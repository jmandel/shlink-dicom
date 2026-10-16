// QR code for the sample link, as SVG. usage: node qr.mjs URL out.svg
import qrcode from "../../../node_modules/qrcode-generator/qrcode.js";
import fs from "fs";
const [url, out] = process.argv.slice(2);
const q = qrcode(0, "M"); q.addData(url); q.make();
const n = q.getModuleCount(), quiet = 4, size = n + 2 * quiet;
let d = "";
for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + quiet},${r + quiet}h1v1h-1z`;
fs.writeFileSync(out, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#1d1e20"/></svg>`);
console.log("modules", n);
