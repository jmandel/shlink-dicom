//! Lossless JPEG encoder: T.81 process 14, first-order prediction (selection value 1), point
//! transform 0, one interleaved scan, no restart intervals. This is DICOM's JPEG Lossless SV1
//! (1.2.840.10008.1.2.4.70).
//!
//! Each component gets its own Huffman table, built from that image's difference categories by
//! the procedure of T.81 Annex K.2 (code lengths limited to 16 bits, the all-ones code reserved).
//! The output depends only on the input samples: no timestamps, no randomness, and ties are broken
//! by symbol order, so the same image always gives the same bytes.

use shl_codec_common::{DecodeError, Result};

/// Encode `samples` (rows × columns × `components`, interleaved, each below 2^`precision`) as a
/// lossless JPEG codestream (SOI … EOI). `precision` 2–16; `components` 1–4.
pub fn encode_lossless_sv1(samples: &[u16], columns: u32, rows: u32, components: u8, precision: u8) -> Result<Vec<u8>> {
    let (w, n) = (columns as usize, usize::from(components));
    let count = w.checked_mul(rows as usize).and_then(|x| x.checked_mul(n)).ok_or_else(|| bad("image too large"))?;
    if samples.len() != count {
        return Err(bad("sample count does not match the image size"));
    }
    if precision <= 16 && samples.iter().any(|&s| u32::from(s) >> precision != 0) {
        return Err(bad("a sample does not fit the precision"));
    }
    encode(
        |y, row| {
            let len = row.len();
            row.copy_from_slice(&samples[y * len..(y + 1) * len]);
        },
        columns,
        rows,
        components,
        precision,
    )
}

/// [`encode_lossless_sv1`] from little-endian samples of `bytes_per_sample` (1 or 2) bytes, of
/// which the low `precision` bits are coded: a frame as DICOM stores it, read a row at a time with
/// no copy of the image.
pub fn encode_lossless_sv1_le(frame: &[u8], bytes_per_sample: usize, columns: u32, rows: u32, components: u8, precision: u8) -> Result<Vec<u8>> {
    let (w, n) = (columns as usize, usize::from(components));
    let count = w.checked_mul(rows as usize).and_then(|x| x.checked_mul(n)).ok_or_else(|| bad("image too large"))?;
    if !matches!(bytes_per_sample, 1 | 2) || count.checked_mul(bytes_per_sample) != Some(frame.len()) {
        return Err(bad("frame length does not match the image size"));
    }
    let mask = ((1u32 << precision.min(16)) - 1) as u16;
    if bytes_per_sample == 1 {
        encode(
            |y, row| {
                let len = row.len();
                for (d, &s) in row.iter_mut().zip(&frame[y * len..(y + 1) * len]) {
                    *d = u16::from(s) & mask;
                }
            },
            columns,
            rows,
            components,
            precision,
        )
    } else {
        encode(
            |y, row| {
                let len = row.len();
                let src = &frame[2 * y * len..2 * (y + 1) * len];
                for (d, s) in row.iter_mut().zip(src.chunks_exact(2)) {
                    *d = u16::from_le_bytes([s[0], s[1]]) & mask;
                }
            },
            columns,
            rows,
            components,
            precision,
        )
    }
}

fn bad(m: &str) -> DecodeError {
    DecodeError::Invalid(m.to_string())
}

