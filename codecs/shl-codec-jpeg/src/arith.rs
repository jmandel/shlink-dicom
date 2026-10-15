//! Arithmetic entropy decoding (T.81 Annex D, F.2.4, G.2 and H.1.4.3; processes 3, 5, 7, 9, 11,
//! 13, 15 and their hierarchical forms).
//!
//! The QM decoder and the DCT procedures follow libjpeg-turbo's `jdarith.c` step for step,
//! including how it behaves on bad data: a marker inside the data supplies zero bytes, and a
//! magnitude or spectral overflow stops decoding until the next restart interval (blocks are
//! then left as they are). The lossless model (H.1.4.3) conditions each difference on the
//! differences to the left (Da) and above (Db), with the DAC thresholds L and U.

use crate::markers::{Scan, Tables, ZIGZAG};

/// Qe values and the probability state machine of T.81 Table D.2, packed as libjpeg packs
/// them: Qe << 16 | Next_Index_MPS << 8 | Switch_MPS << 7 | Next_Index_LPS.
const fn v(qe: u32, lps: u32, mps: u32, switch: u32) -> u32 {
    (qe << 16) | (mps << 8) | (switch << 7) | lps
}

#[rustfmt::skip]
const ARITAB: [u32; 114] = [
    v(0x5a1d, 1, 1, 1), v(0x2586, 14, 2, 0), v(0x1114, 16, 3, 0), v(0x080b, 18, 4, 0),
    v(0x03d8, 20, 5, 0), v(0x01da, 23, 6, 0), v(0x00e5, 25, 7, 0), v(0x006f, 28, 8, 0),
    v(0x0036, 30, 9, 0), v(0x001a, 33, 10, 0), v(0x000d, 35, 11, 0), v(0x0006, 9, 12, 0),
    v(0x0003, 10, 13, 0), v(0x0001, 12, 13, 0), v(0x5a7f, 15, 15, 1), v(0x3f25, 36, 16, 0),
    v(0x2cf2, 38, 17, 0), v(0x207c, 39, 18, 0), v(0x17b9, 40, 19, 0), v(0x1182, 42, 20, 0),
    v(0x0cef, 43, 21, 0), v(0x09a1, 45, 22, 0), v(0x072f, 46, 23, 0), v(0x055c, 48, 24, 0),
    v(0x0406, 49, 25, 0), v(0x0303, 51, 26, 0), v(0x0240, 52, 27, 0), v(0x01b1, 54, 28, 0),
    v(0x0144, 56, 29, 0), v(0x00f5, 57, 30, 0), v(0x00b7, 59, 31, 0), v(0x008a, 60, 32, 0),
    v(0x0068, 62, 33, 0), v(0x004e, 63, 34, 0), v(0x003b, 32, 35, 0), v(0x002c, 33, 9, 0),
    v(0x5ae1, 37, 37, 1), v(0x484c, 64, 38, 0), v(0x3a0d, 65, 39, 0), v(0x2ef1, 67, 40, 0),
    v(0x261f, 68, 41, 0), v(0x1f33, 69, 42, 0), v(0x19a8, 70, 43, 0), v(0x1518, 72, 44, 0),
    v(0x1177, 73, 45, 0), v(0x0e74, 74, 46, 0), v(0x0bfb, 75, 47, 0), v(0x09f8, 77, 48, 0),
    v(0x0861, 78, 49, 0), v(0x0706, 79, 50, 0), v(0x05cd, 48, 51, 0), v(0x04de, 50, 52, 0),
    v(0x040f, 50, 53, 0), v(0x0363, 51, 54, 0), v(0x02d4, 52, 55, 0), v(0x025c, 53, 56, 0),
    v(0x01f8, 54, 57, 0), v(0x01a4, 55, 58, 0), v(0x0160, 56, 59, 0), v(0x0125, 57, 60, 0),
    v(0x00f6, 58, 61, 0), v(0x00cb, 59, 62, 0), v(0x00ab, 61, 63, 0), v(0x008f, 61, 32, 0),
    v(0x5b12, 65, 65, 1), v(0x4d04, 80, 66, 0), v(0x412c, 81, 67, 0), v(0x37d8, 82, 68, 0),
    v(0x2fe8, 83, 69, 0), v(0x293c, 84, 70, 0), v(0x2379, 86, 71, 0), v(0x1edf, 87, 72, 0),
    v(0x1aa9, 87, 73, 0), v(0x174e, 72, 74, 0), v(0x1424, 72, 75, 0), v(0x119c, 74, 76, 0),
    v(0x0f6b, 74, 77, 0), v(0x0d51, 75, 78, 0), v(0x0bb6, 77, 79, 0), v(0x0a40, 77, 48, 0),
    v(0x5832, 80, 81, 1), v(0x4d1c, 88, 82, 0), v(0x438e, 89, 83, 0), v(0x3bdd, 90, 84, 0),
    v(0x34ee, 91, 85, 0), v(0x2eae, 92, 86, 0), v(0x299a, 93, 87, 0), v(0x2516, 86, 71, 0),
    v(0x5570, 88, 89, 1), v(0x4ca9, 95, 90, 0), v(0x44d9, 96, 91, 0), v(0x3e22, 97, 92, 0),
    v(0x3824, 99, 93, 0), v(0x32b4, 99, 94, 0), v(0x2e17, 93, 86, 0), v(0x56a8, 95, 96, 1),
    v(0x4f46, 101, 97, 0), v(0x47e5, 102, 98, 0), v(0x41cf, 103, 99, 0), v(0x3c3d, 104, 100, 0),
    v(0x375e, 99, 93, 0), v(0x5231, 105, 102, 0), v(0x4c0f, 106, 103, 0), v(0x4639, 107, 104, 0),
    v(0x415e, 103, 99, 0), v(0x5627, 105, 106, 1), v(0x50e7, 108, 107, 0), v(0x4b85, 109, 103, 0),
    v(0x5597, 110, 109, 0), v(0x504f, 111, 107, 0), v(0x5a10, 110, 111, 1), v(0x5522, 112, 109, 0),
    v(0x59eb, 112, 111, 1),
    // Index 113: the fixed 0.5 estimate (libjpeg's `fixed_bin`); it never changes state.
    v(0x5a1d, 113, 113, 0),
];

