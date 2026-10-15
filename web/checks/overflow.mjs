// Sideways overflow on narrow screens: the document must not scroll sideways, no visible element
// may extend past the viewport (unless it sits in a sideways-scrolling container such as the
// series strip, which clips it), and no text may spill out of its box.
//
// Larger text is emulated with `text-size-adjust: 200%` on the root, which in Chromium's mobile
// emulation scales every font size, as Android's font scale and Chrome's text scaling do.

export const BIG_TEXT = "html { -webkit-text-size-adjust: 200% !important; text-size-adjust: 200% !important; }";

export async function overflowAudit(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    if (document.documentElement.scrollWidth > vw + 1) out.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${vw}`);
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      for (let e = el; e; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.display === "none" || s.visibility === "hidden") return false;
      }
      return true;
    };
    const scroller = (el) => {
      for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) return e;
      }
      return null;
    };
    const name = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${typeof el.className === "string" && el.className ? `.${el.className.split(" ")[0]}` : ""} "${(el.textContent ?? "").trim().slice(0, 24)}"`;
    for (const el of document.querySelectorAll("body *")) {
      if (el.closest("canvas, svg, video, .sr-only") || !visible(el)) continue;
      const r = el.getBoundingClientRect();
      const box = scroller(el);
      // Inside a clipping or scrolling container, the container decides (the strip scrolls sideways).
      if (!box && (r.right > vw + 1 || r.left < -1)) out.push(`${name(el)} past the screen: ${Math.round(r.left)}–${Math.round(r.right)} of ${vw}`);
      if (box && box === document.documentElement) continue;
      // Text spilling out of its own box (overflow visible).
      const s = getComputedStyle(el);
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (own && s.overflowX === "visible" && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) out.push(`${name(el)} text spills out: ${el.scrollWidth} > ${el.clientWidth}`);
    }
    // Corner annotations on the image must not run into each other.
    const huds = [...document.querySelectorAll(".hud")].filter((h) => visible(h) && h.textContent.trim());
    for (let i = 0; i < huds.length; i++)
      for (let j = i + 1; j < huds.length; j++) {
        const a = huds[i].getBoundingClientRect(), b = huds[j].getBoundingClientRect();
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(`${huds[i].id} and ${huds[j].id} overlap`);
      }
    return [...new Set(out)].slice(0, 12);
  });
}

/** Makes every page of a context use doubled text from the start (survives navigations). */
export function bigTextOn(context) {
  return context.addInitScript((css) => {
    const add = () => {
      const s = document.createElement("style");
      s.textContent = css;
      document.head.append(s);
    };
    if (document.head) add();
    else document.addEventListener("DOMContentLoaded", add);
  }, BIG_TEXT);
}
