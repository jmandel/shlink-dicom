//! Codestream syntax (T.800 Annex A): the main header, tile-part headers and the packet data of
//! each tile, with every parameter resolved per tile and component.

use crate::error::{invalid, unsupported, Result};
use crate::mct2::Part2Header;

/// SIZ component parameters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ComponentSize {
    /// Bit depth, 1–38.
    pub precision: u8,
    pub signed: bool,
    pub dx: u8,
    pub dy: u8,
}

/// SIZ (A.5.1).
#[derive(Debug, Clone)]
pub struct Size {
    pub rsiz: u16,
    pub x1: u32,
    pub y1: u32,
    pub x0: u32,
    pub y0: u32,
    pub tw: u32,
    pub th: u32,
    pub tx0: u32,
    pub ty0: u32,
    pub components: Vec<ComponentSize>,
}

impl Size {
    pub fn tiles_x(&self) -> u32 {
        (self.x1 - self.tx0).div_ceil(self.tw)
    }
    pub fn tiles_y(&self) -> u32 {
        (self.y1 - self.ty0).div_ceil(self.th)
    }
}

/// Code-block style flags (Table A.19).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BlockStyle {
    pub bypass: bool,
    pub reset: bool,
    pub termall: bool,
    pub causal: bool,
    pub predictable: bool,
    pub segmark: bool,
    /// T.814: HT code-blocks (bit 6), and bit 7 (MIXED) when set together.
    pub ht: bool,
    pub mixed: bool,
}

impl BlockStyle {
    fn parse(b: u8) -> Self {
        Self {
            bypass: b & 1 != 0,
            reset: b & 2 != 0,
            termall: b & 4 != 0,
            causal: b & 8 != 0,
            predictable: b & 16 != 0,
            segmark: b & 32 != 0,
            ht: b & 64 != 0,
            mixed: b & 128 != 0,
        }
    }
}

/// The SPcod/SPcoc part of a coding style: per component.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComponentCoding {
    pub levels: u8,
    /// Code-block width and height exponents (xcb, ycb).
    pub cbw: u8,
    pub cbh: u8,
    pub style: BlockStyle,
    /// 5/3 reversible (true) or 9/7 irreversible.
    pub reversible: bool,
    /// (PPx, PPy) for each resolution, lowest first.
    pub precincts: Vec<(u8, u8)>,
}

/// Quantization (QCD/QCC, A.6.4–A.6.5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Quantization {
    /// 0 none, 1 scalar derived, 2 scalar expounded.
    pub style: u8,
    pub guard: u8,
    /// (exponent, mantissa) per sub-band, in the order of the marker (one entry when derived).
    pub steps: Vec<(u8, u16)>,
}

impl Quantization {
    /// (exponent, mantissa) of sub-band `band` (0 = LL; 1 + 3·(r−1) + o for resolution r ≥ 1 and
    /// orientation o of HL, LH, HH) of a component with `levels` decomposition levels.
    pub fn step(&self, band: usize, levels: u8) -> Result<(u8, u16)> {
        if self.style == 1 {
            // Derived (E-5): ε_b = ε_0 − N_L + n_b, n_b the level of the sub-band.
            let (e0, m) = *self.steps.first().ok_or_else(|| invalid("QCD without a step"))?;
            let nb = if band == 0 { i32::from(levels) } else { i32::from(levels) - ((band as i32 - 1) / 3) };
            let e = i32::from(e0) - i32::from(levels) + nb;
            if !(0..=31).contains(&e) {
                return Err(invalid("derived quantization exponent out of range"));
            }
            return Ok((e as u8, m));
        }
        self.steps.get(band).copied().ok_or_else(|| invalid("quantization has fewer steps than sub-bands"))
    }
}

/// A progression order change (POC entry, A.6.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProgressionChange {
    pub rs: u8,
    pub cs: u16,
    pub lye: u16,
    pub re: u8,
    pub ce: u16,
    pub order: u8,
}

/// Coding parameters of the whole image or one tile (COD + COC overrides).
#[derive(Debug, Clone, Default)]
struct Coding {
    /// Scod: SOP, EPH; SGcod: progression, layers, MCT.
    cod: Option<(bool, bool, u8, u16, u8, ComponentCoding)>,
    coc: Vec<Option<ComponentCoding>>,
    qcd: Option<Quantization>,
    qcc: Vec<Option<Quantization>>,
    poc: Vec<ProgressionChange>,
}