/// Statistics bin of the fixed-probability estimate.
const FIXED: u8 = 113;

/// The QM decoder: C and A registers and the byte source.
pub(crate) struct ArithReader<'a> {
    d: &'a [u8],
    pos: usize,
    c: i64,
    a: i64,
    /// Bits left in the input part of C; -16 before the first two bytes; -1 after an error.
    ct: i32,
    /// A marker was met: zero bytes are supplied from here until the next restart.
    at_marker: bool,
}

impl<'a> ArithReader<'a> {
    pub(crate) fn new(d: &'a [u8]) -> Self {
        Self { d, pos: 0, c: 0, a: 0, ct: -16, at_marker: false }
    }

    fn byte(&mut self) -> i64 {
        if self.at_marker {
            return 0;
        }
        let Some(&b) = self.d.get(self.pos) else {
            self.at_marker = true;
            return 0;
        };
        self.pos += 1;
        if b != 0xFF {
            return i64::from(b);
        }
        // Zero stuffing or a marker; extra 0xFF fill bytes are swallowed.
        while self.d.get(self.pos) == Some(&0xFF) {
            self.pos += 1;
        }
        match self.d.get(self.pos) {
            Some(0) => {
                self.pos += 1;
                0xFF
            }
            _ => {
                // Leave pos on the marker's final FF so `restart` finds it.
                self.pos -= 1;
                self.at_marker = true;
                0
            }
        }
    }

    /// Decode one binary decision with statistics bin `st` (T.81 D.2, `arith_decode`).
    #[inline]
    pub(crate) fn decode(&mut self, st: &mut u8) -> bool {
        while self.a < 0x8000 {
            self.ct -= 1;
            if self.ct < 0 {
                let data = self.byte();
                self.c = (self.c << 8) | data;
                self.ct += 8;
                if self.ct < 0 {
                    self.ct += 1;
                    if self.ct == 0 {
                        // Two initial bytes read: A becomes 0x10000 after the shift below.
                        self.a = 0x8000;
                    }
                }
            }
            self.a <<= 1;
        }
        let sv = *st;
        let entry = ARITAB[usize::from(sv & 0x7F).min(ARITAB.len() - 1)];
        let qe = i64::from(entry >> 16);
        let nl = (entry & 0xFF) as u8;
        let nm = ((entry >> 8) & 0xFF) as u8;
        let mut sv_out = sv;
        let mut temp = self.a - qe;
        self.a = temp;
        temp <<= self.ct.clamp(0, 62);
        if self.c >= temp {
            self.c -= temp;
            if self.a < qe {
                self.a = qe;
                *st = (sv & 0x80) ^ nm;
            } else {
                self.a = qe;
                *st = (sv & 0x80) ^ nl;
                sv_out ^= 0x80;
            }
        } else if self.a < 0x8000 {
            if self.a < qe {
                *st = (sv & 0x80) ^ nl;
                sv_out ^= 0x80;
            } else {
                *st = (sv & 0x80) ^ nm;
            }
        }
        sv_out >> 7 != 0
    }

