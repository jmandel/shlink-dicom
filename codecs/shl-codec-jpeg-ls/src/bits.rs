//! Bit reader for one entropy-coded JPEG-LS segment (T.87 A.1: after an 0xFF byte the next
//! byte carries a stuffed 0 bit, so only its 7 low bits are data).

use shl_codec_common::{DecodeError, Result};

/// Length of the entropy-coded data starting at `data[0]`: everything up to the first
/// 0xFF that is followed by a byte with its high bit set (a marker), or the end of input.
pub fn segment_len(data: &[u8]) -> usize {
    let mut i = 0;
    while i < data.len() {
        if data[i] == 0xFF {
            match data.get(i + 1) {
                Some(&b) if b >= 0x80 => return i,
                Some(_) => i += 2,
                None => return i + 1,
            }
        } else {
            i += 1;
        }
    }
    data.len()
}

#[derive(Clone, Copy)]
pub struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
    /// Left-aligned bit cache: the next bit to read is bit 63. Bits below `valid` are zero.
    pub(crate) cache: u64,
    pub(crate) valid: u32,
    prev_ff: bool,
}

#[cold]
#[inline(never)]
fn eod() -> DecodeError {
    DecodeError::Invalid("entropy-coded data ended early".into())
}

const ONES: u64 = 0x0101_0101_0101_0101;
const HIGHS: u64 = 0x8080_8080_8080_8080;

