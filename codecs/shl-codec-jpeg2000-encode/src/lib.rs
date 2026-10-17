//! Lossless JPEG 2000 Part 1 encoder (DICOM 1.2.840.10008.1.2.4.90).
//!
//! The codestream: one tile, reversible 5/3 wavelet with up to 5 decomposition levels (fewer for
//! small images), no multi-component transform (each component coded on its own, so RGB stays
//! RGB), no quantization, 64 × 64 code-blocks with the default style, one quality layer holding
//! every coding pass, LRCP progression, default precincts. Tier-1 is EBCOT with the MQ coder
//! (T.800 Annex C, D), tier-2 writes packet headers with tag trees (Annex B).
//!
//! The output depends only on the input samples: no rate control, no randomness, no threads that
//! could change it.
#![forbid(unsafe_code)]

mod dwt;
mod mq;
mod t1;
mod t2;

use shl_codec_common::{DecodeError, Result};
use t1::{Orient, T1};
use t2::{BitWriter, TagTree};

/// Decomposition levels used when the image is large enough.
pub const DEFAULT_LEVELS: u32 = 5;
const CB: usize = 64;

fn bad(m: &str) -> DecodeError {
    DecodeError::Invalid(m.to_string())
}

struct Block {
    /// Coding passes; 0 for an all-zero block, which no packet includes.
    passes: u32,
    bitplanes: u32,
    data: Vec<u8>,
}

struct Band {
    /// Gain in bits (log2 of the band's nominal gain, T.800 Table E.1): 0, 1 or 2.
    gain: u32,
    /// Code-block grid.
    bw: usize,
    bh: usize,
    blocks: Vec<Block>,
}

