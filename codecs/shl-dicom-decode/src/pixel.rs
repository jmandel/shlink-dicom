//! Sample-level transforms shared by native and encapsulated pixel data. Every function works on
//! little-endian samples of `bps` bytes (1, 2 or 4) and matches what pydicom does in
//! `pixel_array(raw=False)`.

use crate::Error;

/// Allocate a zeroed buffer without aborting on allocation failure.
pub fn alloc(len: usize) -> Result<Vec<u8>, Error> {
    let mut v = Vec::new();
    v.try_reserve_exact(len)
        .map_err(|_| Error::Unsupported(format!("cannot allocate {len} bytes for decoded pixels")))?;
    v.resize(len, 0);
    Ok(v)
}

/// Reverse the byte order of every `width`-byte sample (big endian -> little endian).
pub fn swap_samples(data: &mut [u8], width: usize) {
    if width > 1 {
        for s in data.chunks_exact_mut(width) {
            s.reverse();
        }
    }
}

/// Unpack `count` 1-bit samples, least significant bit first (PS3.5 8.1.1), one byte per sample.
pub fn unpack_bits(src: &[u8], count: usize) -> Result<Vec<u8>, Error> {
    let mut out = alloc(count)?;
    for (i, o) in out.iter_mut().enumerate() {
        let byte = src.get(i / 8).copied().unwrap_or(0);
        *o = (byte >> (i % 8)) & 1;
    }
    Ok(out)
}

/// Unpack `count` ACR-NEMA 12-bit samples, two in every three bytes (b0, b1, b2 hold
/// `b0 | (b1 & 0x0F) << 8` and `b1 >> 4 | b2 << 4`, as GDCM reads them), into 16-bit little-endian.
pub fn unpack_12(src: &[u8], count: usize) -> Result<Vec<u8>, Error> {
    let mut out = alloc(count.checked_mul(2).ok_or_else(|| Error::Unsupported("image too large".into()))?)?;
    for (k, pair) in out.chunks_mut(4).enumerate() {
        let b = |i: usize| u16::from(src.get(3 * k + i).copied().unwrap_or(0));
        let (p0, p1) = (b(0) | (b(1) & 0x0F) << 8, b(1) >> 4 | b(2) << 4);
        for (d, v) in pair.chunks_exact_mut(2).zip([p0, p1]) {
            d.copy_from_slice(&v.to_le_bytes());
        }
    }
    Ok(out)
}

/// Expand native YBR_FULL_422 (Y1 Y2 Cb Cr per pair of pixels, PS3.3 C.7.6.3.1.2) to YBR_FULL
/// (Y1 Cb Cr Y2 Cb Cr). Like pydicom, this runs over the whole buffer, so pairs may span rows.
pub fn expand_ybr_422(src: &[u8], bps: usize) -> Result<Vec<u8>, Error> {
    let group = bps.checked_mul(4).ok_or_else(|| Error::Invalid("sample size overflow".into()))?;
    if group == 0 || !src.len().is_multiple_of(group) {
        return Err(Error::Invalid(
            "YBR_FULL_422 pixel data does not hold a whole number of pixel pairs".into(),
        ));
    }
    let out_len = src.len() / 2 * 3;
    let mut out = alloc(out_len)?;
    if bps == 1 {
        for (d, g) in out.chunks_exact_mut(6).zip(src.chunks_exact(4)) {
            if let ([d0, d1, d2, d3, d4, d5], [y1, y2, cb, cr]) = (d, g) {
                (*d0, *d1, *d2, *d3, *d4, *d5) = (*y1, *cb, *cr, *y2, *cb, *cr);
            }
        }
        return Ok(out);
    }
    for (d, g) in out.chunks_exact_mut(6 * bps).zip(src.chunks_exact(group)) {
        let (y1, rest) = g.split_at(bps);
        let (y2, rest) = rest.split_at(bps);
        let (cb, cr) = rest.split_at(bps);
        for (dst, part) in d.chunks_exact_mut(bps).zip([y1, cb, cr, y2, cb, cr]) {
            dst.copy_from_slice(part);
        }
    }
    Ok(out)
}

