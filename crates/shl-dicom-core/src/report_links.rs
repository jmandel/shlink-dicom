//! Which imaging studies a FHIR DiagnosticReport belongs to. Reports usually come from the clinical
//! record, not the imaging system, so the link is worked out, in this order:
//!
//! 1. **reference**: the report's `imagingStudy.reference`s that resolve to studies (an entry's
//!    fullUrl, "ImagingStudy/<id>", or for studies without a fullUrl, an absolute URL ending in
//!    "/ImagingStudy/<id>"). A report that names several studies (a combined report) belongs to
//!    each. When any reference resolves, the later steps are not tried.
//! 2. **uid**: the report's `imagingStudy.identifier`s naming a study's Study Instance UID; again
//!    every study named.
//! 3. **accession**: a report identifier equals a study's accession number. Inferred, so only
//!    when exactly one study has it; with two or more the report stays unlinked.
//! 4. **date**: the same day, and the report's title or category names one of the study's
//!    modalities. A guess, taken only when exactly one study matches. The Share page never takes
//!    it; the viewer shows it and says it is a guess.
//!
//! A report that matches nothing is unlinked. The viewer's index (`bundle::parse_study_index`),
//! the reader module and the Share page's portal path all use [`link_reports`].

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::bundle::{code_text, study_uid_and_accession, text, DiagnosticReportSummary, StudySummary};

/// A study, as far as linking needs it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkStudy {
    pub id: String,
    #[serde(default)]
    pub full_url: Option<String>,
    #[serde(default)]
    pub study_instance_uid: String,
    #[serde(default)]
    pub accession: Option<String>,
    #[serde(default)]
    pub started: Option<String>,
    #[serde(default)]
    pub modalities: Vec<String>,
}

/// A report, as far as linking needs it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkReport {
    /// `imagingStudy.reference` values, unresolved.
    #[serde(default)]
    pub references: Vec<String>,
    /// Study Instance UIDs from `imagingStudy.identifier` ("urn:oid:" taken off).
    #[serde(default)]
    pub study_uids: Vec<String>,
    /// `identifier` values.
    #[serde(default)]
    pub identifiers: Vec<String>,
    /// effectiveDateTime (or effectivePeriod.start), else issued.
    #[serde(default)]
    pub date: Option<String>,
    /// The title and category text, for the modality words.
    #[serde(default)]
    pub words: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Basis {
    Reference,
    Uid,
    Accession,
    Date,
}

