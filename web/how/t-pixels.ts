// Step 5: bytes to pixels. The unlocked file's header, with a few attributes labelled as stored,
// then the pixels drawn as the slice, with brightness and contrast.
// Step 5b: the same for a compressed slice (JPEG 2000) from a public research collection,
// decoded in a worker.
import { parseDicomSync, T, tagHex, decryptParams, siteUrl } from "../core/index";
import type { DecodedImage } from "../core/images";
import { showImage, Viewport } from "../core/render";
import { displayPlan } from "../core/display";
import type { DataSet } from "../core/dicom";
import type { Scene } from "./how";
import { $, h, mb, n, S } from "./state";

const TS_NAMES: Record<string, string> = {
  "1.2.840.10008.1.2": "Implicit VR Little Endian (uncompressed)",
  "1.2.840.10008.1.2.1": "Explicit VR Little Endian (uncompressed)",
  "1.2.840.10008.1.2.4.90": "JPEG 2000 Lossless",
  "1.2.840.10008.1.2.4.91": "JPEG 2000",
  "1.2.840.10008.1.2.4.80": "JPEG-LS Lossless",
  "1.2.840.10008.1.2.4.201": "HTJ2K Lossless",
  "1.2.840.10008.1.2.4.70": "JPEG Lossless",
};

const hexOf = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

/** One labelled header row: the plain name, the value, and (details) the tag with its bytes as stored. */
function hdrRow(name: string, value: string, tagText: string, bytes: Uint8Array, at: number) {
  return [
    h("dt", { text: name }),
    h("dd", {}, value, " ", h("span", { class: "tg only-d", style: "display:inline" }, tagText), h("span", { class: "hx only-d" }, `byte ${n(at)}: `, h("b", { text: hexOf(bytes.subarray(0, 16)) }), bytes.length > 16 ? " …" : "")),
  ];
}

/** Wires brightness/contrast sliders and dragging on the stage to a viewport. */
function windowControls(vp: Viewport, img: DecodedImage, header: DataSet | null, w0: { center: number; width: number }, stage: HTMLElement, onChange: (c: number, w: number) => void) {
  const lo = (img.minValue ?? 0) * img.rescaleSlope + img.rescaleIntercept;
  const hi = (img.maxValue ?? 4095) * img.rescaleSlope + img.rescaleIntercept;
  const span = Math.max(1, hi - lo);
  let c = w0.center, w = w0.width;
  const cs = $<HTMLInputElement>("wl-c"), ws = $<HTMLInputElement>("wl-w");
  // Brightness up = lower centre; contrast up = narrower width (log scale).
  const toSliders = () => {
    cs.value = String(Math.round(100 * (1 - (c - lo) / span)));
    ws.value = String(Math.round(100 * (1 - Math.log(w / 1) / Math.log(span * 2))));
  };
  const apply = () => {
    vp.setView(displayPlan(img, 0, header, { kind: "window", center: c, width: w }).view);
    onChange(c, w);
  };
  cs.oninput = () => {
    c = lo + (1 - Number(cs.value) / 100) * span;
    apply();
  };
  ws.oninput = () => {
    w = Math.max(1, Math.exp((1 - Number(ws.value) / 100) * Math.log(span * 2)));
    apply();
  };
  let last: { x: number; y: number } | null = null;
  stage.onpointerdown = (e) => {
    stage.setPointerCapture(e.pointerId);
    last = { x: e.clientX, y: e.clientY };
  };
  stage.onpointermove = (e) => {
    if (!last) return;
    const k = span / Math.max(200, stage.clientWidth);
    w = Math.max(1, w + (e.clientX - last.x) * k * 2);
    c = c + (e.clientY - last.y) * k;
    last = { x: e.clientX, y: e.clientY };
    toSliders();
    apply();
  };
  stage.onpointerup = stage.onpointercancel = () => (last = null);
  toSliders();
  apply();
  return { reset: () => ((c = w0.center), (w = w0.width), toSliders(), apply()) };
}

