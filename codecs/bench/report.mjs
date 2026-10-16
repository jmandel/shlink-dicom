#!/usr/bin/env node
// Turns a results file into report.html and a terminal table.
//   node codecs/bench/report.mjs [results/<run>.json] [--baseline results/<other>.json]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const BENCH = join(fileURLToPath(import.meta.url), "..");
const WASM_ALL = ["wasm-base", "wasm-simd", "wasm-relaxed", "wasm-base-opt", "wasm-simd-opt"];
let WASM = WASM_ALL.slice(0, 3);
/** Show only the wasm builds this run has (always base, simd, relaxed). */
function setBuilds(result) {
  const present = new Set(result.records.map((r) => r.build));
  WASM = WASM_ALL.filter((b, i) => i < 3 || present.has(b));
}
const short = (b) => b.replace("wasm-", "").replace("-opt", "+opt");
const THREAD_LIMIT = 1.3; // reference records with cpu/wall above this used several threads

export const med = (r) => r?.stats?.total?.median;
const key = (r) => `${r.case}|${r.runner}|${r.build}`;

export function findBaseline(path, result) {
  const p = path ? resolve(path) : join(BENCH, "results", "baseline.json");
  if (!existsSync(p)) return null;
  const b = JSON.parse(readFileSync(p, "utf8"));
  return b.id === result.id ? null : b;
}

/** Same case+runner+build in both runs. A change counts only when it is >= 5% and the
 *  p10-p90 ranges of the two runs do not overlap. */
export function compare(cur, base) {
  const before = new Map(base.records.filter((r) => r.status === 0).map((r) => [key(r), r]));
  const rows = [];
  for (const r of cur.records) {
    const b = before.get(key(r));
    if (!b || r.status !== 0 || !r.stats) continue;
    const ratio = r.stats.total.median / b.stats.total.median;
    let kind = "same";
    if (ratio > 1.05 && r.stats.total.p10 > b.stats.total.p90) kind = "regression";
    else if (ratio < 0.95 && r.stats.total.p90 < b.stats.total.p10) kind = "improvement";
    rows.push({ case: r.case, runner: r.runner, build: r.build, ratio, kind, now: r.stats.total.median, before: b.stats.total.median });
  }
  const map = new Map(rows.map((x) => [key(x), x]));
  return { rows, map, regressions: rows.filter((x) => x.kind === "regression"), improvements: rows.filter((x) => x.kind === "improvement"), source_changed: cur.env?.git?.codecs_source?.sha256 !== base.env?.git?.codecs_source?.sha256 };
}

/** The wasm runner shown in the summary: Chromium worker when it ran, else Node. */
function wasmRunner(result) {
  return result.records.some((r) => r.runner === "chromium-worker") ? "chromium-worker" : "node";
}

function index(result) {
  const m = new Map();
  for (const r of result.records) m.set(key(r), r);
  const get = (c, runner, build) => { const r = m.get(`${c}|${runner}|${build}`); return r && r.status === 0 ? r : null; };
  const refs = (c) => result.records.filter((r) => r.case === c && r.runner === "ref");
  const cwasm = (c) => result.records.filter((r) => r.case === c && r.runner === "chromium-cwasm");
  // Native C: fastest single-threaded library, GDCM excluded (whole file, threaded).
  const bestRef = (c) => refs(c).filter((r) => r.status === 0 && r.family !== "gdcm" && (r.cpu_over_wall ?? 1) <= THREAD_LIMIT)
    .sort((x, y) => med(x) - med(y))[0] ?? null;
  // C in wasm: fastest library whose output passed the oracle check; otherwise the fastest one
  // that decoded at all, marked as unverified.
  const bestCwasm = (c) => {
    const ok = cwasm(c).filter((r) => r.status === 0).sort((x, y) => med(x) - med(y));
    return ok.find((r) => r.verify?.ok) ?? ok[0] ?? null;
  };
  return { get, refs, cwasm, bestRef, bestCwasm };
}

