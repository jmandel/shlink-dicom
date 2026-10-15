// Test helper: share files on a server the way the Share page does (web/share/lib), from Bun.
//   const s = await packAndShare(base, files, { addOffsetTables });
//   const link = await s.mint(s.bundle, { label: "…" });
import { readFileSync } from "node:fs";
import { encodeShlink, encryptJwe, parseStudyIndex, randomKeyB64 } from "../core/index";
import { Collection } from "../share/lib/ingest";
import { buildBundle, encryptFile, planStudyFiles } from "../share/lib/pack";
import { addOffsetTables } from "../share/lib/offset-tables";
import { initSync } from "../../crates/shl-dicom-wasm/pkg/shl_dicom_wasm.js";

const root = new URL("../../", import.meta.url).pathname;

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
function bundleFiles(bundle: any): string[] {
  return parseStudyIndex(bundle).studies.flatMap((st) => st.files.map((f) => `${f.fileId}.bin`));
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
          body: JSON.stringify({ label: o.label, passcode: o.passcode, exp: o.exp, allowedFiles: bundleFiles(bundle) }),
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

export async function packAndShare(
  base: string,
  files: { name: string; bytes: Uint8Array }[],
  o: { addOffsetTables?: boolean } = {},
): Promise<SharedFixture> {
  const col = new Collection();
  for (const f of files) await col.add(f.name, f.bytes);
  col.finish();
  const studies = col.list();
  let tablesAdded = 0;
  if (o.addOffsetTables) {
    initSync({ module: readFileSync(`${root}crates/shl-dicom-wasm/pkg/shl_dicom_wasm_bg.wasm`) });
    tablesAdded = await addOffsetTables(studies.flatMap((s) => s.series));
  }
  const packed = planStudyFiles(studies);
  const created = await j(await fetch(`${base}/api/shares`, { method: "POST" }));
  const sid: string = created.share.id, token: string = created.controlToken;
  const auth = { Authorization: `Bearer ${token}` };
  let ciphertextBytes = 0, plaintextBytes = 0;
  for (const p of packed) {
    const ct = await encryptFile(p);
    ciphertextBytes += ct.length;
    plaintextBytes += p.plaintextLength;
    await j(
      await fetch(`${base}/api/shares/${sid}/files/${p.fileId}.bin`, {
        method: "PUT",
        headers: { ...auth, "Content-Type": "application/octet-stream", "X-Expected-Size": String(ct.length) },
        body: ct,
      }),
    );
  }
  const bundle = buildBundle(col, packed);
  const ownerJwe = await encryptJwe(new TextEncoder().encode(JSON.stringify(bundle)), randomKeyB64());
  await j(await fetch(`${base}/api/shares/${sid}/owner.jwe`, { method: "PUT", headers: { ...auth, "Content-Type": "application/jose" }, body: ownerJwe }));
  return { sid, token, bundle, plaintextBytes, ciphertextBytes, tablesAdded, skipped: col.skipped, ...linksFor(base, sid, token) };
}
