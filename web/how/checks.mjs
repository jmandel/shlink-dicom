// Scripted headless-Chromium checks for the /how tour. Needs the server on BASE (default
// localhost:3333) serving a fresh `bun web/build.ts`.
//   node web/how/checks.mjs [--only=desktop|phone390] [--quick]
// Runs: desktop and phone, with the details off and on; then the dark scheme with the details on.
// Screenshots go to docs/shots/how/ (dark ones to docs/shots/dark/). Exits non-zero on any failure.
import { launchBrowser, pageErrorCheck } from "../checks/browser.mjs";
import { darkAudit } from "../checks/dark.mjs";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3333";
const SHOTS = new URL("../../docs/shots/how/", import.meta.url).pathname;
const DARK_SHOTS = new URL("../../docs/shots/dark/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
mkdirSync(DARK_SHOTS, { recursive: true });
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const quick = process.argv.includes("--quick");

const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone390: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};
const STEPS = ["link", "index", "pieces", "host", "unlock", "pixels", "compressed", "less", "share"];

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ""}`);
};
const browser = await launchBrowser();

// Requests meant to fail: everything under a link after it is revoked.
const expected404 = (url) => /\/(shl|cap)\//.test(url);

/** Records main-thread tasks over 100 ms (Long Tasks API). */
function longTaskWatch() {
  window.__long = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.duration > 100) window.__long.push(`${Math.round(e.duration)} ms during ${window.__how?.current?.() ?? "load"}`);
    }).observe({ type: "longtask", buffered: true });
  } catch {}
}

async function scrollToStep(page, id) {
  await page.evaluate((id) => {
    const el = document.getElementById(id);
    const wide = innerWidth >= 960;
    const pb = document.querySelector(".panel-wrap").getBoundingClientRect().bottom;
    const target = wide ? 110 : Math.min(pb, innerHeight * 0.6) + 8;
    window.scrollTo(0, el.getBoundingClientRect().top + scrollY - target);
  }, id);
  await page.waitForFunction((id) => window.__how?.current() === id, id, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  return page.evaluate(() => window.__how.current());
}

const visible = (page, sel) => page.locator(sel).first().isVisible();
const text = (page, sel) => page.locator(sel).first().textContent();
const tap = (page, sel, touch) => (touch ? page.locator(sel).first().tap() : page.locator(sel).first().click());

/** Mean brightness of a canvas (0..255); 0 when blank. */
const canvasLevel = (page, sel) =>
  page.evaluate((sel) => {
    const c = document.querySelector(sel);
    if (!c || !c.width) return 0;
    let d;
    try {
      d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    } catch {
      const t = document.createElement("canvas");
      t.width = c.width;
      t.height = c.height;
      t.getContext("2d").drawImage(c, 0, 0);
      d = t.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    }
    let s = 0, n = 0;
    for (let i = 0; i < d.length; i += 4 * 61) (s += d[i] + d[i + 1] + d[i + 2]), n++;
    return s / n / 3;
  }, sel);

async function layout(page, label, coarse) {
  const r = await page.evaluate((coarse) => {
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    const small = [];
    if (coarse) {
      for (const el of document.querySelectorAll("button, a.btn, select, input, .switch")) {
        if (el.closest(".hidden") || el.closest(".scene:not(.on)")) continue;
        const s = getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden") continue;
        let b = el.getBoundingClientRect();
        if (el.matches("input[type=checkbox]") && el.closest("label")) b = el.closest("label").getBoundingClientRect();
        if (!b.width || !b.height) continue;
        if (b.height < 43.5 || b.width < 43.5) small.push(`${el.tagName.toLowerCase()}#${el.id || el.className} ${Math.round(b.width)}×${Math.round(b.height)}`);
      }
    }
    return { overflow, small };
  }, coarse);
  check(`${label}: no horizontal overflow`, r.overflow <= 0, `scrollWidth − innerWidth = ${r.overflow}`);
  if (coarse) check(`${label}: targets ≥ 44 px`, r.small.length === 0, r.small.slice(0, 8).join(", "));
}

