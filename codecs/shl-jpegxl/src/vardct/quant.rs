//! Dequantisation matrices (ISO/IEC 18181-1 I.2.4): the default library, their bitstream
//! encodings and the weight computation (as libjxl's quant_weights.cc).

use crate::bits::BitReader;
use crate::error::{invalid, Error, Result};

pub const NUM_TABLES: usize = 17;
/// Size of each table in 8×8 blocks (x is never above y).
pub const SIZE_X: [usize; NUM_TABLES] = [1, 1, 1, 1, 2, 4, 1, 1, 2, 1, 1, 8, 4, 16, 8, 32, 16];
pub const SIZE_Y: [usize; NUM_TABLES] = [1, 1, 1, 1, 2, 4, 2, 4, 4, 1, 1, 8, 8, 16, 16, 32, 32];
const ALMOST_ZERO: f32 = 1e-8;

#[derive(Clone, Debug)]
pub struct DctParams {
    pub bands: [[f32; 17]; 3],
    pub num: usize,
}

impl DctParams {
    fn new(b: [&[f64]; 3]) -> Self {
        let mut bands = [[0f32; 17]; 3];
        for c in 0..3 {
            for (i, &v) in b[c].iter().enumerate() {
                bands[c][i] = v as f32;
            }
        }
        DctParams { bands, num: b[0].len() }
    }
}

#[derive(Clone, Debug)]
pub enum Encoding {
    Library,
    Identity([[f32; 3]; 3]),
    Dct2([[f32; 6]; 3]),
    Dct4(DctParams, [[f32; 2]; 3]),
    Dct4x8(DctParams, [f32; 3]),
    Afv(DctParams, DctParams, [[f32; 9]; 3]),
    Dct(DctParams),
    Raw(f32, Vec<i32>),
}

