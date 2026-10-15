// The benchmark manifest (bench/cases.json) resolved against codec-corpus. Node only.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BENCH = dirname(dirname(fileURLToPath(import.meta.url)));
export const CODECS = dirname(BENCH);
export const REPO = dirname(CODECS);
export const FORMATS = join(REPO, "codec-corpus", "formats");

export function loadManifest(path = join(BENCH, "cases.json")) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const corpusCache = new Map();
function corpusCase(fmt, id) {
  if (!corpusCache.has(fmt)) {
    const all = JSON.parse(readFileSync(join(FORMATS, fmt, "cases.json"), "utf8")).cases;
    corpusCache.set(fmt, new Map(all.map((c) => [c.id, c])));
  }
  return corpusCache.get(fmt).get(id);
}

/**
 * Cases selected by filters {formats: [..], match: substring, tags: [..]}, with paths and
 * metadata. Missing samples are returned with `missing` set, so runners can skip them loudly.
 */
export function resolveCases(manifest, filter = {}) {
  const out = [];
  for (const e of manifest.cases) {
    const [fmt, id] = [e.id.slice(0, e.id.indexOf("/")), e.id.slice(e.id.indexOf("/") + 1)];
    if (filter.formats?.length && !filter.formats.includes(fmt)) continue;
    if (filter.match && !e.id.includes(filter.match)) continue;
    if (filter.tags?.length && !filter.tags.every((t) => e.tags.includes(t))) continue;
    const c = corpusCase(fmt, id);
    const sample = join(FORMATS, fmt, "samples", `${id}.dcm`);
    const oracle = join(FORMATS, fmt, "oracle", `${id}.npy`);
    const r = { id: e.id, fmt, corpusId: id, label: e.label, tags: e.tags, sample, oracle, warnings: [] };
    if (!c) { r.missing = "not in the corpus cases.json"; out.push(r); continue; }
    if (!existsSync(sample) || !existsSync(oracle)) { r.missing = "sample or oracle not on disk (run discover/generate/oracle, or bench/scripts/make_cases.py)"; out.push(r); continue; }
    Object.assign(r, {
      rows: c.rows, columns: c.columns, frames: c.frames, spp: c.samples_per_pixel, bits_allocated: c.bits_allocated,
      bits_stored: c.bits_stored, signed: c.pixel_representation === 1, photometric: c.photometric,
      transfer_syntax: c.transfer_syntax, max_abs: c.max_abs, expect: c.expect, size: c.size,
    });
    if (c.expect !== "decode") r.missing = `corpus expects ${c.expect}`;
    if (c.oracle_sha256 !== e.oracle_sha256) r.warnings.push("oracle differs from the manifest's oracle_sha256");
    if (c.sha256 !== e.sample_sha256) {
      const actual = createHash("sha256").update(readFileSync(sample)).digest("hex");
      if (actual !== e.sample_sha256) r.warnings.push("sample file differs from the manifest's sample_sha256");
    }
    out.push(r);
  }
  return out;
}

export function megapixels(c) {
  return (c.rows * c.columns * c.frames) / 1e6;
}
