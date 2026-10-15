//! Scan decoding: context modelling, Golomb coding and run mode (T.87 Annex A), for
//! interleave modes 0, 1 and 2, lossless and near-lossless.

use crate::bits::BitReader;
use shl_codec_common::{DecodeError, Result};

const J: [u32; 32] = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 9, 10, 11, 12, 13, 14, 15];

#[cold]
#[inline(never)]
fn invalid(m: &str) -> DecodeError {
    DecodeError::Invalid(m.into())
}

/// Coding parameters for one scan (T.87 C.2.4.1.1 after defaults are applied).
#[derive(Debug, Clone, Copy)]
pub struct Params {
    pub maxval: i32,
    pub near: i32,
    pub t1: i32,
    pub t2: i32,
    pub t3: i32,
    pub reset: i32,
}

/// Default thresholds, T.87 C.2.4.1.1.1.
pub fn default_thresholds(maxval: i32, near: i32) -> (i32, i32, i32) {
    let clamp = |i: i32, j: i32| if i > maxval || i < j { j } else { i };
    if maxval >= 128 {
        let f = (maxval.min(4095) + 128) / 256;
        let t1 = clamp(f + 2 + 3 * near, near + 1); // FACTOR * (BASIC_T1 - 2) + 2 + 3 * NEAR
        let t2 = clamp(f * (7 - 3) + 3 + 5 * near, t1);
        let t3 = clamp(f * (21 - 4) + 4 + 7 * near, t2);
        (t1, t2, t3)
    } else {
        let f = 256 / (maxval + 1);
        let t1 = clamp((3 / f + 3 * near).max(2), near + 1);
        let t2 = clamp((7 / f + 5 * near).max(3), t1);
        let t3 = clamp((21 / f + 7 * near).max(4), t2);
        (t1, t2, t3)
    }
}

#[derive(Clone, Copy)]
struct Ctx {
    a: i64,
    b: i64,
    c: i64,
    n: i64,
}

#[derive(Clone, Copy)]
struct RunCtx {
    a: i64,
    n: i64,
    nn: i64,
}

/// The gradient quantiser covers d in [-65535, 65535], indexed by d's low 17 bits (two's
/// complement), so lookups need no offset and no bounds check.
const QLUT_LEN: usize = 1 << 17;
const QLUT_MASK: usize = QLUT_LEN - 1;
/// Regular contexts are 0..=364; the array is padded to a power of two for masked indexing.
const NCTX: usize = 512;

/// Short Golomb codes (T.87 A.5.3) by (k, next 8 bits), as CharLS does: each entry is
/// `(Errval << 8) | code length`, with Errval already unmapped (before the k = 0 error
/// correction); 0 means the code is longer than 8 bits. Only k < 8 can fit. A code of at
/// most 8 bits is never an escape (escapes need LIMIT − qbpp − 1 >= 17 zeros), and its
/// mapped value is below 128.
const GOLOMB_LUT: [[i32; 256]; 8] = build_golomb_lut();

const fn build_golomb_lut() -> [[i32; 256]; 8] {
    let mut t = [[0i32; 256]; 8];
    let mut k = 0;
    while k < 8 {
        let mut b = 0;
        while b < 256 {
            let lz = if b == 0 { 8 } else { (b as u8).leading_zeros() as usize };
            let len = lz + 1 + k;
            if lz < 8 && len <= 8 {
                let suffix = (b >> (8 - len)) & ((1 << k) - 1);
                let m = ((lz << k) | suffix) as i32;
                let err = (m >> 1) ^ -(m & 1);
                t[k][b] = (err << 8) | len as i32;
            }
            b += 1;
        }
        k += 1;
    }
    t
}

/// Run `$body` for `$c` = 0, 1, 2, 3 while `$c < $n`; with a const `$n` this unrolls the
/// per-component loops of the sample-interleaved decoder.
macro_rules! unroll4 {
    ($n:expr, $c:ident, $body:block) => {{
        { const $c: usize = 0; if $c < $n $body }
        { const $c: usize = 1; if $c < $n $body }
        { const $c: usize = 2; if $c < $n $body }
        { const $c: usize = 3; if $c < $n $body }
    }};
}

