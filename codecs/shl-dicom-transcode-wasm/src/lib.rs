//! `transcode_part10` for a browser worker. Build:
//!
//! ```sh
//! cargo +stable build --release --target wasm32-unknown-unknown -p shl-dicom-transcode-wasm
//! wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/shl_dicom_transcode_wasm.wasm
//! ```
//!
//! ```js
//! import init, { transcode_part10 } from "./shl_dicom_transcode_wasm.js";
//! await init({ module_or_path: assetUrl("shl_dicom_transcode_wasm_bg.wasm") });
//! const r = transcode_part10(bytes, "1.2.840.10008.1.2.4.70");
//! if (r.bytes) { /* r.tsUid, r.outputBytes … */ } else { /* keep the input; r.declined says why */ }
//! r.free();
//! ```
//!
//! The call is synchronous and single-threaded; time it in JavaScript. The result's getters copy
//! out of wasm memory, so read `bytes` once.
use wasm_bindgen::prelude::*;

/// One call's outcome: `bytes` and `tsUid` when re-encoded, `declined` otherwise.
#[wasm_bindgen]
pub struct TranscodeResult {
    bytes: Option<Vec<u8>>,
    declined: Option<String>,
    ts_uid: Option<String>,
    report: shl_dicom_transcode::Report,
}

#[wasm_bindgen]
impl TranscodeResult {
    /// The re-encoded Part 10 file, or undefined when declined.
    #[wasm_bindgen(getter)]
    pub fn bytes(&self) -> Option<Vec<u8>> {
        self.bytes.clone()
    }
    /// Why the input was left as it is, or undefined when re-encoded.
    #[wasm_bindgen(getter)]
    pub fn declined(&self) -> Option<String> {
        self.declined.clone()
    }
    /// The output's transfer syntax, when re-encoded.
    #[wasm_bindgen(getter, js_name = tsUid)]
    pub fn ts_uid(&self) -> Option<String> {
        self.ts_uid.clone()
    }
    #[wasm_bindgen(getter, js_name = inputBytes)]
    pub fn input_bytes(&self) -> f64 {
        self.report.input_bytes as f64
    }
    /// The output's size, or the input's when declined.
    #[wasm_bindgen(getter, js_name = outputBytes)]
    pub fn output_bytes(&self) -> f64 {
        self.report.output_bytes as f64
    }
    #[wasm_bindgen(getter, js_name = pixelBytesIn)]
    pub fn pixel_bytes_in(&self) -> f64 {
        self.report.pixel_bytes_in as f64
    }
    #[wasm_bindgen(getter, js_name = pixelBytesOut)]
    pub fn pixel_bytes_out(&self) -> f64 {
        self.report.pixel_bytes_out as f64
    }
    #[wasm_bindgen(getter)]
    pub fn frames(&self) -> u32 {
        self.report.frames
    }
}

/// Re-encode `input` (a Part 10 file) losslessly under `ts_uid`; see the crate documentation of
/// `shl-dicom-transcode`. Both self-checks always run.
#[wasm_bindgen]
pub fn transcode_part10(input: &[u8], ts_uid: &str) -> TranscodeResult {
    let (r, report) = shl_dicom_transcode::transcode_part10_report(input, ts_uid);
    match r {
        Ok(out) => TranscodeResult { bytes: Some(out), declined: None, ts_uid: Some(ts_uid.to_string()), report },
        Err(e) => TranscodeResult { bytes: None, declined: Some(e.0), ts_uid: None, report },
    }
}

/// The transfer syntaxes `transcode_part10` writes.
#[wasm_bindgen]
pub fn supported_transfer_syntaxes() -> Vec<String> {
    shl_dicom_transcode::SUPPORTED_TRANSFER_SYNTAXES.iter().map(|s| s.to_string()).collect()
}

/// `transcode_part10(input, "1.2.840.10008.1.2.4.70")`.
#[wasm_bindgen]
pub fn transcode_part10_sv1(input: &[u8]) -> TranscodeResult {
    transcode_part10(input, shl_dicom_transcode::JPEG_LOSSLESS_SV1)
}

/// Benchmark builds only: encode `samples` (16-bit little-endian, one component) as JPEG 2000 and
/// return the codestream length, to time the encoder without parsing or self-checks.
#[cfg(feature = "bench")]
#[wasm_bindgen]
pub fn encode_only_j2k(samples: &[u8], columns: u32, rows: u32, precision: u8, signed: bool) -> usize {
    let s: Vec<i32> = samples
        .chunks_exact(2)
        .map(|b| if signed { i32::from(i16::from_le_bytes([b[0], b[1]])) } else { i32::from(u16::from_le_bytes([b[0], b[1]])) })
        .collect();
    shl_codec_jpeg2000_encode::encode_lossless(&s, columns, rows, 1, precision, signed).map_or(0, |v| v.len())
}
