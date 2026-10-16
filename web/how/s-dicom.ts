// Step 8: the DICOM header and Pixel Data. A few header attributes as stored, the Pixel Data's
// structure (native bytes, or the encapsulated items with the Basic Offset Table and the first
// fragment's JPEG markers), then the pixels, decoded in a worker, with brightness and contrast.
import { decryptParams, parseDicomSync, T, tag, tagHex, type DataSet, type Element } from "../core/index";
import type { DecodedImage } from "../core/images";
import { displayPlan } from "../core/display";
import { showImage, Viewport } from "../core/render";
import { byteRow, byteView, u16be, u16le, u32le, type Field } from "./bytes";
import { code, excerpt, h, mb, n, para, S } from "./state";

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

const JPEG_NAMES: Record<number, [string, string]> = {
  0xd8: ["SOI", "start of image"],
  0xc0: ["SOF0", "baseline frame"],
  0xc1: ["SOF1", "extended frame"],
  0xc3: ["SOF3", "lossless frame"],
  0xc4: ["DHT", "Huffman table"],
  0xdb: ["DQT", "quantisation table"],
  0xdd: ["DRI", "restart interval"],
  0xda: ["SOS", "start of scan: the coded pixels follow"],
  0xd9: ["EOI", "end of image"],
  0xfe: ["COM", "comment"],
};
const J2K_NAMES: Record<number, [string, string]> = {
  0x4f: ["SOC", "start of codestream"],
  0x50: ["CAP", "extended capabilities (HTJ2K)"],
  0x51: ["SIZ", "image and tile size"],
  0x52: ["COD", "coding style"],
  0x53: ["COC", "component coding style"],
  0x55: ["TLM", "tile-part lengths"],
  0x5c: ["QCD", "quantisation"],
  0x5d: ["QCC", "component quantisation"],
  0x64: ["COM", "comment"],
  0x90: ["SOT", "start of tile-part"],
  0x93: ["SOD", "start of data: the coded wavelet data follow"],
  0xd9: ["EOC", "end of codestream"],
};
const LONG_VR = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "SV", "UC", "UN", "UR", "UT", "UV"]);
const TAG_NAMES: Record<number, string> = {
  [tag(0x0002, 0x0010)]: "Transfer Syntax UID",
  [tag(0x0002, 0x0012)]: "Implementation Class UID",
  [tag(0x0002, 0x0013)]: "Implementation Version Name",
  [T.PatientName]: "Patient's Name",
  [T.PixelData]: "Pixel Data",
};

/**
 * One DICOM element as stored: tag, VR (explicit VR only), length, and (for text) the value,
 * each with its decoding under its bytes. `el.offset` is where the value starts.
 */
function elementRow(bytes: Uint8Array, t: number, el: Element, explicit: boolean, showValue = true): HTMLElement {
  const long = explicit && LONG_VR.has(el.vr);
  const headLen = !explicit ? 8 : long ? 12 : 8;
  const at = el.offset - headLen;
  const b = (o: number, len: number) => bytes.subarray(at + o, at + o + len);
  const fields: Field[] = [{ name: "tag", bytes: b(0, 4), decoded: `${tagHex(t)} ${TAG_NAMES[t] ?? ""}`.trim() }];
  let lenAt = 4;
  if (explicit) {
    fields.push({ name: "VR", bytes: b(4, 2), decoded: el.vr });
    if (long) {
      fields.push({ name: "reserved", bytes: b(6, 2), decoded: "0" });
      lenAt = 8;
    } else lenAt = 6;
  }
  const lenBytes = b(lenAt, headLen - lenAt);
  const len = lenBytes.length === 2 ? u16le(lenBytes) : u32le(lenBytes);
  fields.push({ name: "length", bytes: lenBytes, decoded: len === 0xffffffff ? "undefined" : n(len) });
  if (showValue && len !== 0xffffffff) fields.push({ name: "value", bytes: bytes.subarray(el.offset, el.offset + Math.min(len, 64)), chars: true });
  return byteRow(`${TAG_NAMES[t] ?? tagHex(t)}, from byte ${n(at)}${showValue && len > 64 ? ` (first 64 of ${n(len)} value bytes)` : ""}`, fields);
}

