//! WebAssembly bindings used by the Share page, so it runs the same code as the CLI and the
//! server's seed: frame offset tables for multi-frame instances that lack them
//! (`shl_dicom_core::offset_tables`) and the rule for which instances the lossless encoder is
//! offered (`shl_dicom_transcode::is_uncompressed_image`).
use shl_dicom_core::offset_tables::{
    offset_table_first_fragment, offset_table_patch, offset_table_patch_from_fragments, FragmentWalk, OffsetTableKind,
    OffsetTablePatch,
};
use wasm_bindgen::prelude::*;

/// The rewrite that adds a frame offset table to one Part 10 instance: the new file is
/// `head` followed by the original bytes from `resume_at`. Fragment bytes are unchanged.
#[wasm_bindgen]
pub struct WasmOffsetTablePatch {
    head: Vec<u8>,
    resume_at: usize,
    frames: usize,
    extended: bool,
}

#[wasm_bindgen]
impl WasmOffsetTablePatch {
    #[wasm_bindgen(getter)]
    pub fn head(&self) -> Vec<u8> {
        self.head.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn resume_at(&self) -> usize {
        self.resume_at
    }
    #[wasm_bindgen(getter)]
    pub fn frames(&self) -> usize {
        self.frames
    }
    /// True for an Extended Offset Table (offsets past 4 GiB); false for a Basic Offset Table.
    #[wasm_bindgen(getter)]
    pub fn extended(&self) -> bool {
        self.extended
    }
}

/// `undefined` when the instance needs no table or its frames can't be located unambiguously.
#[wasm_bindgen]
pub fn offset_table_patch_wasm(bytes: &[u8]) -> Option<WasmOffsetTablePatch> {
    offset_table_patch(bytes).map(to_wasm)
}

fn to_wasm(p: OffsetTablePatch) -> WasmOffsetTablePatch {
    WasmOffsetTablePatch { frames: p.frames, extended: p.kind == OffsetTableKind::Extended, resume_at: p.resume_at, head: p.head }
}

/// Where the first fragment item starts when the instance needs a table; `undefined` when it
/// doesn't, or when `prefix` (the file's first bytes) is too short to tell.
#[wasm_bindgen]
pub fn offset_table_first_fragment_wasm(prefix: &[u8]) -> Option<f64> {
    offset_table_first_fragment(prefix).map(|p| p as f64)
}

/// Walks one file's fragment items for [`FragmentWalker::patch`], for files too large to hold
/// (`shl_dicom_core::offset_tables::FragmentWalk`). The caller reads what `want` asks for and
/// passes it to `feed`, until `want` returns `undefined`:
///
/// ```js
/// const w = new FragmentWalker(firstFragment, file.size);
/// for (let at; (at = w.want()); ) w.feed(await read(at[0], at[1]));
/// const patch = w.patch(prefix);
/// ```
#[wasm_bindgen]
pub struct FragmentWalker(FragmentWalk);

#[wasm_bindgen]
impl FragmentWalker {
    /// `first`: where the first fragment item starts (`offset_table_first_fragment_wasm`);
    /// `file_len`: the file's length.
    #[wasm_bindgen(constructor)]
    pub fn new(first: f64, file_len: f64) -> FragmentWalker {
        FragmentWalker(FragmentWalk::new(first as u64, file_len as u64))
    }

    /// `[position, count]` of the bytes to read next, or `undefined` when the walk has ended.
    pub fn want(&self) -> Option<Vec<f64>> {
        self.0.want().map(|(at, n)| vec![at as f64, n as f64])
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        self.0.feed(bytes);
    }

