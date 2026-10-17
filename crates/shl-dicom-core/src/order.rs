//! How a share's instances are grouped and ordered (spec/README.md §11.1 step 5), the one rule the
//! CLI's pack, the server's seed and the Share page (through shl-dicom-wasm) use:
//!
//! - instances are grouped by Study Instance UID, then Series Instance UID;
//! - studies are ordered by Study Date and Study Time, newest first, then by Study Instance UID;
//!   studies without a date come last. The order does not depend on the order files were read
//!   in, and it is how portals and viewers list a patient's studies;
//! - each study's series by Series Number (none: last; the smallest when its instances differ),
//!   then Series Instance UID;
//! - each series' instances by Instance Number (none: last), then SOP Instance UID;
//! - a SOP Instance UID is packed once: the first copy in that order is kept, and when two copies
//!   tie (same series and Instance Number) the one whose bytes have the smaller SHA-256. The
//!   others are reported as skipped, "duplicate SOP Instance UID".
//!
//! UIDs compare as bytes. A Study, Series or study-level value (description, date, accession) is
//! taken from the first instance, in this order, that has it.
use std::cmp::Ordering;
use serde::{Deserialize, Serialize};

/// What the ordering reads from one instance's header.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InstanceMeta {
    pub study_uid: String,
    pub series_uid: String,
    pub sop_uid: String,
    /// Study Date (DA, YYYYMMDD) and Study Time (TM), as in the header.
    pub study_date: Option<String>,
    pub study_time: Option<String>,
    pub series_number: Option<i32>,
    pub instance_number: Option<i32>,
    /// SHA-256 of the file's bytes (hex). Needed only to break a tie between two copies of one
    /// SOP Instance UID; [`group`] lists the instances it needs it for.
    pub sha256: Option<String>,
}

/// A study's series, each a list of indices into the input, in order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupedStudy {
    pub uid: String,
    pub series: Vec<GroupedSeries>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupedSeries {
    pub uid: String,
    pub instances: Vec<usize>,
}

/// The grouping of a share's instances.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grouped {
    pub studies: Vec<GroupedStudy>,
    /// Copies left out: (index, index of the copy kept).
    pub duplicates: Vec<(usize, usize)>,
    /// Instances whose `sha256` is needed to choose between copies that tie; when not empty,
    /// [`group`] is to be called again with them filled in. The grouping is otherwise complete,
    /// with the lowest index kept for each tie.
    pub need_sha256: Vec<usize>,
}

/// The reason a duplicate is skipped.
pub const DUPLICATE_REASON: &str = "duplicate SOP Instance UID";

fn opt_num(n: Option<i32>) -> i64 {
    n.map(i64::from).unwrap_or(i64::MAX)
}

