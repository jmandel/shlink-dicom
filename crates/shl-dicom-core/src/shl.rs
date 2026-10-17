use serde::{Deserialize, Serialize};
use crate::{
    crypto::{b64url_decode, b64url_encode, decode_key_32},
    Error, ReadError, Result,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShlPayload {
    pub url: String,
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exp: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub v: Option<u32>,
}

impl ShlPayload {
    pub fn key_bytes(&self) -> Result<[u8; 32]> {
        decode_key_32(&self.key)
    }

    pub fn is_u_mode(&self) -> bool {
        self.flag.as_deref().is_some_and(|f| f.contains('U'))
    }
}

/// Computes the alphabetical SHL `flag` string from link policy properties.
/// Without a passcode, uses U mode (`"U"` or `"LU"`).
/// With a passcode, uses manifest mode (`"P"` or `"LP"`).
pub fn compute_shl_flag(has_passcode: bool, long_lived: bool) -> Option<String> {
    let mut flags = String::new();
    if long_lived {
        flags.push('L');
    }
    if has_passcode {
        flags.push('P');
    } else {
        flags.push('U');
    }
    Some(flags)
}

pub fn encode_shlink_uri(payload: &ShlPayload, viewer_prefix: Option<&str>) -> Result<String> {
    let json = serde_json::to_vec(payload).map_err(|e| Error::Json(e.to_string()))?;
    let encoded = b64url_encode(&json);
    match viewer_prefix {
        Some(prefix) if !prefix.is_empty() => {
            let clean = prefix.trim_end_matches('#');
            Ok(format!("{clean}#shlink:/{encoded}"))
        }
        _ => Ok(format!("shlink:/{encoded}")),
    }
}

/// A link as the reader takes it (crates/shl-dicom-reader): its payload, checked, and what its
/// flags and expiry mean.
#[derive(Debug, Clone, PartialEq)]
pub struct LinkInfo {
    pub payload: ShlPayload,
    /// `exp` as given (seconds since 1970; may have a fraction).
    pub exp: Option<f64>,
    pub direct: bool,
    pub passcode: bool,
    pub long_lived: bool,
    /// `exp` is at or before `now`.
    pub expired: bool,
}

/// Reads a SMART Health Link from text that holds one: a bare `shlink:/…`, a viewer URL with
/// `#shlink:/…`, or a message around it. Checks: base64url JSON payload; `url` and a 43-character
/// base64url `key` of 32 bytes; `flag` only L, P and U, each once, and not U with P; `v` absent or
/// 1; `exp` a non-negative number. A long `label` is accepted (it is only shown).
pub fn parse_link(text: &str, now_secs: f64) -> std::result::Result<LinkInfo, ReadError> {
    let fail = |code: &'static str, message: &str| ReadError { code, message: message.to_string() };
    let at = text.find("shlink:/").ok_or_else(|| fail("not-a-link", "no shlink:/ in the text"))?;
    let b64 = text[at + "shlink:/".len()..].split(char::is_whitespace).next().unwrap_or("");
    let v: serde_json::Value = b64url_decode(b64)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or_else(|| fail("damaged", "the payload is not base64url JSON"))?;
    let text_field = |k: &str| v.get(k).and_then(serde_json::Value::as_str).map(str::to_string);
    let (Some(url), Some(key)) = (text_field("url").filter(|u| !u.trim().is_empty()), text_field("key")) else {
        return Err(fail("missing-url-or-key", "the payload has no url or key"));
    };
    decode_key_32(&key).map_err(|_| fail("bad-key", "the key is not 43 base64url characters for 32 bytes"))?;
    let flag = match v.get("flag") {
        None | Some(serde_json::Value::Null) => None,
        Some(f) => Some(f.as_str().ok_or_else(|| fail("bad-flag", "flag is not text"))?.to_string()),
    };
    let flags = flag.clone().unwrap_or_default();
    let flags = flags.as_str();
    for (i, c) in flags.char_indices() {
        if !matches!(c, 'L' | 'P' | 'U') || flags[..i].contains(c) {
            return Err(fail("bad-flag", "flag may hold only L, P and U, each once"));
        }
    }
    if flags.contains('U') && flags.contains('P') {
        return Err(fail("u-with-p", "flag U may not be combined with P"));
    }
    let version = match v.get("v") {
        None | Some(serde_json::Value::Null) => None,
        Some(x) => match x.as_u64() {
            Some(1) => Some(1),
            _ => return Err(ReadError { code: "version", message: format!("version {x} is not one this reader knows (1)") }),
        },
    };
    let exp = match v.get("exp") {
        None | Some(serde_json::Value::Null) => None,
        Some(x) => Some(x.as_f64().filter(|e| e.is_finite() && *e >= 0.0).ok_or_else(|| fail("bad-exp", "exp is not a non-negative number"))?),
    };
    let label = text_field("label");
    let payload = ShlPayload { url, key, exp: exp.map(|e| e as u64), flag, label, v: version };
    Ok(LinkInfo {
        exp,
        direct: flags.contains('U'),
        passcode: flags.contains('P'),
        long_lived: flags.contains('L'),
        expired: exp.is_some_and(|e| e <= now_secs),
        payload,
    })
}

pub fn decode_shlink_uri(uri: &str) -> Result<ShlPayload> {
    parse_link(uri, 0.0).map(|l| l.payload).map_err(|e| Error::InvalidShlink(e.message))
}

/// The Bundle's location in a manifest response (SMART Health Links manifest mode): the first file
/// whose contentType, parameters aside and in any case, is application/fhir+json and which has a
/// location. The location must be an absolute https URL (http only for localhost, 127.0.0.1 and
/// [::1]) without query or fragment, ending in "/" or a file name: `{fileId}.bin` resolves beside
/// it and access tokens live in the path (spec/README.md §10).
pub fn manifest_location(manifest_json: &[u8]) -> std::result::Result<String, ReadError> {
    let fail = |code: &'static str, message: &str| ReadError { code, message: message.to_string() };
    let m: serde_json::Value = serde_json::from_slice(manifest_json).map_err(|_| fail("damaged", "the manifest is not JSON"))?;
    let is_fhir = |t: &str| t.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case("application/fhir+json");
    let loc = m
        .get("files")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .find(|f| f.get("contentType").and_then(serde_json::Value::as_str).is_some_and(is_fhir) && f.get("location").is_some_and(serde_json::Value::is_string))
        .and_then(|f| f.get("location").and_then(serde_json::Value::as_str))
        .ok_or_else(|| fail("no-location", "the manifest names no application/fhir+json file with a location"))?;
    if !location_shape_ok(loc) {
        return Err(fail("bad-location", "the location is not an https URL (http only for localhost) without query or fragment"));
    }
    Ok(loc.to_string())
}

/// An absolute URL with scheme https, or http on localhost, 127.0.0.1 or [::1]; a host; no query
/// or fragment; no whitespace; a path ending in "/" or in a file name (its last segment has a ".").
fn location_shape_ok(loc: &str) -> bool {
    if loc.contains(['?', '#']) || loc.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let (scheme, rest) = match loc.split_once("://") {
        Some(x) => x,
        None => return false,
    };
    let authority = rest.split('/').next().unwrap_or("");
    let host_port = authority.rsplit('@').next().unwrap_or("");
    let host = if let Some(end) = host_port.strip_prefix('[').and_then(|h| h.find(']')) {
        &host_port[..end + 2]
    } else {
        host_port.split(':').next().unwrap_or("")
    };
    if host.is_empty() {
        return false;
    }
    // `{fileId}.bin` resolves beside it: the URL ends in "/" or names a file ("…/bundle.jwe").
    let path = rest.find('/').map_or("", |i| &rest[i..]);
    if !(path.ends_with('/') || path.rsplit('/').next().is_some_and(|last| last.contains('.'))) {
        return false;
    }
    match scheme.to_ascii_lowercase().as_str() {
        "https" => true,
        "http" => matches!(host.to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "[::1]"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(flag: Option<&str>, v: Option<u32>) -> String {
        let p = ShlPayload { url: "https://host.example/x".into(), key: "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8".into(), exp: None, flag: flag.map(String::from), label: None, v };
        encode_shlink_uri(&p, None).unwrap()
    }

    #[test]
    fn u_with_p_and_unknown_versions_are_refused() {
        assert!(decode_shlink_uri(&link(Some("LU"), Some(1))).is_ok());
        assert!(decode_shlink_uri(&link(Some("LP"), None)).is_ok());
        assert!(decode_shlink_uri(&link(Some("PU"), None)).unwrap_err().to_string().contains("U may not be combined with P"));
        assert!(decode_shlink_uri(&link(None, Some(2))).unwrap_err().to_string().contains("version 2"));
    }
}
