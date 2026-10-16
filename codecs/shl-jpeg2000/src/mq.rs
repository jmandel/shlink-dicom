//! The MQ arithmetic decoder (T.800 Annex C) and the raw (bypass) bit reader (D.6).

/// Table C.2: Qe, index after an MPS, index after an LPS, and whether an LPS switches the MPS
/// sense. Packed as Qe | NMPS << 16 | NLPS << 22 | SWITCH << 28.
const fn e(qe: u32, nmps: u32, nlps: u32, switch: u32) -> u32 {
    qe | nmps << 16 | nlps << 22 | switch << 28
}

pub(crate) const TABLE: [u32; 47] = [
    e(0x5601, 1, 1, 1),
    e(0x3401, 2, 6, 0),
    e(0x1801, 3, 9, 0),
    e(0x0AC1, 4, 12, 0),
    e(0x0521, 5, 29, 0),
    e(0x0221, 38, 33, 0),
    e(0x5601, 7, 6, 1),
    e(0x5401, 8, 14, 0),
    e(0x4801, 9, 14, 0),
    e(0x3801, 10, 14, 0),
    e(0x3001, 11, 17, 0),
    e(0x2401, 12, 18, 0),
    e(0x1C01, 13, 20, 0),
    e(0x1601, 29, 21, 0),
    e(0x5601, 15, 14, 1),
    e(0x5401, 16, 14, 0),
    e(0x5101, 17, 15, 0),
    e(0x4801, 18, 16, 0),
    e(0x3801, 19, 17, 0),
    e(0x3401, 20, 18, 0),
    e(0x3001, 21, 19, 0),
    e(0x2801, 22, 19, 0),
    e(0x2401, 23, 20, 0),
    e(0x2201, 24, 21, 0),
    e(0x1C01, 25, 22, 0),
    e(0x1801, 26, 23, 0),
    e(0x1601, 27, 24, 0),
    e(0x1401, 28, 25, 0),
    e(0x1201, 29, 26, 0),
    e(0x1101, 30, 27, 0),
    e(0x0AC1, 31, 28, 0),
    e(0x09C1, 32, 29, 0),
    e(0x08A1, 33, 30, 0),
    e(0x0521, 34, 31, 0),
    e(0x0441, 35, 32, 0),
    e(0x02A1, 36, 33, 0),
    e(0x0221, 37, 34, 0),
    e(0x0141, 38, 35, 0),
    e(0x0111, 39, 36, 0),
    e(0x0085, 40, 37, 0),
    e(0x0049, 41, 38, 0),
    e(0x0025, 42, 39, 0),
    e(0x0015, 43, 40, 0),
    e(0x0009, 44, 41, 0),
    e(0x0005, 45, 42, 0),
    e(0x0001, 45, 43, 0),
    e(0x5601, 46, 46, 0),
];

/// A context: its state's Qe (bits 0–15), MPS (bit 16), and `2 index + MPS` (bits 24–30),
/// which indexes [`NEXT`].
pub(crate) type Cx = u32;

#[inline(always)]
const fn cx_state(index: u32, mps: u32) -> Cx {
    (TABLE[index as usize] & 0xFFFF) | mps << 16 | (2 * index + mps) << 24
}

/// For each context value's `2 index + MPS`: the context after an MPS and after an LPS
/// (C.3.2, Figures C.17 and C.18), so that a renormalising decode updates it with one load.
static NEXT: [[Cx; 2]; 94] = {
    let mut t = [[0; 2]; 94];
    let mut i = 0;
    while i < 94 {
        let (index, mps) = ((i / 2) as u32, (i % 2) as u32);
        let e = TABLE[index as usize];
        t[i] = [cx_state(e >> 16 & 0x3F, mps), cx_state(e >> 22 & 0x3F, mps ^ (e >> 28))];
        i += 1;
    }
    t
};

/// The 19 contexts of Annex D in their initial states (Table D.7): all at state 0 except
/// zero-coding context 0 (state 4), run-length (state 3) and uniform (state 46).
pub(crate) fn initial_contexts() -> [Cx; 19] {
    let mut c = [cx_state(0, 0); 19];
    c[0] = cx_state(4, 0);
    c[17] = cx_state(3, 0);
    c[18] = cx_state(46, 0);
    c
}

