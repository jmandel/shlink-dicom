//! Tile, tile-component, resolution, sub-band, precinct and code-block geometry (B.3–B.7).

use crate::codestream::{ComponentCoding, Size};
use crate::error::{invalid, Result};
use crate::tagtree::TagTree;

#[inline]
pub(crate) fn ceil_div(a: u64, b: u64) -> u64 {
    a.div_ceil(b)
}

/// A rectangle [x0, x1) × [y0, y1).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Rect {
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
}

impl Rect {
    pub(crate) fn w(&self) -> u32 {
        self.x1.saturating_sub(self.x0)
    }
    pub(crate) fn h(&self) -> u32 {
        self.y1.saturating_sub(self.y0)
    }
    pub(crate) fn is_empty(&self) -> bool {
        self.w() == 0 || self.h() == 0
    }
    /// ceil(coordinate / 2^s) on every side (B-14/B-15 style).
    pub(crate) fn scale_down(&self, s: u32) -> Rect {
        let d = 1u64 << s;
        Rect {
            x0: ceil_div(u64::from(self.x0), d) as u32,
            y0: ceil_div(u64::from(self.y0), d) as u32,
            x1: ceil_div(u64::from(self.x1), d) as u32,
            y1: ceil_div(u64::from(self.y1), d) as u32,
        }
    }
}

/// The tile rectangle on the reference grid (B-7).
pub(crate) fn tile_rect(size: &Size, index: u32) -> Rect {
    let tx = index % size.tiles_x();
    let ty = index / size.tiles_x();
    let x0 = u64::from(size.tx0) + u64::from(tx) * u64::from(size.tw);
    let y0 = u64::from(size.ty0) + u64::from(ty) * u64::from(size.th);
    Rect {
        x0: x0.max(u64::from(size.x0)) as u32,
        y0: y0.max(u64::from(size.y0)) as u32,
        x1: (x0 + u64::from(size.tw)).min(u64::from(size.x1)) as u32,
        y1: (y0 + u64::from(size.th)).min(u64::from(size.y1)) as u32,
    }
}

/// A component's rectangle on its own grid for a reference-grid rectangle (B-12).
pub(crate) fn component_rect(r: Rect, dx: u8, dy: u8) -> Rect {
    let (dx, dy) = (u64::from(dx), u64::from(dy));
    Rect {
        x0: ceil_div(u64::from(r.x0), dx) as u32,
        y0: ceil_div(u64::from(r.y0), dy) as u32,
        x1: ceil_div(u64::from(r.x1), dx) as u32,
        y1: ceil_div(u64::from(r.y1), dy) as u32,
    }
}

/// Sub-band orientation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Orient {
    LL = 0,
    HL = 1,
    LH = 2,
    HH = 3,
}

/// One code-block's tier-2 state and coded data.
#[derive(Default)]
pub(crate) struct Block<'a> {
    pub rect: Rect,
    pub included: bool,
    pub lblock: u32,
    /// Coding passes received so far.
    pub passes: u32,
    /// Missing most significant bit-planes (P, B.10.5).
    pub missing: u32,
    /// Contributions in order: (codeword segment index, passes, bytes).
    pub chunks: Vec<Chunk<'a>>,
    /// HT: the pass index of the first HT cleanup pass (3·P0), once known.
    pub ht_p0: Option<u32>,
    /// MIXED: the block's coding (None while undecided), and whether a non-zero length was
    /// read for it under the HT reading.
    pub mixed: crate::t2::Lane,
    pub ht_nonzero: bool,
}

#[derive(Clone, Copy)]
pub(crate) struct Chunk<'a> {
    /// First coding pass of the contribution.
    pub first_pass: u32,
    pub passes: u32,
    pub data: &'a [u8],
    /// Length signalled in the packet header (`data` is shorter only if the body ran out).
    pub len: u32,
}

/// A sub-band of one tile-component.
pub(crate) struct Band {
    pub orient: Orient,
    pub rect: Rect,
    /// Index of the band in quantization order (0 = LL, then 3 per resolution).
    pub qindex: usize,
    /// Effective code-block size exponents.
    pub cbw: u8,
    pub cbh: u8,
}

/// The code-blocks of one precinct in one sub-band.
pub(crate) struct PrecinctBand {
    /// Code-block grid indices of the first code-block, and the grid size.
    pub ncx: u32,
    pub ncy: u32,
    /// Index of the first code-block in `TileComponent::blocks` (row-major ncx × ncy).
    pub first: usize,
    pub inclusion: TagTree,
    pub zero_planes: TagTree,
}

pub(crate) struct Resolution {
    pub rect: Rect,
    pub ppx: u8,
    pub ppy: u8,
    /// Precinct grid size.
    pub npx: u32,
    pub npy: u32,
    /// Indices into `TileComponent::bands`: one (LL) at resolution 0, else HL, LH, HH.
    pub bands: std::ops::Range<usize>,
    /// Index of the first precinct in `TileComponent::precincts`; each precinct has one
    /// `PrecinctBand` per band of the resolution.
    pub first_precinct: usize,
}

pub(crate) struct TileComponent<'a> {
    pub rect: Rect,
    pub levels: u8,
    pub resolutions: Vec<Resolution>,
    pub bands: Vec<Band>,
    /// Per precinct, per band of its resolution.
    pub precincts: Vec<Vec<PrecinctBand>>,
    pub blocks: Vec<Block<'a>>,
}

