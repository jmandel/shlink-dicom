// Scripted Chromium checks for the whole-slide view (web/view/wsi-view.ts).
//   bun web/view/wsi-tools/wsi-fixtures.ts brca-jpeg=<dir> ov-j2k=<dir>   (writes /tmp/wsi-fixtures.json)
//   node web/checks/wsi-checks.mjs [--only=<fixture>] [--skip-walk]
// For each slide: a desktop session over the link packed with offset tables added and one packed
// as the files are
// (zoom to full resolution on tissue, six pans, zoom out), tile pixels against a reference decode
// (web/view/wsi-tools/ref_tiles.py), keyboard, label sheet, then phone touch gestures.
// Screenshots go to docs/shots/wsi/, numbers to docs/shots/wsi/results.json.
import { launchBrowser, pageErrorCheck } from "./browser.mjs";
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

const browser = await launchBrowser();

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
  const tNav = await openSlide(page, F[name][kind === "tables" ? "tablesLink" : "plainLink"]);
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

// Brightfield sessions: streaming, bytes, tiles against the reference, gestures.
const BRIGHTFIELD = ["brca-jpeg", "ov-j2k", "luad-1gb"];
for (const name of BRIGHTFIELD) {
  if (!F[name] || (only && name !== only)) continue;
  numbers[name] = { totalBytes: F[name].totalBytes, ciphertextBytes: F[name].ciphertextBytes, withTables: F[name].withTables };

  // ---------------------------------------------------------------- desktop, offset tables added by the packer
  {
    const { context, page, errors } = await newPage("desktop");
    const r = await session(page, name, "tables", true);
    numbers[name].tables = r;
    check(`${name} tables: first tile shown`, r.firstTileMs > 0, `${r.firstTileMs} ms from first request; ${r.firstTileSinceNavigationMs} ms since navigation`);
    check(`${name} tables: full resolution reached`, r.deepest.bytes > r.fit.bytes, `${r.deepest.firstTileMs} ms to first tile, ${r.deepest.screenMs} ms to full screen`);
    check(`${name} tables: no walking`, r.session.byPurpose.walk.bytes === 0, JSON.stringify(r.session.byPurpose.walk));
    check(`${name} tables: session fetched under 5% of the slide`, r.session.fraction < 0.05, `${(r.session.bytes / 1e6).toFixed(2)} MB of ${(r.totalBytes / 1e6).toFixed(1)} MB = ${(r.session.fraction * 100).toFixed(2)}%`);
    check(`${name} tables: back at a coarse level after zooming out`, r.session.level >= 2, `level index ${r.session.level}`);
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

  // ---------------------------------------------------------------- desktop, files as they are (walking)
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
    await openSlide(page, F[name].tablesLink);
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
    await openSlide(page, F[name].tablesLink);
    await page.screenshot({ path: `${SHOTS}${name}-landscape-fit.png` });
    check(`${name} landscape: opens without errors`, errors.length === 0, errors.slice(0, 5).join(" | "));
    await context.close();
  }
}

// ------------------------------------------------------------------------------------- features
// Workstream D: focal planes, optical paths, TILED_SPARSE, annotations, segmentations, ICC, JPEG XL.
// Each section runs on desktop and phone. Fixtures: web/view/WSI.md, "Feature test data".

const SRGB = "/media/barracuda/shlink-dicom-slides/work/icc-srgb.icc";

/** Compares tiles with the reference decode (ref_tiles.py); returns the summary line. */
function reference(name, tiles, dir) {
  const tf = `/media/barracuda/shlink-dicom-slides/work/${name}-tiles.json`;
  writeFileSync(tf, JSON.stringify(tiles));
  try {
    const out = execFileSync("uv", ["run", "--project", "codec-corpus", "python", "-I", "web/view/wsi-tools/ref_tiles.py", tf, dir, SRGB], { cwd: ROOT, encoding: "utf8" });
    console.log(out.trim().split("\n").map((l) => "    " + l).join("\n"));
    return { ok: true, line: out.trim().split("\n").pop() };
  } catch (e) {
    const out = String(e.stdout ?? e);
    console.log(out.trim().split("\n").map((l) => "    " + l).join("\n"));
    return { ok: false, line: out.trim().split("\n").pop() };
  }
}

