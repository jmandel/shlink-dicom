//! Rendering stages applied to whole frames (libjxl's render pipeline, run stage by stage as
//! its simple pipeline does: each stage sees its input mirrored at the channel's edges).

use crate::error::Result;
use crate::frame_header::LoopFilter;
use crate::simd::F4;
use crate::render::Plane;

#[inline(always)]
pub fn mirror(mut x: i64, size: i64) -> usize {
    while x < 0 || x >= size {
        if x < 0 {
            x = -x - 1;
        } else {
            x = 2 * size - 1 - x;
        }
    }
    x as usize
}

/// A copy of `p` with a mirrored border of `b` samples on every side.
fn padded(p: &Plane, b: usize) -> (Vec<f32>, usize) {
    let pw = p.w + 2 * b;
    let ph = p.h + 2 * b;
    let mut out = vec![0f32; pw * ph];
    for y in 0..ph {
        let sy = mirror(y as i64 - b as i64, p.h as i64);
        let src = p.row(sy);
        let dst = &mut out[y * pw..(y + 1) * pw];
        for x in 0..b {
            dst[x] = src[mirror(x as i64 - b as i64, p.w as i64)];
            dst[b + p.w + x] = src[mirror((p.w + x) as i64, p.w as i64)];
        }
        dst[b..b + p.w].copy_from_slice(src);
    }
    (out, pw)
}

/// Mirrored, column-padded copies of the rows around the one being filtered: the window
/// `y - b ..= y + b` of `src`, each row `w + 2b` long (index x + b is column x).
struct RowRing {
    b: usize,
    rows: Vec<Vec<f32>>,
    tags: Vec<i64>,
}

impl RowRing {
    fn new(w: usize, b: usize) -> Self {
        Self::with_slack(w, b, 0)
    }

    /// Rows `slack` values longer than needed (left zero), so 4-lane loops can run past the
    /// last column.
    fn with_slack(w: usize, b: usize, slack: usize) -> Self {
        RowRing { b, rows: vec![vec![0f32; w + 2 * b + slack]; 2 * b + 1], tags: vec![i64::MIN; 2 * b + 1] }
    }

    /// Makes the window for output row `y` available.
    fn load(&mut self, src: &Plane, y: usize) {
        let n = 2 * self.b + 1;
        for dy in 0..n {
            let r = y as i64 + dy as i64 - self.b as i64;
            let slot = r.rem_euclid(n as i64) as usize;
            if self.tags[slot] == r {
                continue;
            }
            let sy = mirror(r, src.h as i64);
            let s = src.row(sy);
            let dst = &mut self.rows[slot];
            let b = self.b;
            dst[b..b + src.w].copy_from_slice(s);
            for x in 0..b {
                dst[x] = s[mirror(x as i64 - b as i64, src.w as i64)];
                dst[b + src.w + x] = s[mirror((src.w + x) as i64, src.w as i64)];
            }
            self.tags[slot] = r;
        }
    }

    /// Row `y + dy` (|dy| ≤ b) of the window loaded for `y`.
    #[inline(always)]
    fn get(&self, y: usize, dy: isize) -> &[f32] {
        let n = (2 * self.b + 1) as i64;
        let slot = (y as i64 + dy as i64).rem_euclid(n) as usize;
        &self.rows[slot]
    }
}

/// Horizontal 2× chroma upsampling to width `w` (0.75 / 0.25 weights).
pub fn chroma_upsample_h(p: &Plane, w: usize) -> Result<Plane> {
    let (src, pw) = padded(p, 1);
    let mut out = Plane::new(w, p.h)?;
    for y in 0..p.h {
        let r = &src[(y + 1) * pw..(y + 2) * pw];
        let o = out.row_mut(y);
        for x in 0..p.w {
            let cur = r[x + 1] * 0.75;
            let left = 0.25 * r[x] + cur;
            let right = 0.25 * r[x + 2] + cur;
            if 2 * x < w {
                o[2 * x] = left;
            }
            if 2 * x + 1 < w {
                o[2 * x + 1] = right;
            }
        }
    }
    Ok(out)
}

/// Vertical 2× chroma upsampling to height `h`.
pub fn chroma_upsample_v(p: &Plane, h: usize) -> Result<Plane> {
    let (src, pw) = padded(p, 1);
    let mut out = Plane::new(p.w, h)?;
    for y in 0..p.h {
        let t = &src[y * pw + 1..y * pw + 1 + p.w];
        let m = &src[(y + 1) * pw + 1..(y + 1) * pw + 1 + p.w];
        let b = &src[(y + 2) * pw + 1..(y + 2) * pw + 1 + p.w];
        for x in 0..p.w {
            let ms = m[x] * 0.75;
            if 2 * y < h {
                out.data[2 * y * p.w + x] = t[x] * 0.25 + ms;
            }
            if 2 * y + 1 < h {
                out.data[(2 * y + 1) * p.w + x] = b[x] * 0.25 + ms;
            }
        }
    }
    Ok(out)
}