/// Encode `samples` (rows × columns × `components`, interleaved) losslessly. `precision` is the
/// component bit depth (1–16); with `signed` the samples are two's complement values in
/// −2^(P−1)..2^(P−1), otherwise 0..2^P.
pub fn encode_lossless(samples: &[i32], columns: u32, rows: u32, components: u16, precision: u8, signed: bool) -> Result<Vec<u8>> {
    if !(1..=16).contains(&precision) {
        return Err(bad("precision must be 1 to 16 bits"));
    }
    if !(1..=4).contains(&components) {
        return Err(bad("1 to 4 components"));
    }
    if rows == 0 || columns == 0 || rows > 32768 || columns > 32768 {
        return Err(bad("each dimension must be 1 to 32768 (one precinct per resolution)"));
    }
    let (w, h, n) = (columns as usize, rows as usize, usize::from(components));
    let count = w.checked_mul(h).and_then(|x| x.checked_mul(n)).ok_or_else(|| bad("image too large"))?;
    if samples.len() != count {
        return Err(bad("sample count does not match the image size"));
    }
    let (lo, hi) = if signed { (-(1i32 << (precision - 1)), (1i32 << (precision - 1)) - 1) } else { (0, (1i32 << precision) - 1) };
    if samples.iter().any(|&s| s < lo || s > hi) {
        return Err(bad("a sample does not fit the precision"));
    }
    // Levels: each must leave both bands non-empty in both directions.
    let min_dim = w.min(h) as u32;
    let levels = DEFAULT_LEVELS.min(31 - min_dim.leading_zeros());
    let shift = if signed { 0 } else { 1i32 << (precision - 1) };

    // Per component: DC level shift, wavelet, code-blocks.
    let mut t1 = T1::new();
    let mut comps: Vec<Vec<Band>> = Vec::with_capacity(n);
    let mut buf = vec![0i32; w * h];
    for c in 0..n {
        for (dst, &s) in buf.iter_mut().zip(samples.iter().skip(c).step_by(n)) {
            *dst = s - shift;
        }
        dwt::forward(&mut buf, w, w, h, levels);
        comps.push(code_bands(&buf, w, h, levels, &mut t1));
    }

    // Guard bits: enough for the largest coefficient of every band (Mb = G + ε_b − 1, ε_b = P + gain).
    let p = u32::from(precision);
    let mut guard = 2u32;
    for band in comps.iter().flatten() {
        for b in &band.blocks {
            if b.passes > 0 {
                guard = guard.max(b.bitplanes + 1 - (p + band.gain).min(b.bitplanes + 1));
            }
        }
    }
    if guard > 7 {
        return Err(bad("coefficients exceed what 7 guard bits can signal"));
    }

    let mut out = Vec::with_capacity(count * 2);
    out.extend_from_slice(&[0xFF, 0x4F]); // SOC
    // SIZ
    out.extend_from_slice(&[0xFF, 0x51]);
    out.extend_from_slice(&(38 + 3 * components).to_be_bytes());
    out.extend_from_slice(&0u16.to_be_bytes()); // Rsiz: Part 1, no restrictions claimed
    for v in [columns, rows, 0, 0, columns, rows, 0, 0] {
        out.extend_from_slice(&v.to_be_bytes());
    }
    out.extend_from_slice(&components.to_be_bytes());
    for _ in 0..n {
        out.extend_from_slice(&[(u8::from(signed) << 7) | (precision - 1), 1, 1]);
    }
    // COD: default precincts, LRCP, one layer, no MCT; levels, 64 × 64 blocks, style 0, 5/3.
    out.extend_from_slice(&[0xFF, 0x52, 0, 12, 0, 0, 0, 1, 0, levels as u8, 4, 4, 0, 1]);
    // QCD: no quantization, guard bits, ε_b << 3 per band (LL, then HL LH HH per level).
    let nb = 1 + 3 * levels as usize;
    out.extend_from_slice(&[0xFF, 0x5C]);
    out.extend_from_slice(&((3 + nb) as u16).to_be_bytes());
    out.push((guard << 5) as u8);
    out.push((p << 3) as u8);
    for _ in 0..levels {
        out.extend_from_slice(&[((p + 1) << 3) as u8, ((p + 1) << 3) as u8, ((p + 2) << 3) as u8]);
    }
    // SOT (Psot patched below), SOD, packets.
    let sot = out.len();
    out.extend_from_slice(&[0xFF, 0x90, 0, 10, 0, 0, 0, 0, 0, 0, 0, 1]);
    out.extend_from_slice(&[0xFF, 0x93]);
    for r in 0..=levels as usize {
        for bands in &comps {
            let range = if r == 0 { 0..1 } else { 1 + 3 * (r - 1)..1 + 3 * r };
            packet(&mut out, &bands[range], p, guard);
        }
    }
    let psot = u32::try_from(out.len() - sot).map_err(|_| bad("tile-part longer than 4 GiB"))?;
    out[sot + 6..sot + 10].copy_from_slice(&psot.to_be_bytes());
    out.extend_from_slice(&[0xFF, 0xD9]); // EOC
    Ok(out)
}

