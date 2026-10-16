//! Tier-1 for Part 1 code-blocks (T.800 Annex D): significance propagation, magnitude
//! refinement and cleanup passes over MQ-coded or raw (bypass) segments.
//!
//! State is kept per stripe column (four rows): one word holds the significance of the
//! column's samples and of their neighbours (six rows by three columns, including the last row
//! of the stripe above and the first row of the stripe below), the signs of its own six rows,
//! and per-row "coded in this significance propagation pass" and "refined" bits.

use crate::geometry::{Chunk, Orient};
use crate::mq::{initial_contexts, Cx, Mq, Raw};
use crate::t2::mq_pass_terminates;

/// Significance of row `row6` (0 = the row above the stripe … 5 = the row below) and column
/// `col3` (0 = left neighbour, 1 = this column, 2 = right neighbour).
const fn sigma(row6: u32, col3: u32) -> u32 {
    1 << (row6 * 3 + col3)
}
const SIGMA_ALL: u32 = 0x3FFFF;
/// The row below the stripe, hidden in vertically causal mode (D.7).
const SIGMA_BELOW: u32 = sigma(5, 0) | sigma(5, 1) | sigma(5, 2);
/// Sign (negative) of row `row6` of this column.
const CHI0: u32 = 18;
/// Coded in the current significance propagation pass, rows 0–3.
const VIS0: u32 = 24;
const VIS_ALL: u32 = 0xF << VIS0;
/// Refined at least once, rows 0–3.
const REF0: u32 = 28;
/// This column's own four samples.
const OWN: u32 = sigma(1, 1) | sigma(2, 1) | sigma(3, 1) | sigma(4, 1);

const CX_RL: usize = 17;
const CX_UNI: usize = 18;

// Neighbourhood bits of one sample (3 × 3, the sample at bit 4), as `word >> (3 r)`.
const NW: u32 = 1;
const N: u32 = 1 << 1;
const NE: u32 = 1 << 2;
const W: u32 = 1 << 3;
const SELF: u32 = 1 << 4;
const E: u32 = 1 << 5;
const SW: u32 = 1 << 6;
const S: u32 = 1 << 7;
const SE: u32 = 1 << 8;

/// Zero-coding context (Table D.1) for each orientation and 3 × 3 neighbourhood.
const fn zc_table(orient: usize) -> [u8; 512] {
    let mut t = [0u8; 512];
    let mut i = 0;
    while i < 512 {
        let f = i as u32;
        let h = (f & W != 0) as u32 + (f & E != 0) as u32;
        let v = (f & N != 0) as u32 + (f & S != 0) as u32;
        let d = (f & NW != 0) as u32 + (f & NE != 0) as u32 + (f & SW != 0) as u32 + (f & SE != 0) as u32;
        let ctx = if orient == 3 {
            let hv = h + v;
            match d {
                0 => {
                    if hv >= 2 {
                        2
                    } else {
                        hv
                    }
                }
                1 => {
                    if hv >= 2 {
                        5
                    } else if hv == 1 {
                        4
                    } else {
                        3
                    }
                }
                2 => {
                    if hv >= 1 {
                        7
                    } else {
                        6
                    }
                }
                _ => 8,
            }
        } else {
            // HL swaps the roles of horizontal and vertical neighbours.
            let (h, v) = if orient == 1 { (v, h) } else { (h, v) };
            if h == 2 {
                8
            } else if h == 1 {
                if v >= 1 {
                    7
                } else if d >= 1 {
                    6
                } else {
                    5
                }
            } else if v == 2 {
                4
            } else if v == 1 {
                3
            } else if d >= 2 {
                2
            } else {
                d
            }
        };
        t[i] = ctx as u8;
        i += 1;
    }
    t
}

static ZC: [[u8; 512]; 4] = [zc_table(0), zc_table(1), zc_table(2), zc_table(3)];

/// Sign coding (Tables D.2, D.3): context (bits 0–4) and the XOR bit (bit 7), indexed by the
/// significance of W, E, N, S (bits 0–3) and their signs (bits 4–7).
const fn sc_table() -> [u8; 256] {
    let mut t = [0u8; 256];
    let mut i = 0;
    while i < 256 {
        let h = clamp1(contrib(i, 1, 16) + contrib(i, 2, 32));
        let v = clamp1(contrib(i, 4, 64) + contrib(i, 8, 128));
        let (ctx, xor) = match (h, v) {
            (1, 1) => (13, 0),
            (1, 0) => (12, 0),
            (1, _) => (11, 0),
            (0, 1) => (10, 0),
            (0, 0) => (9, 0),
            (0, _) => (10, 1),
            (_, 1) => (11, 1),
            (_, 0) => (12, 1),
            _ => (13, 1),
        };
        t[i] = ctx | xor << 7;
        i += 1;
    }
    t
}

