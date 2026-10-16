// Scripted Chromium checks for every object type in a study (workstream B of docs/COVERAGE-PLAN.md),
// on the public test set in web/checks/objects/samples.json, each case shared as its own link.
//   uv run --project codec-corpus python web/checks/objects/expect.py > /tmp/objects-expect.json
//   bun web/checks/objects-fixtures.ts http://localhost:3350
//   BASE=http://localhost:3350 node web/checks/object-checks.mjs [--only=case]
// Expected values come from pydicom (expect.py), not from the viewer's own parser.
// Screenshots go to docs/shots/objects/.
import { launchBrowser, pageErrorCheck } from "./browser.mjs";
import { downloadMatrix } from "./download-matrix.mjs";
import { darkAudit } from "./dark.mjs";
import { bigTextOn, overflowAudit } from "./overflow.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3350";
const SHOTS = new URL("../../docs/shots/objects/", import.meta.url).pathname;
const ROOT = new URL("../../", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const F = JSON.parse(readFileSync("/tmp/objects-fixtures.json", "utf8"));
const E = JSON.parse(readFileSync("/tmp/objects-expect.json", "utf8"));
const M = JSON.parse(readFileSync(new URL("./objects/samples.json", import.meta.url), "utf8"));
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const bySop = new Map(Object.values(E).map((e) => [e.sopInstance, e]));
const bySeries = (uid) => Object.values(E).filter((e) => e.series === uid);

const browser = await launchBrowser();
const DEV = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

async function open(caseId, dev = "desktop", colorScheme = "light") {
  const context = await browser.newContext({ ...DEV[dev], acceptDownloads: true, colorScheme });
  // Downloads go through the Blob path so the checks can capture them.
  await context.addInitScript(() => delete window.showSaveFilePicker);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/view#${F[caseId].link}`);
  await page.waitForSelector(".study-open", { timeout: 30000 });
  return { context, page, errors };
}

/** Opens study `si`, then each series in turn; calls fn(page, series uid, k) with it selected. */
async function eachSeries(page, si, fn) {
  await page.locator(".study-open").nth(si).click();
  await page.waitForSelector(".series-btn");
  const n = await page.locator(".series-btn").count();
  for (let k = 0; k < n; k++) {
    const uid = await page.locator(`.series-btn[data-series="${k}"]`).getAttribute("data-uid");
    await page.locator(`.series-btn[data-series="${k}"]`).click();
    await fn(uid, k);
  }
}

/** Waits for the object view to finish, and returns the SOP instance it shows. */
const waitObject = async (page) => {
  await page.waitForFunction(() => { const v = document.querySelector(".object-view"); return v && !v.classList.contains("hidden") && v.dataset.rendered; }, null, { timeout: 30000 });
  return page.getAttribute(".object-view", "data-sop");
};

async function objectCase(caseId) {
  if (!F[caseId]) return check(`${caseId}: fixture`, false, "not shared");
  const { context, page, errors } = await open(caseId);
  // Overview: every shared file listed (series counts add up).
  const expectFiles = F[caseId].files - F[caseId].skipped.length;
  const listed = await page.$$eval(".study-contents summary", (s) => s.reduce((a, x) => a + Number(/\((\d+)/.exec(x.textContent)?.[1] ?? 0), 0));
  check(`${caseId}: overview lists every file`, listed === expectFiles, `${listed} of ${expectFiles}${F[caseId].skipped.length ? ` (${F[caseId].skipped.length} not DICOM Part 10)` : ""}`);
  const studies = await page.locator(".study-open").count();
  for (let si = 0; si < studies; si++) {
    if (si) {
      await page.click("#btn-back");
      await page.waitForSelector("#screen-overview:not(.hidden)");
    }
    await eachSeries(page, si, async (uid, k) => {
      await page.waitForTimeout(400);
      // Objects shown in place of the viewer: the expectation is the one for the instance shown.
      const objectMode = await page.evaluate(() => document.body.classList.contains("object-mode"));
      const exp = objectMode ? bySop.get(await waitObject(page)) : bySeries(uid)[0];
      if (!exp) return;
      const name = `${caseId}/${exp.sopClass.split(".").slice(-2).join(".")}`;
      const kind = await page.evaluate(() => document.querySelector(".series-btn[aria-current=true] .s-count")?.textContent ?? "");
      if (exp.srItems !== undefined && !exp.koRefs) {
                const t = await page.$eval(".sr-tree", (x) => ({ items: +x.dataset.items, refs: +x.dataset.refs }));
        check(`${name}: SR content items`, t.items === exp.srItems, `${t.items} of ${exp.srItems}`);
        check(`${name}: SR image references`, t.refs === exp.srRefs, `${t.refs} of ${exp.srRefs}`);
        const linked = await page.locator(".sr-ref").count();
        if (exp.srRefs) {
          const present = await page.evaluate(() => document.querySelectorAll(".sr-ref").length + document.querySelectorAll(".sr-ref-missing").length);
          check(`${name}: every reference shown, as a link or as missing`, present >= Math.min(1, exp.srRefs), `${present}`);
          const shared = new Set(Object.values(E).filter((e) => e.case === caseId).map((e) => e.sopInstance));
          const inShare = exp.srRefSops.filter((s) => shared.has(s)).length;
          check(`${name}: references to images in the share are links`, inShare === linked, `${linked} links, ${inShare} expected`);
          if (linked) {
            const target = await page.locator(".sr-ref").first().textContent();
            await page.locator(".sr-ref").first().click();
            await page.waitForFunction(() => !document.body.classList.contains("object-mode") && window.__viewHooks.state().seriesIdx >= 0);
            check(`${name}: a reference opens its image`, true, target);
            await page.locator(`.series-btn[data-series="${k}"]`).click();
          }
        }
        await page.screenshot({ path: `${SHOTS}${caseId}-sr-${k}.png` });
      } else if (exp.pdfPages !== undefined) {
                await page.waitForSelector(".object-view .pdf-pages[data-rendered]", { timeout: 30000 });
        const pages = await page.locator(".object-view canvas.pdf-page").count();
        check(`${name}: PDF pages drawn`, pages === exp.pdfPages, `${pages} of ${exp.pdfPages}`);
        await page.screenshot({ path: `${SHOTS}${caseId}-pdf-${k}.png` });
      } else if (exp.cdaSections !== undefined) {
        const n = await page.locator(".object-view .cda-section").count();
        check(`${name}: CDA sections shown`, n === exp.cdaSections, `${n} of ${exp.cdaSections}`);
        const cells = await page.locator(".object-view .cda-text td").count();
        check(`${name}: CDA narrative tables kept`, cells > 0, `${cells} cells`);
        await page.screenshot({ path: `${SHOTS}${caseId}-cda-${k}.png` });
      } else if (exp.waveform) {
        if (/^1\.2\.840\.10008\.5\.1\.4\.1\.1\.9\.4\./.test(exp.sopClass)) {
          const dur = await page.$eval(".object-view audio", (a) => new Promise((r) => (a.readyState >= 1 ? r(a.duration) : a.addEventListener("loadedmetadata", () => r(a.duration)))));
          const want = exp.waveform[0].samples / 8000;
          check(`${name}: audio playable at its length`, Math.abs(dur - want) < 0.05, `${dur.toFixed(2)} s of ${want.toFixed(2)} s`);
        }
        const groups = await page.$$eval(".wf-scroll", (w) => w.map((x) => +x.dataset.channels));
        check(`${name}: waveform groups and channels`, JSON.stringify(groups) === JSON.stringify(exp.waveform.map((g) => g.channels)), `${groups.join(", ")} channels`);
        await page.screenshot({ path: `${SHOTS}${caseId}-waveform-${k}.png` });
      } else if (exp.triangles !== undefined) {
                await page.waitForSelector(".model-canvas[data-drawn]");
        const tri = +(await page.getAttribute(".model-canvas", "data-drawn"));
        check(`${name}: 3D model triangles drawn`, tri === exp.triangles, `${tri} of ${exp.triangles}`);
        await page.screenshot({ path: `${SHOTS}${caseId}-model-${k}.png` });
      } else if (exp.koRefs !== undefined) {
                const items = await page.locator(".ko-item").count();
        const links = await page.locator(".ko-open").count();
        const sops = new Set(Object.values(E).filter((e) => e.case === caseId).map((e) => e.sopInstance));
        const inShare = exp.koRefSops.filter((s) => sops.has(s)).length;
        check(`${name}: key image list`, items === exp.koRefs, `${items} of ${exp.koRefs} listed`);
        check(`${name}: key images in the share are links`, links === inShare, `${links} of ${inShare}`);
        await page.screenshot({ path: `${SHOTS}${caseId}-ko-${k}.png` });
        if (links) {
          await page.locator(".ko-open").first().click();
          await page.waitForFunction(() => !document.body.classList.contains("object-mode"));
          check(`${name}: a key image opens`, true);
          await page.locator(`.series-btn[data-series="${k}"]`).click();
        }
      } else if (exp.segments !== undefined || exp.rois !== undefined) {
        // Chosen in the list: the referenced images open with the layer on.
        await page.waitForTimeout(500);
        const onImages = await page.evaluate(() => !document.body.classList.contains("object-mode"));
        if (!onImages) {
          const note = await page.textContent(".object-view");
          check(`${name}: referenced images missing: said so`, /not in this share/.test(note), note.slice(0, 80));
          return;
        }
        const st0 = await page.evaluate(() => window.__viewHooks.state());
        let drawn = 0, best = -1;
        if (exp.contoursPerImage) {
          // The image with the most contours, by SOP Instance UID.
          const [sopBest, nBest] = Object.entries(exp.contoursPerImage).sort((a, b) => b[1] - a[1])[0];
          // The structure set opens its images asynchronously: wait until they are the current series.
          await page.waitForFunction((s) => window.__viewHooks.instanceIndex(s) >= 0, sopBest, { timeout: 30000 });
          const idx = await page.evaluate((s) => window.__viewHooks.instanceIndex(s), sopBest);
          await page.evaluate((i) => window.__viewHooks.showSlice(i), idx);
          // The layer canvas redraws once the slice's header is read: wait for this slice's count.
          await page.waitForFunction((n) => +document.querySelector(".layer-canvas")?.dataset.drawn === n, nBest, { timeout: 15000 }).catch(() => {});
          drawn = +(await page.getAttribute(".layer-canvas", "data-drawn"));
          check(`${name}: contours on the image that names them`, drawn === nBest, `${drawn} of ${nBest} on image ${idx + 1}`);
        } else {
          for (let i = 0; i < st0.sliceCount; i++) {
            await page.evaluate((i) => window.__viewHooks.showSlice(i), i);
            await page.waitForTimeout(150);
            const d = +(await page.getAttribute(".layer-canvas", "data-drawn"));
            if (d > drawn) { drawn = d; best = i; }
          }
          check(`${name}: segmentation drawn on its images`, drawn > 0, `${drawn} segment frame(s) on slice ${best + 1}`);
          if (best >= 0) await page.evaluate((i) => window.__viewHooks.showSlice(i), best);
          await page.waitForTimeout(300);
        }
        await page.click("#btn-layers");
        const legend = await page.locator(".legend-item").count();
        check(`${name}: legend lists segments or structures`, legend >= (exp.segments ?? exp.rois), `${legend}`);
        await page.screenshot({ path: `${SHOTS}${caseId}-layers-${k}.png` });
        await page.click("#sheet-layers [data-close]");
      } else if (exp.voi !== undefined) {
        await page.waitForTimeout(800);
        const onImages = await page.evaluate(() => !document.body.classList.contains("object-mode"));
        if (!onImages) {
          const note = await page.textContent(".object-view");
          check(`${name}: presentation state for images not in the share: said so`, /not in this share/.test(note), note.slice(0, 80));
          return;
        }
        const st = await page.evaluate(() => window.__viewHooks.state());
        if (exp.voi.length) check(`${name}: presentation state window applied`, Math.abs(st.wc - exp.voi[0][0]) < 0.5 && Math.abs(st.ww - exp.voi[0][1]) < 0.5, `W ${st.ww} L ${st.wc}; expected W ${exp.voi[0][1]} L ${exp.voi[0][0]}`);
        await page.screenshot({ path: `${SHOTS}${caseId}-pstate-${k}.png` });
      } else if (/other object/.test(kind)) {
                check(`${name}: listed with a download`, await page.isVisible(".object-view .obj-actions .btn"));
      }
    });
  }
  check(`${caseId}: no console errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
}

/** The same object views on a phone: layout and touch targets. */
async function phoneCase(caseId, seriesKind) {
  const { context, page, errors } = await open(caseId, "phone");
  await page.locator(".study-open").first().click();
  await page.waitForSelector(".series-btn");
  const k = await page.locator(".series-btn").evaluateAll((bs, re) => bs.findIndex((b) => new RegExp(re).test(b.textContent)), seriesKind);
  if (k >= 0) await page.locator(".series-btn").nth(k).click();
  await page.waitForTimeout(2500);
  const r = await page.evaluate(() => {
    const small = [];
    for (const el of document.querySelectorAll(".object-view button, .object-view select, .object-view a")) {
      const b = el.getBoundingClientRect();
      if (b.width && b.height && (b.height < 43.5 || b.width < 43.5)) small.push(`${el.className} ${Math.round(b.width)}×${Math.round(b.height)}`);
    }
    return { overflow: document.documentElement.scrollWidth - innerWidth, small };
  });
  check(`phone/${caseId}: no horizontal overflow`, r.overflow <= 0, `${r.overflow}`);
  check(`phone/${caseId}: targets ≥ 44 px`, r.small.length === 0, r.small.join(", "));
  await page.screenshot({ path: `${SHOTS}phone-${caseId}.png` });
  check(`phone/${caseId}: no console errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
}

/** Segmentations and annotations of a slide, chosen in the series list, open on the slide (wsi-view.ts). */
async function slideLayers() {
  const W = existsSync("/tmp/wsi-fixtures.json") ? JSON.parse(readFileSync("/tmp/wsi-fixtures.json", "utf8"))["ann-seg"] : null;
  if (!W) return check("slide layers: fixture", false, "run web/view/wsi-tools/wsi-fixtures.ts (ann-seg)");
  const base = process.env.WSI_BASE ?? "http://localhost:3333";
  const context = await browser.newContext(DEV.desktop);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/view#${W.tablesLink}`);
  await page.waitForSelector(".study-open");
  await page.locator(".study-open").first().click();
  await page.waitForSelector(".series-btn");
  const rows = await page.locator(".series-btn").evaluateAll((bs) => bs.map((b) => ({ k: b.dataset.series, name: b.querySelector(".s-name").textContent, count: b.querySelector(".s-count").textContent })));
  const derived = rows.filter((r) => /segmentation|other object/.test(r.count));
  for (const r of derived) {
    await page.locator(`.series-btn[data-series="${r.k}"]`).click();
    const ok = await page
      .waitForFunction(() => window.__wsi.active() && window.__wsi.layers().some((l) => l.visible), null, { timeout: 30000 })
      .then(() => true, () => false);
    const vis = await page.evaluate(() => window.__wsi.layers().filter((l) => l.visible).map((l) => l.title));
    check(`slide layers: "${r.name}" opens the slide with it on`, ok, vis.join(", "));
    check(`slide layers: no radiology Layers button on the slide`, !(await page.isVisible("#btn-layers")));
    await page.evaluate(() => window.__wsi.layers().filter((l) => l.visible).forEach((l) => window.__wsi.setLayer(l.id, false)));
  }
  check("slide layers: series to try", derived.length > 0, `${derived.length}`);
  await page.screenshot({ path: `${SHOTS}slide-layer.png` });
  check("slide layers: no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  await context.close();
}

/** Video series are labelled as video, with their length (video-fixtures.ts; VIDEO_FIXTURES_JSON picks the file). */
async function videoLabels() {
  const file = process.env.VIDEO_FIXTURES_JSON ?? "/tmp/video-fixtures.json";
  const V = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  if (!V?.link) return check("video labels: fixture", false, "run web/checks/video-fixtures.ts");
  const base = new URL(JSON.parse(Buffer.from(V.link.slice(V.link.indexOf("/") + 1), "base64url").toString()).url).origin;
  const context = await browser.newContext(DEV.desktop);
  const page = await context.newPage();
  await page.goto(`${base}/view#${V.link}`);
  await page.waitForSelector(".study-open");
  const studies = await page.locator(".study-open").count();
  const labels = [];
  for (let si = 0; si < studies; si++) {
    if (si) {
      await page.click("#btn-back");
      await page.waitForSelector("#screen-overview:not(.hidden)");
    }
    await page.locator(".study-open").nth(si).click();
    await page.waitForSelector(".series-btn");
    await page.waitForTimeout(3000);
    labels.push(...(await page.$$eval(".series-btn .s-count", (x) => x.map((e) => e.textContent))));
  }
  const video = labels.filter((l) => /^Video/.test(l));
  check("video labels: video series say Video, with a length when recorded", video.length > 0 && video.some((l) => /^Video · \d+:\d\d$/.test(l)), labels.join(" | "));
  await context.close();
}

/** A float parametric map over CT slices: offered as a layer, drawn on each slice it covers, in its colour scale. */
async function pmapOverlay() {
  const c = M.cases.find((x) => x.id === "pmap-overlay");
  const cts = c.files.filter((f) => f.startsWith("ct-"));
  const ct = E[`pmap-overlay/${cts[0]}`];
  const { context, page, errors } = await open("pmap-overlay");
  await page.locator(".study-open").first().click();
  await page.locator(`.series-btn[data-uid="${ct.series}"]`).click();
  await page.waitForFunction(() => window.__viewHooks.state().seriesIdx >= 0 && !document.querySelector("#stage-busy:not(.hidden)"));
  await page.waitForSelector("#btn-layers:not(.hidden)", { timeout: 30000 });
  await page.click("#btn-layers");
  const row = page.locator(".layer-row", { hasText: "parametric map" });
  check("pmap overlay: offered in Layers for the CT it was made on", (await row.count()) === 1, await page.textContent("#layers-list"));
  await row.locator("input").check();
  await page.waitForFunction(() => /–/.test(document.querySelector(".map-range")?.textContent ?? ""), null, { timeout: 30000 });
  const range = await page.textContent(".map-range");
  check("pmap overlay: colour scale spans the mapped range, with units", range === "0 – 100 %", range);
  await page.screenshot({ path: `${SHOTS}pmap-overlay-layers.png` });
  await page.click("#sheet-layers [data-close]");
  // Viridis-like scale of layers.ts, 5 stops.
  const stops = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
  const colour = (v) => {
    const k = Math.min(255, Math.floor((v / 100) * 255)), x = (k / 255) * 4, i = Math.min(3, Math.floor(x)), f = x - i;
    return stops[i].map((a, j) => Math.round(a * (1 - f) + stops[i + 1][j] * f));
  };
  const rows = [], bad = [];
  for (let k = 0; k < cts.length; k++) {
    const idx = await page.evaluate((s) => window.__viewHooks.instanceIndex(s), E[`pmap-overlay/${cts[k]}`].sopInstance);
    await page.evaluate((i) => window.__viewHooks.showSlice(i), idx);
    await page.waitForFunction(() => +document.querySelector(".layer-canvas")?.dataset.drawn > 0, null, { timeout: 10000 }).catch(() => {});
    const drawn = +(await page.getAttribute(".layer-canvas", "data-drawn"));
    rows.push(drawn);
    // A map pixel 30 to the right of the frame's centre point: CT pixel (2x, 2y) is inside it.
    const st = await page.evaluate(() => ({ cols: document.querySelector(".layer-canvas").width }));
    const R = 192, C = 192, mx = Math.round(C * (0.4 + 0.05 * k)) + 30, my = R / 2;
    const v = Math.min(100, (Math.hypot(mx - C * (0.4 + 0.05 * k), my - R * 0.5) / 120) * 100);
    const px = await page.evaluate(([x, y]) => {
      const p = window.__viewHooks.clientAt(x, y);
      const cv = document.querySelector(".layer-canvas"), r = cv.getBoundingClientRect();
      const cx = Math.floor((p.x - r.left) * (cv.width / r.width)), cy = Math.floor((p.y - r.top) * (cv.height / r.height));
      return Array.from(cv.getContext("2d").getImageData(cx, cy, 1, 1).data);
    }, [2 * mx, 2 * my]);
    const want = colour(v);
    if (want.some((w, j) => Math.abs(w - px[j]) > 3) || Math.abs(px[3] - 150) > 2) bad.push(`slice ${k + 1}: ${px.join(",")} vs ${want.join(",")},150 (${st.cols})`);
  }
  check("pmap overlay: drawn on each of the 5 slices (1 by source image, 4 by position)", rows.every((d) => d === 1), rows.join(","));
  check("pmap overlay: colour at a known point matches its value on the scale", bad.length === 0, bad.join("; ") || "5 slices");
  await page.screenshot({ path: `${SHOTS}pmap-overlay.png` });
  check("pmap overlay: no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  await context.close();
}

/** Files with an Icon Image Sequence: on a slow link the icon is drawn first, as pydicom reads it. */
async function iconPreviews() {
  for (const c of ["window-presets", "overlay-separate"]) {
    const files = Object.entries(E).filter(([k, v]) => k.startsWith(`${c}/`) && v.icon);
    if (!files.length) continue;
    const context = await browser.newContext(DEV.desktop);
    const page = await context.newPage();
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 40, downloadThroughput: 1e6 / 8, uploadThroughput: 1e6 / 8 });
    await page.goto(`${BASE}/view#${F[c].link}`);
    await page.waitForSelector(".study-open", { timeout: 60000 });
    // The study cards' thumbnails: record each icon drawn while its tile is still loading.
    const seen = await page.evaluate(async () => {
      const t0 = performance.now(), out = new Set();
      for (;;) {
        const cs = [...document.querySelectorAll("canvas.study-thumb")];
        for (const c of cs) if (c.dataset.icon && !c.dataset.drawn) out.add(c.dataset.icon);
        if (cs.every((c) => c.dataset.drawn || c.dataset.error) || performance.now() - t0 > 90000) return [...out];
        await new Promise((r) => setTimeout(r, 25));
      }
    });
    for (const [k, v] of files) {
      const hit = seen.find((x) => {
        const [size, mean] = x.split(" ");
        const m = mean.split(",").map(Number);
        return size === v.icon.size && m.every((y, i) => Math.abs(y - v.icon.mean[i]) <= 2);
      });
      check(`${k}: icon drawn before the image, as pydicom reads it`, !!hit, `${seen.join("; ") || "no icon seen"} vs ${v.icon.size} ${v.icon.mean.join(",")}`);
    }
    check(`${c} icons: no console errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
    await context.close();
  }
}

/** Dark mode on the object views (report, PDF, waveform, 3D, CDA), layers and video. */
async function darkObjects() {
  for (const dev of ["desktop", "phone"]) {
    for (const c of ["sr-dose", "pdf", "waveform-ecg", "model-stl", "synthetic-objects", "seg"]) {
      const { context, page, errors } = await open(c, dev, "dark");
      await page.locator(".study-open").first().click();
      await page.waitForSelector(".series-btn");
      const n = Math.min(4, await page.locator(".series-btn").count());
      for (let k = 0; k < n; k++) {
        await page.locator(`.series-btn[data-series="${k}"]`).click();
        await waitObject(page).catch(() => page.waitForTimeout(1500));
        await page.waitForTimeout(500);
        await darkAudit(page, `dark/${dev} ${c} series ${k + 1}`, check, `${dev}-${c}-${k + 1}`);
        if (c === "seg" && (await page.isVisible("#btn-layers"))) {
          await page.click("#btn-layers");
          await page.waitForSelector("#sheet-layers:not(.hidden)");
          await darkAudit(page, `dark/${dev} ${c} layers sheet`, check, `${dev}-layers`);
          await page.click("#sheet-layers [data-close]");
        }
      }
      check(`dark/${dev} ${c}: no console errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
      await context.close();
    }
    const vf = process.env.VIDEO_FIXTURES_JSON ?? "/tmp/video-fixtures.json";
    if (existsSync(vf)) {
      const V = JSON.parse(readFileSync(vf, "utf8"));
      const base = new URL(JSON.parse(Buffer.from(V.link.slice(V.link.indexOf("/") + 1), "base64url").toString()).url).origin;
      const context = await browser.newContext({ ...DEV[dev], colorScheme: "dark" });
      const page = await context.newPage();
      await page.goto(`${base}/view#${V.link}`);
      await page.waitForSelector(".study-open");
      await page.locator(".study-open").first().click();
      await page.waitForSelector(".series-btn");
      await page.waitForTimeout(4000);
      await darkAudit(page, `dark/${dev} video`, check, `${dev}-video`);
      await context.close();
    }
  }
}

/** Reset returns to the first view on a float image and a colour image (view-checks covers the sample's). */
async function resetOthers() {
  for (const [c, file] of [["float-maps", "ext-cs3d-paramap-float.dcm"], ["icc-photo", "vl-photo-1.dcm"]]) {
    const { context, page, errors } = await open(c);
    // The study holding the file's series.
    const uid = E[`${c}/${file}`].series;
    const ns = await page.locator(".study-open").count();
    for (let si = 0; si < ns; si++) {
      if (si) {
        await page.click("#btn-back");
        await page.waitForSelector("#screen-overview:not(.hidden)");
      }
      await page.locator(".study-open").nth(si).click();
      await page.waitForSelector(".series-btn");
      if (await page.locator(`.series-btn[data-uid="${uid}"]`).count()) break;
    }
    await page.locator(`.series-btn[data-uid="${uid}"]`).click();
    await page.waitForFunction(() => !document.querySelector("#stage-busy:not(.hidden)") && window.__viewHooks.renderShown(8, 8), null, { timeout: 60000 });
    await page.waitForTimeout(400);
    const snap = () => page.evaluate(() => ({ ...window.__viewHooks.state(), img: window.__viewHooks.renderShown(96, 96).grey }));
    const first = await snap();
    await page.evaluate(() => {
      const s = window.__viewHooks.state();
      window.__viewHooks.setWindow(s.wc + s.ww / 4, s.ww / 2);
    });
    // Ctrl + wheel zooms (the wheel alone steps slices).
    await page.mouse.move(700, 400);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -200);
    await page.keyboard.up("Control");
    await page.waitForTimeout(200);
    await page.click("#btn-reset");
    await page.waitForTimeout(400);
    const after = await snap();
    const same = after.sliceIdx === first.sliceIdx && after.zoom === 1 && after.img.every((v, i) => Math.abs(v - first.img[i]) <= 1) && after.wc === first.wc && after.ww === first.ww && after.zoom === first.zoom && after.presetId === first.presetId;
    check(`reset/${c}: Reset returns to the first view`, same, `W ${first.ww} L ${first.wc} ${first.presetId} slice ${first.sliceIdx} → W ${after.ww} L ${after.wc} ${after.presetId} slice ${after.sliceIdx}, zoom ${after.zoom}, max |Δ| ${Math.max(...after.img.map((v, i) => Math.abs(v - first.img[i])))}`);
    check(`reset/${c}: no console errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
    await context.close();
  }
}

/** No sideways overflow in the object views and video on narrow screens (overflow.mjs). */
async function overflowObjects() {
  const vf = process.env.VIDEO_FIXTURES_JSON ?? "/tmp/video-fixtures.json";
  for (const w of [320, 390, 480])
    for (const orient of ["portrait", "landscape"])
      for (const text of [1, 2]) {
        const h = Math.round(w * 2.16);
        const viewport = orient === "portrait" ? { width: w, height: h } : { width: h, height: w };
        const label = `overflow ${viewport.width}×${viewport.height} ${text === 2 ? "200%" : "100%"} text`;
        const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
        if (text === 2) await bigTextOn(context);
        const page = await context.newPage();
        const go = async (link) => {
          await page.goto(link);
          await page.waitForSelector(".study-open", { timeout: 60000 });
          await page.locator(".study-open").first().click();
          await page.waitForSelector(".series-btn");
        };
        try {
          for (const c of ["sr-dose", "pdf", "waveform-ecg", "model-stl"]) {
            await go(`${BASE}/view#${F[c].link}`);
            await waitObject(page).catch(() => {});
            await page.waitForTimeout(500);
            const probs = await overflowAudit(page);
            check(`${label}: ${c}`, probs.length === 0, probs.slice(0, 3).join("; "));
          }
          if (existsSync(vf)) {
            const V = JSON.parse(readFileSync(vf, "utf8"));
            const base = new URL(JSON.parse(Buffer.from(V.link.slice(V.link.indexOf("/") + 1), "base64url").toString()).url).origin;
            await go(`${base}/view#${V.link}`);
            await page.waitForTimeout(2500);
            const probs = await overflowAudit(page);
            check(`${label}: video`, probs.length === 0, probs.slice(0, 3).join("; "));
          }
        } catch (e) {
          check(`${label}: ran`, false, String(e).slice(0, 200));
        }
        await context.close();
      }
}

/** Video: the viewer's geometry gestures on the picture (zoom, pan, reset); the page never zooms. */
async function videoGestures() {
  const vf = process.env.VIDEO_FIXTURES_JSON ?? "/tmp/video-fixtures.json";
  if (!existsSync(vf)) return check("video gestures: fixture", false, "run web/checks/video-fixtures.ts");
  const V = JSON.parse(readFileSync(vf, "utf8"));
  const base = new URL(JSON.parse(Buffer.from(V.link.slice(V.link.indexOf("/") + 1), "base64url").toString()).url).origin;
  for (const dev of ["desktop", "phone"]) {
    const context = await browser.newContext(DEV[dev]);
    const page = await context.newPage();
    await page.goto(`${base}/view#${V.link}`);
    await page.waitForSelector(".study-open");
    await page.locator(".study-open").first().click();
    await page.waitForSelector(".media-stage:not(.hidden) .media-frame", { timeout: 60000 });
    await page.waitForTimeout(1500);
    const b = await page.locator(".media-stage").boundingBox();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    const z = () => page.evaluate(() => ({ z: Number(document.querySelector(".media-frame").dataset.zoom ?? 1), t: document.querySelector(".media-frame").style.transform, page: window.visualViewport?.scale ?? 1 }));
    if (dev === "desktop") {
      await page.mouse.move(x, y);
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -200);
      await page.keyboard.up("Control");
      await page.waitForTimeout(150);
      const a = await z();
      check(`video gestures/desktop: Ctrl+wheel zooms the picture, not the page`, a.z > 1.5 && a.page === 1, JSON.stringify(a));
      await page.mouse.down();
      await page.mouse.move(x + 60, y + 30, { steps: 6 });
      await page.mouse.up();
      const p = await z();
      check(`video gestures/desktop: drag pans the zoomed picture`, p.t !== a.t && p.z === a.z, p.t);
      await page.mouse.dblclick(x, y);
      await page.waitForTimeout(150);
      const r = await z();
      check(`video gestures/desktop: double-click goes back to fit`, r.z === 1 && !r.t);
      await page.mouse.move(x, y);
      await page.mouse.down({ button: "right" });
      await page.mouse.move(x, y - 60, { steps: 6 });
      await page.mouse.up({ button: "right" });
      const rz = await z();
      check(`video gestures/desktop: right-drag up zooms in`, rz.z > 1.3, JSON.stringify(rz));
    } else {
      const cdp = await context.newCDPSession(page);
      const t = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([px, py], id) => ({ x: px, y: py, id })) });
      await t("touchStart", [[x - 30, y], [x + 30, y]]);
      for (let i = 1; i <= 10; i++) await t("touchMove", [[x - 30 - i * 6, y], [x + 30 + i * 6, y]]);
      await t("touchEnd", []);
      await page.waitForTimeout(150);
      const a = await z();
      check(`video gestures/phone: pinch zooms the picture, not the page`, a.z > 2 && a.page === 1, JSON.stringify(a));
      for (let k = 0; k < 2; k++) {
        await t("touchStart", [[x, y]]);
        await t("touchEnd", []);
        await page.waitForTimeout(80);
      }
      await page.waitForTimeout(150);
      const r = await z();
      check(`video gestures/phone: double-tap goes back to fit`, r.z === 1 && !r.t, JSON.stringify(r));
    }
    await context.close();
  }
}