pub fn gaborish(planes: &mut [Plane], lf: &LoopFilter) {
    for (c, p) in planes.iter_mut().take(3).enumerate() {
        let mut w0 = 1.0f32;
        let mut w1 = lf.gab_weights[2 * c];
        let mut w2 = lf.gab_weights[2 * c + 1];
        let div = w0 + 4.0 * (w1 + w2);
        let mul = 1.0 / div;
        w0 *= mul;
        w1 *= mul;
        w2 *= mul;
        let mut ring = RowRing::new(p.w, 1);
        let mut tail = TailRows::default();
        let w = p.w;
        let mut o = vec![0f32; w];
        for y in 0..p.h {
            ring.load(p, y);
            let t = &ring.get(y, -1)[..w + 2];
            let m = &ring.get(y, 0)[..w + 2];
            let b = &ring.get(y, 1)[..w + 2];
            for x in 0..w {
                let sum0 = m[x + 1];
                let sum1 = (m[x] + m[x + 2]) + (t[x + 1] + b[x + 1]);
                let sum2 = (t[x] + t[x + 2]) + (b[x] + b[x + 2]);
                o[x] = sum2 * w2 + (sum1 * w1 + sum0 * w0);
            }
            tail.put(p, 0, y, 1, &o);
        }
        tail.flush(std::slice::from_mut(p));
    }
}

#[allow(clippy::excessive_precision)]
const MIN_SIGMA: f32 = -3.90524291751269967465540850526868;