fn library(table: usize) -> Encoding {
    let d4x8 = || DctParams::new([&[2198.050556016380522, -0.96269623020744692, -0.76194253026666783, -0.6551140670773547], &[764.3655248643528689, -0.92630200888366945, -0.9675229603596517, -0.27845290869168118], &[527.107573587542228, -1.4594385811273854, -1.450082094097871593, -1.5843722511996204]]);
    let d4x4 = || DctParams::new([&[2200.0, 0.0, 0.0, 0.0], &[392.0, 0.0, 0.0, 0.0], &[112.0, -0.25, -0.25, -0.5]]);
    let big = |a: f64, b: f64, c: f64| {
        DctParams::new([
            &[a, -1.025, -0.78, -0.65012, -0.19041574084286472, -0.20819395464, -0.421064, -0.32733845535848671],
            &[b, -0.3041958212306401, -0.3633036457487539, -0.35660379990111464, -0.3443074455424403, -0.33699592683512467, -0.30180866526242109, -0.27321683125358037],
            &[c, -1.2, -1.2, -0.8, -0.7, -0.7, -0.4, -0.5],
        ])
    };
    match table {
        0 => Encoding::Dct(DctParams::new([&[3150.0, 0.0, -0.4, -0.4, -0.4, -2.0], &[560.0, 0.0, -0.3, -0.3, -0.3, -0.3], &[512.0, -2.0, -1.0, 0.0, -1.0, -2.0]])),
        1 => Encoding::Identity([[280.0, 3160.0, 3160.0], [60.0, 864.0, 864.0], [18.0, 200.0, 200.0]]),
        2 => Encoding::Dct2([[3840.0, 2560.0, 1280.0, 640.0, 480.0, 300.0], [960.0, 640.0, 320.0, 180.0, 140.0, 120.0], [640.0, 320.0, 128.0, 64.0, 32.0, 16.0]]),
        3 => Encoding::Dct4(d4x4(), [[1.0, 1.0]; 3]),
        4 => Encoding::Dct(DctParams::new([
            &[8996.8725711814115328, -1.3000777393353804, -0.49424529824571225, -0.439093774457103443, -0.6350101832695744, -0.90177264050827612, -1.6162099239887414],
            &[3191.48366296844234752, -0.67424582104194355, -0.80745813428471001, -0.44925837484843441, -0.35865440981033403, -0.31322389111877305, -0.37615025315725483],
            &[1157.50408145487200256, -2.0531423165804414, -1.4, -0.50687130033378396, -0.42708730624733904, -1.4856834539296244, -4.9209142884401604],
        ])),
        5 => Encoding::Dct(DctParams::new([
            &[15718.40830982518931456, -1.025, -0.98, -0.9012, -0.4, -0.48819395464, -0.421064, -0.27],
            &[7305.7636810695983104, -0.8041958212306401, -0.7633036457487539, -0.55660379990111464, -0.49785304658857626, -0.43699592683512467, -0.40180866526242109, -0.27321683125358037],
            &[3803.53173721215041536, -3.060733579805728, -2.0413270132490346, -2.0235650159727417, -0.5495389509954993, -0.4, -0.4, -0.3],
        ])),
        6 => Encoding::Dct(DctParams::new([
            &[7240.7734393502, -0.7, -0.7, -0.2, -0.2, -0.2, -0.5],
            &[1448.15468787004, -0.5, -0.5, -0.5, -0.2, -0.2, -0.2],
            &[506.854140754517, -1.4, -0.2, -0.5, -0.5, -1.5, -3.6],
        ])),
        7 => Encoding::Dct(DctParams::new([
            &[16283.2494710648897, -1.7812845336559429, -1.6309059012653515, -1.0382179034313539, -0.85, -0.7, -0.9, -1.2360638576849587],
            &[5089.15750884921511936, -0.320049391452786891, -0.35362849922161446, -0.30340000000000003, -0.61, -0.5, -0.5, -0.6],
            &[3397.77603275308720128, -0.321327362693153371, -0.34507619223117997, -0.70340000000000003, -0.9, -1.0, -1.0, -1.1754605576265209],
        ])),
        8 => Encoding::Dct(DctParams::new([
            &[13844.97076442300573, -0.97113799999999995, -0.658, -0.42026, -0.22712, -0.2206, -0.226, -0.6],
            &[4798.964084220744293, -0.61125308982767057, -0.83770786552491361, -0.79014862079498627, -0.2692727459704829, -0.38272769465388551, -0.22924222653091453, -0.20719098826199578],
            &[1807.236946760964614, -1.2, -1.2, -0.7, -0.7, -0.7, -0.4, -0.5],
        ])),
        9 => Encoding::Dct4x8(d4x8(), [1.0, 1.0, 1.0]),
        10 => Encoding::Afv(
            d4x8(),
            d4x4(),
            [
                [3072.0, 3072.0, 256.0, 256.0, 256.0, 414.0, 0.0, 0.0, 0.0],
                [1024.0, 1024.0, 50.0, 50.0, 50.0, 58.0, 0.0, 0.0, 0.0],
                [384.0, 384.0, 12.0, 12.0, 12.0, 22.0, -0.25, -0.25, -0.25],
            ],
        ),
        11 => Encoding::Dct(big(0.9 * 26629.073922049845, 0.9 * 9311.3238710010046, 0.9 * 4992.2486445538634)),
        12 => Encoding::Dct(big(0.65 * 23629.073922049845, 0.65 * 8611.3238710010046, 0.65 * 4492.2486445538634)),
        13 => Encoding::Dct(big(1.8 * 26629.073922049845, 1.8 * 9311.3238710010046, 1.8 * 4992.2486445538634)),
        14 => Encoding::Dct(big(1.3 * 23629.073922049845, 1.3 * 8611.3238710010046, 1.3 * 4492.2486445538634)),
        15 => Encoding::Dct(big(3.6 * 26629.073922049845, 3.6 * 9311.3238710010046, 3.6 * 4992.2486445538634)),
        _ => Encoding::Dct(big(2.6 * 23629.073922049845, 2.6 * 8611.3238710010046, 2.6 * 4492.2486445538634)),
    }
}

fn read_dct_params(br: &mut BitReader) -> Result<DctParams> {
    let num = br.read(4) as usize + 1;
    let mut p = DctParams { bands: [[0.0; 17]; 3], num };
    for c in 0..3 {
        for i in 0..num {
            p.bands[c][i] = br.f16()?;
        }
        if p.bands[c][0] < ALMOST_ZERO {
            return invalid("distance band seed too small");
        }
        p.bands[c][0] *= 64.0;
    }
    Ok(p)
}

