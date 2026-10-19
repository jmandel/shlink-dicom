// The actual viewer markup and styles, with long recipient-controlled text and saved filenames.
// No server or clinical data needed. CHECK_OUT=/path node web/checks/modal-layout-check.mjs
import { chromium } from 'playwright-core';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
const root = new URL('../../', import.meta.url), out = process.env.CHECK_OUT;
const html = (await readFile(new URL('web/view/index.html', root), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const css = await Promise.all(['web/shared/base.css', 'web/view/view.css'].map(f => readFile(new URL(f, root), 'utf8')));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()), args: ['--no-sandbox'] });
const results = [];
try {
  if (out) await mkdir(out, { recursive: true });
  const page = await browser.newPage();
  for (const width of [320, 390, 480, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.setContent(html); for (const content of css) await page.addStyleTag({ content });
    await page.evaluate(() => {
      const name = '2.25.211821980884276248447803804935369747313.dcm';
      document.querySelector('#dl-status').textContent = `Saved ${name}`;
      document.querySelector('#dl-progress').classList.remove('hidden');
      document.querySelector('#dl-options').classList.add('hidden');
      document.querySelector('#dl-bar').style.width = '100%';
      document.querySelector('#btn-dl-cancel').classList.add('hidden');
      document.querySelectorAll('.sheet').forEach(s => {
        if (s.id !== 'sheet-download') {
          const p = document.createElement('p'); p.textContent = `Details: ${'VeryLongPatientSuppliedDescription'.repeat(8)}`; s.append(p);
        }
      });
    });
    for (const id of await page.locator('.sheet').evaluateAll(s => s.map(x => x.id))) {
      const result = await page.evaluate(id => {
        document.querySelectorAll('.sheet').forEach(s => s.classList.toggle('hidden', s.id !== id));
        const s = document.getElementById(id), r = s.getBoundingClientRect();
        return { id, width: innerWidth, clientWidth: s.clientWidth, scrollWidth: s.scrollWidth, left: r.left, right: r.right,
          success: s.scrollWidth <= s.clientWidth + 1 && r.left >= -1 && r.right <= innerWidth + 1 };
      }, id);
      results.push(result);
      if (out && id === 'sheet-download') await page.screenshot({ path: `${out}/download-${width}.png` });
    }
    const sr = await page.evaluate(() => {
      document.querySelectorAll('.sheet').forEach(s => s.classList.add('hidden'));
      const host = document.createElement('div'); host.className = 'object-view'; host.style.position = 'fixed'; host.style.inset = '0';
      let node = host;
      for (let k = 0; k < 6; k++) { const nested = document.createElement('div'); nested.className = 'sr-container'; node.append(nested); node = nested; }
      node.innerHTML = '<div class="sr-item"><span class="sr-name">Maximum X-Ray Tube Current</span><span class="sr-value">'+ 'LongDICOMValue'.repeat(20) + '</span></div>';
      host.insertAdjacentHTML('beforeend', '<dl class="obj-facts"><dt>'+ 'LongAttributeName'.repeat(8) +'</dt><dd>Value</dd></dl>');
      document.body.append(host);
      return { id: 'structured-report', width: innerWidth, clientWidth: host.clientWidth, scrollWidth: host.scrollWidth, success: host.scrollWidth <= host.clientWidth + 1 };
    });
    results.push(sr);
  }
  const result = { success: results.every(r => r.success), checks: results.length, results };
  if (out) await writeFile(`${out}/results.json`, JSON.stringify(result, null, 2)+'\n');
  console.log(JSON.stringify(result, null, 2));
  if (!result.success) process.exitCode = 1;
} finally { await browser.close(); }
