// Runs reading sessions (sessions.mjs) in headless Chromium against a build, and writes one JSON
// line per session: every operation's latency until the right pixels are on screen, stalls,
// session time, bytes and requests. See README.md.
//
//   node perf/sessions/run.mjs --build=main --sample=https://127.0.0.1:3571 --extras=https://127.0.0.1:3572 \
//        --net=home --device=desktop --runs=5 --kinds=ct,mri,slide --out=results.jsonl
import { chromium } from "playwright-core";
import { appendFileSync, readFileSync } from "node:fs";
import { SESSIONS } from "./sessions.mjs";

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? d;
const build = arg("build", "build");
const bases = { sample: arg("sample"), extras: arg("extras") };
/**
 * Shares made with the Share page's packer instead of the server's seed (share-files.ts), as
 * `shlink:/…` strings on the extras server; pointed at --extras like the seeded ones.
 */
const packed = { jxl: arg("jxl"), j2k: arg("j2k") };
function packedLink(name) {
  const s = packed[name];
  if (!s) return null;
  const payload = JSON.parse(Buffer.from(s.split("shlink:/")[1], "base64url").toString());
  payload.url = bases.extras + new URL(payload.url).pathname;
  return `${bases.extras}/view#shlink:/${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
}
const net = arg("net", "home");
const device = arg("device", "desktop");
const cpu = Number(arg("cpu", device === "phone" ? "4" : "1"));
const runs = Number(arg("runs", "3"));
const kinds = arg("kinds", Object.keys(SESSIONS).join(",")).split(",");
const out = arg("out", "sessions.jsonl");
const run0 = Number(arg("run0", "0"));
/** Longest wait for one operation, by profile. */
const CAP = { home: 30000, fast4g: 60000, slow4g: 120000 }[net] ?? 60000;
/** A scrub step slower than this is a stall. */
const STALL_MS = 250;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

/** The share's direct link, pointed at `base` (the server writes its own origin into the link). */
async function linkFor(base) {
  const r = await fetch(`${base}/api/demo-shares`).then((r) => r.json());
  const s = r.shares.find((x) => !x.passcodeHint) ?? r.shares[0];
  const payload = JSON.parse(Buffer.from(s.shlinkUri.split("#shlink:/")[1], "base64url").toString());
  payload.url = base + new URL(payload.url).pathname;
  return `${base}/view#shlink:/${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
}

const pct = (xs, p) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null;
};

// ------------------------------------------------------------------------- in-page operations

