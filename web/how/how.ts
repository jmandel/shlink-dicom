// How it works (/how): opens the public sample link and drives eight widgets with the real
// requests and decryption. See docs/EXPERIENCES.md §3.
import { extractShlink, formatPersonName, LinkError, loadConfig, openShare, pickInitialSeries, plural } from "../core/index";
import { getDecoderPool } from "../core/images";
import { $, emit, logRequest, S } from "./state";
import { initLink } from "./s-link";
import { initBundle } from "./s-bundle";
import { initSeries } from "./s-series";
import { initVerify } from "./s-verify";
import { initHost } from "./s-host";
import { initSandbox } from "./s-sandbox";
import { initCodecs } from "./s-codecs";
import { initBuild } from "./s-build";

/**
 * fetch for the sample's resolver. When step 4 arms the tamper switch for a Range header, the
 * matching response has one random bit flipped before the client code sees it.
 */
const tamperingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const range = (init?.headers as Record<string, string> | undefined)?.Range;
  if (!S.tamper.range || range !== S.tamper.range) return res;
  S.tamper.range = null;
  const buf = new Uint8Array(await res.arrayBuffer());
  const byte = Math.floor(Math.random() * buf.length);
  const bit = Math.floor(Math.random() * 8);
  const before = buf[byte];
  buf[byte] ^= 1 << bit;
  S.tamper.flipped = { byte, bit, before, after: buf[byte] };
  return new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
};

function status(text: string, kind: "" | "ok" | "err" = "") {
  const el = $("status");
  el.className = `status ${kind}`;
  el.textContent = text;
}

async function boot() {
  initLink();
  initBundle();
  initSeries();
  initVerify();
  initHost();
  initSandbox();
  initCodecs();
  initBuild();
  try {
    S.cfg = await loadConfig();
    const res = await fetch(`${S.cfg.apiBase}/api/demo-shares`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const pub = ((await res.json()).shares ?? []).find((s: any) => !s.passcodeHint && s.shlinkUri);
    const link = pub ? extractShlink(pub.shlinkUri) : null;
    if (!link) throw new Error("no public sample");
    S.shlink = link;
    S.sampleSid = String(pub.id ?? "");
  } catch {
    status("This server doesn't offer the public sample link right now, so the widgets can't run.", "err");
    return;
  }
  try {
    // Record decryption is always WebCrypto here: step 4 decrypts single records, which the wasm path does not.
    S.share = await openShare(S.shlink, { recipient: "How it works page", onRequest: logRequest, fetch: tamperingFetch, decrypt: "webcrypto" });
  } catch (e) {
    const why = e instanceof LinkError ? e.message : String((e as Error)?.message ?? e);
    status(`The sample link did not open: ${why}`, "err");
    return;
  }
  const idx = S.share.index;
  status(
    `Opened the sample in ${Math.round(S.share.openMs)} ms: ${formatPersonName(idx.patient.name) || "a patient"}, ${plural(idx.studies.length, "study", "studies")}, ${plural(idx.studies.reduce((a, s) => a + s.series.length, 0), "series", "series")}.`,
    "ok",
  );
  S.sel = { study: 0, series: pickInitialSeries(idx.studies[0]), instance: 0 };
  emit("ready");
  // Start the decoder workers early for steps 5 and 7.
  setTimeout(() => void getDecoderPool().catch(() => {}), 500);
}

boot();
