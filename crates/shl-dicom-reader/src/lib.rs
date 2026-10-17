//! The viewer's link reader (crates/shl-dicom-reader/README.md): the same Rust code the CLI and
//! the server use for links, manifests, Bundle JWEs and study indexes, as a small wasm module of
//! its own. Every function returns JSON (or bytes) and throws a `JsError` whose message is JSON
//! `{"code", "message"}` on failure; the codes are listed in the README.
use serde_json::{json, Value};
use shl_dicom_core::{
    bundle::{parse_study_index, StudyIndex},
    jwe::open_bundle_jwe,
    shl::{manifest_location as find_location, parse_link as read_link},
    ReadError,
};
use wasm_bindgen::prelude::*;

fn thrown(e: ReadError) -> JsError {
    JsError::new(&json!({ "code": e.code, "message": e.message }).to_string())
}

/// The checked link in `text` (see [`parse_link`]).
pub fn read_link_value(text: &str, now_secs: f64) -> Result<Value, ReadError> {
    let l = read_link(text, now_secs)?;
    let p = &l.payload;
    // A whole number of seconds as an integer, as links write it.
    let exp = l.exp.map(|e| if e.fract() == 0.0 && e < 9.0e15 { json!(e as u64) } else { json!(e) });
    Ok(json!({
        "url": p.url, "key": p.key, "exp": exp, "flag": p.flag, "label": p.label, "v": p.v,
        "direct": l.direct, "passcode": l.passcode, "longLived": l.long_lived, "expired": l.expired,
    }))
}

/// The Bundle's bytes (see [`decrypt_bundle`]).
pub fn read_bundle(jwe: &str, key: &str) -> Result<Vec<u8>, ReadError> {
    let key = shl_dicom_core::crypto::decode_key_32(key)
        .map_err(|_| ReadError { code: "bad-key", message: "the key is not 43 base64url characters for 32 bytes".into() })?;
    open_bundle_jwe(jwe, &key)
}

/// The study index as JSON (see [`parse_index`]).
pub fn read_index(bundle: &[u8]) -> Result<String, ReadError> {
    let index = parse_study_index(bundle).map_err(|e| ReadError { code: "invalid-bundle", message: e.to_string() })?;
    Ok(index_json(&index))
}

/// The link in `text` (a bare `shlink:/…`, a viewer URL, or text around one), checked:
/// `{url, key, exp, flag, label, v, direct, passcode, longLived, expired}`.
#[wasm_bindgen]
pub fn parse_link(text: &str, now_secs: f64) -> Result<String, JsError> {
    read_link_value(text, now_secs).map(|v| v.to_string()).map_err(thrown)
}

/// The Bundle's location in a manifest response (the first application/fhir+json file with a
/// location), checked for shape.
#[wasm_bindgen]
pub fn manifest_location(manifest_json: &str) -> Result<String, JsError> {
    find_location(manifest_json.as_bytes()).map_err(thrown)
}

/// The Bundle's bytes (UTF-8 JSON) from its compact JWE and the link's base64url key.
#[wasm_bindgen]
pub fn decrypt_bundle(jwe: &str, key: &str) -> Result<Vec<u8>, JsError> {
    read_bundle(jwe, key).map_err(thrown)
}

/// A link's Bundle opened in one call (for a worker): the index JSON and the Bundle's bytes.
#[wasm_bindgen]
pub struct OpenedBundle {
    index: String,
    bundle: Vec<u8>,
}

#[wasm_bindgen]
impl OpenedBundle {
    /// The study index, as [`parse_index`] gives it.
    #[wasm_bindgen(getter)]
    pub fn index(&self) -> String {
        self.index.clone()
    }
    /// The Bundle's UTF-8 JSON bytes.
    #[wasm_bindgen(getter)]
    pub fn bundle(&self) -> Vec<u8> {
        self.bundle.clone()
    }
}

/// [`decrypt_bundle`] then [`parse_index`]: decrypt, inflate and parse in one call, so a worker
/// does all of it off the page's thread.
#[wasm_bindgen]
pub fn open_bundle(jwe: &str, key: &str) -> Result<OpenedBundle, JsError> {
    let bundle = read_bundle(jwe, key).map_err(thrown)?;
    let index = read_index(&bundle).map_err(thrown)?;
    Ok(OpenedBundle { index, bundle })
}

/// The study index of a decrypted Bundle, in the viewer's shape.
#[wasm_bindgen]
pub fn parse_index(bundle: &[u8]) -> Result<String, JsError> {
    read_index(bundle).map_err(thrown)
}

/// Whether frames of this transfer syntax are found by codestream start markers
/// (`shl_dicom_decode::syntax::frame_start_test`): JPEG, JPEG-LS, JPEG 2000, HTJ2K and JPEG XL.
/// When false, each fragment is one frame.
#[wasm_bindgen]
pub fn has_frame_start_marker(transfer_syntax: &str) -> bool {
    shl_dicom_decode::syntax::frame_start_test(transfer_syntax).is_some()
}

/// Whether a fragment whose value starts with `head` (its first 8 bytes, or all of it when
/// shorter) starts a frame. Always true for syntaxes without start markers.
#[wasm_bindgen]
pub fn is_frame_start(transfer_syntax: &str, head: &[u8]) -> bool {
    shl_dicom_decode::syntax::frame_start_test(transfer_syntax).is_none_or(|test| test(head))
}