/// Per-scan constants, copied into locals by the line decoders and passed by value, so
/// the hot loop does not reload them after every context store.
#[derive(Clone, Copy)]
struct Consts {
    /// Golomb table use is limited to k below this: 8, or 0 (off) when RANGE < 128, so
    /// table values (mapped values below 128) also respect the 2·RANGE − 1 cap.
    lut_kmax: u32,
    esc: u32,
    qbpp: u32,
    mcap: u64,
    maxval: i32,
    range: i32,
    reset: i64,
    step: i64,
}

pub struct Decoder {
    maxval: i32,
    near: i32,
    range: i32,
    qbpp: u32,
    limit: u32,
    /// LIMIT − qbpp − 1: the number of zeros that announces an escape in regular mode.
    esc: u32,
    /// Largest mapped error value accepted: 2·RANGE − 1. Valid codes never exceed it
    /// (regular codes stay at or below RANGE; escapes at or below 2^qbpp < 2·RANGE), and it
    /// bounds |Errval| by RANGE, so one modular wrap always lands in [0, MAXVAL].
    mcap: u64,
    reset: i64,
    step: i32, // 2*NEAR+1
    a_init: i64,
    qlut: Box<[i8; QLUT_LEN]>,
    ctx: Box<[Ctx; NCTX]>,
    rctx: [RunCtx; 2],
}

fn ceil_log2(v: i64) -> u32 {
    let mut k = 0;
    while (1i64 << k) < v {
        k += 1;
    }
    k
}

/// Bias cancellation (T.87 A.6.2), branch-free. With lo = B ≤ −N and hi = B > 0:
/// lo adds N to B and decrements C; hi subtracts N and increments C; then B is limited to
/// [−N + 1, 0]. That limit is a no-op when neither holds, because B is already in range.
#[inline(always)]
fn bias_update(c: &mut Ctx) {
    let lo = i64::from(c.b <= -c.n);
    let hi = i64::from(c.b > 0);
    c.b = (c.b + c.n * (lo - hi)).max(-c.n + 1).min(0);
    // C moves by one step, saturating at [-128, 127].
    c.c = (c.c + hi - lo).clamp(-128, 127);
}

/// Smallest k with n << k >= a (T.87 A.5.1), for n >= 1. Fails above 31.
#[inline(always)]
fn golomb_k(n: i64, a: i64) -> Result<u32> {
    let k = (n.leading_zeros()).saturating_sub(a.leading_zeros());
    let k = if (n << k) < a { k + 1 } else { k };
    if k > 31 {
        return Err(invalid("Golomb parameter out of range"));
    }
    Ok(k)
}

impl Decoder {
    pub fn new(p: &Params) -> Self {
        let maxval = p.maxval;
        let near = p.near;
        let step = 2 * near + 1;
        let range = (maxval + 2 * near) / step + 1;
        let qbpp = ceil_log2(i64::from(range));
        let bpp = ceil_log2(i64::from(maxval) + 1).max(2);
        let limit = 2 * (bpp + bpp.max(8));
        let a_init = i64::from(((range + 32) / 64).max(2));
        let mut qlut = Box::new([0i8; QLUT_LEN]);
        // Quantiser regions (A.3.3) as contiguous ranges of d, each [lo, hi] inclusive and
        // clipped to [-maxval, maxval].
        let regions = [
            (-maxval, -p.t3, -4i8),
            (-p.t3 + 1, -p.t2, -3),
            (-p.t2 + 1, -p.t1, -2),
            (-p.t1 + 1, -near - 1, -1),
            (-near, near, 0),
            (near + 1, p.t1 - 1, 1),
            (p.t1, p.t2 - 1, 2),
            (p.t2, p.t3 - 1, 3),
            (p.t3, maxval, 4),
        ];
        for (lo, hi, q) in regions {
            let (lo, hi) = (lo.max(-maxval), hi.min(maxval));
            // Negative and non-negative parts land in different halves of the table.
            for (l, h) in [(lo, hi.min(-1)), (lo.max(0), hi)] {
                if l <= h {
                    let (a, b) = ((l as u32 as usize) & QLUT_MASK, (h as u32 as usize) & QLUT_MASK);
                    if let Some(r) = qlut.get_mut(a..=b) {
                        r.fill(q);
                    }
                }
            }
        }
        let mut d = Decoder {
            maxval,
            near,
            range,
            qbpp,
            limit,
            esc: limit.saturating_sub(qbpp + 1),
            mcap: (2 * range - 1) as u64,
            reset: i64::from(p.reset),
            step,
            a_init,
            qlut,
            ctx: Box::new([Ctx { a: 0, b: 0, c: 0, n: 1 }; NCTX]),
            rctx: [RunCtx { a: 0, n: 0, nn: 0 }; 2],
        };
        d.reset_contexts();
        d
    }

