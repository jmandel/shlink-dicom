use crate::{Error, Result};

const ZIGZAG: [usize; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
    13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59,
    52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

#[derive(Clone, Default)]
struct HuffTable {
    max_code: [i32; 17],
    val_offset: [i32; 17],
    values: Vec<u8>,
}

impl HuffTable {
    fn from_counts_and_symbols(counts: &[u8; 16], symbols: &[u8]) -> Self {
        let mut max_code = [-1i32; 17];
        let mut val_offset = [0i32; 17];
        let mut code = 0i32;
        let mut k = 0i32;
        for bits in 1..=16 {
            let count = counts[bits - 1] as i32;
            if count == 0 {
                max_code[bits] = -1;
            } else {
                val_offset[bits] = k - code;
                code += count;
                k += count;
                max_code[bits] = code - 1;
            }
            code <<= 1;
        }
        Self {
            max_code,
            val_offset,
            values: symbols.to_vec(),
        }
    }
}

struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
    bit_buf: u32,
    bit_count: u8,
    marker_hit: Option<u8>,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            pos: 0,
            bit_buf: 0,
            bit_count: 0,
            marker_hit: None,
        }
    }

    fn next_bit(&mut self) -> Result<u32> {
        if self.bit_count == 0 {
            let b = self.read_stuffed_byte()?;
            self.bit_buf = b as u32;
            self.bit_count = 8;
        }
        self.bit_count -= 1;
        Ok((self.bit_buf >> self.bit_count) & 1)
    }

    fn read_bits(&mut self, n: u8) -> Result<i32> {
        let mut val = 0u32;
        for _ in 0..n {
            val = (val << 1) | self.next_bit()?;
        }
        Ok(val as i32)
    }

    fn decode_huff(&mut self, table: &HuffTable) -> Result<u8> {
        let mut code = 0i32;
        for bits in 1..=16 {
            code = (code << 1) | (self.next_bit()? as i32);
            if code <= table.max_code[bits] {
                let idx = (code + table.val_offset[bits]) as usize;
                return table
                    .values
                    .get(idx)
                    .copied()
                    .ok_or_else(|| Error::Dicom("JPEG Huffman index out of bounds".into()));
            }
        }
        Err(Error::Dicom("invalid JPEG Huffman code".into()))
    }

    fn read_stuffed_byte(&mut self) -> Result<u8> {
        if self.marker_hit.is_some() {
            return Ok(0);
        }
        if self.pos >= self.data.len() {
            return Err(Error::Dicom("unexpected EOF in JPEG entropy stream".into()));
        }
        let b = self.data[self.pos];
        self.pos += 1;
        if b == 0xFF {
            while self.pos < self.data.len() && self.data[self.pos] == 0xFF {
                self.pos += 1;
            }
            if self.pos >= self.data.len() {
                return Ok(0);
            }
            let next = self.data[self.pos];
            self.pos += 1;
            if next == 0x00 {
                return Ok(0xFF);
            } else {
                self.marker_hit = Some(next);
                return Ok(0);
            }
        }
        Ok(b)
    }

    fn align_for_restart(&mut self) {
        self.bit_buf = 0;
        self.bit_count = 0;
        if let Some(m) = self.marker_hit.take() {
            if (0xD0..=0xD7).contains(&m) {
                return;
            }
        }
        while self.pos + 1 < self.data.len() {
            if self.data[self.pos] == 0xFF {
                let m = self.data[self.pos + 1];
                if (0xD0..=0xD7).contains(&m) {
                    self.pos += 2;
                    return;
                }
            }
            self.pos += 1;
        }
    }
}

fn receive_extend(s: u8, reader: &mut BitReader<'_>) -> Result<i32> {
    if s == 0 {
        return Ok(0);
    }
    let v = reader.read_bits(s)?;
    let vt = 1i32 << (s - 1);
    if v < vt {
        Ok(v + ((-1i32) << s) + 1)
    } else {
        Ok(v)
    }
}

