//! Differential check against the vendored hayro decoder: decode each codestream with both
//! and compare the component planes (before the DC level shift).
//! Usage: diff [--reduce N] [--time] FILE...
use std::time::Instant;

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut reduce = 0u8;
    let mut time = false;
    if let Some(i) = args.iter().position(|a| a == "--reduce") {
        reduce = args[i + 1].parse().unwrap();
        args.drain(i..i + 2);
    }
    if let Some(i) = args.iter().position(|a| a == "--time") {
        time = true;
        args.remove(i);
    }
    let (mut same, mut differ, mut both_err, mut only_new_err, mut only_old_err) = (0, 0, 0, 0, 0);
    let (mut t_old, mut t_new) = (0f64, 0f64);
    for path in &args {
        let data = std::fs::read(path).unwrap();
        let name = std::path::Path::new(path).file_name().unwrap().to_string_lossy().to_string();
        let t = Instant::now();
        let old = hayro(&data, reduce);
        let to = t.elapsed().as_secs_f64();
        let t = Instant::now();
        let new = shl_jpeg2000::decode(&data, &shl_jpeg2000::Options { reduce });
        let tn = t.elapsed().as_secs_f64();
        match (&old, &new) {
            (Err(e1), Err(e2)) => {
                both_err += 1;
                println!("BOTHERR {name}: old {e1} | new {e2}");
            }
            (Ok(_), Err(e)) => {
                only_new_err += 1;
                println!("NEWERR {name}: {e}");
            }
            (Err(e), Ok(_)) => {
                only_old_err += 1;
                println!("OLDERR {name}: {e}");
            }
            (Ok((w, _h, planes)), Ok(img)) => {
                t_old += to;
                t_new += tn;
                let mut max = 0f32;
                let mut count = 0usize;
                let mut lossless = true;
                if planes.len() != img.components.len() {
                    println!("NCOMP {name}: old {} new {}", planes.len(), img.components.len());
                    differ += 1;
                    continue;
                }
                if std::env::var("DUMP").is_ok() {
                    for (p, c) in planes.iter().zip(&img.components) {
                        let v: Vec<f32> = match &c.plane {
                            shl_jpeg2000::Plane::Int(v) => v[..8].iter().map(|&x| x as f32).collect(),
                            shl_jpeg2000::Plane::Float(v) => v[..8].to_vec(),
                        };
                        println!("old {:?}\nnew {:?}", &p[..8], v);
                    }
                }
                for (p, c) in planes.iter().zip(&img.components) {
                    let vals: Vec<f32> = match &c.plane {
                        shl_jpeg2000::Plane::Int(v) => v.iter().map(|&x| x as f32).collect(),
                        shl_jpeg2000::Plane::Float(v) => {
                            lossless = false;
                            v.clone()
                        }
                    };
                    for cy in 0..c.height as usize {
                        for cx in 0..c.width as usize {
                            let a = p[cy * c.dy as usize * w + cx * c.dx as usize];
                            let b = vals[cy * c.width as usize + cx];
                            let d = (a - b).abs();
                            if !(d == 0.0) {
                                count += 1;
                                if d > max || d.is_nan() {
                                    max = d;
                                }
                            }
                        }
                    }
                }
                if count == 0 {
                    same += 1;
                    if time {
                        println!("SAME {name} old {:.1} ms new {:.1} ms", to * 1e3, tn * 1e3);
                    }
                } else {
                    differ += 1;
                    println!("DIFF {name}: {} samples differ, max {max} ({})", count, if lossless { "int" } else { "float" });
                }
            }
        }
    }
    println!("same {same} differ {differ} both_err {both_err} only_new_err {only_new_err} only_old_err {only_old_err}; time old {:.0} ms new {:.0} ms", t_old * 1e3, t_new * 1e3);
}

fn hayro(data: &[u8], reduce: u8) -> Result<(usize, usize, Vec<Vec<f32>>), String> {
    use hayro_jpeg2000::{DecodeSettings, DecoderContext, Image};
    let settings = DecodeSettings {
        resolve_palette_indices: false,
        strict: false,
        target_resolution: None,
        high_throughput: true,
        defer_level_shift: true,
        reduce: (reduce > 0).then_some(reduce),
    };
    let image = Image::new(data, &settings).map_err(|e| e.to_string())?;
    let (w, h) = (image.width() as usize, image.height() as usize);
    let mut ctx = DecoderContext::default();
    let d = image.decode(&mut ctx).map_err(|e| e.to_string())?;
    Ok((w, h, d.components().iter().map(|c| c.samples()[..w * h].to_vec()).collect()))
}
