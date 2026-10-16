//! The HTJ2K (ITU-T T.814) block decoder: HT cleanup, SigProp and MagRef passes.
//!
//! shl patch 5. These files come from `ndic-htj2k` 0.2.5 (MIT, Fideus Labs LLC,
//! <https://github.com/fideus-labs/nd-image-codecs>), `src/block/`, which is a bounds-checked
//! port of OpenJPH's 32-bit block decoder (`ojph_block_decoder32.cpp`, BSD-2-Clause,
//! Copyright (c) 2019-2026 Aous Naman, Kakadu Software Pty Ltd, UNSW Australia). Changes
//! from ndic: the `ndic_core` error type is replaced by [`Error`] below, the encoder is
//! compiled for tests only (round-trip tests), and `decode_block` reuses caller-owned
//! scratch buffers. The tier-2 side (which bytes belong to which code-block, and the pass
//! layout) is in `../segment.rs`; the conversion to hayro's coefficients is in `../decode.rs`.
//!
//! The coder works on **sign-magnitude** `u32` samples: bit 31 is the sign and bitplane `b`
//! of a sub-band with `K_max` magnitude bitplanes sits at bit `31 - K_max + b`. A sample
//! decoded down to bitplane `b` also carries the half-bin bit at `b - 1`, for mid-point
//! reconstruction.

mod decode;
#[cfg(any(test, feature = "ht-reference"))]
mod encode;
// The encoder halves of these modules are used by the round-trip tests only.
#[allow(dead_code)]
pub(crate) mod mel;
#[allow(dead_code)]
pub(crate) mod streams;
#[allow(dead_code)]
pub(crate) mod tables;
#[allow(dead_code, clippy::doc_markdown)] // generated file
mod tables_data;
#[cfg(test)]
mod tests;
#[cfg(feature = "ht-reference")]
pub mod reference;

pub(crate) use decode::{HtScratch, decode_block};
#[cfg(any(test, feature = "ht-reference"))]
pub(crate) use encode::encode_block;

use alloc::string::String;

/// Errors of the HT block decoder. The fields are for debugging; callers only need to know
/// that the block failed.
#[derive(Debug)]
#[allow(dead_code)]
pub(crate) enum Error {
    /// A precondition on the arguments failed (geometry, buffer size).
    InvalidArgument { message: String },
    /// The coded data is malformed.
    Codestream { offset: usize, message: String },
}

pub(crate) type Result<T> = core::result::Result<T, Error>;

/// Coding-pass structure of one code-block's HT codeword segments.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BlockPasses {
    /// Number of coding passes: 1 (cleanup), 2 (+`SigProp`), 3 (+`MagRef`).
    pub(crate) num_passes: u32,
    /// Byte length of the cleanup pass (`Lcup`).
    pub(crate) len_cleanup: usize,
    /// Combined byte length of the refinement passes (`SigProp` + `MagRef`).
    pub(crate) len_refinement: usize,
}

impl BlockPasses {
    /// A cleanup-only segment.
    #[cfg(test)]
    pub(crate) const fn cleanup_only(len: usize) -> Self {
        Self { num_passes: 1, len_cleanup: len, len_refinement: 0 }
    }
}
