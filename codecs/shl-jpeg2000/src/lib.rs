//! JPEG 2000 Part 1 (ITU-T T.800) and High-Throughput JPEG 2000 (ITU-T T.814) decoder, with the
//! array-based multiple component transformations of Part 2 (T.801 Annex J). Pure Rust.
#![forbid(unsafe_code)]

mod bits;
pub mod codestream;
mod decode;
mod dwt;
pub mod error;
mod geometry;
pub mod ht;
mod mct2;
mod mq;
mod t1;
mod t2;
mod tagtree;

pub use decode::{decode, Component, Image, Options, Plane};
pub use error::{Error, Result};