#[derive(Clone, Copy)]
pub(crate) struct Mq<'a> {
    data: &'a [u8],
    /// Index of the byte last read into C.
    pos: usize,
    c: u32,
    a: u32,
    ct: u32,
}

impl<'a> Mq<'a> {
    #[inline]
    fn byte(&self, i: usize) -> u32 {
        // Past the end the decoder sees 0xFF bytes (as if terminated by a marker).
        u32::from(*self.data.get(i).unwrap_or(&0xFF))
    }

    /// INITDEC (C.3.5).
    pub(crate) fn new(data: &'a [u8]) -> Self {
        let mut d = Mq { data, pos: 0, c: 0, a: 0x8000, ct: 0 };
        d.c = d.byte(0) << 16;
        d.byte_in();
        d.c <<= 7;
        d.ct -= 7;
        d.a = 0x8000;
        d
    }

    /// BYTEIN (C.3.4).
    #[inline]
    fn byte_in(&mut self) {
        if self.byte(self.pos) == 0xFF {
            let next = self.byte(self.pos + 1);
            if next > 0x8F {
                self.c = self.c.wrapping_add(0xFF00);
                self.ct = 8;
            } else {
                self.pos += 1;
                self.c = self.c.wrapping_add(next << 9);
                self.ct = 7;
            }
        } else {
            self.pos += 1;
            self.c = self.c.wrapping_add(self.byte(self.pos) << 8);
            self.ct = 8;
        }
    }

    #[inline(always)]
    fn renorm(&mut self) {
        // RENORMD (C.3.3), shifting as many bits at a time as A and CT allow.
        while self.a < 0x8000 {
            if self.ct == 0 {
                self.byte_in();
            }
            let n = (self.a.leading_zeros() - 16).min(self.ct);
            self.a <<= n;
            self.c <<= n;
            self.ct -= n;
        }
    }

    /// DECODE (C.3.2), with the MPS/LPS sub-interval choice and the conditional exchange done
    /// without branches: only renormalisation branches.
    #[inline(always)]
    pub(crate) fn decode(&mut self, cx: &mut Cx) -> u32 {
        let state = *cx;
        let qe = state & 0xFFFF;
        let mps = (state >> 16) & 1;
        let a = self.a - qe;
        // In the LPS sub-interval (C below Qe), A becomes Qe and C is unchanged; otherwise C
        // drops by Qe.
        let lps_interval = (self.c >> 16) < qe;
        let exchange = a < qe;
        let d = mps ^ u32::from(lps_interval) ^ u32::from(exchange);
        if !lps_interval {
            self.c -= qe << 16;
        }
        let a = if lps_interval { qe } else { a };
        self.a = a;
        if a & 0x8000 == 0 {
            *cx = NEXT[(state >> 24) as usize & 0x7F][usize::from(d != mps)];
            self.renorm();
        }
        d
    }
}

/// Raw coding-pass bits (D.6 selective arithmetic coding bypass): MSB first, a stuffed 0 bit
/// after each 0xFF byte. Past the end, 1 bits.
#[derive(Clone, Copy)]
pub(crate) struct Raw<'a> {
    data: &'a [u8],
    pos: usize,
    bits: u32,
    left: u32,
    last_ff: bool,
}

impl<'a> Raw<'a> {
    pub(crate) fn new(data: &'a [u8]) -> Self {
        Raw { data, pos: 0, bits: 0, left: 0, last_ff: false }
    }

    #[inline]
    pub(crate) fn bit(&mut self) -> u32 {
        if self.left == 0 {
            match self.data.get(self.pos) {
                Some(&b) => {
                    self.pos += 1;
                    if self.last_ff {
                        // The stuffed bit is skipped whatever its value.
                        self.bits = u32::from(b) & 0x7F;
                        self.left = 7;
                    } else {
                        self.bits = u32::from(b);
                        self.left = 8;
                    }
                    self.last_ff = b == 0xFF;
                }
                None => return 1,
            }
        }
        self.left -= 1;
        (self.bits >> self.left) & 1
    }
}
