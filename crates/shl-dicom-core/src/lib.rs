pub mod bundle;
pub mod crypto;
pub mod dicom_io;
pub mod jwe;
pub mod offset_tables;
pub mod order;
pub mod packer;
pub mod patient;
pub mod range;
pub mod shl;

use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Error)]
pub enum Error {
    #[error("invalid byte range [{start}, {end}) for plaintext length {plaintext_len}")]
    InvalidRange {
        start: u64,
        end: u64,
        plaintext_len: u64,
    },
    #[error("unexpected ciphertext length: expected {expected}, got {got}")]
    UnexpectedCiphertextLength { expected: u64, got: u64 },
    #[error("a range of {0} bytes is too large to hold on this platform")]
    RangeTooLarge(u64),
    #[error("record {record_index} failed AES-GCM authentication")]
    AuthenticationFailed { record_index: u64 },
    #[error("file key or SHL key must be 32 bytes")]
    InvalidKeyLength,
    #[error("base64url decode error: {0}")]
    Base64(String),
    #[error("crypto error: {0}")]
    Crypto(String),
    #[error("JWE error: {0}")]
    Jwe(String),
    #[error("invalid shlink URI: {0}")]
    InvalidShlink(String),
    #[error("invalid FHIR Bundle: {0}")]
    InvalidBundle(String),
    #[error("DICOM error: {0}")]
    Dicom(String),
    #[error("I/O error: {0}")]
    Io(String),
    #[error("unsupported transfer syntax for built-in pixel decoder: {0}")]
    UnsupportedTransferSyntax(String),
    #[error("JSON error: {0}")]
    Json(String),
}

/// The repository's synthetic DICOM builder, for unit tests.
#[cfg(test)]
#[path = "../../../codecs/shl-dicom-decode/tests/support/ds.rs"]
pub(crate) mod test_ds;

/// A failure of the link reader (link, manifest, Bundle JWE, study index), with a stable `code`
/// the viewer maps to its own words (crates/shl-dicom-reader/README.md lists them) and English
/// detail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadError {
    pub code: &'static str,
    pub message: String,
}

impl std::fmt::Display for ReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
