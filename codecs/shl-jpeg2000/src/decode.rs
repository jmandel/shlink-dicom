//! The decoder: tiles, tier-2, tier-1, dequantization, inverse wavelet transform, inverse
//! component transform, and placement of each tile in the component planes.

use crate::codestream::{self, Codestream, ComponentCoding, Quantization, Tile};
use crate::dwt::{self, Filter, Irr97, Rev53, Rev53F};
use crate::error::{invalid, unsupported, Result};
use crate::geometry::{build_tile_component, component_rect, tile_rect, Block, Orient, Rect, TileComponent};
use crate::mct2;
use crate::t1::{Style, T1};
use crate::t2::{self, Coding, ComponentT2, Lane, MixedChoices};

/// Decoded samples of one component, without the DC level shift.
#[derive(Debug, Clone, PartialEq)]
pub enum Plane {
    /// Reversible (5/3, unquantised) components: exact integers.
    Int(Vec<i32>),
    /// Irreversible or quantised components, and every Part 2 output.
    Float(Vec<f32>),
}

/// One output component on its own sampling grid.
#[derive(Debug, Clone)]
pub struct Component {
    pub width: u32,
    pub height: u32,
    /// Position of the first sample on the component grid (at the decoded resolution).
    pub x0: u32,
    pub y0: u32,
    pub precision: u8,
    pub signed: bool,
    pub dx: u8,
    pub dy: u8,
    pub plane: Plane,
}

/// A decoded image. Samples are as the inverse transforms leave them: the DC level shift
/// 2^(precision − 1) of unsigned components is not added (T.800 G.1.2), and nothing is
/// rounded or clamped.
#[derive(Debug, Clone)]
pub struct Image {
    /// Image area at the decoded resolution.
    pub x0: u32,
    pub y0: u32,
    pub width: u32,
    pub height: u32,
    pub components: Vec<Component>,
    /// The components are the output of a Part 2 multiple component transformation (CBD);
    /// that transformation replaces the DC level shift.
    pub part2: bool,
}

/// Decoding options.
#[derive(Debug, Clone, Copy, Default)]
pub struct Options {
    /// Discard this many of the highest resolution levels: their code-blocks are not decoded
    /// and their synthesis is skipped. Every component of every tile must have at least that
    /// many decomposition levels.
    pub reduce: u8,
}

/// Decode a raw codestream (SOC … EOC).
pub fn decode(data: &[u8], options: &Options) -> Result<Image> {
    let cs = codestream::parse(data)?;
    Decoder::new(&cs, options)?.run()
}

struct Decoder<'c, 'a> {
    cs: &'c Codestream<'a>,
    reduce: u32,
    part2: Option<mct2::Part2Transform>,
    planes: Vec<Component>,
    t1: T1,
    ht: crate::ht::Scratch,
    ht_out: Vec<u32>,
    ht_coded: Vec<u8>,
}

const MAX_MIXED_ATTEMPTS: u32 = 4096;

