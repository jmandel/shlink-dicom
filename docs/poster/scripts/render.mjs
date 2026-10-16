// Render poster.html to poster.png (7200 x 5400) and poster.pdf (48 x 36 in), plus a small preview.
import { chromium } from "../../../node_modules/playwright-core/index.mjs";
import { execFileSync } from "child_process";
const dir = new URL("..", import.meta.url).pathname;
const b = await chromium.launch({ executablePath: "/usr/bin/chromium" });
const p = await b.newPage({ viewport: { width: 4608, height: 3456 }, deviceScaleFactor: 7200 / 4608 });
await p.goto("file://" + dir + "poster.html"); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(500);
const over = await p.evaluate(() => [...document.querySelectorAll(".box, footer")].map((e) => { const r = e.getBoundingClientRect(); return { cls: e.className, top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }; }));
console.log(JSON.stringify(over));
await p.screenshot({ path: dir + "poster.png", clip: { x: 0, y: 0, width: 4608, height: 3456 } });
await p.pdf({ path: dir + "poster.pdf", width: "48in", height: "36in", printBackground: true, pageRanges: "1" });
await b.close();
execFileSync("magick", [dir + "poster.png", "-resize", "1800x", dir + "poster-preview.png"]);
console.log("ok");
