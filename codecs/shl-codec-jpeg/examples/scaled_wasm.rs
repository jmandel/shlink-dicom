//! A wasm32 cdylib exposing `decode_frame_scaled`, so the simd128 kernels can be checked against
//! the native build: codec-corpus/formats/jpeg-dct/scaled/check_wasm.mjs.
//! Build: cargo build --release --target wasm32-unknown-unknown --example scaled_wasm
//!        (RUSTFLAGS="-C target-feature=+simd128" for the simd128 kernels)
use shl_codec_common::{FrameInfo, Photometric};

static mut OUT: Vec<u8> = Vec::new();

/// A buffer of `n` bytes for the caller to fill (leaked; the harness is short-lived).
#[no_mangle]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    let mut v = vec![0u8; n];
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// Decode the codestream at `ptr..ptr + len` at 1/2^s. `photometric` indexes MONOCHROME2, RGB,
/// YBR_FULL, YBR_FULL_422. Returns the output length (read it at `out_ptr()`), or -1 on error.
///
/// # Safety
/// `ptr..ptr + len` must be a buffer from `alloc`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn scaled(ptr: *const u8, len: usize, rows: u32, cols: u32, spp: u32, ba: u32, bs: u32, photometric: u32, s: u32) -> i32 {
    // SAFETY: the caller passes a buffer it got from `alloc` and filled.
    let cs = unsafe { std::slice::from_raw_parts(ptr, len) };
    let info = FrameInfo {
        rows,
        columns: cols,
        samples_per_pixel: spp as u16,
        bits_allocated: ba as u16,
        bits_stored: bs as u16,
        pixel_representation: 0,
        photometric: [Photometric::Monochrome2, Photometric::Rgb, Photometric::YbrFull, Photometric::YbrFull422][photometric as usize],
        planar_configuration: 0,
        transfer_syntax: "1.2.840.10008.1.2.4.50".into(),
    };
    match shl_codec_jpeg::decode_frame_scaled(cs, &info, s as u8) {
        Ok(d) => {
            let n = d.frame.data.len() as i32;
            // SAFETY: single-threaded wasm.
            unsafe { OUT = d.frame.data };
            n
        }
        Err(_) => -1,
    }
}

#[no_mangle]
pub extern "C" fn out_ptr() -> *const u8 {
    // SAFETY: single-threaded wasm.
    unsafe { (*std::ptr::addr_of!(OUT)).as_ptr() }
}
