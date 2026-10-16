//! Primaries and white-point matrices for XYB output to a non-sRGB colour space, ported from
//! libjxl (lib/jxl/cms/jxl_cms_internal.h, lib/jxl/base/matrix_ops.h) with the same f32/f64
//! mix, so the results agree with libjxl's to rounding.

use crate::error::{Error, Result};
use crate::headers::{Primaries, WhitePoint};

pub type M3 = [[f32; 3]; 3];
type Xy = (f32, f32);

/// libjxl's sRGB primaries (more digits than the BT.709 values).
pub const SRGB_PRIMARIES: [Xy; 3] = [(0.639998686, 0.330010138), (0.300003784, 0.600003357), (0.150002046, 0.059997204)];
pub const D65: Xy = (0.3127, 0.3290);

pub fn primaries_xy(p: Primaries) -> [Xy; 3] {
    match p {
        Primaries::Srgb => SRGB_PRIMARIES,
        Primaries::Bt2100 => [(0.708, 0.292), (0.170, 0.797), (0.131, 0.046)],
        Primaries::P3 => [(0.680, 0.320), (0.265, 0.690), (0.150, 0.060)],
        Primaries::Custom(c) => c.map(|(x, y)| (x as f32, y as f32)),
    }
}

pub fn white_point_xy(w: WhitePoint) -> Xy {
    match w {
        WhitePoint::D65 => D65,
        WhitePoint::Dci => (0.314, 0.351),
        WhitePoint::E => ((1.0f64 / 3.0) as f32, (1.0f64 / 3.0) as f32),
        WhitePoint::Custom(x, y) => (x as f32, y as f32),
    }
}

pub fn mul3(a: &M3, b: &M3) -> M3 {
    let mut c = [[0f32; 3]; 3];
    for x in 0..3 {
        let t = [f64::from(b[0][x]), f64::from(b[1][x]), f64::from(b[2][x])];
        for y in 0..3 {
            c[y][x] = (f64::from(a[y][0]) * t[0] + f64::from(a[y][1]) * t[1] + f64::from(a[y][2]) * t[2]) as f32;
        }
    }
    c
}

fn mul3v(a: &M3, b: [f32; 3]) -> [f32; 3] {
    let mut c = [0f32; 3];
    for y in 0..3 {
        let mut e = 0f64;
        for x in 0..3 {
            e += f64::from(a[y][x]) * f64::from(b[x]);
        }
        c[y] = e as f32;
    }
    c
}

pub fn inv3(m: &M3) -> Result<M3> {
    let d = |j: usize, i: usize| f64::from(m[j][i]);
    let t = [
        [d(1, 1) * d(2, 2) - d(1, 2) * d(2, 1), d(0, 2) * d(2, 1) - d(0, 1) * d(2, 2), d(0, 1) * d(1, 2) - d(0, 2) * d(1, 1)],
        [d(1, 2) * d(2, 0) - d(1, 0) * d(2, 2), d(0, 0) * d(2, 2) - d(0, 2) * d(2, 0), d(0, 2) * d(1, 0) - d(0, 0) * d(1, 2)],
        [d(1, 0) * d(2, 1) - d(1, 1) * d(2, 0), d(0, 1) * d(2, 0) - d(0, 0) * d(2, 1), d(0, 0) * d(1, 1) - d(0, 1) * d(1, 0)],
    ];
    let det = d(0, 0) * t[0][0] + d(0, 1) * t[1][0] + d(0, 2) * t[2][0];
    if det.abs() < 1e-10 {
        return Err(Error::Invalid("colour primaries give a singular matrix"));
    }
    let idet = 1.0 / det;
    Ok(t.map(|r| r.map(|v| (v * idet) as f32)))
}

fn white_xyz((wx, wy): Xy) -> Result<[f32; 3]> {
    if !(0.0..=1.0).contains(&wx) || !(wy > 0.0 && wy <= 1.0) {
        return Err(Error::Invalid("white point"));
    }
    let w = [wx / wy, 1.0, (1.0 - wx - wy) / wy];
    if !w[0].is_finite() || !w[2].is_finite() {
        return Err(Error::Invalid("white point"));
    }
    Ok(w)
}

pub fn primaries_to_xyz(p: [Xy; 3], w: Xy) -> Result<M3> {
    let w = white_xyz(w)?;
    let [(rx, ry), (gx, gy), (bx, by)] = p;
    let prim: M3 = [[rx, gx, bx], [ry, gy, by], [1.0 - rx - ry, 1.0 - gx - gy, 1.0 - bx - by]];
    let xyz = mul3v(&inv3(&prim)?, w);
    let a: M3 = [[xyz[0], 0.0, 0.0], [0.0, xyz[1], 0.0], [0.0, 0.0, xyz[2]]];
    Ok(mul3(&prim, &a))
}

const BRADFORD: M3 = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
const BRADFORD_INV: M3 = [[0.9869929, -0.1470543, 0.1599627], [0.4323053, 0.5183603, 0.0492912], [-0.0085287, 0.0400428, 0.9684867]];

pub fn adapt_to_xyz_d50(w: Xy) -> Result<M3> {
    let w = white_xyz(w)?;
    let lms = mul3v(&BRADFORD, w);
    let lms50 = mul3v(&BRADFORD, [0.96422, 1.0, 0.82521]);
    if lms.contains(&0.0) {
        return Err(Error::Invalid("white point"));
    }
    let a: M3 = [[lms50[0] / lms[0], 0.0, 0.0], [0.0, lms50[1] / lms[1], 0.0], [0.0, 0.0, lms50[2] / lms[2]]];
    if !(a[0][0].is_finite() && a[1][1].is_finite() && a[2][2].is_finite()) {
        return Err(Error::Invalid("white point"));
    }
    Ok(mul3(&BRADFORD_INV, &mul3(&a, &BRADFORD)))
}

pub fn primaries_to_xyz_d50(p: [Xy; 3], w: Xy) -> Result<M3> {
    Ok(mul3(&adapt_to_xyz_d50(w)?, &primaries_to_xyz(p, w)?))
}
