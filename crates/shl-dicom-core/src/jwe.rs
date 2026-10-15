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

pub fn encrypt_bundle_jwe(bundle_json: &[u8], shl_key: &[u8; 32]) -> Result<String> {
    let iv = random_bytes::<12>()?;
    encrypt_bundle_jwe_with_iv(bundle_json, shl_key, &iv)
}

pub fn encrypt_bundle_jwe_with_iv(
    bundle_json: &[u8],
    shl_key: &[u8; 32],
    iv: &[u8; 12],
) -> Result<String> {
    let header_json = r#"{"alg":"dir","enc":"A256GCM","zip":"DEF"}"#;
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

pub fn decrypt_bundle_jwe(jwe_compact: &str, shl_key: &[u8; 32]) -> Result<Vec<u8>> {
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
            let mut decoder = DeflateDecoder::new(&decrypted[..]);
            let mut out = Vec::new();
            decoder
                .read_to_end(&mut out)
                .map_err(|e| Error::Jwe(format!("DEFLATE decompression failed: {e}")))?;
            Ok(out)
        }
        None => Ok(decrypted),
        Some(other) => Err(Error::Jwe(format!("unsupported JWE zip: {other}"))),
    }
}