/// One edge-preserving filter step (0, 1 or 2); `inv_sigma` per 8×8 block (`bw` wide).
///
/// Steps 0 and 1 compare plus-shaped neighbourhoods. The sum of absolute differences between
/// the neighbourhoods of p and p + d is a plus-shaped sum of E_d(r) = Σ_c scale_c·|P_c(r) −
/// P_c(r + d)|, and the one for p − d is the same sum shifted by −d, so each direction's E_d
/// is computed once per row and shared (libjxl sums per channel first; the rounding differs).
///
/// Every row loop runs four lanes at a time (`F4`) over the width rounded up to a multiple of
/// 4; the row buffers have that much slack, and the extra lanes are never stored.
pub fn epf(planes: &mut [Plane], lf: &LoopFilter, inv_sigma: &[f32], bw: usize, step: u32) {
    let (w, h) = (planes[0].w, planes[0].h);
    let w4 = w.div_ceil(4) * 4;
    let b = match step {
        0 => 3usize,
        1 => 2,
        _ => 1,
    };
    // P rows are padded by b + 2 columns so that E can be formed beyond the image edges.
    let pb = b + 2;
    let mut rings = [RowRing::with_slack(w, pb, 4), RowRing::with_slack(w, pb, 4), RowRing::with_slack(w, pb, 4)];
    let sm = match step {
        0 => (f64::from(lf.epf_pass0_sigma_scale) * 1.65) as f32,
        1 => 1.65f32,
        _ => (f64::from(lf.epf_pass2_sigma_scale) * 1.65) as f32,
    };
    let bsm = sm * lf.epf_border_sad_mul;
    // Neighbour offsets (dy, dx) in libjxl's order.
    const SADS0: [(isize, isize); 12] = [(-2, 0), (-1, -1), (-1, 0), (-1, 1), (0, -2), (0, -1), (0, 1), (0, 2), (1, -1), (1, 0), (1, 1), (2, 0)];
    const SADS4: [(isize, isize); 4] = [(-1, 0), (0, -1), (0, 1), (1, 0)];
    let offs: &[(isize, isize)] = if step == 0 { &SADS0 } else { &SADS4 };
    // Canonical directions (dy > 0, or dy == 0 and dx > 0); each neighbour maps to one.
    let dirs: Vec<(isize, isize)> = {
        let mut v: Vec<(isize, isize)> = Vec::new();
        for &(dy, dx) in offs {
            let d = if dy > 0 || (dy == 0 && dx > 0) { (dy, dx) } else { (-dy, -dx) };
            if !v.contains(&d) {
                v.push(d);
            }
        }
        v
    };
    let scale = lf.epf_channel_scale;
    let ew = w + 2 * pb; // E rows cover columns -pb .. w + pb (minus the shift), index x + pb.
    // E ring per direction: rows y - 1 - dy .. y + 1 (at most 5 rows).
    const ER: usize = 5;
    let mut erows: Vec<Vec<Vec<f32>>> = dirs.iter().map(|_| vec![vec![0f32; ew + 4]; ER]).collect();
    let mut etags: Vec<Vec<i64>> = dirs.iter().map(|_| vec![i64::MIN; ER]).collect();
    let mut tail = TailRows::default();
    let mut inv_s = vec![0f32; w4];
    // 1.0 where the filter is skipped (sigma below the minimum), else 0.0.
    let mut skip = vec![0f32; w4];
    let mut sad = vec![0f32; w4];
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut wsum = vec![0f32; w4];
    let mut acc = [vec![0f32; w4], vec![0f32; w4], vec![0f32; w4]];
    for y in 0..h {
        for (c, r) in rings.iter_mut().enumerate() {
            r.load(&planes[c], y);
        }
        let prow = |c: usize, dy: isize| -> &[f32] { rings[c].get(y, dy) };
        if step != 2 {
            // Make E rows y - 1 - dy ..= y + 1 available for each direction.
            for (k, &(ddy, ddx)) in dirs.iter().enumerate() {
                for r in (y as i64 - 1 - ddy as i64)..=(y as i64 + 1) {
                    let slot = r.rem_euclid(ER as i64) as usize;
                    if etags[k][slot] == r {
                        continue;
                    }
                    let e = &mut erows[k][slot];
                    e.fill(0.0);
                    for c in 0..3 {
                        let sc = scale[c];
                        let r0 = prow(c, (r - y as i64) as isize);
                        let r1 = prow(c, (r - y as i64) as isize + ddy);
                        // e[i] covers column i - pb; needs P(col) and P(col + ddx).
                        let lo = (ddx.unsigned_abs()).min(pb);
                        let n = (ew - 2 * lo).div_ceil(4) * 4;
                        let a = &r0[lo..lo + n];
                        let bb = &r1[(lo as isize + ddx) as usize..(lo as isize + ddx) as usize + n];
                        let ee = &mut e[lo..lo + n];
                        let scv = F4::splat(sc);
                        for i in (0..n).step_by(4) {
                            F4::load(&ee[i..]).add(F4::load(&a[i..]).sub(F4::load(&bb[i..])).abs().mul(scv)).store(&mut ee[i..]);
                        }
                    }
                    etags[k][slot] = r;
                }
            }
        }
        let border_row = y % 8 == 0 || y % 8 == 7;
        let srow = &inv_sigma[((y / 8) * bw).min(inv_sigma.len())..];
        for (bx, (sk, is)) in skip.chunks_mut(8).zip(inv_s.chunks_mut(8)).enumerate() {
            let s = srow.get(bx).copied().unwrap_or(0.0);
            sk.fill(if s < MIN_SIGMA { 1.0 } else { 0.0 });
            let inner = if border_row { bsm } else { sm };
            for (i, v) in is.iter_mut().enumerate() {
                *v = s * if i == 0 || i == 7 { bsm } else { inner };
            }
        }
        // Column ranges (whole 8-column blocks) where the filter runs; skipped blocks keep
        // their centre values (libjxl skips them too).
        spans.clear();
        for bx in 0..w4.div_ceil(8) {
            if srow.get(bx).copied().unwrap_or(0.0) < MIN_SIGMA {
                continue;
            }
            let (x0, x1) = (bx * 8, (bx * 8 + 8).min(w4));
            match spans.last_mut() {
                Some(last) if last.1 == x0 => last.1 = x1,
                _ => spans.push((x0, x1)),
            }
        }
        wsum.fill(1.0);
        for c in 0..3 {
            acc[c].copy_from_slice(&prow(c, 0)[pb..pb + w4]);
        }
        for &(dy, dx) in offs.iter() {
            if step == 2 {
                sad.fill(0.0);
                for c in 0..3 {
                    let scv = F4::splat(scale[c]);
                    let r0 = &prow(c, 0)[pb..pb + w4];
                    let o = (pb as isize + dx) as usize;
                    let r1 = &prow(c, dy)[o..o + w4];
                    for &(x0, x1) in &spans {
                        for x in (x0..x1).step_by(4) {
                            F4::load(&sad[x..]).add(F4::load(&r1[x..]).sub(F4::load(&r0[x..])).abs().mul(scv)).store(&mut sad[x..]);
                        }
                    }
                }
            } else {
                let canonical = dy > 0 || (dy == 0 && dx > 0);
                let (k, sy, sx) = if canonical {
                    (dirs.iter().position(|&d| d == (dy, dx)).unwrap_or(0), 0isize, 0isize)
                } else {
                    (dirs.iter().position(|&d| d == (-dy, -dx)).unwrap_or(0), dy, dx)
                };
                // SAD(p) = Σ over plus q of E(p + shift + q).
                let er = |ry: isize| -> &[f32] {
                    let r = y as i64 + ry as i64;
                    &erows[k][r.rem_euclid(ER as i64) as usize]
                };
                let base = (pb as isize + sx) as usize;
                let c0 = &er(sy)[base..base + w4];
                let up = &er(sy - 1)[base..base + w4];
                let left = &er(sy)[base - 1..base - 1 + w4];
                let down = &er(sy + 1)[base..base + w4];
                let right = &er(sy)[base + 1..base + 1 + w4];
                for &(x0, x1) in &spans {
                    for x in (x0..x1).step_by(4) {
                        let v = F4::load(&c0[x..]).add(F4::load(&up[x..])).add(F4::load(&left[x..])).add(F4::load(&down[x..])).add(F4::load(&right[x..]));
                        v.store(&mut sad[x..]);
                    }
                }
            }
            let o = (pb as isize + dx) as usize;
            let n0 = &prow(0, dy)[o..o + w4];
            let n1 = &prow(1, dy)[o..o + w4];
            let n2 = &prow(2, dy)[o..o + w4];
            let [a0, a1, a2] = &mut acc;
            let one = F4::splat(1.0);
            for x in spans.iter().flat_map(|&(x0, x1)| (x0..x1).step_by(4)) {
                let weight = F4::load(&sad[x..]).mul(F4::load(&inv_s[x..])).add(one).max0();
                F4::load(&wsum[x..]).add(weight).store(&mut wsum[x..]);
                F4::load(&a0[x..]).add(weight.mul(F4::load(&n0[x..]))).store(&mut a0[x..]);
                F4::load(&a1[x..]).add(weight.mul(F4::load(&n1[x..]))).store(&mut a1[x..]);
                F4::load(&a2[x..]).add(weight.mul(F4::load(&n2[x..]))).store(&mut a2[x..]);
            }
        }
        for c in 0..3 {
            let center = &rings[c].get(y, 0)[pb..pb + w4];
            let o = &mut acc[c];
            let (one, half) = (F4::splat(1.0), F4::splat(0.5));
            for x in (0..w4).step_by(4) {
                let f = F4::load(&o[x..]).mul(one.div(F4::load(&wsum[x..])));
                F4::load(&skip[x..]).gt_select(half, F4::load(&center[x..]), f).store(&mut o[x..]);
            }
            tail.put(&mut planes[c], c, y, pb, &o[..w]);
        }
    }
    tail.flush(planes);
}

