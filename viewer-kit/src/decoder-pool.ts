// DecoderPool: N Web Workers, each with its own instance of the shl-dicom-decode wasm.
//
//   const pool = await DecoderPool.create({ wasmUrl, workerUrl });
//   const img = await pool.decode(bytes, { priority: Priority.Visible, signal });
//   const thumb = await pool.decode(bytes, { scale: 3 });   // 1/8 size, for thumbnails
//   const all = await pool.decodeFrames(bytes, { priority: Priority.Visible });   // multi-frame, in parallel
//
// Scheduling: a single queue ordered by priority (lower number first), then by submission order.
// A job is handed to a worker only when that worker is idle, so a Visible job submitted after
// 100 queued Prefetch jobs starts as soon as any worker finishes its current job.
//
// Transfers: the input buffer is transferred to the worker (the caller's ArrayBuffer is detached)
// unless `copy: true`, or unless the view does not cover its whole buffer (then it is sliced).
// Output pixels are copied once out of wasm memory in the worker and transferred to the caller.
//
// Cancellation: an aborted job still in the queue is removed. A job already running in a worker
// cannot be interrupted (wasm has no preemption); its promise rejects at once with an AbortError
// and the result is dropped when it arrives.
import { decodeError, type DecodedImage, type ImageInfo, type PaletteLut } from "./types";
import { RecordAuthenticationError } from "./record-decrypt";
import type { Probe } from "./wasm-decoder";

export const Priority = {
  /** The slice on screen. */
  Visible: 0,
  /** Neighbours of the slice on screen. */
  Near: 1,
  /** Everything else. */
  Prefetch: 2,
} as const;

export interface DecodeOptions {
  /** Lower runs first; see Priority. Default Priority.Visible. */
  priority?: number;
  signal?: AbortSignal;
  /** Copy the input instead of transferring it (keeps the caller's buffer usable). */
  copy?: boolean;
  /** Decode only frames first..first+count of a multi-frame instance (count 0: to the end). */
  first?: number;
  count?: number;
  /**
   * Decode at 1/2^scale size in each direction (0, the default, is full size): rows and columns
   * become ceil(fullRows / 2^scale) and ceil(fullColumns / 2^scale). JPEG baseline/extended
   * uses its own reduced decode (much cheaper at 1/8); other syntaxes decode in full and are
   * box-averaged in the worker. The result's `scale`, `fullRows` and `fullColumns` are set.
   * When deduplicating, put the scale in `key`: a same-key job returns the first job's result.
   */
  scale?: number;
  /**
   * The input is linked-file ciphertext (PROPOSAL.md §9): the worker verifies and decrypts it with
   * WebCrypto (record-decrypt.ts) and decodes the plaintext window. A record that fails its check
   * rejects with RecordAuthenticationError and nothing is decoded.
   */
  encrypted?: EncryptedInput;
  /** Also return the instance's bytes before Pixel Data (`img.header`), for parsing its attributes. */
  header?: boolean;
  /**
   * Deduplication key (for example `${study}/${series}/${instance}`). A second decode() with the
   * same key while the first is queued or running returns the first promise; a higher priority
   * moves the queued job up.
   */
  key?: string;
}

/** How to decrypt a ciphertext input (see record-decrypt.ts decryptRecords). */
export interface EncryptedInput {
  /** Non-extractable AES-GCM file key (structured-cloneable; posted with the job). */
  key: CryptoKey;
  /** Index of the input's first record in its file. */
  firstRecord: number;
  /** The file's plaintext length, for the record-length checks. */
  filePlaintextLength: number;
  /** Plaintext bytes to keep, counted from the start of the first record. */
  window: { start: number; length: number };
}

export interface FramesOptions extends Omit<DecodeOptions, "first" | "count" | "key"> {
  /** Frames per job. Default: spread over all workers, at least 1. */
  framesPerJob?: number;
  /** Called with each chunk as it arrives (frames firstFrame..firstFrame+frames-1). */
  onChunk?: (chunk: DecodedImage) => void;
}

export interface PoolStats {
  workers: number;
  queued: number;
  running: number;
  completed: number;
}