/// Reads one table's encoding. `raw` decodes a RAW (modular-coded) table of the given size.
pub fn read_encoding(
    br: &mut BitReader,
    table: usize,
    raw: &mut dyn FnMut(&mut BitReader, usize, usize) -> Result<Vec<i32>>,
) -> Result<Encoding> {
    let required = SIZE_X[table] * SIZE_Y[table];
    let mode = br.read(3);
    let need1 = |m| if required != 1 { invalid(m) } else { Ok(()) };
    Ok(match mode {
        0 => Encoding::Library,
        1 => {
            need1("identity table size")?;
            let mut w = [[0f32; 3]; 3];
            for row in w.iter_mut() {
                for v in row.iter_mut() {
                    *v = br.f16()?;
                    if v.abs() < ALMOST_ZERO {
                        return invalid("identity quantiser too small");
                    }
                    *v *= 64.0;
                }
            }
            Encoding::Identity(w)
        }
        2 => {
            need1("DCT2 table size")?;
            let mut w = [[0f32; 6]; 3];
            for row in w.iter_mut() {
                for v in row.iter_mut() {
                    *v = br.f16()?;
                    if v.abs() < ALMOST_ZERO {
                        return invalid("DCT2 quantiser too small");
                    }
                    *v *= 64.0;
                }
            }
            Encoding::Dct2(w)
        }
        3 => {
            need1("DCT4 table size")?;
            let mut m = [[0f32; 2]; 3];
            for row in m.iter_mut() {
                for v in row.iter_mut() {
                    *v = br.f16()?;
                    if v.abs() < ALMOST_ZERO {
                        return invalid("DCT4 multiplier too small");
                    }
                }
            }
            Encoding::Dct4(read_dct_params(br)?, m)
        }
        4 => {
            need1("DCT4x8 table size")?;
            let mut m = [0f32; 3];
            for v in m.iter_mut() {
                *v = br.f16()?;
                if v.abs() < ALMOST_ZERO {
                    return invalid("DCT4x8 multiplier too small");
                }
            }
            Encoding::Dct4x8(read_dct_params(br)?, m)
        }
        5 => {
            need1("AFV table size")?;
            let mut w = [[0f32; 9]; 3];
            for row in w.iter_mut() {
                for v in row.iter_mut() {
                    *v = br.f16()?;
                }
                for v in row.iter_mut().take(6) {
                    *v *= 64.0;
                }
            }
            let a = read_dct_params(br)?;
            let b = read_dct_params(br)?;
            Encoding::Afv(a, b, w)
        }
        6 => Encoding::Dct(read_dct_params(br)?),
        _ => {
            let den = br.f16()?;
            if den < ALMOST_ZERO {
                return invalid("raw quantisation table denominator");
            }
            let t = raw(br, SIZE_X[table] * 8, SIZE_Y[table] * 8)?;
            if t.iter().any(|&v| v <= 0) {
                return invalid("raw quantisation table entry");
            }
            Encoding::Raw(den, t)
        }
    })
}

// ---- libjxl's fast approximations, used for the band interpolation ----

#[allow(clippy::excessive_precision)]
fn fast_log2f(x: f32) -> f32 {
    let p = [-1.8503833400518310E-06f32, 1.4287160470083755E+00, 7.4245873327820566E-01];
    let q = [9.9032814277590719E-01f32, 1.0096718572241148E+00, 1.7409343003366853E-01];
    let bits = x.to_bits() as i32;
    let exp_bits = bits.wrapping_sub(0x3f2a_aaab);
    let exp_shifted = exp_bits >> 23;
    let mantissa = f32::from_bits(bits.wrapping_sub(exp_shifted << 23) as u32);
    let exp_val = exp_shifted as f32;
    let m = mantissa - 1.0;
    let yp = (p[2] * m + p[1]) * m + p[0];
    let yq = (q[2] * m + q[1]) * m + q[0];
    yp / yq + exp_val
}

#[allow(clippy::excessive_precision)]
fn fast_pow2f(x: f32) -> f32 {
    let floorx = x.floor();
    let exp = f32::from_bits(((floorx as i32).wrapping_add(127) << 23) as u32);
    let frac = x - floorx;
    let mut num = frac + 1.01749063e+01;
    num = num * frac + 4.88687798e+01;
    num = num * frac + 9.85506591e+01;
    num *= exp;
    let mut den = frac * 2.10242958e-01 + -2.22328856e-02;
    den = den * frac + -1.94414990e+01;
    den = den * frac + 9.85506633e+01;
    num / den
}

fn fast_powf(b: f32, e: f32) -> f32 {
    fast_pow2f(fast_log2f(b) * e)
}

fn mult(v: f32) -> f32 {
    if v > 0.0 {
        1.0 + v
    } else {
        1.0 / (1.0 - v)
    }
}

