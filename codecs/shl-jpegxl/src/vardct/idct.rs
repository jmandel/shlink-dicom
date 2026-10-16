//! Inverse transforms of the VarDCT blocks (ISO/IEC 18181-1 I.2), using libjxl's scaled DCT
//! (DC = block mean) and its recursive factorisation, so results agree to rounding.

use super::acs::AcStrategy;

const SQRT2: f32 = 1.414_213_56;

/// 1 / (2 cos((i + 0.5) π / N)) for i < N/2, for N = 4..=256 (index log2(N) - 2).
fn wc_multipliers(n: usize) -> &'static [f32] {
    use std::sync::OnceLock;
    static TABLES: OnceLock<Vec<Vec<f32>>> = OnceLock::new();
    let t = TABLES.get_or_init(|| {
        (2..=8)
            .map(|l| {
                let n = 1usize << l;
                (0..n / 2).map(|i| (1.0 / (2.0 * ((i as f64 + 0.5) * std::f64::consts::PI / n as f64).cos())) as f32).collect()
            })
            .collect()
    });
    &t[n.trailing_zeros() as usize - 2]
}

/// In-place inverse DCT of `n` points on each of `l` interleaved lanes: `d[i * l + lane]`.
/// `scratch` must hold at least `2 * n * l` values.
pub fn idct_rows(d: &mut [f32], n: usize, l: usize, scratch: &mut [f32]) {
    if n == 1 {
        return;
    }
    if n == 2 {
        let (a, b) = d.split_at_mut(l);
        for (x, y) in a.iter_mut().zip(b.iter_mut()) {
            let (p, q) = (*x, *y);
            *x = p + q;
            *y = p - q;
        }
        return;
    }
    let h = n / 2;
    let (t, rest) = scratch.split_at_mut(n * l);
    for i in 0..h {
        t[i * l..(i + 1) * l].copy_from_slice(&d[2 * i * l..(2 * i + 1) * l]);
        t[(h + i) * l..(h + i + 1) * l].copy_from_slice(&d[(2 * i + 1) * l..(2 * i + 2) * l]);
    }
    let (lo, hi) = t.split_at_mut(h * l);
    idct_rows(lo, h, l, rest);
    for i in (1..h).rev() {
        let (a, b) = hi.split_at_mut(i * l);
        for (x, y) in b[..l].iter_mut().zip(a[(i - 1) * l..].iter()) {
            *x += *y;
        }
    }
    for v in hi[..l].iter_mut() {
        *v *= SQRT2;
    }
    idct_rows(hi, h, l, rest);
    let m = wc_multipliers(n);
    for i in 0..h {
        let mul = m[i];
        let (top, bot) = d.split_at_mut((n - 1 - i) * l);
        let a = &lo[i * l..(i + 1) * l];
        let b = &hi[i * l..(i + 1) * l];
        let out1 = &mut top[i * l..(i + 1) * l];
        for k in 0..l {
            out1[k] = mul * b[k] + a[k];
        }
        let out2 = &mut bot[..l];
        for k in 0..l {
            out2[k] = a[k] - mul * b[k];
        }
    }
}

