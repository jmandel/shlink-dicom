//! Fuzz decode_frame. The FrameInfo is taken from the codestream's own SOF55 (when present)
//! so mutations reach the scan decoder instead of failing the dimension check; the first
//! input byte picks Bits Allocated.
#![no_main]
use libfuzzer_sys::fuzz_target;
use shl_codec_common::{FrameInfo, Photometric};

fuzz_target!(|data: &[u8]| {
    let Some((&sel, cs)) = data.split_first() else { return };
    let (mut rows, mut cols, mut spp) = (16u32, 16u32, 1u16);
    if let Some(i) = cs.windows(2).position(|w| w == [0xFF, 0xF7]) {
        if let Some(h) = cs.get(i + 4..i + 10) {
            rows = u32::from(u16::from_be_bytes([h[1], h[2]]));
            cols = u32::from(u16::from_be_bytes([h[3], h[4]]));
            spp = u16::from(h[5]);
        }
    }
    if u64::from(rows) * u64::from(cols) * u64::from(spp) > 1 << 22 {
        return;
    }
    let info = FrameInfo {
        rows,
        columns: cols,
        samples_per_pixel: spp,
        bits_allocated: [8, 16, 32, 8][usize::from(sel & 3)],
        bits_stored: 16,
        pixel_representation: 0,
        photometric: Photometric::Monochrome2,
        planar_configuration: 0,
        transfer_syntax: String::new(),
    };
    let _ = shl_codec_jpeg_ls::decode_frame(cs, &info);
});
