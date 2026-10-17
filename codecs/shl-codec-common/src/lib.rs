//! Types shared by every codec crate. Owned by the coordinator; see codec-corpus/AGENTS.md.
#![forbid(unsafe_code)]

use std::fmt;

/// Photometric Interpretation as declared in the dataset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Photometric {
    Monochrome1,
    Monochrome2,
    PaletteColor,
    Rgb,
    YbrFull,
    YbrFull422,
    YbrPartial420,
    YbrPartial422,
    YbrIct,
    YbrRct,
    Other,
}

impl Photometric {
    pub fn parse(s: &str) -> Self {
        match s.trim() {
            "MONOCHROME1" => Self::Monochrome1,
            "MONOCHROME2" => Self::Monochrome2,
            "PALETTE COLOR" => Self::PaletteColor,
            "RGB" => Self::Rgb,
            "YBR_FULL" => Self::YbrFull,
            "YBR_FULL_422" => Self::YbrFull422,
            "YBR_PARTIAL_420" => Self::YbrPartial420,
            "YBR_PARTIAL_422" => Self::YbrPartial422,
            "YBR_ICT" => Self::YbrIct,
            "YBR_RCT" => Self::YbrRct,
            _ => Self::Other,
        }
    }
}

/// Everything a codec needs to know about one frame.
#[derive(Debug, Clone)]
pub struct FrameInfo {
    pub rows: u32,
    pub columns: u32,
    /// 1 or 3.
    pub samples_per_pixel: u16,
    /// 1, 8, 16 or 32.
    pub bits_allocated: u16,
    pub bits_stored: u16,
    /// 0 unsigned, 1 signed (two's complement).
    pub pixel_representation: u16,
    pub photometric: Photometric,
    /// 0 interleaved, 1 planar (meaningful for native and RLE data).
    pub planar_configuration: u16,
    pub transfer_syntax: String,
}

impl FrameInfo {
    pub fn bytes_per_sample(&self) -> usize {
        usize::from(self.bits_allocated.div_ceil(8))
    }

    /// Size of one decoded frame in bytes, or None if it overflows. Codecs must check
    /// dimensions read from a codestream against this before allocating.
    pub fn frame_bytes(&self) -> Option<usize> {
        (self.rows as usize)
            .checked_mul(self.columns as usize)?
            .checked_mul(usize::from(self.samples_per_pixel))?
            .checked_mul(self.bytes_per_sample())
    }
}

/// What colour space the decoded samples are in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorOut {
    /// Samples are in the space the dataset declares (the CLI converts YBR_* to RGB if needed).
    AsDeclared,
    /// The codec already produced RGB (for example JPEG YCbCr output converted, or JPEG 2000 RCT/ICT undone).
    Rgb,
}

/// One decoded frame.
#[derive(Debug, Clone)]
pub struct DecodedFrame {
    /// rows × columns × samples, little-endian, `bits_allocated` wide (1 byte for 8-bit, 2 for 16, 4 for 32).
    /// Values may still carry bits above Bits Stored; the CLI masks or sign-extends.
    pub data: Vec<u8>,
    /// true if `data` is planar (all of sample 0, then sample 1, ...); the CLI interleaves.
    pub planar: bool,
    pub color: ColorOut,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    /// Valid input this codec does not handle yet. The CLI exits 3.
    Unsupported(String),
    /// Malformed or non-conforming input. The CLI exits 2.
    Invalid(String),
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported(m) => write!(f, "unsupported: {m}"),
            Self::Invalid(m) => write!(f, "invalid: {m}"),
        }
    }
}

impl std::error::Error for DecodeError {}

pub type Result<T> = std::result::Result<T, DecodeError>;

/// Signature every codec crate exports as `pub fn decode_frame`.
pub type DecodeFn = fn(&[u8], &FrameInfo) -> Result<DecodedFrame>;

/// A frame decoded at reduced resolution by [`DecodeScaledFn`]. See CONTRACT.md,
/// "Reduced-resolution decode".
#[derive(Debug, Clone)]
pub struct DecodedScaled {
    /// Same layout and rules as a full decode, at `rows` × `columns`: `data` is exactly
    /// `rows × columns × samples × bytes per sample` long.
    pub frame: DecodedFrame,
    pub rows: u32,
    pub columns: u32,
}

/// Signature of an optional `pub fn decode_frame_scaled` in a codec crate: decode one frame at
/// 1/2^`scale_log2` of its size in each direction, using the codec's own reduced decode (JPEG
/// scaled IDCT, JPEG 2000 resolution levels). The result is
/// [`scaled_extent`]`(rows, s)` × [`scaled_extent`]`(columns, s)`. A codec returns
/// `Unsupported` for any scale it has no reduced decode for; the caller then decodes at full
/// size and downsamples itself. `scale_log2 = 0` is a full decode.
pub type DecodeScaledFn = fn(&[u8], &FrameInfo, u8) -> Result<DecodedScaled>;

