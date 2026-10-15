// Chromium for the check suites, with every uncaught page error recorded: in any page of any
// context, whatever flow it happens in. Each suite reports them as one check at the end.
// Also watches every progress bar on every page (progressWatch below): each visible
// role="progressbar" must carry a value and a maximum, never go backwards, fill in proportion,
// and say the same thing in words; bars must not animate on their own.
import { chromium } from "playwright-core";

export async function launchBrowser(opts = {}) {
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", ...opts });
  const errors = [];
  const progress = { bars: 0, samples: 0, problems: [] };
  const watch = (c) => {
    c.on("weberror", (e) => errors.push(`${(e.page()?.url() ?? "?").split("#")[0]}: ${e.error().message}`));
    void c.addInitScript(progressWatch);
    c.on("console", (m) => {
      const t = m.text();
      if (!t.startsWith("[progress] ")) return;
      const r = JSON.parse(t.slice(11));
      progress.bars += r.bars;
      progress.samples += r.samples;
      progress.problems.push(...r.problems);
    });
  };
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (o) => {
    const c = await newContext(o);
    watch(c);
    return c;
  };
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (o) => {
    const p = await newPage(o);
    watch(p.context());
    return p;
  };
  browser.pageErrors = errors;
  browser.progress = progress;
  return browser;
}

/**
 * Runs in every page: samples visible progress bars every 100 ms and logs a summary line
 * ("[progress] {…}") every second and on page hide, for the suite-wide check.
 */
function progressWatch() {
  const seen = new WeakMap();
  let bars = 0, samples = 0;
  const problems = [];
  const qty = (s) => (s.match(/([\d.,]+)\s*(B|KB|MB|GB)?\s+of\s+([\d.,]+)\s*(B|KB|MB|GB)?/) ?? null);
  const flag = (el, what) => {
    const p = `${what} — ${el.getAttribute("aria-label") ?? el.id ?? el.className}: ${el.getAttribute("aria-valuetext") ?? ""}`;
    if (!problems.includes(p) && problems.length < 20) problems.push(p);
  };
  const sample = () => {
    for (const el of document.querySelectorAll('[role="progressbar"]')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || el.closest(".hidden") || getComputedStyle(el).visibility === "hidden") {
        seen.delete(el); // hidden: a later showing is a new job
        continue;
      }
      samples++;
      const now = Number(el.getAttribute("aria-valuenow")), max = Number(el.getAttribute("aria-valuemax"));
      let st = seen.get(el);
      if (!st) seen.set(el, (st = { now: -1, max: -1, same: 0 })), bars++;
      if (!el.hasAttribute("aria-valuenow") || !el.hasAttribute("aria-valuemax") || !Number.isFinite(now) || !Number.isFinite(max) || max <= 0) {
        flag(el, "no determinate value");
        continue;
      }
      if (now < 0 || now > max) flag(el, `value ${now} outside 0..${max}`);
      if (st.max === max && now < st.now && now !== 0) flag(el, `went backwards ${st.now} → ${now}`);
      st.same = st.max === max && st.now === now ? st.same + 1 : 0;
      st.now = now;
      st.max = max;
      // Fill in proportion (once the value has held for a few samples, past any transition).
      const fill = el.firstElementChild;
      if (fill && st.same >= 3) {
        const ratio = fill.getBoundingClientRect().width / r.width;
        if (Math.abs(ratio - now / max) > 0.03) flag(el, `fill ${ratio.toFixed(2)} vs value ${(now / max).toFixed(2)}`);
      }
      // Words: "a of b"; a is 0 at 0, a equals b at the end.
      const q = qty(el.getAttribute("aria-valuetext") ?? "");
      if (!q) flag(el, "no 'a of b' in its text");
      else {
        const a = `${q[1]} ${q[2] ?? ""}`.trim(), b = `${q[3]} ${q[4] ?? ""}`.trim();
        if (now === max && a !== b) flag(el, `full but says ${a} of ${b}`);
        if (now === 0 && parseFloat(q[1]) !== 0) flag(el, `empty but says ${a} of ${b}`);
      }
      if (getComputedStyle(el).animationName !== "none" || (fill && getComputedStyle(fill).animationName !== "none")) flag(el, "animates on its own");
    }
  };
  const report = () => {
    if (!samples && !problems.length) return;
    console.log(`[progress] ${JSON.stringify({ bars, samples, problems: problems.splice(0) })}`);
    bars = 0;
    samples = 0;
  };
  setInterval(sample, 100);
  setInterval(report, 1000);
  addEventListener("pagehide", report);
}

/** The suite-wide checks: no uncaught error in any page; every progress bar seen was honest. */
export function pageErrorCheck(browser, check) {
  const e = browser.pageErrors;
  check("no uncaught page errors in any flow", e.length === 0, e.length ? `${e.length}: ${[...new Set(e)].slice(0, 4).join(" | ")}` : "");
  const p = browser.progress;
  const probs = [...new Set(p.problems)];
  check("progress bars: determinate, never backwards, in proportion, and saying the same in words", probs.length === 0, probs.length ? probs.slice(0, 4).join(" | ") : `${p.bars} bars, ${p.samples} samples`);
}
