//! Decoder errors.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Malformed or inconsistent codestream.
    Invalid(String),
    /// Valid, but a feature this decoder does not implement.
    Unsupported(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(m) => write!(f, "invalid JPEG 2000 codestream: {m}"),
            Self::Unsupported(m) => write!(f, "unsupported JPEG 2000 feature: {m}"),
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

pub(crate) fn invalid(m: impl Into<String>) -> Error {
    Error::Invalid(m.into())
}

pub(crate) fn unsupported(m: impl Into<String>) -> Error {
    Error::Unsupported(m.into())
}
