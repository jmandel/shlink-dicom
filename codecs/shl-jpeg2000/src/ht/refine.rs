//! The HT SigProp (T.814 clause 7.4) and MagRef (7.5) passes, in the stripe-oriented scan of
//! T.800: stripes of four rows, each scanned column by column, top to bottom.
//!
//! Both passes work on the cleanup pass's significance map, one `u16` per column group (four
//! columns of a stripe), bit `4 x + y` for column `x` and row `y` of the group. The map covers
//! the quads' padding samples too; a conforming cleanup pass leaves those insignificant.

use super::bits::{Bits, FwdBytes, RevBytes};

/// For a sample at bit `b` of a group: the later samples of the group it is a scan-causal
/// neighbour of (the sample below, and the three to the right).
const LATER_NEIGHBOURS: [u16; 16] = {
    let mut t = [0u16; 16];
    let mut b = 0;
    while b < 16 {
        let (x, y) = (b / 4, b % 4);
        let mut m = 0u16;
        if y < 3 {
            m |= 1 << (b + 1);
        }
        if x < 3 {
            let right = 4 * (x + 1);
            if y > 0 {
                m |= 1 << (right + y - 1);
            }
            m |= 1 << (right + y);
            if y < 3 {
                m |= 1 << (right + y + 1);
            }
        }
        t[b] = m;
        b += 1;
    }
    t
};

/// Geometry shared by the two passes.
pub(super) struct Refine<'a> {
    pub(super) width: usize,
    pub(super) height: usize,
    pub(super) stride: usize,
    pub(super) p: u32,
    /// The significance map: `stripes + 1` rows (the last all zero) of `sigma_stride` groups,
    /// group `g` at index `g + 1` with zeros on both sides.
    pub(super) sigma: &'a [u16],
    pub(super) sigma_stride: usize,
}

impl Refine<'_> {
    fn groups(&self) -> usize {
        self.width.div_ceil(4)
    }

    /// The SigProp pass over the refinement segment `seg`. `above` is scratch space.
    pub(super) fn sigprop(&self, seg: &[u8], out: &mut [u32], above: &mut Vec<u16>, vertically_causal: bool) {
        let (gs, groups) = (self.sigma_stride, self.groups());
        let mut sp_src = FwdBytes::new(seg, 0);
        let mut sp = Bits::default();
        // Significance after this pass (`sigma | r`) of the stripe above, as `sigma`; then of the
        // current stripe.
        above.clear();
        above.resize(2 * gs, 0);
        let (mut prev, mut cur) = above.split_at_mut(gs);
        let value = 3 << (self.p - 2);

        for s in 0..self.height.div_ceil(4) {
            let rows = (self.height - 4 * s).min(4);
            let row_mask = 0x1111u32 * ((1 << rows) - 1);
            let sig = &self.sigma[s * gs..(s + 1) * gs];
            let next = &self.sigma[(s + 1) * gs..(s + 2) * gs];
            let mut left = 0u32; // column 3 of the group to the left, after this pass
            for g in 1..=groups {
                let cols = (self.width - 4 * (g - 1)).min(4);
                let in_block = row_mask & (0xFFFF >> (16 - 4 * cols));
                let c = u32::from(sig[g]);
                // Columns -1..=4 around the group, 4 bits each (row 0 in the LSB): the left
                // column after this pass, the group and the column to its right as in `sigma`.
                let x = left | c << 4 | (u32::from(sig[g + 1]) & 0xF) << 20;
                let mut v = x | (x << 1) & 0xEE_EEEE | (x >> 1) & 0x77_7777;
                // The rows above (after this pass) and below (cleanup only) the stripe.
                v |= u32::from(prev[g - 1] >> 15) | (u32::from(prev[g] >> 3) & 0x1111) << 4 | (u32::from(prev[g + 1] >> 3) & 1) << 20;
                if !vertically_causal {
                    v |= (u32::from(next[g - 1] >> 12) & 1) << 3 | (u32::from(next[g]) & 0x1111) << 7 | (u32::from(next[g + 1]) & 1) << 23;
                }
                let neighbours = ((v | v << 4 | v >> 4) >> 4) & 0xFFFF;
                let candidates = !c & in_block;
                let mut todo = neighbours & candidates;
                let mut new = 0u32;
                if todo != 0 {
                    sp_src.ensure32(&mut sp);
                    // decodeSigPropMag, in scan order: a sample that becomes significant makes
                    // its later neighbours candidates too.
                    while todo != 0 {
                        let b = todo.trailing_zeros();
                        todo &= todo - 1;
                        if sp.acc & 1 != 0 {
                            new |= 1 << b;
                            todo |= u32::from(LATER_NEIGHBOURS[b as usize]) & candidates;
                        }
                        sp.consume(1);
                    }
                    // decodeSigPropSign.
                    let mut rest = new;
                    while rest != 0 {
                        let b = rest.trailing_zeros() as usize;
                        rest &= rest - 1;
                        let sign = sp.low() << 31;
                        sp.consume(1);
                        let at = (4 * s + b % 4) * self.stride + 4 * (g - 1) + b / 4;
                        if let Some(o) = out.get_mut(at) {
                            *o = sign | value;
                        }
                    }
                }
                let after = c | new;
                #[allow(clippy::cast_possible_truncation)]
                {
                    cur[g] = after as u16;
                }
                left = after >> 12;
            }
            core::mem::swap(&mut prev, &mut cur);
        }
    }

    /// The MagRef pass over the refinement segment `seg`: one bit for each sample significant
    /// in the cleanup pass, refining its magnitude by the plane below the cleanup's.
    pub(super) fn magref(&self, seg: &[u8], out: &mut [u32]) {
        let (gs, groups) = (self.sigma_stride, self.groups());
        let mut mr_src = RevBytes::magref(seg);
        let mut mr = Bits::default();
        let (one, half) = (1u32 << (self.p - 1), 1u32 << (self.p - 2));
        for s in 0..self.height.div_ceil(4) {
            for g in 1..=groups {
                let mut sig = u32::from(self.sigma[s * gs + g]);
                if sig == 0 {
                    continue;
                }
                mr_src.ensure32(&mut mr);
                while sig != 0 {
                    let b = sig.trailing_zeros() as usize;
                    sig &= sig - 1;
                    let (x, y) = (4 * (g - 1) + b / 4, 4 * s + b % 4);
                    let bit = mr.low() & 1;
                    mr.consume(1);
                    if x < self.width && y < self.height {
                        // The cleanup left the half-bin bit at p - 1; the refinement bit takes
                        // its place and the half-bin bit moves to p - 2.
                        if let Some(o) = out.get_mut(y * self.stride + x) {
                            *o ^= ((1 - bit) * one) | half;
                        }
                    }
                }
            }
        }
    }
}