/// In-place output for the row filters. Row `y` of the result can overwrite the input once
/// the window for `y` has been loaded, unless a later window still reads it through the
/// bottom mirror (rows `h - b ..`); those rows wait here until the plane is done.
#[derive(Default)]
struct TailRows {
    rows: Vec<(usize, usize, Vec<f32>)>,
}

impl TailRows {
    fn put(&mut self, p: &mut Plane, c: usize, y: usize, b: usize, row: &[f32]) {
        if y + b < p.h {
            p.row_mut(y).copy_from_slice(row);
        } else {
            self.rows.push((c, y, row.to_vec()));
        }
    }

    fn flush(&mut self, planes: &mut [Plane]) {
        for (c, y, r) in self.rows.drain(..) {
            planes[c].row_mut(y).copy_from_slice(&r);
        }
    }
}

/// The 5×5 kernels of an N× upsampler, from the stored weights.
pub fn upsampling_kernel(weights: &[f32], shift: u32) -> Vec<f32> {
    let n = 1usize << shift;
    let hh = n / 2;
    let mut k = vec![0f32; n * n * 25];
    for ky in 0..hh {
        for kx in 0..hh {
            let o0 = (ky * n + kx) * 25;
            let o1 = (ky * n + (n - 1 - kx)) * 25;
            let o2 = ((n - 1 - ky) * n + kx) * 25;
            let o3 = ((n - 1 - ky) * n + (n - 1 - kx)) * 25;
            for py in 0..5 {
                for px in 0..5 {
                    let j = 5 * ky + py;
                    let i = 5 * kx + px;
                    let my = i.min(j);
                    let mx = i.max(j);
                    let w = weights.get(5 * hh * my - my * (my.saturating_sub(1)) / 2 + mx - my).copied().unwrap_or(0.0);
                    k[o0 + py * 5 + px] = w;
                    k[o1 + py * 5 + (4 - px)] = w;
                    k[o2 + (4 - py) * 5 + px] = w;
                    k[o3 + (4 - py) * 5 + (4 - px)] = w;
                }
            }
        }
    }
    k
}

/// N× upsampling of one channel to (w, h), clamped to each 5×5 neighbourhood's range.
pub fn upsample(p: &Plane, kernel: &[f32], shift: u32, w: usize, h: usize) -> Result<Plane> {
    let n = 1usize << shift;
    let (src, pw) = padded(p, 2);
    let mut out = Plane::new(w, h)?;
    let mut win = [0f32; 25];
    for y in 0..p.h {
        for x in 0..p.w {
            let mut mn = f32::INFINITY;
            let mut mx = f32::NEG_INFINITY;
            for iy in 0..5 {
                for ix in 0..5 {
                    let v = src[(y + iy) * pw + x + ix];
                    win[iy * 5 + ix] = v;
                    mn = mn.min(v);
                    mx = mx.max(v);
                }
            }
            for oy in 0..n {
                let yy = y * n + oy;
                if yy >= h {
                    break;
                }
                for ox in 0..n {
                    let xx = x * n + ox;
                    if xx >= w {
                        break;
                    }
                    let kk = &kernel[(n * oy + ox) * 25..(n * oy + ox) * 25 + 25];
                    let mut a0 = win[0] * kk[0];
                    let mut a1 = win[1] * kk[1];
                    let mut a2 = win[2] * kk[2];
                    let mut i = 3;
                    while i < 24 {
                        a0 += win[i] * kk[i];
                        a1 += win[i + 1] * kk[i + 1];
                        a2 += win[i + 2] * kk[i + 2];
                        i += 3;
                    }
                    a0 += win[24] * kk[24];
                    let r = (a1 + a2) + a0;
                    out.data[yy * w + xx] = r.clamp(mn, mx);
                }
            }
        }
    }
    Ok(out)
}

