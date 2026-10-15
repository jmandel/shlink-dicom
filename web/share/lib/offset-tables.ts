// Frame offset tables for multi-frame files that lack them (whole-slide images, mostly). Without
// one, a viewer has to download every frame before the one it wants. The rewrite itself is the
// core packer's (crates/shl-dicom-core/src/offset_tables.rs, through shl-dicom-wasm), the same
// code the CLI's --add-offset-tables uses; fragment bytes stay as they are.
import { parseSlideHeader } from "../../core/wsi";
import { assetUrl } from "../../core/config";
import type { Instance, SeriesModel } from "./ingest";

/** Whether the review step's "Add frame offset tables" box starts ticked when it is shown. */
export const ADD_OFFSET_TABLES_DEFAULT = true;

const NATIVE = new Set(["1.2.840.10008.1.2", "1.2.840.10008.1.2.1", "1.2.840.10008.1.2.2", "1.2.840.10008.1.2.1.99"]);
const VIDEO = /^1\.2\.840\.10008\.1\.2\.4\.10[0-8](\.1)?$/;
const cache = new WeakMap<Uint8Array, boolean>();

/** An encapsulated multi-frame instance with an empty Basic Offset Table and no Extended Offset Table. */
export function lacksOffsetTable(inst: Instance): boolean {
  const ts = inst.h.transferSyntax;
  if (!ts || NATIVE.has(ts) || VIDEO.test(ts)) return false;
  let v = cache.get(inst.bytes);
  if (v === undefined) {
    try {
      const h = parseSlideHeader(inst.bytes);
      v = h.complete && h.encapsulated && h.numberOfFrames > 1 && !h.basicOffsets && !h.extendedOffsets;
    } catch {
      v = false;
    }
    cache.set(inst.bytes, v);
  }
  return v;
}

let wasm: Promise<typeof import("../../../crates/shl-dicom-wasm/pkg/shl_dicom_wasm.js")> | null = null;

/**
 * Adds offset tables to the instances that lack one, in place. Returns how many were rewritten
 * (an instance whose frames can't be located unambiguously is left as it is).
 */
export async function addOffsetTables(series: SeriesModel[], onProgress?: (done: number, total: number) => void): Promise<number> {
  const todo: [SeriesModel, Instance][] = [];
  for (const se of series) for (const inst of se.instances) if (lacksOffsetTable(inst)) todo.push([se, inst]);
  if (!todo.length) return 0;
  wasm ??= import("../../../crates/shl-dicom-wasm/pkg/shl_dicom_wasm.js").then(async (m) => {
    await m.default({ module_or_path: assetUrl("shl_dicom_wasm_bg.wasm") });
    return m;
  });
  const m = await wasm;
  let rewritten = 0;
  for (let k = 0; k < todo.length; k++) {
    const [se, inst] = todo[k];
    const patch = m.offset_table_patch_wasm(inst.bytes);
    if (patch) {
      const head = patch.head;
      const rest = inst.bytes.subarray(patch.resume_at);
      const out = new Uint8Array(head.length + rest.length);
      out.set(head, 0);
      out.set(rest, head.length);
      patch.free();
      se.bytes += out.length - inst.bytes.length;
      inst.bytes = out;
      cache.set(out, false);
      rewritten++;
    }
    onProgress?.(k + 1, todo.length);
    await new Promise((r) => setTimeout(r, 0));
  }
  return rewritten;
}
