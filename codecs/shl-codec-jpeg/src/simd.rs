//! SIMD kernels and their dispatch.
//!
//! - **x86_64:** AVX2 kernels, chosen at run time when the CPU has AVX2 (the default target has
//!   only SSE2, which lacks a 32-bit multiply).
//! - **wasm32 built with `-C target-feature=+simd128`:** simd128 kernels.
//! - **Otherwise:** the scalar kernels.
//!
//! Each vector kernel runs the same operations as the scalar code it replaces, in the same order
//! and on the same integer types (`idct_1d` is shared through the `Lane` trait), so its results
//! are bit-identical. That is checked by unit tests on random input here and in `idct.rs`, and
//! by the corpus test, which decodes every frame with each available kernel set.
//!
//! `unsafe` is confined to this module and used for two things only:
//! - calling `#[target_feature(enable = "avx2")]` code, done only after
//!   `is_x86_feature_detected!("avx2")`;
//! - unaligned vector loads and stores, each preceded by a length check on its slice.
#![allow(unsafe_code)]

use crate::dct::RowJob;
use crate::idct::{self, SMALL_MAX};
use crate::out::{Sample, Sink};

/// Which kernels to run; chosen once per frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kernels {
    Scalar,
    /// x86_64 AVX2, or wasm32 simd128, whichever this build targets.
    Vector,
}

#[cfg(test)]
thread_local!(static FORCE_SCALAR: core::cell::Cell<bool> = const { core::cell::Cell::new(false) });

impl Kernels {
    pub(crate) fn detect() -> Self {
        #[cfg(test)]
        if FORCE_SCALAR.with(|f| f.get()) {
            return Kernels::Scalar;
        }
        #[cfg(target_arch = "x86_64")]
        if std::is_x86_feature_detected!("avx2") {
            return Kernels::Vector;
        }
        #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
        return Kernels::Vector;
        #[allow(unreachable_code)]
        Kernels::Scalar
    }

    /// Every kernel set this machine can run, for tests that compare them.
    #[cfg(test)]
    pub(crate) fn available() -> Vec<Self> {
        let mut v = vec![Kernels::Scalar];
        if Self::detect() == Kernels::Vector {
            v.push(Kernels::Vector);
        }
        v
    }

    /// Dequantise (`blk[i] * q[i]`, both 16-bit values) and inverse-transform one block. Blocks
    /// whose dequantised coefficients all lie within ±SMALL_MAX take the 32-bit path; others
    /// (only corrupt data) the 64-bit reference (see `idct.rs`).
    #[inline]
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn idct<T: Sample>(self, blk: &[i32; 64], q: &[i32; 64], pass1: u32, max: i32, range: &[u16], out: &mut [T], stride: usize) {
        if self == Kernels::Vector && stride >= 8 && out.len() >= 7 * stride + 8 {
            #[cfg(target_arch = "x86_64")]
            // SAFETY: `Vector` is only chosen on x86_64 when the CPU has AVX2.
            return unsafe { avx2::idct(blk, q, pass1, max, range, out, stride) };
            #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
            return wasm::idct(blk, q, pass1, max, range, out, stride);
        }
        let _ = max; // only the vector kernels need it
        let deq: [i32; 64] = core::array::from_fn(|i| blk[i] * q[i]);
        if deq.iter().all(|d| d.unsigned_abs() <= SMALL_MAX) {
            idct::idct_small(&deq, pass1, range, out, stride)
        } else {
            idct::idct_ref(&deq, pass1, range, out, stride)
        }
    }
}

impl Kernels {
    /// Dequantise and run the reduced IDCT of `size` 4 or 2 (`idct::idct_reduced`). The vector
    /// kernels handle blocks whose dequantised coefficients lie within ±REDUCED_MAX, with the same
    /// results; others go to the scalar code.
    #[inline]
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn idct_reduced<T: Sample>(
        self,
        size: usize,
        blk: &[i32; 64],
        q: &[i32; 64],
        pass1: u32,
        max: i32,
        range: &[u16],
        out: &mut [T],
        stride: usize,
    ) {
        if self == Kernels::Vector && (size == 4 || size == 2) && stride >= size && out.len() >= (size - 1) * stride + size {
            #[cfg(target_arch = "x86_64")]
            // SAFETY: `Vector` is only chosen on x86_64 when the CPU has AVX2.
            return unsafe { avx2::idct_reduced(size, blk, q, pass1, max, range, out, stride) };
            #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
            return wasm::idct_reduced(size, blk, q, pass1, max, range, out, stride);
        }
        let _ = max;
        let deq: [i32; 64] = core::array::from_fn(|i| blk[i] * q[i]);
        idct::idct_reduced(size, &deq, pass1, range, out, stride)
    }

