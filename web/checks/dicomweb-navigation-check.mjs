// Real pointer/keyboard navigation, late study metadata, and slice rendering.
// BASE=http://127.0.0.1:8862 API=https://shlink-dicom.exe.xyz node web/checks/dicomweb-navigation-check.mjs
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = process.env.BASE ?? 'http://127.0.0.1:8862', api = process.env.API ?? base;
const out = process.env.CHECK_OUT ?? '/tmp/dicomweb-navigation-check';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const results = [], errors = [];
const record = (name, value = {}) => { results.push({ name, ...value }); console.log(name, JSON.stringify(value)); };
const url = kind => `${base}/demos/${kind}/?api=${encodeURIComponent(api)}`;
function observe(page) { page.on('pageerror', e => errors.push(e.message)); }
function pixels() {
  const source = document.querySelector('.cornerstone-viewport canvas') ?? window.cornerstone?.getEnabledElements().find(e => e.viewport.getCornerstoneImage?.())?.viewport.element.querySelector('canvas');
  if (!source?.width) return { levels: 0, nonBlack: 0 };
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d'); ctx.drawImage(source, 0, 0, 64, 64);
  const data = ctx.getImageData(0, 0, 64, 64).data, levels = new Set(); let nonBlack = 0;
  for (let i = 0; i < data.length; i += 4) { levels.add(data[i]); if (data[i] > 15) nonBlack++; }
  return { levels: levels.size, nonBlack };
}
try {
  const cs = await context.newPage(); observe(cs); await cs.goto(url('cornerstone'));
  await cs.waitForSelector('.cornerstone-viewport[data-loaded=true]', { timeout: 60_000 });
  const studies = await cs.evaluate(() => window.dicomwebDemo.studies);
  assert.equal(await cs.locator('#browser details').count(), studies.length);
  assert.equal(await cs.locator('#browser button[data-series]').count(), studies.reduce((n, s) => n + s.series.length, 0));
  const waitSeries = async series => {
    await cs.waitForFunction(series => { const e = document.querySelector('.cornerstone-viewport'); return e?.dataset.loaded === 'true' && e.dataset.imageId?.includes(`/series/${series}/`); }, series, { timeout: 60_000 });
    await cs.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await cs.waitForFunction('(' + pixels.toString() + ')().nonBlack > 5');
  };
  for (const st of studies.filter(s => !s.modalities.includes('SM'))) {
    const details = cs.locator('#browser details').filter({ has: cs.locator(`button[data-study="${st.uid}"]`) });
    if (!await details.evaluate(e => e.open)) await details.locator('summary').click();
    for (const se of st.series) {
      await cs.locator(`#browser button[data-series="${se.uid}"]`).click();
      if (se.modality === 'SR') {
        await cs.waitForSelector('.cornerstone-viewport[data-error=true]');
        assert.match(await cs.locator('#status').textContent(), /no displayable image frames/);
        record('Cornerstone non-image series explained', { description: se.description });
        continue;
      }
      await waitSeries(se.uid);
      assert.equal(await cs.locator('#browser button[aria-current=true]').getAttribute('data-series'), se.uid);
      const image = await cs.evaluate(pixels); assert(image.levels > 1, `${se.description}: ${JSON.stringify(image)}`);
      record('Cornerstone series rendered', { study: st.description, series: se.description, uid: se.uid, ...image });
    }
  }
  const mr = studies.find(s => s.modalities.includes('MR')), target = mr.series.find(s => s.description === 'T2 FSE AX');
  await cs.selectOption('#study', mr.uid); await waitSeries(mr.series[0].uid);
  // Repeated series switches must leave the selected series and actual image aligned.
  await cs.evaluate(ids => { const select = document.querySelector('#series'); for (const uid of ids) { select.value = uid; select.dispatchEvent(new Event('change')); } }, [...mr.series.slice(0, 5).map(s => s.uid), target.uid]);
  await waitSeries(target.uid); record('Cornerstone rapid series selection ends on requested image');
  await cs.evaluate(() => {
    window.scrollSamples = []; const el = document.querySelector('.cornerstone-viewport');
    el.addEventListener('wheel', () => window.scrollSamples.push({ type: 'wheel', time: performance.now() }), { capture: true });
    el.addEventListener('CORNERSTONE_STACK_NEW_IMAGE', e => window.scrollSamples.push({ type: 'image', time: performance.now(), index: e.detail.imageIdIndex, id: e.detail.imageId }));
  });
  await cs.waitForTimeout(400);
  const box = await cs.locator('.cornerstone-viewport').boundingBox(); await cs.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 10; i++) { await cs.mouse.wheel(0, 100); await cs.waitForTimeout(100); }
  await cs.waitForFunction(() => window.scrollSamples.some(s => s.type === 'image' && s.index === 10));
  const samples = await cs.evaluate(() => window.scrollSamples), images = samples.filter(s => s.type === 'image');
  assert.equal(images.length, 10); assert(images.every(s => s.id.includes(target.uid)));
  const timings = images.map(image => image.time - samples.filter(s => s.type === 'wheel' && s.time <= image.time).at(-1).time);
  record('Cornerstone ten scrolls render ten distinct slices', { indices: images.map(s => s.index), latencyMs: timings });
  await cs.screenshot({ path: `${out}/cornerstone.png`, fullPage: true });
  for (const width of [320, 390, 768]) {
    await cs.setViewportSize({ width, height: 900 }); await cs.waitForTimeout(100);
    assert(await cs.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    record('Cornerstone layout fits', { width });
  }
  await cs.screenshot({ path: `${out}/cornerstone-mobile.png`, fullPage: true }); await cs.close();

  const page = await context.newPage(); observe(page); await page.goto(url('ohif'));
  const frame = await (await page.waitForSelector('iframe', { timeout: 60_000 })).contentFrame();
  await frame.waitForFunction(() => window.cornerstone?.getEnabledElements().some(e => e.viewport.getCurrentImageId?.()), null, { timeout: 60_000 });
  const dismiss = frame.getByRole('button', { name: /Confirm and hide/i }); if (await dismiss.count()) await dismiss.click();
  const desc = 'HAND RGHT PA LAT OBL MIN 3 VW', hand = studies.find(s => s.description === desc);
  const header = frame.getByText(desc, { exact: true });
  // Close before asynchronous display-set creation. The late result expands the
  // parent state; the old uncontrolled accordion stays closed and then inverts.
  await header.evaluate(e => { e.click(); setTimeout(() => e.click(), 0); });
  await frame.waitForFunction(uid => window.services.displaySetService.getActiveDisplaySets().filter(s => s.StudyInstanceUID === uid).length === 3, hand.uid);
  await page.waitForTimeout(500);
  async function coherent() {
    const s = await header.evaluate(e => { const button = e.closest('button'), content = document.getElementById(button.getAttribute('aria-controls')); return { expanded: button.getAttribute('aria-expanded') === 'true', height: content.getBoundingClientRect().height, thumbnails: content.querySelectorAll('[data-cy="study-browser-thumbnail"]').length }; });
    assert.equal(s.expanded, s.height > 0 && s.thumbnails === 3, JSON.stringify(s)); return s;
  }
  record('OHIF late study metadata keeps expansion coherent', await coherent());
  for (let i = 0; i < 3; i++) { await header.click(); await page.waitForTimeout(300); await coherent(); }
  await header.locator('xpath=ancestor::button').press('Enter'); await page.waitForTimeout(300); await coherent();
  record('OHIF repeated mouse and keyboard expansion');
  for (const st of studies.filter(s => !s.modalities.includes('SM'))) {
    const h = frame.getByText(st.description, { exact: true });
    if (await h.locator('xpath=ancestor::button').getAttribute('aria-expanded') !== 'true') await h.click();
    await frame.waitForFunction(uid => window.services.displaySetService.getActiveDisplaySets().some(s => s.StudyInstanceUID === uid && s.images?.length), st.uid, { timeout: 60_000 });
    const ds = await frame.evaluate(uid => { const s = window.services.displaySetService.getActiveDisplaySets().find(s => s.StudyInstanceUID === uid && s.images?.length); return { id: s.displaySetInstanceUID, series: s.SeriesInstanceUID }; }, st.uid);
    const thumb = frame.locator('#thumbnail-' + ds.id);
    const beforeClick = await frame.evaluate(() => window.cornerstone.getEnabledElements().map(e => e.viewport.getCurrentImageId?.()).filter(Boolean));
    await thumb.click(); await page.waitForTimeout(150);
    assert.deepEqual(await frame.evaluate(() => window.cornerstone.getEnabledElements().map(e => e.viewport.getCurrentImageId?.()).filter(Boolean)), beforeClick);
    await thumb.dblclick();
    await frame.waitForFunction(series => window.cornerstone.getEnabledElements().some(e => e.viewport.getCornerstoneImage?.()?.imageId.includes(`/series/${series}/`)), ds.series, { timeout: 60_000 });
    await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await frame.waitForFunction('(' + pixels.toString() + ')().nonBlack > 5');
    const image = await frame.evaluate(pixels); assert(image.levels > 1);
    record('OHIF double-click loads study', { description: st.description, series: ds.series, ...image });
  }
  await page.screenshot({ path: `${out}/ohif.png`, fullPage: true });
  assert.deepEqual(errors, []);
} catch (e) { errors.push(String(e)); process.exitCode = 1; console.error(e); }
finally { await writeFile(`${out}/results.json`, JSON.stringify({ base, results, errors }, null, 2)); await browser.close(); }