impl<'c, 'a> Decoder<'c, 'a> {
    fn new(cs: &'c Codestream<'a>, options: &Options) -> Result<Self> {
        let size = &cs.size;
        let reduce = u32::from(options.reduce);
        // Part 2: only the array-based multiple component transformation is decoded.
        let rsiz = size.rsiz;
        let part2_mct = rsiz & mct2::RSIZ_PART2 != 0 && rsiz & mct2::RSIZ_MCT != 0;
        if rsiz & mct2::RSIZ_PART2 != 0 && rsiz & 0x7FFF & !mct2::RSIZ_MCT != 0 {
            return Err(unsupported("Part 2 capabilities other than the multiple component transformation"));
        }
        let main_mct = cs.tiles.first().map(|t| t.params.mct).unwrap_or(0);
        let part2 = match main_mct {
            0 | 1 => None,
            mct2::COD_MCT_ARRAY if part2_mct => {
                let p = cs.part2.as_ref().ok_or_else(|| unsupported("Part 2 transformation without MCO"))?;
                if p.mco.as_ref().is_none_or(|m| m.is_empty()) {
                    return Err(unsupported("Part 2 transformation without stages"));
                }
                Some(p.transform(size.components.len())?)
            }
            t if part2_mct && t & mct2::COD_MCT_WAVELET != 0 => {
                return Err(unsupported("Part 2 wavelet-based multiple component transformation"))
            }
            _ => return Err(unsupported(format!("multiple component transformation type {main_mct}"))),
        };
        if let Some(p) = &part2 {
            if size.components.iter().any(|c| c.dx != 1 || c.dy != 1) || p.outputs.iter().any(|o| o.precision > 31) {
                return Err(unsupported("Part 2 transformation of subsampled components"));
            }
            if cs.tiles.iter().any(|t| t.params.mct != main_mct) {
                return Err(unsupported("Part 2 transformation switched in a tile"));
            }
        }
        // Every component of every tile must have `reduce` levels to discard.
        if reduce > 0 && cs.tiles.iter().any(|t| t.params.components.iter().any(|c| u32::from(c.levels) < reduce)) {
            return Err(unsupported(format!("some component has fewer than {reduce} decomposition levels")));
        }
        let image = Rect { x0: size.x0, y0: size.y0, x1: size.x1, y1: size.y1 };
        let mut planes = Vec::with_capacity(size.components.len());
        for (c, comp) in size.components.iter().enumerate() {
            let r = component_rect(image, comp.dx, comp.dy).scale_down(reduce);
            let float = part2.is_some()
                || cs.tiles.iter().any(|t| {
                    let cc = &t.params.components[c];
                    !cc.reversible || t.params.quantization[c].style != 0
                });
            let n = (r.w() as usize).checked_mul(r.h() as usize).ok_or_else(|| invalid("image too large"))?;
            let plane = if float { Plane::Float(alloc(n)?) } else { Plane::Int(alloc(n)?) };
            planes.push(Component {
                width: r.w(),
                height: r.h(),
                x0: r.x0,
                y0: r.y0,
                precision: comp.precision,
                signed: comp.signed,
                dx: comp.dx,
                dy: comp.dy,
                plane,
            });
        }
        Ok(Self { cs, reduce, part2, planes, t1: T1::default(), ht: Default::default(), ht_out: Vec::new(), ht_coded: Vec::new() })
    }

    fn run(mut self) -> Result<Image> {
        let cs = self.cs;
        for tile in &cs.tiles {
            self.tile(tile)?;
        }
        let size = &cs.size;
        let image = Rect { x0: size.x0, y0: size.y0, x1: size.x1, y1: size.y1 }.scale_down(self.reduce);
        let mut components = self.planes;
        if let Some(p) = &self.part2 {
            let len = image.w() as usize * image.h() as usize;
            let mut data: Vec<Vec<f32>> = components
                .iter_mut()
                .map(|c| match std::mem::replace(&mut c.plane, Plane::Float(Vec::new())) {
                    Plane::Float(v) => v,
                    Plane::Int(v) => v.into_iter().map(|x| x as f32).collect(),
                })
                .collect();
            p.apply(&mut data, len)?;
            components = p
                .outputs
                .iter()
                .zip(data)
                .map(|(o, v)| Component {
                    width: image.w(),
                    height: image.h(),
                    x0: image.x0,
                    y0: image.y0,
                    precision: o.precision,
                    signed: o.signed,
                    dx: 1,
                    dy: 1,
                    plane: Plane::Float(v),
                })
                .collect();
        }
        Ok(Image { x0: image.x0, y0: image.y0, width: image.w(), height: image.h(), components, part2: self.part2.is_some() })
    }

