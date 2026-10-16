//! Decode entry points for timing. Native: `src/main.rs`. wasm32: `bench.mjs` (node) calls
//! `bench_alloc`, copies the codestream in, and times `bench_decode` with performance.now().
use shl_codec_common::{FrameInfo, Photometric};

pub fn info(rows: u32, cols: u32, spp: u16, ba: u16, bs: u16, pr: u16, photometric: &str) -> FrameInfo {
    FrameInfo {
        rows,
        columns: cols,
        samples_per_pixel: spp,
        bits_allocated: ba,
        bits_stored: bs,
        pixel_representation: pr,
        photometric: Photometric::parse(photometric),
        planar_configuration: 0,
        transfer_syntax: String::new(),
    }
}

/// codec 0 = shl-codec-jpeg2000, 1 = shl-codec-htj2k (the same decoder). Returns the decoded
/// length, or a negative number on error.
pub fn decode(codec: u32, cs: &[u8], info: &FrameInfo) -> i64 {
    let r = if codec == 0 {
        shl_codec_jpeg2000::decode_frame(cs, info)
    } else {
        shl_codec_htj2k::decode_frame(cs, info)
    };
    match r {
        Ok(f) => f.data.len() as i64,
        Err(_) => -1,
    }
}

#[no_mangle]
pub extern "C" fn bench_alloc(len: usize) -> *mut u8 {
    let mut v = vec![0u8; len];
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr`/`len` must come from `bench_alloc`.
#[no_mangle]
pub unsafe extern "C" fn bench_decode(codec: u32, ptr: *const u8, len: usize, rows: u32, cols: u32, spp: u32, ba: u32, bs: u32, pr: u32, rgb: u32) -> i64 {
    let cs = std::slice::from_raw_parts(ptr, len);
    let ph = if rgb != 0 { "RGB" } else { "MONOCHROME2" };
    decode(codec, cs, &info(rows, cols, spp as u16, ba as u16, bs as u16, pr as u16, ph))
}
