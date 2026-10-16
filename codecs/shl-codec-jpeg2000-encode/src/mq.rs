//! MQ arithmetic encoder (T.800 Annex C.2), with the 19 contexts of EBCOT tier-1.

/// (Qe, NMPS, NLPS, SWITCH) of Table C.2, padded to 64 entries so an index masked to 6 bits
/// needs no bounds check.
#[rustfmt::skip]
const QE: [(u32, u8, u8, bool); 64] = [
    (0x5601, 1, 1, true), (0x3401, 2, 6, false), (0x1801, 3, 9, false), (0x0AC1, 4, 12, false),
    (0x0521, 5, 29, false), (0x0221, 38, 33, false), (0x5601, 7, 6, true), (0x5401, 8, 14, false),
    (0x4801, 9, 14, false), (0x3801, 10, 14, false), (0x3001, 11, 17, false), (0x2401, 12, 18, false),
    (0x1C01, 13, 20, false), (0x1601, 29, 21, false), (0x5601, 15, 14, true), (0x5401, 16, 14, false),
    (0x5101, 17, 15, false), (0x4801, 18, 16, false), (0x3801, 19, 17, false), (0x3401, 20, 18, false),
    (0x3001, 21, 19, false), (0x2801, 22, 19, false), (0x2401, 23, 20, false), (0x2201, 24, 21, false),
    (0x1C01, 25, 22, false), (0x1801, 26, 23, false), (0x1601, 27, 24, false), (0x1401, 28, 25, false),
    (0x1201, 29, 26, false), (0x1101, 30, 27, false), (0x0AC1, 31, 28, false), (0x09C1, 32, 29, false),
    (0x08A1, 33, 30, false), (0x0521, 34, 31, false), (0x0441, 35, 32, false), (0x02A1, 36, 33, false),
    (0x0221, 37, 34, false), (0x0141, 38, 35, false), (0x0111, 39, 36, false), (0x0085, 40, 37, false),
    (0x0049, 41, 38, false), (0x0025, 42, 39, false), (0x0015, 43, 40, false), (0x0009, 44, 41, false),
    (0x0005, 45, 42, false), (0x0001, 45, 43, false), (0x5601, 46, 46, false),
    (0, 0, 0, false), (0, 0, 0, false), (0, 0, 0, false), (0, 0, 0, false), (0, 0, 0, false),
    (0, 0, 0, false), (0, 0, 0, false), (0, 0, 0, false), (0, 0, 0, false), (0, 0, 0, false),
    (0, 0, 0, false), (0, 0, 0, false), (0, 0, 0, false), (0, 0, 0, false), (0, 0, 0, false),
    (0, 0, 0, false), (0, 0, 0, false),
];

pub(crate) const CTX_RL: usize = 17;
pub(crate) const CTX_UNI: usize = 18;

/// One (state, MPS) pair: Qe, the MPS, and the pair to move to after coding an MPS or an LPS
/// (the LPS move already includes the MPS switch). Index = state × 2 + MPS.
#[derive(Clone, Copy)]
struct Entry {
    qe: u32,
    mps: u32,
    next_mps: u8,
    next_lps: u8,
}

const fn entries() -> [Entry; 128] {
    let mut t = [Entry { qe: 0, mps: 0, next_mps: 0, next_lps: 0 }; 128];
    let mut k = 0;
    while k < 47 {
        let (qe, nmps, nlps, switch) = QE[k];
        let mut mps = 0;
        while mps < 2 {
            let lps_mps = if switch { 1 - mps } else { mps };
            t[k * 2 + mps] = Entry { qe, mps: mps as u32, next_mps: nmps * 2 + mps as u8, next_lps: nlps * 2 + lps_mps as u8 };
            mps += 1;
        }
        k += 1;
    }
    t
}

static ENTRIES: [Entry; 128] = entries();

