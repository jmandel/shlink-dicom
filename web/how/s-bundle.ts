// Step 2: the decrypted Bundle as a collapsible tree. ImagingStudy.series is highlighted, and
// each instance has a button that shows its byte offset in the series file.
import { EXT_SERIES_FILE, type SeriesEntry } from "../core/index";
import { $, h, n, on, S, select, seriesByFile } from "./state";

type Path = (string | number)[];
interface Ctx {
  series?: { study: number; series: number; entry: SeriesEntry };
}

let openPaths = new Set<string>();
let pressed: HTMLButtonElement | null = null;

function prim(v: unknown): HTMLElement {
  if (typeof v === "string") return h("span", { class: "j-str", text: JSON.stringify(v) });
  if (typeof v === "number") return h("span", { class: "j-num", text: String(v) });
  return h("span", { class: "j-lit", text: JSON.stringify(v) });
}

function keyLabel(k: string | number | null) {
  return k === null ? null : h("span", { class: "j-key", text: typeof k === "number" ? String(k) : JSON.stringify(k) });
}

function seriesFileId(obj: any): string | null {
  const ext = (obj?.extension ?? []).find((e: any) => e?.url === EXT_SERIES_FILE);
  return ext?.extension?.find((e: any) => e.url === "id")?.valueString ?? null;
}

function node(k: string | number | null, v: any, path: Path, ctx: Ctx, parent: any): HTMLElement {
  if (v === null || typeof v !== "object") {
    return h("div", { class: "j-row" }, keyLabel(k), k === null ? null : ": ", prim(v));
  }
  const isArr = Array.isArray(v);
  const count = isArr ? v.length : Object.keys(v).length;
  const kind = !isArr && typeof v.resourceType === "string" ? v.resourceType : null;
  const d = h("details", { class: "j-node" });
  const summary = h(
    "summary",
    {},
    keyLabel(k),
    h("span", { text: isArr ? "[…]" : "{…}" }),
    h("span", { class: "j-meta", text: kind ?? (isArr ? `${count} item${count === 1 ? "" : "s"}` : `${count} key${count === 1 ? "" : "s"}`) }),
  );
  // ImagingStudy.series: highlighted.
  if (k === "series" && parent?.resourceType === "ImagingStudy") d.classList.add("j-hl");
  // A series object: remember which series it is for its instances.
  let childCtx = ctx;
  const fid = !isArr ? seriesFileId(v) : null;
  if (fid) childCtx = { series: seriesByFile(fid) ?? undefined };
  // One instance of a series: offset button.
  const pk = path[path.length - 2];
  if (pk === "instance" && typeof k === "number" && ctx.series) {
    const inst = ctx.series.entry.instances[k];
    if (inst) {
      const s = ctx.series;
      const btn = h("button", {
        class: "j-inst",
        type: "button",
        "aria-pressed": "false",
        text: `offset ${n(inst.offset)}`,
        onclick: (e: Event) => {
          e.preventDefault();
          e.stopPropagation();
          showInstance(s.study, s.series, k, btn);
        },
      });
      summary.append(btn);
    }
  }
  d.append(summary);
  const kids = h("div", { class: "j-children" });
  d.append(kids);
  let filled = false;
  const fill = () => {
    if (filled) return;
    filled = true;
    const entries: [string | number, any][] = isArr ? v.map((x: any, i: number) => [i, x]) : Object.entries(v);
    for (const [ck, cv] of entries) kids.append(node(ck, cv, [...path, ck], childCtx, v));
  };
  d.addEventListener("toggle", () => d.open && fill());
  if (openPaths.has(path.join("."))) {
    d.open = true;
    fill();
  }
  return d;
}

function showInstance(study: number, series: number, i: number, btn: HTMLButtonElement) {
  if (pressed) pressed.setAttribute("aria-pressed", "false");
  pressed = btn;
  btn.setAttribute("aria-pressed", "true");
  const se = S.share!.index.studies[study].series[series];
  const inst = se.instances[i];
  const end = inst.offset + inst.length;
  const box = $("bundle-pick");
  box.classList.remove("hidden");
  box.replaceChildren(
    h(
      "p",
      {},
      h("strong", { text: `Instance ${i + 1} of ${se.instances.length}` }),
      ` in series ${se.number ?? ""} “${se.description ?? se.modality ?? "series"}”.`,
    ),
    h(
      "p",
      {},
      `Plaintext bytes ${n(inst.offset)} to ${n(end - 1)} of `,
      h("code", { text: `${se.fileId}.bin` }),
      ` (${n(inst.length)} bytes), in records ${inst.firstRecord}–${inst.lastRecord}. `,
      i === 0 ? "It is the first instance, so its offset is 0." : `The offset is the sum of the ${n(i)} lengths before it.`,
    ),
    h("p", {}, h("button", {
      class: "linkish",
      type: "button",
      text: "Show it in the series file",
      onclick: () => {
        select({ study, series, instance: i }, "bundle");
        document.getElementById("series-file")!.scrollIntoView({ behavior: "smooth", block: "start" });
      },
    })),
  );
}

export function initBundle() {
  on("ready", () => {
    const sh = S.share!;
    const bundle = sh.index.bundle;
    const firstStudy = bundle.entry.findIndex((e: any) => e.resource?.resourceType === "ImagingStudy");
    const p = `entry.${firstStudy}.resource`;
    const fid = sh.index.studies[S.sel.study]?.series[S.sel.series]?.fileId;
    const sIdx = Math.max(0, (bundle.entry[firstStudy].resource.series ?? []).findIndex((x: any) => seriesFileId(x) === fid));
    openPaths = new Set(["", "entry", `entry.${firstStudy}`, p, `${p}.series`, `${p}.series.${sIdx}`, `${p}.series.${sIdx}.instance`]);
    const jweReq = S.requests.find((r) => r.purpose === "bundle");
    $("bundle-stats").textContent =
      `${jweReq ? `${n(jweReq.bytes)} bytes of JWE from the host, ` : ""}${n(sh.bundleBytes.length)} bytes of JSON after decryption and decompression. ` +
      `${sh.index.studies.length} studies, ${sh.index.studies.reduce((a, s) => a + s.series.length, 0)} series, ${n(sh.index.studies.reduce((a, s) => a + s.numberOfInstances, 0))} instances.`;
    const tree = $("bundle-tree");
    tree.replaceChildren(node(null, bundle, [], {}, null));
  });
}
