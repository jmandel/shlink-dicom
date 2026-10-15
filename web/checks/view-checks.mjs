// Scripted headless-Chromium checks for /view and the landing page.
//   node web/checks/view-checks.mjs [--only=name] [--perf]
// Each run makes fresh test links first (web/checks/fixtures.ts) and deletes them at the end.
// Screenshots go to docs/shots/view/. Exits non-zero if any check fails.
import { chromium } from "playwright-core";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const BASE = process.env.BASE ?? "http://localhost:3333";
const SHOTS = new URL("../../docs/shots/view/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
execFileSync("bun", [new URL("./fixtures.ts", import.meta.url).pathname, BASE], { stdio: ["ignore", "ignore", "inherit"] });
const F = JSON.parse(readFileSync("/tmp/view-fixtures.json", "utf8"));
const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice(7);
const wantPerf = args.includes("--perf");

const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone390: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  phone360: { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  landscape: { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium" });

async function newPage(dev, opts = {}) {
  const context = await browser.newContext({ ...DEVICES[dev], acceptDownloads: true });
  await context.addInitScript(() => {
    // Downloads go through the Blob path so the test can capture them.
    delete window.showSaveFilePicker;
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !(opts.allowErrors ?? []).some((re) => re.test(m.text()))) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // Name the URL behind "Failed to load resource" errors.
  page.on("response", (r) => {
    if (r.status() >= 400 && !(opts.allowErrors ?? []).some((re) => re.test(String(r.status())))) errors.push(`${r.status()} ${r.url().slice(0, 100)}`);
  });
  return { context, page, errors };
}

const viewUrl = (link, q = "") => `${BASE}/view${q}#${link}`;

async function layoutChecks(page, label, dev) {
  const r = await page.evaluate((coarse) => {
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    const small = [];
    if (coarse) {
      for (const el of document.querySelectorAll("button, a.btn, select, input, .series-btn, [role=button]")) {
        const s = getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden" || el.closest(".hidden")) continue;
        const b = el.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;
        if (b.height < 43.5 || b.width < 43.5) small.push(`${el.tagName.toLowerCase()}#${el.id || el.className} ${Math.round(b.width)}×${Math.round(b.height)}`);
      }
    }
    return { overflow, small, scrollY: window.scrollY, coarse: matchMedia("(pointer: coarse)").matches };
  }, dev !== "desktop");
  check(`${label}: no horizontal overflow`, r.overflow <= 0, `scrollWidth − innerWidth = ${r.overflow}`);
  if (dev !== "desktop") check(`${label}: targets ≥ 44 px (coarse=${r.coarse})`, r.small.length === 0, r.small.join(", "));
  return r;
}

async function waitOverview(page) {
  await page.waitForSelector("#screen-overview:not(.hidden)", { timeout: 20000 });
  await page.waitForFunction(() => window.__view?.marks["first-thumb"], null, { timeout: 20000 });
}
async function openFirstStudy(page, idx = 0) {
  await page.locator(".study-open").nth(idx).click();
  await page.waitForFunction(() => window.__view?.marks["first-slice"], null, { timeout: 20000 });
  await page.waitForTimeout(600);
}
const state = (page) => page.evaluate(() => window.__viewHooks.state());

// CDP touch helpers (Input.dispatchTouchEvent): Chromium turns these into pointer events.
async function touch(page, cdp, pointsFrames, stepMs = 16) {
  const [first, ...rest] = pointsFrames;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: first.map((p, i) => ({ x: p[0], y: p[1], id: i })) });
  for (const f of rest) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: f.map((p, i) => ({ x: p[0], y: p[1], id: i })) });
    await page.waitForTimeout(stepMs);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
const lerp = (a, b, n) => Array.from({ length: n + 1 }, (_, k) => a + ((b - a) * k) / n);

// ---------------------------------------------------------------------------------------- flows

async function flowPublic(dev) {
  const label = `public/${dev}`;
  const { context, page, errors } = await newPage(dev);
  await page.goto(viewUrl(F.publicLink));
  await waitOverview(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}${dev}-overview.png` });
  const ov = await layoutChecks(page, `${label} overview`, dev);
  check(`${label} overview: scrollY 0 on load`, ov.scrollY === 0, `scrollY=${ov.scrollY}`);
  const nStudies = await page.locator(".study-card").count();
  check(`${label}: every study listed`, nStudies === F.sample.studies, `${nStudies} of ${F.sample.studies}`);
  const kicker = await page.textContent("#top-title");
  check(`${label}: "Shared with you" line`, kicker.startsWith(`Shared with you · ${F.sample.label}`), kicker);
  await openFirstStudy(page, F.sample.mriStudy);
  const s = await state(page);
  const seriesName = await page.locator('.series-btn[aria-current="true"] .s-name').textContent();
  check(`${label}: opens on largest axial series`, seriesName === "T2 FSE AX", seriesName);
  await page.screenshot({ path: `${SHOTS}${dev}-viewer.png` });
  const v = await layoutChecks(page, `${label} viewer`, dev);
  check(`${label} viewer: scrollY 0`, v.scrollY === 0, `scrollY=${v.scrollY}`);
  const docH = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  check(`${label} viewer: fits the screen (no page scroll)`, docH <= 0, `extra=${docH}`);

  if (dev === "desktop") {
    // Wheel = slice; drag = window/level; dblclick = reset.
    const box = await page.locator("#stage").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(150);
    const s2 = await state(page);
    check(`${label}: wheel changes slice`, s2.sliceIdx === s.sliceIdx + 1, `${s.sliceIdx} → ${s2.sliceIdx}`);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 - 40, { steps: 6 });
    await page.mouse.up();
    const s3 = await state(page);
    check(`${label}: mouse drag changes window/level`, s3.ww !== s2.ww && s3.wc !== s2.wc, `W ${Math.round(s2.ww)}→${Math.round(s3.ww)} L ${Math.round(s2.wc)}→${Math.round(s3.wc)}`);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -200);
    await page.keyboard.up("Control");
    await page.waitForTimeout(100);
    const s4 = await state(page);
    check(`${label}: ctrl+wheel zooms`, s4.zoom > 1.2, `zoom=${s4.zoom.toFixed(2)}`);
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    const s5 = await state(page);
    check(`${label}: double-click resets`, s5.zoom === 1 && s5.ww === s.ww, `zoom=${s5.zoom} W=${Math.round(s5.ww)}`);
    // Series strip.
    const t1 = F.sample.mriSeries.indexOf("T1 SE AX");
    await page.locator(`.series-btn[data-series="${t1}"]`).click();
    await page.waitForFunction((t1) => window.__viewHooks.state().seriesIdx === t1, t1);
    await page.waitForTimeout(500);
    const t = await page.textContent("#hud-tl");
    check(`${label}: series strip switches series`, t.startsWith("T1 SE AX"), t.split("\n")[0]);
    // Thumbnails drawn.
    await page.waitForTimeout(1500);
    const drawn = await page.locator(".series-btn canvas[data-drawn]").count();
    const n = F.sample.mriSeries.length;
    check(`${label}: strip thumbnails drawn`, drawn === n, `${drawn}/${n}`);
  } else {
    const cdp = await context.newCDPSession(page);
    const box = await page.locator("#stage").boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    // One-finger vertical drag: ~9 px per slice.
    await touch(page, cdp, lerp(0, 1, 10).map((t) => [[cx, cy - 30 + t * 60]]));
    await page.waitForTimeout(150);
    const s2 = await state(page);
    check(`${label}: one-finger vertical drag changes slice`, s2.sliceIdx > s.sliceIdx, `${s.sliceIdx} → ${s2.sliceIdx}`);
    // Two-finger parallel drag: window/level.
    await touch(page, cdp, lerp(0, 1, 10).map((t) => [[cx - 40 + t * 50, cy - 20 * t], [cx + 40 + t * 50, cy - 20 * t]]));
    await page.waitForTimeout(100);
    const s3 = await state(page);
    check(`${label}: two-finger drag changes window/level`, s3.ww !== s2.ww, `W ${Math.round(s2.ww)}→${Math.round(s3.ww)}`);
    // Pinch out: zoom.
    await touch(page, cdp, lerp(0, 1, 10).map((t) => [[cx - 30 - 50 * t, cy], [cx + 30 + 50 * t, cy]]));
    await page.waitForTimeout(100);
    const s4 = await state(page);
    check(`${label}: pinch zooms`, s4.zoom > 1.5, `zoom=${s4.zoom.toFixed(2)}`);
    await page.screenshot({ path: `${SHOTS}${dev}-viewer-zoomed.png` });
    // Double tap: reset.
    for (let k = 0; k < 2; k++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy, id: 0 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(100);
    const s5 = await state(page);
    check(`${label}: double-tap resets zoom and window`, s5.zoom === 1 && Math.round(s5.ww) === Math.round(s.ww), `zoom=${s5.zoom} W=${Math.round(s5.ww)}`);
    // The page still scrolls when a drag starts outside the image (overview).
  }

  // Download sheet.
  await page.click("#btn-download");
  await page.waitForSelector("#sheet-download:not(.hidden)");
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}${dev}-download-sheet.png` });
  if (dev !== "desktop") await layoutChecks(page, `${label} download sheet`, dev);
  if (dev === "desktop" || dev === "phone390") {
    const dl = page.waitForEvent("download", { timeout: 60000 });
    await page.locator(".dl-option").nth(1).click(); // This series
    const d = await dl;
    const path = `/tmp/view-${dev}-${d.suggestedFilename()}`;
    await d.saveAs(path);
    const list = execFileSync("unzip", ["-l", path]).toString();
    const files = list.split("\n").filter((l) => /DICOM\/ST000001\/SE\d+\/IM\d+/.test(l)).length;
    check(`${label}: series ZIP has DICOMDIR + files`, list.includes("DICOMDIR") && files > 0, `${d.suggestedFilename()} · ${files} files`);
    try {
      const out = execFileSync("dcmdump", ["--search", "0004,1430", execFileSync("sh", ["-c", `cd /tmp && rm -rf dd-${dev} && mkdir dd-${dev} && cd dd-${dev} && unzip -q ${path} DICOMDIR && echo /tmp/dd-${dev}/DICOMDIR`]).toString().trim()]).toString();
      check(`${label}: DICOMDIR parses (dcmdump)`, /IMAGE/.test(out), out.split("\n").filter(Boolean).length + " records");
    } catch (e) {
      check(`${label}: DICOMDIR parses (dcmdump)`, false, String(e).slice(0, 200));
    }
    await page.waitForSelector("#dl-status:has-text('Saved')");
    await page.screenshot({ path: `${SHOTS}${dev}-download-done.png` });
  }
  await page.click("#sheet-download [data-close]");

  // Trust sheet.
  await page.click("#btn-trust");
  await page.waitForSelector("#sheet-trust:not(.hidden)");
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}${dev}-trust.png` });
  const trust = await page.textContent("#trust-facts");
  check(`${label}: trust sheet counts verified pieces`, /\d+ pieces checked so far, none altered/.test(trust), trust.match(/\d+ pieces checked[^.]*/)?.[0]);
  await page.click("#sheet-trust [data-close]");

  // Back to the overview (history).
  await page.click("#btn-back");
  await page.waitForSelector("#screen-overview:not(.hidden)");
  check(`${label}: back returns to overview`, true);

  // Wrist study opens on the first series.
  await page.locator(".study-open").nth(F.sample.wristStudy).click();
  await page.waitForFunction((w) => window.__viewHooks.state().studyIdx === w, F.sample.wristStudy);
  await page.waitForFunction(() => !document.querySelector("#stage-busy:not(.hidden)"));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}${dev}-viewer-wrist.png` });
  check(`${label}: no console errors`, errors.length === 0, errors.join(" | "));
  await context.close();
}

