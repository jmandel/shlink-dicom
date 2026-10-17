// Multi-frame images read a frame at a time, so the first frame shows before the rest arrive.
//
//   const s = await FrameStream.open(loader, pool, series, i);   // null: read it whole instead
//   const img = await s.frame(k, { priority });                  // frame k of img is ready
//   s.ready[k]                                                   // 1 once frame k is in img
//   const whole = await s.complete;                              // every frame (the same object)
//
// The instance's header is read first (growing ranges up to Pixel Data), then each frame is
// located by the slide viewer's FrameLocator (wsi-source.ts): Extended or Basic Offset Table,
// native frame arithmetic, or a walk over the fragment items. A frame's bytes go to the decoder
// as a small Part 10 file: the instance's own header with Number of Frames 1, only that frame's
// Per-Frame Functional Groups item, and only that frame's pixel data. The decoder reads such a
// file exactly as it reads that frame of the whole instance, so the frames are filled into one
// DecodedImage that matches a decode of the whole instance (web/checks/frame-identity.ts).
//
// Reads go through the InstanceLoader (`range`), so they share its queue and record cache with
// any other read of the instance. After the first frame, the others are read in stored order at
// Prefetch priority (dropped with the series' other prefetch when the viewer leaves it); a frame
// asked for meanwhile goes ahead of them.
import { headerEnd } from "../../viewer-kit/src/header-end";
import type { DecodedImage, DecoderPool } from "../../viewer-kit/src/index";
import type { SeriesEntry } from "./bundle";
import { RecordAuthenticationError } from "./decrypt";
import { FetchPriority, type InstanceLoader } from "./loader";
import { planBytes, RECORD_PLAINTEXT } from "./range";
import { FrameLocator, type ByteSource, type ReadOptions } from "./wsi-source";
import { frameTableFromHeader, parseSlideHeader, type SlideHeader } from "./wsi";

const UNDEF = 0xffffffff;
const LONG_VR = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "SV", "UC", "UN", "UR", "UT", "UV"]);

/**
 * SOP classes whose instances are often multi-frame: worth reading a frame at a time. Single-frame
 * classes (CT, MR, CR, DX, MG Image Storage…) are read whole, without a header read first.
 */
const MULTI_FRAME_CLASSES = new Set([
  "1.2.840.10008.5.1.4.1.1.2.1", // Enhanced CT
  "1.2.840.10008.5.1.4.1.1.2.2", // Legacy Converted Enhanced CT
  "1.2.840.10008.5.1.4.1.1.3.1", // Ultrasound Multi-frame
  "1.2.840.10008.5.1.4.1.1.4.1", // Enhanced MR
  "1.2.840.10008.5.1.4.1.1.4.3", // Enhanced MR Color
  "1.2.840.10008.5.1.4.1.1.4.4", // Legacy Converted Enhanced MR
  "1.2.840.10008.5.1.4.1.1.6.2", // Enhanced US Volume
  "1.2.840.10008.5.1.4.1.1.7.1", // Multi-frame Single Bit SC
  "1.2.840.10008.5.1.4.1.1.7.2", // Multi-frame Grayscale Byte SC
  "1.2.840.10008.5.1.4.1.1.7.3", // Multi-frame Grayscale Word SC
  "1.2.840.10008.5.1.4.1.1.7.4", // Multi-frame True Color SC
  "1.2.840.10008.5.1.4.1.1.12.1", // X-Ray Angiographic
  "1.2.840.10008.5.1.4.1.1.12.1.1", // Enhanced XA
  "1.2.840.10008.5.1.4.1.1.12.2", // X-Ray Radiofluoroscopic
  "1.2.840.10008.5.1.4.1.1.12.2.1", // Enhanced XRF
  "1.2.840.10008.5.1.4.1.1.13.1.1", // X-Ray 3D Angiographic
  "1.2.840.10008.5.1.4.1.1.13.1.2", // X-Ray 3D Craniofacial
  "1.2.840.10008.5.1.4.1.1.13.1.3", // Breast Tomosynthesis
  "1.2.840.10008.5.1.4.1.1.13.1.4", // Breast Projection X-Ray (presentation)
  "1.2.840.10008.5.1.4.1.1.13.1.5", // Breast Projection X-Ray (processing)
  "1.2.840.10008.5.1.4.1.1.14.1", // IVOCT (presentation)
  "1.2.840.10008.5.1.4.1.1.14.2", // IVOCT (processing)
  "1.2.840.10008.5.1.4.1.1.20", // Nuclear Medicine
  "1.2.840.10008.5.1.4.1.1.77.1.5.4", // Ophthalmic Tomography
  "1.2.840.10008.5.1.4.1.1.128.1", // Legacy Converted Enhanced PET
  "1.2.840.10008.5.1.4.1.1.130", // Enhanced PET
]);

