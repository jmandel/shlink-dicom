//! JPEG-LS decoder (ITU-T T.87 | ISO/IEC 14495-1) for DICOM transfer syntaxes
//! 1.2.840.10008.1.2.4.80 and .81. Owned by the jpeg-ls format agent; see
//! codec-corpus/AGENTS.md and codec-corpus/formats/jpeg-ls/FORMAT.md.
//!
//! Supports lossless and near-lossless coding, interleave modes 0, 1 and 2, 2–16 bit
//! samples, LSE preset parameters (ID 1), mapping tables (ID 2/3, 1–2 byte entries),
//! oversize dimensions (ID 4), restart markers, and the HP colour transforms signalled in
//! an APP8 "mrfx" segment.
#![forbid(unsafe_code)]

mod bits;
mod scan;

use bits::{segment_len, BitReader};
use scan::{default_thresholds, Decoder, Params};
use shl_codec_common::{ColorOut, DecodeError, DecodedFrame, FrameInfo, Result};

fn invalid(m: impl Into<String>) -> DecodeError {
    DecodeError::Invalid(m.into())
}
fn unsupported(m: impl Into<String>) -> DecodeError {
    DecodeError::Unsupported(m.into())
}

struct Reader<'a> {
    d: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn u8(&mut self) -> Result<u8> {
        let b = *self.d.get(self.pos).ok_or_else(|| invalid("unexpected end of codestream"))?;
        self.pos += 1;
        Ok(b)
    }
    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from(self.u8()?) << 8 | u16::from(self.u8()?))
    }
    fn uint(&mut self, n: usize) -> Result<u32> {
        let mut v = 0u32;
        for _ in 0..n {
            v = v << 8 | u32::from(self.u8()?);
        }
        Ok(v)
    }
    /// Marker segment body (after the 2-byte length field).
    fn segment(&mut self) -> Result<&'a [u8]> {
        let len = usize::from(self.u16()?);
        if len < 2 {
            return Err(invalid("marker segment length < 2"));
        }
        let end = self.pos + len - 2;
        let s = self.d.get(self.pos..end).ok_or_else(|| invalid("marker segment overruns codestream"))?;
        self.pos = end;
        Ok(s)
    }
}

struct Component {
    id: u8,
    done: bool,
    table: u8,
}

#[derive(Default, Clone, Copy)]
struct Preset {
    maxval: u16,
    t1: u16,
    t2: u16,
    t3: u16,
    reset: u16,
}

struct Table {
    id: u8,
    width: u8,
    entries: Vec<u32>,
}