async function flowPasscode(dev) {
  const label = `passcode/${dev}`;
  const { context, page, errors } = await newPage(dev, { allowErrors: [/401/, /^404$/, /status of 404/] });
  // Wrong tries go to a test link: on the seeded sample they would use up its attempts.
  await page.goto(viewUrl(dev === "desktop" ? F.passcodeLink : F.passcodeTestLink));
  await page.waitForSelector("#screen-passcode:not(.hidden)");
  await page.screenshot({ path: `${SHOTS}${dev}-passcode.png` });
  await layoutChecks(page, `${label} prompt`, dev);
  if (dev === "desktop") {
    // The seeded sample: right passcode only.
    await page.fill("#input-passcode", "1234");
    await page.click("#btn-passcode");
    await waitOverview(page);
    check(`${label}: seeded passcode sample opens with 1234`, true);
    // A /cap/ prefix that has expired answers 404: the viewer re-resolves the link (same
    // passcode) and retries the read under the new prefix.
    let posts = 0, failed = 0;
    page.on("request", (r) => r.method() === "POST" && /\/shl\//.test(r.url()) && posts++);
    await page.route(/\/cap\/.*\.bin/, (r) => (failed++ === 0 ? r.fulfill({ status: 404, body: "Not Found" }) : r.continue()));
    await openFirstStudy(page);
    check(`${label}: expired /cap/ prefix → re-resolve and retry`, posts === 1 && failed > 1, `manifest POSTs after open: ${posts}`);
    check(`${label}: viewer draws through /cap/`, true);
    check(`${label}: no console errors`, errors.length === 0, errors.join(" | "));
    await context.close();
    return;
  }
  await page.fill("#input-passcode", "0000");
  await page.click("#btn-passcode");
  await page.waitForFunction(() => document.querySelector("#passcode-msg").textContent.length > 0);
  const msg = await page.textContent("#passcode-msg");
  check(`${label}: wrong passcode shows attempts left`, /not right\. \d+ attempts? left/.test(msg), msg);
  await page.screenshot({ path: `${SHOTS}${dev}-passcode-wrong.png` });
  await page.fill("#input-passcode", "1234");
  await page.click("#btn-passcode");
  await waitOverview(page);
  check(`${label}: right passcode opens the overview`, true);
  await openFirstStudy(page);
  check(`${label}: viewer draws through /cap/`, true);
  check(`${label}: no console errors`, errors.length === 0, errors.join(" | "));
  await context.close();
}

async function flowSubset(dev) {
  const label = `subset/${dev}`;
  const { context, page, errors } = await newPage(dev);
  await page.goto(viewUrl(F.subsetLink));
  await waitOverview(page);
  const titles = await page.locator(".study-title").allTextContents();
  check(`${label}: only the wrist study`, titles.length === 1, titles.join(", "));
  await page.screenshot({ path: `${SHOTS}${dev}-subset-overview.png` });
  await openFirstStudy(page);
  await page.screenshot({ path: `${SHOTS}${dev}-subset-viewer.png` });
  check(`${label}: no console errors`, errors.length === 0, errors.join(" | "));
  await context.close();
}

async function flowStates(dev) {
  const label = `states/${dev}`;
  // Revoked.
  {
    const { context, page } = await newPage(dev, { allowErrors: [/404/] });
    await page.goto(viewUrl(F.revokedLink));
    await page.waitForSelector("#screen-error:not(.hidden)");
    const t = await page.textContent("#error-title");
    check(`${label}: revoked link → "no longer works"`, t === "This link no longer works", t);
    await page.screenshot({ path: `${SHOTS}${dev}-revoked.png` });
    await layoutChecks(page, `${label} revoked`, dev);
    await context.close();
  }
  // Expired (by the link's exp).
  {
    const { context, page, errors } = await newPage(dev);
    await page.goto(viewUrl(F.expiredLink));
    await page.waitForSelector("#screen-error:not(.hidden)");
    const t = await page.textContent("#error-title");
    check(`${label}: expired link → "has expired"`, t === "This link has expired", t);
    await page.screenshot({ path: `${SHOTS}${dev}-expired.png` });
    check(`${label}: expired: no requests needed, no errors`, errors.length === 0, errors.join(" | "));
    await context.close();
  }
  // Too many attempts.
  {
    const { context, page } = await newPage(dev, { allowErrors: [/401|404/] });
    await page.goto(viewUrl(dev === "desktop" ? F.lockLinks.desktop : F.lockLinks.phone));
    let t = "";
    for (let k = 0; k < 12; k++) {
      await page.waitForSelector("#screen-passcode:not(.hidden), #screen-error:not(.hidden)");
      if (await page.isVisible("#screen-error")) break;
      await page.fill("#input-passcode", `bad${k}`);
      await page.click("#btn-passcode");
      await page.waitForFunction(() => !document.querySelector("#btn-passcode").disabled || !document.querySelector("#screen-error.hidden"));
      await page.waitForTimeout(100);
    }
    t = await page.textContent("#error-title");
    check(`${label}: too many attempts → locked`, t === "Too many wrong passcodes", t);
    await page.screenshot({ path: `${SHOTS}${dev}-locked.png` });
    await context.close();
  }
  // Server unreachable, then offline.
  {
    const { context, page } = await newPage(dev, { allowErrors: [/ERR_|Failed to load/] });
    await page.route("**/shl/**", (r) => r.abort("connectionrefused"));
    await page.goto(viewUrl(F.publicLink));
    await page.waitForSelector("#screen-error:not(.hidden)");
    const t = await page.textContent("#error-title");
    check(`${label}: unreachable host → "Couldn't reach the server"`, t === "Couldn't reach the server", t);
    await page.screenshot({ path: `${SHOTS}${dev}-network.png` });
    await context.setOffline(true);
    await page.click("#btn-retry");
    await page.waitForSelector("#screen-error:not(.hidden)");
    await page.waitForTimeout(200);
    const t2 = await page.textContent("#error-title");
    check(`${label}: offline → "You're offline"`, t2 === "You're offline", t2);
    await page.screenshot({ path: `${SHOTS}${dev}-offline.png` });
    await context.setOffline(false);
    await page.unroute("**/shl/**");
    await page.click("#btn-retry");
    await waitOverview(page);
    check(`${label}: retry recovers after reconnecting`, true);
    await context.close();
  }
  // Bare /view: paste screen.
  {
    const { context, page, errors } = await newPage(dev);
    await page.goto(`${BASE}/view`);
    await page.waitForSelector("#paste-form:not(.hidden)");
    await page.screenshot({ path: `${SHOTS}${dev}-bare.png` });
    await page.fill("#input-link", `https://example.org/viewer#${F.subsetLink}`);
    await page.click("#paste-form button[type=submit]");
    await waitOverview(page);
    check(`${label}: bare /view accepts a pasted link`, true);
    check(`${label}: bare: no console errors`, errors.length === 0, errors.join(" | "));
    await context.close();
  }
}

async function flowCt(dev) {
  const label = `ct/${dev}`;
  const { context, page, errors } = await newPage(dev);
  await page.goto(viewUrl(F.perfLink));
  await waitOverview(page);
  await openFirstStudy(page);
  const opts = await page.locator("#preset option").allTextContents();
  check(`${label}: CT window presets`, opts.join(",") === "Auto,Soft tissue,Lung,Bone,Brain", opts.join(", "));
  await page.selectOption("#preset", "lung");
  const s = await state(page);
  check(`${label}: Lung preset sets W 1500 L −600`, s.ww === 1500 && s.wc === -600, `W ${s.ww} L ${s.wc}`);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}${dev}-ct-lung.png` });
  await layoutChecks(page, `${label} viewer`, dev);
  await page.click("#btn-back");
  await page.locator(".study-open").nth(1).click();
  await page.waitForFunction(() => /2048/.test(document.querySelector("#hud-tr").textContent));
  const dxOpts = await page.locator("#preset option").count();
  check(`${label}: no preset menu for DX (Auto only)`, !(await page.isVisible("#preset")), `${dxOpts} option(s)`);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}${dev}-dx2048.png` });
  check(`${label}: no console errors`, errors.length === 0, errors.join(" | "));
  await context.close();
}

