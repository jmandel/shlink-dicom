//! Compressed ICC profiles (ISO/IEC 18181-1 Annex B.4): entropy-coded bytes, then the
//! header prediction and the command/data streams that rebuild the profile.

use crate::bits::BitReader;
use crate::entropy::EntropyCode;
use crate::error::{invalid, Error, Result};

const HEADER_SIZE: usize = 128;
const NUM_CONTEXTS: usize = 41;
const MAX_SIZE: u64 = 1 << 28;

fn byte_kind1(b: u8) -> usize {
    match b {
        b'a'..=b'z' | b'A'..=b'Z' => 0,
        b'0'..=b'9' | b'.' | b',' => 1,
        0 => 2,
        1 => 3,
        2..=15 => 4,
        255 => 6,
        241..=254 => 5,
        _ => 7,
    }
}

fn byte_kind2(b: u8) -> usize {
    match b {
        b'a'..=b'z' | b'A'..=b'Z' => 0,
        b'0'..=b'9' | b'.' | b',' => 1,
        0..=15 => 2,
        241..=255 => 3,
        _ => 4,
    }
}

fn context(i: usize, b1: u8, b2: u8) -> usize {
    if i <= 128 {
        0
    } else {
        1 + byte_kind1(b1) + byte_kind2(b2) * 8
    }
}

/// Reads the encoded profile from the codestream and returns the ICC bytes.
pub fn read_icc(br: &mut BitReader) -> Result<Vec<u8>> {
    let enc_size = br.u64();
    if enc_size > MAX_SIZE {
        return invalid("ICC profile too large");
    }
    let code = EntropyCode::read(br, NUM_CONTEXTS)?;
    let mut r = code.reader(br, 0)?;
    let n = enc_size as usize;
    // Each byte costs at least a few bits; refuse sizes the data cannot hold.
    if enc_size > br.total_bits() * 256 + 1024 {
        return invalid("ICC profile larger than the data");
    }
    let mut enc = Vec::new();
    enc.try_reserve_exact(n).map_err(|_| Error::Limit("ICC profile"))?;
    for i in 0..n {
        let b1 = if i > 0 { enc[i - 1] } else { 0 };
        let b2 = if i > 1 { enc[i - 2] } else { 0 };
        enc.push(r.read(&code, br, context(i, b1, b2)) as u8);
        if i % 4096 == 0 && br.overrun() {
            return invalid("truncated ICC profile");
        }
    }
    br.check_end()?;
    if !r.check_final_state() {
        return invalid("ICC profile ANS state");
    }
    unpredict(&enc)
}

fn varint(data: &[u8], pos: &mut usize, end: usize) -> Result<u64> {
    let mut ret = 0u64;
    for i in 0..10 {
        if *pos >= end {
            return invalid("ICC varint");
        }
        let b = data[*pos];
        *pos += 1;
        if i == 9 {
            if b & 0xFE != 0 {
                return invalid("ICC varint");
            }
            return Ok(ret | (u64::from(b) << 63));
        }
        ret |= u64::from(b & 0x7F) << (7 * i);
        if b & 0x80 == 0 {
            return Ok(ret);
        }
    }
    invalid("ICC varint")
}

fn check32(v: u64) -> Result<u32> {
    u32::try_from(v).map_err(|_| Error::Invalid("ICC value exceeds 32 bits"))
}

fn bounds(a: usize, b: u64, size: usize) -> Result<usize> {
    let end = (a as u64).checked_add(b).ok_or(Error::Invalid("ICC out of bounds"))?;
    if end > size as u64 {
        return invalid("ICC out of bounds");
    }
    Ok(end as usize)
}

fn push32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn shuffle(data: &mut [u8], width: usize) {
    let size = data.len();
    if size == 0 {
        return;
    }
    let height = size.div_ceil(width);
    let src = data.to_vec();
    let mut s = 0;
    let mut j = 0;
    for d in data.iter_mut() {
        *d = src[j];
        j += height;
        if j >= size {
            s += 1;
            j = s;
        }
    }
}

fn predict_value(p1: u64, p2: u64, p3: u64, order: u32) -> u64 {
    match order {
        0 => p1,
        1 => p1.wrapping_mul(2).wrapping_sub(p2),
        _ => p1.wrapping_mul(3).wrapping_sub(p2.wrapping_mul(3)).wrapping_add(p3),
    }
}

fn be32(data: &[u8], size: usize, pos: usize) -> u64 {
    if pos + 4 > size {
        0
    } else {
        u64::from(u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]))
    }
}