/// YCbCr (Cb, Y, Cr planes) to RGB, in place.
pub fn ycbcr_to_rgb(planes: &mut [Plane]) {
    const C128: f32 = 128.0 / 255.0;
    const CRCR: f32 = 1.402;
    const CGCB: f32 = -0.114 * 1.772 / 0.587;
    const CGCR: f32 = -0.299 * 1.402 / 0.587;
    const CBCB: f32 = 1.772;
    let n = planes[0].data.len();
    let (p0, rest) = planes.split_at_mut(1);
    let (p1, p2) = rest.split_at_mut(1);
    for i in 0..n {
        let y = p1[0].data[i] + C128;
        let cb = p0[0].data[i];
        let cr = p2[0].data[i];
        p0[0].data[i] = CRCR * cr + y;
        p1[0].data[i] = CGCR * cr + (CGCB * cb + y);
        p2[0].data[i] = CBCB * cb + y;
    }
}

/// Parameters of the XYB to linear RGB conversion.
#[derive(Clone, Debug)]
pub struct OpsinParams {
    /// Row-major 3×3, already scaled by 255 / intensity target.
    pub inverse: [[f32; 3]; 3],
    pub bias: [f32; 3],
    pub bias_cbrt: [f32; 3],
}

/// XYB to linear RGB; with `gray` (all matrix rows equal) only the first plane is computed
/// and copied to the other two.
pub fn xyb_to_linear(planes: &mut [Plane], op: &OpsinParams, gray: bool) {
    let (p0, rest) = planes.split_at_mut(1);
    let (p1, p2) = rest.split_at_mut(1);
    let n = p0[0].data.len().min(p1[0].data.len()).min(p2[0].data.len());
    let (d0, d1, d2) = (&mut p0[0].data[..n], &mut p1[0].data[..n], &mut p2[0].data[..n]);
    let (bc, bias, m) = (op.bias_cbrt, op.bias, &op.inverse);
    #[inline(always)]
    fn mix(x: f32, y: f32, b: f32, bc: [f32; 3], bias: [f32; 3]) -> (f32, f32, f32) {
        let gr = (y + x) - bc[0];
        let gg = (y - x) - bc[1];
        let gb = b - bc[2];
        (gr * gr * gr + bias[0], gg * gg * gg + bias[1], gb * gb * gb + bias[2])
    }
    if gray {
        let m = m[0];
        for ((x, y), b) in d0.iter_mut().zip(d1.iter()).zip(d2.iter()) {
            let (mr, mg, mb) = mix(*x, *y, *b, bc, bias);
            *x = m[2] * mb + (m[1] * mg + m[0] * mr);
        }
        return;
    }
    for ((x, y), b) in d0.iter_mut().zip(d1.iter_mut()).zip(d2.iter_mut()) {
        let (mr, mg, mb) = mix(*x, *y, *b, bc, bias);
        let mut r = m[0][0] * mr;
        let mut g = m[1][0] * mr;
        let mut bb = m[2][0] * mr;
        r += m[0][1] * mg;
        g += m[1][1] * mg;
        bb += m[2][1] * mg;
        r += m[0][2] * mb;
        g += m[1][2] * mb;
        bb += m[2][2] * mb;
        *x = r;
        *y = g;
        *b = bb;
    }
}

#[derive(Clone, Copy, Debug)]
pub enum OutputTf {
    Linear,
    Srgb,
    Gamma(f32),
    Bt709,
    Pq(f32),
    /// HLG: libjxl's inverse OOTF (exponent, luminances of the primaries), then the OETF.
    Hlg(f32, [f32; 3]),
}

#[allow(clippy::excessive_precision)]
fn srgb_from_linear(x: f32) -> f32 {
    let a = x.abs();
    let p = [-5.135152395e-04f32, 5.287254571e-03, 3.903842876e-01, 1.474205315e+00, 7.352629620e-01];
    let q = [1.004519624e-02f32, 3.036675394e-01, 1.340816930e+00, 9.258482155e-01, 2.424867759e-02];
    // Both branches are computed so the loop vectorises; the select picks one.
    let s = a.sqrt();
    let yp = (((p[4] * s + p[3]) * s + p[2]) * s + p[1]) * s + p[0];
    let yq = (((q[4] * s + q[3]) * s + q[2]) * s + q[1]) * s + q[0];
    let v = if a > 0.0031308 { yp / yq } else { a * 12.92 };
    v.copysign(x)
}

fn bt709_from_linear(x: f32) -> f32 {
    if x <= 0.018 {
        4.5 * x
    } else {
        1.099 * crate::vardct::quant::fast_powf_pub(x, 0.45) + -0.099
    }
}

