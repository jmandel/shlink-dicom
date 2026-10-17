// Files pinned by URL and SHA-256, read from a local copy when one has the right hash, else
// downloaded, checked and kept. Used by the builds that start from published inputs:
// pages/build.ts (the GitHub Pages demo link) and imaging-sandbox/scripts/build-data.ts (the
// sandbox dataset, also run on the sandbox VM by deploy/bootstrap-sandbox.sh).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PinnedFile {
  /** Where it is published. */
  url: string;
  /** Its SHA-256, hex. Empty: not pinned yet; the file is fetched unchecked and the caller records the hash. */
  sha256: string;
  /** Its path under `keep` and the `caches`. */
  name: string;
}

export interface FetchOptions {
  /** Where downloads are kept (as keep/name); searched first. */
  keep: string;
  /** Other directories searched (as dir/name) before downloading. */
  caches?: string[];
  log?: (line: string) => void;
}

export const sha256Hex = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

/** The file's bytes. Throws if the download fails or its SHA-256 differs from the pin. */
export async function fetchPinned(f: PinnedFile, o: FetchOptions): Promise<Uint8Array> {
  for (const dir of [o.keep, ...(o.caches ?? [])]) {
    const p = join(dir, f.name);
    if (!existsSync(p)) continue;
    const b = new Uint8Array(readFileSync(p));
    if (f.sha256 && sha256Hex(b) === f.sha256) {
      o.log?.(`${f.name}: ${p} (hash ok)`);
      return b;
    }
  }
  o.log?.(`${f.name}: downloading ${f.url}`);
  const b = await download(f.url);
  if (f.sha256 && sha256Hex(b) !== f.sha256) throw new Error(`${f.name}: SHA-256 ${sha256Hex(b)} does not match the pinned ${f.sha256} (${f.url})`);
  mkdirSync(dirname(join(o.keep, f.name)), { recursive: true });
  writeFileSync(join(o.keep, f.name), b);
  return b;
}

/** GET with retries: a stalled or failed download (one of many in parallel) is tried again. */
async function download(url: string, attempts = 4): Promise<Uint8Array> {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (i >= attempts) throw new Error(`download ${url}: ${(e as Error).message} (${attempts} attempts)`);
      console.error(`download ${url}: ${(e as Error).message}; trying again (${i + 1} of ${attempts})`);
      await Bun.sleep(2000 * i);
    }
  }
}
