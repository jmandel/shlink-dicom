// Shares each case of the object and display test set (web/checks/objects/samples.json, data in
// its dataRoot) on a server, one share per case, packed as the Share page packs. Writes
// /tmp/objects-fixtures.json: { [caseId]: { link, sid, token, files, skipped } }.
//   bun web/checks/objects-fixtures.ts [base] [caseId…]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { packAndShare } from "./pack-share";

const base = process.argv[2] ?? "http://localhost:3333";
const only = new Set(process.argv.slice(3));
const manifest = JSON.parse(readFileSync(new URL("./objects/samples.json", import.meta.url), "utf8"));
// Remove the shares an earlier run made (the server caps how many sandbox shares exist).
const prev: Record<string, any> = existsSync("/tmp/objects-fixtures.json") ? JSON.parse(readFileSync("/tmp/objects-fixtures.json", "utf8")) : {};
for (const [id, v] of Object.entries(prev)) {
  if (only.size && !only.has(id)) continue;
  await fetch(`${base}/api/shares/${v.sid}`, { method: "DELETE", headers: { Authorization: `Bearer ${v.token}` } }).catch(() => {});
}
const out: Record<string, any> = only.size ? prev : {};
for (const c of manifest.cases) {
  if (c.found === false || (only.size && !only.has(c.id))) continue;
  const files = c.files.map((f: string) => ({ name: f, bytes: new Uint8Array(readFileSync(`${manifest.dataRoot}/${c.id}/${f}`)) }));
  const s = await packAndShare(base, files);
  const { shlink } = await s.mint(s.bundle, { label: `Test: ${c.id}` });
  out[c.id] = { link: shlink, sid: s.sid, token: s.token, files: files.length, skipped: s.skipped };
  console.error(`${c.id}: ${files.length} files${s.skipped.length ? `, skipped ${s.skipped.map((x: any) => `${x.name} (${x.reason})`).join(", ")}` : ""}`);
}
writeFileSync("/tmp/objects-fixtures.json", JSON.stringify(out, null, 2));