fn rational4(x: f32, p: &[f32; 5], q: &[f32; 5]) -> f32 {
    let yp = (((p[4] * x + p[3]) * x + p[2]) * x + p[1]) * x + p[0];
    let yq = (((q[4] * x + q[3]) * x + q[2]) * x + q[1]) * x + q[0];
    yp / yq
}

#[allow(clippy::excessive_precision)]
fn pq_from_linear(x: f32, intensity: f32) -> f32 {
    let p = [1.351392e-02f32, -1.095778e+00, 5.522776e+01, 1.492516e+02, 4.838434e+01];
    let q = [1.012416e+00f32, 2.016708e+01, 9.263710e+01, 1.120607e+02, 2.590418e+01];
    let plo = [9.863406e-06f32, 3.881234e-01, 1.352821e+02, 6.889862e+04, -2.864824e+05];
    let qlo = [3.371868e+01f32, 1.477719e+03, 1.608477e+04, -4.389884e+04, -2.072546e+05];
    let a = x.abs();
    let xto025 = (a * (intensity * (1.0 / 10000.0))).sqrt().sqrt();
    let m = if a < 1e-4 { rational4(xto025, &plo, &qlo) } else { rational4(xto025, &p, &q) };
    m.copysign(x)
}

/// libjxl's TF_HLG::EncodedFromDisplay (vector form, with FastLog2f).
fn hlg_from_linear(x: f32) -> f32 {
    const KA: f32 = 0.17883277;
    const KB: f32 = 0.28466892;
    const KC: f32 = 0.55991073;
    const INV_LOG2E: f32 = std::f32::consts::LN_2; // 1 / log2(e)
    let a = x.abs();
    let lo = (3.0 * a).sqrt();
    let hi = (KA * INV_LOG2E) * crate::vardct::quant::fast_log2f_pub(12.0 * a - KB) + KC;
    let v = if a <= 1.0 / 12.0 { lo } else { hi };
    v.copysign(x)
}

/// libjxl's HlgOOTF::Apply: scales each pixel by its luminance to the power `exponent`.
fn hlg_ootf(planes: &mut [Plane], exponent: f32, lum: [f32; 3]) {
    if (-0.01..=0.01).contains(&exponent) {
        return;
    }
    let ratio = |l: f32| crate::vardct::quant::fast_powf_pub(l, exponent).min(1e9);
    if planes.len() == 1 {
        let s = lum[0] + lum[1] + lum[2];
        for v in planes[0].data.iter_mut() {
            *v *= ratio(*v * s);
        }
        return;
    }
    let (p0, rest) = planes.split_at_mut(1);
    let (p1, p2) = rest.split_at_mut(1);
    for ((r, g), b) in p0[0].data.iter_mut().zip(p1[0].data.iter_mut()).zip(p2[0].data.iter_mut()) {
        let k = ratio(lum[0] * *r + (lum[1] * *g + lum[2] * *b));
        *r *= k;
        *g *= k;
        *b *= k;
    }
}

pub fn from_linear(planes: &mut [Plane], tf: OutputTf) {
    if let OutputTf::Hlg(e, lum) = tf {
        hlg_ootf(planes, e, lum);
    }
    for p in planes.iter_mut() {
        match tf {
            OutputTf::Linear => {}
            OutputTf::Srgb => p.data.iter_mut().for_each(|v| *v = srgb_from_linear(*v)),
            OutputTf::Gamma(g) => p.data.iter_mut().for_each(|v| *v = if *v <= 1e-5 { 0.0 } else { crate::vardct::quant::fast_powf_pub(*v, g) }),
            OutputTf::Bt709 => p.data.iter_mut().for_each(|v| *v = bt709_from_linear(*v)),
            OutputTf::Pq(i) => p.data.iter_mut().for_each(|v| *v = pq_from_linear(*v, i)),
            OutputTf::Hlg(..) => p.data.iter_mut().for_each(|v| *v = hlg_from_linear(*v)),
        }
    }
}

