//! Huffman tables (T.81 Annex C) with a 10-bit lookahead table and combined code+value tables.

use crate::invalid;
use shl_codec_common::Result;

pub(crate) const LOOKUP_BITS: u32 = 10;

#[derive(Clone)]
pub(crate) struct HuffTable {
    /// Indexed by the next LOOKUP_BITS bits: `len << 8 | symbol`, or 0 for a longer code.
    pub(crate) lookup: Vec<u16>,
    /// Largest code of each length, or -1 when there is none.
    pub(crate) maxcode: [i32; 17],
    /// values index = code + valoffset[len].
    pub(crate) valoffset: [i32; 17],
    pub(crate) values: Vec<u8>,
    /// Code and value bits decoded together, indexed like `lookup`; 0 when they do not both fit
    /// in LOOKUP_BITS (then the caller takes the `lookup` path).
    /// - DC and lossless tables (class 0): for SSSS <= 15, `difference << 8 | total length`.
    /// - AC tables (class 1): for RS with S > 0, `value << 16 | run << 8 | total length`.
    pub(crate) fast: Vec<i32>,
}

impl HuffTable {
    /// Build from BITS (counts per length 1..=16) and HUFFVAL, rejecting over-subscribed tables.
    /// `class` is 0 for DC and lossless tables, 1 for AC tables.
    pub(crate) fn new(counts: &[u8; 16], values: &[u8], class: u8) -> Result<Self> {
        let total: usize = counts.iter().map(|&c| usize::from(c)).sum();
        if total > 256 || total != values.len() {
            return Err(invalid("bad Huffman table size"));
        }
        let mut lookup = vec![0u16; 1 << LOOKUP_BITS];
        let mut maxcode = [-1i32; 17];
        let mut valoffset = [0i32; 17];
        let mut code: u32 = 0;
        let mut k: usize = 0;
        for len in 1..=16u32 {
            let n = u32::from(counts[(len - 1) as usize]);
            if n > 0 {
                valoffset[len as usize] = k as i32 - code as i32;
                for _ in 0..n {
                    if code >= (1u32 << len) {
                        return Err(invalid("over-subscribed Huffman table"));
                    }
                    if len <= LOOKUP_BITS {
                        let shift = LOOKUP_BITS - len;
                        let base = (code << shift) as usize;
                        for e in &mut lookup[base..base + (1usize << shift)] {
                            *e = ((len as u16) << 8) | u16::from(values[k]);
                        }
                    }
                    code += 1;
                    k += 1;
                }
                maxcode[len as usize] = code as i32 - 1;
            }
            code <<= 1;
        }
        let fast = lookup
            .iter()
            .enumerate()
            .map(|(peek, &e)| {
                let (len, sym) = (u32::from(e >> 8), (e & 0xFF) as u32);
                let (run, s) = if class == 0 { (0, sym) } else { (sym >> 4, sym & 15) };
                let usable = if class == 0 { s <= 15 } else { s > 0 };
                if e == 0 || !usable || len + s > LOOKUP_BITS {
                    return 0;
                }
                let bits = (peek as u32 >> (LOOKUP_BITS - len - s)) & ((1 << s) - 1);
                let v = crate::bits::extend(bits, s);
                if class == 0 {
                    (v << 8) | (len + s) as i32
                } else {
                    (v << 16) | ((run << 8) | (len + s)) as i32
                }
            })
            .collect();
        Ok(Self { lookup, maxcode, valoffset, values: values.to_vec(), fast })
    }
}

/// Standard tables from T.81 K.3, used when a stream omits DHT (Motion-JPEG style frames),
/// as libjpeg-turbo does.
pub(crate) fn std_table(class: u8, id: u8) -> Option<HuffTable> {
    const DC_L_BITS: [u8; 16] = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
    const DC_C_BITS: [u8; 16] = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
    const DC_VALS: [u8; 12] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const AC_L_BITS: [u8; 16] = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
    const AC_L_VALS: [u8; 162] = [
        0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
        0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
        0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
        0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
        0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
        0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
        0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
        0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
        0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
        0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
        0xf9, 0xfa,
    ];
    const AC_C_BITS: [u8; 16] = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
    const AC_C_VALS: [u8; 162] = [
        0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
        0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
        0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
        0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
        0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
        0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
        0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
        0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
        0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
        0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
        0xf9, 0xfa,
    ];
    let t = match (class, id) {
        (0, 0) => HuffTable::new(&DC_L_BITS, &DC_VALS, 0),
        (0, 1) => HuffTable::new(&DC_C_BITS, &DC_VALS, 0),
        (1, 0) => HuffTable::new(&AC_L_BITS, &AC_L_VALS, 1),
        (1, 1) => HuffTable::new(&AC_C_BITS, &AC_C_VALS, 1),
        _ => return None,
    };
    t.ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bits::BitReader;

    #[test]
    fn decodes_canonical_codes() {
        // Lengths: one 1-bit code (A=0), two 3-bit codes (B=100, C=101), one 12-bit code.
        let mut counts = [0u8; 16];
        counts[0] = 1;
        counts[2] = 2;
        counts[11] = 1;
        let t = HuffTable::new(&counts, &[0xA, 0xB, 0xC, 0xD], 0).unwrap();
        // Codes: 0 | 100 | 101 | 110000000000 (next code after 101 is 110, shifted to 12 bits)
        // bits: 0 100 101 110000000000 + pad 1s
        let bits = "0100101110000000000";
        let mut v: Vec<u8> = Vec::new();
        let mut s = bits.to_string();
        while !s.len().is_multiple_of(8) {
            s.push('1');
        }
        for i in (0..s.len()).step_by(8) {
            v.push(u8::from_str_radix(&s[i..i + 8], 2).unwrap());
        }
        let mut r = BitReader::new(&v);
        assert_eq!(r.huff(&t).unwrap(), 0xA);
        assert_eq!(r.huff(&t).unwrap(), 0xB);
        assert_eq!(r.huff(&t).unwrap(), 0xC);
        assert_eq!(r.huff(&t).unwrap(), 0xD);
    }

    #[test]
    fn rejects_oversubscribed() {
        let mut counts = [0u8; 16];
        counts[0] = 3;
        assert!(HuffTable::new(&counts, &[1, 2, 3], 0).is_err());
    }

    #[test]
    fn std_tables_build() {
        for c in 0..2 {
            for i in 0..2 {
                assert!(std_table(c, i).is_some());
            }
        }
    }
}