const geo = (xs) => (xs.length ? Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length) : NaN);
const fmtMs = (x) => (x == null || Number.isNaN(x) ? "-" : x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x >= 1 ? x.toFixed(2) : x.toFixed(3));
const fmtX = (x) => (x == null || Number.isNaN(x) ? "-" : x >= 10 ? x.toFixed(0) + "×" : x.toFixed(2) + "×");
const codecMs = (r) => r?.stats?.codec?.median;

/** Per-format geometric means and per-case rows used by both outputs.
 *  Two separate comparisons, never mixed in one ratio:
 *    vs_cwasm:   our wasm-simd codec stage ÷ C compiled to wasm, same browser and worker
 *    vs_nativec: our native codec stage ÷ native C, timed in-process from Python */
export function table(result) {
  setBuilds(result);
  const { get, bestRef, bestCwasm } = index(result);
  const wr = wasmRunner(result);
  const rows = result.cases.map((c) => {
    const nat = get(c.id, "native", "native");
    const w = Object.fromEntries(WASM.map((b) => [b, get(c.id, wr, b)]));
    const ref = c.fmt === "uncompressed" ? null : bestRef(c.id);
    const cw = bestCwasm(c.id);
    const simdBrowser = get(c.id, "chromium-worker", "wasm-simd");
    return {
      c, nat, w, ref, cw, simdBrowser,
      simd_over_native: w["wasm-simd"] && nat ? med(w["wasm-simd"]) / med(nat) : null,
      vs_nativec: nat && ref ? codecMs(nat) / med(ref) : null,
      vs_cwasm: simdBrowser && cw ? codecMs(simdBrowser) / med(cw) : null,
    };
  });
  const formats = [...new Set(result.cases.map((c) => c.fmt))].map((fmt) => {
    const rs = rows.filter((r) => r.c.fmt === fmt);
    const pick = (k) => geo(rs.map((r) => r[k]).filter((x) => x > 0));
    const big = rs.filter((r) => r.nat).sort((x, y) => y.c.rows * y.c.columns * y.c.frames - x.c.rows * x.c.columns * x.c.frames)[0];
    return {
      fmt, n: rs.length,
      simd_over_native: pick("simd_over_native"),
      base_over_simd: geo(rs.map((r) => (r.w["wasm-base"] && r.w["wasm-simd"] ? med(r.w["wasm-base"]) / med(r.w["wasm-simd"]) : null)).filter((x) => x > 0)),
      simd_over_opt: geo(rs.map((r) => (r.w["wasm-simd-opt"] && r.w["wasm-simd"] ? med(r.w["wasm-simd"]) / med(r.w["wasm-simd-opt"]) : null)).filter((x) => x > 0)),
      base_over_baseopt: geo(rs.map((r) => (r.w["wasm-base-opt"] && r.w["wasm-base"] ? med(r.w["wasm-base"]) / med(r.w["wasm-base-opt"]) : null)).filter((x) => x > 0)),
      vs_cwasm: pick("vs_cwasm"), vs_cwasm_n: rs.filter((r) => r.vs_cwasm).length,
      vs_nativec: pick("vs_nativec"),
      big_native_mps: big?.nat?.mpix_per_s, big_simd_mps: big?.w["wasm-simd"]?.mpix_per_s, big_label: big?.c.label,
    };
  });
  return { rows, formats, wasmRunner: wr };
}