/// Decodes an 8-bit or 12-bit single-component (grayscale) Sequential DCT JPEG (SOF0/SOF1)
/// into little-endian `u16` (for >8-bit) or `u8` (for 8-bit) raw pixel bytes.
pub fn decode_jpeg_12bit_mono(jpeg: &[u8]) -> Result<Vec<u8>> {
    if jpeg.len() < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 {
        return Err(Error::Dicom("missing JPEG SOI marker".into()));
    }

    let mut q_tables = [[0i32; 64]; 4];
    let mut dc_tables: [Option<HuffTable>; 4] = Default::default();
    let mut ac_tables: [Option<HuffTable>; 4] = Default::default();
    let mut precision = 8u8;
    let mut height = 0usize;
    let mut width = 0usize;
    let mut q_selector = 0usize;
    let mut restart_interval = 0usize;

    let mut pos = 2usize;
    while pos + 1 < jpeg.len() {
        if jpeg[pos] != 0xFF {
            pos += 1;
            continue;
        }
        while pos < jpeg.len() && jpeg[pos] == 0xFF {
            pos += 1;
        }
        if pos >= jpeg.len() {
            break;
        }
        let marker = jpeg[pos];
        pos += 1;

        if marker == 0xD9 {
            break;
        }
        if marker == 0xD8 || (0xD0..=0xD7).contains(&marker) {
            continue;
        }
        if pos + 2 > jpeg.len() {
            return Err(Error::Dicom("truncated JPEG marker length".into()));
        }
        let seg_len = u16::from_be_bytes([jpeg[pos], jpeg[pos + 1]]) as usize;
        if seg_len < 2 || pos + seg_len > jpeg.len() {
            return Err(Error::Dicom("invalid JPEG segment length".into()));
        }
        let seg = &jpeg[pos + 2..pos + seg_len];
        pos += seg_len;

        match marker {
            0xDB => {
                // DQT
                let mut p = 0;
                while p < seg.len() {
                    let pq_tq = seg[p];
                    p += 1;
                    let pq = pq_tq >> 4;
                    let tq = (pq_tq & 0x0F) as usize;
                    if tq >= 4 {
                        return Err(Error::Dicom("invalid DQT table id".into()));
                    }
                    for i in 0..64 {
                        if pq == 0 {
                            q_tables[tq][ZIGZAG[i]] = seg[p] as i32;
                            p += 1;
                        } else {
                            q_tables[tq][ZIGZAG[i]] =
                                u16::from_be_bytes([seg[p], seg[p + 1]]) as i32;
                            p += 2;
                        }
                    }
                }
            }
            0xC0 | 0xC1 => {
                // SOF0 / SOF1
                if seg.len() < 9 {
                    return Err(Error::Dicom("short SOF segment".into()));
                }
                precision = seg[0];
                height = u16::from_be_bytes([seg[1], seg[2]]) as usize;
                width = u16::from_be_bytes([seg[3], seg[4]]) as usize;
                let n_comp = seg[5];
                if n_comp != 1 {
                    return Err(Error::Dicom(format!(
                        "12-bit JPEG decoder only supports 1 component, got {n_comp}"
                    )));
                }
                q_selector = seg[8] as usize;
            }
            0xC4 => {
                // DHT
                let mut p = 0;
                while p + 17 <= seg.len() {
                    let tc_th = seg[p];
                    let tc = tc_th >> 4;
                    let th = (tc_th & 0x0F) as usize;
                    let counts: [u8; 16] = seg[p + 1..p + 17].try_into().unwrap();
                    p += 17;
                    let total_syms: usize = counts.iter().map(|&c| c as usize).sum();
                    if p + total_syms > seg.len() || th >= 4 {
                        return Err(Error::Dicom("invalid DHT segment".into()));
                    }
                    let table = HuffTable::from_counts_and_symbols(&counts, &seg[p..p + total_syms]);
                    p += total_syms;
                    if tc == 0 {
                        dc_tables[th] = Some(table);
                    } else {
                        ac_tables[th] = Some(table);
                    }
                }
            }
            0xDD => {
                // DRI
                if seg.len() >= 2 {
                    restart_interval = u16::from_be_bytes([seg[0], seg[1]]) as usize;
                }
            }
            0xDA => {
                // SOS
                if seg.len() < 6 {
                    return Err(Error::Dicom("short SOS segment".into()));
                }
                let td_ta = seg[2];
                let td = (td_ta >> 4) as usize;
                let ta = (td_ta & 0x0F) as usize;
                let dc_table = dc_tables
                    .get(td)
                    .and_then(|t| t.as_ref())
                    .ok_or_else(|| Error::Dicom("missing DC Huffman table".into()))?;
                let ac_table = ac_tables
                    .get(ta)
                    .and_then(|t| t.as_ref())
                    .ok_or_else(|| Error::Dicom("missing AC Huffman table".into()))?;
                let q_table = &q_tables[q_selector.min(3)];

                let mcu_cols = width.div_ceil(8);
                let mcu_rows = height.div_ceil(8);
                let level_shift = if precision == 12 { 2048i32 } else { 128i32 };
                let max_sample = if precision == 12 { 4095i32 } else { 255i32 };

                let mut reader = BitReader::new(&jpeg[pos..]);
                let mut prev_dc = 0i32;
                let mut mcu_count = 0usize;
                let mut pixels_u16 = vec![0u16; width * height];

                for mcu_y in 0..mcu_rows {
                    for mcu_x in 0..mcu_cols {
                        if restart_interval > 0 && mcu_count > 0 && mcu_count % restart_interval == 0
                        {
                            reader.align_for_restart();
                            prev_dc = 0;
                        }
                        mcu_count += 1;

                        let mut coeffs = [0i32; 64];
                        let s_dc = reader.decode_huff(dc_table)?;
                        let diff = receive_extend(s_dc, &mut reader)?;
                        prev_dc += diff;
                        coeffs[0] = prev_dc * q_table[0];

                        let mut k = 1usize;
                        while k < 64 {
                            let rs = reader.decode_huff(ac_table)?;
                            let r = (rs >> 4) as usize;
                            let s = rs & 0x0F;
                            if s == 0 {
                                if r == 15 {
                                    k += 16;
                                    continue;
                                } else {
                                    break;
                                }
                            }
                            k += r;
                            if k >= 64 {
                                break;
                            }
                            let ac = receive_extend(s, &mut reader)?;
                            coeffs[ZIGZAG[k]] = ac * q_table[ZIGZAG[k]];
                            k += 1;
                        }

                        let block = idct_8x8(&coeffs, level_shift, max_sample);
                        for by in 0..8 {
                            let py = mcu_y * 8 + by;
                            if py >= height {
                                continue;
                            }
                            for bx in 0..8 {
                                let px = mcu_x * 8 + bx;
                                if px >= width {
                                    continue;
                                }
                                pixels_u16[py * width + px] = block[by * 8 + bx];
                            }
                        }
                    }
                }

                if precision <= 8 {
                    return Ok(pixels_u16.into_iter().map(|v| v as u8).collect());
                } else {
                    let mut out = Vec::with_capacity(pixels_u16.len() * 2);
                    for v in pixels_u16 {
                        out.extend_from_slice(&v.to_le_bytes());
                    }
                    return Ok(out);
                }
            }
            _ => {}
        }
    }

    Err(Error::Dicom("JPEG stream missing SOS marker".into()))
}

