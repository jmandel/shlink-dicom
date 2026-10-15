// Site configuration: where the API lives and which viewer prefix new links use.
//
// Sources, later wins:
//   1. defaults, which work when the Rust server serves the site (API on the same origin);
//   2. `config.json` at the site root (optional; a static deployment writes it);
//   3. URL query: `?api=https://host` and `?decrypt=webcrypto|wasm`.
import type { DecryptorKind } from "./decrypt";

export interface SiteConfig {
  /** Origin (and optional path) of the shl-dicom server API, no trailing slash. */
  apiBase: string;
  /** Viewer prefix put in front of `#shlink:/…` when this site builds a link. */
  viewerPrefix: string;
  /** Record decryption implementation. */
  decrypt: DecryptorKind;
}

/** Site root, derived from where the bundles are served (`<root>/assets/*.js`). */
export const siteRoot: URL = new URL("../", import.meta.url);

/** A URL under the site root, e.g. siteUrl("view") or siteUrl("how"). */
export function siteUrl(path: string): string {
  return new URL(path.replace(/^\//, ""), siteRoot).toString();
}

/** A file shipped next to the bundles (wasm, workers). */
export function assetUrl(name: string): string {
  return new URL(name, import.meta.url).toString();
}

export function defaultConfig(): SiteConfig {
  const origin = globalThis.location?.origin ?? "http://localhost:3333";
  return { apiBase: origin, viewerPrefix: siteUrl("view"), decrypt: "webcrypto" };
}

let cached: Promise<SiteConfig> | null = null;

/** Loads the configuration once per page. Never throws: a missing or broken config.json is ignored. */
export function loadConfig(): Promise<SiteConfig> {
  cached ??= (async () => {
    const cfg = defaultConfig();
    try {
      const res = await fetch(siteUrl("config.json"), { cache: "no-cache" });
      if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) {
        const j = await res.json();
        if (typeof j.apiBase === "string" && j.apiBase) cfg.apiBase = j.apiBase;
        if (typeof j.viewerPrefix === "string" && j.viewerPrefix) cfg.viewerPrefix = j.viewerPrefix;
        if (j.decrypt === "wasm" || j.decrypt === "webcrypto") cfg.decrypt = j.decrypt;
      }
    } catch {}
    const q = new URLSearchParams(globalThis.location?.search ?? "");
    const api = q.get("api");
    if (api) cfg.apiBase = api;
    const dec = q.get("decrypt");
    if (dec === "wasm" || dec === "webcrypto") cfg.decrypt = dec;
    cfg.apiBase = cfg.apiBase.replace(/\/+$/, "");
    return cfg;
  })();
  return cached;
}

/** The decrypt choice without waiting for config.json (query string only). */
export function decryptFromQuery(): DecryptorKind {
  return new URLSearchParams(globalThis.location?.search ?? "").get("decrypt") === "wasm" ? "wasm" : "webcrypto";
}
