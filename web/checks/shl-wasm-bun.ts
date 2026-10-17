// The Share page's Rust module (crates/shl-dicom-wasm) in Bun, for checks that run web/share/lib.
import { readFileSync } from "node:fs";
import { initSync } from "../../crates/shl-dicom-wasm/pkg/shl_dicom_wasm.js";
import { loadShlWasm } from "../share/lib/shl-wasm";

let ready: Promise<unknown> | null = null;
/** Instantiates the module from its file, once. */
export function useShlWasm(): Promise<unknown> {
  ready ??= (() => {
    initSync({ module: readFileSync(new URL("../../crates/shl-dicom-wasm/pkg/shl_dicom_wasm_bg.wasm", import.meta.url)) });
    return loadShlWasm();
  })();
  return ready;
}
