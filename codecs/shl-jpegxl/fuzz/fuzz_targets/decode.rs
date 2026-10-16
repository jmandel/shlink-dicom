//! Fuzz the whole decoder: any input must decode or return an error, never panic, within
//! libFuzzer's memory limit (images are capped at 2^20 pixels).
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let opts = shl_jpegxl::Options { max_pixels: 1 << 20 };
    if let Ok(img) = shl_jpegxl::decode(data, &opts) {
        let n = img.width as usize * img.height as usize;
        for p in &img.planes {
            match p {
                shl_jpegxl::Plane::Int(d) => assert_eq!(d.len(), n),
                shl_jpegxl::Plane::Float(d) => assert_eq!(d.len(), n),
            }
        }
    }
});
