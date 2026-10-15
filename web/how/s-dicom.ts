// Step 8: the DICOM header and Pixel Data. A few header attributes as stored, then the pixels,
// decoded in a worker, with brightness and contrast.
import { decryptParams, parseDicomSync, T, tagHex, type DataSet } from "../core/index";
import type { DecodedImage } from "../core/images";
import { displayPlan } from "../core/display";
import { showImage, Viewport } from "../core/render";
import { code, excerpt, h, hex, n, para, S } from "./state";

const TS_NAMES: Record<string, string> = {
  "1.2.840.10008.1.2": "Implicit VR Little Endian: uncompressed",
  "1.2.840.10008.1.2.1": "Explicit VR Little Endian: uncompressed",
};

/** Brightness (window centre) and contrast (window width) sliders, and dragging on the image. */
function windowControls(vp: Viewport, img: DecodedImage, header: DataSet, w0: { center: number; width: number }, stage: HTMLElement, cs: HTMLInputElement, ws: HTMLInputElement, onChange: (c: number, w: number) => void) {
  const lo = (img.minValue ?? 0) * img.rescaleSlope + img.rescaleIntercept;
  const hi = (img.maxValue ?? 4095) * img.rescaleSlope + img.rescaleIntercept;
  const span = Math.max(1, hi - lo);
  let c = w0.center, w = w0.width;
  const toSliders = () => {
    cs.value = String(Math.round(100 * (1 - (c - lo) / span)));
    ws.value = String(Math.round(100 * (1 - Math.log(w) / Math.log(span * 2))));
  };
  const apply = () => {
    vp.setView(displayPlan(img, 0, header, { kind: "window", center: c, width: w }).view);
    onChange(c, w);
  };
  cs.oninput = () => ((c = lo + (1 - Number(cs.value) / 100) * span), apply());
  ws.oninput = () => ((w = Math.max(1, Math.exp((1 - Number(ws.value) / 100) * Math.log(span * 2)))), apply());
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
}

export async function mountDicom(pic: HTMLElement, exact: HTMLElement) {
  const series = S.series!;
  const pool = await S.pool!;
  const { plan, bytes: ct } = await S.share!.loader.ciphertext(series, S.slice);
  const bytes = await pool.decrypt(ct.slice(), await decryptParams(series, plan));
  const { ds, meta, transferSyntax } = parseDicomSync(bytes);
  const px = ds.get(T.PixelData);
  const row = (t: number, name: string, value: string, d: DataSet = ds) => `${tagHex(t)} ${(d.get(t)?.vr ?? "  ").padEnd(2)}  ${name.padEnd(20)} ${value}`;
  const lines = [
    `bytes 0–127: preamble; bytes 128–131: "DICM"`,
    row(T.TransferSyntaxUID, "Transfer Syntax UID", transferSyntax, meta),
    row(T.PatientName, "Patient's Name", ds.str(T.PatientName) ?? ""),
    row(T.Modality, "Modality", ds.str(T.Modality) ?? ""),
    row(T.SeriesDescription, "Series Description", ds.str(T.SeriesDescription) ?? ""),
    row(T.Rows, "Rows", String(ds.nums(T.Rows)[0] ?? "")),
    row(T.Columns, "Columns", String(ds.nums(T.Columns)[0] ?? "")),
    row(T.BitsStored, "Bits Stored", String(ds.nums(T.BitsStored)[0] ?? "")),
    row(T.WindowCenter, "Window Center", ds.strs(T.WindowCenter).join("\\")),
    row(T.WindowWidth, "Window Width", ds.strs(T.WindowWidth).join("\\")),
    px ? row(T.PixelData, "Pixel Data", `${n(px.length)} bytes, from byte ${n(px.offset)}`) : "",
  ].filter(Boolean);
  const stage = h("div", { class: "stage", "aria-label": "The slice. Drag to change brightness and contrast." });
  const cs = h("input", { id: "wl-c", type: "range", min: "0", max: "100", "aria-label": "Brightness" }) as HTMLInputElement;
  const ws = h("input", { id: "wl-w", type: "range", min: "0", max: "100", "aria-label": "Contrast" }) as HTMLInputElement;
  const numbers = h("p", { class: "cap" });
  pic.replaceChildren(
    h("p", { class: "cap", text: `The DICOM header of slice ${S.slice + 1}, a few of its ${n(ds.elements.size)} attributes:` }),
    excerpt(lines.join("\n"), [/Patient's Name/, /Pixel Data/], "The DICOM header"),
    h("p", { class: "cap", text: "The Pixel Data, drawn:" }),
    stage,
    h("div", { class: "sliders" }, h("label", { class: "field" }, h("span", { class: "field-label", text: "Brightness" }), cs), h("label", { class: "field" }, h("span", { class: "field-label", text: "Contrast" }), ws)),
    numbers,
  );
  const name = ds.get(T.PatientName)!;
  exact.replaceChildren(
    para("Each attribute is stored as a tag (group, element), a two-letter value representation (VR), a length, then the value. The patient's name as stored, from byte ", n(name.offset), ":"),
    h("pre", { class: "code wrap", text: `${hex(bytes.subarray(name.offset - 8, name.offset)).replace(/(..)/g, "$1 ")} | ${hex(bytes.subarray(name.offset, name.offset + name.length)).replace(/(..)/g, "$1 ")}\n${" ".repeat(24)}| ${new TextDecoder().decode(bytes.subarray(name.offset, name.offset + name.length))}` }),
    para("The transfer syntax, ", code(transferSyntax), ", is ", TS_NAMES[transferSyntax] ?? "a compressed encoding", ": the Pixel Data is each pixel's value, two bytes little-endian, row by row. Decoding still runs in a worker, with our own decoder (Rust compiled to WebAssembly), which also reads the compressed transfer syntaxes: JPEG, JPEG-LS, JPEG 2000, HTJ2K, JPEG XL and RLE."),
    para("Brightness and contrast set the window: pixel values from centre − width/2 to centre + width/2 spread over black to white. The scanner's own suggestion is the Window Center and Width in the header."),
  );
  // The pixels, decoded in a worker. A copy: the header still reads these bytes, and decode transfers its input.
  const img = await pool.decode(bytes, { priority: 0, copy: true });
  const vp = new Viewport(stage);
  const shown = showImage(vp, img, 0, { kind: "auto" }, ds);
  windowControls(vp, img, ds, shown.window ?? { center: 128, width: 256 }, stage, cs, ws, (c, w) => {
    numbers.textContent = `${img.columns} × ${img.rows} pixels, decoded in ${img.decodeMs.toFixed(1)} ms. Window centre ${Math.round(c)}, width ${Math.round(w)}.`;
  });
}
