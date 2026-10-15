use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::{
    crypto::decode_key_32,
    range::{ciphertext_length, record_count, RECORD_PLAINTEXT},
    Error, Result,
};

pub const PROFILE_URL: &str = "https://example.org/shl-dicom/v1";
pub const EXT_SERIES_FILE: &str = "https://example.org/shl-dicom/series-file";
pub const EXT_LENGTH: &str = "https://example.org/shl-dicom/length";

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
    pub series: Vec<SeriesSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesSummary {
    pub uid: String,
    pub number: Option<i32>,
    pub modality: Option<String>,
    pub description: Option<String>,
    pub file_id: String,
    pub key: String,
    pub plaintext_length: u64,
    pub ciphertext_length: u64,
    pub record_count: u64,
    pub instances: Vec<InstanceSummary>,
}

impl SeriesSummary {
    pub fn key_bytes(&self) -> Result<[u8; 32]> {
        decode_key_32(&self.key)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceSummary {
    pub uid: String,
    pub sop_class: String,
    pub number: Option<i32>,
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
    pub series: Vec<SeriesBuildInput>,
}

#[derive(Debug, Clone)]
pub struct SeriesBuildInput {
    pub uid: String,
    pub number: Option<i32>,
    pub modality: Option<String>,
    pub description: Option<String>,
    pub file_id: String,
    pub key_b64: String,
    pub instances: Vec<InstanceBuildInput>,
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
                                "url": EXT_LENGTH,
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
                    "extension": [{
                        "url": EXT_SERIES_FILE,
                        "extension": [
                            { "url": "id", "valueString": se.file_id },
                            { "url": "key", "valueString": se.key_b64 }
                        ]
                    }],
                    "uid": se.uid,
                    "modality": {
                        "system": "http://dicom.nema.org/resources/ontology/DCM",
                        "code": modality_code,
                    },
                    "numberOfInstances": se.instances.len(),
                    "instance": instances_json,
                });
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

/// Builds a link-specific FHIR R4 Bundle from an owner's full Bundle by keeping only
/// the series whose `fileId` is in `selected_file_ids` (or all series if `selected_file_ids` is empty).
/// Updates `numberOfSeries`, `numberOfInstances`, and adds a partial-study `note` if series were filtered.
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

    let mut new_entries = Vec::new();
    for entry in entries {
        let Some(res) = entry.get("resource") else {
            continue;
        };
        let res_type = res.get("resourceType").and_then(Value::as_str).unwrap_or("");
        if res_type != "ImagingStudy" {
            new_entries.push(entry.clone());
            continue;
        }

        let Some(series_arr) = res.get("series").and_then(Value::as_array) else {
            continue;
        };
        let orig_series_count = series_arr.len();
        let mut kept_series = Vec::new();
        let mut kept_instances = 0usize;

        for se in series_arr {
            if let Some((fid, _)) = extract_series_file_ext(se)? {
                if selected_file_ids.iter().any(|s| s == &fid) {
                    let inst_count = se
                        .get("instance")
                        .and_then(Value::as_array)
                        .map(|a| a.len())
                        .unwrap_or(0);
                    kept_instances += inst_count;
                    kept_series.push(se.clone());
                }
            }
        }

        if kept_series.is_empty() {
            continue;
        }

        let mut new_study = res.clone();
        new_study["numberOfSeries"] = json!(kept_series.len());
        new_study["numberOfInstances"] = json!(kept_instances);
        new_study["series"] = json!(kept_series);
        if kept_series.len() < orig_series_count {
            new_study["note"] = json!([{
                "text": format!(
                    "Partial study: {} of {} series shared in this link.",
                    kept_series.len(),
                    orig_series_count
                )
            }]);
        }

        let mut new_entry = entry.clone();
        new_entry["resource"] = new_study;
        new_entries.push(new_entry);
    }

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

    let mut series_list = Vec::new();
    for se_val in series_arr {
        let Some((file_id, key)) = extract_series_file_ext(se_val)? else {
            continue;
        };
        let uid = se_val
            .get("uid")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::InvalidBundle("series missing uid".into()))?
            .to_string();
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

        let mut offset = 0u64;
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

            let first_record = offset / RECORD_PLAINTEXT;
            let last_record = (offset + length - 1) / RECORD_PLAINTEXT;

            instances.push(InstanceSummary {
                uid: inst_uid,
                sop_class,
                number: inst_num,
                offset,
                length,
                first_record,
                last_record,
            });
            offset += length;
        }

        let plaintext_length = offset;
        let ciphertext_len = ciphertext_length(plaintext_length);
        let rec_count = record_count(plaintext_length);

        series_list.push(SeriesSummary {
            uid,
            number,
            modality,
            description: se_desc,
            file_id,
            key,
            plaintext_length,
            ciphertext_length: ciphertext_len,
            record_count: rec_count,
            instances,
        });
    }

    if series_list.is_empty() {
        return Ok(None);
    }

    let number_of_instances = series_list.iter().map(|s| s.instances.len()).sum();
    let number_of_series = series_list.len();

    Ok(Some(StudySummary {
        id,
        study_instance_uid,
        description,
        started,
        number_of_series,
        number_of_instances,
        series: series_list,
    }))
}

fn extract_series_file_ext(se_val: &Value) -> Result<Option<(String, String)>> {
    let Some(exts) = se_val.get("extension").and_then(Value::as_array) else {
        return Ok(None);
    };
    for ext in exts {
        if ext.get("url").and_then(Value::as_str) == Some(EXT_SERIES_FILE) {
            let sub = ext
                .get("extension")
                .and_then(Value::as_array)
                .ok_or_else(|| Error::InvalidBundle("series-file missing sub-extensions".into()))?;
            let mut file_id = None;
            let mut key = None;
            for item in sub {
                match item.get("url").and_then(Value::as_str) {
                    Some("id") => file_id = item.get("valueString").and_then(Value::as_str).map(String::from),
                    Some("key") => key = item.get("valueString").and_then(Value::as_str).map(String::from),
                    _ => {}
                }
            }
            let file_id = file_id.ok_or_else(|| Error::InvalidBundle("series-file missing id".into()))?;
            let key = key.ok_or_else(|| Error::InvalidBundle("series-file missing key".into()))?;
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
        if ext.get("url").and_then(Value::as_str) == Some(EXT_LENGTH) {
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
    Err(Error::InvalidBundle("instance missing valid length extension".into()))
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