const tile = (page, ...a) => page.evaluate((a) => window.__wsi.tilePixels(...a), a);
const centreSum = (page) =>
  page.evaluate(() => {
    const v = window.__wsi.view();
    const c = document.querySelector(".wsi-canvas").getBoundingClientRect();
    let s = 0;
    for (let i = 0; i < 9; i++) {
      const p = window.__wsi.pixelAt(c.left + c.width * (0.3 + 0.05 * i), c.top + c.height * 0.5);
      s += p[0] + p[1] + p[2];
    }
    return s;
  });
const shot = (page, n) => page.waitForTimeout(250).then(() => page.screenshot({ path: `${SHOTS}${n}.png` }));
const want = (n) => !only || only === n || only === "features";

async function layout(page, label, dev) {
  const lay = await page.evaluate(() => {
    const small = [];
    for (const el of document.querySelectorAll("#toolbar button, #toolbar input, #sheet-wsi-layers:not(.hidden) input, #sheet-wsi-layers:not(.hidden) button")) {
      const b = el.getBoundingClientRect();
      if (!b.width || el.closest(".hidden")) continue;
      if (el.type === "checkbox") continue; // checkboxes sit in a full-height label row
      if (b.height < 31.5) small.push(`${el.id || el.type} ${Math.round(b.width)}×${Math.round(b.height)}`);
    }
    return { overflow: document.documentElement.scrollWidth - innerWidth, small };
  });
  check(`${label}: no horizontal overflow`, lay.overflow <= 0, JSON.stringify(lay));
}

