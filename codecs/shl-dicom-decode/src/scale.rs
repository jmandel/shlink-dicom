//! The fallback for reduced-resolution decodes (CONTRACT.md, "Reduced-resolution decode"): a box
//! downsample of canonical pixels, for codecs without a reduced decode of their own.

use crate::Error;

/// Downsample one canonical frame (`rows × columns × spp` samples, `bps` bytes each,
/// little-endian, two's complement when `signed`) by 2^`s` in each direction, appending
/// ceil(rows / 2^s) × ceil(columns / 2^s) × spp samples to `out`.
///
/// Each output sample is the mean of its block, rounded half up (`floor(mean + 1/2)`). Blocks
/// at the right and bottom edges average only the samples they have. With `pick` (PALETTE
/// COLOR, where averaging indices is meaningless) each output sample is instead the block's
/// top-left sample.
#[allow(clippy::too_many_arguments)]
pub(crate) fn box_downsample(
    src: &[u8],
    rows: usize,
    columns: usize,
    spp: usize,
    bps: usize,
    signed: bool,
    s: u8,
    pick: bool,
    out: &mut Vec<u8>,
) -> Result<(), Error> {
    let n = 1usize << s.min(16);
    let (orows, ocols) = (rows.div_ceil(n), columns.div_ceil(n));
    let row_samples = columns * spp;
    if src.len() < rows * row_samples * bps || !matches!(bps, 1 | 2 | 4) {
        return Err(Error::Invalid("frame is shorter than its dimensions".into()));
    }
    let added = orows * ocols * spp * bps;
    out.try_reserve(added).map_err(|_| Error::Unsupported(format!("cannot allocate {added} bytes")))?;
    let get = |i: usize| -> i64 {
        let b = &src[i * bps..i * bps + bps];
        match (bps, signed) {
            (1, false) => i64::from(b[0]),
            (1, true) => i64::from(b[0] as i8),
            (2, false) => i64::from(u16::from_le_bytes([b[0], b[1]])),
            (2, true) => i64::from(i16::from_le_bytes([b[0], b[1]])),
            (_, false) => i64::from(u32::from_le_bytes([b[0], b[1], b[2], b[3]])),
            (_, true) => i64::from(i32::from_le_bytes([b[0], b[1], b[2], b[3]])),
        }
    };
    let put = |out: &mut Vec<u8>, v: i64| match bps {
        1 => out.push(v as u8),
        2 => out.extend_from_slice(&(v as u16).to_le_bytes()),
        _ => out.extend_from_slice(&(v as u32).to_le_bytes()),
    };
    if pick {
        for oy in 0..orows {
            for ox in 0..ocols {
                for c in 0..spp {
                    put(out, get(oy * n * row_samples + ox * n * spp + c));
                }
            }
        }
        return Ok(());
    }
    // Column sums over a block's rows, in i128 so 32-bit samples cannot overflow at any scale.
    let mut col = vec![0i128; row_samples];
    for oy in 0..orows {
        col.fill(0);
        let y1 = ((oy + 1) * n).min(rows);
        for y in oy * n..y1 {
            let base = y * row_samples;
            for (k, c) in col.iter_mut().enumerate() {
                *c += i128::from(get(base + k));
            }
        }
        let block_rows = (y1 - oy * n) as i128;
        for ox in 0..ocols {
            let x1 = ((ox + 1) * n).min(columns);
            let cnt = block_rows * (x1 - ox * n) as i128;
            for c in 0..spp {
                let sum: i128 = (ox * n..x1).map(|x| col[x * spp + c]).sum();
                put(out, (sum * 2 + cnt).div_euclid(2 * cnt) as i64);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn means_round_half_up_and_edges_use_what_they_have() {
        // 3×3, one sample, 8-bit: blocks of 2 → 2×2 output.
        let src = [0u8, 1, 10, 2, 2, 20, 100, 101, 255];
        let mut out = Vec::new();
        box_downsample(&src, 3, 3, 1, 1, false, 1, false, &mut out).unwrap();
        // (0+1+2+2)/4 = 1.25 -> 1; (10+20)/2 = 15; (100+101)/2 = 100.5 -> 101; 255.
        assert_eq!(out, [1, 15, 101, 255]);
    }

    #[test]
    fn signed_and_wide_samples() {
        let src: Vec<u8> = [-3i16, -2, 5, 6].iter().flat_map(|v| v.to_le_bytes()).collect();
        let mut out = Vec::new();
        box_downsample(&src, 2, 2, 1, 2, true, 1, false, &mut out).unwrap();
        // (-3 - 2 + 5 + 6) / 4 = 1.5 -> 2.
        assert_eq!(i16::from_le_bytes([out[0], out[1]]), 2);
        let src: Vec<u8> = [-3i16, -2, -5, -6].iter().flat_map(|v| v.to_le_bytes()).collect();
        out.clear();
        box_downsample(&src, 2, 2, 1, 2, true, 1, false, &mut out).unwrap();
        // -16 / 4 = -4; and -14/4 = -3.5 rounds half up to -3 (checked below).
        assert_eq!(i16::from_le_bytes([out[0], out[1]]), -4);
        let src: Vec<u8> = [-3i16, -2, -4, -5].iter().flat_map(|v| v.to_le_bytes()).collect();
        out.clear();
        box_downsample(&src, 2, 2, 1, 2, true, 1, false, &mut out).unwrap();
        assert_eq!(i16::from_le_bytes([out[0], out[1]]), -3);
        let src: Vec<u8> = [u32::MAX; 4].iter().flat_map(|v| v.to_le_bytes()).collect();
        out.clear();
        box_downsample(&src, 2, 2, 1, 4, false, 1, false, &mut out).unwrap();
        assert_eq!(u32::from_le_bytes([out[0], out[1], out[2], out[3]]), u32::MAX);
    }

    #[test]
    fn colour_channels_are_kept_apart_and_palette_picks() {
        let src = [10u8, 20, 30, 12, 22, 32];
        let mut out = Vec::new();
        box_downsample(&src, 1, 2, 3, 1, false, 1, false, &mut out).unwrap();
        assert_eq!(out, [11, 21, 31]);
        out.clear();
        box_downsample(&src, 1, 2, 3, 1, false, 3, true, &mut out).unwrap();
        assert_eq!(out, [10, 20, 30]);
    }
}
