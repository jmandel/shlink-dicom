// Test data for share-checks, and the expectations read from it.
//   bun web/checks/share-fixtures.ts synthetic <dir>   writes a synthetic CT series (TGZ) and a DX (ZIP)
//   bun web/checks/share-fixtures.ts expect <path>…    reads files, archives or folders as /share does
// Both print JSON: { files, studies: [{ title, uid, series, images, bytes }], series, images, bytes }.
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Collection, expand, plainStudyTitle, studyCounts, studyModalities } from "../share/lib/ingest";
import { BlobBytes } from "../share/lib/bytes";
import { memoryStager } from "../share/lib/stage";
import { ctSeries, dxImage } from "./synthetic";

function walk(p: string): string[] {
  if (!statSync(p).isDirectory()) return [p];
  return readdirSync(p).sort().flatMap((f) => walk(join(p, f)));
}

export async function expectations(paths: string[]) {
  const col = new Collection();
  const stager = memoryStager();
  for (const p of paths) for (const f of walk(p)) for await (const e of expand(f, new BlobBytes(Bun.file(f)), stager)) await col.add(e.name, e.src);
  col.finish();
  const studies = col.list().map((s) => ({ title: plainStudyTitle(s.description, studyModalities(s)), uid: s.uid, ...studyCounts(s) }));
  return { files: paths, studies, series: col.seriesCount, images: col.instanceCount, bytes: col.bytes };
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "synthetic") {
  const dir = rest[0];
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(`${dir}/src/ct`, { recursive: true });
  mkdirSync(`${dir}/src/dx`, { recursive: true });
  ctSeries(60, 256).forEach((b, i) => writeFileSync(`${dir}/src/ct/IM${String(i + 1).padStart(4, "0")}.dcm`, b));
  writeFileSync(`${dir}/src/dx/IM0001.dcm`, dxImage(1024));
  execFileSync("tar", ["-czf", `${dir}/synthetic-ct.tgz`, "-C", `${dir}/src`, "ct"]);
  execFileSync("zip", ["-qr", `${dir}/synthetic-dx.zip`, "dx"], { cwd: `${dir}/src` });
  rmSync(`${dir}/src`, { recursive: true });
  console.log(JSON.stringify(await expectations([`${dir}/synthetic-ct.tgz`, `${dir}/synthetic-dx.zip`])));
} else if (cmd === "expect") {
  console.log(JSON.stringify(await expectations(rest)));
} else {
  console.error("usage: share-fixtures.ts synthetic <dir> | expect <path>…");
  process.exit(2);
}