// Fluorescence: 12 channels, one per instance (real HTAN-OHSU data); 16-bit; three paths in one instance.
for (const [name, dev] of [["fluor-ohsu", "desktop"], ["fluor-ohsu", "phone"], ["fluor-16bit", "desktop"], ["fluor-3path", "desktop"]]) {
  if (!F[name] || !want(name)) continue;
  const P = `${name} ${dev}`;
  const { context, page, errors } = await newPage(dev);
  await openSlide(page, F[name].tablesLink);
  const pyr = await page.evaluate(() => window.__wsi.pyramid());
  const disp = await page.evaluate(() => window.__wsi.display());
  const visible = disp.channels.filter((c) => c.visible).length;
  check(`${P}: ${pyr.paths.length} channels, ${visible} shown at first`, pyr.monochrome && pyr.paths.length > 1 && visible === Math.min(4, pyr.paths.length), pyr.paths.join(", "));
  const nuc = pyr.paths.findIndex((l) => /nucle|dapi|hoechst/i.test(l));
  if (nuc >= 0) check(`${P}: nuclear channel drawn in blue`, JSON.stringify(disp.channels[nuc].color) === "[0,90,255]", JSON.stringify(disp.channels[nuc]));
  await shot(page, `${name}-${dev}-fit`);
  // The Channels sheet: rows, then switch one channel off by tapping its checkbox.
  await page.locator("#btn-wsi-layers").click();
  await page.waitForSelector("#sheet-wsi-layers:not(.hidden)");
  const rows = await page.locator("#sheet-wsi-layers [data-channel]").count();
  check(`${P}: one row per channel`, rows === pyr.paths.length, `${rows}`);
  await shot(page, `${name}-${dev}-channels`);
  await layout(page, `${P} channels sheet`, dev);
  const before = await centreSum(page);
  const first = disp.channels.findIndex((c) => c.visible);
  await page.locator(`#sheet-wsi-layers [data-channel="${first}"] input[type=checkbox]`).click();
  await idle(page);
  await page.waitForTimeout(150);
  const after = await centreSum(page);
  const d2 = await page.evaluate(() => window.__wsi.display());
  check(`${P}: switching a channel off changes the picture`, !d2.channels[first].visible && after !== before, `centre sum ${before} → ${after}`);
  await page.locator("#sheet-wsi-layers .sheet-close").click();
  // Intensity: doubling every visible channel brightens the picture.
  const b0 = await centreSum(page);
  await page.evaluate(() => window.__wsi.display().channels.forEach((c, k) => c.visible && window.__wsi.setChannel(k, { gain: 2 })));
  await page.waitForTimeout(200);
  const b1 = await centreSum(page);
  check(`${P}: intensity 200% brightens`, b1 > b0, `${b0} → ${b1}`);
  await page.evaluate(() => window.__wsi.display().channels.forEach((c, k) => window.__wsi.setChannel(k, { gain: 1, visible: k < 4 })));
  // Full resolution at the centre; bytes per visible channel.
  await page.evaluate(() => { const p = window.__wsi.pyramid(); window.__wsi.setView(p.width / 2, p.height / 2, window.__wsi.view().dpr); });
  await idle(page);
  const st = await stats(page);
  numbers[name] = { ...(numbers[name] ?? {}), [dev]: { bytes: st.bytes, fraction: st.fraction, tiles: st.tilesDecoded } };
  check(`${P}: full resolution with ${Math.min(4, pyr.paths.length)} channels`, st.level === 0, `${(st.bytes / 1e6).toFixed(2)} MB of ${(st.totalBytes / 1e6).toFixed(1)} MB (${(st.fraction * 100).toFixed(1)}%)`);
  await shot(page, `${name}-${dev}-deepest`);
  if (dev === "desktop") {
    const tiles = [];
    for (const path of [0, Math.floor(pyr.paths.length / 2), pyr.paths.length - 1])
      for (const level of [0, pyr.levels.length - 1]) {
        const t = await tile(page, level, 0, 0, 0, path);
        if (t && !t.absent) tiles.push({ ...t, level, tx: 0, ty: 0, plane: 0, path });
      }
    const r = reference(name, tiles, F[name].dir);
    check(`${P}: ${tiles.length} channel tiles match the reference decode`, r.ok, r.line);
  }
  check(`${P}: no console errors`, errors.length === 0, errors.slice(0, 5).join(" | "));
  await context.close();
}

