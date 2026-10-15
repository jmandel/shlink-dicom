// Creates test links on the local server for the View checks and prints them as JSON:
//   publicLink, passcodeLink (the seeded samples), subsetLink (wrist study only), revokedLink,
//   expiredLink, lockLink (passcode 2468, for the too-many-attempts state), perfLink (synthetic
//   512² CT × 100 + 2048² DX, for timing). Uses only the public API, as a sharer would.
//   bun web/checks/fixtures.ts [base]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { encodeShlink, encryptJwe, extractShlink, openShare, randomKeyB64 } from "../core/index";
import { initSync, WasmPacker } from "../../crates/shl-dicom-wasm/pkg/shl_dicom_wasm.js";

const base = process.argv[2] ?? "http://localhost:3333";
const j = async (r: Response) => {
  if (!r.ok) throw new Error(`${r.url}: ${r.status} ${await r.text()}`);
  return r.json();
};
const demos = (await j(await fetch(`${base}/api/demo-shares`))).shares;
const publicLink = extractShlink(demos.find((d: any) => !d.passcodeHint).shlinkUri)!;
const passcodeLink = extractShlink(demos.find((d: any) => d.passcodeHint).shlinkUri)!;

async function newShareFrom(sid: string) {
  return j(await fetch(`${base}/api/shares/${sid}/clone`, { method: "POST" }));
}

async function mint(sid: string, token: string, bundle: any, opts: { label: string; passcode?: string; exp?: number }) {
  const files: string[] = [];
  for (const e of bundle.entry) {
    for (const s of e.resource?.series ?? []) {
      const ext = (s.extension ?? []).find((x: any) => x.url.endsWith("/series-file"));
      const id = ext?.extension?.find((x: any) => x.url === "id")?.valueString;
      if (id) files.push(`${id}.bin`);
    }
  }
  const auth = { Authorization: `Bearer ${token}` };
  const link = await j(
    await fetch(`${base}/api/shares/${sid}/links`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ label: opts.label, passcode: opts.passcode, exp: opts.exp, allowedFiles: files }),
    }),
  );
  const key = randomKeyB64();
  const jwe = await encryptJwe(new TextEncoder().encode(JSON.stringify(bundle)), key);
  const updated = await j(
    await fetch(`${base}/api/shares/${sid}/links/${link.id}/bundle.jwe`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/jose" },
      body: jwe,
    }),
  );
  return {
    lid: link.id,
    shlink: encodeShlink({ url: updated.url, key, flag: updated.flag ?? undefined, label: opts.label, exp: opts.exp, v: 1 }),
  };
}

// Clone the demo share (same encrypted files) and mint links over it.
const demoSid = demos[0].id;
const cloned = await newShareFrom(demoSid);
const full = await openShare(publicLink);
const bundle = full.index.bundle;
const wristOnly = {
  ...bundle,
  entry: bundle.entry.filter((e: any) => e.resource?.resourceType !== "ImagingStudy" || /extremity|wrist/i.test(e.resource.description ?? "")),
};
const subset = await mint(cloned.share.id, cloned.controlToken, wristOnly, { label: "Wrist only" });
const revoked = await mint(cloned.share.id, cloned.controlToken, bundle, { label: "Revoked test" });
await fetch(`${base}/api/shares/${cloned.share.id}/links/${revoked.lid}`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${cloned.controlToken}` },
});
const expired = await mint(cloned.share.id, cloned.controlToken, bundle, {
  label: "Expired test",
  exp: Math.floor(Date.now() / 1000) - 3600,
});
const lock = await mint(cloned.share.id, cloned.controlToken, bundle, { label: "Lockout test", passcode: "2468" });
// A passcode link of our own for wrong-passcode checks (wrong tries on the seeded sample would
// use up its attempts for everyone).
const pass2 = await mint(cloned.share.id, cloned.controlToken, bundle, { label: "Passcode test", passcode: "1234" });

// Perf share: synthetic CT series (viewer-kit/data) and a 2048² DX (codec corpus), packed with
// the existing wasm packer and uploaded as ciphertext.
initSync({ module: readFileSync("crates/shl-dicom-wasm/pkg/shl_dicom_wasm_bg.wasm") });
const packer = new WasmPacker();
const ctDir = "viewer-kit/data/ct100-explicit-le";
for (const f of readdirSync(ctDir).sort()) packer.add_dicom_file(f, readFileSync(`${ctDir}/${f}`));
packer.add_dicom_file("dx2048.dcm", readFileSync("codec-corpus/formats/uncompressed/samples/gen-bench-dx2048-u12.dcm"));
const packed = packer.pack(new Date().toISOString(), undefined);
const created = await j(await fetch(`${base}/api/shares`, { method: "POST" }));
const sid = created.share.id, token = created.controlToken;
await j(await fetch(`${base}/api/shares/${sid}/owner.jwe`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/jose" }, body: packed.owner_jwe }));
for (let i = 0; i < packed.series_file_count; i++) {
  const ct = packed.series_file_ciphertext(i);
  await j(
    await fetch(`${base}/api/shares/${sid}/files/${packed.series_file_id(i)}.bin`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream", "X-Expected-Size": String(ct.length) },
      body: ct,
    }),
  );
}
const perf = await mint(sid, token, JSON.parse(packed.owner_bundle_json), { label: "Synthetic CT and DX (timing)" });

const out = {
  publicLink,
  passcodeLink,
  subsetLink: subset.shlink,
  revokedLink: revoked.shlink,
  expiredLink: expired.shlink,
  lockLink: lock.shlink,
  passcodeTestLink: pass2.shlink,
  perfLink: perf.shlink,
};
writeFileSync("/tmp/view-fixtures.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