    /// Initialise context variables (T.87 A.2.1); also used at restart markers.
    pub fn reset_contexts(&mut self) {
        self.ctx.fill(Ctx { a: self.a_init, b: 0, c: 0, n: 1 });
        self.rctx = [RunCtx { a: self.a_init, n: 1, nn: 0 }; 2];
    }

    #[inline(always)]
    fn q(&self, d: i32) -> i32 {
        i32::from(self.qlut[(d as u32 as usize) & QLUT_MASK])
    }

    #[inline(always)]
    fn context(&self, ra: i32, rb: i32, rc: i32, rd: i32) -> i32 {
        (self.q(rd - rb) * 9 + self.q(rb - rc)) * 9 + self.q(rc - ra)
    }

    /// Reconstruct a sample from prediction and (sign-applied) error (T.87 A.4.4, A.5).
    #[inline(always)]
    fn reconstruct<const LOSSLESS: bool>(&self, px: i32, err: i64) -> i32 {
        if LOSSLESS {
            // |err| <= RANGE (mcap), so this cannot overflow.
            let mut rx = px + err as i32;
            if rx < 0 {
                rx += self.range;
            } else if rx > self.maxval {
                rx -= self.range;
            }
            return rx.clamp(0, self.maxval);
        }
        let step = i64::from(self.step);
        let mut rx = i64::from(px) + err * step;
        let wrap = i64::from(self.range) * step;
        if rx < -i64::from(self.near) {
            rx += wrap;
        } else if rx > i64::from(self.maxval + self.near) {
            rx -= wrap;
        }
        rx.clamp(0, i64::from(self.maxval)) as i32
    }

    fn consts(&self) -> Consts {
        Consts {
            lut_kmax: if self.range >= 128 { 8 } else { 0 },
            esc: self.esc,
            qbpp: self.qbpp,
            mcap: self.mcap,
            maxval: self.maxval,
            range: self.range,
            reset: self.reset,
            step: i64::from(self.step),
        }
    }

    /// Regular-mode sample (T.87 A.4–A.6). `q` is the signed context number. The bit
    /// cache is passed as locals (`cache`, `valid`) so that, once inlined, it stays in
    /// registers; `br` is only touched for refills and slow Golomb codes.
    #[inline(always)]
    #[allow(clippy::too_many_arguments)]
    fn regular<const LOSSLESS: bool>(
        &mut self,
        kc: Consts,
        br: &mut BitReader,
        cache: &mut u64,
        valid: &mut u32,
        q: i32,
        ra: i32,
        rb: i32,
        rc: i32,
    ) -> Result<i32> {
        let Consts { lut_kmax, esc, qbpp, mcap, maxval, range, reset, step } = kc;
        let neg = q < 0;
        let qi = (q.unsigned_abs() as usize) & (NCTX - 1);
        // MED predictor as a branch-free median of (Ra, Rb, Ra + Rb − Rc).
        let mut px = ra.min(rb).max(ra.max(rb).min(ra + rb - rc));
        let c = &mut self.ctx[qi];
        let corr = c.c as i32;
        px = if neg { px - corr } else { px + corr }.max(0).min(maxval);
        let k = golomb_k(c.n, c.a)?;
        if *valid < 40 {
            (*cache, *valid) = br.refill(*cache, *valid);
        }
        let short = if k < lut_kmax { GOLOMB_LUT[(k & 7) as usize][(*cache >> 56) as usize] } else { 0 };
        let len = (short & 0xFF) as u32;
        let mut err = if len != 0 && len <= *valid {
            *cache <<= len;
            *valid -= len;
            i64::from(short >> 8)
        } else {
            let lz = cache.leading_zeros();
            let m = if lz < esc && lz + 1 + k <= *valid {
                // Suffix bits; for k = 0 the shift by 63 − k leaves nothing.
                let v = ((*cache << lz << 1) >> 1) >> (63 - k);
                let n = lz + 1 + k;
                // n <= valid <= 63, so the shift is exact.
                *cache = cache.wrapping_shl(n);
                *valid -= n;
                (u64::from(lz) << k) | v
            } else {
                br.cache = *cache;
                br.valid = *valid;
                let m = br.golomb(k, esc, qbpp)?;
                *cache = br.cache;
                *valid = br.valid;
                m
            };
            if m > mcap {
                return Err(invalid("mapped error out of range"));
            }
            let m = m as i64;
            (m >> 1) ^ -(m & 1)
        };
        if LOSSLESS {
            // Error correction (A.5.2): Errval = −(Errval + 1) when k = 0 and 2B ≤ −N.
            err ^= -i64::from(k == 0 && 2 * c.b + c.n - 1 < 0);
        }
        c.b += if LOSSLESS { err } else { err * step };
        c.a += err.abs();
        if c.n == reset {
            c.a >>= 1;
            c.b >>= 1;
            c.n >>= 1;
        }
        c.n += 1;
        bias_update(c);
        let e = if neg { -err } else { err };
        Ok(if LOSSLESS {
            // |e| <= RANGE and px is in [0, MAXVAL], so one wrap lands in [0, MAXVAL].
            let mut rx = px + e as i32;
            if rx < 0 {
                rx += range;
            }
            if rx > maxval {
                rx -= range;
            }
            rx
        } else {
            self.reconstruct::<false>(px, e)
        })
    }

