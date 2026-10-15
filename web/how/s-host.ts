// Step 5: the same requests from both sides. Left: what reaches the host (paths with random ids,
// ranges, sizes, recipient). Right: what this browser decrypted them to (patient, study, pixels).
import { formatDate, formatPersonName, RECORD_PLAINTEXT, studyTitle } from "../core/index";
import { getDecoderPool } from "../core/images";
import { drawThumbnail } from "../core/render";
import { $, facts, h, n, on, reqRow, S, seriesByFile, type Req } from "./state";

let selectedId = 0;
let follow = true;
let drawToken = 0;

function fileIdOf(url: string): string | null {
  const m = /\/([A-Za-z0-9_-]{22})\.bin(?:\?|$)/.exec(url);
  return m ? m[1] : null;
}

function rangeOf(r: Req): [number, number] | null {
  const m = /bytes=(\d+)-(\d+)/.exec(r.range ?? "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}

async function showCarried(r: Req) {
  const box = $("host-carried");
  const my = ++drawToken;
  if (r.purpose === "bundle" || r.purpose === "manifest") {
    const idx = S.share!.index;
    box.replaceChildren(
      h("p", { class: "cap" }, h("strong", { text: "The Bundle. " }), `To the host: ${n(r.bytes)} bytes it cannot read. Here: the patient, ${idx.studies.length} studies, ${idx.studies.reduce((a, s) => a + s.series.length, 0)} series and a key for each series file.`),
    );
    return;
  }
  const fid = fileIdOf(r.url);
  const found = fid ? seriesByFile(fid) : null;
  const rg = rangeOf(r);
  if (!found || !rg) {
    box.replaceChildren(h("p", { class: "cap", text: "A request this page does not know how to map." }));
    return;
  }
  const se = found.entry;
  const first = Math.floor(rg[0] / 65536), last = Math.floor(rg[1] / 65536);
  const a = first * RECORD_PLAINTEXT, b = Math.min(se.plaintextLength, (last + 1) * RECORD_PLAINTEXT);
  const whole = se.instances.map((x, i) => [x, i] as const).filter(([x]) => x.offset >= a && x.offset + x.length <= b);
  const study = S.share!.index.studies[found.study];
  const imgs = whole.length ? (whole.length === 1 ? `image ${whole[0][1] + 1}` : `images ${whole[0][1] + 1}–${whole[whole.length - 1][1] + 1}`) : "part of one image";
  const caption = h(
    "p",
    { class: "cap" },
    h("strong", { text: `${studyTitle(study)} · ${se.description ?? se.modality ?? "series"}` }),
    h("br"),
    `Records ${first}–${last}: ${imgs} of ${se.instances.length}.`,
  );
  box.replaceChildren(caption);
  const shown = whole.find(([, i]) => S.plain.has(`${se.fileId}/${i}`));
  if (!shown) {
    box.append(h("p", { class: "small muted", text: whole.length ? "Decrypting…" : "This request carried part of an image, not a whole one." }));
    return;
  }
  const canvas = h("canvas", { width: 512, height: 512, "aria-label": `Image ${shown[1] + 1}, decoded in this browser` });
  box.append(canvas);
  try {
    const pool = await getDecoderPool();
    const img = await pool.decode(S.plain.get(`${se.fileId}/${shown[1]}`)!.slice());
    if (my !== drawToken) return;
    drawThumbnail(canvas, img);
    box.append(h("p", { class: "small muted", text: `Image ${shown[1] + 1}: ${img.columns}×${img.rows}, decoded in ${img.decodeMs.toFixed(1)} ms.` }));
  } catch (e) {
    box.append(h("p", { class: "small bad", text: `Could not decode: ${(e as Error).message}` }));
  }
}

function addRow(r: Req) {
  const log = $("host-log");
  const row = reqRow(r, "button", true);
  row.setAttribute("role", "option");
  row.dataset.id = String(r.id);
  row.addEventListener("click", () => {
    follow = false;
    pick(r);
  });
  log.prepend(row);
  while (log.children.length > 60) log.lastElementChild!.remove();
  if (follow && (r.purpose === "series" || !selectedId) && r.status < 300) pick(r);
}

function pick(r: Req) {
  selectedId = r.id;
  for (const el of $("host-log").children) el.setAttribute("aria-selected", String((el as HTMLElement).dataset.id === String(r.id)));
  showCarried(r);
}

export function initHost() {
  on("ready", () => {
    const idx = S.share!.index;
    facts($("host-patient"), [
      ["Patient", formatPersonName(idx.patient.name) || "Not given"],
      ...(idx.patient.birthDate ? [["Born", formatDate(idx.patient.birthDate)] as [string, string]] : []),
      ["Studies", idx.studies.map((s) => `${studyTitle(s)}${s.started ? ` (${formatDate(s.started)})` : ""}`).join("; ")],
    ]);
    for (const r of S.requests) addRow(r);
  });
  on("plain", (fileId: string) => {
    const r = S.requests.find((x) => x.id === selectedId);
    if (r && fileIdOf(r.url) === fileId) showCarried(r);
  });
  on("request", (r: Req) => {
    if (S.share) addRow(r);
  });
}