fn interpolate(pos: f32, max: f32, array: &[f32]) -> Result<f32> {
    let len = array.len();
    let scaled = pos * (len - 1) as f32 / max;
    let idx = scaled as usize;
    if idx + 1 >= len {
        return invalid("quantisation band interpolation");
    }
    let a = array[idx];
    let b = array[idx + 1];
    Ok(a * fast_powf(b / a, scaled - idx as f32))
}

/// Weights for a rows × cols table from distance bands; `out[c * rows * cols + y * cols + x]`.
fn quant_weights(rows: usize, cols: usize, p: &DctParams, out: &mut [f32]) -> Result<()> {
    let n = p.num;
    for c in 0..3 {
        let mut bands = [0f32; 17];
        bands[0] = p.bands[c][0];
        if bands[0] < ALMOST_ZERO {
            return invalid("distance bands");
        }
        for i in 1..n {
            bands[i] = bands[i - 1] * mult(p.bands[c][i]);
            if bands[i] < ALMOST_ZERO {
                return invalid("distance bands");
            }
        }
        let scale = (n - 1) as f32 / (std::f32::consts::SQRT_2 + 1e-6);
        let rcpcol = scale / (cols - 1) as f32;
        let rcprow = scale / (rows - 1) as f32;
        for y in 0..rows {
            let dy = y as f32 * rcprow;
            let dy2 = dy * dy;
            for x in 0..cols {
                let dx = x as f32 * rcpcol;
                let d = (dx * dx + dy2).sqrt();
                let w = if n == 1 {
                    bands[0]
                } else {
                    // libjxl's InterpolateVec: no bounds check; distances stay below n - 1.
                    let idx = (d as i32).clamp(0, n as i32 - 2) as usize;
                    let frac = d - idx as f32;
                    let a = bands[idx];
                    let b = bands[idx + 1];
                    a * fast_powf(b / a, frac)
                };
                out[c * rows * cols + y * cols + x] = w;
            }
        }
    }
    Ok(())
}

