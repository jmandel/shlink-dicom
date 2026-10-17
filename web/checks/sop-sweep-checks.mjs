// Object-type sweep (codec-corpus/prevalence/SOPCLASS_SWEEP.md): every kind of DICOM object in IDC,
// opened in the real viewer from a share, checked for what fits its type. Expected values come
// from pydicom (sop-sweep/expect.py) and reformats from SimpleITK (objects/mpr-ref.py).
//   uv run --project codec-corpus python -I web/checks/sop-sweep/expect.py /media/barracuda/sop-sweep
//   bun web/checks/sop-sweep-fixtures.ts http://localhost:3471
//   BASE=http://localhost:3471 node web/checks/sop-sweep-checks.mjs [--only=case,case]
// Writes ROOT/results.json; screenshots go to ROOT/shots/ (ROOT: $SWEEP, default /media/barracuda/sop-sweep).
// The regression set (the sweep's failing cases, named in sop-sweep/fixtures.json, fetched from IDC by UID):
//   cd codec-corpus && uv run --with idc-index --with pydicom --with highdicom python scripts/sources/sopclass_fetch.py --fixtures ../web/checks/sop-sweep/fixtures.json /media/barracuda/sop-sweep-fixtures
//   uv run --project codec-corpus python -I web/checks/sop-sweep/expect.py /media/barracuda/sop-sweep-fixtures
//   bun web/checks/sop-sweep-fixtures.ts http://localhost:3471 /media/barracuda/sop-sweep-fixtures
//   SWEEP=/media/barracuda/sop-sweep-fixtures BASE=http://localhost:3471 node web/checks/sop-sweep-checks.mjs
import { launchBrowser } from "./browser.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3471";
const ROOT = process.env.SWEEP ?? "/media/barracuda/sop-sweep";
const REPO = new URL("../../", import.meta.url).pathname;
const SHOTS = `${ROOT}/shots/`;
const REFS = `${ROOT}/refs/`;
mkdirSync(SHOTS, { recursive: true });
mkdirSync(REFS, { recursive: true });
const F = JSON.parse(readFileSync(`${ROOT}/shares.json`, "utf8"));
const E = JSON.parse(readFileSync(`${ROOT}/expect.json`, "utf8"));
const CASES = [
  ...JSON.parse(readFileSync(`${ROOT}/cases.json`, "utf8")).cases,
  ...(existsSync(`${ROOT}/cases-extra.json`) ? JSON.parse(readFileSync(`${ROOT}/cases-extra.json`, "utf8")).cases : []),
];
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const resultsPath = `${ROOT}/results.json`;
const RESULTS = existsSync(resultsPath) && only ? JSON.parse(readFileSync(resultsPath, "utf8")) : {};

