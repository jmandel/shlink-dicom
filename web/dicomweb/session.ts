/// <reference path="./dcmjs.d.ts" />
// Read-only DICOMweb over one retained SHLink inventory. No plaintext server or new SHL fields.
import dcmjs from "dcmjs";
import type { OpenShare } from "../core/share";
import type { StudyEntry, SeriesEntry } from "../core/bundle";
import { FrameLocator } from "../core/wsi-source";
import { LoaderBytes } from "../core/frames";
import { parseDicomSync } from "../core/dicom";
import { frameTableFromHeader } from "../core/wsi";
import { RECORD_PLAINTEXT } from "../core/range";
import { TS, NATIVE_SYNTAXES, VIDEO_SYNTAXES } from "../core/transfer-syntax";

type Attribute = { vr: string; Value?: any[]; InlineBinary?: string; BulkDataURI?: string };
export type DicomJson = Record<string, Attribute>;
type Instance = { study: StudyEntry; series: SeriesEntry; i: number };
type Header = { json: DicomJson; locator: FrameLocator; syntax: string; frames: number; pixelTag: string };
const HEADER_LIMIT = 32 * 1024 * 1024, FRAME_LIMIT = 256 * 1024 * 1024;
const enc = new TextEncoder();
const attribute = (vr: string, value: unknown): Attribute => ({ vr, ...(value === undefined || value === null || value === "" ? {} : { Value: Array.isArray(value) ? value : [value] }) });
const first = (json: DicomJson, tag: string) => json[tag]?.Value?.[0];
const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw signal.reason ?? new DOMException("Request cancelled", "AbortError"); };
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function base64(bytes: Uint8Array): string {
  let text = ""; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}

/** dcmjs supplies the complete VR dictionary; remove its internal raw-value bookkeeping. */
export function dicomJson(dict: Record<string, any>): DicomJson {
  const out: DicomJson = {};
  for (const [tag, entry] of Object.entries(dict)) {
    if (!/^[0-9A-F]{8}$/.test(tag) || tag.startsWith("0002") || tag.endsWith("0000")) continue;
    const vr = entry.vr, values = entry.Value;
    if (!Array.isArray(values) || !values.length) { out[tag] = { vr }; continue; }
    if (vr === "SQ") out[tag] = { vr, Value: values.map(dicomJson) };
    else if (values[0] instanceof ArrayBuffer || ArrayBuffer.isView(values[0])) {
      const buffers = values.map(v => v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      const bytes = new Uint8Array(buffers.reduce((n, b) => n + b.length, 0));
      let at = 0; for (const b of buffers) { bytes.set(b, at); at += b.length; }
      out[tag] = { vr, InlineBinary: base64(bytes) };
    } else out[tag] = { vr, Value: values.map(v => typeof v === "bigint" ? String(v) : v) };
  }
  return out;
}

/** FrameLocator returns DICOM fragment items; WADO-RS returns the concatenated codec payload. */
export function fragmentPayload(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [], dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0, length = 0;
  while (at < bytes.length) {
    if (bytes.length - at < 8 || dv.getUint16(at, true) !== 0xfffe) throw new HttpError(422, "Invalid frame fragment");
    const tag = dv.getUint16(at + 2, true), n = dv.getUint32(at + 4, true);
    if (tag === 0xe0dd && n === 0 && at + 8 === bytes.length) break;
    if (tag !== 0xe000 || n > bytes.length - at - 8) throw new HttpError(422, "Truncated frame fragment");
    parts.push(bytes.subarray(at + 8, at + 8 + n)); length += n; at += 8 + n;
  }
  const out = new Uint8Array(length); at = 0;
  for (const b of parts) { out.set(b, at); at += b.length; }
  return out;
}

function mediaType(syntax: string) {
  if (NATIVE_SYNTAXES.has(syntax)) return "application/octet-stream";
  if (syntax === TS.RLE) return "image/dicom-rle";
  if ([TS.JPEGLSLossless, TS.JPEGLSNearLossless].includes(syntax as any)) return "image/jls";
  if ([TS.J2KLossless, TS.J2K].includes(syntax as any)) return "image/jp2";
  if ([TS.J2KPart2Lossless, TS.J2KPart2].includes(syntax as any)) return "image/jpx";
  if ([TS.HTJ2K, TS.HTJ2KLossless, TS.HTJ2KLosslessRPCL].includes(syntax as any)) return "image/jphc";
  if ([TS.JXL, TS.JXLLossless, TS.JXLJPEGRecompression].includes(syntax as any)) return "image/jxl";
  if (/^1\.2\.840\.10008\.1\.2\.4\.(50|51|57|58|65|66|70)$/.test(syntax)) return "image/jpeg";
  throw new HttpError(415, "This transfer syntax is available as an original DICOM download");
}

function stream(iterator: AsyncGenerator<Uint8Array>, signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      try { abort(signal); const r = await iterator.next(); r.done ? controller.close() : controller.enqueue(r.value); }
      catch (e) { controller.error(e); await iterator.return(undefined); }
    },
    async cancel() { await iterator.return(undefined); },
  }, { highWaterMark: 0 });
}