    /// The rewrite, from the file's first bytes (at least up to the first fragment item);
    /// `undefined` when the walk failed, or the instance needs no table, or its frames can't be
    /// located unambiguously.
    pub fn patch(&self, prefix: &[u8]) -> Option<WasmOffsetTablePatch> {
        offset_table_patch_from_fragments(prefix, &self.0.fragments()?).map(to_wasm)
    }
}

/// Whether the Share page offers an instance to its lossless encoder: the packer's rule
/// (`shl_dicom_transcode::is_uncompressed_image`), from the instance's Transfer Syntax UID, SOP
/// Class UID and length in bytes.
#[wasm_bindgen]
pub fn is_uncompressed_image(transfer_syntax: &str, sop_class_uid: &str, len: f64) -> bool {
    shl_dicom_transcode::is_uncompressed_image(transfer_syntax, sop_class_uid, len as u64)
}

/// The share's grouping and order (`shl_dicom_core::order::group`), from a JSON array of
/// `InstanceMeta` (`{studyUid, seriesUid, sopUid, studyDate?, studyTime?, seriesNumber?,
/// instanceNumber?, sha256?}`): JSON `{studies: [{uid, series: [{uid, instances: [index]}]}],
/// duplicates: [[index, keptIndex]], needSha256: [index]}`. When `needSha256` is not empty, call
/// again with those instances' `sha256` filled in.
#[wasm_bindgen]
pub fn group_instances(metas_json: &str) -> Result<String, JsError> {
    let metas: Vec<shl_dicom_core::order::InstanceMeta> = serde_json::from_str(metas_json).map_err(|e| JsError::new(&e.to_string()))?;
    serde_json::to_string(&shl_dicom_core::order::group(&metas)).map_err(|e| JsError::new(&e.to_string()))
}

/// The owner Bundle (`shl_dicom_core::bundle::build_fhir_bundle`) from a JSON `BundleBuildInput`.
#[wasm_bindgen]
pub fn build_bundle(input_json: &str) -> Result<String, JsError> {
    let input: shl_dicom_core::bundle::BundleBuildInput = serde_json::from_str(input_json).map_err(|e| JsError::new(&e.to_string()))?;
    shl_dicom_core::bundle::build_fhir_bundle(&input).map(|b| b.to_string()).map_err(|e| JsError::new(&e.to_string()))
}

/// A link's Bundle (`shl_dicom_core::bundle::subset_bundle`): the owner Bundle cut down to a JSON
/// `LinkSelection` (`{studies: [id], looseReports: [id]}`). JSON `{bundle, allowedFiles}`.
#[wasm_bindgen]
pub fn subset_bundle(owner_json: &str, selection_json: &str, last_updated: &str) -> Result<String, JsError> {
    let owner: serde_json::Value = serde_json::from_str(owner_json).map_err(|e| JsError::new(&e.to_string()))?;
    let sel: shl_dicom_core::bundle::LinkSelection = serde_json::from_str(selection_json).map_err(|e| JsError::new(&e.to_string()))?;
    let link = shl_dicom_core::bundle::subset_bundle(&owner, &sel, last_updated).map_err(|e| JsError::new(&e.to_string()))?;
    serde_json::to_string(&link).map_err(|e| JsError::new(&e.to_string()))
}

/// How a bare data set becomes Part 10 (`shl_dicom_core::dicom_io::part10_wrap`), from its first
/// bytes: the Share page serves `head` and then the file from `skip`, so the file is never read
/// whole. Throws with the reason it can't be wrapped (a prefix that ends before the SOP and Study
/// Instance UIDs throws as a file without them does: the caller tries a longer one).
#[wasm_bindgen(getter_with_clone)]
pub struct Part10Wrap {
    pub head: Vec<u8>,
    pub skip: usize,
}

#[wasm_bindgen]
pub fn part10_wrap(prefix: &[u8]) -> Result<Part10Wrap, JsError> {
    let w = shl_dicom_core::dicom_io::part10_wrap(prefix).map_err(|e| JsError::new(&e))?;
    Ok(Part10Wrap { head: w.head, skip: w.skip })
}

/// Whether a file starting with `prefix` is a bare data set to wrap
/// (`shl_dicom_core::dicom_io::looks_like_bare_data_set`), so a caller wraps it (part10_wrap).
#[wasm_bindgen]
pub fn looks_like_bare_data_set(prefix: &[u8]) -> bool {
    shl_dicom_core::dicom_io::looks_like_bare_data_set(prefix)
}

/// The Bundle's Patient from the included instances' patient fields, in Bundle order
/// (`shl_dicom_core::patient`): a JSON array of `{name?, birthDate?, id?, issuer?}`, and whether
/// the sharer said they are the same person. JSON `{patient: {dicomName, birthDate, identifiers}}`
/// or `{conflict: {first: [name, birthDate], other: [name, birthDate]}, message}`.
#[wasm_bindgen]
pub fn share_patient(records_json: &str, same_patient: bool) -> Result<String, JsError> {
    let records: Vec<shl_dicom_core::patient::PatientMeta> = serde_json::from_str(records_json).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(shl_dicom_core::patient::patient_json(&records, same_patient).to_string())
}
