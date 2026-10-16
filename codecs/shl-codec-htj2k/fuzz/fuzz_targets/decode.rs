//! Fuzz decode_frame. The first input byte picks the FrameInfo:
//! - low bit 0: Rows, Columns and Samples per Pixel come from the codestream's own SIZ (when
//!   that frame is at most 2^20 samples), so mutants get past the header check and reach
//!   the wrapped decoder;
//! - low bit 1: a fixed 64x64 frame, so any SIZ, including oversize ones, meets the header
//!   check with a mismatch;
//! - the other bits pick Bits Allocated, Pixel Representation and the photometric.
#![no_main]
use libfuzzer_sys::fuzz_target;
use shl_codec_common::{FrameInfo, Photometric};

fn siz_dims(cs: &[u8]) -> Option<(u32, u32, u16)> {
    let i = cs.windows(2).position(|w| w == [0xFF, 0x51])? + 2;
    let r32 = |k: usize| -> Option<u32> { Some(u32::from_be_bytes(cs.get(i + k..i + k + 4)?.try_into().ok()?)) };
    let (x, y, xo, yo) = (r32(4)?, r32(8)?, r32(12)?, r32(16)?);
    let c = u16::from_be_bytes(cs.get(i + 36..i + 38)?.try_into().ok()?);
    Some((y.checked_sub(yo)?, x.checked_sub(xo)?, c))
}

fuzz_target!(|data: &[u8]| {
    let Some((&sel, cs)) = data.split_first() else { return };
    let (mut rows, mut cols, mut spp) = (64u32, 64u32, 1u16);
    if sel & 1 == 0 {
        if let Some((r, c, s)) = siz_dims(cs) {
            if u64::from(r).saturating_mul(u64::from(c)).saturating_mul(u64::from(s)) <= 1 << 20 {
                (rows, cols, spp) = (r, c, s);
            }
        }
    }
    let info = FrameInfo {
        rows,
        columns: cols,
        samples_per_pixel: spp,
        bits_allocated: [16, 8, 32, 16][usize::from((sel >> 1) & 3)],
        bits_stored: 12,
        pixel_representation: u16::from((sel >> 3) & 1),
        photometric: [Photometric::Monochrome2, Photometric::Rgb, Photometric::YbrRct, Photometric::Monochrome1]
            [usize::from((sel >> 4) & 3)],
        planar_configuration: 0,
        transfer_syntax: String::new(),
    };
    if let Ok(f) = shl_codec_htj2k::decode_frame(cs, &info) {
        assert_eq!(Some(f.data.len()), info.frame_bytes());
    }
});
