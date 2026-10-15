//! Colour models with no RGB conversion in pydicom: the retired ARGB, CMYK and HSV (PS3.3
//! C.7.6.3.1.2 up to the 2003 edition) and YBR_PARTIAL_422. All are converted to RGB, so the
//! canonical form has three samples per pixel (CONTRACT.md, "Colour").
//!
//! The standard defines the colour models but no conversion for HSV and CMYK; these follow
//! DCMTK's dcmimage, the one reader that implements them (codec-corpus/formats/uncompressed/
//! FORMAT.md, "Retired photometric interpretations"):
//! - HSV: Foley et al.'s hexcone algorithm, hue scaled so that 0..=max covers 0°..360°;
//! - CMYK: each of R, G, B = max − C/M/Y − K, at least 0;
//! - ARGB: where A > 0 the Palette Color Lookup Tables, indexed by A, give the colour; elsewhere R,
//!   G, B are used as they are.
//!
//! YBR_PARTIAL_422 inverts the PS3.3 C.7.6.3.1.2 equations exactly (Y offset 16, Cb/Cr offset 128).

use crate::parse;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Model {
    Argb,
    Cmyk,
    Hsv,
}

impl Model {
    pub fn parse(pm: &str) -> Option<Self> {
        match pm {
            "ARGB" => Some(Self::Argb),
            "CMYK" => Some(Self::Cmyk),
            "HSV" => Some(Self::Hsv),
            _ => None,
        }
    }

    pub fn samples(self) -> u16 {
        match self {
            Self::Argb | Self::Cmyk => 4,
            Self::Hsv => 3,
        }
    }
}

/// Red, green and blue Palette Color Lookup Tables: (0028,1101–1103) descriptors and
/// (0028,1201–1203) data, as PS3.3 C.7.6.3.1.5 defines them.
pub struct Palette {
    first: i64,
    /// Entries per channel, scaled to the image's Bits Stored.
    entries: [Vec<u32>; 3],
}

impl Palette {
    pub fn read(desc: [Option<&[u8]>; 3], data: [Option<&[u8]>; 3], little: bool, bits_stored: u16) -> Option<Self> {
        let mut first = 0i64;
        let mut entries: [Vec<u32>; 3] = Default::default();
        for k in 0..3 {
            let d = desc[k]?;
            let n = parse::read_u16(d.get(0..2)?, little)?;
            let f = parse::read_u16(d.get(2..4)?, little)?;
            let bits = parse::read_u16(d.get(4..6)?, little)?;
            let n = if n == 0 { 65536 } else { usize::from(n) };
            if k == 0 {
                first = i64::from(f);
            }
            let raw = data[k]?;
            let vals: Vec<u32> = if raw.len() >= 2 * n {
                raw.chunks_exact(2).take(n).map(|c| u32::from(parse::read_u16(c, little).unwrap_or(0))).collect()
            } else if bits <= 8 && raw.len() >= n {
                raw.iter().take(n).map(|&b| u32::from(b)).collect()
            } else {
                return None;
            };
            let bits = u32::from(bits.clamp(1, 16));
            let bs = u32::from(bits_stored.clamp(1, 32));
            entries[k] = vals
                .into_iter()
                .map(|v| if bits >= bs { v >> (bits - bs) } else { v << (bs - bits) })
                .collect();
        }
        Some(Self { first, entries })
    }

    fn get(&self, k: usize, index: u32) -> u32 {
        let e = &self.entries[k];
        let i = (i64::from(index) - self.first).clamp(0, e.len() as i64 - 1);
        e.get(i as usize).copied().unwrap_or(0)
    }
}

fn get(data: &[u8], i: usize, bps: usize) -> u32 {
    match data.get(i * bps..i * bps + bps) {
        Some(&[a]) => u32::from(a),
        Some(&[a, b]) => u32::from(u16::from_le_bytes([a, b])),
        Some(&[a, b, c, d]) => u32::from_le_bytes([a, b, c, d]),
        _ => 0,
    }
}

fn put(out: &mut Vec<u8>, v: u32, bps: usize) {
    match bps {
        1 => out.push(v as u8),
        2 => out.extend_from_slice(&(v as u16).to_le_bytes()),
        _ => out.extend_from_slice(&v.to_le_bytes()),
    }
}

