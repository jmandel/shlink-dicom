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
/// The largest instance length, and the largest plaintext of a file, a Bundle may give: 2^53 − 1,
/// the largest integer JavaScript readers handle exactly (Number.isSafeInteger), far above any
/// real study.
pub const MAX_FILE_BYTES: u64 = (1 << 53) - 1;

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

/// One encrypted file (`{file_id}.bin`): its key and lengths (spec/README.md §8.1, §9.2).
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

/// Everything an owner Bundle is built from (spec/README.md §8, §11.1). The CLI's pack, the
/// server's seed and the Share page (through shl-dicom-wasm, as JSON) all build it with
/// [`build_fhir_bundle`].
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BundleBuildInput {
    pub last_updated: String,
    pub patient: PatientInput,
    /// In Bundle order (see `order`); each gets the id `study-{n}`.
    pub studies: Vec<StudyBuildInput>,
    /// DiagnosticReports that name no study, as their source gave them. A link carries one only
    /// when the sharer picks it (`LinkSelection`).
    pub loose_reports: Vec<Value>,
}

/// The patient, from DICOM or from a FHIR source.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PatientInput {
    /// Patient's Name (0010,0010) as DICOM PN: family^given^middle^prefix^suffix.
    pub dicom_name: Option<String>,
    /// A FHIR HumanName from a FHIR source, used as it is (instead of `dicom_name`).
    pub fhir_name: Option<Value>,
    /// DICOM DA (YYYYMMDD) or FHIR date.
    pub birth_date: Option<String>,
    /// FHIR Identifiers (a DICOM Patient ID is `{"value": id}`).
    pub identifiers: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyBuildInput {
    pub study_instance_uid: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Study Date (DA) or an ISO date.
    #[serde(default)]
    pub started: Option<String>,
    /// Accession Number (0008,0050), written as an ImagingStudy identifier of type ACSN.
    #[serde(default)]
    pub accession: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    /// The study's file, written as `linked-file` on the ImagingStudy.
    pub file: LinkedFileInput,
    pub series: Vec<SeriesBuildInput>,
    /// The study's DiagnosticReports, as their source gave them.
    #[serde(default)]
    pub reports: Vec<Value>,
    /// Images the packer re-encoded without loss, for the owner's Provenance (links leave it out).
    #[serde(default)]
    pub reencoded: Option<Reencoded>,
}

/// A note that some of a study's images were re-encoded without loss (spec/README.md §11.1).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reencoded {
    pub images: usize,
    pub of: usize,
    /// The encodings' names ("JPEG Lossless", "JPEG 2000 Lossless").
    pub encodings: Vec<String>,
    /// Who re-encoded them ("shlink-dicom Share page").
    pub agent: String,
}

/// The Provenance text the owner page shows for a study's re-encoded images.
pub fn reencoded_text(r: &Reencoded) -> String {
    format!(
        "{} of {} images were compressed without loss when shared ({}): pixel-identical to the files they came from, not the same bytes.",
        r.images,
        r.of,
        r.encodings.join(" and ")
    )
}

/// DiagnosticReport elements a Bundle keeps from a report's source; the rest (contained
/// resources, references into the source system) do not travel.
const REPORT_KEEP: [&str; 11] = [
    "status", "category", "code", "effectiveDateTime", "effectivePeriod", "issued", "conclusion", "conclusionCode", "presentedForm", "text", "identifier",
];

