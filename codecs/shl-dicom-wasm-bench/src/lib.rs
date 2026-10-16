//! Benchmark wrapper around [`shl_dicom_decode::decode_file`].
//!
//! [`decode_timed`] runs the normal decode, but routes every codec call through a timing shim
//! (via `decode_file_with`), so one decode splits into three stages without touching the
//! decoder itself:
//!
//! - `parse_ms`: from the start to the first codec call (DICOM parse, frame split). For native
//!   (uncompressed) syntaxes there is no codec call, so the whole decode counts as `parse_ms`.
//! - `codec_ms`: time inside the codec's `decode_frame`, summed over frames.
//! - `normalise_ms`: everything else (planar interleave, Bits Stored masking, YBR->RGB, copying
//!   frames into the output).
//!
//! On wasm32 the clock is imported from JavaScript as `env.bench_now` (performance.now()), and
//! the module exports a small C ABI (`bench_*`) used by codecs/bench/lib/wasm.ts. No wasm-bindgen.

use std::sync::Mutex;

use shl_codec_common::{DecodeFn, DecodedFrame, FrameInfo};
pub use shl_dicom_decode::{Canonical, Error};

#[derive(Debug, Clone, Copy, Default)]
pub struct Timings {
    pub total_ms: f64,
    pub parse_ms: f64,
    pub codec_ms: f64,
    pub normalise_ms: f64,
    /// Absolute clock values (ms) for trace marks: start, first codec call, end.
    pub t_start: f64,
    pub t_first_codec: f64,
    pub t_end: f64,
    pub codec_calls: u32,
}