export function pixelsScene(): Scene {
  const series = S.series!;
  const hdr = h("dl", { class: "hdr", "aria-label": "The file's header" }, h("dt", { text: "Header" }), h("dd", { class: "muted", text: "Unlocking…" }));
  const stage = h("div", { class: "stage grow", "aria-label": "The slice. Drag to change brightness and contrast." });
  const el = h("section", { class: "scene", "data-scene": "pixels", "aria-label": "Bytes to pixels" }, h("p", { class: "scene-title", text: `Slice ${S.slice + 1}, unlocked` }), hdr, stage);
  let vp: Viewport | null = null;
  let img: DecodedImage | null = null;
  let started = false;

  const run = async () => {
    const pool = await S.pool!;
    const { plan, bytes: ct } = await S.share!.loader.ciphertext(series, S.slice);
    const bytes = await pool.decrypt(ct.slice(), await decryptParams(series, plan));
    // The header, read here (a few kilobytes, before the pixels).
    const { ds, transferSyntax } = parseDicomSync(bytes);
    const off = (t: number, d = ds) => d.get(t);
    const name = off(T.PatientName);
    const rows = off(T.Rows), cols = off(T.Columns), px = off(T.PixelData);
    const parts: HTMLElement[] = [];
    parts.push(...hdrRow("File marker", "DICM: a DICOM file", "", bytes.subarray(128, 132), 128));
    if (name) parts.push(...hdrRow("Patient", ds.str(T.PatientName) ?? "", tagHex(T.PatientName), bytes.subarray(name.offset, name.offset + name.length), name.offset));
    if (rows && cols) parts.push(...hdrRow("Size", `${ds.nums(T.Columns)[0]} × ${ds.nums(T.Rows)[0]} pixels`, `${tagHex(T.Columns)} ${tagHex(T.Rows)}`, bytes.subarray(rows.offset, cols.offset + cols.length), rows.offset));
    if (px) parts.push(...hdrRow("Pixels", `start at byte ${n(px.offset)} of ${n(bytes.length)}`, tagHex(T.PixelData), bytes.subarray(px.offset, px.offset + 16), px.offset));
    hdr.replaceChildren(...parts);
    // The pixels: decoded in a worker.
    // A copy: the header (ds) still reads these bytes, and decode transfers what it is given.
    img = await pool.decode(bytes, { priority: 0, copy: true });
    vp = new Viewport(stage);
    const shownPlan = showImage(vp, img!, 0, { kind: "auto" }, ds);
    const tsName = TS_NAMES[transferSyntax] ?? transferSyntax;
    windowControls(vp, img!, ds, shownPlan.window ?? { center: 128, width: 256 }, stage, (c, w) => {
      $("d-pixels").textContent = `Transfer syntax ${transferSyntax}: ${tsName}. ${img!.columns} × ${img!.rows} pixels, ${img!.bitsStored} bits stored in ${img!.bitsAllocated}. The scanner suggests a window of centre ${img!.windowCenter ?? "–"}, width ${img!.windowWidth ?? "–"}; brightness and contrast set it, now centre ${Math.round(c)}, width ${Math.round(w)}. Decoded in a worker in ${img!.decodeMs.toFixed(1)} ms.`;
    });
  };
  return {
    id: "pixels",
    el,
    enter: () => {
      if (!started) {
        started = true;
        run().catch((e) => hdr.replaceChildren(h("dt", { text: "Error" }), h("dd", { class: "bad", text: (e as Error).message })));
      }
    },
  };
}

export function compressedScene(): Scene {
  const info = h("div", { class: "cmp-sizes" }, h("p", { class: "muted small", text: "Fetching…" }));
  const stage = h("div", { class: "stage grow", "aria-label": "A compressed CT slice, decoded in this browser" });
  const credit = h("p", { class: "small muted", style: "margin:0" });
  const el = h("section", { class: "scene", "data-scene": "compressed", "aria-label": "A compressed image" }, h("p", { class: "scene-title", text: "A compressed CT slice" }), info, stage, credit);
  let started = false;
  const run = async () => {
    const meta = await (await fetch(siteUrl("how/compressed.json"))).json();
    const res = await fetch(siteUrl(`how/${meta.file}`));
    const bytes = new Uint8Array(await res.arrayBuffer());
    const pool = await S.pool!;
    const img = await pool.decode(bytes.slice(), { priority: 0 });
    const raw = img.frameBytes;
    const pct = (x: number) => `${Math.max(2, (100 * x) / raw)}%`;
    info.replaceChildren(
      h("div", {}, `In the file: ${mb(bytes.length)}`, h("div", { class: "sizebar", style: `width:${pct(bytes.length)}` })),
      h("div", {}, `As pixels: ${mb(raw)}`, h("div", { class: "sizebar raw", style: "width:100%" })),
    );
    const vp = new Viewport(stage);
    showImage(vp, img, 0, { kind: "auto" }, parseDicomSync(bytes, { untilPixelData: true }).ds);
    credit.textContent = meta.credit;
    $("d-compressed").textContent = `Transfer syntax ${img.transferSyntax}: ${TS_NAMES[img.transferSyntax] ?? img.transferSyntax}. ${img.columns} × ${img.rows} pixels, ${img.bitsStored} bits stored. ${n(bytes.length)} bytes in the file, ${n(raw)} once decoded: ${(raw / bytes.length).toFixed(1)} times smaller, with no loss. Decoded in ${img.decodeMs.toFixed(1)} ms in a worker, by our own decoder: Rust compiled to WebAssembly. It also reads the other JPEG modes, JPEG 2000, JPEG-LS, HTJ2K, JPEG XL and RLE.`;
  };
  return {
    id: "compressed",
    el,
    enter: () => {
      if (!started) {
        started = true;
        run().catch((e) => info.replaceChildren(h("p", { class: "bad", text: (e as Error).message })));
      }
    },
  };
}