    /// Restart (F.2.4.4): find the RSTn marker, then start a new interval.
    pub(crate) fn restart(&mut self) {
        let d = self.d;
        let mut p = self.pos;
        self.pos = d.len();
        while p + 1 < d.len() {
            if d[p] == 0xFF && (0xD0..=0xD7).contains(&d[p + 1]) {
                self.pos = p + 2;
                break;
            }
            p += 1;
        }
        self.c = 0;
        self.a = 0;
        self.ct = -16;
        self.at_marker = false;
    }

    fn failed(&self) -> bool {
        self.ct == -1
    }

    fn fail(&mut self) {
        self.ct = -1;
    }
}

/// Statistics of one DCT scan (libjpeg's `dc_stats` / `ac_stats`, per table).
pub(crate) struct DctStats {
    dc: [[u8; 64]; 4],
    ac: [[u8; 256]; 4],
    fixed: u8,
    last_dc: [i32; 4],
    dc_context: [usize; 4],
}

impl DctStats {
    pub(crate) fn new() -> Self {
        Self { dc: [[0; 64]; 4], ac: [[0; 256]; 4], fixed: FIXED, last_dc: [0; 4], dc_context: [0; 4] }
    }

    /// Reset what a scan (or restart) resets, for the scan's components and tables.
    pub(crate) fn reset(&mut self, scan: &Scan, progressive: bool) {
        for (k, sc) in scan.comps.iter().enumerate() {
            if !progressive || (scan.ss == 0 && scan.ah == 0) {
                self.dc[sc.td & 3] = [0; 64];
                self.last_dc[k] = 0;
                self.dc_context[k] = 0;
            }
            if !progressive || scan.ss != 0 {
                self.ac[sc.ta & 3] = [0; 256];
            }
        }
    }
}

/// DC difference (F.2.4.1, Figure F.19) for component `k` of the scan with table `tbl`.
/// Returns None on overflow (the caller stops decoding until the next restart).
fn dc_diff(r: &mut ArithReader, s: &mut DctStats, t: &Tables, k: usize, tbl: usize) -> Option<i32> {
    let stats = &mut s.dc[tbl & 3];
    let ctx = s.dc_context[k];
    if !r.decode(stats.get_mut(ctx)?) {
        s.dc_context[k] = 0;
        return Some(0);
    }
    let sign = r.decode(stats.get_mut(ctx + 1)?);
    let first = ctx + 2 + usize::from(sign);
    // Magnitude: category in bins first, X1 = 20...; bits in X1 + 14...
    let mut st = first;
    let mut m: i32 = i32::from(r.decode(stats.get_mut(st)?));
    if m != 0 {
        st = 20;
        while r.decode(stats.get_mut(st)?) {
            m <<= 1;
            if m == 0x8000 {
                return None;
            }
            st += 1;
        }
    }
    let (l, u) = (t.arith_dc_l[tbl & 3], t.arith_dc_u[tbl & 3]);
    s.dc_context[k] = if m < ((1i32 << l) >> 1) {
        0
    } else if m > ((1i32 << u) >> 1) {
        12 + 4 * usize::from(sign)
    } else {
        4 + 4 * usize::from(sign)
    };
    let mut v = m;
    st += 14;
    while {
        m >>= 1;
        m != 0
    } {
        if r.decode(stats.get_mut(st)?) {
            v |= m;
        }
    }
    v += 1;
    Some(if sign { -v } else { v })
}

