//! Brotli decompressor (RFC 7932).
//!
//! [`decompress_with_consumed`] decodes one complete brotli stream held in memory.
//!
//! - The stream must be complete: running out of input before the final
//!   meta-block ends is an error, and the padding bits after the final
//!   meta-block must be zero.
//! - Bytes after the end of the stream are ignored.
//! - Producing more than `max_output` bytes is an error. The check uses the
//!   meta-block lengths, so it fails before the data is decoded.
//! - The large-window extension is rejected.
//! - A stream may contain at most 2^20 dictionary references that produce no
//!   bytes (possible with some transforms). Encoders never emit them; the
//!   limit stops inputs that would otherwise spin for a long time.
//!
//! Which streams are accepted follows the C decoder in google/brotli
//! (`BrotliDecoderDecompress`). In particular a command that runs past the
//! end of its meta-block is an error.

use core::fmt;

// RFC 7932 appendix A. SHA-256 20e42eb1b511c21806d4d227d07e5dd06877d8ce7b3a817f378f313653f35c70.
static DICT: &[u8; 122_784] = include_bytes!("brotli_dict.bin");

/// Decoding error.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct BrotliError {
    msg: &'static str,
}

impl BrotliError {
    /// Short description of the problem.
    pub fn message(&self) -> &'static str {
        self.msg
    }
}

impl fmt::Display for BrotliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "brotli: {}", self.msg)
    }
}

impl fmt::Debug for BrotliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "BrotliError({:?})", self.msg)
    }
}

impl std::error::Error for BrotliError {}

type R<T> = Result<T, BrotliError>;

const fn e(msg: &'static str) -> BrotliError {
    BrotliError { msg }
}

const TRUNCATED: BrotliError = e("unexpected end of input");
const INTERNAL: BrotliError = e("internal index out of range");
const OUTPUT_LIMIT: BrotliError = e("output exceeds limit");

const MAX_EMPTY_COMMANDS: u32 = 1 << 20;

// ---------------------------------------------------------------------------
// Bit reader

struct BitReader<'a> {
    data: &'a [u8],
    // Next byte of `data` to load into `val`.
    pos: usize,
    // Bits above `nbits` are either zero or equal to the next input bits.
    val: u64,
    nbits: u32,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        BitReader {
            data,
            pos: 0,
            val: 0,
            nbits: 0,
        }
    }

    #[inline(always)]
    fn refill(&mut self) {
        if self.nbits >= 56 {
            return;
        }
        let chunk = self.data.get(self.pos..self.pos + 8);
        if let Some(arr) = chunk.and_then(|c| <[u8; 8]>::try_from(c).ok()) {
            self.val |= u64::from_le_bytes(arr) << self.nbits;
            let take = (63 - self.nbits) >> 3;
            self.pos += take as usize;
            self.nbits += take << 3;
            return;
        }
        while self.nbits < 56 {
            match self.data.get(self.pos) {
                Some(&b) => {
                    self.val |= u64::from(b) << self.nbits;
                    self.pos += 1;
                    self.nbits += 8;
                }
                None => break,
            }
        }
    }

    #[inline(always)]
    fn consume(&mut self, n: u32) {
        self.val >>= n;
        self.nbits -= n;
    }

    /// Reads `n` bits (n <= 32), least significant first.
    #[inline(always)]
    fn bits(&mut self, n: u32) -> R<u32> {
        if self.nbits < n {
            self.refill();
            if self.nbits < n {
                return Err(TRUNCATED);
            }
        }
        let v = (self.val & ((1u64 << n) - 1)) as u32;
        self.consume(n);
        Ok(v)
    }

    /// Skips to the next byte boundary; the skipped bits must be zero.
    fn align(&mut self) -> R<()> {
        let n = self.nbits & 7;
        if self.bits(n)? != 0 {
            return Err(e("non-zero padding bits"));
        }
        Ok(())
    }

    /// Takes `n` whole bytes. Must be called on a byte boundary.
    fn take_bytes(&mut self, n: usize) -> R<&'a [u8]> {
        let start = self
            .pos
            .checked_sub((self.nbits / 8) as usize)
            .ok_or(INTERNAL)?;
        let end = start.checked_add(n).ok_or(TRUNCATED)?;
        let s = self.data.get(start..end).ok_or(TRUNCATED)?;
        self.pos = end;
        self.val = 0;
        self.nbits = 0;
        Ok(s)
    }
}

// ---------------------------------------------------------------------------
// Prefix codes

// Lookup table entry. In a root slot with `bits > ROOT_BITS`, `value` is the
// offset of a second-level table of 2^(bits - ROOT_BITS) entries.
#[derive(Clone, Copy, Default)]
struct Entry {
    bits: u8,
    value: u16,
}

const ROOT_BITS: u32 = 8;
const ROOT_SIZE: usize = 1 << ROOT_BITS;
const MAX_CODE_LEN: usize = 15;

