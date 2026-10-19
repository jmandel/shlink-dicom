// The link reader: the Rust code the CLI and the server use (crates/shl-dicom-reader) for links,
// manifests, Bundle JWEs and study indexes, as a small wasm module. In a page it runs in a worker
// (reader-worker.ts), started as the page loads, so decrypting, inflating and indexing a Bundle
// stay off the page's thread; in Bun (checks, tests) it runs in place.
import { assetUrl } from "./config";
import type { FileEntry, ReportAttachment, SeriesEntry, StudyIndex } from "./bundle";
import type { ShlPayload } from "./shlink";
import { readerError, ReaderError, type Call, type ReaderModule, runCall } from "./reader-call";

export { ReaderError };

/** A checked link: its payload and what its flags say. */
export interface ParsedLink extends ShlPayload {
  direct: boolean;
  passcode: boolean;
  longLived: boolean;
  /** Whether `exp` had passed when it was read. */
  expired: boolean;
}

interface Backend {
  call(c: Call): Promise<any>;
}

/** The module in this thread (Bun, or a page without workers). */
class InPlace implements Backend {
  private m: Promise<ReaderModule>;
  constructor() {
    this.m = import("../../crates/shl-dicom-reader/pkg/shl_dicom_reader.js").then(async (m) => {
      const node = !!(globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node;
      const wasm = node ? new URL("../../crates/shl-dicom-reader/pkg/shl_dicom_reader_bg.wasm", import.meta.url) : assetUrl("shl_dicom_reader_bg.wasm");
      if (node) {
        // Bun/Node: the file itself. Browser workers also lack window, but fetch the asset.
        const fs = "node:fs";
        const { readFileSync } = await import(/* @vite-ignore */ fs);
        m.initSync({ module: readFileSync(wasm) });
      } else await m.default({ module_or_path: wasm });
      return m;
    });
  }
  async call(c: Call) {
    const m = await this.m;
    try {
      return runCall(m, c).value;
    } catch (e) {
      throw readerError(e);
    }
  }
}

/** The module in a worker (reader-worker.ts). */
class InWorker implements Backend {
  private w: Worker;
  private seq = 0;
  private pending = new Map<number, [(v: any) => void, (e: unknown) => void]>();
  constructor() {
    // The page may have started it already (web/view/index.html), with its module loading.
    const early = (globalThis as { __shlReader?: Worker }).__shlReader;
    this.w = early ?? new Worker(assetUrl("reader-worker.js"), { type: "module" });
    this.w.onmessage = (ev) => {
      const { id, value, error } = ev.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (error) p[1](new ReaderError(error.code, error.message));
      else p[0](value);
    };
    this.w.onerror = (ev) => {
      for (const [, f] of this.pending.values()) f(new ReaderError("internal", ev.message || "the link reader failed to start"));
      this.pending.clear();
    };
    if (!early) this.w.postMessage({ init: assetUrl("shl_dicom_reader_bg.wasm") });
  }
  call(c: Call) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, [resolve, reject]);
      this.w.postMessage({ id, ...c });
    });
  }
}

let backend: Backend | null = null;

/** Starts the reader (its worker and module) now, so it is ready when a link is opened. */
export function startReader(): void {
  backend ??= typeof window !== "undefined" && typeof Worker !== "undefined" ? new InWorker() : new InPlace();
}

function use(): Backend {
  startReader();
  return backend!;
}

/** The checked link in `text` (a bare `shlink:/…`, a viewer URL, or text around one). */
export async function parseLink(text: string, nowMs = Date.now()): Promise<ParsedLink> {
  const j = JSON.parse(await use().call({ fn: "parse_link", args: [text, nowMs / 1000] }));
  const p: ParsedLink = { url: j.url, key: j.key, direct: j.direct, passcode: j.passcode, longLived: j.longLived, expired: j.expired };
  if (j.exp !== null) p.exp = j.exp;
  if (j.flag !== null) p.flag = j.flag;
  if (j.label !== null) p.label = j.label;
  if (j.v !== null) p.v = j.v;
  return p;
}

/** The Bundle's location in a manifest response. */
export function manifestLocation(manifestJson: string): Promise<string> {
  return use().call({ fn: "manifest_location", args: [manifestJson] });
}

/** A Bundle's bytes from its compact JWE and the link's key. */
export function decryptBundle(jwe: string, key: string): Promise<Uint8Array> {
  return use().call({ fn: "decrypt_bundle", args: [jwe, key] });
}

/** A link's Bundle, decrypted and indexed in one call (in the worker). */
export async function openBundle(jwe: string, key: string): Promise<{ index: StudyIndex; bundle: Uint8Array }> {
  const { index, bundle } = await use().call({ fn: "open_bundle", args: [jwe, key] });
  return { index: studyIndex(index, bundle), bundle };
}

/** The study index of a decrypted Bundle (bytes, or the Bundle itself). */
export async function parseIndex(bundle: Uint8Array | object): Promise<StudyIndex> {
  const bytes = bundle instanceof Uint8Array ? bundle : new TextEncoder().encode(JSON.stringify(bundle));
  const index = await use().call({ fn: "parse_index", args: [bytes] });
  return studyIndex(index, bytes, bundle instanceof Uint8Array ? undefined : bundle);
}

/**
 * The report-to-study rule (shl_dicom_core::report_links) run again: for each report, its
 * `{studyId, basis}` links. `input` is `{studies, reports}` as crates/shl-dicom-reader/README.md
 * describes.
 */
export async function relinkReports(input: object): Promise<StudyIndex["reports"][number]["links"][]> {
  return JSON.parse(await use().call({ fn: "link_reports", args: [JSON.stringify(input)] }));
}

/** Whether frames of transfer syntax `ts` are found by codestream start markers (else one fragment is one frame). */
export function hasFrameStartMarker(ts: string): Promise<boolean> {
  return use().call({ fn: "has_frame_start_marker", args: [ts] });
}

/**
 * For each fragment head (its first 8 bytes, or all of it when shorter), whether it starts a frame:
 * the rule the packer's offset tables and the decoder use (shl_dicom_decode::syntax).
 */
export function areFrameStarts(ts: string, heads: Uint8Array[]): Promise<boolean[]> {
  return use().call({ fn: "is_frame_start", args: [ts, heads] });
}

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * The reader's index JSON in the viewer's shape: each series' `file` is its study's file object
 * (the same object, so series of one file share it), attachments' data as bytes, and the Bundle.
 */
function studyIndex(json: string, bytes: Uint8Array, bundle?: object): StudyIndex {
  const ix = JSON.parse(json);
  for (const st of ix.studies) {
    const files = new Map<string, FileEntry>(st.files.map((f: FileEntry) => [f.fileId, f]));
    st.series = st.series.map(({ fileId, ...se }: SeriesEntry & { fileId: string }) => ({ ...se, file: files.get(fileId)! }));
  }
  for (const r of ix.reports) {
    r.attachments = r.attachments.map(({ dataB64, ...a }: ReportAttachment & { dataB64: string | null }) => ({ ...a, data: dataB64 ? fromB64(dataB64) : null }));
  }
  ix.bundle = bundle ?? JSON.parse(new TextDecoder().decode(bytes));
  return ix as StudyIndex;
}
