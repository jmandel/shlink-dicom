pub mod bundle;
pub mod crypto;
pub mod dicom_io;
pub mod export;
pub mod jwe;
pub mod offset_tables;
pub mod packer;
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
    UnexpectedCiphertextLength { expected: usize, got: usize },
    #[error("record {record_index} failed AES-GCM authentication")]
    AuthenticationFailed { record_index: u64 },
    #[error("series key or SHL key must be 32 bytes")]
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
    #[error("unsupported transfer syntax for built-in pixel decoder: {0}")]
    UnsupportedTransferSyntax(String),
    #[error("JSON error: {0}")]
    Json(String),
}