#[inline(always)]
fn get<T: Copy>(s: &[T], i: usize) -> R<T> {
    s.get(i).copied().ok_or(INTERNAL)
}

#[inline(always)]
fn set(s: &mut [Entry], i: usize, v: Entry) -> R<()> {
    *s.get_mut(i).ok_or(INTERNAL)? = v;
    Ok(())
}

/// Decodes one symbol using the table that starts at `base` in `table`.
#[inline(always)]
fn read_sym(br: &mut BitReader, table: &[Entry], base: usize) -> R<u16> {
    if br.nbits < MAX_CODE_LEN as u32 {
        br.refill();
    }
    let peek = br.val;
    let root = get(table, base + (peek as usize & (ROOT_SIZE - 1)))?;
    let (n, v) = if u32::from(root.bits) > ROOT_BITS {
        let sub_bits = u32::from(root.bits) - ROOT_BITS;
        let idx = ((peek >> ROOT_BITS) & ((1u64 << sub_bits) - 1)) as usize;
        let s = get(table, base + root.value as usize + idx)?;
        (ROOT_BITS + u32::from(s.bits), s.value)
    } else {
        (u32::from(root.bits), root.value)
    };
    if n > br.nbits {
        return Err(TRUNCATED);
    }
    br.consume(n);
    Ok(v)
}

fn push_single(out: &mut Vec<Entry>, sym: u16) {
    out.extend(core::iter::repeat_n(
        Entry {
            bits: 0,
            value: sym,
        },
        ROOT_SIZE,
    ));
}

/// Appends a lookup table for the canonical code with the given lengths.
/// The code must be complete, or have exactly one used symbol.
fn build_table(lengths: &[u8], out: &mut Vec<Entry>) -> R<()> {
    let mut count = [0u32; MAX_CODE_LEN + 1];
    let mut used = 0usize;
    let mut last_sym = 0usize;
    for (sym, &l) in lengths.iter().enumerate() {
        if l != 0 {
            if l as usize > MAX_CODE_LEN {
                return Err(INTERNAL);
            }
            count[l as usize] += 1;
            used += 1;
            last_sym = sym;
        }
    }
    if used == 1 {
        push_single(out, last_sym as u16);
        return Ok(());
    }
    let mut kraft = 0u32;
    for (l, &c) in count.iter().enumerate().skip(1) {
        kraft += c << (MAX_CODE_LEN - l);
    }
    if kraft != 1 << MAX_CODE_LEN {
        return Err(e("incomplete or oversubscribed prefix code"));
    }
    let mut next = [0u32; MAX_CODE_LEN + 1];
    let mut code = 0u32;
    for l in 1..=MAX_CODE_LEN {
        code = (code + count[l - 1]) << 1;
        next[l] = code;
    }
    // Bit-reversed codes, since the stream is read least significant bit first.
    let mut codes: Vec<(u16, u8, u16)> = Vec::with_capacity(used);
    let mut sub_max = [0u8; ROOT_SIZE];
    for (sym, &l) in lengths.iter().enumerate() {
        if l == 0 {
            continue;
        }
        let c = next[l as usize];
        next[l as usize] += 1;
        let r = (c.reverse_bits() >> (32 - u32::from(l))) as u16;
        codes.push((sym as u16, l, r));
        if u32::from(l) > ROOT_BITS {
            let p = r as usize & (ROOT_SIZE - 1);
            if sub_max[p] < l {
                sub_max[p] = l;
            }
        }
    }
    let base = out.len();
    out.resize(base + ROOT_SIZE, Entry::default());
    for (p, &m) in sub_max.iter().enumerate() {
        if m != 0 {
            let off = out.len() - base;
            set(
                out,
                base + p,
                Entry {
                    bits: m,
                    value: u16::try_from(off).map_err(|_| INTERNAL)?,
                },
            )?;
            out.resize(out.len() + (1 << (u32::from(m) - ROOT_BITS)), Entry::default());
        }
    }
    for &(sym, l, r) in &codes {
        let l32 = u32::from(l);
        if l32 <= ROOT_BITS {
            let mut k = r as usize;
            while k < ROOT_SIZE {
                set(out, base + k, Entry { bits: l, value: sym })?;
                k += 1 << l32;
            }
        } else {
            let root = get(out, base + (r as usize & (ROOT_SIZE - 1)))?;
            let size = 1usize << (u32::from(root.bits) - ROOT_BITS);
            let sub = base + root.value as usize;
            let mut k = (r >> ROOT_BITS) as usize;
            while k < size {
                set(
                    out,
                    sub + k,
                    Entry {
                        bits: l - ROOT_BITS as u8,
                        value: sym,
                    },
                )?;
                k += 1 << (l32 - ROOT_BITS);
            }
        }
    }
    Ok(())
}

