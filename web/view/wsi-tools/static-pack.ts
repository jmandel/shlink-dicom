// Packs a slide folder for a static host (PROPOSAL.md §10, U mode; Appendix C), for slides too
// large for the local server's upload limit. Streams: records are encrypted one at a time, so
// memory stays small apart from the frame index pass (one instance at a time).
//   bun web/view/wsi-tools/static-pack.ts <name> <folder> [hostRoot] [hostUrl]
// Writes <hostRoot>/<id>/{fileId}.bin, bundle.jwe and bundle-index.jwe (the same Bundle plus the
// prototype frame index), and adds <name> to /tmp/wsi-fixtures.json with a U-mode link to each.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { b64urlEncode, encodeShlink, encryptJwe, randomKeyB64, readDicomHeader, recordNonce, RECORD_PLAINTEXT, b64urlDecode } from "../../core/index";
import { computeFrameIndex, EXT_FRAMES, frameIndexExtension } from "../../core/wsi";

const [name, dir, hostRoot = "/media/barracuda/shlink-dicom-slides/host", hostUrl = "http://localhost:3335"] = process.argv.slice(2);
const rnd = (n: number) => b64urlEncode(crypto.getRandomValues(new Uint8Array(n)));
const id = rnd(16);
const out = `${hostRoot}/${id}`;
mkdirSync(out, { recursive: true });

const files: { path: string; size: number; h: ReturnType<typeof readDicomHeader> }[] = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith(".dcm"))) {
  const path = `${dir}/${f}`;
  files.push({ path, size: statSync(path).size, h: readDicomHeader(new Uint8Array(await Bun.file(path).slice(0, 262144).arrayBuffer())) });
}
files.sort((a, b) => (Number(a.h.instanceNumber) || 0) - (Number(b.h.instanceNumber) || 0) || a.h.sopInstanceUid.localeCompare(b.h.sopInstanceUid));

const fileId = rnd(16), keyB64 = rnd(32);
const key = await crypto.subtle.importKey("raw", b64urlDecode(keyB64), "AES-GCM", false, ["encrypt"]);
const P = files.reduce((a, f) => a + f.size, 0);
const starts: number[] = [];
let acc = 0;
for (const f of files) (starts.push(acc), (acc += f.size));
const readPlain = async (a: number, b: number) => {
  const buf = new Uint8Array(b - a);
  for (let i = 0; i < files.length; i++) {
    const s = starts[i], e = s + files[i].size;
    if (e <= a || s >= b) continue;
    const from = Math.max(a, s), to = Math.min(b, e);
    buf.set(new Uint8Array(await Bun.file(files[i].path).slice(from - s, to - s).arrayBuffer()), from - a);
  }
  return buf;
};
const binPath = `${out}/${fileId}.bin`;
if (!existsSync(binPath)) {
  const w = Bun.file(binPath).writer();
  const n = Math.max(1, Math.ceil(P / RECORD_PLAINTEXT));
  const t0 = performance.now();
  for (let r = 0; r < n; r++) {
    const pt = await readPlain(r * RECORD_PLAINTEXT, Math.min(P, (r + 1) * RECORD_PLAINTEXT));
    w.write(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: recordNonce(r) }, key, pt)));
    if (r % 2000 === 0) await w.flush();
  }
  await w.end();
  console.error(`encrypted ${(P / 1e6).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
const ciphertextBytes = statSync(binPath).size;

const h0 = files[0].h;
const studyUid = h0.studyInstanceUid, seriesUid = h0.seriesInstanceUid;
const instances = files.map((f) => ({
  extension: [{ url: "https://example.org/shl-dicom/length", valueDecimal: f.size }],
  uid: f.h.sopInstanceUid,
  sopClass: { system: "urn:ietf:rfc:3986", code: `urn:oid:${f.h.sopClassUid}` },
  ...(f.h.instanceNumber ? { number: Number(f.h.instanceNumber) } : {}),
}));
const bundle = {
  resourceType: "Bundle",
  type: "collection",
  meta: { lastUpdated: new Date().toISOString() },
  entry: [
    { fullUrl: "urn:uuid:p1", resource: { resourceType: "Patient", id: "p1", name: [{ text: h0.patientName.replace(/\^/g, " ") || "Unknown" }] } },
    {
      fullUrl: "urn:uuid:s1",
      resource: {
        resourceType: "ImagingStudy", id: "s1", meta: { profile: ["https://example.org/shl-dicom/v1"] }, status: "available",
        identifier: [{ system: "urn:dicom:uid", value: `urn:oid:${studyUid}` }], subject: { reference: "Patient/p1" },
        description: h0.studyDescription || "Slide microscopy", numberOfSeries: 1, numberOfInstances: files.length,
        series: [{
          extension: [{ url: "https://example.org/shl-dicom/series-file", extension: [{ url: "id", valueString: fileId }, { url: "key", valueString: keyB64 }] }],
          uid: seriesUid, modality: { system: "http://dicom.nema.org/resources/ontology/DCM", code: h0.modality || "SM" },
          description: h0.seriesDescription || undefined, numberOfInstances: files.length, instance: instances,
        }],
      },
    },
  ],
};
const indexed = structuredClone(bundle);
let frames = 0, extJson = 0, ms = 0;
for (const [i, f] of files.entries()) {
  if (f.size > 1.8e9) continue;
  const t = performance.now();
  const fi = computeFrameIndex(new Uint8Array(await Bun.file(f.path).arrayBuffer()));
  if (!fi) continue;
  const ext = await frameIndexExtension(fi);
  ms += performance.now() - t;
  frames += fi.lengths.length;
  extJson += JSON.stringify(ext).length;
  (indexed.entry[1].resource as any).series[0].instance[i].extension.push(ext);
}
const links: Record<string, string> = {};
const sizes: Record<string, number> = {};
for (const [file, b, label] of [["bundle.jwe", bundle, name], ["bundle-index.jwe", indexed, `${name} (frame index)`]] as const) {
  const k = randomKeyB64();
  const jwe = await encryptJwe(new TextEncoder().encode(JSON.stringify(b)), k);
  writeFileSync(`${out}/${file}`, jwe);
  sizes[file] = jwe.length;
  links[file] = encodeShlink({ url: `${hostUrl}/${id}/${file}`, key: k, flag: "U", label, v: 1 });
}
const fx = existsSync("/tmp/wsi-fixtures.json") ? JSON.parse(readFileSync("/tmp/wsi-fixtures.json", "utf8")) : {};
fx[name] = {
  dir, host: out, plainLink: links["bundle.jwe"], indexLink: links["bundle-index.jwe"], totalBytes: P, ciphertextBytes,
  frameIndex: { frames, computeMs: Math.round(ms), extensionJsonBytes: extJson, bundleJweBytes: { plain: sizes["bundle.jwe"], indexed: sizes["bundle-index.jwe"] } },
};
writeFileSync("/tmp/wsi-fixtures.json", JSON.stringify(fx, null, 2));
console.log(JSON.stringify({ ...fx[name], plainLink: undefined, indexLink: undefined }, null, 2));
