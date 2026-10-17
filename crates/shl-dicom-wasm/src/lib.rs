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
