// How it works (/how): a guided tour of one slice of the sample's brain MRI, from the link to
// pixels. A sticky panel shows each step's scene; the steps scroll past it. See docs/HOW-TOUR-PLAN.md.
import { extractShlink, formatPersonName, LinkError, loadConfig, openShare, pickInitialSeries } from "../core/index";
import { getDecoderPool, PoolDecryptor } from "../core/images";
import { $, emit, h, logRequest, on, S } from "./state";
import { linkScene } from "./t-link";
import { indexScene } from "./t-index";
import { hostScene, piecesScene } from "./t-pieces";
import { unlockScene } from "./t-unlock";
import { compressedScene, pixelsScene } from "./t-pixels";
import { lessScene } from "./t-less";
import { shareScene } from "./t-share";
import { initEnd } from "./t-end";

export interface Scene {
  id: string;
  el: HTMLElement;
  /** Called each time the step becomes current. */
  enter?(): void;
  leave?(): void;
}

/**
 * fetch for the sample's resolver: keeps the Bundle's JWE (for its header and size), and when
 * step 4 arms the tamper switch for a Range header, flips one random bit of that response before
 * any client code sees it.
 */
const tourFetch: typeof fetch = async (input, init) => {
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

// The details switch, remembered per browser.
function initDetails() {
  const box = $<HTMLInputElement>("details");
  let on0 = false;
  try {
    on0 = localStorage.getItem("how-details") === "1";
  } catch {}
  if (new URLSearchParams(location.search).has("details")) on0 = true;
  const apply = (v: boolean) => {
    S.details = v;
    document.body.classList.toggle("details", v);
    emit("details", v);
  };
  box.checked = on0;
  apply(on0);
  box.addEventListener("change", () => {
    try {
      localStorage.setItem("how-details", box.checked ? "1" : "0");
    } catch {}
    apply(box.checked);
  });
}

// Scroll engine: the step whose top has passed the reading line is current.
const scenes = new Map<string, Scene>();
let current = "";
function pick() {
  if (!scenes.size) return;
  const steps = [...document.querySelectorAll<HTMLElement>(".step")];
  const wide = matchMedia("(min-width: 960px)").matches;
  let line: number;
  if (wide) line = innerHeight * 0.5;
  else {
    const pb = document.querySelector(".panel-wrap")!.getBoundingClientRect().bottom;
    line = pb + (innerHeight - pb) * 0.45;
  }
  let active = steps[0];
  for (const s of steps) if (s.getBoundingClientRect().top < line) active = s;
  const id = active.dataset.step!;
  if (id === current) return;
  for (const s of steps) s.classList.toggle("active", s === active);
  const prev = scenes.get(current);
  prev?.el.classList.remove("on");
  prev?.leave?.();
  current = id;
  const next = scenes.get(id);
  if (next) {
    next.el.classList.add("on");
    next.enter?.();
  }
  emit("step", id);
}
let queued = false;
const onScroll = () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    pick();
  });
};

async function boot() {
  initDetails();
  initEnd();
  const panel = $("panel");
  panel.append(h("div", { class: "scene on" }, h("p", { class: "muted", text: "Opening the sample link…" })));
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
    S.share = await openShare(link, { recipient: "How it works", onRequest: logRequest, fetch: tourFetch, decryptor: new PoolDecryptor(S.pool) });
  } catch (e) {
    const why = e instanceof LinkError ? e.message : "the server doesn't offer the public sample link right now";
    status(`The tour can't run: ${why}`, "err");
    return;
  }
  const idx = S.share.index;
  S.study = idx.studies.find((s) => s.modalities.includes("MR")) ?? idx.studies[0];
  S.series = S.study.series.find((s) => /T2/i.test(s.description ?? "") && /AX/i.test(s.description ?? "")) ?? S.study.series[pickInitialSeries(S.study)];
  S.slice = Math.floor(S.series.instances.length / 2);
  status(`Opened the sample: ${formatPersonName(idx.patient.name) || "a patient"}, ${idx.studies.length} studies. The tour follows slice ${S.slice + 1} of ${S.series.instances.length} in the “${S.series.description}” series of the ${S.study.description ?? "MRI"} study.`, "ok");

  (window as any).__how = { S, scenes, current: () => current };
  panel.replaceChildren();
  // One scene per task, so building them never holds the main thread for long.
  for (const make of [linkScene, indexScene, piecesScene, hostScene, unlockScene, pixelsScene, compressedScene, lessScene, shareScene]) {
    const sc = make();
    scenes.set(sc.id, sc);
    panel.append(sc.el);
    await new Promise((r) => setTimeout(r, 0));
  }
  emit("ready");
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onScroll);
  pick();
}

on("details", () => onScroll());
boot();
