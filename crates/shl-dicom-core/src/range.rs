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
    /// Where the range starts in the first record's plaintext (under 65,520).
    pub skip_prefix: usize,
    /// The range's plaintext length. A u64, as the Bundle gives it; [`to_usize`] it to slice.
    pub length: u64,
}

/// A length or offset as a `usize` for slicing: an error, not a truncation, where it does not fit
/// (over 4 GiB on wasm32).
pub fn to_usize(n: u64) -> Result<usize> {
    fits(n)
}

fn fits<T: TryFrom<u64>>(n: u64) -> Result<T> {
    T::try_from(n).map_err(|_| Error::RangeTooLarge(n))
}

impl CiphertextRange {
    pub fn http_range_header(&self) -> String {
        format!("bytes={}-{}", self.ciphertext_start, self.ciphertext_end - 1)
    }

    pub fn expected_ciphertext_len(&self) -> u64 {
        self.ciphertext_end - self.ciphertext_start
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
    let length = end - start;

    Ok(CiphertextRange {
        first_record,
        last_record,
        ciphertext_start,
        ciphertext_end,
        skip_prefix,
        length,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lengths_past_4_gib_are_kept_and_never_truncated() {
        // A 5 GiB range of a 6 GiB file keeps its length.
        let r = ciphertext_range(1, (5 << 30) + 1, 6 << 30).unwrap();
        assert_eq!(r.length, 5 << 30);
        // Where usize is 32 bits (wasm32), converting it is an error, not 1 GiB.
        assert!(matches!(fits::<u32>(r.length), Err(Error::RangeTooLarge(n)) if n == 5 << 30));
        assert_eq!(fits::<u32>(u32::MAX as u64).unwrap(), u32::MAX);
        assert_eq!(to_usize(1 << 20).unwrap(), 1 << 20);
        #[cfg(target_pointer_width = "64")]
        assert_eq!(to_usize(r.length).unwrap(), 5 << 30);
        #[cfg(target_pointer_width = "32")]
        assert!(to_usize(r.length).is_err());
    }
}
