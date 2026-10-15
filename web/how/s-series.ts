// Step 3: the series file. A record map, a slider over the instances, the computed byte range,
// records, Range header and nonces, and the real request with its verification.
import { planInstances, readDicomHeader, RECORD_PLAINTEXT, recordNonce, RecordAuthenticationError, type SeriesEntry } from "../core/index";
import { formatBytes, studyTitle } from "../core/format";
import { $, currentSeries, facts, h, hex, n, on, reqRow, S, select, storePlain } from "./state";

type RecState = "fetch" | "ok" | "bad";
const recState = new Map<string, Map<number, RecState>>();
let shownFile = "";
let token = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

export function markRecords(fileId: string, a: number, b: number, st: RecState) {
  let m = recState.get(fileId);
  if (!m) recState.set(fileId, (m = new Map()));
  for (let i = a; i <= b; i++) {
    // A verified record stays verified unless a later read of it fails.
    if (st === "fetch" && m.get(i) === "ok") continue;
    m.set(i, st);
  }
  if (fileId === shownFile) paintMap();
}

function paintMap() {
  const { series } = currentSeries();
  const inst = series.instances[S.sel.instance];
  const m = recState.get(series.fileId);
  const cells = $("sf-map").children;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i] as HTMLElement;
    const st = m?.get(i);
    c.className = `rec${st ? ` ${st}` : ""}${inst && i >= inst.firstRecord && i <= inst.lastRecord ? " sel" : ""}`;
  }
}

function buildMap(series: SeriesEntry) {
  const map = $("sf-map");
  map.replaceChildren();
  for (let i = 0; i < series.recordCount; i++) {
    const first = series.instances.findIndex((x) => x.firstRecord <= i && x.lastRecord >= i);
    const starts = series.instances.filter((x) => x.firstRecord === i).length;
    map.append(
      h("span", {
        class: "rec",
        "data-rec": String(i),
        "data-first": String(first),
        title: `Record ${i}: plaintext ${n(i * RECORD_PLAINTEXT)}–${n(Math.min(series.plaintextLength, (i + 1) * RECORD_PLAINTEXT) - 1)}${starts ? `, ${starts} image${starts > 1 ? "s" : ""} start here` : ""}`,
      }),
    );
  }
  map.setAttribute("aria-label", `${series.recordCount} records of ${series.fileId}.bin. Tap a record to pick the first image that starts in it.`);
  shownFile = series.fileId;
}

function fillSeriesSelect() {
  const sel = $<HTMLSelectElement>("sf-series");
  sel.replaceChildren();
  S.share!.index.studies.forEach((st, a) => {
    const g = h("optgroup", { label: studyTitle(st) });
    st.series.forEach((se, b) => {
      g.append(h("option", { value: `${a}/${b}`, text: `${se.number ?? b + 1} · ${se.description ?? se.modality ?? "Series"} · ${se.instances.length} images · ${formatBytes(se.plaintextLength)}` }));
    });
    sel.append(g);
  });
  sel.addEventListener("change", () => {
    const [a, b] = sel.value.split("/").map(Number);
    select({ study: a, series: b, instance: 0 }, "series-select");
  });
}

function render() {
  const { series } = currentSeries();
  const sel = $<HTMLSelectElement>("sf-series");
  sel.value = `${S.sel.study}/${S.sel.series}`;
  if (shownFile !== series.fileId) buildMap(series);
  $("sf-file").textContent = `${series.fileId}.bin · ${n(series.ciphertextLength)} bytes · ${series.recordCount} records`;
  const slider = $<HTMLInputElement>("sf-slider");
  slider.max = String(series.instances.length - 1);
  slider.value = String(S.sel.instance);
  slider.setAttribute("aria-valuetext", `Image ${S.sel.instance + 1} of ${series.instances.length}`);
  paintMap();
  const inst = series.instances[S.sel.instance];
  const plan = planInstances(series, S.sel.instance);
  const nRec = plan.lastRecord - plan.firstRecord + 1;
  facts($("sf-facts"), [
    ["Image", `${S.sel.instance + 1} of ${series.instances.length}${inst.number !== null ? ` (Instance Number ${inst.number})` : ""}`],
    ["Plaintext bytes", `${n(plan.plaintextStart)} to ${n(plan.plaintextEnd - 1)} (${n(inst.length)} bytes)`],
    ["Records", `${plan.firstRecord}–${plan.lastRecord} (${nRec} record${nRec > 1 ? "s" : ""})`],
    ["Request", h("code", { text: `GET ${series.fileId}.bin\nRange: ${plan.rangeHeader}` }), "mono"],
    ["Nonces", nRec === 1 ? hex(recordNonce(plan.firstRecord)) : `${hex(recordNonce(plan.firstRecord))} … ${hex(recordNonce(plan.lastRecord))}`, "mono"],
    ["Result", h("span", { class: "muted", text: "Fetching…" })],
  ]);
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(fetchCurrent, 180);
}

