// Step 7: corpus coverage by transfer syntax (baked at build time into how/data.json) and a live
// benchmark on the sample: one Range read of the largest series, WebCrypto decryption of all its
// records, and decoding of every image in the worker pool.
import { formatBytes, planSeries, siteUrl, type SeriesEntry } from "../core/index";
import { getDecoderPool } from "../core/images";
import { $, facts, h, n, on, S, storePlain } from "./state";

const UNCOMPRESSED = new Set(["1.2.840.10008.1.2", "1.2.840.10008.1.2.1", "1.2.840.10008.1.2.2", "1.2.840.10008.1.2.1.99"]);
let tsNames: Record<string, string> = {};

async function loadData() {
  const box = $("cx-table");
  try {
    const res = await fetch(siteUrl("how/data.json"), { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    const rows = d.codecs.syntaxes.map((s: any) => {
      tsNames[s.uid] = s.name;
      const pct = s.total ? (100 * s.pass) / s.total : 0;
      return h(
        "tr",
        {},
        h("td", {}, s.name, h("span", { class: "uid", text: s.uid })),
        h("td", { class: "n" }, `${s.pass} / ${s.total}`, h("div", { class: "bar", "aria-hidden": "true" }, h("i", { style: `width:${pct}%` }))),
      );
    });
    const total = d.codecs.syntaxes.reduce((a: number, s: any) => a + s.total, 0);
    const pass = d.codecs.syntaxes.reduce((a: number, s: any) => a + s.pass, 0);
    box.replaceChildren(
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, h("th", { text: "Transfer syntax" }), h("th", { class: "n", text: "Cases passed" }))),
        h("tbody", {}, ...rows),
      ),
      h("p", { class: "small muted", text: `${n(pass)} of ${n(total)} cases pass in report “${d.codecs.report.name}” (${d.codecs.report.time.replace("T", " ")}).` }),
    );
    const idc = d.codecs.idc;
    if (idc) {
      $("cx-idc").textContent =
        `In the NCI Imaging Data Commons, ${idc.studies.pct.toFixed(2)}% of ${n(idc.studies.count)} studies contain only pixel formats for which the corpus has a passing case. ` +
        `That archive is research data, mostly CT and MR, and over 99% of its images are uncompressed, so the figure says little about compressed clinical images.`;
    }
  } catch (e) {
    box.replaceChildren(h("p", { class: "small bad", text: `Coverage data is missing from this build (${(e as Error).message}).` }));
  }
}

function largestSeries(): SeriesEntry {
  return S.share!.index.studies.flatMap((s) => s.series).reduce((a, b) => (b.plaintextLength > a.plaintextLength ? b : a));
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function run() {
  const btn = $<HTMLButtonElement>("bx-run");
  btn.disabled = true;
  const out = $("bx-facts");
  const sh = S.share!;
  const se = largestSeries();
  const plan = planSeries(se);
  const rows: [string, string, string?][] = [];
  const show = (extra?: string) => facts(out, extra ? [...rows, ["", extra]] : rows);
  try {
    show("Downloading…");
    const pool = getDecoderPool();
    const t0 = performance.now();
    const ct = await sh.resolver.fetchRange(plan);
    const tNet = performance.now() - t0;
    rows.push(["Download", `${n(ct.length)} bytes in ${Math.round(tNet)} ms, one Range request`]);
    show("Decrypting…");

    const times: number[] = [];
    let pt: Uint8Array = new Uint8Array(0);
    for (let k = 0; k < 3; k++) {
      const a = performance.now();
      pt = await sh.decryptor.decrypt(se, plan, ct);
      times.push(performance.now() - a);
    }
    storePlain(se, 0, pt);
    const dms = median(times);
    rows.push(["Decrypt", `${se.recordCount} records in ${dms.toFixed(1)} ms, ${Math.round(pt.length / 1e3 / dms)} MB/s (WebCrypto AES-256-GCM, median of 3 runs)`]);
    show("Decoding…");

    const p = await pool;
    const files = se.instances.map((x) => pt.subarray(x.offset, x.offset + x.length));
    await p.decode(files[0].slice()); // warm-up: first use of each worker's wasm
    const a = performance.now();
    const imgs = await Promise.all(files.map((f) => p.decode(f.slice())));
    const all = performance.now() - a;
    const im = imgs[0];
    const ts = im.transferSyntax;
    rows.push([
      "Decode",
      `${imgs.length} images of ${im.columns}×${im.rows}, ${im.bitsAllocated}-bit, ${tsNames[ts] ?? ts}: ${Math.round(all)} ms in all on ${p.size} workers; ${median(imgs.map((x) => x.decodeMs)).toFixed(1)} ms median per image inside the decoder`,
    ]);
    rows.push(["Browser", navigator.userAgent.replace(/^Mozilla\/5\.0 /, "")]);
    show(UNCOMPRESSED.has(ts) ? "The sample's images are uncompressed, so decoding here is mostly parsing and copying. The full report times the compressed syntaxes." : undefined);
  } catch (e) {
    show(`Stopped: ${(e as Error).message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Run it again";
  }
}

export function initCodecs() {
  loadData();
  $("bx-run").addEventListener("click", run);
  on("ready", () => {
    const se = largestSeries();
    $("bx-what").textContent = `Uses series “${se.description ?? se.modality ?? ""}”: ${se.instances.length} images, ${formatBytes(se.plaintextLength)}. The page fetches the whole series file, times WebCrypto decryption of its records, then decodes every image in Web Workers.`;
    $<HTMLButtonElement>("bx-run").disabled = false;
  });
}
