//! Packs the server's sample (`samples/*.tgz`) into a share's study files on disk, holding at most
//! one record and one header in memory: each archive member is written to a scratch file while its
//! header is read, then every study is encrypted record by record (spec/README.md §9.2, §11.1: one
//! file per study, its series in order) from those files into a staged file, which goes into the blob store.
//! As the Share page does by default, uncompressed images are re-encoded without loss first
//! (compress.rs), and encapsulated multi-frame instances that lack a frame offset table get one
//! (`shl_dicom_core::offset_tables`, fragment bytes unchanged); every other instance is kept byte
//! for byte. Files that are not DICOM instances are reported with the reason, never dropped silently.
use std::{
    collections::BTreeMap,
    fs::File,
    io::{BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
};
use shl_dicom_core::{
    bundle::{build_fhir_bundle, BundleBuildInput, InstanceBuildInput, LinkedFileInput, SeriesBuildInput, StudyBuildInput},
    crypto::{b64url_encode, encrypt_file_stream, random_bytes},
    dicom_io::{parse_dicom_header_reader, ParsedDicomInstance, Skipped},
    offset_tables::add_offset_table_to_file,
};
use crate::{
    compress::{compress_file, is_uncompressed_image, CompressStats},
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

/// The instance's header, read from its file up to Pixel Data; `Err` gives the reason for anything
/// that isn't a Part 10 DICOM instance.
fn parse_header(path: &Path, name: &str) -> Result<ParsedDicomInstance, String> {
    let f = File::open(path).map_err(|e| e.to_string())?;
    parse_dicom_header_reader(name, BufReader::with_capacity(64 << 10, f))
}

/// Native transfer syntaxes never take an offset table, so their files are not read again
/// (offset_tables.rs also declines video syntaxes, from the header).
fn may_lack_offset_table(ts: &str) -> bool {
    !matches!(ts, "1.2.840.10008.1.2" | "1.2.840.10008.1.2.1" | "1.2.840.10008.1.2.2" | "1.2.840.10008.1.2.1.99")
}

/// Packs every `*.tgz` in `samples_dir` into share `sid`. `scratch` is removed afterwards.
pub fn pack_samples(state: &AppState, sid: &str, samples_dir: &Path, scratch: &Path, last_updated: &str) -> Result<PackedSample, String> {
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
                let len = std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
                out.flush().map_err(|e| e.to_string())?;
                drop(out);
                match parse_header(&path, &name) {
                    Ok(h) => {
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

        // 2. Group and order as the packer does (spec/README.md §11.1).
        let (patient_name, patient_id, patient_birth_date) =
            (members[0].h.patient_name.clone(), members[0].h.patient_id.clone(), members[0].h.patient_birth_date.clone());
        let mut studies: BTreeMap<String, BTreeMap<String, Vec<Member>>> = BTreeMap::new();
        for m in members {
            studies.entry(m.h.study_instance_uid.clone()).or_default().entry(m.h.series_instance_uid.clone()).or_default().push(m);
        }

        // 3. Encrypt each study from its members into the share's directory.
        std::fs::create_dir_all(state.staging_dir(sid)).map_err(|e| e.to_string())?;
        let conn_arc = state.open_share_db(sid).ok_or("share not found")?;
        let mut study_inputs = Vec::new();
        let (mut file_ids, mut instances, mut bytes) = (Vec::new(), 0usize, 0u64);
        for (study_uid, series_map) in studies {
            let (mut description, mut started, mut accession) = (None, None, None);
            // Each series' members, ordered; then the series ordered as the Bundle lists them.
            let mut series: Vec<(SeriesBuildInput, Vec<Member>)> = Vec::new();
            for (series_uid, mut insts) in series_map {
                insts.sort_by(|a, b| {
                    a.h.instance_number
                        .unwrap_or(i32::MAX)
                        .cmp(&b.h.instance_number.unwrap_or(i32::MAX))
                        .then_with(|| a.h.sop_instance_uid.cmp(&b.h.sop_instance_uid))
                });
                insts.dedup_by(|a, b| a.h.sop_instance_uid == b.h.sop_instance_uid);
                let first = &insts[0].h;
                description = description.or_else(|| first.study_description.clone());
                started = started.or_else(|| first.study_date.clone());
                accession = accession.or_else(|| first.accession_number.clone());
                let input = SeriesBuildInput {
                    uid: series_uid,
                    number: first.series_number,
                    modality: first.modality.clone(),
                    description: first.series_description.clone(),
                    file: None,
                    instances: insts
                        .iter()
                        .map(|m| InstanceBuildInput {
                            uid: m.h.sop_instance_uid.clone(),
                            sop_class_uid: m.h.sop_class_uid.clone(),
                            number: m.h.instance_number,
                            length: m.len,
                        })
                        .collect(),
                };
                series.push((input, insts));
            }
            series.sort_by(|(a, _), (b, _)| a.number.unwrap_or(i32::MAX).cmp(&b.number.unwrap_or(i32::MAX)).then_with(|| a.uid.cmp(&b.uid)));

            // The study's plaintext: every series' instances end to end, read as the records are written.
            let file_id = b64url_encode(&random_bytes::<16>().map_err(|e| e.to_string())?);
            let key = random_bytes::<32>().map_err(|e| e.to_string())?;
            let paths: Vec<PathBuf> = series.iter().flat_map(|(_, m)| m.iter().map(|m| m.path.clone())).collect();
            let reader = Concat { paths, next: 0, cur: None };
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
            for m in series.iter().flat_map(|(_, m)| m.iter()) {
                let _ = std::fs::remove_file(&m.path);
            }
            instances += series.iter().map(|(_, m)| m.len()).sum::<usize>();
            bytes += size;
            file_ids.push(file_id.clone());
            study_inputs.push(StudyBuildInput {
                id: String::new(),
                study_instance_uid: study_uid,
                description,
                started,
                accession,
                note: None,
                file: LinkedFileInput { file_id, key_b64: b64url_encode(&key) },
                series: series.into_iter().map(|(s, _)| s).collect(),
            });
        }
        // Larger studies first, as the packer orders them.
        study_inputs.sort_by(|a, b| {
            let count = |s: &StudyBuildInput| s.series.iter().map(|x| x.instances.len()).sum::<usize>();
            count(b).cmp(&count(a)).then_with(|| a.study_instance_uid.cmp(&b.study_instance_uid))
        });
        for (i, st) in study_inputs.iter_mut().enumerate() {
            st.id = format!("study-{}", i + 1);
        }
        let bundle = build_fhir_bundle(&BundleBuildInput {
            last_updated: last_updated.to_string(),
            patient_name,
            patient_id,
            patient_birth_date,
            studies: study_inputs,
        });
        Ok(PackedSample { owner_bundle_json: bundle.to_string(), file_ids, instances, bytes, compression, offset_tables_added, skipped })
    })();
    let _ = std::fs::remove_dir_all(scratch);
    result
}

/// Files read one after another as one stream, opening each only when it is reached.
struct Concat {
    paths: Vec<PathBuf>,
    next: usize,
    cur: Option<BufReader<File>>,
}

impl Read for Concat {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            if self.cur.is_none() {
                let Some(p) = self.paths.get(self.next) else { return Ok(0) };
                self.cur = Some(BufReader::with_capacity(1 << 20, File::open(p)?));
                self.next += 1;
            }
            let n = self.cur.as_mut().unwrap().read(buf)?;
            if n > 0 || buf.is_empty() {
                return Ok(n);
            }
            self.cur = None;
        }
    }
}