/** An item header inside encapsulated Pixel Data: (FFFE,E000) or the end marker (FFFE,E0DD), and its length. */
function itemRow(bytes: Uint8Array, at: number, what: string): HTMLElement {
  const t = bytes.subarray(at, at + 4), l = bytes.subarray(at + 4, at + 8);
  const isEnd = t[2] === 0xdd;
  return byteRow(what, [
    { name: "tag", bytes: t, decoded: isEnd ? "(FFFE,E0DD) end of the items" : "(FFFE,E000) item" },
    { name: "length", bytes: l, decoded: n(u32le(l)) },
  ]);
}

/** The first fragment's JPEG markers up to the start of scan, each as a byte row. */
function jpegRows(frag: Uint8Array): HTMLElement[] {
  if (frag[0] !== 0xff || frag[1] !== 0xd8) return [];
  const rows = [byteRow(`at byte 0 of the image: SOI, ${JPEG_NAMES[0xd8][1]}`, [{ name: "marker", bytes: frag.subarray(0, 2), decoded: "SOI" }])];
  let p = 2;
  while (p + 4 <= frag.length && frag[p] === 0xff) {
    const m = frag[p + 1];
    const len = u16be(frag.subarray(p + 2, p + 4));
    const [abbr, what] = JPEG_NAMES[m] ?? (m >= 0xe0 && m <= 0xef ? [`APP${m - 0xe0}`, "application data"] : [`ff ${m.toString(16)}`, "marker"]);
    const fields: Field[] = [
      { name: "marker", bytes: frag.subarray(p, p + 2), decoded: abbr },
      { name: "length", bytes: frag.subarray(p + 2, p + 4), decoded: n(len) },
    ];
    if (m === 0xc0 || m === 0xc1 || m === 0xc3) {
      const comps = frag[p + 9];
      fields.push(
        { name: "precision", bytes: frag.subarray(p + 4, p + 5), decoded: `${frag[p + 4]}-bit` },
        { name: "rows", bytes: frag.subarray(p + 5, p + 7), decoded: String(u16be(frag.subarray(p + 5, p + 7))) },
        { name: "columns", bytes: frag.subarray(p + 7, p + 9), decoded: String(u16be(frag.subarray(p + 7, p + 9))) },
        { name: "components", bytes: frag.subarray(p + 9, p + 10), decoded: String(comps) },
      );
    }
    rows.push(byteRow(`at byte ${n(p)}: ${abbr}, ${what}`, fields));
    if (m === 0xda) {
      const end = frag.length >= 2 && frag[frag.length - 2] === 0xff && frag[frag.length - 1] === 0xd9 ? frag.length - 2 : frag.length;
      rows.push(h("p", { class: "bnote", text: `… then ${n(end - (p + 2 + len))} bytes of coded pixel differences …` }));
      if (end < frag.length) rows.push(byteRow(`at byte ${n(end)}: EOI, ${JPEG_NAMES[0xd9][1]}`, [{ name: "marker", bytes: frag.subarray(end, end + 2), decoded: "EOI" }]));
      break;
    }
    p += 2 + len;
  }
  return rows;
}

