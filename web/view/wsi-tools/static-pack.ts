// Packs a slide folder for a static host (PROPOSAL.md §10, U mode; Appendix C), for slides too
// large for the local server's upload limit. Records are encrypted one at a time.
//   bun web/view/wsi-tools/static-pack.ts <name> <folder> [hostRoot] [hostUrl]
// Writes <hostRoot>/<id>/ with two series files and two Bundles: bundle.jwe (the files as they
// are) and bundle-tables.jwe (offset tables added by the core packer's rewrite, through
// shl-dicom-wasm's offset_table_patch_wasm). Adds <name> to /tmp/wsi-fixtures.json.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { b64urlDecode, b64urlEncode, encodeShlink, encryptJwe, randomKeyB64, readDicomHeader, recordNonce, RECORD_PLAINTEXT } from "../../core/index";
import { initSync, offset_table_patch_wasm } from "../../../crates/shl-dicom-wasm/pkg/shl_dicom_wasm.js";

initSync({ module: readFileSync("crates/shl-dicom-wasm/pkg/shl_dicom_wasm_bg.wasm") });
const [name, dir, hostRoot = "/media/barracuda/shlink-dicom-slides/host", hostUrl = "http://localhost:3335"] = process.argv.slice(2);
const rnd = (n: number) => b64urlEncode(crypto.getRandomValues(new Uint8Array(n)));
const id = rnd(16);
const out = `${hostRoot}/${id}`;
mkdirSync(out, { recursive: true });

interface Part {
  path: string;
  size: number;
  h: ReturnType<typeof readDicomHeader>;
  /** Offset-table rewrite: new head bytes, and where the original resumes. */
  head?: Uint8Array;
  resumeAt?: number;
}
const parts: Part[] = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith(".dcm"))) {
  const path = `${dir}/${f}`;
  parts.push({ path, size: statSync(path).size, h: readDicomHeader(new Uint8Array(await Bun.file(path).slice(0, 262144).arrayBuffer())) });
}
parts.sort((a, b) => (Number(a.h.instanceNumber) || 0) - (Number(b.h.instanceNumber) || 0) || a.h.sopInstanceUid.localeCompare(b.h.sopInstanceUid));

/** Byte source of one instance, with or without its offset-table rewrite. */
const instLen = (p: Part, tables: boolean) => (tables && p.head ? p.head.length + p.size - p.resumeAt! : p.size);
async function instSlice(p: Part, tables: boolean, a: number, b: number): Promise<Uint8Array> {
  if (!tables || !p.head) return new Uint8Array(await Bun.file(p.path).slice(a, b).arrayBuffer());
  const out = new Uint8Array(b - a);
  const H = p.head.length;
  if (a < H) out.set(p.head.subarray(a, Math.min(b, H)), 0);
  if (b > H) {
    const from = Math.max(a, H);
    out.set(new Uint8Array(await Bun.file(p.path).slice(p.resumeAt! + from - H, p.resumeAt! + b - H).arrayBuffer()), from - a);
  }
  return out;
}

async function writeSeries(tables: boolean) {
  const fileId = rnd(16), keyB64 = rnd(32);
  const key = await crypto.subtle.importKey("raw", b64urlDecode(keyB64), "AES-GCM", false, ["encrypt"]);
  const lens = parts.map((p) => instLen(p, tables));
  const starts: number[] = [];
  let P = 0;
  for (const l of lens) (starts.push(P), (P += l));
  const read = async (a: number, b: number) => {
    const buf = new Uint8Array(b - a);
    for (let i = 0; i < parts.length; i++) {
      const s = starts[i], e = s + lens[i];
      if (e <= a || s >= b) continue;
      const from = Math.max(a, s), to = Math.min(b, e);
      buf.set(await instSlice(parts[i], tables, from - s, to - s), from - a);
    }
    return buf;
  };
  const w = Bun.file(`${out}/${fileId}.bin`).writer();
  const n = Math.max(1, Math.ceil(P / RECORD_PLAINTEXT));
  for (let r = 0; r < n; r++) {
    const pt = await read(r * RECORD_PLAINTEXT, Math.min(P, (r + 1) * RECORD_PLAINTEXT));
    w.write(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: recordNonce(r) }, key, pt)));
    if (r % 2000 === 0) await w.flush();
  }
  await w.end();
  return { fileId, keyB64, lens, P, ciphertext: statSync(`${out}/${fileId}.bin`).size };
}