/// Everything decoding one tile needs.
#[derive(Debug, Clone)]
pub struct TileParams {
    pub sop: bool,
    pub eph: bool,
    pub progression: u8,
    pub layers: u16,
    pub mct: u8,
    pub components: Vec<ComponentCoding>,
    pub quantization: Vec<Quantization>,
    pub poc: Vec<ProgressionChange>,
}

/// One tile-part: its packet data and, when packet headers are packed into PPM or PPT marker
/// segments (A.7.4, A.7.5), those headers.
#[derive(Debug)]
pub struct TilePart<'a> {
    pub body: &'a [u8],
    pub headers: Option<Vec<u8>>,
}

/// One tile: its index, parameters and tile-parts in codestream order.
#[derive(Debug)]
pub struct Tile<'a> {
    pub index: u32,
    pub params: TileParams,
    pub parts: Vec<TilePart<'a>>,
}

/// A parsed codestream.
#[derive(Debug)]
pub struct Codestream<'a> {
    pub size: Size,
    pub tiles: Vec<Tile<'a>>,
    /// Part 2 multiple component transformation, when present.
    pub part2: Option<Part2Header>,
    /// T.814 Ccap15 from CAP, when Pcap signals Part 15 (HTJ2K).
    pub ccap15: Option<u16>,
}

struct Reader<'a> {
    b: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn u8(&mut self) -> Result<u8> {
        let v = *self.b.get(self.pos).ok_or_else(|| invalid("truncated marker segment"))?;
        self.pos += 1;
        Ok(v)
    }
    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from(self.u8()?) << 8 | u16::from(self.u8()?))
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from(self.u16()?) << 16 | u32::from(self.u16()?))
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.pos.checked_add(n).filter(|&e| e <= self.b.len()).ok_or_else(|| invalid("truncated marker segment"))?;
        let s = &self.b[self.pos..end];
        self.pos = end;
        Ok(s)
    }
    fn rest(&self) -> &'a [u8] {
        &self.b[self.pos.min(self.b.len())..]
    }
}

fn parse_siz(seg: &[u8]) -> Result<Size> {
    let mut r = Reader { b: seg, pos: 0 };
    let rsiz = r.u16()?;
    let (x1, y1, x0, y0) = (r.u32()?, r.u32()?, r.u32()?, r.u32()?);
    let (tw, th, tx0, ty0) = (r.u32()?, r.u32()?, r.u32()?, r.u32()?);
    let n = r.u16()?;
    if n == 0 || n > 16384 {
        return Err(invalid(format!("{n} components")));
    }
    let mut components = Vec::with_capacity(usize::from(n));
    for _ in 0..n {
        let s = r.u8()?;
        let (dx, dy) = (r.u8()?, r.u8()?);
        let precision = (s & 0x7F) + 1;
        if precision > 38 {
            return Err(invalid(format!("component precision {precision}")));
        }
        if dx == 0 || dy == 0 {
            return Err(invalid("component subsampling 0"));
        }
        components.push(ComponentSize { precision, signed: s & 0x80 != 0, dx, dy });
    }
    if x1 <= x0 || y1 <= y0 {
        return Err(invalid("empty image area"));
    }
    if tw == 0 || th == 0 || tx0 > x0 || ty0 > y0 || tx0.checked_add(tw).is_none_or(|e| e <= x0) || ty0.checked_add(th).is_none_or(|e| e <= y0) {
        return Err(invalid("tile grid does not cover the image"));
    }
    Ok(Size { rsiz, x1, y1, x0, y0, tw, th, tx0, ty0, components })
}

fn parse_sp(r: &mut Reader<'_>, precincts_defined: bool) -> Result<ComponentCoding> {
    let levels = r.u8()?;
    if levels > 32 {
        return Err(invalid(format!("{levels} decomposition levels")));
    }
    let (cbw, cbh) = (r.u8()?.saturating_add(2), r.u8()?.saturating_add(2));
    if cbw > 10 || cbh > 10 || cbw + cbh > 12 {
        return Err(invalid("code-block size"));
    }
    let style = BlockStyle::parse(r.u8()?);
    let reversible = match r.u8()? {
        0 => false,
        1 => true,
        t => return Err(unsupported(format!("wavelet transform {t} (Part 2 kernels)"))),
    };
    let precincts = if precincts_defined {
        (0..=levels)
            .map(|res| {
                let v = r.u8()?;
                let (px, py) = (v & 15, v >> 4);
                if res > 0 && (px == 0 || py == 0) {
                    return Err(invalid("precinct size 1 at a resolution above 0"));
                }
                Ok((px, py))
            })
            .collect::<Result<Vec<_>>>()?
    } else {
        vec![(15, 15); usize::from(levels) + 1]
    };
    Ok(ComponentCoding { levels, cbw, cbh, style, reversible, precincts })
}

