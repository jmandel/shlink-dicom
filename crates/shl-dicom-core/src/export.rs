use std::io::{Cursor, Write};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
use crate::{bundle::SeriesSummary, Error, Result};

/// Slices a decrypted series plaintext buffer into `(filename, dicom_bytes)` pairs
/// using only the `instance.offset` and `instance.length` fields from the Bundle.
pub fn split_series_instances<'a>(
    series_plaintext: &'a [u8],
    series: &SeriesSummary,
) -> Result<Vec<(String, &'a [u8])>> {
    if series_plaintext.len() as u64 != series.plaintext_length {
        return Err(Error::InvalidBundle(format!(
            "series plaintext length mismatch: expected {}, got {}",
            series.plaintext_length,
            series_plaintext.len()
        )));
    }

    let folder = match (series.number, series.description.as_deref()) {
        (Some(n), Some(d)) => format!("series_{:03}_{}", n, sanitize_filename(d)),
        (Some(n), None) => format!("series_{:03}", n),
        (None, Some(d)) => format!("series_{}", sanitize_filename(d)),
        (None, None) => format!("series_{}", sanitize_filename(&series.file_id)),
    };

    let mut out = Vec::with_capacity(series.instances.len());
    for (idx, inst) in series.instances.iter().enumerate() {
        let start = inst.offset as usize;
        let end = (inst.offset + inst.length) as usize;
        if end > series_plaintext.len() {
            return Err(Error::InvalidBundle(format!(
                "instance {} exceeds series plaintext bounds",
                inst.uid
            )));
        }
        let num = inst.number.unwrap_or((idx + 1) as i32);
        let filename = format!("{folder}/IM_{num:04}.dcm");
        out.push((filename, &series_plaintext[start..end]));
    }

    Ok(out)
}

/// Builds an uncompressed (Stored) ZIP archive from `(path, bytes)` slices.
pub fn build_uncompressed_zip(files: &[(String, &[u8])]) -> Result<Vec<u8>> {
    let buf = Vec::new();
    let mut zip = ZipWriter::new(Cursor::new(buf));
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .large_file(false);

    for (name, data) in files {
        zip.start_file(name, options)
            .map_err(|e| Error::Dicom(format!("zip start_file {name}: {e}")))?;
        zip.write_all(data)
            .map_err(|e| Error::Dicom(format!("zip write {name}: {e}")))?;
    }

    let cursor = zip
        .finish()
        .map_err(|e| Error::Dicom(format!("zip finish: {e}")))?;
    Ok(cursor.into_inner())
}

fn sanitize_filename(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        } else if c.is_whitespace() && !out.ends_with('_') {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_');
    if trimmed.is_empty() {
        "dicom".to_string()
    } else {
        trimmed.to_string()
    }
}
