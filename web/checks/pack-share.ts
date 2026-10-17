// Test helper: share files on a server the way the Share page does (web/share/lib), from Bun.
//   const s = await packAndShare(base, files, { addOffsetTables });
//   const link = await s.mint(s.bundle, { label: "…" });
// What it packs is kept in a cache keyed by its inputs and the packer's code (PACK_CACHE, default
// <tmp>/shl-pack-cache), so a fresh server only gets the encrypted files uploaded again.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeShlink, encryptJwe, parseIndex, randomKeyB64 } from "../core/index";
import { Collection } from "../share/lib/ingest";
import { buildBundle, encryptFile, planStudyFiles } from "../share/lib/pack";
import { addOffsetTables } from "../share/lib/offset-tables";
import { useShlWasm } from "./shl-wasm-bun";


export interface SharedFixture {
  sid: string;
  token: string;
  /** The owner Bundle (every study). */
  bundle: any;
  plaintextBytes: number;
  ciphertextBytes: number;
  /** Instances given an offset table. */
  tablesAdded: number;
  /** Files the Share page's reader left out, with the reason. */
  skipped: { name: string; reason: string }[];
  mint(bundle: any, o: { label: string; passcode?: string; exp?: number }): Promise<{ lid: string; shlink: string }>;
  revoke(lid: string): Promise<void>;
  remove(): Promise<void>;
}

const j = async (r: Response) => {
  if (!r.ok) throw new Error(`${r.url}: ${r.status} ${await r.text()}`);
  return r.json();
};

/** The files a Bundle links, as `{fileId}.bin`. */
async function bundleFiles(bundle: any): Promise<string[]> {
  return (await parseIndex(bundle)).studies.flatMap((st) => st.files.map((f) => `${f.fileId}.bin`));
}

/** Links over an existing share (for example a clone of the sample). */
export function linksFor(base: string, sid: string, token: string) {
  const auth = { Authorization: `Bearer ${token}` };
  return {
    async mint(bundle: any, o: { label: string; passcode?: string; exp?: number }) {
      const link = await j(
        await fetch(`${base}/api/shares/${sid}/links`, {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({ label: o.label, passcode: o.passcode, exp: o.exp, allowedFiles: await bundleFiles(bundle) }),
        }),
      );
      const key = randomKeyB64();
      const jwe = await encryptJwe(new TextEncoder().encode(JSON.stringify(bundle)), key);
      const updated = await j(
        await fetch(`${base}/api/shares/${sid}/links/${link.id}/bundle.jwe`, { method: "PUT", headers: { ...auth, "Content-Type": "application/jose" }, body: jwe }),
      );
      return { lid: link.id as string, shlink: encodeShlink({ url: updated.url, key, flag: updated.flag ?? undefined, label: o.label, exp: o.exp, v: 1 }) };
    },
    async revoke(lid: string) {
      await fetch(`${base}/api/shares/${sid}/links/${lid}`, { method: "DELETE", headers: auth });
    },
    async remove() {
      await fetch(`${base}/api/shares/${sid}`, { method: "DELETE", headers: auth });
    },
  };
}

/** Code whose change changes what is packed: the packer's wasm and the Share page's packing. */
const PACKER_SOURCES = [
  "../../crates/shl-dicom-wasm/pkg/shl_dicom_wasm_bg.wasm",
  "../share/lib/ingest.ts",
  "../share/lib/pack.ts",
  "../share/lib/offset-tables.ts",
  "../share/lib/bytes.ts",
  "./pack-share.ts",
];

/** The cache key of a packing: the packer's code, the options, and every file's name and bytes. */
function cacheKey(files: { name: string; bytes: Uint8Array }[], o: object): string {
  const h = new Bun.CryptoHasher("sha256");
  for (const f of PACKER_SOURCES) h.update(readFileSync(new URL(f, import.meta.url)));
  h.update(JSON.stringify(o));
  for (const f of files) h.update(`\0${f.name}\0${f.bytes.length}\0`).update(f.bytes);
  return h.digest("hex");
}

interface Packed {
  bundle: any;
  plaintextBytes: number;
  ciphertextBytes: number;
  tablesAdded: number;
  skipped: { name: string; reason: string }[];
  /** The encrypted files, as they go to the server. */
  files: string[];
}

/** Packs the files as the Share page does, into `dir`: one `{fileId}.bin` each, and pack.json. */
async function pack(files: { name: string; bytes: Uint8Array }[], o: { addOffsetTables?: boolean }, dir: string): Promise<Packed> {
  await useShlWasm();
  const col = new Collection();
  // Check fixtures gather sample files from many sources and people; they are shared as one
  // person's, as a sharer would say they are (the one-patient rule is test/patient.test.ts's).
  col.samePatient = true;
  for (const f of files) await col.add(f.name, f.bytes);
  await col.finish();
  const studies = col.list();
  let tablesAdded = 0;
  if (o.addOffsetTables) {
    tablesAdded = await addOffsetTables(studies.flatMap((s) => s.series));
  }
  const packed = planStudyFiles(studies);
  let ciphertextBytes = 0, plaintextBytes = 0;
  for (const p of packed) {
    const ct = await encryptFile(p);
    ciphertextBytes += ct.length;
    plaintextBytes += p.plaintextLength;
    writeFileSync(join(dir, `${p.fileId}.bin`), ct);
  }
  const out: Packed = { bundle: buildBundle(col, packed), plaintextBytes, ciphertextBytes, tablesAdded, skipped: col.skipped, files: packed.map((p) => `${p.fileId}.bin`) };
  writeFileSync(join(dir, "pack.json"), JSON.stringify(out));
  return out;
}

export async function packAndShare(
  base: string,
  files: { name: string; bytes: Uint8Array }[],
  o: { addOffsetTables?: boolean } = {},
): Promise<SharedFixture> {
  const root = process.env.PACK_CACHE ?? join(tmpdir(), "shl-pack-cache");
  const dir = join(root, cacheKey(files, { addOffsetTables: !!o.addOffsetTables }));
  let p: Packed;
  if (existsSync(join(dir, "pack.json"))) p = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8"));
  else {
    // Packed beside the cache, then moved into place whole, so a cut-short run leaves no entry.
    const work = `${dir}.part-${process.pid}`;
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    p = await pack(files, o, work);
    rmSync(dir, { recursive: true, force: true });
    renameSync(work, dir);
  }
  const created = await j(await fetch(`${base}/api/shares`, { method: "POST" }));
  const sid: string = created.share.id, token: string = created.controlToken;
  const auth = { Authorization: `Bearer ${token}` };
  for (const f of p.files) {
    const ct = Bun.file(join(dir, f));
    await j(
      await fetch(`${base}/api/shares/${sid}/files/${f}`, {
        method: "PUT",
        headers: { ...auth, "Content-Type": "application/octet-stream", "X-Expected-Size": String(ct.size) },
        body: ct,
      }),
    );
  }
  const ownerJwe = await encryptJwe(new TextEncoder().encode(JSON.stringify(p.bundle)), randomKeyB64());
  await j(await fetch(`${base}/api/shares/${sid}/owner.jwe`, { method: "PUT", headers: { ...auth, "Content-Type": "application/jose" }, body: ownerJwe }));
  const { files: _f, ...rest } = p;
  return { sid, token, ...rest, ...linksFor(base, sid, token) };
}
