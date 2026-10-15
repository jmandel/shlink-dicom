// Shared state for the tour: the opened sample, the thread (one slice of the brain MRI), the
// requests this page made, the decoder pool, and small DOM helpers.
import { RECORD_CIPHERTEXT, RECORD_PLAINTEXT, TAG, type OpenShare, type RequestEvent, type SeriesEntry, type SiteConfig, type StudyEntry } from "../core/index";
import type { DecoderPool } from "../core/images";

export interface Req extends RequestEvent {
  id: number;
  time: Date;
  recipient: string | null;
}

/**
 * The file a series reads from. Today each series has its own file; with study-level files
 * (docs/STUDY-FILES-AND-S3-PLAN.md) series share one, under `series.file`. Everything the tour
 * says about "the file" comes through here.
 */
export interface FileFacts {
  fileId: string;
  plaintextLength: number;
  ciphertextLength: number;
  recordCount: number;
}
export function fileOf(series: SeriesEntry): FileFacts {
  const f = (series as any).file ?? series;
  return { fileId: f.fileId, plaintextLength: f.plaintextLength, ciphertextLength: f.ciphertextLength, recordCount: f.recordCount };
}
/** Ciphertext length of record i of a file. */
export function recordLength(f: FileFacts, i: number): number {
  return i < f.recordCount - 1 ? RECORD_CIPHERTEXT : f.plaintextLength - i * RECORD_PLAINTEXT + TAG;
}

type Handler = (...a: any[]) => void;
export type Ev = "ready" | "request" | "details" | "step";

export const S = {
  cfg: null as SiteConfig | null,
  shlink: "",
  sampleSid: "",
  share: null as OpenShare | null,
  pool: null as Promise<DecoderPool> | null,
  /** The compact JWE as fetched (for its header and size). */
  jwe: "",
  /** The thread: one slice of the brain MRI. */
  study: null as StudyEntry | null,
  series: null as SeriesEntry | null,
  slice: 0,
  requests: [] as Req[],
  details: false,
  /** Tamper switch: flip one bit of the next response whose Range header matches. */
  tamper: { range: null as string | null, flipped: null as null | { byte: number; bit: number } },
  handlers: new Map<string, Set<Handler>>(),
};

export function on(ev: Ev, fn: Handler) {
  if (!S.handlers.has(ev)) S.handlers.set(ev, new Set());
  S.handlers.get(ev)!.add(fn);
}
export function emit(ev: Ev, ...a: any[]) {
  for (const fn of S.handlers.get(ev) ?? []) {
    try {
      fn(...a);
    } catch (e) {
      console.warn(e);
    }
  }
}

let reqId = 0;
export function logRequest(e: RequestEvent) {
  let recipient: string | null = null;
  try {
    recipient = new URL(e.url).searchParams.get("recipient");
  } catch {}
  const r: Req = { ...e, id: ++reqId, time: new Date(), recipient };
  S.requests.push(r);
  emit("request", r);
}

/** Ciphertext bytes this page has received from the host. */
export const bytesFetched = () => S.requests.reduce((a, r) => a + (r.status < 300 ? r.bytes : 0), 0);

// DOM helpers
export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, any> = {},
  ...kids: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

export const n = (x: number) => x.toLocaleString("en-US");
export const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export const short = (s: string, a = 6, b = 4) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);
export function mb(x: number): string {
  if (x >= 1e9) return `${(x / 1e9).toFixed(2)} GB`;
  if (x >= 1e6) return `${(x / 1e6).toFixed(1)} MB`;
  if (x >= 1e3) return `${Math.round(x / 1e3)} KB`;
  return `${x} bytes`;
}
export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
export const wait = (ms: number) => new Promise((r) => setTimeout(r, reducedMotion() ? 0 : ms));

/** A determinate progress bar: role=progressbar with value, maximum and "a of b" text. */
export function progressBar(label: string) {
  const fill = h("i");
  const el = h("div", { class: "pbar", role: "progressbar", "aria-label": label, "aria-valuemin": "0" }, fill);
  const text = h("span", { class: "pbar-text small muted" });
  return {
    el: h("div", { class: "pbar-wrap" }, el, text),
    set(now: number, max: number, unit = "") {
      el.setAttribute("aria-valuenow", String(now));
      el.setAttribute("aria-valuemax", String(max));
      const words = `${n(now)}${unit} of ${n(max)}${unit}`;
      el.setAttribute("aria-valuetext", words);
      text.textContent = `${label}: ${words}`;
      fill.style.width = `${(100 * now) / max}%`;
    },
  };
}

/** Request path with long random ids shortened. */
export function shortPath(url: string): string {
  try {
    return new URL(url).pathname.replace(/[A-Za-z0-9_-]{20,}/g, (m) => short(m, 6, 3));
  } catch {
    return url;
  }
}