static SC: [u8; 256] = sc_table();

const fn contrib(i: usize, sig: usize, neg: usize) -> i32 {
    if i & sig == 0 {
        0
    } else if i & neg != 0 {
        -1
    } else {
        1
    }
}

const fn clamp1(x: i32) -> i32 {
    if x > 1 {
        1
    } else if x < -1 {
        -1
    } else {
        x
    }
}

/// Decodes bits for a coding pass: MQ with contexts, or raw.
trait PassBits: Copy {
    /// Raw bits: signs are read as they are, not predicted from the neighbours (D.6).
    const RAW: bool;
    fn bit(&mut self, cx: &mut [Cx; 19], ctx: usize) -> u32;
}

impl PassBits for Mq<'_> {
    const RAW: bool = false;
    #[inline(always)]
    fn bit(&mut self, cx: &mut [Cx; 19], ctx: usize) -> u32 {
        self.decode(&mut cx[ctx])
    }
}

impl PassBits for Raw<'_> {
    const RAW: bool = true;
    #[inline(always)]
    fn bit(&mut self, _: &mut [Cx; 19], _: usize) -> u32 {
        Raw::bit(self)
    }
}

/// Code-block style flags that matter to tier-1.
#[derive(Clone, Copy, Default)]
pub(crate) struct Style {
    pub bypass: bool,
    pub reset: bool,
    pub termall: bool,
    pub causal: bool,
    pub segmark: bool,
}

/// Reusable tier-1 state for one code-block.
#[derive(Default)]
pub(crate) struct T1 {
    w: usize,
    h: usize,
    words: Vec<u32>,
    mag: Vec<u32>,
    cx: [Cx; 19],
    data: Vec<u8>,
    /// After decoding: the last pass's kind (0 cleanup, 1 SP, 2 MR) and bit-plane position,
    /// or None if no pass was decoded.
    last: Option<(u32, u32)>,
}

/// Block geometry shared by the passes.
#[derive(Clone, Copy)]
struct Geom {
    w: usize,
    h: usize,
    /// Words per stripe (w + 2: a padding column each side).
    ws: usize,
    stripes: usize,
}

