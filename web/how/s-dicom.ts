// Step 8: the DICOM header and Pixel Data. A few header attributes as stored, the Pixel Data's
// structure (native bytes, or the encapsulated items with the Basic Offset Table and the first
// fragment's JPEG markers), then the pixels, decoded in a worker, with brightness and contrast.
import { decryptParams, parseDicomSync, T, tag, tagHex, type DataSet, type Element } from "../core/index";
import type { DecodedImage } from "../core/images";
import { displayPlan } from "../core/display";
import { showImage, Viewport } from "../core/render";
import { code, excerpt, h, hex, mb, n, para, S } from "./state";

const IMPL_UID = tag(0x0002, 0x0012);
const IMPL_NAME = tag(0x0002, 0x0013);

const TS_NAMES: Record<string, string> = {
  "1.2.840.10008.1.2": "Implicit VR Little Endian (uncompressed)",
  "1.2.840.10008.1.2.1": "Explicit VR Little Endian (uncompressed)",
  "1.2.840.10008.1.2.2": "Explicit VR Big Endian (uncompressed)",
  "1.2.840.10008.1.2.5": "RLE Lossless",
  "1.2.840.10008.1.2.4.50": "JPEG Baseline",
  "1.2.840.10008.1.2.4.51": "JPEG Extended",
  "1.2.840.10008.1.2.4.57": "JPEG Lossless",
  "1.2.840.10008.1.2.4.70": "JPEG Lossless, first-order prediction (SV1)",
  "1.2.840.10008.1.2.4.80": "JPEG-LS Lossless",
  "1.2.840.10008.1.2.4.81": "JPEG-LS near-lossless",
  "1.2.840.10008.1.2.4.90": "JPEG 2000 Lossless",
  "1.2.840.10008.1.2.4.91": "JPEG 2000",
  "1.2.840.10008.1.2.4.201": "HTJ2K Lossless",
  "1.2.840.10008.1.2.4.203": "HTJ2K",
};
const LOSSLESS = new Set(["1.2.840.10008.1.2.5", "1.2.840.10008.1.2.4.57", "1.2.840.10008.1.2.4.70", "1.2.840.10008.1.2.4.80", "1.2.840.10008.1.2.4.90", "1.2.840.10008.1.2.4.201", "1.2.840.10008.1.2.4.202"]);
/** A file meta written by shlink-dicom's transcoder (it sets its Implementation Version Name). */
const OURS = /shl|shlink/i;

const JPEG_MARKERS: Record<number, string> = {
  0xd8: "SOI   start of image",
  0xc0: "SOF0  baseline frame",
  0xc1: "SOF1  extended frame",
  0xc3: "SOF3  lossless frame",
  0xc4: "DHT   Huffman table",
  0xdb: "DQT   quantisation table",
  0xdd: "DRI   restart interval",
  0xda: "SOS   start of scan: the coded pixels follow",
  0xd9: "EOI   end of image",
  0xfe: "COM   comment",
};

/** The first fragment's JPEG markers, up to the start of scan: offset, the bytes, a label. */
function jpegMarkers(frag: Uint8Array): string[] {
  if (frag[0] !== 0xff || frag[1] !== 0xd8) return [];
  const out = [`      @0      ff d8              ${JPEG_MARKERS[0xd8]}`];
  let p = 2;
  while (p + 4 <= frag.length && frag[p] === 0xff) {
    const m = frag[p + 1];
    const len = (frag[p + 2] << 8) | frag[p + 3];
    const shown = hex(frag.subarray(p, p + Math.min(len + 2, m === 0xc3 || m === 0xc0 || m === 0xc1 ? 10 : 4))).replace(/(..)(?!$)/g, "$1 ");
    let label = JPEG_MARKERS[m] ?? (m >= 0xe0 && m <= 0xef ? `APP${m - 0xe0}  application data` : `marker ff ${m.toString(16)}`);
    if (m === 0xc3 || m === 0xc0 || m === 0xc1) {
      const prec = frag[p + 4], rows = (frag[p + 5] << 8) | frag[p + 6], cols = (frag[p + 7] << 8) | frag[p + 8], comps = frag[p + 9];
      label += `: ${prec}-bit, ${rows} rows, ${cols} columns, ${comps} component${comps === 1 ? "" : "s"}`;
    }
    out.push(`      @${String(p).padEnd(6)} ${shown.padEnd(18)} ${label}`);
    if (m === 0xda) {
      const end = frag.length >= 2 && frag[frag.length - 2] === 0xff && frag[frag.length - 1] === 0xd9 ? frag.length - 2 : frag.length;
      out.push(`      … ${n(end - (p + 2 + len))} bytes of coded pixel differences …`);
      if (end < frag.length) out.push(`      @${String(end).padEnd(6)} ff d9              ${JPEG_MARKERS[0xd9]}`);
      break;
    }
    p += 2 + len;
  }
  return out;
}