// The rewrite, from the core packer (one implementation for CLI, server and browser).
let added = 0;
const t0 = performance.now();
for (const p of parts) {
  if (p.size > 2e9) continue; // wasm32 cannot take it
  const patch = offset_table_patch_wasm(new Uint8Array(await Bun.file(p.path).arrayBuffer()));
  if (!patch) continue;
  p.head = patch.head;
  p.resumeAt = patch.resume_at;
  added++;
  patch.free();
}
const patchMs = performance.now() - t0;

const h0 = parts[0].h;
const bundleFor = (s: Awaited<ReturnType<typeof writeSeries>>) => ({
  resourceType: "Bundle",
  type: "collection",
  meta: { lastUpdated: new Date().toISOString() },
  entry: [
    { fullUrl: "urn:uuid:p1", resource: { resourceType: "Patient", id: "p1", name: [{ text: h0.patientName.replace(/\^/g, " ") || "Unknown" }] } },
    {
      fullUrl: "urn:uuid:s1",
      resource: {
        resourceType: "ImagingStudy", id: "s1", meta: { profile: ["https://example.org/shl-dicom/v1"] }, status: "available",
        identifier: [{ system: "urn:dicom:uid", value: `urn:oid:${h0.studyInstanceUid}` }], subject: { reference: "Patient/p1" },
        description: h0.studyDescription || "Slide microscopy", numberOfSeries: 1, numberOfInstances: parts.length,
        series: [{
          extension: [{ url: "https://example.org/shl-dicom/series-file", extension: [{ url: "id", valueString: s.fileId }, { url: "key", valueString: s.keyB64 }] }],
          uid: h0.seriesInstanceUid, modality: { system: "http://dicom.nema.org/resources/ontology/DCM", code: h0.modality || "SM" },
          description: h0.seriesDescription || undefined, numberOfInstances: parts.length,
          instance: parts.map((p, i) => ({
            extension: [{ url: "https://example.org/shl-dicom/length", valueDecimal: s.lens[i] }],
            uid: p.h.sopInstanceUid,
            sopClass: { system: "urn:ietf:rfc:3986", code: `urn:oid:${p.h.sopClassUid}` },
            ...(p.h.instanceNumber ? { number: Number(p.h.instanceNumber) } : {}),
          })),
        }],
      },
    },
  ],
});
const links: Record<string, string> = {};
const series: Record<string, Awaited<ReturnType<typeof writeSeries>>> = {};
for (const [file, tables, label] of [["bundle.jwe", false, name], ["bundle-tables.jwe", true, `${name} (offset tables added)`]] as const) {
  const s = (series[file] = await writeSeries(tables));
  const k = randomKeyB64();
  writeFileSync(`${out}/${file}`, await encryptJwe(new TextEncoder().encode(JSON.stringify(bundleFor(s))), k));
  links[file] = encodeShlink({ url: `${hostUrl}/${id}/${file}`, key: k, flag: "U", label, v: 1 });
}
const fx = existsSync("/tmp/wsi-fixtures.json") ? JSON.parse(readFileSync("/tmp/wsi-fixtures.json", "utf8")) : {};
const plain = series["bundle.jwe"], withT = series["bundle-tables.jwe"];
fx[name] = {
  dir, host: out, plainLink: links["bundle.jwe"], tablesLink: links["bundle-tables.jwe"], totalBytes: plain.P, ciphertextBytes: plain.ciphertext,
  withTables: { instancesRewritten: added, totalBytes: withT.P, ciphertextBytes: withT.ciphertext, addedBytes: withT.P - plain.P, patchMs: Math.round(patchMs) },
};
writeFileSync("/tmp/wsi-fixtures.json", JSON.stringify(fx, null, 2));
console.log(JSON.stringify({ ...fx[name], plainLink: undefined, tablesLink: undefined }, null, 2));
