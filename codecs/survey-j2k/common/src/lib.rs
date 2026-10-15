//! Shared adapter plumbing for the J2K survey.
//!
//! Adapter protocol: `a-<name> IN.j2c OUT.raw`
//!   - OUT.raw: i32 little-endian samples, interleaved (rows, cols, comps), exactly as the
//!     candidate delivered them (after whatever colour transform the candidate applies).
//!   - stdout: one JSON line `{"w":..,"h":..,"nc":..,"signed_out":bool}`; `signed_out` says
//!     whether the candidate claims its samples are already signed values.
//!   - exit 0 ok, 2 on decoder error (message on stderr). Panics surface as exit 101.

use std::io::Write;

#[derive(Debug, Clone)]
pub struct Siz {
    pub width: u32,
    pub height: u32,
    pub comps: Vec<(u8, bool)>, // (precision, signed)
}

/// Minimal SIZ reader (only for adapters that need to know precision/signedness).
pub fn parse_siz(cs: &[u8]) -> Option<Siz> {
    let mut i = cs.windows(2).position(|w| w == [0xFF, 0x51])? + 2;
    let rd16 = |b: &[u8], i: usize| -> Option<u32> { Some(u16::from_be_bytes([*b.get(i)?, *b.get(i + 1)?]) as u32) };
    let rd32 = |b: &[u8], i: usize| -> Option<u32> {
        Some(u32::from_be_bytes([*b.get(i)?, *b.get(i + 1)?, *b.get(i + 2)?, *b.get(i + 3)?]))
    };
    let _len = rd16(cs, i)?;
    i += 2;
    let _rsiz = rd16(cs, i)?;
    let xsiz = rd32(cs, i + 2)?;
    let ysiz = rd32(cs, i + 6)?;
    let xo = rd32(cs, i + 10)?;
    let yo = rd32(cs, i + 14)?;
    let csiz = rd16(cs, i + 34)? as usize;
    let mut comps = Vec::new();
    for c in 0..csiz {
        let s = *cs.get(i + 36 + 3 * c)?;
        comps.push(((s & 0x7F) + 1, s & 0x80 != 0));
    }
    Some(Siz { width: xsiz.checked_sub(xo)?, height: ysiz.checked_sub(yo)?, comps })
}

pub fn args() -> (Vec<u8>, String) {
    let a: Vec<String> = std::env::args().collect();
    if a.len() != 3 {
        eprintln!("usage: {} IN.j2c OUT.raw", a[0]);
        std::process::exit(64);
    }
    let data = std::fs::read(&a[1]).expect("read input");
    let data = if std::env::var_os("SURVEY_NO_UNWRAP").is_some() { data } else { unwrap_jp2(data) };
    (data, a[2].clone())
}

/// Wrapper step every candidate gets: if the frame is a JP2 file (seen in the wild, e.g. GDCM
/// output), return the payload of its `jp2c` box, to the end of the buffer (so a trailing DICOM
/// even-length pad byte after the box does not matter).
pub fn unwrap_jp2(data: Vec<u8>) -> Vec<u8> {
    if !data.starts_with(&[0, 0, 0, 0x0C, b'j', b'P', b' ', b' ']) {
        return data;
    }
    match data.windows(4).position(|w| w == b"jp2c") {
        Some(i) => data[i + 4..].to_vec(),
        None => data,
    }
}

pub fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("decode error: {msg}");
    std::process::exit(2);
}

/// Write planar component data (each plane w*h) as interleaved i32.
pub fn write_planes(out: &str, w: u32, h: u32, planes: &[Vec<i32>], signed_out: bool) {
    let n = (w as usize) * (h as usize);
    for p in planes {
        if p.len() < n {
            fail(format!("plane has {} samples, expected {}", p.len(), n));
        }
    }
    let mut buf = Vec::with_capacity(n * planes.len() * 4);
    for i in 0..n {
        for p in planes {
            buf.extend_from_slice(&p[i].to_le_bytes());
        }
    }
    std::fs::write(out, buf).expect("write output");
    let mut so = std::io::stdout();
    writeln!(so, "{{\"w\":{w},\"h\":{h},\"nc\":{},\"signed_out\":{signed_out}}}", planes.len()).ok();
}

/// Write already-interleaved samples.
pub fn write_interleaved(out: &str, w: u32, h: u32, nc: usize, data: &[i32], signed_out: bool) {
    let mut buf = Vec::with_capacity(data.len() * 4);
    for v in data {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::write(out, buf).expect("write output");
    println!("{{\"w\":{w},\"h\":{h},\"nc\":{nc},\"signed_out\":{signed_out}}}");
}
