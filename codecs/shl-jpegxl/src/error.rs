//! Decoder errors.

use std::fmt;

/// Why a codestream could not be decoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The data violates the standard (or is truncated).
    Invalid(&'static str),
    /// Valid JPEG XL, but a feature this decoder does not implement.
    Unsupported(&'static str),
    /// The image exceeds a configured size or memory limit.
    Limit(&'static str),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Invalid(m) => write!(f, "invalid JPEG XL: {m}"),
            Error::Unsupported(m) => write!(f, "unsupported JPEG XL: {m}"),
            Error::Limit(m) => write!(f, "JPEG XL exceeds a limit: {m}"),
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

/// Shorthand for `Err(Error::Invalid(m))`.
pub(crate) fn invalid<T>(m: &'static str) -> Result<T> {
    Err(Error::Invalid(m))
}