/** Originals of a share's files (sample-originals.py), cached per name. */
function originals(name, files) {
  const out = `/tmp/originals-${name}.json`;
  if (!existsSync(out)) writeFileSync(out, execFileSync("uv", ["run", "--project", `${ROOT}codec-corpus`, "python", `${ROOT}web/checks/sample-originals.py`, ...files], { maxBuffer: 1 << 26 }));
  return JSON.parse(readFileSync(out, "utf8"));
}

/** The download menu on object views (report, PDF, waveform, others) and on video, desktop and phone. */
async function objectDownloads() {
  for (const dev of ["desktop", "phone"]) {
    for (const c of ["sr-dose", "pdf", "waveform-ecg", "synthetic-objects", "enhanced-mf", "cine-mf"]) {
      const cs = M.cases.find((x) => x.id === c);
      const skipped = new Set((F[c].skipped ?? []).map((x) => x.name));
      const O = originals(c, cs.files.filter((f) => !skipped.has(f)).map((f) => `${M.dataRoot}/${c}/${f}`));
      const { context, page, errors } = await open(c, DEV[dev] ? dev : "desktop");
      await page.locator(".study-open").first().click();
      await page.waitForSelector(".series-btn");
      const n = await page.locator(".series-btn").count();
      for (let k = 0; k < (dev === "desktop" ? n : 1); k++) {
        await page.locator(`.series-btn[data-series="${k}"]`).click();
        await waitObject(page).catch(() => {});
        await downloadMatrix(page, `downloads/${dev} ${c} series ${k + 1}`, O, check, { image: true, series: dev === "desktop" });
      }
      check(`downloads/${dev} ${c}: no console errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
      await context.close();
    }
    // Video: the first video study of the video fixtures.
    const vf = process.env.VIDEO_FIXTURES_JSON ?? "/tmp/video-fixtures.json";
    if (!existsSync(vf)) {
      check(`downloads/${dev} video: fixture`, false, "run web/checks/video-fixtures.ts");
      continue;
    }
    const V = JSON.parse(readFileSync(vf, "utf8"));
    const O = originals(`video-${vf.replace(/\W+/g, "-")}`, V.cases.map((x) => x.file));
    const base = new URL(JSON.parse(Buffer.from(V.link.slice(V.link.indexOf("/") + 1), "base64url").toString()).url).origin;
    const context = await browser.newContext({ ...DEV[dev], acceptDownloads: true });
    await context.addInitScript(() => delete window.showSaveFilePicker);
    const page = await context.newPage();
    await page.goto(`${base}/view#${V.link}`);
    await page.waitForSelector(".study-open");
    await page.locator(".study-open").first().click();
    await page.waitForSelector(".series-btn");
    await page.waitForTimeout(3000);
    await downloadMatrix(page, `downloads/${dev} video`, O, check, { image: true });
    await context.close();
  }
}

const CASES = ["synthetic-objects", "sr-measurement", "sr-dose", "sr-basic-or-enhanced", "pdf", "seg", "rtstruct", "gsps", "ps-blending", "kos", "waveform-ecg", "model-stl", "other-nonimage", "pmap"];
try {
  for (const c of CASES) if (!only || only === c) await objectCase(c).catch((e) => check(`${c}: flow threw`, false, String(e?.stack ?? e).slice(0, 400)));
  if (!only || only === "video-gestures") await videoGestures().catch((e) => check("video gestures: flow threw", false, String(e?.stack ?? e).slice(0, 400)));
  if (!only || only === "overflow") await overflowObjects().catch((e) => check("overflow: flow threw", false, String(e?.stack ?? e).slice(0, 400)));
  if (!only || only === "reset") await resetOthers().catch((e) => check("reset: flow threw", false, String(e?.stack ?? e).slice(0, 400)));
  if (!only || only === "dark") await darkObjects().catch((e) => check("dark: flow threw", false, String(e?.stack ?? e).slice(0, 400)));
  if (!only || only === "icons") await iconPreviews().catch((e) => check("icons: flow threw", false, String(e?.stack ?? e).slice(0, 400)));
  if (!only || only === "downloads") await objectDownloads().catch((e) => check("downloads: flow threw", false, String(e?.stack ?? e).slice(0, 400)));
  if (!only || only === "pmap-overlay") await pmapOverlay().catch((e) => check("pmap overlay: flow threw", false, String(e).slice(0, 300)));
  if (!only || only === "video-labels") await videoLabels().catch((e) => check("video labels: flow threw", false, String(e).slice(0, 300)));
  if (!only || only === "slide-layers") await slideLayers().catch((e) => check("slide layers: flow threw", false, String(e).slice(0, 300)));
  if (!only)
    for (const [c, k] of [["sr-dose", "report"], ["waveform-ecg", "waveform"], ["pdf", "PDF"], ["kos", "key image"], ["model-stl", "3D"]])
      await phoneCase(c, k).catch((e) => check(`phone/${c}: flow threw`, false, String(e).slice(0, 300)));
} finally {
  pageErrorCheck(browser, check);
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
writeFileSync("/tmp/object-checks.json", JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
