//! The HT cleanup pass (T.814 clauses 7.2 and 7.3): significance, EMB patterns and unsigned
//! residuals from the MEL and VLC streams, then magnitudes and signs from the MagSgn stream.
//!
//! The quads are visited in the order of clause 7.2, a pair of quads at a time (7.3.4), one
//! line-pair (row of quads) at a time: first the CxtVLC, MEL and U-VLC codes of the whole row,
//! then its MagSgn bits. The VLC and MagSgn streams are independent, and a quad's exponent
//! predictor needs only the line-pair above it.
//!
//! Like the decoder this replaces, the right column of the last quad of an odd-width block (its
//! padding) is not read from the MagSgn stream; a conforming block has no significant samples
//! there, so this only matters for damaged blocks.

use super::bits::{Bits, FwdBytes, Mel, RevBytes};
use super::tables::{CxtEntry, CXT_LOOKUP_0, CXT_LOOKUP_1, UVLC_LOOKUP_0, UVLC_LOOKUP_1};
use super::HtError;

/// Geometry and precision of one code-block's cleanup pass.
pub(super) struct Cleanup<'s> {
    pub(super) width: usize,
    pub(super) height: usize,
    pub(super) stride: usize,
    /// The bit of the cleanup pass's least significant plane, `30 - missing_msbs`.
    pub(super) p: u32,
    /// Largest exponent bound `U_q` the 32-bit output holds, `missing_msbs + 2`.
    pub(super) max_u: u32,
    /// The significance map for the refinement passes (see `refine.rs`); empty without them.
    pub(super) sigma: &'s mut [u16],
    /// Groups per stripe in `sigma`, padding included.
    pub(super) sigma_stride: usize,
}

/// `rho` spread into the column-major bit order of the significance map (bit `4 x + y`):
/// samples 0, 1 of the quad are column 0, samples 2, 3 column 1.
#[inline(always)]
fn spread(rho: u32) -> u32 {
    (rho & 3) | (rho & 0xC) << 2
}

/// Decodes a CxtVLC codeword with context `c_q` (`decodeSigEMB`, 7.3.5); `mel` decides the
/// significance of all-zero-context quads.
#[inline(always)]
fn sig_emb(vlc: &mut Bits, mel: &mut Mel, run: &mut u32, lookup: &[CxtEntry; 1024], c_q: u32) -> u32 {
    if c_q == 0 && !mel.symbol(run) {
        return 0;
    }
    #[allow(clippy::cast_possible_truncation)]
    let e = u32::from(lookup[((c_q << 7) as usize | (vlc.acc as usize & 0x7F)) & 0x3FF]);
    vlc.consume((e >> 5) & 7);
    e
}

/// Context of a quad in the initial line-pair (formula 1) from its left neighbour's `rho`.
#[inline(always)]
fn context_initial(left: u32) -> u32 {
    ((left | left >> 1) & 1) | (left >> 1) & 2 | (left >> 1) & 4
}

/// `sigma_nw | sigma_n` for a quad in a later line-pair (formula 2), from the `rho` of the quads
/// above-left and above; it is also `sigma_ne | sigma_nf` of the quad to the left.
#[inline(always)]
fn above_pair(nw: u32, n: u32) -> u32 {
    (nw >> 3 | n >> 1) & 1
}

/// `sigma_w | sigma_sw` of a quad, from the `rho` of the quad to its left.
#[inline(always)]
fn west(left: u32) -> u32 {
    (left >> 2 | left >> 3) & 1
}

/// The unsigned residuals of a quad pair (7.3.6) from the U-VLC codes that follow their
/// CxtVLC codewords. `u_off` holds the two quads' `u_off` flags in bits 0 and 1. In the initial
/// line-pair a MEL symbol, decoded when both flags are set, selects formula 4 or the shortened
/// code for the second quad.
///
/// U-VLC extensions are not read: they follow suffixes above 27, so `u_q >= 33`, and the
/// caller rejects any `U_q` above 31 before the stream position matters.
#[inline(always)]
fn residuals(vlc: &mut Bits, mel: &mut Mel, run: &mut u32, u_off: u32, initial: bool) -> (u32, u32) {
    let bits = vlc.low();
    let e = if initial {
        let mode = if u_off == 3 && mel.symbol(run) { 7 } else { u_off };
        UVLC_LOOKUP_0[((mode << 6 | (bits & 63)) & 511) as usize]
    } else {
        UVLC_LOOKUP_1[((u_off << 6 | (bits & 63)) & 255) as usize]
    };
    let e = u32::from(e);
    let (len, sfx0, sfx1) = (e & 7, (e >> 3) & 7, (e >> 6) & 7);
    let s = bits >> len;
    let u0 = ((e >> 9) & 7) + (s & ((1 << sfx0) - 1));
    let u1 = (e >> 12) + ((s >> sfx0) & ((1 << sfx1) - 1));
    vlc.consume(len + sfx0 + sfx1);
    (u0, u1)
}