/// Convert interleaved, unsigned samples (`model.samples()` per pixel, `bps` bytes each, already
/// masked to `bits_stored`) to interleaved RGB.
pub fn to_rgb(model: Model, data: &[u8], bps: usize, bits_stored: u16, palette: Option<&Palette>) -> Vec<u8> {
    let spp = usize::from(model.samples());
    let pixels = data.len() / (spp * bps).max(1);
    let max = if bits_stored >= 32 { u32::MAX } else { (1u32 << bits_stored) - 1 };
    let mut out = Vec::with_capacity(pixels * 3 * bps);
    for p in 0..pixels {
        let s = |k: usize| get(data, p * spp + k, bps);
        let rgb = match model {
            Model::Cmyk => {
                let k = s(3);
                [0, 1, 2].map(|c| max.saturating_sub(s(c)).saturating_sub(k))
            }
            Model::Argb => match palette {
                Some(pal) if s(0) > 0 => [0, 1, 2].map(|c| pal.get(c, s(0))),
                _ => [s(1), s(2), s(3)],
            },
            Model::Hsv => hsv(s(0), s(1), s(2), max),
        };
        for v in rgb {
            put(&mut out, v, bps);
        }
    }
    out
}

/// Foley et al., 'Computer Graphics: Principles and Practice' (1990), as DCMTK computes it
/// (dihsvpxt.h): hue × 6 / (max + 1) picks the sector; intermediate values are truncated.
fn hsv(hue: u32, sat: u32, val: u32, max: u32) -> [u32; 3] {
    if sat == 0 {
        return [val; 3];
    }
    let m = f64::from(max);
    let h = f64::from(hue) * 6.0 / (m + 1.0);
    let s = f64::from(sat) / m;
    let v = f64::from(val) / m;
    let hi = h as u32;
    let hf = h - f64::from(hi);
    let p = (m * v * (1.0 - s)) as u32;
    let q = (m * v * (1.0 - s * hf)) as u32;
    let t = (m * v * (1.0 - s * (1.0 - hf))) as u32;
    match hi {
        0 => [val, t, p],
        1 => [q, val, p],
        2 => [p, val, t],
        3 => [p, q, val],
        4 => [t, p, val],
        _ => [val, p, q],
    }
}

/// YBR_PARTIAL (8-bit, interleaved, already expanded from 4:2:2) to RGB in place: the exact
/// inverse of Y = .2568R + .5041G + .0979B + 16, Cb = −.1482R − .2910G + .4392B + 128,
/// Cr = .4392R − .3678G − .0714B + 128, rounded half up and clamped to 0..=255.
pub fn ybr_partial_to_rgb(data: &mut [u8]) {
    const M: [[f64; 3]; 3] = [[0.2568, 0.5041, 0.0979], [-0.1482, -0.2910, 0.4392], [0.4392, -0.3678, -0.0714]];
    let inv = invert(M);
    for px in data.chunks_exact_mut(3) {
        let v = [f64::from(px[0]) - 16.0, f64::from(px[1]) - 128.0, f64::from(px[2]) - 128.0];
        for (o, row) in px.iter_mut().zip(inv) {
            let x = row[0] * v[0] + row[1] * v[1] + row[2] * v[2];
            *o = (x + 0.5).floor().clamp(0.0, 255.0) as u8;
        }
    }
}

fn invert(m: [[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    let mut r = [[0.0; 3]; 3];
    for (i, row) in r.iter_mut().enumerate() {
        for (j, x) in row.iter_mut().enumerate() {
            let (a, b) = ((j + 1) % 3, (j + 2) % 3);
            let (c, d) = ((i + 1) % 3, (i + 2) % 3);
            *x = (m[a][c] * m[b][d] - m[a][d] * m[b][c]) / det;
        }
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_inverse_round_trips() {
        // RGB (200, 100, 50) -> Y 122.67, Cb 91.22, Cr 175.49 by the forward equations.
        let mut px = [123u8, 91, 175];
        ybr_partial_to_rgb(&mut px);
        assert!(px.iter().zip([200u8, 100, 50]).all(|(a, b)| a.abs_diff(b) <= 1), "{px:?}");
    }

    #[test]
    fn cmyk_and_hsv() {
        assert_eq!(to_rgb(Model::Cmyk, &[0, 155, 205, 55], 1, 8, None), [200, 45, 0]);
        assert_eq!(to_rgb(Model::Hsv, &[0, 0, 77], 1, 8, None), [77, 77, 77]);
        assert_eq!(to_rgb(Model::Hsv, &[0, 255, 255], 1, 8, None), [255, 0, 0]);
    }
}
