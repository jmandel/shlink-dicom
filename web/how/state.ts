// Shared state for /how: the opened sample, the slice the page follows (one slice of the brain
// MRI), the requests this page made, the decoder pool, and small DOM helpers.
import { type OpenShare, type RequestEvent, type SeriesEntry, type SiteConfig, type StudyEntry } from "../core/index";
import type { DecoderPool } from "../core/images";

export interface Req extends RequestEvent {
  id: number;
  time: Date;
  recipient: string | null;
}

type Handler = (...a: any[]) => void;

export const S = {
  cfg: null as SiteConfig | null,
  shlink: "",
  sampleSid: "",
  share: null as OpenShare | null,
  pool: null as Promise<DecoderPool> | null,
  /** The compact JWE as fetched (for its header and size). */
  jwe: "",
  /** The slice the page follows. */
  study: null as StudyEntry | null,
  series: null as SeriesEntry | null,
  slice: 0,
  requests: [] as Req[],
  /** Tamper switch: flip one bit of the next response whose Range header matches. */
  tamper: { range: null as string | null, flipped: null as null | { byte: number; bit: number } },
  handlers: new Map<string, Set<Handler>>(),
};

export function onRequest(fn: (r: Req) => void) {
  if (!S.handlers.has("request")) S.handlers.set("request", new Set());
  S.handlers.get("request")!.add(fn);
}

let reqId = 0;
export function logRequest(e: RequestEvent) {
  let recipient: string | null = null;
  try {
    recipient = new URL(e.url).searchParams.get("recipient");
  } catch {}
  const r: Req = { ...e, id: ++reqId, time: new Date(), recipient };
  S.requests.push(r);
  for (const fn of S.handlers.get("request") ?? []) {
    try {
      fn(r);
    } catch (err) {
      console.warn(err);
    }
  }
}

/** Ciphertext bytes this page has received for pieces of `fileId` (or of any file). */
export const bytesFetched = (fileId?: string) =>
  S.requests.reduce((a, r) => a + (r.status < 300 && r.purpose === "file" && (!fileId || r.url.includes(`/${fileId}.bin`)) ? r.bytes : 0), 0);

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

/** One request as a log line: method, path, status; then range, bytes and recipient. */
export function reqRow(r: { method: string; url: string; range?: string; status: number; bytes: number; recipient?: string | null }, full = false) {
  const ok = r.status >= 200 && r.status < 300;
  let path = r.url;
  try {
    path = new URL(r.url).pathname;
  } catch {}
  if (!full) path = path.replace(/[A-Za-z0-9_-]{20,}/g, (m) => short(m, 6, 3));
  const x = [r.range ? `Range: ${r.range}` : null, `${n(r.bytes)} bytes`, r.recipient ? `recipient=${r.recipient}` : null].filter(Boolean).join(" · ");
  return h("div", { class: "req" }, h("span", { class: "m", text: r.method }), h("span", { class: "p", text: path }), h("span", { class: `s ${ok ? "ok" : "bad"}`, text: String(r.status) }), h("span", { class: "x", text: x }));
}

/** Copy and Open buttons for a link (you can't scan a QR code on your own screen). */
export function linkButtons(url: string, idPrefix: string): HTMLElement {
  const field = h("input", { class: "link-field hidden", type: "text", readonly: true, value: url, "aria-label": "The link" }) as HTMLInputElement;
  const copy = h("button", { class: "btn", type: "button", id: `${idPrefix}-copy`, text: "Copy link" });
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy link"), 2000);
    } catch {
      // No clipboard access: show the link selected, ready to copy by hand.
      field.classList.remove("hidden");
      field.focus();
      field.select();
      copy.textContent = "Selected: copy it";
    }
  });
  const open = h("a", { class: "btn", id: `${idPrefix}-open`, href: url, target: "_blank", rel: "noopener", text: "Open link" });
  return h("div", { class: "link-actions" }, h("div", { class: "row" }, copy, open), field);
}

/**
 * A code excerpt: lines matching any of `marks` are highlighted. `label` names it for screen
 * readers ("The decoded payload").
 */
export function excerpt(text: string, marks: RegExp[] = [], label = ""): HTMLElement {
  const pre = h("pre", { class: "code", tabindex: "0", ...(label ? { "aria-label": label } : {}) });
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const hit = marks.some((m) => m.test(line));
    pre.append(hit ? h("mark", { text: line }) : line, i < lines.length - 1 ? "\n" : "");
  });
  return pre;
}

/** Plain text in the "How exactly" layer. */
export const para = (...kids: (Node | string)[]) => h("p", {}, ...kids);
export const code = (t: string) => h("code", { text: t });