fn linear_predict(data: &[u8], start: usize, i: usize, stride: usize, width: usize, order: u32) -> u8 {
    let pos = start + i;
    match width {
        1 => {
            let g = |k: usize| u64::from(data[pos - stride * k]);
            predict_value(g(1), g(2), g(3), order) as u8
        }
        2 => {
            let p = start + (i & !1);
            let g = |k: usize| (u64::from(data[p - stride * k]) << 8) + u64::from(data[p - stride * k + 1]);
            let pred = predict_value(g(1), g(2), g(3), order) & 0xFFFF;
            if i & 1 == 1 {
                (pred & 255) as u8
            } else {
                ((pred >> 8) & 255) as u8
            }
        }
        _ => {
            let p = start + (i & !3);
            let g = |k: usize| be32(data, pos, p - stride * k);
            let pred = predict_value(g(1), g(2), g(3), order) & 0xFFFF_FFFF;
            let shift = 3 - (i & 3);
            ((pred >> (shift * 8)) & 255) as u8
        }
    }
}

const TAG_STRINGS: [&[u8; 4]; 17] = [
    b"cprt", b"wtpt", b"bkpt", b"rXYZ", b"gXYZ", b"bXYZ", b"kXYZ", b"rTRC", b"gTRC", b"bTRC", b"kTRC", b"chad",
    b"desc", b"chrm", b"dmnd", b"dmdd", b"lumi",
];
const TYPE_STRINGS: [&[u8; 4]; 8] = [b"XYZ ", b"desc", b"text", b"mluc", b"para", b"curv", b"sf32", b"gbd "];

#[rustfmt::skip]
const INITIAL_HEADER: [u8; HEADER_SIZE] = [
    0,   0,   0,   0,   0,   0,   0,   0,   4, 0, 0, 0, b'm', b'n', b't', b'r',
    b'R', b'G', b'B', b' ', b'X', b'Y', b'Z', b' ', 0, 0, 0, 0, 0,   0,   0,   0,
    0,   0,   0,   0,   b'a', b'c', b's', b'p', 0, 0, 0, 0, 0,   0,   0,   0,
    0,   0,   0,   0,   0,   0,   0,   0,   0, 0, 0, 0, 0,   0,   0,   0,
    0,   0,   0,   0,   0,   0,   246, 214, 0, 1, 0, 0, 0,   0,   211, 45,
    0,   0,   0,   0,   0,   0,   0,   0,   0, 0, 0, 0, 0,   0,   0,   0,
    0,   0,   0,   0,   0,   0,   0,   0,   0, 0, 0, 0, 0,   0,   0,   0,
    0,   0,   0,   0,   0,   0,   0,   0,   0, 0, 0, 0, 0,   0,   0,   0,
];

fn predict_header(icc: &[u8], header: &mut [u8; HEADER_SIZE], pos: usize) {
    let size = icc.len();
    if pos == 8 && size >= 8 {
        header[80..84].copy_from_slice(&icc[4..8]);
    }
    if pos == 41 && size >= 41 {
        if icc[40] == b'A' {
            header[41..44].copy_from_slice(b"PPL");
        }
        if icc[40] == b'M' {
            header[41..44].copy_from_slice(b"SFT");
        }
    }
    if pos == 42 && size >= 42 {
        if icc[40] == b'S' && icc[41] == b'G' {
            header[42..44].copy_from_slice(b"I ");
        }
        if icc[40] == b'S' && icc[41] == b'U' {
            header[42..44].copy_from_slice(b"NW");
        }
    }
}

