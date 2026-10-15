// Checks for video and cine in /view (web/core/video*.ts).
//   bun web/checks/video-fixtures.ts         (makes the test data and a share; /tmp/video-fixtures.json)
//   node web/checks/video-checks.mjs [--only=<case>] [--keep]
//
// 1. Remux, without a browser: every Transport Stream case is remuxed by web/core/video-remux.ts and
//    decoded by ffmpeg; every frame must hash the same as ffmpeg's decode of the original stream.
// 2. Playback in headless Chromium (desktop, then phone): each case opens, plays, has the right
//    duration and frame count, steps one frame at a time, and its first frame matches ffmpeg's
//    decode within a tolerance. MPEG-2 plays through the lazily loaded wasm decoder (and only
//    MPEG-2 loads it). HEVC shows a message naming the format when the browser has no HEVC decoder. Notes for audio left out and for stereo/3D views are checked.
// Screenshots go to docs/shots/video/, numbers to docs/shots/video/results.json. The share is
// deleted at the end (--keep keeps it).
import { launchBrowser, pageErrorCheck } from "./browser.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3333";
const SHOTS = new URL("../../docs/shots/video/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const F = JSON.parse(readFileSync("/tmp/video-fixtures.json", "utf8"));
const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice(7);
const keep = args.includes("--keep");
const cases = F.cases.filter((c) => !only || c.name.includes(only));

const results = [];
const numbers = {};
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// ------------------------------------------------------------------------------------- 1. remux

const { TsRemuxer } = await import("../core/video-remux.ts");
const framemd5 = (file) =>
  execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:v:0", "-f", "framemd5", "-"], { maxBuffer: 1 << 28 })
    .toString()
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(",").pop().trim());

for (const c of cases) {
  const m = /\(ffmpeg testsrc2\) (\S+\.ts)$/.exec(c.source);
  if (!m || c.expect.plays === "mpeg2") continue;
  const src = `${F.dir}/${m[1]}`;
  const ts = readFileSync(src);
  const r = new TsRemuxer({ frameDuration90k: 90000 / (c.expect.frames / c.expect.duration) });
  const frags = [];
  // Feed in odd-sized pieces, as the network delivers them.
  for (let i = 0, k = 0; i < ts.length; k++) {
    const n = [65520, 1000, 188 * 7 + 5, 333333][k % 4];
    r.push(new Uint8Array(ts.buffer, ts.byteOffset + i, Math.min(n, ts.length - i)));
    frags.push(...r.drain());
    i += n;
  }
  const out = r.finish();
  const file = `${F.dir}/${c.name}.remux.mp4`;
  writeFileSync(file, Buffer.concat([out.init, ...frags, ...out.fragments]));
  const a = framemd5(src), b = framemd5(file);
  const same = a.length === b.length && a.every((x, i) => x === b[i]);
  check(`remux ${c.name}: ${b.length} frames identical to ffmpeg's decode of the Transport Stream`, same && a.length === c.expect.frames, `source ${a.length}, remux ${b.length}, ${out.params.codecString}, dropped ${out.dropped.join(", ") || "nothing"}`);
  if (c.expect.dropped) check(`remux ${c.name}: drops ${c.expect.dropped.join(", ")}`, c.expect.dropped.every((d) => out.dropped.includes(d)), out.dropped.join(", "));
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=start_time:stream=codec_name", "-of", "json", file]).toString());
  check(`remux ${c.name}: starts at 0 (edit list), one video track`, Math.abs(Number(probe.format.start_time)) < 1e-3 && probe.streams.length === 1, `start ${probe.format.start_time}`);
  if (c.name.includes("mvc")) check(`remux ${c.name}: second-view NAL units dropped`, out.droppedNonBase > 0, `${out.droppedNonBase} dropped`);
  if (c.name.includes("3d")) check(`remux ${c.name}: side-by-side frame packing found`, out.framePacking === 3, `type ${out.framePacking}`);
}

// ------------------------------------------------------------------------------------- 2. browser