/// Decode one frame's codestream. See `shl_codec_common::DecodeFn`.
pub fn decode_frame(codestream: &[u8], info: &FrameInfo) -> Result<DecodedFrame> {
    let frame_bytes = info.frame_bytes().ok_or_else(|| invalid("frame size overflows"))?;
    let out_bytes = match info.bits_allocated {
        8 => 1usize,
        16 => 2,
        32 => 4,
        b => return Err(unsupported(format!("Bits Allocated {b} with JPEG-LS"))),
    };

    let mut r = Reader { d: codestream, pos: 0 };
    if r.u16()? != 0xFFD8 {
        return Err(invalid("missing SOI marker"));
    }

    let mut precision = 0u32;
    let mut width = 0u32;
    let mut height = 0u32;
    let mut comps: Vec<Component> = Vec::new();
    let mut preset = Preset::default();
    let mut tables: Vec<Table> = Vec::new();
    let mut restart = 0u32;
    let mut transform = 0u8;
    let mut have_sof = false;
    // Decoded samples, rows × columns × components, interleaved; allocated at the first scan.
    let mut samples: Vec<u16> = Vec::new();

    loop {
        // Next marker; tolerate fill bytes (repeated 0xFF) before it.
        if r.pos >= codestream.len() && have_sof && comps.iter().all(|c| c.done) {
            break; // missing EOI after a complete image
        }
        if r.u8()? != 0xFF {
            return Err(invalid(format!("expected marker at offset {}", r.pos - 1)));
        }
        let mut m = r.u8()?;
        while m == 0xFF {
            m = r.u8()?;
        }
        match m {
            0xF7 => {
                if have_sof {
                    return Err(invalid("second SOF55"));
                }
                let s = r.segment()?;
                let mut sr = Reader { d: s, pos: 0 };
                precision = u32::from(sr.u8()?);
                height = u32::from(sr.u16()?);
                width = u32::from(sr.u16()?);
                let nf = sr.u8()?;
                if !(2..=16).contains(&precision) {
                    return if precision > 16 && precision <= 32 {
                        Err(unsupported(format!("JPEG-LS precision {precision}")))
                    } else {
                        Err(invalid(format!("JPEG-LS precision {precision}")))
                    };
                }
                if precision > u32::from(info.bits_allocated) {
                    return Err(invalid(format!("precision {precision} exceeds Bits Allocated {}", info.bits_allocated)));
                }
                if nf == 0 || u16::from(nf) != info.samples_per_pixel {
                    return Err(invalid(format!("SOF has {nf} components, Samples per Pixel is {}", info.samples_per_pixel)));
                }
                for _ in 0..nf {
                    let id = sr.u8()?;
                    let hv = sr.u8()?;
                    let _tq = sr.u8()?;
                    if hv != 0x11 {
                        return Err(unsupported("JPEG-LS component subsampling"));
                    }
                    if comps.iter().any(|c| c.id == id) {
                        return Err(invalid("duplicate component id"));
                    }
                    comps.push(Component { id, done: false, table: 0 });
                }
                have_sof = true;
            }
            0xF8 => {
                let s = r.segment()?;
                let mut sr = Reader { d: s, pos: 0 };
                match sr.u8()? {
                    1 => {
                        preset = Preset { maxval: sr.u16()?, t1: sr.u16()?, t2: sr.u16()?, t3: sr.u16()?, reset: sr.u16()? };
                    }
                    id @ (2 | 3) => {
                        let tid = sr.u8()?;
                        let wt = sr.u8()?;
                        if tid == 0 || wt == 0 {
                            return Err(invalid("bad mapping table header"));
                        }
                        if wt > 2 {
                            return Err(unsupported(format!("mapping table entries of {wt} bytes")));
                        }
                        let rest = &s[3..];
                        let mut entries = Vec::with_capacity(rest.len() / usize::from(wt));
                        for e in rest.chunks_exact(usize::from(wt)) {
                            entries.push(e.iter().fold(0u32, |v, &b| v << 8 | u32::from(b)));
                        }
                        match (id, tables.iter_mut().find(|t| t.id == tid)) {
                            (2, Some(_)) => return Err(invalid("mapping table redefined")),
                            (2, None) => tables.push(Table { id: tid, width: wt, entries }),
                            (_, Some(t)) if t.width == wt => t.entries.extend(entries),
                            _ => return Err(invalid("bad mapping table continuation")),
                        }
                    }
                    4 => {
                        let wxy = usize::from(sr.u8()?);
                        if !(2..=4).contains(&wxy) {
                            return Err(invalid("bad LSE dimension size"));
                        }
                        height = sr.uint(wxy)?;
                        width = sr.uint(wxy)?;
                    }
                    id => return Err(invalid(format!("unknown LSE id {id}"))),
                }
            }
            0xDD => {
                let s = r.segment()?;
                if s.is_empty() || s.len() > 4 {
                    return Err(invalid("bad DRI segment"));
                }
                restart = s.iter().fold(0u32, |v, &b| v << 8 | u32::from(b));
            }
            0xDA => {
                if !have_sof {
                    return Err(invalid("SOS before SOF55"));
                }
                if width != info.columns || height != info.rows {
                    return Err(invalid(format!(
                        "codestream is {width}x{height}, dataset says {}x{}",
                        info.columns, info.rows
                    )));
                }
                let s = r.segment()?;
                let mut sr = Reader { d: s, pos: 0 };
                let ns = usize::from(sr.u8()?);
                let mut idx = Vec::with_capacity(ns);
                for _ in 0..ns {
                    let id = sr.u8()?;
                    let tm = sr.u8()?;
                    let i = comps.iter().position(|c| c.id == id).ok_or_else(|| invalid("SOS names unknown component"))?;
                    if comps[i].done || idx.contains(&i) {
                        return Err(invalid("component coded twice"));
                    }
                    comps[i].table = tm;
                    idx.push(i);
                }
                let near = i32::from(sr.u8()?);
                let ilv = sr.u8()?;
                let pt = sr.u8()?;
                if ns == 0 || ilv > 2 || (ilv == 0 && ns != 1) || (ilv == 2 && ns > 4) {
                    return Err(invalid(format!("bad scan: Ns={ns}, ILV={ilv}")));
                }
                if pt & 0x0F != 0 {
                    return Err(unsupported("JPEG-LS point transform"));
                }
                let maxval = if preset.maxval == 0 { (1i32 << precision) - 1 } else { i32::from(preset.maxval) };
                if maxval >= 1 << precision {
                    return Err(invalid("LSE MAXVAL exceeds precision"));
                }
                if near > (maxval / 2).min(255) {
                    return Err(invalid(format!("NEAR {near} too large")));
                }
                let (d1, d2, d3) = default_thresholds(maxval, near);
                let pick = |v: u16, d: i32| if v == 0 { d } else { i32::from(v) };
                let p = Params {
                    maxval,
                    near,
                    t1: pick(preset.t1, d1),
                    t2: pick(preset.t2, d2),
                    t3: pick(preset.t3, d3),
                    reset: pick(preset.reset, 64),
                };
                if !(near < p.t1 && p.t1 <= p.t2 && p.t2 <= p.t3 && p.t3 <= maxval) || p.reset < 3 {
                    return Err(invalid("LSE thresholds out of range"));
                }
                let w = width as usize;
                let h = height as usize;
                let total = w
                    .checked_mul(h)
                    .and_then(|n| n.checked_mul(comps.len()))
                    .ok_or_else(|| invalid("image too large"))?;
                if samples.is_empty() {
                    samples = vec![0u16; total];
                }
                let used = decode_scan(&codestream[r.pos..], &p, ilv, w, h, restart, &idx, comps.len(), &mut samples)?;
                r.pos += used;
                for &i in &idx {
                    comps[i].done = true;
                }
            }
            0xD9 => break,
            0xE0..=0xEF | 0xFE => {
                let s = r.segment()?;
                if m == 0xE8 && s.len() >= 5 && &s[..4] == b"mrfx" {
                    transform = s[4];
                }
            }
            0xD0..=0xD7 => return Err(invalid("restart marker outside scan")),
            0xDC => return Err(unsupported("DNL marker")),
            _ => return Err(invalid(format!("unexpected marker 0xFF{m:02X}"))),
        }
    }

    if !have_sof {
        return Err(invalid("no SOF55 frame header"));
    }
    if let Some(c) = comps.iter().find(|c| !c.done) {
        return Err(invalid(format!("component {} has no scan", c.id)));
    }
    // Mapping tables (T.87 C.2.4.1.2): replace each sample by its table entry.
    let nc = comps.len();
    for (ci, c) in comps.iter().enumerate().filter(|(_, c)| c.table != 0) {
        let t = tables.iter().find(|t| t.id == c.table).ok_or_else(|| invalid("missing mapping table"))?;
        if u32::from(t.width) * 8 > u32::from(info.bits_allocated) {
            return Err(invalid("mapping table entries wider than Bits Allocated"));
        }
        for v in samples.iter_mut().skip(ci).step_by(nc) {
            *v = *t.entries.get(usize::from(*v)).ok_or_else(|| invalid("sample outside mapping table"))? as u16;
        }
    }

    let mut color = ColorOut::AsDeclared;
    if transform != 0 {
        if comps.len() != 3 {
            return Err(invalid("colour transform needs 3 components"));
        }
        inverse_hp(transform, precision, &mut samples)?;
        color = ColorOut::Rgb;
    }

    if samples.len() * out_bytes != frame_bytes {
        return Err(invalid("decoded size does not match frame"));
    }
    let data: Vec<u8> = match out_bytes {
        1 => samples.iter().map(|&v| v as u8).collect(),
        2 => samples.iter().flat_map(|v| v.to_le_bytes()).collect(),
        _ => samples.iter().flat_map(|&v| u32::from(v).to_le_bytes()).collect(),
    };
    Ok(DecodedFrame { data, planar: false, color })
}

