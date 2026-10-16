//! Bit-stream recovery from the HT byte-streams (T.814 clause 7.1).
//!
//! Each reader keeps a 64-bit buffer refilled a byte (or four) at a time. Where T.814 calls
//! `error()` (a stuffing bit that is not 0, a stream read past its end) the readers carry on
//! deterministically instead: a byte's bits are ORed into the buffer even where its MSB is a
//! stuffing position, and a stream read past its end continues with fill bytes. A conforming
//! segment never reaches either case.

/// True if any byte of `w` is 0xFF.
#[inline(always)]
fn has_ff(w: u32) -> bool {
    (!w).wrapping_sub(0x0101_0101) & w & 0x8080_8080 != 0
}

/// The bit buffer of a stream: the next `n` bits in `acc`, first in the LSB. Kept apart from
/// the byte source so that it stays in registers in the decoding loops.
#[derive(Clone, Copy, Default)]
pub(super) struct Bits {
    pub(super) acc: u64,
    pub(super) n: u32,
}

impl Bits {
    /// Drops `k <= self.n` bits.
    #[inline(always)]
    pub(super) fn consume(&mut self, k: u32) {
        self.acc >>= k;
        self.n -= k;
    }

    /// The next 32 bits (valid up to `n`).
    #[inline(always)]
    pub(super) fn low(&self) -> u32 {
        #[allow(clippy::cast_possible_truncation)]
        {
            self.acc as u32
        }
    }
}

/// The MagSgn (clause 7.1.2) and SigProp (7.1.5) byte-streams: bytes read forward, bits LSB
/// first; a byte that follows 0xFF carries 7 bits. Past the end the stream reads `fill` bytes:
/// 0xFF for MagSgn (7.1.2, note 3), 0 for SigProp.
pub(super) struct FwdBytes<'a> {
    data: &'a [u8],
    pos: usize,
    fill: u8,
    last_ff: bool,
}

impl<'a> FwdBytes<'a> {
    pub(super) fn new(data: &'a [u8], fill: u8) -> Self {
        Self { data, pos: 0, fill, last_ff: false }
    }

    /// Makes at least 32 bits available in `b`.
    #[inline(always)]
    pub(super) fn ensure32(&mut self, b: &mut Bits) {
        if b.n < 32 {
            *b = self.refill(*b);
        }
    }

    /// Makes at least `need <= 57` bits available in `b`.
    #[inline(always)]
    pub(super) fn ensure(&mut self, b: &mut Bits, need: u32) {
        if b.n < need {
            *b = self.fill(*b);
        }
    }

    /// Adds whole bytes while they fit: at least 57 bits after.
    #[inline(always)]
    fn fill(&mut self, b: Bits) -> Bits {
        if !self.last_ff {
            if let Some(&eight) = self.data.get(self.pos..self.pos + 8).and_then(|s| <&[u8; 8]>::try_from(s).ok()) {
                let k = (64 - b.n) / 8;
                let w = u64::from_le_bytes(eight) & (u64::MAX >> (64 - 8 * k));
                // No 0xFF among the k bytes taken (the high bytes of `w` are 0 now).
                if (!w).wrapping_sub(0x0101_0101_0101_0101) & w & 0x8080_8080_8080_8080 == 0 {
                    self.pos += k as usize;
                    return Bits { acc: b.acc | w << b.n, n: b.n + 8 * k };
                }
            }
        }
        self.refill_bytes(b)
    }

    #[inline(always)]
    fn refill(&mut self, b: Bits) -> Bits {
        if !self.last_ff {
            if let Some(&four) = self.data.get(self.pos..self.pos + 4).and_then(|s| <&[u8; 4]>::try_from(s).ok()) {
                let w = u32::from_le_bytes(four);
                if !has_ff(w) {
                    self.pos += 4;
                    return Bits { acc: b.acc | u64::from(w) << b.n, n: b.n + 32 };
                }
            }
        }
        self.refill_bytes(b)
    }

    #[inline(never)]
    fn refill_bytes(&mut self, mut b: Bits) -> Bits {
        while b.n <= 56 {
            let byte = self.data.get(self.pos).copied().unwrap_or(self.fill);
            self.pos += 1;
            b.acc |= u64::from(byte) << b.n;
            b.n += if self.last_ff { 7 } else { 8 };
            self.last_ff = byte == 0xFF;
        }
        b
    }
}

/// The VLC (clause 7.1.4) and MagRef (7.1.6) byte-streams: bytes read backward from the end of
/// `data`, bits LSB first; a byte whose 7 LSBs are all 1 carries 7 bits if the byte read before
/// it exceeds 0x8F. Before the start of `data` the stream reads 0 bytes.
pub(super) struct RevBytes<'a> {
    data: &'a [u8],
    /// Bytes of `data` not yet read: the next byte is `data[left - 1]`.
    left: usize,
    last: u8,
}

