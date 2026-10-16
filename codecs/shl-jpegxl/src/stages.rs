//! Rendering stages applied to whole frames (libjxl's render pipeline, run stage by stage as
//! its simple pipeline does: each stage sees its input mirrored at the channel's edges).

use crate::error::Result;
use crate::frame_header::LoopFilter;
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
        let (src, pw) = padded(p, 1);
        for y in 0..p.h {
            let t = &src[y * pw..(y + 1) * pw];
            let m = &src[(y + 1) * pw..(y + 2) * pw];
            let b = &src[(y + 2) * pw..(y + 3) * pw];
            let o = p.row_mut(y);
            for x in 0..o.len() {
                let sum0 = m[x + 1];
                let sum1 = (m[x] + m[x + 2]) + (t[x + 1] + b[x + 1]);
                let sum2 = (t[x] + t[x + 2]) + (b[x] + b[x + 2]);
                o[x] = sum2 * w2 + (sum1 * w1 + sum0 * w0);
            }
        }
    }
}

#[allow(clippy::excessive_precision)]
const MIN_SIGMA: f32 = -3.90524291751269967465540850526868;

/// One edge-preserving filter step (0, 1 or 2); `inv_sigma` per 8×8 block (`bw` wide).
pub fn epf(planes: &mut [Plane], lf: &LoopFilter, inv_sigma: &[f32], bw: usize, step: u32) {
    let (w, h) = (planes[0].w, planes[0].h);
    let border = match step {
        0 => 3,
        1 => 2,
        _ => 1,
    };
    let pads: Vec<(Vec<f32>, usize)> = planes.iter().take(3).map(|p| padded(p, border)).collect();
    let pw = pads[0].1;
    let sm = match step {
        0 => (f64::from(lf.epf_pass0_sigma_scale) * 1.65) as f32,
        1 => 1.65f32,
        _ => (f64::from(lf.epf_pass2_sigma_scale) * 1.65) as f32,
    };
    let bsm = sm * lf.epf_border_sad_mul;
    const SADS0: [(i64, i64); 12] = [(-2, 0), (-1, -1), (-1, 0), (-1, 1), (0, -2), (0, -1), (0, 1), (0, 2), (1, -1), (1, 0), (1, 1), (2, 0)];
    const SADS4: [(i64, i64); 4] = [(-1, 0), (0, -1), (0, 1), (1, 0)];
    const PLUS: [(i64, i64); 5] = [(0, 0), (-1, 0), (0, -1), (1, 0), (0, 1)];
    let at = |c: usize, y: usize, x: usize, dy: i64, dx: i64| -> f32 {
        let yy = (y as i64 + border as i64 + dy) as usize;
        let xx = (x as i64 + border as i64 + dx) as usize;
        pads[c].0[yy * pw + xx]
    };
    let mut out: Vec<Vec<f32>> = (0..3).map(|_| vec![0f32; w * h]).collect();
    let mut sads = [0f32; 12];
    for y in 0..h {
        let border_row = y % 8 == 0 || y % 8 == 7;
        for x in 0..w {
            let s = inv_sigma.get((y / 8) * bw + x / 8).copied().unwrap_or(0.0);
            if s < MIN_SIGMA {
                for c in 0..3 {
                    out[c][y * w + x] = at(c, y, x, 0, 0);
                }
                continue;
            }
            let vsm = if border_row || x % 8 == 0 || x % 8 == 7 { bsm } else { sm };
            let inv_s = s * vsm;
            let mut wsum = 1f32;
            let mut acc = [at(0, y, x, 0, 0), at(1, y, x, 0, 0), at(2, y, x, 0, 0)];
            let offs: &[(i64, i64)] = if step == 0 { &SADS0 } else { &SADS4 };
            for (i, &(dy, dx)) in offs.iter().enumerate() {
                let mut total = 0f32;
                for c in 0..3 {
                    let scale = lf.epf_channel_scale[c];
                    let sad = if step == 2 {
                        (at(c, y, x, dy, dx) - at(c, y, x, 0, 0)).abs()
                    } else {
                        let mut sad = 0f32;
                        for &(py, px) in PLUS.iter() {
                            sad += (at(c, y, x, py, px) - at(c, y, x, dy + py, dx + px)).abs();
                        }
                        sad
                    };
                    total = sad * scale + total;
                }
                sads[i] = total;
            }
            for (i, &(dy, dx)) in offs.iter().enumerate() {
                let weight = (sads[i] * inv_s + 1.0).max(0.0);
                wsum += weight;
                for c in 0..3 {
                    acc[c] = weight * at(c, y, x, dy, dx) + acc[c];
                }
            }
            let inv_w = 1.0 / wsum;
            for c in 0..3 {
                out[c][y * w + x] = acc[c] * inv_w;
            }
        }
    }
    for (p, o) in planes.iter_mut().zip(out) {
        p.data = o;
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
                        a0 = win[i] * kk[i] + a0;
                        a1 = win[i + 1] * kk[i + 1] + a1;
                        a2 = win[i + 2] * kk[i + 2] + a2;
                        i += 3;
                    }
                    a0 = win[24] * kk[24] + a0;
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

pub fn xyb_to_linear(planes: &mut [Plane], op: &OpsinParams) {
    let n = planes[0].data.len();
    let (p0, rest) = planes.split_at_mut(1);
    let (p1, p2) = rest.split_at_mut(1);
    let m = &op.inverse;
    for i in 0..n {
        let x = p0[0].data[i];
        let y = p1[0].data[i];
        let b = p2[0].data[i];
        let gr = (y + x) - op.bias_cbrt[0];
        let gg = (y - x) - op.bias_cbrt[1];
        let gb = b - op.bias_cbrt[2];
        let mr = gr * gr * gr + op.bias[0];
        let mg = gg * gg * gg + op.bias[1];
        let mb = gb * gb * gb + op.bias[2];
        let mut r = m[0][0] * mr;
        let mut g = m[1][0] * mr;
        let mut bb = m[2][0] * mr;
        r = m[0][1] * mg + r;
        g = m[1][1] * mg + g;
        bb = m[2][1] * mg + bb;
        r = m[0][2] * mb + r;
        g = m[1][2] * mb + g;
        bb = m[2][2] * mb + bb;
        p0[0].data[i] = r;
        p1[0].data[i] = g;
        p2[0].data[i] = bb;
    }
}

#[derive(Clone, Copy, Debug)]
pub enum OutputTf {
    Linear,
    Srgb,
    Gamma(f32),
    Bt709,
    Pq(f32),
    Hlg,
}

#[allow(clippy::excessive_precision)]
fn srgb_from_linear(x: f32) -> f32 {
    let sign = x.is_sign_negative();
    let a = x.abs();
    let p = [-5.135152395e-04f32, 5.287254571e-03, 3.903842876e-01, 1.474205315e+00, 7.352629620e-01];
    let q = [1.004519624e-02f32, 3.036675394e-01, 1.340816930e+00, 9.258482155e-01, 2.424867759e-02];
    let v = if a > 0.0031308 {
        let s = a.sqrt();
        let yp = (((p[4] * s + p[3]) * s + p[2]) * s + p[1]) * s + p[0];
        let yq = (((q[4] * s + q[3]) * s + q[2]) * s + q[1]) * s + q[0];
        yp / yq
    } else {
        a * 12.92
    };
    if sign {
        -v
    } else {
        v
    }
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

fn hlg_from_linear(x: f32) -> f32 {
    let a = f64::from(x.abs());
    let (ka, kb, kc) = (0.17883277, 0.28466892, 0.55991073);
    let v = if a <= 1.0 / 12.0 { (3.0 * a).sqrt() } else { ka * (12.0 * a - kb).ln() + kc };
    (v as f32).copysign(x)
}

pub fn from_linear(planes: &mut [Plane], tf: OutputTf) {
    for p in planes.iter_mut().take(3) {
        match tf {
            OutputTf::Linear => {}
            OutputTf::Srgb => p.data.iter_mut().for_each(|v| *v = srgb_from_linear(*v)),
            OutputTf::Gamma(g) => p.data.iter_mut().for_each(|v| *v = if *v <= 1e-5 { 0.0 } else { crate::vardct::quant::fast_powf_pub(*v, g) }),
            OutputTf::Bt709 => p.data.iter_mut().for_each(|v| *v = bt709_from_linear(*v)),
            OutputTf::Pq(i) => p.data.iter_mut().for_each(|v| *v = pq_from_linear(*v, i)),
            OutputTf::Hlg => p.data.iter_mut().for_each(|v| *v = hlg_from_linear(*v)),
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
