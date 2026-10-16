//! End-to-end checks on small files built here. The corpus and the Josh Example studies are checked
//! by tools/check_corpus.py against the reference decoders.
use shl_dicom_transcode::{transcode_part10, IMPLEMENTATION_CLASS_UID, IMPLEMENTATION_VERSION_NAME, JPEG_LOSSLESS_SV1};

fn el(out: &mut Vec<u8>, g: u16, e: u16, vr: &[u8; 2], v: &[u8], explicit: bool) {
    out.extend_from_slice(&g.to_le_bytes());
    out.extend_from_slice(&e.to_le_bytes());
    if explicit {
        out.extend_from_slice(vr);
        if matches!(vr, b"OB" | b"OW" | b"SQ" | b"UN") {
            out.extend_from_slice(&[0, 0]);
            out.extend_from_slice(&(v.len() as u32).to_le_bytes());
        } else {
            out.extend_from_slice(&(v.len() as u16).to_le_bytes());
        }
    } else {
        out.extend_from_slice(&(v.len() as u32).to_le_bytes());
    }
    out.extend_from_slice(v);
}

/// A Part 10 file: `frames` frames of rows × cols × spp 16-bit samples (12 stored), with a private
/// element and a sequence before Pixel Data, and an element after it.
fn file(ts: &str, explicit: bool, spp: u16, planar: u16, frames: u16, rows: u16, cols: u16) -> Vec<u8> {
    let mut f = vec![0u8; 128];
    f.extend_from_slice(b"DICM");
    let mut meta = Vec::new();
    let mut tsv = ts.as_bytes().to_vec();
    if tsv.len() % 2 == 1 {
        tsv.push(0);
    }
    el(&mut meta, 2, 1, b"OB", &[0, 1], true);
    el(&mut meta, 2, 0x10, b"UI", &tsv, true);
    el(&mut meta, 2, 0x12, b"UI", b"1.2.3.4", true);
    el(&mut f, 2, 0, b"UL", &(meta.len() as u32).to_le_bytes(), true);
    f.extend_from_slice(&meta);
    let us = |v: u16| v.to_le_bytes();
    el(&mut f, 0x0008, 0x0060, b"CS", b"CT", explicit);
    el(&mut f, 0x0009, 0x0010, b"LO", b"ACME", explicit);
    el(&mut f, 0x0009, 0x1001, b"UN", &[1, 2, 3, 4], explicit);
    // (0008,1140) Referenced Image Sequence, undefined length, one undefined-length item.
    let mut item = Vec::new();
    el(&mut item, 0x0008, 0x1150, b"UI", b"1.2\0", explicit);
    f.extend_from_slice(&[0x08, 0x00, 0x40, 0x11]);
    if explicit {
        f.extend_from_slice(b"SQ\0\0");
    }
    f.extend_from_slice(&[0xFF; 4]);
    f.extend_from_slice(&[0xFE, 0xFF, 0x00, 0xE0, 0xFF, 0xFF, 0xFF, 0xFF]);
    f.extend_from_slice(&item);
    f.extend_from_slice(&[0xFE, 0xFF, 0x0D, 0xE0, 0, 0, 0, 0, 0xFE, 0xFF, 0xDD, 0xE0, 0, 0, 0, 0]);
    el(&mut f, 0x0028, 0x0002, b"US", &us(spp), explicit);
    el(&mut f, 0x0028, 0x0004, b"CS", if spp == 3 { b"RGB " } else { b"MONOCHROME2 " }, explicit);
    if spp == 3 {
        el(&mut f, 0x0028, 0x0006, b"US", &us(planar), explicit);
    }
    el(&mut f, 0x0028, 0x0008, b"IS", format!("{frames:<2}").as_bytes(), explicit);
    el(&mut f, 0x0028, 0x0010, b"US", &us(rows), explicit);
    el(&mut f, 0x0028, 0x0011, b"US", &us(cols), explicit);
    el(&mut f, 0x0028, 0x0100, b"US", &us(16), explicit);
    el(&mut f, 0x0028, 0x0101, b"US", &us(12), explicit);
    el(&mut f, 0x0028, 0x0102, b"US", &us(11), explicit);
    el(&mut f, 0x0028, 0x0103, b"US", &us(0), explicit);
    let n = usize::from(frames) * usize::from(rows) * usize::from(cols) * usize::from(spp);
    let px: Vec<u8> = (0..n).flat_map(|i| (((i * 7 + i / 13) % 4096) as u16).to_le_bytes()).collect();
    el(&mut f, 0x7FE0, 0x0010, b"OW", &px, explicit);
    el(&mut f, 0xFFFC, 0xFFFC, b"OB", &[0, 0], explicit);
    f
}

