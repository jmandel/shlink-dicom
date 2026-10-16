// Scripted headless-Chromium checks for /how, the plain one-column page. Needs a server on BASE
// (default http://localhost:3360) serving a fresh `bun web/build.ts`.
//   BASE=http://localhost:3360 node web/how/checks.mjs [--only=360|390|1440] [--light]
// For each width (360, 390, 1440) and scheme (light, dark): every step renders with numbers from the
// live sample, with every "How exactly" closed and then open; opening only adds; no horizontal
// scroll; no main-thread task over 100 ms. In the light runs also: Copy and Open, the tamper switch,
// share then revoke (404), and the receiver, test vector and decoder comparison in the worker.
// Screenshots: docs/shots/how/ (dark ones in docs/shots/dark/). Exits non-zero on any failure.
import { launchBrowser, pageErrorCheck } from "../checks/browser.mjs";
import { darkAudit } from "../checks/dark.mjs";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3360";
/** Prefix for screenshot names, to keep runs against differently packed samples apart (e.g. "sv1-"). */
const SHOT_TAG = process.env.SHOT_TAG ?? "";
const SHOTS = new URL("../../docs/shots/how/", import.meta.url).pathname;
const DARK_SHOTS = new URL("../../docs/shots/dark/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
mkdirSync(DARK_SHOTS, { recursive: true });
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const lightOnly = process.argv.includes("--light");

const WIDTHS = {
  360: { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  390: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  1440: { viewport: { width: 1440, height: 900 } },
};
const STEPS = ["link", "jwe", "bundle", "study", "file", "host", "gcm", "dicom", "less", "share", "end"];
/** What each step shows without its expander: these must stay present and visible when it opens. */
const PLAIN = {
  link: [".qr svg", "#link-copy", "#link-open", "#link .pic pre.code"],
  jwe: ["#jwe .pic pre.code", "#jwe .pic .facts"],
  bundle: ["#bundle .pic pre.code"],
  study: ["#study .pic pre.code", "#study .pic p.cap"],
  file: ["#file .strip", "#file .thumb.this canvas", "#file .pic pre.code"],
  host: ["#host .host-log .req"],
  gcm: ["#gcm .rec-tiles", "#gcm .slice-img canvas", "#gcm .verdict", "#gcm .switch"],
  dicom: ["#dicom .pic pre.code", "#dicom-encoding", "#dicom .stage canvas", "#wl-c", "#wl-w"],
  less: ["#less .counter", "#less .stage canvas", "#less-slider"],
  share: ["#share .study-list", "#sh-make"],
  end: ["#open-viewer"],
};

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ""}`);
};
const browser = await launchBrowser();
const expected404 = (url) => /\/(shl|cap)\//.test(url);

function longTaskWatch() {
  window.__long = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.duration > 100) window.__long.push(Math.round(e.duration));
    }).observe({ type: "longtask", buffered: true });
  } catch {}
}

const text = async (page, sel) => (await page.locator(sel).first().textContent()) ?? "";
const plainNum = (s) => s.replace(/,/g, "");

/** Size and visibility of each plain element of a step. */
const measure = (page, sels) =>
  page.evaluate((sels) => {
    const out = {};
    for (const s of sels) {
      const els = [...document.querySelectorAll(s)];
      out[s] = els.map((el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return { w: Math.round(r.width), h: Math.round(r.height), vis: r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none" && !el.closest(".hidden") };
      });
    }
    return out;
  }, sels);

async function run(width, dark) {
  const touch = width !== "1440";
  const tag = `${width}px ${dark ? "dark" : "light"}`;
  const L = (s) => `${tag}: ${s}`;
  const shot = async (name, full = false) => {
    const path = dark ? `${DARK_SHOTS}how-${SHOT_TAG}${width}-${name}.png` : `${SHOTS}${SHOT_TAG}${width}-${name}.png`;
    await page.screenshot({ path, fullPage: full });
  };
  const context = await browser.newContext({ ...WIDTHS[width], colorScheme: dark ? "dark" : "light" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE }).catch(() => {});
  await context.addInitScript(longTaskWatch);
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
  await page.waitForFunction(() => document.querySelector("#status")?.classList.contains("ok") && window.__how, null, { timeout: 30000 });
  check(L("sample opens"), true, await text(page, "#status"));

  // Load every step by scrolling to it once, as a reader would.
  for (const id of STEPS) {
    await page.locator(`#${id}`).scrollIntoViewIfNeeded();
    await page.waitForFunction((id) => document.getElementById(id)?.dataset.ready, id, { timeout: 30000 }).catch(() => {});
  }
  const ready = await page.evaluate(() => [...document.querySelectorAll("section.step")].map((s) => `${s.id}:${s.dataset.ready ?? "-"}`));
  check(L("every step renders"), ready.every((r) => r.endsWith(":1")), ready.join(" "));
  // Pictures that finish after mounting.
  await page.waitForSelector("#gcm .verdict.good", { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector("#file .thumb.this canvas") && /fetched of/.test(document.querySelector("#less .counter")?.textContent ?? ""), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);

  // The numbers, recomputed here from the decrypted Bundle (PROPOSAL.md §8.1).
  const truth = await page.evaluate(() => {
    const { S } = window.__how;
    const bundle = S.share.index.bundle;
    const study = bundle.entry.map((e) => e.resource).find((r) => r?.resourceType === "ImagingStudy" && (r.series ?? []).some((x) => x.uid === S.series.uid));
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
    return { off, len: len0, first, last, range: `bytes=${first * 65536}-${Math.min(C, (last + 1) * 65536) - 1}`, entries: bundle.entry.length, jwe: S.jwe.length, json: S.share.bundleBytes.length, url: S.share.resolver.payload.url, ranges: S.requests.filter((r) => r.status === 206).map((r) => r.range) };
  });
  const jweBytes = (await (await page.request.get(truth.url)).body()).length;
  check(L("2 JWE: sizes shown match the file and its decryption"), plainNum(await text(page, "#jwe .facts")).includes(`(${jweBytes} bytes)`) && plainNum(await text(page, "#jwe .facts")).includes(`(${truth.json} bytes)`), `${jweBytes} / ${truth.json}`);
  check(L("3 Bundle: every entry listed"), (await text(page, "#bundle .pic .cap")).includes(`(${truth.entries} entries)`) && /DiagnosticReport/.test(await text(page, "#bundle .pic")));
  const st = plainNum(await text(page, "#study .pic"));
  check(L("4 ImagingStudy: slice offset and length match the Bundle; the key is left out"), st.includes(`${truth.len} bytes starting at byte ${truth.off} `) && /linked-file/.test(st) && /left out here/.test(st), `${truth.len} @ ${truth.off}`);
  const fx = plainNum(await text(page, "#file .pic pre.code"));
  check(L("5 file: record range and Range header match, and that request was made"), fx.includes(`= ${truth.first}`) && fx.includes(`= ${truth.last}`) && fx.includes(`Range: ${truth.range}`) && truth.ranges.includes(truth.range), truth.range);
  check(L("5 file: the slice's records light up and the slice is decoded"), (await page.locator("#file .rec.got").count()) === truth.last - truth.first + 1 && (await page.locator("#file .thumb.this canvas").count()) === 1);
  const rows = await page.locator("#host .host-log .req").count();
  check(L("6 server: its requests listed"), rows >= 3 && /\.bin/.test(await text(page, "#host .host-log")), `${rows} lines`);
  await page.waitForFunction(() => {
    const c = document.querySelector("#gcm .slice-img canvas");
    const d = c?.getContext("2d")?.getImageData(0, 0, c.width, c.height).data;
    if (!d) return false;
    for (let i = 0; i < d.length; i += 4 * 97) if (d[i] > 20) return true;
    return false;
  }, null, { timeout: 15000 }).catch(() => {});
  const lit = await page.evaluate(() => {
    const c = document.querySelector("#gcm .slice-img canvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4 * 97) s += d[i];
    return s / (d.length / (4 * 97));
  });
  check(L("7 tag: every record passes and the slice is decoded from them"), /passed their tag check/.test(await text(page, "#gcm .verdict")) && (await page.locator("#gcm .rec-tile.ok").count()) === truth.last - truth.first + 1 && lit > 5, `brightness ${lit.toFixed(1)}`);
  const dh = await text(page, "#dicom .pic pre.code");
  const ts = /Transfer Syntax UID\s+(\S+):/.exec(dh)?.[1] ?? "";
  const native = ["1.2.840.10008.1.2", "1.2.840.10008.1.2.1", "1.2.840.10008.1.2.2"].includes(ts);
  check(L(`8 DICOM: header tags, implementation and the pixels (${ts})`), /Example\^Josh/.test(dh) && /Pixel Data/.test(dh) && /512/.test(dh) && /Implementation Version Name/.test(dh) && (await page.locator("#dicom .stage canvas").count()) === 1);
  const enc = await text(page, "#dicom-encoding");
  if (native) check(L("8 DICOM: native Pixel Data described as uncompressed"), /uncompressed/.test(enc) && !/Basic Offset Table/.test(dh), enc);
  else {
    check(L("8 DICOM: encapsulated Pixel Data shown with its Basic Offset Table and first fragment"), /Basic Offset Table/.test(dh) && /the compressed image|fragment 1/.test(dh) && /end of the items/.test(dh), ts);
    if (/\.4\.(57|70)$/.test(ts)) check(L("8 DICOM: JPEG markers labelled (SOI, SOF3, SOS)"), /SOI/.test(dh) && /SOF3\s+lossless frame: \d+-bit, 512 rows, 512 columns/.test(dh) && /SOS/.test(dh));
    if (/\.4\.(90|91|201|202|203)$/.test(ts)) check(L("8 DICOM: JPEG 2000 markers labelled (SOC, SIZ, COD, SOT, SOD)"), /SOC/.test(dh) && /SIZ\s+image and tile size: 512 × 512, 1 component, (signed )?\d+-bit/.test(dh) && /COD\s+coding style: \d+ wavelet levels/.test(dh) && /SOT/.test(dh) && /SOD/.test(dh), dh.split("\n").filter((l) => /SIZ|COD/.test(l)).join(" | "));
    check(L("8 DICOM: says the compression is without loss, and names the writer"), /without loss/.test(enc) && /names the program that wrote this file/.test(enc), enc);
  }
  check(L("9 on demand: counter against the study's file"), /fetched of the .* encrypted file/.test(await text(page, "#less .counter")));

  // Opening every expander only adds.
  const sels = Object.values(PLAIN).flat();
  const before = await measure(page, sels);
  const missing = Object.entries(before).filter(([, v]) => !v.length || v.some((x) => !x.vis)).map(([s]) => s);
  check(L("closed: every plain element present and visible"), missing.length === 0, missing.join(", "));
  await shot("closed", true);
  const closedOverflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  for (const d of await page.$$("details.exact")) await d.evaluate((e) => (e.open = true));
  await page.waitForTimeout(500);
  const after = await measure(page, sels);
  const changed = sels.filter((s) => {
    const a = before[s], b = after[s];
    return a.length !== b.length || b.some((x, i) => !x.vis || Math.abs(x.h - a[i].h) > 2 || Math.abs(x.w - a[i].w) > 2);
  });
  check(L("opening every “How exactly” only adds: plain elements unchanged"), changed.length === 0, changed.join(", "));
  const added = await page.evaluate(() => [...document.querySelectorAll(".exact-body")].every((b) => b.getBoundingClientRect().height > 20));
  check(L("open: every expander shows its details"), added);
  await shot("open", true);
  const openOverflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(L("no horizontal scroll, closed and open"), closedOverflow <= 0 && openOverflow <= 0, `${closedOverflow} / ${openOverflow}`);
  if (touch) {
    const small = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll("button, a.btn, input, select, summary, .switch")) {
        if (el.closest(".hidden")) continue;
        let r = el.getBoundingClientRect();
        if (el.matches("input[type=checkbox]") && el.closest("label")) r = el.closest("label").getBoundingClientRect();
        if (el.matches(".link-field")) continue;
        if (!r.width || !r.height) continue;
        if (r.height < 43.5 || r.width < 43.5) out.push(`${el.tagName.toLowerCase()}#${el.id || el.className} ${Math.round(r.width)}×${Math.round(r.height)}`);
      }
      return out;
    });
    check(L("targets ≥ 44 px"), small.length === 0, small.slice(0, 6).join(", "));
  }
  for (const d of await page.$$("details.exact")) await d.evaluate((e) => (e.open = false));

  if (dark) {
    for (const id of STEPS) {
      await page.locator(`#${id}`).scrollIntoViewIfNeeded();
      await darkAudit(page, L(`step ${id}`), check, `how-${SHOT_TAG}${width}-${id}`);
    }
  } else {
    // Copy and Open.
    await page.locator("#link-copy").scrollIntoViewIfNeeded();
    await page.locator("#link-copy").click();
    await page.waitForTimeout(300);
    const href = await page.getAttribute("#link-open", "href");
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
    check(L("1 Copy link copies the viewer link and says so"), (await text(page, "#link-copy")) === "Copied" && clip === href, clip.slice(0, 50));
    const [viewer] = await Promise.all([context.waitForEvent("page"), page.locator("#link-open").click()]);
    await viewer.waitForLoadState();
    check(L("1 Open link opens the sample in the viewer, in a new tab"), /\/view#shlink:\//.test(viewer.url()) && (await page.getAttribute("#link-open", "target")) === "_blank", viewer.url().slice(0, 60));
    await viewer.close();

    // Drag across the records: a new request, whole and cut images.
    await page.locator("#file .strip").scrollIntoViewIfNeeded();
    const n0 = await page.evaluate(() => window.__how.S.requests.length);
    const box = await page.locator("#file .strip").boundingBox();
    const cells = await page.locator("#file .rec").count();
    const x = (k) => box.x + ((k + 0.5) / cells) * box.width;
    await page.mouse.move(x(0), box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(x(cells - 1), box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForFunction((n) => window.__how.S.requests.length > n, n0, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1200);
    check(L("5 dragging across records fetches them; whole images appear, cut ones say which record they need"), (await page.evaluate(() => window.__how.S.requests.length)) > n0 && (await page.locator("#file .thumb canvas").count()) >= 1 && (await page.locator("#file .thumb .cut").count()) >= 1);

    // Tamper.
    await page.locator("#gcm .switch").scrollIntoViewIfNeeded();
    await page.locator("#gcm .switch").click();
    await page.waitForSelector("#gcm .verdict.bad", { timeout: 15000 });
    const bad = await text(page, "#gcm .verdict");
    check(L("7 the tamper switch makes a record fail its tag check, and the slice is not shown"), /failed its tag check/.test(bad) && /flipped/.test(bad) && (await page.locator("#gcm .rec-tile.bad").count()) === 1 && (await page.locator("#gcm .refused:not(.hidden)").count()) === 1, bad);
    await page.locator("#gcm").screenshot({ path: `${SHOTS}${SHOT_TAG}${width}-step7-tampered.png` });
    await page.locator("#gcm .switch").click();
    await page.waitForSelector("#gcm .verdict.good", { timeout: 15000 });
    await page.waitForTimeout(800);
    await page.locator("#gcm").screenshot({ path: `${SHOTS}${SHOT_TAG}${width}-step7.png` });
    await page.locator("#dicom").scrollIntoViewIfNeeded();
    await page.locator("#dicom details.exact").evaluate((e) => (e.open = true));
    await page.waitForTimeout(400);
    await page.locator("#dicom").screenshot({ path: `${SHOTS}${SHOT_TAG}${width}-step8.png` });
    await page.locator("#dicom details.exact").evaluate((e) => (e.open = false));

    // Brightness, and scrolling the series.
    await page.locator("#wl-c").fill("95");
    check(L("8 brightness changes the window"), /Window centre/.test(await text(page, "#dicom .pic")));
    const c0 = await text(page, "#less .counter");
    await page.locator("#less-slider").fill("2");
    await page.waitForFunction((c0) => document.querySelector("#less .counter").textContent !== c0, c0, { timeout: 10000 }).catch(() => {});
    check(L("9 moving to another slice fetches only its records"), (await text(page, "#less .counter")) !== c0, `${c0} → ${await text(page, "#less .counter")}`);

    // Share, open, revoke, open again.
    await page.locator("#sh-make").scrollIntoViewIfNeeded();
    await page.locator("#sh-make").click();
    await page.waitForFunction(() => /A new link/.test(document.querySelector("#share .share-result")?.textContent ?? ""), null, { timeout: 20000 });
    check(L("10 a new link to the MRI only, with its QR code, Copy and Open"), (await page.locator("#share .qr svg").count()) === 1 && (await page.locator("#newlink-copy").count()) === 1 && /\/view#shlink:\//.test((await page.getAttribute("#newlink-open", "href")) ?? ""));
    await page.locator("#sh-open").click();
    await page.waitForFunction(() => /Opened|did not open/.test(document.querySelector("#share .status-line")?.textContent ?? ""), null, { timeout: 20000 });
    check(L("10 the new link opens with one ImagingStudy"), /lists 1 ImagingStudy/.test(await text(page, "#share .status-line")), await text(page, "#share .status-line"));
    await page.locator("#sh-revoke").click();
    await page.waitForFunction(() => /Revoked/.test(document.querySelector("#share .share-result")?.textContent ?? ""), null, { timeout: 15000 });
    await page.locator("#sh-open").click();
    await page.waitForFunction(() => /404|did not open/.test(document.querySelector("#share .status-line")?.textContent ?? ""), null, { timeout: 20000 });
    check(L("10 after revoking, the server answers 404"), /404/.test(await text(page, "#share .status-line")), await text(page, "#share .status-line"));
    await page.locator("#share details.exact").evaluate((e) => (e.open = true));
    await page.waitForFunction(() => document.querySelectorAll("#share .exact-body .req").length >= 2, null, { timeout: 10000 }).catch(() => {});
    check(L("10 the server's access log for the copy is shown"), (await page.locator("#share .exact-body .req").count()) >= 2);
    await page.locator("#share").screenshot({ path: `${SHOTS}${SHOT_TAG}${width}-revoked.png` });

    // Build your own: receiver, test vector, decoder comparison, all in the worker.
    if (width !== "360") {
      await page.locator("#end details.exact").evaluate((e) => (e.open = true));
      await page.locator("#rx-run").scrollIntoViewIfNeeded();
      await page.locator("#rx-run").click();
      await page.waitForFunction(() => /returned|threw/.test(document.querySelector("#rx-out")?.textContent ?? ""), null, { timeout: 20000 });
      check(L("end: the reference receiver runs in a worker on the sample"), /"matchesBundle": true/.test(await text(page, "#rx-out")));
      await page.locator("#tv-run").click();
      await page.waitForFunction(() => /Tampering/.test(document.querySelector("#tv-out")?.textContent ?? ""), null, { timeout: 20000 });
      const tv = await text(page, "#tv-out");
      check(L("end: test vector matches appendix B"), !tv.includes("✗") && (tv.match(/✓/g) ?? []).length >= 7);
      await page.locator("#bx-run").click();
      await page.waitForFunction(() => document.querySelectorAll("#bx-out tbody tr").length || /error|fail/i.test(document.querySelector("#bx-out")?.textContent ?? ""), null, { timeout: 120000 });
      const pb = await page.evaluate(() => {
        const b = document.querySelector('#bx-progress [role="progressbar"]');
        return [b?.getAttribute("aria-valuenow"), b?.getAttribute("aria-valuemax")];
      });
      check(L("end: decoder comparison finishes with real progress and the same pixels"), (await page.locator("#bx-out tbody tr").count()) === 3 && !/\bno\b/.test(await text(page, "#bx-out tbody")) && pb[0] === pb[1], pb.join("/"));
    }
  }

  const long = await page.evaluate(() => window.__long);
  check(L("no main-thread task over 100 ms"), long.length === 0, long.join(", "));
  check(L("no console errors"), errors.length === 0, errors.slice(0, 4).join(" | "));
  await context.close();
}

for (const width of Object.keys(WIDTHS)) {
  if (only && only !== width) continue;
  for (const dark of lightOnly ? [false] : [false, true]) {
    try {
      await run(width, dark);
    } catch (e) {
      check(`${width}px ${dark ? "dark" : "light"}: run completed`, false, e.message.split("\n")[0]);
    }
  }
}
pageErrorCheck(browser, check);
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