async function run(dev, details, dark) {
  const touch = dev !== "desktop";
  const tag = `${dark ? "dark " : ""}${dev} details ${details ? "on" : "off"}`;
  const L = (s) => `${tag}: ${s}`;
  const shot = async (name, full = false) => {
    const p = dark ? `${DARK_SHOTS}how-${dev}-${name}.png` : `${SHOTS}${dev}-${details ? "d" : "plain"}-${name}.png`;
    await page.screenshot({ path: p, fullPage: full });
  };
  const context = await browser.newContext({ ...DEVICES[dev], colorScheme: dark ? "dark" : "light" });
  await context.addInitScript(longTaskWatch);
  await context.addInitScript((d) => {
    try {
      localStorage.setItem("how-details", d ? "1" : "0");
    } catch {}
  }, details);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (/status of 404/.test(m.text()) && expected404(m.location()?.url ?? "")) return;
    errors.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !(r.status() === 404 && expected404(r.url()))) errors.push(`${r.status()} ${r.url().slice(0, 100)}`);
  });

  await page.goto(`${BASE}/how`);
  await page.waitForFunction(() => document.querySelector("#status")?.classList.contains("ok") && window.__how?.scenes.size === 9, null, { timeout: 30000 });
  check(L("sample opens"), true, await text(page, "#status"));
  check(L(`details switch ${details ? "on" : "off"} and remembered`), (await page.isChecked("#details")) === details && (await page.evaluate(() => document.body.classList.contains("details"))) === details);
  // The thread, recomputed here from the decrypted Bundle JSON (PROPOSAL.md §8.1): each series is
  // in its own linked-file, else its study's; offsets run per file through the series in order.
  const truth = await page.evaluate(() => {
    const { S } = window.__how;
    const study = S.share.index.bundle.entry.map((e) => e.resource).find((r) => r?.resourceType === "ImagingStudy" && (r.series ?? []).some((x) => x.uid === S.series.uid));
    const fileOf = (el) => el.extension?.find((x) => /linked-file$/.test(x.url))?.extension.find((x) => x.url === "id").valueString;
    const len = (i) => i.extension.find((x) => /instance-length$/.test(x.url)).valueDecimal;
    const se = study.series.find((x) => x.uid === S.series.uid);
    const file = fileOf(se) ?? fileOf(study);
    const inFile = study.series.filter((x) => (fileOf(x) ?? fileOf(study)) === file);
    const before = inFile.slice(0, inFile.indexOf(se)).flatMap((x) => x.instance).map(len).reduce((a, b) => a + b, 0);
    const lens = se.instance.map(len);
    const off = before + lens.slice(0, S.slice).reduce((a, b) => a + b, 0), len0 = lens[S.slice];
    const first = Math.floor(off / 65520), last = Math.floor((off + len0 - 1) / 65520);
    const total = inFile.flatMap((x) => x.instance).map(len).reduce((a, b) => a + b, 0), C = total + 16 * Math.ceil(total / 65520);
    return { off, len: len0, first, last, range: `bytes=${first * 65536}-${Math.min(C, (last + 1) * 65536) - 1}`, slice: S.slice, n: lens.length };
  });

  for (const id of STEPS) {
    const cur = await scrollToStep(page, id);
    check(L(`step ${id}: its scene is shown`), cur === id && (await page.locator(`.scene[data-scene="${id}"].on`).count()) === 1, `current ${cur}`);
    const dShown = await page.locator(`#${id} .d`).first().isVisible().catch(() => false);
    check(L(`step ${id}: details layer ${details ? "shown" : "hidden"}`), dShown === details);

    if (id === "link") {
      check(L("1 link: QR code and link card"), (await page.locator(".qr svg").count()) >= 1 && /Josh Example/.test(await text(page, ".linkcard")));
      if (details) check(L("1 link: decoded JSON with url and key"), /"key"/.test(await text(page, '.scene[data-scene="link"] .json')));
    }
    if (id === "index") {
      await page.waitForFunction(() => document.querySelector(".toc-tree .this:not(.hidden-item)"), null, { timeout: 8000 });
      const t = await text(page, ".toc-tree .this");
      check(L("2 index: unfolds to this slice"), t.includes(`Slice ${truth.slice + 1} of ${truth.n}`) && t.replace(/,/g, "").includes(String(truth.len)), t);
      if (details) {
        const d = (await text(page, "#d-index")).replace(/,/g, "");
        check(L("2 index: numbers match the Bundle"), d.includes(`starting at byte ${truth.off} `) && d.includes(`slice is ${truth.len} bytes`), d.slice(0, 160));
      }
    }
    if (id === "pieces") {
      await page.waitForFunction(() => document.querySelectorAll(".thumb canvas").length > 0, null, { timeout: 10000 });
      await page.waitForTimeout(800);
      const lvl = await canvasLevel(page, ".thumb.this canvas");
      const reqOk = await page.evaluate((range) => window.__how.S.requests.some((r) => r.range === range && r.status === 206), truth.range);
      check(L("3 pieces: the slice's Range request was made and the slice decoded"), reqOk && lvl > 5, `${truth.range}; brightness ${lvl.toFixed(1)}`);
      const lit = await page.locator(".piece.got").count();
      check(L("3 pieces: the slice's pieces light up"), lit === truth.last - truth.first + 1, `${lit} lit, expected ${truth.last - truth.first + 1}`);
      if (details) check(L("3 pieces: Range header shown matches"), (await text(page, ".range-line")).includes(truth.range) && (await text(page, "#d-pieces")).includes(truth.range));
      // Drag across the strip: a new request, images inside appear, cut ones say which piece they need.
      const before = await page.evaluate(() => window.__how.S.requests.length);
      const box = await page.locator(".strip").boundingBox();
      const cells = await page.locator(".piece").count();
      const x = (k) => box.x + ((k + 0.5) / cells) * box.width;
      await page.mouse.move(x(0), box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(x(cells - 1), box.y + box.height / 2, { steps: 6 });
      await page.mouse.up();
      await page.waitForFunction((n) => window.__how.S.requests.length > n, before, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1200);
      const cut = await page.locator(".thumb .cut").count(), imgs = await page.locator(".thumb canvas").count();
      const after = await page.evaluate(() => window.__how.S.requests.length);
      check(L("3 pieces: dragging a new choice fetches it and shows whole and cut images"), after > before && imgs >= 1 && cut >= 1, `${after - before} new request(s); ${imgs} images, ${cut} cut`);
      await shot("3-pieces");
    }
    if (id === "host") {
      const rows = await page.locator(".host-log .req").count();
      const n = await page.evaluate(() => Math.min(60, window.__how.S.requests.length));
      check(L("3b host: every request listed as the server receives it"), rows === n && /\.bin/.test(await text(page, ".host-log")), `${rows} rows, ${n} requests`);
      await shot("3b-host");
    }
    if (id === "unlock") {
      await page.waitForSelector(".verdict.good", { timeout: 15000 });
      check(L("4 unlock: every piece unlocked and checked"), (await canvasLevel(page, ".band-box canvas")) > 5, await text(page, ".scene.on .verdict"));
      await tap(page, "#unlock .switch", touch);
      await page.waitForSelector(".scene.on .verdict.bad", { timeout: 15000 });
      const bad = await text(page, ".scene.on .verdict");
      check(L("4 unlock: tamper switch makes a piece refused"), /refused/.test(bad) && /flipped/.test(bad), bad);
      await shot("4-tampered");
      await tap(page, "#unlock .switch", touch);
      await page.waitForSelector(".scene.on .verdict.good", { timeout: 15000 });
      check(L("4 unlock: switch off, all pieces pass again"), true);
    }
    if (id === "pixels") {
      await page.waitForFunction(() => /Example/.test(document.querySelector(".hdr")?.textContent ?? ""), null, { timeout: 15000 });
      const hd = await text(page, ".hdr");
      check(L("5 pixels: header shows the file marker, patient, size and pixel start"), /DICM/.test(hd) && /Example\^Josh/.test(hd) && /512 × 512/.test(hd) && /start at byte/.test(hd), hd.slice(0, 120));
      await page.waitForTimeout(500);
      const lvl0 = await canvasLevel(page, '.scene[data-scene="pixels"] .stage canvas');
      await page.locator("#wl-c").fill("95");
      await page.waitForTimeout(500);
      const lvl1 = await canvasLevel(page, '.scene[data-scene="pixels"] .stage canvas');
      check(L("5 pixels: the slice is drawn and brightness changes it"), lvl0 > 3 && Math.abs(lvl1 - lvl0) > 3, `${lvl0.toFixed(1)} → ${lvl1.toFixed(1)}`);
      if (details) check(L("5 pixels: transfer syntax and window in the details"), /1\.2\.840\.10008\.1\.2\.1/.test(await text(page, "#d-pixels")));
      await shot("5-pixels");
    }
    if (id === "compressed") {
      await page.waitForFunction(() => /In the file/.test(document.querySelector('.scene[data-scene="compressed"]')?.textContent ?? ""), null, { timeout: 15000 });
      await page.waitForTimeout(400);
      const size = (await page.request.get(`${BASE}/how/compressed.dcm`)).body().then((b) => b.length);
      const lvl = await canvasLevel(page, '.scene[data-scene="compressed"] .stage canvas');
      check(L("5b compressed: decoded and drawn"), lvl > 3, `brightness ${lvl.toFixed(1)}`);
      if (details) {
        const d = (await text(page, "#d-compressed")).replace(/,/g, "");
        check(L("5b compressed: file size shown matches the file"), d.includes(`${await size} bytes in the file`), d.slice(0, 120));
      }
      await shot("5b-compressed");
    }
    if (id === "less") {
      await page.waitForFunction(() => /of .* shared/.test(document.querySelector('.scene[data-scene="less"] .counter')?.textContent ?? ""), null, { timeout: 15000 });
      const c0 = await page.evaluate(() => window.__how.S.requests.reduce((a, r) => a + (r.status < 300 ? r.bytes : 0), 0));
      await page.locator('.scene[data-scene="less"] .scrub input').fill("2");
      await page.waitForFunction((c0) => window.__how.S.requests.reduce((a, r) => a + (r.status < 300 ? r.bytes : 0), 0) > c0, c0, { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(600);
      const c1 = await page.evaluate(() => window.__how.S.requests.reduce((a, r) => a + (r.status < 300 ? r.bytes : 0), 0));
      check(L("6 less: scrolling to another slice fetches only its pieces"), c1 > c0 && c1 - c0 < 2_000_000, `+${c1 - c0} bytes`);
      if (!quick) {
        await tap(page, "#less-slide", touch);
        await page.waitForFunction(() => /of the slide's/.test(document.querySelector('.scene[data-scene="less"] .counter')?.textContent ?? ""), null, { timeout: 30000 });
        await page.waitForTimeout(2500);
        const s0 = await text(page, '.scene[data-scene="less"] .counter');
        for (let k = 0; k < 3; k++) {
          await tap(page, '[aria-label="Zoom in"]', touch);
          await page.waitForTimeout(2000);
        }
        const s1 = await text(page, '.scene[data-scene="less"] .counter');
        check(L("6 less: zooming the slide fetches a little more of it"), s0 !== s1 && /of the slide's/.test(s1), `${s0} → ${s1}`);
        await shot("6-slide");
        await tap(page, "#less-mri", touch);
      }
    }
    if (id === "share" && !quick && !dark) {
      await tap(page, "#sh-make", touch);
      await page.waitForFunction(() => /A new link/.test(document.querySelector('.scene[data-scene="share"]')?.textContent ?? ""), null, { timeout: 20000 });
      check(L("7 share: a link to the MRI only is made"), true);
      await tap(page, "#sh-open", touch);
      await page.waitForFunction(() => /Opened|did not open/.test(document.querySelector('.scene[data-scene="share"] .big-status')?.textContent ?? ""), null, { timeout: 20000 });
      const o = await text(page, '.scene[data-scene="share"] .big-status');
      check(L("7 share: the new link opens with one study and the slice"), /lists 1 study/.test(o), o);
      await tap(page, "#sh-revoke", touch);
      await page.waitForFunction(() => /Revoked/.test(document.querySelector('.scene[data-scene="share"]')?.textContent ?? ""), null, { timeout: 15000 });
      await tap(page, "#sh-open", touch);
      await page.waitForFunction(() => /404|did not open/.test(document.querySelector('.scene[data-scene="share"] .big-status')?.textContent ?? ""), null, { timeout: 20000 });
      const r = await text(page, '.scene[data-scene="share"] .big-status');
      check(L("7 share: after revoking, the next request gets 404"), /404/.test(r), r);
      if (details) {
        await page.waitForFunction(() => document.querySelectorAll("#d-share-log .req").length >= 2, null, { timeout: 10000 }).catch(() => {});
        check(L("7 share: the server's own access log is shown"), (await page.locator("#d-share-log .req").count()) >= 2);
      }
      await shot("7-share");
    }
    if (dark) await darkAudit(page, L(`step ${id}`), check, `how-${dev}-${id}`);
    else if (!["pieces", "host", "pixels", "compressed", "share"].includes(id) || id === "link") await shot(`${STEPS.indexOf(id) + 1}-${id}`);
  }

  // The ending.
  await page.locator("#end").scrollIntoViewIfNeeded();
  const href = await page.getAttribute("#open-viewer", "href");
  check(L("end: “Open the sample” opens the viewer on the sample link"), /\/view#shlink:\//.test(href ?? ""), href?.slice(0, 50));
  check(L(`end: build-your-own section ${details ? "shown" : "hidden"}`), (await visible(page, ".end-details")) === details);
  if (details && !dark && !quick) {
    await tap(page, "#rx-run", touch);
    await page.waitForFunction(() => /returned|threw/.test(document.querySelector("#rx-out")?.textContent ?? ""), null, { timeout: 20000 });
    const rx = await text(page, "#rx-out");
    check(L("end: the reference receiver runs in a worker on the sample"), /"matchesBundle": true/.test(rx), rx.replace(/\s+/g, " ").slice(0, 160));
    await tap(page, "#tv-run", touch);
    await page.waitForFunction(() => /Tampering/.test(document.querySelector("#tv-out")?.textContent ?? ""), null, { timeout: 20000 });
    const tv = await text(page, "#tv-out");
    check(L("end: test vector matches appendix B"), !tv.includes("✗") && (tv.match(/✓/g) ?? []).length >= 7, `${(tv.match(/✓/g) ?? []).length} ✓`);
    await tap(page, "#bx-run", touch);
    await page.waitForSelector('#bx-progress [role="progressbar"]', { timeout: 5000 });
    await page.waitForFunction(() => document.querySelectorAll("#bx-out tbody tr").length || /error|failed/i.test(document.querySelector("#bx-out")?.textContent ?? ""), null, { timeout: 120000 });
    const bx = await text(page, "#bx-out");
    const pb = await page.evaluate(() => {
      const b = document.querySelector('#bx-progress [role="progressbar"]');
      return [b.getAttribute("aria-valuenow"), b.getAttribute("aria-valuemax")];
    });
    check(L("end: decoder comparison finishes with real progress, same pixels"), (await page.locator("#bx-out tbody tr").count()) === 3 && !/\bno\b/.test(bx) && pb[0] === pb[1], `${pb.join("/")}: ${bx.replace(/\s+/g, " ").slice(0, 200)}`);
    await shot("end-details");
  }

  const long = await page.evaluate(() => window.__long);
  check(L("no main-thread task over 100 ms"), long.length === 0, long.join(", "));
  if (!dark) await layout(page, L("layout"), touch);
  if (!dark && details) await shot("full", true);
  check(L("no console errors"), errors.length === 0, errors.slice(0, 4).join(" | "));
  await context.close();
}

const runs = [];
for (const dev of Object.keys(DEVICES)) for (const details of [false, true]) runs.push([dev, details, false]);
for (const dev of Object.keys(DEVICES)) runs.push([dev, true, true]);
for (const [dev, details, dark] of runs) {
  if (only && only !== dev && !(only === "dark" && dark)) continue;
  try {
    await run(dev, details, dark);
  } catch (e) {
    check(`${dark ? "dark " : ""}${dev} details ${details ? "on" : "off"}: run completed`, false, e.message.split("\n")[0]);
  }
}
// Reduced motion: the tour still runs, with cuts instead of transitions.
{
  const ctx = await browser.newContext({ ...DEVICES.desktop, reducedMotion: "reduce" });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/how`);
  await p.waitForFunction(() => document.querySelector("#status")?.classList.contains("ok"), null, { timeout: 30000 });
  const t = await p.evaluate(() => getComputedStyle(document.querySelector(".scene")).transitionDuration);
  check("reduced motion: scenes cut without transitions", /^0s/.test(t), t);
  await ctx.close();
}
pageErrorCheck(browser, check);
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
