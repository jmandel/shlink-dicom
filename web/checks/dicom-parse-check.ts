// web/core/dicom.ts against pydicom on every file of the codec corpus (and the object test set):
// top-level element count, Rows, Columns, SOP Class UID, Modality, first Window Center.
//   bun web/checks/dicom-parse-check.ts
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseDicom, T } from "../core/dicom";

const root = new URL("../../", import.meta.url).pathname;
const files: string[] = [];
for (const fmt of readdirSync(`${root}codec-corpus/formats`)) {
  try {
    for (const f of readdirSync(`${root}codec-corpus/formats/${fmt}/samples`)) if (f.endsWith(".dcm")) files.push(`${root}codec-corpus/formats/${fmt}/samples/${f}`);
  } catch {}
}
try {
  const M = JSON.parse(readFileSync(`${root}web/checks/objects/samples.json`, "utf8"));
  for (const c of M.cases) for (const f of c.files ?? []) files.push(`${M.dataRoot}/${c.id}/${f}`);
} catch {}
writeFileSync("/tmp/parse-files.txt", files.join("\n"));
const py = `
import json, pydicom
out = {}
for f in open("/tmp/parse-files.txt").read().split("\\n"):
    try:
        d = pydicom.dcmread(f, force=True)
        wc = d.get("WindowCenter", None)
        try:
            wc = float(wc[0]) if wc is not None and not isinstance(wc, (str, float, int)) and hasattr(wc, "__len__") else (float(wc) if wc is not None else None)
        except Exception:
            wc = None
        out[f] = {"n": len(list(d)), "rows": d.get("Rows"), "cols": d.get("Columns"), "sop": str(d.get("SOPClassUID", "")) or None, "mod": d.get("Modality") or None, "wc": wc}
    except Exception as e:
        out[f] = {"err": str(e)}
json.dump(out, open("/tmp/parse-pydicom.json", "w"))
`;
execFileSync("uv", ["run", "--project", `${root}codec-corpus`, "python", "-W", "ignore", "-c", py], { stdio: ["ignore", "ignore", "inherit"] });
const ref = JSON.parse(readFileSync("/tmp/parse-pydicom.json", "utf8"));
let ok = 0, bad = 0, skipped = 0;
for (const f of files) {
  const r = ref[f];
  if (!r || r.err) {
    skipped++;
    continue;
  }
  try {
    const { ds } = await parseDicom(new Uint8Array(readFileSync(f)));
    const mine = { n: ds.elements.size, rows: ds.num(T.Rows), cols: ds.num(T.Columns), sop: ds.str(T.SOPClassUID), mod: ds.str(T.Modality), wc: ds.num(T.WindowCenter) };
    const same = mine.n === r.n && mine.rows === r.rows && mine.cols === r.cols && mine.sop === r.sop && mine.mod === r.mod && (mine.wc === null) === (r.wc === null) && (mine.wc === null || Math.abs(mine.wc - r.wc) < 1e-6);
    if (same) ok++;
    else {
      bad++;
      console.log(`DIFF ${f}: ${JSON.stringify(mine)} vs pydicom ${JSON.stringify(r)}`);
    }
  } catch (e) {
    bad++;
    console.log(`FAIL ${f}: ${e}`);
  }
}
console.log(`${ok}/${ok + bad} files agree with pydicom${skipped ? ` (${skipped} pydicom could not read)` : ""}`);
process.exit(bad ? 1 : 0);
