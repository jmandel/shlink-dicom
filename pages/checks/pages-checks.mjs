// Headless-Chromium checks for the GitHub Pages build (pages/build.ts), served as Pages would serve
// it (pages/checks/serve.ts):
//
//   bun pages/build.ts --site-url http://localhost:8787/shlink-dicom/ --out dist/pages-local
//   bun pages/checks/serve.ts dist/pages-local &
//   node pages/checks/pages-checks.mjs [--shots DIR]
//
// The entry page and the viewer at 390 and 1440 px, light and dark (screenshots); the demo link
// opens through the protocol alone (every study file read with Range and answered 206, nothing
// fetched from /api, nothing kept in Cache Storage or IndexedDB); the MRI scrolls; the MRI slice
// and the X-ray show the source's pixel values; "Download study" gives the shared files byte for
// byte, and those hold the same pixels as the my-health-data originals (web/checks/pixel-identity.py).
// Exits non-zero if any check fails.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser } from "../../web/checks/browser.mjs";

const ROOT = new URL("../../", import.meta.url).pathname;
const BASE = process.env.BASE ?? "http://localhost:8787/shlink-dicom/";
const args = process.argv.slice(2);
const SHOTS = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : join(ROOT, "docs/shots/pages");
const SCRATCH = process.env.SCRATCH ?? join(ROOT, "dist/pages-checks");
mkdirSync(SHOTS, { recursive: true });
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const cfg = JSON.parse(readFileSync(join(ROOT, "pages/demo-link.json"), "utf8"));
const server = process.env.SHL_DICOM_SERVER ?? join(process.env.CARGO_TARGET_DIR ?? join(ROOT, "target"), "release/shl-dicom-server");
// The Python project with pydicom and its decoders (web/checks/pixel-identity.py uses it too).
const PYPROJ = process.env.PYPROJ ?? join(ROOT, "codec-corpus");
const sources = join(process.env.PAGES_SOURCE_CACHE ?? join(ROOT, "dist/pages-sources"), cfg.source.commit);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const py = (script, input) =>
  JSON.parse(execFileSync("uv", ["run", "--project", PYPROJ, "python", "-c", script], { input: JSON.stringify(input), maxBuffer: 1 << 26 }).toString());

// The originals (the archive members) and the shared files (`shl-dicom-server compress`, as the build).
const inputs = cfg.source.files.map((f) => join(sources, f.path));
const orig = join(SCRATCH, "orig"), shared = join(SCRATCH, "shared");
for (const tgz of inputs) {
  const d = join(orig, tgz.split("/").pop());
  mkdirSync(d, { recursive: true });
  execFileSync("tar", ["-xzf", tgz, "-C", d]);
}
execFileSync(server, ["compress", ...inputs, "--out", shared], { stdio: "ignore" });
// SOP Instance UID → original file, for the pixel value checks.
const byUid = py(
  `import json,sys,pydicom
print(json.dumps({str(pydicom.dcmread(p, stop_before_pixels=True).SOPInstanceUID): p for p in json.load(sys.stdin)}))`,
  walk(orig),
);

const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};
const browser = await launchBrowser();

