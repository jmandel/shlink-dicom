// Encrypt-and-upload, streamed: each study's file is read, encrypted and sent in chunks of
// CHUNK_RECORDS records, with at most two chunks in memory. The server keeps what it has received,
// even from an interrupted request (lib/api.ts uploadOffset), so an upload continues where it
// stopped: after a network failure, and after the page is reloaded (see saveJob).
import { RECORD_CIPHERTEXT, RECORD_PLAINTEXT } from "../../core/range";
import { ApiError, type ShareApi } from "./api";
import { LinkError } from "../../core/resolver";
import { CHUNK_RECORDS, ciphertextSize, encryptRecords, fileKey, type PackedFile } from "./pack";
import { ConcatBytes } from "./bytes";
import { b64urlEncode } from "../../core/b64";
import { randomKeyB64 } from "../../core/jwe";

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

/**
 * Makes the share and, with a passcode, its link, then runs `start`, which saves the upload job.
 * The link is made with no files: the server lists only files it holds, and the files are added
 * once uploaded. If anything fails before `start` returns, the share is deleted, so no share is
 * left that no saved job can continue.
 */
export async function startShare<T>(
  root: Pick<ShareApi, "createShare">,
  connect: (sid: string, token: string) => ShareApi,
  o: { expiresAt: number; passcode: string; link: { label: string | null; exp: number | null; longLived: boolean } },
  onConn: (c: Connection) => void,
  start: (api: ShareApi, sid: string, token: string) => Promise<T>,
): Promise<T> {
  const created = await persist(() => root.createShare(o.expiresAt), onConn);
  const api = connect(created.share.id, created.controlToken);
  try {
    if (o.passcode) await persist(() => api.createLink({ ...o.link, passcode: o.passcode, allowedFiles: [] }), onConn);
    return await start(api, created.share.id, created.controlToken);
  } catch (e) {
    await api.deleteShare().catch(() => {});
    throw e;
  }
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

/** Records per entry of the record of what was sent (8 MiB of plaintext). */
export const SENT_GROUP = 128;

/**
 * What may have left the browser, per file id: for each group of SENT_GROUP records from the
 * start, how many of its records were hashed (`n`) and the SHA-256 of their plaintext (`h`). An
 * entry is saved before any of its records are sent.
 */
export type SentHashes = Record<string, { n: number; h: string }[]>;

/**
 * Keeps the saved job's record of what was sent, so that continuing never encrypts different
 * plaintext under a key and record number whose ciphertext may have left the browser (AES-GCM
 * with a reused nonce gives away both plaintexts). `save` saves the job (or, when it cannot, drops
 * it, so that nothing continues from a record that is out of date).
 */
export class SentLedger {
  constructor(
    readonly hashes: SentHashes,
    private save: () => boolean,
  ) {}

  private async hash(p: PackedFile, a: number, b: number): Promise<string> {
    const plain = await new ConcatBytes(p.instances.map((i) => i.src)).read(a * RECORD_PLAINTEXT, Math.min(p.plaintextLength, b * RECORD_PLAINTEXT));
    return b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", plain)));
  }

  /** Records the plaintext of records [0, end) before any of them are sent; `avail` records are readable. */
  async cover(p: PackedFile, end: number, avail: number) {
    const groups = (this.hashes[p.fileId] ??= []);
    let changed = false;
    for (let g = 0; g * SENT_GROUP < end; g++) {
      const a = g * SENT_GROUP;
      const want = Math.min(SENT_GROUP, end - a);
      if ((groups[g]?.n ?? 0) >= want) continue;
      // The whole group when it can be read, so that it is hashed once.
      const n = Math.max(want, Math.min(SENT_GROUP, avail - a));
      groups[g] = { n, h: await this.hash(p, a, a + n) };
      changed = true;
    }
    if (changed) this.save();
  }

  /**
   * Whether everything recorded as possibly sent for `p` is the plaintext it has now, and covers
   * `offset` ciphertext bytes the server reports (records beyond what was recorded can't be checked).
   */
  async check(p: PackedFile, offset: number): Promise<boolean> {
    const groups = this.hashes[p.fileId] ?? [];
    let covered = 0;
    for (const [g, e] of groups.entries()) {
      if (!e || covered !== g * SENT_GROUP) return false;
      if (g * SENT_GROUP + e.n > p.records) return false;
      if ((await this.hash(p, g * SENT_GROUP, g * SENT_GROUP + e.n)) !== e.h) return false;
      covered += e.n;
      if (e.n < SENT_GROUP) break;
    }
    return Math.ceil(offset / RECORD_CIPHERTEXT) <= covered;
  }

  /** `p` starts again under a new id and key. */
  forget(fileId: string) {
    delete this.hashes[fileId];
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
  o: {
    fresh?: boolean;
    signal?: AbortSignal;
    /** The saved job's record of what was sent; without one, a file the server has part of starts again. */
    ledger?: SentLedger;
    /**
     * A file starts again under a new id and key (its plaintext differs from what was sent, or that
     * can't be checked): the caller saves where the new id and key are kept before anything is sent.
     */
    rekeyed?: (p: UploadFile, oldId: string) => Promise<void>;
  } = {},
) {
  const signal = o.signal;
  const ledger = o.ledger ?? new SentLedger({}, () => true);
  const total = () => packed.reduce((a, p) => a + ciphertextSize(p), 0);
  const offsets = new Map<string, number>();
  for (const p of packed) {
    // A new share has no uploads yet; otherwise ask the server what it has.
    const st = o.fresh ? null : await persist(() => api.uploadOffset(p.fileId), onConn, signal);
    let off = st ? (st.complete ? ciphertextSize(p) : st.offset) : -1;
    // Continuing: only if what may have been sent is this plaintext, at this length.
    const sizeOk = !st || st.length === null || !known(p) || st.length === ciphertextSize(p);
    if (st && !(sizeOk && (await ledger.check(p, st.complete ? ciphertextSize(p) : st.offset)))) {
      const oldId = p.fileId;
      ledger.forget(oldId);
      p.fileId = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
      p.key = randomKeyB64();
      await o.rekeyed?.(p, oldId);
      await persist(() => api.deleteFile(oldId), onConn, signal).catch(() => {});
      off = -1;
    }
    offsets.set(p.fileId, off);
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
      // Recorded before any of these records leave the browser.
      await ledger.cover(p, rec + n, known(p) ? p.records : Math.floor((p.growing!.ready - 1) / RECORD_PLAINTEXT));
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
  /** Where the patient came from: a FHIR source's Patient is in the stored owner Bundle (applyChoices). */
  patientSource?: "dicom" | "fhir";
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
  /**
   * Whether the link has a passcode. The passcode itself is never saved: with one, the link is
   * made (with the passcode) as soon as the share is, so continuing after a reload never needs it.
   */
  hasPasscode: boolean;
  exp: number | null;
  /** When the share itself expires (its exp, or the server's longest): the saved job goes then too. */
  expiresAt: number;
  longLived: boolean;
  /** The studies' names, for the "did not finish" notice. */
  title: string;
  /** What may have been sent of each file (SentLedger). */
  sent?: SentHashes;
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

/** The saved job, unless there is none or its share has expired (then it is cleared). */
export function loadJob(now = Math.floor(Date.now() / 1000)): UploadJob | null {
  try {
    const j = JSON.parse(localStorage.getItem(JOB) ?? "null");
    if (!(j?.sid && j?.token && j?.ownerKey)) return null;
    if (!(typeof j.expiresAt === "number" && j.expiresAt > now)) {
      clearJob();
      return null;
    }
    return j;
  } catch {
    return null;
  }
}

export function clearJob() {
  try {
    localStorage.removeItem(JOB);
  } catch {}
}
