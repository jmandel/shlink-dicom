// Shares whole-slide test data on the local server and prints the links as JSON (also written to
// /tmp/wsi-fixtures.json). For each slide folder: one share holding the packed series files and two
// links over it: the Bundle as the packer writes it, and the same Bundle with the prototype frame
// index extension (web/core/wsi.ts, EXT_FRAMES) on each multi-frame instance. The series files
// are identical; only the Bundle differs.
//   bun web/view/wsi-tools/wsi-fixtures.ts <name>=<folder> [<name>=<folder> …] [--base http://localhost:3333]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { encodeShlink, encryptJwe, randomKeyB64 } from "../../core/index";
import { computeFrameIndex, frameIndexExtension, EXT_FRAMES } from "../../core/wsi";
import { initSync, WasmPacker } from "../../../crates/shl-dicom-wasm/pkg/shl_dicom_wasm.js";

const args = process.argv.slice(2);
const bi = args.indexOf("--base");
const base = bi >= 0 ? args[bi + 1] : "http://localhost:3333";
const slides = args.filter((a, i) => a.includes("=") && i !== bi + 1).map((a) => a.split("=") as [string, string]);
const j = async (r: Response) => {
  if (!r.ok) throw new Error(`${r.url}: ${r.status} ${await r.text()}`);
  return r.json();
};

initSync({ module: readFileSync("crates/shl-dicom-wasm/pkg/shl_dicom_wasm_bg.wasm") });

async function deflatedSize(s: string) {
  const out = await new Response(new Blob([s]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer();
  return out.byteLength;
}

async function mint(sid: string, token: string, bundle: any, label: string) {
  const files: string[] = [];
  for (const e of bundle.entry) for (const s of e.resource?.series ?? []) {
    const id = (s.extension ?? []).find((x: any) => x.url.endsWith("/series-file"))?.extension?.find((x: any) => x.url === "id")?.valueString;
    if (id) files.push(`${id}.bin`);
  }
  const auth = { Authorization: `Bearer ${token}` };
  const link = await j(await fetch(`${base}/api/shares/${sid}/links`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ label, allowedFiles: files }) }));
  const key = randomKeyB64();
  const json = JSON.stringify(bundle);
  const jwe = await encryptJwe(new TextEncoder().encode(json), key);
  const updated = await j(await fetch(`${base}/api/shares/${sid}/links/${link.id}/bundle.jwe`, { method: "PUT", headers: { ...auth, "Content-Type": "application/jose" }, body: jwe }));
  return { shlink: encodeShlink({ url: updated.url, key, flag: updated.flag ?? undefined, label, v: 1 }), bundleJsonBytes: json.length, bundleJweBytes: jwe.length };
}

const out: Record<string, any> = {};
for (const [name, dir] of slides) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".dcm")).sort();
  const packer = new WasmPacker();
  const bytesByUid = new Map<string, Uint8Array>();
  for (const f of files) {
    const b = new Uint8Array(readFileSync(`${dir}/${f}`));
    packer.add_dicom_file(f, b);
    bytesByUid.set(f, b);
  }
  const t0 = performance.now();
  const packed = packer.pack(new Date().toISOString(), undefined);
  const packMs = performance.now() - t0;
  const created = await j(await fetch(`${base}/api/shares`, { method: "POST" }));
  const sid = created.share.id, token = created.controlToken;
  await j(await fetch(`${base}/api/shares/${sid}/owner.jwe`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/jose" }, body: packed.owner_jwe }));
  let ciphertext = 0;
  for (let i = 0; i < packed.series_file_count; i++) {
    const ct = packed.series_file_ciphertext(i);
    ciphertext += ct.length;
    await j(await fetch(`${base}/api/shares/${sid}/files/${packed.series_file_id(i)}.bin`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream", "X-Expected-Size": String(ct.length) }, body: ct }));
  }
  const bundle = JSON.parse(packed.owner_bundle_json);
  packed.free();
  packer.free();

  // The frame index, as a packer would compute it at share time (it has every byte).
  const withIndex = structuredClone(bundle);
  const sopUid = (b: Uint8Array) => {
    // SOP Instance UID from file meta (0002,0003).
    const dv = new DataView(b.buffer, b.byteOffset);
    let p = 132;
    while (p < 4096) {
      const g = dv.getUint16(p, true), e = dv.getUint16(p + 2, true);
      const vr = String.fromCharCode(b[p + 4], b[p + 5]);
      const long = ["OB", "OW", "UN", "SQ", "UT", "UC", "UR", "OV"].includes(vr);
      const len = long ? dv.getUint32(p + 8, true) : dv.getUint16(p + 6, true);
      const vo = p + (long ? 12 : 8);
      if (g === 2 && e === 3) return new TextDecoder().decode(b.subarray(vo, vo + len)).replace(/[\0 ]+$/, "");
      p = vo + len;
    }
    return "";
  };
  const byUid = new Map([...bytesByUid.values()].map((b) => [sopUid(b), b]));
  let indexMs = 0, frames = 0, extJson = 0;
  const altRaw: string[] = [];
  for (const e of withIndex.entry) for (const s of e.resource?.series ?? []) for (const inst of s.instance ?? []) {
    const b = byUid.get(inst.uid);
    if (!b) continue;
    const t = performance.now();
    const fi = computeFrameIndex(b);
    if (!fi) continue;
    const ext = await frameIndexExtension(fi);
    indexMs += performance.now() - t;
    frames += fi.lengths.length;
    extJson += JSON.stringify(ext).length;
    inst.extension = [...(inst.extension ?? []).filter((x: any) => x.url !== EXT_FRAMES), ext];
    altRaw.push(JSON.stringify(fi.lengths));
  }
  const plain = await mint(sid, token, bundle, `${name}`);
  const indexed = await mint(sid, token, withIndex, `${name} (frame index)`);
  const totalBytes = files.reduce((a, f) => a + readFileSync(`${dir}/${f}`).length, 0);
  out[name] = {
    dir,
    share: sid,
    plainLink: plain.shlink,
    indexLink: indexed.shlink,
    totalBytes,
    ciphertextBytes: ciphertext,
    packMs: Math.round(packMs),
    frameIndex: {
      frames,
      computeMs: Math.round(indexMs),
      extensionJsonBytes: extJson,
      bundleJsonBytes: { plain: plain.bundleJsonBytes, indexed: indexed.bundleJsonBytes },
      bundleJweBytes: { plain: plain.bundleJweBytes, indexed: indexed.bundleJweBytes },
      // For comparison: the lengths as a plain JSON number array, deflated (what JWE zip would do).
      plainJsonArrayDeflated: await deflatedSize(altRaw.join(",")),
    },
  };
  console.error(`${name}: ${files.length} files, ${(totalBytes / 1e6).toFixed(1)} MB, share ${sid}`);
}
writeFileSync("/tmp/wsi-fixtures.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