/// One block of a sequential scan (`decode_mcu`). `differential`: the DC value is the decoded
/// difference itself (hierarchical differential frames, J.1.2), not a prediction update.
#[allow(clippy::too_many_arguments)]
pub(crate) fn seq_block(
    r: &mut ArithReader,
    s: &mut DctStats,
    t: &Tables,
    k: usize,
    td: usize,
    ta: usize,
    differential: bool,
    blk: &mut [i16; 64],
) {
    if r.failed() {
        return;
    }
    let Some(diff) = dc_diff(r, s, t, k, td) else { return r.fail() };
    let dc = if differential { diff } else { (s.last_dc[k] + diff) & 0xFFFF };
    if !differential {
        s.last_dc[k] = dc;
    }
    blk[0] = dc as i16;
    let kx = usize::from(t.arith_ac_k[ta & 3]);
    let stats = &mut s.ac[ta & 3];
    let mut k = 1usize;
    while k <= 63 {
        let mut st = 3 * (k - 1);
        if r.decode(&mut stats[st]) {
            break; // EOB
        }
        while !r.decode(&mut stats[st + 1]) {
            st += 3;
            k += 1;
            if k > 63 {
                return r.fail();
            }
        }
        let sign = r.decode(&mut s.fixed);
        let Some(v) = ac_value(r, stats, st + 2, k <= kx) else { return r.fail() };
        blk[ZIGZAG[k]] = if sign { -v } else { v } as i16;
        k += 1;
    }
}

/// AC magnitude (F.23, F.24) from bin `st` (S2 of the current index) on; `low`: k <= Kx.
fn ac_value(r: &mut ArithReader, stats: &mut [u8; 256], st: usize, low: bool) -> Option<i32> {
    let mut st = st;
    let mut m: i32 = i32::from(r.decode(stats.get_mut(st)?));
    if m != 0 && r.decode(stats.get_mut(st)?) {
        m <<= 1;
        st = if low { 189 } else { 217 };
        while r.decode(stats.get_mut(st)?) {
            m <<= 1;
            if m == 0x8000 {
                return None;
            }
            st += 1;
        }
    }
    let mut v = m;
    st += 14;
    while {
        m >>= 1;
        m != 0
    } {
        if r.decode(stats.get_mut(st)?) {
            v |= m;
        }
    }
    Some(v + 1)
}

/// Progressive DC first scan, one block (`decode_mcu_DC_first`).
#[allow(clippy::too_many_arguments)]
pub(crate) fn dc_first(r: &mut ArithReader, s: &mut DctStats, t: &Tables, k: usize, td: usize, al: u8, differential: bool, blk: &mut [i16; 64]) {
    if r.failed() {
        return;
    }
    let Some(diff) = dc_diff(r, s, t, k, td) else { return r.fail() };
    let dc = if differential { diff } else { (s.last_dc[k] + diff) & 0xFFFF };
    if !differential {
        s.last_dc[k] = dc;
    }
    blk[0] = (dc << al) as i16;
}

/// Progressive DC refinement, one block (`decode_mcu_DC_refine`).
pub(crate) fn dc_refine(r: &mut ArithReader, s: &mut DctStats, al: u8, blk: &mut [i16; 64]) {
    if r.decode(&mut s.fixed) {
        blk[0] |= (1i32 << al) as i16;
    }
}

/// Progressive AC first scan, one block (`decode_mcu_AC_first`).
pub(crate) fn ac_first(r: &mut ArithReader, s: &mut DctStats, t: &Tables, ta: usize, scan: &Scan, blk: &mut [i16; 64]) {
    if r.failed() {
        return;
    }
    let kx = usize::from(t.arith_ac_k[ta & 3]);
    let (ss, se) = (usize::from(scan.ss), usize::from(scan.se));
    let stats = &mut s.ac[ta & 3];
    let mut k = ss;
    while k <= se {
        let mut st = 3 * (k - 1);
        if r.decode(&mut stats[st]) {
            break;
        }
        while !r.decode(&mut stats[st + 1]) {
            st += 3;
            k += 1;
            if k > se {
                return r.fail();
            }
        }
        let sign = r.decode(&mut s.fixed);
        let Some(v) = ac_value(r, stats, st + 2, k <= kx) else { return r.fail() };
        let v = if sign { -v } else { v };
        blk[ZIGZAG[k]] = ((v as u32) << scan.al) as i16;
        k += 1;
    }
}