    fn tile(&mut self, tile: &'c Tile<'a>) -> Result<()> {
        let cs = self.cs;
        let size = &cs.size;
        let trect = tile_rect(size, tile.index);
        let params = &tile.params;
        let comps: Vec<ComponentT2> = params
            .components
            .iter()
            .map(|c| {
                Ok(ComponentT2 { coding: t2::coding(&c.style, cs.ccap15)?, bypass: c.style.bypass, termall: c.style.termall })
            })
            .collect::<Result<_>>()?;
        let mixed = comps.iter().any(|c| c.coding == Coding::Mixed);
        let mut choices = MixedChoices::default();
        let mut attempts = 0;
        loop {
            attempts += 1;
            let mut tcs: Vec<TileComponent<'a>> = size
                .components
                .iter()
                .zip(&params.components)
                .map(|(c, coding)| build_tile_component(component_rect(trect, c.dx, c.dy), coding))
                .collect::<Result<_>>()?;
            let order = t2::packet_order(size, trect, &tcs, params.layers, params.progression, &params.poc)?;
            t2::read_packets(tile, &mut tcs, &comps, &order, &mut choices)?;
            match self.reconstruct(tile, &tcs) {
                Ok(outs) => {
                    self.store(tile, &tcs, outs)?;
                    return Ok(());
                }
                Err(e) => {
                    if !mixed || attempts >= MAX_MIXED_ATTEMPTS || !choices.advance() {
                        return Err(e);
                    }
                }
            }
        }
    }

