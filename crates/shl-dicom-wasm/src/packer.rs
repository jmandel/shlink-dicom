use shl_dicom_core::{
    crypto::{b64url_encode, decode_key_32, random_bytes},
    jwe::{decrypt_bundle_jwe, encrypt_bundle_jwe},
    packer::{build_link_bundle, IngestSession, PackedSeriesFile},
    shl::{decode_shlink_uri, encode_shlink_uri, ShlPayload},
};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WasmPackedOutput {
    owner_key_b64: String,
    owner_jwe: String,
    owner_bundle_json: String,
    index_json: String,
    series_files: Vec<PackedSeriesFile>,
}

#[wasm_bindgen]
impl WasmPackedOutput {
    #[wasm_bindgen(getter)]
    pub fn owner_key(&self) -> String {
        self.owner_key_b64.clone()
    }

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
    existing_owner_key: Option<[u8; 32]>,
}

#[wasm_bindgen]
impl WasmPacker {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Some(IngestSession::new()),
            existing_owner_key: None,
        }
    }

    pub fn from_owner_jwe(owner_key_b64: &str, owner_jwe: &str) -> Result<WasmPacker, JsError> {
        let owner_key = decode_key_32(owner_key_b64).map_err(|e| JsError::new(&e.to_string()))?;
        let bundle_bytes = decrypt_bundle_jwe(owner_jwe, &owner_key)
            .map_err(|e| JsError::new(&e.to_string()))?;
        let bundle_json = String::from_utf8(bundle_bytes)
            .map_err(|e| JsError::new(&e.to_string()))?;
        let session = IngestSession::from_owner_bundle_json(&bundle_json)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(WasmPacker {
            inner: Some(session),
            existing_owner_key: Some(owner_key),
        })
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

    pub fn add_zip(&mut self, bytes: &[u8]) -> Result<usize, JsError> {
        let session = self
            .inner
            .as_mut()
            .ok_or_else(|| JsError::new("packer already finalized"))?;
        session
            .ingest_zip(bytes)
            .map_err(|e| JsError::new(&e.to_string()))
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
            None => match self.existing_owner_key {
                Some(k) => k,
                None => random_bytes::<32>().map_err(|e| JsError::new(&e.to_string()))?,
            },
        };

        let packed = session
            .pack(last_updated)
            .map_err(|e| JsError::new(&e.to_string()))?;
        let owner_jwe = encrypt_bundle_jwe(packed.owner_bundle_json.as_bytes(), &owner_key)
            .map_err(|e| JsError::new(&e.to_string()))?;
        let index_json = serde_json::to_string(&packed.index)
            .map_err(|e| JsError::new(&e.to_string()))?;

        Ok(WasmPackedOutput {
            owner_key_b64: b64url_encode(&owner_key),
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
pub fn decrypt_jwe_wasm(jwe_compact: &str, key_b64: &str) -> Result<String, JsError> {
    let key = decode_key_32(key_b64).map_err(|e| JsError::new(&e.to_string()))?;
    let bytes = decrypt_bundle_jwe(jwe_compact, &key).map_err(|e| JsError::new(&e.to_string()))?;
    String::from_utf8(bytes).map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen]
pub fn encrypt_jwe_wasm(bundle_json: &str, key_b64: &str) -> Result<String, JsError> {
    let key = decode_key_32(key_b64).map_err(|e| JsError::new(&e.to_string()))?;
    encrypt_bundle_jwe(bundle_json.as_bytes(), &key).map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen]
pub fn generate_key_b64_wasm() -> Result<String, JsError> {
    let key = random_bytes::<32>().map_err(|e| JsError::new(&e.to_string()))?;
    Ok(b64url_encode(&key))
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

#[wasm_bindgen]
pub fn decode_shlink_wasm(uri: &str) -> Result<String, JsError> {
    let payload = decode_shlink_uri(uri).map_err(|e| JsError::new(&e.to_string()))?;
    serde_json::to_string(&payload).map_err(|e| JsError::new(&e.to_string()))
}