#[cfg(target_arch = "wasm32")]
mod clock {
    #[link(wasm_import_module = "env")]
    extern "C" {
        fn bench_now() -> f64;
    }
    pub fn now() -> f64 {
        // SAFETY: imported pure function returning a number.
        unsafe { bench_now() }
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod clock {
    use std::sync::OnceLock;
    use std::time::Instant;
    static T0: OnceLock<Instant> = OnceLock::new();
    pub fn now() -> f64 {
        T0.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
    }
}

pub use clock::now;

/// The shim's state. Process-wide, not per thread: native multi-frame decodes run frames on
/// worker threads. Codec time is then summed over threads, so it can exceed the wall time;
/// pin the process to one CPU for single-core numbers.
struct Shim {
    real: Option<DecodeFn>,
    first: f64,
    codec: f64,
    calls: u32,
}

static SHIM: Mutex<Shim> = Mutex::new(Shim { real: None, first: f64::NAN, codec: 0.0, calls: 0 });

fn shim() -> std::sync::MutexGuard<'static, Shim> {
    SHIM.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn timed_codec(cs: &[u8], info: &FrameInfo) -> shl_codec_common::Result<DecodedFrame> {
    let real = shim().real.ok_or_else(|| shl_codec_common::DecodeError::Invalid("bench: no codec".into()))?;
    let t = now();
    let r = real(cs, info);
    let dt = now() - t;
    let mut s = shim();
    if s.first.is_nan() || t < s.first {
        s.first = t;
    }
    s.codec += dt;
    s.calls += 1;
    r
}

/// `decode_file` with stage timings. Produces exactly the same pixels as `decode_file`.
pub fn decode_timed(bytes: &[u8]) -> (Result<Canonical, Error>, Timings) {
    {
        let mut s = shim();
        (s.first, s.codec, s.calls) = (f64::NAN, 0.0, 0);
    }
    let t0 = now();
    let r = shl_dicom_decode::decode_file_with(bytes, |ts| {
        let real = shl_dicom_decode::codec_for(ts);
        shim().real = real;
        real.map(|_| timed_codec as DecodeFn)
    });
    let t1 = now();
    let (first, codec, calls) = {
        let s = shim();
        (s.first, s.codec, s.calls)
    };
    let total = t1 - t0;
    let parse = if first.is_nan() { total } else { first - t0 };
    let t = Timings {
        total_ms: total,
        parse_ms: parse,
        codec_ms: codec,
        normalise_ms: (total - parse - codec).max(0.0),
        t_start: t0,
        t_first_codec: if first.is_nan() { t1 } else { first },
        t_end: t1,
        codec_calls: calls,
    };
    (r, t)
}

thread_local! {
    static CAPTURED: std::cell::RefCell<Vec<Vec<u8>>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn capture_codec(cs: &[u8], info: &FrameInfo) -> shl_codec_common::Result<DecodedFrame> {
    CAPTURED.with(|c| c.borrow_mut().push(cs.to_vec()));
    let n = info
        .frame_bytes()
        .ok_or_else(|| shl_codec_common::DecodeError::Unsupported("frame too large".into()))?;
    Ok(DecodedFrame {
        data: vec![0; n],
        planar: false,
        color: shl_codec_common::ColorOut::Rgb,
    })
}

/// The codestream of every frame, split exactly as `decode_file` splits them (so another codec
/// can be timed on the same bytes our codec receives). Native syntaxes return an error.
pub fn extract_frames(bytes: &[u8]) -> Result<Vec<Vec<u8>>, Error> {
    CAPTURED.with(|c| c.borrow_mut().clear());
    shl_dicom_decode::decode_file_with(bytes, |ts| {
        shl_dicom_decode::codec_for(ts).map(|_| capture_codec as DecodeFn)
    })?;
    Ok(CAPTURED.with(|c| std::mem::take(&mut *c.borrow_mut())))
}

/// Cheap 64-bit hash of the output, to check every measured run returns the same pixels as the
/// verified one. Not cryptographic.
pub fn quick_hash(data: &[u8]) -> u64 {
    let mut h: u64 = 0x9E37_79B9_7F4A_7C15 ^ data.len() as u64;
    let mut chunks = data.chunks_exact(8);
    for c in &mut chunks {
        let mut w = [0u8; 8];
        w.copy_from_slice(c);
        h = (h ^ u64::from_le_bytes(w))
            .wrapping_mul(0x0100_0000_01B3)
            .rotate_left(29);
    }
    for &b in chunks.remainder() {
        h = (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01B3);
    }
    h ^ (h >> 31)
}

#[cfg(target_arch = "wasm32")]
mod exports {
    //! C ABI for JavaScript. Single-threaded; one result is held at a time.
    use super::*;
    use std::cell::{Cell, RefCell};

    thread_local! {
        static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
        static MSG: RefCell<String> = const { RefCell::new(String::new()) };
        static TIM: Cell<Timings> = Cell::new(Timings::default());
        static META: Cell<[u32; 6]> = const { Cell::new([0; 6]) };
    }

    #[no_mangle]
    pub extern "C" fn bench_alloc(len: usize) -> *mut u8 {
        let mut v = Vec::<u8>::with_capacity(len);
        let p = v.as_mut_ptr();
        std::mem::forget(v);
        p
    }

    /// # Safety
    /// `ptr`/`len` must come from `bench_alloc(len)`.
    #[no_mangle]
    pub unsafe extern "C" fn bench_free(ptr: *mut u8, len: usize) {
        drop(Vec::from_raw_parts(ptr, 0, len));
    }

    /// Decode the DICOM file at ptr/len. Returns 0, or the CONTRACT exit code (2, 3).
    /// The input stays owned by the caller.
    ///
    /// # Safety
    /// `ptr`/`len` must be a live allocation from `bench_alloc`.
    #[no_mangle]
    pub unsafe extern "C" fn bench_decode(ptr: *const u8, len: usize) -> i32 {
        // Drop the previous result first so its memory can be reused, outside the timed region.
        OUT.with(|o| *o.borrow_mut() = Vec::new());
        let bytes = std::slice::from_raw_parts(ptr, len);
        let (r, t) = decode_timed(bytes);
        TIM.with(|c| c.set(t));
        match r {
            Ok(img) => {
                META.with(|m| {
                    m.set([
                        img.frames,
                        img.rows,
                        img.columns,
                        u32::from(img.samples_per_pixel),
                        u32::from(img.bits_allocated),
                        u32::from(img.signed),
                    ])
                });
                OUT.with(|o| *o.borrow_mut() = img.data);
                0
            }
            Err(e) => {
                MSG.with(|m| *m.borrow_mut() = e.to_string());
                e.exit_code()
            }
        }
    }

    thread_local! {
        static FRAMES: RefCell<Vec<Vec<u8>>> = const { RefCell::new(Vec::new()) };
    }

    /// Split the file at ptr/len into frame codestreams; returns the frame count, or -exit code.
    ///
    /// # Safety
    /// `ptr`/`len` must be a live allocation from `bench_alloc`.
    #[no_mangle]
    pub unsafe extern "C" fn bench_extract_frames(ptr: *const u8, len: usize) -> i32 {
        let bytes = std::slice::from_raw_parts(ptr, len);
        match extract_frames(bytes) {
            Ok(f) => {
                let n = f.len() as i32;
                FRAMES.with(|x| *x.borrow_mut() = f);
                n
            }
            Err(e) => {
                MSG.with(|m| *m.borrow_mut() = e.to_string());
                -e.exit_code()
            }
        }
    }
    #[no_mangle]
    pub extern "C" fn bench_frame_ptr(i: usize) -> *const u8 {
        FRAMES.with(|x| x.borrow().get(i).map_or(std::ptr::null(), |f| f.as_ptr()))
    }
    #[no_mangle]
    pub extern "C" fn bench_frame_len(i: usize) -> usize {
        FRAMES.with(|x| x.borrow().get(i).map_or(0, Vec::len))
    }
    #[no_mangle]
    pub extern "C" fn bench_frames_free() {
        FRAMES.with(|x| *x.borrow_mut() = Vec::new());
    }

    #[no_mangle]
    pub extern "C" fn bench_out_ptr() -> *const u8 {
        OUT.with(|o| o.borrow().as_ptr())
    }
    #[no_mangle]
    pub extern "C" fn bench_out_len() -> usize {
        OUT.with(|o| o.borrow().len())
    }
    #[no_mangle]
    pub extern "C" fn bench_out_free() {
        OUT.with(|o| *o.borrow_mut() = Vec::new());
    }
    /// Hash of the last output, split in two 32-bit halves (0 low, 1 high).
    #[no_mangle]
    pub extern "C" fn bench_out_hash(half: u32) -> u32 {
        let h = OUT.with(|o| quick_hash(&o.borrow()));
        if half == 0 {
            h as u32
        } else {
            (h >> 32) as u32
        }
    }
    #[no_mangle]
    pub extern "C" fn bench_meta(i: u32) -> u32 {
        META.with(|m| m.get().get(i as usize).copied().unwrap_or(0))
    }
    /// 0 total, 1 parse, 2 codec, 3 normalise, 4 t_start, 5 t_first_codec, 6 t_end, 7 codec calls.
    #[no_mangle]
    pub extern "C" fn bench_timing(i: u32) -> f64 {
        let t = TIM.with(Cell::get);
        match i {
            0 => t.total_ms,
            1 => t.parse_ms,
            2 => t.codec_ms,
            3 => t.normalise_ms,
            4 => t.t_start,
            5 => t.t_first_codec,
            6 => t.t_end,
            7 => f64::from(t.codec_calls),
            _ => f64::NAN,
        }
    }
    #[no_mangle]
    pub extern "C" fn bench_msg_ptr() -> *const u8 {
        MSG.with(|m| m.borrow().as_ptr())
    }
    #[no_mangle]
    pub extern "C" fn bench_msg_len() -> usize {
        MSG.with(|m| m.borrow().len())
    }
}
