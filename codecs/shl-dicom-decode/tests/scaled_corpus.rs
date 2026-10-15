//! `decode_file_scaled` on every corpus sample (codec-corpus/formats/*/samples, when present):
//!
//! - every file `decode_file` decodes also decodes scaled, at ceil(rows / 2^s) × ceil(columns / 2^s),
//!   with the same frame count, sample layout and photometric; a file it refuses is refused with
//!   the same exit code;
//! - where the fallback applies (every syntax without a reduced codec decode), the result equals
//!   the full decode box-downsampled by the independent reference below, exactly;
//! - JPEG baseline/extended uses the codec's reduced decode (checked sample for sample against
//!   libjpeg-turbo by codec-corpus/formats/jpeg-dct/scaled/check_scaled.py); its reduced IDCT is
//!   a block average, so here its mean difference from the box downsample must stay small.
//! - JPEG 2000 and HTJ2K reduce by discarding resolution levels (checked against OpenJPEG's
//!   `opj_decompress -r` by codec-corpus/formats/jpeg2000/scaled/check_scaled.py). The wavelet
//!   low-pass is not a box filter (the 5/3 LL is (−1, 2, 6, 2, −1)/8 per level), so on sharp or
//!   noisy content it differs from a box average by design; the difference is only printed.
//!
//! Slow in debug builds: run with `cargo test --release -p shl-dicom-decode --test scaled_corpus`.
//! `SCALED_FORMATS=rle,jpeg-ls` limits the formats.

use std::fs;
use std::path::Path;

use shl_dicom_decode::{decode_file, decode_file_scaled, scaled_codec_for, Canonical};

fn sample(b: &[u8], signed: bool) -> i64 {
    match (b.len(), signed) {
        (1, false) => i64::from(b[0]),
        (1, true) => i64::from(b[0] as i8),
        (2, false) => i64::from(u16::from_le_bytes([b[0], b[1]])),
        (2, true) => i64::from(i16::from_le_bytes([b[0], b[1]])),
        (_, false) => i64::from(u32::from_le_bytes([b[0], b[1], b[2], b[3]])),
        (_, true) => i64::from(i32::from_le_bytes([b[0], b[1], b[2], b[3]])),
    }
}

/// Reference downsample, written independently of `scale.rs`: per output sample, gather its
/// block and take floor(mean + 1/2) in exact rational arithmetic (or the top-left sample for
/// PALETTE COLOR).
fn reference(c: &Canonical, s: u8) -> Vec<i64> {
    let n = 1usize << s;
    let (h, w, spp, bps) = (c.rows as usize, c.columns as usize, usize::from(c.samples_per_pixel), c.bytes_per_sample());
    let (oh, ow) = (h.div_ceil(n), w.div_ceil(n));
    let vals: Vec<i64> = c.data.chunks_exact(bps).map(|b| sample(b, c.signed)).collect();
    let palette = c.photometric == "PALETTE COLOR";
    let mut out = Vec::with_capacity(c.frames as usize * oh * ow * spp);
    for f in 0..c.frames as usize {
        let frame = &vals[f * h * w * spp..(f + 1) * h * w * spp];
        for oy in 0..oh {
            for ox in 0..ow {
                for k in 0..spp {
                    if palette {
                        out.push(frame[(oy * n * w + ox * n) * spp + k]);
                        continue;
                    }
                    let mut sum = 0i128;
                    let mut cnt = 0i128;
                    for y in oy * n..((oy + 1) * n).min(h) {
                        for x in ox * n..((ox + 1) * n).min(w) {
                            sum += i128::from(frame[(y * w + x) * spp + k]);
                            cnt += 1;
                        }
                    }
                    // floor(sum / cnt + 1/2) = floor((2·sum + cnt) / (2·cnt)).
                    out.push((2 * sum + cnt).div_euclid(2 * cnt) as i64);
                }
            }
        }
    }
    out
}

