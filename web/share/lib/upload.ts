// Encrypt-and-upload, streamed: each study's file is read, encrypted and sent in chunks of
// CHUNK_RECORDS records, with at most two chunks in memory. The server keeps what it has received,
// even from an interrupted request (lib/api.ts uploadOffset), so an upload continues where it
// stopped: after a network failure, and after the page is reloaded (see saveJob).
import { RECORD_CIPHERTEXT, RECORD_PLAINTEXT } from "../../core/range";
import { ApiError, type ShareApi } from "./api";
import { LinkError } from "../../core/resolver";
import { CHUNK_RECORDS, ciphertextSize, encryptRecords, fileKey, type PackedFile } from "./pack";

export type Connection =
  | { state: "ok" }
  /** A request failed; the next try is in `inMs`. */
  | { state: "retrying"; inMs: number; reason: string }
  /** The browser reports no network; waiting for it to come back. */
  | { state: "offline" };

export interface UploadProgress {
  /** Ciphertext bytes the server has, over all files. */
  sent: number;
  total: number;
  /** Files complete on the server. */
  filesDone: number;
  /** Ciphertext bytes the server has of each file, by file id (-1: no upload yet). */
  offsets: ReadonlyMap<string, number>;
  /** The append under way: its file and how far its bytes have gone. */
  sending?: { fileId: string; offset: number };
  /** File just finished, for the log. */
  finished?: PackedFile;
}

/** Failures worth waiting out: no connection, a stall, a proxy or server error, a busy server. */
export function isTransient(e: unknown): boolean {
  // 409 without an offset: another request for the same file is still finishing on the server.
  if (e instanceof ApiError) return e.status === 0 || e.status === 408 || e.status === 409 || e.status === 425 || e.status === 429 || e.status >= 500;
  if (e instanceof LinkError) return e.reason === "network" || e.reason === "server";
  const name = (e as Error)?.name;
  return name === "TimeoutError" || name === "AbortError" || e instanceof TypeError;
}

/**
 * Waits before the next try: backoff up to 30 s, cut short when the browser comes back online;
 * while it reports being offline, waits for that without a time limit.
 */
function waitToRetry(attempt: number, reason: string, onConn: (c: Connection) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    const inMs = offline ? 0 : Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)) * (0.75 + Math.random() / 2);
    onConn(offline ? { state: "offline" } : { state: "retrying", inMs, reason });
    let timer = 0;
    const done = () => {
      clearTimeout(timer);
      globalThis.removeEventListener?.("online", done);
      signal?.removeEventListener("abort", stop);
      resolve();
    };
    const stop = () => {
      clearTimeout(timer);
      globalThis.removeEventListener?.("online", done);
      reject(signal!.reason ?? new DOMException("aborted", "AbortError"));
    };
    globalThis.addEventListener?.("online", done);
    signal?.addEventListener("abort", stop);
    // Offline: check again every 10 s as well, in case no "online" event comes.
    timer = setTimeout(done, offline ? 10000 : inMs) as unknown as number;
  });
}

/** Runs `fn` until it succeeds, waiting out transient failures without limit; others are thrown. */
export async function persist<T>(fn: () => Promise<T>, onConn: (c: Connection) => void, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fn();
      if (attempt) onConn({ state: "ok" });
      return r;
    } catch (e) {
      if (signal?.aborted || !isTransient(e)) throw e;
      await waitToRetry(attempt, (e as Error).message, onConn, signal);
    }
  }
}

/** Records per append; halved if a proxy refuses a body as too large (413 that isn't a quota). */
let chunkRecords = CHUNK_RECORDS;
const MIN_CHUNK_RECORDS = 4;
/** The least a growing file's append carries: 1 MiB (an append costs a round trip). */
const MIN_GROWING_RECORDS = 16;

/**
 * A file whose instances are still being compressed: its plaintext grows from the front, instance
 * by instance in file order, and its length is known once the last one is in. Until then the file's
 * PackedFile has `plaintextLength` and `records` of what is ready.
 */