/// In-place forward DCT (unscaled: the caller divides by `n`) on interleaved lanes.
pub fn dct_rows(d: &mut [f32], n: usize, l: usize, scratch: &mut [f32]) {
    if n == 1 {
        return;
    }
    if n == 2 {
        let (a, b) = d.split_at_mut(l);
        for (x, y) in a.iter_mut().zip(b.iter_mut()) {
            let (p, q) = (*x, *y);
            *x = p + q;
            *y = p - q;
        }
        return;
    }
    let h = n / 2;
    let (t, rest) = scratch.split_at_mut(n * l);
    for i in 0..h {
        for k in 0..l {
            t[i * l + k] = d[i * l + k] + d[(n - 1 - i) * l + k];
            t[(h + i) * l + k] = d[i * l + k] - d[(n - 1 - i) * l + k];
        }
    }
    let m = wc_multipliers(n);
    let (lo, hi) = t.split_at_mut(h * l);
    dct_rows(lo, h, l, rest);
    for i in 0..h {
        for v in hi[i * l..(i + 1) * l].iter_mut() {
            *v *= m[i];
        }
    }
    dct_rows(hi, h, l, rest);
    for k in 0..l {
        hi[k] = hi[k] * SQRT2 + hi[l + k];
    }
    for i in 1..h - 1 {
        for k in 0..l {
            hi[i * l + k] += hi[(i + 1) * l + k];
        }
    }
    for i in 0..h {
        d[2 * i * l..(2 * i + 1) * l].copy_from_slice(&lo[i * l..(i + 1) * l]);
        d[(2 * i + 1) * l..(2 * i + 2) * l].copy_from_slice(&hi[i * l..(i + 1) * l]);
    }
}

fn transpose(src: &[f32], rows: usize, cols: usize, dst: &mut [f32]) {
    for r in 0..rows {
        for c in 0..cols {
            dst[c * rows + r] = src[r * cols + c];
        }
    }
}

type V8 = [f32; 8];

#[inline(always)]
fn v_add(a: V8, b: V8) -> V8 {
    core::array::from_fn(|i| a[i] + b[i])
}

/// Fixed-size IDCTs on bundles of 8 lanes: `d[i]` holds point i of 8 independent transforms.
macro_rules! idct_bundle {
    ($name:ident, $n:expr, $h:expr, $half:ident) => {
        #[inline(always)]
        fn $name(d: &mut [V8; $n], m: &[f32]) {
            let mut lo = [[0f32; 8]; $h];
            let mut hi = [[0f32; 8]; $h];
            for i in 0..$h {
                lo[i] = d[2 * i];
                hi[i] = d[2 * i + 1];
            }
            $half(&mut lo, wc_multipliers($h));
            for i in (1..$h).rev() {
                hi[i] = v_add(hi[i], hi[i - 1]);
            }
            hi[0] = core::array::from_fn(|k| hi[0][k] * SQRT2);
            $half(&mut hi, wc_multipliers($h));
            for i in 0..$h {
                let mul = m[i];
                let (a, b) = (lo[i], hi[i]);
                d[i] = core::array::from_fn(|k| mul * b[k] + a[k]);
                d[$n - 1 - i] = core::array::from_fn(|k| a[k] - mul * b[k]);
            }
        }
    };
}

#[inline(always)]
fn idct_b2(d: &mut [V8; 2], _m: &[f32]) {
    let (a, b) = (d[0], d[1]);
    d[0] = core::array::from_fn(|k| a[k] + b[k]);
    d[1] = core::array::from_fn(|k| a[k] - b[k]);
}

#[inline(always)]
fn idct_b4(d: &mut [V8; 4], m: &[f32]) {
    let mut lo = [d[0], d[2]];
    let mut hi = [d[1], d[3]];
    idct_b2(&mut lo, m);
    hi[1] = v_add(hi[1], hi[0]);
    hi[0] = core::array::from_fn(|k| hi[0][k] * SQRT2);
    idct_b2(&mut hi, m);
    for i in 0..2 {
        let mul = m[i];
        let (a, b) = (lo[i], hi[i]);
        d[i] = core::array::from_fn(|k| mul * b[k] + a[k]);
        d[3 - i] = core::array::from_fn(|k| a[k] - mul * b[k]);
    }
}

idct_bundle!(idct_b8, 8, 4, idct_b4);
idct_bundle!(idct_b16, 16, 8, idct_b8);
idct_bundle!(idct_b32, 32, 16, idct_b16);
idct_bundle!(idct_b64, 64, 32, idct_b32);
idct_bundle!(idct_b128, 128, 64, idct_b64);
idct_bundle!(idct_b256, 256, 128, idct_b128);