/// Initial state of each context (T.800 Table D.7): state 4 for the all-zero significance
/// context, 3 for run-length, 46 for uniform, 0 otherwise; MPS 0.
const INITIAL: [Entry; 32] = {
    let e = entries();
    let mut t = [e[0]; 32];
    t[0] = e[4 * 2];
    t[CTX_RL] = e[3 * 2];
    t[CTX_UNI] = e[46 * 2];
    t
};

pub(crate) struct MqEncoder {
    a: u32,
    c: u32,
    ct: u32,
    /// out[0] is a placeholder before the first byte (BP starts there, T.800 C.2.8).
    out: Vec<u8>,
    /// The current (state, MPS) entry of each context, held by value so coding a symbol needs
    /// one load.
    ctx: [Entry; 32],
}

impl MqEncoder {
    pub(crate) fn new() -> Self {
        Self { a: 0x8000, c: 0, ct: 12, out: vec![0], ctx: INITIAL }
    }

    /// Reset for the next code-block, keeping the buffer's allocation.
    pub(crate) fn reset(&mut self) {
        self.a = 0x8000;
        self.c = 0;
        self.ct = 12;
        self.out.clear();
        self.out.push(0);
        self.ctx = INITIAL;
    }

    /// ENCODE (C.2.1), with CODEMPS and CODELPS folded into conditional moves: after A −= Qe,
    /// the interval exchange happens exactly when (A < Qe) differs from "this is the MPS", and then
    /// A becomes Qe; otherwise C += Qe. The state moves on an LPS, or on an MPS that renormalises.
    #[inline(always)]
    pub(crate) fn encode(&mut self, bit: u32, cx: usize) {
        let st = &mut self.ctx[cx & 31];
        let e = *st;
        let lps = bit != e.mps;
        let a = self.a - e.qe;
        let exchange = (a < e.qe) ^ lps;
        self.c += if exchange { 0 } else { e.qe };
        self.a = if exchange { e.qe } else { a };
        if self.a & 0x8000 == 0 {
            *st = ENTRIES[usize::from(if lps { e.next_lps } else { e.next_mps } & 127)];
            self.renorm();
        }
    }

    /// RENORME: shift A until its top bit is set, emitting a byte whenever CT reaches 0. Shifts
    /// in runs (the count is known from A's leading zeros) instead of one bit at a time.
    #[inline(always)]
    fn renorm(&mut self) {
        let mut n = (self.a as u16).leading_zeros();
        while n > 0 {
            let s = n.min(self.ct);
            self.a <<= s;
            self.c <<= s;
            self.ct -= s;
            n -= s;
            if self.ct == 0 {
                self.byte_out();
            }
        }
    }

    #[inline(never)]
    fn byte_out(&mut self) {
        // B is the last byte written (initially the placeholder).
        let last = self.out.len() - 1;
        if self.out[last] == 0xFF {
            self.out.push((self.c >> 20) as u8);
            self.c &= 0xFFFFF;
            self.ct = 7;
        } else if self.c < 0x800_0000 {
            self.out.push((self.c >> 19) as u8);
            self.c &= 0x7FFFF;
            self.ct = 8;
        } else {
            self.out[last] += 1;
            if self.out[last] == 0xFF {
                self.c &= 0x7FF_FFFF;
                self.out.push((self.c >> 20) as u8);
                self.c &= 0xFFFFF;
                self.ct = 7;
            } else {
                self.out.push((self.c >> 19) as u8);
                self.c &= 0x7FFFF;
                self.ct = 8;
            }
        }
    }

    /// FLUSH (C.2.9) and return the codeword segment. A final 0xFF is dropped, as T.800 allows
    /// (a decoder reads 0xFF past the end).
    pub(crate) fn finish(&mut self) -> &[u8] {
        // SETBITS
        let tempc = self.c + self.a;
        self.c |= 0xFFFF;
        if self.c >= tempc {
            self.c -= 0x8000;
        }
        self.c <<= self.ct;
        self.byte_out();
        self.c <<= self.ct;
        self.byte_out();
        let mut end = self.out.len();
        if self.out[end - 1] == 0xFF {
            end -= 1;
        }
        &self.out[1..end]
    }
}
