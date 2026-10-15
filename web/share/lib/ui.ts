// Small DOM helpers shared by the Share and Manage pages.
import qrcode from "qrcode-generator";

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Child = Node | string | null | undefined | false;
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, any> | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (k in e && typeof v !== "string") (e as any)[k] = v;
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

/** QR code as SVG, error correction level M (as the SHL specification recommends). */
export function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h("textarea", { style: "position:fixed;top:-1000px;opacity:0" }, text);
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {}
    ta.remove();
    return ok;
  }
}

/** Briefly changes a button's text ("Copied"). */
export function flash(btn: HTMLElement, text: string, ms = 1600) {
  const old = btn.dataset.label ?? btn.textContent ?? "";
  btn.dataset.label = old;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), ms);
}

const rtf = typeof Intl !== "undefined" && "RelativeTimeFormat" in Intl ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }) : null;

/** "today 3:12 pm", "yesterday 3:12 pm", "12 Oct, 3:12 pm". */
export function when(unix: number): string {
  const d = new Date(unix * 1000);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return `today ${time}`;
  if (diff === 1) return `yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) })}, ${time}`;
}

/** "22 Oct" or "22 Oct 2027". */
export function dateOnly(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
}

/** "in 6 days", "in 3 hours". */
export function fromNow(unix: number): string {
  const s = unix - Date.now() / 1000;
  if (!rtf) return dateOnly(unix);
  if (Math.abs(s) < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (Math.abs(s) < 86400 * 2) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}

export const EXPIRY_PRESETS = [
  { id: "1d", label: "1 day", secs: 86400 },
  { id: "1w", label: "1 week", secs: 7 * 86400 },
  { id: "1m", label: "1 month", secs: 30 * 86400 },
  { id: "none", label: "Until I revoke it", secs: null },
] as const;

/** The longest a share is kept on this server (MAX_SHARE_TTL_SECS in the server). */
export const SERVER_MAX_DAYS = 31;

export function expiryFieldset(name: string, selected = "1w"): HTMLFieldSetElement {
  const hint = h("p", { class: "hint", id: `${name}-hint` });
  const update = () => {
    const v = (fs.querySelector(`input[name=${name}]:checked`) as HTMLInputElement)?.value;
    const p = EXPIRY_PRESETS.find((x) => x.id === v)!;
    hint.textContent = p.secs
      ? `Works until ${dateOnly(Date.now() / 1000 + p.secs)}.`
      : `This demo server deletes shares after ${SERVER_MAX_DAYS} days, so the link stops working then if you haven't revoked it.`;
  };
  const fs = h(
    "fieldset",
    { class: "field" },
    h("legend", null, "How long should it work?"),
    h(
      "div",
      { class: "seg", role: "radiogroup" },
      EXPIRY_PRESETS.map((p) =>
        h("label", { class: "seg-opt" }, h("input", { type: "radio", name, value: p.id, checked: p.id === selected, onchange: update }), h("span", null, p.label)),
      ),
    ),
    hint,
  );
  update();
  return fs;
}

export function expiryFrom(fs: HTMLElement, name: string): number | null {
  const v = (fs.querySelector(`input[name=${name}]:checked`) as HTMLInputElement)?.value;
  const p = EXPIRY_PRESETS.find((x) => x.id === v);
  return p?.secs ? Math.floor(Date.now() / 1000) + p.secs : null;
}

export const ICONS = {
  files: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`,
  portal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 14h3M8 17h6"/></svg>`,
  link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>`,
  sample: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg>`,
};
