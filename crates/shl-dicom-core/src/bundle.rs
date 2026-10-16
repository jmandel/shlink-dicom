use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::{
    crypto::decode_key_32,
    range::{ciphertext_length, record_count, RECORD_PLAINTEXT},
    Error, Result,
};

pub const PROFILE_URL: &str =
    "http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/dicom-imaging-study";
pub const EXT_LINKED_FILE: &str =
    "http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/linked-file";
pub const EXT_INSTANCE_LENGTH: &str =
    "http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/instance-length";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyIndex {
    pub last_updated: Option<String>,
    pub patient_name: Option<String>,
    pub patient_id: Option<String>,
    pub patient_birth_date: Option<String>,
    pub diagnostic_reports: Vec<DiagnosticReportSummary>,
    pub studies: Vec<StudySummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReportSummary {
    pub id: String,
    pub status: String,
    pub conclusion: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudySummary {
    pub id: String,
    pub study_instance_uid: String,
    pub description: Option<String>,
    pub started: Option<String>,
    pub number_of_series: usize,
    pub number_of_instances: usize,
    /// The distinct files this study's series use, in first-use order.
    pub files: Vec<FileSummary>,
    pub series: Vec<SeriesSummary>,
}

/// One encrypted file (`{file_id}.bin`): its key and lengths (PROPOSAL.md §8.1, §9.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSummary {
    pub file_id: String,
    pub key: String,
    /// Plaintext length P: the instances of every series in the file.
    pub plaintext_length: u64,
    pub ciphertext_length: u64,
    pub record_count: u64,
}

impl FileSummary {
    pub fn key_bytes(&self) -> Result<[u8; 32]> {
        decode_key_32(&self.key)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesSummary {
    pub uid: String,
    pub number: Option<i32>,
    pub modality: Option<String>,
    pub description: Option<String>,
    /// The file this series is in.
    pub file: FileSummary,
    /// Plaintext offset of the series' first instance in its file.
    pub offset: u64,
    /// Sum of the series' instance lengths.
    pub bytes: u64,
    /// First and last records covering the series in its file.
    pub first_record: u64,
    pub last_record: u64,
    pub instances: Vec<InstanceSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceSummary {
    pub uid: String,
    pub sop_class: String,
    pub number: Option<i32>,
    /// Plaintext offset of this Part 10 file in its series' file.
    pub offset: u64,
    pub length: u64,
    pub first_record: u64,
    pub last_record: u64,
}

#[derive(Debug, Clone)]
pub struct BundleBuildInput {
    pub last_updated: String,
    pub patient_name: Option<String>,
    pub patient_id: Option<String>,
    pub patient_birth_date: Option<String>,
    pub studies: Vec<StudyBuildInput>,
}

#[derive(Debug, Clone)]
pub struct StudyBuildInput {
    pub id: String,
    pub study_instance_uid: String,
    pub description: Option<String>,
    pub started: Option<String>,
    /// Accession Number (0008,0050), written as an ImagingStudy identifier of type ACSN.
    pub accession: Option<String>,
    pub note: Option<String>,
    /// The study's file, written as `linked-file` on the ImagingStudy.
    pub file: LinkedFileInput,
    pub series: Vec<SeriesBuildInput>,
}

/// A `linked-file`: the file id and its base64url key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedFileInput {
    pub file_id: String,
    pub key_b64: String,
}

#[derive(Debug, Clone)]
pub struct SeriesBuildInput {
    pub uid: String,
    pub number: Option<i32>,
    pub modality: Option<String>,
    pub description: Option<String>,
    /// A file of the series' own (a series added to the study later); None for the study's file.
    pub file: Option<LinkedFileInput>,
    pub instances: Vec<InstanceBuildInput>,
}

fn linked_file_json(f: &LinkedFileInput) -> Value {
    json!([{
        "url": EXT_LINKED_FILE,
        "extension": [
            { "url": "id", "valueString": f.file_id },
            { "url": "key", "valueString": f.key_b64 }
        ]
    }])
}

#[derive(Debug, Clone)]
pub struct InstanceBuildInput {
    pub uid: String,
    pub sop_class_uid: String,
    pub number: Option<i32>,
    pub length: u64,
}

fn format_dicom_date(d: &str) -> Option<String> {
    let clean = d.trim();
    if clean.len() == 8 && clean.chars().all(|c| c.is_ascii_digit()) {
        Some(format!("{}-{}-{}", &clean[0..4], &clean[4..6], &clean[6..8]))
    } else if !clean.is_empty() {
        Some(clean.to_string())
    } else {
        None
    }
}

pub fn build_fhir_bundle(input: &BundleBuildInput) -> Value {
    let mut entries = Vec::new();

    let mut patient = json!({
        "resourceType": "Patient",
        "id": "p1",
    });
    if let Some(ref name) = input.patient_name {
        let parts: Vec<&str> = name.split('^').collect();
        let family = parts.first().copied().unwrap_or(name.as_str());
        let given: Vec<&str> = parts.iter().skip(1).copied().filter(|s| !s.is_empty()).collect();
        if given.is_empty() {
            patient["name"] = json!([{ "text": name, "family": family }]);
        } else {
            patient["name"] = json!([{ "text": name, "family": family, "given": given }]);
        }
    }
    if let Some(ref pid) = input.patient_id {
        patient["identifier"] = json!([{ "value": pid }]);
    }
    if let Some(ref dob) = input.patient_birth_date.as_deref().and_then(format_dicom_date) {
        patient["birthDate"] = json!(dob);
    }

    entries.push(json!({
        "fullUrl": random_urn_uuid(),
        "resource": patient,
    }));

    for study in input.studies.iter() {
        let total_instances: usize = study.series.iter().map(|se| se.instances.len()).sum();
        let series_json: Vec<Value> = study
            .series
            .iter()
            .map(|se| {
                let instances_json: Vec<Value> = se
                    .instances
                    .iter()
                    .map(|inst| {
                        let sop_code = if inst.sop_class_uid.starts_with("urn:oid:") {
                            inst.sop_class_uid.clone()
                        } else {
                            format!("urn:oid:{}", inst.sop_class_uid)
                        };
                        let mut inst_obj = json!({
                            "extension": [{
                                "url": EXT_INSTANCE_LENGTH,
                                "valueDecimal": inst.length,
                            }],
                            "uid": inst.uid,
                            "sopClass": {
                                "system": "urn:ietf:rfc:3986",
                                "code": sop_code,
                            }
                        });
                        if let Some(num) = inst.number {
                            inst_obj["number"] = json!(num);
                        }
                        inst_obj
                    })
                    .collect();

                let modality_code = se.modality.as_deref().unwrap_or("OT");
                let mut se_obj = json!({
                    "uid": se.uid,
                    "modality": {
                        "system": "http://dicom.nema.org/resources/ontology/DCM",
                        "code": modality_code,
                    },
                    "numberOfInstances": se.instances.len(),
                    "instance": instances_json,
                });
                if let Some(f) = se.file.as_ref().filter(|f| *f != &study.file) {
                    se_obj["extension"] = linked_file_json(f);
                }
                if let Some(num) = se.number {
                    se_obj["number"] = json!(num);
                }
                if let Some(ref desc) = se.description {
                    se_obj["description"] = json!(desc);
                }
                se_obj
            })
            .collect();

        let study_oid = if study.study_instance_uid.starts_with("urn:oid:") {
            study.study_instance_uid.clone()
        } else {
            format!("urn:oid:{}", study.study_instance_uid)
        };
        let mut study_res = json!({
            "resourceType": "ImagingStudy",
            "id": study.id,
            "meta": {
                "profile": [PROFILE_URL]
            },
            "extension": linked_file_json(&study.file),
            "status": "available",
            "identifier": [{
                "system": "urn:dicom:uid",
                "value": study_oid,
            }],
            "subject": { "reference": "Patient/p1" },
            "numberOfSeries": study.series.len(),
            "numberOfInstances": total_instances,
            "series": series_json,
        });
        if let Some(ref desc) = study.description {
            study_res["description"] = json!(desc);
        }
        if let Some(ref started) = study.started.as_deref().and_then(format_dicom_date) {
            study_res["started"] = json!(started);
        }
        if let Some(ref note) = study.note {
            study_res["note"] = json!([{ "text": note }]);
        }
        if let Some(acc) = study.accession.as_deref().filter(|a| !a.trim().is_empty()) {
            study_res["identifier"].as_array_mut().unwrap().push(json!({
                "type": { "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/v2-0203", "code": "ACSN" }] },
                "value": acc.trim(),
            }));
        }

        entries.push(json!({
            "fullUrl": random_urn_uuid(),
            "resource": study_res,
        }));
    }

    json!({
        "resourceType": "Bundle",
        "meta": {
            "lastUpdated": input.last_updated,
        },
        "type": "collection",
        "entry": entries,
    })
}

/// Builds a link-specific FHIR R4 Bundle from an owner's full Bundle by keeping only the series
/// whose file (their own `linked-file`, else the study's) is in `selected_file_ids`, or everything
/// if `selected_file_ids` is empty. A file is kept or dropped whole, so a link never carries the
/// key of a file holding series it does not list. Updates `numberOfSeries` and
/// `numberOfInstances`, drops a study-level `linked-file` that no kept series uses, and adds a
/// partial-study `note` if series were dropped.
pub fn subset_fhir_bundle(
    owner_bundle: &Value,
    selected_file_ids: &[String],
    last_updated: &str,
) -> Result<Value> {
    if selected_file_ids.is_empty() {
        let mut cloned = owner_bundle.clone();
        cloned["meta"]["lastUpdated"] = json!(last_updated);
        return Ok(cloned);
    }

    let entries = owner_bundle
        .get("entry")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::InvalidBundle("owner Bundle missing entry array".into()))?;

    // ImagingStudy entries kept (by fullUrl and id), so DiagnosticReports can follow them.
    let mut kept_urls: Vec<String> = Vec::new();
    let mut kept_ids: Vec<String> = Vec::new();
    let mut new_entries = Vec::new();
    let mut reports = Vec::new();
    for entry in entries {
        let Some(res) = entry.get("resource") else {
            continue;
        };
        let res_type = res.get("resourceType").and_then(Value::as_str).unwrap_or("");
        if res_type == "DiagnosticReport" {
            // Decided once the kept studies are known; the slot keeps the Bundle's order.
            reports.push((new_entries.len(), entry));
            new_entries.push(Value::Null);
            continue;
        }
        // Provenance is the owner's record (the Share page's re-encoding note); links leave it out.
        if res_type == "Provenance" {
            continue;
        }
        if res_type != "ImagingStudy" {
            new_entries.push(entry.clone());
            continue;
        }

        let Some(series_arr) = res.get("series").and_then(Value::as_array) else {
            continue;
        };
        let study_file = extract_linked_file(res)?;
        let orig_series_count = series_arr.len();
        let mut kept_series = Vec::new();
        let mut kept_instances = 0usize;
        let mut study_file_used = false;

        for se in series_arr {
            let own = extract_linked_file(se)?;
            let Some((fid, _)) = own.as_ref().or(study_file.as_ref()) else {
                continue;
            };
            if selected_file_ids.iter().any(|s| s == fid) {
                study_file_used |= own.is_none();
                kept_instances += se
                    .get("instance")
                    .and_then(Value::as_array)
                    .map(|a| a.len())
                    .unwrap_or(0);
                kept_series.push(se.clone());
            }
        }

        if kept_series.is_empty() {
            continue;
        }

        let mut new_study = res.clone();
        new_study["numberOfSeries"] = json!(kept_series.len());
        new_study["numberOfInstances"] = json!(kept_instances);
        new_study["series"] = json!(kept_series);
        if !study_file_used {
            if let Some(exts) = new_study.get_mut("extension").and_then(Value::as_array_mut) {
                exts.retain(|e| e.get("url").and_then(Value::as_str) != Some(EXT_LINKED_FILE));
                if exts.is_empty() {
                    new_study.as_object_mut().unwrap().remove("extension");
                }
            }
        }
        if kept_series.len() < orig_series_count {
            new_study["note"] = json!([{
                "text": format!(
                    "Partial study: {} of {} series shared in this link.",
                    kept_series.len(),
                    orig_series_count
                )
            }]);
        }

        if let Some(u) = entry.get("fullUrl").and_then(Value::as_str) {
            kept_urls.push(u.to_string());
        }
        if let Some(id) = res.get("id").and_then(Value::as_str) {
            kept_ids.push(id.to_string());
        }
        let mut new_entry = entry.clone();
        new_entry["resource"] = new_study;
        new_entries.push(new_entry);
    }
    // A DiagnosticReport goes with the studies it refers to (by fullUrl or "ImagingStudy/<id>"); one
    // that refers to none goes with every link (as web/share/lib/pack.ts subsetBundle does).
    for (slot, entry) in reports {
        let refs: Vec<&str> = entry["resource"]
            .get("imagingStudy")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|r| r.get("reference").and_then(Value::as_str)).collect())
            .unwrap_or_default();
        let keep = refs.is_empty()
            || refs.iter().any(|r| {
                kept_urls.iter().any(|u| u == r) || r.rsplit_once("ImagingStudy/").is_some_and(|(_, id)| kept_ids.iter().any(|k| k == id))
            });
        if keep {
            new_entries[slot] = entry.clone();
        }
    }
    new_entries.retain(|e| !e.is_null());

    Ok(json!({
        "resourceType": "Bundle",
        "meta": {
            "lastUpdated": last_updated,
        },
        "type": "collection",
        "entry": new_entries,
    }))
}

