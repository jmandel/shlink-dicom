//! `jidctint.c` ("islow") inverse DCT, bit-identical to IJG libjpeg 6b.
//!
//! libjpeg computes in `INT32`, which is `long` (64-bit) on the platforms dcmtk and gdcm are
//! built for. Three paths here give the same results as that 64-bit arithmetic:
//!
//! - [`idct_ref`]: 64-bit throughout, used for blocks whose coefficients are too large for
//!   the 32-bit path (only corrupt or adversarial data).
//! - [`idct_small`]: 32-bit. Exact in the column pass because every intermediate of a block whose
//!   dequantised coefficients are within ±[`SMALL_MAX`] fits in an `i32` (proved by
//!   `tests::small_bound_holds`). The row pass may wrap, which is harmless: it is a chain of
//!   additions, multiplications and left shifts, so it is exact modulo 2^32, and the result is
//!   only used through `(x >> 16+PASS1_BITS) & mask`, which reads bits 17..31 at most.
//! - [`dc_only`]: a block whose AC coefficients are all zero is flat, and its value is computed
//!   with the same arithmetic the full transform would use.
//!
//! `idct_1d` is generic over a [`Lane`] so the SIMD module runs the very same sequence of
//! operations on vectors. The vector kernels also replace the range-limit table with
//! arithmetic: with n = max + 1, c = n / 2 and mask = 4n - 1, `range[v & mask]` equals
//! `clamp(((v + 2n + c) & mask) - 2n, 0, max)` (`tests::range_arithmetic_matches_table`).

use crate::out::Sample;
use core::num::Wrapping;
use core::ops::{Add, Sub};

pub(crate) const CONST_BITS: u32 = 13;
pub(crate) const FIX_0_298631336: i32 = 2446;
pub(crate) const FIX_0_390180644: i32 = 3196;
pub(crate) const FIX_0_541196100: i32 = 4433;
pub(crate) const FIX_0_765366865: i32 = 6270;
pub(crate) const FIX_0_899976223: i32 = 7373;
pub(crate) const FIX_1_175875602: i32 = 9633;
pub(crate) const FIX_1_501321110: i32 = 12299;
pub(crate) const FIX_1_847759065: i32 = 15137;
pub(crate) const FIX_1_961570560: i32 = 16069;
pub(crate) const FIX_2_053119869: i32 = 16819;
pub(crate) const FIX_2_562915447: i32 = 20995;
pub(crate) const FIX_3_072711026: i32 = 25172;

/// Largest |dequantised coefficient| for which [`idct_small`] is exact (see the module docs).
/// Valid 8-bit data stays below about 2^11 and valid 12-bit data below about 2^15.
pub(crate) const SMALL_MAX: u32 = 32767;

/// Arithmetic `idct_1d` needs: wrapping or exact integer lanes, scalar or vector.
pub(crate) trait Lane: Copy + Add<Output = Self> + Sub<Output = Self> {
    fn mulc(self, c: i32) -> Self;
    fn shl(self, n: u32) -> Self;
}

impl Lane for i64 {
    #[inline(always)]
    fn mulc(self, c: i32) -> Self {
        self * i64::from(c)
    }
    #[inline(always)]
    fn shl(self, n: u32) -> Self {
        self << n
    }
}

impl Lane for Wrapping<i32> {
    #[inline(always)]
    fn mulc(self, c: i32) -> Self {
        self * Wrapping(c)
    }
    #[inline(always)]
    fn shl(self, n: u32) -> Self {
        self << n as usize
    }
}