/// Writes JSON without building a value tree first (the index of a large study has thousands of
/// instances).
struct Out(String);

impl Out {
    fn raw(&mut self, s: &str) -> &mut Self {
        self.0.push_str(s);
        self
    }
    fn str(&mut self, v: &str) -> &mut Self {
        self.0.push('"');
        for c in v.chars() {
            match c {
                '"' => self.0.push_str("\\\""),
                '\\' => self.0.push_str("\\\\"),
                '\n' => self.0.push_str("\\n"),
                '\r' => self.0.push_str("\\r"),
                '\t' => self.0.push_str("\\t"),
                c if (c as u32) < 0x20 => self.0.push_str(&format!("\\u{:04x}", c as u32)),
                c => self.0.push(c),
            }
        }
        self.0.push('"');
        self
    }
    fn opt(&mut self, v: &Option<String>) -> &mut Self {
        match v {
            Some(s) => self.str(s),
            None => self.raw("null"),
        }
    }
    fn num(&mut self, n: impl std::fmt::Display) -> &mut Self {
        self.0.push_str(&n.to_string());
        self
    }
    fn opt_num(&mut self, n: Option<impl std::fmt::Display>) -> &mut Self {
        match n {
            Some(n) => self.num(n),
            None => self.raw("null"),
        }
    }
    fn key(&mut self, k: &str) -> &mut Self {
        if !self.0.ends_with('{') {
            self.0.push(',');
        }
        self.str(k).raw(":")
    }
    fn list<T>(&mut self, items: &[T], mut f: impl FnMut(&mut Self, &T)) -> &mut Self {
        self.0.push('[');
        for (i, x) in items.iter().enumerate() {
            if i > 0 {
                self.0.push(',');
            }
            f(self, x);
        }
        self.0.push(']');
        self
    }
}

/// A [`StudyIndex`] as the viewer's `StudyIndex` (web/core/bundle.ts) without its `bundle` field:
/// each series names its file by `fileId` (the TS adapter links it to the study's file object),
/// and report attachments carry `dataB64`.
pub fn index_json(ix: &StudyIndex) -> String {
    let mut o = Out(String::with_capacity(4096));
    o.raw("{").key("lastUpdated").opt(&ix.last_updated);
    o.key("patient").raw("{").key("name").opt(&ix.patient_name).key("birthDate").opt(&ix.patient_birth_date).key("id").opt(&ix.patient_id).raw("}");
    o.key("reports").list(&ix.diagnostic_reports, |o, r| {
        o.raw("{").key("id").str(&r.id).key("status").str(&r.status).key("title").opt(&r.title).key("conclusion").opt(&r.conclusion);
        o.key("issued").opt(&r.issued).key("effective").opt(&r.effective);
        o.key("studyIds").list(&r.study_ids, |o, s| {
            o.str(s);
        });
        o.key("studyUids").list(&r.study_uids, |o, s| {
            o.str(s);
        });
        o.key("identifiers").list(&r.identifiers, |o, i| {
            o.raw("{").key("system").opt(&i.system).key("value").str(&i.value).key("accession").raw(if i.accession { "true" } else { "false" }).raw("}");
        });
        o.key("category").opt(&r.category).key("text").opt(&r.text);
        o.key("attachments").list(&r.attachments, |o, a| {
            o.raw("{").key("contentType").str(&a.content_type).key("title").opt(&a.title).key("size").opt_num(a.size);
            o.key("dataB64").opt(&a.data_b64).key("url").opt(&a.url).raw("}");
        });
        o.raw("}");
    });
    o.key("studies").list(&ix.studies, |o, st| {
        o.raw("{").key("id").str(&st.id).key("studyInstanceUid").str(&st.study_instance_uid).key("description").opt(&st.description).key("started").opt(&st.started);
        o.key("modalities").list(&st.modalities, |o, m| {
            o.str(m);
        });
        o.key("notes").list(&st.notes, |o, n| {
            o.str(n);
        });
        o.key("accession").opt(&st.accession);
        o.key("files").list(&st.files, |o, f| {
            o.raw("{").key("fileId").str(&f.file_id).key("key").str(&f.key).key("plaintextLength").num(f.plaintext_length);
            o.key("ciphertextLength").num(f.ciphertext_length).key("recordCount").num(f.record_count).raw("}");
        });
        o.key("numberOfSeries").num(st.number_of_series).key("numberOfInstances").num(st.number_of_instances).key("bytes").num(st.bytes);
        o.key("series").list(&st.series, |o, se| {
            o.raw("{").key("uid").str(&se.uid).key("number").opt_num(se.number).key("modality").opt(&se.modality);
            o.key("description").opt(&se.description).key("bodySite").opt(&se.body_site);
            o.key("id").str(&format!("{}@{}", se.file.file_id, se.offset)).key("fileId").str(&se.file.file_id);
            o.key("offset").num(se.offset).key("bytes").num(se.bytes).key("firstRecord").num(se.first_record).key("lastRecord").num(se.last_record);
            o.key("instances").list(&se.instances, |o, i| {
                o.raw("{").key("uid").str(&i.uid).key("sopClass").str(&i.sop_class).key("number").opt_num(i.number);
                o.key("offset").num(i.offset).key("length").num(i.length).key("firstRecord").num(i.first_record).key("lastRecord").num(i.last_record).raw("}");
            });
            o.raw("}");
        });
        o.raw("}");
    });
    o.raw("}");
    o.0
}
