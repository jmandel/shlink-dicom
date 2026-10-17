//! One patient per share (spec/README.md §11.1 step 4): the Bundle's Patient comes from the studies the
//! share includes, and studies of two different people are not packed together unless the sharer
//! says they are the same person. The CLI's pack, the server's seed and the Share page (through
//! shl-dicom-wasm) use this one rule.
//!
//! Two instances name different people when both have a family name and the family names differ
//! (compared after trimming, collapsing runs of spaces and ignoring case), or when both have a
//! birth date and the dates differ. Given names, middle names and Patient IDs never count: one
//! person's records from two sites often spell a given name differently or carry two MRNs.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::bundle::PatientInput;

/// What the rule reads from one instance's header.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PatientMeta {
    /// Patient's Name (0010,0010), DICOM PN.
    pub name: Option<String>,
    /// Patient's Birth Date (0010,0030), DA.
    pub birth_date: Option<String>,
    /// Patient ID (0010,0020) and Issuer of Patient ID (0010,0021).
    pub id: Option<String>,
    pub issuer: Option<String>,
}

/// Two instances that name different people: each one's name and birth date as the files give them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatientConflict {
    pub first: (Option<String>, Option<String>),
    pub other: (Option<String>, Option<String>),
}

impl std::fmt::Display for PatientConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let show = |(n, d): &(Option<String>, Option<String>)| {
            format!("{}, born {}", n.as_deref().unwrap_or("no name"), d.as_deref().unwrap_or("unknown"))
        };
        write!(f, "these files are for more than one patient ({} and {}); include one patient's studies", show(&self.first), show(&self.other))
    }
}

fn text(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// The family name as the rule compares it: the first PN component, trimmed, single-spaced, upper case.
fn family(pn: &str) -> Option<String> {
    let f = pn.split('=').next()?.split('^').next()?;
    let f = f.split_whitespace().collect::<Vec<_>>().join(" ").to_uppercase();
    (!f.is_empty()).then_some(f)
}

/// The first two records, in order, that name different people; None when they all agree.
pub fn find_conflict(records: &[PatientMeta]) -> Option<PatientConflict> {
    let rec = |m: &PatientMeta| (text(&m.name).map(String::from), text(&m.birth_date).map(String::from));
    let mut by_family: Option<(String, &PatientMeta)> = None;
    let mut by_birth: Option<(&str, &PatientMeta)> = None;
    for m in records {
        if let Some(f) = text(&m.name).and_then(family) {
            match &by_family {
                Some((g, first)) if *g != f => return Some(PatientConflict { first: rec(first), other: rec(m) }),
                Some(_) => {}
                None => by_family = Some((f, m)),
            }
        }
        if let Some(d) = text(&m.birth_date) {
            match by_birth {
                Some((e, first)) if e != d => return Some(PatientConflict { first: rec(first), other: rec(m) }),
                Some(_) => {}
                None => by_birth = Some((d, m)),
            }
        }
    }
    None
}

/// The Bundle's Patient from the included instances, in Bundle order: the first name and the first
/// birth date, and every distinct Patient ID (with its issuer) as an identifier. Refuses records
/// that name different people unless `same_patient` (the sharer said they are one person).
pub fn patient_from(records: &[PatientMeta], same_patient: bool) -> Result<PatientInput, PatientConflict> {
    if !same_patient {
        if let Some(c) = find_conflict(records) {
            return Err(c);
        }
    }
    let mut p = PatientInput {
        dicom_name: records.iter().find_map(|m| text(&m.name).map(String::from)),
        birth_date: records.iter().find_map(|m| text(&m.birth_date).map(String::from)),
        ..Default::default()
    };
    let mut seen: Vec<(Option<&str>, &str)> = Vec::new();
    for m in records {
        let Some(id) = text(&m.id) else { continue };
        let key = (text(&m.issuer), id);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let mut ident = json!({ "value": id });
        if let Some(issuer) = key.0 {
            ident["assigner"] = json!({ "display": issuer });
        }
        p.identifiers.push(ident);
    }
    Ok(p)
}

/// [`patient_from`] as JSON for shl-dicom-wasm: `{"patient": PatientInput}` or `{"conflict": ...}`.
pub fn patient_json(records: &[PatientMeta], same_patient: bool) -> Value {
    match patient_from(records, same_patient) {
        Ok(p) => json!({ "patient": {
            "dicomName": p.dicom_name,
            "birthDate": p.birth_date,
            "identifiers": p.identifiers,
        } }),
        Err(c) => json!({ "conflict": c, "message": c.to_string() }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(name: &str, birth: &str, id: &str) -> PatientMeta {
        let o = |s: &str| (!s.is_empty()).then(|| s.to_string());
        PatientMeta { name: o(name), birth_date: o(birth), id: o(id), issuer: None }
    }

    #[test]
    fn two_people_conflict_and_one_person_does_not() {
        let ann = m("ALPHA^ANN", "19700101", "A-1");
        let bob = m("BETA^BOB", "19700101", "B-2");
        let c = find_conflict(&[ann.clone(), bob.clone()]).expect("two family names");
        assert_eq!(c.first.0.as_deref(), Some("ALPHA^ANN"));
        assert_eq!(c.other.0.as_deref(), Some("BETA^BOB"));
        assert!(patient_from(&[ann.clone(), bob.clone()], false).is_err());
        // A birth date differs.
        assert!(find_conflict(&[m("ALPHA^ANN", "19700101", ""), m("ALPHA^ANN", "19710101", "")]).is_some());
        // A given-name variant, another MRN, case and spacing: the same person.
        let same = [m("EXAMPLE^JOSH", "19800202", "MRN-1"), m("example  ^JOSHUA", "19800202", "MRN-9"), m("", "", "")];
        assert_eq!(find_conflict(&same), None);
        let p = patient_from(&same, false).unwrap();
        assert_eq!(p.dicom_name.as_deref(), Some("EXAMPLE^JOSH"));
        assert_eq!(p.identifiers, vec![json!({ "value": "MRN-1" }), json!({ "value": "MRN-9" })]);
    }

    #[test]
    fn the_sharer_can_say_two_records_are_one_person() {
        let p = patient_from(&[m("ALPHA^ANN", "19700101", "A-1"), m("ALPHA-BETA^ANN", "19700101", "A-1")], true).unwrap();
        assert_eq!((p.dicom_name.as_deref(), p.birth_date.as_deref()), (Some("ALPHA^ANN"), Some("19700101")));
        assert_eq!(p.identifiers.len(), 1);
    }
}