fn parse_quant(r: &mut Reader<'_>) -> Result<Quantization> {
    let s = r.u8()?;
    let (style, guard) = (s & 0x1F, s >> 5);
    let mut steps = Vec::new();
    match style {
        0 => {
            while !r.rest().is_empty() {
                steps.push((r.u8()? >> 3, 0));
            }
        }
        1 | 2 => {
            while r.rest().len() >= 2 {
                let v = r.u16()?;
                steps.push(((v >> 11) as u8, v & 0x7FF));
            }
        }
        _ => return Err(invalid(format!("quantization style {style}"))),
    }
    if steps.is_empty() {
        return Err(invalid("quantization without steps"));
    }
    Ok(Quantization { style, guard, steps })
}

fn component_index(r: &mut Reader<'_>, n: usize) -> Result<usize> {
    let c = if n < 257 { usize::from(r.u8()?) } else { usize::from(r.u16()?) };
    if c >= n {
        return Err(invalid(format!("component {c} of {n}")));
    }
    Ok(c)
}

/// Apply one coding marker segment (COD, COC, QCD, QCC, POC, RGN) to `c`.
fn coding_marker(c: &mut Coding, marker: u8, seg: &[u8], n: usize) -> Result<()> {
    let mut r = Reader { b: seg, pos: 0 };
    match marker {
        0x52 => {
            let scod = r.u8()?;
            let (progression, layers, mct) = (r.u8()?, r.u16()?, r.u8()?);
            if progression > 4 {
                return Err(invalid(format!("progression order {progression}")));
            }
            if layers == 0 {
                return Err(invalid("0 layers"));
            }
            let sp = parse_sp(&mut r, scod & 1 != 0)?;
            c.cod = Some((scod & 2 != 0, scod & 4 != 0, progression, layers, mct, sp));
        }
        0x53 => {
            let ci = component_index(&mut r, n)?;
            let scoc = r.u8()?;
            c.coc[ci] = Some(parse_sp(&mut r, scoc & 1 != 0)?);
        }
        0x5C => c.qcd = Some(parse_quant(&mut r)?),
        0x5D => {
            let ci = component_index(&mut r, n)?;
            c.qcc[ci] = Some(parse_quant(&mut r)?);
        }
        0x5F => {
            let wide = n >= 257;
            let entry = if wide { 9 } else { 7 };
            if seg.is_empty() || !seg.len().is_multiple_of(entry) {
                return Err(invalid("POC length"));
            }
            for _ in 0..seg.len() / entry {
                let rs = r.u8()?;
                let cs = if wide { r.u16()? } else { u16::from(r.u8()?) };
                let lye = r.u16()?;
                let re = r.u8()?;
                let ce = if wide { r.u16()? } else { u16::from(r.u8()?) };
                let order = r.u8()?;
                if order > 4 {
                    return Err(invalid(format!("POC progression order {order}")));
                }
                c.poc.push(ProgressionChange { rs, cs, lye, re, ce: if ce == 0 && !wide { 256 } else { ce }, order });
            }
        }
        0x5E => return Err(unsupported("region of interest (RGN)")),
        _ => {}
    }
    Ok(())
}