/// Bit `j` of a 4-bit pattern moved to bit `8 j`.
const SPREAD: [u32; 16] = {
    let mut t = [0u32; 16];
    let mut i = 0;
    while i < 16 {
        t[i] = (i as u32 & 1) | (i as u32 & 2) << 7 | (i as u32 & 4) << 14 | (i as u32 & 8) << 21;
        i += 1;
    }
    t
};

/// One sample of a quad (7.3.8): `(output word, v_n | 1)`, where the output holds the sign in
/// bit 31 and `2 mu_n + 1` at bit `p - 1` (the magnitude with its half-bin bit below it), and
/// `v_n | 1 = 2 mu_n - 1` (0 if insignificant) feeds the exponent predictors of the next
/// line-pair. `sig`, `m` and
/// `i` are the sample's `sigma_n`, `m_n` and `i_n`; an insignificant sample (`m = 0`) reads no
/// bits and is 0, without a branch. `ms` must hold `m` bits.
#[inline(always)]
fn sample(ms: &mut Bits, sig: u32, m: u32, i: u32, p: u32) -> (u32, u32) {
    let bits = ms.low();
    let v = (bits & ((1 << m) - 1)) | i << m | sig;
    ms.consume(m);
    ((bits & sig) << 31 | v.wrapping_add(2 * sig) << (p - 1), v)
}

/// Exponent predictor `kappa_q` (formula 5) of a quad with entry `e` in a non-initial
/// line-pair; `above` ORs `2 mu - 1` of the four samples above it (`nw`, `n`, `ne`, `nf`).
#[inline(always)]
fn kappa(e: u32, above: u32) -> u32 {
    let rho = e & 0xF;
    if rho & (rho.wrapping_sub(1)) == 0 {
        1
    } else {
        // max(1, E_max - 1), E_max the bit length of the largest 2 mu - 1.
        31 - (above | 2).leading_zeros()
    }
}

/// The samples of a quad with entry `e` and exponent bound `u_q` (7.3.8), in the order of
/// clause 7.2 (top-left, bottom-left, top-right, bottom-right), with `2 mu - 1` of the bottom
/// two. With `left_only` the right column, the padding of an odd-width block, is skipped.
#[inline(always)]
fn quad(src: &mut FwdBytes, ms: &mut Bits, e: u32, u_q: u32, p: u32, left_only: bool) -> ([u32; 4], u32, u32) {
    if e & 0xF == 0 {
        return ([0; 4], 0, 0);
    }
    // sigma_n, m_n = sigma_n U_q - k_n and i_n of the four samples, one byte each.
    let sig = SPREAD[(e & 0xF) as usize];
    let m = (u_q * 0x0101_0101 - SPREAD[((e >> 8) & 0xF) as usize]) & (sig * 0xFF);
    let i = SPREAD[((e >> 12) & 0xF) as usize];
    if u_q <= 14 {
        // 57 bits hold the quad's at most 4 U_q.
        src.ensure(ms, 4 * u_q);
        let (s0, _) = sample(ms, sig & 1, m & 0xFF, i & 1, p);
        let (s1, e1) = sample(ms, (sig >> 8) & 1, (m >> 8) & 0xFF, (i >> 8) & 1, p);
        if left_only {
            return ([s0, s1, 0, 0], e1, 0);
        }
        let (s2, _) = sample(ms, (sig >> 16) & 1, (m >> 16) & 0xFF, (i >> 16) & 1, p);
        let (s3, e3) = sample(ms, sig >> 24, m >> 24, i >> 24, p);
        return ([s0, s1, s2, s3], e1, e3);
    }
    src.ensure32(ms);
    let (s0, _) = sample(ms, sig & 1, m & 0xFF, i & 1, p);
    src.ensure32(ms);
    let (s1, e1) = sample(ms, (sig >> 8) & 1, (m >> 8) & 0xFF, (i >> 8) & 1, p);
    if left_only {
        return ([s0, s1, 0, 0], e1, 0);
    }
    src.ensure32(ms);
    let (s2, _) = sample(ms, (sig >> 16) & 1, (m >> 16) & 0xFF, (i >> 16) & 1, p);
    src.ensure32(ms);
    let (s3, e3) = sample(ms, sig >> 24, m >> 24, i >> 24, p);
    ([s0, s1, s2, s3], e1, e3)
}

