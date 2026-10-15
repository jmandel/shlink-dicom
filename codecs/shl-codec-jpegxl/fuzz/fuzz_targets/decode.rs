//! Fuzz `decode_frame`. The FrameInfo comes from the input's own image header (so most inputs
//! get past the geometry check and reach rendering); the first byte picks Bits Allocated and
//! Pixel Representation.
#![no_main]

use jxl_oxide::{InitializeResult, JxlImage, JxlThreadPool, PixelFormat};
use libfuzzer_sys::fuzz_target;
use shl_codec_common::{FrameInfo, Photometric};

fn header(cs: &[u8]) -> Option<(u32, u32, u16)> {
    let mut u = JxlImage::builder().pool(JxlThreadPool::none()).build_uninit();
    u.feed_bytes(cs).ok()?;
    match u.try_init().ok()? {
        InitializeResult::Initialized(img) => {
            let spp = match img.pixel_format() {
                PixelFormat::Gray | PixelFormat::Graya => 1,
                _ => 3,
            };
            Some((img.width(), img.height(), spp))
        }
        InitializeResult::NeedMoreData(_) => None,
    }
}

fuzz_target!(|data: &[u8]| {
    let Some((&sel, cs)) = data.split_first() else { return };
    let Some((cols, rows, spp)) = header(cs) else { return };
    // Keep allocations within libFuzzer's memory limit.
    if u64::from(rows) * u64::from(cols) > 1 << 20 {
        return;
    }
    let bits_allocated = if sel & 1 != 0 { 16 } else { 8 };
    let info = FrameInfo {
        rows,
        columns: cols,
        samples_per_pixel: spp,
        bits_allocated,
        bits_stored: bits_allocated,
        pixel_representation: u16::from(sel >> 7),
        photometric: if spp == 3 { Photometric::Rgb } else { Photometric::Monochrome2 },
        planar_configuration: 0,
        transfer_syntax: "1.2.840.10008.1.2.4.112".to_string(),
    };
    if let Ok(f) = shl_codec_jpegxl::decode_frame(cs, &info) {
        assert_eq!(Some(f.data.len()), info.frame_bytes());
    }
});
