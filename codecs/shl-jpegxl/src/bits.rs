//! LSB-first bit reader (ISO/IEC 18181-1 clause 9) and the field encodings built on it.
//!
//! Reads past the end of the data return zero bits; `check_end` reports such an overrun, which
//! callers turn into an error at section boundaries (the same policy as libjxl).

use crate::error::{invalid, Error, Result};

#[derive(Clone)]
pub struct BitReader<'a> {
    data: &'a [u8],
    /// Next byte of `data` to load into `buf`.
    pos: usize,
    /// Zero bytes loaded after the end of `data`.
    pad: usize,
    buf: u64,
    nbits: u32,
}

impl<'a> BitReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        BitReader { data, pos: 0, pad: 0, buf: 0, nbits: 0 }
    }

    /// Ensures at least 56 bits are buffered.
    #[inline(always)]
    pub fn refill(&mut self) {
        if self.nbits >= 56 {
            return;
        }
        if let Some(chunk) = self.data.get(self.pos..self.pos + 8) {
            let mut b = [0u8; 8];
            b.copy_from_slice(chunk);
            let v = u64::from_le_bytes(b);
            self.buf |= v << self.nbits;
            let take = (63 - self.nbits) >> 3;
            self.pos += take as usize;
            self.nbits |= 56;
        } else {
            self.refill_slow();
        }
    }

    #[cold]
    fn refill_slow(&mut self) {
        while self.nbits <= 56 {
            let byte = match self.data.get(self.pos) {
                Some(&b) => {
                    self.pos += 1;
                    b
                }
                None => {
                    self.pad += 1;
                    0
                }
            };
            self.buf |= u64::from(byte) << self.nbits;
            self.nbits += 8;
        }
    }

    /// The next `n` (≤ 32) bits, without consuming them. Call `refill` first.
    #[inline(always)]
    pub fn peek(&self, n: u32) -> u32 {
        (self.buf & ((1u64 << n) - 1)) as u32
    }

    /// Drops `n` bits that `peek` returned (`n` ≤ the buffered count).
    #[inline(always)]
    pub fn consume(&mut self, n: u32) {
        let n = n.min(self.nbits);
        self.buf >>= n;
        self.nbits -= n;
    }

    /// Reads `n` ≤ 32 bits.
    #[inline(always)]
    pub fn read(&mut self, n: u32) -> u32 {
        debug_assert!(n <= 32);
        if self.nbits < n {
            self.refill();
        }
        let v = self.peek(n);
        self.consume(n);
        v
    }

    #[inline(always)]
    pub fn bit(&mut self) -> bool {
        self.read(1) == 1
    }

    /// Bits consumed so far, counting zero bits read past the end.
    pub fn bits_consumed(&self) -> u64 {
        ((self.pos + self.pad) as u64) * 8 - u64::from(self.nbits)
    }

    pub fn total_bits(&self) -> u64 {
        self.data.len() as u64 * 8
    }

    /// True if more bits were read than the data holds.
    pub fn overrun(&self) -> bool {
        self.bits_consumed() > self.total_bits()
    }

    /// Error if any read went past the end of the data.
    pub fn check_end(&self) -> Result<()> {
        if self.overrun() {
            invalid("unexpected end of data")
        } else {
            Ok(())
        }
    }

    /// Skips to the next byte boundary; the skipped bits must be zero.
    pub fn jump_to_byte_boundary(&mut self) -> Result<()> {
        let rem = (self.bits_consumed() % 8) as u32;
        if rem != 0 && self.read(8 - rem) != 0 {
            return invalid("non-zero padding bits");
        }
        Ok(())
    }

    /// Byte offset of the next unread byte; only meaningful at a byte boundary.
    pub fn byte_pos(&self) -> usize {
        (self.bits_consumed() / 8) as usize
    }

    /// Skips `n` bits.
    pub fn skip(&mut self, mut n: u64) -> Result<()> {
        while n > 0 {
            let s = n.min(32) as u32;
            self.read(s);
            n -= u64::from(s);
            if self.overrun() {
                return Err(Error::Invalid("skip past the end of data"));
            }
        }
        Ok(())
    }

    // ---- Field encodings (clause 9.2) ----

    /// U32 with four distributions, each `(extra_bits, offset)`; `Val(v)` is `(0, v)`.
    #[inline]
    pub fn u32(&mut self, d: [(u32, u32); 4]) -> u32 {
        let (bits, offset) = d[self.read(2) as usize];
        offset.wrapping_add(self.read(bits))
    }

    pub fn u64(&mut self) -> u64 {
        match self.read(2) {
            0 => 0,
            1 => 1 + u64::from(self.read(4)),
            2 => 17 + u64::from(self.read(8)),
            _ => {
                let mut v = u64::from(self.read(12));
                let mut shift = 12;
                while self.bit() {
                    if shift == 60 {
                        v |= u64::from(self.read(4)) << shift;
                        break;
                    }
                    v |= u64::from(self.read(8)) << shift;
                    shift += 8;
                }
                v
            }
        }
    }

    pub fn f16(&mut self) -> Result<f32> {
        let bits = self.read(16);
        let sign = bits >> 15;
        let exp = (bits >> 10) & 0x1F;
        let mant = bits & 0x3FF;
        if exp == 31 {
            return invalid("F16 infinity or NaN");
        }
        let v = if exp == 0 {
            (1.0f32 / 16384.0) * (mant as f32 * (1.0 / 1024.0))
        } else {
            f32::from_bits(((exp + 112) << 23) | (mant << 13))
        };
        Ok(if sign == 1 { -v } else { v })
    }

    /// Enum: U32(Val(0), Val(1), BitsOffset(4, 2), BitsOffset(6, 18)); values ≥ 64 are invalid.
    pub fn enum_val(&mut self) -> Result<u32> {
        let v = self.u32([(0, 0), (0, 1), (4, 2), (6, 18)]);
        if v >= 64 {
            return invalid("enum value out of range");
        }
        Ok(v)
    }

    /// Reads the extensions bit field and skips every extension's payload.
    pub fn extensions(&mut self) -> Result<()> {
        let ext = self.u64();
        let mut total: u64 = 0;
        for i in 0..64 {
            if ext & (1u64 << i) != 0 {
                total = total.saturating_add(self.u64());
            }
        }
        if self.overrun() {
            return invalid("truncated extensions");
        }
        self.skip(total)
    }
}