/// Interleave one planar frame (all of sample 0, then sample 1, ...) in place.
pub fn interleave(frame: &mut [u8], spp: usize, bps: usize) -> Result<(), Error> {
    if spp <= 1 {
        return Ok(());
    }
    let src = frame.to_vec();
    interleave_into(&src, frame, spp, bps)
}

/// Interleave planar `src` into `dst` (same length).
pub fn interleave_into(src: &[u8], dst: &mut [u8], spp: usize, bps: usize) -> Result<(), Error> {
    let unit = spp.checked_mul(bps).filter(|u| *u > 0).ok_or_else(|| Error::Invalid("bad sample size".into()))?;
    if !src.len().is_multiple_of(unit) || src.len() != dst.len() {
        return Err(Error::Invalid("planar frame length is not a multiple of the pixel size".into()));
    }
    if spp == 1 {
        dst.copy_from_slice(src);
        return Ok(());
    }
    let plane = src.len() / spp;
    match (spp, bps) {
        (3, 1) => {
            let (p0, rest) = src.split_at(plane);
            let (p1, p2) = rest.split_at(plane);
            interleave3::<1, 16, 48>(p0, p1, p2, dst);
        }
        (3, 2) => {
            let (p0, rest) = src.split_at(plane);
            let (p1, p2) = rest.split_at(plane);
            interleave3::<2, 32, 96>(p0, p1, p2, dst);
        }
        _ => {
            for (p, px) in dst.chunks_exact_mut(unit).enumerate() {
                for (s, d) in px.chunks_exact_mut(bps).enumerate() {
                    let at = s * plane + p * bps;
                    if let Some(v) = src.get(at..at + bps) {
                        d.copy_from_slice(v);
                    }
                }
            }
        }
    }
    Ok(())
}

/// Three planes of `B`-byte samples -> interleaved. Works in blocks of 16 samples through
/// fixed-size arrays, so there are no bounds checks in the loop and it compiles to shuffles.
/// `IN` = 16 × `B` and `OUT` = 48 × `B` (stable Rust cannot compute array sizes from `B`).
fn interleave3<const B: usize, const IN: usize, const OUT: usize>(p0: &[u8], p1: &[u8], p2: &[u8], dst: &mut [u8]) {
    const N: usize = 16;
    debug_assert!(IN == N * B && OUT == 3 * IN);
    let blocks = p0
        .chunks_exact(IN)
        .zip(p1.chunks_exact(IN))
        .zip(p2.chunks_exact(IN))
        .zip(dst.chunks_exact_mut(OUT));
    for (((a, b), c), d) in blocks {
        let (Ok(a), Ok(b), Ok(c), Ok(d)) = (
            <&[u8; IN]>::try_from(a),
            <&[u8; IN]>::try_from(b),
            <&[u8; IN]>::try_from(c),
            <&mut [u8; OUT]>::try_from(d),
        ) else {
            continue;
        };
        for k in 0..N {
            for j in 0..B {
                d[(3 * k) * B + j] = a[k * B + j];
                d[(3 * k + 1) * B + j] = b[k * B + j];
                d[(3 * k + 2) * B + j] = c[k * B + j];
            }
        }
    }
    let done = p0.len() / IN * IN;
    let tail = p0
        .get(done..)
        .unwrap_or(&[])
        .chunks_exact(B)
        .zip(p1.get(done..).unwrap_or(&[]).chunks_exact(B))
        .zip(p2.get(done..).unwrap_or(&[]).chunks_exact(B))
        .zip(dst.get_mut(3 * done..).unwrap_or(&mut []).chunks_exact_mut(3 * B));
    for (((a, b), c), d) in tail {
        let (d0, rest) = d.split_at_mut(B);
        let (d1, d2) = rest.split_at_mut(B);
        d0.copy_from_slice(a);
        d1.copy_from_slice(b);
        d2.copy_from_slice(c);
    }
}

/// Keep the low `bits_stored` bits (unsigned) or sign-extend from bit `bits_stored - 1` (signed).
/// No-op when Bits Stored equals the sample width.
pub fn fix_unused_bits(data: &mut [u8], bps: usize, bits_stored: u16, signed: bool) {
    let Some(fix) = lane_fix(bps, bits_stored, signed) else { return };
    let mut chunks = data.chunks_exact_mut(8);
    for c in &mut chunks {
        let x = u64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]);
        c.copy_from_slice(&fix(x).to_le_bytes());
    }
    fix_tail(chunks.into_remainder(), bps, &fix);
}