    /// Upsampling, colour conversion and output (`dct::RowJob`). On x86_64 with AVX2 the same
    /// code is compiled with AVX2 enabled; LLVM vectorises its loops. wasm simd128 builds
    /// vectorise it the same way without a separate copy.
    pub(crate) fn rows<T: Sample>(self, job: &RowJob<T>, sink: &mut Sink) {
        #[cfg(target_arch = "x86_64")]
        if self == Kernels::Vector {
            // SAFETY: `Vector` is only chosen on x86_64 when the CPU has AVX2.
            return unsafe { rows_avx2(job, sink) };
        }
        job.run(sink)
    }
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
fn rows_avx2<T: Sample>(job: &RowJob<T>, sink: &mut Sink) {
    job.run(sink)
}

/// The final steps shared by both vector IDCTs, per lane: descale, then libjpeg's range limit as
/// arithmetic (the identity is documented and tested in `idct.rs`).
#[cfg(any(target_arch = "x86_64", all(target_arch = "wasm32", target_feature = "simd128")))]
#[derive(Clone, Copy)]
struct Limits {
    k: i32,
    mask: i32,
    two_n: i32,
    max: i32,
}

#[cfg(any(target_arch = "x86_64", all(target_arch = "wasm32", target_feature = "simd128")))]
impl Limits {
    fn new(max: i32) -> Self {
        let n = max + 1;
        Self { k: 2 * n + n / 2, mask: 4 * n - 1, two_n: 2 * n, max }
    }
}

#[cfg(target_arch = "x86_64")]
mod avx2 {
    use super::Limits;
    use crate::idct::{idct2_1d, idct4_1d, idct_1d, Lane, CONST_BITS, REDUCED_MAX, SMALL_MAX};
    use crate::out::Sample;
    use core::arch::x86_64::*;
    use core::ops::{Add, Sub};

    /// One row of 8 lanes. Only built inside `#[target_feature(enable = "avx2")]` functions, so
    /// the AVX2 instructions its methods use are always available.
    #[derive(Clone, Copy)]
    struct Y(__m256i);

    impl Add for Y {
        type Output = Y;
        #[inline(always)]
        fn add(self, o: Y) -> Y {
            // SAFETY: see `Y`.
            Y(unsafe { _mm256_add_epi32(self.0, o.0) })
        }
    }
    impl Sub for Y {
        type Output = Y;
        #[inline(always)]
        fn sub(self, o: Y) -> Y {
            // SAFETY: see `Y`.
            Y(unsafe { _mm256_sub_epi32(self.0, o.0) })
        }
    }
    impl Lane for Y {
        #[inline(always)]
        fn mulc(self, c: i32) -> Y {
            // SAFETY: see `Y`.
            Y(unsafe { _mm256_mullo_epi32(self.0, _mm256_set1_epi32(c)) })
        }
        #[inline(always)]
        fn shl(self, n: u32) -> Y {
            // SAFETY: see `Y`.
            Y(unsafe { _mm256_sll_epi32(self.0, _mm_cvtsi32_si128(n as i32)) })
        }
    }

    #[inline]
    #[target_feature(enable = "avx2")]
    fn descale(x: Y, n: u32) -> Y {
        let r = _mm256_set1_epi32(1 << (n - 1));
        Y(_mm256_sra_epi32(_mm256_add_epi32(x.0, r), _mm_cvtsi32_si128(n as i32)))
    }

    #[inline]
    #[target_feature(enable = "avx2")]
    fn transpose(m: [Y; 8]) -> [Y; 8] {
        let [r0, r1, r2, r3, r4, r5, r6, r7] = m.map(|y| y.0);
        let t0 = _mm256_unpacklo_epi32(r0, r1);
        let t1 = _mm256_unpackhi_epi32(r0, r1);
        let t2 = _mm256_unpacklo_epi32(r2, r3);
        let t3 = _mm256_unpackhi_epi32(r2, r3);
        let t4 = _mm256_unpacklo_epi32(r4, r5);
        let t5 = _mm256_unpackhi_epi32(r4, r5);
        let t6 = _mm256_unpacklo_epi32(r6, r7);
        let t7 = _mm256_unpackhi_epi32(r6, r7);
        let u0 = _mm256_unpacklo_epi64(t0, t2);
        let u1 = _mm256_unpackhi_epi64(t0, t2);
        let u2 = _mm256_unpacklo_epi64(t1, t3);
        let u3 = _mm256_unpackhi_epi64(t1, t3);
        let u4 = _mm256_unpacklo_epi64(t4, t6);
        let u5 = _mm256_unpackhi_epi64(t4, t6);
        let u6 = _mm256_unpacklo_epi64(t5, t7);
        let u7 = _mm256_unpackhi_epi64(t5, t7);
        [
            Y(_mm256_permute2x128_si256::<0x20>(u0, u4)),
            Y(_mm256_permute2x128_si256::<0x20>(u1, u5)),
            Y(_mm256_permute2x128_si256::<0x20>(u2, u6)),
            Y(_mm256_permute2x128_si256::<0x20>(u3, u7)),
            Y(_mm256_permute2x128_si256::<0x31>(u0, u4)),
            Y(_mm256_permute2x128_si256::<0x31>(u1, u5)),
            Y(_mm256_permute2x128_si256::<0x31>(u2, u6)),
            Y(_mm256_permute2x128_si256::<0x31>(u3, u7)),
        ]
    }