/** Below this an instance is read whole: one request is as quick as a header and a frame. */
export const FRAME_STREAM_MIN_BYTES = 1 << 20;

/** Whether instance i of a series is worth reading a frame at a time (its header decides). */
export function mayStreamFrames(series: SeriesEntry, i: number): boolean {
  const inst = series.instances[i];
  return !!inst && inst.length >= FRAME_STREAM_MIN_BYTES && MULTI_FRAME_CLASSES.has(inst.sopClass);
}

/** Plaintext of a series' file through the InstanceLoader's queue and record cache. */
export class LoaderBytes implements ByteSource {
  private recent: { bytes: number; ms: number }[] = [];

  constructor(
    readonly loader: InstanceLoader,
    readonly series: SeriesEntry,
  ) {}

  async read(a: number, b: number, o: ReadOptions = {}): Promise<Uint8Array> {
    const plan = planBytes(this.series, a, b);
    const t0 = performance.now();
    const ct = await this.loader.range(this.series, plan, { priority: o.priority, signal: o.signal });
    this.recent.push({ bytes: ct.byteLength, ms: performance.now() - t0 });
    if (this.recent.length > 8) this.recent.shift();
    try {
      const pt = await this.loader.decryptor.decrypt(this.series, plan, ct);
      this.loader.report(plan, "verified");
      return pt;
    } catch (e) {
      if (e instanceof RecordAuthenticationError) this.loader.report(plan, "failed");
      throw e;
    }
  }

  /** Fetches [a, b) into the loader's record cache without decrypting it (reads after it share it). */
  prefetch(a: number, b: number, o: ReadOptions = {}): Promise<unknown> {
    return this.loader.range(this.series, planBytes(this.series, a, b), { priority: o.priority, signal: o.signal });
  }

  throughput(): number {
    const ms = this.recent.reduce((a, r) => a + r.ms, 0);
    return ms > 0 ? (this.recent.reduce((a, r) => a + r.bytes, 0) * 1000) / ms : 0;
  }
}

// ------------------------------------------------------------------------------- one-frame files

/** One top-level element of a header: [start, end) with its value at vo (len UNDEF: undefined). */
interface El {
  tag: number;
  start: number;
  vo: number;
  len: number;
  end: number;
}

/**
 * The header of a one-frame file for frame k: the instance's header (bytes before Pixel Data)
 * with Number of Frames 1, only item k of the Per-Frame Functional Groups Sequence, and no
 * Extended Offset Table. Null for a header this cannot rewrite (big endian, deflated).
 */
