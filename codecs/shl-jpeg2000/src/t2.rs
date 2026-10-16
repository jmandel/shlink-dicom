//! Tier-2 (Annex B): packet order, including progression order changes, and packet headers,
//! for Part 1 code-blocks and T.814 HT code-blocks (Annex B of T.814), MIXED included.

use crate::bits::HeaderBits;
use crate::codestream::{ProgressionChange, Size, Tile};
use crate::error::{unsupported, Result};
use crate::geometry::{Chunk, Rect, TileComponent};

/// How a tile-component's code-blocks are coded (T.814 A.3.2, A.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Coding {
    /// Part 1 (MQ, Annex D).
    Mq,
    /// HT (T.814 clause 7).
    Ht,
    /// MIXED: each code-block is one or the other, found by trial (T.814 A.4).
    Mixed,
}

/// A MIXED code-block's coding, as far as tier-2 has decided it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum Lane {
    #[default]
    Unknown,
    Ht,
    Mq,
}

/// The coding of a tile-component from its style byte and the CAP Ccap15 field.
pub(crate) fn coding(style: &crate::codestream::BlockStyle, ccap15: Option<u16>) -> Result<Coding> {
    if style.mixed && !style.ht {
        return Err(unsupported("code-block style bit 7 without bit 6"));
    }
    Ok(match ccap15.map(|c| c >> 14) {
        Some(0) => Coding::Ht,
        Some(2) | None => {
            if style.mixed {
                return Err(unsupported("MIXED code-blocks without the MIXED capability"));
            }
            if style.ht {
                Coding::Ht
            } else {
                Coding::Mq
            }
        }
        Some(3) => match (style.ht, style.mixed) {
            (true, true) => Coding::Mixed,
            (true, false) => Coding::Ht,
            _ => Coding::Mq,
        },
        _ => return Err(unsupported("reserved HT capability set")),
    })
}

/// One packet: layer, resolution, component, precinct (index within the resolution).
#[derive(Debug, Clone, Copy)]
pub(crate) struct Packet {
    pub layer: u16,
    pub res: u8,
    pub comp: u16,
    pub precinct: u32,
}

const MAX_PACKETS: usize = 1 << 25;