/// A `linked-file`: the file id and its base64url key.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedFileInput {
    pub file_id: String,
    pub key_b64: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesBuildInput {
    pub uid: String,
    #[serde(default)]
    pub number: Option<i32>,
    #[serde(default)]
    pub modality: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// A file of the series' own (a series added to the study later); None for the study's file.
    #[serde(default)]
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceBuildInput {
    pub uid: String,
    pub sop_class_uid: String,
    #[serde(default)]
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

/// A DICOM PN (first component group: family^given^middle^prefix^suffix) as a FHIR HumanName.
/// `text` is the name as people read it: given and middle names, then the family name, each word
/// capitalised ("DOE^JOHN^Q" -> "John Q Doe"); the components keep their own case.
pub fn human_name_from_pn(pn: &str) -> Option<Value> {
    let group = pn.split('=').next().unwrap_or("").trim();
    if group.is_empty() {
        return None;
    }
    if !group.contains('^') {
        return Some(json!({ "text": group }));
    }
    let c: Vec<&str> = group.split('^').map(str::trim).collect();
    let at = |i: usize| c.get(i).copied().filter(|s| !s.is_empty());
    let title = |w: &str| {
        w.split(' ')
            .filter(|t| !t.is_empty())
            .map(|t| {
                let mut ch = t.chars();
                ch.next().map(|f| f.to_uppercase().chain(ch.flat_map(char::to_lowercase)).collect::<String>()).unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join(" ")
    };
    let given: Vec<&str> = [at(1), at(2)].into_iter().flatten().collect();
    let shown: Vec<String> = given.iter().map(|g| title(g)).chain(at(0).map(title)).collect();
    let mut name = json!({ "text": shown.join(" ") });
    if let Some(f) = at(0) {
        name["family"] = json!(f);
    }
    if !given.is_empty() {
        name["given"] = json!(given);
    }
    if let Some(p) = at(3) {
        name["prefix"] = json!([p]);
    }
    if let Some(sx) = at(4) {
        name["suffix"] = json!([sx]);
    }
    Some(name)
}

/// A report as a Bundle carries it: the kept elements, the Bundle's Patient, and (for a study's
/// report) the study it belongs to, by fullUrl and by Study Instance UID.
fn report_entry(source: &Value, id: String, study: Option<(&str, &str)>) -> Value {
    let mut dr = json!({ "resourceType": "DiagnosticReport", "id": id });
    for k in REPORT_KEEP {
        if let Some(v) = source.get(k) {
            dr[k] = v.clone();
        }
    }
    // Attachments keep their inline data only: a `url` would point recipients at the source system
    // (a portal, or wherever the source said), so it is dropped, and an attachment with no data is
    // left out.
    if let Some(forms) = dr.get("presentedForm").and_then(Value::as_array) {
        let kept: Vec<Value> = forms
            .iter()
            .filter(|a| a.get("data").is_some_and(|d| !d.is_null()))
            .map(|a| {
                let mut a = a.clone();
                if let Some(o) = a.as_object_mut() {
                    o.remove("url");
                }
                a
            })
            .collect();
        let o = dr.as_object_mut().unwrap();
        if kept.is_empty() {
            o.remove("presentedForm");
        } else {
            o.insert("presentedForm".into(), Value::Array(kept));
        }
    }
    dr["subject"] = json!({ "reference": "Patient/p1" });
    if let Some((url, uid)) = study {
        dr["imagingStudy"] = json!([{ "reference": url, "identifier": { "system": "urn:dicom:uid", "value": format!("urn:oid:{uid}") } }]);
    }
    json!({ "fullUrl": random_urn_uuid(), "resource": dr })
}

/// The owner Bundle: Patient, then for each study its ImagingStudy (id `study-{n}`), a
/// Provenance when images were re-encoded, and its reports (ids `report-{n}`); then the reports
/// that name no study.
/// Refuses an instance of length 0: it names no bytes, so a Bundle listing it is wrong (a byte
/// source that was lost before packing, for example).
pub fn build_fhir_bundle(input: &BundleBuildInput) -> Result<Value> {
    for st in &input.studies {
        for inst in st.series.iter().flat_map(|se| &se.instances) {
            if inst.length == 0 {
                return Err(Error::InvalidBundle(format!("instance {} has length 0", inst.uid)));
            }
        }
    }
    let mut entries = Vec::new();

    let mut patient = json!({
        "resourceType": "Patient",
        "id": "p1",
    });
    let p = &input.patient;
    if let Some(name) = p.fhir_name.clone().or_else(|| p.dicom_name.as_deref().and_then(human_name_from_pn)) {
        patient["name"] = json!([name]);
    }
    if !p.identifiers.is_empty() {
        patient["identifier"] = json!(p.identifiers);
    }
    if let Some(ref dob) = p.birth_date.as_deref().and_then(format_dicom_date) {
        patient["birthDate"] = json!(dob);
    }

    entries.push(json!({
        "fullUrl": random_urn_uuid(),
        "resource": patient,
    }));

    let mut report_n = 0;
    for (study_n, study) in input.studies.iter().enumerate() {
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
            "id": format!("study-{}", study_n + 1),
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

        let study_url = random_urn_uuid();
        entries.push(json!({
            "fullUrl": study_url,
            "resource": study_res,
        }));
        if let Some(r) = study.reencoded.as_ref().filter(|r| r.images > 0) {
            entries.push(json!({
                "fullUrl": random_urn_uuid(),
                "resource": {
                    "resourceType": "Provenance",
                    "target": [{ "reference": study_url }],
                    "recorded": input.last_updated,
                    "activity": {
                        "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/v3-DataOperation", "code": "TRANSFORM" }],
                        "text": reencoded_text(r),
                    },
                    "agent": [{ "who": { "display": r.agent } }],
                },
            }));
        }
        let uid = study.study_instance_uid.trim_start_matches("urn:oid:");
        for r in &study.reports {
            report_n += 1;
            entries.push(report_entry(r, format!("report-{report_n}"), Some((&study_url, uid))));
        }
    }
    for r in &input.loose_reports {
        report_n += 1;
        entries.push(report_entry(r, format!("report-{report_n}"), None));
    }

    Ok(json!({
        "resourceType": "Bundle",
        "meta": {
            "lastUpdated": input.last_updated,
        },
        "type": "collection",
        "entry": entries,
    }))
}

/// What a link carries (spec/README.md §8.2): whole studies, by ImagingStudy id, and the reports
/// that name no study which the sharer picked, by DiagnosticReport id. A study's reports go with it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LinkSelection {
    pub studies: Vec<String>,
    pub loose_reports: Vec<String>,
}

impl LinkSelection {
    /// Every study and every report of `owner`.
    pub fn everything(owner: &Value) -> Self {
        let mut sel = Self::default();
        for e in owner.get("entry").and_then(Value::as_array).into_iter().flatten() {
            let r = &e["resource"];
            let id = r["id"].as_str().unwrap_or_default().to_string();
            match r["resourceType"].as_str() {
                Some("ImagingStudy") => sel.studies.push(id),
                Some("DiagnosticReport") if report_refs(r).is_empty() => sel.loose_reports.push(id),
                _ => {}
            }
        }
        sel
    }
}

/// A link's Bundle and the files it needs (`{fileId}.bin`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkBundle {
    pub bundle: Value,
    pub allowed_files: Vec<String>,
}

