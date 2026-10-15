// Scripted headless-Chromium checks for /share and /share/manage.
//   node web/checks/share-checks.mjs [--only=files|portal|reshare|manage|slide] [--dev=desktop|phone390]
// The slide flow needs the CPTAC-LUAD slide (web/view/WSI.md) in SLIDE_DIR; it is skipped without it.
// Needs the server on :3333 and the imaging sandbox on :3334 started with
//   SHARE_REDIRECT_URIS=http://localhost:3333/share/smart-callback/ bun src/server.ts
// Screenshots go to docs/shots/share/. Exits non-zero if any check fails. Deletes the shares it makes.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const BASE = process.env.BASE ?? "http://localhost:3333";
const ROOT = new URL("../../", import.meta.url).pathname;
const SHOTS = `${ROOT}docs/shots/share/`;
mkdirSync(SHOTS, { recursive: true });
const SAMPLES = [`${ROOT}data/samples/mri-brain-2020.tgz`, `${ROOT}data/samples/wrist-low-res.tgz`];
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

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium" });

async function newPage(dev, opts = {}) {
  const context = await browser.newContext({ ...DEVICES[dev] });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE }).catch(() => {});
  const page = await context.newPage();
  const errors = [];
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

function verify(link, archives = [], passcode) {
  const out = execFileSync("bun", [`${ROOT}web/checks/share-verify.ts`, link, ...archives, ...(passcode ? [`--passcode=${passcode}`] : [])], { cwd: ROOT, encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out.trim().split("\n").pop());
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
    await page.waitForFunction(() => /Uploaded [^0]/.test(document.getElementById("up-main").textContent), null, { timeout: 30000 }).catch(() => {});
    await shot(page, `${dev}-4-upload`);
  }
  await page.waitForSelector("#s-done:not(.hidden)", { timeout: 120000 });
  const result = await page.evaluate(() => window.__share.result);
  made.push(result.manage);
  if (o.shots) {
    await layout(page, `${prefix} done`, dev);
    await shot(page, `${dev}-5-done`);
  }
  check(`${prefix}: QR code rendered`, (await page.locator("#qr svg").count()) === 1);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("shl-dicom-shares") ?? "[]").length);
  check(`${prefix}: manage link saved in this browser`, saved >= 1, `${saved} saved`);
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
  const { context, page, errors } = await newPage(dev);
  await page.goto(`${BASE}/share`);
  await page.waitForSelector(".choice");
  await layout(page, `${P} add`, dev);
  await shot(page, `${dev}-1-add`);
  check(`${P}: four sources offered`, (await page.locator(".choice").count()) === 4);
  await page.click("[data-src=files]");
  await layout(page, `${P} files panel`, dev);
  await shot(page, `${dev}-1-files`);
  await page.setInputFiles("#in-files", SAMPLES);
  await page.waitForSelector("#s-review:not(.hidden)", { timeout: 60000 });
  await page.waitForFunction(() => document.body.dataset.thumbs === "done", null, { timeout: 30000 });
  const found = await page.textContent("#found");
  check(`${P}: found line counts everything`, /2 studies · 17 series · 266 images/.test(found), found);
  const titles = await page.locator(".study h2").allTextContents();
  check(`${P}: plain study names`, titles.join("|") === "Brain MRI|Upper extremity X-ray", titles.join("|"));
  const drawn = await page.locator("canvas.drawn").count();
  check(`${P}: 17 series thumbnails drawn`, drawn === 17, `${drawn}`);
  check(`${P}: no offset-table option for single-frame files`, await page.locator("#rv-offsets-row.hidden").count() === 1);
  const tech = await page.locator(".study .tech").first().textContent();
  check(`${P}: technical line`, /14 series · 263 images · 41 MB · uncompressed/.test(tech), tech);
  await layout(page, `${P} review`, dev);
  await shot(page, `${dev}-2-review`);
  const r = await finish(page, dev, P, { recipient: "Dr. Patel, Neurology", shots: true });
  const v = verify(r.shlink, SAMPLES);
  check(`${P}: link opens with both studies`, v.studies.length === 2 && v.instances === 266, JSON.stringify(v.studies.map((s) => s.instances)));
  check(`${P}: every instance byte-identical to the archives`, v.matched === 266 && v.mismatched === 0, `${v.matched} matched, ${v.mismatched} differ, ${v.missing} missing`);
  check(`${P}: label in the link`, v.label === "Imaging for Dr. Patel, Neurology", v.label);
  const view = await openInView(dev, r.shlink, P, { name: "files" });
  check(`${P}: /view lists 2 studies`, view.studies === 2, `${view.studies}`);
  await noErrors(P, errors);
  await context.close();
  return r;
}

