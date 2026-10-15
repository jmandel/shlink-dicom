// Scripted Chromium checks for the whole-slide view (web/view/wsi-view.ts).
//   bun web/view/wsi-tools/wsi-fixtures.ts brca-jpeg=<dir> ov-j2k=<dir>   (writes /tmp/wsi-fixtures.json)
//   node web/checks/wsi-checks.mjs [--only=<fixture>] [--skip-walk]
// For each slide: a desktop session over the link with the Bundle frame index and one without
// (zoom to full resolution on tissue, six pans, zoom out), tile pixels against a reference decode
// (web/view/wsi-tools/ref_tiles.py), keyboard, label sheet, then phone touch gestures.
// Screenshots go to docs/shots/wsi/, numbers to docs/shots/wsi/results.json.
import { chromium } from "playwright-core";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const BASE = process.env.BASE ?? "http://localhost:3333";
const SHOTS = new URL("../../docs/shots/wsi/", import.meta.url).pathname;
const ROOT = new URL("../../", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const F = JSON.parse(readFileSync("/tmp/wsi-fixtures.json", "utf8"));
const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice(7);
const skipWalk = args.includes("--skip-walk");

const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  landscape: { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

const results = [];
const numbers = {};
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium" });

async function newPage(dev) {
  const context = await browser.newContext(DEVICES[dev]);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("response", (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url().slice(0, 100)}`));
  await page.addInitScript(() => {
    window.__longTasks = [];
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__longTasks.push(Math.round(e.duration)))).observe({ type: "longtask", buffered: true });
    } catch {}
  });
  return { context, page, errors };
}

const idle = (page, timeout = 300000) => page.waitForFunction(() => window.__wsi?.idle(), null, { timeout, polling: 50 });
const stats = (page) => page.evaluate(() => window.__wsi.stats());
const view = (page) => page.evaluate(() => window.__wsi.view());

async function openSlide(page, link) {
  await page.goto(`${BASE}/view#${link}`);
  await page.waitForSelector("#screen-overview:not(.hidden)", { timeout: 30000 });
  await page.waitForFunction(() => window.__view?.marks["first-thumb"], null, { timeout: 120000 });
  const tClick = await page.evaluate(() => performance.now());
  await page.locator(".study-open").first().click();
  await page.waitForFunction(() => window.__wsi?.active(), null, { timeout: 30000 });
  await idle(page);
  return tClick;
}

/** The darkest (most tissue-like) spot of the minimap, in base-level pixels. */
const tissuePoint = (page) =>
  page.evaluate(() => {
    const c = document.querySelector(".wsi-mini");
    const g = c.getContext("2d").getImageData(0, 0, c.width, c.height);
    let best = 1e9, bx = 0, by = 0;
    const B = 6;
    for (let y = 0; y + B <= c.height; y += 2)
      for (let x = 0; x + B <= c.width; x += 2) {
        let s = 0;
        for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) {
          const k = ((y + j) * c.width + x + i) * 4;
          // Skip the blue viewport marker; tissue is pink/purple (red channel high relative to blue's excess).
          s += g.data[k + 2] > g.data[k] + 30 ? 765 : g.data[k] + g.data[k + 1];
        }
        if (s < best) [best, bx, by] = [s, x + B / 2, y + B / 2];
      }
    const p = window.__wsi.pyramid();
    return [Math.round((bx / c.width) * p.width), Math.round((by / c.height) * p.height)];
  });

/** A typical session: fit → full resolution on tissue → six half-screen pans → zoom out to fit. */
async function session(page, name, kind, shots) {
  const tNav = await openSlide(page, F[name][kind === "index" ? "indexLink" : "plainLink"]);
  const s0 = await stats(page);
  const marks = await page.evaluate(() => ({ view: window.__view.marks, wsi: window.__wsi.marks() }));
  const out = {
    fit: { bytes: s0.bytes, requests: s0.requests, tiles: s0.tilesDecoded },
    firstTileMs: Math.round(s0.firstTileMs),
    firstTileDrawnAfterClickMs: Math.round(s0.firstDrawMs),
    firstTileSinceNavigationMs: Math.round(marks.wsi.firstDecode),
    headersMs: Math.round(marks.wsi.headers - marks.wsi.sessionStart),
    totalBytes: s0.totalBytes,
  };
  if (shots) await page.waitForTimeout(250), await page.screenshot({ path: `${SHOTS}${name}-desktop-fit.png` });
  const [tx, ty] = await tissuePoint(page);
  let t = Date.now();
  const tSet = await page.evaluate(([x, y]) => (window.__wsi.setView(x, y, window.__wsi.view().dpr), performance.now()), [tx, ty]);
  await page.waitForFunction(() => window.__wsi.marks().level0, null, { timeout: 300000, polling: 20 });
  const firstDeep = Math.round((await page.evaluate(() => window.__wsi.marks().level0)) - tSet);
  await idle(page);
  const s1 = await stats(page);
  out.deepest = { firstTileMs: firstDeep, screenMs: Date.now() - t, bytes: s1.bytes, requests: s1.requests, byPurpose: s1.byPurpose, center: [tx, ty] };
  if (shots) await page.waitForTimeout(250), await page.screenshot({ path: `${SHOTS}${name}-desktop-deepest.png` });
  const pans = [];
  for (let i = 0; i < 6; i++) {
    t = Date.now();
    await page.evaluate((i) => {
      const v = window.__wsi.view();
      const dx = [1, 0, 1, 0, -1, 0][i] * (v.w / 2 / v.scale), dy = [0, 1, 0, 1, 0, -1][i] * (v.h / 2 / v.scale);
      window.__wsi.setView(v.cx + dx, v.cy + dy, v.scale);
    }, i);
    await idle(page);
    pans.push(Date.now() - t);
  }
  const s2 = await stats(page);
  out.pans = { ms: pans, bytes: s2.bytes, requests: s2.requests };
  // Zoom back out with the wheel, through the levels.
  await page.mouse.move(720, 450);
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(60);
  }
  await idle(page);
  const s3 = await stats(page);
  out.session = { bytes: s3.bytes, requests: s3.requests, tiles: s3.tilesDecoded, fraction: s3.fraction, byPurpose: s3.byPurpose, level: s3.level };
  out.longTasks = await page.evaluate(() => window.__longTasks);
  return out;
}

for (const name of Object.keys(F)) {
  if (only && name !== only) continue;
  numbers[name] = { totalBytes: F[name].totalBytes, ciphertextBytes: F[name].ciphertextBytes, frameIndex: F[name].frameIndex };

  // ---------------------------------------------------------------- desktop, with the frame index
  {
    const { context, page, errors } = await newPage("desktop");
    const r = await session(page, name, "index", true);
    numbers[name].index = r;
    check(`${name} index: first tile shown`, r.firstTileMs > 0, `${r.firstTileMs} ms from first request; ${r.firstTileSinceNavigationMs} ms since navigation`);
    check(`${name} index: full resolution reached`, r.deepest.bytes > r.fit.bytes, `${r.deepest.firstTileMs} ms to first tile, ${r.deepest.screenMs} ms to full screen`);
    check(`${name} index: no walking`, r.session.byPurpose.walk.bytes === 0, JSON.stringify(r.session.byPurpose.walk));
    check(`${name} index: session fetched under 5% of the slide`, r.session.fraction < 0.05, `${(r.session.bytes / 1e6).toFixed(2)} MB of ${(r.totalBytes / 1e6).toFixed(1)} MB = ${(r.session.fraction * 100).toFixed(2)}%`);
    check(`${name} index: back at a coarse level after zooming out`, r.session.level >= 2, `level index ${r.session.level}`);
    const lt = Math.max(0, ...r.longTasks);
    check(`${name}: main thread stays responsive (longest task < 250 ms)`, lt < 250, `long tasks: ${r.longTasks.slice(0, 12).join(", ") || "none"}`);

    // Tiles against the reference decode: per level, the top-left and bottom-right tiles and two near tissue.
    const tiles = await page.evaluate(async ([cx, cy]) => {
      const p = window.__wsi.pyramid();
      const out = [];
      for (let k = 0; k < p.levels.length; k++) {
        const L = p.levels[k];
        const tx = Math.min(L.tilesAcross - 1, Math.floor(cx / L.downsample / L.tileWidth)), ty = Math.min(L.tilesDown - 1, Math.floor(cy / L.downsample / L.tileHeight));
        for (const [x, y] of [[0, 0], [L.tilesAcross - 1, L.tilesDown - 1], [tx, ty], [Math.max(0, tx - 1), ty]]) {
          const t = await window.__wsi.tilePixels(k, x, y);
          if (t) out.push({ ...t, level: k, tx: x, ty: y, columns: t.columns, rows: t.rows, spp: t.spp });
        }
      }
      return out;
    }, r.deepest.center);
    const tf = `/media/barracuda/shlink-dicom-slides/work/${name}-tiles.json`;
    mkdirSync("/media/barracuda/shlink-dicom-slides/work", { recursive: true });
    writeFileSync(tf, JSON.stringify(tiles));
    let refOut = "", refOk = false;
    try {
      refOut = execFileSync("uv", ["run", "--project", "codec-corpus", "python", "-I", "web/view/wsi-tools/ref_tiles.py", tf, F[name].dir], { cwd: ROOT, encoding: "utf8" });
      refOk = true;
    } catch (e) {
      refOut = String(e.stdout ?? e);
    }
    console.log(refOut.trim().split("\n").map((l) => "    " + l).join("\n"));
    check(`${name}: ${tiles.length} tiles match the reference decode`, refOk, refOut.trim().split("\n").pop());
    numbers[name].reference = refOut.trim().split("\n").pop();

    // Keyboard.
    await page.evaluate(() => window.__wsi.setView(window.__wsi.pyramid().width / 2, window.__wsi.pyramid().height / 2, window.__wsi.view().scale));
    await page.locator("#stage").focus();
    const v0 = await view(page);
    await page.keyboard.press("+");
    await page.keyboard.press("+");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(100);
    const v1 = await view(page);
    check(`${name}: keyboard zoom and pan`, v1.scale > v0.scale * 2 && v1.cx > v0.cx, `scale ${v0.scale.toFixed(4)} → ${v1.scale.toFixed(4)}, cx ${Math.round(v0.cx)} → ${Math.round(v1.cx)}`);
    await page.keyboard.press("0");
    await idle(page);

    // Label and glass slide.
    if (await page.locator("#btn-label:not(.hidden)").count()) {
      await page.locator("#btn-label").click();
      await page.waitForFunction(() => [...document.querySelectorAll("#label-images canvas")].every((c) => c.width > 300), null, { timeout: 30000 });
      await page.screenshot({ path: `${SHOTS}${name}-desktop-label.png` });
      check(`${name}: label and glass slide images shown`, true);
      await page.locator("#sheet-label [data-close]").click();
    } else check(`${name}: label button`, false, "no label or overview in the pyramid");
    // Overview card.
    await page.goBack();
    await page.waitForSelector("#screen-overview:not(.hidden)");
    await page.screenshot({ path: `${SHOTS}${name}-desktop-overview.png` });
    check(`${name} desktop: no console errors`, errors.length === 0, errors.slice(0, 5).join(" | "));
    await context.close();
  }

  // ---------------------------------------------------------------- desktop, without the frame index
  if (!skipWalk) {
    const { context, page, errors } = await newPage("desktop");
    const r = await session(page, name, "plain", false);
    numbers[name].walk = r;
    check(`${name} walk: full resolution reached by walking fragment headers`, r.deepest.byPurpose.walk.bytes > 0, `${(r.deepest.byPurpose.walk.bytes / 1e6).toFixed(1)} MB walked in ${r.deepest.screenMs} ms`);
    check(`${name} walk: no console errors`, errors.length === 0, errors.slice(0, 5).join(" | "));
    await context.close();
  }

  // ---------------------------------------------------------------- phone, touch
  {
    const { context, page, errors } = await newPage("phone");
    const cdp = await context.newCDPSession(page);
    await openSlide(page, F[name].indexLink);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}${name}-phone-fit.png` });
    const box = await page.locator(".wsi-canvas").boundingBox();
    const mx = box.x + box.width / 2, my = box.y + box.height / 2;
    const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    // Double tap zooms in 2×.
    let v0 = await view(page);
    await page.touchscreen.tap(mx, my);
    await page.waitForTimeout(80);
    await page.touchscreen.tap(mx, my);
    await page.waitForTimeout(150);
    let v1 = await view(page);
    check(`${name} phone: double tap zooms in`, Math.abs(v1.scale / v0.scale - 2) < 0.01, `${v0.scale.toFixed(5)} → ${v1.scale.toFixed(5)}`);
    // Pinch out (fingers apart) zooms in about the midpoint.
    v0 = v1;
    await touch("touchStart", [[mx - 30, my], [mx + 30, my]]);
    for (let i = 1; i <= 10; i++) await touch("touchMove", [[mx - 30 - i * 9, my], [mx + 30 + i * 9, my]]);
    await touch("touchEnd", []);
    await page.waitForTimeout(150);
    v1 = await view(page);
    check(`${name} phone: pinch zooms`, v1.scale > v0.scale * 3.5 && v1.scale < v0.scale * 4.5, `${v0.scale.toFixed(5)} → ${v1.scale.toFixed(5)} (fingers 60 → 240 px)`);
    // Drag pans.
    v0 = v1;
    await touch("touchStart", [[mx, my]]);
    for (let i = 1; i <= 8; i++) await touch("touchMove", [[mx - i * 15, my - i * 10]]);
    await touch("touchEnd", []);
    await page.waitForTimeout(150);
    v1 = await view(page);
    const dxCss = (v1.cx - v0.cx) * v1.scale / v1.dpr;
    check(`${name} phone: drag pans with the finger`, Math.abs(dxCss - 120) < 3, `moved ${dxCss.toFixed(1)} CSS px for a 120 px drag`);
    // Minimap tap moves there.
    const mb = await page.locator(".wsi-mini").boundingBox();
    await page.touchscreen.tap(mb.x + mb.width * 0.25, mb.y + mb.height * 0.5);
    await page.waitForTimeout(150);
    const p = await page.evaluate(() => window.__wsi.pyramid());
    v1 = await view(page);
    check(`${name} phone: minimap tap moves the view`, Math.abs(v1.cx - p.width * 0.25) < p.width * 0.02, `cx ${Math.round(v1.cx)} of ${p.width}`);
    // Full resolution on tissue.
    await page.evaluate(() => window.__wsi.setView(window.__wsi.pyramid().width / 2, window.__wsi.pyramid().height / 2, window.__wsi.view().scale));
    await idle(page);
    const [tx, ty] = await tissuePoint(page);
    await page.evaluate(([x, y]) => window.__wsi.setView(x, y, window.__wsi.view().dpr * 0.75), [tx, ty]);
    await idle(page);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}${name}-phone-deepest.png` });
    const s = await stats(page);
    check(`${name} phone: full resolution on tissue`, s.level === 0, `level ${s.level}; ${(s.bytes / 1e6).toFixed(2)} MB = ${(s.fraction * 100).toFixed(2)}%`);
    numbers[name].phone = { bytes: s.bytes, fraction: s.fraction, tiles: s.tilesDecoded, requests: s.requests };
    const lay = await page.evaluate(() => {
      const small = [];
      for (const el of document.querySelectorAll("#toolbar button, #btn-back, #btn-trust, #btn-download")) {
        const b = el.getBoundingClientRect();
        if (b.width && (b.height < 43.5 || b.width < 43.5) && !el.closest(".hidden")) small.push(`${el.id} ${Math.round(b.width)}×${Math.round(b.height)}`);
      }
      return { overflow: document.documentElement.scrollWidth - innerWidth, small };
    });
    check(`${name} phone: no horizontal overflow, targets ≥ 44 px`, lay.overflow <= 0 && !lay.small.length, JSON.stringify(lay));
    await page.locator("#btn-label").tap();
    await page.waitForFunction(() => [...document.querySelectorAll("#label-images canvas")].every((c) => c.width > 300), null, { timeout: 30000 });
    await page.screenshot({ path: `${SHOTS}${name}-phone-label.png` });
    check(`${name} phone: no console errors`, errors.length === 0, errors.slice(0, 5).join(" | "));
    await context.close();
  }
  {
    const { context, page, errors } = await newPage("landscape");
    await openSlide(page, F[name].indexLink);
    await page.screenshot({ path: `${SHOTS}${name}-landscape-fit.png` });
    check(`${name} landscape: opens without errors`, errors.length === 0, errors.slice(0, 5).join(" | "));
    await context.close();
  }
}

await browser.close();
writeFileSync(`${SHOTS}results.json`, JSON.stringify({ when: new Date().toISOString(), numbers, results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