export function frameHeader(header: Uint8Array, k: number): { bytes: Uint8Array; explicit: boolean } | null {
  const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const n = header.byteLength;
  if (n < 132 || dv.getUint32(128) !== 0x4449434d) return null;
  let p = 132;
  let ts = "";
  while (p + 8 <= n && dv.getUint16(p, true) === 0x0002) {
    const vr = String.fromCharCode(header[p + 4], header[p + 5]);
    const long = LONG_VR.has(vr);
    const len = long ? dv.getUint32(p + 8, true) : dv.getUint16(p + 6, true);
    const vo = p + (long ? 12 : 8);
    if (dv.getUint16(p + 2, true) === 0x0010) ts = String.fromCharCode(...header.subarray(vo, vo + len)).replace(/[\0 ]+$/, "");
    p = vo + len;
  }
  if (ts === "1.2.840.10008.1.2.1.99" || ts === "1.2.840.10008.1.2.2" || !ts) return null;
  const explicit = ts !== "1.2.840.10008.1.2";

  const readEl = (q: number): El | null => {
    if (q + 8 > n) return null;
    const tag = ((dv.getUint16(q, true) << 16) | dv.getUint16(q + 2, true)) >>> 0;
    let len: number, vo: number;
    const vr = String.fromCharCode(header[q + 4], header[q + 5]);
    if (tag >>> 16 !== 0xfffe && explicit && /^[A-Z]{2}$/.test(vr)) {
      if (LONG_VR.has(vr)) {
        if (q + 12 > n) return null;
        len = dv.getUint32(q + 8, true);
        vo = q + 12;
      } else {
        len = dv.getUint16(q + 6, true);
        vo = q + 8;
      }
    } else {
      len = dv.getUint32(q + 4, true);
      vo = q + 8;
    }
    const end = len === UNDEF ? skipUndefined(vo) : vo + len;
    return end < 0 || end > n ? null : { tag, start: q, vo, len, end };
  };
  /** Position after the delimiter closing an undefined-length value at q, or -1. */
  const skipUndefined = (q: number): number => {
    while (q + 8 <= n) {
      if (dv.getUint16(q, true) === 0xfffe) {
        const e = dv.getUint16(q + 2, true), len = dv.getUint32(q + 4, true);
        if (e === 0xe0dd || e === 0xe00d) return q + 8;
        const end = len === UNDEF ? skipUndefined(q + 8) : q + 8 + len;
        if (end < 0) return -1;
        q = end;
        continue;
      }
      const el = readEl(q);
      if (!el) return -1;
      q = el.end;
    }
    return -1;
  };

  const parts: Uint8Array[] = [header.subarray(0, p)];
  let frames = false;
  while (p < n) {
    const el = readEl(p);
    if (!el) return null;
    if (el.tag === 0x00280008) {
      // Number of Frames (IS): "1" padded to the value's length.
      const v = header.slice(el.start, el.end);
      const off = el.vo - el.start;
      v.fill(0x20, off);
      v[off] = 0x31;
      parts.push(v);
      frames = true;
    } else if (el.tag === 0x52009230) {
      // Per-Frame Functional Groups: item k only.
      const items: [number, number][] = [];
      let q = el.vo;
      const stop = el.len === UNDEF ? el.end - 8 : el.end;
      while (q < stop) {
        if (dv.getUint16(q, true) !== 0xfffe || dv.getUint16(q + 2, true) !== 0xe000) return null;
        const len = dv.getUint32(q + 4, true);
        const end = len === UNDEF ? skipUndefined(q + 8) : q + 8 + len;
        if (end < 0 || end > stop) return null;
        items.push([q, end]);
        q = end;
      }
      const item = items[k];
      if (!item) return null;
      const head = header.slice(el.start, el.vo);
      const hv = new DataView(head.buffer);
      hv.setUint32(head.byteLength - 4, el.len === UNDEF ? UNDEF : item[1] - item[0], true);
      parts.push(head, header.subarray(item[0], item[1]));
      if (el.len === UNDEF) parts.push(new Uint8Array([0xfe, 0xff, 0xdd, 0xe0, 0, 0, 0, 0]));
    } else if (el.tag === 0x7fe00001 || el.tag === 0x7fe00002) {
      // Extended Offset Table (Lengths): they describe every frame; the file holds one.
    } else {
      parts.push(header.subarray(el.start, el.end));
    }
    p = el.end;
  }
  if (!frames) return null;
  return { bytes: concat(parts), explicit };
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((a, x) => a + x.byteLength, 0));
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.byteLength;
  }
  return out;
}

/**
 * A one-frame Part 10 file: `head` from frameHeader, then Pixel Data holding `frame` (the
 * frame's fragment items, or its native bytes; a 1-bit frame starting at bit `bitShift`).
 * `pixelElement` is the instance's own Pixel Data element header (its VR is kept).
 */