/// Dequantisation multipliers for one table: 3 channels × (8·SIZE_X × 8·SIZE_Y), in the
/// coefficient layout (rows of 8·SIZE_Y).
pub fn compute_table(enc: &Encoding, table: usize) -> Result<Vec<f32>> {
    let lib;
    let enc = if let Encoding::Library = enc {
        lib = library(table);
        &lib
    } else {
        enc
    };
    let wrows = 8 * SIZE_X[table];
    let wcols = 8 * SIZE_Y[table];
    let num = wrows * wcols;
    let mut w = vec![0f32; 3 * num];
    const N: usize = 8;
    match enc {
        Encoding::Library => unreachable_library()?,
        Encoding::Identity(iw) => {
            for c in 0..3 {
                for i in 0..64 {
                    w[64 * c + i] = iw[c][0];
                }
                w[64 * c + 1] = iw[c][1];
                w[64 * c + 8] = iw[c][1];
                w[64 * c + 9] = iw[c][2];
            }
        }
        Encoding::Dct2(dw) => {
            for c in 0..3 {
                let s = c * 64;
                w[s] = 0xBAD as f32;
                w[s + 1] = dw[c][0];
                w[s + 8] = dw[c][0];
                w[s + 9] = dw[c][1];
                for y in 0..2 {
                    for x in 0..2 {
                        w[s + y * 8 + x + 2] = dw[c][2];
                        w[s + (y + 2) * 8 + x] = dw[c][2];
                    }
                }
                for y in 0..2 {
                    for x in 0..2 {
                        w[s + (y + 2) * 8 + x + 2] = dw[c][3];
                    }
                }
                for y in 0..4 {
                    for x in 0..4 {
                        w[s + y * 8 + x + 4] = dw[c][4];
                        w[s + (y + 4) * 8 + x] = dw[c][4];
                    }
                }
                for y in 0..4 {
                    for x in 0..4 {
                        w[s + (y + 4) * 8 + x + 4] = dw[c][5];
                    }
                }
            }
        }
        Encoding::Dct4(p, m) => {
            let mut w4 = [0f32; 48];
            quant_weights(4, 4, p, &mut w4)?;
            for c in 0..3 {
                for y in 0..8 {
                    for x in 0..8 {
                        w[c * num + y * 8 + x] = w4[c * 16 + (y / 2) * 4 + x / 2];
                    }
                }
                w[c * num + 1] /= m[c][0];
                w[c * num + N] /= m[c][0];
                w[c * num + N + 1] /= m[c][1];
            }
        }
        Encoding::Dct4x8(p, m) => {
            let mut w48 = [0f32; 96];
            quant_weights(4, 8, p, &mut w48)?;
            for c in 0..3 {
                for y in 0..8 {
                    for x in 0..8 {
                        w[c * num + y * 8 + x] = w48[c * 32 + (y / 2) * 8 + x];
                    }
                }
                w[c * num + N] /= m[c];
            }
        }
        Encoding::Dct(p) => quant_weights(wrows, wcols, p, &mut w)?,
        Encoding::Raw(den, t) => {
            if t.len() != 3 * num {
                return invalid("raw quantisation table size");
            }
            for i in 0..3 * num {
                w[i] = 1.0 / (den * t[i] as f32);
            }
        }
        Encoding::Afv(p48, p44, aw) => {
            #[allow(clippy::excessive_precision)]
            const FREQS: [f32; 16] = [
                0.0, 0.0, 0.8517778890324296, 5.37778436506804, 0.0, 0.0, 4.734747904497923, 5.449245381693219,
                1.6598270267479331, 4.0, 7.275749096817861, 10.423227632456525, 2.662932286148962, 7.630657783650829,
                8.962388608184032, 12.97166202570235,
            ];
            let mut w48 = [0f32; 96];
            quant_weights(4, 8, p48, &mut w48)?;
            let mut w44 = [0f32; 48];
            quant_weights(4, 4, p44, &mut w44)?;
            #[allow(clippy::excessive_precision)]
            let lo = 0.8517778890324296f32;
            #[allow(clippy::excessive_precision)]
            let hi = 12.97166202570235f32 - lo + 1e-6;
            for c in 0..3 {
                let mut bands = [0f32; 4];
                bands[0] = aw[c][5];
                if bands[0] < ALMOST_ZERO {
                    return invalid("AFV bands");
                }
                for i in 1..4 {
                    bands[i] = bands[i - 1] * mult(aw[c][i + 5]);
                    if bands[i] < ALMOST_ZERO {
                        return invalid("AFV bands");
                    }
                }
                let s = c * 64;
                w[s] = 1.0;
                let set = |w: &mut Vec<f32>, x: usize, y: usize, v: f32| w[s + y * 8 + x] = v;
                set(&mut w, 0, 1, aw[c][0]);
                set(&mut w, 1, 0, aw[c][1]);
                set(&mut w, 0, 2, aw[c][2]);
                set(&mut w, 2, 0, aw[c][3]);
                set(&mut w, 2, 2, aw[c][4]);
                for y in 0..4 {
                    for x in 0..4 {
                        if x < 2 && y < 2 {
                            continue;
                        }
                        let v = interpolate(FREQS[y * 4 + x] - lo, hi, &bands)?;
                        set(&mut w, 2 * x, 2 * y, v);
                    }
                }
                for y in 0..4 {
                    for x in 0..8 {
                        if x == 0 && y == 0 {
                            continue;
                        }
                        w[c * num + (2 * y + 1) * 8 + x] = w48[c * 32 + y * 8 + x];
                    }
                }
                for y in 0..4 {
                    for x in 0..4 {
                        if x == 0 && y == 0 {
                            continue;
                        }
                        w[c * num + (2 * y) * 8 + 2 * x + 1] = w44[c * 16 + y * 4 + x];
                    }
                }
            }
        }
    }
    for v in w.iter_mut() {
        if *v >= 1.0 / ALMOST_ZERO || *v < ALMOST_ZERO {
            return invalid("quantisation table value");
        }
        *v = 1.0 / *v;
    }
    Ok(w)
}

fn unreachable_library() -> Result<()> {
    Err(Error::Invalid("library quantisation table"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fast_pow_is_close() {
        for &(b, e) in &[(2.0f32, 0.5f32), (0.3, 0.7), (1.7, 0.25)] {
            let want = b.powf(e);
            assert!((fast_powf(b, e) - want).abs() < 1e-4 * want, "{b}^{e}");
        }
    }

    #[test]
    fn library_tables_compute() {
        for t in 0..NUM_TABLES {
            let w = compute_table(&Encoding::Library, t).unwrap();
            assert_eq!(w.len(), 3 * 64 * SIZE_X[t] * SIZE_Y[t]);
            assert!(w.iter().all(|v| v.is_finite() && *v > 0.0));
        }
    }
}

/// libjxl's FastPowf (used by the gamma transfer function).
pub fn fast_powf_pub(b: f32, e: f32) -> f32 {
    fast_powf(b, e)
}