fn band_rect(tc: Rect, n: u32, xo: u32, yo: u32) -> Rect {
    // B-15: ceil((t − 2^(n−1)·o) / 2^n); never negative.
    let d = 1u64 << n;
    let off = if n == 0 { 0 } else { 1u64 << (n - 1) };
    let f = |t: u32, o: u32| -> u32 {
        let t = u64::from(t);
        let s = off * u64::from(o);
        if t <= s {
            0
        } else {
            ceil_div(t - s, d) as u32
        }
    };
    Rect { x0: f(tc.x0, xo), y0: f(tc.y0, yo), x1: f(tc.x1, xo), y1: f(tc.y1, yo) }
}

/// Upper bound on code-blocks per tile-component, against hostile headers.
const MAX_BLOCKS: usize = 1 << 24;

pub(crate) fn build_tile_component<'a>(tc: Rect, coding: &ComponentCoding) -> Result<TileComponent<'a>> {
    let nl = u32::from(coding.levels);
    let mut resolutions = Vec::with_capacity(nl as usize + 1);
    let mut bands = Vec::new();
    let mut precincts = Vec::new();
    let mut blocks: Vec<Block<'a>> = Vec::new();
    for r in 0..=nl {
        let rect = tc.scale_down(nl - r);
        let (ppx, ppy) = coding.precincts[r as usize];
        let (npx, npy) = if rect.is_empty() {
            (0, 0)
        } else {
            (
                (ceil_div(u64::from(rect.x1), 1 << ppx) - (u64::from(rect.x0) >> ppx)) as u32,
                (ceil_div(u64::from(rect.y1), 1 << ppy) - (u64::from(rect.y0) >> ppy)) as u32,
            )
        };
        let first_band = bands.len();
        let (cbw, cbh) = if r == 0 {
            (coding.cbw.min(ppx), coding.cbh.min(ppy))
        } else {
            (coding.cbw.min(ppx - 1), coding.cbh.min(ppy - 1))
        };
        if r == 0 {
            bands.push(Band { orient: Orient::LL, rect: band_rect(tc, nl, 0, 0), qindex: 0, cbw, cbh });
        } else {
            let n = nl - r + 1;
            for (i, (orient, xo, yo)) in [(Orient::HL, 1, 0), (Orient::LH, 0, 1), (Orient::HH, 1, 1)].into_iter().enumerate() {
                bands.push(Band { orient, rect: band_rect(tc, n, xo, yo), qindex: 1 + 3 * (r as usize - 1) + i, cbw, cbh });
            }
        }
        let band_range = first_band..bands.len();
        let first_precinct = precincts.len();
        let nprec = u64::from(npx) * u64::from(npy);
        if nprec as usize > MAX_BLOCKS || precincts.len() + nprec as usize > MAX_BLOCKS {
            return Err(invalid("too many precincts"));
        }
        // Precinct origin on the resolution grid, then on the band grid (halved above r = 0).
        let (px0, py0) = (u64::from(rect.x0) >> ppx << ppx, u64::from(rect.y0) >> ppy << ppy);
        let shift = u32::from(r > 0);
        for p in 0..nprec {
            let (kx, ky) = (p % u64::from(npx.max(1)), p / u64::from(npx.max(1)));
            let mut per_band = Vec::with_capacity(band_range.len());
            for b in band_range.clone() {
                let band = &bands[b];
                let bx0 = (px0 + (kx << ppx)) >> shift;
                let by0 = (py0 + (ky << ppy)) >> shift;
                let (pw, ph) = (1u64 << (u32::from(ppx) - shift), 1u64 << (u32::from(ppy) - shift));
                let x0 = bx0.max(u64::from(band.rect.x0));
                let y0 = by0.max(u64::from(band.rect.y0));
                let x1 = (bx0 + pw).min(u64::from(band.rect.x1));
                let y1 = (by0 + ph).min(u64::from(band.rect.y1));
                let (ncx, ncy, cx0, cy0) = if x0 >= x1 || y0 >= y1 {
                    (0, 0, 0, 0)
                } else {
                    let cx0 = x0 >> band.cbw;
                    let cy0 = y0 >> band.cbh;
                    (
                        (ceil_div(x1, 1 << band.cbw) - cx0) as u32,
                        (ceil_div(y1, 1 << band.cbh) - cy0) as u32,
                        cx0,
                        cy0,
                    )
                };
                let first = blocks.len();
                let count = ncx as usize * ncy as usize;
                if blocks.len() + count > MAX_BLOCKS {
                    return Err(invalid("too many code-blocks"));
                }
                for j in 0..u64::from(ncy) {
                    for i in 0..u64::from(ncx) {
                        let (cx, cy) = (cx0 + i, cy0 + j);
                        let rect = Rect {
                            x0: (cx << band.cbw).max(x0) as u32,
                            y0: (cy << band.cbh).max(y0) as u32,
                            x1: ((cx + 1) << band.cbw).min(x1) as u32,
                            y1: ((cy + 1) << band.cbh).min(y1) as u32,
                        };
                        blocks.push(Block { rect, lblock: 3, ..Default::default() });
                    }
                }
                per_band.push(PrecinctBand {
                    ncx,
                    ncy,
                    first,
                    inclusion: TagTree::new(ncx, ncy),
                    zero_planes: TagTree::new(ncx, ncy),
                });
            }
            precincts.push(per_band);
        }
        resolutions.push(Resolution { rect, ppx, ppy, npx, npy, bands: band_range, first_precinct });
    }
    Ok(TileComponent { rect: tc, levels: coding.levels, resolutions, bands, precincts, blocks })
}