// Focal planes: TILED_SPARSE with Z offsets in µm (sparse-z); TILED_FULL with planes in one instance (full-z).
for (const [name, dev] of [["sparse-z", "desktop"], ["sparse-z", "phone"], ["full-z", "desktop"]]) {
  if (!F[name] || !want(name)) continue;
  const P = `${name} ${dev}`;
  const { context, page, errors } = await newPage(dev);
  await openSlide(page, F[name].tablesLink);
  const pyr = await page.evaluate(() => window.__wsi.pyramid());
  check(`${P}: three focal planes`, pyr.planes.length === 3, `${JSON.stringify(pyr.planes)} (${pyr.planesInMicrons ? "µm" : "plane numbers"})`);
  if (name === "sparse-z") check(`${P}: TILED_SPARSE levels`, pyr.levels.every((l) => l.sparse), pyr.levels.map((l) => l.sparse).join(","));
  check(`${P}: focus control shown`, await page.locator(".wsi-focus:not(.hidden)").count() === 1);
  const [tx, ty] = await tissuePoint(page);
  await page.evaluate(([x, y]) => window.__wsi.setView(x, y, window.__wsi.view().dpr), [tx, ty]);
  await idle(page);
  await shot(page, `${name}-${dev}-plane-mid`);
  const mid = await centreSum(page);
  // Move focus with the control (desktop: keyboard on the slider; phone: tap near its left end).
  if (dev === "desktop") {
    await page.locator("#wsi-focus").focus();
    await page.keyboard.press("Home");
  } else {
    const b = await page.locator("#wsi-focus").boundingBox();
    await page.touchscreen.tap(b.x + 6, b.y + b.height / 2);
  }
  await page.waitForFunction(() => window.__wsi.display().plane === 0, null, { timeout: 5000 });
  await idle(page);
  await shot(page, `${name}-${dev}-plane-0`);
  const top = await centreSum(page);
  const label = await page.textContent(".wsi-focus .mono");
  check(`${P}: focus moved to plane 1 and the picture changed`, top !== mid, `${label.trim()}; centre sum ${mid} → ${top}`);
  const st = await stats(page);
  check(`${P}: no walking, offsets from the file's tables`, st.byPurpose.walk.bytes === 0, `${(st.bytes / 1e6).toFixed(2)} MB of ${(st.totalBytes / 1e6).toFixed(1)} MB`);
  if (dev === "desktop") {
    // Keyboard: Page Up moves focus one plane.
    await page.locator("#stage").focus();
    await page.keyboard.press("PageUp");
    const z = await page.evaluate(() => window.__wsi.display().plane);
    check(`${P}: Page Up moves focus`, z === 1, `plane ${z}`);
    // Tiles of every plane against the reference; and a sparse tile left out of the file is reported absent.
    const L = pyr.levels[0];
    const tiles = [];
    const cx = Math.floor(tx / L.tileWidth), cy = Math.floor(ty / L.tileHeight);
    for (const plane of [0, 1, 2]) {
      const t = await tile(page, 0, cx, cy, plane, 0);
      if (t && !t.absent) tiles.push({ ...t, level: 0, tx: cx, ty: cy, plane, path: 0 });
    }
    const t1 = await tile(page, 1, 0, 0, 2, 0);
    if (t1 && !t1.absent) tiles.push({ ...t1, level: 1, tx: 0, ty: 0, plane: 2, path: 0 });
    const r = reference(name, tiles, F[name].dir);
    check(`${P}: ${tiles.length} tiles of three planes match the reference decode`, r.ok && tiles.length === 4, r.line);
    if (name === "sparse-z") {
      let absent = null;
      for (let y = 0; y < L.tilesDown && !absent; y++)
        for (let x = 0; x < L.tilesAcross && !absent; x++) {
          const a = await tile(page, 0, x, y, 1, 0);
          if (a?.absent) absent = [x, y];
        }
      check(`${P}: background tiles are absent from the file and left empty`, !!absent, `first absent tile ${JSON.stringify(absent)}`);
    }
  }
  check(`${P}: no console errors`, errors.length === 0, errors.slice(0, 5).join(" | "));
  await context.close();
}