const CODE_LENGTH_ORDER: [usize; 18] = [1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15];
// Fixed code for code length code lengths, indexed by the next 4 bits.
const CL_PREFIX_LEN: [u8; 16] = [2, 2, 2, 3, 2, 2, 2, 4, 2, 2, 2, 3, 2, 2, 2, 4];
const CL_PREFIX_VAL: [u8; 16] = [0, 4, 3, 2, 0, 4, 3, 1, 0, 4, 3, 2, 0, 4, 3, 5];

/// Reads a prefix code over `alphabet` symbols and appends its table to `out`.
fn read_prefix_code(
    br: &mut BitReader,
    alphabet: usize,
    out: &mut Vec<Entry>,
    lengths: &mut Vec<u8>,
) -> R<()> {
    let hskip = br.bits(2)?;
    lengths.clear();
    lengths.resize(alphabet, 0);
    if hskip == 1 {
        // Simple prefix code.
        let nsym = br.bits(2)? as usize + 1;
        let nbits = usize::BITS - (alphabet.saturating_sub(1)).leading_zeros();
        let mut syms = [0usize; 4];
        for i in 0..nsym {
            let s = br.bits(nbits)? as usize;
            if s >= alphabet {
                return Err(e("simple prefix code symbol out of range"));
            }
            if syms[..i].contains(&s) {
                return Err(e("duplicate symbol in simple prefix code"));
            }
            syms[i] = s;
        }
        let lens: &[u8] = match nsym {
            1 => {
                push_single(out, syms[0] as u16);
                return Ok(());
            }
            2 => &[1, 1],
            3 => &[1, 2, 2],
            _ => {
                if br.bits(1)? == 0 {
                    &[2, 2, 2, 2]
                } else {
                    &[1, 2, 3, 3]
                }
            }
        };
        for (&s, &l) in syms.iter().zip(lens) {
            *lengths.get_mut(s).ok_or(INTERNAL)? = l;
        }
        return build_table(lengths, out);
    }

    // Complex prefix code: first the code length code.
    let mut cl = [0u8; 18];
    let mut space = 32i32;
    let mut num = 0;
    for &o in CODE_LENGTH_ORDER.iter().skip(hskip as usize) {
        if br.nbits < 4 {
            br.refill();
        }
        let p = (br.val & 15) as usize;
        let n = u32::from(get(&CL_PREFIX_LEN, p)?);
        if n > br.nbits {
            return Err(TRUNCATED);
        }
        br.consume(n);
        let v = get(&CL_PREFIX_VAL, p)?;
        cl[o] = v;
        if v != 0 {
            space -= 32 >> v;
            num += 1;
            if space <= 0 {
                break;
            }
        }
    }
    if !(num == 1 || space == 0) {
        return Err(e("invalid code length code"));
    }
    let mut cl_table = Vec::with_capacity(ROOT_SIZE);
    build_table(&cl, &mut cl_table)?;

    // Then the symbol code lengths.
    let mut sym = 0usize;
    let mut prev_len = 8u8;
    let mut repeat = 0usize;
    let mut repeat_len = 0u8;
    let mut space = 32768i32;
    while sym < alphabet && space > 0 {
        let c = read_sym(br, &cl_table, 0)?;
        if c < 16 {
            repeat = 0;
            let l = c as u8;
            *lengths.get_mut(sym).ok_or(INTERNAL)? = l;
            if l != 0 {
                prev_len = l;
                space -= 32768 >> l;
            }
            sym += 1;
        } else {
            let (extra, new_len) = if c == 16 { (2, prev_len) } else { (3, 0) };
            if repeat_len != new_len {
                repeat = 0;
                repeat_len = new_len;
            }
            let old = repeat;
            if repeat > 0 {
                repeat = (repeat - 2) << extra;
            }
            repeat += br.bits(extra)? as usize + 3;
            let delta = repeat - old;
            if delta > alphabet - sym {
                return Err(e("code length repeat past end of alphabet"));
            }
            let run = lengths.get_mut(sym..sym + delta).ok_or(INTERNAL)?;
            run.fill(repeat_len);
            sym += delta;
            if repeat_len != 0 {
                // delta <= 704, so this cannot overflow.
                space -= (delta as i32) << (15 - u32::from(repeat_len));
            }
        }
    }
    if space != 0 {
        return Err(e("incomplete or oversubscribed prefix code"));
    }
    build_table(lengths, out)
}

/// A set of prefix codes stored in one buffer.
struct Group {
    table: Vec<Entry>,
    starts: Vec<usize>,
}

impl Group {
    fn read(br: &mut BitReader, alphabet: usize, n: usize, scratch: &mut Vec<u8>) -> R<Group> {
        let mut g = Group {
            table: Vec::new(),
            starts: Vec::with_capacity(n),
        };
        for _ in 0..n {
            g.starts.push(g.table.len());
            read_prefix_code(br, alphabet, &mut g.table, scratch)?;
        }
        Ok(g)
    }

    #[inline(always)]
    fn start(&self, i: usize) -> R<usize> {
        get(&self.starts, i)
    }
}

