//! Entropy decoding (ISO/IEC 18181-1 Annex C): prefix codes and ANS, context maps with
//! clustering, hybrid integers and LZ77.

use crate::bits::{bits_offset, val, BitReader};
use crate::error::{invalid, Result};

const ANS_LOG_TAB_SIZE: u32 = 12;
const ANS_TAB_SIZE: u32 = 1 << ANS_LOG_TAB_SIZE;
const ANS_SIGNATURE: u32 = 0x13;
const PREFIX_MAX_BITS: u32 = 15;
const HUFFMAN_TABLE_BITS: u32 = 8;
const WINDOW_SIZE: usize = 1 << 20;
const WINDOW_MASK: usize = WINDOW_SIZE - 1;
const NUM_SPECIAL_DISTANCES: usize = 120;

#[derive(Clone, Copy, Debug, Default)]
pub struct HybridUint {
    split_exponent: u32,
    split_token: u32,
    msb_in_token: u32,
    lsb_in_token: u32,
}

impl HybridUint {
    const fn new(split_exponent: u32, msb_in_token: u32, lsb_in_token: u32) -> Self {
        HybridUint { split_exponent, split_token: 1 << split_exponent, msb_in_token, lsb_in_token }
    }

    fn read_config(log_alpha_size: u32, br: &mut BitReader) -> Result<Self> {
        let split_exponent = br.read(ceil_log2(log_alpha_size + 1));
        let mut msb = 0;
        let mut lsb = 0;
        if split_exponent != log_alpha_size {
            msb = br.read(ceil_log2(split_exponent + 1));
            if msb > split_exponent {
                return invalid("hybrid uint config");
            }
            lsb = br.read(ceil_log2(split_exponent - msb + 1));
        }
        if lsb + msb > split_exponent || split_exponent > 31 {
            return invalid("hybrid uint config");
        }
        Ok(HybridUint::new(split_exponent, msb, lsb))
    }

    /// The value of `token`, reading its extra bits (at most 31 are buffered by `refill`).
    #[inline(always)]
    fn decode(&self, token: u32, br: &mut BitReader) -> u32 {
        if token < self.split_token {
            return token;
        }
        let ml = self.msb_in_token + self.lsb_in_token;
        let nbits = (self.split_exponent - ml).wrapping_add((token - self.split_token) >> ml) & 31;
        let low = token & ((1 << self.lsb_in_token) - 1);
        let t = token >> self.lsb_in_token;
        let extra = u64::from(br.peek(nbits));
        br.consume(nbits);
        let hi = (1u64 << self.msb_in_token) | u64::from(t & ((1 << self.msb_in_token) - 1));
        (((((hi << nbits) | extra) << self.lsb_in_token) | u64::from(low)) & 0xFFFF_FFFF) as u32
    }
}