const PRECISION: HtError = HtError::Invalid("exponent bound beyond the sample precision");

impl Cleanup<'_> {
    /// Decodes the cleanup segment `seg` (`Lcup` bytes, `Scup` already checked) into `out`,
    /// using `rows` as scratch space.
    pub(super) fn decode(&mut self, rows: &mut Vec<u32>, seg: &[u8], scup: usize, out: &mut [u32]) -> Result<(), HtError> {
        let (width, height, stride, p, max_u) = (self.width, self.height, self.stride, self.p, self.max_u);
        let pcup = seg.len() - scup;
        let mut ms_src = FwdBytes::new(&seg[..pcup], 0xFF);
        let mut ms = Bits::default();
        let mut mel = Mel::new(seg, pcup);
        let (mut vlc_src, mut vlc) = RevBytes::vlc(seg, pcup);

        let qw = width.div_ceil(2);
        let qh = height.div_ceil(2);
        // Per quad of the line-pair above and of the current one, at index q + 1 with zeros
        // around: the codeword entry (rho in the low bits, see `CxtEntry`), and `2 mu - 1`
        // ORed over the bottom samples of columns 2q - 1 and 2q.
        // Then a row for the padding samples below an odd-height block.
        rows.clear();
        rows.resize(4 * (qw + 3) + width, 0);
        let (rho_above, rest) = rows.split_at_mut(qw + 3);
        let (rho_cur, rest) = rest.split_at_mut(qw + 3);
        let (e_above, rest) = rest.split_at_mut(qw + 3);
        let (e_cur, padding) = rest.split_at_mut(qw + 3);
        let (mut rho_above, mut rho_cur, mut e_above, mut e_cur) = (rho_above, rho_cur, e_above, e_cur);

        for r in 0..qh {
            let y = 2 * r;
            let Some(row) = out.get_mut(y * stride..) else { break };
            let (top, rest) = row.split_at_mut(width.min(row.len()));
            let bottom = match rest.get_mut(stride - width..stride) {
                Some(b) if y + 1 < height => b,
                _ => &mut padding[..width],
            };
            let at = (y / 4) * self.sigma_stride;
            let sigma = self.sigma.get_mut(at..at + self.sigma_stride).unwrap_or_default();
            let sigma_shift = (y % 4) as u32;

            if r == 0 {
                vlc_row::<true>(&mut vlc_src, &mut vlc, &mut mel, rho_above, rho_cur, qw);
                magsgn_row::<true>(&mut ms_src, &mut ms, top, bottom, rho_cur, e_above, e_cur, sigma, sigma_shift, p, max_u)?;
            } else {
                vlc_row::<false>(&mut vlc_src, &mut vlc, &mut mel, rho_above, rho_cur, qw);
                magsgn_row::<false>(&mut ms_src, &mut ms, top, bottom, rho_cur, e_above, e_cur, sigma, sigma_shift, p, max_u)?;
            }
            core::mem::swap(&mut rho_above, &mut rho_cur);
            core::mem::swap(&mut e_above, &mut e_cur);
        }
        Ok(())
    }
}

