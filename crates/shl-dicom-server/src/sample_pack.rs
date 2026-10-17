//! Packs the server's sample (`samples/*.tgz`) into a share's study files on disk, holding at most
//! one record and one header in memory: each archive member is written to a scratch file while its
//! header is read, then every study is encrypted record by record (spec/README.md §9.2, §11.1: one
//! file per study, its series in order) from those files into a staged file, which goes into the blob store.
//! As the Share page does by default, uncompressed images are re-encoded without loss first
//! (compress.rs), and encapsulated multi-frame instances that lack a frame offset table get one
//! (`shl_dicom_core::offset_tables`, fragment bytes unchanged); every other instance is kept byte
//! for byte. Files that are not DICOM instances are reported with the reason, never dropped silently.
use std::{
    fs::File,
    io::{BufReader, BufWriter, Write},
    path::{Path, PathBuf},
};
use shl_dicom_core::{
    bundle::{build_fhir_bundle, BundleBuildInput, LinkedFileInput},
    crypto::{b64url_encode, encrypt_file_stream, random_bytes, ReadChain},
    dicom_io::{parse_dicom_file_header, ParsedDicomInstance, Skipped},
    offset_tables::add_offset_table_to_file,
    order::DUPLICATE_REASON,
    packer::plan_share,
};
use shl_dicom_transcode::is_uncompressed_image;
use crate::{
    compress::{compress_file, CompressStats},
    state::{new_storage_key, record_file, AppState},
};

/// Puts a staged file into the blob store from this synchronous packer (the CLI runs it inside
/// Tokio, so the store call runs on the runtime).
fn store_sync(state: &AppState, key: &str, path: &Path) -> Result<(), String> {
    tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(state.store.put_file(key, path)))
}

struct Member {
    path: PathBuf,
    len: u64,
    h: ParsedDicomInstance,
}

pub struct PackedSample {
    pub owner_bundle_json: String,
    pub file_ids: Vec<String>,
    pub instances: usize,
    pub bytes: u64,
    pub compression: CompressStats,
    /// Multi-frame instances that were given a frame offset table.
    pub offset_tables_added: usize,
    /// Archive members that are not DICOM instances, with the reason.
    pub skipped: Vec<Skipped>,
}

/// SHA-256 (hex) of a file, to choose between two copies of one instance.
fn file_sha256(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    if let Ok(mut f) = File::open(path) {
        let _ = std::io::copy(&mut f, &mut h);
    }
    h.finalize().iter().map(|x| format!("{x:02x}")).collect()
}

/// The sample's DiagnosticReports by Study Instance UID, from `samples/reports.json`
/// (`[{ studyInstanceUid, report }]`, written by deploy/sample-reports.ts); none without it.
fn sample_reports(samples_dir: &Path) -> Result<std::collections::HashMap<String, Vec<serde_json::Value>>, String> {
    let mut out: std::collections::HashMap<String, Vec<serde_json::Value>> = std::collections::HashMap::new();
    let Ok(text) = std::fs::read_to_string(samples_dir.join("reports.json")) else { return Ok(out) };
    let items: Vec<serde_json::Value> = serde_json::from_str(&text).map_err(|e| format!("reports.json: {e}"))?;
    for item in items {
        if let Some(uid) = item["studyInstanceUid"].as_str() {
            out.entry(uid.to_string()).or_default().push(item["report"].clone());
        }
    }
    Ok(out)
}

/// Native transfer syntaxes never take an offset table, so their files are not read again
/// (offset_tables.rs also declines video syntaxes, from the header).
fn may_lack_offset_table(ts: &str) -> bool {
    !shl_dicom_decode::syntax::is_native(ts)
}

