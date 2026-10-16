//! EBCOT tier-1 (T.800 Annex D): one code-block's coefficients to an MQ codeword segment, with
//! the default code-block style (no bypass, no resets, termination only at the end, no vertically
//! causal context, no segmentation symbols).

use crate::mq::{MqEncoder, CTX_RL, CTX_UNI};

/// Subband orientation, for the significance contexts (Table D.1).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Orient {
    /// LL and LH (vertically high-pass): horizontal neighbours count most.
    LlLh,
    /// HL (horizontally high-pass): vertical neighbours count most.
    Hl,
    Hh,
}

// Flag bits per coefficient. Neighbour significance: N S W E NW NE SW SE.
const N: u32 = 1 << 0;
const S: u32 = 1 << 1;
const W: u32 = 1 << 2;
const E: u32 = 1 << 3;
const NW: u32 = 1 << 4;
const NE: u32 = 1 << 5;
const SW: u32 = 1 << 6;
const SE: u32 = 1 << 7;
const NBR: u32 = 0xFF;
// Negative sign of the significant N, S, W, E neighbour.
const NNEG: u32 = 1 << 8;
const SNEG: u32 = 1 << 9;
const WNEG: u32 = 1 << 10;
const ENEG: u32 = 1 << 11;
const SIG: u32 = 1 << 12;
const VISIT: u32 = 1 << 13;
const REFINED: u32 = 1 << 14;

/// Significance context for each neighbourhood pattern, per orientation.
fn zc_table(o: Orient) -> [u8; 256] {
    let mut t = [0u8; 256];
    for (k, e) in t.iter_mut().enumerate() {
        let k = k as u32;
        let h = (k & W != 0) as u32 + (k & E != 0) as u32;
        let v = (k & N != 0) as u32 + (k & S != 0) as u32;
        let d = (k & NW != 0) as u32 + (k & NE != 0) as u32 + (k & SW != 0) as u32 + (k & SE != 0) as u32;
        let (h, v) = if o == Orient::Hl { (v, h) } else { (h, v) };
        *e = match o {
            Orient::LlLh | Orient::Hl => match (h, v, d) {
                (2, _, _) => 8,
                (1, v, _) if v >= 1 => 7,
                (1, 0, d) if d >= 1 => 6,
                (1, 0, 0) => 5,
                (0, 2, _) => 4,
                (0, 1, _) => 3,
                (0, 0, d) if d >= 2 => 2,
                (0, 0, 1) => 1,
                _ => 0,
            },
            Orient::Hh => match (h + v, d) {
                (_, d) if d >= 3 => 8,
                (hv, 2) if hv >= 1 => 7,
                (0, 2) => 6,
                (hv, 1) if hv >= 2 => 5,
                (1, 1) => 4,
                (0, 1) => 3,
                (hv, 0) if hv >= 2 => 2,
                (1, 0) => 1,
                _ => 0,
            },
        };
    }
    t
}

/// A neighbour's sign contribution (Table D.2): 0 if insignificant, else ±1.
const fn contribution(k: usize, sig: usize, neg: usize) -> i32 {
    if k & sig == 0 {
        0
    } else if k & neg != 0 {
        -1
    } else {
        1
    }
}

/// (context, XOR bit) of Table D.3 for each pattern of the N/S/W/E significance and sign bits
/// (flag bits 0–3 and 8–11, packed as `sig | neg << 4`).
const SIGN_LUT: [(u8, u8); 256] = {
    let mut t = [(9u8, 0u8); 256];
    let mut k = 0;
    while k < 256 {
        let h = contribution(k, 4, 0x40) + contribution(k, 8, 0x80);
        let v = contribution(k, 1, 0x10) + contribution(k, 2, 0x20);
        let h = if h > 1 { 1 } else if h < -1 { -1 } else { h };
        let v = if v > 1 { 1 } else if v < -1 { -1 } else { v };
        t[k] = match (h, v) {
            (1, 1) => (13, 0),
            (1, 0) => (12, 0),
            (1, -1) => (11, 0),
            (0, 1) => (10, 0),
            (0, 0) => (9, 0),
            (0, -1) => (10, 1),
            (-1, 1) => (11, 1),
            (-1, 0) => (12, 1),
            _ => (13, 1),
        };
        k += 1;
    }
    t
};

#[inline(always)]
fn sign_ctx(f: u32) -> (usize, u32) {
    let (cx, xor) = SIGN_LUT[((f & 0xF) | ((f >> 4) & 0xF0)) as usize];
    (usize::from(cx), u32::from(xor))
}

