// How it works (/how): one page that reads top to bottom. It opens the public sample link and
// follows one slice of the brain MRI through each layer of the protocol. Each step's picture is
// built once, when it first comes near the screen, and then stays as it is.
import { extractShlink, formatPersonName, LinkError, loadConfig, openShare, pickInitialSeries } from "../core/index";
import { getDecoderPool, PoolDecryptor } from "../core/images";
import { $, h, logRequest, S } from "./state";
import { mountLink } from "./s-link";
import { mountJwe } from "./s-jwe";
import { mountBundle } from "./s-bundle";
import { mountStudy } from "./s-study";
import { mountFile } from "./s-file";
import { mountHost } from "./s-host";
import { mountGcm } from "./s-gcm";
import { mountDicom } from "./s-dicom";
import { mountLess } from "./s-less";
import { mountShare } from "./s-share";
import { mountEnd } from "./s-end";

export type Mount = (pic: HTMLElement, exact: HTMLElement) => void | Promise<void>;

const STEPS: Record<string, Mount> = {
  link: mountLink,
  jwe: mountJwe,
  bundle: mountBundle,
  study: mountStudy,
  file: mountFile,
  host: mountHost,
  gcm: mountGcm,
  dicom: mountDicom,
  less: mountLess,
  share: mountShare,
  end: mountEnd,
};

/**
 * fetch for the sample's resolver: keeps the JWE as fetched, and when step 7 arms the tamper
 * switch for a Range header, flips one random bit of that response before any client code sees it.
 */
const pageFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if ((res.headers.get("content-type") ?? "").includes("jose")) S.jwe = await res.clone().text();
  const range = (init?.headers as Record<string, string> | undefined)?.Range;
  if (!S.tamper.range || range !== S.tamper.range) return res;
  S.tamper.range = null;
  const buf = new Uint8Array(await res.arrayBuffer());
  const byte = Math.floor(Math.random() * buf.length);
  const bit = Math.floor(Math.random() * 8);
  buf[byte] ^= 1 << bit;
  S.tamper.flipped = { byte, bit };
  return new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
};

function status(text: string, kind: "" | "ok" | "err" = "") {
  const el = $("status");
  el.className = `status ${kind}`;
  el.textContent = text;
}

const mounted = new Set<string>();
async function mount(section: HTMLElement) {
  const id = section.id;
  if (mounted.has(id)) return;
  mounted.add(id);
  const pic = section.querySelector<HTMLElement>("[data-pic]") ?? h("div");
  const exact = section.querySelector<HTMLElement>("[data-exact]") ?? h("div");
  try {
    await STEPS[id]?.(pic, exact);
    section.dataset.ready = "1";
  } catch (e) {
    pic.replaceChildren(h("p", { class: "bad", text: (e as Error).message }));
    section.dataset.ready = "error";
  }
}

async function boot() {
  S.pool = getDecoderPool();
  try {
    S.cfg = await loadConfig();
    const res = await fetch(`${S.cfg.apiBase}/api/demo-shares`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const pub = ((await res.json()).shares ?? []).find((s: any) => !s.passcodeHint && s.shlinkUri);
    const link = pub ? extractShlink(pub.shlinkUri) : null;
    if (!link) throw new Error("no public sample");
    S.shlink = link;
    S.sampleSid = String(pub.id ?? "");
    S.share = await openShare(link, { recipient: "How it works", onRequest: logRequest, fetch: pageFetch, decryptor: new PoolDecryptor(S.pool) });
  } catch (e) {
    const why = e instanceof LinkError ? e.message : "this server doesn't offer the public sample link right now";
    status(`The examples can't run: ${why}.`, "err");
    return;
  }
  const idx = S.share.index;
  S.study = idx.studies.find((s) => s.modalities.includes("MR")) ?? idx.studies[0];
  S.series = S.study.series.find((s) => /T2/i.test(s.description ?? "") && /AX/i.test(s.description ?? "")) ?? S.study.series[pickInitialSeries(S.study)];
  S.slice = Math.floor(S.series.instances.length / 2);
  status(`Opened the sample: ${formatPersonName(idx.patient.name) || "a patient"}, ${idx.studies.length} studies. The page follows slice ${S.slice + 1} of ${S.series.instances.length} in the “${S.series.description}” series of the ${S.study.description ?? "MRI"} study.`, "ok");
  (window as any).__how = { S, mounted };

  // Build each step's picture once, when it comes within a screen of view.
  const sections = [...document.querySelectorAll<HTMLElement>("section.step")];
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        void mount(e.target as HTMLElement);
      }
    },
    { rootMargin: "100% 0px" },
  );
  for (const s of sections) io.observe(s);
}

boot();
