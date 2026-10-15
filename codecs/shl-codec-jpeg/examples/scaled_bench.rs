//! Thumbnail cost: full decode followed by a box downsample, against `decode_frame_scaled`, for
//! one case dumped by extract_frames.py (frame 0). Prints the minimum and median per decode over
//! `reps` runs at each scale.
//! Usage: cargo run --release --example scaled_bench -- <frames/CASE dir> [reps]
use shl_codec_common::{FrameInfo, Photometric};
use std::{env, fs, path::Path, time::Instant};

fn field(text: &str, key: &str) -> String {
    let pat = format!("\"{key}\":");
    let rest = text[text.find(&pat).expect(key) + pat.len()..].trim_start();
    match rest.strip_prefix('"') {
        Some(r) => r[..r.find('"').unwrap()].to_string(),
        None => rest[..rest.find([',', '\n', '}']).unwrap()].trim().to_string(),
    }
}

/// Mean over each n×n block (partial blocks over the samples they have), interleaved samples,
/// 1 or 2 bytes each: rows summed column-wise (a loop LLVM vectorises), then each block's columns.
fn box_downsample(data: &[u8], w: usize, h: usize, spp: usize, bps: usize, n: usize) -> Vec<u8> {
    let (ow, oh) = (w.div_ceil(n), h.div_ceil(n));
    let rw = w * spp;
    let mut out = vec![0u8; ow * oh * spp * bps];
    let mut col = vec![0u32; rw];
    let mut row16 = vec![0u16; if bps == 2 { rw } else { 0 }];
    for oy in 0..oh {
        col.fill(0);
        let y1 = ((oy + 1) * n).min(h);
        for y in oy * n..y1 {
            let src = &data[y * rw * bps..(y + 1) * rw * bps];
            if bps == 1 {
                for (c, &v) in col.iter_mut().zip(src) {
                    *c += u32::from(v);
                }
            } else {
                for (d, b) in row16.iter_mut().zip(src.chunks_exact(2)) {
                    *d = u16::from_le_bytes([b[0], b[1]]);
                }
                for (c, &v) in col.iter_mut().zip(&row16) {
                    *c += u32::from(v);
                }
            }
        }
        let rows = (y1 - oy * n) as u32;
        for ox in 0..ow {
            let x1 = ((ox + 1) * n).min(w);
            let cnt = rows * (x1 - ox * n) as u32;
            for c in 0..spp {
                let sum: u32 = col[ox * n * spp + c..x1 * spp].iter().step_by(spp).sum();
                let v = (sum + cnt / 2) / cnt;
                let i = (oy * ow + ox) * spp + c;
                if bps == 1 {
                    out[i] = v as u8;
                } else {
                    out[2 * i..2 * i + 2].copy_from_slice(&(v as u16).to_le_bytes());
                }
            }
        }
    }
    out
}

fn time(reps: usize, mut f: impl FnMut() -> usize) -> (f64, f64) {
    let mut t: Vec<f64> = (0..reps)
        .map(|_| {
            let s = Instant::now();
            std::hint::black_box(f());
            s.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    t.sort_by(|a, b| a.partial_cmp(b).unwrap());
    (t[0], t[reps / 2])
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let dir = Path::new(&args[1]);
    let reps: usize = args.get(2).map(|s| s.parse().unwrap()).unwrap_or(20);
    let text = fs::read_to_string(dir.join("info.json")).unwrap();
    let n = |k: &str| field(&text, k).parse::<u32>().unwrap();
    let info = FrameInfo {
        rows: n("rows"),
        columns: n("columns"),
        samples_per_pixel: n("samples_per_pixel") as u16,
        bits_allocated: n("bits_allocated") as u16,
        bits_stored: n("bits_stored") as u16,
        pixel_representation: n("pixel_representation") as u16,
        photometric: Photometric::parse(&field(&text, "photometric")),
        planar_configuration: n("planar_configuration") as u16,
        transfer_syntax: field(&text, "transfer_syntax"),
    };
    let cs = fs::read(dir.join("frame-0.bin")).unwrap();
    // `<dir> <reps> loop S`: only the scaled decode at 1/2^S, for profiling.
    if args.get(3).map(String::as_str) == Some("loop") {
        let s: u8 = args[4].parse().unwrap();
        let t = time(reps, || shl_codec_jpeg::decode_frame_scaled(&cs, &info, s).unwrap().frame.data.len());
        println!("scaled 1/{}: min {:.3} median {:.3} ms", 1 << s, t.0, t.1);
        return;
    }
    let (w, h, spp, bps) = (info.columns as usize, info.rows as usize, usize::from(info.samples_per_pixel), info.bytes_per_sample());
    println!("{} ({w}x{h}, {spp} samples, {} bytes each)", dir.file_name().unwrap().to_string_lossy(), bps);
    let full = time(reps, || shl_codec_jpeg::decode_frame(&cs, &info).unwrap().data.len());
    println!("  full decode                        min {:8.3} ms  median {:8.3} ms", full.0, full.1);
    let d = shl_codec_jpeg::decode_frame(&cs, &info).unwrap();
    let ds = time(reps, || box_downsample(&d.data, w, h, spp, bps, 8).len());
    println!("  box downsample 1/8 alone           min {:8.3} ms  median {:8.3} ms", ds.0, ds.1);
    for s in 1..=3u8 {
        let k = 1usize << s;
        let fb = time(reps, || {
            let d = shl_codec_jpeg::decode_frame(&cs, &info).unwrap();
            box_downsample(&d.data, w, h, spp, bps, k).len()
        });
        let sc = time(reps, || shl_codec_jpeg::decode_frame_scaled(&cs, &info, s).unwrap().frame.data.len());
        println!(
            "  1/{k}: full + box  min {:8.3} median {:8.3} ms | scaled  min {:8.3} median {:8.3} ms | {:.1}x",
            fb.0,
            fb.1,
            sc.0,
            sc.1,
            fb.1 / sc.1
        );
    }
}