impl Basis {
    pub fn as_str(self) -> &'static str {
        match self {
            Basis::Reference => "reference",
            Basis::Uid => "uid",
            Basis::Accession => "accession",
            Basis::Date => "date",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportLink {
    pub study_id: String,
    pub basis: Basis,
}

impl LinkStudy {
    pub fn of_summary(st: &StudySummary, full_url: Option<String>) -> Self {
        LinkStudy {
            id: st.id.clone(),
            full_url,
            study_instance_uid: st.study_instance_uid.clone(),
            accession: st.accession.clone(),
            started: st.started.clone(),
            modalities: st.modalities.clone(),
        }
    }

    /// From an ImagingStudy resource (a portal's search result: no share files needed).
    pub fn of_fhir(res: &Value, full_url: Option<String>) -> Self {
        let (study_instance_uid, accession) = study_uid_and_accession(res);
        let mut modalities: Vec<String> = Vec::new();
        let codes = res.get("series").and_then(Value::as_array).into_iter().flatten().map(|s| s.get("modality"));
        let top = res.get("modality").and_then(Value::as_array).into_iter().flatten().map(Some);
        for m in codes.chain(top).filter_map(|m| text(m.and_then(|m| m.get("code")))) {
            if !modalities.contains(&m) {
                modalities.push(m);
            }
        }
        LinkStudy { id: text(res.get("id")).unwrap_or_default(), full_url, study_instance_uid, accession, started: text(res.get("started")), modalities }
    }
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array().into_iter().flatten().filter_map(|x| x.as_str().map(String::from)).collect()
}
fn opt(v: &Value) -> Option<String> {
    v.as_str().map(String::from)
}

impl LinkStudy {
    /// From the JSON shape `link_reports` exports take: `{id, fullUrl, studyInstanceUid, accession,
    /// started, modalities}` (all but `id` optional).
    pub fn of_json(v: &Value) -> Self {
        LinkStudy {
            id: v["id"].as_str().unwrap_or_default().to_string(),
            full_url: opt(&v["fullUrl"]),
            study_instance_uid: v["studyInstanceUid"].as_str().unwrap_or_default().to_string(),
            accession: opt(&v["accession"]),
            started: opt(&v["started"]),
            modalities: strs(&v["modalities"]),
        }
    }
}

impl LinkReport {
    /// From `{references, studyUids, identifiers, date, words}` (all optional).
    pub fn of_json(v: &Value) -> Self {
        LinkReport {
            references: strs(&v["references"]),
            study_uids: strs(&v["studyUids"]),
            identifiers: strs(&v["identifiers"]),
            date: opt(&v["date"]),
            words: v["words"].as_str().unwrap_or_default().to_string(),
        }
    }

    /// From a report summary whose `study_ids` are still the raw references.
    pub fn of_summary(r: &DiagnosticReportSummary) -> Self {
        LinkReport {
            references: r.study_ids.clone(),
            study_uids: r.study_uids.clone(),
            identifiers: r.identifiers.iter().map(|i| i.value.clone()).collect(),
            date: r.effective.clone().or_else(|| r.issued.clone()),
            words: [r.title.as_deref(), r.category.as_deref()].into_iter().flatten().collect::<Vec<_>>().join(" "),
        }
    }

    /// From a DiagnosticReport resource: the same fields `bundle::report_of` reads, without its
    /// attachments (so the Share page's module stays small).
    pub fn of_fhir(r: &Value) -> Self {
        let list = |k: &str| r.get(k).and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
        let refs = list("imagingStudy");
        let words = [code_text(r.get("code")), code_text(r.get("category").and_then(|c| c.get(0)))];
        LinkReport {
            references: refs.iter().filter_map(|x| x.get("reference").and_then(Value::as_str)).filter(|s| !s.is_empty()).map(String::from).collect(),
            study_uids: refs
                .iter()
                .filter_map(|x| text(x.get("identifier").and_then(|i| i.get("value"))))
                .map(|v| v.strip_prefix("urn:oid:").unwrap_or(&v).to_string())
                .collect(),
            identifiers: list("identifier").iter().filter_map(|i| text(i.get("value"))).collect(),
            date: text(r.get("effectiveDateTime")).or_else(|| text(r.get("effectivePeriod").and_then(|p| p.get("start")))).or_else(|| text(r.get("issued"))),
            words: words.into_iter().flatten().collect::<Vec<_>>().join(" "),
        }
    }
}

/// Each report's links, in report order (empty: unlinked).
pub fn link_reports(studies: &[LinkStudy], reports: &[LinkReport]) -> Vec<Vec<ReportLink>> {
    reports.iter().map(|r| link_one(studies, r)).collect()
}

fn link_one(studies: &[LinkStudy], r: &LinkReport) -> Vec<ReportLink> {
    let all = |pick: &dyn Fn(&LinkStudy) -> bool, basis: Basis| -> Vec<ReportLink> {
        studies.iter().filter(|st| pick(st)).map(|st| ReportLink { study_id: st.id.clone(), basis }).collect()
    };
    let one = |pick: &dyn Fn(&LinkStudy) -> bool, basis: Basis| -> Vec<ReportLink> {
        let mut hits = studies.iter().filter(|st| pick(st));
        match (hits.next(), hits.next()) {
            (Some(st), None) => vec![ReportLink { study_id: st.id.clone(), basis }],
            _ => Vec::new(),
        }
    };
    let by_ref = all(&|st| r.references.iter().any(|x| resolves(x, st)), Basis::Reference);
    if !by_ref.is_empty() {
        return by_ref;
    }
    let by_uid = all(&|st| !st.study_instance_uid.is_empty() && r.study_uids.contains(&st.study_instance_uid), Basis::Uid);
    if !by_uid.is_empty() {
        return by_uid;
    }
    let ids: Vec<&str> = r.identifiers.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    let has_accession = |st: &LinkStudy| st.accession.as_deref().map(str::trim).is_some_and(|a| !a.is_empty() && ids.contains(&a));
    if studies.iter().any(|st| has_accession(st)) {
        // An accession number names the exam; when two studies share it, it names neither.
        return one(&has_accession, Basis::Accession);
    }
    let Some(d) = r.date.as_deref().and_then(day) else { return Vec::new() };
    let words = r.words.to_ascii_lowercase();
    one(&|st| st.started.as_deref().and_then(day) == Some(d) && st.modalities.iter().any(|m| names_modality(&words, m)), Basis::Date)
}

/// A reference names `st`: its fullUrl, "ImagingStudy/<id>", or, for a study known only by id (a
/// portal's search result), any URL ending in "/ImagingStudy/<id>".
fn resolves(reference: &str, st: &LinkStudy) -> bool {
    if st.id.is_empty() || reference.is_empty() {
        return false;
    }
    if st.full_url.as_deref() == Some(reference) {
        return true;
    }
    let tail = format!("ImagingStudy/{}", st.id);
    reference == tail || (st.full_url.is_none() && reference.ends_with(&format!("/{tail}")))
}

fn day(s: &str) -> Option<&str> {
    let d = s.get(..10)?;
    let b = d.as_bytes();
    (b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })).then_some(d)
}

/// `w` occurs in `text` as a whole word (between non-word characters, as a regex `\b` does).
fn has_word(text: &str, w: &str) -> bool {
    let is_word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let b = text.as_bytes();
    text.match_indices(w).any(|(i, _)| (i == 0 || !is_word(b[i - 1])) && b.get(i + w.len()).is_none_or(|c| !is_word(*c)))
}

