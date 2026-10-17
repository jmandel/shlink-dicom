// Packs a slide folder for a static host (spec/README.md §10, U mode; Appendix C), for slides too
// large for the local server's upload limit. The files are encrypted by the Share page's packer (web/share/lib/pack.ts).
//   bun web/view/wsi-tools/static-pack.ts <name> <folder> [hostRoot] [hostUrl]
// Writes <hostRoot>/<id>/ with two encrypted files and two Bundles: bundle.jwe (the files as they
// are) and bundle-tables.jwe (offset tables added by the core packer's rewrite, through
// shl-dicom-wasm's offset_table_patch_wasm). Adds <name> to /tmp/wsi-fixtures.json.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { EXT_INSTANCE_LENGTH, EXT_LINKED_FILE, PROFILE_URL, b64urlEncode, encodeShlink, encryptJwe, randomKeyB64, readDicomHeader, recordCount } from "../../core/index";
import { BlobBytes, ConcatBytes, MemBytes, SubBytes, type Bytes } from "../../share/lib/bytes";
import { CHUNK_RECORDS, encryptRecords, fileKey, type PackedFile } from "../../share/lib/pack";
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
  h: Awaited<ReturnType<typeof readDicomHeader>>;
  /** Offset-table rewrite: new head bytes, and where the original resumes. */
  head?: Uint8Array;
  resumeAt?: number;
}
const parts: Part[] = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith(".dcm"))) {
  const path = `${dir}/${f}`;
  parts.push({ path, size: statSync(path).size, h: await readDicomHeader(new Uint8Array(await Bun.file(path).slice(0, 262144).arrayBuffer())) });
}
parts.sort((a, b) => (Number(a.h.instanceNumber) || 0) - (Number(b.h.instanceNumber) || 0) || a.h.sopInstanceUid.localeCompare(b.h.sopInstanceUid));

/** Byte source of one instance, with or without its offset-table rewrite. */
function instBytes(p: Part, tables: boolean): Bytes {
  const file = new BlobBytes(Bun.file(p.path));
  if (!tables || !p.head) return file;
  return new ConcatBytes([new MemBytes(p.head), new SubBytes(file, p.resumeAt!, p.size - p.resumeAt!)]);
}

/** Encrypts the instances, end to end, into one file as the Share page's packer does (pack.ts). */
async function writeSeries(tables: boolean) {
  const instances = parts.map((p) => ({ src: instBytes(p, tables) }));
  const P = instances.reduce((a, i) => a + i.src.size, 0);
  const f = { instances, fileId: rnd(16), key: randomKeyB64(), plaintextLength: P, records: recordCount(P) } as unknown as PackedFile;
  const key = await fileKey(f);
  const w = Bun.file(`${out}/${f.fileId}.bin`).writer();
  for (let r = 0; r < f.records; r += CHUNK_RECORDS) {
    w.write(await encryptRecords(f, key, r, Math.min(f.records, r + CHUNK_RECORDS)));
    await w.flush();
  }
  await w.end();
  return { fileId: f.fileId, keyB64: f.key, lens: instances.map((i) => i.src.size), P, ciphertext: statSync(`${out}/${f.fileId}.bin`).size };
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
        resourceType: "ImagingStudy", id: "s1", meta: { profile: [PROFILE_URL] },
        extension: [{ url: EXT_LINKED_FILE, extension: [{ url: "id", valueString: s.fileId }, { url: "key", valueString: s.keyB64 }] }],
        status: "available",
        identifier: [{ system: "urn:dicom:uid", value: `urn:oid:${h0.studyInstanceUid}` }], subject: { reference: "Patient/p1" },
        description: h0.studyDescription || "Slide microscopy", numberOfSeries: 1, numberOfInstances: parts.length,
        series: [{
          uid: h0.seriesInstanceUid, modality: { system: "http://dicom.nema.org/resources/ontology/DCM", code: h0.modality || "SM" },
          description: h0.seriesDescription || undefined, numberOfInstances: parts.length,
          instance: parts.map((p, i) => ({
            extension: [{ url: EXT_INSTANCE_LENGTH, valueDecimal: s.lens[i] }],
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