/// `idct_rows` for n ≥ 8 points and a lane count that is a multiple of 8.
fn idct_rows_bundled(d: &mut [f32], n: usize, l: usize) {
    macro_rules! run {
        ($f:ident, $n:expr) => {{
            let m = wc_multipliers($n);
            let mut b = [[0f32; 8]; $n];
            for l0 in (0..l).step_by(8) {
                for i in 0..$n {
                    b[i].copy_from_slice(&d[i * l + l0..i * l + l0 + 8]);
                }
                $f(&mut b, m);
                for i in 0..$n {
                    d[i * l + l0..i * l + l0 + 8].copy_from_slice(&b[i]);
                }
            }
        }};
    }
    match n {
        8 => run!(idct_b8, 8),
        16 => run!(idct_b16, 16),
        32 => run!(idct_b32, 32),
        64 => run!(idct_b64, 64),
        128 => run!(idct_b128, 128),
        _ => run!(idct_b256, 256),
    }
}

/// 8-point IDCT of the 8 columns of an 8×8 block (`d[i * 8 + lane]`), libjxl's factorisation.
#[inline(always)]
fn idct8_cols(d: &mut [f32; 64]) {
    let m4 = wc_multipliers(4);
    let m8 = wc_multipliers(8);
    let (m40, m41) = (m4[0], m4[1]);
    let (m80, m81, m82, m83) = (m8[0], m8[1], m8[2], m8[3]);
    for j in 0..8 {
        let x = [d[j], d[8 + j], d[16 + j], d[24 + j], d[32 + j], d[40 + j], d[48 + j], d[56 + j]];
        // Even half: IDCT4 of x0, x2, x4, x6.
        let (a0, a1, a2, a3) = (x[0], x[2], x[4], x[6]);
        let (e0, e1) = (a0 + a2, a0 - a2);
        let b1 = a1 * SQRT2;
        let b3 = a3 + a1;
        let (o0, o1) = (b1 + b3, b1 - b3);
        let ev = [m40 * o0 + e0, m41 * o1 + e1, e1 - m41 * o1, e0 - m40 * o0];
        // Odd half: B-transpose, then IDCT4.
        let q0 = x[1] * SQRT2;
        let q1 = x[3] + x[1];
        let q2 = x[5] + x[3];
        let q3 = x[7] + x[5];
        let (f0, f1) = (q0 + q2, q0 - q2);
        let g1 = q1 * SQRT2;
        let g3 = q3 + q1;
        let (h0, h1) = (g1 + g3, g1 - g3);
        let od = [m40 * h0 + f0, m41 * h1 + f1, f1 - m41 * h1, f0 - m40 * h0];
        let m = [m80, m81, m82, m83];
        for i in 0..4 {
            d[i * 8 + j] = m[i] * od[i] + ev[i];
            d[(7 - i) * 8 + j] = ev[i] - m[i] * od[i];
        }
    }
}

#[inline(always)]
fn transpose8(d: &mut [f32; 64]) {
    for y in 0..8 {
        for x in y + 1..8 {
            d.swap(y * 8 + x, x * 8 + y);
        }
    }
}

/// The 8×8 case of `idct2d`.
pub fn idct8x8(coef: &mut [f32], out: &mut [f32], stride: usize) {
    let mut b = [0f32; 64];
    b.copy_from_slice(&coef[..64]);
    idct8_cols(&mut b);
    transpose8(&mut b);
    idct8_cols(&mut b);
    for r in 0..8 {
        out[r * stride..r * stride + 8].copy_from_slice(&b[r * 8..r * 8 + 8]);
    }
}

