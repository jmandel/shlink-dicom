// Parses each instance of a slide folder with web/core/wsi.ts and reports the pyramid and the
// offset tables they carry.   bun web/view/wsi-tools/probe.ts <folder>
import { readdirSync, readFileSync, statSync } from "node:fs";
import { buildPyramid, parseSlideHeader, NeedMoreBytes } from "../../core/wsi";
const dir = process.argv[2];
const files = readdirSync(dir).filter((f) => f.endsWith(".dcm")).sort();
const headers = [];
for (const f of files) {
  const fd = Bun.file(`${dir}/${f}`);
  let n = 65520, h;
  for (;;) {
    const bytes = new Uint8Array(await fd.slice(0, n).arrayBuffer());
    try { h = parseSlideHeader(bytes); break; } catch (e) { if (e instanceof NeedMoreBytes) { n = Math.ceil(e.needBytes / 65520) * 65520; continue; } throw e; }
  }
  const part = parseSlideHeader(new Uint8Array(await fd.slice(0, 65520).arrayBuffer()), { partial: true });
  headers.push(h);
  const ext = h.basicOffsets ? `BOT ${h.basicOffsets.length}` : h.extendedOffsets ? `EOT ${h.extendedOffsets.length}` : h.encapsulated && h.numberOfFrames > 1 ? "no offset table" : "";
  console.log(f.slice(0, 8), statSync(`${dir}/${f}`).size, h.flavor, h.transferSyntax, `${h.totalColumns}x${h.totalRows}`, `tile ${h.columns}x${h.rows}`, h.numberOfFrames, h.dimensionOrganization, `header read ${n}`, `partial@64K: tpm=${part.totalColumns} complete=${part.complete} spacing=${part.pixelSpacing}`, `first item ${h.firstFragmentOffset}`, ext);
}
const p = buildPyramid(headers);
console.log("levels", p.levels.map((l) => `${l.width}x${l.height} ds${l.downsample.toFixed(2)} ${l.tilesAcross}x${l.tilesDown}`), "label", p.label, "overview", p.overview, "thumb", p.thumbnail);
