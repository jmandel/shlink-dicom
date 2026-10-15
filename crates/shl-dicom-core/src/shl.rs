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

    pub fn requires_passcode(&self) -> bool {
        self.flag.as_deref().is_some_and(|f| f.contains('P'))
    }

    pub fn is_long_lived(&self) -> bool {
        self.flag.as_deref().is_some_and(|f| f.contains('L'))
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
    Ok(payload)
}
