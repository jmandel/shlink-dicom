//! Entropy-coded segment reader shared by the DCT and lossless decoders.
//!
//! Follows libjpeg's `fill_bit_buffer`: `FF 00` is a stuffed 0xFF, runs of `FF` fill bytes are
//! skipped, and any other marker stops the reader. Past a marker or the end of data the reader
//! supplies zero bits, as libjpeg does, so a short final byte never fails a valid stream.

use crate::huffman::HuffTable;
use crate::invalid;
use shl_codec_common::Result;

/// The bit buffer: up to 64 bits, most significant first. A `Copy` value so hot loops keep it
/// in registers (`BitReader::load` / `store`), passing it by value to the refill slow path.
#[derive(Clone, Copy, Default)]
pub(crate) struct Bits {
    acc: u64,
    n: u32,
}

impl Bits {
    /// The next `LOOKUP_BITS` bits (the caller has buffered them).
    #[inline(always)]
    pub(crate) fn peek(self) -> usize {
        (self.acc >> (64 - crate::huffman::LOOKUP_BITS)) as usize
    }

    /// Drop `n` buffered bits.
    #[inline(always)]
    pub(crate) fn consume(&mut self, n: u32) {
        self.acc <<= n;
        self.n -= n;
    }

    /// Read `n` (0..=32) buffered bits.
    #[inline(always)]
    pub(crate) fn take(&mut self, n: u32) -> u32 {
        let v = ((self.acc >> 1) >> (63 - n)) as u32;
        self.consume(n);
        v
    }

    /// Decode a code longer than `LOOKUP_BITS` (16 bits are buffered): its symbol and the
    /// buffer after it. By value, so callers' buffers stay in registers.
    #[inline(never)]
    pub(crate) fn huff_long(mut self, t: &HuffTable) -> Result<(Bits, u8)> {
        for len in (crate::huffman::LOOKUP_BITS + 1)..=16 {
            let code = (self.acc >> (64 - len)) as i32;
            if code <= t.maxcode[len as usize] {
                self.consume(len);
                let idx = code + t.valoffset[len as usize];
                return usize::try_from(idx)
                    .ok()
                    .and_then(|i| t.values.get(i).copied())
                    .map(|v| (self, v))
                    .ok_or_else(|| invalid("corrupt Huffman code"));
            }
        }
        Err(invalid("corrupt Huffman code (no code of length <= 16 matches)"))
    }

    /// Whether the buffered bits (at least 16) start with no code of length <= 16.
    pub(crate) fn no_code_matches(self, t: &HuffTable) -> bool {
        (1..=16u32).all(|len| (self.acc >> (64 - len)) as i32 > t.maxcode[len as usize])
    }
}

pub(crate) struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
    b: Bits,
    at_marker: bool,
    /// Bytes of zero fill supplied after the data ran out (diagnostics only).
    pub(crate) overrun: usize,
    /// Lossless only: codes that matched no table entry, decoded as symbol 0 (see `lossless::diff_b`).
    pub(crate) bad_codes: u32,
    /// Lossless only: an SSSS = 16 difference was decoded.
    pub(crate) ssss16: bool,
    /// Lossless only: Cornell workaround (see `LosslessDecoder`).
    pub(crate) cornell: bool,
}