fn report_refs(r: &Value) -> Vec<&str> {
    r.get("imagingStudy")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.get("reference").and_then(Value::as_str)).collect())
        .unwrap_or_default()
}

/// The link's Bundle: the owner Bundle cut down to the selected studies, whole, with their
/// reports and the picked reports that name no study, and without the owner's Provenance. A
/// study keeps a study-level `linked-file` only when one of its series uses it, so a link carries
/// no key for a file it does not serve.
pub fn subset_bundle(owner: &Value, sel: &LinkSelection, last_updated: &str) -> Result<LinkBundle> {
    let entries = owner
        .get("entry")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::InvalidBundle("owner Bundle missing entry array".into()))?;
    let is = |e: &Value, t: &str| e["resource"]["resourceType"] == t;
    let kept: Vec<&Value> = entries.iter().filter(|e| is(e, "ImagingStudy") && sel.studies.iter().any(|id| e["resource"]["id"] == id.as_str())).collect();
    for id in &sel.studies {
        if !kept.iter().any(|e| e["resource"]["id"] == id.as_str()) {
            return Err(Error::InvalidBundle(format!("no ImagingStudy {id} in the owner Bundle")));
        }
    }
    let kept_urls: Vec<&str> = kept.iter().filter_map(|e| e["fullUrl"].as_str()).collect();
    let mut out = Vec::new();
    let mut files: Vec<String> = Vec::new();
    for e in entries {
        let r = &e["resource"];
        match r["resourceType"].as_str() {
            Some("ImagingStudy") => {
                if !kept.iter().any(|k| std::ptr::eq(*k, e)) {
                    continue;
                }
                let study_file = extract_linked_file(r)?;
                let mut study_file_used = false;
                for se in r["series"].as_array().into_iter().flatten() {
                    let own = extract_linked_file(se)?;
                    study_file_used |= own.is_none();
                    if let Some((id, _)) = own.or_else(|| study_file.clone()) {
                        let name = format!("{id}.bin");
                        if !files.contains(&name) {
                            files.push(name);
                        }
                    }
                }
                let mut e = e.clone();
                if !study_file_used {
                    let res = &mut e["resource"];
                    if let Some(exts) = res.get_mut("extension").and_then(Value::as_array_mut) {
                        exts.retain(|x| x.get("url").and_then(Value::as_str) != Some(EXT_LINKED_FILE));
                        if exts.is_empty() {
                            res.as_object_mut().unwrap().remove("extension");
                        }
                    }
                }
                out.push(e);
            }
            Some("DiagnosticReport") => {
                let refs = report_refs(r);
                let keep = if refs.is_empty() {
                    sel.loose_reports.iter().any(|id| r["id"] == id.as_str())
                } else {
                    refs.iter().any(|x| {
                        kept_urls.contains(x)
                            || x.rsplit_once("ImagingStudy/").is_some_and(|(_, id)| sel.studies.iter().any(|s| s == id))
                    })
                };
                if keep {
                    out.push(e.clone());
                }
            }
            // The owner's record of re-encoding; links leave it out.
            Some("Provenance") => {}
            _ => out.push(e.clone()),
        }
    }
    let mut bundle = owner.clone();
    if !bundle["meta"].is_object() {
        bundle["meta"] = json!({});
    }
    bundle["meta"]["lastUpdated"] = json!(last_updated);
    bundle["entry"] = json!(out);
    Ok(LinkBundle { bundle, allowed_files: files })
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
            if length == 0 || length > MAX_FILE_BYTES {
                return Err(Error::InvalidBundle(format!("instance length {length} is not 1 to {MAX_FILE_BYTES}")));
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

            // A file's instances end to end may not pass MAX_FILE_BYTES either.
            let end = offset
                .checked_add(length)
                .filter(|&e| e <= MAX_FILE_BYTES)
                .ok_or_else(|| Error::InvalidBundle(format!("file {} would pass {MAX_FILE_BYTES} bytes", files[fi].0)))?;
            instances.push(InstanceSummary {
                uid: inst_uid,
                sop_class,
                number: inst_num,
                offset,
                length,
                first_record: offset / RECORD_PLAINTEXT,
                last_record: (end - 1) / RECORD_PLAINTEXT,
            });
            offset = end;
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
