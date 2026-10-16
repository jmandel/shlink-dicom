//! The output buffer: rows of interleaved samples, little-endian, Bits Allocated wide.

use crate::invalid;
use shl_codec_common::Result;

pub(crate) struct Sink {
    data: Vec<u8>,
    row_bytes: usize,
}

impl Sink {
    pub(crate) fn new(w: usize, h: usize, n: usize, bps: usize) -> Result<Self> {
        let row_bytes = w
            .checked_mul(n)
            .and_then(|v| v.checked_mul(bps))
            .ok_or_else(|| invalid("frame size overflows"))?;
        let total = row_bytes.checked_mul(h).ok_or_else(|| invalid("frame size overflows"))?;
        Ok(Self { data: vec![0; total], row_bytes })
    }

    #[inline(always)]
    pub(crate) fn row(&mut self, y: usize) -> &mut [u8] {
        &mut self.data[y * self.row_bytes..(y + 1) * self.row_bytes]
    }

    pub(crate) fn into_data(self) -> Vec<u8> {
        self.data
    }
}

/// A decoded sample as the DCT planes store it: `u8` for 8-bit precision, `u16` otherwise.
pub(crate) trait Sample: Copy + Default + Into<i32> + 'static {
    /// Bytes per sample (used by the SIMD kernels' stores).
    #[allow(dead_code)]
    const BYTES: usize;
    /// From a value known to fit (at most the precision's maximum).
    fn from_u16(v: u16) -> Self;
    /// This sample type's AVX2 kernels (IDCT, reduced IDCT, rows).
    #[cfg(target_arch = "x86_64")]
    fn avx2(k: &crate::simd::Avx2) -> (crate::simd::IdctFn<Self>, crate::simd::ReducedFn<Self>, crate::simd::RowsFn<Self>);
    /// Fill `dst` from little-endian packed samples: 8 per word for `u8`, 4 for `u16`.
    #[cfg(target_arch = "x86_64")]
    fn put_words(dst: &mut [Self], w: &[u64; 2]);
    /// wasm simd128: 8 samples from the start of `s` as u16 lanes.
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    fn get8(s: &[Self]) -> core::arch::wasm32::v128;
    /// wasm simd128: the first 8 (or 16) u16 lanes of `lo`, `hi` written as samples, values
    /// known to fit (u8 narrows them); `dst.len()` is 8 or 16.
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    fn put(dst: &mut [Self], lo: core::arch::wasm32::v128, hi: core::arch::wasm32::v128);
}

// The wasm loads and stores below use no `unsafe` pointer access: 8-bit samples go through
// 64-bit integers, 16-bit samples through lane constructors and extracts. LLVM combines both
// into `v128.load64_zero` / `v128.load` and vector or 64-bit stores.

impl Sample for u8 {
    const BYTES: usize = 1;
    #[inline(always)]
    fn from_u16(v: u16) -> Self {
        v as u8
    }
    #[cfg(target_arch = "x86_64")]
    #[inline(always)]
    fn avx2(k: &crate::simd::Avx2) -> (crate::simd::IdctFn<u8>, crate::simd::ReducedFn<u8>, crate::simd::RowsFn<u8>) {
        (k.idct8, k.reduced8, k.rows8)
    }
    #[cfg(target_arch = "x86_64")]
    #[inline(always)]
    fn put_words(dst: &mut [u8], w: &[u64; 2]) {
        dst[..8].copy_from_slice(&w[0].to_le_bytes());
    }
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    #[inline(always)]
    fn get8(s: &[u8]) -> core::arch::wasm32::v128 {
        use core::arch::wasm32::*;
        let w = u64::from_le_bytes(s[..8].try_into().unwrap_or_else(|_| unreachable!()));
        u16x8_extend_low_u8x16(u64x2(w, 0))
    }
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    #[inline(always)]
    fn put(dst: &mut [u8], lo: core::arch::wasm32::v128, hi: core::arch::wasm32::v128) {
        use core::arch::wasm32::*;
        let v = u8x16_narrow_i16x8(lo, hi);
        dst[..8].copy_from_slice(&u64x2_extract_lane::<0>(v).to_le_bytes());
        if dst.len() >= 16 {
            dst[8..16].copy_from_slice(&u64x2_extract_lane::<1>(v).to_le_bytes());
        }
    }
}

