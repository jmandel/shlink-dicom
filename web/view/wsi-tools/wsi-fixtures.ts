// Shares whole-slide test data on the local server and prints the links as JSON (also merged into
// /tmp/wsi-fixtures.json). For each slide folder, two shares packed as the Share page packs
// (web/checks/pack-share.ts): one as the files are (`plainLink`), one with offset tables added to
// instances that lack them (`tablesLink`; see crates/shl-dicom-core/src/offset_tables.rs).
//   bun web/view/wsi-tools/wsi-fixtures.ts <name>=<folder> [<name>=<folder> …] [--base http://localhost:3333]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { packAndShare } from "../../checks/pack-share";

const args = process.argv.slice(2);
const bi = args.indexOf("--base");
const base = bi >= 0 ? args[bi + 1] : "http://localhost:3333";
const slides = args.filter((a, i) => a.includes("=") && (bi < 0 || i !== bi + 1)).map((a) => a.split("=") as [string, string]);

/** Packs the folder (with or without offset tables), uploads it as a new share, mints one link. */
async function share(name: string, dir: string, addOffsetTables: boolean) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".dcm"))
    .sort()
    .map((f) => ({ name: f, bytes: new Uint8Array(readFileSync(`${dir}/${f}`)) }));
  const t0 = performance.now();
  const s = await packAndShare(base, files, { addOffsetTables });
  const packMs = Math.round(performance.now() - t0);
  const { shlink } = await s.mint(s.bundle, { label: addOffsetTables ? `${name} (offset tables added)` : name });
  return { sid: s.sid, token: s.token, link: shlink, plaintext: s.plaintextBytes, ciphertext: s.ciphertextBytes, tablesAdded: s.tablesAdded, packMs };
}

const out: Record<string, any> = existsSync("/tmp/wsi-fixtures.json") ? JSON.parse(readFileSync("/tmp/wsi-fixtures.json", "utf8")) : {};
for (const [name, dir] of slides) {
  const plain = await share(name, dir, false);
  const tables = await share(name, dir, true);
  out[name] = {
    dir,
    // DELETE /api/shares/{sid} with the token removes a share.
    shares: { plain: { sid: plain.sid, token: plain.token }, tables: { sid: tables.sid, token: tables.token } },
    plainLink: plain.link,
    tablesLink: tables.link,
    totalBytes: plain.plaintext,
    ciphertextBytes: plain.ciphertext,
    withTables: { totalBytes: tables.plaintext, ciphertextBytes: tables.ciphertext, addedBytes: tables.plaintext - plain.plaintext, instancesRewritten: tables.tablesAdded, packMs: tables.packMs },
    packMs: plain.packMs,
  };
  console.error(`${name}: ${(plain.plaintext / 1e6).toFixed(1)} MB; offset tables add ${tables.plaintext - plain.plaintext} bytes; shares ${plain.sid}, ${tables.sid}`);
}
writeFileSync("/tmp/wsi-fixtures.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]: any) => [k, { ...v, plainLink: undefined, tablesLink: undefined }])), null, 2));