    /// Tier-1, dequantization and the inverse DWT of every component of a tile; returns the
    /// tile-component samples at the decoded resolution.
    fn reconstruct(&mut self, tile: &Tile<'a>, tcs: &[TileComponent<'a>]) -> Result<Vec<Plane>> {
        let cs = self.cs;
        let params = &tile.params;
        let mut outs = Vec::with_capacity(tcs.len());
        for (c, tc) in tcs.iter().enumerate() {
            let coding = &params.components[c];
            let quant = &params.quantization[c];
            let comp = &cs.size.components[c];
            // Integers for reversible unquantised components (exact), f32 otherwise.
            let int = coding.reversible && quant.style == 0;
            let t2c = t2::coding(&coding.style, cs.ccap15)?;
            let keep = tc.resolutions.len() - self.reduce as usize;
            let nbands = tc.resolutions[keep - 1].bands.end;
            if int {
                let mut bands: Vec<Vec<i32>> = Vec::with_capacity(nbands);
                for b in &tc.bands[..nbands] {
                    bands.push(alloc(b.rect.w() as usize * b.rect.h() as usize)?);
                }
                self.blocks(tc, coding, quant, comp.precision, t2c, keep, BandBufs::Int(&mut bands))?;
                outs.push(Plane::Int(synthesize::<i32, Rev53>(tc, keep, bands)));
            } else {
                let mut bands: Vec<Vec<f32>> = Vec::with_capacity(nbands);
                for b in &tc.bands[..nbands] {
                    bands.push(alloc(b.rect.w() as usize * b.rect.h() as usize)?);
                }
                self.blocks(tc, coding, quant, comp.precision, t2c, keep, BandBufs::Float(&mut bands))?;
                outs.push(Plane::Float(if coding.reversible {
                    synthesize::<f32, Rev53F>(tc, keep, bands)
                } else {
                    synthesize::<f32, Irr97>(tc, keep, bands)
                }));
            }
        }
        // Inverse component transformation (Annex G) on the first three components.
        if params.mct == 1 && outs.len() >= 3 {
            let (a, rest) = outs.split_at_mut(1);
            let (b, c) = rest.split_at_mut(1);
            match (&mut a[0], &mut b[0], &mut c[0]) {
                (Plane::Int(y0), Plane::Int(y1), Plane::Int(y2)) if y0.len() == y1.len() && y1.len() == y2.len() => {
                    for ((a, b), c) in y0.iter_mut().zip(y1.iter_mut()).zip(y2.iter_mut()) {
                        let g = *a - ((*b + *c) >> 2);
                        let r = *c + g;
                        let bl = *b + g;
                        *a = r;
                        *b = g;
                        *c = bl;
                    }
                }
                (Plane::Float(y0), Plane::Float(y1), Plane::Float(y2))
                    if y0.len() == y1.len() && y1.len() == y2.len() && params.components[..3].iter().all(|c| c.reversible) =>
                {
                    for ((a, b), c) in y0.iter_mut().zip(y1.iter_mut()).zip(y2.iter_mut()) {
                        let g = *a - ((*b + *c) * 0.25).floor();
                        let r = *c + g;
                        let bl = *b + g;
                        *a = r;
                        *b = g;
                        *c = bl;
                    }
                }
                (Plane::Float(y0), Plane::Float(y1), Plane::Float(y2))
                    if y0.len() == y1.len() && y1.len() == y2.len() && params.components[..3].iter().all(|c| !c.reversible) =>
                {
                    for ((a, b), c) in y0.iter_mut().zip(y1.iter_mut()).zip(y2.iter_mut()) {
                        let (y, cb, cr) = (*a, *b, *c);
                        *a = cr * 1.402 + y;
                        *b = cr * -0.71414 + (cb * -0.34413 + y);
                        *c = cb * 1.772 + y;
                    }
                }
                _ => return Err(unsupported("component transformation over components of different sizes or kinds")),
            }
        }
        Ok(outs)
    }

    #[allow(clippy::too_many_arguments)]
    fn blocks(
        &mut self,
        tc: &TileComponent<'a>,
        coding: &ComponentCoding,
        quant: &Quantization,
        precision: u8,
        t2c: Coding,
        keep: usize,
        mut bufs: BandBufs<'_>,
    ) -> Result<()> {
        let style = Style {
            bypass: coding.style.bypass,
            reset: coding.style.reset,
            termall: coding.style.termall,
            causal: coding.style.causal,
            segmark: coding.style.segmark,
        };
        for res in &tc.resolutions[..keep] {
            for p in 0..(res.npx * res.npy) as usize {
                for (bi, pb) in tc.precincts[res.first_precinct + p].iter().enumerate() {
                    let b = res.bands.start + bi;
                    let band = &tc.bands[b];
                    let (exp, mant) = quant.step(band.qindex, tc.levels)?;
                    let mb = u32::from(quant.guard) + u32::from(exp);
                    let mb = mb.checked_sub(1).ok_or_else(|| invalid("no bit-planes"))?;
                    if mb > 31 {
                        return Err(invalid(format!("{mb} bit-planes")));
                    }
                    let step = if quant.style == 0 {
                        1.0
                    } else {
                        let gain = match band.orient {
                            Orient::LL => 0,
                            Orient::HL | Orient::LH => 1,
                            Orient::HH => 2,
                        };
                        let rb = i32::from(precision) + gain;
                        pow2(rb - i32::from(exp)) * (1.0 + f32::from(mant) / 2048.0)
                    };
                    let bw = band.rect.w() as usize;
                    for k in 0..(pb.ncx * pb.ncy) as usize {
                        let block = &tc.blocks[pb.first + k];
                        let (w, h) = (block.rect.w() as usize, block.rect.h() as usize);
                        if w == 0 || h == 0 {
                            continue;
                        }
                        let off = (block.rect.y0 - band.rect.y0) as usize * bw + (block.rect.x0 - band.rect.x0) as usize;
                        let lane = match t2c {
                            Coding::Mq => Lane::Mq,
                            Coding::Ht => Lane::Ht,
                            Coding::Mixed => block.mixed,
                        };
                        let ht = match lane {
                            Lane::Mq => false,
                            Lane::Ht => true,
                            Lane::Unknown => {
                                // Trial: HT first, Part 1 if the HT decode fails (T.814 A.4).
                                self.ht_block(block, mb, coding.style.causal).is_ok()
                            }
                        };
                        if ht {
                            if lane != Lane::Unknown {
                                self.ht_block(block, mb, coding.style.causal)?;
                            }
                            let shift = 31 - mb;
                            let src = &self.ht_out;
                            match &mut bufs {
                                BandBufs::Int(v) => {
                                    let dst = &mut v[b][off..];
                                    for y in 0..h {
                                        for x in 0..w {
                                            let sm = src[y * w + x];
                                            let m = ((sm & 0x7FFF_FFFF) >> shift) as i32;
                                            dst[y * bw + x] = if sm >> 31 != 0 { -m } else { m };
                                        }
                                    }
                                }
                                BandBufs::Float(v) => {
                                    let dst = &mut v[b][off..];
                                    let irreversible = !coding.reversible;
                                    let scale = f32::from_bits((127 - shift) << 23) * step;
                                    for y in 0..h {
                                        for x in 0..w {
                                            let sm = src[y * w + x];
                                            let m = if irreversible {
                                                (sm & 0x7FFF_FFFF) as f32 * scale
                                            } else {
                                                ((sm & 0x7FFF_FFFF) >> shift) as f32 * step
                                            };
                                            dst[y * bw + x] = if sm >> 31 != 0 { -m } else { m };
                                        }
                                    }
                                }
                            }
                        } else {
                            let bitplanes = mb.saturating_sub(block.missing);
                            self.t1.decode(w, h, band.orient, &block.chunks, block.passes, bitplanes, style);
                            match &mut bufs {
                                BandBufs::Int(v) => self.t1.write_i32(&mut v[b][off..], bw),
                                BandBufs::Float(v) => self.t1.write_f32(&mut v[b][off..], bw, !coding.reversible, step),
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Decode an HT code-block (T.814 B.3, clause 7) into `self.ht_out` (sign-magnitude, the
    /// cleanup plane at bit 30 − S_blk). Uses the last HT set whose cleanup segment is present.
    fn ht_block(&mut self, block: &Block<'a>, mb: u32, causal: bool) -> Result<()> {
        let (w, h) = (block.rect.w() as usize, block.rect.h() as usize);
        self.ht_out.clear();
        self.ht_out.resize(w * h, 0);
        let Some(p0) = block.ht_p0 else {
            // Placeholder passes only (or never included): zero.
            return Ok(());
        };
        let avail = block.passes - p0;
        if avail > 3 * mb || p0 > 3 * mb {
            return Err(invalid("HT code-block with more passes than bit-planes"));
        }
        let sets = avail.div_ceil(3) as usize;
        // (cleanup bytes, refinement bytes) per set, as ranges into one buffer per kind.
        let mut cleanup: Vec<Vec<u8>> = vec![Vec::new(); sets];
        let mut refine: Vec<Vec<u8>> = vec![Vec::new(); sets];
        for ch in &block.chunks {
            if ch.passes == 0 {
                continue;
            }
            let last = ch.first_pass + ch.passes - 1;
            if last < p0 {
                if ch.len != 0 {
                    return Err(invalid("HT placeholder passes with data"));
                }
                continue;
            }
            let rel = last - p0;
            let set = (rel / 3) as usize;
            if rel % 3 == 0 {
                cleanup[set].extend_from_slice(ch.data);
            } else {
                refine[set].extend_from_slice(ch.data);
            }
        }
        let mut chosen = None;
        for j in 0..sets {
            let cl = cleanup[j].len();
            if cl == 1 || (j == 0 && cl == 0) {
                return Err(invalid("HT cleanup segment of length 1 (or an empty first one)"));
            }
            if cl == 0 && !refine[j].is_empty() {
                return Err(invalid("HT refinement segment without a cleanup segment"));
            }
            if cl > 0 {
                chosen = Some(j);
            }
        }
        let Some(j) = chosen else { return Ok(()) };
        let in_set = (avail - 3 * j as u32).min(3);
        let num_passes = if refine[j].is_empty() { 1 } else { in_set };
        let s_blk = block.missing + p0 / 3 + j as u32;
        if s_blk >= mb {
            return Err(invalid("HT code-block skips more bit-planes than the sub-band has"));
        }
        self.ht_coded.clear();
        self.ht_coded.extend_from_slice(&cleanup[j]);
        let len_cleanup = cleanup[j].len();
        self.ht_coded.extend_from_slice(&refine[j]);
        // The block decoder places the cleanup plane at bit 30 − missing, i.e. relative to
        // 31 bit-planes; shift by 31 − Mb more.
        let missing = s_blk;
        crate::ht::decode_block(
            &mut self.ht,
            &self.ht_coded,
            &mut self.ht_out,
            w,
            h,
            w,
            missing,
            &crate::ht::BlockPasses { num_passes, len_cleanup, len_refinement: refine[j].len() },
            causal,
        )
        .map_err(|e| match e {
            crate::ht::HtError::Invalid(m) => invalid(format!("HT code-block: {m}")),
            crate::ht::HtError::Unsupported(m) => unsupported(format!("HT code-block: {m}")),
        })
    }

    /// Write each tile-component into its component plane.
    fn store(&mut self, tile: &Tile<'a>, tcs: &[TileComponent<'a>], outs: Vec<Plane>) -> Result<()> {
        let sole = self.cs.tiles.len() == 1;
        let _ = tile;
        for ((tc, out), comp) in tcs.iter().zip(outs).zip(self.planes.iter_mut()) {
            let r = tc.rect.scale_down(self.reduce);
            if r.is_empty() {
                continue;
            }
            let (w, h) = (r.w() as usize, r.h() as usize);
            let (pw, ph) = (comp.width as usize, comp.height as usize);
            if r.x0 < comp.x0 || r.y0 < comp.y0 {
                return Err(invalid("tile outside the image"));
            }
            let (ox, oy) = ((r.x0 - comp.x0) as usize, (r.y0 - comp.y0) as usize);
            if ox + w > pw || oy + h > ph {
                return Err(invalid("tile outside the image"));
            }
            match (&mut comp.plane, out) {
                (Plane::Int(dst), Plane::Int(src)) => {
                    if sole && ox == 0 && oy == 0 && w == pw && h == ph {
                        *dst = src;
                    } else {
                        copy_rows(dst, pw, &src, w, h, ox, oy);
                    }
                }
                (Plane::Float(dst), Plane::Float(src)) => {
                    if sole && ox == 0 && oy == 0 && w == pw && h == ph {
                        *dst = src;
                    } else {
                        copy_rows(dst, pw, &src, w, h, ox, oy);
                    }
                }
                (Plane::Float(dst), Plane::Int(src)) => {
                    let src: Vec<f32> = src.into_iter().map(|v| v as f32).collect();
                    copy_rows(dst, pw, &src, w, h, ox, oy);
                }
                (Plane::Int(_), Plane::Float(_)) => return Err(invalid("component kind changed between tiles")),
            }
        }
        Ok(())
    }
}

enum BandBufs<'b> {
    Int(&'b mut Vec<Vec<i32>>),
    Float(&'b mut Vec<Vec<f32>>),
}

fn copy_rows<T: Copy>(dst: &mut [T], dw: usize, src: &[T], w: usize, h: usize, ox: usize, oy: usize) {
    for y in 0..h {
        dst[(oy + y) * dw + ox..][..w].copy_from_slice(&src[y * w..][..w]);
    }
}

fn alloc<T: Default + Clone>(n: usize) -> Result<Vec<T>> {
    let mut v = Vec::new();
    v.try_reserve_exact(n).map_err(|_| unsupported(format!("cannot allocate {n} samples")))?;
    v.resize(n, T::default());
    Ok(v)
}

/// 2^e as f32, exactly (e within the normal range).
fn pow2(e: i32) -> f32 {
    if (-126..=127).contains(&e) {
        f32::from_bits(((e + 127) as u32) << 23)
    } else {
        (e as f32).exp2()
    }
}

/// The inverse DWT from the LL band up to resolution `keep − 1`.
fn synthesize<T: Copy + Default, F: Filter<T>>(tc: &TileComponent<'_>, keep: usize, mut bands: Vec<Vec<T>>) -> Vec<T> {
    let mut cur = std::mem::take(&mut bands[0]);
    let (mut out, mut low, mut high) = (Vec::new(), Vec::new(), Vec::new());
    for r in 1..keep {
        let res = &tc.resolutions[r];
        let b = res.bands.start;
        dwt::level::<T, F>(res.rect, &cur, &bands[b], &bands[b + 1], &bands[b + 2], &mut out, &mut low, &mut high);
        std::mem::swap(&mut cur, &mut out);
    }
    cur
}