pub fn ceil_log2(x: u32) -> u32 {
    if x <= 1 {
        0
    } else {
        32 - (x - 1).leading_zeros()
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Lz77 {
    enabled: bool,
    min_symbol: u32,
    min_length: u32,
    length_config: HybridUint,
}

// ---- Prefix codes (Brotli-style two-level tables) ----

#[derive(Clone, Copy, Default, Debug)]
struct HuffCode {
    bits: u8,
    value: u16,
}

#[derive(Clone, Debug)]
struct HuffTable {
    table: Vec<HuffCode>,
}

impl HuffTable {
    #[inline(always)]
    fn read(&self, br: &mut BitReader) -> u32 {
        let mut idx = br.peek(HUFFMAN_TABLE_BITS) as usize;
        let mut e = self.table[idx];
        if u32::from(e.bits) > HUFFMAN_TABLE_BITS {
            br.consume(HUFFMAN_TABLE_BITS);
            let n = u32::from(e.bits) - HUFFMAN_TABLE_BITS;
            idx += usize::from(e.value) + br.peek(n) as usize;
            // Tables are built complete, so `idx` is in range; fall back to 0 defensively.
            e = self.table.get(idx).copied().unwrap_or_default();
        }
        br.consume(u32::from(e.bits));
        u32::from(e.value)
    }

    fn single(value: u16) -> Self {
        HuffTable { table: vec![HuffCode { bits: 0, value }; 1 << HUFFMAN_TABLE_BITS] }
    }
}

fn next_key(key: u32, len: u32) -> u32 {
    let mut step = 1u32 << (len - 1);
    while key & step != 0 {
        step >>= 1;
    }
    (key & (step.wrapping_sub(1))) + step
}

fn replicate(table: &mut [HuffCode], base: usize, step: usize, end: usize, code: HuffCode) -> Option<()> {
    let mut e = end;
    loop {
        e -= step;
        *table.get_mut(base + e)? = code;
        if e == 0 {
            return Some(());
        }
    }
}

fn next_table_bits(count: &[u16; 16], mut len: u32, root_bits: u32) -> u32 {
    let mut left: i64 = 1 << (len - root_bits);
    while len < PREFIX_MAX_BITS {
        if left <= i64::from(count[len as usize]) {
            break;
        }
        left -= i64::from(count[len as usize]);
        len += 1;
        left <<= 1;
    }
    len - root_bits
}

/// Builds the lookup table for complete code lengths (as libjxl's BuildHuffmanTable).
fn build_table(root_bits: u32, lengths: &[u8]) -> Option<Vec<HuffCode>> {
    let mut count = [0u16; 16];
    for &l in lengths {
        count[usize::from(l)] += 1;
    }
    let mut offset = [0u16; 16];
    let mut sum = 0u16;
    let mut max_length = 1u32;
    for len in 1..=PREFIX_MAX_BITS as usize {
        offset[len] = sum;
        if count[len] != 0 {
            sum = sum.checked_add(count[len])?;
            max_length = len as u32;
        }
    }
    let mut sorted = vec![0u16; usize::from(sum)];
    for (sym, &l) in lengths.iter().enumerate() {
        if l != 0 {
            let o = &mut offset[usize::from(l)];
            *sorted.get_mut(usize::from(*o))? = sym as u16;
            *o += 1;
        }
    }
    let mut total_size = 1usize << root_bits;
    if sum == 1 {
        return Some(vec![HuffCode { bits: 0, value: sorted[0] }; total_size]);
    }
    let mut table = vec![HuffCode::default(); total_size];
    let mut table_bits = root_bits.min(max_length);
    let mut table_size = 1usize << table_bits;
    let mut key = 0u32;
    let mut symbol = 0usize;
    let mut step = 2usize;
    let mut bits = 1u32;
    while bits <= table_bits {
        while count[bits as usize] != 0 {
            let code = HuffCode { bits: bits as u8, value: *sorted.get(symbol)? };
            symbol += 1;
            replicate(&mut table, key as usize, step, table_size, code)?;
            key = next_key(key, bits);
            count[bits as usize] -= 1;
        }
        step <<= 1;
        bits += 1;
    }
    while total_size != table_size {
        table.copy_within(0..table_size, table_size);
        table_size <<= 1;
    }
    let mask = total_size - 1;
    let mut low: usize = usize::MAX;
    let mut tbase = 0usize;
    step = 2;
    let mut len = root_bits + 1;
    while len <= max_length {
        while count[len as usize] != 0 {
            if (key as usize & mask) != low {
                tbase += table_size;
                table_bits = next_table_bits(&count, len, root_bits);
                table_size = 1 << table_bits;
                total_size += table_size;
                if total_size > (1 << (PREFIX_MAX_BITS + 1)) {
                    return None;
                }
                table.resize(total_size, HuffCode::default());
                low = key as usize & mask;
                let root = table.get_mut(low)?;
                root.bits = (table_bits + root_bits) as u8;
                root.value = (tbase - low) as u16;
            }
            let code = HuffCode { bits: (len - root_bits) as u8, value: *sorted.get(symbol)? };
            symbol += 1;
            replicate(&mut table, tbase + (key as usize >> root_bits), step, table_size, code)?;
            key = next_key(key, len);
            count[len as usize] -= 1;
        }
        len += 1;
        step <<= 1;
    }
    table.truncate(total_size);
    Some(table)
}

const CODE_LENGTH_ORDER: [usize; 18] = [1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15];

fn read_code_lengths(cl_lengths: &[u8; 18], num_symbols: usize, br: &mut BitReader) -> Result<Vec<u8>> {
    let table = build_table(5, cl_lengths).ok_or(crate::error::Error::Invalid("prefix code"))?;
    let mut lengths = vec![0u8; num_symbols];
    let mut symbol = 0usize;
    let mut prev_len = 8u8;
    let mut repeat = 0usize;
    let mut repeat_len = 0u8;
    let mut space: i64 = 32768;
    while symbol < num_symbols && space > 0 {
        br.refill();
        let e = table[br.peek(5) as usize];
        br.consume(u32::from(e.bits));
        let code_len = e.value as u8;
        if code_len < 16 {
            repeat = 0;
            lengths[symbol] = code_len;
            symbol += 1;
            if code_len != 0 {
                prev_len = code_len;
                space -= 32768 >> code_len;
            }
        } else {
            let extra_bits = u32::from(code_len) - 14;
            let new_len = if code_len == 16 { prev_len } else { 0 };
            if repeat_len != new_len {
                repeat = 0;
                repeat_len = new_len;
            }
            let old_repeat = repeat;
            if repeat > 0 {
                repeat = (repeat - 2) << extra_bits;
            }
            repeat += br.read(extra_bits) as usize + 3;
            let delta = repeat - old_repeat;
            if symbol + delta > num_symbols {
                return invalid("prefix code repeat");
            }
            lengths[symbol..symbol + delta].fill(repeat_len);
            symbol += delta;
            if repeat_len != 0 {
                space -= (delta as i64) << (15 - u32::from(repeat_len));
            }
        }
    }
    if space != 0 {
        return invalid("prefix code lengths");
    }
    Ok(lengths)
}

fn read_simple_code(alphabet_size: usize, br: &mut BitReader) -> Result<HuffTable> {
    let max_bits = if alphabet_size > 1 { 32 - ((alphabet_size - 1) as u32).leading_zeros() } else { 0 };
    let mut n = br.read(2) as usize + 1;
    let mut s = [0u16; 4];
    for v in s.iter_mut().take(n) {
        let sym = br.read(max_bits) as usize;
        if sym >= alphabet_size {
            return invalid("simple prefix code symbol");
        }
        *v = sym as u16;
    }
    for i in 0..n {
        for j in i + 1..n {
            if s[i] == s[j] {
                return invalid("simple prefix code duplicate");
            }
        }
    }
    if n == 4 {
        n += br.read(1) as usize;
    }
    let c = |bits: u8, value: u16| HuffCode { bits, value };
    let small: Vec<HuffCode> = match n {
        1 => vec![c(0, s[0])],
        2 => {
            if s[0] > s[1] {
                s.swap(0, 1);
            }
            vec![c(1, s[0]), c(1, s[1])]
        }
        3 => {
            if s[1] > s[2] {
                s.swap(1, 2);
            }
            vec![c(1, s[0]), c(2, s[1]), c(1, s[0]), c(2, s[2])]
        }
        4 => {
            s.sort_unstable();
            vec![c(2, s[0]), c(2, s[2]), c(2, s[1]), c(2, s[3])]
        }
        _ => {
            if s[2] > s[3] {
                s.swap(2, 3);
            }
            vec![c(1, s[0]), c(2, s[1]), c(1, s[0]), c(3, s[2]), c(1, s[0]), c(2, s[1]), c(1, s[0]), c(3, s[3])]
        }
    };
    let size = 1usize << HUFFMAN_TABLE_BITS;
    let table = (0..size).map(|i| small[i % small.len()]).collect();
    Ok(HuffTable { table })
}

fn read_prefix_code(alphabet_size: usize, br: &mut BitReader) -> Result<HuffTable> {
    let skip = br.read(2) as usize;
    if skip == 1 {
        return read_simple_code(alphabet_size, br);
    }
    const HUFF: [(u8, u8); 16] = [
        (2, 0), (2, 4), (2, 3), (3, 2), (2, 0), (2, 4), (2, 3), (4, 1),
        (2, 0), (2, 4), (2, 3), (3, 2), (2, 0), (2, 4), (2, 3), (4, 5),
    ];
    let mut cl = [0u8; 18];
    let mut space: i32 = 32;
    let mut num_codes = 0;
    for &idx in CODE_LENGTH_ORDER.iter().skip(skip) {
        if space <= 0 {
            break;
        }
        br.refill();
        let (b, v) = HUFF[br.peek(4) as usize];
        br.consume(u32::from(b));
        cl[idx] = v;
        if v != 0 {
            space -= 32 >> v;
            num_codes += 1;
        }
    }
    if !(num_codes == 1 || space == 0) {
        return invalid("prefix code length code");
    }
    let lengths = read_code_lengths(&cl, alphabet_size, br)?;
    let table = build_table(HUFFMAN_TABLE_BITS, &lengths).ok_or(crate::error::Error::Invalid("prefix code"))?;
    Ok(HuffTable { table })
}

// ---- ANS ----

#[derive(Clone, Copy, Default, Debug)]
struct AliasEntry {
    cutoff: u16,
    right_value: u16,
    freq0: u16,
    offsets1: u16,
    freq1_xor_freq0: u16,
}

fn read_varlen_u8(br: &mut BitReader) -> u32 {
    if br.bit() {
        let n = br.read(3);
        if n == 0 {
            1
        } else {
            br.read(n) + (1 << n)
        }
    } else {
        0
    }
}

fn read_varlen_u16(br: &mut BitReader) -> u32 {
    if br.bit() {
        let n = br.read(4);
        if n == 0 {
            1
        } else {
            br.read(n) + (1 << n)
        }
    } else {
        0
    }
}

fn population_count_precision(logcount: u32, shift: u32) -> u32 {
    let r = (logcount as i32).min(shift as i32 - ((ANS_LOG_TAB_SIZE - logcount) >> 1) as i32);
    r.max(0) as u32
}

fn flat_histogram(length: usize, total: i32) -> Vec<i32> {
    let count = total / length as i32;
    let rem = (total % length as i32) as usize;
    (0..length).map(|i| count + i32::from(i < rem)).collect()
}

fn read_histogram(br: &mut BitReader) -> Result<Vec<i32>> {
    let range = ANS_TAB_SIZE as i32;
    if br.bit() {
        // Simple: one or two symbols.
        let num = br.read(1) as usize + 1;
        let mut syms = [0usize; 2];
        let mut max = 0;
        for s in syms.iter_mut().take(num) {
            *s = read_varlen_u8(br) as usize;
            max = max.max(*s);
        }
        let mut counts = vec![0i32; max + 1];
        if num == 1 {
            counts[syms[0]] = range;
        } else {
            if syms[0] == syms[1] {
                return invalid("ANS histogram");
            }
            counts[syms[0]] = br.read(ANS_LOG_TAB_SIZE) as i32;
            counts[syms[1]] = range - counts[syms[0]];
        }
        return Ok(counts);
    }
    if br.bit() {
        let alphabet_size = read_varlen_u8(br) as usize + 1;
        return Ok(flat_histogram(alphabet_size, range));
    }
    let mut log = 0;
    while log < 3 {
        if !br.bit() {
            break;
        }
        log += 1;
    }
    let shift = (br.read(log) | (1 << log)) - 1;
    if shift > ANS_LOG_TAB_SIZE + 1 {
        return invalid("ANS histogram shift");
    }
    let length = read_varlen_u8(br) as usize + 3;
    let mut counts = vec![0i32; length];
    #[rustfmt::skip]
    const HUFF: [(u8, u8); 128] = [
        (3, 10), (7, 12), (3, 7), (4, 3), (3, 6), (3, 8), (3, 9), (4, 5),
        (3, 10), (4, 4),  (3, 7), (4, 1), (3, 6), (3, 8), (3, 9), (4, 2),
        (3, 10), (5, 0),  (3, 7), (4, 3), (3, 6), (3, 8), (3, 9), (4, 5),
        (3, 10), (4, 4),  (3, 7), (4, 1), (3, 6), (3, 8), (3, 9), (4, 2),
        (3, 10), (6, 11), (3, 7), (4, 3), (3, 6), (3, 8), (3, 9), (4, 5),
        (3, 10), (4, 4),  (3, 7), (4, 1), (3, 6), (3, 8), (3, 9), (4, 2),
        (3, 10), (5, 0),  (3, 7), (4, 3), (3, 6), (3, 8), (3, 9), (4, 5),
        (3, 10), (4, 4),  (3, 7), (4, 1), (3, 6), (3, 8), (3, 9), (4, 2),
        (3, 10), (7, 13), (3, 7), (4, 3), (3, 6), (3, 8), (3, 9), (4, 5),
        (3, 10), (4, 4),  (3, 7), (4, 1), (3, 6), (3, 8), (3, 9), (4, 2),
        (3, 10), (5, 0),  (3, 7), (4, 3), (3, 6), (3, 8), (3, 9), (4, 5),
        (3, 10), (4, 4),  (3, 7), (4, 1), (3, 6), (3, 8), (3, 9), (4, 2),
        (3, 10), (6, 11), (3, 7), (4, 3), (3, 6), (3, 8), (3, 9), (4, 5),
        (3, 10), (4, 4),  (3, 7), (4, 1), (3, 6), (3, 8), (3, 9), (4, 2),
        (3, 10), (5, 0),  (3, 7), (4, 3), (3, 6), (3, 8), (3, 9), (4, 5),
        (3, 10), (4, 4),  (3, 7), (4, 1), (3, 6), (3, 8), (3, 9), (4, 2),
    ];
    let mut logcounts = vec![0i32; length];
    let mut same = vec![0usize; length];
    let mut omit_log = -1i32;
    let mut omit_pos: isize = -1;
    let mut i = 0usize;
    while i < length {
        br.refill();
        let (b, v) = HUFF[br.peek(7) as usize];
        br.consume(u32::from(b));
        logcounts[i] = i32::from(v) - 1;
        if logcounts[i] == ANS_LOG_TAB_SIZE as i32 {
            let rle = read_varlen_u8(br) as usize;
            same[i] = rle + 5;
            i += rle + 4;
            continue;
        }
        if logcounts[i] > omit_log {
            omit_log = logcounts[i];
            omit_pos = i as isize;
        }
        i += 1;
    }
    if omit_pos < 0 {
        return invalid("ANS histogram");
    }
    let omit_pos = omit_pos as usize;
    if omit_pos + 1 < length && logcounts[omit_pos + 1] == ANS_LOG_TAB_SIZE as i32 {
        return invalid("ANS histogram");
    }
    let mut total: i32 = 0;
    let mut prev = 0i32;
    let mut numsame = 0usize;
    for i in 0..length {
        if same[i] != 0 {
            numsame = same[i] - 1;
            prev = if i > 0 { counts[i - 1] } else { 0 };
        }
        if numsame > 0 {
            counts[i] = prev;
            numsame -= 1;
        } else {
            let code = logcounts[i];
            if i == omit_pos || code < 0 {
                continue;
            } else if shift == 0 || code == 0 {
                counts[i] = 1 << code;
            } else {
                let bitcount = population_count_precision(code as u32, shift);
                counts[i] = (1 << code) + ((br.read(bitcount) as i32) << (code as u32 - bitcount));
            }
        }
        total = total.wrapping_add(counts[i]);
    }
    counts[omit_pos] = range.wrapping_sub(total);
    if counts[omit_pos] <= 0 {
        return invalid("ANS histogram count");
    }
    Ok(counts)
}

fn init_alias_table(mut dist: Vec<i32>, log_alpha_size: u32) -> Result<Vec<AliasEntry>> {
    let range = ANS_TAB_SIZE;
    let table_size = 1usize << log_alpha_size;
    while dist.last() == Some(&0) {
        dist.pop();
    }
    if dist.is_empty() {
        dist.push(range as i32);
    }
    if dist.len() > table_size {
        return invalid("ANS alphabet too large");
    }
    let entry_size = range >> log_alpha_size;
    let mut sum: i64 = 0;
    let mut single = None;
    for (s, &v) in dist.iter().enumerate() {
        if v < 0 {
            return invalid("ANS histogram");
        }
        sum += i64::from(v);
        if v as u32 == ANS_TAB_SIZE {
            single = Some(s);
        }
    }
    if sum != i64::from(range) {
        return invalid("ANS histogram sum");
    }
    let mut a = vec![AliasEntry::default(); table_size];
    if let Some(s) = single {
        for (i, e) in a.iter_mut().enumerate() {
            *e = AliasEntry {
                right_value: s as u16,
                cutoff: 0,
                offsets1: (entry_size as usize * i) as u16,
                freq0: 0,
                freq1_xor_freq0: ANS_TAB_SIZE as u16,
            };
        }
        return Ok(a);
    }
    let mut underfull = Vec::new();
    let mut overfull = Vec::new();
    let mut cutoffs = vec![0u32; table_size];
    for (i, &d) in dist.iter().enumerate() {
        cutoffs[i] = d as u32;
        if cutoffs[i] > entry_size {
            overfull.push(i);
        } else if cutoffs[i] < entry_size {
            underfull.push(i);
        }
    }
    for i in dist.len()..table_size {
        underfull.push(i);
    }
    while let Some(o) = overfull.pop() {
        let u = match underfull.pop() {
            Some(u) => u,
            None => return invalid("ANS alias table"),
        };
        let by = entry_size - cutoffs[u];
        cutoffs[o] -= by;
        a[u].right_value = o as u16;
        a[u].offsets1 = cutoffs[o] as u16;
        if cutoffs[o] < entry_size {
            underfull.push(o);
        } else if cutoffs[o] > entry_size {
            overfull.push(o);
        }
    }
    for i in 0..table_size {
        if cutoffs[i] == entry_size {
            a[i].right_value = i as u16;
            a[i].offsets1 = 0;
            a[i].cutoff = 0;
        } else {
            a[i].offsets1 = a[i].offsets1.wrapping_sub(cutoffs[i] as u16);
            a[i].cutoff = cutoffs[i] as u16;
        }
        let f0 = dist.get(i).copied().unwrap_or(0) as u16;
        let f1 = dist.get(usize::from(a[i].right_value)).copied().unwrap_or(0) as u16;
        a[i].freq0 = f0;
        a[i].freq1_xor_freq0 = f1 ^ f0;
    }
    Ok(a)
}

#[derive(Clone, Debug)]
enum Codes {
    Prefix(Vec<HuffTable>),
    Ans { tables: Vec<AliasEntry>, log_alpha_size: u32 },
}

/// A decoded set of histograms with its context map ("entropy code").
#[derive(Clone, Debug)]
pub struct EntropyCode {
    lz77: Lz77,
    pub context_map: Vec<u8>,
    configs: Vec<HybridUint>,
    codes: Codes,
    lz77_ctx: usize,
    /// Per cluster: the only symbol with nonzero probability (ANS), if any.
    single_symbol: Vec<Option<u32>>,
}

impl EntropyCode {
    pub fn read(br: &mut BitReader, num_contexts: usize) -> Result<Self> {
        Self::read_inner(br, num_contexts, false)
    }

    fn read_inner(br: &mut BitReader, mut num_contexts: usize, disallow_lz77: bool) -> Result<Self> {
        let mut lz77 = Lz77 { enabled: br.bit(), ..Lz77::default() };
        if lz77.enabled {
            lz77.min_symbol = br.u32([val(224), val(512), val(4096), bits_offset(15, 8)]);
            lz77.min_length = br.u32([val(3), val(4), bits_offset(2, 5), bits_offset(8, 9)]);
            num_contexts += 1;
            lz77.length_config = HybridUint::read_config(8, br)?;
            if disallow_lz77 {
                return invalid("LZ77 not allowed here");
            }
        }
        if num_contexts > (1 << 22) {
            return invalid("too many contexts");
        }
        let mut context_map = vec![0u8; num_contexts];
        let mut num_histograms = 1usize;
        if num_contexts > 1 {
            num_histograms = read_context_map(br, &mut context_map)?;
        }
        if br.overrun() {
            return invalid("truncated entropy code");
        }
        let lz77_ctx = usize::from(*context_map.last().unwrap_or(&0));
        let use_prefix = br.bit();
        let log_alpha_size = if use_prefix { PREFIX_MAX_BITS } else { br.read(2) + 5 };
        let mut configs = Vec::with_capacity(num_histograms);
        for _ in 0..num_histograms {
            configs.push(HybridUint::read_config(log_alpha_size, br)?);
        }
        let max_alphabet = 1usize << log_alpha_size;
        let mut single_symbol = vec![None; num_histograms];
        let codes = if use_prefix {
            let mut sizes = Vec::with_capacity(num_histograms);
            for _ in 0..num_histograms {
                let s = read_varlen_u16(br) as usize + 1;
                if s > max_alphabet {
                    return invalid("prefix alphabet too large");
                }
                sizes.push(s);
            }
            let mut tables = Vec::with_capacity(num_histograms);
            for &s in &sizes {
                if br.overrun() {
                    return invalid("truncated prefix codes");
                }
                tables.push(if s > 1 { read_prefix_code(s, br)? } else { HuffTable::single(0) });
            }
            Codes::Prefix(tables)
        } else {
            let mut tables = Vec::with_capacity(num_histograms << log_alpha_size);
            for ss in single_symbol.iter_mut() {
                if br.overrun() {
                    return invalid("truncated ANS histograms");
                }
                let mut counts = read_histogram(br)?;
                if counts.len() > max_alphabet {
                    return invalid("ANS alphabet too large");
                }
                while counts.last() == Some(&0) {
                    counts.pop();
                }
                let nonzero: Vec<usize> = (0..counts.len()).filter(|&i| counts[i] != 0).collect();
                *ss = match nonzero.as_slice() {
                    [] => Some(0),
                    [s] => Some(*s as u32),
                    _ => None,
                };
                tables.extend(init_alias_table(counts, log_alpha_size)?);
            }
            Codes::Ans { tables, log_alpha_size }
        };
        if br.overrun() {
            return invalid("truncated entropy code");
        }
        Ok(EntropyCode { lz77, context_map, configs, codes, lz77_ctx, single_symbol })
    }

    /// The only token cluster `c` can produce, when that token is a literal value below the
    /// hybrid-uint split (so it decodes to itself and consumes no bits). ANS only.
    pub fn single_value(&self, cluster: usize) -> Option<u32> {
        let s = (*self.single_symbol.get(cluster)?)?;
        let cfg = self.configs.get(cluster)?;
        if s >= cfg.split_token || (self.lz77.enabled && s >= self.lz77.min_symbol) {
            return None;
        }
        Some(s)
    }

    /// The only symbol cluster `c` can produce (ANS only), as libjxl's degenerate symbol.
    pub fn single_symbol(&self, cluster: usize) -> Option<u32> {
        *self.single_symbol.get(cluster)?
    }

    /// Creates a decoder positioned at the start of the symbol stream.
    pub fn reader(&self, br: &mut BitReader, distance_multiplier: u32) -> Result<SymbolReader> {
        let state = match self.codes {
            Codes::Ans { .. } => br.read(32),
            Codes::Prefix(_) => ANS_SIGNATURE << 16,
        };
        let mut special = [0u32; NUM_SPECIAL_DISTANCES];
        let num_special = if distance_multiplier == 0 { 0 } else { NUM_SPECIAL_DISTANCES };
        for (i, d) in special.iter_mut().enumerate().take(num_special) {
            let (dx, dy) = SPECIAL_DISTANCES[i];
            let v = i64::from(dx) + i64::from(distance_multiplier) * i64::from(dy);
            *d = v.clamp(1, i64::from(u32::MAX)) as u32;
        }
        Ok(SymbolReader {
            state,
            window: Vec::new(),
            lz77: self.lz77.enabled,
            num_to_copy: 0,
            copy_pos: 0,
            num_decoded: 0,
            special,
            num_special,
        })
    }
}

/// Reads a context map of `map.len()` entries; returns the number of clusters.
pub fn read_context_map_pub(br: &mut BitReader, map: &mut [u8]) -> Result<usize> {
    read_context_map(br, map)
}

fn read_context_map(br: &mut BitReader, map: &mut [u8]) -> Result<usize> {
    if br.bit() {
        let bits_per_entry = br.read(2);
        for e in map.iter_mut() {
            *e = br.read(bits_per_entry) as u8;
        }
    } else {
        let use_mtf = br.bit();
        let code = EntropyCode::read_inner(br, 1, map.len() <= 2)?;
        let mut r = code.reader(br, 0)?;
        let mut maxsym = 0;
        for e in map.iter_mut() {
            let s = r.read(&code, br, 0);
            maxsym = maxsym.max(s);
            *e = s as u8;
            if br.overrun() {
                return invalid("truncated context map");
            }
        }
        if maxsym >= 256 {
            return invalid("context map cluster id");
        }
        if !r.check_final_state() {
            return invalid("context map ANS state");
        }
        if use_mtf {
            inverse_mtf(map);
        }
    }
    let num = usize::from(*map.iter().max().unwrap_or(&0)) + 1;
    let mut seen = vec![false; num];
    for &m in map.iter() {
        seen[usize::from(m)] = true;
    }
    if seen.iter().any(|s| !s) {
        return invalid("incomplete context map");
    }
    Ok(num)
}

fn inverse_mtf(v: &mut [u8]) {
    let mut mtf: [u8; 256] = core::array::from_fn(|i| i as u8);
    for e in v.iter_mut() {
        let idx = usize::from(*e);
        let value = mtf[idx];
        mtf.copy_within(0..idx, 1);
        mtf[0] = value;
        *e = value;
    }
}

/// Decoding state for one symbol stream.
pub struct SymbolReader {
    state: u32,
    /// LZ77 window: grows to WINDOW_SIZE, then wraps. Unwritten entries read as 0.
    window: Vec<u32>,
    lz77: bool,
    num_to_copy: u64,
    copy_pos: u64,
    num_decoded: u64,
    special: [u32; NUM_SPECIAL_DISTANCES],
    num_special: usize,
}

impl SymbolReader {
    #[inline(always)]
    fn read_symbol(&mut self, code: &EntropyCode, cluster: usize, br: &mut BitReader) -> u32 {
        match &code.codes {
            Codes::Prefix(t) => match t.get(cluster) {
                Some(t) => t.read(br),
                None => 0,
            },
            Codes::Ans { tables, log_alpha_size } => {
                let res = self.state & (ANS_TAB_SIZE - 1);
                let log_entry = ANS_LOG_TAB_SIZE - log_alpha_size;
                let i = (cluster << log_alpha_size) + (res >> log_entry) as usize;
                let e = match tables.get(i) {
                    Some(e) => *e,
                    None => return 0,
                };
                let pos = res & ((1 << log_entry) - 1);
                let greater = pos >= u32::from(e.cutoff);
                let (value, offset, freq) = if greater {
                    (u32::from(e.right_value), u32::from(e.offsets1) + pos, u32::from(e.freq0 ^ e.freq1_xor_freq0))
                } else {
                    (res >> log_entry, pos, u32::from(e.freq0))
                };
                self.state = freq.wrapping_mul(self.state >> ANS_LOG_TAB_SIZE).wrapping_add(offset);
                if self.state < (1 << 16) {
                    self.state = (self.state << 16) | br.peek(16);
                    br.consume(16);
                }
                value
            }
        }
    }

    /// Reads one value in (unclustered) context `ctx`.
    #[inline(always)]
    pub fn read(&mut self, code: &EntropyCode, br: &mut BitReader, ctx: usize) -> u32 {
        let cluster = usize::from(*code.context_map.get(ctx).unwrap_or(&0));
        self.read_clustered(code, br, cluster)
    }

    /// Reads one value in an already clustered context.
    #[inline(always)]
    pub fn read_clustered(&mut self, code: &EntropyCode, br: &mut BitReader, cluster: usize) -> u32 {
        if code.lz77.enabled {
            return self.read_lz77(code, br, cluster);
        }
        br.refill();
        let token = self.read_symbol(code, cluster, br);
        match code.configs.get(cluster) {
            Some(c) => c.decode(token, br),
            None => 0,
        }
    }

    #[inline(never)]
    fn read_lz77(&mut self, code: &EntropyCode, br: &mut BitReader, cluster: usize) -> u32 {
        if self.num_to_copy > 0 {
            return self.copy_one();
        }
        br.refill();
        let token = self.read_symbol(code, cluster, br);
        if token >= code.lz77.min_symbol {
            let len = code.lz77.length_config.decode(token - code.lz77.min_symbol, br);
            self.num_to_copy = u64::from(len) + u64::from(code.lz77.min_length);
            br.refill();
            let dctx = code.lz77_ctx;
            let dtoken = self.read_symbol(code, dctx, br);
            let mut distance = match code.configs.get(dctx) {
                Some(c) => u64::from(c.decode(dtoken, br)),
                None => 0,
            };
            if (distance as usize) < self.num_special {
                distance = u64::from(self.special[distance as usize]);
            } else {
                distance = distance + 1 - self.num_special as u64;
            }
            distance = distance.min(self.num_decoded).min(WINDOW_SIZE as u64);
            self.copy_pos = self.num_decoded - distance;
            return self.copy_one();
        }
        let v = match code.configs.get(cluster) {
            Some(c) => c.decode(token, br),
            None => 0,
        };
        self.push_window(v);
        v
    }

    #[inline(always)]
    fn push_window(&mut self, v: u32) {
        let i = (self.num_decoded as usize) & WINDOW_MASK;
        if let Some(e) = self.window.get_mut(i) {
            *e = v;
        } else {
            self.window.push(v);
        }
        self.num_decoded += 1;
    }

    #[inline(always)]
    fn copy_one(&mut self) -> u32 {
        let v = self.window.get((self.copy_pos as usize) & WINDOW_MASK).copied().unwrap_or(0);
        self.copy_pos += 1;
        self.num_to_copy -= 1;
        self.push_window(v);
        v
    }

    /// True when an ANS stream ended in its initial state (always true for prefix codes).
    pub fn check_final_state(&self) -> bool {
        self.state == ANS_SIGNATURE << 16
    }

    /// Records `n` copies of `v` as decoded (for the LZ77 window), after a fast-path fill.
    pub fn advance_single(&mut self, v: u32, n: u64) {
        if self.lz77 {
            for _ in 0..n.min(WINDOW_SIZE as u64) {
                self.push_window(v);
            }
            self.num_decoded += n.saturating_sub(WINDOW_SIZE as u64);
        }
    }

    pub fn copying(&self) -> bool {
        self.num_to_copy != 0
    }
}

#[rustfmt::skip]
const SPECIAL_DISTANCES: [(i8, i8); NUM_SPECIAL_DISTANCES] = [
    (0, 1),  (1, 0),  (1, 1),  (-1, 1), (0, 2),  (2, 0),  (1, 2),  (-1, 2),
    (2, 1),  (-2, 1), (2, 2),  (-2, 2), (0, 3),  (3, 0),  (1, 3),  (-1, 3),
    (3, 1),  (-3, 1), (2, 3),  (-2, 3), (3, 2),  (-3, 2), (0, 4),  (4, 0),
    (1, 4),  (-1, 4), (4, 1),  (-4, 1), (3, 3),  (-3, 3), (2, 4),  (-2, 4),
    (4, 2),  (-4, 2), (0, 5),  (3, 4),  (-3, 4), (4, 3),  (-4, 3), (5, 0),
    (1, 5),  (-1, 5), (5, 1),  (-5, 1), (2, 5),  (-2, 5), (5, 2),  (-5, 2),
    (4, 4),  (-4, 4), (3, 5),  (-3, 5), (5, 3),  (-5, 3), (0, 6),  (6, 0),
    (1, 6),  (-1, 6), (6, 1),  (-6, 1), (2, 6),  (-2, 6), (6, 2),  (-6, 2),
    (4, 5),  (-4, 5), (5, 4),  (-5, 4), (3, 6),  (-3, 6), (6, 3),  (-6, 3),
    (0, 7),  (7, 0),  (1, 7),  (-1, 7), (5, 5),  (-5, 5), (7, 1),  (-7, 1),
    (4, 6),  (-4, 6), (6, 4),  (-6, 4), (2, 7),  (-2, 7), (7, 2),  (-7, 2),
    (3, 7),  (-3, 7), (7, 3),  (-7, 3), (5, 6),  (-5, 6), (6, 5),  (-6, 5),
    (8, 0),  (4, 7),  (-4, 7), (7, 4),  (-7, 4), (8, 1),  (8, 2),  (6, 6),
    (-6, 6), (8, 3),  (5, 7),  (-5, 7), (7, 5),  (-7, 5), (8, 4),  (6, 7),
    (-6, 7), (7, 6),  (-7, 6), (8, 5),  (7, 7),  (-7, 7), (8, 6),  (8, 7),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hybrid_uint_examples() {
        // split_exponent 4, msb 2, lsb 0 (libjxl's comment): 16 -> token 16 + 2 bits "00".
        let cfg = HybridUint::new(4, 2, 0);
        let data = [0b01u8, 0, 0, 0, 0, 0, 0, 0];
        let mut br = BitReader::new(&data);
        br.refill();
        assert_eq!(cfg.decode(16, &mut br), 17);
        let mut br = BitReader::new(&[0u8; 8]);
        br.refill();
        assert_eq!(cfg.decode(20, &mut br), 32);
        assert_eq!(cfg.decode(5, &mut br), 5);
    }

    #[test]
    fn mtf() {
        let mut v = [1u8, 1, 0, 2];
        inverse_mtf(&mut v);
        assert_eq!(v, [1, 0, 0, 2]);
    }

    #[test]
    fn complete_table() {
        // Lengths 1,2,3,3: codes 0, 10, 110, 111 (bit-reversed in the table).
        let t = build_table(8, &[1, 2, 3, 3]).unwrap();
        assert_eq!(t.len(), 256);
        assert_eq!((t[0].bits, t[0].value), (1, 0));
        assert_eq!((t[1].bits, t[1].value), (2, 1));
        assert_eq!((t[3].bits, t[3].value), (3, 2));
        assert_eq!((t[7].bits, t[7].value), (3, 3));
    }

    #[test]
    fn ceil_log2_values() {
        assert_eq!(ceil_log2(1), 0);
        assert_eq!(ceil_log2(2), 1);
        assert_eq!(ceil_log2(3), 2);
        assert_eq!(ceil_log2(9), 4);
    }
}
