// The Share page's Rust module (crates/shl-dicom-wasm): the packer's rules and rewrites, the same
// code the CLI and the server's seed run.
import { assetUrl } from "../../core/config";

export type ShlWasm = typeof import("../../../crates/shl-dicom-wasm/pkg/shl_dicom_wasm.js");

let loading: Promise<ShlWasm> | null = null;
let loaded: ShlWasm | null = null;

/** Loads the module once. */
export function loadShlWasm(): Promise<ShlWasm> {
  loading ??= import("../../../crates/shl-dicom-wasm/pkg/shl_dicom_wasm.js").then(async (m) => {
    // In Bun the caller has already run initSync.
    if (typeof window !== "undefined") await m.default({ module_or_path: assetUrl("shl_dicom_wasm_bg.wasm") });
    return (loaded = m);
  });
  return loading;
}

/** The module, for synchronous callers; throws if loadShlWasm has not finished. */
export function shlWasm(): ShlWasm {
  if (!loaded) throw new Error("shl-dicom-wasm is not loaded yet");
  return loaded;
}
