// Shares each case of the object-type sweep (codec-corpus/prevalence/SOPCLASS_SWEEP.md) on a server,
// one share per case, packed as the Share page packs (pack-share.ts).
//   bun web/checks/sop-sweep-fixtures.ts [base] [root] [caseId…]
// root (default /media/barracuda/sop-sweep) holds cases.json, cases-extra.json and dl/<SeriesInstanceUID>/.
// Writes root/shares.json: { [caseId]: { link, sid, token, files, skipped } }.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { packAndShare } from "./pack-share";

const base = process.argv[2] ?? "http://localhost:3471";
const root = process.argv[3] ?? "/media/barracuda/sop-sweep";
const only = new Set(process.argv.slice(4));
const cases = [
  ...JSON.parse(readFileSync(`${root}/cases.json`, "utf8")).cases,
  ...(existsSync(`${root}/cases-extra.json`) ? JSON.parse(readFileSync(`${root}/cases-extra.json`, "utf8")).cases : []),
];
const outPath = `${root}/shares.json`;
const prev: Record<string, any> = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : {};
const out: Record<string, any> = { ...prev };
for (const c of cases) {
  if (only.size && !only.has(c.id)) continue;
  if (prev[c.id]) await fetch(`${base}/api/shares/${prev[c.id].sid}`, { method: "DELETE", headers: { Authorization: `Bearer ${prev[c.id].token}` } }).catch(() => {});
  const files: { name: string; bytes: Uint8Array }[] = [];
  for (const uid of c.series) {
    const dir = c.dirs?.[uid] ?? `${root}/dl/${uid}`;
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".dcm")).sort()) files.push({ name: `${uid}/${f}`, bytes: new Uint8Array(readFileSync(`${dir}/${f}`)) });
  }
  try {
    const s = await packAndShare(base, files);
    const { shlink } = await s.mint(s.bundle, { label: `Sweep: ${c.id}` });
    out[c.id] = { link: shlink, sid: s.sid, token: s.token, files: files.length, skipped: s.skipped };
    console.error(`${c.id}: ${files.length} files${s.skipped.length ? `, skipped ${s.skipped.map((x: any) => `${x.name} (${x.reason})`).join(", ")}` : ""}`);
  } catch (e) {
    out[c.id] = { error: String(e).slice(0, 300), files: files.length };
    console.error(`${c.id}: FAILED ${String(e).slice(0, 200)}`);
  }
  writeFileSync(outPath, JSON.stringify(out, null, 1));
}