/// The tile's packets in codestream order (B.12), with progression order changes (A.6.6).
pub(crate) fn packet_order(size: &Size, tile: Rect, tcs: &[TileComponent<'_>], layers: u16, progression: u8, poc: &[ProgressionChange]) -> Result<Vec<Packet>> {
    let nc = tcs.len();
    let max_res = tcs.iter().map(|t| usize::from(t.levels) + 1).max().unwrap_or(0);
    let entries: Vec<ProgressionChange> = if poc.is_empty() {
        vec![ProgressionChange { rs: 0, cs: 0, lye: layers, re: max_res as u8, ce: nc as u16, order: progression }]
    } else {
        poc.to_vec()
    };
    // Next layer to emit per component and precinct (precincts of all resolutions in order).
    let mut next: Vec<Vec<u16>> = tcs.iter().map(|t| vec![0u16; t.precincts.len()]).collect();
    let mut out = Vec::new();
    let precincts = |c: usize, r: usize| -> u32 {
        let res = &tcs[c].resolutions[r];
        res.npx * res.npy
    };
    let mut emit = |out: &mut Vec<Packet>, l: u16, r: usize, c: usize, p: u32| -> Result<()> {
        let idx = tcs[c].resolutions[r].first_precinct + p as usize;
        if next[c][idx] == l {
            next[c][idx] += 1;
            if out.len() >= MAX_PACKETS {
                return Err(unsupported("too many packets"));
            }
            out.push(Packet { layer: l, res: r as u8, comp: c as u16, precinct: p });
        }
        Ok(())
    };
    for e in &entries {
        let lye = e.lye.min(layers);
        let (rs, re) = (usize::from(e.rs), usize::from(e.re).min(max_res));
        let (cs, ce) = (usize::from(e.cs), usize::from(e.ce).min(nc));
        if rs >= re || cs >= ce || lye == 0 {
            continue;
        }
        let has = |c: usize, r: usize| r < tcs[c].resolutions.len();
        match e.order {
            0 => {
                for l in 0..lye {
                    for r in rs..re {
                        for c in cs..ce {
                            if has(c, r) {
                                for p in 0..precincts(c, r) {
                                    emit(&mut out, l, r, c, p)?;
                                }
                            }
                        }
                    }
                }
            }
            1 => {
                for r in rs..re {
                    for l in 0..lye {
                        for c in cs..ce {
                            if has(c, r) {
                                for p in 0..precincts(c, r) {
                                    emit(&mut out, l, r, c, p)?;
                                }
                            }
                        }
                    }
                }
            }
            order => {
                // Position-driven orders: walk the reference-grid positions where some
                // precinct of the entry starts, in raster order.
                let pos = Positions::new(size, tile, tcs, rs..re, cs..ce);
                let (xs, ys) = (pos.xs.clone(), pos.ys.clone());
                match order {
                    2 => {
                        // RPCL
                        for r in rs..re {
                            for &y in &ys {
                                for &x in &xs {
                                    for c in cs..ce {
                                        if let Some(p) = pos.precinct(c, r, x, y) {
                                            for l in 0..lye {
                                                emit(&mut out, l, r, c, p)?;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    3 => {
                        // PCRL
                        for &y in &ys {
                            for &x in &xs {
                                for c in cs..ce {
                                    for r in rs..re {
                                        if let Some(p) = pos.precinct(c, r, x, y) {
                                            for l in 0..lye {
                                                emit(&mut out, l, r, c, p)?;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    _ => {
                        // CPRL
                        for c in cs..ce {
                            for &y in &ys {
                                for &x in &xs {
                                    for r in rs..re {
                                        if let Some(p) = pos.precinct(c, r, x, y) {
                                            for l in 0..lye {
                                                emit(&mut out, l, r, c, p)?;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(out)
}

/// Precinct positions on the reference grid for the position-driven orders (B.12.1.3–5).
struct Positions<'t, 'a> {
    tile: Rect,
    tcs: &'t [TileComponent<'a>],
    dx: Vec<u64>,
    dy: Vec<u64>,
    xs: Vec<u64>,
    ys: Vec<u64>,
}

impl<'t, 'a> Positions<'t, 'a> {
    fn new(size: &Size, tile: Rect, tcs: &'t [TileComponent<'a>], rr: std::ops::Range<usize>, cr: std::ops::Range<usize>) -> Self {
        let dx: Vec<u64> = size.components.iter().map(|c| u64::from(c.dx)).collect();
        let dy: Vec<u64> = size.components.iter().map(|c| u64::from(c.dy)).collect();
        let (mut xs, mut ys) = (vec![u64::from(tile.x0)], vec![u64::from(tile.y0)]);
        for c in cr {
            let tc = &tcs[c];
            for r in rr.clone() {
                let Some(res) = tc.resolutions.get(r) else { continue };
                if res.rect.is_empty() {
                    continue;
                }
                let lev = u32::from(tc.levels) - r as u32;
                let (px0, py0) = (u64::from(res.rect.x0) >> res.ppx, u64::from(res.rect.y0) >> res.ppy);
                for k in 1..=u64::from(res.npx) {
                    let x = ((px0 + k) << (u32::from(res.ppx) + lev)).saturating_mul(dx[c]);
                    if x < u64::from(tile.x1) {
                        xs.push(x);
                    }
                }
                for k in 1..=u64::from(res.npy) {
                    let y = ((py0 + k) << (u32::from(res.ppy) + lev)).saturating_mul(dy[c]);
                    if y < u64::from(tile.y1) {
                        ys.push(y);
                    }
                }
            }
        }
        xs.sort_unstable();
        xs.dedup();
        ys.sort_unstable();
        ys.dedup();
        Self { tile, tcs, dx, dy, xs, ys }
    }

    /// The precinct of (c, r) that starts at (x, y), if one does (OpenJPEG's test).
    fn precinct(&self, c: usize, r: usize, x: u64, y: u64) -> Option<u32> {
        let tc = &self.tcs[c];
        let res = tc.resolutions.get(r)?;
        if res.rect.is_empty() {
            return None;
        }
        let lev = u32::from(tc.levels) - r as u32;
        let (rpx, rpy) = (u32::from(res.ppx) + lev, u32::from(res.ppy) + lev);
        let (dx, dy) = (self.dx[c], self.dy[c]);
        let (trx0, try0) = (u64::from(res.rect.x0), u64::from(res.rect.y0));
        let hit_y = (dy << rpy) != 0 && y.is_multiple_of(dy << rpy) || (y == u64::from(self.tile.y0) && !(try0 << lev).is_multiple_of(1u64 << rpy));
        let hit_x = (dx << rpx) != 0 && x.is_multiple_of(dx << rpx) || (x == u64::from(self.tile.x0) && !(trx0 << lev).is_multiple_of(1u64 << rpx));
        if !hit_x || !hit_y {
            return None;
        }
        let px = (x.div_ceil(dx << lev) >> res.ppx).checked_sub(trx0 >> res.ppx)?;
        let py = (y.div_ceil(dy << lev) >> res.ppy).checked_sub(try0 >> res.ppy)?;
        if px >= u64::from(res.npx) || py >= u64::from(res.npy) {
            return None;
        }
        Some((py * u64::from(res.npx) + px) as u32)
    }
}

/// Coding pass count (Table B.4).
fn pass_count(h: &mut HeaderBits<'_>) -> Option<u32> {
    if h.bit()? == 0 {
        return Some(1);
    }
    if h.bit()? == 0 {
        return Some(2);
    }
    let v = h.bits(2)?;
    if v < 3 {
        return Some(3 + v);
    }
    let v = h.bits(5)?;
    if v < 31 {
        return Some(6 + v);
    }
    Some(37 + h.bits(7)?)
}

fn length(h: &mut HeaderBits<'_>, lblock: u32, passes: u32) -> Option<u32> {
    let n = lblock + passes.ilog2();
    if n > 32 {
        return None;
    }
    if n == 32 {
        return Some(h.bits(16)? << 16 | h.bits(16)?);
    }
    h.bits(n)
}

/// Whether Part 1 pass `i` ends a codeword segment (Table D.8/D.9).
pub(crate) fn mq_pass_terminates(i: u32, bypass: bool, termall: bool) -> bool {
    termall || (bypass && (i == 9 || (i > 9 && !(i - 10).is_multiple_of(3))))
}

/// Whether HT pass `i` ends a codeword segment (T.814 B.2), `p0` the first cleanup pass.
pub(crate) fn ht_pass_terminates(i: u32, p0: u32) -> bool {
    i >= p0 && (i - p0) % 3 != 1
}

/// Per-tile tier-2 options.
pub(crate) struct ComponentT2 {
    pub coding: Coding,
    pub bypass: bool,
    pub termall: bool,
}

/// Choices for the genuinely ambiguous MIXED contributions, explored depth first.
#[derive(Default)]
pub(crate) struct MixedChoices {
    assignments: Vec<bool>,
    cursor: usize,
}

impl MixedChoices {
    fn next(&mut self) -> bool {
        if self.cursor == self.assignments.len() {
            self.assignments.push(true);
        }
        let c = self.assignments[self.cursor];
        self.cursor += 1;
        c
    }
    /// The next untried assignment; false when all are exhausted.
    pub(crate) fn advance(&mut self) -> bool {
        self.assignments.truncate(self.cursor);
        self.cursor = 0;
        while let Some(last) = self.assignments.pop() {
            if last {
                self.assignments.push(false);
                return true;
            }
        }
        false
    }
}

/// Read the packets of every tile-part of `tile` into the code-blocks of `tcs`.
///
/// A malformed packet ends its tile-part: the remaining packets of that part are skipped and
/// reading resumes with the next tile-part (lenient, as the decoder this replaces was). Errors
/// are returned only for what makes the result meaningless (MIXED trial exhaustion).
pub(crate) fn read_packets<'a>(
    tile: &Tile<'a>,
    tcs: &mut [TileComponent<'a>],
    comps: &[ComponentT2],
    order: &[Packet],
    choices: &mut MixedChoices,
) -> Result<bool> {
    let mut it = order.iter();
    let mut ok = true;
    let mut scratch: Vec<(usize, usize)> = Vec::new();
    for part in &tile.parts {
        let mut body = HeaderBits::new(part.body);
        let mut packed = part.headers.as_deref().map(HeaderBits::new);
        loop {
            let at_end = match &packed {
                Some(h) => h.at_end(),
                None => body.at_end(),
            };
            if at_end {
                break;
            }
            let Some(p) = it.next() else { break };
            let c = usize::from(p.comp);
            let r = packet(tile, &mut tcs[c], &comps[c], p, &mut body, packed.as_mut(), &mut scratch, choices);
            if r.is_none() {
                ok = false;
                break;
            }
        }
    }
    Ok(ok)
}

#[allow(clippy::too_many_arguments)]
fn packet<'a>(
    tile: &Tile<'a>,
    tc: &mut TileComponent<'a>,
    cfg: &ComponentT2,
    p: &Packet,
    body: &mut HeaderBits<'a>,
    packed: Option<&mut HeaderBits<'_>>,
    added: &mut Vec<(usize, usize)>,
    choices: &mut MixedChoices,
) -> Option<()> {
    if tile.params.sop && body.peek_bytes(2) == Some(&[0xFF, 0x91]) {
        body.bytes(6)?;
    }
    added.clear();
    // The header comes from the packed headers or, inline, from the body.
    match packed {
        Some(h) => header(tile, tc, cfg, p, h, added, choices)?,
        None => header(tile, tc, cfg, p, body, added, choices)?,
    }
    // Body: the contributions in header order.
    for &(b, ch) in added.iter() {
        let len = tc.blocks[b].chunks[ch].len as usize;
        let data = body.bytes(len)?;
        tc.blocks[b].chunks[ch].data = data;
    }
    Some(())
}

fn header(
    tile: &Tile<'_>,
    tc: &mut TileComponent<'_>,
    cfg: &ComponentT2,
    p: &Packet,
    h: &mut HeaderBits<'_>,
    added: &mut Vec<(usize, usize)>,
    choices: &mut MixedChoices,
) -> Option<()> {
    let res = &tc.resolutions[usize::from(p.res)];
    let prec_idx = res.first_precinct + p.precinct as usize;
    let nbands = res.bands.len();
    if h.bit()? == 1 {
        for bi in 0..nbands {
            let n = {
                let pb = &tc.precincts[prec_idx][bi];
                pb.ncx as usize * pb.ncy as usize
            };
            for k in 0..n {
                block_header(tc, prec_idx, bi, k, p.layer, cfg, h, added, choices)?;
            }
        }
    }
    h.align();
    if tile.params.eph {
        if h.peek_bytes(2) != Some(&[0xFF, 0x92]) {
            return None;
        }
        h.bytes(2)?;
    }
    Some(())
}

#[allow(clippy::too_many_arguments)]
fn block_header(
    tc: &mut TileComponent<'_>,
    prec_idx: usize,
    bi: usize,
    k: usize,
    layer: u16,
    cfg: &ComponentT2,
    h: &mut HeaderBits<'_>,
    added: &mut Vec<(usize, usize)>,
    choices: &mut MixedChoices,
) -> Option<()> {
    let pb = &mut tc.precincts[prec_idx][bi];
    let (x, y) = ((k % pb.ncx as usize) as u32, (k / pb.ncx as usize) as u32);
    let bidx = pb.first + k;
    let block = &mut tc.blocks[bidx];
    // B.10.4 inclusion.
    let included = if block.included {
        h.bit()? == 1
    } else {
        pb.inclusion.read(x, y, u32::from(layer) + 1, h)? <= u32::from(layer)
    };
    if !included {
        return Some(());
    }
    if !block.included {
        // B.10.5 zero bit-planes.
        block.missing = pb.zero_planes.read(x, y, u32::MAX, h)?;
        block.included = true;
    }
    let passes = pass_count(h)?;
    let mut k = 0;
    while h.bit()? == 1 {
        k += 1;
        if k > 64 {
            return None;
        }
    }
    block.lblock += k;
    let start = block.passes;
    let end = start.checked_add(passes)?;
    if end > 255 {
        return None;
    }
    let lblock = block.lblock;
    let mut push = |block: &mut crate::geometry::Block<'_>, first: u32, n: u32, len: u32| {
        added.push((bidx, block.chunks.len()));
        block.chunks.push(Chunk { first_pass: first, passes: n, data: &[], len });
    };
    match cfg.coding {
        Coding::Mq => {
            let mut first = start;
            for i in start..end {
                if mq_pass_terminates(i, cfg.bypass, cfg.termall) || i == end - 1 {
                    let n = i + 1 - first;
                    let len = length(h, lblock, n)?;
                    push(block, first, n, len);
                    first = i + 1;
                }
            }
        }
        Coding::Ht => {
            for (first, n, len) in ht_lengths(&mut block.ht_p0, lblock, start, passes, h, None)? {
                push(block, first, n, len);
            }
        }
        Coding::Mixed => {
            for (first, n, len) in mixed_lengths(block, lblock, start, passes, h, choices)? {
                push(block, first, n, len);
            }
        }
    }
    block.passes = end;
    Some(())
}

/// The first pass that can be the first HT cleanup pass in a contribution of `passes` passes
/// from `start`, when every earlier pass was a placeholder: the last multiple of 3 in it.
fn ht_first_cleanup_candidate(start: u32, passes: u32) -> Option<u32> {
    let cup = (start + passes - 1) / 3 * 3;
    (cup >= start).then_some(cup)
}

type Spans = Vec<(u32, u32, u32)>;

/// HT contribution lengths (T.814 B.3): segments end at each cleanup pass and after each
/// MagRef pass; leading placeholder passes join the first cleanup segment. The first cleanup
/// pass is found when a contribution's first length is 2 or more (a cleanup segment is never
/// 1 byte; a placeholder-only contribution has length 0).
///
/// `mixed`: in a MIXED tile-component, whether a non-zero length has been seen (T.814 A.4:
/// the first non-zero length has a 0 top bit and Lblock > 3).
fn ht_lengths(p0: &mut Option<u32>, lblock: u32, start: u32, passes: u32, h: &mut HeaderBits<'_>, mut mixed: Option<&mut bool>) -> Option<Spans> {
    let mut note = |v: u32, width: u32| -> Option<()> {
        if v != 0 {
            if let Some(seen) = mixed.as_deref_mut() {
                if !*seen && !(lblock > 3 && v >> (width - 1) == 0) {
                    return None;
                }
                *seen = true;
            }
        }
        Some(())
    };
    let width = |n: u32| lblock + n.ilog2();
    let mut out = Vec::new();
    match *p0 {
        Some(p0) => {
            let mut first = start;
            for i in start..start + passes {
                if ht_pass_terminates(i, p0) || i == start + passes - 1 {
                    let n = i + 1 - first;
                    let v = length(h, lblock, n)?;
                    // A cleanup segment is never one byte long (T.814 B.3).
                    if v == 1 && i >= p0 && (i - p0) % 3 == 0 {
                        return None;
                    }
                    note(v, width(n))?;
                    out.push((first, n, v));
                    first = i + 1;
                }
            }
        }
        None => match ht_first_cleanup_candidate(start, passes) {
            None => {
                if length(h, lblock, passes)? != 0 {
                    return None;
                }
                out.push((start, passes, 0));
            }
            Some(cup) => {
                let span1 = cup - start + 1;
                let narrow = width(span1);
                if narrow > 32 {
                    return None;
                }
                let v = length(h, lblock, span1)?;
                if v >= 2 {
                    note(v, narrow)?;
                    *p0 = Some(cup);
                    out.push((start, span1, v));
                    let rem = start + passes - 1 - cup;
                    if rem > 0 {
                        let v2 = length(h, lblock, rem)?;
                        note(v2, width(rem))?;
                        out.push((cup + 1, rem, v2));
                    }
                } else if v == 0 {
                    let wide = width(passes);
                    if wide > narrow && h.bits(wide - narrow)? != 0 {
                        return None;
                    }
                    out.push((start, passes, 0));
                } else {
                    return None;
                }
            }
        },
    }
    Some(out)
}

/// MIXED contribution lengths (T.814 A.4). A Part 1 block in a MIXED tile-component uses
/// neither bypass nor termination on each pass, so it has one length per contribution; an
/// HT block splits as [`ht_lengths`]. While both readings give the same bits the block stays
/// undecided; where they differ, `choices` picks (HT first) and a failure later in the tile
/// makes the caller try the other reading.
fn mixed_lengths(block: &mut crate::geometry::Block<'_>, lblock: u32, start: u32, passes: u32, h: &mut HeaderBits<'_>, choices: &mut MixedChoices) -> Option<Spans> {
    match block.mixed {
        Lane::Mq => Some(vec![(start, passes, length(h, lblock, passes)?)]),
        Lane::Ht => ht_lengths(&mut block.ht_p0, lblock, start, passes, h, Some(&mut block.ht_nonzero)),
        Lane::Unknown => {
            // Would the HT reading read exactly one length over the whole contribution?
            let single = match block.ht_p0 {
                Some(p0) => !(start..start + passes - 1).any(|i| ht_pass_terminates(i, p0)),
                None => ht_first_cleanup_candidate(start, passes).is_none_or(|cup| cup == start + passes - 1),
            };
            if single {
                let mut probe = h.clone();
                let v = length(&mut probe, lblock, passes)?;
                // Under the HT reading the same bits must also be a valid HT length.
                let mut ht_probe = h.clone();
                let (mut p0, mut nz) = (block.ht_p0, block.ht_nonzero);
                let ht = ht_lengths(&mut p0, lblock, start, passes, &mut ht_probe, Some(&mut nz));
                let same = ht.as_ref().is_some_and(|s| s.len() == 1 && s[0].2 == v) && ht_probe.byte_pos() == probe.byte_pos();
                *h = probe;
                if same {
                    block.ht_p0 = p0;
                    block.ht_nonzero = nz;
                } else {
                    block.mixed = Lane::Mq;
                }
                return Some(vec![(start, passes, v)]);
            }
            if choices.next() {
                block.mixed = Lane::Ht;
                ht_lengths(&mut block.ht_p0, lblock, start, passes, h, Some(&mut block.ht_nonzero))
            } else {
                block.mixed = Lane::Mq;
                Some(vec![(start, passes, length(h, lblock, passes)?)])
            }
        }
    }
}
