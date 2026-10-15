// Shared state for the How it works widgets: the opened sample share, the request log, the
// current series/instance selection, decrypted instances, and a few DOM helpers.
import type { OpenShare, RequestEvent, SeriesEntry, SiteConfig, StudyEntry } from "../core/index";

export interface Req extends RequestEvent {
  id: number;
  /** performance.now() when the answer arrived. */
  at: number;
  /** Wall-clock time. */
  time: Date;
  recipient: string | null;
}

export interface Selection {
  study: number;
  series: number;
  instance: number;
}

type Handler = (...a: any[]) => void;

export const S = {
  cfg: null as SiteConfig | null,
  /** Bare shlink:/… of the public sample. */
  shlink: "",
  /** Server share id of the sample (for /api/shares/{sid}/clone). */
  sampleSid: "",
  share: null as OpenShare | null,
  requests: [] as Req[],
  sel: { study: 0, series: 0, instance: 0 } as Selection,
  /** Decrypted instances by `${fileId}/${i}` (from step 3), for step 5's pixels. */
  plain: new Map<string, Uint8Array>(),
  /** Tamper switch for step 4: flips one bit of the next response for this Range header. */
  tamper: { range: null as string | null, flipped: null as null | { byte: number; bit: number; before: number; after: number } },
  handlers: new Map<string, Set<Handler>>(),
};

export type Ev = "request" | "select" | "ready" | "plain";
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
  const r: Req = { ...e, id: ++reqId, at: performance.now(), time: new Date(), recipient };
  S.requests.push(r);
  emit("request", r);
}

/** Keeps every whole instance inside decrypted plaintext [start, start + pt.length) of a series. */
export function storePlain(series: SeriesEntry, start: number, pt: Uint8Array) {
  const end = start + pt.length;
  let added = false;
  series.instances.forEach((x, i) => {
    const key = `${series.fileId}/${i}`;
    if (x.offset >= start && x.offset + x.length <= end && !S.plain.has(key)) {
      S.plain.set(key, pt.slice(x.offset - start, x.offset - start + x.length));
      added = true;
    }
  });
  if (added) emit("plain", series.fileId);
}

export function currentSeries(): { study: StudyEntry; series: SeriesEntry } {
  const study = S.share!.index.studies[S.sel.study];
  return { study, series: study.series[S.sel.series] };
}

export function select(sel: Partial<Selection>, source = "") {
  Object.assign(S.sel, sel);
  emit("select", S.sel, source);
}

/** Finds a series by file id. */
export function seriesByFile(fileId: string): { study: number; series: number; entry: SeriesEntry } | null {
  const studies = S.share?.index.studies ?? [];
  for (let a = 0; a < studies.length; a++) {
    const b = studies[a].series.findIndex((s) => s.fileId === fileId);
    if (b >= 0) return { study: a, series: b, entry: studies[a].series[b] };
  }
  return null;
}

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

export function facts(dl: HTMLElement, rows: [string, Node | string, string?][]) {
  dl.replaceChildren();
  for (const [k, v, cls] of rows) {
    dl.append(h("dt", { text: k }));
    const dd = h("dd", { class: cls ?? "" });
    dd.append(v);
    dl.append(dd);
  }
}

export const n = (x: number) => x.toLocaleString("en-US");
export const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export const short = (s: string, a = 6, b = 4) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);

/** The path of a URL, with long ids shortened, for compact request rows. */
export function shortPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/[A-Za-z0-9_-]{20,}/g, (m) => short(m, 6, 3));
  } catch {
    return url;
  }
}

/** A request row: method, path, status; then range, bytes, time and recipient. */
export function reqRow(r: { method: string; url: string; range?: string; status: number; bytes: number; ms?: number; recipient?: string | null }, tag: "div" | "button" = "div", fullPath = false) {
  const path = fullPath ? new URL(r.url).pathname : shortPath(r.url);
  const details = [r.range ? `Range: ${r.range}` : null, `${n(r.bytes)} bytes`, r.ms !== undefined ? `${Math.round(r.ms)} ms` : null, r.recipient ? `recipient=${r.recipient}` : null]
    .filter(Boolean)
    .join(" · ");
  const ok = r.status >= 200 && r.status < 300;
  return h(
    tag as any,
    { class: "req new", ...(tag === "button" ? { type: "button" } : {}) },
    h("span", { class: "m", text: r.method }),
    h("span", { class: "p", text: path }),
    h("span", { class: `s ${ok ? "ok" : "bad"}`, text: String(r.status) }),
    h("span", { class: "d", text: details }),
  );
}