// ---------------------------------------------------------------------------
// Block types and counts

const BLOCK_LEN_BASE: [u32; 26] = [
    1, 5, 9, 13, 17, 25, 33, 41, 49, 65, 81, 97, 113, 145, 177, 209, 241, 305, 369, 497, 753,
    1265, 2289, 4337, 8433, 16625,
];
const BLOCK_LEN_EXTRA: [u8; 26] = [
    2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 7, 8, 9, 10, 11, 12, 13, 24,
];

fn read_var_u8(br: &mut BitReader) -> R<u32> {
    if br.bits(1)? == 0 {
        return Ok(0);
    }
    let n = br.bits(3)?;
    if n == 0 {
        return Ok(1);
    }
    Ok((1 << n) + br.bits(n)?)
}

struct BlockSwitch {
    n: usize,
    types: Vec<Entry>,
    counts: Vec<Entry>,
    cur: usize,
    prev: usize,
    count: u32,
}

impl BlockSwitch {
    fn read(br: &mut BitReader, scratch: &mut Vec<u8>) -> R<BlockSwitch> {
        let n = read_var_u8(br)? as usize + 1;
        let mut s = BlockSwitch {
            n,
            types: Vec::new(),
            counts: Vec::new(),
            cur: 0,
            prev: 1,
            count: 1 << 24,
        };
        if n >= 2 {
            read_prefix_code(br, n + 2, &mut s.types, scratch)?;
            read_prefix_code(br, 26, &mut s.counts, scratch)?;
            s.count = s.read_count(br)?;
        }
        Ok(s)
    }

    fn read_count(&self, br: &mut BitReader) -> R<u32> {
        let c = read_sym(br, &self.counts, 0)? as usize;
        let base = get(&BLOCK_LEN_BASE, c)?;
        let extra = get(&BLOCK_LEN_EXTRA, c)?;
        Ok(base + br.bits(u32::from(extra))?)
    }

    /// Reads the next block type and count.
    fn switch(&mut self, br: &mut BitReader) -> R<()> {
        if self.n < 2 {
            return Err(e("block count exhausted"));
        }
        let s = read_sym(br, &self.types, 0)? as usize;
        let mut t = match s {
            0 => self.prev,
            1 => self.cur + 1,
            _ => s - 2,
        };
        if t >= self.n {
            t -= self.n;
        }
        self.prev = self.cur;
        self.cur = t;
        self.count = self.read_count(br)?;
        Ok(())
    }
}

fn read_context_map(
    br: &mut BitReader,
    size: usize,
    ntrees: usize,
    scratch: &mut Vec<u8>,
) -> R<Vec<u8>> {
    let mut map = vec![0u8; size];
    if ntrees < 2 {
        return Ok(map);
    }
    let rle_max = if br.bits(1)? == 1 { br.bits(4)? + 1 } else { 0 };
    let mut table = Vec::new();
    read_prefix_code(br, ntrees + rle_max as usize, &mut table, scratch)?;
    let mut i = 0usize;
    while i < size {
        let c = u32::from(read_sym(br, &table, 0)?);
        if c == 0 {
            i += 1;
        } else if c <= rle_max {
            let reps = (1usize << c) + br.bits(c)? as usize;
            if reps > size - i {
                return Err(e("context map run too long"));
            }
            i += reps;
        } else {
            *map.get_mut(i).ok_or(INTERNAL)? = (c - rle_max) as u8;
            i += 1;
        }
    }
    if br.bits(1)? == 1 {
        // Inverse move-to-front.
        let mut mtf: [u8; 256] = core::array::from_fn(|i| i as u8);
        for v in map.iter_mut() {
            let idx = *v as usize;
            let val = mtf[idx];
            *v = val;
            mtf.copy_within(0..idx, 1);
            mtf[0] = val;
        }
    }
    Ok(map)
}

// ---------------------------------------------------------------------------
// Commands

#[derive(Clone, Copy)]
struct Cmd {
    ins_base: u32,
    ins_extra: u8,
    copy_base: u32,
    copy_extra: u8,
    implicit_dist: bool,
    dist_ctx: u8,
}

const INS_BASE: [u32; 24] = [
    0, 1, 2, 3, 4, 5, 6, 8, 10, 14, 18, 26, 34, 50, 66, 98, 130, 194, 322, 578, 1090, 2114, 6210,
    22594,
];
const INS_EXTRA: [u8; 24] = [
    0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 12, 14, 24,
];
const COPY_BASE: [u32; 24] = [
    2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 18, 22, 30, 38, 54, 70, 102, 134, 198, 326, 582, 1094,
    2118,
];
const COPY_EXTRA: [u8; 24] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 24,
];
// First insert and copy length code of each 64-symbol cell.
const CELL_INS: [usize; 11] = [0, 0, 0, 0, 8, 8, 0, 16, 8, 16, 16];
const CELL_COPY: [usize; 11] = [0, 8, 0, 8, 0, 8, 16, 0, 16, 8, 16];