impl T1 {
    /// Decode a code-block of `w` × `h` from its contributions. `bitplanes` is Mb − P.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn decode(&mut self, w: usize, h: usize, orient: Orient, chunks: &[Chunk<'_>], total_passes: u32, bitplanes: u32, style: Style) {
        self.w = w;
        self.h = h;
        let g = Geom { w, h, ws: w + 2, stripes: h.div_ceil(4) };
        self.words.clear();
        self.words.resize(g.ws * g.stripes, 0);
        self.mag.clear();
        self.mag.resize(w * h, 0);
        self.cx = initial_contexts();
        self.last = None;
        let max_passes = if bitplanes == 0 { 0 } else { 1 + 3 * (bitplanes - 1) };
        let passes = total_passes.min(max_passes);
        if passes == 0 {
            return;
        }
        let zc = &ZC[orient as usize];
        self.data.clear();
        // Segments: runs of chunks up to a terminating pass. Without bypass or termination on
        // each pass, everything is one segment.
        let mut seg_start_pass = 0u32;
        let mut seg_start_byte = 0usize;
        let count = chunks.len();
        for (i, ch) in chunks.iter().enumerate() {
            self.data.extend_from_slice(ch.data);
            let last_pass = ch.first_pass + ch.passes - 1;
            let ends = mq_pass_terminates(last_pass, style.bypass, style.termall) || i + 1 == count;
            if !ends {
                continue;
            }
            let end_pass = (last_pass + 1).min(passes);
            if seg_start_pass < end_pass {
                let data = std::mem::take(&mut self.data);
                let seg = &data[seg_start_byte..];
                let raw = style.bypass && seg_start_pass >= 10 && !seg_start_pass.is_multiple_of(3);
                if raw {
                    let mut d = Raw::new(seg);
                    self.passes(&mut d, g, seg_start_pass, end_pass, bitplanes, zc, style);
                } else {
                    let mut d = Mq::new(seg);
                    self.passes(&mut d, g, seg_start_pass, end_pass, bitplanes, zc, style);
                }
                self.data = data;
            }
            seg_start_pass = last_pass + 1;
            seg_start_byte = self.data.len();
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn passes<D: PassBits>(&mut self, d: &mut D, g: Geom, start: u32, end: u32, bitplanes: u32, zc: &[u8; 512], style: Style) {
        for pass in start..end {
            let pos = bitplanes - 1 - pass.div_ceil(3);
            match pass % 3 {
                0 => {
                    cleanup(d, &mut self.cx, &mut self.words, &mut self.mag, g, pos, zc, style.causal);
                    if style.segmark {
                        for _ in 0..4 {
                            d.bit(&mut self.cx, CX_UNI);
                        }
                    }
                }
                1 => sigprop(d, &mut self.cx, &mut self.words, &mut self.mag, g, pos, zc, style.causal),
                _ => refine(d, &mut self.cx, &mut self.words, &mut self.mag, g, pos, style.causal),
            }
            if style.reset {
                self.cx = initial_contexts();
            }
            self.last = Some((pass % 3, pos));
        }
    }

    /// Visit every sample: (row, column, magnitude, negative, lowest decoded plane).
    #[inline(always)]
    fn samples(&self, mut f: impl FnMut(usize, usize, u32, bool, u32)) {
        let ws = self.w + 2;
        let Some((kind, pos)) = self.last else {
            for y in 0..self.h {
                for x in 0..self.w {
                    f(y, x, 0, false, 0);
                }
            }
            return;
        };
        for y in 0..self.h {
            let (k, r) = (y / 4, (y % 4) as u32);
            let words = &self.words[k * ws + 1..k * ws + 1 + self.w];
            let mags = &self.mag[y * self.w..(y + 1) * self.w];
            for (x, (&word, &m)) in words.iter().zip(mags).enumerate() {
                let neg = word >> (CHI0 + r + 1) & 1 != 0;
                // After a significance propagation pass, samples significant before it have
                // their lowest decoded plane one above it.
                let plane = if kind == 1 && word >> (VIS0 + r) & 1 == 0 { pos + 1 } else { pos };
                f(y, x, m, neg, plane);
            }
        }
    }

    /// Write the block's integer coefficients (reversible, unquantised) into `out`, rows
    /// `stride` apart. Samples not decoded to the last bit-plane get half the remaining range.
    pub(crate) fn write_i32(&self, out: &mut [i32], stride: usize) {
        self.samples(|y, x, m, neg, p| {
            let mut v = m as i32;
            if m != 0 {
                if p > 0 {
                    v += 1 << (p - 1);
                }
                if neg {
                    v = -v;
                }
            }
            out[y * stride + x] = v;
        });
    }

    /// Write the block's coefficients times `step` into `out` (E-6 reconstruction, with the
    /// mid-point rule of the decoder this replaces: always for irreversible, for reversible
    /// only below the lowest decoded plane).
    pub(crate) fn write_f32(&self, out: &mut [f32], stride: usize, irreversible: bool, step: f32) {
        self.samples(|y, x, m, neg, p| {
            let mut v = m as i32 as f32;
            if m != 0 {
                if irreversible || p != 0 {
                    v += 0.5 * (1u32 << p) as f32;
                }
                if neg {
                    v = -v;
                }
            }
            out[y * stride + x] = v * step;
        });
    }
}

/// Mark sample (row `r` of stripe `k`, word index `i`) significant.
#[inline(always)]
fn set_significant(words: &mut [u32], g: Geom, k: usize, i: usize, r: u32, neg: bool) {
    let chi = u32::from(neg);
    words[i] |= sigma(r + 1, 1) | chi << (CHI0 + r + 1);
    words[i - 1] |= sigma(r + 1, 2);
    words[i + 1] |= sigma(r + 1, 0);
    if r == 0 && k > 0 {
        let j = i - g.ws;
        words[j] |= sigma(5, 1) | chi << (CHI0 + 5);
        words[j - 1] |= sigma(5, 2);
        words[j + 1] |= sigma(5, 0);
    } else if r == 3 && k + 1 < g.stripes {
        let j = i + g.ws;
        words[j] |= sigma(0, 1) | chi << CHI0;
        words[j - 1] |= sigma(0, 2);
        words[j + 1] |= sigma(0, 0);
    }
}

/// The 3 × 3 neighbourhood of row `r`, the row below hidden in causal mode.
#[inline(always)]
fn neighbourhood(word: u32, r: u32, causal: bool) -> u32 {
    let n = (word >> (3 * r)) & 0x1FF;
    if causal && r == 3 {
        n & 0x3F
    } else {
        n
    }
}

#[inline(always)]
fn sign<D: PassBits>(d: &mut D, cx: &mut [Cx; 19], words: &[u32], i: usize, r: u32, nb: u32, causal: bool) -> bool {
    if D::RAW {
        return d.bit(cx, 0) != 0;
    }
    let word = words[i];
    let mut idx = (nb >> 3 & 1) | (nb >> 4 & 2) | (nb << 1 & 4) | (nb >> 4 & 8);
    idx |= (words[i - 1] >> (CHI0 + r + 1) & 1) << 4;
    idx |= (words[i + 1] >> (CHI0 + r + 1) & 1) << 5;
    idx |= (word >> (CHI0 + r) & 1) << 6;
    if !(causal && r == 3) {
        idx |= (word >> (CHI0 + r + 2) & 1) << 7;
    }
    let e = SC[idx as usize];
    let bit = d.bit(cx, usize::from(e & 0x1F));
    (bit ^ u32::from(e >> 7)) != 0
}

/// Significance propagation of one sample, row `r` of the column at word `i`.
#[allow(clippy::too_many_arguments)]
#[inline(always)]
fn sp_sample<D: PassBits>(d: &mut D, cx: &mut [Cx; 19], words: &mut [u32], mag: &mut [u32], g: Geom, k: usize, x: usize, i: usize, r: u32, one: u32, zc: &[u8; 512], causal: bool) {
    let word = words[i];
    let nb = neighbourhood(word, r, causal);
    if nb & SELF == 0 && nb != 0 {
        let bit = d.bit(cx, usize::from(zc[nb as usize]));
        words[i] |= 1 << (VIS0 + r);
        if bit != 0 {
            let neg = sign(d, cx, words, i, r, nb, causal);
            mag[(4 * k + r as usize) * g.w + x] = one;
            set_significant(words, g, k, i, r, neg);
        }
    }
}

/// Significance propagation pass (D.3.1).
#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn sigprop<D: PassBits>(dst: &mut D, cx: &mut [Cx; 19], words: &mut [u32], mag: &mut [u32], g: Geom, pos: u32, zc: &[u8; 512], causal: bool) {
    let mut local = *dst;
    let d = &mut local;
    let one = 1u32 << pos;
    for k in 0..g.stripes {
        let rows = (g.h - 4 * k).min(4) as u32;
        for x in 0..g.w {
            let i = k * g.ws + x + 1;
            let word = words[i];
            // Nothing significant around, or all four already significant.
            if word & SIGMA_ALL == 0 || word & OWN == OWN {
                continue;
            }
            if rows == 4 {
                sp_sample(d, cx, words, mag, g, k, x, i, 0, one, zc, causal);
                sp_sample(d, cx, words, mag, g, k, x, i, 1, one, zc, causal);
                sp_sample(d, cx, words, mag, g, k, x, i, 2, one, zc, causal);
                sp_sample(d, cx, words, mag, g, k, x, i, 3, one, zc, causal);
            } else {
                for r in 0..rows {
                    sp_sample(d, cx, words, mag, g, k, x, i, r, one, zc, causal);
                }
            }
        }
    }
    *dst = local;
}

