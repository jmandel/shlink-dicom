// Build-time data and pages for /how (called from web/build.ts):
//
//   how/data.json         codec coverage by transfer syntax (codec-corpus report + cases), the
//                         IDC prevalence estimate, and per-format decode speed from the last full
//                         benchmark run
//   how/spec.html         PROPOSAL.md, rendered
//   how/series-file.html  reference/series-file.ts      how/test-vector.html  reference/test-vector.ts
//   how/receiver.mjs      the 50-line receiver shown on the page
//   how/bench.html        the full benchmark report (codecs/bench/report.mjs on the last full run)
//   how/corpus.html       the codec corpus: what it is, and every case with its outcome
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const TS_NAMES: Record<string, string> = {
  "1.2.840.10008.1.2": "Implicit VR Little Endian",
  "1.2.840.10008.1.2.1": "Explicit VR Little Endian",
  "1.2.840.10008.1.2.2": "Explicit VR Big Endian",
  "1.2.840.10008.1.2.1.99": "Deflated Explicit VR Little Endian",
  "1.2.840.10008.1.2.5": "RLE Lossless",
  "1.2.840.10008.1.2.4.50": "JPEG Baseline",
  "1.2.840.10008.1.2.4.51": "JPEG Extended",
  "1.2.840.10008.1.2.4.57": "JPEG Lossless",
  "1.2.840.10008.1.2.4.70": "JPEG Lossless SV1",
  "1.2.840.10008.1.2.4.80": "JPEG-LS Lossless",
  "1.2.840.10008.1.2.4.81": "JPEG-LS Near-Lossless",
  "1.2.840.10008.1.2.4.90": "JPEG 2000 Lossless",
  "1.2.840.10008.1.2.4.91": "JPEG 2000",
  "1.2.840.10008.1.2.4.201": "HTJ2K Lossless",
  "1.2.840.10008.1.2.4.202": "HTJ2K Lossless RPCL",
  "1.2.840.10008.1.2.4.203": "HTJ2K",
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const slug = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<link rel="stylesheet" href="../assets/base.css" />
<style>
.doc { max-width: 860px; margin: 0 auto; padding: 24px var(--gutter) 48px; }
.doc .back { display: inline-block; margin-bottom: 16px; }
.doc h1 { font-size: 1.75rem; } .doc h2 { margin-top: 1.6em; } .doc h3 { margin-top: 1.3em; }
.doc pre { background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 12px; overflow-x: auto; font: 13px/1.5 var(--mono); }
.doc code { font-family: var(--mono); font-size: 0.9em; }
.doc :not(pre) > code { background: var(--surface-2); padding: 1px 4px; border-radius: 4px; overflow-wrap: anywhere; }
.doc table { border-collapse: collapse; display: block; overflow-x: auto; font-size: 0.9rem; margin: 0 0 1em; }
.doc th, .doc td { border-bottom: 1px solid var(--border); padding: 6px 8px; text-align: left; vertical-align: top; }
.doc th { background: var(--surface-2); }
.doc .num { text-align: right; font-variant-numeric: tabular-nums; }
.doc .bad { color: var(--danger); }
.doc li { margin-bottom: 0.3em; }
</style>
</head>
<body>
<main class="doc">
<a class="back" href="../how">← How it works</a>
${body}
</main>
</body>
</html>
`;
}

function markdownPage(title: string, md: string): string {
  let html = Bun.markdown.html(md);
  html = html.replace(/<h([1-4])>(.*?)<\/h\1>/g, (_m, n, inner) => `<h${n} id="${slug(inner)}">${inner}</h${n}>`);
  return page(title, html);
}

function codePage(title: string, intro: string, code: string): string {
  return page(title, `<h1>${esc(title)}</h1>\n<p>${intro}</p>\n<pre><code>${esc(code)}</code></pre>`);
}

type Case = Record<string, any>;

function loadCases(root: string): Map<string, Case> {
  const out = new Map<string, Case>();
  const dir = `${root}codec-corpus/formats`;
  for (const fmt of readdirSync(dir)) {
    const f = `${dir}/${fmt}/cases.json`;
    if (!existsSync(f)) continue;
    for (const c of JSON.parse(readFileSync(f, "utf8")).cases) out.set(`${fmt}/${c.id}`, c);
  }
  return out;
}

// Pixel profile key, as codec-corpus/prevalence/scripts/pixprofile.py make_key().
const int = (v: unknown, d = 0) => {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : d;
};
function profileKey(ts: any, ph: any, ba: any, bs: any, pr: any, spp: any, pc: any, frames: any): string {
  const s = int(spp, 1);
  const p = s > 1 ? int(pc, 0) : 0;
  const fr = frames === "single" || frames === "multi" ? frames : int(frames, 1) > 1 ? "multi" : "single";
  return [String(ts ?? "").trim(), String(ph ?? "").trim(), int(ba), int(bs), int(pr), s, p, fr].join("|");
}

function parseCsv(text: string): Record<string, string>[] {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const cols = head.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));
}

/** Coverage by transfer syntax, plus the IDC study/series/instance estimate (as coverage.py, exact match). */
function codecCoverage(root: string, reportName: string) {
  const report = JSON.parse(readFileSync(`${root}codec-corpus/reports/${reportName}.json`, "utf8"));
  const cases = loadCases(root);
  const byTs = new Map<string, { pass: number; total: number }>();
  const profile = new Map<string, string[]>();
  for (const r of report.results) {
    const c = cases.get(`${r.format}/${r.case}`);
    if (!c || c.expect !== "decode" || r.outcome === "skipped") continue;
    const ts = String(c.transfer_syntax);
    const e = byTs.get(ts) ?? { pass: 0, total: 0 };
    e.total++;
    if (r.outcome === "pass") e.pass++;
    byTs.set(ts, e);
    const k = profileKey(c.transfer_syntax, c.photometric, c.bits_allocated, c.bits_stored, c.pixel_representation, c.samples_per_pixel, c.planar_configuration, c.frames ?? 1);
    profile.set(k, [...(profile.get(k) ?? []), r.outcome]);
  }
  const passing = (k: string) => {
    const o = profile.get(k);
    return !!o && o.includes("pass") && !o.some((x) => x === "fail" || x === "crash" || x === "unsupported");
  };
  const syntaxes = [...byTs.entries()]
    .map(([uid, v]) => ({ uid, name: TS_NAMES[uid] ?? uid, ...v }))
    .sort((a, b) => a.uid.localeCompare(b.uid, "en", { numeric: true }));

  let idc: any = null;
  const prof = `${root}codec-corpus/prevalence/profiles-idc.csv`;
  const sets = `${root}codec-corpus/prevalence/profiles-idc-sets.csv`;
  if (existsSync(prof) && existsSync(sets)) {
    let total = 0, ok = 0;
    for (const r of parseCsv(readFileSync(prof, "utf8"))) {
      const n = Number(r.instances);
      total += n;
      if (passing(profileKey(r.transfer_syntax, r.photometric, r.bits_allocated, r.bits_stored, r.pixel_representation, r.samples_per_pixel, r.planar_configuration, r.frames))) ok += n;
    }
    const level = (name: string) => {
      let n = 0, good = 0;
      for (const r of parseCsv(readFileSync(sets, "utf8"))) {
        if (r.level !== name) continue;
        const c = Number(r.count);
        n += c;
        if (r.profiles.split(";").every(passing)) good += c;
      }
      return { count: n, pct: (100 * good) / n };
    };
    idc = { instances: total, instancePct: (100 * ok) / total, series: level("series"), studies: level("study") };
  }
  return { report: { name: report.name, time: report.time }, syntaxes, idc, results: report.results, cases };
}

/** The most recent benchmark run that covered every format and ran in Chromium. */
function lastFullBench(root: string): { file: string; run: any } | null {
  const dir = `${root}codecs/bench/results`;
  if (!existsSync(dir)) return null;
  let best: { file: string; run: any } | null = null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f === "latest.json" || f === "baseline.json") continue;
    try {
      const run = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
      const s = run.selection ?? {};
      if (s.format || s.case || s.tag || !run.runners?.includes("chromium-worker")) continue;
      if (!best || run.started > best.run.started) best = { file: `${dir}/${f}`, run };
    } catch {}
  }
  return best;
}

function benchSummary(run: any) {
  const geo = (xs: number[]) => (xs.length ? Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length) : null);
  const fmts = new Map<string, { cases: number; simd: number[]; native: number[] }>();
  const fmtOf = new Map<string, string>(run.cases.map((c: any) => [c.id, c.fmt]));
  for (const c of run.cases) if (!fmts.has(c.fmt)) fmts.set(c.fmt, { cases: 0, simd: [], native: [] });
  for (const c of run.cases) fmts.get(c.fmt)!.cases++;
  for (const r of run.records) {
    if (!r.verify?.ok || !(r.mpix_per_s > 0)) continue;
    const f = fmts.get(fmtOf.get(r.case)!);
    if (!f) continue;
    if (r.runner === "chromium-worker" && r.build === "wasm-simd") f.simd.push(r.mpix_per_s);
    if (r.runner === "native" && r.build === "native") f.native.push(r.mpix_per_s);
  }
  return {
    id: run.id,
    started: run.started,
    cpu: run.env?.machine?.cpu ?? null,
    chromium: run.env?.toolchain?.chromium ?? null,
    formats: [...fmts.entries()].map(([fmt, v]) => ({ fmt, cases: v.cases, browserMpixS: geo(v.simd), nativeMpixS: geo(v.native) })),
  };
}

function corpusPage(root: string, cov: ReturnType<typeof codecCoverage>): string {
  const readme = readFileSync(`${root}codec-corpus/README.md`, "utf8");
  const rows = cov.results
    .map((r: any) => {
      const c = cov.cases.get(`${r.format}/${r.case}`) ?? {};
      const ok = r.outcome === "pass";
      return `<tr><td>${esc(r.format)}</td><td><code>${esc(r.case)}</code></td><td>${esc(TS_NAMES[c.transfer_syntax] ?? c.transfer_syntax ?? "")}</td><td>${c.rows ?? ""}×${c.columns ?? ""}${(c.frames ?? 1) > 1 ? ` × ${c.frames}` : ""}</td><td>${esc(c.expect ?? "")}</td><td class="${ok ? "" : "bad"}">${esc(r.outcome)}</td><td class="num">${r.max_abs_diff ?? ""}</td></tr>`;
    })
    .join("\n");
  let html = Bun.markdown.html(readme).replace(/<h([1-4])>(.*?)<\/h\1>/g, (_m, n, inner) => `<h${n} id="${slug(inner)}">${inner}</h${n}>`);
  html += `\n<h2 id="cases">Every case in report “${esc(cov.report.name)}” (${esc(cov.report.time)})</h2>
<p>“decode” cases must match the reference decode within the case's tolerance; “error” cases are damaged files that must be refused cleanly. The last column is the largest pixel difference from the reference.</p>
<table><thead><tr><th>Format</th><th>Case</th><th>Transfer syntax</th><th>Size</th><th>Expect</th><th>Outcome</th><th class="num">Max diff</th></tr></thead><tbody>
${rows}
</tbody></table>`;
  return page("Codec corpus", html);
}

export async function bakeHow(root: string, out: string) {
  const dir = `${out}/how`;
  mkdirSync(dir, { recursive: true });

  const cov = codecCoverage(root, "foundation");
  const full = lastFullBench(root);
  const data = {
    codecs: { report: cov.report, syntaxes: cov.syntaxes, idc: cov.idc },
    bench: full ? benchSummary(full.run) : null,
  };
  writeFileSync(`${dir}/data.json`, JSON.stringify(data));

  writeFileSync(`${dir}/spec.html`, markdownPage("Sharing full DICOM studies through SMART Health Links", readFileSync(`${root}PROPOSAL.md`, "utf8")));
  writeFileSync(
    `${dir}/series-file.html`,
    codePage("reference/series-file.ts", "The reference implementation of series-file encryption and range decryption (PROPOSAL.md §9), using only WebCrypto.", readFileSync(`${root}reference/series-file.ts`, "utf8")),
  );
  writeFileSync(
    `${dir}/test-vector.html`,
    codePage("reference/test-vector.ts", "Produces the test vector in PROPOSAL.md appendix B and checks range reads and tampering. Run it with <code>bun reference/test-vector.ts</code>.", readFileSync(`${root}reference/test-vector.ts`, "utf8")),
  );
  writeFileSync(`${dir}/receiver.mjs`, readFileSync(`${root}web/how/receiver.js`, "utf8"));
  writeFileSync(`${dir}/corpus.html`, corpusPage(root, cov));

  if (full) {
    const { writeReport } = await import(`${root}codecs/bench/report.mjs`);
    writeReport(full.run, null, null, `${dir}/bench.html`);
  }
}