/// Reusable buffers and tables for coding code-blocks.
///
/// Flags, magnitudes and signs are stored by stripe column: the four coefficients of one column
/// of a 4-row stripe are adjacent, so every pass reads memory in order. Index of (x, y):
/// `((y / 4 + 1) * (w + 2) + x + 1) * 4 + y % 4`; a padding column on each side and a padding
/// stripe above and below hold the zero flags of neighbours outside the block.
pub(crate) struct T1 {
    zc: [[u8; 256]; 3],
    flags: Vec<u32>,
    /// Per stripe column: COL_SIG if any of its coefficients is significant, COL_NBR if any has a
    /// significant neighbour. Both only ever get set, so the passes can skip quiet columns.
    colf: Vec<u8>,
    mag: Vec<u32>,
    neg: Vec<u8>,
    /// w + 2: stripe columns per stripe, padding included.
    cols: usize,
    pub(crate) mq: MqEncoder,
}

/// One coded code-block: its number of coding passes and of magnitude bit-planes (K).
pub(crate) struct Coded {
    pub passes: u32,
    /// Number of magnitude bit-planes with a 1 (K).
    pub bitplanes: u32,
}

impl T1 {
    pub(crate) fn new() -> Self {
        Self {
            zc: [zc_table(Orient::LlLh), zc_table(Orient::Hl), zc_table(Orient::Hh)],
            flags: Vec::new(),
            colf: Vec::new(),
            mag: Vec::new(),
            neg: Vec::new(),
            cols: 0,
            mq: MqEncoder::new(),
        }
    }

    #[inline(always)]
    fn base(&self, stripe: usize, x: usize) -> usize {
        ((stripe + 1) * self.cols + x + 1) * 4
    }

    /// Code a `w` × `h` block of coefficients (row-major, `stride` apart in `coef`). Returns None
    /// for an all-zero block (not included in any packet); otherwise the codeword is
    /// `self.mq.finish()`.
    pub(crate) fn code(&mut self, coef: &[i32], stride: usize, w: usize, h: usize, orient: Orient) -> Option<Coded> {
        self.cols = w + 2;
        let stripes = h.div_ceil(4);
        let len = (stripes + 2) * self.cols * 4;
        self.flags.clear();
        self.flags.resize(len, 0);
        self.colf.clear();
        self.colf.resize(len / 4, 0);
        self.mag.clear();
        self.mag.resize(len, 0);
        self.neg.clear();
        self.neg.resize(len, 0);
        let mut max = 0u32;
        for y in 0..h {
            let row = &coef[y * stride..y * stride + w];
            for (x, &c) in row.iter().enumerate() {
                let i = self.base(y / 4, x) + y % 4;
                let m = c.unsigned_abs();
                max |= m;
                self.mag[i] = m;
                self.neg[i] = u8::from(c < 0);
            }
        }
        if max == 0 {
            return None;
        }
        let k = 32 - max.leading_zeros();
        self.mq.reset();
        let zc = self.zc[match orient {
            Orient::LlLh => 0,
            Orient::Hl => 1,
            Orient::Hh => 2,
        }];
        let g = Geom { w, h, cols: self.cols };
        let Self { flags, colf, mag, neg, mq, .. } = self;
        let mut passes = 0;
        for p in (0..k).rev() {
            if p + 1 < k {
                sig_pass(flags, colf, mag, neg, mq, g, p, &zc);
                ref_pass(flags, colf, mag, mq, g, p);
                passes += 2;
            }
            cleanup(flags, colf, mag, neg, mq, g, p, &zc);
            passes += 1;
        }
        Some(Coded { passes, bitplanes: k })
    }
}

/// Block geometry for the passes: width, height, stripe columns per stripe (w + 2).
#[derive(Clone, Copy)]
struct Geom {
    w: usize,
    h: usize,
    cols: usize,
}

impl Geom {
    #[inline(always)]
    fn base(&self, stripe: usize, x: usize) -> usize {
        ((stripe + 1) * self.cols + x + 1) * 4
    }
}

const COL_SIG: u8 = 1;
const COL_NBR: u8 = 2;

/// Mark the coefficient at index `i` significant and record it in its neighbours' flags and in
/// the column summaries.
#[inline(always)]
fn set_sig(flags: &mut [u32], colf: &mut [u8], cols: usize, i: usize, negative: bool) {
    let c = i / 4;
    colf[c] |= COL_SIG | COL_NBR;
    colf[c - 1] |= COL_NBR;
    colf[c + 1] |= COL_NBR;
    if i.is_multiple_of(4) {
        colf[c - cols - 1] |= COL_NBR;
        colf[c - cols] |= COL_NBR;
        colf[c - cols + 1] |= COL_NBR;
    } else if i % 4 == 3 {
        colf[c + cols - 1] |= COL_NBR;
        colf[c + cols] |= COL_NBR;
        colf[c + cols + 1] |= COL_NBR;
    }
    let row = cols * 4;
    let k = i % 4;
    // The coefficient above: the previous one in the column, or the last of the stripe above.
    let up = if k > 0 { i - 1 } else { i - row + 3 };
    let down = if k < 3 { i + 1 } else { i + row - 3 };
    flags[i] |= SIG;
    flags[up] |= S | if negative { SNEG } else { 0 };
    flags[down] |= N | if negative { NNEG } else { 0 };
    flags[i - 4] |= E | if negative { ENEG } else { 0 };
    flags[i + 4] |= W | if negative { WNEG } else { 0 };
    flags[up - 4] |= SE;
    flags[up + 4] |= SW;
    flags[down - 4] |= NE;
    flags[down + 4] |= NW;
}

