//! WebAssembly bindings used by the Share page, so it runs the same code as the CLI and the
//! server's seed: frame offset tables for multi-frame instances that lack them
//! (`shl_dicom_core::offset_tables`) and the rule for which instances the lossless encoder is
//! offered (`shl_dicom_transcode::is_uncompressed_image`).
use shl_dicom_core::offset_tables::{
    offset_table_first_fragment, offset_table_patch, offset_table_patch_from_fragments, FragmentInfo, OffsetTableKind,
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

/// The rewrite from the file's first bytes and its fragment items, for files too large to hold:
/// `positions[i]` is item i's header position in the file, `lengths[i]` its value length, and
/// `heads[8 i .. 8 i + head_lens[i]]` the first bytes of its value.
#[wasm_bindgen]
pub fn offset_table_patch_from_fragments_wasm(
    prefix: &[u8],
    positions: &[f64],
    lengths: &[u32],
    heads: &[u8],
    head_lens: &[u8],
) -> Option<WasmOffsetTablePatch> {
    if positions.len() != lengths.len() || heads.len() != 8 * positions.len() || head_lens.len() != positions.len() {
        return None;
    }
    let frags: Vec<FragmentInfo> = (0..positions.len())
        .map(|i| FragmentInfo { pos: positions[i] as u64, len: lengths[i], head: &heads[8 * i..8 * i + head_lens[i].min(8) as usize] })
        .collect();
    offset_table_patch_from_fragments(prefix, &frags).map(to_wasm)
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

/// A bare data set wrapped in Part 10 as the packer stores it
/// (`shl_dicom_core::dicom_io::wrap_bare_data_set`); `undefined` when the bytes are already Part 10
/// or do not start like a data set. Throws with the reason when they start like one but cannot
/// be read.
#[wasm_bindgen]
pub fn wrap_bare_data_set(raw: &[u8]) -> Result<Option<Vec<u8>>, JsError> {
    shl_dicom_core::dicom_io::wrap_bare_data_set(raw).map_err(|e| JsError::new(&e))
}

/// Whether a file starting with `prefix` is a bare data set to wrap
/// (`shl_dicom_core::dicom_io::looks_like_bare_data_set`), so a caller reads the whole file only then.
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