/// Parse a raw codestream (SOC … EOC).
pub fn parse(b: &[u8]) -> Result<Codestream<'_>> {
    if b.get(..4) != Some(&[0xFF, 0x4F, 0xFF, 0x51]) {
        return Err(invalid("no SOC + SIZ at the start"));
    }
    let seg_at = |pos: usize| -> Result<(u8, &[u8], usize)> {
        let m = *b.get(pos + 1).ok_or_else(|| invalid("truncated main header"))?;
        if b[pos] != 0xFF {
            return Err(invalid(format!("expected a marker at offset {pos}")));
        }
        let len = b.get(pos + 2..pos + 4).map(|s| usize::from(u16::from_be_bytes([s[0], s[1]]))).ok_or_else(|| invalid("truncated marker"))?;
        if len < 2 {
            return Err(invalid("marker segment length < 2"));
        }
        let seg = b.get(pos + 4..pos + 2 + len).ok_or_else(|| invalid("truncated marker segment"))?;
        Ok((m, seg, pos + 2 + len))
    };
    let (_, siz_seg, mut pos) = seg_at(2)?;
    let size = parse_siz(siz_seg)?;
    let n = size.components.len();
    if size.rsiz & 0x4000 != 0 && size.rsiz & 0x3FFF != 0 {
        // Part 15 with some other capability: decoded only as far as the markers allow.
    }
    let mut main = Coding { coc: vec![None; n], qcc: vec![None; n], ..Default::default() };
    let mut ppm: Vec<(u8, &[u8])> = Vec::new();
    let mut part2: Option<Part2Header> = None;
    let mut ccap15 = None;
    // Main header.
    loop {
        let (m, seg, next) = seg_at(pos)?;
        match m {
            0x90 => break, // SOT
            0x52 | 0x53 | 0x5C | 0x5D | 0x5F | 0x5E => coding_marker(&mut main, m, seg, n)?,
            0x60 => {
                let z = *seg.first().ok_or_else(|| invalid("empty PPM"))?;
                ppm.push((z, &seg[1..]));
            }
            0x50 => {
                // CAP: Pcap bit 15 (from MSB, i.e. Part 15) signals HTJ2K.
                let pcap = seg.get(..4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]])).unwrap_or(0);
                if pcap & (1 << (32 - 15)) != 0 {
                    // One Ccap per set Pcap bit, in bit order; Part 15's is the first unless
                    // bits 1–14 are set too.
                    let before = (pcap >> (32 - 14)).count_ones() as usize;
                    let at = 4 + 2 * before;
                    ccap15 = Some(seg.get(at..at + 2).map(|s| u16::from_be_bytes([s[0], s[1]])).unwrap_or(0));
                }
            }
            // MCT, MCC, MCO, CBD (T.801 Annex J).
            0x74 => part2.get_or_insert_with(Part2Header::default).read_mct(seg)?,
            0x75 => part2.get_or_insert_with(Part2Header::default).read_mcc(seg)?,
            0x77 => part2.get_or_insert_with(Part2Header::default).read_mco(seg)?,
            0x78 => part2.get_or_insert_with(Part2Header::default).read_cbd(seg)?,
            0x51 | 0x4F | 0x93 | 0xD9 => return Err(invalid(format!("marker FF{m:02X} in the main header"))),
            _ => {} // TLM, PLM, CRG, COM, CPF, and unknown segments
        }
        pos = next;
    }
    if main.cod.is_none() || main.qcd.is_none() {
        return Err(invalid("main header without COD or QCD"));
    }
    if part2.is_some() && size.rsiz & 0x8000 == 0 {
        return Err(unsupported("multiple component transformation markers in a Part 1 codestream"));
    }

    // Tile-parts.
    let ntiles = u64::from(size.tiles_x()) * u64::from(size.tiles_y());
    if ntiles > 65535 {
        return Err(invalid(format!("{ntiles} tiles")));
    }
    /// Per tile-part: body, PPT segments (Zppt, data), index among all tile-parts.
    type PartBuilding<'a> = (&'a [u8], Vec<(u8, &'a [u8])>, usize);
    struct Building<'a> {
        coding: Coding,
        parts: Vec<PartBuilding<'a>>,
    }
    let mut tiles: Vec<Option<Building<'_>>> = (0..ntiles).map(|_| None).collect();
    let mut part_no = 0usize;
    loop {
        if pos + 2 > b.len() || b[pos..pos + 2] == [0xFF, 0xD9] {
            break;
        }
        if b[pos..pos + 2] != [0xFF, 0x90] {
            // Junk after the last tile-part (some writers pad): stop there.
            break;
        }
        let (_, sot, mut hpos) = seg_at(pos)?;
        let mut r = Reader { b: sot, pos: 0 };
        let (isot, psot, tpsot, _tnsot) = (r.u16()?, r.u32()?, r.u8()?, r.u8()?);
        let t = usize::from(isot);
        if t >= tiles.len() {
            return Err(invalid(format!("tile {t} of {ntiles}")));
        }
        let end = if psot == 0 { b.len() } else { pos.checked_add(psot as usize).ok_or_else(|| invalid("Psot"))? };
        // A tile-part claiming more than the codestream holds is cut to what is there.
        let end = end.min(b.len());
        let entry = tiles[t].get_or_insert_with(|| Building {
            coding: Coding { coc: vec![None; n], qcc: vec![None; n], ..Default::default() },
            parts: Vec::new(),
        });
        let first_part = entry.parts.is_empty();
        let mut ppt = Vec::new();
        let _ = tpsot;
        // Tile-part header up to SOD.
        loop {
            if hpos + 2 > end {
                return Err(invalid("tile-part header without SOD"));
            }
            if b[hpos..hpos + 2] == [0xFF, 0x93] {
                hpos += 2;
                break;
            }
            let (m, seg, next) = seg_at(hpos)?;
            match m {
                // COD and QCD only count in the first tile-part of a tile; COC/QCC/POC/RGN anywhere.
                0x52 | 0x5C if !first_part => {}
                0x52 | 0x53 | 0x5C | 0x5D | 0x5F | 0x5E => coding_marker(&mut entry.coding, m, seg, n)?,
                0x61 => {
                    let z = *seg.first().ok_or_else(|| invalid("empty PPT"))?;
                    ppt.push((z, &seg[1..]));
                }
                0x74..=0x78 => return Err(unsupported("multiple component transformation markers in a tile-part header")),
                _ => {}
            }
            hpos = next;
        }
        entry.parts.push((b.get(hpos..end.max(hpos)).unwrap_or(&[]), ppt, part_no));
        part_no += 1;
        pos = end;
        if psot == 0 {
            break;
        }
    }

    // PPM: the packed headers of each tile-part, in codestream order (A.7.4).
    let ppm_per_part: Option<Vec<Vec<u8>>> = if ppm.is_empty() {
        None
    } else {
        ppm.sort_by_key(|p| p.0);
        let joined: Vec<u8> = ppm.iter().flat_map(|p| p.1.iter().copied()).collect();
        let mut r = Reader { b: &joined, pos: 0 };
        let mut parts = Vec::new();
        while !r.rest().is_empty() {
            let len = r.u32()? as usize;
            parts.push(r.take(len)?.to_vec());
        }
        Some(parts)
    };

    let (sop, eph, progression, layers, mct, sp) = main.cod.clone().ok_or_else(|| invalid("no COD"))?;
    let qcd = main.qcd.clone().ok_or_else(|| invalid("no QCD"))?;
    let mut out = Vec::with_capacity(tiles.len());
    for (index, t) in tiles.into_iter().enumerate() {
        let Some(mut t) = t else { continue };
        let tc = &t.coding;
        let (sop, eph, progression, layers, mct, tsp) = tc.cod.clone().unwrap_or((sop, eph, progression, layers, mct, sp.clone()));
        let components = (0..n)
            .map(|c| {
                tc.coc[c].clone().or_else(|| tc.cod.as_ref().map(|cod| cod.5.clone())).or_else(|| main.coc[c].clone()).unwrap_or_else(|| tsp.clone())
            })
            .collect();
        let quantization = (0..n)
            .map(|c| tc.qcc[c].clone().or_else(|| tc.qcd.clone()).or_else(|| main.qcc[c].clone()).unwrap_or_else(|| qcd.clone()))
            .collect();
        let poc = if tc.poc.is_empty() { main.poc.clone() } else { tc.poc.clone() };
        let mut parts = Vec::with_capacity(t.parts.len());
        for (body, mut ppt, part) in t.parts.drain(..) {
            let headers = if let Some(ppm) = &ppm_per_part {
                if !ppt.is_empty() {
                    return Err(invalid("both PPM and PPT"));
                }
                Some(ppm.get(part).ok_or_else(|| invalid("PPM has fewer tile-parts than the codestream"))?.clone())
            } else if !ppt.is_empty() {
                ppt.sort_by_key(|p| p.0);
                Some(ppt.iter().flat_map(|p| p.1.iter().copied()).collect())
            } else {
                None
            };
            parts.push(TilePart { body, headers });
        }
        out.push(Tile {
            index: index as u32,
            params: TileParams { sop, eph, progression, layers, mct, components, quantization, poc },
            parts,
        });
    }
    if out.is_empty() {
        return Err(invalid("no tile-parts"));
    }
    Ok(Codestream { size, tiles: out, part2, ccap15 })
}
