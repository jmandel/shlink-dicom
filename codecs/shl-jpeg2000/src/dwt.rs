//! Inverse discrete wavelet transform (T.800 Annex F): 2D_SR one level at a time, with the
//! reversible 5/3 filter on integers and the irreversible 9/7 filter in f32.

use crate::geometry::Rect;

/// The 9/7 lifting constants (Table F.4), as the decoder this replaces uses them.
const NEG_ALPHA: f32 = 1.586_134_3;
const NEG_BETA: f32 = 0.052_980_117;
const NEG_GAMMA: f32 = -0.882_911_1;
const NEG_DELTA: f32 = -0.443_506_87;
const KAPPA: f32 = 1.230_174_1;
const INV_KAPPA: f32 = 1.0 / KAPPA;

/// A wavelet filter on samples of type `T`.
pub(crate) trait Filter<T: Copy + Default> {
    /// 1D lifting of one row or column held as its low-pass (`low`) and high-pass (`high`)
    /// samples; `odd`: the signal starts at an odd coordinate (with a high-pass sample).
    fn lift(low: &mut [T], high: &mut [T], odd: bool);
    /// The single-sample case at an odd coordinate (F.3.7).
    fn halve(v: T) -> T;
    /// Vertical lifting over whole rows of `buf` (`w` wide, `h` ≥ 2 high), the first row at
    /// an odd coordinate if `odd`.
    fn lift_columns(buf: &mut [T], w: usize, h: usize, odd: bool);
}

/// Reversible 5/3 on integers.
pub(crate) struct Rev53;
/// Reversible 5/3 in f32 (quantised reversible components), with floor as in (F-5), (F-6).
pub(crate) struct Rev53F;
/// Irreversible 9/7 in f32.
pub(crate) struct Irr97;

/// Neighbour index for low[k] in high (−1 or 0 offset by parity), clamped (symmetric
/// extension by one sample mirrors onto the nearest sample of the other parity).
#[inline(always)]
fn clamp(i: isize, n: usize) -> usize {
    i.clamp(0, n as isize - 1) as usize
}

/// One lifting step: `dst[k] = f(dst[k], src[k + a], src[k + a + 1])`, out-of-range
/// neighbours clamped.
#[inline(always)]
fn step<T: Copy>(dst: &mut [T], src: &[T], a: isize, f: impl Fn(T, T, T) -> T) {
    let n = src.len();
    let m = dst.len();
    if n == 0 {
        return;
    }
    // Interior: both neighbours in range when 0 <= k + a and k + a + 1 < n.
    let lo = (-a).max(0) as usize;
    let hi = ((n as isize - 1 - a).max(0) as usize).min(m);
    for k in 0..lo.min(m) {
        let k = k as isize;
        dst[k as usize] = f(dst[k as usize], src[clamp(k + a, n)], src[clamp(k + a + 1, n)]);
    }
    if lo < hi {
        let off = (lo as isize + a) as usize;
        let s = &src[off..off + (hi - lo) + 1];
        for (j, d) in dst[lo..hi].iter_mut().enumerate() {
            *d = f(*d, s[j], s[j + 1]);
        }
    }
    for k in hi.max(lo)..m {
        let k = k as isize;
        dst[k as usize] = f(dst[k as usize], src[clamp(k + a, n)], src[clamp(k + a + 1, n)]);
    }
}

/// Row `r` of `buf` and its neighbours `a`, `b` (≠ r).
#[inline(always)]
fn rows3<T>(buf: &mut [T], w: usize, r: usize, a: usize, b: usize) -> (&mut [T], &[T], &[T]) {
    if a == b {
        let [t, n] = buf.get_disjoint_mut([r * w..r * w + w, a * w..a * w + w]).expect("distinct rows");
        let n: &[T] = n;
        (t, n, n)
    } else {
        let [t, n1, n2] = buf.get_disjoint_mut([r * w..r * w + w, a * w..a * w + w, b * w..b * w + w]).expect("distinct rows");
        (t, n1, n2)
    }
}

/// Apply `f(row, above, below)` to every row of parity `parity` (0 even) in `buf`, mirrored at
/// the edges.
#[inline(always)]
fn vstep<T: Copy>(buf: &mut [T], w: usize, h: usize, parity: usize, f: impl Fn(T, T, T) -> T) {
    let mut r = parity;
    while r < h {
        let a = if r == 0 { 1 } else { r - 1 };
        let b = if r + 1 >= h { r - 1 } else { r + 1 };
        let (t, n1, n2) = rows3(buf, w, r, a, b);
        for ((x, &p), &q) in t.iter_mut().zip(n1).zip(n2) {
            *x = f(*x, p, q);
        }
        r += 2;
    }
}