async function newPage(dev, colorScheme = "light") {
  const context = await browser.newContext({ ...DEVICES[dev], colorScheme, acceptDownloads: true });
  await context.addInitScript(() => delete window.showSaveFilePicker);
  const page = await context.newPage();
  const errors = [], requests = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("requestfinished", async (r) => {
    const res = await r.response();
    requests.push({ url: r.url(), method: r.method(), range: r.headers()["range"] ?? null, status: res?.status() ?? 0 });
  });
  page.on("response", (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url().slice(0, 120)}`));
  return { context, page, errors, requests };
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const idle = (page) => page.waitForFunction(() => !document.querySelector("#stage-busy:not(.hidden)") && window.__viewHooks?.renderShown(8, 8), null, { timeout: 120000 });

async function openStudy(page, re) {
  if (await page.isVisible("#btn-back")) {
    await page.click("#btn-back");
    await page.waitForSelector("#screen-overview:not(.hidden)");
  }
  const titles = await page.locator(".study-card .study-title").allTextContents();
  const i = titles.findIndex((t) => re.test(t));
  if (i < 0) throw new Error(`no study ${re} in ${titles.join(", ")}`);
  await page.locator(".study-open").nth(i).click();
  await page.waitForSelector("#screen-viewer:not(.hidden)");
  await idle(page);
  await page.waitForTimeout(400);
}

// Values on screen (valueAt, the cursor readout) against pydicom's decode of the original file.
async function pixelCheck(page, label) {
  const cur = await page.evaluate(() => window.__viewHooks.current());
  const uid = cur.onScreen?.uid;
  const src = uid && byUid[uid];
  if (!src) return check(`${label}: on-screen instance is in the source`, false, String(uid));
  const pts = py(
    `import json,sys,pydicom,numpy as np
q=json.load(sys.stdin); ds=pydicom.dcmread(q["path"]); a=ds.pixel_array.astype(float)
a=a*float(getattr(ds,"RescaleSlope",1) or 1)+float(getattr(ds,"RescaleIntercept",0) or 0)
r,c=a.shape[:2]; pts=[(int(r*y/9),int(c*x/9)) for y in range(1,9) for x in range(1,9)]
print(json.dumps({"rows":r,"cols":c,"pts":[[y,x,a[y,x]] for y,x in pts]}))`,
    { path: src },
  );
  const got = await page.evaluate((p) => p.map(([y, x]) => window.__viewHooks.valueAt(x, y)?.value ?? null), pts.pts);
  const bad = pts.pts.filter(([, , v], i) => got[i] === null || Math.abs(got[i] - v) > 1e-6);
  check(`${label}: ${pts.pts.length} pixel values match the original (${pts.cols}×${pts.rows})`, bad.length === 0, bad.length ? `${bad.length} differ, e.g. ${JSON.stringify(bad[0])} vs ${got[pts.pts.findIndex((p) => p === bad[0])]}` : "");
}

// 1. The entry page.
let viewerLink = null;
for (const dev of ["desktop", "phone"]) {
  for (const scheme of ["light", "dark"]) {
    const { context, page, errors } = await newPage(dev, scheme);
    await page.goto(BASE);
    const label = `entry/${dev}/${scheme}`;
    viewerLink = await page.getAttribute("a.btn-primary", "href");
    check(`${label}: viewer link`, /\/view\/#shlink:\//.test(viewerLink ?? ""), viewerLink?.slice(0, 60));
    check(`${label}: QR code`, (await page.locator(".qr svg").count()) === 1);
    check(`${label}: no horizontal overflow`, (await overflow(page)) <= 0);
    check(`${label}: no unfilled placeholders`, !(await page.content()).includes("{{"));
    check(`${label}: no console errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
    await page.screenshot({ path: join(SHOTS, `entry-${dev === "desktop" ? 1440 : 390}-${scheme}.png`), fullPage: true });
    await context.close();
  }
}