const fn build_cmds() -> [Cmd; 704] {
    let mut t = [Cmd {
        ins_base: 0,
        ins_extra: 0,
        copy_base: 0,
        copy_extra: 0,
        implicit_dist: false,
        dist_ctx: 0,
    }; 704];
    let mut s = 0;
    while s < 704 {
        let cell = s >> 6;
        let ic = CELL_INS[cell] + ((s >> 3) & 7);
        let cc = CELL_COPY[cell] + (s & 7);
        t[s] = Cmd {
            ins_base: INS_BASE[ic],
            ins_extra: INS_EXTRA[ic],
            copy_base: COPY_BASE[cc],
            copy_extra: COPY_EXTRA[cc],
            implicit_dist: cell < 2,
            dist_ctx: if cc < 3 { cc as u8 } else { 3 },
        };
        s += 1;
    }
    t
}

static CMDS: [Cmd; 704] = build_cmds();

// Distance codes 0..15: (index into recent distances, delta).
const SHORT_DIST: [(u8, i8); 16] = [
    (0, 0),
    (1, 0),
    (2, 0),
    (3, 0),
    (0, -1),
    (0, 1),
    (0, -2),
    (0, 2),
    (0, -3),
    (0, 3),
    (1, -1),
    (1, 1),
    (1, -2),
    (1, 2),
    (1, -3),
    (1, 3),
];

const DICT_OFFSETS: [u32; 25] = [
    0, 0, 0, 0, 0, 4096, 9216, 21504, 35840, 44032, 53248, 63488, 74752, 87040, 93696, 100864,
    104704, 106752, 108928, 113536, 115968, 118528, 119872, 121280, 122016,
];
const DICT_SIZE_BITS: [u8; 25] = [
    0, 0, 0, 0, 10, 10, 11, 11, 10, 10, 10, 10, 10, 9, 9, 8, 7, 7, 8, 7, 7, 6, 6, 5, 5,
];

#[inline(always)]
fn context(mode: u8, p1: u8, p2: u8) -> usize {
    (match mode {
        0 => p1 & 0x3f,
        1 => p1 >> 2,
        2 => UTF8_LUT0[p1 as usize] | UTF8_LUT1[p2 as usize],
        _ => (SIGNED_LUT[p1 as usize] << 3) | SIGNED_LUT[p2 as usize],
    }) as usize
}

// Simplified uppercasing from the RFC. Returns the number of bytes stepped over.
fn to_upper(w: &mut [u8], i: usize) -> usize {
    let Some(c) = w.get_mut(i) else { return 1 };
    if *c < 0xc0 {
        if c.is_ascii_lowercase() {
            *c ^= 32;
        }
        return 1;
    }
    let c = *c;
    if c < 0xe0 {
        if let Some(b) = w.get_mut(i + 1) {
            *b ^= 32;
        }
        return 2;
    }
    if let Some(b) = w.get_mut(i + 2) {
        *b ^= 5;
    }
    3
}

/// Appends dictionary word `word` with transform `t` to `out`.
fn push_transformed(out: &mut Vec<u8>, word: &[u8], t: usize) -> R<()> {
    let &(prefix, ty, suffix) = TRANSFORMS.get(t).ok_or(e("invalid transform"))?;
    out.extend_from_slice(prefix);
    let mut w = [0u8; 24];
    let mut len = word.len().min(w.len());
    w[..len].copy_from_slice(&word[..len]);
    let mut start = 0;
    if ty >= 12 {
        start = usize::from(ty - 11).min(len);
    } else if ty <= 9 {
        len = len.saturating_sub(usize::from(ty));
    }
    let part = &mut w[start..len];
    if ty == 10 {
        to_upper(part, 0);
    } else if ty == 11 {
        let mut i = 0;
        while i < part.len() {
            i += to_upper(part, i);
        }
    }
    out.extend_from_slice(part);
    out.extend_from_slice(suffix);
    Ok(())
}

// ---------------------------------------------------------------------------
// Stream

struct Decoder<'a> {
    br: BitReader<'a>,
    out: Vec<u8>,
    window: usize,
    // Recent distances, most recent first.
    dist: [i64; 4],
    empty_commands: u32,
    scratch: Vec<u8>,
}