export interface PoolOptions {
  /** URL of shl_dicom_decode.wasm, or an already compiled module. */
  wasm: string | URL | WebAssembly.Module;
  /**
   * The JPEG XL decoder module (shl_dicom_decode_jxl.wasm), fetched and compiled the first time
   * a worker meets a JPEG XL instance (.110–.112), then shared by all workers. Default: that file
   * next to `wasm` when `wasm` is a URL; none when it is a module. `null` turns JPEG XL off (such
   * instances then fail with UnsupportedDicomError).
   */
  jxlWasm?: string | URL | WebAssembly.Module | null;
  /** URL of the bundled decoder-worker.js. */
  workerUrl: string | URL;
  /** Default: navigator.hardwareConcurrency - 1, at least 1, at most 8. */
  workers?: number;
  /** Called whenever the queue or the running set changes (for a queue-depth readout). */
  onStats?: (s: PoolStats) => void;
}

interface Job {
  id: number;
  seq: number;
  priority: number;
  kind: "decode" | "probe" | "decrypt";
  bytes: ArrayBuffer;
  first: number;
  count: number;
  scale: number;
  key?: string;
  encrypted?: EncryptedInput;
  header?: boolean;
  t0: number;
  resolve(v: any): void;
  reject(e: unknown): void;
  settled: boolean;
  promise?: Promise<any>;
}

interface Slot {
  worker: Worker;
  job: Job | null;
}

const abortError = () => new DOMException("decode aborted", "AbortError");

export function defaultWorkerCount(): number {
  const hc = (globalThis.navigator?.hardwareConcurrency ?? 2) - 1;
  return Math.max(1, Math.min(8, hc));
}

