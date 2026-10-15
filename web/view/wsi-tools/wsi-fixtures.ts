// Shares whole-slide test data on the local server and prints the links as JSON (also merged into
// /tmp/wsi-fixtures.json). For each slide folder, two shares packed by the wasm packer: one as the
// files are (`plainLink`), one with the packer's offset-table option on (`tablesLink`; see
// crates/shl-dicom-core/src/offset_tables.rs).
//   bun web/view/wsi-tools/wsi-fixtures.ts <name>=<folder> [<name>=<folder> …] [--base http://localhost:3333]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { encodeShlink, encryptJwe, randomKeyB64 } from "../../core/index";
import { initSync, WasmPacker } from "../../../crates/shl-dicom-wasm/pkg/shl_dicom_wasm.js";

const args = process.argv.slice(2);
const bi = args.indexOf("--base");
const base = bi >= 0 ? args[bi + 1] : "http://localhost:3333";
const slides = args.filter((a, i) => a.includes("=") && (bi < 0 || i !== bi + 1)).map((a) => a.split("=") as [string, string]);
const j = async (r: Response) => {
  if (!r.ok) throw new Error(`${r.url}: ${r.status} ${await r.text()}`);
  return r.json();
};

initSync({ module: readFileSync("crates/shl-dicom-wasm/pkg/shl_dicom_wasm_bg.wasm") });

async function mint(sid: string, token: string, bundle: any, label: string) {
  const files: string[] = [];
  for (const e of bundle.entry) for (const s of e.resource?.series ?? []) {
    const id = (s.extension ?? []).find((x: any) => x.url.endsWith("/series-file"))?.extension?.find((x: any) => x.url === "id")?.valueString;
    if (id) files.push(`${id}.bin`);
  }
  const auth = { Authorization: `Bearer ${token}` };
  const link = await j(await fetch(`${base}/api/shares/${sid}/links`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ label, allowedFiles: files }) }));
  const key = randomKeyB64();
  const jwe = await encryptJwe(new TextEncoder().encode(JSON.stringify(bundle)), key);
  const updated = await j(await fetch(`${base}/api/shares/${sid}/links/${link.id}/bundle.jwe`, { method: "PUT", headers: { ...auth, "Content-Type": "application/jose" }, body: jwe }));
  return encodeShlink({ url: updated.url, key, flag: updated.flag ?? undefined, label, v: 1 });
}

/** Packs the folder (with or without offset tables), uploads it as a new share, mints one link. */
async function packAndShare(name: string, dir: string, addTables: boolean) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".dcm")).sort();
  const packer = new WasmPacker();
  for (const f of files) packer.add_dicom_file(f, new Uint8Array(readFileSync(`${dir}/${f}`)));
  packer.set_add_offset_tables(addTables);
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
  const link = await mint(sid, token, bundle, addTables ? `${name} (offset tables added)` : name);
  return { share: sid, token, link, ciphertext, packMs: Math.round(packMs), plaintext: bundle.entry.flatMap((e: any) => e.resource?.series ?? []).flatMap((s: any) => s.instance).reduce((a: number, i: any) => a + i.extension[0].valueDecimal, 0) };
}

const out: Record<string, any> = existsSync("/tmp/wsi-fixtures.json") ? JSON.parse(readFileSync("/tmp/wsi-fixtures.json", "utf8")) : {};
for (const [name, dir] of slides) {
  const plain = await packAndShare(name, dir, false);
  const tables = await packAndShare(name, dir, true);
  out[name] = {
    dir,
    // DELETE /api/shares/{sid} with the token removes a share.
    shares: { plain: { sid: plain.share, token: plain.token }, tables: { sid: tables.share, token: tables.token } },
    plainLink: plain.link,
    tablesLink: tables.link,
    totalBytes: plain.plaintext,
    ciphertextBytes: plain.ciphertext,
    withTables: { totalBytes: tables.plaintext, ciphertextBytes: tables.ciphertext, addedBytes: tables.plaintext - plain.plaintext, packMs: tables.packMs },
    packMs: plain.packMs,
  };
  console.error(`${name}: ${(plain.plaintext / 1e6).toFixed(1)} MB; offset tables add ${tables.plaintext - plain.plaintext} bytes; shares ${plain.share}, ${tables.share}`);
}
writeFileSync("/tmp/wsi-fixtures.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]: any) => [k, { ...v, plainLink: undefined, tablesLink: undefined }])), null, 2));
