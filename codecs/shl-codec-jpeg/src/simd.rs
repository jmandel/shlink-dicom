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
//! The only `unsafe` in the crate is the three calls below into `#[target_feature(enable =
//! "avx2")]` code, each made only when `Kernels::Vector` was chosen after
//! `is_x86_feature_detected!("avx2")`. The kernels themselves are safe code: the AVX2 ones use
//! the intrinsics inside AVX2 functions (target_feature 1.1), the simd128 ones the wasm32
//! intrinsics, which are safe in a simd128 build, and both load and store through slices.

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
            #[allow(unsafe_code)]
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
            #[allow(unsafe_code)]
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
            #[allow(unsafe_code)]
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
    //! Every function that uses AVX2 is `#[target_feature(enable = "avx2")]`, so the intrinsics
    //! are safe to call inside it (target_feature 1.1), and so are calls between these
    //! functions. Loads and stores go through arrays and lane extracts, which LLVM turns into
    //! the same vector loads and stores; no raw pointers.
    use super::Limits;
    use crate::idct::{idct2_1d, idct4_1d, idct_1d, Lane, CONST_BITS, REDUCED_MAX, SMALL_MAX};
    use crate::out::Sample;
    use core::arch::x86_64::*;
    use core::ops::{Add, Sub};

    /// One row of 8 lanes for the shared 1-D transforms. A trait method cannot enable AVX2, so
    /// `Lane` works on a plain array with wrapping arithmetic (what `_mm256_add_epi32`,
    /// `_mm256_mullo_epi32` and `_mm256_sll_epi32` compute); inlined into the AVX2 functions,
    /// LLVM emits those instructions.
    #[derive(Clone, Copy)]
    struct Y([i32; 8]);

    impl Add for Y {
        type Output = Y;
        #[inline(always)]
        fn add(self, o: Y) -> Y {
            Y(core::array::from_fn(|i| self.0[i].wrapping_add(o.0[i])))
        }
    }
    impl Sub for Y {
        type Output = Y;
        #[inline(always)]
        fn sub(self, o: Y) -> Y {
            Y(core::array::from_fn(|i| self.0[i].wrapping_sub(o.0[i])))
        }
    }
    impl Lane for Y {
        #[inline(always)]
        fn mulc(self, c: i32) -> Y {
            Y(self.0.map(|x| x.wrapping_mul(c)))
        }
        #[inline(always)]
        fn shl(self, n: u32) -> Y {
            Y(self.0.map(|x| x.wrapping_shl(n)))
        }
    }

    #[inline]
    #[target_feature(enable = "avx2")]
    fn v(y: Y) -> __m256i {
        let a = y.0;
        _mm256_setr_epi32(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7])
    }

    #[inline]
    #[target_feature(enable = "avx2")]
    fn y(v: __m256i) -> Y {
        Y([
            _mm256_extract_epi32::<0>(v),
            _mm256_extract_epi32::<1>(v),
            _mm256_extract_epi32::<2>(v),
            _mm256_extract_epi32::<3>(v),
            _mm256_extract_epi32::<4>(v),
            _mm256_extract_epi32::<5>(v),
            _mm256_extract_epi32::<6>(v),
            _mm256_extract_epi32::<7>(v),
        ])
    }

    /// Row r of a block, dequantised.
    #[inline]
    #[target_feature(enable = "avx2")]
    fn dequant_rows(blk: &[i32; 64], q: &[i32; 64]) -> [__m256i; 8] {
        let ld = |a: &[i32; 64], r: usize| {
            let s = &a[r * 8..r * 8 + 8];
            _mm256_setr_epi32(s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7])
        };
        core::array::from_fn(|r| _mm256_mullo_epi32(ld(blk, r), ld(q, r)))
    }

    /// Whether any lane of `rows` has |x| > `bound`.
    #[inline]
    #[target_feature(enable = "avx2")]
    fn any_over(rows: &[__m256i; 8], bound: u32) -> bool {
        let b = _mm256_set1_epi32(bound as i32);
        let over = rows.iter().fold(_mm256_setzero_si256(), |acc, &r| _mm256_or_si256(acc, _mm256_cmpgt_epi32(_mm256_abs_epi32(r), b)));
        _mm256_movemask_epi8(over) != 0
    }

    #[inline]
    #[target_feature(enable = "avx2")]
    fn descale(x: Y, n: u32) -> Y {
        let r = _mm256_set1_epi32(1 << (n - 1));
        y(_mm256_sra_epi32(_mm256_add_epi32(v(x), r), _mm_cvtsi32_si128(n as i32)))
    }

    #[inline]
    #[target_feature(enable = "avx2")]
    fn transpose(m: [__m256i; 8]) -> [__m256i; 8] {
        let [r0, r1, r2, r3, r4, r5, r6, r7] = m;
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
            _mm256_permute2x128_si256::<0x20>(u0, u4),
            _mm256_permute2x128_si256::<0x20>(u1, u5),
            _mm256_permute2x128_si256::<0x20>(u2, u6),
            _mm256_permute2x128_si256::<0x20>(u3, u7),
            _mm256_permute2x128_si256::<0x31>(u0, u4),
            _mm256_permute2x128_si256::<0x31>(u1, u5),
            _mm256_permute2x128_si256::<0x31>(u2, u6),
            _mm256_permute2x128_si256::<0x31>(u3, u7),
        ]
    }

    /// libjpeg's range limit as arithmetic on every lane (see `Limits`).
    #[inline]
    #[target_feature(enable = "avx2")]
    fn limit(x: Y, l: Limits) -> __m256i {
        let (k, mask, two_n) = (_mm256_set1_epi32(l.k), _mm256_set1_epi32(l.mask), _mm256_set1_epi32(l.two_n));
        let w = _mm256_sub_epi32(_mm256_and_si256(_mm256_add_epi32(v(x), k), mask), two_n);
        _mm256_min_epi32(_mm256_max_epi32(w, _mm256_setzero_si256()), _mm256_set1_epi32(l.max))
    }

    /// `Kernels::idct` with AVX2: dequantisation and `idct::idct_small` with no zero shortcuts
    /// (they are exact rewrites). Caller checks `out.len() >= 7 * stride + 8`.
    #[target_feature(enable = "avx2")]
    #[allow(clippy::too_many_arguments)]
    pub(super) fn idct<T: Sample>(blk: &[i32; 64], q: &[i32; 64], pass1: u32, max: i32, range: &[u16], out: &mut [T], stride: usize) {
        let rows = dequant_rows(blk, q);
        if any_over(&rows, SMALL_MAX) {
            let deq: [i32; 64] = core::array::from_fn(|i| blk[i] * q[i]);
            return crate::idct::idct_ref(&deq, pass1, range, out, stride);
        }
        let ws = idct_1d(rows.map(|r| y(r))).map(|r| descale(r, CONST_BITS - pass1));
        let cols = idct_1d(transpose(ws.map(|r| v(r))).map(|c| y(c))).map(|c| descale(c, CONST_BITS + pass1 + 3));
        let l = Limits::new(max);
        let rows = transpose(cols.map(|c| limit(c, l)));
        // Rows of `out` one stride apart. One check up front, with a bound on `stride` so that
        // nothing below can overflow; LLVM then drops the per-row checks. The caller has
        // checked the length already, and no plane is 2^28 samples wide.
        assert!(stride <= 1 << 28 && out.len() >= 7 * stride + 8);
        for r in (0..8).step_by(2) {
            // Values are in 0..=max (<= 4095), so the unsigned saturating packs are exact.
            // p = row r then row r + 1, as 16-bit values.
            let p = _mm256_permute4x64_epi64::<0b11_01_10_00>(_mm256_packus_epi32(rows[r], rows[r + 1]));
            let (lo, hi) = (_mm256_castsi256_si128(p), _mm256_extracti128_si256::<1>(p));
            let (a, b) = if T::BYTES == 1 {
                let b = _mm_packus_epi16(lo, hi);
                ([_mm_cvtsi128_si64(b) as u64, 0], [_mm_extract_epi64::<1>(b) as u64, 0])
            } else {
                let w = |x: __m128i| [_mm_cvtsi128_si64(x) as u64, _mm_extract_epi64::<1>(x) as u64];
                (w(lo), w(hi))
            };
            T::put_words(&mut out[r * stride..r * stride + 8], &a);
            T::put_words(&mut out[(r + 1) * stride..(r + 1) * stride + 8], &b);
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
        let rows = dequant_rows(blk, q);
        if any_over(&rows, REDUCED_MAX) {
            let deq: [i32; 64] = core::array::from_fn(|i| blk[i] * q[i]);
            return crate::idct::idct_reduced(size, &deq, pass1, range, out, stride);
        }
        let rows = rows.map(|r| y(r));
        if size == 2 {
            let ws = idct2_1d(rows).map(|r| descale(r, CONST_BITS - pass1 + 2).0.map(i64::from));
            return crate::idct::idct2_rows(&ws, pass1, range, out, stride);
        }
        let ws = idct4_1d(rows).map(|r| descale(r, CONST_BITS - pass1 + 1));
        let z = Y([0; 8]);
        let cols = transpose([ws[0], ws[1], ws[2], ws[3], z, z, z, z].map(|r| v(r))).map(|c| y(c));
        let l = Limits::new(max);
        // o[c] lane r is output row r, column c.
        let o = idct4_1d(cols).map(|c| y(limit(descale(c, CONST_BITS + pass1 + 4), l)).0);
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

    /// The 16 bytes of `v` written to `dst` (exactly 16 bytes) as two 64-bit lanes.
    #[inline(always)]
    fn store_bytes(dst: &mut [u8], v: v128) {
        dst[..8].copy_from_slice(&u64x2_extract_lane::<0>(v).to_le_bytes());
        dst[8..16].copy_from_slice(&u64x2_extract_lane::<1>(v).to_le_bytes());
    }

    /// Store 8 u16 lanes (values that fit T) as 8 samples.
    #[inline(always)]
    fn store8<T: Sample>(dst: &mut [T], p: v128) {
        T::put(&mut dst[..8], p, p);
    }

    /// 16 samples as two u16x8.
    #[inline(always)]
    fn load16<T: Sample>(s: &[T]) -> (v128, v128) {
        (T::get8(&s[..8]), T::get8(&s[8..16]))
    }

    /// 8 samples as one u16x8.
    #[inline(always)]
    fn load8<T: Sample>(s: &[T]) -> v128 {
        T::get8(s)
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
            // Values are at most 4095 (12-bit) or 255 (8-bit, so the unsigned narrow is exact).
            T::put(dst, a, b);
            i += 8;
        }
        i
    }

    /// `dct::ycc_px` on 8 pixels (u16x8 inputs, chroma not yet centred), each channel clamped
    /// to 0..=255 by the saturating narrows (values stay far inside i16 before that).
    #[inline(always)]
    fn ycc8(y: v128, cb: v128, cr: v128) -> [v128; 3] {
        use crate::dct::{FIX_0_34414, FIX_0_71414, FIX_1_40200, FIX_1_77200};
        // `dct::ycc_px` regrouped for 16-bit lanes and `i32x4.dot_i16x8_s`. Each term
        // (k·x + 2^15) >> 16 has k split as j·2^16 + k' with |k'| < 2^15, so the term is
        // j·x + ((k'·x + 2^15) >> 16) exactly, and k'·x + 2^15 is one dot product of the pairs
        // (x, 2)·(k', 2^14) (the G term, with two chroma products, is two). Every sum lies far
        // inside i16 before the saturating narrow to u8, which is the 0..=255 clamp.
        const KR: i32 = FIX_1_40200 - (1 << 16); // 26345
        const KB: i32 = FIX_1_77200 - (2 << 16); // -14942
        const KG_CR: i32 = (1 << 15) - FIX_0_71414; // -14034, with −2^15·cr in the second pair
        let pair = |a: i32, b: i32| i32x4_splat((a as u16 as u32 | (b as u16 as u32) << 16) as i32);
        let c128 = i16x8_splat(128);
        let (cb, cr) = (i16x8_sub(cb, c128), i16x8_sub(cr, c128));
        let two = i16x8_splat(2);
        let zip = |a: v128, b: v128| (i16x8_shuffle::<0, 8, 1, 9, 2, 10, 3, 11>(a, b), i16x8_shuffle::<4, 12, 5, 13, 6, 14, 7, 15>(a, b));
        let (cr2, cb2, cbcr) = (zip(cr, two), zip(cb, two), zip(cb, cr));
        let term = |p: (v128, v128), k: v128| {
            i16x8_narrow_i32x4(i32x4_shr(i32x4_dot_i16x8(p.0, k), 16), i32x4_shr(i32x4_dot_i16x8(p.1, k), 16))
        };
        let term2 = |p: (v128, v128), k: v128, q: (v128, v128), l: v128| {
            let lo = i32x4_add(i32x4_dot_i16x8(p.0, k), i32x4_dot_i16x8(q.0, l));
            let hi = i32x4_add(i32x4_dot_i16x8(p.1, k), i32x4_dot_i16x8(q.1, l));
            i16x8_narrow_i32x4(i32x4_shr(lo, 16), i32x4_shr(hi, 16))
        };
        let r = i16x8_add(i16x8_add(y, cr), term(cr2, pair(KR, 1 << 14)));
        let g = i16x8_add(y, term2(cbcr, pair(-FIX_0_34414, KG_CR), cr2, pair(-(1 << 15), 1 << 14)));
        let b = i16x8_add(i16x8_add(y, i16x8_add(cb, cb)), term(cb2, pair(KB, 1 << 14)));
        [r, g, b]
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
        store_bytes(&mut dst[..16], o0);
        store_bytes(&mut dst[16..32], o1);
        store_bytes(&mut dst[32..48], o2);
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
            store8(&mut out[r * stride..r * stride + 8], p);
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
        let cols = transpose([ws[0], ws[1], ws[2], ws[3], z, z, z, z].map(|r| v(r))).map(|c| y(c));
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
