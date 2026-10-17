// Lossless compression on the device (spec/README.md §11.1): uncompressed images are re-encoded
// before they are encrypted, so a share is smaller and recipients download less. The pixels stay
// identical; the file bytes change (new transfer syntax, encapsulated Pixel Data, and the file meta
// naming this packer). Every other file (reports, SRs, PDFs, already-compressed images) stays as it
// is, and so does any image the encoder declines.
//
// Two encodings: JPEG Lossless SV1 (the default: fast) and JPEG 2000 Lossless (smaller, slower).
// The encoders run in workers (compress-worker.ts) and check each result bit for bit before
// returning it. Each re-encoded file is staged with its SHA-256, so an interrupted upload continues
// with exactly the bytes it started with.
import { assetUrl } from "../../core/config";
import { TS } from "../../core/transfer-syntax";
import type { Bytes } from "./bytes";
import type { Collection, Instance, SeriesModel, StudyModel } from "./ingest";
import { shlWasm } from "./shl-wasm";
import type { Stager } from "./stage";

export type CompressMode = "sv1" | "j2k" | "exact";
export type Encoding = Exclude<CompressMode, "exact">;

/** The review step's choice when it is first shown. */
export const COMPRESS_DEFAULT: CompressMode = "sv1";

export const ENCODING_TS: Record<Encoding, string> = { sv1: TS.JPEGLosslessSV1, j2k: TS.J2KLossless };
export const ENCODING_NAME: Record<Encoding, string> = { sv1: "JPEG Lossless", j2k: "JPEG 2000 Lossless" };

/** The name of the encoding the Share page writes as transfer syntax `ts`, if it is one. */
export function encodingName(ts: string): string | undefined {
  const e = (Object.keys(ENCODING_TS) as Encoding[]).find((k) => ENCODING_TS[k] === ts);
  return e && ENCODING_NAME[e];
}

/**
 * Whether an instance is an uncompressed image the encoders may take: the packer's rule
 * (shl_dicom_transcode::is_uncompressed_image, through shl-dicom-wasm). Needs loadShlWasm first.
 */
export function isUncompressedImage(inst: Instance): boolean {
  return shlWasm().is_uncompressed_image(inst.h.transferSyntax, inst.h.sopClassUid, inst.src.size);
}

export function uncompressedImages(studies: StudyModel[]): { se: SeriesModel; inst: Instance }[] {
  const out: { se: SeriesModel; inst: Instance }[] = [];
  for (const st of studies) for (const se of st.series) for (const inst of se.instances) if (isUncompressedImage(inst)) out.push({ se, inst });
  return out;
}

export type TranscodeResult = { bytes: Uint8Array; transferSyntax: string } | { declined: string };

/**
 * How many encodes run at once: one per core but one, at most four, and fewer on devices that
 * report little memory (each worker keeps its encoder's memory, about four times the largest image
 * it has encoded, until the pool is closed): one per 2 GB.
 */
function poolSize(): number {
  const cores = Math.max(1, (navigator.hardwareConcurrency || 2) - 1);
  const gb = (navigator as any).deviceMemory as number | undefined;
  const byMemory = gb === undefined ? 4 : Math.max(1, Math.floor(gb / 2));
  return Math.max(1, Math.min(cores, byMemory, 4));
}

/** Input bytes being encoded at once, across workers (a larger image still goes, alone). */
const IN_FLIGHT = 48 << 20;

/** Workers running the encoders. */
export class CompressPool {
  private idle: Worker[] = [];
  private waiting: (() => void)[] = [];
  private seq = 0;
  private pending = new Map<number, (r: TranscodeResult) => void>();
  private capsWaiting: ((ts: string[]) => void)[] = [];
  private caps: Promise<Encoding[]> | null = null;
  readonly size: number;
  private workers: Worker[] = [];

  constructor(n = poolSize()) {
    this.size = n;
    for (let i = 0; i < n; i++) {
      const w = new Worker(assetUrl("compress-worker.js"), { type: "module" });
      w.onmessage = (ev) => {
        const m = ev.data;
        if (m.caps) {
          this.capsWaiting.shift()?.(m.caps);
          this.idle.push(w);
          this.waiting.shift()?.();
          return;
        }
        this.pending.get(m.id)?.(m.bytes ? { bytes: new Uint8Array(m.bytes), transferSyntax: m.transferSyntax } : { declined: m.declined ?? "no result" });
        this.pending.delete(m.id);
        this.idle.push(w);
        this.waiting.shift()?.();
      };
      this.idle.push(w);
      this.workers.push(w);
    }
  }

