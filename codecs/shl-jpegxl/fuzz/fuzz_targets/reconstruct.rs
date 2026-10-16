//! Fuzz JPEG reconstruction (jbrd box, brotli, VarDCT coefficients, JPEG writer): any input
//! must give a JPEG or an error, never a panic (images are capped at 2^20 pixels).
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = shl_jpegxl::reconstruct_jpeg(data, &shl_jpegxl::Options { max_pixels: 1 << 20 });
});