/// One 1-D pass of `jidctint.c`; returns the 8 outputs before descaling, as
/// (tmp10+tmp3, tmp11+tmp2, tmp12+tmp1, tmp13+tmp0, tmp13-tmp0, tmp12-tmp1, tmp11-tmp2, tmp10-tmp3).
#[inline(always)]
pub(crate) fn idct_1d<T: Lane>(i: [T; 8]) -> [T; 8] {
    // Even part.
    let (z2, z3) = (i[2], i[6]);
    let z1 = (z2 + z3).mulc(FIX_0_541196100);
    let tmp2 = z1 + z3.mulc(-FIX_1_847759065);
    let tmp3 = z1 + z2.mulc(FIX_0_765366865);
    let tmp0 = (i[0] + i[4]).shl(CONST_BITS);
    let tmp1 = (i[0] - i[4]).shl(CONST_BITS);
    let tmp10 = tmp0 + tmp3;
    let tmp13 = tmp0 - tmp3;
    let tmp11 = tmp1 + tmp2;
    let tmp12 = tmp1 - tmp2;
    // Odd part.
    let (t0, t1, t2, t3) = (i[7], i[5], i[3], i[1]);
    let z1 = t0 + t3;
    let z2 = t1 + t2;
    let z3 = t0 + t2;
    let z4 = t1 + t3;
    let z5 = (z3 + z4).mulc(FIX_1_175875602);
    let t0 = t0.mulc(FIX_0_298631336);
    let t1 = t1.mulc(FIX_2_053119869);
    let t2 = t2.mulc(FIX_3_072711026);
    let t3 = t3.mulc(FIX_1_501321110);
    let z1 = z1.mulc(-FIX_0_899976223);
    let z2 = z2.mulc(-FIX_2_562915447);
    let z3 = z3.mulc(-FIX_1_961570560) + z5;
    let z4 = z4.mulc(-FIX_0_390180644) + z5;
    let t0 = t0 + (z1 + z3);
    let t1 = t1 + (z2 + z4);
    let t2 = t2 + (z2 + z3);
    let t3 = t3 + (z1 + z4);
    [tmp10 + t3, tmp11 + t2, tmp12 + t1, tmp13 + t0, tmp13 - t0, tmp12 - t1, tmp11 - t2, tmp10 - t3]
}

#[inline(always)]
fn descale(x: i64, n: u32) -> i64 {
    (x + (1i64 << (n - 1))) >> n
}

/// `jpeg_idct_islow` in 64-bit arithmetic, as libjpeg computes it on LP64 platforms.
/// `blk` holds dequantised coefficients in natural order. Writes 8 rows of 8 at `out[r*stride..]`.
pub(crate) fn idct_ref<T: Sample>(blk: &[i32; 64], pass1: u32, range: &[u16], out: &mut [T], stride: usize) {
    let mut ws = [0i32; 64];
    for col in 0..8 {
        if (1..8).all(|r| blk[r * 8 + col] == 0) {
            let dc = (i64::from(blk[col]) << pass1) as i32;
            for r in 0..8 {
                ws[r * 8 + col] = dc;
            }
            continue;
        }
        let o = idct_1d(core::array::from_fn(|r| i64::from(blk[r * 8 + col])));
        for r in 0..8 {
            ws[r * 8 + col] = descale(o[r], CONST_BITS - pass1) as i32;
        }
    }
    let mask = range.len() - 1;
    for row in 0..8 {
        let o = idct_1d(core::array::from_fn(|c| i64::from(ws[row * 8 + c])));
        let Some(dst) = out.get_mut(row * stride..row * stride + 8) else { return };
        for c in 0..8 {
            let v = descale(o[c], CONST_BITS + pass1 + 3) as i32;
            dst[c] = T::from_u16(range[(v as usize) & mask]);
        }
    }
}

