// Scripted headless-Chromium checks for /how. Needs the server on BASE (default localhost:3333)
// serving a fresh `bun web/build.ts`.
//   node web/how/checks.mjs [--only=desktop|phone390]
// Screenshots go to docs/shots/how/. Exits non-zero if any check fails.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3333";
const SHOTS = new URL("../../docs/shots/how/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);

const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone390: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium" });

/** Requests that are meant to fail: the sandbox's left-out series and everything after revocation. */
const expected404 = (url) => /\/(shl|cap)\//.test(url);

async function newPage(context) {
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const url = m.location()?.url ?? "";
    if (/Failed to load resource: the server responded with a status of 404/.test(m.text()) && expected404(url)) return;
    errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400 && !(r.status() === 404 && expected404(r.url()))) errors.push(`${r.status()} ${r.url().slice(0, 100)}`);
  });
  return { page, errors };
}

async function layout(page, label, coarse) {
  const r = await page.evaluate((coarse) => {
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    const small = [];
    if (coarse) {
      const sel = "button, a.btn, select, input, summary, .toc a, [role=option], .linkish";
      for (const el of document.querySelectorAll(sel)) {
        if (el.closest(".hidden") || el.closest("[hidden]")) continue;
        const s = getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden") continue;
        let b = el.getBoundingClientRect();
        // A checkbox or switch counts by its label, which is the touch target.
        if (el.matches("input[type=checkbox], input[type=radio]") && el.closest("label")) b = el.closest("label").getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;
        if (b.height < 43.5 || b.width < 43.5) small.push(`${el.tagName.toLowerCase()}#${el.id || el.className || el.textContent.trim().slice(0, 20)} ${Math.round(b.width)}×${Math.round(b.height)}`);
      }
    }
    return { overflow, small, coarse: matchMedia("(pointer: coarse)").matches };
  }, coarse);
  check(`${label}: no horizontal overflow`, r.overflow <= 0, `scrollWidth − innerWidth = ${r.overflow}`);
  if (coarse) check(`${label}: targets ≥ 44 px (coarse=${r.coarse})`, r.small.length === 0, r.small.slice(0, 12).join(", "));
}

async function shot(page, sel, name) {
  await page.locator(sel).scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.locator(sel).screenshot({ path: `${SHOTS}${name}.png` });
}

const tap = (page, sel, touch) => (touch ? page.locator(sel).first().tap() : page.locator(sel).first().click());