#[rustfmt::skip]
pub const UPS2: [f32; 15] = [
    -0.01716200, -0.03452303, -0.04022174, -0.02921014, -0.00624645,
    0.14111091, 0.28896755, 0.00278718, -0.01610267, 0.56661550,
    0.03777607, -0.01986694, -0.03144731, -0.01185068, -0.00213539,
];
#[rustfmt::skip]
pub const UPS4: [f32; 55] = [
    -0.02419067, -0.03491987, -0.03693351, -0.03094285, -0.00529785,
    -0.01663432, -0.03556863, -0.03888905, -0.03516850, -0.00989469,
    0.23651958, 0.33392945, -0.01073543, -0.01313181, -0.03556694,
    0.13048175, 0.40103025, 0.03951150, -0.02077584, 0.46914198,
    -0.00209270, -0.01484589, -0.04064806, 0.18942530, 0.56279892,
    0.06674400, -0.02335494, -0.03551682, -0.00754830, -0.02267919,
    -0.02363578, 0.00315804, -0.03399098, -0.01359519, -0.00091653,
    -0.00335467, -0.01163294, -0.01610294, -0.00974088, -0.00191622,
    -0.01095446, -0.03198464, -0.04455121, -0.02799790, -0.00645912,
    0.06390599, 0.22963888, 0.00630981, -0.01897349, 0.67537268,
    0.08483369, -0.02534994, -0.02205197, -0.01667999, -0.00384443,
];
#[rustfmt::skip]
pub const UPS8: [f32; 210] = [
    -0.02928613, -0.03706353, -0.03783812, -0.03324558, -0.00447632,
    -0.02519406, -0.03752601, -0.03901508, -0.03663285, -0.00646649,
    -0.02066407, -0.03838633, -0.04002101, -0.03900035, -0.00901973,
    -0.01626393, -0.03954148, -0.04046620, -0.03979621, -0.01224485,
    0.29895328, 0.35757708, -0.02447552, -0.01081748, -0.04314594,
    0.23903219, 0.41119301, -0.00573046, -0.01450239, -0.04246845,
    0.17567618, 0.45220643, 0.02287757, -0.01936783, -0.03583255,
    0.11572472, 0.47416733, 0.06284440, -0.02685066, 0.42720050,
    -0.02248939, -0.01155273, -0.04562755, 0.28689496, 0.49093869,
    -0.00007891, -0.01545926, -0.04562659, 0.21238920, 0.53980934,
    0.03369474, -0.02070211, -0.03866988, 0.14229550, 0.56593398,
    0.08045181, -0.02888298, -0.03680918, -0.00542229, -0.02920477,
    -0.02788574, -0.02118180, -0.03942402, -0.00775547, -0.02433614,
    -0.03193943, -0.02030828, -0.04044014, -0.01074016, -0.01930822,
    -0.03620399, -0.01974125, -0.03919545, -0.01456093, -0.00045072,
    -0.00360110, -0.01020207, -0.01231907, -0.00638988, -0.00071592,
    -0.00279122, -0.00957115, -0.01288327, -0.00730937, -0.00107783,
    -0.00210156, -0.00890705, -0.01317668, -0.00813895, -0.00153491,
    -0.02128481, -0.04173044, -0.04831487, -0.03293190, -0.00525260,
    -0.01720322, -0.04052736, -0.05045706, -0.03607317, -0.00738030,
    -0.01341764, -0.03965629, -0.05151616, -0.03814886, -0.01005819,
    0.18968273, 0.33063684, -0.01300105, -0.01372950, -0.04017465,
    0.13727832, 0.36402234, 0.01027890, -0.01832107, -0.03365072,
    0.08734506, 0.38194295, 0.04338228, -0.02525993, 0.56408126,
    0.00458352, -0.01648227, -0.04887868, 0.24585519, 0.62026135,
    0.04314807, -0.02213737, -0.04158014, 0.16637289, 0.65027023,
    0.09621636, -0.03101388, -0.04082742, -0.00904519, -0.02790922,
    -0.02117818, 0.00798662, -0.03995711, -0.01243427, -0.02231705,
    -0.02946266, 0.00992055, -0.03600283, -0.01684920, -0.00111684,
    -0.00411204, -0.01297130, -0.01723725, -0.01022545, -0.00165306,
    -0.00313110, -0.01218016, -0.01763266, -0.01125620, -0.00231663,
    -0.01374149, -0.03797620, -0.05142937, -0.03117307, -0.00581914,
    -0.01064003, -0.03608089, -0.05272168, -0.03375670, -0.00795586,
    0.09628104, 0.27129991, -0.00353779, -0.01734151, -0.03153981,
    0.05686230, 0.28500998, 0.02230594, -0.02374955, 0.68214326,
    0.05018048, -0.02320852, -0.04383616, 0.18459474, 0.71517975,
    0.10805613, -0.03263677, -0.03637639, -0.01394373, -0.02511203,
    -0.01728636, 0.05407331, -0.02867568, -0.01893131, -0.00240854,
    -0.00446511, -0.01636187, -0.02377053, -0.01522848, -0.00333334,
    -0.00819975, -0.02964169, -0.04499287, -0.02745350, -0.00612408,
    0.02727416, 0.19446600, 0.00159832, -0.02232473, 0.74982506,
    0.11452620, -0.03348048, -0.01605681, -0.02070339, -0.00458223,
];

/// libjxl's 8-lane xorshift128+ generator used for noise.
struct Xorshift128Plus {
    s0: [u64; 8],
    s1: [u64; 8],
}