    /// Run length (T.87 A.7.1.2); `left` samples remain in the line. Returns the run length.
    #[inline(always)]
    fn run_length(&self, br: &mut BitReader, run_index: &mut usize, left: usize) -> Result<usize> {
        let mut n = 0usize;
        while br.bit()? {
            let full = 1usize << J[*run_index & 31];
            let cnt = full.min(left - n);
            n += cnt;
            if cnt == full && *run_index < 31 {
                *run_index += 1;
            }
            if n == left {
                return Ok(n);
            }
        }
        let j = J[*run_index & 31];
        n += br.bits(j)? as usize;
        if n >= left {
            // An interrupted run must end before the end of the line.
            return Err(invalid("run length exceeds line"));
        }
        Ok(n)
    }

    /// Run-interruption error (T.87 A.7.2), context 0 or 1 (RItype).
    #[inline(always)]
    fn ri_error(&mut self, br: &mut BitReader, ritype: usize, run_index: usize) -> Result<i64> {
        let rc = self.rctx[ritype & 1];
        let temp = rc.a + if ritype == 1 { rc.n >> 1 } else { 0 };
        let k = golomb_k(rc.n, temp)?;
        let limit = self.limit - J[run_index & 31] - 1;
        let esc = limit.checked_sub(self.qbpp + 1).filter(|&e| e > 0).ok_or_else(|| invalid("Golomb limit too small"))?;
        let em = br.golomb(k, esc, self.qbpp)?;
        if em > self.mcap {
            return Err(invalid("mapped error out of range"));
        }
        let em = em as i64;
        let t = em + ritype as i64;
        let map = t & 1 == 1;
        let abs = (t + i64::from(map)) / 2;
        let err = if (k != 0 || 2 * rc.nn >= rc.n) == map { -abs } else { abs };
        let c = &mut self.rctx[ritype & 1];
        if err < 0 {
            c.nn += 1;
        }
        c.a += (em + 1 - ritype as i64) >> 1;
        if c.n == self.reset {
            c.a >>= 1;
            c.n >>= 1;
            c.nn >>= 1;
        }
        c.n += 1;
        Ok(err)
    }

    #[inline(always)]
    fn ri_sample<const LOSSLESS: bool>(&mut self, br: &mut BitReader, ra: i32, rb: i32, run_index: usize, force0: bool) -> Result<i32> {
        if !force0 && (ra - rb).abs() <= self.near {
            let e = self.ri_error(br, 1, run_index)?;
            Ok(self.reconstruct::<LOSSLESS>(ra, e))
        } else {
            let e = self.ri_error(br, 0, run_index)?;
            let s = if rb < ra { -1 } else { 1 };
            Ok(self.reconstruct::<LOSSLESS>(rb, e * s))
        }
    }