// FHIR DiagnosticReports beside the images (the sandbox's reports, web/checks/fixtures.ts).
async function flowReports(dev) {
  const label = `reports/${dev}`;
  if (!F.reportsLink) return check(`${label}: sandbox reports fixture`, false, "imaging-sandbox/build/dataset missing");
  const { context, page, errors } = await newPage(dev);
  await page.goto(viewUrl(F.reportsLink));
  await waitOverview(page);
  // Accessions come from image headers once the overview has decoded one image per study.
  await page.waitForFunction(() => document.querySelectorAll(".report-from").length >= 5 && [...document.querySelectorAll(".report-from")].some((e) => /accession/.test(e.textContent)), null, { timeout: 20000 }).catch(() => {});
  const rows = await page.$$eval(".report", (bs) => bs.map((b) => ({ title: b.closest(".study-card").querySelector(".study-title")?.textContent ?? "(no study)", basis: b.dataset.basis, from: b.querySelector(".report-from").textContent })));
  const row = (re) => rows.find((r) => re.test(r.title)) ?? { basis: "", from: "" };
  check(`${label}: report linked by its imagingStudy reference (a Bundle fullUrl)`, row(/HAND AND WRIST RT/).basis === "reference", JSON.stringify(row(/HAND AND WRIST RT/)));
  check(`${label}: report linked by a relative ImagingStudy/<id> reference`, row(/WRIST LEFT/).basis === "reference", JSON.stringify(row(/WRIST LEFT/)));
  check(`${label}: report linked by Study Instance UID`, row(/BRAIN/).basis === "uid" && row(/BRAIN/).from === "From the clinical record.", JSON.stringify(row(/BRAIN/)));
  check(`${label}: report linked by accession (from the DICOM header)`, row(/CT ABDOMEN/).basis === "accession" && /accession/.test(row(/CT ABDOMEN/).from), JSON.stringify(row(/CT ABDOMEN/)));
  check(`${label}: report linked by date is labelled as a guess`, row(/Histopathology/).basis === "date" && /date and type of exam/.test(row(/Histopathology/).from), JSON.stringify(row(/Histopathology/)));
  check(`${label}: report without images listed on its own`, /without images/.test(await page.textContent(".loose-reports")) && row(/\(no study\)/).basis === "none", JSON.stringify(row(/\(no study\)/)));
  await page.screenshot({ path: `${SHOTS}${dev}-reports-overview.png`, fullPage: dev !== "desktop" });
  await layoutChecks(page, `${label} overview`, dev);
  const brain = await page.locator(".study-open").evaluateAll((bs) => bs.findIndex((b) => /BRAIN/.test(b.textContent)));
  await page.locator(".study-open").nth(brain).click();
  await page.waitForFunction(() => window.__view?.marks["first-slice"], null, { timeout: 20000 });
  if (dev === "desktop") {
    check(`${label}: report opens beside the images`, await page.isVisible("#report-panel"));
    const box = await page.locator("#stage").boundingBox(), panel = await page.locator("#report-panel").boundingBox();
    check(`${label}: images and report side by side`, box.x + box.width <= panel.x + 1, `stage ends ${Math.round(box.x + box.width)}, panel starts ${Math.round(panel.x)}`);
  } else {
    check(`${label}: report closed until asked for on a phone`, !(await page.isVisible("#report-panel")));
    await page.click("#btn-report");
    check(`${label}: Report button opens it`, await page.isVisible("#report-panel"));
  }
  await page.locator("#report-panel .report-tab", { hasText: "PDF" }).click();
  await page.waitForSelector("#report-panel .pdf-pages[data-rendered]", { timeout: 20000 });
  const pdfPages = await page.locator("#report-panel canvas.pdf-page").count();
  check(`${label}: PDF attachment rendered`, pdfPages >= 1, `${pdfPages} page(s)`);
  await page.screenshot({ path: `${SHOTS}${dev}-reports-pdf.png` });
  await page.locator("#report-panel .report-tab", { hasText: "Text" }).click();
  const txt = await page.textContent("#report-panel .report-text");
  const want = F.reportsMriText.trim();
  check(`${label}: text attachment shown as is`, txt.trim() === want, `${txt.trim().length} of ${want.length} characters match: ${txt.slice(0, 40)}`);
  await layoutChecks(page, `${label} panel`, dev);
  await page.click("#btn-report-close");
  check(`${label}: report closes`, !(await page.isVisible("#report-panel")));
  check(`${label}: no console errors`, errors.length === 0, errors.join(" | "));
  await context.close();
}