/// Decompresses a complete brotli stream and returns it with the length of the
/// stream in bytes: everything up to and including the byte that holds the
/// last bit of the final meta-block (that byte's padding bits must be zero).
///
/// Returns an error if the stream is invalid or truncated, uses the
/// large-window extension, or decodes to more than `max_output` bytes.
/// Input after the end of the stream is ignored.
pub fn decompress_with_consumed(
    input: &[u8],
    max_output: usize,
) -> Result<(Vec<u8>, usize), BrotliError> {
    let mut br = BitReader::new(input);
    let wbits = read_window_bits(&mut br)?;
    let mut d = Decoder {
        br,
        out: Vec::new(),
        window: (1usize << wbits) - 16,
        dist: [4, 11, 15, 16],
        empty_commands: 0,
        scratch: Vec::new(),
    };
    loop {
        let last = d.br.bits(1)? == 1;
        if last && d.br.bits(1)? == 1 {
            break;
        }
        let nibbles = d.br.bits(2)?;
        if nibbles == 3 {
            // Metadata: skipped.
            if d.br.bits(1)? != 0 {
                return Err(e("reserved bit set"));
            }
            let nbytes = d.br.bits(2)?;
            let mut len = 0usize;
            for i in 0..nbytes {
                let b = d.br.bits(8)?;
                if i + 1 == nbytes && nbytes > 1 && b == 0 {
                    return Err(e("metadata length has a zero last byte"));
                }
                len |= (b as usize) << (8 * i);
            }
            if nbytes > 0 {
                len += 1;
            }
            d.br.align()?;
            d.br.take_bytes(len)?;
        } else {
            let nibbles = nibbles + 4;
            let mut mlen = 0usize;
            for i in 0..nibbles {
                let v = d.br.bits(4)?;
                if i + 1 == nibbles && nibbles > 4 && v == 0 {
                    return Err(e("meta-block length has a zero last nibble"));
                }
                mlen |= (v as usize) << (4 * i);
            }
            mlen += 1;
            let uncompressed = !last && d.br.bits(1)? == 1;
            if mlen > max_output.saturating_sub(d.out.len()) {
                return Err(OUTPUT_LIMIT);
            }
            if uncompressed {
                d.br.align()?;
                let s = d.br.take_bytes(mlen)?;
                d.out.extend_from_slice(s);
            } else {
                d.compressed_block(mlen)?;
            }
        }
        if last {
            break;
        }
    }
    d.br.align()?;
    let used = d.br.pos.checked_sub((d.br.nbits / 8) as usize).ok_or(INTERNAL)?;
    Ok((d.out, used))
}

fn read_window_bits(br: &mut BitReader) -> R<u32> {
    if br.bits(1)? == 0 {
        return Ok(16);
    }
    let n = br.bits(3)?;
    if n != 0 {
        return Ok(17 + n);
    }
    let n = br.bits(3)?;
    match n {
        0 => Ok(17),
        1 => Err(e("large window brotli is not supported")),
        _ => Ok(8 + n),
    }
}