/// Inverse HP colour transforms (APP8 "mrfx", as written by HP's encoder and CharLS), on
/// interleaved 3-component samples.
fn inverse_hp(t: u8, precision: u32, samples: &mut [u16]) -> Result<()> {
    if !(1..=3).contains(&t) {
        return Err(unsupported(format!("colour transform {t}")));
    }
    let range = 1i32 << precision;
    let mask = range - 1;
    let half = range / 2;
    for px in samples.chunks_exact_mut(3) {
        let (v1, v2, v3) = (i32::from(px[0]), i32::from(px[1]), i32::from(px[2]));
        let (r, g, bl) = match t {
            1 => (v1 + v2 - half, v2, v3 + v2 - half),
            2 => {
                let r = (v1 + v2 - half) & mask;
                (r, v2, v3 + ((r + v2) >> 1) - half)
            }
            _ => {
                let g = (v1 - ((v3 + v2) >> 2) + range / 4) & mask;
                (v3 + g - half, g, v2 + g - half)
            }
        };
        px[0] = (r & mask) as u16;
        px[1] = (g & mask) as u16;
        px[2] = (bl & mask) as u16;
    }
    Ok(())
}

/// Decode the entropy-coded data of one scan into `out` (rows × columns × `nf` frame
/// components, interleaved). `comp` lists the frame component index of each scan
/// component. `data` starts right after the SOS segment; returns the bytes consumed.
#[allow(clippy::too_many_arguments)]
fn decode_scan(data: &[u8], p: &Params, ilv: u8, w: usize, h: usize, restart: u32, comp: &[usize], nf: usize, out: &mut [u16]) -> Result<usize> {
    let nc = comp.len();
    if comp.iter().any(|&c| c >= nf) || w.checked_mul(h).and_then(|n| n.checked_mul(nf)) != Some(out.len()) {
        return Err(invalid("scan does not fit the frame"));
    }
    // Scan components in frame order covering every component: rows copy straight across.
    let identity = comp.iter().enumerate().all(|(i, &c)| i == c) && nc == nf;
    let mut dec = Decoder::new(p);
    // Line buffers with one guard sample at each end: per component for ILV 0/1, one
    // interleaved buffer for ILV 2.
    let (groups, stride) = if ilv == 2 { (1, nc) } else { (nc, 1) };
    let blen = (w + 2).checked_mul(stride).ok_or_else(|| invalid("image too large"))?;
    let mut prev = vec![vec![0i32; blen]; groups];
    let mut cur = vec![vec![0i32; blen]; groups];
    let mut run_index = vec![0usize; groups];

    let mut pos = 0usize;
    let mut seg = segment_len(data);
    let mut br = BitReader::new(&data[..seg]);
    let mut rst = 0u8;
    for y in 0..h {
        if restart > 0 && y > 0 && y.is_multiple_of(restart as usize) {
            // End of restart interval: skip to the marker, which must be RSTm.
            pos += seg;
            let mut i = pos;
            while data.get(i) == Some(&0xFF) {
                i += 1;
            }
            if i == pos || data.get(i) != Some(&(0xD0 + rst)) {
                return Err(invalid("missing restart marker"));
            }
            pos = i + 1;
            rst = (rst + 1) & 7;
            seg = segment_len(&data[pos..]);
            br = BitReader::new(&data[pos..pos + seg]);
            // A restart re-initialises as at the start of a scan, as CharLS does: contexts,
            // run indices, and the line above the first line of the interval reads as zero.
            dec.reset_contexts();
            run_index.iter_mut().for_each(|r| *r = 0);
            prev.iter_mut().chain(cur.iter_mut()).for_each(|b| b.fill(0));
        }
        for g in 0..groups {
            let (pv, cv) = (&mut prev[g], &mut cur[g]);
            // Edge samples: Rd at the right edge = Rb; Ra at the left edge = Rb, and the
            // left guard of the previous line supplies Rc.
            for c in 0..stride {
                pv[(w + 1) * stride + c] = pv[w * stride + c];
                cv[c] = pv[stride + c];
            }
            match (ilv == 2, p.near == 0) {
                (true, true) => dec.line_ilv2::<true>(&mut br, pv, cv, nc, &mut run_index[g])?,
                (true, false) => dec.line_ilv2::<false>(&mut br, pv, cv, nc, &mut run_index[g])?,
                (false, true) => dec.line::<true>(&mut br, pv, cv, &mut run_index[g])?,
                (false, false) => dec.line::<false>(&mut br, pv, cv, &mut run_index[g])?,
            }
            let row = &mut out[y * w * nf..(y + 1) * w * nf];
            if identity && stride == nf {
                // One interleaved line holding every component (or a single component).
                for (d, &s) in row.iter_mut().zip(&cv[stride..(w + 1) * stride]) {
                    *d = s as u16;
                }
            } else {
                for c in 0..stride {
                    let dst = comp[g + c];
                    for (d, s) in row.iter_mut().skip(dst).step_by(nf).zip(cv[stride + c..].iter().step_by(stride)) {
                        *d = *s as u16;
                    }
                }
            }
            std::mem::swap(pv, cv);
        }
    }
    Ok(pos + seg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use shl_codec_common::Photometric;

    /// CharLS encode of a 1-column, 17-row 8-bit image: all 0 except row 14 = 255.
    const SMALL: &[u8] = &[
        0xff, 0xd8, 0xff, 0xf7, 0x00, 0x0b, 0x08, 0x00, 0x11, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xda, 0x00, 0x08,
        0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0xff, 0x7e, 0x4d, 0x00, 0xff, 0xd9,
    ];
    const SOS_TM: usize = 21;

    fn info(bits_allocated: u16) -> FrameInfo {
        FrameInfo {
            rows: 17,
            columns: 1,
            samples_per_pixel: 1,
            bits_allocated,
            bits_stored: bits_allocated,
            pixel_representation: 0,
            photometric: Photometric::Monochrome2,
            planar_configuration: 0,
            transfer_syntax: "1.2.840.10008.1.2.4.80".into(),
        }
    }

    fn expected() -> Vec<u16> {
        (0..17).map(|i| if i == 14 { 255 } else { 0 }).collect()
    }

    /// Insert an LSE mapping table (ID 2, TID 1, 2-byte entries) before SOS and select it.
    fn with_table(entries: &[u16]) -> Vec<u8> {
        let mut s = SMALL[..15].to_vec();
        let len = 2 + 3 + 2 * entries.len();
        s.extend_from_slice(&[0xFF, 0xF8, (len >> 8) as u8, len as u8, 2, 1, 2]);
        for e in entries {
            s.extend_from_slice(&e.to_be_bytes());
        }
        let tm = s.len() + SOS_TM - 15;
        s.extend_from_slice(&SMALL[15..]);
        s[tm] = 1;
        s
    }

    #[test]
    fn decodes_small_stream() {
        let f = decode_frame(SMALL, &info(8)).unwrap();
        assert_eq!(f.data, expected().iter().map(|&v| v as u8).collect::<Vec<_>>());
        let f = decode_frame(SMALL, &info(16)).unwrap();
        assert_eq!(f.data.len(), 34);
    }

    #[test]
    fn applies_mapping_table() {
        let table: Vec<u16> = (0..256).map(|v| v * 3 + 7).collect();
        let f = decode_frame(&with_table(&table), &info(16)).unwrap();
        let got: Vec<u16> = f.data.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        assert_eq!(got, expected().iter().map(|&v| v * 3 + 7).collect::<Vec<_>>());
        // Index 255 is outside a 10-entry table.
        assert!(matches!(decode_frame(&with_table(&[1; 10]), &info(16)), Err(DecodeError::Invalid(_))));
        // Table entries wider than the output.
        assert!(matches!(decode_frame(&with_table(&table), &info(8)), Err(DecodeError::Invalid(_))));
    }

    #[test]
    fn rejects_malformed() {
        let bad = |d: &[u8], i: &FrameInfo| matches!(decode_frame(d, i), Err(DecodeError::Invalid(_)));
        for n in 0..SMALL.len() - 2 {
            assert!(bad(&SMALL[..n], &info(8)), "truncated at {n}");
        }
        let mut i = info(8);
        i.rows = 16;
        assert!(bad(SMALL, &i), "dimension mismatch");
        let mut d = SMALL.to_vec();
        d[6] = 1; // precision 1
        assert!(bad(&d, &info(8)));
        let mut d = SMALL.to_vec();
        d[6] = 12; // precision 12 > Bits Allocated 8
        assert!(bad(&d, &info(8)));
        let mut d = SMALL.to_vec();
        d[SOS_TM + 1] = 200; // NEAR > MAXVAL/2
        assert!(bad(&d, &info(8)));
        let mut d = SMALL.to_vec();
        d[SOS_TM + 2] = 3; // ILV 3
        assert!(bad(&d, &info(8)));
    }

    #[test]
    fn tolerates_fill_bytes_and_missing_eoi() {
        let mut d = SMALL[..SMALL.len() - 2].to_vec();
        d.extend_from_slice(&[0xFF, 0xFF, 0xFF, 0xD9]);
        assert!(decode_frame(&d, &info(8)).is_ok());
        assert!(decode_frame(&SMALL[..SMALL.len() - 2], &info(8)).is_ok());
    }
}