pub fn parse_study_index(bundle_json: &[u8]) -> Result<StudyIndex> {
    let root: Value = serde_json::from_slice(bundle_json).map_err(|e| Error::Json(e.to_string()))?;
    if root.get("resourceType").and_then(Value::as_str) != Some("Bundle") {
        return Err(Error::InvalidBundle("root resourceType must be Bundle".into()));
    }

    let last_updated = root
        .get("meta")
        .and_then(|m| m.get("lastUpdated"))
        .and_then(Value::as_str)
        .map(String::from);

    let mut patient_name = None;
    let mut patient_id = None;
    let mut patient_birth_date = None;
    let mut diagnostic_reports = Vec::new();
    let mut studies = Vec::new();

    let entries = root
        .get("entry")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::InvalidBundle("Bundle missing entry array".into()))?;

    for entry in entries {
        let Some(res) = entry.get("resource") else {
            continue;
        };
        let Some(res_type) = res.get("resourceType").and_then(Value::as_str) else {
            continue;
        };

        match res_type {
            "Patient" => {
                if let Some(name_obj) = res
                    .get("name")
                    .and_then(Value::as_array)
                    .and_then(|a| a.first())
                {
                    if let Some(text) = name_obj.get("text").and_then(Value::as_str) {
                        patient_name = Some(text.to_string());
                    } else {
                        let family = name_obj.get("family").and_then(Value::as_str).unwrap_or("");
                        let given = name_obj
                            .get("given")
                            .and_then(Value::as_array)
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(Value::as_str)
                                    .collect::<Vec<_>>()
                                    .join(" ")
                            })
                            .unwrap_or_default();
                        let combined = format!("{given} {family}").trim().to_string();
                        if !combined.is_empty() {
                            patient_name = Some(combined);
                        }
                    }
                }
                patient_id = res
                    .get("identifier")
                    .and_then(Value::as_array)
                    .and_then(|a| a.first())
                    .and_then(|id| id.get("value"))
                    .and_then(Value::as_str)
                    .map(String::from);
                patient_birth_date = res.get("birthDate").and_then(Value::as_str).map(String::from);
            }
            "DiagnosticReport" => {
                diagnostic_reports.push(DiagnosticReportSummary {
                    id: res
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("report")
                        .to_string(),
                    status: res
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string(),
                    conclusion: res.get("conclusion").and_then(Value::as_str).map(String::from),
                });
            }
            "ImagingStudy" => {
                if let Some(study) = parse_imaging_study(res)? {
                    for f in &study.files {
                        if studies.iter().any(|st: &StudySummary| st.files.iter().any(|g| g.file_id == f.file_id)) {
                            return Err(Error::InvalidBundle(format!(
                                "file {} is linked from two ImagingStudy resources",
                                f.file_id
                            )));
                        }
                    }
                    studies.push(study);
                }
            }
            _ => {}
        }
    }

    Ok(StudyIndex {
        last_updated,
        patient_name,
        patient_id,
        patient_birth_date,
        diagnostic_reports,
        studies,
    })
}

