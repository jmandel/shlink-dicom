//! WebAssembly bindings used by the web app. The Share page adds frame offset tables to
//! multi-frame instances that lack them with the same code as the CLI and the server's seed
//! (`shl_dicom_core::offset_tables`). Everything else in the browser is TypeScript (`web/core`).
use shl_dicom_core::offset_tables::{offset_table_patch, OffsetTableKind};
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
    offset_table_patch(bytes).map(|p| WasmOffsetTablePatch {
        frames: p.frames,
        extended: p.kind == OffsetTableKind::Extended,
        resume_at: p.resume_at,
        head: p.head,
    })
}