/// Scaled 2-D IDCT of a `rows × cols` pixel block from coefficients in libjxl's layout
/// (`min × max`, first index along the smaller dimension; x first for square blocks).
/// `coef` is destroyed. Writes `rows` rows of `cols` pixels to `out` with `stride`.
pub fn idct2d(coef: &mut [f32], rows: usize, cols: usize, out: &mut [f32], stride: usize, scratch: &mut [f32]) {
    if rows == 8 && cols == 8 {
        return idct8x8(coef, out, stride);
    }
    let n = rows * cols;
    let (block, rest) = scratch.split_at_mut(n);
    let pass = |d: &mut [f32], pts: usize, lanes: usize, rest: &mut [f32]| {
        if pts >= 8 && lanes % 8 == 0 {
            idct_rows_bundled(d, pts, lanes);
        } else {
            idct_rows(d, pts, lanes, rest);
        }
    };
    if rows < cols {
        transpose(&coef[..n], rows, cols, block);
        pass(block, cols, rows, rest);
        transpose(block, cols, rows, &mut coef[..n]);
        pass(&mut coef[..n], rows, cols, rest);
    } else {
        pass(&mut coef[..n], cols, rows, rest);
        transpose(&coef[..n], cols, rows, block);
        coef[..n].copy_from_slice(block);
        pass(&mut coef[..n], rows, cols, rest);
    }
    for r in 0..rows {
        out[r * stride..r * stride + cols].copy_from_slice(&coef[r * cols..(r + 1) * cols]);
    }
}

/// Scaled 2-D DCT of a `rows × cols` block (row-major); the result is in coefficient layout
/// (`rows × cols` if rows < cols, else `cols × rows`).
pub fn dct2d(data: &mut [f32], rows: usize, cols: usize, scratch: &mut [f32]) {
    let n = rows * cols;
    let (block, rest) = scratch.split_at_mut(n);
    let sr = 1.0 / rows as f32;
    let sc = 1.0 / cols as f32;
    dct_rows(&mut data[..n], rows, cols, rest);
    for v in data[..n].iter_mut() {
        *v *= sr;
    }
    transpose(&data[..n], rows, cols, block);
    dct_rows(block, cols, rows, rest);
    for v in block.iter_mut() {
        *v *= sc;
    }
    if rows < cols {
        transpose(block, cols, rows, &mut data[..n]);
    } else {
        data[..n].copy_from_slice(block);
    }
}

/// Upsampling scale for the lowest-frequency coefficients of an `n`-block dimension
/// (libjxl's DCTResampleScales<n, 8n>): 1 / (cos(iπ/16n) cos(iπ/8n) cos(iπ/4n)).
fn resample_scale(n: usize, i: usize) -> f32 {
    let nn = (8 * n) as f64;
    let i = i as f64;
    let pi = std::f64::consts::PI;
    let v = (i / (2.0 * nn) * pi).cos() * (i / nn * pi).cos() * (i / (nn / 2.0) * pi).cos();
    (1.0 / v) as f32
}

/// The lowest frequencies of a multi-block transform, computed from the LF (DC) samples of
/// the blocks it covers (`dc[y * dc_stride + x]`), into `llf` (stride = coefficient row
/// length).
pub fn llf_from_dc(acs: AcStrategy, dc: &[f32], dc_stride: usize, llf: &mut [f32], scratch: &mut [f32]) {
    let cy = acs.covered_y();
    let cx = acs.covered_x();
    if !acs.is_multiblock() {
        llf[0] = dc[0];
        return;
    }
    let stride = cx.max(cy) * 8;
    let (block, rest) = scratch.split_at_mut(cx * cy);
    for y in 0..cy {
        for x in 0..cx {
            block[y * cx + x] = dc[y * dc_stride + x];
        }
    }
    dct2d(block, cy, cx, rest);
    if cy < cx {
        for y in 0..cy {
            for x in 0..cx {
                llf[y * stride + x] = block[y * cx + x] * resample_scale(cy, y) * resample_scale(cx, x);
            }
        }
    } else {
        for y in 0..cx {
            for x in 0..cy {
                llf[y * stride + x] = block[y * cy + x] * resample_scale(cx, y) * resample_scale(cy, x);
            }
        }
    }
}