/** The Pixel Data element, as stored: native bytes, or its encapsulated items. */
function pixelLines(bytes: Uint8Array, px: Element): string[] {
  const head = `${tagHex(T.PixelData)} ${px.vr.padEnd(2)}  Pixel Data`;
  if (!px.fragments?.length) return [`${head}: ${n(px.length)} bytes, from byte ${n(px.offset)}`];
  const [bot, ...frags] = px.fragments;
  const lines = [`${head}: undefined length, made of items, from byte ${n(px.offset)}`];
  const dv = new DataView(bytes.buffer, bytes.byteOffset + bot.offset, bot.length);
  const offsets = Array.from({ length: Math.floor(bot.length / 4) }, (_, i) => dv.getUint32(4 * i, true));
  lines.push(`  (FFFE,E000) item, ${bot.length} bytes: Basic Offset Table ${bot.length ? `[${offsets.join(", ")}]` : "(empty)"}`);
  frags.forEach((fr, i) => {
    lines.push(`  (FFFE,E000) item, ${n(fr.length)} bytes: ${frags.length === 1 ? "the compressed image" : `fragment ${i + 1}`}`);
    if (i === 0) {
      const marks = jpegMarkers(bytes.subarray(fr.offset, fr.offset + fr.length));
      if (marks.length) lines.push(...marks);
      else lines.push(`      ${hex(bytes.subarray(fr.offset, fr.offset + 16)).replace(/(..)(?!$)/g, "$1 ")} …`);
    }
  });
  lines.push(`  (FFFE,E0DD) end of the items`);
  return lines;
}

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
  const encapsulated = !!px?.fragments?.length;
  const tsName = TS_NAMES[transferSyntax] ?? transferSyntax;
  const implName = meta.str(IMPL_NAME) ?? "";
  const implUid = meta.str(IMPL_UID) ?? "";
  const row = (t: number, name: string, value: string, d: DataSet = ds) => `${tagHex(t)} ${(d.get(t)?.vr ?? "  ").padEnd(2)}  ${name.padEnd(27)} ${value}`;
  const lines = [
    `bytes 0–127: preamble; bytes 128–131: "DICM"`,
    row(T.TransferSyntaxUID, "Transfer Syntax UID", `${transferSyntax}: ${tsName}`, meta),
    row(IMPL_UID, "Implementation Class UID", implUid, meta),
    row(IMPL_NAME, "Implementation Version Name", implName, meta),
    row(T.PatientName, "Patient's Name", ds.str(T.PatientName) ?? ""),
    row(T.Modality, "Modality", ds.str(T.Modality) ?? ""),
    row(T.SeriesDescription, "Series Description", ds.str(T.SeriesDescription) ?? ""),
    row(T.Rows, "Rows", String(ds.nums(T.Rows)[0] ?? "")),
    row(T.Columns, "Columns", String(ds.nums(T.Columns)[0] ?? "")),
    row(T.BitsStored, "Bits Stored", String(ds.nums(T.BitsStored)[0] ?? "")),
    row(T.WindowCenter, "Window Center", ds.strs(T.WindowCenter).join("\\")),
    row(T.WindowWidth, "Window Width", ds.strs(T.WindowWidth).join("\\")),
    ...(px ? pixelLines(bytes, px) : []),
  ];
  const stage = h("div", { class: "stage", "aria-label": "The slice. Drag to change brightness and contrast." });
  const cs = h("input", { id: "wl-c", type: "range", min: "0", max: "100", "aria-label": "Brightness" }) as HTMLInputElement;
  const ws = h("input", { id: "wl-w", type: "range", min: "0", max: "100", "aria-label": "Contrast" }) as HTMLInputElement;
  const numbers = h("p", { class: "cap" });
  const encoding = h("p", { class: "cap", id: "dicom-encoding" });
  pic.replaceChildren(
    h("p", { class: "cap", text: `The DICOM header of slice ${S.slice + 1}, a few of its ${n(ds.elements.size)} attributes, and how its Pixel Data is stored:` }),
    excerpt(lines.join("\n"), [/Transfer Syntax UID/, /Implementation Version Name/, /Patient's Name/, /Pixel Data/, /Basic Offset Table/, /SOF3|SOF0|SOF1/], "The DICOM header and Pixel Data"),
    encoding,
    h("p", { class: "cap", text: "The Pixel Data, decoded in this browser:" }),
    stage,
    h("div", { class: "sliders" }, h("label", { class: "field" }, h("span", { class: "field-label", text: "Brightness" }), cs), h("label", { class: "field" }, h("span", { class: "field-label", text: "Contrast" }), ws)),
    numbers,
  );
  const name = ds.get(T.PatientName)!;
  const how = encapsulated
    ? [
        para("Compressed Pixel Data is stored as items. The first item is the Basic Offset Table: where each frame's data starts (empty means a single frame, or that the reader finds frames itself). The items after it hold the compressed frames."),
        ...(/\.4\.(57|70)$/.test(transferSyntax)
          ? [para("JPEG Lossless predicts each pixel from its neighbour to the left (with SV1, first-order prediction) and Huffman-codes the difference. The markers name each part: SOI starts the image, DHT holds the Huffman table, SOF3 gives the bit depth and size, SOS starts the coded data, EOI ends it. Decoding reverses each step exactly, so no value changes.")]
          : []),
      ]
    : [para("This transfer syntax stores the Pixel Data uncompressed: each pixel's value, ", code(String(ds.nums(T.BitsAllocated)[0] ?? 16)), " bits, row by row.")];
  exact.replaceChildren(
    para("Each attribute is stored as a tag (group, element), a two-letter value representation (VR), a length, then the value. The patient's name as stored, from byte ", n(name.offset), ":"),
    h("pre", { class: "code wrap", text: `${hex(bytes.subarray(name.offset - 8, name.offset)).replace(/(..)/g, "$1 ")} | ${hex(bytes.subarray(name.offset, name.offset + name.length)).replace(/(..)/g, "$1 ")}\n${" ".repeat(24)}| ${new TextDecoder().decode(bytes.subarray(name.offset, name.offset + name.length))}` }),
    para("The file meta (group 0002) says how the rest is encoded (", code("Transfer Syntax UID"), ") and which program wrote the file (", code("Implementation Class UID"), " and ", code("Implementation Version Name"), ")."),
    ...how,
    para("Decoding runs in a worker, with our own decoder (Rust compiled to WebAssembly). It reads uncompressed data and the compressed transfer syntaxes: JPEG, JPEG-LS, JPEG 2000, HTJ2K, JPEG XL and RLE."),
    para("Brightness and contrast set the window: pixel values from centre − width/2 to centre + width/2 spread over black to white. The scanner's own suggestion is the Window Center and Width in the header."),
  );
  // The pixels, decoded in a worker. A copy: the header still reads these bytes, and decode transfers its input.
  const img = await pool.decode(bytes, { priority: 0, copy: true });
  const pixelBytes = img.rows * img.columns * img.samplesPerPixel * (img.bitsAllocated / 8);
  const stored = encapsulated ? px!.fragments!.slice(1).reduce((a, f) => a + f.length, 0) : px?.length ?? 0;
  const parts: string[] = [];
  if (encapsulated && LOSSLESS.has(transferSyntax)) {
    parts.push(`The Pixel Data is compressed with ${tsName}, without loss: decoding gives back every pixel value exactly, ${mb(pixelBytes)} of pixels from ${mb(stored)}.`);
    if (OURS.test(implName)) parts.push("shlink-dicom compressed it when the study was shared, so the pixel values are identical to those in the scanner's file.");
  } else if (encapsulated) {
    parts.push(`The Pixel Data is compressed with ${tsName}, a lossy encoding: ${mb(pixelBytes)} of pixels from ${mb(stored)}.`);
  } else {
    parts.push(`The Pixel Data is uncompressed: ${mb(stored)}, each pixel's value in ${img.bitsAllocated / 8} bytes, row by row.`);
  }
  if (implName || implUid) parts.push(`The file meta names the program that wrote this file: ${implName || "(no name)"}${implUid ? ` (${implUid})` : ""}.`);
  encoding.textContent = parts.join(" ");
  const vp = new Viewport(stage);
  const shown = showImage(vp, img, 0, { kind: "auto" }, ds);
  windowControls(vp, img, ds, shown.window ?? { center: 128, width: 256 }, stage, cs, ws, (c, w) => {
    numbers.textContent = `${img.columns} × ${img.rows} pixels, decoded in ${img.decodeMs.toFixed(1)} ms. Window centre ${Math.round(c)}, width ${Math.round(w)}.`;
  });
}