impl Decoder<'_> {
    fn compressed_block(&mut self, mlen: usize) -> R<()> {
        let br = &mut self.br;
        let scratch = &mut self.scratch;
        let mut lit_bs = BlockSwitch::read(br, scratch)?;
        let mut cmd_bs = BlockSwitch::read(br, scratch)?;
        let mut dist_bs = BlockSwitch::read(br, scratch)?;
        let npostfix = br.bits(2)?;
        let ndirect = br.bits(4)? << npostfix;
        let postfix_mask = (1u32 << npostfix) - 1;
        let mut modes = Vec::with_capacity(lit_bs.n);
        for _ in 0..lit_bs.n {
            modes.push(br.bits(2)? as u8);
        }
        let ntrees_l = read_var_u8(br)? as usize + 1;
        let cmap_l = read_context_map(br, 64 * lit_bs.n, ntrees_l, scratch)?;
        let ntrees_d = read_var_u8(br)? as usize + 1;
        let cmap_d = read_context_map(br, 4 * dist_bs.n, ntrees_d, scratch)?;
        let lit = Group::read(br, 256, ntrees_l, scratch)?;
        let cmd = Group::read(br, 704, cmd_bs.n, scratch)?;
        let dist_alphabet = 16 + ndirect as usize + (48usize << npostfix);
        let dist = Group::read(br, dist_alphabet, ntrees_d, scratch)?;

        // Literal table starts for the 64 contexts of the current block type.
        let mut lit_starts = [0usize; 64];
        let set_lit = |starts: &mut [usize; 64], btype: usize| -> R<u8> {
            for (ctx, s) in starts.iter_mut().enumerate() {
                *s = lit.start(get(&cmap_l, 64 * btype + ctx)? as usize)?;
            }
            get(&modes, btype)
        };
        let mut mode = set_lit(&mut lit_starts, 0)?;
        let mut cmd_start = cmd.start(0)?;
        let mut dist_cmap = 0usize;

        let out = &mut self.out;
        let mut tail = out.iter().rev();
        let mut p1 = tail.next().copied().unwrap_or(0);
        let mut p2 = tail.next().copied().unwrap_or(0);
        let mut remaining = mlen;
        while remaining > 0 {
            if cmd_bs.count == 0 {
                cmd_bs.switch(br)?;
                cmd_start = cmd.start(cmd_bs.cur)?;
            }
            cmd_bs.count -= 1;
            let c = get(&CMDS, read_sym(br, &cmd.table, cmd_start)? as usize)?;
            let insert_len = (c.ins_base + br.bits(u32::from(c.ins_extra))?) as usize;
            let copy_len = (c.copy_base + br.bits(u32::from(c.copy_extra))?) as usize;
            if insert_len > remaining {
                return Err(e("insert past end of meta-block"));
            }
            for _ in 0..insert_len {
                if lit_bs.count == 0 {
                    lit_bs.switch(br)?;
                    mode = set_lit(&mut lit_starts, lit_bs.cur)?;
                }
                lit_bs.count -= 1;
                let start = lit_starts[context(mode, p1, p2) & 63];
                let b = read_sym(br, &lit.table, start)? as u8;
                out.push(b);
                p2 = p1;
                p1 = b;
            }
            remaining -= insert_len;
            if remaining == 0 {
                break;
            }

            let mut dcode = 0usize;
            let distance: i64 = if c.implicit_dist {
                self.dist[0]
            } else {
                if dist_bs.count == 0 {
                    dist_bs.switch(br)?;
                    dist_cmap = 4 * dist_bs.cur;
                }
                dist_bs.count -= 1;
                let tree = get(&cmap_d, dist_cmap + c.dist_ctx as usize)? as usize;
                dcode = read_sym(br, &dist.table, dist.start(tree)?)? as usize;
                if dcode < 16 {
                    let (idx, delta) = get(&SHORT_DIST, dcode)?;
                    let v = get(&self.dist, idx as usize)? + i64::from(delta);
                    if v <= 0 {
                        return Err(e("invalid distance"));
                    }
                    v
                } else if dcode < 16 + ndirect as usize {
                    dcode as i64 - 15
                } else {
                    let x = (dcode - 16 - ndirect as usize) as u32;
                    let nbits = 1 + (x >> (npostfix + 1));
                    let hcode = x >> npostfix;
                    let lcode = x & postfix_mask;
                    let offset = ((2 + i64::from(hcode & 1)) << nbits) - 4;
                    let extra = i64::from(br.bits(nbits)?);
                    ((offset + extra) << npostfix) + i64::from(lcode) + i64::from(ndirect) + 1
                }
            };

            let max_dist = self.window.min(out.len());
            let distance = distance as usize;
            if distance > max_dist {
                // Static dictionary reference.
                if !(4..=24).contains(&copy_len) {
                    return Err(e("invalid backward reference"));
                }
                let word_id = distance - max_dist - 1;
                let nbits = get(&DICT_SIZE_BITS, copy_len)?;
                let idx = word_id & ((1usize << nbits) - 1);
                let t = word_id >> nbits;
                let off = get(&DICT_OFFSETS, copy_len)? as usize + idx * copy_len;
                let word = DICT.get(off..off + copy_len).ok_or(INTERNAL)?;
                let before = out.len();
                push_transformed(out, word, t)?;
                let n = out.len() - before;
                if n > remaining {
                    return Err(e("dictionary word past end of meta-block"));
                }
                if n == 0 {
                    self.empty_commands += 1;
                    if self.empty_commands > MAX_EMPTY_COMMANDS {
                        return Err(e("too many empty dictionary references"));
                    }
                }
                remaining -= n;
            } else {
                if copy_len > remaining {
                    return Err(e("copy past end of meta-block"));
                }
                if dcode != 0 {
                    self.dist = [distance as i64, self.dist[0], self.dist[1], self.dist[2]];
                }
                if distance == 0 {
                    return Err(INTERNAL);
                }
                let start = out.len().checked_sub(distance).ok_or(INTERNAL)?;
                if distance >= copy_len {
                    out.extend_from_within(start..start + copy_len);
                } else {
                    let mut left = copy_len;
                    while left > 0 {
                        let n = left.min(out.len() - start);
                        out.extend_from_within(start..start + n);
                        left -= n;
                    }
                }
                remaining -= copy_len;
            }
            let mut tail = out.iter().rev();
            p1 = tail.next().copied().unwrap_or(0);
            p2 = tail.next().copied().unwrap_or(0);
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Tables

// (prefix, transform type, suffix) for the 121 transforms of RFC 7932 appendix B.
// Type: 0 identity, 1-9 omit last N, 10 uppercase first, 11 uppercase all,
// 12-18 omit first 1-7, 20 omit first 9.
const TRANSFORMS: [(&[u8], u8, &[u8]); 121] = [
    (b"", 0, b""),
    (b"", 0, b" "),
    (b" ", 0, b" "),
    (b"", 12, b""),
    (b"", 10, b" "),
    (b"", 0, b" the "),
    (b" ", 0, b""),
    (b"s ", 0, b" "),
    (b"", 0, b" of "),
    (b"", 10, b""),
    (b"", 0, b" and "),
    (b"", 13, b""),
    (b"", 1, b""),
    (b", ", 0, b" "),
    (b"", 0, b", "),
    (b" ", 10, b" "),
    (b"", 0, b" in "),
    (b"", 0, b" to "),
    (b"e ", 0, b" "),
    (b"", 0, b"\""),
    (b"", 0, b"."),
    (b"", 0, b"\">"),
    (b"", 0, b"\n"),
    (b"", 3, b""),
    (b"", 0, b"]"),
    (b"", 0, b" for "),
    (b"", 14, b""),
    (b"", 2, b""),
    (b"", 0, b" a "),
    (b"", 0, b" that "),
    (b" ", 10, b""),
    (b"", 0, b". "),
    (b".", 0, b""),
    (b" ", 0, b", "),
    (b"", 15, b""),
    (b"", 0, b" with "),
    (b"", 0, b"'"),
    (b"", 0, b" from "),
    (b"", 0, b" by "),
    (b"", 16, b""),
    (b"", 17, b""),
    (b" the ", 0, b""),
    (b"", 4, b""),
    (b"", 0, b". The "),
    (b"", 11, b""),
    (b"", 0, b" on "),
    (b"", 0, b" as "),
    (b"", 0, b" is "),
    (b"", 7, b""),
    (b"", 1, b"ing "),
    (b"", 0, b"\n\t"),
    (b"", 0, b":"),
    (b" ", 0, b". "),
    (b"", 0, b"ed "),
    (b"", 20, b""),
    (b"", 18, b""),
    (b"", 6, b""),
    (b"", 0, b"("),
    (b"", 10, b", "),
    (b"", 8, b""),
    (b"", 0, b" at "),
    (b"", 0, b"ly "),
    (b" the ", 0, b" of "),
    (b"", 5, b""),
    (b"", 9, b""),
    (b" ", 10, b", "),
    (b"", 10, b"\""),
    (b".", 0, b"("),
    (b"", 11, b" "),
    (b"", 10, b"\">"),
    (b"", 0, b"=\""),
    (b" ", 0, b"."),
    (b".com/", 0, b""),
    (b" the ", 0, b" of the "),
    (b"", 10, b"'"),
    (b"", 0, b". This "),
    (b"", 0, b","),
    (b".", 0, b" "),
    (b"", 10, b"("),
    (b"", 10, b"."),
    (b"", 0, b" not "),
    (b" ", 0, b"=\""),
    (b"", 0, b"er "),
    (b" ", 11, b" "),
    (b"", 0, b"al "),
    (b" ", 11, b""),
    (b"", 0, b"='"),
    (b"", 11, b"\""),
    (b"", 10, b". "),
    (b" ", 0, b"("),
    (b"", 0, b"ful "),
    (b" ", 10, b". "),
    (b"", 0, b"ive "),
    (b"", 0, b"less "),
    (b"", 11, b"'"),
    (b"", 0, b"est "),
    (b" ", 10, b"."),
    (b"", 11, b"\">"),
    (b" ", 0, b"='"),
    (b"", 10, b","),
    (b"", 0, b"ize "),
    (b"", 11, b"."),
    (b"\xc2\xa0", 0, b""),
    (b" ", 0, b","),
    (b"", 10, b"=\""),
    (b"", 11, b"=\""),
    (b"", 0, b"ous "),
    (b"", 11, b", "),
    (b"", 10, b"='"),
    (b" ", 10, b","),
    (b" ", 11, b"=\""),
    (b" ", 11, b", "),
    (b"", 11, b","),
    (b"", 11, b"("),
    (b"", 11, b". "),
    (b" ", 11, b"."),
    (b"", 11, b"='"),
    (b" ", 11, b". "),
    (b" ", 10, b"=\""),
    (b" ", 11, b"='"),
    (b" ", 10, b"='"),
];

const UTF8_LUT0: [u8; 256] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 0, 0, 4, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    8, 12, 16, 12, 12, 20, 12, 16, 24, 28, 12, 12, 32, 12, 36, 12,
    44, 44, 44, 44, 44, 44, 44, 44, 44, 44, 32, 32, 24, 40, 28, 12,
    12, 48, 52, 52, 52, 48, 52, 52, 52, 48, 52, 52, 52, 52, 52, 48,
    52, 52, 52, 52, 52, 48, 52, 52, 52, 52, 52, 24, 12, 28, 12, 12,
    12, 56, 60, 60, 60, 56, 60, 60, 60, 56, 60, 60, 60, 60, 60, 56,
    60, 60, 60, 60, 60, 56, 60, 60, 60, 60, 60, 24, 12, 28, 12, 0,
    0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1,
    0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1,
    0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1,
    0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1,
    2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3,
    2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3,
    2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3,
    2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3,
];
const UTF8_LUT1: [u8; 256] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1,
    1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1,
    1, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
    3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 1, 1, 1, 1, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
];
const SIGNED_LUT: [u8; 256] = [
    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
    3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
    3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
    3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
    4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
    4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
    4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
    4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
    5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
    5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
    5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
    6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 7,
];
