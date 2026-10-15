use shl_dicom_core::{
    crypto::{decode_key_32, random_bytes},
    jwe::encrypt_bundle_jwe,
    offset_tables::{offset_table_patch, OffsetTableKind},
    packer::{build_link_bundle, IngestSession, PackedSeriesFile},
    shl::{encode_shlink_uri, ShlPayload},
};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WasmPackedOutput {
    owner_jwe: String,
    owner_bundle_json: String,
    index_json: String,
    series_files: Vec<PackedSeriesFile>,
}

#[wasm_bindgen]
impl WasmPackedOutput {
    #[wasm_bindgen(getter)]
    pub fn owner_jwe(&self) -> String {
        self.owner_jwe.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn owner_bundle_json(&self) -> String {
        self.owner_bundle_json.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn index_json(&self) -> String {
        self.index_json.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn series_file_count(&self) -> usize {
        self.series_files.len()
    }

    pub fn series_file_id(&self, idx: usize) -> Result<String, JsError> {
        self.series_files
            .get(idx)
            .map(|f| f.file_id.clone())
            .ok_or_else(|| JsError::new("series index out of bounds"))
    }

    pub fn series_file_ciphertext(&self, idx: usize) -> Result<Vec<u8>, JsError> {
        self.series_files
            .get(idx)
            .map(|f| f.ciphertext.clone())
            .ok_or_else(|| JsError::new("series index out of bounds"))
    }
}

#[wasm_bindgen]
pub struct WasmPacker {
    inner: Option<IngestSession>,
}

#[wasm_bindgen]
impl WasmPacker {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Some(IngestSession::new()),
        }
    }

    pub fn add_tgz(&mut self, bytes: &[u8]) -> Result<usize, JsError> {
        let session = self
            .inner
            .as_mut()
            .ok_or_else(|| JsError::new("packer already finalized"))?;
        session
            .ingest_tar_gz(bytes)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Fill in missing frame offset tables when packing (see shl_dicom_core::offset_tables).
    pub fn set_add_offset_tables(&mut self, on: bool) -> Result<(), JsError> {
        self.inner
            .as_mut()
            .ok_or_else(|| JsError::new("packer already finalized"))?
            .set_add_offset_tables(on);
        Ok(())
    }

    pub fn add_dicom_file(&mut self, name: &str, bytes: &[u8]) -> Result<bool, JsError> {
        let session = self
            .inner
            .as_mut()
            .ok_or_else(|| JsError::new("packer already finalized"))?;
        session
            .ingest_dicom_bytes(name, bytes.to_vec())
            .map_err(|e| JsError::new(&e.to_string()))
    }

    pub fn pack(
        &mut self,
        last_updated: &str,
        owner_key_b64: Option<String>,
    ) -> Result<WasmPackedOutput, JsError> {
        let session = self
            .inner
            .take()
            .ok_or_else(|| JsError::new("packer already finalized"))?;
        let owner_key = match owner_key_b64 {
            Some(ref s) => decode_key_32(s).map_err(|e| JsError::new(&e.to_string()))?,
            None => random_bytes::<32>().map_err(|e| JsError::new(&e.to_string()))?,
        };

        let packed = session
            .pack(last_updated)
            .map_err(|e| JsError::new(&e.to_string()))?;
        let owner_jwe = encrypt_bundle_jwe(packed.owner_bundle_json.as_bytes(), &owner_key)
            .map_err(|e| JsError::new(&e.to_string()))?;
        let index_json = serde_json::to_string(&packed.index)
            .map_err(|e| JsError::new(&e.to_string()))?;

        Ok(WasmPackedOutput {
            owner_jwe,
            owner_bundle_json: packed.owner_bundle_json,
            index_json,
            series_files: packed.series_files,
        })
    }
}

#[wasm_bindgen]
pub fn build_link_bundle_wasm(
    owner_bundle_json: &str,
    selected_file_ids_json: &str,
    shl_key_b64: Option<String>,
    last_updated: &str,
) -> Result<String, JsError> {
    let selected: Vec<String> = serde_json::from_str(selected_file_ids_json)
        .map_err(|e| JsError::new(&e.to_string()))?;
    let shl_key = match shl_key_b64 {
        Some(ref s) => decode_key_32(s).map_err(|e| JsError::new(&e.to_string()))?,
        None => random_bytes::<32>().map_err(|e| JsError::new(&e.to_string()))?,
    };
    let out = build_link_bundle(owner_bundle_json, &selected, &shl_key, last_updated)
        .map_err(|e| JsError::new(&e.to_string()))?;
    serde_json::to_string(&out).map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen]
pub fn encode_shlink_wasm(
    payload_json: &str,
    viewer_prefix: Option<String>,
) -> Result<String, JsError> {
    let payload: ShlPayload =
        serde_json::from_str(payload_json).map_err(|e| JsError::new(&e.to_string()))?;
    encode_shlink_uri(&payload, viewer_prefix.as_deref()).map_err(|e| JsError::new(&e.to_string()))
}

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
    offset_table_patch(bytes).map(|p| WasmOffsetTablePatch {
        frames: p.frames,
        extended: p.kind == OffsetTableKind::Extended,
        resume_at: p.resume_at,
        head: p.head,
    })
}

