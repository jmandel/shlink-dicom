//! Lossless compression of the sample at seed time (spec/README.md §11.1), with the same rules as the
//! Share page (web/share/lib/compress.ts): uncompressed images are re-encoded as JPEG Lossless SV1
//! by `shl-dicom-transcode`, which checks its own output bit for bit; everything else, and any image
//! the encoder declines, is kept as it is.
use std::{
    collections::BTreeMap,
    fs::File,
    io::BufReader,
    path::{Path, PathBuf},
};

/// Uncompressed transfer syntaxes the encoder takes: implicit and explicit VR little endian.
const NATIVE: [&str; 2] = ["1.2.840.10008.1.2", "1.2.840.10008.1.2.1"];

/// SOP classes without pixel data to compress: SR, PDF and CDA, KO, presentation states,
/// waveforms, raw data, RT plans and structures.
const NOT_IMAGES: [&str; 9] = [
    "1.2.840.10008.5.1.4.1.1.88.",
    "1.2.840.10008.5.1.4.1.1.104.",
    "1.2.840.10008.5.1.4.1.1.11.",
    "1.2.840.10008.5.1.4.1.1.9.",
    "1.2.840.10008.5.1.4.1.1.66",
    "1.2.840.10008.5.1.4.1.1.481.3",
    "1.2.840.10008.5.1.4.1.1.481.4",
    "1.2.840.10008.5.1.4.1.1.481.5",
    "1.2.840.10008.5.1.4.1.1.481.8",
];

/// Instances larger than this are kept as they are (encoding takes about 3–4 times the input).
const MAX_INSTANCE: u64 = 256 << 20;

/// Whether an instance is an uncompressed image the encoder may take.
pub fn is_uncompressed_image(transfer_syntax: &str, sop_class: &str, len: u64) -> bool {
    NATIVE.contains(&transfer_syntax) && !NOT_IMAGES.iter().any(|p| sop_class.starts_with(p)) && len <= MAX_INSTANCE
}

/// What compression did: images tried, re-encoded, and their bytes before and after.
#[derive(Default, Debug, Clone)]
pub struct CompressStats {
    pub images: usize,
    pub compressed: usize,
    pub bytes_before: u64,
    pub bytes_after: u64,
    pub declined: BTreeMap<String, usize>,
}

/// Re-encodes the file at `path` in place when the encoder takes it. Returns the file's length.
pub fn compress_file(path: &Path, stats: &mut CompressStats) -> Result<u64, String> {
    let input = std::fs::read(path).map_err(|e| e.to_string())?;
    stats.images += 1;
    stats.bytes_before += input.len() as u64;
    match shl_dicom_transcode::transcode_part10_sv1(&input) {
        Ok(out) => {
            std::fs::write(path, &out).map_err(|e| e.to_string())?;
            stats.compressed += 1;
            stats.bytes_after += out.len() as u64;
            Ok(out.len() as u64)
        }
        Err(d) => {
            *stats.declined.entry(d.0).or_default() += 1;
            stats.bytes_after += input.len() as u64;
            Ok(input.len() as u64)
        }
    }
}

/// Copies every file of `inputs` (files, folders, and the members of `.tgz` archives) under `out`,
/// re-encoding the uncompressed images on the way.
pub fn compress_tree(inputs: &[PathBuf], out: &Path) -> Result<CompressStats, String> {
    let mut stats = CompressStats::default();
    for input in inputs {
        let base = out.join(input.file_name().unwrap_or_default());
        if input.extension().is_some_and(|x| x == "tgz") {
            let gz = flate2::read::GzDecoder::new(BufReader::new(File::open(input).map_err(|e| e.to_string())?));
            let mut ar = tar::Archive::new(gz);
            for entry in ar.entries().map_err(|e| e.to_string())? {
                let mut entry = entry.map_err(|e| e.to_string())?;
                if !entry.header().entry_type().is_file() {
                    continue;
                }
                let rel = entry.path().map_err(|e| e.to_string())?.to_path_buf();
                let dest = base.join(rel);
                std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
                entry.unpack(&dest).map_err(|e| e.to_string())?;
                compress_if_image(&dest, &mut stats)?;
            }
        } else {
            for f in walk(input) {
                let dest = if input.is_dir() { base.join(f.strip_prefix(input).unwrap()) } else { base.clone() };
                std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
                std::fs::copy(&f, &dest).map_err(|e| e.to_string())?;
                compress_if_image(&dest, &mut stats)?;
            }
        }
    }
    Ok(stats)
}

fn walk(p: &Path) -> Vec<PathBuf> {
    if !p.is_dir() {
        return vec![p.to_path_buf()];
    }
    let mut v: Vec<PathBuf> = std::fs::read_dir(p).map(|d| d.flatten().map(|e| e.path()).collect()).unwrap_or_default();
    v.sort();
    v.iter().flat_map(|x| walk(x)).collect()
}

fn compress_if_image(path: &Path, stats: &mut CompressStats) -> Result<(), String> {
    let name = path.to_string_lossy().to_string();
    let Ok(f) = File::open(path) else { return Ok(()) };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let Ok(Some(h)) = shl_dicom_core::dicom_io::parse_dicom_header_reader(&name, BufReader::with_capacity(64 << 10, f)) else {
        return Ok(());
    };
    if is_uncompressed_image(&h.transfer_syntax_uid, &h.sop_class_uid, len) {
        compress_file(path, stats)?;
    }
    Ok(())
}