fn idct_8x8(coeffs: &[i32; 64], level_shift: i32, max_sample: i32) -> [u16; 64] {
    // Separable 1D floating-point IDCT over rows then columns
    const COS_TABLE: [[f32; 8]; 8] = [
        [0.35355338, 0.35355338, 0.35355338, 0.35355338, 0.35355338, 0.35355338, 0.35355338, 0.35355338],
        [0.49039263, 0.41573480, 0.27778512, 0.09754516, -0.09754516, -0.27778512, -0.41573480, -0.49039263],
        [0.46193975, 0.19134171, -0.19134171, -0.46193975, -0.46193975, -0.19134171, 0.19134171, 0.46193975],
        [0.41573480, -0.09754516, -0.49039263, -0.27778512, 0.27778512, 0.49039263, 0.09754516, -0.41573480],
        [0.35355338, -0.35355338, -0.35355338, 0.35355338, 0.35355338, -0.35355338, -0.35355338, 0.35355338],
        [0.27778512, -0.49039263, 0.09754516, 0.41573480, -0.41573480, -0.09754516, 0.49039263, -0.27778512],
        [0.19134171, -0.46193975, 0.46193975, -0.19134171, -0.19134171, 0.46193975, -0.46193975, 0.19134171],
        [0.09754516, -0.27778512, 0.41573480, -0.49039263, 0.49039263, -0.41573480, 0.27778512, -0.09754516],
    ];

    let mut tmp = [0.0f32; 64];
    for y in 0..8 {
        for x in 0..8 {
            let mut sum = 0.0f32;
            for u in 0..8 {
                sum += (coeffs[y * 8 + u] as f32) * COS_TABLE[u][x];
            }
            tmp[y * 8 + x] = sum;
        }
    }

    let mut out = [0u16; 64];
    for y in 0..8 {
        for x in 0..8 {
            let mut sum = 0.0f32;
            for v in 0..8 {
                sum += tmp[v * 8 + x] * COS_TABLE[v][y];
            }
            let val = (sum.round() as i32 + level_shift).clamp(0, max_sample);
            out[y * 8 + x] = val as u16;
        }
    }
    out
}
