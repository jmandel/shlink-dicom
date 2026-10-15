use std::collections::BTreeMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::{
    bundle::{
        build_fhir_bundle, parse_study_index, subset_fhir_bundle, BundleBuildInput,
        InstanceBuildInput, SeriesBuildInput, StudyBuildInput, StudyIndex,
    },
    crypto::{b64url_encode, encrypt_series, random_bytes},
    dicom_io::{extract_dicom_from_tar_gz, extract_dicom_from_zip, parse_dicom_bytes, ParsedDicomInstance},
    jwe::encrypt_bundle_jwe,
    offset_tables::{add_offset_table, offset_table_status, OffsetTableStatus},
    Error, Result,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedSeriesFile {
    pub file_id: String,
    pub key_b64: String,
    pub series_uid: String,
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
    pub series_files: Vec<PackedSeriesFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkBundleOutput {
    pub shl_key_b64: String,
    pub bundle_json: String,
    pub bundle_jwe: String,
    pub allowed_files: Vec<String>,
}

pub struct IngestSession {
    existing_bundle: Option<Value>,
    instances: Vec<ParsedDicomInstance>,
    add_offset_tables: bool,
}

impl Default for IngestSession {
    fn default() -> Self {
        Self::new()
    }
}

impl IngestSession {
    pub fn new() -> Self {
        Self {
            existing_bundle: None,
            instances: Vec::new(),
            add_offset_tables: false,
        }
    }

    pub fn from_owner_bundle_json(owner_bundle_json: &str) -> Result<Self> {
        let val: Value =
            serde_json::from_str(owner_bundle_json).map_err(|e| Error::Json(e.to_string()))?;
        let _ = parse_study_index(owner_bundle_json.as_bytes())?;
        Ok(Self {
            existing_bundle: Some(val),
            instances: Vec::new(),
            add_offset_tables: false,
        })
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

    pub fn ingest_dicom_bytes(&mut self, source_name: &str, raw_bytes: Vec<u8>) -> Result<bool> {
        if let Some(parsed) = parse_dicom_bytes(source_name, raw_bytes)? {
            self.instances.push(parsed);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn ingest_tar_gz(&mut self, tgz_bytes: &[u8]) -> Result<usize> {
        let parsed = extract_dicom_from_tar_gz(tgz_bytes)?;
        let count = parsed.len();
        self.instances.extend(parsed);
        Ok(count)
    }

    pub fn ingest_zip(&mut self, zip_bytes: &[u8]) -> Result<usize> {
        let parsed = extract_dicom_from_zip(zip_bytes)?;
        let count = parsed.len();
        self.instances.extend(parsed);
        Ok(count)
    }

    pub fn instances(&self) -> &[ParsedDicomInstance] {
        &self.instances
    }

    /// Groups ingested DICOM instances by `(StudyInstanceUID, SeriesInstanceUID)`,
    /// orders each series by `(InstanceNumber, SOPInstanceUID)`, encrypts each series
    /// into `{fileId}.bin` with a fresh 16-byte `fileId` and 32-byte `key`, and builds
    /// the master owner FHIR R4 Bundle.
    pub fn pack(self, last_updated: &str) -> Result<PackedStudySet> {
        if self.instances.is_empty() && self.existing_bundle.is_none() {
            return Err(Error::Dicom("no DICOM instances ingested".into()));
        }

        let mut patient_name = None;
        let mut patient_id = None;
        let mut patient_birth_date = None;

        // Group by StudyInstanceUID -> SeriesInstanceUID -> Vec<ParsedDicomInstance>
        let mut studies_map: BTreeMap<String, BTreeMap<String, Vec<ParsedDicomInstance>>> =
            BTreeMap::new();

        for inst in self.instances {
            if patient_name.is_none() {
                patient_name = inst.patient_name.clone();
            }
            if patient_id.is_none() {
                patient_id = inst.patient_id.clone();
            }
            if patient_birth_date.is_none() {
                patient_birth_date = inst.patient_birth_date.clone();
            }
            studies_map
                .entry(inst.study_instance_uid.clone())
                .or_default()
                .entry(inst.series_instance_uid.clone())
                .or_default()
                .push(inst);
        }

        let mut study_inputs = Vec::new();
        let mut series_files = Vec::new();
        let add_tables = self.add_offset_tables;
        let mut offset_tables_added = 0usize;

        for (study_idx, (study_uid, series_map)) in studies_map.into_iter().enumerate() {
            let mut study_desc = None;
            let mut study_date = None;
            let mut series_inputs = Vec::new();

            for (series_uid, mut insts) in series_map {
                // Deduplicate by SOPInstanceUID in case the archive had duplicate files
                insts.sort_by(|a, b| {
                    let num_cmp = a
                        .instance_number
                        .unwrap_or(i32::MAX)
                        .cmp(&b.instance_number.unwrap_or(i32::MAX));
                    num_cmp.then_with(|| a.sop_instance_uid.cmp(&b.sop_instance_uid))
                });
                insts.dedup_by(|a, b| a.sop_instance_uid == b.sop_instance_uid);
                if add_tables {
                    for inst in insts.iter_mut() {
                        let (bytes, changed) = add_offset_table(std::mem::take(&mut inst.bytes));
                        inst.bytes = bytes;
                        offset_tables_added += changed as usize;
                    }
                }

                let first = &insts[0];
                if study_desc.is_none() {
                    study_desc = first.study_description.clone();
                }
                if study_date.is_none() {
                    study_date = first.study_date.clone();
                }

                let file_id_bytes = random_bytes::<16>()?;
                let file_id = b64url_encode(&file_id_bytes);
                let series_key = random_bytes::<32>()?;
                let key_b64 = b64url_encode(&series_key);

                let total_pt_len: usize = insts.iter().map(|i| i.bytes.len()).sum();
                let mut series_plaintext = Vec::with_capacity(total_pt_len);
                let mut inst_inputs = Vec::with_capacity(insts.len());

                for inst in &insts {
                    series_plaintext.extend_from_slice(&inst.bytes);
                    inst_inputs.push(InstanceBuildInput {
                        uid: inst.sop_instance_uid.clone(),
                        sop_class_uid: inst.sop_class_uid.clone(),
                        number: inst.instance_number,
                        length: inst.bytes.len() as u64,
                    });
                }

                let ciphertext = encrypt_series(&series_plaintext, &series_key)?;

                series_files.push(PackedSeriesFile {
                    file_id: file_id.clone(),
                    key_b64: key_b64.clone(),
                    series_uid: series_uid.clone(),
                    study_uid: study_uid.clone(),
                    plaintext_len: total_pt_len as u64,
                    ciphertext,
                });

                series_inputs.push(SeriesBuildInput {
                    uid: series_uid,
                    number: first.series_number,
                    modality: first.modality.clone(),
                    description: first.series_description.clone(),
                    file_id,
                    key_b64,
                    instances: inst_inputs,
                });
            }

            series_inputs.sort_by(|a, b| {
                a.number
                    .unwrap_or(i32::MAX)
                    .cmp(&b.number.unwrap_or(i32::MAX))
                    .then_with(|| a.uid.cmp(&b.uid))
            });

            study_inputs.push(StudyBuildInput {
                id: format!("study-{}", study_idx + 1),
                study_instance_uid: study_uid,
                description: study_desc,
                started: study_date,
                note: None,
                series: series_inputs,
            });
        }

        // Order multi-slice volumetric studies first so the primary study is shown first
        study_inputs.sort_by(|a, b| {
            let count_a: usize = a.series.iter().map(|s| s.instances.len()).sum();
            let count_b: usize = b.series.iter().map(|s| s.instances.len()).sum();
            count_b
                .cmp(&count_a)
                .then_with(|| a.study_instance_uid.cmp(&b.study_instance_uid))
        });
        for (i, st) in study_inputs.iter_mut().enumerate() {
            st.id = format!("study-{}", i + 1);
        }

        let new_bundle = build_fhir_bundle(&BundleBuildInput {
            last_updated: last_updated.to_string(),
            patient_name,
            patient_id,
            patient_birth_date,
            studies: study_inputs,
        });

        let final_bundle = if let Some(mut existing) = self.existing_bundle {
            merge_bundles(&mut existing, &new_bundle, last_updated)?;
            existing
        } else {
            new_bundle
        };

        let owner_bundle_json =
            serde_json::to_string(&final_bundle).map_err(|e| Error::Json(e.to_string()))?;
        let index = parse_study_index(owner_bundle_json.as_bytes())?;

        Ok(PackedStudySet {
            offset_tables_added,
            owner_bundle_json,
            index,
            series_files,
        })
    }
}

fn merge_bundles(existing: &mut Value, added: &Value, last_updated: &str) -> Result<()> {
    existing["meta"]["lastUpdated"] = json!(last_updated);
    let existing_entries = existing
        .get_mut("entry")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| Error::InvalidBundle("existing Bundle missing entry".into()))?;
    let added_entries = added
        .get("entry")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::InvalidBundle("added Bundle missing entry".into()))?;

    let mut study_counter = existing_entries.len();
    for entry in added_entries {
        let Some(res) = entry.get("resource") else {
            continue;
        };
        if res.get("resourceType").and_then(Value::as_str) == Some("ImagingStudy") {
            study_counter += 1;
            let mut cloned_entry = entry.clone();
            cloned_entry["fullUrl"] = json!(format!("urn:uuid:imagingstudy-{study_counter}"));
            cloned_entry["resource"]["id"] = json!(format!("study-{study_counter}"));
            existing_entries.push(cloned_entry);
        }
    }
    Ok(())
}

/// Builds a link-specific Bundle (`bundle.jwe`) from the owner's full Bundle JSON,
/// filtering to `selected_file_ids` (or including all series if `selected_file_ids` is empty).
pub fn build_link_bundle(
    owner_bundle_json: &str,
    selected_file_ids: &[String],
    shl_key: &[u8; 32],
    last_updated: &str,
) -> Result<LinkBundleOutput> {
    let owner_val: Value =
        serde_json::from_str(owner_bundle_json).map_err(|e| Error::Json(e.to_string()))?;
    let link_bundle_val = subset_fhir_bundle(&owner_val, selected_file_ids, last_updated)?;
    let bundle_json =
        serde_json::to_string(&link_bundle_val).map_err(|e| Error::Json(e.to_string()))?;
    let parsed_index = parse_study_index(bundle_json.as_bytes())?;

    let mut allowed_files = Vec::new();
    for st in &parsed_index.studies {
        for se in &st.series {
            allowed_files.push(format!("{}.bin", se.file_id));
        }
    }

    let bundle_jwe = encrypt_bundle_jwe(bundle_json.as_bytes(), shl_key)?;
    Ok(LinkBundleOutput {
        shl_key_b64: b64url_encode(shl_key),
        bundle_json,
        bundle_jwe,
        allowed_files,
    })
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

    #[test]
    fn pack_adds_offset_tables_when_asked() {
        let (src, off) = pack_one(false);
        assert_eq!(off.offset_tables_added, 0);
        assert_eq!(off.index.studies[0].series[0].instances[0].length, src.len() as u64);

        let (_, on) = pack_one(true);
        assert_eq!(on.offset_tables_added, 1);
        let sf = &on.series_files[0];
        let inst = &on.index.studies[0].series[0].instances[0];
        assert_eq!(inst.length, src.len() as u64 + 4 * 9);
        assert_eq!(sf.plaintext_len, inst.length);
        let key = crate::crypto::decode_key_32(&sf.key_b64).unwrap();
        let plain = decrypt_range(&sf.ciphertext, 0, sf.plaintext_len, sf.plaintext_len, &key).unwrap();
        assert_eq!(offset_table_status(&plain), OffsetTableStatus::HasTable);
        assert_eq!(frames_of(&plain).unwrap(), frames_of(&src).unwrap());
    }
}