    /// Decode one line of a single component. `prev` and `cur` have `w + 2` entries; sample x
    /// lives at index x + 1. The caller sets the edge entries (A.2.1 / CharLS convention).
    #[inline(never)]
    pub fn line<const LOSSLESS: bool>(&mut self, br: &mut BitReader, prev: &[i32], cur: &mut [i32], run_index: &mut usize) -> Result<()> {
        // Work on a local copy of the bit reader so its state can live in registers.
        let mut r = *br;
        let res = self.line_inner::<LOSSLESS>(&mut r, prev, cur, run_index);
        *br = r;
        res
    }

    #[inline(always)]
    fn line_inner<const LOSSLESS: bool>(&mut self, br: &mut BitReader, prev: &[i32], cur: &mut [i32], run_index: &mut usize) -> Result<()> {
        let len = cur.len();
        if len < 2 || prev.len() != len {
            return Err(invalid("line buffer size"));
        }
        let w = len - 2;
        // Hot state in locals: the bit cache, the constants and the neighbours.
        let kc = self.consts();
        let mut cache = br.cache;
        let mut valid = br.valid;
        let mut x = 1;
        let mut ra = cur[0];
        let mut rc = prev[0];
        let mut rb = prev[1];
        while x <= w {
            let rd = prev[x + 1];
            let q = self.context(ra, rb, rc, rd);
            if q != 0 {
                let rx = self.regular::<LOSSLESS>(kc, br, &mut cache, &mut valid, q, ra, rb, rc)?;
                cur[x] = rx;
                ra = rx;
                rc = rb;
                rb = rd;
                x += 1;
                continue;
            }
            // Run mode: rare enough to go through the bit reader struct.
            br.cache = cache;
            br.valid = valid;
            let n = self.run_length(br, run_index, w + 1 - x)?;
            cur[x..x + n].fill(ra);
            x += n;
            if x <= w {
                cur[x] = self.ri_sample::<LOSSLESS>(br, ra, prev[x], *run_index, false)?;
                *run_index = run_index.saturating_sub(1);
                x += 1;
            }
            cache = br.cache;
            valid = br.valid;
            if x <= w {
                ra = cur[x - 1];
                rc = prev[x - 1];
                rb = prev[x];
            }
        }
        br.cache = cache;
        br.valid = valid;
        Ok(())
    }

    /// Decode one sample-interleaved line of `nc` (1..=4) components. Buffers hold
    /// (w + 2) * nc entries; component c of sample x lives at (x + 1) * nc + c.
    #[inline(never)]
    pub fn line_ilv2<const LOSSLESS: bool>(&mut self, br: &mut BitReader, prev: &[i32], cur: &mut [i32], nc: usize, run_index: &mut usize) -> Result<()> {
        let mut r = *br;
        let res = match nc {
            1 => self.line_ilv2_inner::<LOSSLESS, 1>(&mut r, prev, cur, run_index),
            2 => self.line_ilv2_inner::<LOSSLESS, 2>(&mut r, prev, cur, run_index),
            3 => self.line_ilv2_inner::<LOSSLESS, 3>(&mut r, prev, cur, run_index),
            4 => self.line_ilv2_inner::<LOSSLESS, 4>(&mut r, prev, cur, run_index),
            _ => Err(invalid("ILV 2 with more than 4 components")),
        };
        *br = r;
        res
    }

