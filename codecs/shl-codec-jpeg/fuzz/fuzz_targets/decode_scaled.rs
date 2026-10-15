//! Fuzz `decode_frame_scaled` at 1/2 to 1/16 (bits 3-4 of the first byte choose the scale). The
//! FrameInfo is taken from the input's own SOF (so most inputs get past the geometry check), with
//! the first byte choosing the photometric and Bits Allocated.
#![no_main]

use libfuzzer_sys::fuzz_target;
use shl_codec_common::{FrameInfo, Photometric};

fn sof(d: &[u8]) -> Option<(u8, u32, u32, u16)> {
    // A hierarchical image's DHP gives the image size; otherwise the first SOFn.
    let is_frame = |m: u8| matches!(m, 0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF);
    let i = d
        .windows(2)
        .position(|w| w[0] == 0xFF && w[1] == 0xDE)
        .or_else(|| d.windows(2).position(|w| w[0] == 0xFF && is_frame(w[1])))?;
    let s = d.get(i + 4..i + 10)?;
    Some((s[0], u32::from(u16::from_be_bytes([s[1], s[2]])), u32::from(u16::from_be_bytes([s[3], s[4]])), u16::from(s[5])))
}

fuzz_target!(|data: &[u8]| {
    let Some((&sel, cs)) = data.split_first() else { return };
    let Some((p, rows, cols, nf)) = sof(cs) else { return };
    // Keep allocations within libFuzzer's memory limit.
    if u64::from(rows) * u64::from(cols) * u64::from(nf.max(1)) > 1 << 22 {
        return;
    }
    let photometric = [Photometric::Monochrome2, Photometric::Rgb, Photometric::YbrFull, Photometric::YbrFull422][usize::from(sel & 3)];
    let bits_allocated = if sel & 4 != 0 || p > 8 { 16 } else { 8 };
    let info = FrameInfo {
        rows,
        columns: cols,
        samples_per_pixel: nf,
        bits_allocated,
        bits_stored: u16::from(p).min(bits_allocated),
        pixel_representation: u16::from(sel >> 7),
        photometric,
        planar_configuration: 0,
        transfer_syntax: "1.2.840.10008.1.2.4.57".to_string(),
    };
    let s = 1 + ((sel >> 3) & 3);
    if let Ok(d) = shl_codec_jpeg::decode_frame_scaled(cs, &info, s) {
        let n = 1u32 << s;
        assert_eq!((d.rows, d.columns), (rows.div_ceil(n), cols.div_ceil(n)));
        let small = FrameInfo { rows: d.rows, columns: d.columns, ..info };
        assert_eq!(Some(d.frame.data.len()), small.frame_bytes());
    }
});
