use serde::{Deserialize, Serialize};
use crate::{
    crypto::{b64url_decode, b64url_encode, decode_key_32},
    Error, Result,
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

pub fn decode_shlink_uri(uri: &str) -> Result<ShlPayload> {
    let trimmed = uri.trim();
    let idx = trimmed
        .find("shlink:/")
        .ok_or_else(|| Error::InvalidShlink("missing 'shlink:/' prefix".into()))?;
    let b64 = &trimmed[idx + "shlink:/".len()..];
    let bytes = b64url_decode(b64)?;
    let payload: ShlPayload =
        serde_json::from_slice(&bytes).map_err(|e| Error::InvalidShlink(e.to_string()))?;
    let _ = payload.key_bytes()?;
    // SMART Health Links: U SHALL NOT be combined with P, and a reader should not follow a link
    // of a version it does not know (this one knows 1).
    let flag = payload.flag.as_deref().unwrap_or("");
    if flag.contains('U') && flag.contains('P') {
        return Err(Error::InvalidShlink("flag U may not be combined with P".into()));
    }
    if let Some(v) = payload.v.filter(|&v| v != 1) {
        return Err(Error::InvalidShlink(format!("version {v} is not one this reader knows (1)")));
    }
    Ok(payload)
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
