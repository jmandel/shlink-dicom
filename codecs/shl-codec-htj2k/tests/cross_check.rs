//! Every HTJ2K corpus frame decoded by this crate and by the vendored oxideav-jpeg2000 (the
//! decoder it replaced) must give byte-identical output (lossless) or differ by at most 1
//! (lossy). Frames come from codec-corpus `scripts/extract_frames.py`; the test skips with a
//! note when they are not there.
use std::path::PathBuf;

use shl_codec_common::{DecodeError, DecodedFrame, FrameInfo, Photometric, Result};
use shl_codec_jpeg2000::prep;

fn field<'a>(json: &'a str, key: &str) -> Option<&'a str> {
    let k = format!("\"{key}\":");
    let rest = json[json.find(&k)? + k.len()..].trim_start().trim_start_matches('"');
    rest.split(['"', ',', '}', '\n']).next().map(str::trim)
}

fn info(json: &str) -> FrameInfo {
    let n = |k: &str| field(json, k).and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
    FrameInfo {
        rows: n("rows"),
        columns: n("columns"),
        samples_per_pixel: n("samples_per_pixel") as u16,
        bits_allocated: n("bits_allocated") as u16,
        bits_stored: n("bits_stored") as u16,
        pixel_representation: n("pixel_representation") as u16,
        photometric: Photometric::parse(field(json, "photometric").unwrap_or("")),
        planar_configuration: n("planar_configuration") as u16,
        transfer_syntax: field(json, "transfer_syntax").unwrap_or("").to_string(),
    }
}

/// Decode with oxideav, packed as the wrapper packs.
fn decode_oxideav(codestream: &[u8], info: &FrameInfo) -> Result<DecodedFrame> {
    let prep = prep::prepare(codestream, info)?;
    let image = oxideav_jpeg2000::decode_j2k(prep.codestream).map_err(|e| DecodeError::Invalid(format!("{e}")))?;
    if image.width != info.columns || image.height != info.rows || image.components.len() != prep.header.components.len() {
        return Err(DecodeError::Invalid("oxideav output disagrees with SIZ".into()));
    }
    let planes: Vec<(&[i32], usize)> = image.components.iter().map(|c| (c.samples.as_slice(), c.width as usize)).collect();
    prep::pack(info, &prep, |c, cx, cy| {
        let (plane, cw) = planes[c];
        plane[cy * cw + cx]
    })
}

/// Decode every frame under `dir` both ways; returns (frames, frames this crate declined).
pub fn cross_check(dir: &std::path::Path) -> (usize, Vec<String>, i64) {
    let (mut frames, mut declined, mut lossy_max) = (0, Vec::new(), 0);
    let mut cases: Vec<_> = std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).collect();
    cases.sort();
    for case in cases {
        let Ok(json) = std::fs::read_to_string(case.join("info.json")) else { continue };
        let fi = info(&json);
        let mut k = 0;
        while let Ok(cs) = std::fs::read(case.join(format!("frame-{k}.bin"))) {
            let name = format!("{}/frame-{k}", case.file_name().unwrap().to_string_lossy());
            let ox = decode_oxideav(&cs, &fi);
            match shl_codec_htj2k::decode_frame(&cs, &fi) {
                Ok(h) => {
                    let ox = ox.unwrap_or_else(|e| panic!("{name}: we decode, oxideav fails: {e:?}"));
                    assert_eq!(h.data.len(), ox.data.len(), "{name}");
                    let diff = max_diff(&h.data, &ox.data, &fi);
                    if fi.transfer_syntax.ends_with(".203") {
                        // Lossy (9/7): our f32 and oxideav's f64 wavelets may round a
                        // sample differently; the oracle tolerance for these cases is 1.
                        lossy_max = lossy_max.max(diff);
                        assert!(diff <= 1, "{name}: lossy samples differ by {diff}");
                    } else {
                        assert_eq!(diff, 0, "{name}: lossless samples differ");
                    }
                    assert_eq!(format!("{:?}", h.color), format!("{:?}", ox.color), "{name}");
                }
                Err(e) => declined.push(format!("{name}: {e:?}")),
            }
            frames += 1;
            k += 1;
        }
    }
    (frames, declined, lossy_max)
}

/// Largest per-sample difference, reading samples at the frame's width and signedness.
fn max_diff(a: &[u8], b: &[u8], fi: &FrameInfo) -> i64 {
    let bps = fi.bytes_per_sample();
    let signed = fi.pixel_representation == 1;
    let val = |s: &[u8]| -> i64 {
        match (bps, signed) {
            (1, false) => i64::from(s[0]),
            (1, true) => i64::from(s[0] as i8),
            (2, false) => i64::from(u16::from_le_bytes([s[0], s[1]])),
            (2, true) => i64::from(i16::from_le_bytes([s[0], s[1]])),
            _ => i64::from(i32::from_le_bytes([s[0], s[1], s[2], s[3]])),
        }
    };
    a.chunks_exact(bps).zip(b.chunks_exact(bps)).map(|(x, y)| (val(x) - val(y)).abs()).max().unwrap_or(0)
}

#[test]
fn matches_oxideav_on_every_corpus_frame() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../codec-corpus/formats/htj2k/frames");
    if !dir.is_dir() {
        eprintln!("skipping: {} not found (run codec-corpus/scripts/extract_frames.py)", dir.display());
        return;
    }
    let (frames, declined, lossy_max) = cross_check(&dir);
    eprintln!(
        "{frames} frames cross-checked (lossless identical, lossy max |diff| {lossy_max}); declined {}: {declined:#?}",
        declined.len()
    );
    assert!(frames > 0);
    assert!(declined.is_empty(), "declined: {declined:#?}");
}

/// Extra frame directories (same layout) named in `HTJ2K_CROSS_CHECK_DIRS`, colon-separated:
/// for streams outside the corpus. Declined frames are listed.
#[test]
fn extra_dirs() {
    let Ok(dirs) = std::env::var("HTJ2K_CROSS_CHECK_DIRS") else { return };
    for dir in dirs.split(':').filter(|d| !d.is_empty()) {
        let (frames, declined, lossy_max) = cross_check(std::path::Path::new(dir));
        eprintln!("{dir}: {frames} frames (lossy max |diff| {lossy_max}); declined {}: {declined:#?}", declined.len());
    }
}