/// The encoder, reading the image a row at a time through `fill(y, row)` (twice: once to count
/// difference categories, once to code them), so it holds three rows, not the image.
fn encode(fill: impl Fn(usize, &mut [u16]), columns: u32, rows: u32, components: u8, precision: u8) -> Result<Vec<u8>> {
    if !(2..=16).contains(&precision) {
        return Err(bad("lossless JPEG precision must be 2 to 16 bits"));
    }
    if !(1..=4).contains(&components) {
        return Err(bad("lossless JPEG takes 1 to 4 components"));
    }
    if rows == 0 || columns == 0 || rows > 65535 || columns > 65535 {
        return Err(bad("image size must be 1 to 65535 in each direction"));
    }
    let (w, h, n) = (columns as usize, rows as usize, usize::from(components));
    let row_len = w * n;
    let mut prev = vec![0u16; row_len];
    let mut cur = vec![0u16; row_len];
    let mut diffs = vec![0i32; row_len];
    let mut rows_of_diffs = |each: &mut dyn FnMut(&[i32])| {
        for y in 0..h {
            fill(y, &mut cur);
            differences(&cur, (y > 0).then_some(&prev[..]), n, precision, &mut diffs);
            each(&diffs);
            std::mem::swap(&mut prev, &mut cur);
        }
    };

    // Pass 1: difference category counts per component.
    let mut freq = vec![[0u32; 17]; n];
    rows_of_diffs(&mut |row: &[i32]| {
        if n == 1 {
            let f = &mut freq[0];
            for &d in row {
                f[category(d) as usize] += 1;
            }
        } else {
            for px in row.chunks_exact(n) {
                for (f, &d) in freq.iter_mut().zip(px) {
                    f[category(d) as usize] += 1;
                }
            }
        }
    });
    let tables: Vec<Table> = freq.iter().map(Table::build).collect();
    // The coded size is known exactly from the counts (plus rare stuffed bytes).
    let bits: u64 = freq
        .iter()
        .zip(&tables)
        .map(|(f, t)| f.iter().enumerate().map(|(s, &c)| u64::from(c) * (u64::from(t.size[s]) + if s < 16 { s as u64 } else { 0 })).sum::<u64>())
        .sum();
    let coded = (bits / 8) as usize;

    // Headers.
    let mut out = Vec::with_capacity(coded + coded / 128 + 1024);
    out.extend_from_slice(&[0xFF, 0xD8]); // SOI
    for (id, t) in tables.iter().enumerate() {
        let len = 2 + 1 + 16 + t.values.len();
        out.extend_from_slice(&[0xFF, 0xC4]);
        out.extend_from_slice(&(len as u16).to_be_bytes());
        out.push(id as u8); // class 0 (DC / lossless), table id
        out.extend_from_slice(&t.bits);
        out.extend_from_slice(&t.values);
    }
    // SOF3
    out.extend_from_slice(&[0xFF, 0xC3]);
    out.extend_from_slice(&((8 + 3 * n) as u16).to_be_bytes());
    out.push(precision);
    out.extend_from_slice(&(rows as u16).to_be_bytes());
    out.extend_from_slice(&(columns as u16).to_be_bytes());
    out.push(components);
    for c in 0..n {
        out.extend_from_slice(&[c as u8 + 1, 0x11, 0]);
    }
    // SOS: predictor 1 (Ss), Se 0, Ah 0, Al (point transform) 0.
    out.extend_from_slice(&[0xFF, 0xDA]);
    out.extend_from_slice(&((6 + 2 * n) as u16).to_be_bytes());
    out.push(components);
    for c in 0..n {
        out.extend_from_slice(&[c as u8 + 1, (c as u8) << 4]);
    }
    out.extend_from_slice(&[1, 0, 0]);

    // Pass 2: entropy-coded data; each code and its extra bits in one write (at most 16 + 15 bits).
    let mut bw = BitWriter { out, acc: 0, nbits: 0 };
    // Per symbol: the code shifted to make room for its extra bits, and the total length.
    let lut: Vec<[(u32, u32); 17]> = tables
        .iter()
        .map(|t| core::array::from_fn(|s| {
            let extra = if (1..16).contains(&s) { s as u32 } else { 0 };
            (t.code[s] << extra, u32::from(t.size[s]) + extra)
        }))
        .collect();
    let emit = |bw: &mut BitWriter, l: &[(u32, u32); 17], d: i32| {
        let s = category(d);
        let (code, len) = l[s as usize];
        let v = if d < 0 { d - 1 } else { d } as u32 & ((1u32 << s) - 1) & 0x7FFF;
        bw.put(code | if s < 16 { v } else { 0 }, len);
    };
    rows_of_diffs(&mut |row: &[i32]| {
        if n == 1 {
            for &d in row {
                emit(&mut bw, &lut[0], d);
            }
        } else {
            for px in row.chunks_exact(n) {
                for (l, &d) in lut.iter().zip(px) {
                    emit(&mut bw, l, d);
                }
            }
        }
    });
    let mut out = bw.finish();
    out.extend_from_slice(&[0xFF, 0xD9]); // EOI
    Ok(out)
}