fn parse_imaging_study(res: &Value) -> Result<Option<StudySummary>> {
    let id = res
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("study")
        .to_string();
    let study_instance_uid = res
        .get("identifier")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())
        .and_then(|ident| ident.get("value"))
        .and_then(Value::as_str)
        .map(|s| s.strip_prefix("urn:oid:").unwrap_or(s).to_string())
        .unwrap_or_else(|| id.clone());

    let description = res.get("description").and_then(Value::as_str).map(String::from);
    let started = res.get("started").and_then(Value::as_str).map(String::from);

    let Some(series_arr) = res.get("series").and_then(Value::as_array) else {
        return Ok(None);
    };
    let study_file = extract_linked_file(res)?;
    let mut own_files = Vec::with_capacity(series_arr.len());
    for se_val in series_arr {
        own_files.push(extract_linked_file(se_val)?);
    }
    // An ImagingStudy without any linked-file is ordinary FHIR, not shared under this profile; one
    // without series shares nothing.
    if series_arr.is_empty() || (study_file.is_none() && own_files.iter().all(Option::is_none)) {
        return Ok(None);
    }
    // A series-level linked-file that names the study's file must give the same key.
    if let Some((sid, skey)) = &study_file {
        if own_files.iter().flatten().any(|(id, key)| id == sid && key != skey) {
            return Err(Error::InvalidBundle(format!("file {sid} is given two keys")));
        }
    }

    // Walk series and instances in array order with a running offset per file (§8.1).
    // `files` holds (file_id, key, running offset) in first-use order.
    let mut files: Vec<(String, String, u64)> = Vec::new();
    let mut file_index: HashMap<String, usize> = HashMap::new();
    let mut pending = Vec::with_capacity(series_arr.len());
    for (se_val, own) in series_arr.iter().zip(own_files) {
        let uid = se_val
            .get("uid")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::InvalidBundle("series missing uid".into()))?
            .to_string();
        let (file_id, key) = own
            .or_else(|| study_file.clone())
            .ok_or_else(|| Error::InvalidBundle(format!("series {uid} has no linked-file")))?;
        let fi = match file_index.get(&file_id) {
            Some(&fi) => {
                if files[fi].1 != key {
                    return Err(Error::InvalidBundle(format!("file {file_id} is given two keys")));
                }
                fi
            }
            None => {
                files.push((file_id.clone(), key, 0));
                file_index.insert(file_id, files.len() - 1);
                files.len() - 1
            }
        };
        let number = se_val.get("number").and_then(Value::as_i64).map(|n| n as i32);
        let modality = se_val
            .get("modality")
            .and_then(|m| m.get("code"))
            .and_then(Value::as_str)
            .map(String::from);
        let se_desc = se_val
            .get("description")
            .and_then(Value::as_str)
            .map(String::from);

        let inst_arr = se_val
            .get("instance")
            .and_then(Value::as_array)
            .ok_or_else(|| Error::InvalidBundle("series missing instance array".into()))?;
        if inst_arr.is_empty() {
            return Err(Error::InvalidBundle(format!("series {uid} lists no instances")));
        }

        let start = files[fi].2;
        let mut offset = start;
        let mut instances = Vec::with_capacity(inst_arr.len());
        for inst_val in inst_arr {
            let length = extract_instance_length(inst_val)?;
            if length == 0 {
                return Err(Error::InvalidBundle("instance length must be > 0".into()));
            }
            let inst_uid = inst_val
                .get("uid")
                .and_then(Value::as_str)
                .ok_or_else(|| Error::InvalidBundle("instance missing uid".into()))?
                .to_string();
            let sop_class = inst_val
                .get("sopClass")
                .and_then(|s| s.get("code"))
                .and_then(Value::as_str)
                .map(|s| s.strip_prefix("urn:oid:").unwrap_or(s).to_string())
                .unwrap_or_default();
            let inst_num = inst_val.get("number").and_then(Value::as_i64).map(|n| n as i32);

            instances.push(InstanceSummary {
                uid: inst_uid,
                sop_class,
                number: inst_num,
                offset,
                length,
                first_record: offset / RECORD_PLAINTEXT,
                last_record: (offset + length - 1) / RECORD_PLAINTEXT,
            });
            offset += length;
        }
        files[fi].2 = offset;
        pending.push((fi, uid, number, modality, se_desc, start, offset - start, instances));
    }

    let file_summaries: Vec<FileSummary> = files
        .into_iter()
        .map(|(file_id, key, p)| FileSummary {
            file_id,
            key,
            plaintext_length: p,
            ciphertext_length: ciphertext_length(p),
            record_count: record_count(p),
        })
        .collect();
    let series_list: Vec<SeriesSummary> = pending
        .into_iter()
        .map(|(fi, uid, number, modality, description, offset, bytes, instances)| SeriesSummary {
            uid,
            number,
            modality,
            description,
            file: file_summaries[fi].clone(),
            offset,
            bytes,
            first_record: offset / RECORD_PLAINTEXT,
            last_record: (offset + bytes - 1) / RECORD_PLAINTEXT,
            instances,
        })
        .collect();

    let number_of_instances = series_list.iter().map(|s| s.instances.len()).sum();
    let number_of_series = series_list.len();

    Ok(Some(StudySummary {
        id,
        study_instance_uid,
        description,
        started,
        number_of_series,
        number_of_instances,
        files: file_summaries,
        series: series_list,
    }))
}