// Annotations and segmentations: TCGA-05-5425 DX1 with Bulk Simple Annotations (9,856 nuclei) and four SEG series.
for (const dev of ["desktop", "phone"]) {
  const name = "ann-seg";
  if (!F[name] || !want(name)) continue;
  const P = `${name} ${dev}`;
  const { context, page, errors } = await newPage(dev);
  await openSlide(page, F[name].tablesLink);
  await page.waitForFunction(() => window.__wsi.layers().length >= 5, null, { timeout: 30000 });
  const s0 = await stats(page);
  let layers = await page.evaluate(() => window.__wsi.layers());
  check(`${P}: annotation and segmentation layers found`, layers.filter((l) => l.kind === "annotations").length === 1 && layers.filter((l) => l.kind === "segmentation").length === 4, layers.map((l) => `${l.kind}: ${l.title}`).join(" | "));
  check(`${P}: layers are not read until shown`, s0.layerBytes === 0, `${s0.layerBytes} bytes`);
  // Open the Layers sheet and switch annotations and the nuclei segmentation on by tapping.
  await page.locator("#btn-wsi-layers").click();
  await page.waitForSelector("#sheet-wsi-layers:not(.hidden)");
  const ann = layers.find((l) => l.kind === "annotations");
  const nuc = layers.find((l) => l.kind === "segmentation" && l.title === "Nuclei");
  await page.locator(`#sheet-wsi-layers [data-layer="${ann.id}"] input`).click();
  await page.locator(`#sheet-wsi-layers [data-layer="${nuc.id}"] input`).click();
  await page.waitForFunction(() => window.__wsi.layers().every((l) => !l.visible || l.state === "ready"), null, { timeout: 60000 });
  await shot(page, `${name}-${dev}-layers`);
  await layout(page, `${P} layers sheet`, dev);
  await page.locator("#sheet-wsi-layers .sheet-close").click();
  await idle(page);
  layers = await page.evaluate(() => window.__wsi.layers());
  const a2 = layers.find((l) => l.id === ann.id);
  check(`${P}: 9,856 nucleus polygons drawn at fit`, a2.drawn === 9856, `${a2.drawn} drawn; ${a2.detail}`);
  // Zoom on the first polygon: its outline is drawn in the annotation colour.
  await page.evaluate(() => window.__wsi.setView(3495, 389, window.__wsi.view().dpr * 2));
  await idle(page);
  await shot(page, `${name}-${dev}-zoom`);
  const box = await page.locator(".wsi-canvas").boundingBox();
  // The outline is anti-aliased: look for the annotation colour within 3 CSS pixels of the vertex.
  const px = await page.evaluate(([x, y]) => {
    let best = null;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const p = window.__wsi.pixelAt(x + dx, y + dy);
      if (p[0] > 200 && p[1] > 170 && p[2] < 80) best = p;
    }
    return best;
  }, [box.x + box.width / 2, box.y + box.height / 2]);
  check(`${P}: polygon outline drawn where the annotation is`, !!px, `annotation colour near the first point of the first polygon: ${JSON.stringify(px)}`);
  const st = await stats(page);
  check(`${P}: overlays add their own bytes only`, st.layerBytes > 0, `slide ${(st.bytes / 1e6).toFixed(2)} MB; layers ${(st.layerBytes / 1e6).toFixed(2)} MB`);
  numbers[name] = { ...(numbers[name] ?? {}), [dev]: { slideBytes: st.bytes, layerBytes: st.layerBytes } };
  if (dev === "desktop") {
    // Segmentation tiles (1-bit) against pydicom, and the two-segment TIL map (frames packed mid-byte).
    const til = layers.find((l) => l.title.includes("CNN"));
    await page.evaluate((id) => window.__wsi.setLayer(id, true), til.id);
    await page.waitForFunction((id) => window.__wsi.layers().find((l) => l.id === id).state === "ready", til.id, { timeout: 30000 });
    await idle(page);
    const tiles = [];
    for (const [lid, level, tx, ty, path] of [[nuc.id, 0, 13, 1, 0], [nuc.id, 1, 0, 0, 0], [til.id, 0, 0, 0, 0], [til.id, 0, 0, 0, 1]]) {
      const t = await page.evaluate((a) => window.__wsi.tilePixels(...a), [level, tx, ty, 0, path, lid]);
      if (t && !t.absent) tiles.push({ ...t, level, tx, ty, plane: 0, path });
    }
    const r = reference(name, tiles, F[name].dir);
    check(`${P}: ${tiles.length} segmentation tiles match pydicom`, r.ok && tiles.length === 4, r.line);
  }
  check(`${P}: no console errors`, errors.length === 0, errors.slice(0, 5).join(" | "));
  await context.close();
}