async function run(dev) {
  const touch = dev !== "desktop";
  const context = await browser.newContext({ ...DEVICES[dev] });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  const { page, errors } = await newPage(context);
  const L = (s) => `${dev}: ${s}`;

  await page.goto(`${BASE}/how`);
  await page.waitForFunction(() => document.querySelector("#status")?.classList.contains("ok"), null, { timeout: 20000 });
  check(L("sample opens"), true, await page.textContent("#status"));
  await page.screenshot({ path: `${SHOTS}${dev}-top.png` });

  // 1. The link
  await tap(page, '#link-json .field-btn[data-k="flag"]', touch);
  const note = await page.textContent("#link-note");
  check(L("1 link: tapping a field shows its note"), /flag/.test(note) && /U:/.test(note), note.slice(0, 80));
  await page.locator("#link .paste summary").click();
  await page.fill("#link-input", "not a link");
  await page.click("#link-decode");
  check(L("1 link: a bad paste is explained"), /doesn't contain/.test(await page.textContent("#link-input-msg")));
  await page.locator("#link .paste summary").click();
  await tap(page, '#link-json .field-btn[data-k="key"]', touch);
  await shot(page, "#link", `${dev}-1-link`);

  // 2. The Bundle
  const hl = await page.locator("#bundle-tree .j-hl").count();
  check(L("2 bundle: ImagingStudy.series highlighted"), hl >= 1, `${hl} highlighted`);
  const btn = page.locator("#bundle-tree .j-inst").nth(3);
  const off = (await btn.textContent()).replace(/\D/g, "");
  await (touch ? btn.tap() : btn.click());
  const pick = await page.textContent("#bundle-pick");
  check(L("2 bundle: an instance shows its byte offset"), pick.replace(/,/g, "").includes(`bytes ${off} to`), pick.slice(0, 120));
  await shot(page, "#bundle", `${dev}-2-bundle`);
  await page.locator("#bundle-pick .linkish").click();
  await page.waitForTimeout(400);
  check(L("2 bundle: “Show it in the series file” selects that image"), (await page.inputValue("#sf-slider")) === "3");

  // 3. The series file: slider → range → real request → verified
  const before = await page.locator("#sf-net .req").count();
  if (touch) {
    await page.locator("#sf-next").tap();
    await page.locator("#sf-next").tap();
  } else {
    await page.locator("#sf-slider").focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
  }
  check(L("3 series: slider/± moves to image 6"), (await page.inputValue("#sf-slider")) === "5");
  await page.waitForFunction(() => /verified/.test(document.querySelector("#sf-facts")?.textContent ?? ""), null, { timeout: 10000 });
  const facts = await page.textContent("#sf-facts");
  const range = /Range: (bytes=\d+-\d+)/.exec(facts)?.[1];
  const net = await page.locator("#sf-net .req").first().textContent();
  check(L("3 series: the Range request fired and is listed"), !!range && net.includes(range) && net.includes("206") && (await page.locator("#sf-net .req").count()) > before, `${range} · ${net.slice(0, 90)}`);
  check(L("3 series: decrypted image matches the Bundle"), /SOP Instance UID matches/.test(facts));
  const selCells = await page.locator("#sf-map .rec.sel").count();
  const okCells = await page.locator("#sf-map .rec.ok").count();
  check(L("3 series: record map marks the image's records and verified ones"), selCells >= 1 && okCells >= selCells, `${selCells} selected, ${okCells} verified`);
  // Tap a record cell: picks the first image starting there.
  await tap(page, "#sf-map .rec:nth-child(40)", touch);
  await page.waitForTimeout(300);
  check(L("3 series: tapping the record map picks an image"), (await page.inputValue("#sf-slider")) !== "5", `now ${await page.inputValue("#sf-slider")}`);
  await page.waitForFunction(() => /verified/.test(document.querySelector("#sf-facts")?.textContent ?? ""), null, { timeout: 10000 });
  await shot(page, "#series-file", `${dev}-3-series-file`);

  // 4. Decrypt and verify, then tamper
  await page.locator("#verify").scrollIntoViewIfNeeded();
  await tap(page, "#vf-run", touch);
  await page.waitForSelector("#vf-result .verdict.good", { timeout: 10000 });
  check(L("4 verify: record verified"), true, (await page.textContent("#vf-result .verdict")).slice(0, 80));
  await tap(page, "#verify .switch", touch);
  check(L("4 verify: tamper switch on"), await page.isChecked("#vf-tamper"));
  await tap(page, "#vf-run", touch);
  await page.waitForSelector("#vf-result .verdict.bad", { timeout: 10000 });
  const bad = await page.textContent("#vf-result .verdict.bad");
  check(L("4 verify: tampered record refused"), /Refused/.test(bad) && /flipped/.test(bad), bad.slice(0, 140));
  await shot(page, "#verify", `${dev}-4-verify-tampered`);
  await tap(page, "#verify .switch", touch);

  // 5. What the host sees
  await page.locator("#host").scrollIntoViewIfNeeded();
  const rows = await page.locator("#host-log .req").count();
  check(L("5 host: host pane lists requests"), rows >= 4, `${rows} rows`);
  // Select the series-file request from step 3 (newest 206 of a .bin with several records).
  const target = page.locator("#host-log .req", { hasText: ".bin" }).filter({ hasText: "206" }).nth(2);
  await (touch ? target.tap() : target.click());
  await page.waitForFunction(() => {
    const c = document.querySelector("#host-carried canvas");
    if (!c) return /part of one image/.test(document.querySelector("#host-carried")?.textContent ?? "");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4 * 97) if (d[i] > 20) return true;
    return false;
  }, null, { timeout: 15000 });
  check(L("5 host: browser pane shows what the request carried"), true, (await page.textContent("#host-carried .cap")).slice(0, 100));
  await shot(page, "#host", `${dev}-5-host`);

  // 6. Sharing and revocation (mints our own links; never touches the seeded passcode demo)
  await page.locator("#revoke").scrollIntoViewIfNeeded();
  await tap(page, "#sb-clone", touch);
  await page.waitForFunction(() => /Done in/.test(document.querySelector("#sb-clone-msg")?.textContent ?? ""), null, { timeout: 30000 });
  check(L("6 sandbox: copy made"), true, (await page.textContent("#sb-clone-msg")).slice(0, 100));
  const passcode = touch ? "4321" : "";
  if (passcode) await page.fill("#sb-pass", passcode);
  await tap(page, "#sb-mint", touch);
  await page.waitForSelector("#sb-link:not(.hidden)", { timeout: 15000 });
  const href = await page.getAttribute("#sb-open", "href");
  check(L(`6 sandbox: ${passcode ? "passcode" : "direct"} subset link made`), /\/view#shlink:\//.test(href), href.slice(0, 60));

  const [viewer] = await Promise.all([context.waitForEvent("page"), tap(page, "#sb-open", touch)]);
  const vErr = [];
  viewer.on("pageerror", (e) => vErr.push(e.message));
  if (passcode) {
    await viewer.waitForSelector("#screen-passcode:not(.hidden)", { timeout: 20000 });
    await viewer.fill("#input-passcode", passcode);
    await viewer.click("#btn-passcode");
  }
  await viewer.waitForSelector("#screen-overview:not(.hidden)", { timeout: 20000 });
  const studies = await viewer.locator(".study-open").count();
  check(L("6 sandbox: subset link opens in a new tab with one study"), studies === 1, `${studies} studies; ${await viewer.textContent("#ov-studies")}`.slice(0, 120));
  await viewer.screenshot({ path: `${SHOTS}${dev}-6-subset-opened.png` });

  await tap(page, "#sb-probe", touch);
  await page.waitForFunction(() => /Left-out/.test(document.querySelector("#sb-probe-msg")?.textContent ?? ""), null, { timeout: 15000 });
  const probe = await page.textContent("#sb-probe-msg");
  check(L("6 sandbox: included series 206, left-out series 404"), /: 206\./.test(probe) && /: 404,/.test(probe), probe);

  await tap(page, "#sb-revoke", touch);
  await page.waitForFunction(() => /Revoked/.test(document.querySelector("#sb-revoke-msg")?.textContent ?? ""), null, { timeout: 15000 });
  const rev = await page.textContent("#sb-revoke-msg");
  check(L("6 sandbox: after revocation the link and its files answer 404"), /The link: 404/.test(rev) && /used before: 404/.test(rev), rev);
  await page.waitForFunction(() => [...document.querySelectorAll("#sb-log .req")].some((r) => /bundle\.jwe|manifest|\/shl\/[^/]+$/.test(r.textContent) || /POST/.test(r.textContent)) && document.querySelectorAll("#sb-log .req").length >= 3, null, { timeout: 10000 });
  check(L("6 sandbox: server access log shown"), true, `${await page.locator("#sb-log .req").count()} log rows`);
  await shot(page, "#revoke", `${dev}-6-revoked`);

  await viewer.reload();
  if (passcode) {
    await viewer.waitForSelector("#screen-passcode:not(.hidden)", { timeout: 20000 });
    await viewer.fill("#input-passcode", passcode);
    await viewer.click("#btn-passcode");
  }
  await viewer.waitForSelector("#screen-error:not(.hidden)", { timeout: 20000 });
  check(L("6 sandbox: the opened tab shows the link no longer works"), true, await viewer.textContent("#error-title"));
  await viewer.screenshot({ path: `${SHOTS}${dev}-6-subset-revoked.png` });
  check(L("6 sandbox: viewer tab had no page errors"), vErr.length === 0, vErr.join(" | "));
  await viewer.close();

  // 7. Codecs and performance
  await page.locator("#codecs").scrollIntoViewIfNeeded();
  const tsRows = await page.locator("#cx-table tbody tr").count();
  check(L("7 codecs: coverage by transfer syntax"), tsRows >= 10, `${tsRows} syntaxes; ${await page.textContent("#cx-idc")}`.slice(0, 120));
  await tap(page, "#bx-run", touch);
  await page.waitForFunction(() => /Decode/.test(document.querySelector("#bx-facts")?.textContent ?? ""), null, { timeout: 60000 });
  const bx = await page.textContent("#bx-facts");
  check(L("7 codecs: live benchmark ran"), /MB\/s/.test(bx) && /images of/.test(bx), bx.replace(/\s+/g, " ").slice(0, 200));
  await shot(page, "#codecs", `${dev}-7-codecs`);

  // 8. Build it
  await page.locator("#build").scrollIntoViewIfNeeded();
  await tap(page, "#rx-run", touch);
  await page.waitForFunction(() => /returned|threw/.test(document.querySelector("#rx-out")?.textContent ?? ""), null, { timeout: 15000 });
  const rx = await page.textContent("#rx-out");
  check(L("8 build: the 50-line receiver runs on the sample"), /"matchesBundle": true/.test(rx) && /"transferSyntax"/.test(rx), rx.replace(/\s+/g, " ").slice(0, 160));
  await tap(page, "#tv-run", touch);
  await page.waitForFunction(() => (document.querySelector("#tv-facts")?.textContent ?? "").includes("Tampering"), null, { timeout: 15000 });
  const tv = await page.textContent("#tv-facts");
  check(L("8 build: test vector matches appendix B"), !tv.includes("✗") && (tv.match(/✓/g) ?? []).length >= 8, `${(tv.match(/✓/g) ?? []).length} ✓`);
  await shot(page, "#build", `${dev}-8-build`);

  // Spec and generated pages resolve.
  for (const p of ["how/spec.html", "how/series-file.html", "how/test-vector.html", "how/corpus.html", "how/bench.html", "how/receiver.mjs", "how/data.json"]) {
    const r = await page.request.get(`${BASE}/${p}`);
    if (dev === "desktop") check(`linked page /${p}`, r.ok(), String(r.status()));
  }

  await layout(page, L("layout"), touch);
  await page.screenshot({ path: `${SHOTS}${dev}-full.png`, fullPage: true });
  check(L("no console errors"), errors.length === 0, errors.slice(0, 5).join(" | "));
  await context.close();
}

for (const dev of Object.keys(DEVICES)) {
  if (only && only !== dev) continue;
  try {
    await run(dev);
  } catch (e) {
    check(`${dev}: run completed`, false, e.message.split("\n")[0]);
  }
}
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