pub const AFV_BASIS: [[f32; 16]; 16] = [
    [0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25],
    [0.876902929799142, 0.2206518106944235, -0.10140050393753763, -0.1014005039375375, 0.2206518106944236, -0.10140050393753777, -0.10140050393753772, -0.10140050393753763, -0.10140050393753758, -0.10140050393753769, -0.1014005039375375, -0.10140050393753768, -0.10140050393753768, -0.10140050393753759, -0.10140050393753763, -0.10140050393753741],
    [0.0, 0.0, 0.40670075830260755, 0.44444816619734445, 0.0, 0.0, 0.19574399372042936, 0.2929100136981264, -0.40670075830260716, -0.19574399372042872, 0.0, 0.11379074460448091, -0.44444816619734384, -0.29291001369812636, -0.1137907446044814, 0.0],
    [0.0, 0.0, -0.21255748058288748, 0.3085497062849767, 0.0, 0.4706702258572536, -0.1621205195722993, 0.0, -0.21255748058287047, -0.16212051957228327, -0.47067022585725277, -0.1464291867126764, 0.3085497062849487, 0.0, -0.14642918671266536, 0.4251149611657548],
    [0.0, -0.7071067811865474, 0.0, 0.0, 0.7071067811865476, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    [-0.4105377591765233, 0.6235485373547691, -0.06435071657946274, -0.06435071657946266, 0.6235485373547694, -0.06435071657946284, -0.0643507165794628, -0.06435071657946274, -0.06435071657946272, -0.06435071657946279, -0.06435071657946266, -0.06435071657946277, -0.06435071657946277, -0.06435071657946273, -0.06435071657946274, -0.0643507165794626],
    [0.0, 0.0, -0.4517556589999482, 0.15854503551840063, 0.0, -0.04038515160822202, 0.0074182263792423875, 0.39351034269210167, -0.45175565899994635, 0.007418226379244351, 0.1107416575309343, 0.08298163094882051, 0.15854503551839705, 0.3935103426921022, 0.0829816309488214, -0.45175565899994796],
    [0.0, 0.0, -0.304684750724869, 0.5112616136591823, 0.0, 0.0, -0.290480129728998, -0.06578701549142804, 0.304684750724884, 0.2904801297290076, 0.0, -0.23889773523344604, -0.5112616136592012, 0.06578701549142545, 0.23889773523345467, 0.0],
    [0.0, 0.0, 0.3017929516615495, 0.25792362796341184, 0.0, 0.16272340142866204, 0.09520022653475037, 0.0, 0.3017929516615503, 0.09520022653475055, -0.16272340142866173, -0.35312385449816297, 0.25792362796341295, 0.0, -0.3531238544981624, -0.6035859033230976],
    [0.0, 0.0, 0.40824829046386274, 0.0, 0.0, 0.0, 0.0, -0.4082482904638628, -0.4082482904638635, 0.0, 0.0, -0.40824829046386296, 0.0, 0.4082482904638634, 0.408248290463863, 0.0],
    [0.0, 0.0, 0.1747866975480809, 0.0812611176717539, 0.0, 0.0, -0.3675398009862027, -0.307882213957909, -0.17478669754808135, 0.3675398009862011, 0.0, 0.4826689115059883, -0.08126111767175039, 0.30788221395790305, -0.48266891150598584, 0.0],
    [0.0, 0.0, -0.21105601049335784, 0.18567180916109802, 0.0, 0.0, 0.49215859013738733, -0.38525013709251915, 0.21105601049335806, -0.49215859013738905, 0.0, 0.17419412659916217, -0.18567180916109904, 0.3852501370925211, -0.1741941265991621, 0.0],
    [0.0, 0.0, -0.14266084808807264, -0.3416446842253372, 0.0, 0.7367497537172237, 0.24627107722075148, -0.08574019035519306, -0.14266084808807344, 0.24627107722075137, 0.14883399227113567, -0.04768680350229251, -0.3416446842253373, -0.08574019035519267, -0.047686803502292804, -0.14266084808807242],
    [0.0, 0.0, -0.13813540350758585, 0.3302282550303788, 0.0, 0.08755115000587084, -0.07946706605909573, -0.4613374887461511, -0.13813540350758294, -0.07946706605910261, 0.49724647109535086, 0.12538059448563663, 0.3302282550303805, -0.4613374887461554, 0.12538059448564315, -0.13813540350758452],
    [0.0, 0.0, -0.17437602599651067, 0.0702790691196284, 0.0, -0.2921026642334881, 0.3623817333531167, 0.0, -0.1743760259965108, 0.36238173335311646, 0.29210266423348785, -0.4326608024727445, 0.07027906911962818, 0.0, -0.4326608024727457, 0.34875205199302267],
    [0.0, 0.0, 0.11354987314994337, -0.07417504595810355, 0.0, 0.19402893032594343, -0.435190496523228, 0.21918684838857466, 0.11354987314994257, -0.4351904965232251, 0.5550443808910661, -0.25468277124066463, -0.07417504595810233, 0.2191868483885728, -0.25468277124066413, 0.1135498731499429],
];

fn afv_idct4x4(coeffs: &[f32; 16], pixels: &mut [f32; 16]) {
    for (i, p) in pixels.iter_mut().enumerate() {
        let mut v = 0.0f32;
        for j in 0..16 {
            v += coeffs[j] * AFV_BASIS[j][i];
        }
        *p = v;
    }
}

fn afv_to_pixels(kind: usize, c: &[f32], out: &mut [f32], stride: usize, scratch: &mut [f32]) {
    let afv_x = kind & 1;
    let afv_y = kind / 2;
    let (b00, b01, b10) = (c[0], c[1], c[8]);
    let dcs = [(b00 + b10 + b01) * 4.0, b00 + b10 - b01, b00 - b10];
    let mut coeff = [0f32; 16];
    coeff[0] = dcs[0];
    for iy in 0..4 {
        for ix in 0..4 {
            if ix == 0 && iy == 0 {
                continue;
            }
            coeff[iy * 4 + ix] = c[iy * 2 * 8 + ix * 2];
        }
    }
    let mut px = [0f32; 16];
    afv_idct4x4(&coeff, &mut px);
    for iy in 0..4 {
        for ix in 0..4 {
            let sy = if afv_y == 1 { 3 - iy } else { iy };
            let sx = if afv_x == 1 { 3 - ix } else { ix };
            out[(iy + afv_y * 4) * stride + afv_x * 4 + ix] = px[sy * 4 + sx];
        }
    }
    let mut block = [0f32; 32];
    block[0] = dcs[1];
    for iy in 0..4 {
        for ix in 0..4 {
            if ix == 0 && iy == 0 {
                continue;
            }
            block[iy * 4 + ix] = c[iy * 2 * 8 + ix * 2 + 1];
        }
    }
    let o = afv_y * 4 * stride + if afv_x == 1 { 0 } else { 4 };
    idct2d(&mut block[..16], 4, 4, &mut out[o..], stride, scratch);
    block[0] = dcs[2];
    for iy in 0..4 {
        for ix in 0..8 {
            if ix == 0 && iy == 0 {
                continue;
            }
            block[iy * 8 + ix] = c[(1 + iy * 2) * 8 + ix];
        }
    }
    let o = if afv_y == 1 { 0 } else { 4 } * stride;
    idct2d(&mut block, 4, 8, &mut out[o..], stride, scratch);
}

fn idct2_top_block(s: usize, block: &mut [f32; 64]) {
    let mut temp = [0f32; 64];
    let h = s / 2;
    for y in 0..h {
        for x in 0..h {
            let c00 = block[y * 8 + x];
            let c01 = block[y * 8 + h + x];
            let c10 = block[(y + h) * 8 + x];
            let c11 = block[(y + h) * 8 + h + x];
            temp[y * 2 * 8 + x * 2] = c00 + c01 + c10 + c11;
            temp[y * 2 * 8 + x * 2 + 1] = c00 + c01 - c10 - c11;
            temp[(y * 2 + 1) * 8 + x * 2] = c00 - c01 + c10 - c11;
            temp[(y * 2 + 1) * 8 + x * 2 + 1] = c00 - c01 - c10 + c11;
        }
    }
    for y in 0..s {
        block[y * 8..y * 8 + s].copy_from_slice(&temp[y * 8..y * 8 + s]);
    }
}

/// Inverse transform of one block's coefficients (destroyed) into pixels at `out`.
pub fn transform_to_pixels(acs: AcStrategy, c: &mut [f32], out: &mut [f32], stride: usize, scratch: &mut [f32]) {
    use super::acs::Kind;
    match acs.kind() {
        Kind::Identity => {
            let (b00, b01, b10, b11) = (c[0], c[1], c[8], c[9]);
            let dcs = [b00 + b01 + b10 + b11, b00 + b01 - b10 - b11, b00 - b01 + b10 - b11, b00 - b01 - b10 + b11];
            for y in 0..2 {
                for x in 0..2 {
                    let block_dc = dcs[y * 2 + x];
                    let mut residual_sum = 0f32;
                    for iy in 0..4 {
                        for ix in 0..4 {
                            if ix == 0 && iy == 0 {
                                continue;
                            }
                            residual_sum += c[(y + iy * 2) * 8 + x + ix * 2];
                        }
                    }
                    let center = block_dc - residual_sum * (1.0 / 16.0);
                    out[(4 * y + 1) * stride + 4 * x + 1] = center;
                    for iy in 0..4 {
                        for ix in 0..4 {
                            if ix == 1 && iy == 1 {
                                continue;
                            }
                            out[(y * 4 + iy) * stride + x * 4 + ix] = c[(y + iy * 2) * 8 + x + ix * 2] + center;
                        }
                    }
                    out[y * 4 * stride + x * 4] = c[(y + 2) * 8 + x + 2] + center;
                }
            }
        }
        Kind::Dct8x4 => {
            let dcs = [c[0] + c[8], c[0] - c[8]];
            for x in 0..2 {
                let mut block = [0f32; 32];
                block[0] = dcs[x];
                for iy in 0..4 {
                    for ix in 0..8 {
                        if ix == 0 && iy == 0 {
                            continue;
                        }
                        block[iy * 8 + ix] = c[(x + iy * 2) * 8 + ix];
                    }
                }
                idct2d(&mut block, 8, 4, &mut out[x * 4..], stride, scratch);
            }
        }
        Kind::Dct4x8 => {
            let dcs = [c[0] + c[8], c[0] - c[8]];
            for y in 0..2 {
                let mut block = [0f32; 32];
                block[0] = dcs[y];
                for iy in 0..4 {
                    for ix in 0..8 {
                        if ix == 0 && iy == 0 {
                            continue;
                        }
                        block[iy * 8 + ix] = c[(y + iy * 2) * 8 + ix];
                    }
                }
                idct2d(&mut block, 4, 8, &mut out[y * 4 * stride..], stride, scratch);
            }
        }
        Kind::Dct4x4 => {
            let (b00, b01, b10, b11) = (c[0], c[1], c[8], c[9]);
            let dcs = [b00 + b01 + b10 + b11, b00 + b01 - b10 - b11, b00 - b01 + b10 - b11, b00 - b01 - b10 + b11];
            for y in 0..2 {
                for x in 0..2 {
                    let mut block = [0f32; 16];
                    block[0] = dcs[y * 2 + x];
                    for iy in 0..4 {
                        for ix in 0..4 {
                            if ix == 0 && iy == 0 {
                                continue;
                            }
                            block[iy * 4 + ix] = c[(y + iy * 2) * 8 + x + ix * 2];
                        }
                    }
                    idct2d(&mut block, 4, 4, &mut out[y * 4 * stride + x * 4..], stride, scratch);
                }
            }
        }
        Kind::Dct2x2 => {
            let mut b = [0f32; 64];
            b.copy_from_slice(&c[..64]);
            idct2_top_block(2, &mut b);
            idct2_top_block(4, &mut b);
            idct2_top_block(8, &mut b);
            for y in 0..8 {
                out[y * stride..y * stride + 8].copy_from_slice(&b[y * 8..y * 8 + 8]);
            }
        }
        Kind::Afv(k) => afv_to_pixels(k as usize, c, out, stride, scratch),
        Kind::Dct => {
            let rows = acs.covered_y() * 8;
            let cols = acs.covered_x() * 8;
            idct2d(c, rows, cols, out, stride, scratch);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn naive_idct(coef: &[f32], n: usize) -> Vec<f32> {
        // out[x] = c0 + sum_k sqrt2 * ck * cos((2x+1) k pi / 2n)
        (0..n)
            .map(|x| {
                let mut v = coef[0] as f64;
                for k in 1..n {
                    v += coef[k] as f64 * 2f64.sqrt() * (((2 * x + 1) * k) as f64 * std::f64::consts::PI / (2 * n) as f64).cos();
                }
                v as f32
            })
            .collect()
    }

    #[test]
    fn idct_matches_definition() {
        for n in [2usize, 4, 8, 16, 32, 64, 128, 256] {
            let coef: Vec<f32> = (0..n).map(|i| ((i * 37 % 11) as f32 - 5.0) / (1 + i) as f32).collect();
            let mut d = coef.clone();
            let mut s = vec![0f32; 4 * n];
            idct_rows(&mut d, n, 1, &mut s);
            let want = naive_idct(&coef, n);
            for (a, b) in d.iter().zip(want.iter()) {
                assert!((a - b).abs() < 1e-3, "n={n} {a} {b}");
            }
        }
    }

    #[test]
    fn idct8x8_matches_generic() {
        let coef: Vec<f32> = (0..64).map(|i| ((i * 29 % 17) as f32 - 8.0) / (1 + i % 9) as f32).collect();
        let mut a = coef.clone();
        let mut out_fast = vec![0f32; 64];
        idct8x8(&mut a, &mut out_fast, 8);
        // Generic path: columns, transpose, columns.
        let mut g = coef.clone();
        let mut s = vec![0f32; 256];
        idct_rows(&mut g, 8, 8, &mut s);
        let mut t = vec![0f32; 64];
        transpose(&g, 8, 8, &mut t);
        idct_rows(&mut t, 8, 8, &mut s);
        for (x, y) in out_fast.iter().zip(t.iter()) {
            assert_eq!(x, y);
        }
    }

    #[test]
    fn bundled_matches_generic() {
        for &(n, l) in &[(8usize, 8usize), (16, 8), (32, 16), (64, 32), (128, 8), (256, 16)] {
            let data: Vec<f32> = (0..n * l).map(|i| ((i * 31 % 23) as f32 - 11.0) / (1 + i % 7) as f32).collect();
            let mut a = data.clone();
            let mut b = data.clone();
            let mut s = vec![0f32; 4 * n * l];
            idct_rows(&mut a, n, l, &mut s);
            idct_rows_bundled(&mut b, n, l);
            assert_eq!(a, b, "n={n} l={l}");
        }
    }

    #[test]
    fn dct_inverts_idct() {
        for n in [2usize, 4, 8, 16, 32] {
            let px: Vec<f32> = (0..n).map(|i| (i as f32 * 0.7).sin()).collect();
            let mut d = px.clone();
            let mut s = vec![0f32; 4 * n];
            dct_rows(&mut d, n, 1, &mut s);
            for v in d.iter_mut() {
                *v /= n as f32;
            }
            idct_rows(&mut d, n, 1, &mut s);
            for (a, b) in d.iter().zip(px.iter()) {
                assert!((a - b).abs() < 1e-4, "n={n}");
            }
        }
    }
}