/// [`idct_ref`] for blocks whose coefficients are all within ±[`SMALL_MAX`], in 32-bit arithmetic.
pub(crate) fn idct_small<T: Sample>(blk: &[i32; 64], pass1: u32, range: &[u16], out: &mut [T], stride: usize) {
    let mut ws = [Wrapping(0i32); 64];
    let shift1 = CONST_BITS - pass1;
    let round1 = Wrapping(1i32 << (shift1 - 1));
    for col in 0..8 {
        if (1..8).all(|r| blk[r * 8 + col] == 0) {
            let dc = Wrapping(blk[col] << pass1);
            for r in 0..8 {
                ws[r * 8 + col] = dc;
            }
            continue;
        }
        let o = idct_1d(core::array::from_fn(|r| Wrapping(blk[r * 8 + col])));
        for r in 0..8 {
            ws[r * 8 + col] = (o[r] + round1) >> shift1 as usize;
        }
    }
    let mask = range.len() - 1;
    let shift2 = CONST_BITS + pass1 + 3;
    let round2 = Wrapping(1i32 << (shift2 - 1));
    for row in 0..8 {
        let Some(dst) = out.get_mut(row * stride..row * stride + 8) else { return };
        let w: &[Wrapping<i32>; 8] = ws[row * 8..row * 8 + 8].try_into().unwrap_or(&[Wrapping(0); 8]);
        let o = idct_1d(*w);
        for c in 0..8 {
            let v = ((o[c] + round2) >> shift2 as usize).0;
            dst[c] = T::from_u16(range[(v as usize) & mask]);
        }
    }
}

/// The flat value of a block whose AC coefficients are all zero: what [`idct_ref`] computes for it.
#[inline]
pub(crate) fn dc_only(dc: i32, pass1: u32, range: &[u16]) -> u16 {
    let ws = (i64::from(dc) << pass1) as i32;
    let v = descale(i64::from(ws) << CONST_BITS, CONST_BITS + pass1 + 3) as i32;
    range[(v as usize) & (range.len() - 1)]
}

// `jidctred.c` constants (FIX(x) with CONST_BITS = 13).
const FIX_0_211164243: i32 = 1730;
const FIX_0_509795579: i32 = 4176;
const FIX_0_601344887: i32 = 4926;
const FIX_0_720959822: i32 = 5906;
const FIX_0_850430095: i32 = 6967;
const FIX_1_061594337: i32 = 8697;
const FIX_1_272758580: i32 = 10426;
const FIX_1_451774981: i32 = 11893;
const FIX_2_172734803: i32 = 17799;
const FIX_3_624509785: i32 = 29692;

/// Largest |dequantised coefficient| for which the vector reduced IDCTs (32-bit lanes) are exact:
/// pass 1 then fits in i32 (`tests::reduced_bound_holds`), and pass 2 may wrap only above the
/// bits the range limit reads, as in [`idct_small`]. The 2×2 pass 2, which would read bit 32 for
/// 12-bit data, is done in 64 bits. Valid 8-bit and 12-bit data stay below about 2^14.
#[cfg_attr(not(any(target_arch = "x86_64", all(target_arch = "wasm32", target_feature = "simd128"))), allow(dead_code))]
pub(crate) const REDUCED_MAX: u32 = 25000;