/** A JPEG 2000 codestream's markers: the main header, the first tile-part's SOT and SOD, then EOC. */
function j2kRows(cs: Uint8Array): HTMLElement[] {
  if (cs[0] !== 0xff || cs[1] !== 0x4f) return [];
  const sub = (o: number, len: number) => cs.subarray(o, o + len);
  const u32 = (o: number) => new DataView(cs.buffer, cs.byteOffset + o).getUint32(0);
  const rows = [byteRow(`at byte 0 of the image: SOC, ${J2K_NAMES[0x4f][1]}`, [{ name: "marker", bytes: sub(0, 2), decoded: "SOC" }])];
  let p = 2;
  while (p + 4 <= cs.length && cs[p] === 0xff) {
    const m = cs[p + 1];
    const len = u16be(sub(p + 2, 2));
    const [abbr, what] = J2K_NAMES[m] ?? [`ff ${m.toString(16)}`, "marker"];
    const fields: Field[] = [
      { name: "marker", bytes: sub(p, 2), decoded: abbr },
      { name: "length", bytes: sub(p + 2, 2), decoded: n(len) },
    ];
    if (m === 0x51 && p + 41 <= cs.length) {
      // SIZ: Rsiz, then the image width and height (Xsiz, Ysiz, 4 bytes each, big-endian).
      fields.push({ name: "capabilities", bytes: sub(p + 4, 2), decoded: String(u16be(sub(p + 4, 2))) }, { name: "width", bytes: sub(p + 6, 4), decoded: String(u32(p + 6) - u32(p + 14)) }, { name: "height", bytes: sub(p + 10, 4), decoded: String(u32(p + 10) - u32(p + 18)) });
    }
    if (m === 0x52 && p + 14 <= cs.length) {
      fields.push({ name: "levels", bytes: sub(p + 9, 1), decoded: `${cs[p + 9]} wavelet levels` });
      fields.push({ name: "transform", bytes: sub(p + 13, 1), decoded: cs[p + 13] === 1 ? "5/3, reversible" : "9/7" });
    }
    if (m === 0x90 && p + 10 <= cs.length) fields.push({ name: "tile", bytes: sub(p + 4, 2), decoded: String(u16be(sub(p + 4, 2))) }, { name: "tile-part length", bytes: sub(p + 6, 4), decoded: n(u32(p + 6)) });
    rows.push(byteRow(`at byte ${n(p)}: ${abbr}, ${what}`, fields));
    if (m === 0x90) {
      const psot = u32(p + 6);
      const sod = p + 2 + len;
      if (cs[sod] === 0xff && cs[sod + 1] === 0x93) {
        rows.push(byteRow(`at byte ${n(sod)}: SOD, ${J2K_NAMES[0x93][1]}`, [{ name: "marker", bytes: sub(sod, 2), decoded: "SOD" }]));
        const end = cs.length >= 2 && cs[cs.length - 2] === 0xff && cs[cs.length - 1] === 0xd9 ? cs.length - 2 : cs.length;
        const tileEnd = psot ? Math.min(end, p + psot) : end;
        rows.push(h("p", { class: "bnote", text: `… then ${n(tileEnd - (sod + 2))} bytes of coded data${tileEnd < end ? ", then more tile-parts" : ""} …` }));
        if (end < cs.length) rows.push(byteRow(`at byte ${n(end)}: EOC, ${J2K_NAMES[0xd9][1]}`, [{ name: "marker", bytes: sub(end, 2), decoded: "EOC" }]));
      }
      break;
    }
    p += 2 + len;
  }
  return rows;
}