// The passes take the buffers as separate arguments, so the compiler knows they do not alias the
// MQ coder's registers.

#[allow(clippy::too_many_arguments)]
fn sig_pass(flags: &mut [u32], colf: &mut [u8], mag: &[u32], neg: &[u8], mq: &mut MqEncoder, g: Geom, p: u32, zc: &[u8; 256]) {
    for s in 0..g.h.div_ceil(4) {
        let rows = (g.h - 4 * s).min(4);
        for x in 0..g.w {
            let b = g.base(s, x);
            if colf[b / 4] & COL_NBR == 0 {
                continue;
            }
            for i in b..b + rows {
                let f = flags[i];
                if f & SIG != 0 || f & NBR == 0 {
                    continue;
                }
                let bit = (mag[i] >> p) & 1;
                mq.encode(bit, usize::from(zc[(f & NBR) as usize]));
                if bit == 1 {
                    let (cx, xor) = sign_ctx(f);
                    mq.encode(u32::from(neg[i]) ^ xor, cx);
                    set_sig(flags, colf, g.cols, i, neg[i] != 0);
                }
                flags[i] |= VISIT;
            }
        }
    }
}

fn ref_pass(flags: &mut [u32], colf: &[u8], mag: &[u32], mq: &mut MqEncoder, g: Geom, p: u32) {
    for s in 0..g.h.div_ceil(4) {
        let rows = (g.h - 4 * s).min(4);
        for x in 0..g.w {
            let b = g.base(s, x);
            if colf[b / 4] & COL_SIG == 0 {
                continue;
            }
            for i in b..b + rows {
                let f = flags[i];
                if f & (SIG | VISIT) != SIG {
                    continue;
                }
                let cx = if f & REFINED != 0 {
                    16
                } else if f & NBR != 0 {
                    15
                } else {
                    14
                };
                mq.encode((mag[i] >> p) & 1, cx);
                flags[i] |= REFINED;
            }
        }
    }
}

/// The cleanup pass; it also clears VISIT, which only holds within one bit-plane.
#[allow(clippy::too_many_arguments)]
fn cleanup(flags: &mut [u32], colf: &mut [u8], mag: &[u32], neg: &[u8], mq: &mut MqEncoder, g: Geom, p: u32, zc: &[u8; 256]) {
    for s in 0..g.h.div_ceil(4) {
        let rows = (g.h - 4 * s).min(4);
        for x in 0..g.w {
            let b = g.base(s, x);
            let mut k = 0;
            // A column with no significant coefficient and no significant neighbour has nothing
            // visited and all-zero contexts: run-length mode without reading its flags.
            let quiet = colf[b / 4] == 0 || flags[b..b + 4].iter().all(|&f| f & (SIG | VISIT | NBR) == 0);
            if rows == 4 && quiet {
                // Run-length mode: is any of the four significant in this bit-plane?
                match (0..4).find(|&j| (mag[b + j] >> p) & 1 == 1) {
                    None => {
                        mq.encode(0, CTX_RL);
                        continue;
                    }
                    Some(j) => {
                        mq.encode(1, CTX_RL);
                        mq.encode((j as u32 >> 1) & 1, CTX_UNI);
                        mq.encode(j as u32 & 1, CTX_UNI);
                        let i = b + j;
                        let (cx, xor) = sign_ctx(flags[i]);
                        mq.encode(u32::from(neg[i]) ^ xor, cx);
                        set_sig(flags, colf, g.cols, i, neg[i] != 0);
                        k = j + 1;
                    }
                }
            }
            for i in b + k..b + rows {
                let f = flags[i];
                if f & (SIG | VISIT) == 0 {
                    let bit = (mag[i] >> p) & 1;
                    mq.encode(bit, usize::from(zc[(f & NBR) as usize]));
                    if bit == 1 {
                        let (cx, xor) = sign_ctx(f);
                        mq.encode(u32::from(neg[i]) ^ xor, cx);
                        set_sig(flags, colf, g.cols, i, neg[i] != 0);
                    }
                }
                flags[i] &= !VISIT;
            }
        }
    }
}