impl Filter<i32> for Rev53 {
    #[inline(always)]
    fn lift(low: &mut [i32], high: &mut [i32], odd: bool) {
        let (a, b) = if odd { (0, -1) } else { (-1, 0) };
        // F-5 then F-6.
        step(low, high, a, |s, l, r| s - ((l + r + 2) >> 2));
        step(high, low, b, |s, l, r| s + ((l + r) >> 1));
    }
    fn halve(v: i32) -> i32 {
        v >> 1
    }
    fn lift_columns(buf: &mut [i32], w: usize, h: usize, odd: bool) {
        // Low-pass rows are those at even coordinates.
        let low = usize::from(odd);
        vstep(buf, w, h, low, |s, l, r| s - ((l + r + 2) >> 2));
        vstep(buf, w, h, 1 - low, |s, l, r| s + ((l + r) >> 1));
    }
}

impl Filter<f32> for Rev53F {
    #[inline(always)]
    fn lift(low: &mut [f32], high: &mut [f32], odd: bool) {
        let (a, b) = if odd { (0, -1) } else { (-1, 0) };
        step(low, high, a, |s, l, r| s - ((l + r) * 0.25 + 0.5).floor());
        step(high, low, b, |s, l, r| s + ((l + r) * 0.5).floor());
    }
    fn halve(v: f32) -> f32 {
        v * 0.5
    }
    fn lift_columns(buf: &mut [f32], w: usize, h: usize, odd: bool) {
        let low = usize::from(odd);
        vstep(buf, w, h, low, |s, l, r| s - ((l + r) * 0.25 + 0.5).floor());
        vstep(buf, w, h, 1 - low, |s, l, r| s + ((l + r) * 0.5).floor());
    }
}

impl Filter<f32> for Irr97 {
    #[inline(always)]
    fn lift(low: &mut [f32], high: &mut [f32], odd: bool) {
        let (a, b) = if odd { (0, -1) } else { (-1, 0) };
        for v in low.iter_mut() {
            *v *= KAPPA;
        }
        for v in high.iter_mut() {
            *v *= INV_KAPPA;
        }
        step(low, high, a, |s, l, r| (l + r) * NEG_DELTA + s);
        step(high, low, b, |s, l, r| (l + r) * NEG_GAMMA + s);
        step(low, high, a, |s, l, r| (l + r) * NEG_BETA + s);
        step(high, low, b, |s, l, r| (l + r) * NEG_ALPHA + s);
    }
    fn halve(v: f32) -> f32 {
        v * 0.5
    }
    fn lift_columns(buf: &mut [f32], w: usize, h: usize, odd: bool) {
        let low = usize::from(odd);
        for (r, row) in buf.chunks_exact_mut(w).take(h).enumerate() {
            let k = if r % 2 == low { KAPPA } else { INV_KAPPA };
            for v in row {
                *v *= k;
            }
        }
        vstep(buf, w, h, low, |s, l, r| (l + r) * NEG_DELTA + s);
        vstep(buf, w, h, 1 - low, |s, l, r| (l + r) * NEG_GAMMA + s);
        vstep(buf, w, h, low, |s, l, r| (l + r) * NEG_BETA + s);
        vstep(buf, w, h, 1 - low, |s, l, r| (l + r) * NEG_ALPHA + s);
    }
}

/// One level of 2D_SR (F.3.2): `ll` (the previous resolution, `ll_rect`), `hl`, `lh`, `hh`
/// into `out` over `rect` (the next resolution's rectangle).
#[allow(clippy::too_many_arguments)]
pub(crate) fn level<T: Copy + Default, F: Filter<T>>(rect: Rect, ll: &[T], hl: &[T], lh: &[T], hh: &[T], out: &mut Vec<T>, low: &mut Vec<T>, high: &mut Vec<T>) {
    let (w, h) = (rect.w() as usize, rect.h() as usize);
    out.clear();
    out.resize(w * h, T::default());
    if w == 0 || h == 0 {
        return;
    }
    let (u0, u1, v0) = (rect.x0, rect.x1, rect.y0);
    let nul = (u1.div_ceil(2) - u0.div_ceil(2)) as usize;
    let nuh = (u1 / 2 - u0 / 2) as usize;
    let odd_x = u0 % 2 == 1;
    let odd_y = v0 % 2 == 1;
    low.clear();
    low.resize(nul, T::default());
    high.clear();
    high.resize(nuh, T::default());
    for y in 0..h {
        let v = v0 as usize + y;
        let (lb, hb, row) = if v.is_multiple_of(2) {
            (ll, hl, v / 2 - (v0 as usize).div_ceil(2))
        } else {
            (lh, hh, (v - 1) / 2 - v0 as usize / 2)
        };
        let o = &mut out[y * w..(y + 1) * w];
        if w == 1 {
            o[0] = if odd_x { F::halve(hb[row]) } else { lb[row] };
            continue;
        }
        low.copy_from_slice(&lb[row * nul..row * nul + nul]);
        high.copy_from_slice(&hb[row * nuh..row * nuh + nuh]);
        F::lift(low, high, odd_x);
        let (first, second) = if odd_x { (&high[..], &low[..]) } else { (&low[..], &high[..]) };
        for (i, d) in o.iter_mut().enumerate() {
            *d = if i % 2 == 0 { first[i / 2] } else { second[i / 2] };
        }
    }
    if h == 1 {
        if odd_y {
            for v in out.iter_mut() {
                *v = F::halve(*v);
            }
        }
        return;
    }
    F::lift_columns(out, w, h, odd_y);
}