fn trimmed(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// Groups and orders `metas` (see the module documentation).
pub fn group(metas: &[InstanceMeta]) -> Grouped {
    // A series' number: the smallest its instances give (they should all give the same), so a
    // series stays in one piece.
    let mut series_number: std::collections::HashMap<(&str, &str), i64> = std::collections::HashMap::new();
    for m in metas {
        let n = series_number.entry((&m.study_uid, &m.series_uid)).or_insert(i64::MAX);
        *n = (*n).min(opt_num(m.series_number));
    }
    let within = |i: usize| {
        let m = &metas[i];
        (series_number[&(m.study_uid.as_str(), m.series_uid.as_str())], m.series_uid.as_bytes(), opt_num(m.instance_number), m.sop_uid.as_bytes())
    };
    // Each study's date and time: its first instance's (by series, then instance) that has a date.
    let mut idx: Vec<usize> = (0..metas.len()).collect();
    idx.sort_by(|&a, &b| metas[a].study_uid.as_bytes().cmp(metas[b].study_uid.as_bytes()).then(within(a).cmp(&within(b))).then(a.cmp(&b)));
    let mut when: std::collections::HashMap<&str, (String, String)> = std::collections::HashMap::new();
    for &i in &idx {
        let m = &metas[i];
        if let (false, Some(d)) = (when.contains_key(m.study_uid.as_str()), trimmed(&m.study_date)) {
            when.insert(&m.study_uid, (d.to_string(), trimmed(&m.study_time).unwrap_or("").to_string()));
        }
    }
    // Studies newest first, then by UID; undated last.
    let study_cmp = |a: &str, b: &str| {
        let by_date = match (when.get(a), when.get(b)) {
            (Some(x), Some(y)) => y.cmp(x),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => Ordering::Equal,
        };
        by_date.then_with(|| a.as_bytes().cmp(b.as_bytes()))
    };
    idx.sort_by(|&a, &b| study_cmp(&metas[a].study_uid, &metas[b].study_uid).then(within(a).cmp(&within(b))).then(a.cmp(&b)));

    // One copy per SOP Instance UID: the first in that order; copies at the same place (same
    // study, series and Instance Number) by SHA-256.
    let place = |i: usize| {
        let m = &metas[i];
        (m.study_uid.as_str(), m.series_uid.as_str(), opt_num(m.instance_number))
    };
    let mut out = Grouped::default();
    let mut by_sop: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    let mut keep = vec![true; metas.len()];
    for &i in &idx {
        let sop = metas[i].sop_uid.as_str();
        let Some(&k) = by_sop.get(sop) else {
            by_sop.insert(sop, i);
            continue;
        };
        let winner = if place(k) != place(i) {
            k
        } else {
            match (&metas[k].sha256, &metas[i].sha256) {
                (Some(a), Some(b)) if b < a => i,
                (Some(_), Some(_)) => k,
                _ => {
                    for j in [k, i] {
                        if metas[j].sha256.is_none() && !out.need_sha256.contains(&j) {
                            out.need_sha256.push(j);
                        }
                    }
                    k
                }
            }
        };
        keep[if winner == k { i } else { k }] = false;
        by_sop.insert(sop, winner);
    }
    for &i in &idx {
        if !keep[i] {
            out.duplicates.push((i, by_sop[metas[i].sop_uid.as_str()]));
        }
    }
    out.need_sha256.sort_unstable();

    for &i in idx.iter().filter(|&&i| keep[i]) {
        let m = &metas[i];
        if out.studies.last().is_none_or(|s| s.uid != m.study_uid) {
            out.studies.push(GroupedStudy { uid: m.study_uid.clone(), series: Vec::new() });
        }
        let st = out.studies.last_mut().unwrap();
        if st.series.last().is_none_or(|s| s.uid != m.series_uid) {
            st.series.push(GroupedSeries { uid: m.series_uid.clone(), instances: Vec::new() });
        }
        st.series.last_mut().unwrap().instances.push(i);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(study: &str, date: Option<&str>, series: &str, sn: Option<i32>, sop: &str, n: Option<i32>) -> InstanceMeta {
        InstanceMeta {
            study_uid: study.into(),
            series_uid: series.into(),
            sop_uid: sop.into(),
            study_date: date.map(String::from),
            series_number: sn,
            instance_number: n,
            ..Default::default()
        }
    }

    #[test]
    fn studies_newest_first_then_series_and_instances_by_number() {
        let metas = vec![
            m("1.2.9", Some("20200101"), "1.2.9.1", Some(2), "1.2.9.1.2", Some(2)), // 0
            m("1.2.8", None, "1.2.8.1", None, "1.2.8.1.1", None),                   // 1 undated: last
            m("1.2.9", Some("20200101"), "1.2.9.1", Some(2), "1.2.9.1.1", Some(1)), // 2
            m("1.2.7", Some("20240501"), "1.2.7.5", None, "1.2.7.5.1", None),       // 3 newest
            m("1.2.9", Some("20200101"), "1.2.9.2", Some(1), "1.2.9.2.1", None),    // 4
            m("1.2.7", Some("20240501"), "1.2.7.4", Some(9), "1.2.7.4.1", None),    // 5
        ];
        let g = group(&metas);
        let order: Vec<(&str, Vec<Vec<usize>>)> =
            g.studies.iter().map(|s| (s.uid.as_str(), s.series.iter().map(|se| se.instances.clone()).collect())).collect();
        assert_eq!(order, [("1.2.7", vec![vec![5], vec![3]]), ("1.2.9", vec![vec![4], vec![2, 0]]), ("1.2.8", vec![vec![1]])]);
        assert!(g.duplicates.is_empty() && g.need_sha256.is_empty());
        // The input order does not matter.
        let mut rev = metas.clone();
        rev.reverse();
        let g2 = group(&rev);
        let uids = |g: &Grouped| g.studies.iter().map(|s| s.uid.clone()).collect::<Vec<_>>();
        assert_eq!(uids(&g), uids(&g2));
    }

    #[test]
    fn one_copy_per_sop_instance_uid() {
        // A copy in a later series loses to the one in the earlier series.
        let metas = vec![m("1", None, "1.2", Some(2), "9", Some(1)), m("1", None, "1.1", Some(1), "9", Some(1))];
        let g = group(&metas);
        assert_eq!(g.duplicates, [(0, 1)]);
        assert!(g.need_sha256.is_empty());
        // Two copies at the same place tie: the smaller SHA-256 wins, whichever was read first.
        let mut tied = vec![m("1", None, "1.1", Some(1), "9", Some(1)), m("1", None, "1.1", Some(1), "9", Some(1))];
        assert_eq!(group(&tied).need_sha256, [0, 1]);
        tied[0].sha256 = Some("bb".into());
        tied[1].sha256 = Some("aa".into());
        let g = group(&tied);
        assert_eq!((g.duplicates.clone(), g.studies[0].series[0].instances.clone()), (vec![(0, 1)], vec![1]));
        tied.swap(0, 1);
        assert_eq!(group(&tied).duplicates, [(1, 0)]);
    }
}