export function terminalSummary(result, baseline, cmp) {
  const { rows, formats, wasmRunner: wr } = table(result);
  const pad = (s, n) => String(s).padEnd(n), lp = (s, n) => String(s).padStart(n);
  const short = (s) => (s ?? "-").replace(/ \(.*\)$/, "").slice(0, 16);
  const out = [];
  const e = result.env ?? {};
  if (Math.max(e.load_avg?.start ?? 0, e.load_avg?.end ?? 0) > 1.5 || Math.max(e.other_bench_runs?.start ?? 0, e.other_bench_runs?.end ?? 0) > 0)
    out.push(`\nNOISY RUN: load average ${e.load_avg?.start?.toFixed(1)} -> ${e.load_avg?.end?.toFixed(1)}, other bench runs ${e.other_bench_runs?.start ?? "?"} -> ${e.other_bench_runs?.end ?? "?"}`);
  out.push(`\nmedian ms. Whole-file decode: native, base/simd/relaxed (wasm, ${wr}).`);
  out.push(`vs C in wasm (same browser): our wasm-simd codec stage ÷ fastest Cornerstone C/C++ codec compiled to wasm, same Chromium worker.`);
  out.push(`vs native C (Python in-process): our native codec stage ÷ fastest single-threaded native C/C++ library. The two are never mixed.`);
  out.push(pad("case", 44) + lp("MP", 6) + lp("native", 8) + WASM.map((b) => lp(short(b), 9)).join("") + lp("simd/nat", 9) +
    " │" + lp("simd codec", 11) + lp("C wasm", 8) + " " + pad("lib", 16) + lp("÷Cwasm", 7) +
    " │" + lp("nat codec", 10) + lp("native C", 9) + " " + pad("lib", 16) + lp("÷natC", 7) + (cmp ? lp("Δ base", 8) : ""));
  let fmt = null;
  for (const r of rows) {
    if (r.c.fmt !== fmt) { fmt = r.c.fmt; out.push(`-- ${fmt}`); }
    const d = cmp?.map.get(`${r.c.id}|${wr}|wasm-simd`);
    const flag = r.nat?.verify?.ok === false || Object.values(r.w).some((x) => x?.verify?.ok === false) ? " VERIFY FAILED" : "";
    const cwFlag = r.cw && !r.cw.verify?.ok ? "≠" : "";
    out.push(pad(r.c.label.slice(0, 42), 44) + lp(((r.c.rows * r.c.columns * r.c.frames) / 1e6).toFixed(2), 6) + lp(fmtMs(med(r.nat)), 8) +
      WASM.map((b) => lp(fmtMs(med(r.w[b])), 9)).join("") + lp(fmtX(r.simd_over_native), 9) +
      " │" + lp(fmtMs(codecMs(r.simdBrowser)), 11) + lp(fmtMs(med(r.cw)) + cwFlag, 8) + " " + pad(r.cw ? short(r.cw.build) : "-", 16) + lp(fmtX(r.vs_cwasm), 7) +
      " │" + lp(fmtMs(r.ref ? codecMs(r.nat) : null), 10) + lp(fmtMs(med(r.ref)), 9) + " " + pad(r.ref ? short(r.ref.build) : "-", 16) + lp(fmtX(r.vs_nativec), 7) +
      (cmp ? lp(d ? `${d.ratio >= 1 ? "+" : ""}${((d.ratio - 1) * 100).toFixed(0)}%${d.kind === "regression" ? "!" : d.kind === "improvement" ? "*" : ""}` : "-", 8) : "") + flag);
  }
  out.push("≠ = that C-in-wasm library's output did not match the oracle within max_abs (time shown, not verified)");
  out.push("\nper format (geometric means; MP/s for the largest case)");
  out.push(pad("format", 15) + lp("cases", 6) + lp("simd/native", 12) + lp("base/simd", 10) + lp("simd/+opt", 10) + lp("base/+opt", 10) + lp("vs C in wasm", 13) + lp("vs native C", 12) + lp("native MP/s", 12) + lp("simd MP/s", 10) + "  largest case");
  for (const f of formats) {
    out.push(pad(f.fmt, 15) + lp(f.n, 6) + lp(fmtX(f.simd_over_native), 12) + lp(fmtX(f.base_over_simd), 10) + lp(fmtX(f.simd_over_opt), 10) + lp(fmtX(f.base_over_baseopt), 10) + lp(fmtX(f.vs_cwasm) + (f.vs_cwasm_n && f.vs_cwasm_n < f.n ? ` (${f.vs_cwasm_n})` : ""), 13) + lp(fmtX(f.vs_nativec), 12) +
      lp(f.big_native_mps?.toFixed(1) ?? "-", 12) + lp(f.big_simd_mps?.toFixed(1) ?? "-", 10) + "  " + (f.big_label ?? ""));
  }
  const sizes = Object.entries(result.builds).filter(([, b]) => b.bytes);
  if (sizes.length) out.push("\nwasm size (custom sections stripped): " + sizes.map(([k, b]) => `${k} ${(b.bytes / 1024).toFixed(0)} KiB raw, ${(b.bytes_gzip / 1024).toFixed(0)} KiB gzip`).join("; "));
  if (cmp) {
    out.push(`\nvs baseline ${baseline.id}${cmp.source_changed ? "" : " (decoder source unchanged: differences are noise)"}: ${cmp.regressions.length} regression(s), ${cmp.improvements.length} improvement(s)`);
    for (const x of cmp.regressions) out.push(`  REGRESSION ${x.runner} ${x.build} ${x.case}: ${fmtMs(x.before)} -> ${fmtMs(x.now)} ms (+${((x.ratio - 1) * 100).toFixed(0)}%)`);
    for (const x of cmp.improvements.slice(0, 15)) out.push(`  improved   ${x.runner} ${x.build} ${x.case}: ${fmtMs(x.before)} -> ${fmtMs(x.now)} ms (${((x.ratio - 1) * 100).toFixed(0)}%)`);
  }
  return out.join("\n");
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

function cell(r, cmpRow) {
  if (!r) return `<td class="num muted">–</td>`;
  const s = r.stats.total;
  const bad = r.verify && !r.verify.ok;
  const tip = `median ${fmtMs(s.median)} ms, p10 ${fmtMs(s.p10)}, p90 ${fmtMs(s.p90)}, n=${r.n}; first decode ${fmtMs(r.cold_ms)} ms; ${r.mpix_per_s?.toFixed(1)} MP/s` +
    (r.verify ? `; verify: ${r.verify.ok ? (r.verify.exact ? "exact" : `within max_abs (max diff ${r.verify.max_abs_diff})`) : r.verify.reason}` : "") +
    (cmpRow ? `; baseline ${fmtMs(cmpRow.before)} ms (${cmpRow.ratio >= 1 ? "+" : ""}${((cmpRow.ratio - 1) * 100).toFixed(1)}%)` : "");
  const delta = cmpRow && cmpRow.kind !== "same" ? `<span class="delta ${cmpRow.kind}">${cmpRow.kind === "regression" ? "▲" : "▼"}${Math.abs((cmpRow.ratio - 1) * 100).toFixed(0)}%</span>` : "";
  return `<td class="num${bad ? " bad" : ""}" title="${esc(tip)}">${bad ? "✗ " : ""}${fmtMs(s.median)}${delta}</td>`;
}

function stageBar(r) {
  if (!r?.stats?.parse) return `<td></td>`;
  const st = r.stats, tot = st.parse.median + st.codec.median + st.normalise.median || 1;
  const seg = (k, cls) => {
    const w = (st[k].median / tot) * 100;
    return w < 0.05 ? "" : `<span class="seg ${cls}" style="width:${w.toFixed(2)}%" title="${k}: ${fmtMs(st[k].median)} ms (${w.toFixed(0)}%)"></span>`;
  };
  const pct = (k) => ((st[k].median / tot) * 100).toFixed(0);
  return `<td class="bar-cell"><div class="bar">${seg("parse", "s-parse")}${seg("codec", "s-codec")}${seg("normalise", "s-norm")}</div><div class="bar-label">${pct("parse")} / ${pct("codec")} / ${pct("normalise")}%</div></td>`;
}

export function writeReport(result, baseline, cmp, file = join(BENCH, "report.html")) {
  const { rows, formats, wasmRunner: wr } = table(result);
  const { get, refs, cwasm } = index(result);
  const e = result.env ?? {};
  const failures = result.records.filter((r) => r.runner !== "ref" && r.runner !== "chromium-cwasm" && (r.status !== 0 || (r.verify && !r.verify.ok)));
  const fmtRows = formats.map((f) => `<tr><td>${esc(f.fmt)}</td><td class="num">${f.n}</td><td class="num">${fmtX(f.simd_over_native)}</td><td class="num">${fmtX(f.base_over_simd)}</td>${WASM.includes("wasm-simd-opt") ? `<td class="num">${fmtX(f.simd_over_opt)}</td>` : ""}<td class="num">${fmtX(f.vs_cwasm)}${f.vs_cwasm_n && f.vs_cwasm_n < f.n ? ` <span class="muted">(${f.vs_cwasm_n} of ${f.n} cases)</span>` : ""}</td><td class="num">${fmtX(f.vs_nativec)}</td><td class="num">${f.big_native_mps?.toFixed(1) ?? "–"}</td><td class="num">${f.big_simd_mps?.toFixed(1) ?? "–"}</td><td>${esc(f.big_label)}</td></tr>`).join("");
  const sections = formats.map((f) => {
    const body = rows.filter((r) => r.c.fmt === f.fmt).map((r) => {
      const c = r.c;
      const cm = (runner, build) => cmp?.map.get(`${c.id}|${runner}|${build}`);
      const refList = refs(c.id).map((x) => x.status === 0
        ? `${esc(x.build)} ${fmtMs(med(x))} ms${(x.cpu_over_wall ?? 1) > THREAD_LIMIT ? ` <span class="muted">(${x.cpu_over_wall}× CPU: threaded)</span>` : ""}`
        : `${esc(x.build)} <span class="muted">failed</span>`).join("<br>");
      const cwList = cwasm(c.id).map((x) => x.status === 0
        ? `${esc(x.build)} ${fmtMs(med(x))} ms${x.verify?.ok ? "" : ` <span class="flag" title="${esc(x.verify?.reason)}">≠ oracle${x.verify?.max_abs_diff != null ? ` (max diff ${x.verify.max_abs_diff})` : ""}</span>`}`
        : `${esc(x.build)} <span class="muted" title="${esc(x.msg)}">does not decode this case</span>`).join("<br>");
      const main = get(c.id, "chromium-main", "wasm-simd"), node = get(c.id, "node", "wasm-simd");
      return `<tr>
        <td><div class="case">${esc(c.label)}</div><div class="id">${esc(c.id)}</div></td>
        <td class="num">${((c.rows * c.columns * c.frames) / 1e6).toFixed(2)}<div class="id">${c.columns}×${c.rows}${c.frames > 1 ? "×" + c.frames : ""}</div></td>
        ${cell(r.nat, cm("native", "native"))}
        ${WASM.map((b) => cell(r.w[b], cm(wr, b))).join("")}
        ${cell(main, cm("chromium-main", "wasm-simd"))}${cell(node, cm("node", "wasm-simd"))}
        <td class="num">${fmtX(r.simd_over_native)}</td>
        ${stageBar(r.w["wasm-simd"])}${stageBar(r.nat)}
        <td class="num sep">${fmtMs(codecMs(r.simdBrowser))}</td><td class="num">${fmtX(r.vs_cwasm)}</td>
        <td class="refs">${cwList || '<span class="muted">no package for this format</span>'}</td>
        <td class="num sep">${fmtMs(r.ref ? codecMs(r.nat) : null)}</td><td class="num">${fmtX(r.vs_nativec)}</td>
        <td class="refs">${refList || '<span class="muted">–</span>'}</td></tr>`;
    }).join("");
    return `<section><h2>${esc(f.fmt)}</h2><div class="scroll"><table>
      <thead><tr><th rowspan="2">Case</th><th rowspan="2" class="num">MP</th><th rowspan="2" class="num">Native</th>
      <th colspan="${WASM.length}" class="grp">wasm, ${esc(wr)} (ms)</th><th rowspan="2" class="num">Main thread simd</th><th rowspan="2" class="num">Node simd</th>
      <th rowspan="2" class="num">simd ÷ native</th><th colspan="2" class="grp">Stages: parse / codec / normalise</th>
      <th colspan="3" class="grp sep">vs C compiled to wasm (same browser)</th><th colspan="3" class="grp sep">vs native C (Python in-process)</th></tr>
      <tr>${WASM.map((b) => `<th class="num">${short(b)}</th>`).join("")}<th>wasm simd</th><th>native</th>
      <th class="num sep">Our wasm-simd codec (ms)</th><th class="num">Ours ÷ fastest</th><th>C/C++ in wasm, frame decode (ms)</th>
      <th class="num sep">Our native codec (ms)</th><th class="num">Ours ÷ fastest</th><th>Native C/C++, frame decode (ms)</th></tr></thead>
      <tbody>${body}</tbody></table></div></section>`;
  }).join("");
  const sizes = Object.entries(result.builds ?? {}).map(([k, b]) => `<tr><td>${esc(k)}</td><td>${esc(b.about)}</td><td><code>${esc(b.rustflags || "–")}</code>${b.wasm_opt ? `<br><code>wasm-opt ${esc(b.wasm_opt)}</code>` : ""}</td><td class="num">${b.bytes ? (b.bytes / 1024).toFixed(0) + " KiB" : "–"}</td><td class="num">${b.bytes_gzip ? (b.bytes_gzip / 1024).toFixed(0) + " KiB" : "–"}</td><td class="num">${b.bytes_with_debug ? (b.bytes_with_debug / 2 ** 20).toFixed(1) + " MiB" : "–"}</td><td class="num">${b.simd_instructions ?? "–"}</td></tr>`).join("");
  const regress = cmp ? `<section><h2>Compared with ${esc(baseline.id)}</h2>
    <p>${cmp.regressions.length} regression(s) and ${cmp.improvements.length} improvement(s) among ${cmp.rows.length} matching measurements. A change is marked only when it is at least 5% and the p10–p90 ranges of the two runs do not overlap.${cmp.source_changed ? "" : " <strong>The decoder source is the same in both runs</strong>, so any marked change is machine noise."}</p>
    ${cmp.regressions.length ? `<ul class="list">${cmp.regressions.map((x) => `<li><span class="delta regression">▲${((x.ratio - 1) * 100).toFixed(0)}%</span> ${esc(x.runner)} ${esc(x.build)} ${esc(x.case)}: ${fmtMs(x.before)} → ${fmtMs(x.now)} ms</li>`).join("")}</ul>` : ""}
    ${cmp.improvements.length ? `<details><summary>Improvements</summary><ul class="list">${cmp.improvements.map((x) => `<li><span class="delta improvement">▼${((1 - x.ratio) * 100).toFixed(0)}%</span> ${esc(x.runner)} ${esc(x.build)} ${esc(x.case)}: ${fmtMs(x.before)} → ${fmtMs(x.now)} ms</li>`).join("")}</ul></details>` : ""}</section>` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Decoder benchmark</title><style>
:root{color-scheme:light;--bg:#fcfcfb;--fg:#0b0b0b;--muted:#6b6a66;--line:#e4e3df;--head:#f3f2ef;--parse:#2a78d6;--codec:#eb6834;--norm:#1baf7a;--bad:#c62828;--good:#1b7f3a;--badbg:#fdecea;--goodbg:#e8f5ec}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#1a1a19;--fg:#f0efec;--muted:#a3a29a;--line:#34332f;--head:#24231f;--parse:#3987e5;--codec:#d95926;--norm:#199e70;--bad:#ef6b6b;--good:#5cc47e;--badbg:#3a1f1f;--goodbg:#1d3324}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#1a1a19;--fg:#f0efec;--muted:#a3a29a;--line:#34332f;--head:#24231f;--parse:#3987e5;--codec:#d95926;--norm:#199e70;--bad:#ef6b6b;--good:#5cc47e;--badbg:#3a1f1f;--goodbg:#1d3324}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0 auto;padding:16px;max-width:1500px}
h1{font-size:22px;margin:8px 0 4px}h2{font-size:17px;margin:28px 0 8px}p{max-width:80ch}
.muted,.id{color:var(--muted)}.id{font-size:11px;font-family:ui-monospace,monospace;word-break:break-all}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--line);padding:5px 8px;vertical-align:top;text-align:left}
th{background:var(--head);font-weight:600;font-size:12px}th.grp{text-align:center}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td.bad{color:var(--bad);font-weight:600}.case{font-weight:500}.refs{font-size:12px;min-width:220px}
.bar-cell{min-width:120px}.bar{display:flex;gap:2px;height:10px;width:120px}.seg{display:block;height:100%;border-radius:2px}
.s-parse{background:var(--parse)}.s-codec{background:var(--codec)}.s-norm{background:var(--norm)}.bar-label{font-size:11px;color:var(--muted)}
.legend span{display:inline-flex;align-items:center;gap:6px;margin-right:16px}.legend i{width:12px;height:10px;border-radius:2px;display:inline-block}
.delta{font-size:11px;margin-left:4px;padding:0 3px;border-radius:3px}.delta.regression{color:var(--bad);background:var(--badbg)}.delta.improvement{color:var(--good);background:var(--goodbg)}
.list{padding-left:18px}.flag{color:var(--bad);font-size:11px}th.sep,td.sep{border-left:1px solid var(--line)}.meta td{border:0;padding:2px 12px 2px 0}code{font-size:12px}.fail{color:var(--bad)}
</style></head><body>
<h1>Decoder benchmark</h1>
<p class="muted">Run ${esc(result.id)} · ${esc(e.machine?.cpu)} (${e.machine?.logical_cpus} threads, governor ${esc(e.machine?.governor)}) · Chromium ${esc(e.browser?.chromium ?? "–")} · Node ${esc(e.toolchain?.node)} · ${esc(e.toolchain?.rustc)} · decoder source ${esc(e.git?.codecs_source?.sha256)} · git ${esc(e.git?.head)}${e.git?.dirty_files ? ` (+${e.git.dirty_files} uncommitted)` : ""} · manifest v${result.manifest_version}</p>
<p>Times are the median of ${result.options.min_runs}–${result.options.max_runs} measured decodes after ${result.options.warmup} warm-up decodes (in wasm, at least ${result.options.warmup_ms ?? 0} ms of them), timed inside the decoder around <code>decode_file</code> (input already in memory). Hover a time for p10/p90, run count, first-decode time and verification. Every result was checked against the corpus oracle; a failed check shows ✗ in red. C/C++ libraries are timed on the frame codestreams only, so they are compared with our <em>codec</em> stage, in two separate comparisons: compiled to wasm in the same browser worker, and native from Python. GDCM decodes the whole file and may use threads, so it is listed but never used for a ratio. A C-in-wasm result marked ≠ did not match the oracle within the case's max_abs.</p>
${Math.max(e.load_avg?.start ?? 0, e.load_avg?.end ?? 0) > 1.5 || Math.max(e.other_bench_runs?.start ?? 0, e.other_bench_runs?.end ?? 0) > 0
  ? `<p class="fail"><strong>Noisy run:</strong> the machine was busy (1-minute load average ${e.load_avg.start.toFixed(1)} at start, ${e.load_avg.end.toFixed(1)} at end${e.other_bench_runs ? `; other bench runs in progress: ${e.other_bench_runs.start} at start, ${e.other_bench_runs.end} at end` : ""}). Expect more noise than usual; re-run on a quiet machine before trusting small differences.</p>` : ""}
${failures.length ? `<p class="fail"><strong>${failures.length} result(s) failed or did not verify:</strong> ${failures.map((r) => esc(`${r.runner} ${r.build} ${r.case}: ${r.msg ?? r.verify?.reason}`)).join("; ")}</p>` : ""}
${regress}
<section><h2>By format</h2><p class="muted">Geometric means over the format's cases. The two comparisons with C/C++ libraries are kept apart and never mixed in one ratio. <strong>vs C compiled to wasm (same browser)</strong>: our wasm-simd codec stage ÷ the fastest Cornerstone codec package (C/C++ built with Emscripten) decoding the same frame codestreams in the same Chromium worker; this is the browser alternative to our decoder. <strong>vs native C (Python in-process)</strong>: our native codec stage ÷ the fastest single-threaded native library. Below 1× means ours is faster.</p><div class="scroll"><table>
<thead><tr><th>Format</th><th class="num">Cases</th><th class="num">simd ÷ native</th><th class="num">base ÷ simd</th>${WASM.includes("wasm-simd-opt") ? '<th class="num">simd ÷ simd+opt</th>' : ""}<th class="num">vs C compiled to wasm (same browser)</th><th class="num">vs native C (Python in-process)</th><th class="num">Native MP/s</th><th class="num">simd MP/s</th><th>Largest case</th></tr></thead><tbody>${fmtRows}</tbody></table></div></section>
<p class="legend"><span><i style="background:var(--parse)"></i>parse + frame split</span><span><i style="background:var(--codec)"></i>codec</span><span><i style="background:var(--norm)"></i>normalise (planar, Bits Stored, YBR→RGB, copy)</span> <span class="muted">Uncompressed files have no codec call; their whole decode counts as parse.</span></p>
${sections}
<section><h2>Builds</h2><p class="muted">Release profile: opt-level 3, lto = "fat", codegen-units = 1, debug = 1. Sizes are with custom sections (names, DWARF) stripped; the unstripped files keep function names for profiling.</p><div class="scroll"><table><thead><tr><th>Build</th><th>What</th><th>RUSTFLAGS</th><th class="num">Size</th><th class="num">gzip -9</th><th class="num">With debug info</th><th class="num">v128 instructions</th></tr></thead><tbody>${sizes}</tbody></table></div>
<p class="muted">C/C++ in wasm (Cornerstone packages, decoder builds): ${esc(Object.entries(e.cwasm_packages ?? {}).map(([k, v]) => `${k} ${v.version}${v.simd_instructions == null ? "" : v.simd_instructions ? ` (uses wasm SIMD: ${v.simd_instructions} v128 instructions)` : " (no wasm SIMD)"}`).join("; ") || "not run")}.</p></section>
<section><h2>Environment</h2><table class="meta"><tbody>
<tr><td>Machine</td><td>${esc(JSON.stringify(e.machine))}</td></tr><tr><td>Browser</td><td>${esc(JSON.stringify(e.browser ?? {}))}</td></tr>
<tr><td>Native malloc</td><td><code>GLIBC_TUNABLES=${esc(e.native_malloc)}</code> (freed memory is kept, as in wasm)</td></tr>
<tr><td>Options</td><td>${esc(JSON.stringify(result.options))}</td></tr><tr><td>Git</td><td>${esc(JSON.stringify(e.git))}</td></tr></tbody></table></section>
</body></html>`;
  writeFileSync(file, html);
  return file;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: a, positionals } = parseArgs({ allowPositionals: true, options: { baseline: { type: "string" } } });
  const result = JSON.parse(readFileSync(positionals[0] ?? join(BENCH, "results", "latest.json"), "utf8"));
  const baseline = findBaseline(a.baseline, result);
  const cmp = baseline ? compare(result, baseline) : null;
  console.log(terminalSummary(result, baseline, cmp));
  console.log(`\nreport: ${writeReport(result, baseline, cmp)}`);
}
