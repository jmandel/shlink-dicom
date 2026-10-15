// Dark-mode audit of what is on screen (pages opened with colorScheme "dark"): no near-white
// panel inside the page, and body text with contrast of at least 4.5:1 (3:1 for large text)
// against what is behind it. Image areas (canvas, video, PDF pages, the image stage) are left out:
// they are black on purpose, or paper.
import { mkdirSync } from "node:fs";

const SHOTS = new URL("../../docs/shots/dark/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

export async function darkAudit(page, label, check, shot) {
  const r = await page.evaluate(() => {
    const parse = (c) => {
      const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
      return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : [0, 0, 0, 0];
    };
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
      for (let e = el; e; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.display === "none" || s.visibility === "hidden" || +s.opacity === 0) return false;
      }
      return true;
    };
    const skip = (el) => !!el.closest("canvas, video, img, svg, .pdf-page, .stage, .media-stage, .label-fig");
    // What is behind an element: its own background, else its ancestors', composited.
    const behind = (el) => {
      let layers = [];
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c[3] > 0) layers.push(c);
        if (c[3] >= 1) break;
      }
      let out = [255, 255, 255];
      for (const c of layers.reverse()) out = out.map((v, i) => v * (1 - c[3]) + c[i] * c[3]);
      return out;
    };
    const white = [], low = [];
    let texts = 0;
    for (const el of document.querySelectorAll("body *")) {
      if (skip(el) || !visible(el)) continue;
      const s = getComputedStyle(el);
      const bg = parse(s.backgroundColor);
      const r = el.getBoundingClientRect();
      if (bg[3] > 0.5 && lum(bg) > 0.8 && r.width >= 32 && r.height >= 32) white.push(`${el.tagName.toLowerCase()}.${el.className || el.id} ${s.backgroundColor}`);
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own) continue;
      texts++;
      const fg = parse(s.color), b = behind(el);
      const L1 = lum(fg.slice(0, 3).map((v, i) => v * fg[3] + b[i] * (1 - fg[3]))), L2 = lum(b);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const size = parseFloat(s.fontSize), large = size >= 24 || (size >= 18.6 && +s.fontWeight >= 700);
      if (ratio < (large ? 3 : 4.5)) low.push(`"${el.textContent.trim().slice(0, 30)}" ${ratio.toFixed(2)}:1 (${s.color} on rgb(${b.map(Math.round).join(",")}))`);
    }
    // Drawn panels that are page furniture, not images (waveform plots): their background pixel.
    for (const c of document.querySelectorAll("canvas.wf-canvas")) {
      if (!visible(c)) continue;
      const d = c.getContext("2d")?.getImageData(1, 1, 1, 1).data;
      if (d && lum([d[0], d[1], d[2]]) > 0.8) white.push(`canvas.wf-canvas rgb(${d[0]},${d[1]},${d[2]})`);
    }
    return { white: [...new Set(white)], low: [...new Set(low)], texts, scheme: matchMedia("(prefers-color-scheme: dark)").matches };
  });
  check(`${label}: dark scheme applied`, r.scheme, "");
  check(`${label}: no near-white panels`, r.white.length === 0, r.white.slice(0, 3).join("; "));
  check(`${label}: text contrast ≥ 4.5:1 (3:1 large)`, r.low.length === 0, r.low.length ? r.low.slice(0, 3).join("; ") : `${r.texts} text elements`);
  if (shot) await page.screenshot({ path: `${SHOTS}${shot}.png` });
  return r;
}
