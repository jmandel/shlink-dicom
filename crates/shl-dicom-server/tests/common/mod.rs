//! Shared test helpers.
#![allow(dead_code)]

/// A small explicit VR little endian Part 10 file.
pub fn part10(sop: &str) -> Vec<u8> {
    fn el(b: &mut Vec<u8>, g: u16, e: u16, vr: &[u8; 2], v: &[u8]) {
        let mut v = v.to_vec();
        if v.len() % 2 == 1 {
            v.push(if vr == b"UI" { 0 } else { b' ' });
        }
        b.extend_from_slice(&g.to_le_bytes());
        b.extend_from_slice(&e.to_le_bytes());
        b.extend_from_slice(vr);
        if matches!(vr, b"OB" | b"OW") {
            b.extend_from_slice(&[0, 0]);
            b.extend_from_slice(&(v.len() as u32).to_le_bytes());
        } else {
            b.extend_from_slice(&(v.len() as u16).to_le_bytes());
        }
        b.extend_from_slice(&v);
    }
    let mut meta = Vec::new();
    el(&mut meta, 0x0002, 0x0001, b"OB", &[0, 1]);
    el(&mut meta, 0x0002, 0x0002, b"UI", b"1.2.840.10008.5.1.4.1.1.1");
    el(&mut meta, 0x0002, 0x0003, b"UI", sop.as_bytes());
    el(&mut meta, 0x0002, 0x0010, b"UI", b"1.2.840.10008.1.2.1");
    let mut b = vec![0u8; 128];
    b.extend_from_slice(b"DICM");
    el(&mut b, 0x0002, 0x0000, b"UL", &(meta.len() as u32).to_le_bytes());
    b.extend_from_slice(&meta);
    el(&mut b, 0x0008, 0x0016, b"UI", b"1.2.840.10008.5.1.4.1.1.1");
    el(&mut b, 0x0008, 0x0018, b"UI", sop.as_bytes());
    el(&mut b, 0x0008, 0x0060, b"CS", b"CR");
    el(&mut b, 0x0020, 0x000D, b"UI", b"2.25.88");
    el(&mut b, 0x0020, 0x000E, b"UI", b"2.25.88.1");
    el(&mut b, 0x7FE0, 0x0010, b"OW", &[0u8; 64]);
    b
}