// ICC: the ScanScope v1 profile (lut16, Lab) applied to each tile, against lcms2; and switching it off.
for (const name of ["brca-jpeg"]) {
  if (!F[name] || !want("icc")) continue;
  const P = `${name} icc`;
  const { context, page, errors } = await newPage("desktop");
  await openSlide(page, F[name].tablesLink);
  const icc = await page.evaluate(() => window.__wsi.icc());
  check(`${P}: profile found and applied`, icc.available && icc.on, JSON.stringify(icc));
  const tiles = [];
  for (const [level, tx, ty] of [[3, 2, 3], [3, 9, 5], [2, 5, 7]]) {
    const t = await page.evaluate((a) => window.__wsi.tileRgb(...a), [level, tx, ty]);
    const raw = await tile(page, level, tx, ty);
    tiles.push({ ...raw, b64: t.b64, rows: t.height, columns: t.width, spp: 3, level, tx, ty, icc: true });
  }
  const r = reference(`${name}-icc`, tiles, F[name].dir);
  check(`${P}: corrected tiles match lcms2`, r.ok, r.line);
  await page.evaluate(() => window.__wsi.setIcc(false));
  await idle(page);
  const off = await page.evaluate((a) => window.__wsi.tileRgb(...a), [3, 2, 3]);
  const raw = await tile(page, 3, 2, 3);
  const r2 = reference(`${name}-icc-off`, [{ ...raw, b64: off.b64, level: 3, tx: 2, ty: 3 }], F[name].dir);
  check(`${P}: switched off, tiles are the stored pixels`, r2.ok, r2.line);
  check(`${P}: no console errors`, errors.length === 0, errors.slice(0, 5).join(" | "));
  await context.close();
}

// JPEG XL: lossless, lossy and JPEG recompression slides (built from TCGA DX1 and BS2).
for (const name of ["jxl-lossless", "jxl-lossy", "jxl-recompress"]) {
  if (!F[name] || !want(name) && only !== "jxl") continue;
  const P = `${name} desktop`;
  const { context, page, errors } = await newPage("desktop");
  await openSlide(page, F[name].tablesLink);
  const msg = await page.evaluate(() => window.__wsi.message());
  const st = await stats(page);
  check(`${P}: tiles decode`, !msg && st.tilesDecoded > 0, msg ?? `${st.tilesDecoded} tiles`);
  await shot(page, `${name}-desktop-fit`);
  const pyr = await page.evaluate(() => window.__wsi.pyramid());
  const tiles = [];
  for (const [level, tx, ty] of [[pyr.levels.length - 1, 0, 0], [pyr.levels.length - 1, 1, 1], [0, 5, 3]]) {
    const t = await tile(page, level, tx, ty);
    if (t && !t.absent) tiles.push({ ...t, level, tx, ty });
  }
  const r = reference(name, tiles, F[name].dir);
  check(`${P}: ${tiles.length} tiles match libjxl`, r.ok, r.line);
  check(`${P}: no console errors`, errors.length === 0, errors.slice(0, 5).join(" | "));
  await context.close();
}