impl Sample for u16 {
    const BYTES: usize = 2;
    #[inline(always)]
    fn from_u16(v: u16) -> Self {
        v
    }
    #[cfg(target_arch = "x86_64")]
    #[inline(always)]
    fn avx2(k: &crate::simd::Avx2) -> (crate::simd::IdctFn<u16>, crate::simd::ReducedFn<u16>, crate::simd::RowsFn<u16>) {
        (k.idct16, k.reduced16, k.rows16)
    }
    #[cfg(target_arch = "x86_64")]
    #[inline(always)]
    fn put_words(dst: &mut [u16], w: &[u64; 2]) {
        let v: [u16; 8] = core::array::from_fn(|j| (w[j / 4] >> (16 * (j % 4))) as u16);
        dst[..8].copy_from_slice(&v);
    }
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    #[inline(always)]
    fn get8(s: &[u16]) -> core::arch::wasm32::v128 {
        let s: &[u16; 8] = s[..8].try_into().unwrap_or_else(|_| unreachable!());
        core::arch::wasm32::u16x8(s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7])
    }
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    #[inline(always)]
    fn put(dst: &mut [u16], lo: core::arch::wasm32::v128, hi: core::arch::wasm32::v128) {
        use core::arch::wasm32::u16x8_extract_lane as e;
        dst[..8].copy_from_slice(&[e::<0>(lo), e::<1>(lo), e::<2>(lo), e::<3>(lo), e::<4>(lo), e::<5>(lo), e::<6>(lo), e::<7>(lo)]);
        if dst.len() >= 16 {
            dst[8..16].copy_from_slice(&[e::<0>(hi), e::<1>(hi), e::<2>(hi), e::<3>(hi), e::<4>(hi), e::<5>(hi), e::<6>(hi), e::<7>(hi)]);
        }
    }
}

/// Write `src` to `out` at `bps` (1, 2 or 4) bytes per sample.
#[inline(always)]
pub(crate) fn put_row<T: Sample>(src: &[T], out: &mut [u8], bps: usize) {
    match bps {
        1 => {
            for (o, &s) in out.iter_mut().zip(src) {
                *o = s.into() as u8;
            }
        }
        2 => {
            for (o, &s) in out.chunks_exact_mut(2).zip(src) {
                o.copy_from_slice(&(s.into() as u16).to_le_bytes());
            }
        }
        _ => {
            for (o, &s) in out.chunks_exact_mut(4).zip(src) {
                o.copy_from_slice(&(s.into() as u16 as u32).to_le_bytes());
            }
        }
    }
}

/// Interleave one row of each component into `out`.
#[inline(always)]
pub(crate) fn interleave_row<T: Sample>(srcs: &[&[T]], out: &mut [u8], bps: usize) {
    if let [a, b, c] = srcs {
        match bps {
            1 => {
                #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
                let done = crate::simd::wasm::rgb_row8(a, b, c, out);
                #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
                let done = 0;
                let (a, b, c, out) = (&a[done..], &b[done..], &c[done..], &mut out[3 * done..]);
                for (o, ((&a, &b), &c)) in out.chunks_exact_mut(3).zip(a.iter().zip(b.iter()).zip(c.iter())) {
                    o.copy_from_slice(&[a.into() as u8, b.into() as u8, c.into() as u8]);
                }
                return;
            }
            2 => {
                for (o, ((&a, &b), &c)) in out.chunks_exact_mut(6).zip(a.iter().zip(b.iter()).zip(c.iter())) {
                    let [a, b, c] = [a, b, c].map(|v| (v.into() as u16).to_le_bytes());
                    o.copy_from_slice(&[a[0], a[1], b[0], b[1], c[0], c[1]]);
                }
                return;
            }
            _ => {}
        }
    }
    let n = srcs.len();
    for (c, src) in srcs.iter().enumerate() {
        for (x, &s) in src.iter().enumerate() {
            let i = (x * n + c) * bps;
            if let Some(o) = out.get_mut(i..i + bps) {
                put_row(&[s], o, bps);
            }
        }
    }
}