/// The bands of one transformed component in packet order: LL, then HL, LH, HH from the lowest
/// resolution up, each split into coded code-blocks. Outside wasm the code-blocks of a large
/// component are coded on several threads; each block is coded alone, so the output is the same.
fn code_bands(buf: &[i32], w: usize, h: usize, levels: u32, t1: &mut T1) -> Vec<Band> {
    // Region sizes: sizes[d] is the low-pass region after d levels.
    let mut sizes = vec![(w, h)];
    for _ in 0..levels {
        let (cw, ch) = *sizes.last().unwrap_or(&(w, h));
        sizes.push((cw.div_ceil(2), ch.div_ceil(2)));
    }
    // (x0, y0, width, height, orientation, gain) of each band.
    let mut geo = Vec::with_capacity(1 + 3 * levels as usize);
    let (lw, lh) = sizes[levels as usize];
    geo.push((0, 0, lw, lh, Orient::LlLh, 0));
    for d in (1..=levels as usize).rev() {
        let (cw, ch) = sizes[d - 1];
        let (lw, lh) = sizes[d];
        geo.push((lw, 0, cw - lw, lh, Orient::Hl, 1));
        geo.push((0, lh, lw, ch - lh, Orient::LlLh, 1));
        geo.push((lw, lh, cw - lw, ch - lh, Orient::Hh, 2));
    }
    // Every code-block: (x, y, width, height, orientation).
    let mut jobs = Vec::new();
    for &(x0, y0, bw, bh, orient, _) in &geo {
        for by in 0..bh.div_ceil(CB) {
            for bx in 0..bw.div_ceil(CB) {
                jobs.push((x0 + bx * CB, y0 + by * CB, CB.min(bw - bx * CB), CB.min(bh - by * CB), orient));
            }
        }
    }
    let code = |t1: &mut T1, &(x, y, cw, ch, orient): &(usize, usize, usize, usize, Orient)| match t1.code(&buf[y * w + x..], w, cw, ch, orient) {
        None => Block { passes: 0, bitplanes: 0, data: Vec::new() },
        Some(c) => Block { passes: c.passes, bitplanes: c.bitplanes, data: t1.mq.finish().to_vec() },
    };
    // One thread per 256 × 256 pixels of the component.
    let threads = shl_codec_common::parallel::threads(w * h / (256 * 256));
    let mut blocks: Vec<Block> = if threads > 1 {
        shl_codec_common::parallel::map_chunks(&jobs, threads, T1::new, |t1, j| code(t1, j))
    } else {
        jobs.iter().map(|j| code(t1, j)).collect()
    };
    let mut bands = Vec::with_capacity(geo.len());
    for &(_, _, bw, bh, _, gain) in geo.iter().rev() {
        let n = bw.div_ceil(CB) * bh.div_ceil(CB);
        let rest = blocks.split_off(blocks.len() - n);
        bands.push(Band { gain, bw: bw.div_ceil(CB), bh: bh.div_ceil(CB), blocks: rest });
    }
    bands.reverse();
    bands
}

/// Number-of-passes codeword (Table B.4).
fn write_passes(bw: &mut BitWriter<'_>, n: u32) {
    match n {
        1 => bw.bit(0),
        2 => bw.bits(0b10, 2),
        3..=5 => bw.bits(0b1100 | (n - 3), 4),
        6..=36 => {
            bw.bits(0b1111, 4);
            bw.bits(n - 6, 5);
        }
        _ => {
            bw.bits(0x1FF, 9);
            bw.bits(n - 37, 7);
        }
    }
}

/// One packet: layer 0 of one resolution of one component, one precinct (B.9, B.10).
fn packet(out: &mut Vec<u8>, bands: &[Band], p: u32, guard: u32) {
    let any = bands.iter().any(|b| b.blocks.iter().any(|k| k.passes > 0));
    let mut bw = BitWriter::new(out);
    if !any {
        bw.bit(0);
        bw.finish();
        return;
    }
    bw.bit(1);
    for band in bands.iter() {
        if band.blocks.is_empty() {
            continue;
        }
        let mb = guard + p + band.gain - 1;
        let incl: Vec<u32> = band.blocks.iter().map(|b| u32::from(b.passes == 0)).collect();
        let zbp: Vec<u32> = band.blocks.iter().map(|b| if b.passes > 0 { mb - b.bitplanes } else { mb }).collect();
        let mut incl_tree = TagTree::new(band.bw, band.bh, &incl);
        let mut zbp_tree = TagTree::new(band.bw, band.bh, &zbp);
        for (k, b) in band.blocks.iter().enumerate() {
            let (x, y) = (k % band.bw, k / band.bw);
            incl_tree.encode(&mut bw, x, y, 1);
            if b.passes == 0 {
                continue;
            }
            zbp_tree.encode(&mut bw, x, y, u32::MAX);
            write_passes(&mut bw, b.passes);
            // Lblock starts at 3; the length takes Lblock + ⌊log2(passes)⌋ bits (B.10.7.1).
            let lblock = 3u32;
            let len = b.data.len() as u32;
            let need = 32 - len.leading_zeros();
            let have = lblock + (31 - b.passes.leading_zeros());
            let inc = need.saturating_sub(have);
            for _ in 0..inc {
                bw.bit(1);
            }
            bw.bit(0);
            bw.bits(len, have + inc);
        }
    }
    bw.finish();
    for band in bands.iter() {
        for b in &band.blocks {
            out.extend_from_slice(&b.data);
        }
    }
}

#[cfg(test)]
mod tests;