pub const fn val(v: u32) -> (u32, u32) {
    (0, v)
}
pub const fn bits(n: u32) -> (u32, u32) {
    (n, 0)
}
pub const fn bits_offset(n: u32, o: u32) -> (u32, u32) {
    (n, o)
}

#[inline]
pub fn unpack_signed(v: u32) -> i32 {
    ((v >> 1) as i32) ^ -((v & 1) as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lsb_first() {
        let data = [0b1010_1100u8, 0xFF, 0x01];
        let mut br = BitReader::new(&data);
        assert_eq!(br.read(2), 0b00);
        assert_eq!(br.read(3), 0b011);
        assert_eq!(br.read(3), 0b101);
        assert_eq!(br.read(9), 0x1FF);
        assert_eq!(br.bits_consumed(), 17);
        assert!(!br.overrun());
        assert_eq!(br.read(16), 0);
        assert!(br.overrun());
    }

    #[test]
    fn long_reads() {
        let data: Vec<u8> = (0..40u8).collect();
        let mut br = BitReader::new(&data);
        for i in 0..10u32 {
            let b = (i * 4) as u8;
            assert_eq!(br.read(32), u32::from_le_bytes([b, b + 1, b + 2, b + 3]));
        }
        br.check_end().unwrap();
    }

    #[test]
    fn signed() {
        assert_eq!(unpack_signed(0), 0);
        assert_eq!(unpack_signed(1), -1);
        assert_eq!(unpack_signed(2), 1);
        assert_eq!(unpack_signed(u32::MAX), i32::MIN);
    }

    #[test]
    fn f16_values() {
        let mut br = BitReader::new(&[0x00, 0x3C, 0x00, 0xC0]);
        assert_eq!(br.f16().unwrap(), 1.0);
        assert_eq!(br.f16().unwrap(), -2.0);
    }
}