/// Whether lower-cased report words name modality `m`.
fn names_modality(words: &str, m: &str) -> bool {
    let any = |subs: &[&str], whole: &[&str]| subs.iter().any(|s| words.contains(s)) || whole.iter().any(|w| has_word(words, w));
    match m {
        "CT" => any(&["computed tomograph"], &["ct"]),
        "MR" => any(&["magnetic resonance"], &["mr", "mri"]),
        "CR" | "DX" => any(&["radiograph"], &["x-ray", "xray", "xr"]),
        "US" => any(&["ultraso"], &["us"]),
        "NM" => any(&["nuclear"], &["nm"]),
        "PT" => any(&[], &["pet"]),
        "MG" => any(&["mammo"], &[]),
        "SM" => any(&["patholog", "histolog", "slide", "biopsy"], &[]),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(id: &str, uid: &str, acc: Option<&str>, started: Option<&str>, m: &[&str]) -> LinkStudy {
        LinkStudy {
            id: id.into(),
            full_url: Some(format!("urn:uuid:{id}")),
            study_instance_uid: uid.into(),
            accession: acc.map(Into::into),
            started: started.map(Into::into),
            modalities: m.iter().map(|s| s.to_string()).collect(),
        }
    }
    fn links(v: &[ReportLink]) -> Vec<(&str, &str)> {
        v.iter().map(|l| (l.study_id.as_str(), l.basis.as_str())).collect()
    }

    #[test]
    fn explicit_links_keep_every_study_and_inferred_ones_need_a_single_match() {
        let studies = [st("a", "1.1", Some("ACC"), Some("2024-03-01"), &["CT"]), st("b", "1.2", Some("ACC"), Some("2024-03-01"), &["CT"]), st("c", "1.3", None, Some("2024-03-02"), &["MR"])];
        let rep = |f: &dyn Fn(&mut LinkReport)| {
            let mut r = LinkReport::default();
            f(&mut r);
            r
        };
        let reports = [
            rep(&|r| r.references = vec!["urn:uuid:a".into(), "ImagingStudy/b".into()]),
            rep(&|r| r.study_uids = vec!["1.2".into(), "1.3".into()]),
            rep(&|r| r.identifiers = vec!["ACC".into()]),
            rep(&|r| {
                r.date = Some("2024-03-02T10:00:00Z".into());
                r.words = "Brain MRI".into();
            }),
            rep(&|r| {
                r.date = Some("2024-03-01".into());
                r.words = "CT chest".into();
            }),
            rep(&|r| {
                r.references = vec!["ImagingStudy/zz".into()];
                r.study_uids = vec!["1.3".into()];
            }),
        ];
        let got = link_reports(&studies, &reports);
        assert_eq!(links(&got[0]), [("a", "reference"), ("b", "reference")]);
        assert_eq!(links(&got[1]), [("b", "uid"), ("c", "uid")]);
        assert!(got[2].is_empty(), "two studies share the accession");
        assert_eq!(links(&got[3]), [("c", "date")]);
        assert!(got[4].is_empty(), "two CT studies that day");
        assert_eq!(links(&got[5]), [("c", "uid")], "an unresolved reference falls through to the UID");
    }

    #[test]
    fn portal_studies_resolve_absolute_references() {
        let s = LinkStudy { id: "42".into(), ..Default::default() };
        let r = LinkReport { references: vec!["https://img.example/fhir/ImagingStudy/42".into()], ..Default::default() };
        assert_eq!(links(&link_reports(&[s], &[r])[0]), [("42", "reference")]);
    }

    #[test]
    fn a_fhir_report_reads_as_its_summary_does() {
        let r = serde_json::json!({
            "resourceType": "DiagnosticReport", "id": "x", "code": { "text": "CT chest" }, "category": [{ "coding": [{ "display": "Radiology" }] }],
            "imagingStudy": [{ "reference": "ImagingStudy/a" }, { "identifier": { "value": "urn:oid:1.2" } }],
            "identifier": [{ "value": "ACC" }, { "value": " " }], "issued": "2024-01-02T00:00:00Z",
            "presentedForm": [{ "contentType": "text/plain", "data": "aGk=" }]
        });
        let a = LinkReport::of_fhir(&r);
        let b = LinkReport::of_summary(&crate::bundle::report_of(&r, 0));
        assert_eq!(serde_json::to_value(&a).unwrap(), serde_json::to_value(&b).unwrap());
    }

    #[test]
    fn modality_words_are_whole_words() {
        assert!(names_modality("x-ray chest", "DX") && names_modality("ct abdomen", "CT") && !names_modality("ctx", "CT"));
        assert!(!names_modality("focus", "US") && names_modality("us pelvis", "US") && names_modality("mammography", "MG"));
    }
}