    /// `Kernels::idct` with AVX2: dequantisation and `idct::idct_small` with no zero shortcuts
    /// (they are exact rewrites). Caller checks `out.len() >= 7 * stride + 8`.
    #[target_feature(enable = "avx2")]
    #[allow(clippy::too_many_arguments)]
    pub(super) fn idct<T: Sample>(blk: &[i32; 64], q: &[i32; 64], pass1: u32, max: i32, range: &[u16], out: &mut [T], stride: usize) {
        // SAFETY: both arrays have 64 elements, so 8 are readable at r * 8 for r < 8.
        let ld = |a: &[i32; 64], r: usize| unsafe { _mm256_loadu_si256(a.as_ptr().add(r * 8).cast()) };
        let rows: [Y; 8] = core::array::from_fn(|r| Y(_mm256_mullo_epi32(ld(blk, r), ld(q, r))));
        let small = _mm256_set1_epi32(SMALL_MAX as i32);
        let over = rows.iter().fold(_mm256_setzero_si256(), |acc, y| {
            _mm256_or_si256(acc, _mm256_cmpgt_epi32(_mm256_abs_epi32(y.0), small))
        });
        if _mm256_movemask_epi8(over) != 0 {
            let deq: [i32; 64] = core::array::from_fn(|i| blk[i] * q[i]);
            return crate::idct::idct_ref(&deq, pass1, range, out, stride);
        }
        let ws = idct_1d(rows).map(|y| descale(y, CONST_BITS - pass1));
        let cols = idct_1d(transpose(ws)).map(|y| descale(y, CONST_BITS + pass1 + 3));
        let l = Limits::new(max);
        let (k, mask, two_n) = (_mm256_set1_epi32(l.k), _mm256_set1_epi32(l.mask), _mm256_set1_epi32(l.two_n));
        let (zero, vmax) = (_mm256_setzero_si256(), _mm256_set1_epi32(l.max));
        let lim = cols.map(|y| {
            let v = _mm256_sub_epi32(_mm256_and_si256(_mm256_add_epi32(y.0, k), mask), two_n);
            Y(_mm256_min_epi32(_mm256_max_epi32(v, zero), vmax))
        });
        let rows = transpose(lim);
        assert!(out.len() >= 7 * stride + 8);
        let base = out.as_mut_ptr();
        for r in (0..8).step_by(2) {
            // Values are in 0..=max (<= 4095), so the unsigned saturating packs are exact.
            // p = row r then row r + 1, as 16-bit values.
            let p = _mm256_permute4x64_epi64::<0b11_01_10_00>(_mm256_packus_epi32(rows[r].0, rows[r + 1].0));
            let (lo, hi) = (_mm256_castsi256_si128(p), _mm256_extracti128_si256::<1>(p));
            // SAFETY: the assert above; each store writes 8 samples at the start of row r or r + 1.
            unsafe {
                if T::BYTES == 1 {
                    let b = _mm_packus_epi16(lo, hi);
                    _mm_storel_epi64(base.add(r * stride).cast(), b);
                    _mm_storel_epi64(base.add((r + 1) * stride).cast(), _mm_unpackhi_epi64(b, b));
                } else {
                    _mm_storeu_si128(base.add(r * stride).cast(), lo);
                    _mm_storeu_si128(base.add((r + 1) * stride).cast(), hi);
                }
            }
        }
    }
    /// `Kernels::idct_reduced` with AVX2: lanes are columns in pass 1. For 4×4, pass 2 runs on
    /// the transposed work array (lanes are rows); for 2×2 it runs in 64 bits (`idct2_rows`).
    /// Caller checks `out.len() >= (size - 1) * stride + size`.
    #[target_feature(enable = "avx2")]
    #[allow(clippy::too_many_arguments)]
    pub(super) fn idct_reduced<T: Sample>(
        size: usize,
        blk: &[i32; 64],
        q: &[i32; 64],
        pass1: u32,
        max: i32,
        range: &[u16],
        out: &mut [T],
        stride: usize,
    ) {
        // SAFETY: both arrays have 64 elements, so 8 are readable at r * 8 for r < 8.
        let ld = |a: &[i32; 64], r: usize| unsafe { _mm256_loadu_si256(a.as_ptr().add(r * 8).cast()) };
        let rows: [Y; 8] = core::array::from_fn(|r| Y(_mm256_mullo_epi32(ld(blk, r), ld(q, r))));
        let lim_v = _mm256_set1_epi32(REDUCED_MAX as i32);
        let over = rows.iter().fold(_mm256_setzero_si256(), |acc, y| {
            _mm256_or_si256(acc, _mm256_cmpgt_epi32(_mm256_abs_epi32(y.0), lim_v))
        });
        let store = |y: Y| {
            let mut a = [0i32; 8];
            // SAFETY: `a` holds 8 i32.
            unsafe { _mm256_storeu_si256(a.as_mut_ptr().cast(), y.0) };
            a
        };
        if _mm256_movemask_epi8(over) != 0 {
            let deq: [i32; 64] = core::array::from_fn(|i| blk[i] * q[i]);
            return crate::idct::idct_reduced(size, &deq, pass1, range, out, stride);
        }
        if size == 2 {
            let ws = idct2_1d(rows).map(|y| store(descale(y, CONST_BITS - pass1 + 2)).map(i64::from));
            return crate::idct::idct2_rows(&ws, pass1, range, out, stride);
        }
        let ws = idct4_1d(rows).map(|y| descale(y, CONST_BITS - pass1 + 1));
        let z = Y(_mm256_setzero_si256());
        let cols = transpose([ws[0], ws[1], ws[2], ws[3], z, z, z, z]);
        let l = Limits::new(max);
        let (k, mask, two_n) = (_mm256_set1_epi32(l.k), _mm256_set1_epi32(l.mask), _mm256_set1_epi32(l.two_n));
        let (zero, vmax) = (_mm256_setzero_si256(), _mm256_set1_epi32(l.max));
        // o[c] lane r is output row r, column c.
        let o = idct4_1d(cols).map(|y| {
            let y = descale(y, CONST_BITS + pass1 + 4);
            let v = _mm256_sub_epi32(_mm256_and_si256(_mm256_add_epi32(y.0, k), mask), two_n);
            store(Y(_mm256_min_epi32(_mm256_max_epi32(v, zero), vmax)))
        });
        for r in 0..4 {
            let dst = &mut out[r * stride..r * stride + 4];
            for (c, d) in dst.iter_mut().enumerate() {
                *d = T::from_u16(o[c][r] as u16);
            }
        }
    }
}


#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
pub(crate) mod wasm {
    use super::Limits;
    use crate::idct::{idct2_1d, idct4_1d, idct_1d, Lane, CONST_BITS, REDUCED_MAX, SMALL_MAX};
    use crate::out::Sample;
    use core::arch::wasm32::*;
    use core::ops::{Add, Sub};