// The server's own sample (Josh Example): every report links to its study exactly, never by the
// date fallback, and no report is left without its images.
async function flowSampleReports(dev) {
  const label = `sample-reports/${dev}`;
  const { context, page, errors } = await newPage(dev);
  await page.goto(viewUrl(F.publicLink));
  await waitOverview(page);
  await page.waitForTimeout(1500);
  const rows = await page.$$eval(".report", (bs) => bs.map((b) => ({ study: b.closest(".study-card").querySelector(".study-open")?.dataset.study ?? null, basis: b.dataset.basis })));
  const studies = await page.locator(".study-open").count();
  const exact = rows.filter((r) => r.basis === "reference" || r.basis === "uid");
  check(`${label}: ${F.sample.reports} reports, each linked exactly`, rows.length === F.sample.reports && exact.length === rows.length, rows.map((r) => r.basis).join(", "));
  check(`${label}: one report per study, every study has one`, new Set(exact.map((r) => r.study)).size === Math.min(studies, rows.length) && rows.every((r) => r.study !== null), `${new Set(exact.map((r) => r.study)).size} studies of ${studies}`);
  check(`${label}: no console errors`, errors.length === 0, errors.join(" | "));
  await context.close();
}

async function flowPages(dev) {
  const label = `pages/${dev}`;
  const { context, page, errors } = await newPage(dev);
  await page.goto(`${BASE}/`);
  await page.waitForSelector("#sample-public:not([aria-disabled])");
  await page.screenshot({ path: `${SHOTS}${dev}-landing.png`, fullPage: true });
  await layoutChecks(page, `${label} landing`, dev);
  const y = await page.evaluate(() => scrollY);
  check(`${label} landing: scrollY 0`, y === 0);
  await page.click("#sample-public");
  await waitOverview(page);
  check(`${label}: "Try a sample" opens /view`, new URL(page.url()).pathname === "/view");
  // Root-prefixed links (seeded samples use https://host/#shlink:/…) forward to /view.
  await page.goto(`${BASE}/#${F.subsetLink}`);
  await waitOverview(page);
  check(`${label}: /#shlink:/… forwards to /view`, new URL(page.url()).pathname === "/view");
  check(`${label}: no console errors`, errors.length === 0, errors.join(" | "));
  await context.close();
}

