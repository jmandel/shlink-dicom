//! Float Pixel Data (7FE0,0008) and Double Float Pixel Data (7FE0,0009): IEEE 754 binary32 or
//! binary64 samples, always native (PS3.5 8.2: these elements are never encapsulated). Parametric
//! maps use them. The canonical form keeps the stored values as little-endian f32 or f64
//! (CONTRACT.md, "Float pixel data"); there is no Bits Stored, Pixel Representation or colour
//! conversion to apply.

use crate::parse::{self, Attributes};
use crate::{pixel, Canonical, Error, Inference};

fn us(v: Option<&[u8]>, little: bool, name: &str) -> Result<Option<u16>, Error> {
    match v {
        None | Some([]) => Ok(None),
        Some(b) => parse::read_u16(b, little)
            .map(Some)
            .ok_or_else(|| Error::Invalid(format!("{name} has a {}-byte value", b.len()))),
    }
}

/// Decode frames `first..first + count` of a float image of `frames` frames. `bits` is 32 for
/// Float Pixel Data and 64 for Double Float Pixel Data; `little` says how the attribute values
/// are encoded and `pixel_little` how the samples are.
#[allow(clippy::too_many_arguments)]
pub fn decode(
    a: &Attributes<'_>,
    data: &[u8],
    bits: u16,
    little: bool,
    pixel_little: bool,
    ts: &str,
    frames: usize,
    first: usize,
    count: usize,
) -> Result<Canonical, Error> {
    let mut notes = Vec::new();
    let rows = us(a.rows, little, "Rows")?.filter(|v| *v > 0);
    let columns = us(a.columns, little, "Columns")?.filter(|v| *v > 0);
    let (Some(rows), Some(columns)) = (rows, columns) else {
        return Err(Error::Invalid("missing required element (0028,0010) Rows or (0028,0011) Columns".into()));
    };
    let spp = us(a.samples_per_pixel, little, "Samples per Pixel")?.unwrap_or(1);
    if spp != 1 && spp != 3 {
        return Err(Error::Invalid(format!("Samples per Pixel {spp}")));
    }
    match us(a.bits_allocated, little, "Bits Allocated")? {
        Some(b) if b == bits => {}
        declared => notes.push(Inference::new(
            "BitsAllocated",
            bits,
            format!(
                "{}; {} Pixel Data holds {bits}-bit samples",
                declared.map_or("missing".to_string(), |b| format!("{b} does not match")),
                if bits == 64 { "Double Float" } else { "Float" }
            ),
        )),
    }
    let photometric = a.photometric.map(parse::trim_text).filter(|s| !s.is_empty()).unwrap_or_else(|| {
        let v = if spp == 3 { "RGB" } else { "MONOCHROME2" };
        notes.push(Inference::new("PhotometricInterpretation", v, format!("missing; {spp} sample(s) per pixel")));
        v.to_string()
    });
    let planar = spp == 3 && us(a.planar_configuration, little, "Planar Configuration")? == Some(1);

    let bps = usize::from(bits / 8);
    let frame_bytes = (rows as usize)
        .checked_mul(columns as usize)
        .and_then(|n| n.checked_mul(usize::from(spp)))
        .and_then(|n| n.checked_mul(bps))
        .ok_or_else(|| Error::Unsupported("image too large".into()))?;
    let needed = frame_bytes.checked_mul(frames).ok_or_else(|| Error::Unsupported("image too large".into()))?;
    let Some(stored) = data.get(..needed) else {
        return Err(Error::Invalid(format!(
            "{} Pixel Data has {} bytes, the image needs {needed} ({frames} frame(s) of {columns}×{rows}×{spp} at {bits} bits)",
            if bits == 64 { "Double Float" } else { "Float" },
            data.len()
        )));
    };
    let part = stored.get(frame_bytes * first..frame_bytes * (first + count)).unwrap_or(&[]);
    let mut out = pixel::alloc(0)?;
    out.try_reserve_exact(part.len())
        .map_err(|_| Error::Unsupported(format!("cannot allocate {} bytes for decoded pixels", part.len())))?;
    out.extend_from_slice(part);
    if !pixel_little {
        pixel::swap_samples(&mut out, bps);
    }
    if planar && frame_bytes > 0 {
        for frame in out.chunks_exact_mut(frame_bytes) {
            pixel::interleave(frame, 3, bps)?;
        }
    }
    Ok(Canonical {
        frames: u32::try_from(count).map_err(|_| Error::Unsupported("too many frames".into()))?,
        first_frame: u32::try_from(first).map_err(|_| Error::Unsupported("too many frames".into()))?,
        total_frames: u32::try_from(frames).map_err(|_| Error::Unsupported("too many frames".into()))?,
        rows: u32::from(rows),
        columns: u32::from(columns),
        samples_per_pixel: spp,
        bits_allocated: bits,
        bits_stored: bits,
        signed: false,
        float: true,
        photometric,
        transfer_syntax: ts.to_string(),
        data: out,
        inferred: notes,
    })
}