export function frameFile(head: { bytes: Uint8Array; explicit: boolean }, pixelElement: Uint8Array, h: SlideHeader, frame: Uint8Array, bitShift = 0): Uint8Array<ArrayBuffer> {
  const el = pixelElement.slice();
  const ev = new DataView(el.buffer);
  const lenAt = el.byteLength - 4;
  if (h.encapsulated) {
    ev.setUint32(lenAt, UNDEF, true);
    // The frame's bytes are items: keep whole items only.
    const fv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    let used = 0;
    while (used + 8 <= frame.byteLength && fv.getUint16(used, true) === 0xfffe && fv.getUint16(used + 2, true) === 0xe000) {
      const len = fv.getUint32(used + 4, true);
      if (len === UNDEF || used + 8 + len > frame.byteLength) break;
      used += 8 + len;
    }
    return concat([head.bytes, el, new Uint8Array([0xfe, 0xff, 0x00, 0xe0, 0, 0, 0, 0]), frame.subarray(0, used), new Uint8Array([0xfe, 0xff, 0xdd, 0xe0, 0, 0, 0, 0])]);
  }
  let data = frame;
  if (h.bitsAllocated === 1) {
    // Frames of 1-bit data are packed back to back: re-align this one to its first byte.
    const out = new Uint8Array(Math.ceil((h.rows * h.columns * h.samplesPerPixel) / 8));
    for (let i = 0; i < out.length; i++) out[i] = ((frame[i] >> bitShift) | ((frame[i + 1] ?? 0) << (8 - bitShift))) & 0xff;
    data = out;
  }
  const pad = data.byteLength % 2 ? new Uint8Array(1) : new Uint8Array(0);
  ev.setUint32(lenAt, data.byteLength + pad.byteLength, true);
  return concat([head.bytes, el, data, pad]);
}

// ------------------------------------------------------------------------------------- the stream

export interface FrameReadOptions {
  priority?: number;
  signal?: AbortSignal;
}

const abortError = () => new DOMException("frame read aborted", "AbortError");

