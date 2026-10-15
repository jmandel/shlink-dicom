use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use crate::{
    range::{ciphertext_length, ciphertext_range, record_count, RECORD_CIPHERTEXT, RECORD_PLAINTEXT, TAG_LEN},
    Error, Result,
};

pub fn b64url_encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn b64url_decode(s: &str) -> Result<Vec<u8>> {
    let trimmed = s.trim().trim_end_matches('=');
    URL_SAFE_NO_PAD
        .decode(trimmed)
        .map_err(|e| Error::Base64(e.to_string()))
}

pub fn decode_key_32(s: &str) -> Result<[u8; 32]> {
    let bytes = b64url_decode(s)?;
    bytes.try_into().map_err(|_| Error::InvalidKeyLength)
}

pub fn random_bytes<const N: usize>() -> Result<[u8; N]> {
    let mut buf = [0u8; N];
    getrandom::getrandom(&mut buf).map_err(|e| Error::Crypto(e.to_string()))?;
    Ok(buf)
}

/// Nonce for record `record_index`: a 12-byte (96-bit) big-endian unsigned integer.
pub fn record_nonce(record_index: u64) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[4..12].copy_from_slice(&record_index.to_be_bytes());
    n
}

pub fn encrypt_file(plaintext: &[u8], file_key: &[u8; 32]) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new(file_key.into());
    let n = record_count(plaintext.len() as u64);
    let mut out = Vec::with_capacity(ciphertext_length(plaintext.len() as u64) as usize);

    for i in 0..n {
        let start = (i * RECORD_PLAINTEXT) as usize;
        let end = ((i + 1) * RECORD_PLAINTEXT).min(plaintext.len() as u64) as usize;
        let chunk = if start < plaintext.len() {
            &plaintext[start..end]
        } else {
            &[]
        };
        let nonce_bytes = record_nonce(i);
        let ct = cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), chunk)
            .map_err(|_| Error::AuthenticationFailed { record_index: i })?;
        out.extend_from_slice(&ct);
    }

    Ok(out)
}

pub fn decrypt_range(
    ciphertext_slice: &[u8],
    start: u64,
    end: u64,
    plaintext_len: u64,
    file_key: &[u8; 32],
) -> Result<Vec<u8>> {
    let r = ciphertext_range(start, end, plaintext_len)?;
    if ciphertext_slice.len() != r.expected_ciphertext_len() {
        return Err(Error::UnexpectedCiphertextLength {
            expected: r.expected_ciphertext_len(),
            got: ciphertext_slice.len(),
        });
    }

    let cipher = Aes256Gcm::new(file_key.into());
    let total_records = record_count(plaintext_len);
    let mut joined = Vec::with_capacity(
        ((r.last_record - r.first_record + 1) * RECORD_PLAINTEXT) as usize,
    );

    for i in r.first_record..=r.last_record {
        let off = ((i - r.first_record) * RECORD_CIPHERTEXT) as usize;
        let rec_end = (off + RECORD_CIPHERTEXT as usize).min(ciphertext_slice.len());
        let rec = &ciphertext_slice[off..rec_end];

        // Non-final records must be exactly 65,536 bytes; final record must match remainder + 16.
        let expected_rec_len = if i + 1 < total_records {
            RECORD_CIPHERTEXT as usize
        } else {
            (plaintext_len - i * RECORD_PLAINTEXT + TAG_LEN) as usize
        };
        if rec.len() != expected_rec_len {
            return Err(Error::AuthenticationFailed { record_index: i });
        }

        let nonce_bytes = record_nonce(i);
        let pt = cipher
            .decrypt(Nonce::from_slice(&nonce_bytes), rec)
            .map_err(|_| Error::AuthenticationFailed { record_index: i })?;
        joined.extend_from_slice(&pt);
    }

    Ok(joined[r.skip_prefix..r.skip_prefix + r.length].to_vec())
}

/// Encrypts a series file as it is read (§9.2), one record at a time: reads plaintext from
/// `reader` until it ends and writes the records to `writer`. Returns the ciphertext length.
pub fn encrypt_series_stream<R: std::io::Read, W: std::io::Write>(mut reader: R, mut writer: W, series_key: &[u8; 32]) -> Result<u64> {
    let cipher = Aes256Gcm::new(series_key.into());
    let mut buf = vec![0u8; RECORD_PLAINTEXT as usize];
    let mut i = 0u64;
    let mut written = 0u64;
    loop {
        // Fill a whole record unless the plaintext ends.
        let mut n = 0;
        while n < buf.len() {
            let k = reader.read(&mut buf[n..]).map_err(|e| Error::Io(e.to_string()))?;
            if k == 0 {
                break;
            }
            n += k;
        }
        if n == 0 && i > 0 {
            break;
        }
        let ct = cipher
            .encrypt(Nonce::from_slice(&record_nonce(i)), &buf[..n])
            .map_err(|_| Error::AuthenticationFailed { record_index: i })?;
        writer.write_all(&ct).map_err(|e| Error::Io(e.to_string()))?;
        written += ct.len() as u64;
        i += 1;
        if n < buf.len() {
            break;
        }
    }
    Ok(written)
}
