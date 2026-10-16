//! The ISO BMFF container (ISO/IEC 18181-2): finds the codestream (`jxlc`, or `jxlp` parts)
//! and the JPEG reconstruction box (`jbrd`).

use crate::error::{invalid, Error, Result};
use std::borrow::Cow;

const SIGNATURE: [u8; 12] = [0, 0, 0, 0x0C, b'J', b'X', b'L', b' ', 0x0D, 0x0A, 0x87, 0x0A];

pub struct Parsed<'a> {
    pub codestream: Cow<'a, [u8]>,
    pub jbrd: Option<&'a [u8]>,
    /// `Exif` and `xml ` boxes, or `brob` boxes holding them (body, is_brotli).
    pub exif: Option<(&'a [u8], bool)>,
    pub xmp: Option<(&'a [u8], bool)>,
}

/// Splits a JPEG XL file into its codestream (and JPEG reconstruction data, if any).
pub fn parse(data: &[u8]) -> Result<Parsed<'_>> {
    if data.len() >= 2 && data[0] == 0xFF && data[1] == 0x0A {
        return Ok(Parsed { codestream: Cow::Borrowed(data), jbrd: None, exif: None, xmp: None });
    }
    if data.len() < 12 || data[..12] != SIGNATURE {
        return invalid("not a JPEG XL file");
    }
    let mut pos = 12;
    let mut jxlc: Option<&[u8]> = None;
    let mut parts: Vec<&[u8]> = Vec::new();
    let mut last_part_seen = false;
    let mut next_index = 0u32;
    let mut jbrd = None;
    let mut exif = None;
    let mut xmp = None;
    while pos < data.len() {
        let rest = &data[pos..];
        if rest.len() < 8 {
            // DICOM pads fragments to even length; a few stray bytes after the last box carry
            // nothing, as for libjxl.
            if rest.iter().all(|&b| b == 0) {
                break;
            }
            return invalid("truncated box header");
        }
        let size32 = u32::from_be_bytes([rest[0], rest[1], rest[2], rest[3]]) as u64;
        let ty = [rest[4], rest[5], rest[6], rest[7]];
        let (header, size) = match size32 {
            1 => {
                if rest.len() < 16 {
                    return invalid("truncated box header");
                }
                let mut b = [0u8; 8];
                b.copy_from_slice(&rest[8..16]);
                (16usize, u64::from_be_bytes(b))
            }
            0 => (8usize, rest.len() as u64),
            s => (8usize, s),
        };
        if size < header as u64 || size > rest.len() as u64 {
            return invalid("box size");
        }
        let body = &rest[header..size as usize];
        match &ty {
            b"jxlc" => {
                if jxlc.is_some() || !parts.is_empty() {
                    return invalid("more than one codestream");
                }
                jxlc = Some(body);
            }
            b"jxlp" => {
                if jxlc.is_some() || last_part_seen {
                    return invalid("unexpected jxlp box");
                }
                if body.len() < 4 {
                    return invalid("jxlp box too small");
                }
                let idx = u32::from_be_bytes([body[0], body[1], body[2], body[3]]);
                if idx & 0x7FFF_FFFF != next_index {
                    return invalid("jxlp boxes out of order");
                }
                next_index += 1;
                if idx & 0x8000_0000 != 0 {
                    last_part_seen = true;
                }
                parts.push(&body[4..]);
            }
            b"jbrd" => jbrd = Some(body),
            b"Exif" if exif.is_none() => exif = Some((body, false)),
            b"xml " if xmp.is_none() => xmp = Some((body, false)),
            b"brob" if body.len() >= 4 => match &body[..4] {
                b"Exif" if exif.is_none() => exif = Some((&body[4..], true)),
                b"xml " if xmp.is_none() => xmp = Some((&body[4..], true)),
                b"jxlc" | b"jxlp" | b"jbrd" | b"brob" => return invalid("brob box with a forbidden type"),
                _ => {}
            },
            _ => {}
        }
        pos += size as usize;
    }
    let codestream = if let Some(c) = jxlc {
        Cow::Borrowed(c)
    } else if !parts.is_empty() {
        let total: usize = parts.iter().map(|p| p.len()).sum();
        let mut v = Vec::new();
        v.try_reserve_exact(total).map_err(|_| Error::Limit("codestream"))?;
        for p in parts {
            v.extend_from_slice(p);
        }
        Cow::Owned(v)
    } else {
        return invalid("no codestream box");
    };
    Ok(Parsed { codestream, jbrd, exif, xmp })
}