/// Box-downsample every frame of a float result by 2^`s` (CONTRACT.md, "Reduced-resolution
/// decode"): each output sample is the mean of its block, computed in f64 and stored at the
/// sample width. NaN samples are left out of the mean; a block of only NaN gives NaN.
pub fn downsample(full: Canonical, s: u8) -> Result<Canonical, Error> {
    let n = 1usize << s.min(16);
    let (rows, columns, spp) = (full.rows as usize, full.columns as usize, usize::from(full.samples_per_pixel));
    let bps = full.bytes_per_sample();
    let (orows, ocols) = (rows.div_ceil(n), columns.div_ceil(n));
    let frame_bytes = rows * columns * spp * bps;
    let mut out = Vec::new();
    let total = orows * ocols * spp * bps * full.frames as usize;
    out.try_reserve_exact(total).map_err(|_| Error::Unsupported(format!("cannot allocate {total} bytes")))?;
    let get = |frame: &[u8], i: usize| -> f64 {
        match frame.get(i * bps..i * bps + bps) {
            Some(&[a, b, c, d]) => f64::from(f32::from_le_bytes([a, b, c, d])),
            Some(&[a, b, c, d, e, f, g, h]) => f64::from_le_bytes([a, b, c, d, e, f, g, h]),
            _ => f64::NAN,
        }
    };
    if frame_bytes > 0 {
        for frame in full.data.chunks_exact(frame_bytes) {
            for oy in 0..orows {
                for ox in 0..ocols {
                    for c in 0..spp {
                        let (mut sum, mut cnt) = (0.0f64, 0u32);
                        for y in oy * n..((oy + 1) * n).min(rows) {
                            for x in ox * n..((ox + 1) * n).min(columns) {
                                let v = get(frame, (y * columns + x) * spp + c);
                                if !v.is_nan() {
                                    sum += v;
                                    cnt += 1;
                                }
                            }
                        }
                        let mean = if cnt == 0 { f64::NAN } else { sum / f64::from(cnt) };
                        if bps == 4 {
                            out.extend_from_slice(&(mean as f32).to_le_bytes());
                        } else {
                            out.extend_from_slice(&mean.to_le_bytes());
                        }
                    }
                }
            }
        }
    }
    Ok(Canonical { rows: orows as u32, columns: ocols as u32, data: out, ..full })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downsample_means_and_skips_nan() {
        let vals: [f32; 4] = [1.0, 2.0, f32::NAN, 4.0];
        let data: Vec<u8> = vals.iter().flat_map(|v| v.to_le_bytes()).collect();
        let c = Canonical {
            frames: 1,
            first_frame: 0,
            total_frames: 1,
            rows: 2,
            columns: 2,
            samples_per_pixel: 1,
            bits_allocated: 32,
            bits_stored: 32,
            signed: false,
            float: true,
            photometric: "MONOCHROME2".into(),
            transfer_syntax: "1.2.840.10008.1.2.1".into(),
            data,
            inferred: vec![],
        };
        let d = downsample(c, 1).unwrap();
        assert_eq!((d.rows, d.columns), (1, 1));
        assert_eq!(f32::from_le_bytes(d.data[..4].try_into().unwrap()), 7.0 / 3.0);
    }
}
