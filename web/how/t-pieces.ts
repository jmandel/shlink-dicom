// Step 3: the pieces. The file as a strip of numbered pieces around this slice; the reader drags
// a selection, the page fetches exactly those pieces with one Range request, and every image wholly
// inside them is decrypted and decoded in a worker and appears.
// Step 3b: the same requests as the server receives them.
import { decryptParams, planBytes, planInstances, RECORD_CIPHERTEXT, RECORD_PLAINTEXT, type SeriesEntry } from "../core/index";
import type { DecodedImage } from "../core/images";
import { drawThumbnail } from "../core/render";
import type { Scene } from "./how";
import { $, h, mb, n, on, recordLength, S, shortPath, type Req } from "./state";

/** Fetches pieces a..b (inclusive) of the series' file with one Range request. */
export async function fetchPieces(series: SeriesEntry, a: number, b: number) {
  const f = series.file;
  const plan = planBytes(series, a * RECORD_PLAINTEXT, Math.min(f.plaintextLength, (b + 1) * RECORD_PLAINTEXT));
  const ct = await S.share!.resolver.fetchRange(plan);
  return { plan, ct };
}

/** Decrypts and decodes image i, whose pieces are inside ciphertext `ct` starting at piece `a`, in one worker job. */
export async function decodeFrom(series: SeriesEntry, i: number, ct: Uint8Array, a: number): Promise<DecodedImage> {
  const inst = series.instances[i];
  const f = series.file;
  const start = (inst.firstRecord - a) * RECORD_CIPHERTEXT;
  const end = (inst.lastRecord - a) * RECORD_CIPHERTEXT + recordLength(f, inst.lastRecord);
  const encrypted = await decryptParams(series, planInstances(series, i));
  const pool = await S.pool!;
  return pool.decode(ct.slice(start, end), { encrypted, priority: 0 });
}

export function reqRow(r: { method: string; url: string; range?: string; status: number; bytes: number; recipient?: string | null }, full = false) {
  const ok = r.status >= 200 && r.status < 300;
  const path = full ? new URL(r.url).pathname : shortPath(r.url);
  const x = [r.range ? `Range: ${r.range}` : null, `${n(r.bytes)} bytes`, r.recipient ? `recipient=${r.recipient}` : null].filter(Boolean).join(" · ");
  return h("div", { class: "req" }, h("span", { class: "m", text: r.method }), h("span", { class: "p", text: path }), h("span", { class: `s ${ok ? "ok" : "bad"}`, text: String(r.status) }), h("span", { class: "x", text: x }));
}