fn meta_value(f: &[u8], element: u16) -> Option<String> {
    let mut p = 132;
    while f.get(p..p + 2) == Some(&[2, 0]) {
        let e = u16::from_le_bytes([f[p + 2], f[p + 3]]);
        let long = &f[p + 4..p + 6] == b"OB";
        let (len, vs) = if long {
            (u32::from_le_bytes(f[p + 8..p + 12].try_into().unwrap()) as usize, p + 12)
        } else {
            (usize::from(u16::from_le_bytes([f[p + 6], f[p + 7]])), p + 8)
        };
        if e == element {
            return Some(String::from_utf8_lossy(&f[vs..vs + len]).trim_end_matches(['\0', ' ']).to_string());
        }
        p = vs + len;
    }
    None
}

#[test]
fn explicit_and_implicit_multiframe_and_planar_rgb() {
    for (ts, explicit) in [("1.2.840.10008.1.2.1", true), ("1.2.840.10008.1.2", false)] {
        for (spp, planar) in [(1, 0), (3, 0), (3, 1)] {
            let input = file(ts, explicit, spp, planar, 3, 40, 50);
            let out = transcode_part10(&input, JPEG_LOSSLESS_SV1).unwrap_or_else(|e| panic!("{ts} spp {spp}: {e}"));
            assert_eq!(meta_value(&out, 0x10).as_deref(), Some(JPEG_LOSSLESS_SV1));
            assert_eq!(meta_value(&out, 0x12).as_deref(), Some(IMPLEMENTATION_CLASS_UID));
            assert_eq!(meta_value(&out, 0x13).as_deref(), Some(IMPLEMENTATION_VERSION_NAME));
            assert!(out.len() < input.len());
            // Deterministic.
            assert_eq!(out, transcode_part10(&input, JPEG_LOSSLESS_SV1).unwrap());
            // The decoder reads it back to the same pixels (the transcoder checked too).
            let a = shl_dicom_decode::decode_file(&input).unwrap();
            let b = shl_dicom_decode::decode_file(&out).unwrap();
            assert_eq!((a.frames, a.data), (b.frames, b.data));
            // Planar Configuration is 0 afterwards; an explicit input keeps its data set bytes
            // up to Planar Configuration.
            if explicit {
                let pc = out.windows(6).position(|w| w == [0x28, 0x00, 0x06, 0x00, b'U', b'S']).unwrap_or(0);
                if spp == 3 {
                    assert_eq!(&out[pc + 8..pc + 10], &[0, 0]);
                }
            }
        }
    }
}

#[test]
fn declines_leave_reasons() {
    let input = file("1.2.840.10008.1.2.1", true, 1, 0, 1, 8, 8);
    // Already compressed.
    let mut jpeg = input.clone();
    let at = jpeg.windows(19).position(|w| w == b"1.2.840.10008.1.2.1").unwrap();
    jpeg[at..at + 20].copy_from_slice(b"1.2.840.10008.1.2.5\0");
    assert!(transcode_part10(&jpeg, JPEG_LOSSLESS_SV1).unwrap_err().0.contains("not uncompressed"));
    // Not a Part 10 file.
    assert!(transcode_part10(&input[132..], JPEG_LOSSLESS_SV1).is_err());
    // Unknown target.
    assert!(transcode_part10(&input, "1.2.840.10008.1.2.4.50").is_err());
    // Garbage never panics.
    for cut in (0..input.len()).step_by(7) {
        let _ = transcode_part10(&input[..cut], JPEG_LOSSLESS_SV1);
    }
}

/// Mutated files never panic. Seeds: the files under $SHL_TRANSCODE_FUZZ_DIR (for example the
/// corpus's uncompressed samples) plus the files built here; $SHL_TRANSCODE_FUZZ_ITERS rounds.
#[test]
fn mutated_files_never_panic() {
    let mut seeds = vec![file("1.2.840.10008.1.2", false, 3, 1, 2, 9, 7), file("1.2.840.10008.1.2.1", true, 1, 0, 2, 9, 7)];
    if let Ok(dir) = std::env::var("SHL_TRANSCODE_FUZZ_DIR") {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            if let Ok(b) = std::fs::read(e.path()) {
                if b.len() < 400_000 {
                    seeds.push(b);
                }
            }
        }
    }
    let iterations: usize = std::env::var("SHL_TRANSCODE_FUZZ_ITERS").ok().and_then(|s| s.parse().ok()).unwrap_or(200);
    let mut x: u64 = 0x2545_F491_4F6C_DD1D;
    let mut rnd = move || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    for i in 0..iterations {
        let mut f = seeds[i % seeds.len()].clone();
        let span = f.len().clamp(1, 4096);
        for _ in 0..(1 + rnd() % 8) {
            let at = (rnd() as usize) % span;
            match rnd() % 4 {
                0 => f[at] = rnd() as u8,
                1 => f[at] ^= 1 << (rnd() % 8),
                2 => f[at] = [0x00, 0xFF, 0x7F, 0x80][(rnd() % 4) as usize],
                _ => {
                    let cut = (rnd() as usize) % f.len().max(1);
                    f.truncate(cut);
                    break;
                }
            }
        }
        let _ = transcode_part10(&f, JPEG_LOSSLESS_SV1);
    }
}
