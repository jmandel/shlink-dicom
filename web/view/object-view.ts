// The non-image objects of a study, shown in place of the slice viewer: structured reports,
// encapsulated PDF and CDA documents, waveforms (plotted; audio played), 3D models, key image
// lists, and anything else as a named entry with a download.
import type { SeriesEntry, StudyEntry } from "../core/bundle";
import { parseDicom, T, type DataSet } from "../core/dicom";
import { readKeyObjects } from "../core/derived";
import { formatBytes, formatDate, plural } from "../core/format";
import { parseMtl, parseObj, parseStl, type Mesh } from "../core/mesh";
import { sopInfo, type ObjectKind } from "../core/objects";
import { readSr, type SrNode, type SrRef } from "../core/sr";
import { readWaveforms, toWav, type WaveformGroup } from "../core/waveform";
import type { InstanceLoader } from "../core/loader";
import { renderPdf } from "./pdf-view";
import { ModelView } from "./model-view";

export interface ObjectContext {
  loader: InstanceLoader;
  study: StudyEntry;
  /** Where a SOP instance is in the share, or null. */
  locate(sop: string): { series: SeriesEntry; index: number } | null;
  /** Shows a referenced image (frame is 1-based). */
  jump(sop: string, frame?: number): void;
  /** Saves one instance as a .dcm file. */
  download(series: SeriesEntry, index: number): void;
  /** Draws a small preview of an image instance on a canvas. */
  thumb(canvas: HTMLCanvasElement, series: SeriesEntry, index: number): Promise<void>;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class ObjectView {
  readonly box: HTMLElement;
  private abort = new AbortController();
  private model: ModelView | null = null;
  series: SeriesEntry | null = null;
  /** The instance shown, within `series`. */
  index = 0;

  constructor(stage: HTMLElement, private ctx: ObjectContext) {
    this.box = el("div", "object-view hidden");
    this.box.setAttribute("role", "region");
    stage.append(this.box);
  }

  get active() {
    return !this.box.classList.contains("hidden");
  }

  setContext(ctx: ObjectContext) {
    this.ctx = ctx;
  }

  close() {
    this.abort.abort();
    this.model?.destroy();
    this.model = null;
    this.series = null;
    this.box.classList.add("hidden");
    this.box.textContent = "";
  }

  /** Shows instance `index` of a non-image series. */
  async show(se: SeriesEntry, kind: ObjectKind, index = 0, note?: string) {
    this.close();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.series = se;
    this.index = index;
    this.box.classList.remove("hidden");
    this.box.dataset.kind = kind;
    this.box.scrollTop = 0;
    const inst = se.instances[index];
    this.box.dataset.sop = inst.uid;
    delete this.box.dataset.rendered;
    const info = sopInfo(inst.sopClass);
    const head = el("header", "obj-head");
    head.append(el("h2", "obj-title", se.description ?? info.name));
    head.append(el("p", "obj-sub small muted", `${info.name} · from the imaging system · ${formatBytes(inst.length)}`));
    const actions = el("div", "obj-actions");
    if (se.instances.length > 1) {
      const pick = el("select", "obj-pick");
      pick.setAttribute("aria-label", "Object");
      se.instances.forEach((x, k) => {
        const o = el("option", undefined, `${k + 1} of ${se.instances.length}${x.number != null ? ` · number ${x.number}` : ""}`);
        o.value = String(k);
        pick.append(o);
      });
      pick.value = String(index);
      pick.addEventListener("change", () => void this.show(se, kind, Number(pick.value), note));
      actions.append(pick);
    }
    const dl = el("button", "btn", "Download this file");
    dl.type = "button";
    dl.addEventListener("click", () => this.ctx.download(se, index));
    actions.append(dl);
    head.append(actions);
    const body = el("div", "obj-body");
    body.append(el("p", "muted", "Loading…"));
    this.box.append(head, body);
    try {
      const bytes = await this.ctx.loader.instance(se, index, { signal });
      if (signal.aborted) return;
      const { ds } = await parseDicom(bytes);
      body.textContent = "";
      switch (kind) {
        case "sr":
          this.renderSr(body, ds);
          break;
        case "pdf":
          await this.renderPdfObject(body, ds, signal);
          break;
        case "cda":
          await this.renderCda(body, ds, signal);
          break;
        case "waveform":
          this.renderWaveform(body, ds);
          break;
        case "model":
          await this.renderModel(body, ds, inst.sopClass, signal);
          break;
        case "ko":
          this.renderKeyImages(body, ds);
          break;
        default:
          this.renderOther(body, ds, se, index, note);
      }
      this.box.dataset.rendered = kind;
    } catch (e) {
      if ((e as any)?.name === "AbortError") return;
      body.textContent = "";
      body.append(el("p", "obj-error", `This object can't be shown: ${(e as Error).message}. You can still download it.`));
      this.box.dataset.rendered = "error";
    }
  }

  // --------------------------------------------------------------------------- structured report

  private renderSr(body: HTMLElement, ds: DataSet) {
    const doc = readSr(ds);
    const facts = [
      doc.date ? formatDate(doc.date) : null,
      doc.template,
      doc.completion === "COMPLETE" ? "complete" : doc.completion === "PARTIAL" ? "partial" : null,
      doc.verification === "VERIFIED" ? "verified" : doc.verification === "UNVERIFIED" ? "not verified" : null,
    ].filter(Boolean);
    body.append(el("h3", "sr-doc-title", doc.title?.meaning ?? "Structured report"));
    if (facts.length) body.append(el("p", "small muted", facts.join(" · ")));
    const tree = el("div", "sr-tree");
    for (const c of doc.root.children) tree.append(this.srNode(c, 1));
    const count = (n: SrNode): number => n.children.reduce((a, c) => a + 1 + count(c), 0);
    tree.dataset.items = String(count(doc.root));
    tree.dataset.refs = String(doc.references.length);
    body.append(tree);
    if (doc.references.length) {
      const missing = doc.references.filter((r) => !this.ctx.locate(r.ref.sopInstance)).length;
      body.append(el("p", "small muted sr-ref-note", `${plural(doc.references.length, "image reference")}${missing ? `, ${missing} to images not in this share` : ""}.`));
    }
  }

  private srNode(n: SrNode, depth: number): HTMLElement {
    const name = n.concept?.meaning ?? n.valueType;
    if (n.valueType === "CONTAINER") {
      const d = el("details", "sr-container");
      d.open = depth <= 2 || n.children.length <= 12;
      const s = el("summary", "sr-heading", name);
      d.append(s);
      for (const c of n.children) d.append(this.srNode(c, depth + 1));
      return d;
    }
    const row = el("div", "sr-item");
    row.dataset.vt = n.valueType;
    row.append(el("span", "sr-name", name));
    const val = el("span", "sr-value");
    if (n.ref) val.append(this.refButton(n.ref, n.valueType === "IMAGE" ? "image" : n.valueType === "WAVEFORM" ? "waveform" : "object"));
    else if (n.scoord) {
      const img = n.children.find((c) => c.valueType === "IMAGE")?.ref;
      val.append(document.createTextNode(`${n.scoord.type.toLowerCase()} on `));
      if (img) val.append(this.refButton(img, "image"));
      else val.append(document.createTextNode("an image"));
    } else if (n.byReference) val.textContent = `see item ${n.byReference}`;
    else val.textContent = n.text;
    row.append(val);
    const kids = n.children.filter((c) => !(n.scoord && c.valueType === "IMAGE"));
    if (!kids.length) return row;
    const wrap = el("div", "sr-group");
    wrap.append(row);
    const sub = el("div", "sr-children");
    for (const c of kids) sub.append(this.srNode(c, depth + 1));
    wrap.append(sub);
    return wrap;
  }

  private refButton(ref: SrRef, what: string): HTMLElement {
    const where = this.ctx.locate(ref.sopInstance);
    const frame = ref.frames[0];
    if (!where) return el("span", "sr-ref-missing", `${what} not in this share`);
    const b = el("button", "linkish sr-ref", `${where.series.description ?? "Series"}, ${what} ${where.index + 1}${frame ? `, frame ${frame}` : ""}`);
    b.type = "button";
    b.addEventListener("click", () => this.ctx.jump(ref.sopInstance, frame));
    return b;
  }

  // --------------------------------------------------------------------------- documents

  private async renderPdfObject(body: HTMLElement, ds: DataSet, signal: AbortSignal) {
    const title = ds.str(T.DocumentTitle);
    if (title) body.append(el("h3", undefined, title));
    const doc = ds.raw(T.EncapsulatedDocument);
    if (!doc?.length) throw new Error("the file holds no document");
    const pages = el("div", "pdf-pages");
    body.append(pages);
    const n = await renderPdf(pages, doc, signal);
    body.append(el("p", "small muted", plural(n, "page")));
  }

  private async renderCda(body: HTMLElement, ds: DataSet, signal: AbortSignal) {
    const raw = ds.raw(T.EncapsulatedDocument);
    if (!raw?.length) throw new Error("the file holds no document");
    const xml = new DOMParser().parseFromString(new TextDecoder().decode(raw).replace(/\0+$/, ""), "application/xml");
    if (xml.querySelector("parsererror")) throw new Error("the CDA document is not well-formed XML");
    const doc = el("article", "cda");
    const title = xml.querySelector("ClinicalDocument > title")?.textContent;
    doc.append(el("h3", undefined, title || ds.str(T.DocumentTitle) || "Clinical document"));
    const nonXml = xml.querySelector("nonXMLBody > text");
    if (nonXml) {
      const media = nonXml.getAttribute("mediaType") ?? "";
      if (/pdf/i.test(media) && nonXml.getAttribute("representation") === "B64") {
        const bytes = Uint8Array.from(atob((nonXml.textContent ?? "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
        const pages = el("div", "pdf-pages");
        doc.append(pages);
        body.append(doc);
        await renderPdf(pages, bytes, signal);
        return;
      }
      doc.append(el("pre", "report-text", nonXml.textContent ?? ""));
    }
    for (const sec of xml.querySelectorAll("section")) {
      const s = el("section", "cda-section");
      const t = sec.querySelector(":scope > title")?.textContent;
      if (t) s.append(el("h4", undefined, t));
      const text = sec.querySelector(":scope > text");
      if (text) s.append(narrative(text));
      doc.append(s);
    }
    body.append(doc);
  }

  // --------------------------------------------------------------------------- waveforms

  private renderWaveform(body: HTMLElement, ds: DataSet) {
    const groups = readWaveforms(ds);
    if (!groups.length) throw new Error("the file holds no waveform data");
    const sop = ds.str(T.SOPClassUID) ?? "";
    const isEcg = sop.startsWith("1.2.840.10008.5.1.4.1.1.9.1.");
    const isAudio = sop.startsWith("1.2.840.10008.5.1.4.1.1.9.4.");
    for (const g of groups) {
      const sec = el("section", "wf-group");
      const dur = g.samples / (g.samplingFrequency || 1);
      sec.append(el("h3", undefined, [g.label || (isAudio ? "Audio" : "Waveform"), `${plural(g.channels.length, "channel")}`, `${g.samplingFrequency} Hz`, `${dur.toFixed(1)} s`, g.originality === "DERIVED" ? "derived" : null].filter(Boolean).join(" · ")));
      if (isAudio) {
        const a = el("audio");
        a.controls = true;
        a.src = URL.createObjectURL(toWav(g));
        a.className = "wf-audio";
        sec.append(a);
      }
      sec.append(plotWaveform(g, isEcg));
      body.append(sec);
    }
    if (isEcg) body.append(el("p", "small muted", "Drawn at 25 mm/s and 10 mm/mV on a 1 mm grid, at about 4 screen pixels per mm."));
  }

  // --------------------------------------------------------------------------- 3D models

  private async renderModel(body: HTMLElement, ds: DataSet, sopClass: string, signal: AbortSignal) {
    const raw = ds.raw(T.EncapsulatedDocument);
    if (!raw?.length) throw new Error("the file holds no model");
    let mesh: Mesh;
    if (sopClass.endsWith(".104.3")) mesh = parseStl(raw);
    else if (sopClass.endsWith(".104.4")) {
      const mtl = await this.findMtl(ds, signal);
      mesh = parseObj(new TextDecoder().decode(raw), mtl ?? undefined);
    } else {
      body.append(el("pre", "report-text", new TextDecoder().decode(raw).slice(0, 4000)));
      body.append(el("p", "small muted", "A material file: it gives colours to an OBJ model."));
      return;
    }
    const size = mesh.max.map((m, i) => m - mesh.min[i]);
    body.append(el("p", "small muted", `${mesh.triangles.toLocaleString()} triangles · ${size.map((s) => s.toFixed(0)).join(" × ")} mm. Drag to turn, pinch or scroll to zoom.`));
    const holder = el("div", "model-holder");
    body.append(holder);
    this.model = new ModelView(holder, mesh);
  }

  /** The MTL instance an OBJ refers to (Referenced SOP Sequence), if it is in the share. */
  private async findMtl(ds: DataSet, signal: AbortSignal) {
    for (const r of ds.seq(T.ReferencedSOPSequence)) {
      const where = this.ctx.locate(r.str(T.ReferencedSOPInstanceUID) ?? "");
      if (!where) continue;
      const b = await this.ctx.loader.instance(where.series, where.index, { signal });
      const m = (await parseDicom(b)).ds.raw(T.EncapsulatedDocument);
      if (m) return parseMtl(new TextDecoder().decode(m));
    }
    return null;
  }

  // --------------------------------------------------------------------------- key images

  private renderKeyImages(body: HTMLElement, ds: DataSet) {
    const ko = readKeyObjects(ds);
    body.append(el("h3", undefined, ko.title?.meaning ?? "Key images"));
    if (ko.description) body.append(el("p", "ko-desc", ko.description));
    const list = el("ul", "ko-list");
    for (const ref of ko.images) {
      const li = el("li", "ko-item");
      const where = this.ctx.locate(ref.sopInstance);
      if (!where) {
        li.append(el("span", "muted", `${sopInfo(ref.sopClass).name}, not in this share`));
        list.append(li);
        continue;
      }
      const b = el("button", "ko-open");
      b.type = "button";
      const c = el("canvas", "ko-thumb");
      c.width = c.height = Math.round(96 * Math.min(2, devicePixelRatio || 1));
      b.append(c, el("span", undefined, `${where.series.description ?? "Series"} · image ${where.index + 1}${ref.frames[0] ? `, frame ${ref.frames[0]}` : ""}`));
      b.addEventListener("click", () => this.ctx.jump(ref.sopInstance, ref.frames[0]));
      li.append(b);
      list.append(li);
      void this.ctx.thumb(c, where.series, where.index).catch(() => {});
    }
    body.append(list);
    body.append(el("p", "small muted", `${plural(ko.images.length, "key image")}.`));
  }

  // --------------------------------------------------------------------------- anything else

  private renderOther(body: HTMLElement, ds: DataSet, se: SeriesEntry, index: number, note?: string) {
    const inst = se.instances[index];
    const dl = el("dl", "obj-facts");
    const fact = (k: string, v: string | null) => v && dl.append(el("dt", undefined, k), el("dd", undefined, v));
    fact("Type", sopInfo(inst.sopClass).name);
    fact("SOP class", inst.sopClass);
    fact("Size", formatBytes(inst.length));
    fact("Date", ds.str(T.ContentDate) ? formatDate(ds.str(T.ContentDate)) : null);
    fact("Manufacturer", ds.str(T.Manufacturer));
    body.append(el("p", undefined, note ?? "This viewer does not display this kind of object. Download it to open it in software that does."), dl);
  }
}

/** A CDA narrative block (paragraphs, lists, tables, emphasis) as safe HTML elements. */
function narrative(node: Element): HTMLElement {
  const map: Record<string, keyof HTMLElementTagNameMap> = {
    paragraph: "p", list: "ul", item: "li", table: "table", thead: "thead", tbody: "tbody", tr: "tr", td: "td", th: "th", br: "br", caption: "caption",
  };
  const conv = (n: Node): Node | null => {
    if (n.nodeType === Node.TEXT_NODE) return document.createTextNode(n.textContent ?? "");
    if (n.nodeType !== Node.ELEMENT_NODE) return null;
    const e = n as Element;
    let tag = map[e.localName] ?? "span";
    if (e.localName === "list" && e.getAttribute("listType") === "ordered") tag = "ol";
    if (e.localName === "content" && /bold/i.test(e.getAttribute("styleCode") ?? "")) tag = "b";
    const out = document.createElement(tag);
    for (const c of e.childNodes) {
      const k = conv(c);
      if (k) out.append(k);
    }
    return out;
  };
  const d = el("div", "cda-text");
  for (const c of node.childNodes) {
    const k = conv(c);
    if (k) d.append(k);
  }
  return d;
}

/** Channel traces on a canvas. ECG: 25 mm/s, 10 mm/mV, 1 mm grid (4 CSS px per mm). Others: each channel fitted. */
function plotWaveform(g: WaveformGroup, ecg: boolean): HTMLElement {
  const wrap = el("div", "wf-scroll");
  const PX_MM = 4;
  const dur = g.samples / (g.samplingFrequency || 1);
  const width = ecg ? Math.max(320, Math.round(dur * 25 * PX_MM)) : Math.max(320, Math.min(4000, g.samples));
  const laneH = ecg ? 30 * PX_MM : 90;
  const labelW = 64;
  const height = laneH * g.channels.length;
  const c = el("canvas", "wf-canvas");
  const dpr = Math.min(2, devicePixelRatio || 1);
  c.width = Math.round((width + labelW) * dpr);
  c.height = Math.round(height * dpr);
  c.style.width = `${width + labelW}px`;
  c.style.height = `${height}px`;
  const ctx = c.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width + labelW, height);
  if (ecg) {
    for (let x = 0; x <= width; x += PX_MM) {
      ctx.strokeStyle = x % (5 * PX_MM) === 0 ? "#f3b4b4" : "#fbe3e3";
      ctx.beginPath();
      ctx.moveTo(labelW + x + 0.5, 0);
      ctx.lineTo(labelW + x + 0.5, height);
      ctx.stroke();
    }
    for (let y = 0; y <= height; y += PX_MM) {
      ctx.strokeStyle = y % (5 * PX_MM) === 0 ? "#f3b4b4" : "#fbe3e3";
      ctx.beginPath();
      ctx.moveTo(labelW, y + 0.5);
      ctx.lineTo(labelW + width, y + 0.5);
      ctx.stroke();
    }
  }
  g.channels.forEach((ch, k) => {
    const mid = k * laneH + laneH / 2;
    let toY: (v: number) => number;
    if (ecg) {
      const mv = /^u|µ/i.test(ch.units) ? 1 / 1000 : /^mV$/i.test(ch.units) ? 1 : 1 / 1000;
      toY = (v) => mid - v * mv * 10 * PX_MM;
    } else {
      let lo = Infinity, hi = -Infinity;
      for (const v of ch.values) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const span = hi - lo || 1;
      toY = (v) => k * laneH + 6 + (1 - (v - lo) / span) * (laneH - 12);
    }
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const n = ch.values.length;
    for (let i = 0; i < n; i++) {
      const x = labelW + (i / Math.max(1, n - 1)) * width;
      const y = toY(ch.values[i]);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = "#333";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText(ch.label.slice(0, 9), 4, k * laneH + 16);
    if (ch.units) {
      ctx.fillStyle = "#777";
      ctx.fillText(ch.units, 4, k * laneH + 30);
    }
  });
  wrap.append(c);
  wrap.dataset.channels = String(g.channels.length);
  return wrap;
}