export function piecesScene(): Scene {
  const series = S.series!;
  const f = series.file;
  const inst = series.instances[S.slice];
  const pad = 6;
  // The window stays inside this series' records: the file also holds the study's other series.
  const w0 = Math.max(series.firstRecord, inst.firstRecord - pad);
  const w1 = Math.min(series.lastRecord, inst.lastRecord + pad);
  const count = w1 - w0 + 1;
  let sel: [number, number] = [inst.firstRecord, inst.lastRecord];
  const got = new Set<number>();

  const overview = h("div", { class: "overview", "aria-hidden": "true" });
  const pct = (r: number) => `${(100 * r) / f.recordCount}%`;
  overview.append(
    h("i", { class: "sl", style: `left:${pct(inst.firstRecord)};width:max(3px, ${pct(inst.lastRecord - inst.firstRecord + 1)})` }),
    h("i", { class: "win", style: `left:${pct(w0)};width:max(6px, ${pct(count)})` }),
  );
  const strip = h("div", { class: "strip", role: "group", tabindex: "0", "aria-label": `Pieces ${w0} to ${w1} of the file. Drag to choose pieces; arrow keys move the choice, Shift and an arrow key resize it.`, style: `grid-template-columns: repeat(${count}, 1fr)` });
  const cells: HTMLElement[] = [];
  for (let r = w0; r <= w1; r++) {
    const c = h("div", { class: `piece${r >= inst.firstRecord && r <= inst.lastRecord ? " slice" : ""}`, "data-r": String(r) });
    cells.push(c);
    strip.append(c);
  }
  const rangeLine = h("p", { class: "range-line only-d" });
  const thumbs = h("div", { class: "thumbs grow", "aria-live": "polite" });
  const caption = h("p", { class: "small muted", style: "margin:0" });
  const el = h(
    "section",
    { class: "scene", "data-scene": "pieces", "aria-label": "The pieces" },
    h("p", { class: "scene-title", text: `The file: ${n(f.recordCount)} pieces, ${mb(f.ciphertextLength)}` }),
    h("div", { class: "strip-wrap" }, overview, h("div", { class: "overview-label" }, h("span", { text: "piece 0" }), h("span", { text: `piece ${n(f.recordCount - 1)}` })), strip),
    caption,
    rangeLine,
    thumbs,
  );

  const label = () => {
    const wide = strip.clientWidth / count >= 26;
    cells.forEach((c, k) => {
      const r = w0 + k;
      c.textContent = wide || r === sel[0] || r === sel[1] ? String(r) : "";
      c.classList.toggle("sel", r >= sel[0] && r <= sel[1] && !got.has(r));
      c.classList.toggle("got", r >= sel[0] && r <= sel[1] && got.has(r));
    });
    const plan = planBytes(series, sel[0] * RECORD_PLAINTEXT, Math.min(f.plaintextLength, (sel[1] + 1) * RECORD_PLAINTEXT));
    rangeLine.textContent = `GET ${f.fileId}.bin  Range: ${plan.rangeHeader}`;
    caption.textContent = `Chosen: pieces ${sel[0]}–${sel[1]} (${sel[1] - sel[0] + 1}). The marked pieces hold slice ${S.slice + 1}.`;
  };

  const thumbCache = new Map<number, HTMLCanvasElement>();
  let token = 0;
  const load = async () => {
    const my = ++token;
    const [a, b] = sel;
    got.clear();
    label();
    let ct: Uint8Array;
    try {
      ct = (await fetchPieces(series, a, b)).ct;
    } catch (e) {
      if (my === token) caption.textContent = `The request failed: ${(e as Error).message}`;
      return;
    }
    if (my !== token) return;
    for (let r = a; r <= b; r++) got.add(r);
    label();
    const lo = a * RECORD_PLAINTEXT, hi = Math.min(f.plaintextLength, (b + 1) * RECORD_PLAINTEXT);
    thumbs.replaceChildren();
    series.instances.forEach((x, i) => {
      if (x.offset + x.length <= lo || x.offset >= hi) return;
      const card = h("div", { class: `thumb${i === S.slice ? " this" : ""}` });
      const whole = x.firstRecord >= a && x.lastRecord <= b;
      const name = `Slice ${i + 1}`;
      if (!whole) {
        const need = x.firstRecord < a ? `piece ${a - 1}` : `piece ${b + 1}`;
        card.append(h("div", { class: "cut", text: `Needs ${need}` }), h("span", { text: `${name}: cut off` }));
      } else {
        let cv = thumbCache.get(i);
        if (!cv) {
          cv = h("canvas", { width: 128, height: 128, "aria-label": `${name}, decoded` });
          const c = cv;
          decodeFrom(series, i, ct, a).then(
            (img) => {
              drawThumbnail(c, img);
              thumbCache.set(i, c);
            },
            (e) => card.append(h("span", { class: "bad", text: (e as Error).message })),
          );
        }
        card.append(cv, h("span", { text: name }));
      }
      thumbs.append(card);
    });
    if (!thumbs.children.length) thumbs.append(h("p", { class: "small muted", text: "No image of this series in these pieces." }));
  };

  // Dragging across the strip.
  let dragFrom = -1;
  const at = (e: PointerEvent) => {
    const r = strip.getBoundingClientRect();
    const k = Math.max(0, Math.min(count - 1, Math.floor(((e.clientX - r.left) / r.width) * count)));
    return w0 + k;
  };
  strip.addEventListener("pointerdown", (e) => {
    strip.setPointerCapture(e.pointerId);
    dragFrom = at(e);
    sel = [dragFrom, dragFrom];
    label();
  });
  strip.addEventListener("pointermove", (e) => {
    if (dragFrom < 0) return;
    const r = at(e);
    sel = [Math.min(dragFrom, r), Math.max(dragFrom, r)];
    label();
  });
  const end = () => {
    if (dragFrom < 0) return;
    dragFrom = -1;
    void load();
  };
  strip.addEventListener("pointerup", end);
  strip.addEventListener("pointercancel", end);
  strip.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (!d) return;
    e.preventDefault();
    if (e.shiftKey) sel = [sel[0], Math.max(sel[0], Math.min(w1, sel[1] + d))];
    else if (sel[0] + d >= w0 && sel[1] + d <= w1) sel = [sel[0] + d, sel[1] + d];
    void load();
  });

  // Details: the arithmetic for this slice, and the requests made.
  const lastOff = inst.offset + inst.length - 1;
  const plan0 = planInstances(series, S.slice);
  $("d-pieces").textContent = `Slice ${S.slice + 1} is bytes ${n(inst.offset)} to ${n(lastOff)} of the file: ⌊${n(inst.offset)} ÷ 65,520⌋ = ${inst.firstRecord} and ⌊${n(lastOff)} ÷ 65,520⌋ = ${inst.lastRecord}, so pieces ${inst.firstRecord} to ${inst.lastRecord}. They start at byte ${inst.firstRecord} × 65,536 = ${n(plan0.ciphertextStart)} on the server, so the browser sends: Range: ${plan0.rangeHeader}.`;
  const reqs = $("d-requests");
  on("request", (r: Req) => {
    reqs.prepend(reqRow(r));
    while (reqs.children.length > 30) reqs.lastElementChild!.remove();
  });
  for (const r of S.requests) reqs.prepend(reqRow(r));

  let started = false;
  return {
    id: "pieces",
    el,
    enter: () => {
      label();
      if (!started) {
        started = true;
        void load();
      }
    },
  };
}

export function hostScene(): Scene {
  const log = h("div", { class: "host-log grow", "aria-label": "Requests as the server receives them" });
  const fill = () => {
    log.replaceChildren(...[...S.requests].reverse().slice(0, 60).map((r) => reqRow(r, true)));
  };
  const el = h(
    "section",
    { class: "scene", "data-scene": "host", "aria-label": "What the server sees" },
    h("p", { class: "scene-title", text: "What the server receives" }),
    log,
  );
  on("request", () => {
    if (el.classList.contains("on")) fill();
  });
  return { id: "host", el, enter: fill };
}