    /// One row of 8 lanes as two `i32x4`.
    #[derive(Clone, Copy)]
    struct W(v128, v128);

    impl Add for W {
        type Output = W;
        #[inline(always)]
        fn add(self, o: W) -> W {
            W(i32x4_add(self.0, o.0), i32x4_add(self.1, o.1))
        }
    }
    impl Sub for W {
        type Output = W;
        #[inline(always)]
        fn sub(self, o: W) -> W {
            W(i32x4_sub(self.0, o.0), i32x4_sub(self.1, o.1))
        }
    }
    impl Lane for W {
        #[inline(always)]
        fn mulc(self, c: i32) -> W {
            let c = i32x4_splat(c);
            W(i32x4_mul(self.0, c), i32x4_mul(self.1, c))
        }
        #[inline(always)]
        fn shl(self, n: u32) -> W {
            W(i32x4_shl(self.0, n), i32x4_shl(self.1, n))
        }
    }

    #[inline(always)]
    fn descale(x: W, n: u32) -> W {
        let r = i32x4_splat(1 << (n - 1));
        W(i32x4_shr(i32x4_add(x.0, r), n), i32x4_shr(i32x4_add(x.1, r), n))
    }

    #[inline(always)]
    fn t4(a: v128, b: v128, c: v128, d: v128) -> [v128; 4] {
        let t0 = i32x4_shuffle::<0, 4, 1, 5>(a, b);
        let t1 = i32x4_shuffle::<2, 6, 3, 7>(a, b);
        let t2 = i32x4_shuffle::<0, 4, 1, 5>(c, d);
        let t3 = i32x4_shuffle::<2, 6, 3, 7>(c, d);
        [
            i32x4_shuffle::<0, 1, 4, 5>(t0, t2),
            i32x4_shuffle::<2, 3, 6, 7>(t0, t2),
            i32x4_shuffle::<0, 1, 4, 5>(t1, t3),
            i32x4_shuffle::<2, 3, 6, 7>(t1, t3),
        ]
    }