/// The SV1 differences of one row (T.81 H.1.2.1): the first samples of the image are predicted by
/// 2^(P−1), the first samples of other rows by the row above (`prev`), all others by the sample to
/// the left. Differences are taken modulo 2^16 into −32767..=32768.
fn differences(row: &[u16], prev: Option<&[u16]>, n: usize, precision: u8, out: &mut [i32]) {
    let wrap = |d: i32| {
        let d = d & 0xFFFF;
        if d > 32768 {
            d - 65536
        } else {
            d
        }
    };
    let start = 1i32 << (precision - 1);
    for c in 0..n {
        let pred = prev.map_or(start, |p| i32::from(p[c]));
        out[c] = wrap(i32::from(row[c]) - pred);
    }
    for ((d, &s), &left) in out[n..].iter_mut().zip(&row[n..]).zip(row) {
        *d = wrap(i32::from(s) - i32::from(left));
    }
}

/// SSSS: the number of bits in |d| (0 for 0, 16 for 32768).
fn category(d: i32) -> u32 {
    32 - d.unsigned_abs().leading_zeros()
}

struct Table {
    /// BITS: number of codes of each length 1..=16.
    bits: [u8; 16],
    /// HUFFVAL: symbols in code order.
    values: Vec<u8>,
    code: [u32; 17],
    size: [u8; 17],
}

impl Table {
    /// T.81 Annex K.2 (Figures K.1–K.4): code sizes by repeatedly merging the two least frequent
    /// entries (with a reserved symbol of count 1 so no code is all ones), lengths above 16 moved
    /// down, then codes assigned in order of length and symbol.
    fn build(freq: &[u32; 17]) -> Self {
        const RESERVED: usize = 17;
        let mut f = [0u64; 18];
        for (k, &v) in freq.iter().enumerate() {
            f[k] = u64::from(v);
        }
        f[RESERVED] = 1;
        let mut codesize = [0u32; 18];
        let mut others = [usize::MAX; 18];
        loop {
            // V1: least frequency, the larger symbol on ties; V2: next least, likewise (libjpeg's jchuff.c).
            let mut v1 = usize::MAX;
            for k in 0..18 {
                if f[k] > 0 && (v1 == usize::MAX || f[k] <= f[v1]) {
                    v1 = k;
                }
            }
            let mut v2 = usize::MAX;
            for k in 0..18 {
                if f[k] > 0 && k != v1 && (v2 == usize::MAX || f[k] <= f[v2]) {
                    v2 = k;
                }
            }
            if v2 == usize::MAX {
                break;
            }
            f[v1] += f[v2];
            f[v2] = 0;
            let mut k = v1;
            loop {
                codesize[k] += 1;
                if others[k] == usize::MAX {
                    break;
                }
                k = others[k];
            }
            others[k] = v2;
            let mut k = v2;
            loop {
                codesize[k] += 1;
                if others[k] == usize::MAX {
                    break;
                }
                k = others[k];
            }
        }
        // K.2 Figure K.2: count codes per size (up to 32 here), then Figure K.3: limit to 16.
        let mut bits = [0u32; 33];
        for &s in &codesize {
            if s > 0 {
                bits[s as usize] += 1;
            }
        }
        let mut i = 32;
        while i > 16 {
            while bits[i] > 0 {
                let mut j = i - 2;
                while bits[j] == 0 {
                    j -= 1;
                }
                bits[i] -= 2;
                bits[i - 1] += 1;
                bits[j + 1] += 2;
                bits[j] -= 1;
            }
            i -= 1;
        }
        // Remove the reserved code (the longest).
        let mut i = 16;
        while bits[i] == 0 {
            i -= 1;
        }
        bits[i] -= 1;
        // K.2 Figure K.4: symbols sorted by code size, then by value.
        let mut values = Vec::new();
        for len in 1..=32u32 {
            for (sym, &s) in codesize.iter().enumerate().take(17) {
                if s == len {
                    values.push(sym as u8);
                }
            }
        }
        let mut out_bits = [0u8; 16];
        for (k, b) in out_bits.iter_mut().enumerate() {
            *b = bits[k + 1] as u8;
        }
        // Canonical codes (C.1–C.2), and the per-symbol lookup.
        let (mut code, mut size) = ([0u32; 17], [0u8; 17]);
        let mut next = 0u32;
        let mut k = 0usize;
        for len in 1..=16u8 {
            for _ in 0..out_bits[usize::from(len) - 1] {
                let sym = usize::from(values[k]);
                code[sym] = next;
                size[sym] = len;
                next += 1;
                k += 1;
            }
            next <<= 1;
        }
        Self { bits: out_bits, values, code, size }
    }
}