/// `dst` extended with `src` after [`fix_unused_bits`], in one pass.
pub fn extend_fixing_unused_bits(dst: &mut Vec<u8>, src: &[u8], bps: usize, bits_stored: u16, signed: bool) {
    let Some(fix) = lane_fix(bps, bits_stored, signed) else {
        dst.extend_from_slice(src);
        return;
    };
    let start = dst.len();
    let chunks = src.chunks_exact(8);
    let rest = chunks.remainder();
    dst.extend(chunks.flat_map(|c| fix(u64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]])).to_le_bytes()));
    dst.extend_from_slice(rest);
    let tail = dst.len() - rest.len();
    fix_tail(&mut dst[tail.max(start)..], bps, &fix);
}

/// The per-word function of [`fix_unused_bits`]: eight bytes at a time, each lane of `bps`
/// bytes handled independently (no carries cross lanes). Keeps the low `bs` bits, and for signed
/// samples copies bit `bs - 1` into the bits above. None when there is nothing to do.
fn lane_fix(bps: usize, bits_stored: u16, signed: bool) -> Option<impl Fn(u64) -> u64> {
    let width = (bps * 8) as u32;
    let bs = u32::from(bits_stored);
    if bs == 0 || bs >= width || !matches!(bps, 1 | 2 | 4) {
        return None;
    }
    let lane_mask: u64 = (1u64 << bs) - 1;
    let lane_high: u64 = ((1u64 << width) - 1) & !lane_mask;
    let lanes = 8 / bps;
    let rep = |v: u64| (0..lanes).fold(0u64, |a, i| a | v << (i * bps * 8));
    let (mask, top) = (rep(lane_mask), rep(1u64 << (bs - 1)));
    Some(move |x: u64| -> u64 {
        let m = x & mask;
        if signed {
            // Each lane's sign bit moved to bit 0 (0 or 1 per lane), times the lane's high bits.
            m | ((m & top) >> (bs - 1)).wrapping_mul(lane_high)
        } else {
            m
        }
    })
}

/// Fewer than eight bytes (whole samples; a partial sample is left alone): one at a time.
fn fix_tail(tail: &mut [u8], bps: usize, fix: &impl Fn(u64) -> u64) {
    for s in tail.chunks_exact_mut(bps) {
        let mut b = [0u8; 8];
        b[..bps].copy_from_slice(s);
        let v = fix(u64::from_le_bytes(b)).to_le_bytes();
        s.copy_from_slice(&v[..bps]);
    }
}

/// [`fix_unused_bits`] with its own bit count for each component of interleaved samples.
pub fn fix_unused_bits_per_component(data: &mut [u8], bps: usize, bits: &[u16], signed: bool) {
    match bits {
        [] => {}
        [first, rest @ ..] if rest.iter().all(|b| b == first) => fix_unused_bits(data, bps, *first, signed),
        _ => {
            let n = bits.len();
            for (i, sample) in data.chunks_exact_mut(bps).enumerate() {
                if let Some(&b) = bits.get(i % n) {
                    fix_unused_bits(sample, bps, b, signed);
                }
            }
        }
    }
}

/// pydicom's YBR_FULL -> RGB matrix (`_convert_YBR_FULL_to_RGB`), built in float64 and stored as
/// float32: R = Y + 1.402 Cr', G = Y + g_cb Cb' + g_cr Cr', B = Y + 1.772 Cb' (Cb' = Cb - 128).
const R_CR: f32 = 1.402;
const B_CB: f32 = 1.772;
#[allow(clippy::excessive_precision)]
const G_CB: f32 = (-0.114f64 * 1.772 / 0.587) as f32;
#[allow(clippy::excessive_precision)]
const G_CR: f32 = (-0.299f64 * 1.402 / 0.587) as f32;

