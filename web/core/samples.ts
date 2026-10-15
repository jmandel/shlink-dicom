// The public sample links the server seeds (GET /api/demo-shares).
import { extractShlink } from "./shlink";
import type { SiteConfig } from "./config";

export interface SampleLink {
  title: string;
  description: string;
  /** Bare `shlink:/…`. */
  shlink: string;
  /** The passcode, for the passcode demo. */
  passcodeHint: string | null;
}

/** Lists the server's sample links. The first one without a passcode is the public sample. */
export async function fetchSampleLinks(cfg: SiteConfig): Promise<SampleLink[]> {
  const res = await fetch(`${cfg.apiBase}/api/demo-shares`);
  if (!res.ok) throw new Error(`sample links: HTTP ${res.status}`);
  const j = await res.json();
  return (j.shares ?? []).map((s: any) => ({
    title: String(s.title ?? "Sample"),
    description: String(s.description ?? ""),
    shlink: extractShlink(String(s.shlinkUri ?? "")) ?? "",
    passcodeHint: s.passcodeHint ?? null,
  }));
}

/** Viewer URL for a link: `${viewerPrefix}#shlink:/…`. */
export function viewerUrl(cfg: SiteConfig, shlink: string): string {
  return `${cfg.viewerPrefix}#${extractShlink(shlink) ?? shlink}`;
}