impl<'a> RevBytes<'a> {
    /// The VLC stream of a cleanup segment `seg` (`Lcup >= 2` bytes) whose MagSgn stream has
    /// `pcup` bytes (`initVLC`): it starts with the 4 MSBs of byte `Lcup - 2`, the byte whose
    /// 4 LSBs, with byte `Lcup - 1`, hold `Scup` and read as 1s.
    pub(super) fn vlc(seg: &'a [u8], pcup: usize) -> (Self, Bits) {
        let lcup = seg.len();
        let last = seg[lcup - 2] | 0x0F;
        let nibble = last >> 4;
        let bits = Bits { acc: u64::from(nibble), n: if nibble & 7 == 7 { 3 } else { 4 } };
        (Self { data: &seg[pcup..lcup - 2], left: lcup - 2 - pcup, last }, bits)
    }

    /// The MagRef stream of a refinement segment (`initMR`).
    pub(super) fn magref(seg: &'a [u8]) -> Self {
        Self { data: seg, left: seg.len(), last: 0xFF }
    }

    #[inline(always)]
    pub(super) fn ensure32(&mut self, b: &mut Bits) {
        if b.n < 32 {
            *b = self.refill(*b);
        }
    }

    #[inline(always)]
    fn refill(&mut self, b: Bits) -> Bits {
        if self.left >= 4 {
            if let Some(&four) = self.data.get(self.left - 4..self.left).and_then(|s| <&[u8; 4]>::try_from(s).ok()) {
                // Four bytes, none with its 7 LSBs all 1, so none is stuffed.
                let w = u32::from_be_bytes(four);
                if !has_ff(w | 0x8080_8080) {
                    self.left -= 4;
                    self.last = four[0];
                    return Bits { acc: b.acc | u64::from(w) << b.n, n: b.n + 32 };
                }
            }
        }
        self.refill_bytes(b)
    }

    #[inline(never)]
    fn refill_bytes(&mut self, mut b: Bits) -> Bits {
        while b.n <= 56 {
            let byte = if self.left > 0 {
                self.left -= 1;
                self.data.get(self.left).copied().unwrap_or(0)
            } else {
                0
            };
            b.acc |= u64::from(byte) << b.n;
            b.n += if self.last > 0x8F && byte & 0x7F == 0x7F { 7 } else { 8 };
            self.last = byte;
        }
        b
    }
}

/// The MEL bit-stream (clause 7.1.3) and its symbol decoder (`decodeMELSym`, 7.3.3): bytes read
/// forward from byte `Pcup` of the cleanup segment, bits MSB first, a byte that follows 0xFF
/// carrying its 7 LSBs; byte `Lcup - 2` reads with its 4 LSBs set and everything from byte
/// `Lcup - 1` on reads 0xFF (`modDcup`).
pub(super) struct Mel<'a> {
    /// Bytes `Pcup..Lcup` of the cleanup segment.
    data: &'a [u8],
    pos: usize,
    last_ff: bool,
    /// The next bits, first in the MSB.
    acc: u64,
    n: u32,
    /// `MEL_k`.
    k: usize,
    /// `MEL_run` and `MEL_one` of the run being read, as `2 (symbols left) + MEL_one`, the
    /// terminating 1 counted as a symbol. Copied to a local by the decoding loop; see
    /// [`Self::symbol`].
    pub(super) run: u32,
}

impl<'a> Mel<'a> {
    pub(super) fn new(seg: &'a [u8], pcup: usize) -> Self {
        Self { data: &seg[pcup..], pos: 0, last_ff: false, acc: 0, n: 0, k: 0, run: 0 }
    }

    fn refill(&mut self) {
        while self.n <= 56 {
            let len = self.data.len();
            let b = match self.data.get(self.pos) {
                Some(&b) if self.pos + 2 < len => b,
                Some(&b) if self.pos + 2 == len => b | 0x0F,
                _ => 0xFF,
            };
            self.pos += 1;
            let (bits, width) = if self.last_ff { (b & 0x7F, 7) } else { (b, 8) };
            self.acc |= u64::from(bits) << (64 - self.n - width);
            self.n += width;
            self.last_ff = b == 0xFF;
        }
    }

    /// The next MEL symbol (`decodeMELSym`), with `run` the caller's copy of [`Self::run`].
    #[inline(always)]
    pub(super) fn symbol(&mut self, run: &mut u32) -> bool {
        if *run < 2 {
            *run = self.next_run();
        }
        *run -= 2;
        *run == 1
    }

    /// Decodes one MEL codeword: a run of `2^MEL_E[k]` zeros, or a run of up to
    /// `2^MEL_E[k] - 1` zeros and a one.
    #[inline(never)]
    fn next_run(&mut self) -> u32 {
        if self.n < 6 {
            self.refill();
        }
        let e = super::tables::MEL_E[self.k.min(12)];
        if self.acc >> 63 != 0 {
            self.k = (self.k + 1).min(12);
            self.acc <<= 1;
            self.n -= 1;
            2 << e
        } else {
            #[allow(clippy::cast_possible_truncation)] // at most 5 bits
            let zeros = if e == 0 { 0 } else { ((self.acc << 1) >> (64 - e)) as u32 };
            self.k = self.k.saturating_sub(1);
            self.acc <<= 1 + e;
            self.n -= 1 + e;
            (zeros + 1) << 1 | 1
        }
    }
}