/** Opens study card i; resolves with ms until its first picture (slice, slide tile, video). */
async function opOpen(page, i) {
  return page.evaluate(
    async ([i, cap]) => {
      const t = performance.now();
      const v = window.__view;
      const n0 = v.drawLog.length;
      document.querySelectorAll(".study-open")[i].click();
      for (;;) {
        if (v.drawLog.length > n0) return { ms: Math.round(v.drawLog[n0][2] - t), what: "slice" };
        const s = window.__wsi?.stats?.();
        if (window.__wsi?.active?.() && s?.firstDrawMs != null) return { ms: Math.round(performance.now() - t), what: "tile" };
        const vm = window.__video?.metrics?.();
        if (vm?.opened > 0 && window.__video.active()) return { ms: Math.round(performance.now() - t), what: "video" };
        if (performance.now() - t > cap) return { ms: null, timeout: true };
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    [i, CAP],
  );
}

/**
 * A paced run of slice requests. `targets` are slice indices; each step's latency is the time until
 * that slice, or one requested after it in the same run, is drawn.
 */
async function opScrub(page, targets, pace) {
  return page.evaluate(
    async ([targets, pace, cap]) => {
      const h = window.__viewHooks, v = window.__view;
      const reqs = [];
      for (const s of targets) {
        reqs.push([s, performance.now()]);
        h.showSlice(s);
        await new Promise((r) => setTimeout(r, 1000 / pace));
      }
      // Until the last one is drawn (or the cap).
      const last = targets[targets.length - 1], t1 = performance.now();
      while (performance.now() - t1 < cap && !v.drawLog.some((d) => d[1] === last && d[2] >= reqs[reqs.length - 1][1])) await new Promise((r) => setTimeout(r, 5));
      const log = v.drawLog;
      return reqs.map(([s, t], j) => {
        const later = new Set(targets.slice(j));
        const d = log.find((e) => e[2] >= t && e[0] !== "mpr" && later.has(e[1]));
        return d ? Math.round(d[2] - t) : null;
      });
    },
    [targets, pace, CAP],
  );
}

async function sliceState(page) {
  return page.evaluate(() => window.__viewHooks.state());
}

/** Clicks strip button k; ms until a picture of another series is drawn. */
async function opSwitch(page, k) {
  return page.evaluate(
    async ([k, cap]) => {
      const v = window.__view;
      const n0 = v.drawLog.length;
      const prev = n0 ? v.drawLog[n0 - 1][0] : "";
      const t = performance.now();
      document.querySelector(`.series-btn[data-series="${k}"]`).click();
      for (;;) {
        const d = v.drawLog.slice(n0).find((e) => e[0] !== prev && e[0] !== "mpr");
        if (d) return { ms: Math.round(d[2] - t) };
        if (window.__wsi?.active?.() && window.__wsi.stats()?.firstDrawMs != null) return { ms: Math.round(performance.now() - t) };
        if (performance.now() - t > cap) return { ms: null, timeout: true };
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    [k, CAP],
  );
}

async function opMpr(page, plane, slab) {
  return page.evaluate(
    async ([plane, slab, cap]) => {
      const h = window.__viewHooks, v = window.__view;
      const n0 = v.drawLog.length;
      const t = performance.now();
      void h.enterMpr(plane, slab ? { slab: { thickness: slab, mode: "mip" } } : undefined);
      for (;;) {
        const d = v.drawLog.slice(n0).find((e) => e[0] === "mpr");
        if (d) return { ms: Math.round(d[2] - t) };
        if (performance.now() - t > cap) return { ms: null, timeout: true };
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    [plane, slab ?? 0, CAP],
  );
}

/** Play: ms until the frame moves on, then frames shown over `seconds` against the expected count. */
async function opPlay(page, seconds) {
  return page.evaluate(
    async ([seconds, cap]) => {
      const vd = window.__video;
      const s0 = vd?.state();
      if (!s0) return { ms: null, missing: true };
      const t = performance.now();
      vd.play();
      let moved = null;
      while (performance.now() - t < cap) {
        const s = vd.state();
        if (s && s.frame !== s0.frame) {
          moved = performance.now() - t;
          break;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      if (moved === null) return { ms: null, timeout: true };
      const f0 = vd.state().frame, t0 = performance.now();
      const seen = new Set([f0]);
      while (performance.now() - t0 < seconds * 1000) {
        seen.add(vd.state().frame);
        await new Promise((r) => setTimeout(r, 10));
      }
      vd.pause();
      return { ms: Math.round(moved), framesShown: seen.size, seconds };
    },
    [seconds, CAP],
  );
}

/** A slide view; ms until every tile it needs is on screen. */
async function opSlideView(page, step) {
  return page.evaluate(
    async ([step, cap]) => {
      const w = window.__wsi;
      const p = w.pyramid(), v = w.view();
      const t = performance.now();
      if (step.op === "zoom") w.setView(p.width * step.x, p.height * step.y, v.dpr);
      if (step.op === "pan") w.setView(v.cx + (step.dx * v.w) / v.scale, v.cy + (step.dy * v.h) / v.scale, v.scale);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      while (!w.idle()) {
        if (performance.now() - t > cap) return { ms: null, timeout: true };
        await new Promise((r) => setTimeout(r, 5));
      }
      return { ms: Math.round(performance.now() - t) };
    },
    [step, CAP],
  );
}

// ------------------------------------------------------------------------- one session

async function session(browser, kind, run) {
  const def = SESSIONS[kind];
  const context = await browser.newContext({ ...DEVICES[device] });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
  let bytes = 0, requests = 0;
  cdp.on("Network.loadingFinished", (e) => {
    bytes += e.encodedDataLength;
    requests++;
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const ops = [];
  const t0 = Date.now();
  try {
    await page.goto(packedLink(def.share) ?? (await linkFor(bases[def.share])), { waitUntil: "commit" });
    await page.waitForSelector("#screen-overview:not(.hidden)", { timeout: CAP * 2 });
    // Matched on the card's title (the study's description).
    const card = await page.evaluate(
      ([src, flags]) => [...document.querySelectorAll(".study-open")].findIndex((b) => new RegExp(src, flags).test(b.querySelector(".study-title")?.textContent ?? "")),
      [def.study.source, def.study.flags],
    );
    if (card < 0) throw new Error(`no study card matches ${def.study}`);
    for (const step of def.steps) {
      if (step.op === "open") {
        ops.push({ op: "open", ...(await opOpen(page, card)) });
      } else if (step.op === "scrub" || step.op === "rock") {
        const st = await sliceState(page);
        const n = st.sliceCount;
        if (n < 2) continue;
        const targets = [];
        let s = st.sliceIdx;
        if (step.op === "scrub") {
          let dir = Math.sign(step.count);
          for (let k = 0; k < Math.abs(step.count); k++) {
            if (s + dir < 0 || s + dir >= n) dir = -dir;
            s += dir;
            targets.push(s);
          }
        } else {
          const lo = Math.max(0, s - step.span), hi = Math.min(n - 1, s + step.span);
          for (let k = 0; k < step.times; k++) {
            for (let x = s; x <= hi; x++) targets.push(x);
            for (let x = hi; x >= lo; x--) targets.push(x);
            for (let x = lo; x <= s; x++) targets.push(x);
          }
        }
        const lat = await opScrub(page, targets, step.pace);
        for (const ms of lat) ops.push({ op: "step", label: step.label, ms, timeout: ms === null || undefined });
      } else if (step.op === "pause") {
        await page.waitForTimeout(step.ms);
      } else if (step.op === "jump") {
        const st = await sliceState(page);
        if (st.sliceCount < 2) continue;
        const far = st.sliceIdx < st.sliceCount / 2 ? st.sliceCount - 1 : 0;
        const [ms] = await opScrub(page, [far], 1000);
        ops.push({ op: "jump", ms, timeout: ms === null || undefined });
      } else if (step.op === "switch") {
        const n = await page.locator(".series-btn").count();
        if (n < 2) continue;
        const cur = (await sliceState(page)).seriesIdx;
        const k = (((cur + step.to) % n) + n) % n;
        ops.push({ op: "switch", ...(await opSwitch(page, k)) });
      } else if (step.op === "mpr") {
        const r = await opMpr(page, step.plane);
        ops.push({ op: "mpr", label: "first", ...r });
        if (r.ms !== null) for (const slab of step.slabs ?? []) ops.push({ op: "mpr", label: `slab${slab}`, ...(await opMpr(page, step.plane, slab)) });
      } else if (step.op === "play") {
        ops.push({ op: "play", ...(await opPlay(page, step.seconds)) });
      } else if (step.op === "fit") {
        // From the open click: every tile of the fitted view on screen.
        const r = await page.evaluate(async (cap) => {
          const t = performance.now();
          while (!(window.__wsi?.active() && window.__wsi.idle())) {
            if (performance.now() - t > cap) return { ms: null, timeout: true };
            await new Promise((r) => setTimeout(r, 5));
          }
          return { ms: Math.round(performance.now() - t) };
        }, CAP);
        ops.push({ op: "fit", ...r });
      } else if (step.op === "zoom" || step.op === "pan") {
        ops.push({ op: step.op, ...(await opSlideView(page, step)) });
      }
    }
  } catch (e) {
    errors.push(String(e.message ?? e).slice(0, 300));
  }
  const steps = ops.filter((o) => o.op === "step");
  const stalled = steps.filter((o) => o.ms === null || o.ms > STALL_MS);
  const res = {
    build, net, device, cpu, kind, run,
    load: Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]),
    totalMs: Date.now() - t0,
    bytes, requests,
    stalls: stalled.length,
    stallMs: stalled.reduce((a, o) => a + (o.ms ?? CAP), 0),
    ops,
    errors,
  };
  await context.close();
  return res;
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--ignore-certificate-errors", "--enable-unsafe-swiftshader", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"],
});
for (let r = run0; r < run0 + runs; r++) {
  for (const kind of kinds) {
    const res = await session(browser, kind, r);
    appendFileSync(out, JSON.stringify(res) + "\n");
    const opens = res.ops.filter((o) => o.op !== "step").map((o) => `${o.op}${o.label ? `:${o.label}` : ""}=${o.ms ?? "x"}`).join(" ");
    const steps = res.ops.filter((o) => o.op === "step").map((o) => o.ms);
    console.log(`${build} ${net} ${device} r${r} ${kind}: ${res.totalMs} ms, ${(res.bytes / 1e6).toFixed(1)} MB, ${res.requests} req, steps p50 ${pct(steps, 0.5)} p95 ${pct(steps, 0.95)} stalls ${res.stalls} | ${opens}${res.errors.length ? ` | ERR ${res.errors[0]}` : ""}`);
  }
}
await browser.close();