    #[inline(always)]
    fn transpose(m: [W; 8]) -> [W; 8] {
        let a = t4(m[0].0, m[1].0, m[2].0, m[3].0); // top-left
        let b = t4(m[4].0, m[5].0, m[6].0, m[7].0); // bottom-left
        let c = t4(m[0].1, m[1].1, m[2].1, m[3].1); // top-right
        let d = t4(m[4].1, m[5].1, m[6].1, m[7].1); // bottom-right
        [
            W(a[0], b[0]),
            W(a[1], b[1]),
            W(a[2], b[2]),
            W(a[3], b[3]),
            W(c[0], d[0]),
            W(c[1], d[1]),
            W(c[2], d[2]),
            W(c[3], d[3]),
        ]
    }

    /// 16 samples as two u16x8. Caller checks `s.len() >= 16`.
    #[inline(always)]
    fn load16<T: Sample>(s: &[T]) -> (v128, v128) {
        assert!(s.len() >= 16);
        // SAFETY: the assert above: 16 samples of T::BYTES bytes are readable.
        unsafe {
            if T::BYTES == 1 {
                let b = v128_load(s.as_ptr().cast());
                (u16x8_extend_low_u8x16(b), u16x8_extend_high_u8x16(b))
            } else {
                (v128_load(s.as_ptr().cast()), v128_load(s.as_ptr().add(8).cast()))
            }
        }
    }

    /// 8 samples as one u16x8. Caller checks `s.len() >= 8`.
    #[inline(always)]
    fn load8<T: Sample>(s: &[T]) -> v128 {
        assert!(s.len() >= 8);
        // SAFETY: the assert above: 8 samples of T::BYTES bytes are readable.
        unsafe {
            if T::BYTES == 1 {
                u16x8_extend_low_u8x16(v128_load64_zero(s.as_ptr().cast()))
            } else {
                v128_load(s.as_ptr().cast())
            }
        }
    }

    /// The middle of `dct::h2v1_fancy`: output pairs for inputs i = 1, 2, ... while a whole
    /// vector of 8 fits before the last input; returns the first i it did not do. Same
    /// arithmetic in u16 lanes (at most 4 * 4095 + 2, no overflow).
    pub(crate) fn h2v1_mid<T: Sample>(inp: &[T], out: &mut [T]) -> usize {
        let n = inp.len().min(out.len() / 2);
        let (one, two) = (u16x8_splat(1), u16x8_splat(2));
        let mut i = 1;
        while i + 9 <= n {
            let l = load8(&inp[i - 1..]);
            let c = load8(&inp[i..]);
            let r = load8(&inp[i + 1..]);
            let c3 = i16x8_add(i16x8_add(c, c), c);
            let even = u16x8_shr(i16x8_add(i16x8_add(c3, l), one), 2);
            let odd = u16x8_shr(i16x8_add(i16x8_add(c3, r), two), 2);
            let a = i16x8_shuffle::<0, 8, 1, 9, 2, 10, 3, 11>(even, odd);
            let b = i16x8_shuffle::<4, 12, 5, 13, 6, 14, 7, 15>(even, odd);
            let dst = &mut out[2 * i..2 * i + 16];
            // SAFETY: dst has exactly 16 samples of T::BYTES bytes each; values are at most
            // 4095 (12-bit) or 255 (8-bit, so the unsigned narrow is exact).
            unsafe {
                if T::BYTES == 1 {
                    v128_store(dst.as_mut_ptr().cast(), u8x16_narrow_i16x8(a, b));
                } else {
                    v128_store(dst.as_mut_ptr().cast(), a);
                    v128_store(dst.as_mut_ptr().add(8).cast(), b);
                }
            }
            i += 8;
        }
        i
    }

    /// `dct::ycc_px` on 8 pixels (u16x8 inputs, chroma not yet centred), each channel clamped
    /// to 0..=255 by the saturating narrows (values stay far inside i16 before that).
    #[inline(always)]
    fn ycc8(y: v128, cb: v128, cr: v128) -> [v128; 3] {
        use crate::dct::{FIX_0_34414, FIX_0_71414, FIX_1_40200, FIX_1_77200};
        let c128 = i16x8_splat(128);
        let (cb, cr) = (i16x8_sub(cb, c128), i16x8_sub(cr, c128));
        let half = i32x4_splat(1 << 15);
        let px = |y: v128, cb: v128, cr: v128| -> [v128; 3] {
            let r = i32x4_add(y, i32x4_shr(i32x4_add(i32x4_mul(cr, i32x4_splat(FIX_1_40200)), half), 16));
            let g = i32x4_mul(cb, i32x4_splat(-FIX_0_34414));
            let g = i32x4_sub(g, i32x4_mul(cr, i32x4_splat(FIX_0_71414)));
            let g = i32x4_add(y, i32x4_shr(i32x4_add(g, half), 16));
            let b = i32x4_add(y, i32x4_shr(i32x4_add(i32x4_mul(cb, i32x4_splat(FIX_1_77200)), half), 16));
            [r, g, b]
        };
        let lo = px(u32x4_extend_low_u16x8(y), i32x4_extend_low_i16x8(cb), i32x4_extend_low_i16x8(cr));
        let hi = px(u32x4_extend_high_u16x8(y), i32x4_extend_high_i16x8(cb), i32x4_extend_high_i16x8(cr));
        [0, 1, 2].map(|c| i16x8_narrow_i32x4(lo[c], hi[c]))
    }

