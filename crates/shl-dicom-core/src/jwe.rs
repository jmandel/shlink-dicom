use std::io::Read;
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use flate2::{
    read::{DeflateDecoder, DeflateEncoder},
    Compression,
};
use serde::{Deserialize, Serialize};
use crate::{
    crypto::{b64url_decode, b64url_encode, random_bytes},
    Error, Result,
};

#[derive(Debug, Serialize, Deserialize)]
struct JweHeader {
    alg: String,
    enc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    zip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cty: Option<String>,
}

/// The `cty` of a Bundle JWE.
pub const BUNDLE_CTY: &str = "application/fhir+json";

pub fn encrypt_bundle_jwe(bundle_json: &[u8], shl_key: &[u8; 32]) -> Result<String> {
    let iv = random_bytes::<12>()?;
    encrypt_bundle_jwe_with_iv(bundle_json, shl_key, &iv)
}

pub fn encrypt_bundle_jwe_with_iv(
    bundle_json: &[u8],
    shl_key: &[u8; 32],
    iv: &[u8; 12],
) -> Result<String> {
    // `cty` names the payload's content type, as SMART Health Links require of every JWE; the
    // member order matches the browser's encryptJwe (web/core/jwe.ts).
    let header_json = format!(r#"{{"alg":"dir","enc":"A256GCM","zip":"DEF","cty":"{BUNDLE_CTY}"}}"#);
    let header_b64 = b64url_encode(header_json.as_bytes());

    let mut encoder = DeflateEncoder::new(bundle_json, Compression::default());
    let mut compressed = Vec::new();
    encoder
        .read_to_end(&mut compressed)
        .map_err(|e| Error::Jwe(e.to_string()))?;

    let cipher = Aes256Gcm::new(shl_key.into());
    let ct_with_tag = cipher
        .encrypt(
            Nonce::from_slice(iv),
            Payload {
                msg: &compressed,
                aad: header_b64.as_bytes(),
            },
        )
        .map_err(|e| Error::Jwe(e.to_string()))?;

    let tag_offset = ct_with_tag.len() - 16;
    let ct = &ct_with_tag[..tag_offset];
    let tag = &ct_with_tag[tag_offset..];

    Ok(format!(
        "{}..{}.{}.{}",
        header_b64,
        b64url_encode(iv),
        b64url_encode(ct),
        b64url_encode(tag)
    ))
}

/// The largest Bundle a reader inflates: far above any real one (a Bundle lists studies, not their
/// pixels), and small enough that a hostile JWE cannot exhaust memory by inflating without end.
pub const MAX_BUNDLE_BYTES: u64 = 64 << 20;
/// The largest compact JWE a reader takes: a 64 MiB payload in base64url, plus the header.
pub const MAX_JWE_CHARS: usize = (MAX_BUNDLE_BYTES as usize).div_ceil(3) * 4 + 4096;

pub fn decrypt_bundle_jwe(jwe_compact: &str, shl_key: &[u8; 32]) -> Result<Vec<u8>> {
    if jwe_compact.len() > MAX_JWE_CHARS {
        return Err(Error::Jwe(format!("JWE is longer than {MAX_JWE_CHARS} characters")));
    }
    let parts: Vec<&str> = jwe_compact.trim().split('.').collect();
    if parts.len() != 5 || !parts[1].is_empty() {
        return Err(Error::Jwe("invalid compact JWE format".into()));
    }

    let header_b64 = parts[0];
    let header_bytes = b64url_decode(header_b64)?;
    let header: JweHeader =
        serde_json::from_slice(&header_bytes).map_err(|e| Error::Jwe(e.to_string()))?;

    if header.alg != "dir" || header.enc != "A256GCM" {
        return Err(Error::Jwe(format!(
            "unsupported JWE alg/enc: {}/{}",
            header.alg, header.enc
        )));
    }
    if header.cty.as_deref() != Some(BUNDLE_CTY) {
        return Err(Error::Jwe(format!("JWE cty must be {BUNDLE_CTY}, not {}", header.cty.as_deref().unwrap_or("missing"))));
    }

    let iv = b64url_decode(parts[2])?;
    if iv.len() != 12 {
        return Err(Error::Jwe("JWE IV must be 12 bytes".into()));
    }
    let ct = b64url_decode(parts[3])?;
    let tag = b64url_decode(parts[4])?;
    if tag.len() != 16 {
        return Err(Error::Jwe("JWE authentication tag must be 16 bytes".into()));
    }

    let mut ct_with_tag = Vec::with_capacity(ct.len() + tag.len());
    ct_with_tag.extend_from_slice(&ct);
    ct_with_tag.extend_from_slice(&tag);

    let cipher = Aes256Gcm::new(shl_key.into());
    let decrypted = cipher
        .decrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: &ct_with_tag,
                aad: header_b64.as_bytes(),
            },
        )
        .map_err(|_| Error::Jwe("JWE authentication failed".into()))?;

    match header.zip.as_deref() {
        Some("DEF") => {
            // One byte past the cap tells a Bundle that is too large from one exactly at it.
            let mut decoder = DeflateDecoder::new(&decrypted[..]).take(MAX_BUNDLE_BYTES + 1);
            let mut out = Vec::new();
            decoder
                .read_to_end(&mut out)
                .map_err(|e| Error::Jwe(format!("DEFLATE decompression failed: {e}")))?;
            if out.len() as u64 > MAX_BUNDLE_BYTES {
                return Err(Error::Jwe(format!("Bundle inflates past {MAX_BUNDLE_BYTES} bytes")));
            }
            Ok(out)
        }
        None => Ok(decrypted),
        Some(other) => Err(Error::Jwe(format!("unsupported JWE zip: {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::Aead;

    /// A Bundle JWE whose protected header is `header` (no zip).
    fn jwe_with_header(header: &str, key: &[u8; 32]) -> String {
        let h = b64url_encode(header.as_bytes());
        let iv = [7u8; 12];
        let ct = Aes256Gcm::new(key.into()).encrypt(Nonce::from_slice(&iv), Payload { msg: b"{}", aad: h.as_bytes() }).unwrap();
        let (c, t) = ct.split_at(ct.len() - 16);
        format!("{h}..{}.{}.{}", b64url_encode(&iv), b64url_encode(c), b64url_encode(t))
    }

    #[test]
    fn bundle_jwe_names_its_content_type() {
        let key = [9u8; 32];
        let jwe = encrypt_bundle_jwe(b"{}", &key).unwrap();
        let header: JweHeader = serde_json::from_slice(&b64url_decode(jwe.split('.').next().unwrap()).unwrap()).unwrap();
        assert_eq!(header.cty.as_deref(), Some(BUNDLE_CTY));
        assert_eq!(decrypt_bundle_jwe(&jwe, &key).unwrap(), b"{}");
        let ok = jwe_with_header(r#"{"alg":"dir","enc":"A256GCM","cty":"application/fhir+json"}"#, &key);
        assert_eq!(decrypt_bundle_jwe(&ok, &key).unwrap(), b"{}");
        for header in [r#"{"alg":"dir","enc":"A256GCM"}"#, r#"{"alg":"dir","enc":"A256GCM","cty":"application/smart-health-card"}"#] {
            assert!(decrypt_bundle_jwe(&jwe_with_header(header, &key), &key).is_err(), "{header}");
        }
    }

    #[test]
    fn oversized_bundles_and_jwes_are_refused() {
        const MIB64: usize = 64 << 20;
        let key = [3u8; 32];
        // One repeated byte deflates about 1000:1, so a 64 MiB Bundle is a small JWE.
        let jwe = encrypt_bundle_jwe(&vec![b' '; MIB64 + 1], &key).unwrap();
        assert!(jwe.len() < 1 << 20);
        let err = decrypt_bundle_jwe(&jwe, &key).expect_err("a Bundle past 64 MiB was inflated");
        assert!(err.to_string().contains("inflates past"), "{err}");
        let ok = vec![b' '; MIB64];
        assert_eq!(decrypt_bundle_jwe(&encrypt_bundle_jwe(&ok, &key).unwrap(), &key).unwrap().len(), ok.len());
        let err = decrypt_bundle_jwe(&"a".repeat(90 << 20), &key).expect_err("a 90 MiB JWE was read");
        assert!(err.to_string().contains("longer than"), "{err}");
    }
}
