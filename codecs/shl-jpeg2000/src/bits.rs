//! Packet header bits (B.10.1): read MSB first; after an 0xFF byte one bit is stuffed.

/// A bit reader over packet headers. `None` from any read means the data ran out.
#[derive(Clone)]
pub(crate) struct HeaderBits<'a> {
    data: &'a [u8],
    /// Position in bits.
    pos: usize,
}

impl<'a> HeaderBits<'a> {
    pub(crate) fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    pub(crate) fn byte_pos(&self) -> usize {
        self.pos / 8
    }

    pub(crate) fn at_end(&self) -> bool {
        self.byte_pos() >= self.data.len()
    }

    #[inline]
    fn raw_bit(&mut self) -> Option<u32> {
        let byte = *self.data.get(self.pos / 8)?;
        let bit = (byte >> (7 - self.pos % 8)) & 1;
        self.pos += 1;
        Some(u32::from(bit))
    }

    /// One header bit. The bit after the last bit of an 0xFF byte is stuffed and skipped
    /// whatever its value: B.10.1 says it is 0, but an Aperio encoder writes 1, and OpenJPEG
    /// reads only the low seven bits of that byte.
    #[inline]
    pub(crate) fn bit(&mut self) -> Option<u32> {
        let stuff = self.pos % 8 == 7 && self.data[self.pos / 8] == 0xFF;
        let b = self.raw_bit()?;
        if stuff {
            self.raw_bit()?;
        }
        Some(b)
    }

    #[inline]
    pub(crate) fn bits(&mut self, n: u32) -> Option<u32> {
        let mut v = 0u32;
        for _ in 0..n {
            v = (v << 1) | self.bit()?;
        }
        Some(v)
    }

    pub(crate) fn align(&mut self) {
        self.pos = self.pos.div_ceil(8) * 8;
    }

    /// The byte-aligned rest, for reading markers and packet bodies.
    pub(crate) fn peek_bytes(&self, n: usize) -> Option<&'a [u8]> {
        let start = self.byte_pos();
        self.data.get(start..start.checked_add(n)?)
    }

    /// Read `n` bytes (byte-aligned).
    pub(crate) fn bytes(&mut self, n: usize) -> Option<&'a [u8]> {
        let s = self.peek_bytes(n)?;
        self.pos += n * 8;
        Some(s)
    }
}