// 2. The viewer, desktop: protocol only, MRI scrolls, pixel values, downloads.
{
  const { context, page, errors, requests } = await newPage("desktop");
  await page.goto(viewerLink);
  await page.waitForSelector("#screen-overview:not(.hidden)", { timeout: 30000 });
  await page.waitForFunction(() => window.__view?.marks["first-thumb"], null, { timeout: 30000 });
  check("view: two studies", (await page.locator(".study-open").count()) === 2);
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(SHOTS, "view-overview-1440-light.png") });

  await openStudy(page, /BRAIN/);
  const s0 = await page.evaluate(() => ({ ...window.__viewHooks.state(), img: window.__viewHooks.renderShown(64, 64).grey }));
  await page.click("#stage");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowDown");
  await idle(page);
  await page.waitForTimeout(400);
  const s1 = await page.evaluate(() => ({ ...window.__viewHooks.state(), img: window.__viewHooks.renderShown(64, 64).grey }));
  const changed = s0.img.filter((v, i) => Math.abs(v - s1.img[i]) > 8).length;
  check("view MRI: slices scroll", s1.sliceIdx === s0.sliceIdx + 5 && changed > 100, `slice ${s0.sliceIdx} → ${s1.sliceIdx}, ${changed} of 4096 pixels changed`);
  check("view MRI: image not blank", new Set(s1.img).size > 20);
  await pixelCheck(page, "view MRI");
  await page.screenshot({ path: join(SHOTS, "view-mri-1440-light.png") });

  await openStudy(page, /WRIST/);
  const xr = await page.evaluate(() => window.__viewHooks.renderShown(64, 64).grey);
  check("view X-ray: image drawn", new Set(xr).size > 20);
  await pixelCheck(page, "view X-ray");
  await page.screenshot({ path: join(SHOTS, "view-xray-1440-light.png") });

  // Download study: the shared files, byte for byte.
  const sharedSha = new Map(walk(shared).map((p) => [sha(p), p]));
  const pairs = [];
  for (const re of [/WRIST/, /BRAIN/]) {
    await openStudy(page, re);
    const dl = page.waitForEvent("download", { timeout: 300000 });
    await page.click("#btn-download");
    const d = await dl;
    const zip = join(SCRATCH, d.suggestedFilename());
    await d.saveAs(zip);
    const dir = `${zip}.d`;
    mkdirSync(dir, { recursive: true });
    execFileSync("unzip", ["-q", zip, "-d", dir]);
    const files = walk(dir).filter((f) => /\/IM\d{6}$/.test(f));
    const missing = files.filter((f) => !sharedSha.has(sha(f)));
    check(`download ${re.source}: ${files.length} files, each a shared file byte for byte`, files.length > 0 && missing.length === 0, missing.slice(0, 2).join(", "));
    for (const f of files) {
      const s = sharedSha.get(sha(f));
      if (s) pairs.push({ source: join(orig, s.slice(shared.length + 1)), shared: f });
    }
    if (await page.isVisible("#sheet-download")) {
      await page.waitForSelector("#dl-status:has-text('Saved')", { timeout: 300000 }).catch(() => {});
      await page.click("#sheet-download [data-close]");
    }
    await page.waitForTimeout(500);
  }
  writeFileSync(join(SCRATCH, "pairs.json"), JSON.stringify(pairs));
  const pid = JSON.parse(execFileSync("uv", ["run", "--project", PYPROJ, "python", join(ROOT, "web/checks/pixel-identity.py"), join(SCRATCH, "pairs.json")], { maxBuffer: 1 << 26 }).toString());
  check(`downloads: pixels identical to the my-health-data originals (pixel-identity.py)`, pid.checked === pairs.length && pid.identical === pairs.length, `${pid.identical} of ${pid.checked}; ${JSON.stringify(pid.transferSyntaxes)}`);

  // Through the protocol only.
  const bins = requests.filter((r) => r.url.includes("/demo-links/") && /\.bin(\?|$)/.test(r.url));
  check("requests: study files read with Range, answered 206", bins.length > 0 && bins.every((r) => r.range && r.status === 206), `${bins.length} requests; ${bins.filter((r) => !r.range || r.status !== 206).length} not`);
  check("requests: nothing outside the site, no /api", requests.every((r) => r.url.startsWith(BASE) || r.url.startsWith("data:") || r.url.startsWith("blob:")) && !requests.some((r) => r.url.includes("/api/")), requests.filter((r) => !r.url.startsWith(BASE)).map((r) => r.url).slice(0, 3).join(" "));
  const stored = await page.evaluate(async () => ({ caches: (await caches.keys()).length, idb: (await indexedDB.databases()).length }));
  check("nothing kept: Cache Storage and IndexedDB empty", stored.caches === 0 && stored.idb === 0, JSON.stringify(stored));
  // The trust sheet's How it works link goes to the full demo (this copy has none).
  check("view: How it works link points at the full demo", (await page.getAttribute("#trust-how", "href")) === "https://shlink-dicom.exe.xyz/how");
  check("view desktop: no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
}

// 3. The viewer on a phone and in dark mode (screenshots, layout).
for (const [dev, scheme] of [["phone", "light"], ["phone", "dark"], ["desktop", "dark"]]) {
  const { context, page, errors } = await newPage(dev, scheme);
  const w = dev === "desktop" ? 1440 : 390;
  await page.goto(viewerLink);
  await page.waitForSelector("#screen-overview:not(.hidden)", { timeout: 30000 });
  await page.waitForFunction(() => window.__view?.marks["first-thumb"], null, { timeout: 30000 });
  await page.waitForTimeout(800);
  check(`view ${w}/${scheme}: overview, no horizontal overflow`, (await overflow(page)) <= 0);
  await page.screenshot({ path: join(SHOTS, `view-overview-${w}-${scheme}.png`) });
  await openStudy(page, /BRAIN/);
  await page.screenshot({ path: join(SHOTS, `view-mri-${w}-${scheme}.png`) });
  await openStudy(page, /WRIST/);
  await page.screenshot({ path: join(SHOTS, `view-xray-${w}-${scheme}.png`) });
  check(`view ${w}/${scheme}: no console errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
}

// 4. The viewer with no link: "Open the sample" opens this site's demo link (config.json).
{
  const { context, page, errors } = await newPage("phone");
  await page.goto(`${BASE}view/`);
  await page.waitForSelector("#btn-sample:visible");
  check("view, no link: sample description names this link's studies", /brain MRI and left wrist X-rays/.test(await page.textContent("#sample-row")));
  await page.screenshot({ path: join(SHOTS, "view-nolink-390-light.png") });
  await page.click("#btn-sample");
  await page.waitForSelector("#screen-overview:not(.hidden)", { timeout: 30000 });
  check("view, no link: Open the sample opens the demo link", (await page.locator(".study-open").count()) === 2);
  check("view, no link: no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