async function mapLimited<T, U>(values: T[], run: (value: T) => Promise<U>, signal: AbortSignal): Promise<U[]> {
  const out = new Array<U>(values.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(6, values.length) }, async () => {
    while (cursor < values.length) { abort(signal); const i = cursor++; out[i] = await run(values[i]); }
  }));
  return out;
}

export class DicomwebSession {
  readonly stats = { queries: 0, metadata: 0, frames: 0, originals: 0 };
  private headers = new Map<string, Promise<Header>>();
  private locators = new Map<SeriesEntry, FrameLocator>();
  private lifetime = new AbortController();
  readonly root: URL;
  constructor(readonly share: OpenShare, root: string) { this.root = new URL(root.replace(/\/?$/, "/")); }
  close() { this.lifetime.abort(); this.headers.clear(); this.locators.clear(); }

  private instanceUrl(x: Instance) {
    return new URL(`studies/${encodeURIComponent(x.study.studyInstanceUid)}/series/${encodeURIComponent(x.series.uid)}/instances/${encodeURIComponent(x.series.instances[x.i].uid)}`, this.root).href;
  }

  private header(x: Instance): Promise<Header> {
    const id = x.series.id + "/" + x.i;
    let promise = this.headers.get(id);
    if (!promise) {
      promise = this.readHeader(x).catch(e => { this.headers.delete(id); throw e; });
      this.headers.set(id, promise);
    }
    return promise;
  }