async function flowPortal(dev) {
  const P = `portal/${dev}`;
  const { context, page, errors } = await newPage(dev);
  await page.goto(`${BASE}/share`);
  await page.click("[data-src=portal]");
  const portal = await page.inputValue("#in-portal");
  check(`${P}: portal defaults to the local sandbox`, portal === "http://localhost:3334/fhir", portal);
  await layout(page, `${P} portal panel`, dev);
  await shot(page, `${dev}-1-portal`);
  await Promise.all([page.waitForURL(/localhost:3334\/auth/), page.click("#portal-form button[type=submit]")]);
  await page.locator("input[name=patient]").first().check();
  await shot(page, `${dev}-portal-signin`);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForSelector("input[name=study]");
  await shot(page, `${dev}-portal-consent`);
  await Promise.all([page.waitForURL(/\/share\/smart-callback\//), page.getByRole("button", { name: "Allow" }).click()]);
  await page.waitForSelector("#s-review:not(.hidden)", { timeout: 90000 });
  await page.waitForFunction(() => document.body.dataset.thumbs === "done", null, { timeout: 30000 });
  check(`${P}: callback URL cleaned up`, !/code=/.test(page.url()), page.url());
  const patient = await page.textContent("#rv-patient");
  check(`${P}: patient from the portal`, /^Patient: /.test(patient), patient);
  const reports = await page.locator(".report-line").allTextContents();
  check(`${P}: a report for each study`, reports.length === 2, reports.join(" | "));
  const drawn = await page.locator("canvas.drawn").count();
  check(`${P}: thumbnails drawn`, drawn === 17, `${drawn}`);
  await layout(page, `${P} review`, dev);
  await shot(page, `${dev}-2-review-portal`);
  const pass = "2468";
  const r = await finish(page, dev, P, { recipient: "Dr. Okafor", passcode: pass, expiry: "1m", updates: true });
  const v = verify(r.shlink, [], pass);
  check(`${P}: link has both studies`, v.studies.length === 2 && v.instances === 266, JSON.stringify(v.studies));
  check(`${P}: reports travel with PDF and text inline`, v.reports.length === 2 && v.reports.every((x) => x.hasText && x.forms.includes("application/pdf")), JSON.stringify(v.reports));
  check(`${P}: started date from the portal`, !!v.studies[0].started, v.studies[0].started);
  const view = await openInView(dev, r.shlink, P, { passcode: pass, name: "portal" });
  check(`${P}: /view shows the reports`, view.reports.length >= 2 && view.reports.some((t) => /SAMPLE REPORT|impression/i.test(t)), view.reports.map((t) => t.slice(0, 60)).join(" | "));
  await noErrors(P, errors);
  await context.close();
}

async function flowReshare(dev) {
  const P = `reshare/${dev}`;
  const demos = await (await fetch(`${BASE}/api/demo-shares`)).json();
  const sample = demos.shares.find((s) => !s.passcodeHint).shlinkUri;
  const { context, page, errors } = await newPage(dev);
  await page.goto(`${BASE}/share`);
  await page.click("[data-src=link]");
  await page.fill("#in-link", sample);
  await layout(page, `${P} link panel`, dev);
  await shot(page, `${dev}-1-link`);
  await page.click("#link-form button[type=submit]");
  await page.waitForSelector("#s-review:not(.hidden)", { timeout: 60000 });
  check(`${P}: two studies from the link`, (await page.locator(".study").count()) === 2);
  // Leave out the wrist study.
  await page.locator(".study").nth(1).locator(".switch-label").click();
  check(`${P}: study marked as left out`, (await page.locator(".study.excluded").count()) === 1);
  const total = await page.textContent("#rv-total");
  check(`${P}: total updates`, /^Sharing 1 study/.test(total), total);
  await shot(page, `${dev}-2-review-reshare`);
  const r = await finish(page, dev, P, { recipient: "Second opinion" });
  const v = verify(r.shlink, SAMPLES);
  check(`${P}: new link has only the brain MRI`, v.studies.length === 1 && v.instances === 263, JSON.stringify(v.studies));
  check(`${P}: instances byte-identical to the originals`, v.matched === 263, `${v.matched} matched`);
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
  check(`${P}: link lists its studies`, studies === "Brain MRI, Upper extremity X-ray", studies);
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

  // New link for someone else: the wrist study only.
  await page.click("#new-link-btn");
  await page.fill("#nl-recipient", "Dr. Lee, Orthopedics");
  await page.locator(".check-row", { hasText: "Brain MRI" }).click();
  await layout(page, `${P} new link form`, dev);
  await shot(page, `${dev}-6-manage-new-link`);
  await page.locator("#new-link button[type=submit]").click();
  await page.waitForFunction(() => document.querySelectorAll(".link-card").length === 2);
  await page.waitForSelector(".lc-qr .mono");
  const newLink = await page.locator(".lc-qr .mono").first().textContent();
  const v = verify(newLink, SAMPLES);
  check(`${P}: new link has only the wrist study`, v.studies.length === 1 && v.instances === 3 && v.matched === 3, JSON.stringify(v.studies));
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

async function flowSlide(dev) {
  const P = `slide/${dev}`;
  const { readdirSync, statSync } = await import("node:fs");
  let files = [];
  try {
    files = readdirSync(SLIDE_DIR).map((f) => `${SLIDE_DIR}/${f}`).filter((f) => f.endsWith(".dcm") && statSync(f).size < 500e6);
  } catch {}
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

// ---------------------------------------------------------------------------------------- run

for (const dev of Object.keys(DEVICES)) {
  if (onlyDev && dev !== onlyDev) continue;
  try {
    let files;
    if (!only || only === "files" || only === "manage") files = await flowFiles(dev);
    if (!only || only === "portal") await flowPortal(dev);
    if (!only || only === "reshare") await flowReshare(dev);
    if (files && (!only || only === "manage")) await flowManage(dev, files);
    if (!only || only === "slide") await flowSlide(dev);
  } catch (e) {
    check(`${dev}: flow ran to the end`, false, String(e.stack ?? e).split("\n").slice(0, 3).join(" "));
  }
}

await browser.close();
// Clean up the shares the checks made.
for (const m of made) {
  const q = new URLSearchParams(m.split("#")[1]);
  await fetch(`${BASE}/api/shares/${q.get("share")}`, { method: "DELETE", headers: { Authorization: `Bearer ${q.get("token")}` } }).catch(() => {});
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
