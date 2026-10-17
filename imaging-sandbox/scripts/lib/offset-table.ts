// Frame offset tables for the sandbox's rewritten instances, from the packer's Rust code
// (crates/shl-dicom-core/src/offset_tables.rs) through shl-dicom-wasm, as the Share page adds them
// (web/share/lib/offset-tables.ts). Needs the wasm package built first:
//   cargo build --release --target wasm32-unknown-unknown -p shl-dicom-wasm
//   wasm-bindgen --target web --out-dir crates/shl-dicom-wasm/pkg target/wasm32-unknown-unknown/release/shl_dicom_wasm.wasm
import { readFileSync } from "node:fs";
import { initSync, offset_table_first_fragment_wasm, offset_table_patch_wasm } from "../../../crates/shl-dicom-wasm/pkg/shl_dicom_wasm.js";

initSync({ module: readFileSync(new URL("../../../crates/shl-dicom-wasm/pkg/shl_dicom_wasm_bg.wasm", import.meta.url)) });

/** `bytes` with a frame offset table added when it is an encapsulated multi-frame instance
 *  without one; otherwise `bytes` itself. Fragment bytes are unchanged. Throws when such an
 *  instance's frames cannot be located, so the build never ships a slide without a table. */
export function addOffsetTable(bytes: Uint8Array): Uint8Array {
  const patch = offset_table_patch_wasm(bytes);
  let out = bytes;
  if (patch) {
    const head = patch.head;
    out = new Uint8Array(head.byteLength + bytes.byteLength - patch.resume_at);
    out.set(head, 0);
    out.set(bytes.subarray(patch.resume_at), head.byteLength);
    patch.free();
  }
  if (offset_table_first_fragment_wasm(out) !== undefined) throw new Error("multi-frame instance still has no frame offset table");
  return out;
}