  /** Ends the workers, giving back their memory (the encoders' memory only grows while they live). */
  close() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.idle = [];
  }

  /** The encodings this build's encoder offers (JPEG Lossless always, when it loads at all). */
  encodings(): Promise<Encoding[]> {
    this.caps ??= (async () => {
      while (!this.idle.length) await new Promise<void>((r) => this.waiting.push(r));
      const w = this.idle.pop()!;
      const ts = await new Promise<string[]>((resolve) => {
        this.capsWaiting.push(resolve);
        w.postMessage({ id: 0, caps: true });
      });
      return (Object.keys(ENCODING_TS) as Encoding[]).filter((e) => ts.includes(ENCODING_TS[e]));
    })();
    return this.caps;
  }

  async transcode(bytes: Uint8Array, mode: Encoding): Promise<TranscodeResult> {
    while (!this.idle.length) await new Promise<void>((r) => this.waiting.push(r));
    const w = this.idle.pop()!;
    const id = ++this.seq;
    // Always a copy: the buffer goes to the worker (transferred), and `bytes` may be a view of the
    // image's own source (an in-memory staged file), which a transfer would empty.
    const copy = bytes.slice();
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      w.postMessage({ id, bytes: copy.buffer, mode }, [copy.buffer as ArrayBuffer]);
    });
  }
}

let shared: CompressPool | null = null;
/** One pool per page, made when first needed. */
export function compressPool(): CompressPool {
  return (shared ??= new CompressPool());
}

/** Closes the page's pool once compressing is done, so the upload runs without the encoders' memory. */
export function closeCompressPool() {
  shared?.close();
  shared = null;
}

export type Transcode = (bytes: Uint8Array, mode: Encoding) => Promise<TranscodeResult>;
const poolTranscode: Transcode = (b, m) => compressPool().transcode(b, m);

export interface CompressProgress {
  done: number;
  total: number;
  /** Bytes of the images handled so far, before and after. */
  before: number;
  after: number;
  /** Uncompressed bytes of every image to do, and seconds since the start. */
  totalBytes: number;
  seconds: number;
}

/** A re-encoded instance: its staged file (in the stager) and the SHA-256 of its bytes. */
export interface Reencoded {
  file: string;
  sha256: string;
}

export interface CompressSummary extends CompressProgress {
  mode: Encoding;
  /** Images re-encoded; the rest of `total` were kept as they were. */
  compressed: number;
  /** Why images were kept, with counts. */
  declined: Map<string, number>;
  /** By SOP Instance UID: what an interrupted upload needs to continue with the same bytes. */
  records: Record<string, Reencoded>;
  /** SOP Instance UIDs of the images kept as they were. */
  kept: string[];
}

export interface CompressOptions {
  /** Called as each image is handled (in the order they finish), with its record when re-encoded. */
  onImage?: (inst: Instance, rec: Reencoded | null) => void | Promise<void>;
  /** SOP Instance UIDs to leave alone (images kept as they were before a reload). */
  skip?: ReadonlySet<string>;
}

const hex = async (b: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");

/** The staged file's name in the stager (empty for an in-memory stager). */
const stagedName = (src: Bytes) => ((src as any).blob?.name as string | undefined) ?? "";

const once = (b: Uint8Array) =>
  (async function* () {
    yield b;
  })();

/**
 * Re-encodes the uncompressed images of these studies, in place: each re-encoded instance gets the
 * staged result as its bytes and the new transfer syntax in its header. Measured progress: images
 * handled of the known total.
 */
export async function compressStudies(
  col: Collection,
  studies: StudyModel[],
  mode: Encoding,
  stager: Stager,
  onProgress?: (p: CompressProgress) => void,
  signal?: AbortSignal,
  transcode: Transcode = poolTranscode,
  o: CompressOptions = {},
): Promise<CompressSummary> {
  const todo = uncompressedImages(studies).filter(({ inst }) => !o.skip?.has(inst.h.sopInstanceUid));
  const t0 = performance.now();
  const sum: CompressSummary = {
    mode,
    done: 0,
    total: todo.length,
    before: 0,
    after: 0,
    totalBytes: todo.reduce((a, x) => a + x.inst.src.size, 0),
    seconds: 0,
    compressed: 0,
    declined: new Map(),
    records: {},
    kept: [],
  };
  onProgress?.(sum);
  let inFlight = 0;
  const gate: (() => void)[] = [];
  const one = async ({ se, inst }: { se: SeriesModel; inst: Instance }) => {
    const size = inst.src.size;
    while (inFlight > 0 && inFlight + size > IN_FLIGHT) await new Promise<void>((r) => gate.push(r));
    inFlight += size;
    try {
      signal?.throwIfAborted();
      const r = await transcode(await inst.src.read(0, size), mode);
      sum.before += size;
      let rec: Reencoded | null = null;
      if ("bytes" in r) {
        const sha256 = await hex(r.bytes);
        const staged = await stager.stage(inst.name, once(r.bytes));
        rec = sum.records[inst.h.sopInstanceUid] = { file: stagedName(staged), sha256 };
        replaceBytes(col, se, inst, staged, r.transferSyntax);
        sum.after += staged.size;
        sum.compressed++;
      } else {
        sum.after += size;
        sum.declined.set(r.declined, (sum.declined.get(r.declined) ?? 0) + 1);
        sum.kept.push(inst.h.sopInstanceUid);
      }
      sum.done++;
      sum.seconds = (performance.now() - t0) / 1000;
      onProgress?.(sum);
      await o.onImage?.(inst, rec);
    } finally {
      inFlight -= size;
      gate.shift()?.();
    }
  };
  // Enough readers to keep every worker busy, and two ahead.
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: workers() + 2 }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) await one(job);
    }),
  );
  return sum;
}

