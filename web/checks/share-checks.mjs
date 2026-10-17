// Scripted headless-Chromium checks for /share and /share/manage.
//   node web/checks/share-checks.mjs [--only=files|portal|reshare|manage|slide|big] [--dev=desktop|phone390] [--big]
// Data: synthetic files (web/checks/synthetic.ts) for the files and manage flows; the sandbox dataset
// (imaging-sandbox/build/dataset/dicom, from `bun imaging-sandbox/scripts/build-data.ts`) for the portal
// and re-share flows, which use the sandbox and the server's sample. Expectations are read from the data.
// The slide flow needs the CPTAC-LUAD slide (web/view/WSI.md) in SLIDE_DIR; it is skipped without it.
// Needs the server on :3333 and the imaging sandbox on :3334 started with
//   SHARE_REDIRECT_URIS=http://localhost:3333/share/smart-callback/ bun src/server.ts
// Screenshots go to docs/shots/share/. Exits non-zero if any check fails. Deletes the shares it makes.
import { launchBrowser, pageErrorCheck } from "./browser.mjs";
import { downloadMatrix } from "./download-matrix.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const BASE = process.env.BASE ?? "http://localhost:3333";
// The portal the Share page offers by default for this site.
// PORTAL overrides it (a sandbox on another port, when :3334 is taken).
const PORTAL = process.env.PORTAL ?? (/\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE) ? `http://${new URL(BASE).hostname}:3334/fhir` : "https://smart-imaging-sandbox.exe.xyz/fhir");
const ROOT = new URL("../../", import.meta.url).pathname;
const SHOTS = `${ROOT}docs/shots/share/`;
mkdirSync(SHOTS, { recursive: true });
const DATASET = `${ROOT}imaging-sandbox/build/dataset/dicom`;
const fixtures = (...a) => JSON.parse(execFileSync("bun", [`${ROOT}web/checks/share-fixtures.ts`, ...a], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 }).trim().split("\n").pop());
const FXDIR = `/tmp/share-checks-${process.pid}`;
const FX = fixtures("synthetic", FXDIR);
// The server's sample and the sandbox are built from the same dataset; expectations for them come
// from the sample's Bundle. Byte-for-byte checks against the local build run when it is the same data.
const LOCAL = fixtures("expect", DATASET);
let SAMPLE; // { link, index, totals: { studies, series, images }, sameAsLocal }
async function sample() {
  if (SAMPLE) return SAMPLE;
  const demos = await (await fetch(`${BASE}/api/demo-shares`)).json();
  const link = demos.shares.find((s) => !s.passcodeHint).shlinkUri;
  const index = verify(link, [], undefined, ["--index-only"]);
  const totals = { studies: index.studies, series: index.studies.reduce((a, s) => a + s.series, 0), images: index.studies.reduce((a, s) => a + s.instances, 0) };
  SAMPLE = { link, index, totals, sameAsLocal: totals.images === LOCAL.images && totals.series === LOCAL.series && totals.studies.length === LOCAL.studies.length };
  if (!SAMPLE.sameAsLocal) console.log(`NOTE the server's sample (${totals.series} series, ${totals.images} images) is not the local dataset build (${LOCAL.series}, ${LOCAL.images}); byte-for-byte checks are skipped`);
  return SAMPLE;
}
/** Each review card: title, image count, size in MB and report lines, as the page shows them. */
async function cards(page) {
  return page.locator(".study").evaluateAll((els) =>
    els.map((el) => {
      const tech = el.querySelector(":scope > .tech")?.textContent ?? "";
      const m = /([\d.]+) (KB|MB|GB)/.exec(tech);
      return {
        title: el.querySelector("h2")?.textContent ?? "",
        images: Number(/(\d+) images?/.exec(tech)?.[1] ?? 0),
        mb: m ? Number(m[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[m[2]] : 0,
        reports: el.querySelectorAll(".report-line").length,
      };
    }),
  );
}
const pl = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const foundRe = (x) => new RegExp(`^Found ${pl(x.studies.length, "study", "studies")} · ${pl(x.series, "series", "series")} · ${pl(x.images, "image")} · `);
// A whole slide without offset tables: CPTAC-LUAD C3N-02231, all but its 1 GB base level (152 MB).
const SLIDE_DIR = process.env.SLIDE_DIR ?? "/media/barracuda/shlink-dicom-slides/dl/4a6b5ed5-a7e8-450d-9af6-e739b1807bac";
const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice(7);
const onlyDev = args.find((a) => a.startsWith("--dev="))?.slice(6);

const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone390: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const made = []; // manage URLs, deleted at the end

const browser = await launchBrowser();

async function newPage(dev, opts = {}) {
  const context = await browser.newContext({ ...DEVICES[dev], ...(opts.dark ? { colorScheme: "dark" } : {}) });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE }).catch(() => {});
  // Progress bars are watched suite-wide (browser.mjs, progressWatch).
  const errors = [];
  const page = await context.newPage();
  const allowed = (s) => (opts.allowErrors ?? []).some((re) => re.test(s));
  page.on("console", (m) => m.type() === "error" && !allowed(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("response", (r) => r.status() >= 400 && !allowed(`${r.status()} ${r.url()}`) && errors.push(`${r.status()} ${r.url().slice(0, 100)}`));
  return { context, page, errors };
}

async function layout(page, label, dev) {
  const r = await page.evaluate((coarse) => {
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    const small = [];
    if (coarse) {
      for (const el of document.querySelectorAll("button, a.btn, select, input, summary, [role=button]")) {
        const s = getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden" || el.closest(".hidden") || el.closest("dialog:not([open])")) continue;
        const b = el.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;
        if (b.height < 43.5 || b.width < 43.5) small.push(`${el.tagName.toLowerCase()}#${el.id || el.className} ${Math.round(b.width)}×${Math.round(b.height)}`);
      }
    }
    return { overflow, small };
  }, dev !== "desktop");
  check(`${label}: no horizontal overflow`, r.overflow <= 0, `scrollWidth − innerWidth = ${r.overflow}`);
  if (dev !== "desktop") check(`${label}: targets ≥ 44 px`, r.small.length === 0, r.small.join(", "));
}

const shot = (page, name) => page.screenshot({ path: `${SHOTS}${name}.png`, fullPage: true });

function verify(link, archives = [], passcode, extra = []) {
  const out = execFileSync("bun", [`${ROOT}web/checks/share-verify.ts`, link, ...archives, ...(passcode ? [`--passcode=${passcode}`] : []), ...extra], { cwd: ROOT, encoding: "utf8", timeout: 900000, stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out.trim().split("\n").pop());
}
/**
 * Every instance is the file it came from: byte-identical, or (where the share page compressed it,
 * the default) re-encoded without loss with the same pixels and other elements (share-verify --pixels).
 * `exact`: only byte-identical counts.
 */
function sameContent(P, v, n, what, o = {}) {
  if (o.exact) return check(`${P}: every instance byte-identical to ${what}`, v.instances === n && v.matched === n, `${v.matched} of ${n} matched, ${v.mismatched} differ, ${v.missing} missing`);
  const re = o.reencoded === undefined ? true : o.reencoded === v.reencoded;
  check(
    `${P}: every instance byte-identical to ${what} or re-encoded without loss and pixel-identical${o.reencoded !== undefined ? ` (${o.reencoded} re-encoded)` : ""}`,
    v.instances === n && v.matched + v.reencoded === n && v.pixelDiffer === 0 && v.missing === 0 && re,
    `${v.matched} byte-identical, ${v.reencoded} re-encoded and pixel-identical, ${v.pixelDiffer} differ, ${v.missing} missing`,
  );
}

function verifyFails(link) {
  try {
    verify(link);
    return null;
  } catch (e) {
    const t = String(e.stderr || e.message);
    return t.match(/reason: "(\w+)"/)?.[1] ?? t.match(/(LinkError|PasscodeError)[^\n]*/)?.[0] ?? "failed";
  }
}

async function noErrors(label, errors) {
  check(`${label}: no console errors`, errors.length === 0, errors.slice(0, 5).join(" | "));
}

/** Steps 3–5 from the review screen. Returns the result ({ shlink, manage }). */
async function finish(page, dev, prefix, o = {}) {
  await page.click("#rv-next");
  await page.waitForSelector("#s-who:not(.hidden)");
  if (o.recipient) await page.fill("#in-recipient", o.recipient);
  if (o.passcode) await page.fill("#in-pass", o.passcode);
  if (o.expiry) await page.click(`input[name=expiry][value="${o.expiry}"]`);
  if (o.updates) await page.click("#in-updates");
  if (o.shots) {
    await layout(page, `${prefix} who`, dev);
    await shot(page, `${dev}-3-who`);
  }
  await page.click("#who-form button[type=submit]");
  await page.waitForSelector("#s-upload:not(.hidden)");
  if (o.shots) {
    await page.waitForFunction(() => /[Uu]ploaded [^0]/.test(document.getElementById("up-main").textContent), null, { timeout: 30000 }).catch(() => {});
    await shot(page, `${dev}-4-upload`);
  }
  await page.waitForSelector("#s-done:not(.hidden), #up-error:not(.hidden)", { timeout: 900000 });
  if (await page.locator("#up-error:not(.hidden)").count()) throw new Error(`upload failed: ${await page.textContent("#up-error-text")}`);
  const result = await page.evaluate(() => window.__share.result);
  made.push(result.manage);
  if (o.shots) {
    await layout(page, `${prefix} done`, dev);
    await shot(page, `${dev}-5-done`);
  }
  check(`${prefix}: QR code rendered`, (await page.locator("#qr svg").count()) === 1);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("shl-dicom-shares") ?? "[]").length);
  check(`${prefix}: owner link saved in this browser`, saved >= 1, `${saved} saved`);
  const box = { h: await page.textContent(".manage-box h2"), copy: await page.textContent("#m-copy") };
  check(`${prefix}: hand-over names the owner link`, box.h === "Save your owner link" && box.copy === "Copy owner link", JSON.stringify(box));
  return result;
}

async function openInView(dev, link, prefix, o = {}) {
  const { context, page, errors } = await newPage(dev);
  await page.goto(link);
  if (o.passcode) {
    await page.waitForSelector("#screen-passcode:not(.hidden)", { timeout: 20000 });
    await page.fill("#input-passcode", o.passcode);
    await page.click("#btn-passcode");
  }
  await page.waitForSelector("#screen-overview:not(.hidden)", { timeout: 30000 });
  await page.waitForFunction(() => window.__view?.marks["first-thumb"], null, { timeout: 30000 });
  const studies = await page.locator(".study-card").count();
  const reports = await page.locator(".report").allTextContents();
  await shot(page, `${dev}-${o.name}-view`);
  await page.locator(".study-open").first().click();
  await page.waitForFunction(() => window.__view?.marks["first-slice"], null, { timeout: 30000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}${dev}-${o.name}-viewer.png` });
  await noErrors(`${prefix} /view`, errors);
  await context.close();
  return { studies, reports };
}

// ------------------------------------------------------------------------------------- flows

async function flowFiles(dev) {
  const P = `files/${dev}`;
  const mem = await memoryWatch();
  const { context, page, errors } = await newPage(dev);
  await page.goto(`${BASE}/share`);
  await page.waitForSelector(".choice");
  await layout(page, `${P} add`, dev);
  await shot(page, `${dev}-1-add`);
  check(`${P}: four sources offered`, (await page.locator(".choice").count()) === 4);
  await page.click("[data-src=files]");
  await layout(page, `${P} files panel`, dev);
  await shot(page, `${dev}-1-files`);
  await page.setInputFiles("#in-files", FX.files);
  await page.waitForSelector("#s-review:not(.hidden)", { timeout: 60000 });
  await page.waitForFunction(() => document.body.dataset.thumbs === "done", null, { timeout: 30000 });
  const found = await page.textContent("#found");
  check(`${P}: found line counts everything`, foundRe(FX).test(found), found);
  const titles = await page.locator(".study h2").allTextContents();
  const want = FX.studies.map((s) => s.title);
  check(`${P}: plain study names`, titles.join("|") === want.join("|"), titles.join("|"));
  const drawn = await page.locator("canvas.drawn").count();
  check(`${P}: a thumbnail for each of the ${FX.series} series`, drawn === FX.series, `${drawn}`);
  check(`${P}: no offset-table option for single-frame files`, await page.locator("#rv-offsets-row.hidden").count() === 1);
  const tech = await page.locator(".study .tech").first().textContent();
  const s0 = FX.studies[0];
  check(`${P}: technical line`, tech.startsWith(`${pl(s0.series, "series", "series")} · ${pl(s0.images, "image")} · `) && /uncompressed/.test(tech), tech);
  // Attach a report file to the first study.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`${FXDIR}/Report.txt`, "SYNTHETIC REPORT FOR TESTING.\nImpression: test phantom only.\n");
  const canAttach = (await page.locator(".study .reports input[type=file]").count()) > 0;
  check(`${P}: review offers to attach a report`, canAttach, canAttach ? "" : "not on this site yet");
  if (canAttach) {
    await page.locator(".study").first().locator(".reports input[type=file]").setInputFiles(`${FXDIR}/Report.txt`);
    await page.waitForSelector(".study .report-row");
    check(`${P}: attached report listed`, /Report: Report/.test(await page.locator(".study .report-row").first().textContent()));
  }
  await compressReview(page, P, FX);
  await layout(page, `${P} review`, dev);
  await shot(page, `${dev}-2-review`);
  const r = await finish(page, dev, P, { recipient: "Dr. Patel, Neurology", shots: true });
  const upLog = (await page.locator("#up-log li").allTextContents()).find((t) => /^Compressed/.test(t)) ?? "";
  check(`${P}: the upload log says what was compressed`, new RegExp(`^Compressed ${FX.images} images without loss as JPEG Lossless \\(pixels identical\\): `).test(upLog), upLog);
  const m = await mem.done();
  console.log(`MEMORY ${P}: peak renderer resident ${m.peakHwmMB} MB for ${(FX.bytes / 1e6).toFixed(1)} MB (baseline)`);
  const v = verify(r.shlink, FX.files, undefined, ["--pixels"]);
  check(`${P}: link opens with every study`, v.studies.length === FX.studies.length && v.instances === FX.images, JSON.stringify(v.studies.map((s) => s.instances)));
  sameContent(P, v, FX.images, "the files", { reencoded: FX.images });
  check(`${P}: re-encoded as JPEG Lossless by this packer`, v.pixelReport?.transferSyntaxes?.["1.2.840.10008.1.2.4.70"] === FX.images && Object.keys(v.pixelReport?.implementations ?? {}).every((k) => /SHLDICOM/.test(k)), JSON.stringify([v.pixelReport?.transferSyntaxes, v.pixelReport?.implementations]));
  check(`${P}: label in the link`, v.label === "Imaging for Dr. Patel, Neurology", v.label);
  if (canAttach) check(`${P}: attached report is in the Bundle, linked to its study by reference`, v.reports.length === 1 && v.reports[0].hasText && v.reports[0].studyIds[0] === v.studies[0].id && v.reports[0].basis === "reference" && v.reports[0].byFullUrl, JSON.stringify(v.reports));
  const view = await openInView(dev, r.shlink, P, { name: "files" });
  check(`${P}: /view lists ${FX.studies.length} studies`, view.studies === FX.studies.length, `${view.studies}`);
  await noErrors(P, errors);
  await context.close();
  return r;
}

/** The review step's compression choice for files that are all uncompressed images (`x`: fixture expectations). */
async function compressReview(page, P, x) {
  await page.waitForFunction(() => document.body.dataset.estimate === "done", null, { timeout: 120000 });
  const r = await page.evaluate(() => ({
    shown: !document.getElementById("rv-compress").classList.contains("hidden"),
    checked: document.querySelector("input[name=compress]:checked")?.value,
    what: document.getElementById("rv-compress-what").textContent,
    sv1: document.getElementById("rv-c-sv1").textContent,
    exact: document.getElementById("rv-c-exact").textContent,
    total: document.getElementById("rv-total").textContent,
  }));
  check(`${P}: compression offered, compressing without loss chosen by default`, r.shown && r.checked === "sv1", JSON.stringify(r));
  check(`${P}: the choice says what changes`, new RegExp(`^${x.images} images? here (is|are) uncompressed \\([\\d.]+ [KMG]B\\)\\. Compressing without loss keeps every pixel identical but changes the file bytes\\.$`).test(r.what), r.what);
  const about = /^JPEG Lossless · about ([\d.]+) ([KMG]B)/.exec(r.sv1);
  check(`${P}: the estimated size is smaller`, !!about && /\(about [\d.]+ [KMG]B after compression\)$/.test(r.total), `${r.sv1} · ${r.total}`);
  check(`${P}: keeping files exact says byte for byte`, /· the recipient gets the original files, byte for byte$/.test(r.exact), r.exact);
}

/** "Keep files exactly as they are": every instance byte-identical, and the owner page says so. */
async function flowExact(dev) {
  const P = `exact/${dev}`;
  const { context, page, errors } = await newPage(dev);
  await page.goto(`${BASE}/share`);
  await page.click("[data-src=files]");
  await page.setInputFiles("#in-files", FX.files);
  await page.waitForSelector("#s-review:not(.hidden)", { timeout: 60000 });
  await page.waitForFunction(() => document.body.dataset.estimate === "done", null, { timeout: 120000 });
  await page.locator("label.pick:has(input[value=exact])").click();
  check(`${P}: keep exact chosen`, (await page.evaluate(() => document.querySelector("input[name=compress]:checked")?.value)) === "exact");
  const total = await page.textContent("#rv-total");
  check(`${P}: no compressed size in the summary`, !/after compression/.test(total), total);
  await layout(page, `${P} review`, dev);
  await shot(page, `${dev}-2-review-exact`);
  const r = await finish(page, dev, P, { recipient: "Exact copies" });
  const log = await page.locator("#up-log li").allTextContents();
  check(`${P}: nothing compressed`, !log.some((t) => /Compressed/.test(t)), log.join(" | "));
  const v = verify(r.shlink, FX.files);
  sameContent(P, v, FX.images, "the files", { exact: true });
  const m = await newPage(dev);
  await m.page.goto(r.manage);
  await m.page.waitForSelector("#share-files", { timeout: 20000 });
  const note = await m.page.textContent("#share-files");
  check(`${P}: the owner page says the files are byte for byte`, note === "The files are shared exactly as they were added, byte for byte.", note);
  await m.context.close();
  await noErrors(P, errors);
  await context.close();
}

/** Picks "Smaller files, slower" (JPEG 2000 Lossless) on the review step, checking that it is offered and what it says. */
async function chooseJ2k(page, P) {
  await page.waitForFunction(() => document.body.dataset.estimate === "done", null, { timeout: 300000 });
  const r = await page.evaluate(() => ({
    shown: !document.querySelector("label.pick:has(input[value=j2k])").classList.contains("hidden"),
    sv1: document.getElementById("rv-c-sv1").textContent,
    j2k: document.getElementById("rv-c-j2k").textContent,
  }));
  check(`${P}: "Smaller files, slower" is offered (the encoder makes JPEG 2000)`, r.shown, JSON.stringify(r));
  const size = (t) => {
    const m = /about ([\d.]+) (KB|MB|GB)/.exec(t);
    return m ? Number(m[1]) * { KB: 1e-3, MB: 1, GB: 1e3 }[m[2]] : NaN;
  };
  check(
    `${P}: the JPEG 2000 estimate gives its size, how much smaller, and how much longer when that matters`,
    /^JPEG 2000 Lossless · about [\d.]+ [KMG]B( · [\d.]+ [KMG]B smaller)?( · about [\d.]+ (seconds|minutes?|hours?) more to compress on this device)?$/.test(r.j2k) && size(r.j2k) <= size(r.sv1) * 1.05,
    `${r.sv1} | ${r.j2k}`,
  );
  await page.locator("label.pick:has(input[value=j2k])").click();
  const total = await page.textContent("#rv-total");
  check(`${P}: the summary uses the JPEG 2000 estimate`, /\(about [\d.]+ [KMG]B after compression\)$/.test(total), total);
}

/** "Smaller files, slower": JPEG 2000 Lossless, pixel-identical, downloads from /view, and the owner page's note. */
async function flowJ2k(dev) {
  const P = `j2k/${dev}`;
  const { context, page, errors } = await newPage(dev);
  await page.goto(`${BASE}/share`);
  await page.click("[data-src=files]");
  await page.setInputFiles("#in-files", FX.files);
  await page.waitForSelector("#s-review:not(.hidden)", { timeout: 60000 });
  await chooseJ2k(page, P);
  await layout(page, `${P} review`, dev);
  await shot(page, `${dev}-2-review-j2k`);
  const r = await finish(page, dev, P, { recipient: "JPEG 2000 test" });
  const log = (await page.locator("#up-log li").allTextContents()).find((t) => /^Compressed/.test(t)) ?? "";
  check(`${P}: the upload log names JPEG 2000`, new RegExp(`^Compressed ${FX.images} images without loss as JPEG 2000 Lossless \\(pixels identical\\): `).test(log), log);
  const dump = `${FXDIR}/j2k-${dev}`;
  mkdirSync(dump, { recursive: true });
  const v = verify(r.shlink, FX.files, undefined, ["--pixels", `--dump=${dump}`]);
  sameContent(P, v, FX.images, "the files", { reencoded: FX.images });
  check(`${P}: every image is JPEG 2000 Lossless, written by this packer`, v.pixelReport?.transferSyntaxes?.["1.2.840.10008.1.2.4.90"] === FX.images && Object.keys(v.pixelReport?.implementations ?? {}).every((k) => /SHLDICOM/.test(k)), JSON.stringify([v.pixelReport?.transferSyntaxes, v.pixelReport?.implementations]));
  // /view's downloads: the files the share holds, byte for byte (each one checked above to be pixel-identical to its source).
  const { readFileSync, statSync } = await import("node:fs");
  const idx = JSON.parse(readFileSync(`${dump}/index.json`, "utf8"));
  const O = Object.fromEntries(Object.entries(idx).map(([sop, x]) => [sop, { path: `${dump}/${sop}.dcm`, size: statSync(`${dump}/${sop}.dcm`).size, series: x.series, study: x.study, reencoded: true }]));
  const vp = await newPage(dev);
  // Plain downloads (as view-checks does): no save-file picker.
  await vp.context.addInitScript(() => {
    delete window.showSaveFilePicker;
  });
  await vp.page.goto(r.shlink);
  await vp.page.waitForSelector("#screen-overview:not(.hidden)", { timeout: 30000 });
  await vp.page.locator(".study-open").first().click();
  await vp.page.waitForFunction(() => window.__view?.marks["first-slice"], null, { timeout: 60000 });
  await downloadMatrix(vp.page, `${P} /view`, O, check, { image: true, series: true, study: true });
  await noErrors(`${P} /view`, vp.errors);
  await vp.context.close();
  // The owner page names the encoding.
  const m = await newPage(dev);
  await m.page.goto(r.manage);
  await m.page.waitForSelector("#share-files", { timeout: 20000 });
  const notes = await m.page.locator("#share-files li").allTextContents();
  check(`${P}: the owner page says the images were compressed as JPEG 2000 Lossless`, notes.length === FX.studies.length && notes.every((t) => /images were compressed without loss when shared \(JPEG 2000 Lossless\): pixel-identical to the files they came from, not the same bytes\.$/.test(t)), notes.join(" | "));
  await m.context.close();
  await noErrors(P, errors);
  await context.close();
}

/** JPEG 2000 with a reload part-way through the upload: it continues with the staged JPEG 2000 files. */
async function flowJ2kResume(dev) {
  const P = `j2k-resume/${dev}`;
  execFileSync("bun", [`${ROOT}web/checks/share-big.ts`, NET_DIR, "200", "512"], { cwd: ROOT, encoding: "utf8" });
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(NET_DIR).filter((f) => f.endsWith(".dcm")).sort().map((f) => `${NET_DIR}/${f}`);
  const { context, page, errors } = await newPage(dev, { allowErrors: [/interrupted|ERR_ABORTED|net::ERR/i] });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  // A slow uplink, so the reload lands part-way through the (much smaller) JPEG 2000 upload.
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 20, downloadThroughput: -1, uploadThroughput: 1 << 20 });
  await page.goto(`${BASE}/share`);
  await page.click("[data-src=files]");
  await page.setInputFiles("#in-files", files);
  await page.waitForSelector("#s-review:not(.hidden)", { timeout: 120000 });
  await chooseJ2k(page, P);
  // A report attached by the sharer: kept through the reload (it is in no file read again).
  await page.locator(".study").first().locator("input[type=file]").setInputFiles({ name: "resume-note.txt", mimeType: "text/plain", buffer: Buffer.from("Read before the reload.") });
  await page.waitForFunction(() => [...document.querySelectorAll(".report-line")].some((e) => e.textContent.includes("resume-note")), null, { timeout: 10000 });
  await page.click("#rv-next");
  // With a passcode: the link is made with it when the share is, and the saved job never holds it.
  const PASS = "7319-resume";
  await page.fill("#in-pass", PASS);
  await page.click("#who-form button[type=submit]");
  await page.waitForFunction(() => /^(Compressed and u|U)ploaded/.test(document.getElementById("up-main")?.textContent ?? "") && parseFloat(document.getElementById("up-bar")?.style.width ?? "0") > 30, null, { timeout: 600000, polling: 100 });
  const before = await page.textContent("#up-main");
  const saved = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("shl-dicom-upload-job:")).map((k) => localStorage.getItem(k)).join("") ?? "");
  const job = JSON.parse(saved || "{}");
  check(`${P}: the saved job does not hold the passcode`, saved.length > 0 && !saved.includes(PASS) && job.hasPasscode === true && !("passcode" in job), saved ? `hasPasscode ${job.hasPasscode}` : "no saved job");
  check(`${P}: the saved job expires with the share`, typeof job.expiresAt === "number" && job.expiresAt > Date.now() / 1000, String(job.expiresAt));
  // A reload while requests are in flight can report ERR_ABORTED for the old page; the new one loads all the same.
  await page.reload().catch(() => page.goto(`${BASE}/share`));
  await page.waitForSelector("#resume:not(.hidden)", { timeout: 30000 });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#resume-continue")]);
  await chooser.setFiles(files);
  await page.waitForSelector("#s-upload:not(.hidden)");
  const seen = await page.waitForFunction(() => /^(Compressed and u|U)ploaded/.test(document.getElementById("up-main").textContent) && document.getElementById("up-main").textContent, null, { timeout: 300000 });
  check(`${P}: after a reload the upload continues from what the server has`, parseFloat((await page.locator("#up-bar").getAttribute("style")).match(/width: ([\d.]+)/)?.[1] ?? "0") > 25, `${before} → ${await seen.jsonValue()}`);
  await page.waitForSelector("#s-done:not(.hidden), #up-error:not(.hidden)", { timeout: 900000 });
  if (await page.locator("#up-error:not(.hidden)").count()) throw new Error(`upload failed: ${await page.textContent("#up-error-text")}`);
  const result = await page.evaluate(() => window.__share.result);
  made.push(result.manage);
  const v = verify(result.shlink, [NET_DIR], PASS, ["--pixels"]);
  sameContent(P, v, files.length, "the files", { reencoded: files.length });
  check(`${P}: the resumed link asks for the passcode it was made with`, verifyFails(result.shlink), "opened without the passcode");
  check(`${P}: the report attached before the reload is in the link`, v.reports.length === 1 && /resume-note/.test(v.reports[0].title), JSON.stringify(v.reports.map((r) => r.title)));
  check(`${P}: the resumed share is all JPEG 2000 Lossless`, v.pixelReport?.transferSyntaxes?.["1.2.840.10008.1.2.4.90"] === files.length, JSON.stringify(v.pixelReport?.transferSyntaxes));
  await noErrors(P, errors);
  await context.close();
}

/**
 * A reload part-way through a portal upload: the link still has the portal's Patient, its study
 * descriptions and the reports chosen (one left out stays out), not what the staged files say.
 */
async function flowPortalResume(dev) {
  const P = `portal-resume/${dev}`;
  const { context, page, errors } = await newPage(dev, { allowErrors: [/interrupted|ERR_ABORTED|net::ERR/i] });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await page.goto(`${BASE}/share`);
  await page.click("[data-src=portal]");
  await Promise.all([page.waitForURL((u) => u.host === new URL(PORTAL).host && u.pathname.includes("/auth")), page.click("#portal-form button[type=submit]")]);
  await page.locator("input[name=patient]").first().check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForSelector("input[name=study]");
  await Promise.all([page.waitForURL(/\/share\/smart-callback\//), page.getByRole("button", { name: "Allow" }).click()]);
  await page.waitForSelector("#s-review:not(.hidden)", { timeout: 600000 });
  // Only the largest study that has reports, so the upload is long enough to reload part-way.
  const all = await cards(page);
  const pick = all.map((c, i) => [c, i]).filter(([c]) => c.reports >= 1).sort((x, y) => y[0].mb - x[0].mb)[0][1];
  for (const [i] of all.entries()) if (i !== pick) await page.locator(".study").nth(i).locator(".study-head .switch-label").click();
  const study = page.locator(".study").nth(pick);
  const nReports = all[pick].reports;
  if (nReports > 1) await study.locator(".report-row .switch-label").first().click();
  const want = await page.evaluate(() => {
    const c = window.__share.collection;
    const st = c.list().filter((s) => s.include);
    return { patient: c.patient.name, descriptions: st.map((s) => s.description), reports: st.flatMap((s) => s.reports.filter((r) => r.include)).length };
  });
  await page.click("#rv-next");
  await page.waitForSelector("#s-who:not(.hidden)");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 20, downloadThroughput: -1, uploadThroughput: 1 << 19 });
  await page.click("#who-form button[type=submit]");
  await page.waitForFunction(() => /^(Compressed and u|U)ploaded/.test(document.getElementById("up-main")?.textContent ?? "") && parseFloat(document.getElementById("up-bar")?.style.width ?? "0") > 20, null, { timeout: 600000, polling: 100 });
  await page.reload().catch(() => page.goto(`${BASE}/share`));
  await page.waitForSelector("#resume:not(.hidden)", { timeout: 30000 });
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.click("#resume-continue");
  await page.waitForSelector("#s-done:not(.hidden), #up-error:not(.hidden)", { timeout: 900000 });
  if (await page.locator("#up-error:not(.hidden)").count()) throw new Error(`upload failed: ${await page.textContent("#up-error-text")}`);
  const result = await page.evaluate(() => window.__share.result);
  made.push(result.manage);
  const v = verify(result.shlink);
  check(`${P}: the link has the portal's Patient after the reload`, v.patient === want.patient, `${v.patient} (want ${want.patient})`);
  check(`${P}: the link has the portal's study descriptions after the reload`, JSON.stringify(v.studies.map((s) => s.description ?? null)) === JSON.stringify(want.descriptions), `${JSON.stringify(v.studies.map((s) => s.description))} (want ${JSON.stringify(want.descriptions)})`);
  check(`${P}: the reports chosen before the reload, and only those, are in the link`, v.reports.length === want.reports, `${v.reports.length} (want ${want.reports} of ${nReports})`);
  await noErrors(P, errors);
  await context.close();
}

/** A CD-style folder (Explicit VR, DICOMDIR): compressed without loss by default, pixel-identical. */
async function flowCd(dev) {
  const P = `cd/${dev}`;
  const dir = `${FXDIR}/cd`;
  const CD = fixtures("cd", dir, "xr-wrist-left-2012");
  const { context, page, errors } = await newPage(dev);
  await page.goto(`${BASE}/share`);
  await page.click("[data-src=files]");
  await page.setInputFiles("#in-folder", dir);
  await page.waitForSelector("#s-review:not(.hidden)", { timeout: 120000 });
  const skipped = await page.textContent("#rv-skipped");
  check(`${P}: the DICOMDIR is skipped as an index`, /1 file skipped/.test(skipped), skipped);
  await compressReview(page, P, CD);
  await shot(page, `${dev}-2-review-cd`);
  const r = await finish(page, dev, P, { recipient: "CD test" });
  const v = verify(r.shlink, [dir], undefined, ["--pixels"]);
  sameContent(P, v, CD.images, "the CD's files", { reencoded: CD.images });
  check(`${P}: smaller than the CD`, (await page.locator("#up-log li").allTextContents()).some((t) => /^Compressed \d+ images without loss .*: ([\d.]+ [KMG]B) → ([\d.]+ [KMG]B)/.test(t)));
  await noErrors(P, errors);
  await context.close();
}

async function flowPortal(dev) {
  const P = `portal/${dev}`;
  const { context, page, errors } = await newPage(dev);
  await page.goto(`${BASE}/share`);
  await page.click("[data-src=portal]");
  if (process.env.PORTAL) await page.fill("#in-portal", PORTAL);
  else {
    const portal = await page.inputValue("#in-portal");
    check(`${P}: portal defaults to the sandbox`, portal === PORTAL, portal);
  }
  await layout(page, `${P} portal panel`, dev);
  await shot(page, `${dev}-1-portal`);
  await Promise.all([page.waitForURL((u) => u.host === new URL(PORTAL).host && u.pathname.includes("/auth")), page.click("#portal-form button[type=submit]")]);
  await page.locator("input[name=patient]").first().check();
  await shot(page, `${dev}-portal-signin`);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForSelector("input[name=study]");
  await shot(page, `${dev}-portal-consent`);
  await Promise.all([page.waitForURL(/\/share\/smart-callback\//), page.getByRole("button", { name: "Allow" }).click()]);
  await page.waitForSelector("#s-review:not(.hidden)", { timeout: 600000 });
  await page.waitForFunction(() => document.body.dataset.thumbs === "done", null, { timeout: 120000 });
  check(`${P}: callback URL cleaned up`, !/code=/.test(page.url()), page.url());
  const patient = await page.textContent("#rv-patient");
  check(`${P}: patient from the portal`, /^Patient: /.test(patient), patient);
  const S = await sample();
  const found = await page.textContent("#found");
  check(`${P}: found line matches the sandbox data`, foundRe(S.totals).test(found), found);
  const reports = await page.locator(".report-line").allTextContents();
  check(`${P}: reports listed`, reports.length >= 1, reports.join(" | "));
  const drawn = await page.locator("canvas.drawn").count(), failed = await page.locator("canvas.failed").count();
  check(`${P}: a thumbnail tried for each of the ${S.totals.series} series`, drawn + failed === S.totals.series && drawn >= S.totals.series - 2, `${drawn} drawn, ${failed} not decodable`);
  // Leave out the two largest studies (the CT and the slide), to keep the upload short.
  const all = await cards(page);
  const big = all.map((c, i) => [c.mb, i]).sort((x, y) => y[0] - x[0]).slice(0, 2).map(([, i]) => i);
  for (const i of big) await page.locator(".study").nth(i).locator(".study-head .switch-label").click();
  const keep = all.filter((_, i) => !big.includes(i));
  const keepImages = keep.reduce((a, c) => a + c.images, 0);
  const keepReports = keep.reduce((a, c) => a + c.reports, 0);
  // Leave out one report (in the first study left in).
  const firstKept = all.findIndex((_, i) => !big.includes(i));
  const rowToggles = (await page.locator(".report-row .switch-label").count()) > 0;
  check(`${P}: each report can be left out`, rowToggles, rowToggles ? "" : "not on this site yet");
  if (rowToggles) {
    await page.locator(".study").nth(firstKept).locator(".report-row .switch-label").first().click();
    check(`${P}: report marked as left out`, (await page.locator(".report-row.excluded:not(.follows-study)").count()) === 1);
  }
  const leftOut = rowToggles ? 1 : 0;
  if (rowToggles) {
    // A left-out study's report is shown off and disabled, whatever its own choice.
    const bigReport = await page.locator(".study").nth(big[0]).locator(".report-row").first().evaluate((row) => {
      const input = row.querySelector("input");
      return { checked: input.checked, disabled: input.disabled, aria: input.getAttribute("aria-disabled"), text: row.querySelector(".sw-text").textContent, opacity: getComputedStyle(row.querySelector(".report-name")).opacity, attach: row.closest(".study").querySelector(".attach").disabled };
    });
    check(`${P}: a left-out study's report shows off and disabled`, !bigReport.checked && bigReport.disabled && bigReport.aria === "true" && bigReport.text === "Left out with the study" && Number(bigReport.opacity) < 1 && bigReport.attach, JSON.stringify(bigReport));
    // Leaving out and re-including a study restores each report's own choice.
    const kept = page.locator(".study").nth(firstKept);
    await kept.locator(".study-head .switch-label").click();
    const during = await kept.locator(".report-row .sw-text").first().textContent();
    await kept.locator(".study-head .switch-label").click();
    const after = await kept.locator(".report-row .sw-text").first().textContent();
    check(`${P}: re-including a study restores its report's own choice`, during === "Left out with the study" && after === "Left out", `${during} → ${after}`);
    const total = await page.textContent("#rv-total");
    check(`${P}: the summary counts what goes in`, new RegExp(`^Sharing ${keep.length} studies · ${keepReports - leftOut} reports · `).test(total), total);
  }
  await layout(page, `${P} review`, dev);
  await shot(page, `${dev}-2-review-portal`);
  const pass = "2468";
  const r = await finish(page, dev, P, { recipient: "Dr. Okafor", passcode: pass, expiry: "1m", updates: true });
  const received = await page.evaluate(() => [...window.__share.collection.received]).catch(() => []);
  console.log(`PORTAL ${P}: images received by transfer syntax: ${JSON.stringify(received)}`);
  const sv1 = received.find(([t]) => t === "1.2.840.10008.1.2.4.70")?.[1] ?? 0;
  check(`${P}: the portal sent JPEG Lossless for the images it stores uncompressed (Accept lists it first)`, sv1 > 0, JSON.stringify(received));
  const v = verify(r.shlink, S.sameAsLocal ? [DATASET] : [], pass, ["--pixels"]);
  const ts = v.pixelReport?.transferSyntaxes ?? {};
  check(`${P}: images arrive compressed or are compressed on the device`, Object.keys(ts).every((t) => ["1.2.840.10008.1.2.4.70", "1.2.840.10008.1.2.4.90"].includes(t)), JSON.stringify({ received, inLink: ts }));
  check(`${P}: link has the studies left in`, v.studies.length === keep.length && v.instances === keepImages, JSON.stringify(v.studies.map((s) => s.instances)));
  if (S.sameAsLocal) sameContent(P, v, keepImages, "the sandbox dataset");
  check(`${P}: reports travel with PDF and text inline`, v.reports.length === keepReports - leftOut && v.reports.every((x) => x.hasText && x.forms.includes("application/pdf")), JSON.stringify(v.reports));
  check(`${P}: every report links to its study by reference (fullUrl), none unmatched or by date`, v.reports.every((x) => x.basis === "reference" && x.byFullUrl), JSON.stringify(v.reports.map((x) => [x.title, x.basis, x.byFullUrl])));
  check(`${P}: started date from the portal`, !!v.studies[0].started, v.studies[0].started);
  const view = await openInView(dev, r.shlink, P, { passcode: pass, name: "portal" });
  check(`${P}: /view shows the reports`, view.reports.length >= keepReports - leftOut && v.reports.every((r) => view.reports.some((t) => t.includes(r.title))), view.reports.map((t) => t.slice(0, 60)).join(" | "));
  await noErrors(P, errors);
  await context.close();
}

async function flowReshare(dev) {
  const P = `reshare/${dev}`;
  const S = await sample();
  const sv = S.index;
  check(`${P}: the sample's Bundle has a report for each study, linked to it`, sv.reports.length === sv.studies.length && sv.reports.every((x) => x.studyIds.length === 1 && x.hasText), `${sv.reports.length} reports, ${sv.studies.length} studies`);
  check(`${P}: every sample report links to its study by reference (fullUrl), none unmatched or by date`, sv.reports.length > 0 && sv.reports.every((x) => x.basis === "reference" && x.byFullUrl), JSON.stringify(sv.reports.map((x) => [x.title, x.basis, x.byFullUrl])));
  check(`${P}: each sample study has exactly one report`, new Set(sv.reports.map((x) => x.studyIds[0])).size === sv.studies.length);
  const { context, page, errors } = await newPage(dev);
  await page.goto(`${BASE}/share`);
  await page.click("[data-src=link]");
  await page.fill("#in-link", S.link);
  await layout(page, `${P} link panel`, dev);
  await shot(page, `${dev}-1-link`);
  await page.click("#link-form button[type=submit]");
  await page.waitForSelector("#s-review:not(.hidden)", { timeout: 600000 });
  const n = await page.locator(".study").count();
  check(`${P}: every sample study from the link`, n === S.totals.studies.length, `${n}`);
  // Keep only the first study.
  for (let i = 1; i < n; i++) await page.locator(".study").nth(i).locator(".study-head .switch-label").click();
  check(`${P}: the others marked as left out`, (await page.locator(".study.excluded").count()) === n - 1);
  const [kept] = await cards(page);
  const total = await page.textContent("#rv-total");
  check(`${P}: total updates`, /^Sharing 1 study/.test(total), total);
  await shot(page, `${dev}-2-review-reshare`);
  const r = await finish(page, dev, P, { recipient: "Second opinion" });
  const v = verify(r.shlink, [], undefined, [`--ref-link=${S.link}`]);
  check(`${P}: new link has only ${kept.title}`, v.studies.length === 1 && v.instances === kept.images, JSON.stringify(v.studies));
  check(`${P}: instances byte-identical to the sample's`, v.matched === kept.images, `${v.matched} matched, ${v.mismatched} differ, ${v.missing} missing`);
  check(`${P}: the kept study's report comes along, linked by reference`, v.reports.length === 1 && v.reports[0].studyIds[0] === v.studies[0].id && v.reports[0].basis === "reference" && v.reports[0].byFullUrl, JSON.stringify(v.reports));
  await noErrors(P, errors);
  await context.close();
}

async function flowManage(dev, files) {
  const P = `manage/${dev}`;
  const { context, page, errors } = await newPage(dev, { allowErrors: [/404 .*\/shl\//] });
  await page.goto(files.manage);
  await page.waitForSelector(".link-card", { timeout: 20000 });
  const status = await page.locator(".link-card .lc-status").first().textContent();
  check(`${P}: link shows it was opened`, /^Opened \d+ times?, last today/.test(status), status);
  const studies = await page.locator(".link-card .lc-studies").first().textContent();
  check(`${P}: link lists its studies`, studies === FX.studies.map((s) => s.title).join(", "), studies);
  const filesNote = await page.locator("#share-files li").allTextContents();
  check(`${P}: the owner page says which images were compressed without loss`, filesNote.length === FX.studies.length && FX.studies.every((st, i) => filesNote[i] === `${st.title}: ${st.images} of ${st.images} images were compressed without loss when shared (JPEG Lossless): pixel-identical to the files they came from, not the same bytes.`), filesNote.join(" | "));
  const tl = await page.locator("#timeline li").allTextContents();
  check(`${P}: timeline has an open and image loads`, tl.some((t) => /Opened · Dr\. Patel/.test(t)) && tl.some((t) => /encrypted image data/.test(t)), tl.slice(0, 3).join(" | "));
  await layout(page, `${P} page`, dev);
  await shot(page, `${dev}-6-manage`);

  // Extend
  const lid = await page.locator(".link-card").first().getAttribute("data-lid");
  const exp0 = await page.evaluate((id) => window.__manage.share.links.find((l) => l.id === id).exp, lid);
  await page.locator(".link-card").first().getByRole("button", { name: "Extend by a week" }).click();
  await page.waitForFunction(([id, e]) => window.__manage.share.links.find((l) => l.id === id).exp > e, [lid, exp0]);
  const exp1 = await page.evaluate((id) => window.__manage.share.links.find((l) => l.id === id).exp, lid);
  check(`${P}: extend adds a week`, exp1 - Math.max(exp0, Date.now() / 1000) > 6.9 * 86400, `${exp0} → ${exp1}`);

  // Take offline and back
  await page.locator(".link-card").first().getByRole("button", { name: "Take offline" }).click();
  await page.waitForSelector(".link-card .pill.off");
  check(`${P}: offline link does not open`, /unavailable|404/.test(verifyFails(files.shlink) ?? ""), verifyFails(files.shlink) ?? "opened");
  await page.locator(".link-card").first().getByRole("button", { name: "Bring back online" }).click();
  await page.waitForFunction(() => !document.querySelector(".link-card .pill.off"));
  check(`${P}: back online, the link opens`, verifyFails(files.shlink) === null);

  // New link for someone else: every study but the first.
  await page.click("#new-link-btn");
  await page.fill("#nl-recipient", "Dr. Lee, Orthopedics");
  await page.locator(".check-row", { hasText: FX.studies[0].title }).click();
  await layout(page, `${P} new link form`, dev);
  await shot(page, `${dev}-6-manage-new-link`);
  await page.locator("#new-link button[type=submit]").click();
  await page.waitForFunction(() => document.querySelectorAll(".link-card").length === 2);
  await page.waitForSelector(".lc-qr .mono");
  const newLink = await page.locator(".lc-qr .mono").first().textContent();
  const v = verify(newLink, FX.files, undefined, ["--pixels"]);
  const rest = FX.studies.slice(1);
  const restImages = rest.reduce((a, s) => a + s.images, 0);
  check(`${P}: new link leaves out ${FX.studies[0].title}`, v.studies.length === rest.length && v.instances === restImages && v.matched + v.reencoded === restImages, JSON.stringify(v.studies));
  await shot(page, `${dev}-6-manage-two-links`);

  // Revoke it.
  const card = page.locator(".link-card", { hasText: "Dr. Lee" });
  await card.getByRole("button", { name: "Revoke" }).click();
  await page.waitForSelector("dialog[open]");
  await shot(page, `${dev}-6-manage-revoke`);
  await page.click("#confirm-ok");
  await page.waitForFunction(() => document.querySelectorAll(".link-card").length === 1);
  check(`${P}: revoked link does not open`, /unavailable|404/.test(verifyFails(newLink) ?? ""), verifyFails(newLink) ?? "opened");
  check(`${P}: the other link still opens`, verifyFails(files.shlink) === null);

  await page.click("#techlog summary");
  const rows = await page.locator(".log-table tbody tr").count();
  check(`${P}: technical log lists requests`, rows > 10, `${rows} rows`);
  await layout(page, `${P} with log`, dev);
  await page.evaluate(() => document.getElementById("activity").scrollIntoView());
  await page.screenshot({ path: `${SHOTS}${dev}-6-manage-activity.png` });
  await noErrors(P, errors);
  await context.close();
}

// ------------------------------------------------------------------- size: memory while uploading

/** Samples the browser's renderer memory (resident set, and its peak) while a flow runs. */
async function memoryWatch() {
  const { readFileSync } = await import("node:fs");
  const cdp = await browser.newBrowserCDPSession();
  const kb = (pid, field) => {
    try {
      return Number(new RegExp(`${field}:\\s+(\\d+) kB`).exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0);
    } catch {
      return 0;
    }
  };
  let peakRss = 0, peakHwm = 0, stop = false;
  const tick = async () => {
    try {
      const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
      for (const p of processInfo.filter((x) => x.type === "renderer")) {
        peakRss = Math.max(peakRss, kb(p.id, "VmRSS"));
        peakHwm = Math.max(peakHwm, kb(p.id, "VmHWM"));
      }
    } catch {}
  };
  const loop = (async () => {
    while (!stop) {
      await tick();
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  return {
    async done() {
      stop = true;
      await loop;
      await tick();
      await cdp.detach().catch(() => {});
      return { peakRssMB: Math.round(peakRss / 1024), peakHwmMB: Math.round(peakHwm / 1024) };
    },
  };
}

/** Peak renderer memory allowed while sharing a file of any size. */
const MEMORY_BOUND_MB = 1024;

async function flowSlide(dev, o = {}) {
  const P = `slide${o.full ? "-full" : ""}/${dev}`;
  const { readdirSync, statSync } = await import("node:fs");
  let files = [];
  try {
    files = readdirSync(SLIDE_DIR).map((f) => `${SLIDE_DIR}/${f}`).filter((f) => f.endsWith(".dcm") && (o.full || statSync(f).size < 500e6));
  } catch {}
  const slideBytes = files.reduce((a, f) => a + statSync(f).size, 0);
  const mem = o.full ? await memoryWatch() : null;
  if (!files.length) {
    console.log(`SKIP ${P}: no slide in ${SLIDE_DIR}`);
    return;
  }
  const { context, page, errors } = await newPage(dev);
  await page.goto(`${BASE}/share`);
  await page.click("[data-src=files]");
  await page.setInputFiles("#in-files", files);
  await page.waitForSelector("#s-review:not(.hidden)", { timeout: 120000 });
  const row = await page.evaluate(() => ({ shown: !document.getElementById("rv-offsets-row").classList.contains("hidden"), checked: document.getElementById("rv-offsets").checked, text: document.getElementById("rv-offsets-row").textContent.trim() }));
  check(`${P}: offset-table option shown and on`, row.shown && row.checked, JSON.stringify(row));
  await page.locator("#rv-offsets-row").scrollIntoViewIfNeeded();
  // SLIDE_OFFSETS=off: untick the box, for a comparison run (the viewer then walks fragment headers).
  const off = process.env.SLIDE_OFFSETS === "off";
  if (off) await page.click("#rv-offsets-row");
  await layout(page, `${P} review`, dev);
  await page.screenshot({ path: `${SHOTS}${dev}-2-review-slide.png` });
  const r = await finish(page, dev, P, { recipient: "Pathology" });
  if (mem) {
    const m = await mem.done();
    check(`${P}: renderer memory stays bounded while sharing ${(slideBytes / 1e9).toFixed(2)} GB`, m.peakHwmMB < MEMORY_BOUND_MB, `peak resident ${m.peakHwmMB} MB (bound ${MEMORY_BOUND_MB} MB)`);
    console.log(`MEMORY ${P}: peak renderer resident ${m.peakHwmMB} MB for ${(slideBytes / 1e9).toFixed(2)} GB`);
  }
  const v = verify(r.shlink);
  check(`${P}: link opens with the slide's ${files.length} instances`, v.instances === files.length, `${v.instances}`);
  // In /view: every level has a Basic Offset Table, and full resolution needs no walking.
  const { context: vc, page: vp, errors: verr } = await newPage(dev);
  await vp.goto(r.shlink);
  await vp.waitForSelector("#screen-overview:not(.hidden)", { timeout: 30000 });
  await vp.locator(".study-open").first().click();
  await vp.waitForFunction(() => window.__wsi?.active() && window.__wsi.idle(), null, { timeout: 120000, polling: 50 });
  const pyr = await vp.evaluate(() => window.__wsi.pyramid());
  if (!off) check(`${P}: /view reads the added Basic Offset Tables`, pyr.levels.every((l) => l.source === "basic-offset-table"), pyr.levels.map((l) => l.source).join(", "));
  await vp.evaluate(() => {
    const p = window.__wsi.pyramid();
    window.__wsi.setView(p.width * 0.5, p.height * 0.5, window.__wsi.view().dpr);
  });
  await vp.waitForFunction(() => window.__wsi.idle() && window.__wsi.view().level === 0, null, { timeout: 120000, polling: 50 });
  const st = await vp.evaluate(() => window.__wsi.stats());
  check(`${P}: finest level on screen ${off ? "by walking (box unticked)" : "with no walking"}`, off ? st.byPurpose.walk.bytes > 0 : st.byPurpose.walk.bytes === 0, `${(st.bytes / 1e6).toFixed(2)} MB of ${(st.totalBytes / 1e6).toFixed(1)} MB (${(st.fraction * 100).toFixed(2)}%), ${st.requests} requests`);
  await vp.waitForTimeout(250);
  await vp.screenshot({ path: `${SHOTS}${dev}-slide-viewer.png` });
  await noErrors(`${P} /view`, verr);
  await vc.close();
  await noErrors(P, errors);
  await context.close();
}

/** A multi-GB synthetic CT, with the page reloaded part-way through the upload. */
async function flowBigCt(dev) {
  const P = `big-ct/${dev}`;
  const dir = process.env.BIG_DIR ?? "/media/barracuda/shlink-dicom-share-big/ct1600";
  const info = JSON.parse(execFileSync("bun", [`${ROOT}web/checks/share-big.ts`, dir, "1600", "1024"], { cwd: ROOT, encoding: "utf8", timeout: 1800000 }).trim().split("\n").pop());
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(dir).filter((f) => f.endsWith(".dcm")).sort().map((f) => `${dir}/${f}`);
  const mem = await memoryWatch();
  const { context, page, errors } = await newPage(dev, { allowErrors: [/interrupted|ERR_ABORTED|net::ERR/i, /status of 404/, /\b50[234]\b/] });
  await page.goto(`${BASE}/share`);
  await page.click("[data-src=files]");
  await page.setInputFiles("#in-files", files);
  await page.waitForSelector("#s-review:not(.hidden)", { timeout: 600000 });
  const found = await page.textContent("#found");
  check(`${P}: found ${files.length} images, ${(info.bytes / 1e9).toFixed(2)} GB`, new RegExp(`· ${files.length} images ·`).test(found), found);
  await page.click("#rv-next");
  await page.fill("#in-recipient", "Big CT test");
  await page.click("#who-form button[type=submit]");
  // Reload a third of the way through (images are compressed as the files upload), then continue with the same files.
  const tc = Date.now();
  await page.waitForFunction(() => /[1-9][\d.]* [KMG]?B of/.test(document.getElementById("up-main")?.textContent ?? "") && /^Compressed and uploaded/.test(document.getElementById("up-main").textContent), null, { timeout: 1800000, polling: 250 });
  const tUpload = Date.now();
  const compressLine = (await page.locator("#up-log li").allTextContents()).find((t) => /^Compressed/.test(t)) ?? "";
  console.log(`COMPRESS ${P}: ${((Date.now() - tc) / 1000).toFixed(0)} s to the first bytes on the server`);
  check(`${P}: the upload starts while images are still being compressed`, !compressLine, compressLine || "(still compressing)");
  await page.waitForFunction(() => {
    const w = parseFloat(document.getElementById("up-bar")?.style.width ?? "0");
    return /^(Compressed and u|U)ploaded/.test(document.getElementById("up-main")?.textContent ?? "") && w > 33;
  }, null, { timeout: 900000, polling: 250 });
  const before = await page.textContent("#up-main");
  const tReload = Date.now();
  // A reload while requests are in flight can report ERR_ABORTED for the old page; the new one loads all the same.
  await page.reload().catch(() => page.goto(`${BASE}/share`));
  await page.waitForSelector("#resume:not(.hidden)", { timeout: 30000 });
  check(`${P}: after a reload the page offers to continue`, true, before);
  await layout(page, `${P} resume`, dev);
  await shot(page, `${dev}-big-resume`);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#resume-continue")]);
  await chooser.setFiles(files);
  await page.waitForSelector("#s-upload:not(.hidden)");
  const resumedAt = await page.waitForFunction(() => /[Uu]ploaded/.test(document.getElementById("up-main").textContent) && document.getElementById("up-main").textContent, null, { timeout: 300000 });
  check(`${P}: the upload continues from what the server has`, parseFloat((await page.locator("#up-bar").getAttribute("style")).match(/width: ([\d.]+)/)?.[1] ?? "0") > 30, await resumedAt.jsonValue());
  const tResumed = Date.now();
  await page.waitForSelector("#s-done:not(.hidden), #up-error:not(.hidden)", { timeout: 1800000 });
  if (await page.locator("#up-error:not(.hidden)").count()) throw new Error(`upload failed: ${await page.textContent("#up-error-text")}`);
  const result = await page.evaluate(() => window.__share.result);
  made.push(result.manage);
  console.log(`TIMES ${P}: compress ${((tUpload - tc) / 1000).toFixed(0)} s · upload until the reload ${((tReload - tUpload) / 1000).toFixed(0)} s · resume to done ${((Date.now() - tResumed) / 1000).toFixed(0)} s · ${(await page.locator("#up-log li").allTextContents()).filter((t) => /^Compressed/.test(t)).join("")}`);
  const m = await mem.done();
  check(`${P}: renderer memory stays bounded while sharing ${(info.bytes / 1e9).toFixed(2)} GB`, m.peakHwmMB < MEMORY_BOUND_MB, `peak resident ${m.peakHwmMB} MB (bound ${MEMORY_BOUND_MB} MB)`);
  console.log(`MEMORY ${P}: peak renderer resident ${m.peakHwmMB} MB for ${(info.bytes / 1e9).toFixed(2)} GB`);
  await shot(page, `${dev}-big-done`);
  const v = verify(result.shlink, [dir], undefined, ["--pixels"]);
  sameContent(P, v, files.length, "the files");
  await noErrors(P, errors);
  await context.close();
}

// ------------------------------------------------------------------------ network failures

const NET_DIR = process.env.NET_DIR ?? "/media/barracuda/shlink-dicom-share-big/ct200";

/** A TCP proxy to the server that stalls one upload mid-body (it stops forwarding, keeps the socket). */
async function stallProxy(port, upstream, stallAtPatch) {
  const net = await import("node:net");
  const tls = await import("node:tls");
  const upHost = upstream.tls ? upstream.host : `127.0.0.1:${upstream.port}`;
  let patches = 0, stalled = false;
  const sockets = new Set();
  const server = net.createServer((client) => {
    const up = upstream.tls ? tls.connect({ host: upstream.host, port: upstream.port, servername: upstream.host }) : net.connect(upstream.port, "127.0.0.1");
    sockets.add(client).add(up);
    let counting = -1;
    client.on("data", (d) => {
      if (counting < 0 && d.includes("PATCH /api/shares/") && !stalled && ++patches === stallAtPatch) counting = 0;
      if (counting >= 0) {
        counting += d.length;
        if (counting > 1 << 20) {
          stalled = true;
          client.pause();
          return; // stop forwarding; both sockets stay open
        }
      }
      // Links name the server, not the proxy (same length, so bodies are untouched).
      up.write(Buffer.from(d.toString("latin1").replaceAll(`Host: 127.0.0.1:${port}`, `Host: ${upHost}`), "latin1"));
    });
    up.on("data", (d) => client.write(d));
    for (const [a, b] of [[client, up], [up, client]]) {
      a.on("error", () => b.destroy());
      a.on("close", () => b.destroy());
    }
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return {
    get stalled() {
      return stalled;
    },
    close() {
      for (const x of sockets) x.destroy();
      server.close();
    },
  };
}

/**
 * Starts the upload of NET_DIR's files and waits until `pct` percent is sent. `o.exact`: keep the
 * files exactly as they are (the network flows, so the upload stays long enough to disturb).
 */
async function startNetUpload(page, dev, files, pct, o = {}) {
  await page.goto(`${o.pageBase ?? BASE}/share${o.query ?? ""}`);
  await page.click("[data-src=files]");
  await page.setInputFiles("#in-files", files);
  await page.waitForSelector("#s-review:not(.hidden)", { timeout: 120000 });
  if (o.exact) await page.locator("label.pick:has(input[value=exact])").click();
  await page.click("#rv-next");
  await page.click("#who-form button[type=submit]");
  // The upload's own bar (compressing comes first, on the same bar).
  await page.waitForFunction((p) => /^(Compressed and u|U)ploaded/.test(document.getElementById("up-main")?.textContent ?? "") && parseFloat(document.getElementById("up-bar")?.style.width ?? "0") >= p, pct, { timeout: 300000, polling: 100 });
}

async function finishNetUpload(page, P, files, timeout = 900000) {
  await page.waitForSelector("#s-done:not(.hidden), #up-error:not(.hidden)", { timeout });
  if (await page.locator("#up-error:not(.hidden)").count()) throw new Error(`upload failed: ${await page.textContent("#up-error-text")}`);
  const result = await page.evaluate(() => window.__share.result);
  made.push(result.manage);
  const v = verify(result.shlink, [NET_DIR], undefined, ["--pixels"]);
  sameContent(P, v, files.length, "the files");
}

/** Waits until the page reports a connection problem, and returns what it shows. */
async function seesTrouble(page, timeout = 60000) {
  await page.waitForFunction(() => ["offline", "retrying"].includes(document.body.dataset.connection), null, { timeout, polling: 100 });
  return page.textContent("#up-main");
}

async function flowNetwork(dev) {
  const { readdirSync } = await import("node:fs");
  execFileSync("bun", [`${ROOT}web/checks/share-big.ts`, NET_DIR, "200", "512"], { cwd: ROOT, encoding: "utf8" });
  const files = readdirSync(NET_DIR).filter((f) => f.endsWith(".dcm")).sort().map((f) => `${NET_DIR}/${f}`);
  const slow = { offline: false, latency: 20, downloadThroughput: -1, uploadThroughput: 4 << 20 };
  const noise = [/ERR_INTERNET_DISCONNECTED|ERR_FAILED|ERR_CONNECTION|ERR_ABORTED|ERR_EMPTY_RESPONSE|net::/i, /503|502/];

  // Offline for 5 s and for 60 s, on a connection limited to 4 MB/s; and for 5 s while the images
  // are still being compressed (the files growing as they upload).
  for (const [secs, exact] of [[5, true], [60, true], [5, false]]) {
    const P = `offline-${secs}s${exact ? "" : "-compressing"}/${dev}`;
    const { context, page, errors } = await newPage(dev, { allowErrors: noise });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", slow);
    await startNetUpload(page, dev, files, exact ? 20 : 1, { exact });
    await cdp.send("Network.emulateNetworkConditions", { ...slow, offline: true });
    const shown = await seesTrouble(page);
    check(`${P}: the page says the connection is lost`, /Connection lost/.test(shown), shown);
    await page.screenshot({ path: `${SHOTS}${dev}-net-offline.png` });
    await page.waitForTimeout(secs * 1000);
    await cdp.send("Network.emulateNetworkConditions", slow);
    await page.waitForFunction(() => document.body.dataset.connection === "ok", null, { timeout: 120000, polling: 200 });
    check(`${P}: resumes when the network is back`, true);
    await finishNetUpload(page, P, files);
    await noErrors(P, errors);
    await context.close();
  }

  // Flaky: a third of the appends fail (connection reset or a 503 from the proxy); as they are, and
  // compressed on the way.
  for (const exact of [true, false]) {
    const P = `flaky${exact ? "" : "-compressing"}/${dev}`;
    const { context, page, errors } = await newPage(dev, { allowErrors: noise });
    // Every third append fails (alternately reset and 503), so every run rides out some.
    let failed = 0, patches = 0;
    await page.route(/\/api\/shares\/[^/]+\/files\//, async (route) => {
      const r = route.request();
      if (r.method() === "PATCH" && ++patches % 3 === 2) {
        failed++;
        return failed % 2 ? route.abort("connectionreset") : route.fulfill({ status: 503, body: "Service Unavailable" });
      }
      return route.continue();
    });
    await startNetUpload(page, dev, files, 0, { exact });
    await finishNetUpload(page, P, files);
    check(`${P}: rode out ${failed} failed requests`, failed > 0, `${failed} failed`);
    await noErrors(P, errors);
    await context.close();
  }

  // A server that stops responding mid-request (a proxy that stops forwarding part-way through a body).
  // Against a remote server, the page comes from the local server and talks to the remote API
  // through the proxy (a page on https can't call http://127.0.0.1).
  {
    const P = `stall/${dev}`;
    const remote = !/localhost|127\.0\.0\.1/.test(BASE);
    const u = new URL(BASE);
    const proxy = await stallProxy(3399, remote ? { host: u.hostname, port: Number(u.port || 443), tls: u.protocol === "https:" } : { port: Number(u.port || 80) }, 3);
    // 409 while the server is still holding the stalled request (until its 30 s idle limit).
    const { context, page, errors } = await newPage(dev, { allowErrors: [...noise, /409/] });
    await startNetUpload(page, dev, files, 0, { query: "?api=http://127.0.0.1:3399", pageBase: remote ? "http://localhost:3333" : BASE, exact: true });
    const shown = await seesTrouble(page, 120000);
    check(`${P}: a stalled request is noticed`, proxy.stalled && /Connection lost/.test(shown), shown);
    await finishNetUpload(page, P, files);
    await noErrors(P, errors);
    await context.close();
    proxy.close();
  }
}

/** A passcode link whose capability URLs last 5 s, re-shared while uploading slowly. */
async function flowCapExpiry(dev) {
  if (!/localhost|127\.0\.0\.1/.test(BASE)) return;
  const P = `cap-expiry/${dev}`;
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const data = mkdtempSync("/media/barracuda/shlink-dicom-share-big/capsrv-");
  const srv = spawn(`${ROOT}target/release/shl-dicom-server`, ["serve", "--port", "3398", "--data-dir", data], { env: { ...process.env, SHL_CAP_TTL_SECS: "5" }, stdio: "ignore" });
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch("http://127.0.0.1:3398/api/demo-shares")).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    const src = JSON.parse(execFileSync("bun", [`${ROOT}web/checks/share-source.ts`, "http://127.0.0.1:3398", NET_DIR], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").pop());
    const { context, page, errors } = await newPage(dev, { allowErrors: [/404 .*\/cap\//, /status of 404/] });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 20, downloadThroughput: -1, uploadThroughput: 4 << 20 });
    await page.goto(`${BASE}/share`);
    await page.click("[data-src=link]");
    await page.fill("#in-link", src.link);
    await page.click("#link-form button[type=submit]");
    await page.waitForSelector("#in-link-pass:visible");
    await page.fill("#in-link-pass", "4321");
    await page.click("#link-form button[type=submit]");
    await page.waitForSelector("#s-review:not(.hidden)", { timeout: 120000 });
    await page.click("#rv-next");
    await page.click("#who-form button[type=submit]");
    await page.waitForSelector("#s-done:not(.hidden), #up-error:not(.hidden)", { timeout: 900000 });
    if (await page.locator("#up-error:not(.hidden)").count()) throw new Error(`upload failed: ${await page.textContent("#up-error-text")}`);
    const result = await page.evaluate(() => window.__share.result);
    made.push(result.manage);
    const ev = await (await fetch(`http://127.0.0.1:3398/api/shares/${src.sid}/access?limit=5000`, { headers: { Authorization: `Bearer ${src.token}` } })).json();
    const posts = ev.events.filter((e) => e.method === "POST" && e.status === 200).length;
    const expired = ev.events.filter((e) => /\/cap\//.test(e.path) && e.status === 404).length;
    check(`${P}: the capability URL expired and was renewed with the remembered passcode`, posts >= 2, `${posts} manifest requests, ${expired} expired-capability 404s logged`);
    const v = verify(result.shlink, [], undefined, [`--ref-link=${src.link}`, "--ref-passcode=4321", "--pixels"]);
    sameContent(P, v, v.instances, "the source link");
    await noErrors(P, errors);
    await context.close();
  } finally {
    srv.kill();
    rmSync(data, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------- remembering the picked files

/** Reload mid-upload twice: with remembered handles, and with files picked again (one changed). */
async function flowRemember(dev) {
  const { readdirSync, readFileSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = await import("node:fs");
  const noise = [/status of 404/, /404 .*\/files\//, /ERR_ABORTED|net::/i];
  const slow = { offline: false, latency: 20, downloadThroughput: -1, uploadThroughput: 1 << 20 };

  // 1. Picked with the File System Access API (handles kept in IndexedDB). Handles to files in the
  //    page's private file system stand in for the picker, which can't run headless.
  {
    const P = `remember-handles/${dev}`;
    const { context, page, errors } = await newPage(dev, { allowErrors: noise });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", slow);
    await page.goto(`${BASE}/share`);
    const files = FX.files.map((f) => ({ name: f.split("/").pop(), b64: readFileSync(f).toString("base64") }));
    await page.evaluate(async (files) => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("picked", { create: true });
      const handles = [];
      for (const f of files) {
        const h = await dir.getFileHandle(f.name, { create: true });
        const w = await h.createWritable();
        await w.write(Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)));
        await w.close();
        handles.push(h);
      }
      await window.__share.pickHandles({ kind: "files", handles });
    }, files);
    await page.waitForSelector("#s-review:not(.hidden)", { timeout: 60000 });
    await page.click("#rv-next");
    await page.click("#who-form button[type=submit]");
    await page.waitForFunction(() => /^(Compressed and u|U)ploaded/.test(document.getElementById("up-main")?.textContent ?? "") && parseFloat(document.getElementById("up-bar")?.style.width ?? "0") >= 20, null, { timeout: 120000, polling: 100 });
    await page.reload();
    await page.waitForSelector("#resume:not(.hidden)");
    const label = await page.textContent("#resume-continue");
    check(`${P}: after a reload, continues without picking again`, label === "Continue", label);
    await cdp.send("Network.emulateNetworkConditions", { ...slow, uploadThroughput: -1 });
    await page.click("#resume-continue");
    await finishNetUploadFrom(page, P, FX.files, FX.images);
    await noErrors(P, errors);
    await context.close();
  }

  // 2. Picked with a plain file input: after the reload the same files are picked again and matched
  //    by name, size and a quick hash. A changed file is named, and the right ones then continue.
  {
    const P = `remember-repick/${dev}`;
    execFileSync("bun", [`${ROOT}web/checks/share-big.ts`, NET_DIR, "200", "512"], { cwd: ROOT, encoding: "utf8" });
    const files = readdirSync(NET_DIR).filter((f) => f.endsWith(".dcm")).sort().map((f) => `${NET_DIR}/${f}`);
    const wrong = `/media/barracuda/shlink-dicom-share-big/changed-${process.pid}`;
    rmSync(wrong, { recursive: true, force: true });
    mkdirSync(wrong, { recursive: true });
    for (const f of files) symlinkSync(f, `${wrong}/${f.split("/").pop()}`);
    const first = files[0].split("/").pop();
    rmSync(`${wrong}/${first}`);
    const changed = readFileSync(files[0]);
    changed[2000] ^= 0xff;
    writeFileSync(`${wrong}/${first}`, changed);
    const { context, page, errors } = await newPage(dev, { allowErrors: noise });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { ...slow, uploadThroughput: 4 << 20 });
    await startNetUpload(page, dev, files, 20);
    await page.reload();
    await page.waitForSelector("#resume:not(.hidden)");
    let [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#resume-continue")]);
    await chooser.setFiles(readdirSync(wrong).sort().map((f) => `${wrong}/${f}`));
    await page.waitForSelector("#resume-error:not(.hidden)", { timeout: 60000 });
    const msg = await page.textContent("#resume-error");
    check(`${P}: a changed file is named`, msg === `${first} is not the same file as before.`, msg);
    await layout(page, `${P} notice`, dev);
    await page.screenshot({ path: `${SHOTS}${dev}-resume-changed.png` });
    [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#resume-continue")]);
    await chooser.setFiles(files);
    await finishNetUploadFrom(page, P, files, files.length, NET_DIR);
    await noErrors(P, errors);
    await context.close();
    rmSync(wrong, { recursive: true, force: true });
  }
}

async function finishNetUploadFrom(page, P, files, images, ref) {
  await page.waitForSelector("#s-done:not(.hidden), #up-error:not(.hidden)", { timeout: 900000 });
  if (await page.locator("#up-error:not(.hidden)").count()) throw new Error(`upload failed: ${await page.textContent("#up-error-text")}`);
  const result = await page.evaluate(() => window.__share.result);
  made.push(result.manage);
  const v = verify(result.shlink, ref ? [ref] : files, undefined, ["--pixels"]);
  sameContent(P, v, images, "the files");
}

// --------------------------------------------------------------------------------- dark mode

const DARK_SHOTS = `${ROOT}docs/shots/dark/`;

/** In dark mode: no near-white panels except the QR code, and body text at 4.5:1 or more. */
async function darkAudit(page, label) {
  const r = await page.evaluate(() => {
    const rgb = (c) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (el) => {
      for (let e = el; e; e = e.parentElement) {
        const c = rgb(getComputedStyle(e).backgroundColor);
        if (c.length >= 3 && (c[3] === undefined || c[3] > 0.5)) return c;
      }
      return rgb(getComputedStyle(document.body).backgroundColor);
    };
    const visible = (el) => {
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== "hidden" && !el.closest(".hidden");
    };
    const dimmed = (el) => {
      for (let e = el; e; e = e.parentElement) if (Number(getComputedStyle(e).opacity) < 1) return true;
      return !!el.closest("[disabled], [aria-disabled=true]");
    };
    const white = [], low = [];
    for (const el of document.querySelectorAll("body *")) {
      if (!visible(el) || el.closest(".qr, canvas, img, svg")) continue;
      const c = rgb(getComputedStyle(el).backgroundColor);
      const b = el.getBoundingClientRect();
      if (c.length >= 3 && (c[3] === undefined || c[3] > 0.5) && lum(c) > 0.7 && b.width * b.height > 2000) white.push(`${el.tagName.toLowerCase()}.${el.className}`);
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own || dimmed(el)) continue;
      const fg = rgb(getComputedStyle(el).color), bg = bgOf(el);
      const [a, z] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      const ratio = (a + 0.05) / (z + 0.05);
      if (ratio < 4.5) low.push(`${el.tagName.toLowerCase()} "${el.textContent.trim().slice(0, 30)}" ${ratio.toFixed(2)}`);
    }
    return { white: [...new Set(white)], low: [...new Set(low)] };
  });
  check(`${label}: no near-white panels`, r.white.length === 0, r.white.slice(0, 5).join(", "));
  check(`${label}: text contrast ≥ 4.5:1`, r.low.length === 0, r.low.slice(0, 5).join(", "));
}

async function flowDark(dev) {
  mkdirSync(DARK_SHOTS, { recursive: true });
  const P = `dark/${dev}`;
  const shotD = (page, name) => page.screenshot({ path: `${DARK_SHOTS}${dev}-${name}.png`, fullPage: true });
  const noise = [/ERR_INTERNET_DISCONNECTED|ERR_FAILED|net::/i, /status of 404/, /404 .*\/files\//];
  const { context, page, errors } = await newPage(dev, { dark: true, allowErrors: noise });
  await page.goto(`${BASE}/share`);
  await page.waitForSelector(".choice");
  check(`${P}: the page is in dark mode`, await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches));
  await darkAudit(page, `${P} sources`);
  await shotD(page, "1-sources");
  await page.click("[data-src=portal]");
  await darkAudit(page, `${P} portal panel`);
  await shotD(page, "1-portal");
  await page.click("#add-portal [data-back]");
  await page.click("[data-src=files]");
  await darkAudit(page, `${P} files panel`);
  await page.setInputFiles("#in-files", FX.files);
  await page.waitForSelector("#s-review:not(.hidden)", { timeout: 60000 });
  await page.waitForFunction(() => document.body.dataset.thumbs === "done", null, { timeout: 30000 });
  writeFileSync(`${FXDIR}/Report.txt`, "SYNTHETIC REPORT FOR TESTING.\n");
  await page.locator(".study").first().locator(".reports input[type=file]").setInputFiles(`${FXDIR}/Report.txt`);
  await page.waitForSelector(".study .report-row");
  await page.locator(".study").nth(1).locator(".study-head .switch-label").click();
  await darkAudit(page, `${P} review`);
  await shotD(page, "2-review");
  await page.locator(".study").nth(1).locator(".study-head .switch-label").click();
  await page.click("#rv-next");
  await darkAudit(page, `${P} who`);
  await shotD(page, "3-who");
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  const slow = { offline: false, latency: 20, downloadThroughput: -1, uploadThroughput: 512 << 10 };
  await cdp.send("Network.emulateNetworkConditions", slow);
  await page.click("#who-form button[type=submit]");
  await page.waitForFunction(() => /^(Compressed and u|U)ploaded/.test(document.getElementById("up-main")?.textContent ?? "") && parseFloat(document.getElementById("up-bar")?.style.width ?? "0") >= 10, null, { timeout: 120000, polling: 100 });
  await darkAudit(page, `${P} upload`);
  await shotD(page, "4-upload");
  await cdp.send("Network.emulateNetworkConditions", { ...slow, offline: true });
  await page.waitForFunction(() => ["offline", "retrying"].includes(document.body.dataset.connection), null, { timeout: 60000 });
  await darkAudit(page, `${P} connection lost`);
  await shotD(page, "4-upload-connection-lost");
  await cdp.send("Network.emulateNetworkConditions", { ...slow, offline: false, uploadThroughput: -1 });
  await page.waitForSelector("#s-done:not(.hidden)", { timeout: 300000 });
  const result = await page.evaluate(() => window.__share.result);
  made.push(result.manage);
  await darkAudit(page, `${P} hand-over`);
  const qr = await page.evaluate(() => getComputedStyle(document.querySelector(".qr")).backgroundColor);
  check(`${P}: the QR code stays dark on white`, qr === "rgb(255, 255, 255)", qr);
  await shotD(page, "5-done");
  await page.goto(result.manage);
  await page.waitForSelector(".link-card", { timeout: 20000 });
  await page.locator(".link-card").first().getByRole("button", { name: "Show link" }).click();
  await page.waitForSelector(".lc-qr .qr svg");
  await darkAudit(page, `${P} owner page`);
  await shotD(page, "6-owner");
  await page.locator(".link-card").first().getByRole("button", { name: "Revoke" }).click();
  await page.waitForSelector("dialog[open]");
  await shotD(page, "6-owner-dialog");
  await page.keyboard.press("Escape");
  await noErrors(P, errors);
  await context.close();

  // The portal callback and its review, with reports.
  if (/localhost|127\.0\.0\.1/.test(BASE)) {
    const { context: c2, page: p2, errors: e2 } = await newPage(dev, { dark: true });
    await p2.goto(`${BASE}/share`);
    await p2.click("[data-src=portal]");
    await Promise.all([p2.waitForURL((u) => u.host === new URL(PORTAL).host && u.pathname.includes("/auth")), p2.click("#portal-form button[type=submit]")]);
    await p2.locator("input[name=patient]").first().check();
    await p2.getByRole("button", { name: "Continue" }).click();
    await p2.waitForSelector("input[name=study]");
    await Promise.all([p2.waitForURL(/\/share\/smart-callback\//), p2.getByRole("button", { name: "Allow" }).click()]);
    await p2.waitForFunction(() => document.getElementById("loading-bar")?.getAttribute("aria-valuenow") > 0, null, { timeout: 120000 });
    await darkAudit(p2, `${P} portal download`);
    await shotD(p2, "1-portal-download");
    await p2.waitForSelector("#s-review:not(.hidden)", { timeout: 600000 });
    await darkAudit(p2, `${P} portal review`);
    await shotD(p2, "2-review-portal");
    await noErrors(`${P} portal`, e2);
    await c2.close();
  }
}

// ------------------------------------------------------------------ the stable sample address

async function flowSample(dev) {
  const P = `sample/${dev}`;
  const S = await sample();
  const { context, page, errors } = await newPage(dev);
  await page.goto(`${BASE}/sample`);
  check(`${P}: /sample lands in the viewer`, /\/view#shlink:\//.test(page.url()), page.url().slice(0, 80));
  await page.waitForSelector("#screen-overview:not(.hidden)", { timeout: 30000 });
  const n = await page.locator(".study-card").count();
  check(`${P}: with the sample open`, n === S.totals.studies.length, `${n} studies`);
  await page.goto(`${BASE}/sample/passcode`);
  await page.waitForSelector("#screen-passcode:not(.hidden)", { timeout: 30000 });
  check(`${P}: /sample/passcode asks for the passcode`, /\/view#shlink:\//.test(page.url()));
  await page.goto(`${BASE}/view`);
  await page.waitForSelector("#sample-row:not(.hidden)", { timeout: 20000 });
  await layout(page, `${P} empty /view`, dev);
  await shot(page, `${dev}-view-empty`);
  await page.click("#btn-sample");
  await page.waitForSelector("#screen-overview:not(.hidden)", { timeout: 30000 });
  const m = await page.locator(".study-card").count();
  check(`${P}: the empty /view's sample button opens the sample`, m === S.totals.studies.length, `${m} studies`);
  await page.goto(`${BASE}/`);
  await page.waitForFunction(() => !document.getElementById("sample-public")?.hasAttribute("aria-disabled"), null, { timeout: 20000 });
  const href = await page.getAttribute("#sample-public", "href");
  check(`${P}: the landing page's sample button uses /sample`, href === `${new URL(BASE).origin}/sample`, href);
  await noErrors(P, errors);
  await context.close();
}

// ---------------------------------------------------------------------------------------- run

for (const dev of Object.keys(DEVICES)) {
  if (onlyDev && dev !== onlyDev) continue;
  try {
    let files;
    if (!only || only === "files" || only === "manage") files = await flowFiles(dev);
    if (!only || only === "portal") await flowPortal(dev);
    if (!only || only === "portal" || only === "portal-resume") await flowPortalResume(dev);
    if (!only || only === "reshare") await flowReshare(dev);
    if (!only || only === "exact") await flowExact(dev);
    if (!only || only === "cd") await flowCd(dev);
    if (!only || only === "j2k") {
      await flowJ2k(dev);
      await flowJ2kResume(dev);
    }
    if (files && (!only || only === "manage")) await flowManage(dev, files);
    if (!only || only === "slide") await flowSlide(dev);
    if (!only || only === "sample") await flowSample(dev);
    if (!only || only === "dark") await flowDark(dev);
    if (!only || only === "remember") await flowRemember(dev);
    if (!only || only === "network") {
      await flowNetwork(dev);
      await flowCapExpiry(dev);
    }
    // --big: the 1.2 GB slide and a multi-GB CT (local disk space and time; not run by default).
    if (args.includes("--big") && (!only || only === "big")) {
      await flowSlide(dev, { full: true });
      await flowBigCt(dev);
    }
  } catch (e) {
    check(`${dev}: flow ran to the end`, false, String(e.stack ?? e).split("\n").slice(0, 3).join(" "));
  }
}

pageErrorCheck(browser, check);

await browser.close();
// Clean up the shares the checks made.
for (const m of made) {
  const q = new URLSearchParams(m.split("#")[1]);
  await fetch(`${BASE}/api/shares/${q.get("share")}`, { method: "DELETE", headers: { Authorization: `Bearer ${q.get("token")}` } }).catch(() => {});
}
(await import("node:fs")).rmSync(FXDIR, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