    /// YCbCr→RGB for 8-bit output, 16 pixels at a time; returns how many pixels it converted
    /// (the caller converts the rest). Same arithmetic as `dct::ycc_px`.
    pub(crate) fn ycc_row8<T: Sample>(y: &[T], cb: &[T], cr: &[T], out: &mut [u8]) -> usize {
        let n = y.len().min(cb.len()).min(cr.len()).min(out.len() / 3);
        let mut x = 0;
        while x + 16 <= n {
            let (y0, y1) = load16(&y[x..]);
            let (cb0, cb1) = load16(&cb[x..]);
            let (cr0, cr1) = load16(&cr[x..]);
            let a = ycc8(y0, cb0, cr0);
            let b = ycc8(y1, cb1, cr1);
            let [r, g, bl] = [0, 1, 2].map(|c| u8x16_narrow_i16x8(a[c], b[c]));
            store_rgb(r, g, bl, &mut out[3 * x..3 * x + 48]);
            x += 16;
        }
        x
    }

    /// 16 pixels of 8-bit R, G, B interleaved into `dst` (exactly 48 bytes).
    #[inline(always)]
    fn store_rgb(r: v128, g: v128, bl: v128, dst: &mut [u8]) {
        let t0 = i8x16_shuffle::<0, 16, 0, 1, 17, 0, 2, 18, 0, 3, 19, 0, 4, 20, 0, 5>(r, g);
        let o0 = i8x16_shuffle::<0, 1, 16, 3, 4, 17, 6, 7, 18, 9, 10, 19, 12, 13, 20, 15>(t0, bl);
        let t1 = i8x16_shuffle::<21, 0, 6, 22, 0, 7, 23, 0, 8, 24, 0, 9, 25, 0, 10, 26>(r, g);
        let o1 = i8x16_shuffle::<0, 21, 2, 3, 22, 5, 6, 23, 8, 9, 24, 11, 12, 25, 14, 15>(t1, bl);
        let t2 = i8x16_shuffle::<0, 11, 27, 0, 12, 28, 0, 13, 29, 0, 14, 30, 0, 15, 31, 0>(r, g);
        let o2 = i8x16_shuffle::<26, 1, 2, 27, 4, 5, 28, 7, 8, 29, 10, 11, 30, 13, 14, 31>(t2, bl);
        assert!(dst.len() == 48);
        // SAFETY: the assert above: dst has exactly 48 bytes.
        unsafe {
            v128_store(dst.as_mut_ptr().cast(), o0);
            v128_store(dst.as_mut_ptr().add(16).cast(), o1);
            v128_store(dst.as_mut_ptr().add(32).cast(), o2);
        }
    }

    /// Three 8-bit components interleaved into RGB bytes, 16 pixels at a time; returns how many
    /// pixels it wrote (the caller writes the rest). Samples are at most 255, so the narrows are
    /// exact.
    pub(crate) fn rgb_row8<T: Sample>(r: &[T], g: &[T], b: &[T], out: &mut [u8]) -> usize {
        let n = r.len().min(g.len()).min(b.len()).min(out.len() / 3);
        let mut x = 0;
        while x + 16 <= n {
            let [r, g, bl] = [r, g, b].map(|s| {
                let (lo, hi) = load16(&s[x..]);
                u8x16_narrow_i16x8(lo, hi)
            });
            store_rgb(r, g, bl, &mut out[3 * x..3 * x + 48]);
            x += 16;
        }
        x
    }