/// pydicom's rounding: `clip(floor(x + 0.5), 0, 255)`. Clamping in float and then truncating
/// gives the same byte for every x (truncation is floor on 0..=255, and values below 0 clamp to
/// 0 either way), without a libm `floor` call, and it vectorises.
#[inline(always)]
fn round_clamp(x: f32) -> u8 {
    (x + 0.5).clamp(0.0, 255.0) as u8
}

/// R and B depend on two inputs each, so they come from 64 KiB tables indexed by (Y, Cr) and
/// (Y, Cb), filled with the float32 formula. Built once per process.
type RbTables = (Box<[u8; 1 << 16]>, Box<[u8; 1 << 16]>);

fn rb_tables() -> &'static RbTables {
    static TABLES: std::sync::OnceLock<RbTables> = std::sync::OnceLock::new();
    TABLES.get_or_init(|| {
        let mut r = Box::new([0u8; 1 << 16]);
        let mut b = Box::new([0u8; 1 << 16]);
        for (i, (rv, bv)) in r.iter_mut().zip(b.iter_mut()).enumerate() {
            let y = (i >> 8) as f32;
            let c = (i & 0xFF) as f32 - 128.0;
            // The zero matrix entries add a signed zero to an integer-valued Y, a no-op.
            *rv = round_clamp(y + c * R_CR);
            *bv = round_clamp(y + c * B_CB);
        }
        (r, b)
    })
}

/// Per-call state for YBR_FULL -> RGB: the shared R/B tables and the two G product tables.
struct YbrToRgb {
    tables: &'static RbTables,
    g_cb: [f32; 256],
    g_cr: [f32; 256],
}

impl YbrToRgb {
    fn new() -> Self {
        let mut g_cb = [0f32; 256];
        let mut g_cr = [0f32; 256];
        for i in 0..256usize {
            let c = i as f32 - 128.0;
            g_cb[i] = c * G_CB;
            g_cr[i] = c * G_CR;
        }
        Self { tables: rb_tables(), g_cb, g_cr }
    }

    /// One pixel. R and B are table lookups; G = (Y + g_cb Cb') + g_cr Cr' in float32, numpy's
    /// order. `yi | c < 65536`, so the fixed-size tables are indexed without a bounds check.
    #[inline(always)]
    fn px(&self, y: u8, cb: u8, cr: u8) -> [u8; 3] {
        let yi = usize::from(y) << 8;
        let (cbi, cri) = (usize::from(cb), usize::from(cr));
        let r = self.tables.0[(yi | cri) & 0xFFFF];
        let b = self.tables.1[(yi | cbi) & 0xFFFF];
        let g = round_clamp((f32::from(y) + self.g_cb[cbi]) + self.g_cr[cri]);
        [r, g, b]
    }
}

/// YBR_FULL -> RGB for interleaved 8-bit samples, bit-for-bit as pydicom's float32 version
/// (`ybr_full_to_rgb_reference`; the test `ybr_matches_reference_on_all_inputs` checks all 2^24
/// inputs).
pub fn ybr_full_to_rgb(data: &mut [u8]) {
    let conv = YbrToRgb::new();
    for px in data.chunks_exact_mut(3) {
        if let [y, cb, cr] = px {
            [*y, *cb, *cr] = conv.px(*y, *cb, *cr);
        }
    }
}

/// Native 8-bit YBR_FULL_422 straight to RGB: [`expand_ybr_422`] followed by
/// [`ybr_full_to_rgb`], in one pass without the intermediate buffer.
pub fn ybr_422_to_rgb(src: &[u8]) -> Result<Vec<u8>, Error> {
    if !src.len().is_multiple_of(4) {
        return Err(Error::Invalid(
            "YBR_FULL_422 pixel data does not hold a whole number of pixel pairs".into(),
        ));
    }
    let mut out = alloc(src.len() / 2 * 3)?;
    let conv = YbrToRgb::new();
    for (d, g) in out.chunks_exact_mut(6).zip(src.chunks_exact(4)) {
        if let ([d0, d1, d2, d3, d4, d5], [y1, y2, cb, cr]) = (d, g) {
            [*d0, *d1, *d2] = conv.px(*y1, *cb, *cr);
            [*d3, *d4, *d5] = conv.px(*y2, *cb, *cr);
        }
    }
    Ok(out)
}