// Slides without offset tables on a slow connection: the walk is shown, not frozen.
// 20 Mbit/s via CDP; the plain brca-jpeg link (no tables). Gates: progress shown within 500 ms
// of zooming in, its text changes at least every second, no main-thread task over 100 ms, and
// pan and zoom answered (on the next frame) while the walk goes on.
for (const dev of ["desktop", "phone"]) {
  const name = "brca-jpeg";
  if (!F[name] || !want("throttled")) continue;
  const P = `${name} no tables, 20 Mbit/s, ${dev}`;
  const { context, page, errors } = await newPage(dev);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 40, downloadThroughput: 20e6 / 8, uploadThroughput: 5e6 / 8 });
  await openSlide(page, F[name].plainLink);
  const notice = await page.evaluate(() => window.__wsi.notice());
  check(`${P}: the slide's info says it has no offset table`, notice === "This slide has no frame offset table, so the viewer has to read ahead to find tiles. Adding tables when sharing avoids this.", notice ?? "not shown");
  const [tx, ty] = await tissuePoint(page);
  // Sample the progress text every 100 ms, and long tasks from here on.
  const t0 = await page.evaluate(([x, y]) => {
    window.__samples = [];
    window.__lt = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push([Math.round(e.startTime), Math.round(e.duration)]))).observe({ type: "longtask" });
    const t = performance.now();
    window.__sampler = setInterval(() => window.__samples.push([Math.round(performance.now() - t), window.__wsi.progress()]), 100);
    window.__wsi.setView(x, y, window.__wsi.view().dpr);
    return t;
  }, [tx, ty]);
  // Pan and zoom while the walk goes on: time from the input to the next frame showing the change.
  const answer = async (send) => {
    await page.evaluate(() => {
      window.__in = null;
      window.__out = null;
      const v0 = JSON.stringify(window.__wsi.view());
      for (const t of ["wheel", "pointermove", "touchmove"]) addEventListener(t, () => (window.__in ??= performance.now()), { capture: true, once: true });
      const tick = () => (JSON.stringify(window.__wsi.view()) !== v0 ? (window.__out = performance.now()) : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });
    await send();
    await page.waitForTimeout(600);
    const r = await page.evaluate(() => [window.__in, window.__out, window.__wsi.progress()]);
    return { ms: r[0] && r[1] ? Math.round(r[1] - r[0]) : null, progress: r[2] };
  };
  await page.waitForTimeout(2500);
  const box = await page.locator(".wsi-canvas").boundingBox();
  const mx = box.x + box.width / 2, my = box.y + box.height / 2;
  let pan, zoom;
  if (dev === "desktop") {
    pan = await answer(async () => { await page.mouse.move(mx, my); await page.mouse.down(); await page.mouse.move(mx - 80, my - 40, { steps: 4 }); await page.mouse.up(); });
    zoom = await answer(async () => { await page.mouse.move(mx, my); await page.mouse.wheel(0, 120); });
  } else {
    const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    pan = await answer(async () => { await touch("touchStart", [[mx, my]]); for (let i = 1; i <= 4; i++) await touch("touchMove", [[mx - i * 20, my - i * 10]]); await touch("touchEnd", []); });
    zoom = await answer(async () => { await touch("touchStart", [[mx - 30, my], [mx + 30, my]]); for (let i = 1; i <= 4; i++) await touch("touchMove", [[mx - 30 + i * 4, my], [mx + 30 - i * 4, my]]); await touch("touchEnd", []); });
  }
  await page.waitForTimeout(12000 - 2500 - 1200);
  const { samples, lt } = await page.evaluate((t0) => {
    clearInterval(window.__sampler);
    return { samples: window.__samples, lt: window.__lt.filter(([t]) => t >= t0).map(([, d]) => d) };
  }, t0);
  const shown = samples.filter(([, p]) => p);
  const firstAt = shown.length ? shown[0][0] : null;
  let gap = 0, last = null, lastT = null, gapAt = null;
  const walkSamples = samples.filter(([, p]) => p && p.startsWith("Finding tiles"));
  for (const [t, p] of walkSamples) {
    if (p !== last) {
      if (lastT !== null && t - lastT > gap) (gap = t - lastT), (gapAt = `${lastT}–${t} ms: "${last}" → "${p}"`);
      last = p;
      lastT = t;
    }
  }
  const st = await stats(page);
  check(`${P}: progress shown within 500 ms`, firstAt !== null && firstAt <= 500, `first at ${firstAt} ms: "${shown[0]?.[1]}"`);
  check(`${P}: the walk is shown and its text changes at least every second`, walkSamples.length > 20 && gap <= 1000, `${walkSamples.length} samples while finding tiles, longest gap ${gap} ms (${gapAt}); last "${walkSamples.at(-1)?.[1]}"; ${(st.byPurpose.walk.bytes / 1e6).toFixed(1)} MB walked in 12 s`);
  check(`${P}: no main-thread task over 100 ms`, Math.max(0, ...lt) <= 100, `long tasks: ${lt.join(", ") || "none"}`);
  check(`${P}: pan answered during the walk`, pan.ms !== null && pan.ms < 250 && /Finding tiles/.test(pan.progress ?? ""), JSON.stringify(pan));
  check(`${P}: zoom answered during the walk`, zoom.ms !== null && zoom.ms < 250 && /Finding tiles/.test(zoom.progress ?? ""), JSON.stringify(zoom));
  await shot(page, `${name}-${dev}-walking`);
  numbers.throttled = { ...(numbers.throttled ?? {}), [dev]: { firstProgressMs: firstAt, longestGapMs: gap, longTasks: lt, pan, zoom, walked12s: st.byPurpose.walk.bytes } };
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  check(`${P}: no console errors`, errors.length === 0, errors.slice(0, 5).join(" | "));
  await context.close();
}