/** The Pixel Data, byte by byte: its element header, then its items (encapsulated) or its first values (native). */
function pixelRows(bytes: Uint8Array, px: Element, explicit: boolean, bitsAllocated: number): HTMLElement[] {
  const rows = [elementRow(bytes, T.PixelData, px, explicit, false)];
  if (!px.fragments?.length) {
    const vals = Array.from({ length: 4 }, (_, i) => bytes.subarray(px.offset + i * 2, px.offset + i * 2 + 2));
    rows.push(byteRow(`the first pixel values (${bitsAllocated}-bit, little-endian)`, vals.map((v, i) => ({ name: `pixel ${i + 1}`, bytes: v, decoded: String(u16le(v)) }))));
    rows.push(h("p", { class: "bnote", text: `… then the rest of the ${n(px.length)} bytes, row by row.` }));
    return rows;
  }
  const [bot, ...frags] = px.fragments;
  rows.push(itemRow(bytes, bot.offset - 8, `item 0: the Basic Offset Table${bot.length ? "" : " (empty)"}`));
  if (bot.length) {
    const vals = Array.from({ length: Math.min(4, Math.floor(bot.length / 4)) }, (_, i) => bytes.subarray(bot.offset + 4 * i, bot.offset + 4 * i + 4));
    rows.push(byteRow("where each frame starts", vals.map((v, i) => ({ name: `frame ${i + 1}`, bytes: v, decoded: n(u32le(v)) }))));
  }
  frags.forEach((fr, i) => {
    if (i > 2) return;
    rows.push(itemRow(bytes, fr.offset - 8, `item ${i + 1}: ${frags.length === 1 ? "the compressed image" : `fragment ${i + 1}`}, ${n(fr.length)} bytes`));
    if (i === 0) {
      const frag = bytes.subarray(fr.offset, fr.offset + fr.length);
      const marks = jpegRows(frag);
      rows.push(...(marks.length ? marks : j2kRows(frag)));
    }
  });
  // The sequence delimiter follows the last fragment.
  const last = px.fragments[px.fragments.length - 1];
  const end = last.offset + last.length;
  if (end + 8 <= bytes.length && bytes[end] === 0xfe && bytes[end + 1] === 0xff) rows.push(itemRow(bytes, end, "the end of the items"));
  return rows;
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
    px ? `${tagHex(T.PixelData)} ${px.vr.padEnd(2)}  ${"Pixel Data".padEnd(27)} ${encapsulated ? `items from byte ${n(px.offset)}: the Basic Offset Table, then the compressed image` : `${n(px.length)} bytes from byte ${n(px.offset)}`}` : "",
  ].filter(Boolean);
  const bitsAllocated = ds.nums(T.BitsAllocated)[0] ?? 16;
  const stage = h("div", { class: "stage", "aria-label": "The slice. Drag to change brightness and contrast." });
  const cs = h("input", { id: "wl-c", type: "range", min: "0", max: "100", "aria-label": "Brightness" }) as HTMLInputElement;
  const ws = h("input", { id: "wl-w", type: "range", min: "0", max: "100", "aria-label": "Contrast" }) as HTMLInputElement;
  const numbers = h("p", { class: "cap" });
  const encoding = h("p", { class: "cap", id: "dicom-encoding" });
  pic.replaceChildren(
    h("p", { class: "cap", text: `The DICOM header of slice ${S.slice + 1}, a few of its ${n(ds.elements.size)} attributes, and how its Pixel Data is stored:` }),
    excerpt(lines.join("\n"), [/Transfer Syntax UID/, /Implementation Version Name/, /Patient's Name/, /Pixel Data/], "The DICOM header"),
    h("p", { class: "cap", text: "The Pixel Data, byte by byte: each field's bytes in hex, with what they mean beneath them." }),
    px ? byteView("The Pixel Data, byte by byte", pixelRows(bytes, px, ds.explicit, bitsAllocated)) : "",
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
        ...(/\.4\.(90|91|201|202|203)$/.test(transferSyntax)
          ? [para("JPEG 2000 transforms the image into wavelet bands and codes them in blocks. The markers name each part: SOC starts the codestream, SIZ gives the size and bit depth, COD the coding style (the reversible 5/3 wavelet is lossless), SOT and SOD start each tile's data, EOC ends it.")]
          : []),
        ...(/\.4\.(57|70)$/.test(transferSyntax)
          ? [para("JPEG Lossless predicts each pixel from its neighbour to the left (with SV1, first-order prediction) and Huffman-codes the difference. The markers name each part: SOI starts the image, DHT holds the Huffman table, SOF3 gives the bit depth and size, SOS starts the coded data, EOI ends it. Decoding reverses each step exactly, so no value changes.")]
          : []),
      ]
    : [para("This transfer syntax stores the Pixel Data uncompressed: each pixel's value, ", code(String(ds.nums(T.BitsAllocated)[0] ?? 16)), " bits, row by row.")];
  exact.replaceChildren(
    para("Each attribute is stored as a tag (group, element), a two-letter value representation (VR, in files that spell it out), a length, then the value. Numbers are little-endian: the low byte comes first, so ", code("0c 00"), " is 12. Three of them as stored:"),
    byteView("Header attributes, byte by byte", [
      elementRow(bytes, T.PatientName, name, ds.explicit),
      ...[T.TransferSyntaxUID, IMPL_NAME].map((t) => meta.get(t)).map((el, i) => (el ? elementRow(bytes, [T.TransferSyntaxUID, IMPL_NAME][i], el, true) : null)).filter((x): x is HTMLElement => !!x),
    ]),
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
