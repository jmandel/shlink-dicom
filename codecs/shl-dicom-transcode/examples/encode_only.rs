//! `encode_only DIR`: time the JPEG 2000 and SV1 encoders alone (no parsing, no self-check) on
//! the decoded pixels of every 16-bit or 8-bit monochrome or RGB file under DIR.
fn files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            files(&p, out);
        } else {
            out.push(p);
        }
    }
}

fn main() {
    let dir = std::path::PathBuf::from(std::env::args().nth(1).unwrap_or_else(|| ".".into()));
    let mut paths = Vec::new();
    files(&dir, &mut paths);
    paths.sort();
    let mut frames = Vec::new();
    for p in &paths {
        let Ok(b) = std::fs::read(p) else { continue };
        let Ok(c) = shl_dicom_decode::decode_file(&b) else { continue };
        if c.bits_allocated != 16 && c.bits_allocated != 8 || c.float {
            continue;
        }
        let fb = c.data.len() / c.frames.max(1) as usize;
        for f in c.data.chunks_exact(fb.max(1)) {
            let s: Vec<i32> = if c.bits_allocated == 8 {
                f.iter().map(|&v| i32::from(v)).collect()
            } else if c.signed {
                f.chunks_exact(2).map(|v| i32::from(i16::from_le_bytes([v[0], v[1]]))).collect()
            } else {
                f.chunks_exact(2).map(|v| i32::from(u16::from_le_bytes([v[0], v[1]]))).collect()
            };
            let p = c.bits_stored.max(if c.bits_allocated == 16 { 9 } else { 2 }) as u8;
            let mask = (1i32 << p) - 1;
            let s: Vec<i32> = if c.signed { s } else { s.into_iter().map(|v| v & mask).collect() };
            frames.push((s, c.columns, c.rows, c.samples_per_pixel, p, c.signed, f.len()));
        }
    }
    let bytes: usize = frames.iter().map(|f| f.6).sum();
    let t0 = std::time::Instant::now();
    let mut out = 0usize;
    for (s, w, h, n, p, signed, _) in &frames {
        out += shl_codec_jpeg2000_encode::encode_lossless(s, *w, *h, *n, *p, *signed).map_or(0, |v| v.len());
    }
    let t = t0.elapsed().as_secs_f64();
    println!("JPEG 2000: {} frames, {:.1} MB -> {:.1} MB, {:.2} s, {:.1} MB/s", frames.len(), bytes as f64 / 1e6, out as f64 / 1e6, t, bytes as f64 / 1e6 / t);
    let t0 = std::time::Instant::now();
    let mut out = 0usize;
    for (s, w, h, n, p, signed, _) in &frames {
        let m = (1i32 << p) - 1;
        let u: Vec<u16> = s.iter().map(|&v| (v & m) as u16).collect();
        let _ = signed;
        out += shl_codec_jpeg::encode_lossless_sv1(&u, *w, *h, *n as u8, *p).map_or(0, |v| v.len());
    }
    let t = t0.elapsed().as_secs_f64();
    println!("SV1:       {} frames, {:.1} MB -> {:.1} MB, {:.2} s, {:.1} MB/s", frames.len(), bytes as f64 / 1e6, out as f64 / 1e6, t, bytes as f64 / 1e6 / t);
}
