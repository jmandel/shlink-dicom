// Public-sample regression: a metadata refresh must not let obsolete cards start prefetch.
// BASE=http://127.0.0.1:8080 node web/checks/overview-work-check.mjs
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const base = process.env.BASE ?? 'http://127.0.0.1:8080';
const out = process.env.CHECK_OUT ?? '/tmp/overview-work-check';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  const log = window.__overviewWorkCheck = { replacements: [], radiographs: [] };
  let first;
  new MutationObserver(() => {
    const next = document.querySelector('#ov-studies .study-card');
    if (first && next && next !== first) log.replacements.push({ at: performance.now(), oldThumbnailReady: !!first.querySelector('canvas')?.dataset.drawn });
    if (next) first = next;
  }).observe(document, { childList: true, subtree: true });
  const original = window.fetch;
  window.fetch = function (input, options) {
    const url = typeof input === 'string' ? input : input.url;
    const range = new Headers(options?.headers ?? input?.headers).get('range');
    // In the public sample, each large radiograph follows its 64 KiB header.
    const match = /^bytes=65536-(\d+)$/.exec(range ?? '');
    if (url?.includes('.bin') && match && Number(match[1]) > 2 * 1024 * 1024) {
      const card = [...document.querySelectorAll('.study-card')].find(x => /Histopathology/.test(x.querySelector('.study-title')?.textContent));
      log.radiographs.push({ at: performance.now(), range, slideReady: !!card?.querySelector('canvas')?.dataset.drawn });
    }
    return original.call(this, input, options);
  };
});
const page = await context.newPage(), errors = [], result = {};
page.on('pageerror', e => errors.push(String(e)));
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 80, downloadThroughput: 1012500, uploadThroughput: 168750 });
try {
  const demos = await fetch(`${base}/api/demo-shares`).then(r => r.json());
  const link = demos.shares.find(s => !s.passcodeHint).shlinkUri;
  const payload = JSON.parse(Buffer.from(link.split('shlink:/')[1], 'base64url').toString());
  payload.url = base + new URL(payload.url).pathname;
  await page.goto(`${base}/view#shlink:/${Buffer.from(JSON.stringify(payload)).toString('base64url')}`, { waitUntil: 'commit' });
  await page.waitForFunction(() => {
    const canvases = [...document.querySelectorAll('.study-thumb')];
    return canvases.length === 6 && canvases.every(c => c.dataset.drawn);
  }, null, { timeout: 90000 });
  Object.assign(result, await page.evaluate(() => window.__overviewWorkCheck));
  if (!result.replacements.some(x => !x.oldThumbnailReady)) throw Error('Setup did not replace cards while thumbnails were loading');
  if (result.radiographs.length !== 3) throw Error('Expected exactly three large radiograph transfers');
  if (!result.radiographs.every(x => x.slideReady)) throw Error('Obsolete overview started radiograph prefetch before the slide thumbnail');
  // A normal round trip must still resume the current overview.
  await page.locator('.study-open').filter({ has: page.locator('.study-title', { hasText: /ABDOMEN/i }) }).click();
  await page.waitForFunction(() => window.__viewHooks.current().onScreen?.uid, null, { timeout: 60000 });
  await page.click('#btn-back');
  await page.waitForSelector('#screen-overview:not(.hidden)');
  if (await page.locator('.study-thumb[data-drawn]').count() !== 6) throw Error('Returning to the overview lost completed thumbnails');
  if (errors.length) throw Error(errors.join('\n'));
  result.success = true;
} catch (e) {
  result.success = false;
  result.error = String(e.stack ?? e);
} finally {
  result.errors = errors;
  writeFileSync(`${out}/results.json`, JSON.stringify(result, null, 2) + '\n');
  await page.screenshot({ path: `${out}/overview.png` });
  await browser.close();
}
console.log(JSON.stringify(result));
process.exitCode = result.success ? 0 : 1;
