//! Decode every frame dumped by `extract_frames.py --format rle` and compare with the oracle.
//! The codec returns planar, Bits-Allocated-wide data; this test applies the CLI's normalisation
//! (interleave, mask or sign-extend to Bits Stored) before comparing. YBR cases are decoded but
//! not compared: the oracle is RGB and the YBR -> RGB conversion is the CLI's job, so they are
//! checked by `check.py` instead.

mod common;

use shl_codec_common::{FrameInfo, Photometric};
use shl_codec_rle::decode_frame;

fn read_sample(b: &[u8], bps: usize) -> u32 {
    let mut v = 0u32;
    for (i, &x) in b[..bps].iter().enumerate() {
        v |= u32::from(x) << (8 * i);
    }
    v
}

/// Interleave planar samples and normalise each to Bits Stored; returns canonical LE bytes.
fn canonical(planar: &[u8], info: &FrameInfo) -> Vec<u8> {
    let bps = info.bytes_per_sample();
    let spp = usize::from(info.samples_per_pixel);
    let plane = info.rows as usize * info.columns as usize;
    let bits_alloc = u32::from(info.bits_allocated);
    let bits = u32::from(info.bits_stored);
    let mut out = Vec::with_capacity(planar.len());
    for p in 0..plane {
        for s in 0..spp {
            let off = (s * plane + p) * bps;
            let mut v = read_sample(&planar[off..], bps);
            if bits < bits_alloc {
                let mask = (1u32 << bits) - 1;
                v &= mask;
                if info.pixel_representation == 1 && v & (1 << (bits - 1)) != 0 {
                    v |= !mask;
                }
            }
            out.extend_from_slice(&v.to_le_bytes()[..bps]);
        }
    }
    out
}

fn is_ybr(p: Photometric) -> bool {
    matches!(
        p,
        Photometric::YbrFull
            | Photometric::YbrFull422
            | Photometric::YbrPartial420
            | Photometric::YbrPartial422
            | Photometric::YbrIct
            | Photometric::YbrRct
    )
}

#[test]
fn corpus_frames_match_oracle() {
    let cases = common::load_cases();
    if cases.is_empty() {
        eprintln!(
            "no frames in {:?}; run `uv run python scripts/extract_frames.py --format rle` in codec-corpus",
            common::frames_dir()
        );
        return;
    }
    let mut failures = Vec::new();
    let mut frames_checked = 0;
    let mut ybr_decoded = 0;
    for case in &cases {
        let (descr, shape, oracle) = common::read_npy(&case.oracle);
        let width: usize = descr[2..].parse().unwrap();
        assert_eq!(width, case.info.bytes_per_sample(), "{}: oracle dtype {descr}", case.name);
        assert_eq!(shape[0], case.frames.len(), "{}: frame count", case.name);
        let fbytes = case.info.frame_bytes().unwrap();
        assert_eq!(oracle.len(), fbytes * case.frames.len(), "{}: oracle size", case.name);
        for (k, cs) in case.frames.iter().enumerate() {
            let result = decode_frame(cs, &case.info);
            if case.expect == "error" {
                if result.is_ok() {
                    failures.push(format!("{} frame {k}: decoded, expected error", case.name));
                }
                continue;
            }
            match result {
                Err(e) => failures.push(format!("{} frame {k}: {e}", case.name)),
                Ok(_) if is_ybr(case.info.photometric) => ybr_decoded += 1,
                Ok(d) => {
                    assert!(d.planar);
                    let got = canonical(&d.data, &case.info);
                    let want = &oracle[k * fbytes..(k + 1) * fbytes];
                    if got != want {
                        let first = got.iter().zip(want).position(|(a, b)| a != b);
                        failures.push(format!("{} frame {k}: mismatch at byte {first:?}", case.name));
                    }
                }
            }
            frames_checked += 1;
        }
    }
    eprintln!(
        "{} cases, {frames_checked} frames decoded, {ybr_decoded} of them YBR (decoded, not compared)",
        cases.len()
    );
    assert!(failures.is_empty(), "failures:\n{}", failures.join("\n"));
}