/// Packs every `*.tgz` in `samples_dir` into share `sid`. `scratch` is removed afterwards.
pub fn pack_samples(state: &AppState, sid: &str, samples_dir: &Path, scratch: &Path, last_updated: &str, same_patient: bool) -> Result<PackedSample, String> {
    std::fs::create_dir_all(scratch).map_err(|e| e.to_string())?;
    let result = (|| {
        let mut tgzs: Vec<PathBuf> = std::fs::read_dir(samples_dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "tgz"))
            .collect();
        tgzs.sort();
        if tgzs.is_empty() {
            return Err("no samples/*.tgz".to_string());
        }

        // 1. Unpack each member to a scratch file and read its header.
        let mut members: Vec<Member> = Vec::new();
        let mut n = 0usize;
        let mut compression = CompressStats::default();
        let mut offset_tables_added = 0usize;
        let mut skipped = Vec::new();
        for tgz in &tgzs {
            let gz = flate2::read::GzDecoder::new(BufReader::new(File::open(tgz).map_err(|e| e.to_string())?));
            let mut ar = tar::Archive::new(gz);
            for entry in ar.entries().map_err(|e| e.to_string())? {
                let mut entry = entry.map_err(|e| e.to_string())?;
                if !entry.header().entry_type().is_file() {
                    continue;
                }
                let name = entry.path().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
                let path = scratch.join(format!("{n:08}"));
                n += 1;
                let mut out = BufWriter::new(File::create(&path).map_err(|e| e.to_string())?);
                std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
                out.flush().map_err(|e| e.to_string())?;
                drop(out);
                // A bare data set is wrapped in Part 10 in place, so the length is read afterwards.
                match parse_dicom_file_header(&name, &path) {
                    Ok(h) => {
                        let len = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
                        // Uncompressed images become JPEG Lossless SV1 (pixel-identical); encapsulated
                        // multi-frame instances without a frame offset table get one; the rest stay as they are.
                        let mut len = if is_uncompressed_image(&h.transfer_syntax_uid, &h.sop_class_uid, len) { compress_file(&path, &mut compression)? } else { len };
                        if may_lack_offset_table(&h.transfer_syntax_uid) {
                            if let Some(new_len) = add_offset_table_to_file(&path).map_err(|e| format!("{name}: {e}"))? {
                                len = new_len;
                                offset_tables_added += 1;
                            }
                        }
                        members.push(Member { path, len, h })
                    }
                    Err(reason) => {
                        let _ = std::fs::remove_file(&path);
                        skipped.push(Skipped { name: format!("{}: {name}", tgz.file_name().unwrap_or_default().to_string_lossy()), reason });
                    }
                }
            }
        }
        if members.is_empty() {
            return Err(format!("no DICOM instances in samples/*.tgz ({} file(s) skipped)", skipped.len()));
        }

        // 2. Group and order as the packer does (spec/README.md §11.1), with the sample's reports.
        let headers: Vec<ParsedDicomInstance> = members.iter().map(|m| m.h.clone()).collect();
        let plan = plan_share(&headers, |i| members[i].len, |i| file_sha256(&members[i].path), same_patient).map_err(|c| c.to_string())?;
        for &i in &plan.duplicates {
            skipped.push(Skipped { name: members[i].h.source_name.clone(), reason: DUPLICATE_REASON.into() });
        }
        let mut reports = sample_reports(samples_dir)?;

        // 3. Encrypt each study from its members into the share's directory.
        std::fs::create_dir_all(state.staging_dir(sid)).map_err(|e| e.to_string())?;
        let conn_arc = state.open_share_db(sid).ok_or("share not found")?;
        let mut study_inputs = Vec::new();
        let (mut file_ids, mut instances, mut bytes) = (Vec::new(), 0usize, 0u64);
        for (mut study, order) in plan.studies {
            // The study's plaintext: its instances in Bundle order, read as the records are written.
            let file_id = b64url_encode(&random_bytes::<16>().map_err(|e| e.to_string())?);
            let key = random_bytes::<32>().map_err(|e| e.to_string())?;
            let reader = ReadChain::new(order.iter().map(|&i| File::open(&members[i].path).map(|f| BufReader::with_capacity(1 << 20, f))));
            let part = state.part_path(sid, &file_id);
            let mut out = BufWriter::new(File::create(&part).map_err(|e| e.to_string())?);
            let size = encrypt_file_stream(reader, &mut out, &key).map_err(|e| e.to_string())?;
            out.flush().map_err(|e| e.to_string())?;
            drop(out);
            // Into the blob store (local files, or S3 as a multipart upload streamed from disk).
            let storage = new_storage_key();
            store_sync(state, &storage, &part)?;
            state.blob_add(&storage, size)?;
            record_file(&conn_arc.lock().unwrap(), &file_id, &storage, size)?;
            for &i in &order {
                let _ = std::fs::remove_file(&members[i].path);
            }
            instances += order.len();
            bytes += size;
            file_ids.push(file_id.clone());
            study.file = LinkedFileInput { file_id, key_b64: b64url_encode(&key) };
            study.reports = reports.remove(&study.study_instance_uid).unwrap_or_default();
            study_inputs.push(study);
        }
        let bundle = build_fhir_bundle(&BundleBuildInput {
            last_updated: last_updated.to_string(),
            patient: plan.patient,
            studies: study_inputs,
            loose_reports: Vec::new(),
        });
        Ok(PackedSample { owner_bundle_json: bundle.to_string(), file_ids, instances, bytes, compression, offset_tables_added, skipped })
    })();
    let _ = std::fs::remove_dir_all(scratch);
    result
}