// Toolbar controls belong to their mode: on the public sample (Josh Example), the slide shows only
// slide controls, and the CT, MRI and X-ray studies show none of them, also after the slide was open.
for (const dev of ["desktop", "phone"]) {
  if (!want("toolbar")) continue;
  const P = `toolbar ${dev}`;
  const demos = await (await fetch(`${BASE}/api/demo-shares`)).json();
  const sample = demos.shares.find((d) => !d.passcodeHint);
  const { context, page, errors } = await newPage(dev);
  await page.goto(`${BASE}/view#${sample.shlinkUri.split("#")[1]}`);
  await page.waitForSelector("#screen-overview:not(.hidden)", { timeout: 30000 });
  const titles = await page.locator(".study-open .study-title").allTextContents();
  const visibleControls = () =>
    page.evaluate(() => {
      const shown = (e) => e.offsetParent !== null && getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden";
      const out = [];
      for (const e of document.querySelectorAll("#toolbar > *, #toolbar .tool-btns > *")) {
        if (e.classList.contains("tool-btns") || e.tagName === "LABEL" && e.classList.contains("sr-only")) continue;
        if (shown(e)) out.push(e.id || e.className.split(" ")[0]);
      }
      return out;
    });
  const open = async (i) => {
    await page.locator(".study-open").nth(i).click();
    await page.waitForSelector("#screen-viewer:not(.hidden)", { timeout: 30000 });
    await page.waitForFunction(() => window.__wsi?.active() || (document.querySelector("#stage-busy")?.classList.contains("hidden") && window.__view?.marks["first-slice"]), null, { timeout: 60000 });
    await page.waitForTimeout(800);
    return { slide: await page.evaluate(() => window.__wsi.active()), controls: await visibleControls() };
  };
  const back = async () => {
    await page.locator("#btn-back").click();
    await page.waitForSelector("#screen-overview:not(.hidden)", { timeout: 30000 });
  };
  const SLIDE_ONLY = ["btn-label", "btn-wsi-layers", "wsi-focus"];
  const NOT_ON_SLIDES = ["slice-ctl", "preset", "view-plane", "btn-layers", "measure-tool", "play-bar"];
  // The slide first, so the other studies are opened after slide mode has been left.
  let order = titles.map((_, i) => i);
  const results = [];
  for (const i of order) {
    const r = await open(i);
    results.push({ title: titles[i], ...r });
    await back();
  }
  const slideIdx = results.findIndex((r) => r.slide);
  if (slideIdx > 0) {
    // Re-open: the slide, then every other study.
    order = [slideIdx, ...order.filter((i) => i !== slideIdx)];
    results.length = 0;
    for (const i of order) {
      const r = await open(i);
      results.push({ title: titles[i], ...r });
      await back();
    }
  }
  const slide = results.find((r) => r.slide);
  check(`${P}: the lung slide shows its glass-slide button and no radiology or video controls`, !!slide && slide.controls.includes("btn-label") && !slide.controls.some((c) => NOT_ON_SLIDES.includes(c)), slide ? `${slide.title}: ${slide.controls.join(", ")}` : "no slide in the sample");
  for (const r of results.filter((x) => !x.slide)) {
    check(`${P}: ${r.title} shows no slide controls`, !r.controls.some((c) => SLIDE_ONLY.includes(c)), r.controls.join(", "));
  }
  await page.screenshot({ path: `${SHOTS}toolbar-${dev}-last.png` });
  check(`${P}: no console errors`, errors.length === 0, errors.slice(0, 5).join(" | "));
  await context.close();
}

pageErrorCheck(browser, check);

await browser.close();
writeFileSync(`${SHOTS}results.json`, JSON.stringify({ when: new Date().toISOString(), numbers, results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