/// Refinement of one sample; returns the word with its refined bit set.
#[allow(clippy::too_many_arguments)]
#[inline(always)]
fn mr_sample<D: PassBits>(d: &mut D, cx: &mut [Cx; 19], word: u32, mag: &mut [u32], m: usize, r: u32, pos: u32, causal: bool) -> u32 {
    // Significant, and not just made so in this bit-plane's SP pass.
    if word & sigma(r + 1, 1) != 0 && word >> (VIS0 + r) & 1 == 0 {
        let ctx = if word >> (REF0 + r) & 1 != 0 {
            16
        } else if neighbourhood(word, r, causal) & !SELF != 0 {
            15
        } else {
            14
        };
        let bit = d.bit(cx, ctx);
        mag[m] |= bit << pos;
        return 1 << (REF0 + r);
    }
    0
}

/// Magnitude refinement pass (D.3.3).
#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn refine<D: PassBits>(dst: &mut D, cx: &mut [Cx; 19], words: &mut [u32], mag: &mut [u32], g: Geom, pos: u32, causal: bool) {
    let mut local = *dst;
    let d = &mut local;
    for k in 0..g.stripes {
        let rows = (g.h - 4 * k).min(4) as u32;
        for x in 0..g.w {
            let i = k * g.ws + x + 1;
            let word = words[i];
            if word & OWN == 0 {
                continue;
            }
            let m = 4 * k * g.w + x;
            let mut set = 0;
            if rows == 4 {
                set |= mr_sample(d, cx, word, mag, m, 0, pos, causal);
                set |= mr_sample(d, cx, word, mag, m + g.w, 1, pos, causal);
                set |= mr_sample(d, cx, word, mag, m + 2 * g.w, 2, pos, causal);
                set |= mr_sample(d, cx, word, mag, m + 3 * g.w, 3, pos, causal);
            } else {
                for r in 0..rows {
                    set |= mr_sample(d, cx, word, mag, m + r as usize * g.w, r, pos, causal);
                }
            }
            words[i] = word | set;
        }
    }
    *dst = local;
}

