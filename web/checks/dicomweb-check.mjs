// Real viewer integration, retained-session restart, isolation and passcode checks.
// BASE=http://localhost:8861 API=https://shlink-dicom.exe.xyz CHECK_OUT=/tmp/dicomweb node web/checks/dicomweb-check.mjs
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = process.env.BASE ?? 'http://127.0.0.1:8861', api = process.env.API ?? base, out = process.env.CHECK_OUT ?? '/tmp/dicomweb-check';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const results = [], errors = [], upstreamDiagnostics = [];
const record = (name, value) => { results.push({ name, ...value }); console.log(name, JSON.stringify(value)); };
const url = kind => `${base}/demos/${kind}/?api=${encodeURIComponent(api)}`;
function observe(page) {
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    if (m.type() !== 'error' || /status of (404|410)/.test(m.text())) return;
    const diagnostic = { message: m.text().slice(0, 350), url: page.url().split('#')[0], location: m.location(), after: results.at(-1)?.name };
    // OHIF's bundled VTK logs this for the sample's reconstructed dose-report thumbnail:
    // its original, valid WindowWidth=1 maps to equal low/high thresholds. Preserve the
    // clinical metadata and record the upstream diagnostic separately from integration errors.
    if (m.text() === 'attempt to set zero width color range' && m.location().url.includes('/ohif-viewer/')) upstreamDiagnostics.push(diagnostic);
    else errors.push(diagnostic);
  });
}
const canvasStats = () => {
  const source = [...document.querySelectorAll('canvas')].find(c => c.width > 100 && c.height > 100);
  if (!source) return null;
  const copy = document.createElement('canvas'); copy.width = copy.height = 64;
  const ctx = copy.getContext('2d'); ctx.drawImage(source, 0, 0, 64, 64);
  const data = ctx.getImageData(0, 0, 64, 64).data, levels = new Set();
  let nonBlack = 0; for (let i = 0; i < data.length; i += 4) { levels.add(data[i]); if (data[i] > 15) nonBlack++; }
  return { width: source.width, height: source.height, levels: levels.size, nonBlack };
};
try {
  const cornerstone = await context.newPage(); observe(cornerstone);
  await cornerstone.goto(url('cornerstone'));
  await cornerstone.waitForSelector('.cornerstone-viewport[data-loaded=true]', { timeout: 60_000 });
  await cornerstone.waitForFunction(() => document.querySelector('canvas')?.width > 100);
  // Wait for the first paint, not merely the decoded stack promise.
  await cornerstone.waitForFunction('(' + canvasStats.toString() + ')()?.nonBlack > 50');
  const csPixels = await cornerstone.evaluate(canvasStats); assert(csPixels.levels > 30); record('Cornerstone sample pixels', csPixels);
  await cornerstone.screenshot({ path: `${out}/cornerstone.png`, fullPage: true });
  const root = await cornerstone.evaluate(() => window.dicomwebDemo.root);
  const endpoint = await cornerstone.evaluate(async () => {
    const d = window.dicomwebDemo, st = d.studies.find(s => s.uid === document.querySelector('#study').value), se = st.series.find(s => s.uid === document.querySelector('#series').value);
    const path = `${d.root}studies/${st.uid}/series/${se.uid}`, meta = await (await fetch(path + '/metadata')).json();
    const frame = `${path}/instances/${meta[1]['00080018'].Value[0]}/frames/1`;
    const r = await fetch(frame); return { frame, status: r.status, type: r.headers.get('Content-Type'), length: (await r.arrayBuffer()).byteLength, instances: meta.length };
  });
  assert.equal(endpoint.status, 200); assert(endpoint.length > 1000); assert(endpoint.type.includes('1.2.840.10008.1.2.4.70')); record('Stored JPEG Lossless WADO frame', endpoint);
  const cdp = await context.newCDPSession(cornerstone), versions = new Map();
  cdp.on('ServiceWorker.workerVersionUpdated', ({ versions: update }) => { for (const v of update) versions.set(v.versionId, v); });
  await cdp.send('ServiceWorker.enable');
  for (let i = 0; i < 40 && ![...versions.values()].some(v => v.status === 'activated'); i++) await cornerstone.waitForTimeout(100);
  const version = [...versions.values()].find(v => v.scriptURL.endsWith('/shlink-dicomweb-sw.js') && v.status === 'activated'); assert(version, 'active service worker');
  await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  for (let i = 0; i < 40 && versions.get(version.versionId).runningStatus !== 'stopped'; i++) await cornerstone.waitForTimeout(100);
  assert.equal(versions.get(version.versionId).runningStatus, 'stopped');
  const afterRestart = await cornerstone.evaluate(async endpoint => {
    const r = await fetch(endpoint); return { status: r.status, length: (await r.arrayBuffer()).byteLength, root: window.dicomwebDemo.root };
  }, endpoint.frame);
  assert.equal(afterRestart.status, 200); assert.equal(afterRestart.root, root); assert.equal(afterRestart.length, endpoint.length); record('Service worker stopped and restarted', afterRestart);
  // An XHR is the request type used by WADO loaders; cancellation also has to cross the bridge.
  const cancelled = await cornerstone.evaluate(async () => {
    const d = window.dicomwebDemo, st = d.studies.find(s => s.modalities.includes('SM'));
    const ac = new AbortController(), p = fetch(`${d.root}studies/${st.uid}`, { signal: ac.signal });
    const r = await p, reader = r.body.getReader(); await reader.read(); ac.abort();
    try { while (!(await reader.read()).done) {} return false; } catch (e) { return e.name === 'AbortError'; }
  });
  assert(cancelled); record('Original stream cancelled', { cancelled });
  const second = await context.newPage(); observe(second); await second.goto(url('cornerstone'));
  await second.waitForSelector('.cornerstone-viewport[data-loaded=true]', { timeout: 60_000 });
  const isolation = await second.evaluate(async root => ({ own: window.dicomwebDemo.root, foreignStatus: (await fetch(root + 'studies')).status }), root);
  assert.notEqual(isolation.own, root); assert.equal(isolation.foreignStatus, 410); record('Two tabs keep sessions separate', isolation);
  await second.evaluate(() => window.dicomwebDemo.dispose());
  assert.equal(await second.evaluate(async root => (await fetch(root + 'studies')).status, isolation.own), 410);
  await second.close();
  const wheel = await cornerstone.locator('.cornerstone-viewport').boundingBox();
  await cornerstone.mouse.move(wheel.x + wheel.width / 2, wheel.y + wheel.height / 2); await cornerstone.mouse.wheel(0, 200); await cornerstone.waitForTimeout(700);
  const afterWheel = await cornerstone.evaluate(canvasStats); assert(afterWheel.nonBlack > 50); record('Cornerstone scroll renders', afterWheel);
  for (const width of [320, 390, 768]) {
    await cornerstone.setViewportSize({ width, height: 900 }); await cornerstone.waitForTimeout(150);
    const size = await cornerstone.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert(size.page <= width + 1 && size.body <= width + 1); record(`Cornerstone layout ${width}`, size);
  }
  await cornerstone.screenshot({ path: `${out}/cornerstone-mobile.png`, fullPage: true });
  await cornerstone.setViewportSize({ width: 1440, height: 1100 });
  const ctStudy = await cornerstone.evaluate(() => window.dicomwebDemo.studies.find(s => s.modalities.includes('CT')).uid);
  await cornerstone.selectOption('#study', ctStudy); await cornerstone.waitForSelector('.cornerstone-viewport[data-loaded=true]', { timeout: 60_000 });
  await cornerstone.waitForFunction('(' + canvasStats.toString() + ')()?.nonBlack > 50');
  record('Cornerstone CT pixels', await cornerstone.evaluate(canvasStats)); await cornerstone.screenshot({ path: `${out}/cornerstone-ct.png`, fullPage: true }); await cornerstone.close();
  const ohif = await context.newPage(); observe(ohif); await ohif.goto(url('ohif'));
  await ohif.waitForSelector('iframe', { timeout: 60_000 });
  const frame = await (await ohif.$('iframe')).contentFrame();
  await frame.waitForSelector('canvas', { timeout: 90_000 });
  await frame.waitForFunction('(' + canvasStats.toString() + ')()?.nonBlack > 50', null, { timeout: 60_000 });
  const dismiss = frame.getByRole('button', { name: /Confirm and hide/i }); if (await dismiss.count()) await dismiss.click();
  const ohifPixels = await frame.evaluate(canvasStats); assert(ohifPixels.levels > 30); record('OHIF sample pixels', ohifPixels);
  await ohif.screenshot({ path: `${out}/ohif.png`, fullPage: true });
  await ohif.selectOption('#study', ctStudy);
  const ctFrame = await (await ohif.waitForSelector('iframe')).contentFrame();
  await ctFrame.waitForSelector('canvas', { timeout: 90_000 });
  await ctFrame.waitForFunction('(' + canvasStats.toString() + ')()?.nonBlack > 50', null, { timeout: 60_000 });
  record('OHIF CT pixels', await ctFrame.evaluate(canvasStats)); await ohif.screenshot({ path: `${out}/ohif-ct.png`, fullPage: true });
  await ohif.close();
  const samples = (await (await fetch(`${api}/api/demo-shares`)).json()).shares;
  const locked = samples.find(s => s.passcodeHint);
  if (locked) {
    const page = await context.newPage(); observe(page);
    await page.goto(url('cornerstone') + '#' + locked.shlinkUri);
    await page.waitForFunction(() => document.querySelector('#status').dataset.error === 'true', null, { timeout: 60_000 });
    assert.match(await page.locator('#status').textContent(), /passcode/i);
    await page.locator('#passcode').fill(locked.passcodeHint); await page.getByRole('button', { name: 'Open link', exact: true }).click();
    await page.waitForSelector('.cornerstone-viewport[data-loaded=true]', { timeout: 60_000 }); record('Passcode share', { rendered: true }); await page.close();
  }
  assert.deepEqual(errors, []); record('Browser errors', { errors, upstreamDiagnostics });
} finally {
  await writeFile(`${out}/results.json`, JSON.stringify({ results, errors, upstreamDiagnostics }, null, 2)); await browser.close();
}