// ---------------------------------------------------------------------------------------- perf

/**
 * Main-thread cost while a whole series streams in: open a study cold, then until every slice is
 * decoded, record animation-frame intervals and long tasks (> 50 ms). Decrypt work on the main
 * thread shows up here; decrypt in the workers should not.
 */
async function prefetchLoad(link, studyIdx, want) {
  const { context, page } = await newPage("desktop");
  await context.addInitScript(() => {
    window.__lt = [];
    new PerformanceObserver((l) => window.__lt.push(...l.getEntries().map((e) => ({ t: e.startTime, d: e.duration })))).observe({ type: "longtask", buffered: true });
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const busy = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  await page.goto(viewUrl(link));
  await page.waitForSelector(".study-open");
  await page.waitForTimeout(1500); // let the overview's thumbnails finish: measure the series load only
  const m0 = await busy();
  await page.locator(".study-open").nth(studyIdx).click();
  await page.waitForFunction(() => window.__view.marks["first-slice"], null, { timeout: 30000 });
  const r = await page.evaluate(async (want) => {
    const t0 = window.__view.marks["first-slice"];
    const frames = [];
    let last = performance.now();
    while (window.__viewHooks.cached() < want && performance.now() - t0 < 60000) {
      await new Promise(requestAnimationFrame);
      const now = performance.now();
      frames.push(now - last);
      last = now;
    }
    const t1 = performance.now();
    const lt = window.__lt.filter((e) => e.t >= t0 - 1 && e.t <= t1);
    return { allDecodedMs: Math.round(t1 - t0), frames, longTasks: lt.length, longTaskMs: Math.round(lt.reduce((a, e) => a + e.d, 0)), worstTaskMs: Math.round(Math.max(0, ...lt.map((e) => e.d))) };
  }, want);
  const m1 = await busy();
  await context.close();
  const s = [...r.frames].sort((a, b) => a - b);
  const q = (p) => +(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0).toFixed(1);
  return { allDecodedMs: r.allDecodedMs, mainTaskMs: Math.round((m1.TaskDuration - m0.TaskDuration) * 1000), mainScriptMs: Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000), longTasks: r.longTasks, longTaskMs: r.longTaskMs, worstTaskMs: r.worstTaskMs, frameMedian: q(0.5), frameP95: q(0.95), frameMax: q(1) };
}

async function perf() {
  const out = {};
  const runs = (n, f) => Promise.resolve().then(async () => { const a = []; for (let k = 0; k < n; k++) a.push(await f()); return a; });
  out["prefetch-mri-t2-20"] = await runs(3, () => prefetchLoad(F.publicLink, 0, 20));
  out["prefetch-ct-100"] = await runs(3, () => prefetchLoad(F.perfLink, 0, 100));
  if (process.env.PREFETCH_ONLY) {
    console.log(JSON.stringify(out, null, 2));
    writeFileSync("/tmp/view-perf.json", JSON.stringify(out, null, 2));
    return;
  }
  // Time to first image from a cold load (fresh context = empty HTTP cache), desktop and phone.
  for (const dev of ["desktop", "phone390"]) {
    const runs = [];
    for (let k = 0; k < 5; k++) {
      const { context, page } = await newPage(dev);
      await page.goto(viewUrl(F.publicLink));
      await page.waitForSelector(".study-open");
      const tClick = await page.evaluate(() => performance.now());
      await page.locator(".study-open").first().click();
      await page.waitForFunction(() => window.__view.marks["first-slice"], null, { timeout: 20000 });
      const m = await page.evaluate(() => ({ ...window.__view.marks, nav: performance.getEntriesByType("navigation")[0].toJSON() }));
      runs.push({
        domContentLoaded: Math.round(m.nav.domContentLoadedEventEnd),
        bundle: m.bundle,
        poolReady: m["pool-ready"],
        overview: m.overview,
        firstThumb: m["first-thumb"],
        click: Math.round(tClick),
        firstSlice: m["first-slice"],
        clickToSlice: m["first-slice"] - Math.round(tClick),
      });
      await context.close();
    }
    out[`cold-${dev}`] = runs;
  }
  // Scrolling and window/level on the synthetic CT (512²) and DX (2048²): CPU fallback (what
  // this machine's SwiftShader gets) and the GL path forced on SwiftShader.
  for (const renderer of ["cpu", "gl"]) {
    const { context, page } = await newPage("desktop");
    await page.goto(viewUrl(F.perfLink, `?renderer=${renderer}`));
    await waitOverview(page);
    const studies = await page.locator(".study-title").allTextContents();
    await page.locator(".study-open").first().click();
    await page.waitForFunction(() => window.__view.marks["first-slice"]);
    const info = await page.evaluate(() => ({ s: window.__viewHooks.state(), hud: document.querySelector("#hud-tr").textContent }));
    // Wait for prefetch to decode every slice.
    const tPre0 = Date.now();
    await page.waitForFunction(() => {
      const st = window.__viewHooks.state();
      return st.sliceCount >= 100 && window.__viewHooks.cached() === st.sliceCount;
    }, null, { timeout: 60000 });
    const prefetchMs = Date.now() - tPre0;
    const scroll = await page.evaluate(async () => {
      const h = window.__viewHooks;
      const n = h.state().sliceCount;
      const frames = [];
      let last = performance.now();
      const drawsBefore = window.__view.draws.length;
      for (let k = 0; k < 2 * n; k++) {
        h.showSlice(k % n);
        await new Promise(requestAnimationFrame);
        const now = performance.now();
        frames.push(now - last);
        last = now;
      }
      return { frames, draws: window.__view.draws.slice(drawsBefore) };
    });
    const wl = async () =>
      page.evaluate(async () => {
        const h = window.__viewHooks;
        const s0 = h.state();
        const frames = [];
        const drawsBefore = window.__view.draws.length;
        let last = performance.now();
        for (let k = 0; k < 120; k++) {
          h.setWindow(s0.wc + (k % 20) * 5, s0.ww + (k % 30) * 7);
          await new Promise(requestAnimationFrame);
          const now = performance.now();
          frames.push(now - last);
          last = now;
        }
        return { frames, draws: window.__view.draws.slice(drawsBefore) };
      });
    const wl512 = await wl();
    // Switch to the DX study.
    await page.click("#btn-back");
    await page.locator(".study-open").nth(1).click();
    await page.waitForFunction(() => window.__viewHooks.state().studyIdx === 1);
    await page.waitForFunction(() => /2048/.test(document.querySelector("#hud-tr").textContent));
    await page.waitForTimeout(500);
    const wl2048 = await wl();
    const st = (a) => {
      if (!a.length) return null;
      const s = [...a].sort((x, y) => x - y);
      const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
      return { median: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), over20ms: s.filter((x) => x > 20).length, n: s.length };
    };
    out[`interaction-${renderer}`] = {
      studies,
      renderer: info.s.renderer,
      firstImage: info.hud,
      prefetchWaitMs: prefetchMs,
      scroll512: { frameMs: st(scroll.frames), drawMs: st(scroll.draws) },
      wl512: { frameMs: st(wl512.frames), drawMs: st(wl512.draws) },
      wl2048: { frameMs: st(wl2048.frames), drawMs: st(wl2048.draws) },
    };
    await page.screenshot({ path: `${SHOTS}perf-${renderer}-dx2048.png` });
    await context.close();
  }
  out.loadavg = readFileSync("/proc/loadavg", "utf8").trim();
  writeFileSync("/tmp/view-perf.json", JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

// ---------------------------------------------------------------------------------------- run

const flows = {
  public: () => Promise.all(["desktop", "phone390"].map(flowPublic)).then(() => Promise.all(["phone360", "landscape"].map(flowPublic))),
  passcode: () => Promise.all(["desktop", "phone390"].map(flowPasscode)),
  subset: () => Promise.all(["desktop", "phone360"].map(flowSubset)),
  states: () => Promise.all(["desktop", "phone390"].map(flowStates)),
  ct: () => Promise.all(["desktop", "phone390"].map(flowCt)),
  reports: () => Promise.all(["desktop", "phone390"].map(flowReports)),
  "sample-reports": () => Promise.all(["desktop", "phone390"].map(flowSampleReports)),
  pages: () => Promise.all(["desktop", "phone390", "landscape"].map(flowPages)),
};
try {
  for (const [name, f] of Object.entries(flows)) {
    if (only && only !== name) continue;
    try {
      await f();
    } catch (e) {
      check(`${name}: flow threw`, false, String(e?.stack ?? e).slice(0, 600));
    }
  }
  if (wantPerf) await perf();
} finally {
  await browser.close();
  for (const sh of F.shares) {
    await fetch(`${BASE}/api/shares/${sh.sid}`, { method: "DELETE", headers: { Authorization: `Bearer ${sh.token}` } }).catch(() => {});
  }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
writeFileSync("/tmp/view-checks.json", JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