/// Reduced-size inverse DCTs, as `jidctred.c` (IJG 6b, kept unchanged in libjpeg-turbo) computes
/// them: `size` 4 (`jpeg_idct_4x4`), 2 (`jpeg_idct_2x2`) or 1 (`jpeg_idct_1x1`) output samples
/// per side from one 8×8 block. `deq` holds dequantised coefficients in natural order.
///
/// Arithmetic follows libjpeg on LP64: `INT32` products and sums in 64 bits, the work array in
/// `int` (truncated to 32 bits), and the result truncated to `int` before the range-limit mask.
/// Valid data never comes near those limits; the truncations only fix what corrupt data gives.
/// libjpeg-turbo's SSE2 versions of the 4×4 and 2×2 transforms give the same results on valid
/// data (checked against `djpeg -scale` on the corpus).
pub(crate) fn idct_reduced<T: Sample>(size: usize, deq: &[i32; 64], pass1: u32, range: &[u16], out: &mut [T], stride: usize) {
    let mask = range.len() - 1;
    let limit = |v: i64| T::from_u16(range[(v as i32 as usize) & mask]);
    match size {
        1 => {
            if let Some(o) = out.first_mut() {
                *o = limit(descale(i64::from(deq[0]), 3));
            }
        }
        2 => {
            // Work array: rows 0 and 1 of columns 0..8 (2, 4 and 6 are never read).
            let mut ws = [[0i64; 8]; 2];
            for col in [0usize, 1, 3, 5, 7] {
                let c = |r: usize| i64::from(deq[r * 8 + col]);
                if deq[8 + col] | deq[24 + col] | deq[40 + col] | deq[56 + col] == 0 {
                    let dc = i64::from((c(0) << pass1) as i32);
                    ws[0][col] = dc;
                    ws[1][col] = dc;
                    continue;
                }
                let o = idct2_1d(core::array::from_fn(c));
                ws[0][col] = i64::from(descale(o[0], CONST_BITS - pass1 + 2) as i32);
                ws[1][col] = i64::from(descale(o[1], CONST_BITS - pass1 + 2) as i32);
            }
            idct2_rows(&ws, pass1, range, out, stride);
        }
        _ => {
            if out.len() < 3 * stride + 4 {
                return;
            }
            // Work array: rows 0..4 of columns 0..8 (column 4 is never read).
            let mut ws = [[0i64; 8]; 4];
            for col in [0usize, 1, 2, 3, 5, 6, 7] {
                let c = |r: usize| i64::from(deq[r * 8 + col]);
                if deq[8 + col] | deq[16 + col] | deq[24 + col] | deq[40 + col] | deq[48 + col] | deq[56 + col] == 0 {
                    let dc = i64::from((c(0) << pass1) as i32);
                    for w in ws.iter_mut() {
                        w[col] = dc;
                    }
                    continue;
                }
                let o = idct4_1d(core::array::from_fn(c));
                let sh = CONST_BITS - pass1 + 1;
                for (w, v) in ws.iter_mut().zip(o) {
                    w[col] = i64::from(descale(v, sh) as i32);
                }
            }
            for (r, w) in ws.iter().enumerate() {
                let dst = &mut out[r * stride..r * stride + 4];
                if w[1] | w[2] | w[3] | w[5] | w[6] | w[7] == 0 {
                    let v = limit(descale(w[0], pass1 + 3));
                    dst.fill(v);
                    continue;
                }
                let o = idct4_1d(*w);
                let sh = CONST_BITS + pass1 + 3 + 1;
                for (d, v) in dst.iter_mut().zip(o) {
                    *d = limit(descale(v, sh));
                }
            }
        }
    }
}

/// Pass 2 of `jpeg_idct_2x2`, in 64 bits: work array rows 0 and 1 to the 2×2 output.
pub(crate) fn idct2_rows<T: Sample>(ws: &[[i64; 8]; 2], pass1: u32, range: &[u16], out: &mut [T], stride: usize) {
    if out.len() < stride + 2 {
        return;
    }
    let mask = range.len() - 1;
    let limit = |v: i64| T::from_u16(range[(v as i32 as usize) & mask]);
    for (r, w) in ws.iter().enumerate() {
        let dst = &mut out[r * stride..r * stride + 2];
        if w[1] | w[3] | w[5] | w[7] == 0 {
            let v = limit(descale(w[0], pass1 + 3));
            dst[0] = v;
            dst[1] = v;
            continue;
        }
        let o = idct2_1d(*w);
        let sh = CONST_BITS + pass1 + 3 + 2;
        dst[0] = limit(descale(o[0], sh));
        dst[1] = limit(descale(o[1], sh));
    }
}

/// One 1-D pass of `jpeg_idct_4x4` over inputs 0..8 (4 unused); returns outputs 0..4 before
/// descaling. Generic over [`Lane`] so the vector kernels run the same operations.
#[inline(always)]
pub(crate) fn idct4_1d<L: Lane>(i: [L; 8]) -> [L; 4] {
    // Even part.
    let tmp0 = i[0].shl(CONST_BITS + 1);
    let tmp2 = i[2].mulc(FIX_1_847759065) + i[6].mulc(-FIX_0_765366865);
    let tmp10 = tmp0 + tmp2;
    let tmp12 = tmp0 - tmp2;
    // Odd part.
    let (z1, z2, z3, z4) = (i[7], i[5], i[3], i[1]);
    let tmp0 = z1.mulc(-FIX_0_211164243) + z2.mulc(FIX_1_451774981) + z3.mulc(-FIX_2_172734803) + z4.mulc(FIX_1_061594337);
    let tmp2 = z1.mulc(-FIX_0_509795579) + z2.mulc(-FIX_0_601344887) + z3.mulc(FIX_0_899976223) + z4.mulc(FIX_2_562915447);
    [tmp10 + tmp2, tmp12 + tmp0, tmp12 - tmp0, tmp10 - tmp2]
}