    /// Decode one sample-interleaved line of `NC` components. Buffers hold (w + 2) * NC
    /// entries; component c of sample x lives at (x + 1) * NC + c.
    #[inline(always)]
    fn line_ilv2_inner<const LOSSLESS: bool, const NC: usize>(&mut self, br: &mut BitReader, prev: &[i32], cur: &mut [i32], run_index: &mut usize) -> Result<()> {
        let len = cur.len();
        if prev.len() != len || !len.is_multiple_of(NC) || len / NC < 2 {
            return Err(invalid("line buffer size"));
        }
        let w = len / NC - 2;
        let kc = self.consts();
        let mut cache = br.cache;
        let mut valid = br.valid;
        let mut ra = [0i32; NC];
        let mut rb = [0i32; NC];
        let mut rc = [0i32; NC];
        ra.copy_from_slice(&cur[..NC]);
        rc.copy_from_slice(&prev[..NC]);
        rb.copy_from_slice(&prev[NC..2 * NC]);
        let mut x = 1;
        while x <= w {
            let mut rd = [0i32; NC];
            rd.copy_from_slice(&prev[(x + 1) * NC..(x + 2) * NC]);
            let mut qs = [0i32; NC];
            let mut any = false;
            unroll4!(NC, C, {
                qs[C] = self.context(ra[C], rb[C], rc[C], rd[C]);
                any |= qs[C] != 0;
            });
            if any {
                let mut rx = [0i32; NC];
                unroll4!(NC, C, {
                    rx[C] = self.regular::<LOSSLESS>(kc, br, &mut cache, &mut valid, qs[C], ra[C], rb[C], rc[C])?;
                });
                cur[x * NC..(x + 1) * NC].copy_from_slice(&rx);
                ra = rx;
                rc = rb;
                rb = rd;
                x += 1;
                continue;
            }
            // Run mode over whole pixels (all components equal to their left neighbours).
            br.cache = cache;
            br.valid = valid;
            let n = self.run_length(br, run_index, w + 1 - x)?;
            for px in cur[x * NC..(x + n) * NC].chunks_exact_mut(NC) {
                px.copy_from_slice(&ra);
            }
            x += n;
            if x <= w {
                for c in 0..NC {
                    cur[x * NC + c] = self.ri_sample::<LOSSLESS>(br, ra[c], prev[x * NC + c], *run_index, true)?;
                }
                *run_index = run_index.saturating_sub(1);
                x += 1;
            }
            cache = br.cache;
            valid = br.valid;
            if x <= w {
                ra.copy_from_slice(&cur[(x - 1) * NC..x * NC]);
                rc.copy_from_slice(&prev[(x - 1) * NC..x * NC]);
                rb.copy_from_slice(&prev[x * NC..(x + 1) * NC]);
            }
        }
        br.cache = cache;
        br.valid = valid;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golomb_lut_matches_bit_reader() {
        // Every (k, byte) entry must decode exactly as the general Golomb path does.
        for k in 0..8u32 {
            for b in 0..=255u8 {
                if b == 0xFF {
                    continue; // would be followed by a stuffed byte in a real stream
                }
                let data = [b, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55];
                let mut br = BitReader::new(&data);
                let m = br.golomb(k, 23, 8).unwrap() as i64;
                let used = 64 - br_remaining(&br); // bits the general path consumed
                let e = GOLOMB_LUT[k as usize][usize::from(b)];
                let len = (e & 0xFF) as u32;
                if len == 0 {
                    assert!(used > 8, "k={k} b={b:#x}: short code missing from table");
                } else {
                    assert_eq!(len, used, "k={k} b={b:#x}: length");
                    assert_eq!(i64::from(e >> 8), (m >> 1) ^ -(m & 1), "k={k} b={b:#x}: value");
                }
            }
        }
    }

    fn br_remaining(br: &BitReader) -> u32 {
        let mut c = *br;
        let mut n = 0;
        while c.bits(1).is_ok() {
            n += 1;
        }
        n
    }

    #[test]
    fn golomb_k_is_minimal() {
        for n in 1..300i64 {
            for a in 1..5000i64 {
                let mut k = 0;
                while (n << k) < a {
                    k += 1;
                }
                assert_eq!(golomb_k(n, a).unwrap(), k, "n={n} a={a}");
            }
        }
    }

    #[test]
    fn default_thresholds_match_t87_table() {
        assert_eq!(default_thresholds(255, 0), (3, 7, 21));
        assert_eq!(default_thresholds(4095, 0), (18, 67, 276));
        assert_eq!(default_thresholds(65535, 0), (18, 67, 276));
        assert_eq!(default_thresholds(255, 3), (12, 22, 42));
        assert_eq!(default_thresholds(15, 0), (2, 3, 4));
        assert_eq!(default_thresholds(15, 1), (3, 5, 8));
        assert_eq!(default_thresholds(3, 1), (3, 3, 3));
    }
}