  private async readHeader(x: Instance): Promise<Header> {
    const { series, i } = x, inst = series.instances[i];
    let locator = this.locators.get(series);
    if (!locator) { locator = new FrameLocator(series, new LoaderBytes(this.share.loader, series), this.lifetime.signal); this.locators.set(series, locator); }
    let n = Math.min(inst.length, locator.firstHeaderBytes(i));
    for (;;) {
      abort(this.lifetime.signal);
      if (n > HEADER_LIMIT) throw new HttpError(413, "DICOM metadata exceeds the adapter's 32 MiB header budget");
      const bytes = await locator.bytes.read(inst.offset, inst.offset + n, { signal: this.lifetime.signal });
      const parsed = parseDicomSync(bytes, { untilPixelData: true, need: true });
      if (parsed.transferSyntax === TS.Deflated) throw new HttpError(415, "Deflated datasets are available as original DICOM downloads");
      const h = locator.takeHeader(i, bytes);
      // The existing slide parser's pixel-element probe is little endian; its dataset parser
      // already supplies the correct big-endian attributes and top-level Pixel Data position.
      if (parsed.transferSyntax === TS.ExplicitBE && parsed.dataEnd >= 0 && parsed.needBytes === 0 && parsed.dataEnd + 12 <= bytes.length) {
        h.pixelDataValueOffset = parsed.dataEnd + 12; h.pixelDataLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(parsed.dataEnd + 8, false);
        h.complete = true; locator.tables[i] = frameTableFromHeader(h, inst.length);
      }
      if (h.complete || n === inst.length || (parsed.needBytes === 0 && parsed.dataEnd >= 0 && !h.encapsulated)) {
        if (h.complete && !h.encapsulated && h.photometric.startsWith("YBR") && h.photometric.endsWith("_422")) {
          const fb = h.rows * h.columns * 2 * h.bitsAllocated / 8, base = h.pixelDataValueOffset;
          if (!Number.isSafeInteger(fb) || h.samplesPerPixel !== 3 || base + fb * h.numberOfFrames > inst.length) throw new HttpError(422, "Invalid native YBR 422 frame dimensions");
          locator.tables[i] = { source: "native", range: k => k >= 0 && k < h.numberOfFrames ? [base + k * fb, base + (k + 1) * fb] : null };
        }
        const stopTag = parsed.dataEnd >= 0 && parsed.dataEnd + 4 <= bytes.length
          ? ((new DataView(bytes.buffer, bytes.byteOffset).getUint16(parsed.dataEnd, parsed.transferSyntax !== TS.ExplicitBE) * 65536 + new DataView(bytes.buffer, bytes.byteOffset).getUint16(parsed.dataEnd + 2, parsed.transferSyntax !== TS.ExplicitBE)) >>> 0).toString(16).toUpperCase().padStart(8, "0") : "7FE00010";
        const dict = dcmjs.data.DicomMessage.readFile(bytes.slice().buffer, { untilTag: stopTag, includeUntilTagValue: false });
        const json = dicomJson(dict.dict);
        for (const [tag, value] of [["0020000D", x.study.studyInstanceUid], ["0020000E", series.uid], ["00080018", inst.uid], ["00080016", inst.sopClass]] as const) {
          if (first(json, tag) && first(json, tag) !== value) throw new HttpError(422, "DICOM identity differs from the share inventory");
          if (!json[tag] && value) json[tag] = attribute("UI", value);
        }
        if (/^7FE000(08|09|10)$/.test(stopTag) && json[stopTag]) json[stopTag] = { vr: json[stopTag].vr, BulkDataURI: this.instanceUrl(x) + "/bulk/" + stopTag };
        return { json, locator, syntax: parsed.transferSyntax, frames: Number(first(json, "00280008") ?? 1), pixelTag: stopTag };
      }
      const want = inst.offset + Math.max(n * 2, h.needBytes || 0, parsed.needBytes || 0);
      if (n === HEADER_LIMIT) throw new HttpError(413, "DICOM metadata exceeds the adapter's 32 MiB header budget");
      n = Math.min(HEADER_LIMIT, inst.length, (Math.floor(want / RECORD_PLAINTEXT) + 1) * RECORD_PLAINTEXT - inst.offset);
    }
  }

  private studyJson(st: StudyEntry): DicomJson {
    const patient = this.share.index.patient;
    return {
      "00100010": attribute("PN", patient.name ? { Alphabetic: patient.name } : undefined),
      "00100020": attribute("LO", patient.id), "00100030": attribute("DA", patient.birthDate?.replaceAll("-", "")),
      "0020000D": attribute("UI", st.studyInstanceUid), "00080020": attribute("DA", st.started?.slice(0, 10).replaceAll("-", "")),
      "00080030": attribute("TM", st.started?.slice(11, 19).replaceAll(":", "")),
      "00081030": attribute("LO", st.description), "00080050": attribute("SH", st.accession),
      "00080061": attribute("CS", st.modalities), "00201206": attribute("IS", st.series.length),
      "00201208": attribute("IS", st.series.reduce((n, s) => n + s.instances.length, 0)),
    };
  }
  private seriesJson(st: StudyEntry, se: SeriesEntry): DicomJson {
    return { ...this.studyJson(st), "0020000E": attribute("UI", se.uid), "00200011": attribute("IS", se.number),
      "00080060": attribute("CS", se.modality), "0008103E": attribute("LO", se.description), "00201209": attribute("IS", se.instances.length) };
  }

