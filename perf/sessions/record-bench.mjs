// Record size against decrypt cost: AES-GCM records of 16, 32 and 64 KiB, decrypted the way the
// viewer does (viewer-kit record-decrypt.ts: `lanes` WebCrypto calls in flight), in headless
// Chromium, at 1× and 4× CPU throttling. Reports MB/s, calls per MB, and the browser's CPU time per MB.
//   node perf/sessions/record-bench.mjs [MB]
import { chromium } from "playwright-core";
const MB = Number(process.argv[2] ?? 64);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium" });
const bcdp = await browser.newBrowserCDPSession();
const cpuTime = async () => (await bcdp.send("SystemInfo.getProcessInfo")).processInfo.reduce((a, p) => a + p.cpuTime, 0);
for (const cpu of [1, 4]) {
  const page = await browser.newPage();
  // A secure origin (WebCrypto needs one), answered by the page's own route.
  await page.route("https://bench.invalid/", (r) => r.fulfill({ contentType: "text/html", body: "<title>bench</title>" }));
  await page.goto("https://bench.invalid/");
  const cdp = await page.context().newCDPSession(page);
  if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
  for (const kib of [64, 32, 16]) {
    const R = kib * 1024;
    const c0 = await cpuTime();
    // Encrypt once (not timed), then decrypt three times; the median is reported.
    const r = await page.evaluate(
      async ([R, MB]) => {
        const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
        const P = R - 16, n = Math.ceil((MB << 20) / P);
        const nonce = (i) => {
          const b = new Uint8Array(12);
          new DataView(b.buffer).setUint32(8, i);
          return b;
        };
        const plain = new Uint8Array(P);
        crypto.getRandomValues(plain.subarray(0, 65536 > P ? P : 65536));
        const ct = new Uint8Array(n * R);
        // Encrypt as the Share page does (pack.ts: every record of a chunk at once).
        const te = performance.now();
        for (let c = 0; c < n; c += 128) {
          await Promise.all(Array.from({ length: Math.min(128, n - c) }, async (_, k) => ct.set(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(c + k) }, key, plain)), (c + k) * R)));
        }
        const encMs = performance.now() - te;
        const times = [];
        for (let rep = 0; rep < 3; rep++) {
          const t = performance.now();
          let next = 0;
          const lane = async () => {
            while (next < n) {
              const i = next++;
              await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(i) }, key, ct.subarray(i * R, (i + 1) * R));
            }
          };
          await Promise.all(Array.from({ length: 8 }, lane));
          times.push(performance.now() - t);
        }
        times.sort((a, b) => a - b);
        return { records: n, ms: times[1], encMs };
      },
      [R, MB],
    );
    // Includes the untimed encrypt; it is the same work at every size, so differences are decrypt's.
    const cpuS = (await cpuTime()) - c0;
    console.log(JSON.stringify({ cpu, kib, MB, records: r.records, ms: Math.round(r.ms), MBps: +(MB / (r.ms / 1000)).toFixed(0), encryptMBps: +(MB / (r.encMs / 1000)).toFixed(0), callsPerMB: +(r.records / MB).toFixed(0), usPerCall: +((r.ms * 1000) / r.records).toFixed(1), cpuMsPerMB_encrypt_and_3_decrypts: +((cpuS * 1000) / MB).toFixed(1) }));
  }
  await page.close();
}
await browser.close();
