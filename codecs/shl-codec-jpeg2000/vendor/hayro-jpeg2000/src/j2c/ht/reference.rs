//! Test scaffolding (feature `ht-reference`), for shl-jpeg2000's HT block decoder: the vendored
//! decoder and test encoder behind a public interface, and a recorder of the HT code-blocks
//! that frame decodes pass to the decoder. Deleted with this crate.

use alloc::string::String;
use alloc::vec::Vec;
use std::sync::Mutex;

use super::{BlockPasses, HtScratch};

/// Scratch buffers of [`decode_block`].
#[derive(Default)]
pub struct Scratch(HtScratch);

/// The vendored `decode_block`, with the pass layout spelled out.
#[allow(clippy::too_many_arguments)]
pub fn decode_block(
    scratch: &mut Scratch,
    coded: &[u8],
    out: &mut [u32],
    width: usize,
    height: usize,
    stride: usize,
    missing_msbs: u32,
    num_passes: u32,
    len_cleanup: usize,
    len_refinement: usize,
    vertically_causal: bool,
) -> Result<(), String> {
    let passes = BlockPasses { num_passes, len_cleanup, len_refinement };
    super::decode_block(&mut scratch.0, coded, out, width, height, stride, missing_msbs, &passes, vertically_causal)
        .map_err(|e| alloc::format!("{e:?}"))
}

/// The vendored test encoder: one cleanup pass for sign-magnitude samples.
pub fn encode_block(samples: &[u32], width: usize, height: usize, stride: usize, missing_msbs: u32) -> Option<Vec<u8>> {
    super::encode_block(samples, width, height, stride, missing_msbs).ok()
}

/// One recorded HT code-block: the arguments of a `decode_block` call.
#[derive(Clone, Debug)]
pub struct Block {
    /// Cleanup then refinement bytes.
    pub coded: Vec<u8>,
    /// Block width.
    pub width: usize,
    /// Block height.
    pub height: usize,
    /// Missing MSBs of the cleanup pass.
    pub missing_msbs: u32,
    /// HT passes in the set.
    pub num_passes: u32,
    /// Bytes of the cleanup segment.
    pub len_cleanup: usize,
    /// The vertically causal context flag.
    pub vertically_causal: bool,
}

static RECORDED: Mutex<Option<Vec<Block>>> = Mutex::new(None);

/// Starts recording the HT code-blocks of subsequent decodes (all threads).
pub fn start_recording() {
    *RECORDED.lock().unwrap() = Some(Vec::new());
}

/// Stops recording and returns the blocks recorded.
pub fn take_recorded() -> Vec<Block> {
    RECORDED.lock().unwrap().take().unwrap_or_default()
}

pub(crate) fn record(coded: &[u8], width: usize, height: usize, missing_msbs: u32, num_passes: u32, len_cleanup: usize, vertically_causal: bool) {
    if let Some(v) = RECORDED.lock().unwrap().as_mut() {
        v.push(Block { coded: coded.to_vec(), width, height, missing_msbs, num_passes, len_cleanup, vertically_causal });
    }
}
