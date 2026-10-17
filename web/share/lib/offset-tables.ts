// Frame offset tables for multi-frame files that lack them (whole-slide images, mostly). Without
// one, a viewer has to download every frame before the one it wants. The rewrite is the core
// packer's (crates/shl-dicom-core/src/offset_tables.rs, through shl-dicom-wasm), the same code the
// CLI's --add-offset-tables uses; fragment bytes stay as they are. Files are never held whole: the
// header and the fragment item headers are read from the byte source, and the rewritten instance is
// the new head followed by the original bytes from where the patch resumes.
import { ConcatBytes, MemBytes, SubBytes, WindowReader, type Bytes } from "./bytes";
import type { Instance, SeriesModel } from "./ingest";
import { loadShlWasm } from "./shl-wasm";

/** Whether the review step's "Add frame offset tables" box starts ticked when it is shown. */
export const ADD_OFFSET_TABLES_DEFAULT = true;

const NATIVE = new Set(["1.2.840.10008.1.2", "1.2.840.10008.1.2.1", "1.2.840.10008.1.2.2", "1.2.840.10008.1.2.1.99"]);
const VIDEO = /^1\.2\.840\.10008\.1\.2\.4\.10[0-8](\.1)?$/;
/** Header bytes read to find the first fragment item. */
const PREFIX_READS = [256 << 10, 4 << 20, 32 << 20];

const firstFragment = new WeakMap<Bytes, { prefix: Uint8Array; at: number } | null>();

/** The file's prefix through the empty BOT item, when the instance needs a table; else null. */
async function needsTable(inst: Instance): Promise<{ prefix: Uint8Array; at: number } | null> {
  const ts = inst.h.transferSyntax;
  if (!ts || NATIVE.has(ts) || VIDEO.test(ts)) return null;
  if (firstFragment.has(inst.src)) return firstFragment.get(inst.src)!;
  const m = await loadShlWasm();
  let found: { prefix: Uint8Array; at: number } | null = null;
  for (const n of PREFIX_READS) {
    const prefix = await inst.src.read(0, Math.min(inst.src.size, n));
    const at = m.offset_table_first_fragment_wasm(prefix);
    if (at !== undefined) {
      found = { prefix: prefix.slice(0, at), at };
      break;
    }
    if (prefix.length >= inst.src.size) break;
  }
  firstFragment.set(inst.src, found);
  return found;
}

/** Whether any of these instances is an encapsulated multi-frame file with an empty offset table. */
export async function anyLacksOffsetTable(series: SeriesModel[]): Promise<boolean> {
  for (const se of series) for (const inst of se.instances) if (await needsTable(inst)) return true;
  return false;
}

/** Walks the fragment items from `at`, reading item headers through a window. */
async function fragments(src: Bytes, at: number) {
  const r = new WindowReader(src);
  const positions: number[] = [], lengths: number[] = [], heads: number[] = [], headLens: number[] = [];
  let p = at;
  for (;;) {
    const hdr = await r.get(p, 8);
    if (!hdr) return null;
    const dv = new DataView(hdr.buffer, hdr.byteOffset, 8);
    const tag = ((dv.getUint16(0, true) << 16) | dv.getUint16(2, true)) >>> 0;
    const len = dv.getUint32(4, true);
    if (tag === 0xfffee0dd) break;
    if (tag !== 0xfffee000 || len === 0xffffffff || p + 8 + len > src.size) return null;
    const n = Math.min(len, 8);
    const head = n ? await r.get(p + 8, n) : new Uint8Array(0);
    positions.push(p);
    lengths.push(len);
    for (let i = 0; i < 8; i++) heads.push(head && i < n ? head[i] : 0);
    headLens.push(n);
    p += 8 + len;
  }
  return { positions: new Float64Array(positions), lengths: new Uint32Array(lengths), heads: new Uint8Array(heads), headLens: new Uint8Array(headLens) };
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
  const f = await fragments(inst.src, need.at);
  const patch = f && m.offset_table_patch_from_fragments_wasm(need.prefix, f.positions, f.lengths, f.heads, f.headLens);
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
