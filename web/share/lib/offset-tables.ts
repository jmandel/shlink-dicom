// Frame offset tables for multi-frame files that lack them (whole-slide images, mostly). Without
// one, a viewer has to download every frame before the one it wants. The rewrite is the core
// packer's (crates/shl-dicom-core/src/offset_tables.rs, through shl-dicom-wasm), the same code the
// CLI's --add-offset-tables uses; fragment bytes stay as they are. Files are never held whole: the
// header and the fragment item headers are read from the byte source, and the rewritten instance is
// the new head followed by the original bytes from where the patch resumes.
import { NATIVE_SYNTAXES, VIDEO_SYNTAXES } from "../../core/transfer-syntax";
import { ConcatBytes, MemBytes, SubBytes, WindowReader, type Bytes } from "./bytes";
import type { Instance, SeriesModel, StudyModel } from "./ingest";
import { loadShlWasm } from "./shl-wasm";

/** Whether the review step's "Add frame offset tables" box starts ticked when it is shown. */
export const ADD_OFFSET_TABLES_DEFAULT = true;

/** Header bytes read to find the first fragment item. */
const PREFIX_READS = [4 << 10, 64 << 10, 256 << 10, 4 << 20, 32 << 20];

const firstFragment = new WeakMap<Bytes, { prefix: Uint8Array; at: number } | null>();

/** The file's prefix through the empty BOT item, when the instance needs a table; else null. */
async function needsTable(inst: Instance, signal?: AbortSignal): Promise<{ prefix: Uint8Array; at: number } | null> {
  signal?.throwIfAborted();
  const ts = inst.h.transferSyntax;
  if (!ts || NATIVE_SYNTAXES.has(ts) || VIDEO_SYNTAXES[ts]) return null;
  if (firstFragment.has(inst.src)) return firstFragment.get(inst.src)!;
  const m = await loadShlWasm();
  let found: { prefix: Uint8Array; at: number } | null = null;
  for (const n of PREFIX_READS) {
    signal?.throwIfAborted();
    const prefix = await inst.src.read(0, Math.min(inst.src.size, n), signal);
    signal?.throwIfAborted();
    const probe = m.offset_table_probe_wasm(prefix);
    if (probe) {
      const at = probe.first_fragment;
      probe.free();
      if (at !== undefined) found = { prefix: prefix.slice(0, at), at };
      break;
    }
    if (prefix.length >= inst.src.size) break;
  }
  firstFragment.set(inst.src, found);
  return found;
}

/** Inspect headers with bounded concurrency; stop inspecting a study once a missing table is found. */
export async function studiesLackingOffsetTables(
  studies: StudyModel[],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Set<StudyModel>> {
  const todo = studies.flatMap((st) => st.series.flatMap((se) => se.instances.map((inst) => ({ st, inst }))));
  const lacking = new Set<StudyModel>();
  let next = 0, done = 0;
  onProgress?.(0, todo.length);
  await Promise.all(Array.from({ length: Math.min(6, todo.length) }, async () => {
    while (next < todo.length) {
      signal?.throwIfAborted();
      const { st, inst } = todo[next++];
      if (!lacking.has(st) && await needsTable(inst, signal)) lacking.add(st);
      signal?.throwIfAborted();
      onProgress?.(++done, todo.length);
    }
  }));
  return lacking;
}

/**
 * Adds offset tables to the instances that lack one, in place. Returns how many were rewritten
 * (an instance whose frames can't be located unambiguously is left as it is).
 */
export async function addOffsetTables(
  series: SeriesModel[],
  onProgress?: (done: number, total: number) => void,
  only: (inst: Instance) => boolean = () => true,
): Promise<number> {
  const todo: [SeriesModel, Instance, { prefix: Uint8Array; at: number }][] = [];
  for (const se of series) for (const inst of se.instances) {
    if (!only(inst)) continue;
    const need = await needsTable(inst);
    if (need) todo.push([se, inst, need]);
  }
  if (!todo.length) return 0;
  onProgress?.(0, todo.length);
  let rewritten = 0;
  for (let k = 0; k < todo.length; k++) {
    const [se, inst, need] = todo[k];
    if (await patchInstance(se, inst, need)) rewritten++;
    onProgress?.(k + 1, todo.length);
  }
  return rewritten;
}

/** Adds an offset table to one instance, in place, when it lacks one. Returns whether it did. */
export async function addOffsetTable(se: SeriesModel, inst: Instance): Promise<boolean> {
  const need = await needsTable(inst);
  return !!need && (await patchInstance(se, inst, need));
}

async function patchInstance(se: SeriesModel, inst: Instance, need: { prefix: Uint8Array; at: number }): Promise<boolean> {
  const m = await loadShlWasm();
  // The fragment items are walked by the core's walker, reading what it asks for through a window.
  const r = new WindowReader(inst.src);
  const walker = new m.FragmentWalker(need.at, inst.src.size);
  let patch: ReturnType<typeof walker.patch>;
  try {
    for (let at; (at = walker.want()); ) {
      const b = await r.get(at[0], at[1]);
      if (!b) break;
      walker.feed(b);
    }
    patch = walker.patch(need.prefix);
  } finally {
    walker.free();
  }
  if (!patch) return false;
  const head = patch.head;
  const rest = new SubBytes(inst.src, patch.resume_at, inst.src.size - patch.resume_at);
  const before = inst.src.size;
  inst.src = new ConcatBytes([new MemBytes(head), rest]);
  firstFragment.set(inst.src, null);
  patch.free();
  se.bytes += inst.src.size - before;
  return true;
}
