//! `hashes DIR [TS]`: print {"relative/path": "<sha256 of the output>" | "declined: <reason>"} for
//! every file under DIR, as JSON. The wasm test (shl-dicom-transcode-wasm/test/bench-chromium.mjs)
//! checks that the browser build writes the same bytes.
use sha2::{Digest, Sha256};

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
    let ts = std::env::args().nth(2).unwrap_or_else(|| shl_dicom_transcode::JPEG_LOSSLESS_SV1.to_string());
    let mut paths = Vec::new();
    files(&dir, &mut paths);
    paths.sort();
    let mut entries = Vec::new();
    for p in &paths {
        let Ok(bytes) = std::fs::read(p) else { continue };
        let v = match shl_dicom_transcode::transcode_part10(&bytes, &ts) {
            Ok(out) => Sha256::digest(&out).iter().map(|b| format!("{b:02x}")).collect::<String>(),
            Err(e) => format!("declined: {e}"),
        };
        let rel = p.strip_prefix(&dir).unwrap_or(p).to_string_lossy().replace('\\', "/");
        entries.push(format!("{:?}: {:?}", rel, v));
    }
    println!("{{{}}}", entries.join(",\n"));
}