fn splitmix64(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

impl Xorshift128Plus {
    fn new(seed1: u32, seed2: u32, seed3: u32, seed4: u32) -> Self {
        let mut s0 = [0u64; 8];
        let mut s1 = [0u64; 8];
        s0[0] = splitmix64(((u64::from(seed1) << 32).wrapping_add(u64::from(seed2))).wrapping_add(0x9E37_79B9_7F4A_7C15));
        s1[0] = splitmix64(((u64::from(seed3) << 32).wrapping_add(u64::from(seed4))).wrapping_add(0x9E37_79B9_7F4A_7C15));
        for i in 1..8 {
            s0[i] = splitmix64(s0[i - 1]);
            s1[i] = splitmix64(s1[i - 1]);
        }
        Xorshift128Plus { s0, s1 }
    }

    fn fill(&mut self, out: &mut [u64; 8]) {
        for i in 0..8 {
            let mut s1 = self.s0[i];
            let s0 = self.s1[i];
            out[i] = s1.wrapping_add(s0);
            self.s0[i] = s0;
            s1 ^= s1 << 23;
            s1 ^= s0 ^ (s1 >> 18) ^ (s0 >> 5);
            self.s1[i] = s1;
        }
    }
}

#[inline(always)]
fn bits_to_float(b: u32) -> f32 {
    f32::from_bits((b >> 9) | 0x3F80_0000)
}

/// The three random planes (w × h) for noise, tiled in `group_dim` squares.
pub fn noise_planes(w: usize, h: usize, group_dim: usize, visible: u32, nonvisible: u32) -> Result<[Plane; 3]> {
    let mut planes = [Plane::new(w, h)?, Plane::new(w, h)?, Plane::new(w, h)?];
    let mut b64 = [0u64; 8];
    for ty in (0..h).step_by(group_dim) {
        for tx in (0..w).step_by(group_dim) {
            let mut rng = Xorshift128Plus::new(visible, nonvisible, tx as u32, ty as u32);
            let tw = group_dim.min(w - tx);
            let th = group_dim.min(h - ty);
            for p in planes.iter_mut() {
                for y in ty..ty + th {
                    let row = &mut p.data[y * w + tx..y * w + tx + tw];
                    let mut x = 0;
                    while x + 16 < tw {
                        rng.fill(&mut b64);
                        for i in 0..16 {
                            let v = (b64[i / 2] >> (32 * (i % 2))) as u32;
                            row[x + i] = bits_to_float(v);
                        }
                        x += 16;
                    }
                    rng.fill(&mut b64);
                    let mut i = 0;
                    while x < tw {
                        let v = (b64[i / 2] >> (32 * (i % 2))) as u32;
                        row[x] = bits_to_float(v);
                        x += 1;
                        i += 1;
                    }
                }
            }
        }
    }
    Ok(planes)
}

/// Convolves a noise plane with libjxl's 5×5 high-pass kernel.
pub fn convolve_noise(p: &mut Plane) {
    let (src, pw) = padded(p, 2);
    for y in 0..p.h {
        let rows: [&[f32]; 5] = core::array::from_fn(|i| &src[(y + i) * pw..(y + i + 1) * pw]);
        let o = p.row_mut(y);
        for x in 0..o.len() {
            let xx = x + 2;
            let p00 = rows[2][xx];
            let mut others = 0f32;
            for i in 0..5 {
                let xi = x + i;
                others += rows[0][xi];
                others += rows[1][xi];
                others += rows[3][xi];
                others += rows[4][xi];
            }
            others += rows[2][xx - 2];
            others += rows[2][xx - 1];
            others += rows[2][xx + 1];
            others += rows[2][xx + 2];
            o[x] = others * 0.16 + p00 * -3.84;
        }
    }
}

fn noise_strength(lut: &[f32; 8], x: f32) -> f32 {
    let scaled = (x * 6.0).max(0.0);
    let mut fl = scaled.floor();
    let mut frac = scaled - fl;
    if scaled >= 7.0 {
        fl = 6.0;
        frac = 1.0;
    }
    let i = fl as usize;
    let low = lut[i];
    let hi = lut[i + 1];
    ((hi - low) * frac + low).clamp(0.0, 1.0)
}

/// Adds noise (already convolved random planes) to the XYB planes.
pub fn add_noise(planes: &mut [Plane], rnd: &[Plane; 3], lut: &[f32; 8], ytox: f32, ytob: f32) {
    let n = planes[0].data.len();
    let (px, rest) = planes.split_at_mut(1);
    let (py, pb) = rest.split_at_mut(1);
    for i in 0..n {
        let vx = px[0].data[i];
        let vy = py[0].data[i];
        let in_g = vy - vx;
        let in_r = vy + vx;
        let sg = noise_strength(lut, in_g * 0.5);
        let sr = noise_strength(lut, in_r * 0.5);
        let nr = rnd[0].data[i] * 0.22;
        let ng = rnd[1].data[i] * 0.22;
        let nc = rnd[2].data[i] * 0.22;
        let red = sr * (0.0078125 * nr + 0.9921875 * nc);
        let green = sg * (0.0078125 * ng + 0.9921875 * nc);
        let rg = red + green;
        px[0].data[i] = (ytox * rg + (red - green)) + vx;
        py[0].data[i] = vy + rg;
        pb[0].data[i] += ytob * rg;
    }
}