/// The `linked-file` extension on an ImagingStudy or a series, as (file id, key), checked.
fn extract_linked_file(el: &Value) -> Result<Option<(String, String)>> {
    let Some(exts) = el.get("extension").and_then(Value::as_array) else {
        return Ok(None);
    };
    for ext in exts {
        if ext.get("url").and_then(Value::as_str) == Some(EXT_LINKED_FILE) {
            let sub = ext
                .get("extension")
                .and_then(Value::as_array)
                .ok_or_else(|| Error::InvalidBundle("linked-file missing sub-extensions".into()))?;
            let mut file_id = None;
            let mut key = None;
            for item in sub {
                match item.get("url").and_then(Value::as_str) {
                    Some("id") => file_id = item.get("valueString").and_then(Value::as_str).map(String::from),
                    Some("key") => key = item.get("valueString").and_then(Value::as_str).map(String::from),
                    _ => {}
                }
            }
            let file_id = file_id.ok_or_else(|| Error::InvalidBundle("linked-file missing id".into()))?;
            let key = key.ok_or_else(|| Error::InvalidBundle("linked-file missing key".into()))?;
            if file_id.len() != 22 || !file_id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
                return Err(Error::InvalidBundle(format!("bad file id {file_id}")));
            }
            let _ = decode_key_32(&key)?;
            return Ok(Some((file_id, key)));
        }
    }
    Ok(None)
}

fn extract_instance_length(inst_val: &Value) -> Result<u64> {
    let exts = inst_val
        .get("extension")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::InvalidBundle("instance missing extension array".into()))?;
    for ext in exts {
        if ext.get("url").and_then(Value::as_str) == Some(EXT_INSTANCE_LENGTH) {
            if let Some(n) = ext.get("valueDecimal").and_then(Value::as_u64) {
                return Ok(n);
            }
            if let Some(f) = ext.get("valueDecimal").and_then(Value::as_f64) {
                if f > 0.0 && f.fract() == 0.0 {
                    return Ok(f as u64);
                }
            }
        }
    }
    Err(Error::InvalidBundle("instance missing valid instance-length extension".into()))
}

/// A random (version 4) `urn:uuid:` for Bundle.entry.fullUrl.
pub fn random_urn_uuid() -> String {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).expect("random bytes");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("urn:uuid:{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}