impl<'a> BitReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        BitReader { data, pos: 0, cache: 0, valid: 0, prev_ff: false }
    }

    /// Top up the cache to at least 56 bits (at most 63, so a shift by any number of valid
    /// bits stays below 64), or to the end of the data.
    #[inline(always)]
    fn fill(&mut self) {
        // Fast path: take whole bytes at once while none of them is 0xFF (no stuffing).
        if !self.prev_ff && self.valid <= 55 {
            if let Some(chunk) = self.data.get(self.pos..self.pos + 8) {
                let mut b = [0u8; 8];
                b.copy_from_slice(chunk);
                let w = u64::from_be_bytes(b);
                let nb = (63 - self.valid) / 8; // 1..=7 bytes fit
                let take = nb * 8;
                let top = !(u64::MAX >> take);
                // A zero byte in !w marks an 0xFF; this test may give false positives (then
                // the byte loop below handles it) but never false negatives.
                let v = !w;
                if (v.wrapping_sub(ONES) & !v & HIGHS) & top == 0 {
                    self.cache |= (w & top) >> self.valid;
                    self.valid += take;
                    self.pos += nb as usize;
                    return;
                }
            }
        }
        while self.valid <= 55 {
            let Some(&b) = self.data.get(self.pos) else { return };
            self.pos += 1;
            if self.prev_ff {
                // Stuffed bit: high bit must be 0 (segment_len guarantees it); 7 data bits.
                self.cache |= u64::from(b & 0x7F) << (57 - self.valid);
                self.valid += 7;
            } else {
                self.cache |= u64::from(b) << (56 - self.valid);
                self.valid += 8;
            }
            self.prev_ff = b == 0xFF;
        }
    }

    /// Refill for callers that keep `cache`/`valid` in locals: takes and returns them.
    /// The common case (8 more bytes, none 0xFF) is inline; the rest is out of line.
    #[inline(always)]
    pub fn refill(&mut self, cache: u64, valid: u32) -> (u64, u32) {
        if !self.prev_ff && valid <= 55 {
            if let Some(chunk) = self.data.get(self.pos..self.pos + 8) {
                let mut b = [0u8; 8];
                b.copy_from_slice(chunk);
                let w = u64::from_be_bytes(b);
                let nb = (63 - valid) / 8;
                let top = !(u64::MAX >> (nb * 8));
                let v = !w;
                if (v.wrapping_sub(ONES) & !v & HIGHS) & top == 0 {
                    self.pos += nb as usize;
                    return (cache | ((w & top) >> valid), valid + nb * 8);
                }
            }
        }
        self.refill_slow(cache, valid)
    }

    #[inline(never)]
    fn refill_slow(&mut self, cache: u64, valid: u32) -> (u64, u32) {
        self.cache = cache;
        self.valid = valid;
        self.fill();
        (self.cache, self.valid)
    }

    #[inline(always)]
    fn consume(&mut self, n: u32) {
        self.cache = if n < 64 { self.cache << n } else { 0 };
        self.valid -= n;
    }

    /// Read `n` bits (0..=32), MSB first.
    #[inline(always)]
    pub fn bits(&mut self, n: u32) -> Result<u32> {
        if n == 0 {
            return Ok(0);
        }
        if self.valid < n {
            self.fill();
            if self.valid < n {
                return Err(eod());
            }
        }
        let v = (self.cache >> (64 - n)) as u32;
        self.consume(n);
        Ok(v)
    }

    #[inline(always)]
    pub fn bit(&mut self) -> Result<bool> {
        if self.valid == 0 {
            self.fill();
            if self.valid == 0 {
                return Err(eod());
            }
        }
        let v = self.cache >> 63 == 1;
        self.consume(1);
        Ok(v)
    }

    /// Count 0 bits up to and including the terminating 1; returns the number of zeros.
    /// Fails if more than `max` zeros are seen.
    #[inline(always)]
    pub fn unary(&mut self, max: u32) -> Result<u32> {
        let mut q = 0u32;
        loop {
            if self.valid == 0 {
                self.fill();
                if self.valid == 0 {
                    return Err(eod());
                }
            }
            let lz = self.cache.leading_zeros();
            if lz < self.valid {
                q += lz;
                if q > max {
                    return Err(DecodeError::Invalid("Golomb code too long".into()));
                }
                self.consume(lz + 1);
                return Ok(q);
            }
            q += self.valid;
            self.cache = 0;
            self.valid = 0;
            if q > max {
                return Err(DecodeError::Invalid("Golomb code too long".into()));
            }
        }
    }

    /// Limited-length Golomb code (T.87 A.5.3): `esc` = LIMIT − qbpp − 1 zeros announce an
    /// escape followed by `qbpp` bits of value − 1. `k` must be at most 31.
    #[inline(always)]
    pub fn golomb(&mut self, k: u32, esc: u32, qbpp: u32) -> Result<u64> {
        if self.valid < 40 {
            self.fill();
        }
        // Fast path: prefix and suffix are both in the cache.
        let lz = self.cache.leading_zeros();
        if lz < esc && lz + 1 + k <= self.valid {
            let c = self.cache << lz << 1;
            let v = if k == 0 { 0 } else { c >> (64 - k) };
            self.consume(lz + 1 + k);
            return Ok((u64::from(lz) << k) | v);
        }
        let q = self.unary(esc)?;
        if q < esc {
            Ok((u64::from(q) << k) | u64::from(self.bits(k)?))
        } else {
            Ok(u64::from(self.bits(qbpp)?) + 1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stuffing_and_segment_end() {
        // 0xFF 0x7F -> 8 ones then 7 ones; then a marker.
        let d = [0xFF, 0x7F, 0xA5, 0xFF, 0xD9];
        assert_eq!(segment_len(&d), 3);
        let mut r = BitReader::new(&d[..3]);
        assert_eq!(r.bits(15).unwrap(), 0x7FFF);
        assert_eq!(r.bits(8).unwrap(), 0xA5);
        assert!(r.bits(1).is_err());
    }

    #[test]
    fn unary_counts_zeros() {
        let d = [0x00, 0x01, 0x80];
        let mut r = BitReader::new(&d);
        assert_eq!(r.unary(100).unwrap(), 15);
        assert!(r.bit().unwrap());
        let mut r = BitReader::new(&d);
        assert!(r.unary(10).is_err());
    }

    #[test]
    fn fill_bytes_before_marker() {
        assert_eq!(segment_len(&[0x12, 0xFF, 0xFF, 0xD9]), 1);
        assert_eq!(segment_len(&[0x12, 0xFF]), 2);
    }
}