fn unpredict(enc: &[u8]) -> Result<Vec<u8>> {
    let size = enc.len();
    let mut pos = 0;
    let osize = check32(varint(enc, &mut pos, size)?)? as usize;
    let csize = check32(varint(enc, &mut pos, size)?)?;
    if osize as u64 > MAX_SIZE || (osize as u64 + 65536) < size as u64 {
        return invalid("malformed ICC");
    }
    let mut cpos = pos;
    let commands_end = bounds(pos, u64::from(csize), size)?;
    pos = commands_end;
    let mut out: Vec<u8> = Vec::new();
    out.try_reserve_exact(osize).map_err(|_| Error::Limit("ICC profile"))?;
    let mut header = INITIAL_HEADER;
    header[0..4].copy_from_slice(&(osize as u32).to_be_bytes());
    for i in 0..=HEADER_SIZE {
        if out.len() == osize {
            if cpos != commands_end || pos != size {
                return invalid("ICC trailing data");
            }
            return Ok(out);
        }
        if i == HEADER_SIZE {
            break;
        }
        predict_header(&out, &mut header, i);
        if pos >= size {
            return invalid("ICC out of bounds");
        }
        out.push(enc[pos].wrapping_add(header[i]));
        pos += 1;
    }
    if cpos >= commands_end {
        return invalid("ICC out of bounds");
    }
    let numtags = varint(enc, &mut cpos, commands_end)?;
    if numtags != 0 {
        let numtags = check32(numtags - 1)?;
        push32(&mut out, numtags);
        let mut prevtagstart = HEADER_SIZE as u64 + u64::from(numtags) * 12;
        let mut prevtagsize = 0u64;
        loop {
            if out.len() > osize {
                return invalid("ICC size");
            }
            if cpos >= commands_end {
                break;
            }
            let command = enc[cpos];
            cpos += 1;
            let tagcode = command & 63;
            let tag: [u8; 4] = match tagcode {
                0 => break,
                1 => {
                    bounds(pos, 4, size)?;
                    let t = [enc[pos], enc[pos + 1], enc[pos + 2], enc[pos + 3]];
                    pos += 4;
                    t
                }
                2 => *b"rTRC",
                3 => *b"rXYZ",
                t => match TAG_STRINGS.get(usize::from(t) - 4) {
                    Some(s) => **s,
                    None => return invalid("ICC tag code"),
                },
            };
            out.extend_from_slice(&tag);
            let mut tagsize = prevtagsize;
            if matches!(&tag, b"rXYZ" | b"gXYZ" | b"bXYZ" | b"kXYZ" | b"wtpt" | b"bkpt" | b"lumi") {
                tagsize = 20;
            }
            let tagstart = if command & 64 != 0 {
                varint(enc, &mut cpos, commands_end)?
            } else {
                check32(prevtagstart)?;
                prevtagstart + prevtagsize
            };
            push32(&mut out, check32(tagstart)?);
            if command & 128 != 0 {
                tagsize = varint(enc, &mut cpos, commands_end)?;
            }
            push32(&mut out, check32(tagsize)?);
            prevtagstart = tagstart;
            prevtagsize = tagsize;
            if tagcode == 2 {
                for t in [b"gTRC", b"bTRC"] {
                    out.extend_from_slice(t);
                    push32(&mut out, tagstart as u32);
                    push32(&mut out, tagsize as u32);
                }
            }
            if tagcode == 3 {
                check32(tagstart + tagsize * 2)?;
                out.extend_from_slice(b"gXYZ");
                push32(&mut out, (tagstart + tagsize) as u32);
                push32(&mut out, tagsize as u32);
                out.extend_from_slice(b"bXYZ");
                push32(&mut out, (tagstart + tagsize * 2) as u32);
                push32(&mut out, tagsize as u32);
            }
        }
    }
    loop {
        if out.len() > osize {
            return invalid("ICC size");
        }
        if cpos >= commands_end {
            break;
        }
        let command = enc[cpos];
        cpos += 1;
        match command {
            1 => {
                let num = varint(enc, &mut cpos, commands_end)?;
                let end = bounds(pos, num, size)?;
                out.extend_from_slice(&enc[pos..end]);
                pos = end;
            }
            2 | 3 => {
                let num = varint(enc, &mut cpos, commands_end)?;
                let end = bounds(pos, num, size)?;
                let mut s = enc[pos..end].to_vec();
                shuffle(&mut s, if command == 2 { 2 } else { 4 });
                out.extend_from_slice(&s);
                pos = end;
            }
            4 => {
                bounds(cpos, 2, commands_end)?;
                let flags = enc[cpos];
                cpos += 1;
                let width = usize::from(flags & 3) + 1;
                if width == 3 {
                    return invalid("ICC predict width");
                }
                let order = u32::from((flags & 12) >> 2);
                if order == 3 {
                    return invalid("ICC predict order");
                }
                let mut stride = width as u64;
                if flags & 16 != 0 {
                    stride = varint(enc, &mut cpos, commands_end)?;
                    if stride < width as u64 {
                        return invalid("ICC stride");
                    }
                }
                if out.is_empty() || (((out.len() - 1) >> 2) as u64) < stride {
                    return invalid("ICC stride");
                }
                let stride = stride as usize;
                let num = varint(enc, &mut cpos, commands_end)?;
                let end = bounds(pos, num, size)?;
                if out.len() as u64 + num > osize as u64 {
                    return invalid("ICC size");
                }
                let mut s = enc[pos..end].to_vec();
                if width > 1 {
                    shuffle(&mut s, width);
                }
                let start = out.len();
                for (i, &v) in s.iter().enumerate() {
                    let p = linear_predict(&out, start, i, stride, width, order);
                    out.push(p.wrapping_add(v));
                }
                pos = end;
            }
            10 => {
                out.extend_from_slice(b"XYZ \0\0\0\0");
                let end = bounds(pos, 12, size)?;
                out.extend_from_slice(&enc[pos..end]);
                pos = end;
            }
            16..=23 => {
                out.extend_from_slice(TYPE_STRINGS[usize::from(command - 16)]);
                out.extend_from_slice(&[0; 4]);
            }
            _ => return invalid("ICC command"),
        }
    }
    if pos != size || out.len() != osize {
        return invalid("ICC size mismatch");
    }
    Ok(out)
}