/// Cleanup coding of one sample (not significant, not coded in the SP pass).
#[allow(clippy::too_many_arguments)]
#[inline(always)]
fn cu_sample<D: PassBits>(d: &mut D, cx: &mut [Cx; 19], words: &mut [u32], mag: &mut [u32], g: Geom, k: usize, x: usize, i: usize, r: u32, one: u32, zc: &[u8; 512], causal: bool) {
    let word = words[i];
    let nb = neighbourhood(word, r, causal);
    if nb & SELF == 0 && word >> (VIS0 + r) & 1 == 0 {
        let bit = d.bit(cx, usize::from(zc[nb as usize]));
        if bit != 0 {
            let neg = sign(d, cx, words, i, r, nb, causal);
            mag[(4 * k + r as usize) * g.w + x] = one;
            set_significant(words, g, k, i, r, neg);
        }
    }
}

/// Cleanup pass (D.3.4), with run-length coding of empty columns.
#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn cleanup<D: PassBits>(dst: &mut D, cx: &mut [Cx; 19], words: &mut [u32], mag: &mut [u32], g: Geom, pos: u32, zc: &[u8; 512], causal: bool) {
    let mut local = *dst;
    let d = &mut local;
    let one = 1u32 << pos;
    let rl_mask = if causal { (SIGMA_ALL & !SIGMA_BELOW) | VIS_ALL } else { SIGMA_ALL | VIS_ALL };
    for k in 0..g.stripes {
        let rows = (g.h - 4 * k).min(4) as u32;
        for x in 0..g.w {
            let i = k * g.ws + x + 1;
            let word = words[i];
            if rows == 4 {
                // Every sample significant or coded already: nothing to do.
                let done = (word >> 4 & 1 | word >> 6 & 2 | word >> 8 & 4 | word >> 10 & 8) | (word >> VIS0 & 0xF);
                if done == 0xF {
                    words[i] = word & !VIS_ALL;
                    continue;
                }
                let mut start = 0;
                if word & rl_mask == 0 {
                    // Run-length coding.
                    if d.bit(cx, CX_RL) == 0 {
                        continue;
                    }
                    let r = d.bit(cx, CX_UNI) << 1 | d.bit(cx, CX_UNI);
                    let nb = neighbourhood(word, r, causal);
                    let neg = sign(d, cx, words, i, r, nb, causal);
                    mag[(4 * k + r as usize) * g.w + x] = one;
                    set_significant(words, g, k, i, r, neg);
                    start = r + 1;
                }
                match start {
                    0 => {
                        cu_sample(d, cx, words, mag, g, k, x, i, 0, one, zc, causal);
                        cu_sample(d, cx, words, mag, g, k, x, i, 1, one, zc, causal);
                        cu_sample(d, cx, words, mag, g, k, x, i, 2, one, zc, causal);
                        cu_sample(d, cx, words, mag, g, k, x, i, 3, one, zc, causal);
                    }
                    1 => {
                        cu_sample(d, cx, words, mag, g, k, x, i, 1, one, zc, causal);
                        cu_sample(d, cx, words, mag, g, k, x, i, 2, one, zc, causal);
                        cu_sample(d, cx, words, mag, g, k, x, i, 3, one, zc, causal);
                    }
                    2 => {
                        cu_sample(d, cx, words, mag, g, k, x, i, 2, one, zc, causal);
                        cu_sample(d, cx, words, mag, g, k, x, i, 3, one, zc, causal);
                    }
                    3 => cu_sample(d, cx, words, mag, g, k, x, i, 3, one, zc, causal),
                    _ => {}
                }
            } else {
                for r in 0..rows {
                    cu_sample(d, cx, words, mag, g, k, x, i, r, one, zc, causal);
                }
            }
            words[i] &= !VIS_ALL;
        }
    }
    *dst = local;
}