const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
};

const browser = await launchBrowser({ args: ["--autoplay-policy=no-user-gesture-required"] });

async function newPage(dev) {
  const context = await browser.newContext(DEVICES[dev]);
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("response", (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url().slice(0, 100)}`));
  return { context, page, errors, requests };
}

/**
 * Differences between two RGBA frames: luma (BT.709 weights) mean absolute difference and PSNR,
 * and the RGB mean absolute difference. Luma shows whether the picture decoded the same; RGB also
 * carries the player's colour conversion and chroma upsampling, which differ between players.
 */
function compare(a, b) {
  let ly = 0, sq = 0, rgb = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) {
    const ya = 0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2];
    const yb = 0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2];
    const d = ya - yb;
    ly += Math.abs(d);
    sq += d * d;
    rgb += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    n++;
  }
  const mse = sq / n;
  return { mad: ly / n, psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse), rgbMad: rgb / (3 * n) };
}

/** Opens a case: its study, then its series, then its clip when the series holds several. */
async function openCase(page, c) {
  await page.goto("about:blank");
  await page.goto(`${BASE}/view#${F.link}`);
  await page.waitForSelector("#screen-overview:not(.hidden)", { timeout: 30000 });
  await page.click(`.study-open[data-study="${c.at.study}"]`);
  await page.waitForSelector("#screen-viewer:not(.hidden)");
  const current = () => page.evaluate(() => window.__viewHooks.state().seriesIdx);
  await page.waitForFunction(() => window.__viewHooks.state().seriesIdx >= 0);
  if ((await current()) !== c.at.series) await page.click(`.series-btn[data-series="${c.at.series}"]`);
  const ready = () => page.waitForFunction(() => window.__video?.metrics().opened > 0 || window.__video?.metrics().error, null, { timeout: 180000 });
  await ready();
  for (let k = 0; k < c.at.instance; k++) {
    const n = await page.evaluate(() => window.__video.metrics().opened);
    await page.click('.play-bar button[aria-label="Next video"]');
    await page.waitForFunction((n) => window.__video.metrics().opened > n || window.__video.metrics().error, n, { timeout: 180000 });
  }
  return page.evaluate(() => ({ m: window.__video.metrics(), state: window.__video.state(), note: window.__video.note(), status: window.__video.status() }));
}

const hevcSupported = async (page) => page.evaluate(() => MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L153.B0"'));

async function runDevice(dev) {
  const { context, page, errors, requests } = await newPage(dev);
  const list = dev === "desktop" ? cases : cases.filter((c) => /h264-ts-ac3|h264-3d|Issue42|hevc-main-mp4|mpeg2-ts/.test(c.name));
  for (const c of list) {
    const tag = `${dev} ${c.name}`;
    let r;
    requests.length = 0;
    try {
      r = await openCase(page, c);
    } catch (e) {
      check(`${tag}: opens`, false, e.message);
      continue;
    }
    const plays = c.expect.plays !== "if-supported" || (await hevcSupported(page));
    const decoderLoaded = requests.some((u) => /mpeg2dec\.wasm/.test(u));
    check(`${tag}: MPEG-2 decoder ${c.expect.plays === "mpeg2" ? "loaded" : "not loaded"}`, decoderLoaded === (c.expect.plays === "mpeg2"));
    if (!plays) {
      check(`${tag}: message names the format`, /HEVC/.test(r.status) && !r.m.opened, r.status);
      await page.screenshot({ path: `${SHOTS}${dev}-${c.name}.png` });
      continue;
    }
    check(`${tag}: plays (${c.expect.plays === "mpeg2" ? "wasm decoder on a canvas" : "<video>"})`, r.m.opened >= 1 && !r.m.error, `${r.m.container} → ${r.m.codec}, opened in ${r.m.lastOpenMs} ms`);
    const tol = Math.max(0.1, (2 * c.expect.duration) / c.expect.frames);
    check(`${tag}: duration ${c.expect.duration.toFixed(3)} s`, Math.abs(r.m.duration - c.expect.duration) <= tol, `${r.m.duration.toFixed(3)} s (tolerance ${tol.toFixed(3)})`);
    // The counter follows the stream (MP4 sample table, Transport/Program Stream duration); a raw
    // MPEG-2 stream has no timestamps, so there it follows Number of Frames (ETIAM_video_002: 450 in
    // the header, 451 decodable).
    check(`${tag}: ${c.expect.frames} frames${c.expect.plays === "mpeg2" ? " (±2 until decoded to the end)" : " (±1: an MP4 sample can decode to no picture)"}`, Math.abs(r.state.frames - c.expect.frames) <= (c.expect.plays === "mpeg2" ? 2 : 1), `${r.state.frames} shown, ${c.expect.frames} in the stream`);
    if (c.expect.note) check(`${tag}: note says "${c.expect.note}"`, r.note.includes(c.expect.note), r.note);
    // First frame against ffmpeg's decode.
    const g = await page.evaluate(() => window.__video.grab());
    const px = Buffer.from(g.b64, "base64");
    const scored = c.refs.map((r) => {
      const ref = readFileSync(r.path);
      return ref.length === px.length ? { matrix: r.matrix, ...compare(px, ref) } : null;
    });
    const best = scored.filter(Boolean).sort((a, b) => a.mad - b.mad)[0];
    if (!best) check(`${tag}: first frame size`, false, `${g.width}×${g.height}`);
    else {
      numbers[`${tag} first frame`] = scored;
      check(
        `${tag}: first frame matches ffmpeg's decode (luma mean abs diff ≤ 1.5, PSNR ≥ 40 dB; RGB mean ≤ 5)`,
        best.mad <= 1.5 && best.psnr >= 40 && best.rgbMad <= 5,
        `luma ${best.mad.toFixed(2)} / ${best.psnr.toFixed(1)} dB, RGB ${best.rgbMad.toFixed(2)}, against ffmpeg's ${best.matrix} conversion${c.refs.length > 1 ? " (the stream names no colour matrix)" : ""}`,
      );
    }
    // Play, then pause: time advances; the counter follows.
    await page.evaluate(() => window.__video.play());
    await page.waitForTimeout(1200);
    const p = await page.evaluate(() => window.__video.state());
    await page.evaluate(() => window.__video.pause());
    check(`${tag}: playing advances the frame counter`, p.playing && p.frame > 5, `frame ${p.frame + 1} after 1.2 s`);
    // Step forward and back one frame.
    await page.evaluate(() => window.__video.seekFrame(10));
    await page.waitForFunction(() => window.__video.state().frame === 10, null, { timeout: 5000 }).catch(() => {});
    await page.evaluate(() => window.__video.step(1));
    await page.waitForTimeout(300);
    const s1 = await page.evaluate(() => window.__video.state());
    await page.evaluate(() => window.__video.step(-1));
    await page.waitForTimeout(300);
    const s2 = await page.evaluate(() => window.__video.state());
    check(`${tag}: frame stepping`, s1.frame === 11 && s2.frame === 10 && !s2.playing, `11 → ${s1.frame + 1}... ${s2.frame + 1}`);
    if (c.expect.plays === "mpeg2") {
      // The LGPL credit links to the licence and to the exact FFmpeg source, served beside the decoder.
      const links = await page.$$eval(".media-credit a", (as) => as.map((a) => a.href));
      const got = await Promise.all(links.map((u) => fetch(u).then(async (r) => ({ u, ok: r.ok, type: r.headers.get("content-type"), bytes: (await r.arrayBuffer()).byteLength }))));
      check(`${tag}: FFmpeg licence and source links work`, got.length === 2 && got.every((g) => g.ok && g.bytes > 1000) && /text\/plain/.test(got[0].type ?? ""), got.map((g) => `${g.u.split("/").pop()} ${g.type} ${g.bytes} B`).join(", "));
      // Play through to the end: every frame drawn, few dropped.
      await page.evaluate(() => (window.__video.seekFrame(0), window.__video.play()));
      await page.waitForFunction(() => !window.__video.state().playing, null, { timeout: c.expect.duration * 1000 + 30000 }).catch(() => {});
      const st = await page.evaluate(() => ({ s: window.__video.mpeg2(), st: window.__video.state() }));
      numbers[`${tag} playback`] = st.s;
      check(`${tag}: plays to the last frame in real time`, st.st.frame === st.st.frames - 1 && Math.abs(st.st.frames - c.expect.frames) <= 1 && st.s.late <= c.expect.frames * 0.05, `ended on ${st.st.frame + 1}/${st.st.frames}; ${st.s.drawn} drawn, ${st.s.late} dropped as late`);
    }
    await page.screenshot({ path: `${SHOTS}${dev}-${c.name}.png` });
  }

  if (!list.length) return void (await context.close());
  // Layout: the play bar fits; no horizontal scroll; buttons are big enough to tap.
  const layout = await page.evaluate(() => {
    const bar = document.querySelector(".play-bar");
    const r = bar?.getBoundingClientRect();
    const btns = [...document.querySelectorAll(".play-bar button")].filter((b) => b.offsetParent).map((b) => b.getBoundingClientRect());
    return { scroll: document.scrollingElement.scrollWidth, width: innerWidth, bar: r && { left: r.left, right: r.right }, minBtn: Math.min(...btns.map((b) => Math.min(b.width, b.height))) };
  });
  check(`${dev}: play bar fits the screen`, layout.scroll <= layout.width && layout.bar && layout.bar.right <= layout.width + 1, JSON.stringify(layout));
  check(`${dev}: play bar buttons at least ${dev === "phone" ? 36 : 36} px`, layout.minBtn >= 36, `${layout.minBtn.toFixed(0)} px`);
  check(`${dev}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
}

// ------------------------------------------------------------------------------------- 3. cine

/**
 * Multi-frame images: the cine bar appears, takes its timing from the file (Frame Time Vector,
 * Frame Time, or none), plays at that rate, steps, loops, and in a series of several clips plays
 * the clip on screen.
 */
async function runCine(dev) {
  const { context, page, errors } = await newPage(dev);
  const list = (F.cine?.cases ?? []).filter((c) => !only || c.name.includes(only));
  for (const c of dev === "desktop" ? list : list.filter((x) => /ftv|clips/.test(x.name))) {
    const tag = `${dev} ${c.name}`;
    await page.goto("about:blank");
    await page.goto(`${BASE}/view#${F.cine.link}`);
    await page.waitForSelector("#screen-overview:not(.hidden)", { timeout: 30000 });
    const idx = await page.$$eval(".study-title", (els, s) => els.findIndex((e) => e.textContent === s), c.study);
    if (idx < 0) {
      check(`${tag}: study in the share`, false, c.study);
      continue;
    }
    await page.click(`.study-open[data-study="${idx}"]`);
    const ok = await page.waitForFunction(() => window.__video?.cine(), null, { timeout: 120000 }).then(() => true, () => false);
    if (!ok) {
      check(`${tag}: cine controls appear`, false, await page.evaluate(() => document.getElementById("stage-msg")?.textContent ?? ""));
      continue;
    }
    const cine = await page.evaluate(() => window.__video.cine());
    check(`${tag}: cine controls for ${c.frames} frames`, cine.frames === c.frames, `${cine.frames}`);
    check(`${tag}: timing from ${c.timing ?? "nothing (the file has none)"}`, cine.timing.source === c.timing, `${cine.timing.source}; shows "${cine.rate}"`);
    if (!c.timing) check(`${tag}: rate label says the file has no timing`, /no timing/.test(cine.rate), cine.rate);
    const head = cine.timing.durations.slice(0, 6).map((x) => Math.round(x * 100) / 100);
    check(`${tag}: frame durations match the file`, head.every((d, i) => Math.abs(d - c.durationsHead[i]) < 0.01), `${head.join(", ")} ms`);
    // Play: measure the time between frame changes.
    const playMs = Math.min(4000, Math.max(1500, c.meanMs * 14));
    await page.evaluate(() => (window.__video.seekFrame(0), window.__video.play()));
    await page.waitForTimeout(playMs);
    const log = await page.evaluate(() => window.__video.cineLog());
    const st = await page.evaluate(() => window.__video.state());
    await page.evaluate(() => window.__video.pause());
    const steps = log.length - 1;
    const meanMs = steps > 0 ? (log[log.length - 1].t - log[0].t) / steps : NaN;
    numbers[`${tag} cine`] = { meanMs, expected: c.meanMs, steps };
    check(`${tag}: plays at the recorded rate (mean frame time within 10%)`, steps >= 5 && Math.abs(meanMs - c.meanMs) <= 0.1 * c.meanMs + 2, `${meanMs.toFixed(1)} ms per frame over ${steps} frames, file says ${c.meanMs.toFixed(1)}`);
    if (/ftv/.test(c.name)) {
      // Frame i shows for FTV[i+1]: 20 ms after even frames, 60 ms after odd ones.
      const gaps = { short: [], long: [] };
      for (let i = 1; i < log.length; i++) if (log[i].f === log[i - 1].f + 1) (log[i - 1].f % 2 ? gaps.long : gaps.short).push(log[i].t - log[i - 1].t);
      const m = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
      check(`${tag}: each frame shows for its own Frame Time Vector value`, m(gaps.long) > 2 * m(gaps.short), `after 20 ms frames ${m(gaps.short).toFixed(1)} ms, after 60 ms frames ${m(gaps.long).toFixed(1)} ms`);
    }
    const wrapped = log.some((e, i) => i > 0 && e.f < log[i - 1].f);
    if (playMs > c.frames * c.meanMs * 1.2) check(`${tag}: loops`, wrapped, `${log.length} frames shown`);
    // Step.
    await page.evaluate(() => window.__video.seekFrame(3));
    await page.evaluate(() => window.__video.step(1));
    const s1 = await page.evaluate(() => window.__video.state());
    await page.evaluate(() => window.__video.step(-1));
    const s2 = await page.evaluate(() => window.__video.state());
    check(`${tag}: frame stepping`, s1.frame === 4 && s2.frame === 3 && !s2.playing, `from 3: forward to ${s1.frame}, back to ${s2.frame}`);
    if (c.instances > 1) {
      const before = await page.evaluate(() => window.__viewHooks.state().sliceIdx);
      check(`${tag}: playing stays on the clip on screen`, st.frame >= 0 && before === (await page.evaluate(() => window.__viewHooks.state().sliceIdx)), `clip ${before + 1}`);
      await page.evaluate((i) => window.__viewHooks.showSlice(i), (before + 1) % c.instances);
      await page.waitForFunction((b) => window.__video.cine() && window.__viewHooks.state().sliceIdx !== b, before, { timeout: 15000 }).catch(() => {});
      const cine2 = await page.evaluate(() => ({ cine: window.__video.cine(), state: window.__video.state(), slice: window.__viewHooks.state().sliceIdx }));
      check(`${tag}: another clip gets its own cine controls`, cine2.cine?.frames === c.frames && cine2.state.frame === 0 && cine2.slice !== before, JSON.stringify(cine2.state));
    }
    await page.screenshot({ path: `${SHOTS}${dev}-${c.name}.png` });
  }
  check(`${dev} cine: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
}

await runDevice("desktop");
await runDevice("phone");
await runCine("desktop");
await runCine("phone");
pageErrorCheck(browser, check);
await browser.close();

if (!keep) {
  for (const sh of [F.share, F.cine?.share].filter(Boolean)) await fetch(`${BASE}/api/shares/${sh.sid}`, { method: "DELETE", headers: { Authorization: `Bearer ${sh.token}` } });
}
writeFileSync(`${SHOTS}results.json`, JSON.stringify({ results, numbers }, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