/// The straightforward float32 version, kept as the reference for the exhaustive test.
#[cfg(test)]
fn ybr_full_to_rgb_reference(px: [u8; 3]) -> [u8; 3] {
    let round = |x: f32| (x + 0.5).floor().clamp(0.0, 255.0) as u8;
    let y = f32::from(px[0]);
    let cb = f32::from(px[1]) - 128.0;
    let cr = f32::from(px[2]) - 128.0;
    let r = y + cb * 0.0 + cr * R_CR;
    let g = y + cb * G_CB + cr * G_CR;
    let b = y + cb * B_CB + cr * 0.0;
    [round(r), round(g), round(b)]
}

#[cfg(test)]
mod tests {
    /// The word-at-a-time masking against the per-sample definition, every width and Bits
    /// Stored, signed and unsigned, with lengths that leave tails.
    #[test]
    fn fix_unused_bits_matches_per_sample() {
        let mut x = 0x9E37_79B9_7F4A_7C15u64;
        let data: Vec<u8> = (0..203)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                x as u8
            })
            .collect();
        for bps in [1usize, 2, 4] {
            for bs in 1..(bps as u16 * 8) {
                for signed in [false, true] {
                    for len in [0, 1, 7, 8, 9, 64, 203] {
                        let len = len / bps * bps;
                        let mut got = data[..len].to_vec();
                        fix_unused_bits(&mut got, bps, bs, signed);
                        let mut got2 = vec![7u8; 3];
                        extend_fixing_unused_bits(&mut got2, &data[..len], bps, bs, signed);
                        assert_eq!(&got2[3..], &got[..], "extend: bps {bps} bs {bs} signed {signed} len {len}");
                        let want: Vec<u8> = data[..len]
                            .chunks_exact(bps)
                            .flat_map(|c| {
                                let mut b = [0u8; 4];
                                b[..bps].copy_from_slice(c);
                                let v = u32::from_le_bytes(b);
                                let shift = 32 - u32::from(bs);
                                let r = if signed { (((v << shift) as i32) >> shift) as u32 } else { v & ((1u32 << bs) - 1) };
                                r.to_le_bytes()[..bps].to_vec()
                            })
                            .collect();
                        assert_eq!(got, want, "bps {bps} bs {bs} signed {signed} len {len}");
                    }
                }
            }
        }
    }

    use super::*;

    #[test]
    fn unpack_lsb_first() {
        assert_eq!(unpack_bits(&[0b0000_0101, 0b1000_0000], 16).unwrap(), [1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        assert_eq!(unpack_bits(&[0xFF], 3).unwrap(), [1, 1, 1]);
    }

    #[test]
    fn mask_and_sign_extend() {
        let mut d = 0xF800u16.to_le_bytes().to_vec(); // 12-bit stored, junk above
        fix_unused_bits(&mut d, 2, 12, false);
        assert_eq!(u16::from_le_bytes([d[0], d[1]]), 0x0800);
        let mut d = 0x0800u16.to_le_bytes().to_vec();
        fix_unused_bits(&mut d, 2, 12, true);
        assert_eq!(i16::from_le_bytes([d[0], d[1]]), -2048);
        let mut d = 0x0000_8000u32.to_le_bytes().to_vec();
        fix_unused_bits(&mut d, 4, 16, true);
        assert_eq!(i32::from_le_bytes([d[0], d[1], d[2], d[3]]), -32768);
        let mut d = vec![0xF0];
        fix_unused_bits(&mut d, 1, 5, true);
        assert_eq!(d[0] as i8, -16);
    }

    #[test]
    fn per_component_bits() {
        let mut d = vec![0xFF; 6];
        fix_unused_bits_per_component(&mut d, 1, &[4, 8, 6], false);
        assert_eq!(d, [0x0F, 0xFF, 0x3F, 0x0F, 0xFF, 0x3F]);
    }

    #[test]
    fn interleave_planes() {
        let mut f = vec![1, 2, 10, 20, 100, 200];
        interleave(&mut f, 3, 1).unwrap();
        assert_eq!(f, [1, 10, 100, 2, 20, 200]);
        let mut f = vec![1, 0, 2, 0, 3, 0];
        interleave(&mut f, 3, 2).unwrap();
        assert_eq!(f, [1, 0, 2, 0, 3, 0]);
    }

    #[test]
    fn ybr_422_expansion() {
        assert_eq!(expand_ybr_422(&[1, 2, 3, 4], 1).unwrap(), [1, 3, 4, 2, 3, 4]);
        assert!(expand_ybr_422(&[1, 2], 1).is_err());
    }

    #[test]
    fn ybr_matches_reference_on_all_inputs() {
        // Every (Y, Cb, Cr) triple, 2^24 pixels, in 256 batches of 65536.
        let mut buf = vec![0u8; 3 << 16];
        for y in 0..=255u8 {
            for (i, px) in buf.chunks_exact_mut(3).enumerate() {
                px.copy_from_slice(&[y, (i >> 8) as u8, i as u8]);
            }
            ybr_full_to_rgb(&mut buf);
            for (i, px) in buf.chunks_exact(3).enumerate() {
                let want = ybr_full_to_rgb_reference([y, (i >> 8) as u8, i as u8]);
                assert_eq!(px, want, "Y={y} Cb={} Cr={}", i >> 8, i & 255);
            }
        }
    }

    #[test]
    fn fast_paths_match_generic() {
        // interleave: 3×1 and 3×2 fast paths against an index formula.
        for bps in [1usize, 2, 4] {
            for pixels in [1usize, 7, 16, 37] {
            let src: Vec<u8> = (0..pixels * 3 * bps).map(|i| (i * 37 % 251) as u8).collect();
            let mut f = src.clone();
            interleave(&mut f, 3, bps).unwrap();
            for p in 0..pixels {
                for s in 0..3 {
                    let got = &f[(p * 3 + s) * bps..][..bps];
                    let want = &src[(s * pixels + p) * bps..][..bps];
                    assert_eq!(got, want, "bps={bps} p={p} s={s}");
                }
            }
            }
        }
        // 422 expansion: 2-byte path.
        assert_eq!(expand_ybr_422(&[1, 0, 2, 0, 3, 0, 4, 0], 2).unwrap(), [1, 0, 3, 0, 4, 0, 2, 0, 3, 0, 4, 0]);
        // Masking and sign extension against a per-value formula for every width and Bits Stored.
        for bps in [1usize, 2, 4] {
            let width = bps as u32 * 8;
            for bs in 1..=width as u16 {
                for signed in [false, true] {
                    let vals: Vec<u64> = (0..64u64).map(|i| i.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 13).collect();
                    let mut d: Vec<u8> = vals.iter().flat_map(|v| v.to_le_bytes()[..bps].to_vec()).collect();
                    fix_unused_bits(&mut d, bps, bs, signed);
                    for (v, got) in vals.iter().zip(d.chunks_exact(bps)) {
                        let raw = v & ((1u64 << width) - 1);
                        let low = raw & ((1u64 << bs) - 1);
                        let want = if signed && bs < width as u16 && low >> (bs - 1) & 1 == 1 {
                            (low | !((1u64 << bs) - 1)) & ((1u64 << width) - 1)
                        } else if bs < width as u16 {
                            low
                        } else {
                            raw
                        };
                        let mut g = [0u8; 8];
                        g[..bps].copy_from_slice(got);
                        assert_eq!(u64::from_le_bytes(g), want, "bps={bps} bs={bs} signed={signed}");
                    }
                }
            }
        }
    }

    #[test]
    fn fused_422_matches_two_passes() {
        let src: Vec<u8> = (0..4000u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 24) as u8).collect();
        let mut two = expand_ybr_422(&src, 1).unwrap();
        ybr_full_to_rgb(&mut two);
        assert_eq!(ybr_422_to_rgb(&src).unwrap(), two);
        assert!(ybr_422_to_rgb(&[1, 2]).is_err());
    }

    #[test]
    fn ybr_grey_and_extremes() {
        let mut d = vec![128, 128, 128, 0, 128, 128, 255, 0, 255];
        ybr_full_to_rgb(&mut d);
        assert_eq!(&d[..6], &[128, 128, 128, 0, 0, 0]);
        assert_eq!(d[6], 255);
    }
}
