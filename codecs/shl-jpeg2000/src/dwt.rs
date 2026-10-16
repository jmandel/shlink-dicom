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

/// `dst[i] = f(dst[i], a[i], b[i])` over a row.
#[inline(always)]
fn lift_row<T: Copy>(dst: &mut [T], a: &[T], b: &[T], f: impl Fn(T, T, T) -> T) {
    for ((x, &p), &q) in dst.iter_mut().zip(a).zip(b) {
        *x = f(*x, p, q);
    }
}

/// Vertical lifting in one pass down the rows: step k (of `N`) updates the rows of parity
/// `parity[k]` from their neighbours, through `step(k, row, above, below)`. Step k reaches
/// row r once its neighbours have had step k − 1 and before they have step k + 1 (row
/// t − k when the pass is at row t), so every sample sees what it would in separate passes,
/// while only a few rows are live in cache. `scale(row, r)`, if any, runs on each row before
/// any step reads it.
#[inline(always)]
fn vlift<T: Copy, const N: usize>(
    buf: &mut [T],
    w: usize,
    h: usize,
    parity: [usize; N],
    step: impl Fn(usize, &mut [T], &[T], &[T]),
    scale: Option<impl Fn(&mut [T], usize)>,
) {
    if let Some(sc) = &scale {
        sc(&mut buf[..w], 0);
    }
    for t in 0..h + N {
        if let Some(sc) = &scale {
            if t + 1 < h {
                sc(&mut buf[(t + 1) * w..(t + 2) * w], t + 1);
            }
        }
        for (k, &par) in parity.iter().enumerate() {
            let Some(r) = t.checked_sub(k) else { continue };
            if r >= h || r % 2 != par {
                continue;
            }
            let a = if r == 0 { 1 } else { r - 1 };
            let b = if r + 1 >= h { r - 1 } else { r + 1 };
            let (row, n1, n2) = rows3(buf, w, r, a, b);
            step(k, row, n1, n2);
        }
    }
}

impl Filter<i32> for Rev53 {
    #[inline(always)]
    fn lift(low: &mut [i32], high: &mut [i32], odd: bool) {
        let (a, b) = if odd { (0, -1) } else { (-1, 0) };
        // F-5 then F-6.
        step(low, high, a, |s, l, r| s.wrapping_sub(l.wrapping_add(r).wrapping_add(2) >> 2));
        step(high, low, b, |s, l, r| s.wrapping_add(l.wrapping_add(r) >> 1));
    }
    fn halve(v: i32) -> i32 {
        v >> 1
    }
    fn lift_columns(buf: &mut [i32], w: usize, h: usize, odd: bool) {
        // Low-pass rows are those at even coordinates.
        let low = usize::from(odd);
        let step = |k: usize, row: &mut [i32], a: &[i32], b: &[i32]| match k {
            0 => lift_row(row, a, b, |s, l, r| s.wrapping_sub(l.wrapping_add(r).wrapping_add(2) >> 2)),
            _ => lift_row(row, a, b, |s, l, r| s.wrapping_add(l.wrapping_add(r) >> 1)),
        };
        vlift(buf, w, h, [low, 1 - low], step, None::<fn(&mut [i32], usize)>);
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
        let step = |k: usize, row: &mut [f32], a: &[f32], b: &[f32]| match k {
            0 => lift_row(row, a, b, |s, l, r| s - ((l + r) * 0.25 + 0.5).floor()),
            _ => lift_row(row, a, b, |s, l, r| s + ((l + r) * 0.5).floor()),
        };
        vlift(buf, w, h, [low, 1 - low], step, None::<fn(&mut [f32], usize)>);
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
        let step = |k: usize, row: &mut [f32], a: &[f32], b: &[f32]| match k {
            0 => lift_row(row, a, b, |s, l, r| (l + r) * NEG_DELTA + s),
            1 => lift_row(row, a, b, |s, l, r| (l + r) * NEG_GAMMA + s),
            2 => lift_row(row, a, b, |s, l, r| (l + r) * NEG_BETA + s),
            _ => lift_row(row, a, b, |s, l, r| (l + r) * NEG_ALPHA + s),
        };
        let scale = |row: &mut [f32], r: usize| {
            let k = if r % 2 == low { KAPPA } else { INV_KAPPA };
            for v in row {
                *v *= k;
            }
        };
        vlift(buf, w, h, [low, 1 - low, low, 1 - low], step, Some(scale));
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
        for ((pair, &a), &b) in o.chunks_exact_mut(2).zip(first).zip(second) {
            pair[0] = a;
            pair[1] = b;
        }
        if w % 2 == 1 {
            o[w - 1] = first[w / 2];
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