export class Growing {
  /** Plaintext bytes ready, from the start of the file. */
  ready = 0;
  done = false;
  /** Why the rest will never come (compression failed). */
  error: unknown = null;
  private waiters: [() => void, (e: unknown) => void][] = [];
  /** More plaintext is ready (or, with `done`, all of it). */
  grow(ready: number, done = false) {
    this.ready = ready;
    this.done ||= done;
    for (const [w] of this.waiters.splice(0)) w();
  }
  fail(e: unknown) {
    this.error = e;
    for (const [, f] of this.waiters.splice(0)) f(e);
  }
  changed(): Promise<void> {
    if (this.error) return Promise.reject(this.error);
    return new Promise((r, f) => this.waiters.push([r, f]));
  }
}

export type UploadFile = PackedFile & { growing?: Growing };

/** Whether the file's length is known: it was planned whole, or its last instance is in. */
const known = (p: UploadFile) => !p.growing || p.growing.done;

/**
 * Uploads every file, each from where the server has it. Any failure that might pass (offline,
 * dropped connection, stall, 5xx) is waited out and retried without limit; each retry first asks
 * the server how far it got (HEAD, Upload-Offset).
 *
 * A growing file is uploaded as its plaintext arrives, without a length at first; the last append
 * gives the length (draft-ietf-httpbis-resumable-upload). Only whole records go before then, and
 * always with more plaintext ready after them, so the last append is never empty.
 */
export async function uploadFiles(
  api: ShareApi,
  packed: UploadFile[],
  on: (p: UploadProgress) => void,
  onConn: (c: Connection) => void,
  o: { fresh?: boolean; signal?: AbortSignal } = {},
) {
  const signal = o.signal;
  const total = () => packed.reduce((a, p) => a + ciphertextSize(p), 0);
  const offsets = new Map<string, number>();
  for (const p of packed) {
    // A new share has no uploads yet; otherwise ask the server what it has.
    const st = o.fresh ? null : await persist(() => api.uploadOffset(p.fileId), onConn, signal);
    offsets.set(p.fileId, st ? (st.complete ? ciphertextSize(p) : st.offset) : -1);
  }
  const sentBefore = (p: PackedFile) => packed.reduce((a, q) => a + (q === p ? 0 : Math.max(0, offsets.get(q.fileId)!)), 0);
  let filesDone = packed.filter((p) => known(p) && offsets.get(p.fileId) === ciphertextSize(p)).length;
  const report = (sent: number, finished?: PackedFile, sending?: UploadProgress["sending"]) => on({ sent, total: total(), filesDone, offsets, finished, sending });
  report([...offsets.values()].reduce((a, n) => a + Math.max(0, n), 0));
  for (const p of packed) {
    let off = offsets.get(p.fileId)!;
    if (known(p) && off === ciphertextSize(p)) continue;
    if (off < 0) {
      await persist(() => api.createUpload(p.fileId, known(p) ? ciphertextSize(p) : null), onConn, signal);
      off = 0;
    }
    const base = sentBefore(p);
    const key = await fileKey(p);
    /**
     * Records [rec, rec + n) can go now: the file is whole, or more plaintext is ready after them.
     * While it grows, an append takes what is ready (at least MIN_GROWING_RECORDS), so the link
     * isn't left idle waiting for a whole chunk.
     */
    const sendable = (rec: number) => {
      if (known(p)) return Math.min(p.records - rec, chunkRecords);
      const n = Math.min(chunkRecords, Math.floor((p.growing!.ready - 1) / RECORD_PLAINTEXT) - rec);
      return n >= Math.min(chunkRecords, MIN_GROWING_RECORDS) ? n : 0;
    };
    // The next chunk is encrypted while the current one uploads.
    let ahead: { rec: number; n: number; ct: Promise<Uint8Array> } | null = null;
    const chunk = (rec: number, n: number) => {
      if (ahead && ahead.rec === rec && ahead.n === n) return ahead.ct;
      ahead?.ct.catch(() => {});
      return persist(() => encryptRecords(p, key, rec, rec + n), onConn, signal);
    };
    let attempt = 0;
    while (!known(p) || off < ciphertextSize(p)) {
      signal?.throwIfAborted();
      const rec = Math.floor(off / RECORD_CIPHERTEXT);
      const n = sendable(rec);
      if (!n) {
        await p.growing!.changed();
        continue;
      }
      const ct = await chunk(rec, n);
      const next = rec + n;
      // A growing file's part-chunk is not encrypted ahead: more may be ready by the time it goes.
      const m = sendable(next);
      ahead = m && (known(p) || m === chunkRecords) ? { rec: next, n: m, ct: chunk(next, m) } : null;
      ahead?.ct.catch(() => {});
      const body = ct.subarray(off - rec * RECORD_CIPHERTEXT);
      const from = off;
      // Known now; the server learns the length with this append if it had none.
      const size = known(p) ? ciphertextSize(p) : null;
      try {
        const r = await api.appendUpload(p.fileId, from, body, from + body.length === size, (loaded) => report(base + from + loaded, undefined, { fileId: p.fileId, offset: from + loaded }), size);
        off = r.offset;
        if (attempt) onConn({ state: "ok" });
        attempt = 0;
        offsets.set(p.fileId, off);
      } catch (e) {
        const err = e as ApiError & { offset?: number };
        if (err.status === 413 && !/QUOTA/.test(err.message) && chunkRecords > MIN_CHUNK_RECORDS) {
          chunkRecords = Math.max(MIN_CHUNK_RECORDS, chunkRecords >> 1);
          ahead = null;
          continue;
        }
        if (err.status === 409 && typeof err.offset === "number") {
          off = err.offset;
          continue;
        }
        if (signal?.aborted || !isTransient(e)) throw e;
        await waitToRetry(attempt++, err.message, onConn, signal);
        // Ask where the server got to before sending more.
        const st = await persist(() => api.uploadOffset(p.fileId), onConn, signal);
        if (!st) {
          await persist(() => api.createUpload(p.fileId, known(p) ? ciphertextSize(p) : null), onConn, signal);
          off = 0;
        } else off = st.complete ? ciphertextSize(p) : st.offset;
        onConn({ state: "ok" });
      }
    }
    offsets.set(p.fileId, ciphertextSize(p));
    filesDone++;
    report(base + ciphertextSize(p), p);
  }
}