    /// `Kernels::idct` with simd128: dequantisation and `idct::idct_small` with no zero
    /// shortcuts. Caller checks `out.len() >= 7 * stride + 8`.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn idct<T: Sample>(blk: &[i32; 64], q: &[i32; 64], pass1: u32, max: i32, range: &[u16], out: &mut [T], stride: usize) {
        let ld = |a: &[i32; 64], i: usize| i32x4(a[i], a[i + 1], a[i + 2], a[i + 3]);
        let dq = |i: usize| i32x4_mul(ld(blk, i), ld(q, i));
        let rows: [W; 8] = core::array::from_fn(|r| W(dq(r * 8), dq(r * 8 + 4)));
        let small = i32x4_splat(SMALL_MAX as i32);
        let over = rows.iter().fold(i32x4_splat(0), |acc, w| {
            v128_or(acc, v128_or(i32x4_gt(i32x4_abs(w.0), small), i32x4_gt(i32x4_abs(w.1), small)))
        });
        if v128_any_true(over) {
            let deq: [i32; 64] = core::array::from_fn(|i| blk[i] * q[i]);
            return crate::idct::idct_ref(&deq, pass1, range, out, stride);
        }
        let ws = idct_1d(rows).map(|y| descale(y, CONST_BITS - pass1));
        let cols = idct_1d(transpose(ws)).map(|y| descale(y, CONST_BITS + pass1 + 3));
        let l = Limits::new(max);
        let (k, mask, two_n) = (i32x4_splat(l.k), i32x4_splat(l.mask), i32x4_splat(l.two_n));
        let (zero, vmax) = (i32x4_splat(0), i32x4_splat(l.max));
        let lim1 = |v: v128| i32x4_min(i32x4_max(i32x4_sub(v128_and(i32x4_add(v, k), mask), two_n), zero), vmax);
        let lim = cols.map(|w| W(lim1(w.0), lim1(w.1)));
        for (r, w) in transpose(lim).iter().enumerate() {
            // Values are in 0..=max (<= 4095), so the unsigned saturating narrows are exact.
            let p = u16x8_narrow_i32x4(w.0, w.1);
            let dst = &mut out[r * stride..r * stride + 8];
            // SAFETY: dst has exactly 8 samples of T::BYTES bytes each.
            unsafe {
                if T::BYTES == 1 {
                    v128_store64_lane::<0>(u8x16_narrow_i16x8(p, p), dst.as_mut_ptr().cast());
                } else {
                    v128_store(dst.as_mut_ptr().cast(), p);
                }
            }
        }
    }
    /// `Kernels::idct_reduced` with simd128; the same steps as the AVX2 kernel.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn idct_reduced<T: Sample>(
        size: usize,
        blk: &[i32; 64],
        q: &[i32; 64],
        pass1: u32,
        max: i32,
        range: &[u16],
        out: &mut [T],
        stride: usize,
    ) {
        let ld = |a: &[i32; 64], i: usize| i32x4(a[i], a[i + 1], a[i + 2], a[i + 3]);
        let dq = |i: usize| i32x4_mul(ld(blk, i), ld(q, i));
        let rows: [W; 8] = core::array::from_fn(|r| W(dq(r * 8), dq(r * 8 + 4)));
        let lim_v = i32x4_splat(REDUCED_MAX as i32);
        let over = rows.iter().fold(i32x4_splat(0), |acc, w| {
            v128_or(acc, v128_or(i32x4_gt(i32x4_abs(w.0), lim_v), i32x4_gt(i32x4_abs(w.1), lim_v)))
        });
        if v128_any_true(over) {
            let deq: [i32; 64] = core::array::from_fn(|i| blk[i] * q[i]);
            return crate::idct::idct_reduced(size, &deq, pass1, range, out, stride);
        }
        let store = |w: W| {
            [
                i32x4_extract_lane::<0>(w.0),
                i32x4_extract_lane::<1>(w.0),
                i32x4_extract_lane::<2>(w.0),
                i32x4_extract_lane::<3>(w.0),
                i32x4_extract_lane::<0>(w.1),
                i32x4_extract_lane::<1>(w.1),
                i32x4_extract_lane::<2>(w.1),
                i32x4_extract_lane::<3>(w.1),
            ]
        };
        if size == 2 {
            let ws = idct2_1d(rows).map(|y| store(descale(y, CONST_BITS - pass1 + 2)).map(i64::from));
            return crate::idct::idct2_rows(&ws, pass1, range, out, stride);
        }
        let ws = idct4_1d(rows).map(|y| descale(y, CONST_BITS - pass1 + 1));
        let z = W(i32x4_splat(0), i32x4_splat(0));
        let cols = transpose([ws[0], ws[1], ws[2], ws[3], z, z, z, z]);
        let l = Limits::new(max);
        let (k, mask, two_n) = (i32x4_splat(l.k), i32x4_splat(l.mask), i32x4_splat(l.two_n));
        let (zero, vmax) = (i32x4_splat(0), i32x4_splat(l.max));
        let lim1 = |v: v128| i32x4_min(i32x4_max(i32x4_sub(v128_and(i32x4_add(v, k), mask), two_n), zero), vmax);
        // o[c] lane r is output row r, column c (only the low half: 4 rows).
        let o = idct4_1d(cols).map(|w| {
            let w = descale(w, CONST_BITS + pass1 + 4);
            store(W(lim1(w.0), lim1(w.1)))
        });
        for r in 0..4 {
            let dst = &mut out[r * stride..r * stride + 4];
            for (c, d) in dst.iter_mut().enumerate() {
                *d = T::from_u16(o[c][r] as u16);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::idct::tests::{random_block, Rng};
    use crate::idct::range_table;

    /// Every corpus frame (from `extract_frames.py`) decodes to the same bytes with the vector
    /// kernels as with the scalar ones.
    #[test]
    fn corpus_frames_match_scalar() {
        if Kernels::detect() != Kernels::Vector {
            eprintln!("no vector kernels on this machine; nothing to compare");
            return;
        }
        let mut frames = 0;
        for fmt in ["jpeg-dct", "jpeg-lossless"] {
            for case in crate::test_common::load_cases(fmt) {
                for (k, cs) in case.frames.iter().enumerate() {
                    let vector = crate::decode_frame(cs, &case.info);
                    FORCE_SCALAR.with(|f| f.set(true));
                    let scalar = crate::decode_frame(cs, &case.info);
                    FORCE_SCALAR.with(|f| f.set(false));
                    match (vector, scalar) {
                        (Ok(a), Ok(b)) => assert!(a.data == b.data && a.color == b.color, "{} frame {k}", case.name),
                        (Err(a), Err(b)) => assert_eq!(a.to_string(), b.to_string(), "{} frame {k}", case.name),
                        _ => panic!("{} frame {k}: vector and scalar disagree on success", case.name),
                    }
                    frames += 1;
                }
            }
        }
        eprintln!("{frames} frames compared");
    }

    #[test]
    fn reduced_idct_kernels_match_scalar_on_random_blocks() {
        let mut rng = Rng(0xFEED_FACE_1234_5678);
        for (max, pass1) in [(255, 2u32), (4095, 1)] {
            let range = range_table(max);
            for i in 0..100_000 {
                let nz = [1, 2, 6, 20, 64][i % 5];
                let qmax = [255u64, 4095, 65535][i % 3];
                let q: [i32; 64] = core::array::from_fn(|_| (rng.next() % (qmax + 1)) as i32);
                let lim = [32767i64, 2047, 255, 100][(i / 3) % 4];
                let b = random_block(&mut rng, lim, nz);
                let deq: [i32; 64] = core::array::from_fn(|k| b[k] * q[k]);
                for size in [4usize, 2] {
                    let mut want = [0u16; 4 * 7];
                    idct::idct_reduced(size, &deq, pass1, &range, &mut want, 7);
                    for k in Kernels::available() {
                        let mut got = [0u16; 4 * 7];
                        k.idct_reduced(size, &b, &q, pass1, max, &range, &mut got, 7);
                        assert_eq!(want, got, "{k:?} size {size} block {b:?} q {q:?}");
                        if max == 255 {
                            let mut got8 = [0u8; 4 * 7];
                            k.idct_reduced(size, &b, &q, pass1, max, &range, &mut got8, 7);
                            assert_eq!(want.map(|v| v as u8), got8, "{k:?} u8 size {size}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn idct_kernels_match_reference_on_random_blocks() {
        let mut rng = Rng(0xDEAD_BEEF_CAFE_F00D);
        for (max, pass1) in [(255, 2u32), (4095, 1)] {
            let range = range_table(max);
            for i in 0..100_000 {
                let nz = [1, 2, 6, 20, 64][i % 5];
                // Quantisers 1..=255, 1..=4095 or 0..=65535 so some blocks exceed SMALL_MAX.
                let qmax = [255u64, 4095, 65535][i % 3];
                let q: [i32; 64] = core::array::from_fn(|_| (rng.next() % (qmax + 1)) as i32);
                let lim = [32767i64, 2047, 255][(i / 3) % 3];
                let b = random_block(&mut rng, lim, nz);
                let deq: [i32; 64] = core::array::from_fn(|k| b[k] * q[k]);
                let mut want = [0u16; 8 * 11];
                idct::idct_ref(&deq, pass1, &range, &mut want, 11);
                for k in Kernels::available() {
                    let mut got = [0u16; 8 * 11];
                    k.idct(&b, &q, pass1, max, &range, &mut got, 11);
                    assert_eq!(want, got, "{k:?} block {b:?} q {q:?}");
                    if max == 255 {
                        let mut got8 = [0u8; 8 * 11];
                        k.idct(&b, &q, pass1, max, &range, &mut got8, 11);
                        assert_eq!(want.map(|v| v as u8), got8, "{k:?} u8 block {b:?} q {q:?}");
                    }
                }
            }
        }
    }
}