async function fetchCurrent() {
  const my = ++token;
  const sh = S.share!;
  const { series } = currentSeries();
  const i = S.sel.instance;
  const inst = series.instances[i];
  const plan = planInstances(series, i);
  const resultDd = () => $("sf-facts").lastElementChild as HTMLElement;
  markRecords(series.fileId, plan.firstRecord, plan.lastRecord, "fetch");
  const t0 = performance.now();
  try {
    const ct = await sh.resolver.fetchRange(plan);
    const t1 = performance.now();
    const pt = await sh.decryptor.decrypt(series, plan, ct);
    const t2 = performance.now();
    markRecords(series.fileId, plan.firstRecord, plan.lastRecord, "ok");
    storePlain(series, plan.plaintextStart, pt);
    if (my !== token) return;
    let uidOk = false;
    try {
      uidOk = readDicomHeader(pt).sopInstanceUid === inst.uid;
    } catch {}
    const nRec = plan.lastRecord - plan.firstRecord + 1;
    resultDd().replaceChildren(
      h("span", { class: "good", text: `${nRec} record${nRec > 1 ? "s" : ""} verified. ` }),
      `${n(ct.length)} bytes in ${Math.round(t1 - t0)} ms, decrypted in ${(t2 - t1).toFixed(1)} ms. `,
      uidOk ? "The decrypted file starts with DICM and its SOP Instance UID matches the Bundle." : "",
    );
  } catch (e) {
    if (e instanceof RecordAuthenticationError) markRecords(series.fileId, e.recordIndex, e.recordIndex, "bad");
    else markRecords(series.fileId, plan.firstRecord, plan.lastRecord, "bad");
    if (my === token) resultDd().replaceChildren(h("span", { class: "bad", text: String((e as Error).message ?? e) }));
  }
}

/** A tap on the map picks the first image that starts in the record under the finger. */
function onMapClick(e: MouseEvent) {
  const cell = (e.target as HTMLElement).closest<HTMLElement>(".rec");
  if (!cell) return;
  const i = Number(cell.dataset.rec);
  const { series } = currentSeries();
  const start = series.instances.findIndex((x) => x.firstRecord === i && x.offset >= i * RECORD_PLAINTEXT);
  select({ instance: start >= 0 ? start : Number(cell.dataset.first) }, "map");
}

export function initSeries() {
  $("sf-map").addEventListener("click", onMapClick);
  const slider = $<HTMLInputElement>("sf-slider");
  slider.addEventListener("input", () => select({ instance: Number(slider.value) }, "slider"));
  const step = (d: number) => {
    const { series } = currentSeries();
    select({ instance: Math.max(0, Math.min(series.instances.length - 1, S.sel.instance + d)) }, "slider");
  };
  $("sf-prev").addEventListener("click", () => step(-1));
  $("sf-next").addEventListener("click", () => step(1));

  on("ready", () => {
    fillSeriesSelect();
    render();
    schedule();
  });
  on("select", () => {
    render();
    schedule();
  });

  const net = $("sf-net");
  on("request", (r) => {
    net.prepend(reqRow(r));
    while (net.children.length > 40) net.lastElementChild!.remove();
  });
}