impl<'a> BitReader<'a> {
    pub(crate) fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0, b: Bits::default(), at_marker: false, overrun: 0, bad_codes: 0, ssss16: false, cornell: false }
    }

    /// The bit buffer, for a hot loop to keep in registers; hand it back with `store`.
    #[inline(always)]
    pub(crate) fn load(&self) -> Bits {
        self.b
    }

    #[inline(always)]
    pub(crate) fn store(&mut self, b: Bits) {
        self.b = b;
    }

    #[inline]
    fn next_byte(&mut self) -> u8 {
        if self.at_marker {
            self.overrun += 1;
            return 0;
        }
        let Some(&b) = self.data.get(self.pos) else {
            self.at_marker = true;
            self.overrun += 1;
            return 0;
        };
        if b != 0xFF {
            self.pos += 1;
            return b;
        }
        // 0xFF: skip fill bytes, then 0x00 means a stuffed data byte; anything else is a marker.
        let mut p = self.pos + 1;
        while self.data.get(p) == Some(&0xFF) {
            p += 1;
        }
        match self.data.get(p) {
            Some(0) => {
                self.pos = p + 1;
                0xFF
            }
            _ => {
                // Leave pos on the final FF of the run so restart handling sees the marker.
                self.pos = p - 1;
                self.at_marker = true;
                self.overrun += 1;
                0
            }
        }
    }

    /// `b` with at least 32 bits buffered: enough for one Huffman code and its value bits, read
    /// with `Bits::take` and no further checks.
    #[inline(always)]
    pub(crate) fn ensure32(&mut self, b: Bits) -> Bits {
        if b.n < 32 {
            self.refill(b)
        } else {
            b
        }
    }

    /// Top up `b` (holding at most 31 bits) to at least 56 bits.
    #[inline]
    fn refill(&mut self, mut b: Bits) -> Bits {
        // Fast path: the next 8 bytes are in range and none is 0xFF, so the bytes we take are plain
        // data. Takes the whole bytes that fit; the slow path handles stuffing and markers.
        if !self.at_marker {
            if let Some(d) = self.data.get(self.pos..self.pos + 8) {
                let w = u64::from_be_bytes([d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7]]);
                // Exact test for "some byte of w is 0xFF" (a zero byte in !w).
                let nw = !w;
                if nw.wrapping_sub(0x0101_0101_0101_0101) & w & 0x8080_8080_8080_8080 == 0 {
                    let k = (63 - b.n) / 8; // 4 to 7 bytes: b.n <= 31 here
                    b.acc |= (w >> (64 - 8 * k)) << (64 - b.n - 8 * k);
                    b.n += 8 * k;
                    self.pos += k as usize;
                    return b;
                }
            }
        }
        self.refill_slow(b)
    }

    #[cold]
    #[inline(never)]
    fn refill_slow(&mut self, mut b: Bits) -> Bits {
        while b.n <= 56 {
            let byte = self.next_byte();
            b.acc |= u64::from(byte) << (56 - b.n);
            b.n += 8;
        }
        b
    }

    /// The next `LOOKUP_BITS` bits, without consuming them; at least 16 bits are buffered after.
    /// (This and the next three methods are the plain reader API, kept for tests.)
    #[cfg(test)]
    pub(crate) fn peek_lookup(&mut self) -> usize {
        if self.b.n < 16 {
            self.b = self.refill(self.b);
        }
        self.b.peek()
    }

    /// Drop `n` (at most the buffered count) bits.
    #[cfg(test)]
    pub(crate) fn consume(&mut self, n: u32) {
        self.b.consume(n);
    }

    /// Read `n` (0..=16) bits as an unsigned value.
    #[cfg(test)]
    pub(crate) fn bits(&mut self, n: u32) -> u32 {
        if self.b.n < n {
            self.b = self.refill(self.b);
        }
        self.b.take(n)
    }

    /// Decode one Huffman symbol.
    #[cfg(test)]
    pub(crate) fn huff(&mut self, t: &HuffTable) -> Result<u8> {
        let peek = self.peek_lookup();
        let e = t.lookup[peek];
        if e != 0 {
            self.consume(u32::from(e >> 8));
            return Ok(e as u8);
        }
        let (b, v) = self.b.huff_long(t)?;
        self.b = b;
        Ok(v)
    }

    /// Process a restart marker: drop buffered bits, then consume the next RSTn marker.
    /// If the data does not sit on one (corrupt stream), skip ahead to the next RSTn.
    pub(crate) fn restart(&mut self) {
        self.b = Bits::default();
        self.at_marker = false;
        let d = self.data;
        let mut p = self.pos;
        while p + 1 < d.len() {
            if d[p] == 0xFF && (0xD0..=0xD7).contains(&d[p + 1]) {
                self.pos = p + 2;
                return;
            }
            p += 1;
        }
        self.pos = d.len();
    }
}

/// HUFF_EXTEND: turn `s` (0..=16) received bits into a signed difference.
#[inline(always)]
pub(crate) fn extend(v: u32, s: u32) -> i32 {
    // When the top received bit is 0 the value is negative: v - (2^s - 1). For s = 0, v = 0.
    let neg = (v.wrapping_shl(1) >> s.max(1)) ^ 1; // 1 when the top bit is clear (and s > 0)
    let neg = neg & u32::from(s != 0);
    (v as i32).wrapping_sub((((1u32 << s) - 1) * neg) as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stuffed_bytes_and_markers() {
        // 0xA5, stuffed 0xFF, fill FFs then stuffed 0xFF, then RST0 then 0x3C.
        let d = [0xA5, 0xFF, 0x00, 0xFF, 0xFF, 0x00, 0xFF, 0xD0, 0x3C];
        let mut r = BitReader::new(&d);
        assert_eq!(r.bits(8), 0xA5);
        assert_eq!(r.bits(8), 0xFF);
        assert_eq!(r.bits(4), 0xF);
        assert_eq!(r.bits(4), 0xF);
        assert_eq!(r.bits(8), 0); // zero fill at marker
        r.restart();
        assert_eq!(r.bits(8), 0x3C);
        assert_eq!(r.bits(16), 0);
    }

    #[test]
    fn fast_fill_matches_byte_reader() {
        // Random data with stuffed FFs and fill bytes; read random widths and compare with the
        // destuffed bit string.
        let mut x = 0x2545_F491_4F6C_DD1Du64;
        let mut d = Vec::new();
        let mut plain = Vec::new();
        for _ in 0..4000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let b = (x >> 24) as u8;
            let b = if x.is_multiple_of(7) { 0xFF } else { b };
            plain.push(b);
            d.push(b);
            if b == 0xFF {
                if x.is_multiple_of(3) {
                    d.push(0xFF); // fill byte before the stuffing zero
                }
                d.push(0);
            }
        }
        let bit = |i: usize| u32::from(plain.get(i / 8).map_or(0, |b| (b >> (7 - i % 8)) & 1));
        let mut r = BitReader::new(&d);
        let mut pos = 0usize;
        while pos < plain.len() * 8 + 40 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let n = (x % 17) as u32;
            let want = (0..n).fold(0u32, |v, k| (v << 1) | bit(pos + k as usize));
            assert_eq!(r.bits(n), want, "at bit {pos}");
            pos += n as usize;
        }
    }

    #[test]
    fn extend_values() {
        assert_eq!(extend(0, 1), -1);
        assert_eq!(extend(1, 1), 1);
        assert_eq!(extend(0b010, 3), -5);
        assert_eq!(extend(0b110, 3), 6);
        assert_eq!(extend(0, 15), -32767);
        assert_eq!(extend(0x7FFF, 16), -32768);
    }
}
