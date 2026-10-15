// Step 5: the encrypted file and its records. A strip of the file's 64 KiB records around this
// slice, the arithmetic to the record range and the exact Range header. Dragging across the strip
// fetches the chosen records with one Range request; every image wholly inside them is decrypted
// and decoded in a worker and appears.
import { decryptParams, planBytes, planInstances, RECORD_CIPHERTEXT, RECORD_PLAINTEXT, type SeriesEntry } from "../core/index";
import type { DecodedImage } from "../core/images";
import { drawThumbnail } from "../core/render";
import { code, excerpt, h, mb, n, onRequest, para, recordLength, reqRow, S } from "./state";

/** Fetches records a..b (inclusive) of the series' file with one Range request. */
async function fetchRecords(series: SeriesEntry, a: number, b: number) {
  const plan = planBytes(series, a * RECORD_PLAINTEXT, Math.min(series.file.plaintextLength, (b + 1) * RECORD_PLAINTEXT));
  return S.share!.resolver.fetchRange(plan);
}

/** Decrypts and decodes image i, whose records are inside ciphertext `ct` starting at record `a`, in one worker job. */
async function decodeFrom(series: SeriesEntry, i: number, ct: Uint8Array, a: number): Promise<DecodedImage> {
  const inst = series.instances[i];
  const start = (inst.firstRecord - a) * RECORD_CIPHERTEXT;
  const end = (inst.lastRecord - a) * RECORD_CIPHERTEXT + recordLength(series.file, inst.lastRecord);
  const encrypted = await decryptParams(series, planInstances(series, i));
  const pool = await S.pool!;
  return pool.decode(ct.slice(start, end), { encrypted, priority: 0, header: true });
}

export function mountFile(pic: HTMLElement, exact: HTMLElement) {
  const series = S.series!;
  const f = series.file;
  const inst = series.instances[S.slice];
  const pad = 6;
  // The strip stays inside this series' records: the file also holds the study's other series.
  const w0 = Math.max(series.firstRecord, inst.firstRecord - pad);
  const w1 = Math.min(series.lastRecord, inst.lastRecord + pad);
  const count = w1 - w0 + 1;
  let sel: [number, number] = [inst.firstRecord, inst.lastRecord];
  const got = new Set<number>();

  const pct = (r: number) => `${(100 * r) / f.recordCount}%`;
  const overview = h(
    "div",
    { class: "overview", "aria-hidden": "true" },
    h("i", { class: "sl", style: `left:${pct(inst.firstRecord)};width:max(3px, ${pct(inst.lastRecord - inst.firstRecord + 1)})` }),
    h("i", { class: "win", style: `left:${pct(w0)};width:max(6px, ${pct(count)})` }),
  );
  const strip = h("div", {
    class: "strip",
    role: "group",
    tabindex: "0",
    "aria-label": `Records ${w0} to ${w1} of the file. Drag to choose records; arrow keys move the choice, Shift with an arrow key resizes it.`,
    style: `grid-template-columns: repeat(${count}, 1fr)`,
  });
  const cells: HTMLElement[] = [];
  for (let r = w0; r <= w1; r++) {
    const c = h("div", { class: `rec${r >= inst.firstRecord && r <= inst.lastRecord ? " slice" : ""}` });
    cells.push(c);
    strip.append(c);
  }
  const caption = h("p", { class: "cap" });
  const rangeLine = h("pre", { class: "code wrap", "aria-label": "The Range request" });
  const thumbs = h("div", { class: "thumbs", "aria-live": "polite" });

  const last = inst.offset + inst.length - 1;
  const plan0 = planInstances(series, S.slice);
  pic.replaceChildren(
    h("p", { class: "cap", text: `The encrypted file: ${n(f.recordCount)} records, ${mb(f.ciphertextLength)}. The bar is the whole file; the strip below is the part around this slice.` }),
    overview,
    strip,
    caption,
    h("p", { class: "cap", text: "From byte offsets to records, and the request your browser sent:" }),
    excerpt(
      [
        `this slice:   bytes ${n(inst.offset)} to ${n(last)} of the file's contents`,
        `first record: ⌊${n(inst.offset)} ÷ 65,520⌋ = ${inst.firstRecord}`,
        `last record:  ⌊${n(last)} ÷ 65,520⌋ = ${inst.lastRecord}`,
        `on the server each record takes 65,536 bytes, so:`,
        `GET /…/${f.fileId}.bin`,
        `Range: ${plan0.rangeHeader}`,
      ].join("\n"),
      [/^Range:/],
      "From byte offsets to records",
    ),
    h("p", { class: "cap", text: "Images in your chosen records:" }),
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
    caption.textContent = `Chosen: records ${sel[0]}–${sel[1]}. The underlined ones hold slice ${S.slice + 1}.`;
    rangeLine.textContent = `Range: ${plan.rangeHeader}`;
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
      ct = await fetchRecords(series, a, b);
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
      const name = `Instance ${i + 1}`;
      if (!(x.firstRecord >= a && x.lastRecord <= b)) {
        const need = x.firstRecord < a ? a - 1 : b + 1;
        card.append(h("div", { class: "cut", text: `Needs record ${need}` }), h("span", { text: `${name}: cut off` }));
      } else {
        let cv = thumbCache.get(i);
        if (!cv) {
          const c = (cv = h("canvas", { width: 128, height: 128, "aria-label": `${name}, decoded` }));
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
  };

  // Choosing records: drag (mouse, pen or touch), or the arrow keys.
  let dragFrom = -1;
  const at = (e: PointerEvent) => {
    const r = strip.getBoundingClientRect();
    return w0 + Math.max(0, Math.min(count - 1, Math.floor(((e.clientX - r.left) / r.width) * count)));
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
  new ResizeObserver(label).observe(strip);

  // How exactly: the record format, and every request this page has made for records.
  const reqs = h("div", { class: "reqs" });
  const add = (r: any) => r.purpose === "file" && reqs.prepend(reqRow(r));
  for (const r of S.requests) add(r);
  onRequest(add);
  exact.replaceChildren(
    para("A record holds 65,520 bytes of the file's contents, encrypted, then its 16-byte AES-256-GCM tag: 65,536 bytes in all, 64 KiB. Record ", code("i"), " starts at byte 65,536 × ", code("i"), " on the server, so any byte range of the contents maps to one run of records and one Range request. The last record of a file is shorter."),
    para("The study's instances sit end to end, series by series. A record can hold the end of one instance and the start of the next, which is why the instances at the edges of a choice are cut off."),
    para("Your last choice as a request: "),
    rangeLine,
    para("Every Range request this page has made for records:"),
    reqs,
  );
  void load();
}
