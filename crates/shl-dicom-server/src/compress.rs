//! Lossless compression of the sample at seed time (spec/README.md §11.1), with the Share page's
//! rule (`shl_dicom_transcode::is_uncompressed_image`): uncompressed images are re-encoded as JPEG
//! Lossless SV1 by `shl-dicom-transcode`, which checks its own output bit for bit; everything else,
//! and any image the encoder declines, is kept as it is.
use std::{
    collections::BTreeMap,
    fs::File,
    io::BufReader,
    path::{Path, PathBuf},
};

use shl_dicom_transcode::is_uncompressed_image;

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
                std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
                // unpack_in refuses a member whose path leaves `base` (`..`, or absolute).
                if !entry.unpack_in(&base).map_err(|e| e.to_string())? {
                    return Err(format!("{}: {} is outside the archive", input.display(), rel.display()));
                }
                compress_if_image(&base.join(rel.strip_prefix("/").unwrap_or(&rel)), &mut stats)?;
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
    // As the seed does: a bare data set is wrapped in Part 10 in place.
    let Ok(h) = shl_dicom_core::dicom_io::parse_dicom_file_header(&name, path) else {
        return Ok(());
    };
    let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if is_uncompressed_image(&h.transfer_syntax_uid, &h.sop_class_uid, len) {
        compress_file(path, stats)?;
    }
    Ok(())
}