/// One 1-D pass of `jpeg_idct_2x2` over inputs 0..8 (2, 4 and 6 unused); returns outputs 0 and 1
/// before descaling.
#[inline(always)]
pub(crate) fn idct2_1d<L: Lane>(i: [L; 8]) -> [L; 2] {
    let tmp10 = i[0].shl(CONST_BITS + 2);
    let tmp0 = i[7].mulc(-FIX_0_720959822) + i[5].mulc(FIX_0_850430095) + i[3].mulc(-FIX_1_272758580) + i[1].mulc(FIX_3_624509785);
    [tmp10 + tmp0, tmp10 - tmp0]
}

/// The value of a block with no AC coefficients at reduced size `size` (what [`idct_reduced`]
/// computes for it, without the transform).
#[inline]
pub(crate) fn dc_only_reduced(size: usize, dc: i32, pass1: u32, range: &[u16]) -> u16 {
    if size == 1 {
        range[(descale(i64::from(dc), 3) as i32 as usize) & (range.len() - 1)]
    } else {
        dc_only(dc, pass1, range)
    }
}

/// libjpeg's post-IDCT range-limit table, indexed by `value & (len - 1)`.
pub(crate) fn range_table(max: i32) -> Vec<u16> {
    let n = max + 1;
    let c = n / 2;
    (0..4 * n)
        .map(|idx| {
            let s = if idx >= 2 * n - c { idx - 4 * n } else { idx };
            (s + c).clamp(0, max) as u16
        })
        .collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::cell::Cell;

    /// A linear form in the 8 inputs of `idct_1d`, recording the largest L1 norm (the largest
    /// value it can take when every input is within ±1) of any intermediate result.
    #[derive(Clone, Copy)]
    struct Form([i64; 8]);
    thread_local!(static MAX_L1: Cell<i64> = const { Cell::new(0) });
    fn note(f: Form) -> Form {
        let l1: i64 = f.0.iter().map(|c| c.abs()).sum();
        MAX_L1.with(|m| m.set(m.get().max(l1)));
        f
    }
    impl Add for Form {
        type Output = Form;
        fn add(self, o: Form) -> Form {
            note(Form(core::array::from_fn(|k| self.0[k] + o.0[k])))
        }
    }
    impl Sub for Form {
        type Output = Form;
        fn sub(self, o: Form) -> Form {
            note(Form(core::array::from_fn(|k| self.0[k] - o.0[k])))
        }
    }
    impl Lane for Form {
        fn mulc(self, c: i32) -> Form {
            note(Form(self.0.map(|x| x * i64::from(c))))
        }
        fn shl(self, n: u32) -> Form {
            note(Form(self.0.map(|x| x << n)))
        }
    }

    #[test]
    fn small_bound_holds() {
        let inputs: [Form; 8] = core::array::from_fn(|k| {
            let mut f = [0i64; 8];
            f[k] = 1;
            Form(f)
        });
        idct_1d(inputs);
        let l1 = MAX_L1.with(Cell::get);
        // Largest intermediate, plus the pass-1 rounding constant (at most 2^12), must fit in i32.
        let worst = l1 * i64::from(SMALL_MAX) + (1 << 12);
        assert!(worst <= i64::from(i32::MAX), "L1 {l1}: {worst} overflows");
        // The SMALL_MAX + 1 boundary makes the path's guard meaningful: dequantised values reach
        // i16 × u16, far above it.
        assert!(l1 * 65536 > i64::from(i32::MAX));
    }

    #[test]
    fn reduced_bound_holds() {
        let unit = |k: usize| {
            let mut f = [0i64; 8];
            f[k] = 1;
            Form(f)
        };
        for size in [4, 2] {
            MAX_L1.with(|m| m.set(0));
            let inputs: [Form; 8] = core::array::from_fn(unit);
            if size == 4 {
                idct4_1d(inputs);
            } else {
                idct2_1d(inputs);
            }
            let l1 = MAX_L1.with(Cell::get);
            // Pass 1 rounding constant is at most 2^13.
            let worst = l1 * i64::from(REDUCED_MAX) + (1 << 13);
            assert!(worst <= i64::from(i32::MAX), "size {size}: L1 {l1}: {worst} overflows");
        }
    }

    /// Deterministic xorshift for test vectors.
    pub(crate) struct Rng(pub(crate) u64);
    impl Rng {
        pub(crate) fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
    }

    /// A random block of dequantised coefficients within ±`lim`, with `nz` nonzero entries.
    pub(crate) fn random_block(rng: &mut Rng, lim: i64, nz: usize) -> [i32; 64] {
        let mut b = [0i32; 64];
        for _ in 0..nz {
            let k = (rng.next() % 64) as usize;
            let v = (rng.next() % (2 * lim as u64 + 1)) as i64 - lim;
            b[k] = v as i32;
        }
        if rng.next().is_multiple_of(4) {
            // Extremes, which are where overflow would show.
            for v in b.iter_mut().filter(|v| **v != 0) {
                *v = if *v > 0 { lim as i32 } else { -lim as i32 };
            }
        }
        b
    }

    #[test]
    fn small_matches_ref_on_random_blocks() {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        for (max, pass1) in [(255, 2u32), (4095, 1)] {
            let range = range_table(max);
            for i in 0..200_000 {
                let nz = [1, 2, 6, 20, 64][i % 5];
                let b = random_block(&mut rng, i64::from(SMALL_MAX), nz);
                let (mut a, mut c) = ([0u16; 64], [0u16; 64]);
                idct_ref(&b, pass1, &range, &mut a, 8);
                idct_small(&b, pass1, &range, &mut c, 8);
                assert_eq!(a, c, "block {b:?}");
            }
        }
    }

    #[test]
    fn dc_only_matches_ref() {
        for (max, pass1) in [(255, 2u32), (4095, 1)] {
            let range = range_table(max);
            for dc in (-70_000..70_000).step_by(7).chain([i32::MIN, i32::MAX, -2_147_450_880]) {
                let mut b = [0i32; 64];
                b[0] = dc;
                let mut a = [0u16; 64];
                idct_ref(&b, pass1, &range, &mut a, 8);
                assert!(a.iter().all(|&v| v == dc_only(dc, pass1, &range)), "dc {dc}");
            }
        }
    }

    #[test]
    fn range_arithmetic_matches_table() {
        for max in [255, 4095] {
            let t = range_table(max);
            let n = max + 1;
            let (k, mask) = (2 * n + n / 2, 4 * n - 1);
            for v in (-70_000..70_000).chain([i32::MIN, i32::MIN + 1, i32::MAX - 1, i32::MAX]) {
                let a = ((v.wrapping_add(k) & mask) - 2 * n).clamp(0, max);
                assert_eq!(a as u16, t[(v as usize) & (t.len() - 1)], "v {v} max {max}");
            }
        }
    }

    /// Floating-point reference: the 8×8 IDCT averaged over each `n`×`n` group of samples
    /// (n = 8 / size), before range limiting. `jidctred.c`'s constants are exactly these averages
    /// (for example `FIX_3_624509785` = √2·(c1+c3+c5+c7) for 2×2), so frequencies the reduced
    /// output cannot show average out rather than alias.
    fn reduced_float(size: usize, deq: &[i32; 64], max: i32) -> Vec<f64> {
        let n = 8 / size;
        let pi = std::f64::consts::PI;
        let cu = |u: usize| if u == 0 { 1.0 / 2f64.sqrt() } else { 1.0 };
        let mut full = [0f64; 64];
        for y in 0..8 {
            for x in 0..8 {
                let mut s = 0.0;
                for v in 0..8 {
                    for u in 0..8 {
                        s += cu(u) * cu(v) * f64::from(deq[v * 8 + u])
                            * ((2 * x + 1) as f64 * u as f64 * pi / 16.0).cos()
                            * ((2 * y + 1) as f64 * v as f64 * pi / 16.0).cos();
                    }
                }
                full[y * 8 + x] = s / 4.0;
            }
        }
        let mut out = vec![0.0; size * size];
        for oy in 0..size {
            for ox in 0..size {
                let mut s = 0.0;
                for y in 0..n {
                    for x in 0..n {
                        s += full[(oy * n + y) * 8 + ox * n + x];
                    }
                }
                out[oy * size + ox] = (s / (n * n) as f64 + f64::from((max + 1) / 2)).clamp(0.0, f64::from(max));
            }
        }
        out
    }

    /// The reduced IDCTs equal the block average of the exact transform to within rounding, and a
    /// DC-only block gives the same flat value through the transform and the shortcut.
    #[test]
    fn reduced_idct_is_block_average() {
        let mut rng = Rng(0x1234_5678_9ABC_DEF1);
        for (max, pass1) in [(255, 2u32), (4095, 1)] {
            let range = range_table(max);
            for size in [1usize, 2, 4] {
                let mut worst = 0f64;
                for i in 0..4_000 {
                    // Outputs stay inside the range limit's non-wrapping window (libjpeg wraps
                    // outside it by design): |sample - centre| <= Σ|coef| / 4 <= (max + 1) / 2.
                    let nz = [1, 3, 8, 64][i % 4];
                    let lim = i64::from(max + 1) * 2 / nz as i64;
                    let b = random_block(&mut rng, lim, nz);
                    let mut got = [0u16; 16];
                    idct_reduced(size, &b, pass1, &range, &mut got, 4);
                    let want = reduced_float(size, &b, max);
                    for oy in 0..size {
                        for ox in 0..size {
                            worst = worst.max((f64::from(got[oy * 4 + ox]) - want[oy * size + ox]).abs());
                        }
                    }
                    let mut flat = [0i32; 64];
                    flat[0] = b[0];
                    let mut f = [0u16; 16];
                    idct_reduced(size, &flat, pass1, &range, &mut f, 4);
                    assert_eq!(f[0], dc_only_reduced(size, b[0], pass1, &range), "size {size} dc {}", b[0]);
                }
                eprintln!("size {size} max {max}: worst {worst:.3}");
                assert!(worst <= 1.0, "size {size} max {max}: worst {worst}");
            }
        }
    }

    /// Hand-checked: DC 80 (8-bit) is +10 at full size, so 138 at every reduced size.
    #[test]
    fn reduced_idct_dc_vectors() {
        let range = range_table(255);
        let mut b = [0i32; 64];
        b[0] = 80;
        for size in [1, 2, 4] {
            let mut o = [0u8; 16];
            idct_reduced(size, &b, 2, &range, &mut o, 4);
            assert_eq!(o[0], 138);
            assert_eq!(o[(size - 1) * 4 + size - 1], 138);
        }
        // DESCALE(-4, 3) = (-4 + 4) >> 3 = 0 for 1×1; the same value via the 2-pass shortcut.
        assert_eq!(dc_only_reduced(1, -4, 2, &range), 128);
        assert_eq!(dc_only_reduced(2, -4, 2, &range), 128);
    }

    #[test]
    fn dc_only_block_is_flat() {
        let range = range_table(255);
        // DC 20 -> 20/8 = 2.5 -> rounds to 3 (libjpeg descale rounds half up), +128.
        assert_eq!(dc_only(20, 2, &range), 131);
    }

    #[test]
    fn range_table_wraps_like_libjpeg() {
        let t = range_table(255);
        assert_eq!(t.len(), 1024);
        assert_eq!(t[0], 128);
        assert_eq!(t[127], 255);
        assert_eq!(t[128], 255);
        assert_eq!(t[1023], 127); // -1
        assert_eq!(t[1024 - 128], 0); // -128
        assert_eq!(t[700], 0);
    }
}