/** `p`, or an AbortError when `signal` aborts first (p goes on). */
function withSignal<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((res, rej) => {
    const onAbort = () => rej(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(res, rej).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
const isAbort = (e: unknown) => (e as any)?.name === "AbortError";

/** Frames read ahead at once by the background read. */
const AHEAD = 6;

export class FrameStream {
  /** The image, once a frame is decoded: every frame's slot, filled as frames arrive. */
  image: DecodedImage | null = null;
  /** 1 for each frame filled in `image`. */
  readonly ready: Uint8Array;
  readyCount = 0;
  /** Resolves with `image` when every frame is in. */
  readonly complete: Promise<DecodedImage>;
  private resolveComplete!: (img: DecodedImage) => void;
  private rejectComplete!: (e: unknown) => void;
  private jobs = new Map<number, { p: Promise<void>; priority: number }>();
  private streaming = false;
  private background: number = FetchPriority.Prefetch;
  private failed: unknown = null;
  /** Background runs started (a new one supersedes the last). */
  private runs = 0;
  /** The frame asked for last: read first, and the background read goes outward from it. */
  private focus = 0;
  /** Reads at Visible priority in flight (at most two: a scrub's older asks wait their turn). */
  private visible = 0;
  private waiters = new Map<number, { res: () => void; rej: (e: unknown) => void }[]>();
  /** Viewing order (position → stored frame) and its inverse; stored order until setOrder. */
  private order: number[] | null = null;
  private position: Int32Array | null = null;
  /** +1 or -1: the way the asks have been moving through the viewing order. */
  private heading: 1 | -1 = 1;

  private constructor(
    readonly pool: DecoderPool,
    readonly locator: FrameLocator,
    readonly series: SeriesEntry,
    readonly instance: number,
    /** The instance's bytes before Pixel Data. */
    readonly header: Uint8Array,
    readonly h: SlideHeader,
    private pixelElement: Uint8Array,
  ) {
    this.ready = new Uint8Array(h.numberOfFrames);
    this.complete = new Promise((res, rej) => ((this.resolveComplete = res), (this.rejectComplete = rej)));
    this.complete.catch(() => {});
  }

  get frames(): number {
    return this.h.numberOfFrames;
  }

  /**
   * Reads instance i's header. Null when the instance is not one to read a frame at a time: one
   * frame, float pixel data, a header the one-frame files cannot be made from, or frames that
   * can't be located.
   */
  static async open(loader: InstanceLoader, pool: DecoderPool, series: SeriesEntry, i: number, o: FrameReadOptions = {}): Promise<FrameStream | null> {
    const inst = series.instances[i];
    const locator = new FrameLocator(series, new LoaderBytes(loader, series));
    let n = locator.firstHeaderBytes(i);
    let bytes: Uint8Array;
    let h: SlideHeader;
    for (;;) {
      bytes = await locator.bytes.read(inst.offset, inst.offset + n, { priority: o.priority ?? FetchPriority.Visible, signal: o.signal, purpose: "header" });
      try {
        h = parseSlideHeader(bytes, { partial: true });
      } catch {
        return null; // big endian, deflated, or not Part 10
      }
      if (h.complete) break;
      if (h.rows && h.numberOfFrames < 2) return null;
      // Pixel Data that is not (7FE0,0010): float pixel data, read whole.
      const e = headerEnd(bytes);
      if (e + 4 <= bytes.byteLength && new DataView(bytes.buffer, bytes.byteOffset).getUint16(e + 2, true) !== 0x0010) return null;
      if (n >= inst.length) return null;
      const want = inst.offset + Math.max((h.needBytes || n) + 1024, Math.ceil(n * 2.5));
      n = Math.min(inst.length, (Math.floor(want / RECORD_PLAINTEXT) + 1) * RECORD_PLAINTEXT - inst.offset);
    }
    const end = headerEnd(bytes);
    const elementBytes = h.encapsulated || h.transferSyntax !== "1.2.840.10008.1.2" ? 12 : 8;
    if (h.numberOfFrames < 2 || !h.rows || !h.columns || h.pixelDataValueOffset !== end + elementBytes) return null;
    // JPEG 2000 Part 2: the frames of a volume may be components of one codestream.
    if (h.transferSyntax === "1.2.840.10008.1.2.4.92" || h.transferSyntax === "1.2.840.10008.1.2.4.93") return null;
    const header = bytes.slice(0, end);
    const head0 = frameHeader(header, 0);
    if (!head0) return null;
    locator.headers[i] = h;
    locator.tables[i] = frameTableFromHeader(h, inst.length);
    if (!h.encapsulated && h.photometric.startsWith("YBR") && h.photometric.endsWith("_422")) {
      // Native YBR_FULL_422 stores two samples per pixel, not three.
      const fb = (h.rows * h.columns * 2 * h.bitsAllocated) / 8;
      if (!Number.isInteger(fb) || h.samplesPerPixel !== 3) return null;
      const base = h.pixelDataValueOffset;
      locator.tables[i] = { source: "native", range: (k) => (k < h.numberOfFrames ? [base + k * fb, base + (k + 1) * fb] : null) };
    }
    if (!locator.tables[i] && !h.encapsulated) return null;
    return new FrameStream(pool, locator, series, i, header, h, bytes.slice(end, h.pixelDataValueOffset));
  }

  /** True when the stream gave up (a frame failed to read or decode): read the instance whole. */
  get broken(): boolean {
    return this.failed !== null;
  }

  /**
   * Frame k (stored order) decoded into `image`; resolves with the image. At Visible priority the
   * latest ask goes first: two such reads at most are in flight, and an ask that has not started
   * when a newer one comes waits for the background read, which works outward from the newest.
   */
  async frame(k: number, o: FrameReadOptions = {}): Promise<DecodedImage> {
    if (this.failed) throw this.failed;
    if (k < 0 || k >= this.frames) throw new RangeError(`frame ${k} of ${this.frames}`);
    const priority = o.priority ?? FetchPriority.Visible;
    if (!this.ready[k]) {
      if (priority <= FetchPriority.Visible) {
        const at = (f: number) => (this.position ? this.position[f] : f);
        if (at(k) !== at(this.focus)) this.heading = at(k) > at(this.focus) ? 1 : -1;
        this.focus = k;
        const p = new Promise<void>((res, rej) => {
          let w = this.waiters.get(k);
          if (!w) this.waiters.set(k, (w = []));
          w.push({ res, rej });
        });
        this.kick();
        await withSignal(p, o.signal);
      } else {
        for (let tries = 0; !this.ready[k]; tries++) {
          try {
            await withSignal(this.job(k, priority), o.signal);
          } catch (e) {
            // A shared read the loader dropped (the background read of a series left and come back to).
            if (isAbort(e) && !o.signal?.aborted && tries < 3) continue;
            throw e;
          }
        }
      }
    }
    this.kick();
    return this.image!;
  }

  /**
   * The order the frames are viewed in (position → stored frame; the viewer sorts them in space).
   * The background read goes outward from the frame asked for last in this order, ahead in the
   * direction the asks are moving first.
   */
  setOrder(order: number[] | null) {
    if (order && (order.length !== this.frames || new Set(order).size !== this.frames)) order = null;
    this.order = order;
    this.position = order ? Int32Array.from({ length: this.frames }) : null;
    if (order) order.forEach((f, i) => (this.position![f] = i));
  }

  /** Reads the frames not yet in at `priority` at least (ImageStore.get waiting for all of them). */
  raise(priority: number) {
    this.background = Math.min(this.background, priority);
    this.kick();
  }

  /** Starts the focus frame's read if it can, and the background read if it is not running. */
  private kick() {
    if (this.failed) return;
    const f = this.focus;
    if (!this.ready[f]) {
      const j = this.jobs.get(f);
      if (j) {
        if (j.priority > FetchPriority.Visible) void this.job(f, FetchPriority.Visible).catch(() => {});
      } else if (this.visible < 2) {
        this.visible++;
        this.job(f, FetchPriority.Visible).then(
          () => {
            this.visible--;
            this.kick();
          },
          (e) => {
            this.visible--;
            if (!isAbort(e)) this.fail(e);
            else this.kick();
          },
        );
      }
    }
    if (!this.streaming && this.readyCount < this.frames) this.stream();
  }

  private fail(e: unknown) {
    if (this.failed) return;
    this.failed = e;
    this.streaming = false;
    this.rejectComplete(e);
    for (const w of this.waiters.values()) for (const x of w) x.rej(e);
    this.waiters.clear();
  }

  /**
   * Frame k's read and decode, shared by everyone who asks for it. A caller giving up does not
   * stop it (the frame is wanted anyway); a more urgent ask asks the loader again at its priority,
   * which moves the queued request up.
   */
  private job(k: number, priority: number): Promise<void> {
    const j = this.jobs.get(k);
    if (j) {
      if (priority < j.priority) {
        j.priority = priority;
        void this.locator.frameBytes(this.instance, k, { priority, purpose: "image" }).catch(() => {});
      }
      return j.p;
    }
    const entry = { p: Promise.resolve(), priority };
    entry.p = this.read(k, entry);
    this.jobs.set(k, entry);
    const drop = () => this.jobs.get(k) === entry && this.jobs.delete(k);
    entry.p.then(drop, drop);
    return entry.p;
  }

  private async read(k: number, job: { priority: number }): Promise<void> {
    const bytes = await this.locator.frameBytes(this.instance, k, { priority: job.priority, purpose: "image" });
    if (this.ready[k]) return;
    if (!bytes) throw new Error(`frame ${k + 1} of ${this.frames} was not found in the Pixel Data`);
    const head = frameHeader(this.header, k);
    if (!head) throw new Error("the header could not be read frame by frame");
    const shift = this.locator.tables[this.instance]?.bitShift?.(k) ?? 0;
    const file = frameFile(head, this.pixelElement, this.h, bytes, shift);
    const img = await this.pool.decode(file, { priority: job.priority, key: `${this.series.id}/${this.instance}#${k}` });
    if (!this.ready[k]) this.fill(k, img);
  }

  /** Puts decoded frame k into the image (made from the first frame decoded). */
  private fill(k: number, one: DecodedImage) {
    const n = this.frames;
    const fb = one.frameBytes;
    let img = this.image;
    if (!img) {
      img = this.image = {
        ...one,
        frames: n,
        firstFrame: 0,
        totalFrames: n,
        pixels: new ArrayBuffer(fb * n),
        frameOffsets: Array.from({ length: n }, (_, j) => j * fb),
        perFrame: one.perFrame ? new Array(n).fill(null) : null,
        minValue: null,
        maxValue: null,
        header: this.header,
        decodeMs: 0,
        totalMs: 0,
      };
    }
    if (one.frameBytes !== img.frameBytes || one.rows !== img.rows || one.columns !== img.columns) throw new Error(`frame ${k + 1} does not match the others`);
    new Uint8Array(img.pixels, k * fb, fb).set(new Uint8Array(one.pixels, 0, fb));
    if (img.perFrame) {
      if (one.perFrame) img.perFrame[k] = one.perFrame[0];
      else img.perFrame = null;
    }
    if (one.minValue != null) img.minValue = img.minValue == null ? one.minValue : Math.min(img.minValue, one.minValue);
    if (one.maxValue != null) img.maxValue = img.maxValue == null ? one.maxValue : Math.max(img.maxValue, one.maxValue);
    if (k === 0) {
      // The instance-wide attributes as a whole decode reports them (from frame 0's groups).
      const { frames: _f, firstFrame: _a, totalFrames: _t, pixels: _p, frameOffsets: _o, perFrame: _pf, minValue: _lo, maxValue: _hi, header: _h, decodeMs: _d, totalMs: _m, ...rest } = one;
      Object.assign(img, rest);
    }
    img.decodeMs += one.decodeMs;
    this.ready[k] = 1;
    this.readyCount++;
    const w = this.waiters.get(k);
    if (w) {
      this.waiters.delete(k);
      for (const x of w) x.res();
    }
    if (this.readyCount === n) this.resolveComplete(img);
  }

  /**
   * The frame to read next in the background: the nearest to the focus in viewing order that is
   * not in or on its way, ahead (in the heading) before behind at each distance.
   */
  private pickNext(): number {
    const n = this.frames, order = this.order;
    const p = this.position ? this.position[this.focus] : this.focus;
    const h = this.heading;
    for (let d = 0; d < n; d++) {
      for (const q of d ? [p + h * d, p - h * d] : [p]) {
        if (q < 0 || q >= n) continue;
        const k = order ? order[q] : q;
        if (!this.ready[k] && !this.jobs.has(k)) return k;
      }
    }
    return -1;
  }

  /** Which way to batch from frame k in stored order: towards the next frame in viewing order. */
  private batchDirection(k: number): 1 | -1 {
    const order = this.order;
    if (!order) return k >= this.focus ? 1 : -1;
    const p = this.position![k], f = this.position![this.focus];
    const next = order[p + (p >= f ? 1 : -1)];
    return next !== undefined && next < k ? -1 : 1;
  }

  /**
   * Frame k and the frames after it in direction `dir` (stored order) that are not in or on their
   * way and lie next to it in the file, up to about 0.4 s of transfer at the measured speed (256 KiB
   * to 4 MiB). Their bytes are asked for in one read, so the frames' own reads find their records
   * on the way instead of making a request each.
   */
  private batch(k: number, dir: 1 | -1): number[] {
    const t = this.locator.tables[this.instance];
    const bytes = this.locator.bytes as LoaderBytes;
    const first = t?.range(k);
    if (!t || t.source === "walk" || !bytes.prefetch || !first) return [k];
    const bps = bytes.throughput();
    const want = Math.max(4 * RECORD_PLAINTEXT, Math.min(64 * RECORD_PLAINTEXT, bps ? bps * 0.4 : 4 * RECORD_PLAINTEXT));
    let [a, b] = first;
    const out = [k];
    for (let j = k + dir; j >= 0 && j < this.frames && !this.ready[j] && !this.jobs.has(j); j += dir) {
      const r = t.range(j);
      if (!r || (dir > 0 ? r[0] !== b : r[1] !== a) || Math.max(b, r[1]) - Math.min(a, r[0]) > want) break;
      [a, b] = [Math.min(a, r[0]), Math.max(b, r[1])];
      out.push(j);
    }
    const off = this.series.instances[this.instance].offset;
    if (out.length > 1) void bytes.prefetch(off + a, off + b, { priority: this.background }).catch(() => {});
    return out;
  }

  /** Reads every frame not yet in, nearest the focus first, a batch or a few frames at a time. */
  private stream() {
    this.streaming = true;
    const run = ++this.runs;
    let running = 0;
    const live = () => run === this.runs && !this.failed;
    const pump = () => {
      while (live() && running < AHEAD) {
        const k = this.pickNext();
        if (k < 0) break;
        for (const j of this.batch(k, this.batchDirection(k))) {
          running++;
          this.job(j, this.background).then(
            () => {
              running--;
              pump();
            },
            (e) => {
              running--;
              if (!live()) return;
              if (isAbort(e)) {
                // The loader dropped the read (the viewer left the series): stop until asked again.
                this.runs++;
                this.streaming = false;
                return;
              }
              this.fail(e);
            },
          );
        }
      }
      if (live() && running === 0 && this.pickNext() < 0) this.streaming = false;
    };
    pump();
  }
}
