//! HT block decoder (ITU-T T.814 clause 7): one HT code-block's cleanup, SigProp and MagRef
//! passes to sign-magnitude samples. Interface fixed by the tier-2/tier-1 driver; see
//! [`decode_block`].
//!
//! Written from T.814 (06/2019). The CxtVLC tables are Annex C's, transcribed into `annex_c.rs`
//! by `gen_annex_c.py` from the text of the Recommendation; the other code tables follow from
//! the procedures of clause 7.3.

mod annex_c;
mod bits;
mod cleanup;
mod refine;
mod tables;
#[cfg(test)]
mod tests;

/// Errors from a damaged or unsupported HT code-block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HtError {
    /// Bad arguments or malformed segments: block size, segment lengths, `Scup`, or an
    /// exponent bound beyond 32-bit samples.
    Invalid(&'static str),
    /// Valid but not handled.
    Unsupported(&'static str),
}

/// The coded data of one HT set of a code-block (T.814 clause 7.1).
pub struct BlockPasses {
    /// HT coding passes in the set: 1 (cleanup), 2 (+ SigProp) or 3 (+ MagRef).
    pub num_passes: u32,
    /// Bytes of the cleanup segment (Lcup) at the start of `coded`.
    pub len_cleanup: usize,
    /// Bytes of the refinement segment (SigProp + MagRef) after it.
    pub len_refinement: usize,
}

/// Reusable buffers for [`decode_block`].
#[derive(Default)]
pub struct Scratch {
    /// Per-quad state of two line-pairs (cleanup).
    rows: Vec<u32>,
    /// The cleanup pass's significance map, for the refinement passes.
    sigma: Vec<u16>,
    /// Significance after SigProp of two stripes.
    above: Vec<u16>,
}

/// Largest suffix length `Scup` (T.814 clause 7.1).
const MAX_SCUP: usize = 4079;

/// Decode one HT code-block of `width` × `height` samples into `out` (`stride` apart).
///
/// Samples are sign (bit 31) and magnitude, the cleanup pass's bit-plane at bit
/// `30 − missing_msbs`, with the half-bin bit below each nonzero sample's last decoded plane.
/// `tests/ht_golden.rs` checks every output word against an independent block decoder's.
///
/// `out` is overwritten for every sample of the block and untouched elsewhere. Code-blocks
/// are at most 1024 samples wide or high and 4096 in area (T.800 B.7). Refinement passes
/// without bytes are skipped, as are those of a block with `missing_msbs == 29` (no plane
/// below the cleanup's). A damaged segment that passes these checks decodes to some output
/// rather than an error: streams read past their ends continue with fill bytes (see
/// `bits.rs`).
///
/// # Errors
/// [`HtError::Invalid`] for bad geometry, lengths or an exponent bound beyond 32-bit samples;
/// [`HtError::Unsupported`] for `missing_msbs >= 30`.
#[allow(clippy::too_many_arguments)]
pub fn decode_block(
    scratch: &mut Scratch,
    coded: &[u8],
    out: &mut [u32],
    width: usize,
    height: usize,
    stride: usize,
    missing_msbs: u32,
    passes: &BlockPasses,
    vertically_causal: bool,
) -> Result<(), HtError> {
    if width == 0 || height == 0 || width > 1024 || height > 1024 || width * height > 4096 {
        return Err(HtError::Invalid("code-block size"));
    }
    if stride < width || out.len() < (height - 1) * stride + width {
        return Err(HtError::Invalid("output buffer smaller than the code-block"));
    }
    let mut num_passes = passes.num_passes;
    if num_passes > 1 && passes.len_refinement == 0 {
        num_passes = 1;
    }
    if num_passes > 3 {
        return Err(HtError::Invalid("more than 3 HT coding passes"));
    }
    if missing_msbs >= 30 {
        return Err(HtError::Unsupported("more than 29 missing bit-planes"));
    }
    if missing_msbs == 29 {
        num_passes = 1;
    }
    let lcup = passes.len_cleanup;
    let lref = passes.len_refinement;
    let Some(end) = lcup.checked_add(lref).filter(|&end| lcup >= 2 && end <= coded.len()) else {
        return Err(HtError::Invalid("segment lengths"));
    };
    let cleanup_seg = &coded[..lcup];
    let scup = usize::from(cleanup_seg[lcup - 1]) << 4 | usize::from(cleanup_seg[lcup - 2] & 0xF);
    if scup < 2 || scup > lcup || scup > MAX_SCUP {
        return Err(HtError::Invalid("Scup"));
    }

    let p = 30 - missing_msbs;
    let refine = num_passes >= 2;
    let sigma_stride = width.div_ceil(4) + 2;
    let Scratch { rows, sigma, above } = scratch;
    sigma.clear();
    if refine {
        sigma.resize((height.div_ceil(4) + 1) * sigma_stride, 0);
    }
    let mut cleanup = cleanup::Cleanup {
        width,
        height,
        stride,
        p,
        max_u: missing_msbs + 2,
        sigma: &mut sigma[..],
        sigma_stride,
    };
    cleanup.decode(rows, cleanup_seg, scup, out)?;
    if !refine {
        return Ok(());
    }
    let refine_seg = &coded[lcup..end];
    let pass = refine::Refine { width, height, stride, p, sigma, sigma_stride };
    pass.sigprop(refine_seg, out, above, vertically_causal);
    if num_passes == 3 {
        pass.magref(refine_seg, out);
    }
    Ok(())
}