#[test]
fn scaled_matches_full_decode_downsampled() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../codec-corpus/formats");
    let only = std::env::var("SCALED_FORMATS").ok();
    let Ok(formats) = fs::read_dir(&root) else {
        eprintln!("no corpus at {root:?}");
        return;
    };
    let mut formats: Vec<_> = formats.flatten().map(|e| e.path()).collect();
    formats.sort();
    let (mut files, mut codec_path, mut failures) = (0, 0, Vec::new());
    for fmt in formats {
        let name = fmt.file_name().unwrap().to_string_lossy().to_string();
        if only.as_ref().is_some_and(|o| !o.split(',').any(|x| x == name)) {
            continue;
        }
        let Ok(samples) = fs::read_dir(fmt.join("samples")) else { continue };
        let mut paths: Vec<_> = samples.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "dcm")).collect();
        paths.sort();
        for p in paths {
            let bytes = fs::read(&p).unwrap();
            let case = p.file_stem().unwrap().to_string_lossy().to_string();
            let full = decode_file(&bytes);
            for s in 1..=3u8 {
                let scaled = decode_file_scaled(&bytes, s);
                let (full, scaled) = match (&full, scaled) {
                    (Err(a), Err(b)) => {
                        if a.exit_code() != b.exit_code() {
                            failures.push(format!("{name}/{case} 1/{}: full {a}, scaled {b}", 1 << s));
                        }
                        continue;
                    }
                    (Ok(f), Ok(sc)) => (f, sc),
                    (a, b) => {
                        failures.push(format!("{name}/{case} 1/{}: full {:?} but scaled {:?}", 1 << s, a.as_ref().err(), b.err()));
                        continue;
                    }
                };
                let n = 1u32 << s;
                if (scaled.rows, scaled.columns, scaled.frames) != (full.rows.div_ceil(n), full.columns.div_ceil(n), full.frames)
                    || scaled.samples_per_pixel != full.samples_per_pixel
                    || scaled.bits_allocated != full.bits_allocated
                    || scaled.photometric != full.photometric
                {
                    failures.push(format!("{name}/{case} 1/{n}: shape or photometric differs"));
                    continue;
                }
                let want = reference(full, s);
                let got: Vec<i64> = scaled.data.chunks_exact(scaled.bytes_per_sample()).map(|b| sample(b, scaled.signed)).collect();
                if got.len() != want.len() {
                    failures.push(format!("{name}/{case} 1/{n}: {} samples, expected {}", got.len(), want.len()));
                    continue;
                }
                let reduced = scaled_codec_for(&full.transfer_syntax).is_some() && full.photometric != "PALETTE COLOR";
                let wavelet = matches!(
                    full.transfer_syntax.as_str(),
                    "1.2.840.10008.1.2.4.90" | "1.2.840.10008.1.2.4.91" | "1.2.840.10008.1.2.4.201" | "1.2.840.10008.1.2.4.202" | "1.2.840.10008.1.2.4.203"
                );
                if reduced && wavelet {
                    let mean = got.iter().zip(&want).map(|(a, b)| (a - b).abs() as f64).sum::<f64>() / got.len() as f64;
                    if s == 3 {
                        eprintln!("note {name}/{case} 1/{n}: wavelet reduction, mean |diff| {mean:.2} from the box downsample");
                    }
                    if s == 1 {
                        codec_path += 1;
                    }
                } else if reduced {
                    // The codec's own reduced decode: close to the box downsample, not equal
                    // (colour more so: chroma is upsampled or not at a different stage). A sanity
                    // bound against gross errors (channel order, offsets); exactness is checked
                    // against libjpeg-turbo at codec level.
                    let mean = got.iter().zip(&want).map(|(a, b)| (a - b).abs() as f64).sum::<f64>() / got.len() as f64;
                    let range = (1i64 << full.bits_stored.min(16)) as f64;
                    let bound = if full.samples_per_pixel == 1 { range / 64.0 } else { range / 8.0 };
                    if mean > bound {
                        failures.push(format!("{name}/{case} 1/{n}: mean |diff| {mean:.2} from the box downsample"));
                    }
                    if s == 1 {
                        codec_path += 1;
                    }
                } else if let Some(i) = got.iter().zip(&want).position(|(a, b)| a != b) {
                    failures.push(format!("{name}/{case} 1/{n}: sample {i} is {} but the box downsample is {}", got[i], want[i]));
                }
            }
            files += 1;
        }
    }
    eprintln!("{files} files, {codec_path} through a codec's reduced decode");
    assert!(failures.is_empty(), "{} failing:\n{}", failures.len(), failures.join("\n"));
}