/// The [`DecodeScaledFn`] for codecs without a reduced decode: always `Unsupported`.
pub fn decode_scaled_unsupported(_codestream: &[u8], _info: &FrameInfo, scale_log2: u8) -> Result<DecodedScaled> {
    Err(DecodeError::Unsupported(format!("no reduced-resolution decode (1/{} requested)", 1u64 << scale_log2.min(63))))
}

/// `ceil(n / 2^scale_log2)`: the size of one dimension after a reduced decode (the libjpeg and
/// OpenJPEG convention). 0 stays 0; any nonzero `n` gives at least 1.
pub fn scaled_extent(n: u32, scale_log2: u8) -> u32 {
    if scale_log2 >= 32 {
        return u32::from(n > 0);
    }
    let d = 1u64 << scale_log2;
    (u64::from(n).div_ceil(d)) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scaled_extent_rounds_up() {
        assert_eq!(scaled_extent(2048, 3), 256);
        assert_eq!(scaled_extent(2921, 3), 366);
        assert_eq!(scaled_extent(1, 3), 1);
        assert_eq!(scaled_extent(0, 3), 0);
        assert_eq!(scaled_extent(7, 0), 7);
        assert_eq!(scaled_extent(u32::MAX, 1), 1 << 31);
        assert_eq!(scaled_extent(u32::MAX, 40), 1);
    }
}

/// Work split over threads (outside wasm), for codecs whose output does not depend on how it is
/// split: the encoders' code-blocks and frames.
pub mod parallel {
    use std::cell::Cell;

    thread_local! {
        static LIMIT: Cell<usize> = const { Cell::new(usize::MAX) };
    }

    /// Runs `f` with at most `n` threads for [`threads`] on this thread: tests compare a threaded
    /// result with the one-thread result.
    #[doc(hidden)]
    pub fn with_thread_limit<R>(n: usize, f: impl FnOnce() -> R) -> R {
        let before = LIMIT.with(|l| l.replace(n.max(1)));
        let r = f();
        LIMIT.with(|l| l.set(before));
        r
    }

    /// Threads for `want` units of work: up to 8, as many as the machine has, at least 1; 1 in wasm.
    pub fn threads(want: usize) -> usize {
        if cfg!(target_arch = "wasm32") {
            return 1;
        }
        let have = std::thread::available_parallelism().map_or(1, |n| n.get());
        want.min(have).min(8).min(LIMIT.with(Cell::get)).max(1)
    }

    /// `f` over `items`, results in order, the items split into `threads` runs; each run gets its
    /// own state from `init`. A worker's panic is raised again here, so a failure is never a
    /// silently shorter result.
    pub fn map_chunks<T: Sync, S, R: Send>(items: &[T], threads: usize, init: impl Fn() -> S + Sync, f: impl Fn(&mut S, &T) -> R + Sync) -> Vec<R> {
        #[cfg(not(target_arch = "wasm32"))]
        if threads > 1 && items.len() > 1 {
            let per = items.len().div_ceil(threads);
            let (init, f) = (&init, &f);
            return std::thread::scope(|s| {
                let hs: Vec<_> = items
                    .chunks(per)
                    .map(|run| {
                        s.spawn(move || {
                            let mut st = init();
                            run.iter().map(|t| f(&mut st, t)).collect::<Vec<R>>()
                        })
                    })
                    .collect();
                hs.into_iter().flat_map(|h| h.join().unwrap_or_else(|e| std::panic::resume_unwind(e))).collect()
            });
        }
        let _ = threads;
        let mut st = init();
        items.iter().map(|t| f(&mut st, t)).collect()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn threaded_results_match_one_thread_in_order() {
            let items: Vec<u32> = (0..1000).collect();
            let one = map_chunks(&items, 1, || 0u32, |n, &x| { *n += 1; x * 3 });
            for t in [2, 3, 7] {
                assert_eq!(map_chunks(&items, t, || 0u32, |_, &x| x * 3), one, "{t} threads");
            }
        }

        #[test]
        #[should_panic(expected = "item 500")]
        fn a_worker_panic_is_raised() {
            let items: Vec<u32> = (0..1000).collect();
            map_chunks(&items, 4, || (), |_, &x| if x == 500 { panic!("item 500") } else { x });
        }

        #[test]
        fn the_limit_applies() {
            assert_eq!(with_thread_limit(1, || threads(100)), 1);
            assert!(threads(1) == 1);
        }
    }
}
