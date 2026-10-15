use std::collections::{HashMap, VecDeque};
use serde::Serialize;
use shl_dicom_core::{
    bundle::{parse_study_index, InstanceSummary, SeriesSummary, StudyIndex},
    crypto::{decrypt_record, decode_key_32},
    export::{build_uncompressed_zip, split_series_instances},
    jwe::decrypt_bundle_jwe,
    range::{ciphertext_range, record_count, RECORD_CIPHERTEXT, RECORD_PLAINTEXT, TAG_LEN},
    shl::decode_shlink_uri,
};
use wasm_bindgen::prelude::*;

const DEFAULT_MAX_CACHED_RECORDS: usize = 1024; // 64 MiB max

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RangePlanJson {
    file_id: String,
    first_record: u64,
    last_record: u64,
    ciphertext_start: u64,
    ciphertext_end: u64,
    range_header: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IngestResultJson {
    verified_records: Vec<u32>,
    cached_record_count: usize,
    cached_bytes: usize,
}

#[wasm_bindgen]
pub struct WasmShlSession {
    index: StudyIndex,
    series_by_file_id: HashMap<String, SeriesSummary>,
    records: HashMap<(String, u32), Vec<u8>>,
    lru_order: VecDeque<(String, u32)>,
    max_cached_records: usize,
    cached_bytes: usize,
}

#[wasm_bindgen]
impl WasmShlSession {
    #[wasm_bindgen(constructor)]
    pub fn new(shlink_uri: &str, bundle_jwe: &str) -> Result<WasmShlSession, JsError> {
        let payload = decode_shlink_uri(shlink_uri).map_err(|e| JsError::new(&e.to_string()))?;
        let shl_key = payload
            .key_bytes()
            .map_err(|e| JsError::new(&e.to_string()))?;
        let bundle_bytes = decrypt_bundle_jwe(bundle_jwe, &shl_key)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Self::from_bundle_bytes(&bundle_bytes)
    }

    pub fn from_bundle_json(bundle_json: &str) -> Result<WasmShlSession, JsError> {
        Self::from_bundle_bytes(bundle_json.as_bytes())
    }

    fn from_bundle_bytes(bundle_bytes: &[u8]) -> Result<WasmShlSession, JsError> {
        let index = parse_study_index(bundle_bytes).map_err(|e| JsError::new(&e.to_string()))?;

        let mut series_by_file_id = HashMap::new();
        for st in &index.studies {
            for se in &st.series {
                series_by_file_id.insert(se.file_id.clone(), se.clone());
            }
        }

        Ok(WasmShlSession {
            index,
            series_by_file_id,
            records: HashMap::new(),
            lru_order: VecDeque::new(),
            max_cached_records: DEFAULT_MAX_CACHED_RECORDS,
            cached_bytes: 0,
        })
    }

    pub fn set_max_cached_records(&mut self, max_records: usize) {
        self.max_cached_records = max_records.max(1);
        self.evict_if_needed();
    }

    pub fn index_json(&self) -> String {
        serde_json::to_string(&self.index).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn cached_record_count(&self) -> usize {
        self.records.len()
    }

    pub fn plan_instance_range(
        &self,
        study_idx: usize,
        series_idx: usize,
        instance_idx: usize,
    ) -> Result<String, JsError> {
        let (se, inst) = self.lookup_instance(study_idx, series_idx, instance_idx)?;
        let r = ciphertext_range(inst.offset, inst.offset + inst.length, se.plaintext_length)
            .map_err(|e| JsError::new(&e.to_string()))?;
        let plan = RangePlanJson {
            file_id: se.file_id.clone(),
            first_record: r.first_record,
            last_record: r.last_record,
            ciphertext_start: r.ciphertext_start,
            ciphertext_end: r.ciphertext_end,
            range_header: r.http_range_header(),
        };
        serde_json::to_string(&plan).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Verifies the AES-256-GCM tag of each 64 KiB record starting at `first_record`
    /// and stores verified plaintext records in the bounded LRU cache.
    pub fn ingest_ciphertext_range(
        &mut self,
        file_id: &str,
        first_record: u32,
        ciphertext: &[u8],
    ) -> Result<String, JsError> {
        let se = self
            .series_by_file_id
            .get(file_id)
            .ok_or_else(|| JsError::new(&format!("unknown series fileId: {file_id}")))?
            .clone();
        let series_key = decode_key_32(&se.key).map_err(|e| JsError::new(&e.to_string()))?;
        let total_records = record_count(se.plaintext_length);

        if ciphertext.is_empty() {
            return Err(JsError::new("empty ciphertext slice"));
        }

        let mut offset = 0usize;
        let mut rec_idx = first_record as u64;
        let mut verified = Vec::new();

        while offset < ciphertext.len() {
            if rec_idx >= total_records {
                return Err(JsError::new("ciphertext extends past total series records"));
            }
            let expected_rec_len = if rec_idx + 1 < total_records {
                RECORD_CIPHERTEXT as usize
            } else {
                (se.plaintext_length - rec_idx * RECORD_PLAINTEXT + TAG_LEN) as usize
            };
            if offset + expected_rec_len > ciphertext.len() {
                return Err(JsError::new(&format!(
                    "record {rec_idx} truncated: expected {expected_rec_len} bytes, got {}",
                    ciphertext.len() - offset
                )));
            }
            let rec_ct = &ciphertext[offset..offset + expected_rec_len];
            let pt = decrypt_record(rec_ct, rec_idx, &series_key)
                .map_err(|e| JsError::new(&e.to_string()))?;

            self.insert_cached_record(file_id.to_string(), rec_idx as u32, pt);
            verified.push(rec_idx as u32);
            offset += expected_rec_len;
            rec_idx += 1;
        }

        let res = IngestResultJson {
            verified_records: verified,
            cached_record_count: self.records.len(),
            cached_bytes: self.cached_bytes,
        };
        serde_json::to_string(&res).map_err(|e| JsError::new(&e.to_string()))
    }

    pub fn has_instance(&self, study_idx: usize, series_idx: usize, instance_idx: usize) -> bool {
        let Ok((se, inst)) = self.lookup_instance(study_idx, series_idx, instance_idx) else {
            return false;
        };
        for r in inst.first_record..=inst.last_record {
            if !self.records.contains_key(&(se.file_id.clone(), r as u32)) {
                return false;
            }
        }
        true
    }

    pub fn get_instance_dicom(
        &mut self,
        study_idx: usize,
        series_idx: usize,
        instance_idx: usize,
    ) -> Result<Vec<u8>, JsError> {
        let (se, inst) = self.lookup_instance(study_idx, series_idx, instance_idx)?;
        let file_id = se.file_id.clone();
        let first_rec = inst.first_record as u32;
        let last_rec = inst.last_record as u32;
        let offset = inst.offset;
        let length = inst.length as usize;

        let mut joined =
            Vec::with_capacity(((last_rec - first_rec + 1) as usize) * (RECORD_PLAINTEXT as usize));
        for r in first_rec..=last_rec {
            let key = (file_id.clone(), r);
            if !self.records.contains_key(&key) {
                return Err(JsError::new(&format!(
                    "record {r} of series {file_id} is not in cache"
                )));
            }
            self.touch_lru(&key);
            let rec_pt = self.records.get(&key).unwrap();
            joined.extend_from_slice(rec_pt);
        }

        let skip = (offset - (first_rec as u64) * RECORD_PLAINTEXT) as usize;
        if skip + length > joined.len() {
            return Err(JsError::new("instance bounds exceed decrypted records"));
        }
        Ok(joined[skip..skip + length].to_vec())
    }

    pub fn export_series_zip(
        &mut self,
        study_idx: usize,
        series_idx: usize,
    ) -> Result<Vec<u8>, JsError> {
        let se = self
            .index
            .studies
            .get(study_idx)
            .and_then(|s| s.series.get(series_idx))
            .ok_or_else(|| JsError::new("series index out of bounds"))?
            .clone();

        let mut full_pt = Vec::with_capacity(se.plaintext_length as usize);
        for r in 0..(se.record_count as u32) {
            let key = (se.file_id.clone(), r);
            let rec = self.records.get(&key).ok_or_else(|| {
                JsError::new(&format!("record {r} of series {} not cached", se.file_id))
            })?;
            full_pt.extend_from_slice(rec);
        }

        let files =
            split_series_instances(&full_pt, &se).map_err(|e| JsError::new(&e.to_string()))?;
        build_uncompressed_zip(&files).map_err(|e| JsError::new(&e.to_string()))
    }

    fn lookup_instance(
        &self,
        study_idx: usize,
        series_idx: usize,
        instance_idx: usize,
    ) -> Result<(&SeriesSummary, &InstanceSummary), JsError> {
        let study = self
            .index
            .studies
            .get(study_idx)
            .ok_or_else(|| JsError::new("study_idx out of bounds"))?;
        let series = study
            .series
            .get(series_idx)
            .ok_or_else(|| JsError::new("series_idx out of bounds"))?;
        let inst = series
            .instances
            .get(instance_idx)
            .ok_or_else(|| JsError::new("instance_idx out of bounds"))?;
        Ok((series, inst))
    }

    fn insert_cached_record(&mut self, file_id: String, record_idx: u32, pt: Vec<u8>) {
        let key = (file_id, record_idx);
        if let Some(prev) = self.records.remove(&key) {
            self.cached_bytes = self.cached_bytes.saturating_sub(prev.len());
            self.lru_order.retain(|k| k != &key);
        }
        self.cached_bytes += pt.len();
        self.lru_order.push_back(key.clone());
        self.records.insert(key, pt);
        self.evict_if_needed();
    }

    fn touch_lru(&mut self, key: &(String, u32)) {
        self.lru_order.retain(|k| k != key);
        self.lru_order.push_back(key.clone());
    }

    fn evict_if_needed(&mut self) {
        while self.records.len() > self.max_cached_records {
            if let Some(oldest) = self.lru_order.pop_front() {
                if let Some(removed) = self.records.remove(&oldest) {
                    self.cached_bytes = self.cached_bytes.saturating_sub(removed.len());
                }
            } else {
                break;
            }
        }
    }
}