const browser = await launchBrowser({ args: ["--disable-gpu"] });
const VIEWPORT = { viewport: { width: 1280, height: 860 } };
const fileOf = (c, uid) => (c.dirs?.[uid] ?? `${ROOT}/dl/${uid}`);
const lsDcm = (dir) => execFileSync("find", [dir, "-maxdepth", "1", "-name", "*.dcm"], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
const MPR_MODALITIES = ["CT", "MR", "PT", "NM"];

/** One case: open its share, then every series, checking what fits its category. */
async function runCase(c) {
  const out = { id: c.id, sopClass: c.sopClass, primary: c.primary, checks: [], shots: [], series: {} };
  const check = (name, ok, detail = "", series = null) => {
    out.checks.push({ name, ok, detail: String(detail).slice(0, 400), series });
    console.log(`${ok === null ? "INFO" : ok ? "PASS" : "FAIL"} ${c.id}: ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ""}`);
  };
  const fx = F[c.id];
  if (!fx || fx.error) {
    check("shared", false, fx?.error ?? "no fixture");
    return out;
  }
  const exp = E[c.id] ?? {};
  const context = await browser.newContext(VIEWPORT);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const shot = async (tag) => {
    const p = `${SHOTS}${c.id}-${tag}.png`;
    await page.screenshot({ path: p }).catch(() => {});
    out.shots.push(p);
  };
  try {
    await page.goto(`${BASE}/view#${fx.link}`);
    await page.waitForSelector(".study-open", { timeout: 60000 });
    const nStudies = await page.locator(".study-open").count();
    const seen = new Set();
    for (let si = 0; si < nStudies; si++) {
      if (si) {
        await page.click("#btn-back");
        await page.waitForSelector("#screen-overview:not(.hidden)");
      }
      await page.locator(".study-open").nth(si).click();
      await page.waitForSelector(".series-btn");
      const rows = await page.locator(".series-btn").evaluateAll((bs) => bs.map((b) => ({ k: b.dataset.series, uid: b.dataset.uid, count: b.querySelector(".s-count")?.textContent ?? "" })));
      // The primary series first, then those it references.
      rows.sort((a, b) => (b.uid === c.primary) - (a.uid === c.primary));
      for (const r of rows) {
        seen.add(r.uid);
        const e = exp[r.uid];
        if (!e) {
          check("series in the share is expected", false, `${r.uid} (${r.count})`, r.uid);
          continue;
        }
        const deep = r.uid === c.primary;
        const tag = `${e.category}${deep ? "" : "-ref"}-${r.uid.slice(-6)}`;
        const before = out.checks.filter((x) => x.ok === false).length;
        try {
          await page.locator(`.series-btn[data-series="${r.k}"]`).click();
          out.series[r.uid] = { category: e.category, label: r.count, sopClass: e.sopClass };
          await seriesChecks(page, c, r, e, deep, check, out);
        } catch (err) {
          check(`${e.category} series: flow`, false, String(err?.message ?? err).split("\n")[0], r.uid);
        }
        if (out.checks.filter((x) => x.ok === false).length > before) await shot(tag);
        else if (deep) await shot(`${tag}-ok`);
      }
    }
    for (const uid of Object.keys(exp)) if (!seen.has(uid)) check("every series listed", false, `${uid} (${exp[uid].category}) not in the series list`, uid);
  } catch (err) {
    check("opens", false, String(err?.message ?? err).split("\n")[0]);
    await shot("open");
  }
  const pageErrors = errors.filter((x) => x.startsWith("pageerror"));
  check("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  check("no console errors", errors.length === 0, errors.filter((x) => !x.startsWith("pageerror")).slice(0, 3).join(" | "));
  await context.close();
  return out;
}

const stageMsg = (page) => page.evaluate(() => { const m = document.querySelector("#stage-msg"); return m && !m.classList.contains("hidden") ? m.textContent : ""; });
const idle = (page, ms = 90000) => page.waitForFunction(() => !document.querySelector("#stage-busy:not(.hidden)"), null, { timeout: ms });

/** Waits for slice i of the series on screen to be drawn (hud shows it, nothing loading). */
async function showSlice(page, i, n) {
  await page.evaluate((i) => window.__viewHooks.showSlice(i), i);
  await page.waitForFunction(([i, n]) => {
    const s = window.__viewHooks.state();
    return s.sliceIdx === i && !document.querySelector("#stage-busy:not(.hidden)") && (document.querySelector("#hud-tl")?.textContent ?? "").includes(`${i + 1}/${n}`);
  }, [i, n], { timeout: 60000 });
}

async function seriesChecks(page, c, r, e, deep, check, out) {
  const cat = e.category;
  const uid = r.uid;
  const objectMode = () => page.evaluate(() => document.body.classList.contains("object-mode"));
  const waitObject = () => page.waitForFunction(() => { const v = document.querySelector(".object-view"); return v && !v.classList.contains("hidden") && v.dataset.rendered; }, null, { timeout: 60000 });
  if (cat === "volume" || cat === "mf2d" || cat === "image" || cat === "pmap") {
    // Opens and draws.
    const drawn = await page
      .waitForFunction(() => { const s = window.__viewHooks.state(); return s.seriesIdx >= 0 && !document.querySelector("#stage-busy:not(.hidden)") && (window.__viewHooks.renderShown(4, 4) || document.querySelector("#stage-msg:not(.hidden)")); }, null, { timeout: 120000 })
      .then(() => true, () => false);
    const msg = await stageMsg(page);
    if (!drawn || msg) {
      if (await objectMode()) {
        const t = await page.textContent(".object-view");
        return check(`${cat}: opens as an image`, false, `shown as an object: ${t.slice(0, 150)}`, uid);
      }
      return check(`${cat}: opens and draws`, false, msg || "timed out with nothing drawn", uid);
    }
    check(`${cat}: opens and draws`, true, r.count, uid);
    const st = await page.evaluate(() => window.__viewHooks.state());
    // One multi-frame instance: a slice per frame. Several instances: a slice per instance (a
    // multi-frame one plays its frames with the cine control).
    const single = e.frames.length === 1;
    const n = single ? e.slices.length : e.frames.length;
    check(`${cat}: one slice per ${single && n > 1 ? "frame" : "instance"}`, st.sliceCount === n, `${st.sliceCount} of ${n}${!single && e.frames.some((f) => f > 1) ? ` (instances of ${[...new Set(e.frames)].join(", ")} frames)` : ""}`, uid);
    // Dimensions of what is drawn.
    const tr = (await page.textContent("#hud-tr")).split("\n")[0];
    const s0 = (await sliceAt(page, e, st.sliceIdx)) ?? e.slices[0];
    const dims = `${s0.cols}×${s0.rows}`;
    check(`${cat}: dimensions`, tr === dims, `${tr}; expected ${dims}`, uid);
    // Not a silent blank.
    const g = await page.evaluate(() => window.__viewHooks.renderShown(64, 64));
    const flat = g && g.grey.every((v) => v === g.grey[0]);
    if (flat) {
      const es = await sliceAt(page, e, st.sliceIdx);
      check(`${cat}: not blank`, !!es?.constant, `every pixel drawn at grey ${g.grey[0]}${es?.constant ? " (the frame is constant)" : ""}`, uid);
    } else check(`${cat}: not blank`, true, "", uid);
    if (!deep) return;
    // Initial window: the stored window of the slice first shown, when it has one, unless under
    // 1% of the slice's values fall inside it (then the viewer opens on the values' own range).
    const firstSlice = await sliceAt(page, e, st.sliceIdx);
    if (firstSlice?.window && e.spp === 1 && firstSlice.windowCover != null && firstSlice.windowCover < 0.01) {
      const [wc, ww] = firstSlice.window;
      const other = Math.abs(st.wc - wc) > 0.51 || Math.abs(st.ww - ww) > 0.51;
      check(`${cat}: a stored window that misses the values gives way to their range`, other, `W ${st.ww} L ${st.wc}; slice ${st.sliceIdx + 1} stores W ${ww} L ${wc} with ${(100 * firstSlice.windowCover).toFixed(2)}% of values inside`, uid);
    } else if (firstSlice?.window && e.spp === 1) {
      const [wc, ww] = firstSlice.window;
      const ok = Math.abs(st.wc - wc) < 0.51 && Math.abs(st.ww - ww) < 0.51;
      check(`${cat}: initial window is the stored window of the slice shown`, ok, `W ${st.ww} L ${st.wc}; slice ${st.sliceIdx + 1} stores W ${ww} L ${wc}`, uid);
    }
    // Step through the slices: order by position, values (rescale) at known pixels.
    const idx = n <= 40 ? [...Array(n).keys()] : [...new Set([...Array(30).keys()].map((k) => Math.round((k * (n - 1)) / 29)))];
    const pos = [], badVals = [], windows = new Set();
    let valChecked = 0;
    for (const i of idx) {
      await showSlice(page, i, n);
      const es = await sliceAt(page, e, i);
      if (!es) {
        badVals.push(`slice ${i + 1}: instance on screen not in the series`);
        continue;
      }
      pos.push(es.pos);
      const s2 = await page.evaluate(() => window.__viewHooks.state());
      windows.add(`${s2.wc}/${s2.ww}`);
      if (es.values && (i === idx[0] || i === idx[idx.length - 1] || i === idx[Math.floor(idx.length / 2)] || idx.length <= 6)) {
        for (const p of es.values) {
          const v = await page.evaluate(([x, y]) => window.__viewHooks.valueAt(x, y), [p.x, p.y]);
          valChecked++;
          const tol = Math.max(Math.abs(es.slope) / 2 + 1e-6, Math.abs(p.real) * 1e-4, 1e-3);
          if (!v || Math.abs(v.value - p.real) > tol) badVals.push(`slice ${i + 1} (${(e.frames.length === 1 && n > 1) ? `frame ${es.frame + 1}` : es.uid.slice(-8)}) (${p.x},${p.y}): ${v ? v.value : "none"} vs ${p.real} (stored ${p.stored} × ${es.slope} + ${es.intercept})`);
        }
      }
    }
    if (valChecked || badVals.length) check(`${cat}: values under the cursor are the stored values through each slice's own rescale`, badVals.length === 0, badVals.length ? `${badVals.length} wrong: ${badVals.slice(0, 3).join("; ")}` : `${valChecked} pixels`, uid);
    if (pos.every((p) => p !== null && p !== undefined) && pos.length >= 3 && (cat === "volume" || e.regularVolume) && (single || e.frames.every((f) => f === 1))) {
      const d = pos.slice(1).map((p, k) => p - pos[k]);
      const mono = d.every((x) => x > 1e-4) || d.every((x) => x < -1e-4);
      const dup = new Set(e.slices.map((s) => s.pos?.toFixed(3))).size < e.slices.length;
      if (e.regularVolume) check(`${cat}: slices step in spatial order (by position along the normal)`, mono, mono ? `${pos.length} slices visited` : `positions in viewer order: ${pos.slice(0, 12).map((p) => p.toFixed(1)).join(", ")}${pos.length > 12 ? " …" : ""}`, uid);
      else check(`${cat}: slices step in spatial order`, null, `not one regular volume (${e.notVolume}${dup ? "; positions repeat" : ""}): order ${mono ? "monotonic" : "not monotonic"}`, uid);
    }
    const winVaries = new Set(e.slices.map((s) => (s.window ? s.window.join("/") : "-"))).size > 1;
    if (winVaries) check(`${cat}: per-slice stored windows (info)`, null, `stored windows vary between slices; the viewer showed ${windows.size} distinct window(s) while stepping`, uid);
    const rescVaries = new Set(e.slices.map((s) => `${s.slope}/${s.intercept}`)).size > 1;
    if (rescVaries) check(`${cat}: per-slice rescale (info)`, null, `${new Set(e.slices.map((s) => `${s.slope}/${s.intercept}`)).size} distinct rescales`, uid);
    // Cine: a multi-frame instance gets a play bar, and playing moves the frame.
    if (e.frames.some((f) => f > 1)) {
      if (!single) await showSlice(page, e.frames.findIndex((f) => f > 1), n);
      const bar = await page.isVisible(".play-bar button[aria-label='Play']");
      check(`${cat}: multi-frame: play control shown`, bar, "", uid);
      if (bar) {
        // The frame counter of the play bar ("4 / 9"; one multi-frame instance: also the slice).
        const where = () => page.evaluate(() => `${window.__viewHooks.state().sliceIdx} ${document.querySelector(".play-bar .play-info")?.textContent ?? ""}`);
        const s0i = await where();
        await page.click(".play-bar button[aria-label='Play']");
        const moved = await page.waitForFunction((s) => `${window.__viewHooks.state().sliceIdx} ${document.querySelector(".play-bar .play-info")?.textContent ?? ""}` !== s, s0i, { timeout: 8000 }).then(() => true, () => false);
        await page.click(".play-bar button[aria-label='Pause']").catch(() => page.click(".play-bar button[aria-label='Play']").catch(() => {}));
        check(`${cat}: multi-frame: frames play`, moved, "", uid);
      }
    }
    // Reformats.
    if (cat === "volume" && MPR_MODALITIES.includes(e.modality) && n >= 10 && e.spp === 1) {
      if (e.slices[0].iop) await reformats(page, c, r, e, check);
      else check("volume: reformats", null, "no Image Orientation (Patient): not a volume", uid);
    }
    return;
  }
  if (cat === "seg" || cat === "rtstruct") {
    await page.waitForTimeout(800);
    await page.waitForFunction(() => !document.querySelector("#stage-busy:not(.hidden)"), null, { timeout: 90000 }).catch(() => {});
    if (await objectMode()) {
      const note = (await page.textContent(".object-view")) ?? "";
      const missing = Object.keys(e.lands ?? {}).length === 0;
      return check(`${cat}: opens its referenced images with the layer on`, missing && /not in this share/.test(note), `shown as an object: ${note.slice(0, 160)}`, uid);
    }
    const targets = Object.entries(e.lands ?? {}).sort((a, b) => (b[1].frames ?? b[1].contours) - (a[1].frames ?? a[1].contours)).slice(0, 3);
    if (!targets.length) return check(`${cat}: where it lands is known`, null, "no frame or contour matched an image in the share", uid);
    const bad = [];
    let good = 0;
    for (const [key, t] of targets) {
      const [sop, frame] = key.split("/");
      const idx = await page.waitForFunction((s) => window.__viewHooks.instanceIndex(s) >= 0 ? window.__viewHooks.instanceIndex(s) : null, sop, { timeout: 30000 }).then((h) => h.jsonValue(), () => -1);
      if (idx < 0) {
        bad.push(`${sop.slice(-8)}: not in the series on screen`);
        continue;
      }
      const slice = Number(frame) > 0 ? Number(frame) : idx;
      const n = (await page.evaluate(() => window.__viewHooks.state())).sliceCount;
      await showSlice(page, slice, n);
      const want = t.frames ?? t.contours;
      await page.waitForFunction((n) => +document.querySelector(".layer-canvas")?.dataset.drawn >= n, want, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(200);
      const m = await page.evaluate(() => {
        const cv = document.querySelector(".layer-canvas");
        if (!cv) return null;
        const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
        let k = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
        for (let y = 0; y < cv.height; y++)
          for (let x = 0; x < cv.width; x++)
            if (d[(y * cv.width + x) * 4 + 3] > 0) {
              k++;
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
            }
        if (!k) return { drawn: +cv.dataset.drawn, n: 0 };
        const r = cv.getBoundingClientRect();
        const cl = (x, y) => window.__viewHooks.pixelAtClient(r.left + ((x + 0.5) * r.width) / cv.width, r.top + ((y + 0.5) * r.height) / cv.height);
        return { drawn: +cv.dataset.drawn, n: k, a: cl(x0, y0), b: cl(x1, y1) };
      });
      if (!m || !m.n) {
        bad.push(`image ${slice + 1}: nothing drawn (expected ${want} ${cat === "seg" ? "segment frame(s)" : "contour(s)"})`);
        continue;
      }
      // The drawn pixels' bounding box (image pixels) against the mask's or contour's.
      const box = m.a && m.b ? [m.a.x, m.a.y, m.b.x + 1, m.b.y + 1] : null;
      const off = box ? Math.max(...box.map((v, j) => Math.abs(v - t.box[j]))) : Infinity;
      const tol = 4;
      if (m.drawn !== want && cat === "seg") bad.push(`image ${slice + 1}: ${m.drawn} segment frame(s) drawn, ${want} expected`);
      else if (!(off <= tol)) bad.push(`image ${slice + 1}: drawn over x ${box?.[0]}–${box?.[2]}, y ${box?.[1]}–${box?.[3]}; expected x ${t.box[0].toFixed(0)}–${t.box[2].toFixed(0)}, y ${t.box[1].toFixed(0)}–${t.box[3].toFixed(0)}`);
      else good++;
    }
    check(`${cat}: lands on the referenced images, in the right place`, bad.length === 0, bad.length ? bad.join("; ") : `${good} image(s): count and bounding box match`, uid);
    await page.click("#btn-layers").catch(() => {});
    const legend = await page.locator(".legend-item").count();
    const wantLegend = cat === "seg" ? e.segments : e.rois;
    check(`${cat}: legend lists ${cat === "seg" ? "segments" : "structures"}`, legend >= Math.min(wantLegend, 1), `${legend} of ${wantLegend}`, uid);
    await page.click("#sheet-layers [data-close]").catch(() => {});
    return;
  }
  if (cat === "pr") {
    await page.waitForTimeout(1000);
    await idle(page).catch(() => {});
    if (await objectMode()) {
      const note = (await page.textContent(".object-view")) ?? "";
      const label = /does not display|not in this share|can't be shown/.test(note);
      return check(`pr: applied to its images, or says why not`, e.sopClass.endsWith(".11.1") ? false : label ? "unsupported" : false, note.slice(0, 160), uid);
    }
    const cur = await page.evaluate(() => window.__viewHooks.current());
    if (e.refImages.length) check("pr: shows one of its referenced images", e.refImages.includes(cur.onScreen?.uid), cur.onScreen?.uid ?? "", uid);
    const st = await page.evaluate(() => window.__viewHooks.state());
    if (e.voi?.length) check("pr: its window applied", Math.abs(st.wc - e.voi[0][0]) < 0.5 && Math.abs(st.ww - e.voi[0][1]) < 0.5, `W ${st.ww} L ${st.wc}; expected W ${e.voi[0][1]} L ${e.voi[0][0]}`, uid);
    if (e.blendSeries) check("pr: blending of two series", null, `advanced blending of ${e.blendSeries.length} series; on screen: ${cur.series}`, uid);
    return;
  }
  if (["sr", "ko", "pdf", "model", "other"].includes(cat)) {
    const ok = await waitObject().then(() => true, () => false);
    const kind = await page.getAttribute(".object-view", "data-rendered").catch(() => null);
    const text = ((await page.textContent(".object-view").catch(() => "")) ?? "").replace(/\s+/g, " ");
    if (!ok) return check(`${cat}: shown`, false, `nothing rendered: ${text.slice(0, 120)}`, uid);
    if (kind === "error") return check(`${cat}: shown`, false, text.slice(0, 200), uid);
    if (cat === "sr" || cat === "ko") {
      if (cat === "sr") {
        const t = await page.$eval(".sr-tree", (x) => ({ items: +x.dataset.items, refs: +x.dataset.refs })).catch(() => null);
        check("sr: every content item shown", t?.items === e.srItems, `${t?.items} of ${e.srItems}; "${e.title}"`, uid);
        check("sr: image references", t?.refs === e.srRefs, `${t?.refs} of ${e.srRefs}`, uid);
        const present = await page.evaluate(() => document.querySelectorAll(".sr-ref").length + document.querySelectorAll(".sr-ref-missing").length);
        if (e.srRefs) check("sr: references shown as links or as missing", present >= 1, `${present}`, uid);
      } else {
        const items = await page.locator(".ko-item").count();
        check("ko: key image list", items === e.koRefs, `${items} of ${e.koRefs}`, uid);
      }
      return;
    }
    if (cat === "pdf") {
      const pages = await page.waitForSelector(".object-view .pdf-pages[data-rendered]", { timeout: 30000 }).then(() => page.locator("canvas.pdf-page").count(), () => 0);
      return check("pdf: pages drawn", pages > 0, `${pages}`, uid);
    }
    if (cat === "model") {
      const tri = await page.waitForSelector(".model-canvas[data-drawn]", { timeout: 30000 }).then(() => page.getAttribute(".model-canvas", "data-drawn"), () => null);
      return check("model: triangles drawn", +tri === e.triangles, `${tri} of ${e.triangles}`, uid);
    }
    // Anything else: named, said plainly that it is not displayed, with a download.
    const named = text.includes(e.className?.replace(/ Storage$/, "") ?? "\u0000") || /Type/.test(text);
    const says = /does not display/.test(text);
    const dl = await page.isVisible(".object-view .obj-actions .btn");
    check("other: labelled as not displayed, with a download", says && dl && named ? "unsupported" : false, text.slice(0, 160), uid);
    return;
  }
  if (cat === "slide") {
    const ok = await page.waitForFunction(() => window.__wsi?.active(), null, { timeout: 90000 }).then(() => true, () => false);
    if (!ok) return check("slide: opens in the slide viewer", false, (await stageMsg(page)) || "not active", uid);
    await page.waitForTimeout(1500);
    const hud = await page.textContent("#hud-tl");
    const b = e.base;
    const want = b ? `${b.w.toLocaleString("en-US")} × ${b.h.toLocaleString("en-US")}` : "";
    check("slide: base level size", !b || hud.includes(want), `${hud.replace(/\n/g, " | ")}; expected ${want}, ${e.levels} levels`, uid);
    check("slide: levels", !b || hud.includes(`${e.levels} level`), hud.replace(/\n/g, " | "), uid);
    return;
  }
  if (cat === "ann") {
    const ok = await page.waitForFunction(() => window.__wsi?.active() && window.__wsi.layers().some((l) => l.visible), null, { timeout: 90000 }).then(() => true, () => false);
    const vis = await page.evaluate(() => window.__wsi?.layers?.().filter((l) => l.visible).map((l) => l.title) ?? []).catch(() => []);
    if (!ok && (await objectMode())) {
      const note = (await page.textContent(".object-view")) ?? "";
      return check("ann: opens its slide with the annotations on", /not in this share/.test(note) ? "unsupported" : false, note.slice(0, 160), uid);
    }
    return check("ann: opens its slide with the annotations on", ok, vis.join(", "), uid);
  }
  check(`${cat}: no check for this category`, null, "", uid);
}

/** The expected slice for viewer slice i (by the instance on screen; a single multi-frame instance: the frame on screen). */
async function sliceAt(page, e, i) {
  const cur = await page.evaluate(() => window.__viewHooks.current());
  const uid = cur.onScreen?.uid;
  const single = e.frames.length === 1;
  // The frame on screen: a multi-frame instance steps its frames in spatial order, not stored order.
  return e.slices.find((s) => s.uid === uid && s.frame === (single ? cur.onScreen.frame ?? i : 0)) ?? null;
}

/** Thin reformats in the planes not acquired (and one oblique) against the SimpleITK oracle. */
async function reformats(page, c, r, e, check) {
  const uid = r.uid;
  await page.evaluate(() => window.__viewHooks.setMprEngine("cpu"));
  const planes = ["axial", "sagittal", "coronal"];
  const io = e.slices[0].iop;
  const nrm = [io[1] * io[5] - io[2] * io[4], io[2] * io[3] - io[0] * io[5], io[0] * io[4] - io[1] * io[3]].map(Math.abs);
  const acquired = nrm[2] >= nrm[0] && nrm[2] >= nrm[1] ? "axial" : nrm[0] >= nrm[1] ? "sagittal" : "coronal";
  const configs = [...planes.filter((p) => p !== acquired).map((p) => [p, {}]), [planes.find((p) => p !== acquired), { turn: 20, tilt: 15 }]];
  const files = lsDcm(fileOf(c, uid));
  for (const [plane, opts] of configs) {
    const label = `volume: reformat ${plane}${opts.turn ? " turned 20° tilted 15°" : ""}`;
    try {
      await page.evaluate(([p, o]) => window.__viewHooks.enterMpr(p, o), [plane, { slab: { thickness: 0, mode: "mip" }, ...opts }]);
      await idle(page, 180000);
      const m = await page.evaluate(() => window.__viewHooks.mprState());
      if (!m) {
        const msg = await stageMsg(page);
        if (!e.regularVolume) check(`${label}: not a volume, and says why`, msg ? true : false, `${msg || "no message"} (pydicom: ${e.notVolume})`, uid);
        else check(`${label}: builds the volume`, false, msg || "no reformat and no message", uid);
        continue;
      }
      if (!e.regularVolume) check(`${label}: built a volume from slices that are not one regular volume (info)`, null, e.notVolume, uid);
      const st = await page.evaluate(() => window.__viewHooks.state());
      const tag = `${c.id}-${plane}-${opts.turn ?? 0}`;
      const job = { files, spec: m.spec, window: { center: st.wc, width: st.ww }, out: `${REFS}${tag}.png` };
      writeFileSync(`${REFS}${tag}.json`, JSON.stringify(job));
      const info = JSON.parse(execFileSync("uv", ["run", "-q", "--project", `${REPO}codec-corpus`, "--with", "simpleitk", "--with", "pillow", "python", "-I", `${REPO}web/checks/objects/mpr-ref.py`, `${REFS}${tag}.json`], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 24 }).trim().split("\n").pop());
      const url = `data:image/png;base64,${readFileSync(job.out).toString("base64")}`;
      const cmp = await page.evaluate((u) => window.__viewHooks.compareWith(u), url);
      // One stored unit in grey levels: with a narrow window a rounding tie (x.5) is several levels.
      const unit = (255 * Math.abs(e.slices[0].slope)) / Math.max(1, st.ww - 1);
      const ok = cmp && !cmp.error && cmp.max <= Math.max(2, Math.ceil(unit) + 1) && cmp.over2 < (unit > 2 ? 0.005 : 0.001);
      check(`${label}: matches SimpleITK`, ok, cmp?.error ?? `max |Δ| ${cmp?.max}, mean ${cmp?.mean?.toFixed(3)}, >2: ${((cmp?.over2 ?? 0) * 100).toFixed(2)}% (${m.spec.width}×${m.spec.height}; 1 stored unit = ${unit.toFixed(1)} grey levels${info.uniformRescale ? "" : "; rescale differs between slices"})`, uid);
      if (!ok) await page.screenshot({ path: `${SHOTS}${tag}-mpr.png` }).catch(() => {});
    } catch (err) {
      check(`${label}`, false, String(err?.message ?? err).split("\n")[0], uid);
    }
  }
  await page.evaluate(() => window.__viewHooks.enterMpr("")).catch(() => {});
}

for (const c of CASES) {
  if (only && !only.includes(c.id)) continue;
  const res = await runCase(c).catch((e) => ({ id: c.id, checks: [{ name: "ran", ok: false, detail: String(e).slice(0, 300) }], shots: [] }));
  const fails = res.checks.filter((x) => x.ok === false).length;
  const unsupported = res.checks.some((x) => x.ok === "unsupported");
  res.verdict = fails ? "fail" : unsupported ? "unsupported" : "pass";
  RESULTS[c.id] = res;
  writeFileSync(resultsPath, JSON.stringify(RESULTS, null, 1));
  console.log(`== ${c.id}: ${res.verdict}${fails ? ` (${fails} failed)` : ""}`);
}
await browser.close();
const all = Object.values(RESULTS);
console.log(`\n${all.filter((r) => r.verdict === "pass").length} pass, ${all.filter((r) => r.verdict === "unsupported").length} unsupported, ${all.filter((r) => r.verdict === "fail").length} fail of ${all.length} cases`);
process.exit(all.some((r) => r.verdict === "fail" && (!only || only.includes(r.id))) ? 1 : 0);