/// Big-endian bit writer with 0xFF byte stuffing (T.81 F.1.2.3).
struct BitWriter {
    out: Vec<u8>,
    acc: u64,
    nbits: u32,
}

impl BitWriter {
    /// Append the low `n` bits of `bits` (n at most 32).
    #[inline]
    fn put(&mut self, bits: u32, n: u32) {
        if n == 0 {
            return;
        }
        let bits = u64::from(bits) & ((1u64 << n) - 1);
        self.acc = (self.acc << n) | bits;
        self.nbits += n;
        if self.nbits >= 32 {
            self.nbits -= 32;
            let word = (self.acc >> self.nbits) as u32;
            let bytes = word.to_be_bytes();
            if bytes.contains(&0xFF) {
                for b in bytes {
                    self.out.push(b);
                    if b == 0xFF {
                        self.out.push(0);
                    }
                }
            } else {
                self.out.extend_from_slice(&bytes);
            }
        }
    }

    /// Pad the last byte with 1 bits (F.1.2.3) and flush.
    fn finish(mut self) -> Vec<u8> {
        let pad = (8 - self.nbits % 8) % 8;
        self.put((1u32 << pad) - 1, pad);
        while self.nbits >= 8 {
            self.nbits -= 8;
            let b = (self.acc >> self.nbits) as u8;
            self.out.push(b);
            if b == 0xFF {
                self.out.push(0);
            }
        }
        self.out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use shl_codec_common::{FrameInfo, Photometric};

    fn roundtrip(samples: &[u16], w: u32, h: u32, n: u8, p: u8) {
        let cs = encode_lossless_sv1(samples, w, h, n, p).unwrap();
        let info = FrameInfo {
            rows: h,
            columns: w,
            samples_per_pixel: u16::from(n),
            bits_allocated: if p > 8 { 16 } else { 8 },
            bits_stored: u16::from(p),
            pixel_representation: 0,
            photometric: if n == 3 { Photometric::Rgb } else { Photometric::Monochrome2 },
            planar_configuration: 0,
            transfer_syntax: "1.2.840.10008.1.2.4.70".into(),
        };
        let d = crate::decode_frame(&cs, &info).unwrap();
        let got: Vec<u16> = if p > 8 {
            d.data.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect()
        } else {
            d.data.iter().map(|&b| u16::from(b)).collect()
        };
        assert_eq!(got, samples, "precision {p}, {n} components");
        assert_eq!(cs, encode_lossless_sv1(samples, w, h, n, p).unwrap(), "deterministic");
    }

    #[test]
    fn round_trips_every_precision_and_extreme_differences() {
        let mut x: u32 = 12345;
        for p in 2..=16u8 {
            for n in [1u8, 3] {
                let (w, h) = (37u32, 23u32);
                let mask = (1u32 << p) - 1;
                let s: Vec<u16> = (0..w * h * u32::from(n))
                    .map(|i| {
                        x = x.wrapping_mul(1_103_515_245).wrapping_add(12345);
                        // Alternate extremes (largest differences, SSSS 16 at 16 bits) and noise.
                        (if i % 7 < 2 { if i % 2 == 0 { 0 } else { mask } } else { x >> 7 & mask }) as u16
                    })
                    .collect();
                roundtrip(&s, w, h, n, p);
            }
        }
    }

    #[test]
    fn flat_and_tiny_images() {
        roundtrip(&[5], 1, 1, 1, 8);
        roundtrip(&[0; 64 * 3], 8, 8, 3, 8);
        roundtrip(&[65535; 10], 10, 1, 1, 16);
    }
}