  private query(rows: DicomJson[], params: URLSearchParams): DicomJson[] {
    const names: Record<string, string> = { PatientName: "00100010", PatientID: "00100020", StudyInstanceUID: "0020000D", SeriesInstanceUID: "0020000E", SOPInstanceUID: "00080018", AccessionNumber: "00080050", StudyDate: "00080020", ModalitiesInStudy: "00080061", Modality: "00080060", StudyDescription: "00081030", SeriesDescription: "0008103E" };
    for (const [key, pattern] of params) {
      if (["limit", "offset", "includefield", "fuzzymatching"].includes(key.toLowerCase()) || !pattern) continue;
      const tag = names[key] ?? (/^[0-9A-Fa-f]{8}$/.test(key) ? key.toUpperCase() : undefined);
      if (!tag) throw new HttpError(400, "Unsupported query field: " + key);
      const alternatives = pattern.split(",").map(p => new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".") + "$", "i"));
      rows = rows.filter(row => {
        const values = (row[tag]?.Value ?? []).map(v => typeof v === "object" ? v.Alphabetic ?? "" : String(v));
        if (row[tag]?.vr === "DA" && /^\d{0,8}-\d{0,8}$/.test(pattern)) {
          const [lo, hi] = pattern.split("-"); return values.some(v => (!lo || v >= lo) && (!hi || v <= hi));
        }
        return values.some(v => alternatives.some(re => re.test(v)));
      });
    }
    const offset = Number(params.get("offset") ?? 0), limit = Number(params.get("limit") ?? rows.length);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0) throw new HttpError(400, "Invalid query paging");
    return rows.slice(offset, offset + limit);
  }

  private json(value: unknown) { return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/dicom+json", "Cache-Control": "no-store" } }); }

  async handle(request: Request): Promise<Response> {
    try { return await this.route(new Request(request, { signal: AbortSignal.any([request.signal, this.lifetime.signal]) })); }
    catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      const status = error instanceof HttpError ? error.status : 502;
      return new Response(JSON.stringify({ error: (error as Error).message || "DICOM retrieval failed" }), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
  }

  private async route(request: Request): Promise<Response> {
    abort(this.lifetime.signal); abort(request.signal);
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
    const url = new URL(request.url);
    if (url.origin !== this.root.origin || !url.pathname.startsWith(this.root.pathname)) throw new HttpError(404, "Unknown session route");
    const p = url.pathname.slice(this.root.pathname.length).replace(/\/$/, "").split("/").map(decodeURIComponent);
    if (p[0] !== "studies") throw new HttpError(404, "Unknown DICOMweb resource");
    if (p.length === 1) { this.stats.queries++; return this.json(this.query(this.share.index.studies.map(st => this.studyJson(st)), url.searchParams)); }
    const study = this.share.index.studies.find(st => st.studyInstanceUid === p[1]);
    if (!study) throw new HttpError(404, "Study is not in this share");
    if (p[2] === "series" && p.length === 3) { this.stats.queries++; return this.json(this.query(study.series.map(se => this.seriesJson(study, se)), url.searchParams)); }
    const series = p[2] === "series" ? study.series.find(se => se.uid === p[3]) : undefined;
    if (p[2] === "series" && !series) throw new HttpError(404, "Series is not in this share");
    const entries = (series ? [series] : study.series).flatMap(se => se.instances.map((_, i) => ({ study, series: se, i })));
    const instance = p[4] === "instances" && p[5] ? entries.find(x => x.series.instances[x.i].uid === p[5]) : undefined;
    if (p[5] && p[4] === "instances" && !instance) throw new HttpError(404, "Instance is not in this share");
    const metadata = (p.length === 3 && p[2] === "metadata") || (!!series && p.length === 5 && p[4] === "metadata") || (!!instance && p.length === 7 && p[6] === "metadata");
    const instanceQuery = (p.length === 3 && p[2] === "instances") || (!!series && p.length === 5 && p[4] === "instances");
    if (metadata || instanceQuery) {
      this.stats[metadata ? "metadata" : "queries"]++;
      const values = await mapLimited(instance ? [instance] : entries, x => this.header(x).then(h => h.json), request.signal);
      return this.json(instanceQuery ? this.query(values, url.searchParams) : values);
    }
    if (instance && p.length === 8 && (p[6] === "frames" || p[6] === "bulk")) {
      const header = await this.header(instance), h = header.locator.headers[instance.i]!;
      if (!h.complete || header.pixelTag !== "7FE00010" || VIDEO_SYNTAXES[header.syntax] || [TS.J2KPart2, TS.J2KPart2Lossless].includes(header.syntax as any)) throw new HttpError(415, "This object is available as an original DICOM download");
      if (!Number.isSafeInteger(header.frames) || header.frames < 1) throw new HttpError(422, "Invalid frame count");
      const allFrames = p[6] === "bulk", requestedFrames = allFrames ? [] : p[7].split(",").map(Number);
      if (allFrames ? p[7] !== header.pixelTag : !requestedFrames.length || requestedFrames.some(k => !Number.isSafeInteger(k) || k < 1 || k > header.frames)) throw new HttpError(404, "Frame is not in this instance");
      function* frameNumbers() { if (allFrames) { for (let i = 1; i <= header.frames; i++) yield i; } else yield* requestedFrames; }
      const accept = request.headers.get("Accept") ?? "*/*";
      const requested = [...accept.matchAll(/transfer-syntax\s*=\s*"?([^";,\s]+)/gi)].map(m => m[1]);
      if (requested.length && !requested.includes("*") && !requested.includes(header.syntax)) throw new HttpError(406, "The adapter preserves the stored transfer syntax");
      const type = mediaType(header.syntax), boundary = "shl-" + crypto.randomUUID(), self = this;
      async function* payload() {
        for (const frame of frameNumbers()) {
          abort(request.signal);
          const range = await header.locator.locate(instance!.i, frame - 1, { signal: request.signal });
          if (!range) throw new HttpError(422, "Frame location is unavailable");
          if (range[1] - range[0] > FRAME_LIMIT) throw new HttpError(413, "Frame exceeds the adapter's 256 MiB frame budget");
          const stored = await header.locator.frameBytes(instance!.i, frame - 1, { signal: request.signal });
          if (!stored) throw new HttpError(422, "Frame is unavailable");
          let bytes = h.encapsulated ? fragmentPayload(stored) : stored;
          if (!h.encapsulated && h.bitsAllocated === 1) {
            const shift = header.locator.tables[instance!.i]?.bitShift?.(frame - 1) ?? 0;
            const bits = h.rows * h.columns * h.samplesPerPixel, packed = new Uint8Array(Math.ceil(bits / 8));
            for (let k = 0; k < bits; k++) packed[k >> 3] |= ((stored[(k + shift) >> 3] >> ((k + shift) & 7)) & 1) << (k & 7);
            bytes = packed;
          }
          self.stats.frames++;
          yield enc.encode(`--${boundary}\r\nContent-Type: ${type}; transfer-syntax=${header.syntax}\r\nContent-Location: ${self.instanceUrl(instance!)}/frames/${frame}\r\n\r\n`);
          yield bytes; yield enc.encode("\r\n");
        }
        yield enc.encode(`--${boundary}--\r\n`);
      }
      return new Response(stream(payload(), request.signal), { headers: { "Content-Type": `multipart/related; type="${type}"; boundary=${boundary}; transfer-syntax=${header.syntax}`, "Cache-Control": "no-store" } });
    }
    if (p.length === 2 || (series && p.length === 4) || (instance && p.length === 6)) {
      const selected = instance ? [instance] : entries, boundary = "shl-" + crypto.randomUUID(), self = this;
      const single = !!instance && request.headers.get("Accept") === "application/dicom";
      async function* originals() {
        for (const x of selected) {
          if (!single) yield enc.encode(`--${boundary}\r\nContent-Type: application/dicom\r\nContent-Location: ${self.instanceUrl(x)}\r\n\r\n`);
          yield* self.share.loader.streamInstance(x.series, x.i, { signal: request.signal, durable: true, priority: 3 });
          self.stats.originals++; if (!single) yield enc.encode("\r\n");
        }
        if (!single) yield enc.encode(`--${boundary}--\r\n`);
      }
      return new Response(stream(originals(), request.signal), { headers: { "Content-Type": single ? "application/dicom" : `multipart/related; type="application/dicom"; boundary=${boundary}`, "Cache-Control": "no-store" } });
    }
    throw new HttpError(404, "Unknown DICOMweb resource");
  }
}