/// Progressive AC refinement, one block (`decode_mcu_AC_refine`).
pub(crate) fn ac_refine(r: &mut ArithReader, s: &mut DctStats, ta: usize, scan: &Scan, blk: &mut [i16; 64]) {
    if r.failed() {
        return;
    }
    let (ss, se) = (usize::from(scan.ss), usize::from(scan.se));
    let p1 = (1i32 << scan.al) as i16;
    let m1 = ((-1i32) << scan.al) as i16;
    let mut kex = se;
    while kex > 0 && blk[ZIGZAG[kex]] == 0 {
        kex -= 1;
    }
    let stats = &mut s.ac[ta & 3];
    let mut k = ss;
    while k <= se {
        let mut st = 3 * (k - 1);
        if k > kex && r.decode(&mut stats[st]) {
            break;
        }
        loop {
            let pos = ZIGZAG[k];
            let c = blk[pos];
            if c != 0 {
                if r.decode(&mut stats[st + 2]) {
                    blk[pos] = if c < 0 { c.wrapping_add(m1) } else { c.wrapping_add(p1) };
                }
                break;
            }
            if r.decode(&mut stats[st + 1]) {
                blk[pos] = if r.decode(&mut s.fixed) { m1 } else { p1 };
                break;
            }
            st += 3;
            k += 1;
            if k > se {
                return r.fail();
            }
        }
        k += 1;
    }
}

/// Lossless statistics for one conditioning table (H.1.4.3.1): 5 × 5 contexts of S0, SS, SP
/// and SN, then two sets of 15 X and 15 M bins (small and large |Db|).
#[derive(Clone)]
pub(crate) struct LosslessStats {
    sign_zero: [[u8; 4]; 25],
    mag: [[u8; 30]; 2],
}

impl LosslessStats {
    pub(crate) fn new() -> Self {
        Self { sign_zero: [[0; 4]; 25], mag: [[0; 30]; 2] }
    }
}

/// Category of a neighbouring difference (H.1.4.3.1): 0, ±1 small, ±2 large.
fn classify(d: i32, l: u8, u: u8) -> usize {
    let a = d.unsigned_abs();
    let c: i32 = if a <= (1u32 << l) >> 1 {
        0
    } else if a <= 1u32 << u {
        1
    } else {
        2
    };
    (if d < 0 { -c } else { c } + 2) as usize
}

/// Decode one lossless difference given the differences to the left (`da`) and above (`db`).
/// Returns None on a magnitude overflow.
pub(crate) fn lossless_diff(r: &mut ArithReader, s: &mut LosslessStats, da: i32, db: i32, l: u8, u: u8) -> Option<i32> {
    let ctx = &mut s.sign_zero[classify(da, l, u) * 5 + classify(db, l, u)];
    if !r.decode(&mut ctx[0]) {
        return Some(0);
    }
    let sign = r.decode(&mut ctx[1]);
    let mut sz = 0i32;
    if r.decode(&mut ctx[if sign { 3 } else { 2 }]) {
        let set = &mut s.mag[usize::from(db.unsigned_abs() > 1u32 << u)];
        let mut i = 0usize;
        let mut m = 2i32;
        while r.decode(set.get_mut(i)?) {
            m <<= 1;
            i += 1;
            if i >= 15 {
                return None;
            }
        }
        m >>= 1;
        sz = m;
        while {
            m >>= 1;
            m != 0
        } {
            if r.decode(set.get_mut(15 + i)?) {
                sz |= m;
            }
        }
    }
    Some(if sign { -sz - 1 } else { sz + 1 })
}

impl ArithReader<'_> {
    /// Lossless helper: whether an overflow stopped decoding in this interval.
    pub(crate) fn is_failed(&self) -> bool {
        self.failed()
    }
    pub(crate) fn set_failed(&mut self) {
        self.fail()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_matches_t81() {
        // Spot checks against T.81 Table D.2.
        assert_eq!(ARITAB[0] >> 16, 0x5a1d);
        assert_eq!(ARITAB[46] >> 16, 0x0bfb);
        assert_eq!(ARITAB[112] >> 16, 0x59eb);
        assert_eq!((ARITAB[14] >> 7) & 1, 1);
    }

    #[test]
    fn classify_categories() {
        // L = 0, U = 1: 0 is zero; ±1 and ±2 small; larger is large.
        assert_eq!(classify(0, 0, 1), 2);
        assert_eq!(classify(1, 0, 1), 3);
        assert_eq!(classify(-2, 0, 1), 1);
        assert_eq!(classify(3, 0, 1), 4);
        assert_eq!(classify(-3, 0, 1), 0);
    }
}
