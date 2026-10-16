//! Fuzz decode_frame and check every frame it accepts against a direct reading of PS3.5
//! Annex G: each segment PackBits-decoded on its own (a shortfall of up to one row filled with
//! zeros), its bytes placed sample by sample, most significant segment first.
//!
//! Input: rows and columns (u16 LE each, at most 1024), a byte whose bit 0 picks 1 or 3
//! samples per pixel and bits 1–2 Bits Allocated 8, 16 or 32, then the codestream.
#![no_main]
use libfuzzer_sys::fuzz_target;
use shl_codec_common::{FrameInfo, Photometric};
use shl_codec_rle::{decode_frame, parse_header, unpack_bits_partial};

fn reference(cs: &[u8], rows: usize, cols: usize, spp: usize, bps: usize) -> Option<Vec<u8>> {
    let plane = rows * cols;
    let ranges = parse_header(cs).ok()?;
    let mut data = vec![0u8; plane * spp * bps];
    for (seg, &(start, end)) in ranges.iter().enumerate() {
        let mut bytes = vec![0u8; plane];
        let n = unpack_bits_partial(&cs[start..end], &mut bytes);
        if plane - n > cols {
            return None;
        }
        let (sample, byte) = (seg / bps, bps - 1 - seg % bps);
        for (i, &v) in bytes.iter().enumerate() {
            data[(sample * plane + i) * bps + byte] = v;
        }
    }
    Some(data)
}

fuzz_target!(|data: &[u8]| {
    let Some((head, cs)) = data.split_at_checked(5) else { return };
    let rows = u32::from(u16::from_le_bytes([head[0], head[1]])) % 1024 + 1;
    let cols = u32::from(u16::from_le_bytes([head[2], head[3]])) % 1024 + 1;
    let spp: u16 = if head[4] & 1 == 0 { 1 } else { 3 };
    let bits: u16 = [8, 16, 32, 8][usize::from((head[4] >> 1) & 3)];
    let info = FrameInfo {
        rows,
        columns: cols,
        samples_per_pixel: spp,
        bits_allocated: bits,
        bits_stored: bits,
        pixel_representation: 0,
        photometric: if spp == 1 { Photometric::Monochrome2 } else { Photometric::Rgb },
        planar_configuration: 1,
        transfer_syntax: String::new(),
    };
    if let Ok(f) = decode_frame(cs, &info) {
        let want = reference(cs, rows as usize, cols as usize, usize::from(spp), usize::from(bits / 8));
        assert_eq!(Some(&f.data), want.as_ref(), "decode_frame differs from the per-segment reference");
    }
});
