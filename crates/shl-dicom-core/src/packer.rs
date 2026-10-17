use std::collections::BTreeMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::{
    bundle::{
        build_fhir_bundle, parse_study_index, subset_bundle, BundleBuildInput, InstanceBuildInput, LinkSelection,
        LinkedFileInput, PatientInput, SeriesBuildInput, StudyBuildInput, StudyIndex,
    },
    order::{group, InstanceMeta, DUPLICATE_REASON},
    patient::{patient_from, PatientConflict, PatientMeta},
    crypto::{b64url_encode, encrypt_file_stream, random_bytes, ReadChain},
    range::ciphertext_length,
    dicom_io::{extract_dicom_from_tar_gz, extract_dicom_from_zip, parse_dicom_bytes, ParsedDicomInstance, Skipped},
    jwe::encrypt_bundle_jwe,
    offset_tables::{add_offset_table, offset_table_status, OffsetTableStatus},
    Error, Result,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
/// One study's encrypted file (`{file_id}.bin`): all its series, end to end.
pub struct PackedStudyFile {
    pub file_id: String,
    pub key_b64: String,
    pub study_uid: String,
    pub plaintext_len: u64,
    #[serde(skip)]
    pub ciphertext: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct PackedStudySet {
    /// Instances that got a frame offset table (with `set_add_offset_tables(true)`).
    pub offset_tables_added: usize,
    pub owner_bundle_json: String,
    pub index: StudyIndex,
    pub files: Vec<PackedStudyFile>,
    /// Files not packed, with the reason: those `ingest_*` skipped, and duplicate copies.
    pub skipped: Vec<Skipped>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkBundleOutput {
    pub shl_key_b64: String,
    pub bundle_json: String,
    pub bundle_jwe: String,
    pub allowed_files: Vec<String>,
}

/// A study's file id (base64url, 16 bytes) and key, given instead of drawn at random.
#[derive(Debug, Clone)]
pub struct StudyFile {
    pub file_id: String,
    pub key: [u8; 32],
}

pub struct IngestSession {
    instances: Vec<ParsedDicomInstance>,
    skipped: Vec<Skipped>,
    add_offset_tables: bool,
    study_files: Option<BTreeMap<String, StudyFile>>,
    same_patient: bool,
}

impl Default for IngestSession {
    fn default() -> Self {
        Self::new()
    }
}

impl IngestSession {
    pub fn new() -> Self {
        Self {
            instances: Vec::new(),
            skipped: Vec::new(),
            add_offset_tables: false,
            study_files: None,
            same_patient: false,
        }
    }

    /// Uses these file ids and keys, by Study Instance UID, instead of random ones, so packing the
    /// same instances again gives the same files byte for byte (a link whose files must not change
    /// between builds). `pack` fails for a study without an entry. The caller must never give an
    /// id and key to different content (spec/README.md §13, nonce safety).
    pub fn set_study_files(&mut self, files: BTreeMap<String, StudyFile>) {
        self.study_files = Some(files);
    }

    /// Packs instances that name different people (`patient`) as one patient's, which `pack`
    /// otherwise refuses: the sharer said they are the same person.
    pub fn set_same_patient(&mut self, on: bool) {
        self.same_patient = on;
    }

    /// When on, `pack` gives each encapsulated multi-frame instance that has an empty Basic Offset
    /// Table and no Extended Offset Table a filled-in table (see `offset_tables`). Fragment bytes
    /// are unchanged; the instance's length in the Bundle is its new length. Off by default.
    pub fn set_add_offset_tables(&mut self, on: bool) {
        self.add_offset_tables = on;
    }

    /// Ingested instances that are multi-frame, encapsulated and lack an offset table.
    pub fn instances_missing_offset_tables(&self) -> usize {
        self.instances
            .iter()
            .filter(|i| matches!(offset_table_status(&i.bytes), OffsetTableStatus::Missing { .. }))
            .count()
    }

    /// Ingests one file; returns false, and records the reason in [`Self::skipped`], when it is
    /// not a DICOM instance or cannot be read.
    pub fn ingest_dicom_bytes(&mut self, source_name: &str, raw_bytes: Vec<u8>) -> Result<bool> {
        match parse_dicom_bytes(source_name, raw_bytes) {
            Ok(parsed) => {
                self.instances.push(parsed);
                Ok(true)
            }
            Err(reason) => {
                self.skipped.push(Skipped { name: source_name.to_string(), reason });
                Ok(false)
            }
        }
    }

    /// Ingests every DICOM instance in a `.tar.gz`; returns how many. Other files go to
    /// [`Self::skipped`] with their reasons.
    pub fn ingest_tar_gz(&mut self, tgz_bytes: &[u8]) -> Result<usize> {
        let (parsed, skipped) = extract_dicom_from_tar_gz(tgz_bytes)?;
        let count = parsed.len();
        self.instances.extend(parsed);
        self.skipped.extend(skipped);
        Ok(count)
    }

    /// As [`Self::ingest_tar_gz`], for a `.zip`.
    pub fn ingest_zip(&mut self, zip_bytes: &[u8]) -> Result<usize> {
        let (parsed, skipped) = extract_dicom_from_zip(zip_bytes)?;
        let count = parsed.len();
        self.instances.extend(parsed);
        self.skipped.extend(skipped);
        Ok(count)
    }

    /// Files that were not ingested, each with the reason.
    pub fn skipped(&self) -> &[Skipped] {
        &self.skipped
    }

    pub fn instances(&self) -> &[ParsedDicomInstance] {
        &self.instances
    }

    /// Groups and orders the ingested instances ([`plan_share`]: studies newest first, one copy
    /// per SOP Instance UID; the copies left out go to `skipped`), encrypts each study into one
    /// `{fileId}.bin` with a fresh 16-byte `fileId` and 32-byte `key` (spec/README.md §11.1),
    /// and builds the owner's FHIR R4 Bundle.
    pub fn pack(mut self, last_updated: &str) -> Result<PackedStudySet> {
        if self.instances.is_empty() {
            let n = self.skipped.len();
            return Err(Error::Dicom(format!("no DICOM instances ingested ({n} file(s) skipped)")));
        }
        let mut offset_tables_added = 0usize;
        if self.add_offset_tables {
            for inst in self.instances.iter_mut() {
                let (bytes, changed) = add_offset_table(std::mem::take(&mut inst.bytes));
                inst.bytes = bytes;
                offset_tables_added += changed as usize;
            }
        }
        let insts = &self.instances;
        let plan = plan_share(insts, |i| insts[i].bytes.len() as u64, |i| sha256_hex(&insts[i].bytes), self.same_patient)
            .map_err(|c| Error::Dicom(c.to_string()))?;
        for &i in &plan.duplicates {
            self.skipped.push(Skipped { name: insts[i].source_name.clone(), reason: DUPLICATE_REASON.into() });
        }

        let mut study_inputs = Vec::new();
        let mut files = Vec::new();
        for (mut study, order) in plan.studies {
            // The study's file: its instances in Bundle order, end to end, encrypted record by
            // record straight from the instances (no copy of the plaintext).
            let parts: Vec<&[u8]> = order.iter().map(|&i| insts[i].bytes.as_slice()).collect();
            let total_pt_len: usize = parts.iter().map(|p| p.len()).sum();
            let uid = study.study_instance_uid.clone();
            let (file_id, key) = match &self.study_files {
                Some(given) => {
                    let f = given.get(&uid).ok_or_else(|| Error::Dicom(format!("no file id and key given for study {uid}")))?;
                    (f.file_id.clone(), f.key)
                }
                None => (b64url_encode(&random_bytes::<16>()?), random_bytes::<32>()?),
            };
            let key_b64 = b64url_encode(&key);
            let mut ciphertext = Vec::with_capacity(ciphertext_length(total_pt_len as u64) as usize);
            encrypt_file_stream(ReadChain::new(parts.into_iter().map(Ok)), &mut ciphertext, &key)?;
            files.push(PackedStudyFile { file_id: file_id.clone(), key_b64: key_b64.clone(), study_uid: uid, plaintext_len: total_pt_len as u64, ciphertext });
            study.file = LinkedFileInput { file_id, key_b64 };
            study_inputs.push(study);
        }

        let new_bundle = build_fhir_bundle(&BundleBuildInput {
            last_updated: last_updated.to_string(),
            patient: plan.patient,
            studies: study_inputs,
            loose_reports: Vec::new(),
        })?;
        let owner_bundle_json = serde_json::to_string(&new_bundle).map_err(|e| Error::Json(e.to_string()))?;
        let index = parse_study_index(owner_bundle_json.as_bytes())?;
        Ok(PackedStudySet { offset_tables_added, owner_bundle_json, index, files, skipped: self.skipped })
    }
}

/// A share planned from its instances' headers (`order::group`): the patient, each study's
/// Bundle input (its `file` still empty) with its instances (indices) in file order, and the
/// duplicate copies left out.
pub struct SharePlan {
    pub patient: PatientInput,
    pub studies: Vec<(StudyBuildInput, Vec<usize>)>,
    pub duplicates: Vec<usize>,
}

/// Plans a share from `headers`; `len(i)` is instance i's length as packed, and `sha256(i)` the
/// SHA-256 (hex) of its bytes, asked for only to choose between two copies of one SOP Instance
/// UID at the same place. The patient comes from `patient::patient_from` (refusing two people
/// unless `same_patient`); each study-level value from the first instance, in order, that has it.
pub fn plan_share(
    headers: &[ParsedDicomInstance],
    len: impl Fn(usize) -> u64,
    mut sha256: impl FnMut(usize) -> String,
    same_patient: bool,
) -> std::result::Result<SharePlan, PatientConflict> {
    let mut metas: Vec<InstanceMeta> = headers.iter().map(instance_meta).collect();
    let mut grouped = group(&metas);
    if !grouped.need_sha256.is_empty() {
        for &i in &grouped.need_sha256 {
            metas[i].sha256 = Some(sha256(i));
        }
        grouped = group(&metas);
    }
    let text = |v: &Option<String>| v.clone().filter(|v| !v.trim().is_empty());
    let mut studies = Vec::new();
    for gs in grouped.studies {
        let order: Vec<usize> = gs.series.iter().flat_map(|se| se.instances.iter().copied()).collect();
        let first = |f: fn(&ParsedDicomInstance) -> &Option<String>| order.iter().find_map(|&i| text(f(&headers[i])));
        let series = gs
            .series
            .iter()
            .map(|se| {
                let hs = || se.instances.iter().map(|&i| &headers[i]);
                SeriesBuildInput {
                    uid: se.uid.clone(),
                    number: hs().filter_map(|h| h.series_number).min(),
                    modality: hs().find_map(|h| text(&h.modality)),
                    description: hs().find_map(|h| text(&h.series_description)),
                    file: None,
                    instances: se
                        .instances
                        .iter()
                        .map(|&i| InstanceBuildInput { uid: headers[i].sop_instance_uid.clone(), sop_class_uid: headers[i].sop_class_uid.clone(), number: headers[i].instance_number, length: len(i) })
                        .collect(),
                }
            })
            .collect();
        let study = StudyBuildInput {
            study_instance_uid: gs.uid.clone(),
            description: first(|h| &h.study_description),
            started: first(|h| &h.study_date),
            accession: first(|h| &h.accession_number),
            note: None,
            file: LinkedFileInput { file_id: String::new(), key_b64: String::new() },
            series,
            reports: Vec::new(),
            reencoded: None,
        };
        studies.push((study, order));
    }
    let records: Vec<PatientMeta> = studies
        .iter()
        .flat_map(|(_, order): &(StudyBuildInput, Vec<usize>)| order.iter())
        .map(|&i| {
            let h = &headers[i];
            PatientMeta { name: h.patient_name.clone(), birth_date: h.patient_birth_date.clone(), id: h.patient_id.clone(), issuer: h.patient_id_issuer.clone() }
        })
        .collect();
    let patient = patient_from(&records, same_patient)?;
    Ok(SharePlan { patient, studies, duplicates: grouped.duplicates.iter().map(|&(i, _)| i).collect() })
}

/// What `order::group` reads from an ingested instance.
pub fn instance_meta(i: &ParsedDicomInstance) -> InstanceMeta {
    InstanceMeta {
        study_uid: i.study_instance_uid.clone(),
        series_uid: i.series_instance_uid.clone(),
        sop_uid: i.sop_instance_uid.clone(),
        study_date: i.study_date.clone(),
        study_time: i.study_time.clone(),
        series_number: i.series_number,
        instance_number: i.instance_number,
        sha256: None,
    }
}

fn sha256_hex(b: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

/// Builds a link's Bundle (`bundle.jwe`) from the owner's Bundle JSON: the selected studies and
/// picked reports (`subset_bundle`), or everything when `selection` is None.
pub fn build_link_bundle(
    owner_bundle_json: &str,
    selection: Option<&LinkSelection>,
    shl_key: &[u8; 32],
    last_updated: &str,
) -> Result<LinkBundleOutput> {
    let owner_val: Value = serde_json::from_str(owner_bundle_json).map_err(|e| Error::Json(e.to_string()))?;
    let everything;
    let sel = match selection {
        Some(s) => s,
        None => {
            everything = LinkSelection::everything(&owner_val);
            &everything
        }
    };
    let link = subset_bundle(&owner_val, sel, last_updated)?;
    let bundle_json = serde_json::to_string(&link.bundle).map_err(|e| Error::Json(e.to_string()))?;
    let bundle_jwe = encrypt_bundle_jwe(bundle_json.as_bytes(), shl_key)?;
    Ok(LinkBundleOutput { shl_key_b64: b64url_encode(shl_key), bundle_json, bundle_jwe, allowed_files: link.allowed_files })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::decrypt_range;
    use crate::offset_tables::{frames_of, offset_table_status, tests::synthetic, OffsetTableStatus};

    fn pack_one(add: bool) -> (Vec<u8>, PackedStudySet) {
        let src = synthetic(9, &[1, 2], false);
        let mut s = IngestSession::new();
        assert!(s.ingest_dicom_bytes("slide.dcm", src.clone()).unwrap());
        assert_eq!(s.instances_missing_offset_tables(), 1);
        s.set_add_offset_tables(add);
        (src, s.pack("2026-10-15T00:00:00Z").unwrap())
    }

    /// A one-instance CT of `name`, born `birth`, in its own study.
    fn ct_of(name: &str, birth: &str, id: &str, study: &str) -> Vec<u8> {
        use crate::test_ds::{part10_meta, Ds, Enc};
        let class = "1.2.840.10008.5.1.4.1.1.2";
        let sop = format!("{study}.1.1");
        let mut d = Ds::new(Enc::ExplicitLe);
        d.ui(0x0008, 0x0016, class).ui(0x0008, 0x0018, &sop).text(0x0008, 0x0020, b"DA", "20240101").text(0x0008, 0x0060, b"CS", "CT");
        d.text(0x0010, 0x0010, b"PN", name).text(0x0010, 0x0020, b"LO", id).text(0x0010, 0x0030, b"DA", birth);
        d.ui(0x0020, 0x000D, study).ui(0x0020, 0x000E, &format!("{study}.1")).text(0x0020, 0x0013, b"IS", "1");
        d.image(1, "MONOCHROME2", None, None, 2, 2, 8, 8, 0);
        d.elem(0x7FE0, 0x0010, b"OW", &[7; 4]);
        part10_meta("1.2.840.10008.1.2.1", &[(0x0002, class), (0x0003, &sop)], &d.out, true)
    }

    #[test]
    fn pack_refuses_two_people_unless_told_they_are_one() {
        let session = |same: bool| {
            let mut s = IngestSession::new();
            s.ingest_dicom_bytes("ann.dcm", ct_of("ALPHA^ANN", "19700101", "A-1", "2.25.1")).unwrap();
            s.ingest_dicom_bytes("bob.dcm", ct_of("BETA^BOB", "19800202", "B-2", "2.25.2")).unwrap();
            s.set_same_patient(same);
            s
        };
        let err = session(false).pack("2026-10-17T00:00:00Z").unwrap_err().to_string();
        assert!(err.contains("more than one patient") && err.contains("ALPHA^ANN") && err.contains("BETA^BOB"), "{err}");
        let packed = session(true).pack("2026-10-17T00:00:00Z").unwrap();
        assert_eq!(packed.index.patient_name.as_deref(), Some("Ann Alpha"));
        // One person under two given names and two record numbers: packed without being told.
        let mut s = IngestSession::new();
        s.ingest_dicom_bytes("a.dcm", ct_of("EXAMPLE^JOSH", "19800202", "MRN-1", "2.25.1")).unwrap();
        s.ingest_dicom_bytes("b.dcm", ct_of("EXAMPLE^JOSHUA", "19800202", "MRN-2", "2.25.2")).unwrap();
        let v: Value = serde_json::from_str(&s.pack("2026-10-17T00:00:00Z").unwrap().owner_bundle_json).unwrap();
        assert_eq!(v["entry"][0]["resource"]["identifier"], serde_json::json!([{ "value": "MRN-1" }, { "value": "MRN-2" }]));
    }

    #[test]
    fn pack_adds_offset_tables_when_asked() {
        let (src, off) = pack_one(false);
        assert_eq!(off.offset_tables_added, 0);
        assert_eq!(off.index.studies[0].series[0].instances[0].length, src.len() as u64);

        let (_, on) = pack_one(true);
        assert_eq!(on.offset_tables_added, 1);
        let sf = &on.files[0];
        let inst = &on.index.studies[0].series[0].instances[0];
        assert_eq!(inst.length, src.len() as u64 + 4 * 9);
        assert_eq!(sf.plaintext_len, inst.length);
        let key = crate::crypto::decode_key_32(&sf.key_b64).unwrap();
        let plain = decrypt_range(&sf.ciphertext, 0, sf.plaintext_len, sf.plaintext_len, &key).unwrap();
        assert_eq!(offset_table_status(&plain), OffsetTableStatus::HasTable);
        assert_eq!(frames_of(&plain).unwrap(), frames_of(&src).unwrap());
    }
}