export class DecoderPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private byKey = new Map<string, Job>();
  private nextId = 1;
  private completed = 0;
  private onStats?: (s: PoolStats) => void;
  private jxlSource: string | URL | WebAssembly.Module | null = null;
  private jxlModule: Promise<WebAssembly.Module> | null = null;

  private constructor() {}

  /** The JPEG XL module, compiled once on first use. */
  private loadJxl(): Promise<WebAssembly.Module> {
    const src = this.jxlSource;
    if (!src) return Promise.reject(new Error("no JPEG XL decoder module configured (PoolOptions.jxlWasm)"));
    this.jxlModule ??= src instanceof WebAssembly.Module ? Promise.resolve(src) : WebAssembly.compileStreaming(fetch(src));
    this.jxlModule.catch(() => (this.jxlModule = null)); // a failed fetch may be retried
    return this.jxlModule;
  }

  /** A worker asks for the JPEG XL module: send it, or the reason it is unavailable. */
  private sendJxl(worker: Worker) {
    this.loadJxl().then(
      (module) => worker.postMessage({ type: "jxl", module }),
      (e) => worker.postMessage({ type: "jxl", error: String((e as Error)?.message ?? e) }),
    );
  }

  static async create(opts: PoolOptions): Promise<DecoderPool> {
    const pool = new DecoderPool();
    pool.onStats = opts.onStats;
    pool.jxlSource = opts.jxlWasm !== undefined ? opts.jxlWasm
      : opts.wasm instanceof WebAssembly.Module ? null
      : new URL("shl_dicom_decode_jxl.wasm", new URL(opts.wasm, globalThis.location?.href));
    const module = opts.wasm instanceof WebAssembly.Module ? opts.wasm : await WebAssembly.compileStreaming(fetch(opts.wasm));
    const n = opts.workers ?? defaultWorkerCount();
    await Promise.all(
      Array.from({ length: n }, () => new Promise<void>((resolve, reject) => {
        const worker = new Worker(opts.workerUrl, { type: "module", name: "shl-dicom-decode" });
        const slot: Slot = { worker, job: null };
        worker.onmessage = (ev) => {
          if (ev.data?.type === "ready") {
            worker.onmessage = (e) => (e.data?.type === "need-jxl" ? pool.sendJxl(worker) : pool.onResult(slot, e.data));
            resolve();
          }
        };
        worker.onerror = (e) => reject(new Error(`decoder worker failed to start: ${e.message}`));
        worker.postMessage({ type: "init", module });
        pool.slots.push(slot);
      })),
    );
    return pool;
  }

  get size(): number {
    return this.slots.length;
  }

  get stats(): PoolStats {
    return { workers: this.slots.length, queued: this.queue.length, running: this.slots.filter((s) => s.job).length, completed: this.completed };
  }

  /** Decode one instance (or a frame range of it) on one worker. */
  decode(bytes: ArrayBuffer | Uint8Array, opts: DecodeOptions = {}): Promise<DecodedImage> {
    if (opts.key) {
      const existing = this.byKey.get(opts.key);
      if (existing && !existing.settled) {
        this.raise(existing, opts.priority ?? Priority.Visible);
        return existing.promise!;
      }
    }
    return this.submit("decode", bytes, opts);
  }

  /**
   * Verify and decrypt linked-file ciphertext on a worker; resolves with the plaintext window.
   * Keeps the main thread free of decryption (bulk downloads, whole-slide record reads).
   */
  decrypt(ciphertext: ArrayBuffer | Uint8Array, encrypted: EncryptedInput, opts: Pick<DecodeOptions, "priority" | "signal" | "copy"> = {}): Promise<Uint8Array> {
    return this.submit("decrypt", ciphertext, { ...opts, encrypted });
  }

  /** Frame count and whether frames can be decoded separately. Runs on a worker (copies `bytes`). */
  probe(bytes: ArrayBuffer | Uint8Array, opts: Pick<DecodeOptions, "priority" | "signal"> = {}): Promise<Probe> {
    return this.submit("probe", bytes, { ...opts, copy: true });
  }

  /**
   * Decode every frame of a multi-frame instance, splitting the frames across workers. Each job
   * gets its own copy of the file bytes (a worker cannot share them without SharedArrayBuffer).
   * Native (uncompressed) instances and single frames go to one worker: their decode is a copy.
   * Returns all frames in one buffer (one extra copy on the main thread to join the chunks).
   */
  async decodeFrames(bytes: ArrayBuffer | Uint8Array, opts: FramesOptions = {}): Promise<DecodedImage> {
    const t0 = performance.now();
    if (opts.encrypted) {
      // Decrypt on one worker first; the frame jobs then share out the plaintext.
      bytes = await this.decrypt(bytes, opts.encrypted, opts);
      opts = { ...opts, encrypted: undefined, copy: false };
    }
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const p = await this.probe(u8, opts);
    const per = opts.framesPerJob ?? Math.max(1, Math.ceil(p.frames / this.slots.length));
    if (!p.encapsulated || p.frames <= 1 || per >= p.frames) {
      const img = await this.decode(u8, { ...opts, copy: opts.copy });
      opts.onChunk?.(img);
      return img;
    }
    const jobs: Promise<DecodedImage>[] = [];
    for (let first = 0; first < p.frames; first += per) {
      const last = first + per >= p.frames;
      // Every job but the last gets a copy; the last takes the caller's buffer (unless opts.copy).
      const job = this.decode(u8, { priority: opts.priority, signal: opts.signal, copy: !last || opts.copy, first, count: Math.min(per, p.frames - first), scale: opts.scale });
      if (opts.onChunk) void job.then(opts.onChunk, () => {});
      jobs.push(job);
    }
    const chunks = await Promise.all(jobs);
    const head = chunks[0];
    const fb = head.frameBytes;
    const out = new Uint8Array(fb * p.frames);
    let decodeMs = 0;
    let lo = Infinity, hi = -Infinity;
    for (const c of chunks) {
      out.set(new Uint8Array(c.pixels), c.firstFrame * fb);
      decodeMs += c.decodeMs;
      if (c.minValue != null) lo = Math.min(lo, c.minValue);
      if (c.maxValue != null) hi = Math.max(hi, c.maxValue);
    }
    const perFrame = chunks.every((c) => c.perFrame) ? chunks.flatMap((c) => c.perFrame!) : null;
    return {
      ...head,
      frames: p.frames,
      firstFrame: 0,
      pixels: out.buffer,
      frameOffsets: Array.from({ length: p.frames }, (_, k) => k * fb),
      minValue: Number.isFinite(lo) ? lo : null,
      maxValue: Number.isFinite(hi) ? hi : null,
      perFrame,
      decodeMs,
      totalMs: performance.now() - t0,
    };
  }

  /** Stop all workers. Pending jobs reject with AbortError. */
  destroy(): void {
    for (const j of this.queue) this.settle(j, null, abortError());
    for (const s of this.slots) {
      if (s.job) this.settle(s.job, null, abortError());
      s.worker.terminate();
    }
    this.queue = [];
    this.slots = [];
  }

  // ---------------------------------------------------------------------------------------

  private submit(kind: Job["kind"], bytes: ArrayBuffer | Uint8Array, opts: DecodeOptions): Promise<any> {
    if (opts.signal?.aborted) return Promise.reject(abortError());
    let buf: ArrayBuffer;
    if (bytes instanceof Uint8Array) {
      const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer;
      buf = whole && !opts.copy ? (bytes.buffer as ArrayBuffer) : bytes.slice().buffer;
    } else {
      buf = opts.copy ? bytes.slice(0) : bytes;
    }
    const job = {
      id: this.nextId++,
      seq: this.nextId,
      priority: opts.priority ?? Priority.Visible,
      kind,
      bytes: buf,
      first: opts.first ?? 0,
      count: opts.count ?? 0,
      scale: opts.scale ?? 0,
      key: opts.key,
      encrypted: opts.encrypted,
      header: opts.header,
      t0: performance.now(),
      settled: false,
    } as Job;
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    if (opts.key) this.byKey.set(opts.key, job);
    opts.signal?.addEventListener("abort", () => this.abort(job), { once: true });
    this.enqueue(job);
    this.pump();
    return job.promise;
  }

  private enqueue(job: Job) {
    // Insert keeping (priority, seq) order. Queues are short; linear insert is fine.
    let i = this.queue.length;
    while (i > 0 && (this.queue[i - 1].priority > job.priority || (this.queue[i - 1].priority === job.priority && this.queue[i - 1].seq > job.seq))) i--;
    this.queue.splice(i, 0, job);
  }

  private raise(job: Job, priority: number) {
    if (priority >= job.priority) return;
    job.priority = priority;
    const i = this.queue.indexOf(job);
    if (i >= 0) {
      this.queue.splice(i, 1);
      this.enqueue(job);
    }
  }

  private abort(job: Job) {
    const i = this.queue.indexOf(job);
    if (i >= 0) this.queue.splice(i, 1);
    this.settle(job, null, abortError());
    this.emit();
  }

  private settle(job: Job, value: unknown, error?: unknown) {
    if (job.settled) return;
    job.settled = true;
    if (job.key && this.byKey.get(job.key) === job) this.byKey.delete(job.key);
    if (error !== undefined) job.reject(error);
    else job.resolve(value);
  }

  private pump() {
    for (const slot of this.slots) {
      if (slot.job) continue;
      const job = this.queue.shift();
      if (!job) break;
      slot.job = job;
      const { bytes } = job;
      job.bytes = new ArrayBuffer(0);
      slot.worker.postMessage({ type: job.kind, id: job.id, bytes, first: job.first, count: job.count, scale: job.scale, encrypted: job.encrypted, header: job.header }, [bytes]);
    }
    this.emit();
  }

  private onResult(slot: Slot, m: any) {
    const job = slot.job;
    slot.job = null;
    this.completed++;
    if (job && job.id === m.id && !job.settled) {
      if (!m.ok) this.settle(job, null, m.auth ? new RecordAuthenticationError(m.auth.record, m.auth.reason) : decodeError(m.code, m.message));
      else if (job.kind === "probe") this.settle(job, m.probe);
      else if (job.kind === "decrypt") this.settle(job, new Uint8Array(m.plaintext));
      else {
        const img = toImage(m.info, m.pixels, m.lut, m.ms, performance.now() - job.t0);
        if (m.header) img.header = new Uint8Array(m.header);
        this.settle(job, img);
      }
    }
    this.pump();
  }

  private emit() {
    this.onStats?.(this.stats);
  }
}

function toImage(info: ImageInfo & { palette: { first: number; count: number } | null }, pixels: ArrayBuffer, lut: ArrayBuffer | null, ms: number, totalMs: number): DecodedImage {
  const palette: PaletteLut | null = info.palette && lut ? { first: info.palette.first, rgba: new Uint8Array(lut) } : null;
  return {
    ...info,
    pixels,
    palette,
    frameOffsets: Array.from({ length: info.frames }, (_, k) => k * info.frameBytes),
    decodeMs: ms,
    totalMs,
  };
}
