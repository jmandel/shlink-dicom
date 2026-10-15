use serde::{Deserialize, Serialize};
use crate::{Error, Result};

pub const RECORD_PLAINTEXT: u64 = 65_520;
pub const TAG_LEN: u64 = 16;
pub const RECORD_CIPHERTEXT: u64 = RECORD_PLAINTEXT + TAG_LEN; // 65_536

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CiphertextRange {
    pub first_record: u64,
    pub last_record: u64,
    pub ciphertext_start: u64,
    pub ciphertext_end: u64,
    pub skip_prefix: usize,
    pub length: usize,
}

impl CiphertextRange {
    pub fn http_range_header(&self) -> String {
        format!("bytes={}-{}", self.ciphertext_start, self.ciphertext_end - 1)
    }

    pub fn expected_ciphertext_len(&self) -> usize {
        (self.ciphertext_end - self.ciphertext_start) as usize
    }
}

pub fn record_count(plaintext_len: u64) -> u64 {
    if plaintext_len == 0 {
        1
    } else {
        plaintext_len.div_ceil(RECORD_PLAINTEXT)
    }
}

pub fn ciphertext_length(plaintext_len: u64) -> u64 {
    plaintext_len + record_count(plaintext_len) * TAG_LEN
}

pub fn ciphertext_range(start: u64, end: u64, plaintext_len: u64) -> Result<CiphertextRange> {
    if start >= end || end > plaintext_len {
        return Err(Error::InvalidRange {
            start,
            end,
            plaintext_len,
        });
    }
    let first_record = start / RECORD_PLAINTEXT;
    let last_record = (end - 1) / RECORD_PLAINTEXT;
    let ciphertext_start = first_record * RECORD_CIPHERTEXT;
    let total_ct = ciphertext_length(plaintext_len);
    let ciphertext_end = total_ct.min((last_record + 1) * RECORD_CIPHERTEXT);
    let skip_prefix = (start - first_record * RECORD_PLAINTEXT) as usize;
    let length = (end - start) as usize;

    Ok(CiphertextRange {
        first_record,
        last_record,
        ciphertext_start,
        ciphertext_end,
        skip_prefix,
        length,
    })
}