/// CxtVLC, MEL and U-VLC decoding of a line-pair of `qw` quads: `quads[q + 1]` gets quad `q`'s
/// codeword entry with `u_q` in bits 16 and up; `above` holds the line-pair above's.
#[inline(never)]
fn vlc_row<const INITIAL: bool>(src: &mut RevBytes, bits: &mut Bits, mel: &mut Mel, above: &[u32], quads: &mut [u32], qw: usize) {
    let (mut vlc, mut run) = (*bits, mel.run);
    let lookup = if INITIAL { &CXT_LOOKUP_0 } else { &CXT_LOOKUP_1 };
    let pairs = qw.div_ceil(2);
    let mut left = 0u32; // entry of the quad to the left
    // Pair i: the quads above-left to above-right of quads 2i and 2i + 1 (indices offset by 1).
    let above_pairs = above.chunks_exact(2).zip(above.get(2..).unwrap_or_default().chunks_exact(2));
    let outs = quads.get_mut(1..).unwrap_or_default().chunks_exact_mut(2);
    for (i, ((a, b), out)) in above_pairs.zip(outs).take(pairs).enumerate() {
        let pair = 2 * i + 1 < qw;
        src.ensure32(&mut vlc);
        // sigma_nw | sigma_n of the pair's quads and of the next quad.
        let (x1, x2, x3) = (above_pair(a[0], a[1]), above_pair(a[1], b[0]), above_pair(b[0], b[1]));
        let c0 = if INITIAL { context_initial(left) } else { x1 | west(left) << 1 | x2 << 2 };
        let t0 = sig_emb(&mut vlc, mel, &mut run, lookup, c0);
        let t1 = if pair {
            let c1 = if INITIAL { context_initial(t0) } else { x2 | west(t0) << 1 | x3 << 2 };
            sig_emb(&mut vlc, mel, &mut run, lookup, c1)
        } else {
            0
        };
        let (u0, u1) = residuals(&mut vlc, mel, &mut run, (t0 >> 4) & 1 | (t1 >> 3) & 2, INITIAL);
        out[0] = t0 | u0 << 16;
        out[1] = t1 | u1 << 16;
        left = if pair { t1 } else { t0 };
    }
    (*bits, mel.run) = (vlc, run);
}

/// MagSgn decoding of a line-pair into the rows `top` and `bottom`, from the entries `quads`
/// of [`vlc_row`]; `e_above` and `e_cur` hold the `2 mu - 1` of the bottom rows of the
/// line-pair above and this one (see [`Cleanup::decode`]). Also marks the significant samples
/// in `sigma`, the significance map's stripe, at row `sigma_shift`.
#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn magsgn_row<const INITIAL: bool>(
    src: &mut FwdBytes,
    bits: &mut Bits,
    top: &mut [u32],
    bottom: &mut [u32],
    quads: &[u32],
    e_above: &[u32],
    e_cur: &mut [u32],
    sigma: &mut [u16],
    sigma_shift: u32,
    p: u32,
    max_u: u32,
) -> Result<(), HtError> {
    let mut ms = *bits;
    let width = top.len();
    let qw = width.div_ceil(2);
    let mut e_left = 0u32; // 2 mu - 1 of the bottom-right sample of the quad to the left
    let mut q = 0;
    while q < qw {
        let pair = q + 1 < qw;
        let x = 2 * q;
        let Some(&[ea1, ea2, ea3]) = e_above.get(q + 1..q + 4) else { break };
        let Some(&[t0, t1]) = quads.get(q + 1..q + 3) else { break };
        let u_q0 = (t0 >> 16) + if INITIAL { 1 } else { kappa(t0, ea1 | ea2) };
        if u_q0 > max_u {
            return Err(PRECISION);
        }
        let (v0, e01, e03) = quad(src, &mut ms, t0, u_q0, p, x + 1 == width);
        let (v1, e11, e13) = if pair {
            let u_q1 = (t1 >> 16) + if INITIAL { 1 } else { kappa(t1, ea2 | ea3) };
            if u_q1 > max_u {
                return Err(PRECISION);
            }
            quad(src, &mut ms, t1, u_q1, p, x + 3 == width)
        } else {
            ([0; 4], 0, 0)
        };
        let row_top = [v0[0], v0[2], v1[0], v1[2]];
        let row_bottom = [v0[1], v0[3], v1[1], v1[3]];
        if let (Some(t), Some(b)) = (top.get_mut(x..x + 4), bottom.get_mut(x..x + 4)) {
            t.copy_from_slice(&row_top);
            b.copy_from_slice(&row_bottom);
        } else {
            for (k, (t, b)) in top.iter_mut().zip(bottom.iter_mut()).skip(x).enumerate() {
                (*t, *b) = (row_top[k], row_bottom[k]);
            }
        }
        if let Some([e_q0, e_q1]) = e_cur.get_mut(q + 1..q + 3) {
            *e_q0 = e_left | e01;
            *e_q1 = e03 | e11;
        }
        e_left = if pair { e13 } else { e03 };
        if let Some(s) = sigma.get_mut(q / 2 + 1) {
            #[allow(clippy::cast_possible_truncation)] // 16 bits
            {
                *s |= ((spread(t0 & 0xF) | spread(t1 & 0xF) << 8) << sigma_shift) as u16;
            }
        }
        q += 2;
    }
    // Columns 2 qw - 1 and 2 qw (padding) of the last quad.
    if let Some(e) = e_cur.get_mut(qw + 1) {
        *e = e_left;
    }
    *bits = ms;
    Ok(())
}