// ------------------------------------------------------------------------- the saved job

/** What this browser keeps about an upload until the link exists. */
export interface UploadJob {
  apiBase: string;
  sid: string;
  token: string;
  ownerKey: string;
  source: { kind: "files" | "portal" | "link" | "sample"; link?: string; stage?: string; files?: { name: string; size: number; id?: string }[] };
  addOffsetTables: boolean;
  /** The sharer said files naming different people are one person's (lib/ingest.ts sharePatient). */
  samePatient?: boolean;
  /**
   * Uncompressed images re-encoded without loss before packing (lib/compress.ts): the encoding, the
   * staging session holding the re-encoded files, and each one's staged file and SHA-256.
   */
  compress: {
    mode: import("./compress").Encoding;
    stage?: string;
    records: Record<string, import("./compress").Reencoded>;
    /** SOP Instance UIDs of images handled but kept as they were (so far, while streaming). */
    kept?: string[];
  } | null;
  /**
   * Set when the files were uploaded while their images were being compressed: each file's id, key
   * and instances (SOP Instance UIDs, in file order). The owner Bundle is stored only once the
   * files are, so this is what a reload continues from until then.
   */
  plan?: { fileId: string; key: string; uids: string[] }[];
  recipient: string | null;
  passcode: string;
  exp: number | null;
  longLived: boolean;
  /** The studies' names, for the "did not finish" notice. */
  title: string;
  startedAt: number;
}

const JOB = "shl-dicom-upload-job";

export function saveJob(j: UploadJob): boolean {
  try {
    localStorage.setItem(JOB, JSON.stringify(j));
    return true;
  } catch {
    return false;
  }
}

export function loadJob(): UploadJob | null {
  try {
    const j = JSON.parse(localStorage.getItem(JOB) ?? "null");
    return j?.sid && j?.token && j?.ownerKey ? j : null;
  } catch {
    return null;
  }
}

export function clearJob() {
  try {
    localStorage.removeItem(JOB);
  } catch {}
}