/** Workers encoding at once on this device. */
export function workers(): number {
  return shared?.size ?? poolSize();
}

/**
 * For an upload that continues after a reload: gives each instance re-encoded last time the same
 * bytes again, from its staged file when it is still there (checked against its SHA-256), else by
 * encoding it again (and checking that gives the same bytes). Throws when neither works.
 */
export async function restoreCompressed(
  col: Collection,
  studies: StudyModel[],
  mode: Encoding,
  records: Record<string, Reencoded>,
  stager: Stager,
  onProgress?: (done: number, total: number) => void,
  transcode: Transcode = poolTranscode,
): Promise<void> {
  const todo = uncompressedImages(studies).filter(({ inst }) => records[inst.h.sopInstanceUid]);
  let done = 0;
  onProgress?.(done, todo.length);
  for (const { se, inst } of todo) {
    const rec = records[inst.h.sopInstanceUid];
    let src: Bytes | null = rec.file ? await stager.open(rec.file) : null;
    if (src && (await hex(await src.read(0, src.size))) !== rec.sha256) src = null;
    if (!src) {
      const r = await transcode(await inst.src.read(0, inst.src.size), mode);
      if (!("bytes" in r) || (await hex(r.bytes)) !== rec.sha256) {
        throw new Error("The compressed copies of some images are gone, and compressing them again did not give the same files. Start the upload again.");
      }
      src = await stager.stage(inst.name, once(r.bytes));
    }
    replaceBytes(col, se, inst, src, ENCODING_TS[mode]);
    onProgress?.(++done, todo.length);
  }
}

/** Swaps an instance's bytes for its re-encoded copy and keeps the counts in step. */
function replaceBytes(col: Collection, se: SeriesModel, inst: Instance, src: Bytes, ts: string) {
  const delta = src.size - inst.src.size;
  inst.src = src;
  inst.h = { ...inst.h, transferSyntax: ts };
  inst.reencoded = true;
  se.bytes += delta;
  col.bytes += delta;
  se.transferSyntaxes = new Set(se.instances.map((i) => i.h.transferSyntax).filter(Boolean));
}

/** About how much smaller a series gets, by each encoding, and how fast this device encodes. */
export interface SeriesEstimate {
  /** Uncompressed images and their bytes. */
  images: number;
  before: number;
  /** About how many bytes after re-encoding, by encoding. */
  after: Record<Encoding, number>;
  /** Encoding speed measured here: uncompressed bytes per second in one worker (0: not measured). */
  rate: Record<Encoding, number>;
  /** Whether the sample image was encoded (false: declined, for example when this build lacks the encoding). */
  ok: Record<Encoding, boolean>;
}

/**
 * Estimates a series by encoding one of its uncompressed images (the middle one) both ways and
 * applying the ratios to the rest. Null when the series has none.
 */
export async function estimateSeries(se: SeriesModel, encodings: Encoding[], transcode: Transcode = poolTranscode): Promise<SeriesEstimate | null> {
  const mine = se.instances.filter(isUncompressedImage);
  if (!mine.length) return null;
  const before = mine.reduce((a, i) => a + i.src.size, 0);
  const pick = mine[Math.floor(mine.length / 2)];
  const bytes = await pick.src.read(0, pick.src.size);
  const est: SeriesEstimate = { images: mine.length, before, after: { sv1: before, j2k: before }, rate: { sv1: 0, j2k: 0 }, ok: { sv1: false, j2k: false } };
  for (const mode of encodings) {
    const t0 = performance.now();
    const r = await transcode(bytes.slice(), mode);
    const s = (performance.now() - t0) / 1000;
    if ("bytes" in r) {
      est.ok[mode] = true;
      est.after[mode] = Math.round(before * (r.bytes.length / pick.src.size));
      if (s > 0) est.rate[mode] = pick.src.size / s;
    }
  }
  return est;
}
