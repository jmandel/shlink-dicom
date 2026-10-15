"""Summarise the long-tail sweep results into Markdown tables for prevalence/LONGTAIL.md.

    uv run python scripts/sources/longtail_report.py [--results ...] > prevalence/cache/longtail/report.md

Pass rate = pass / evaluated, where evaluated excludes no-pixel-data, download-error,
skipped-decoded-size and sweep-error. 95% intervals are Wilson score intervals.
When an instance appears more than once in the results (a re-check), the last record wins.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from longtail_register import TS_SHORT, signature  # noqa: E402

D = HERE.parent.parent / "prevalence" / "cache" / "longtail"
NOT_EVAL = {"no-pixel-data", "download-error", "skipped-decoded-size", "sweep-error"}
SOP = {
    "1.2.840.10008.5.1.4.1.1.2": "CT", "1.2.840.10008.5.1.4.1.1.2.1": "Enhanced CT",
    "1.2.840.10008.5.1.4.1.1.4": "MR", "1.2.840.10008.5.1.4.1.1.4.1": "Enhanced MR",
    "1.2.840.10008.5.1.4.1.1.128": "PET", "1.2.840.10008.5.1.4.1.1.130": "Enhanced PET",
    "1.2.840.10008.5.1.4.1.1.7": "Secondary Capture", "1.2.840.10008.5.1.4.1.1.7.2": "MF Grayscale Byte SC",
    "1.2.840.10008.5.1.4.1.1.7.3": "MF Grayscale Word SC", "1.2.840.10008.5.1.4.1.1.7.4": "MF True Color SC",
    "1.2.840.10008.5.1.4.1.1.66.4": "Segmentation", "1.2.840.10008.5.1.4.1.1.77.1.6": "VL WSI",
    "1.2.840.10008.5.1.4.1.1.1": "CR", "1.2.840.10008.5.1.4.1.1.1.1": "DX (presentation)",
    "1.2.840.10008.5.1.4.1.1.1.1.1": "DX (processing)", "1.2.840.10008.5.1.4.1.1.1.2": "MG (presentation)",
    "1.2.840.10008.5.1.4.1.1.1.2.1": "MG (processing)", "1.2.840.10008.5.1.4.1.1.13.1.3": "Breast Tomosynthesis",
    "1.2.840.10008.5.1.4.1.1.20": "NM", "1.2.840.10008.5.1.4.1.1.481.1": "RT Image",
    "1.2.840.10008.5.1.4.1.1.481.2": "RT Dose", "1.2.840.10008.5.1.4.1.1.6.1": "US", "1.2.840.10008.5.1.4.1.1.3.1": "US MF",
    "1.2.840.10008.5.1.4.1.1.12.1": "XA", "1.2.840.10008.5.1.4.1.1.12.2": "RF", "1.2.840.10008.5.1.4.1.1.30": "Parametric Map",
    "1.2.840.10008.5.1.4.1.1.4.4": "Legacy Converted Enhanced MR", "1.2.840.10008.5.1.4.1.1.2.2": "Legacy Converted Enhanced CT",
    "1.2.840.10008.5.1.4.1.1.128.1": "Legacy Converted Enhanced PET", "1.2.840.10008.5.1.4.1.1.77.1.4": "VL Photographic",
    "1.2.840.10008.5.1.4.1.1.88.11": "Basic Text SR",
}


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, c - h), min(1.0, c + h)


def pct(x: float) -> str:
    return f"{100 * x:.2f}%"


def rate_line(rs: list[dict]) -> str:
    ev = [r for r in rs if r["outcome"] not in NOT_EVAL]
    k = sum(r["outcome"] == "pass" for r in ev)
    lo, hi = wilson(k, len(ev))
    return f"{k} / {len(ev)} = {pct(k / len(ev)) if ev else '-'} (95% CI {pct(lo)}–{pct(hi)})"


def table(rs: list[dict], key, title: str, top: int = 40, only_with_fail: bool = False) -> str:
    g = defaultdict(list)
    for r in rs:
        g[key(r)].append(r)
    rows = []
    for k, v in g.items():
        ev = [r for r in v if r["outcome"] not in NOT_EVAL]
        p = sum(r["outcome"] == "pass" for r in ev)
        f = len(ev) - p
        if only_with_fail and f == 0:
            continue
        rows.append((k, len(v), len(ev), p, f, Counter(r["outcome"] for r in ev if r["outcome"] != "pass")))
    rows.sort(key=lambda x: (-x[4], -x[2]))
    out = [f"| {title} | Swept | Evaluated | Pass | Not pass | Not-pass outcomes |", "|---|---:|---:|---:|---:|---|"]
    for k, n, e, p, f, c in rows[:top]:
        out.append(f"| {str(k)[:90].replace('|', '/')} | {n} | {e} | {p} | {f} | "
                   + ", ".join(f"{o} {m}" for o, m in c.most_common()) + " |")
    if len(rows) > top:
        rest = rows[top:]
        out.append(f"| ({len(rest)} more strata) | {sum(x[1] for x in rest)} | {sum(x[2] for x in rest)} | "
                   f"{sum(x[3] for x in rest)} | {sum(x[4] for x in rest)} | |")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", type=Path, default=D / "results.jsonl")
    a = ap.parse_args()
    recs = {}
    for line in a.results.read_text().splitlines():
        r = json.loads(line)
        recs[r["instance_uuid"]] = r
    rs = list(recs.values())
    ctrl = [r for r in rs if r.get("control")]
    lt = [r for r in rs if r.get("reason") in ("cover", "extra")]
    print("## Outcomes\n")
    print("| Outcome | All | Control | Long-tail |\n|---|---:|---:|---:|")
    for o, n in Counter(r["outcome"] for r in rs).most_common():
        print(f"| {o} | {n} | {sum(r['outcome'] == o for r in ctrl)} | {sum(r['outcome'] == o for r in lt)} |")
    print(f"\n- Control: {rate_line(ctrl)}")
    print(f"- Long-tail selection (cover + extra): {rate_line(lt)}")
    print(f"- Cover only: {rate_line([r for r in rs if r.get('reason') == 'cover'])}")
    print(f"- All: {rate_line(rs)}\n")
    ts_name = lambda r: TS_SHORT.get(r["ts"], r["ts"])  # noqa: E731
    print("### By transfer syntax (all swept)\n")
    print(table(rs, ts_name, "Transfer syntax"))
    print("\n### By writing toolkit (ImplementationVersionName / ImplementationClassUID)\n")
    print(table(rs, lambda r: f"{r['impl_ver']} / {r['impl_class']}", "Toolkit"))
    print("\n### By manufacturer (strata with a non-pass, then largest)\n")
    print(table(rs, lambda r: r["manufacturer"], "Manufacturer", top=40))
    print("\n### By SOP class\n")
    print(table(rs, lambda r: SOP.get(r["sop_class"], r["sop_class"]), "SOP class"))
    print("\n### By collection (only strata with a non-pass)\n")
    print(table(rs, lambda r: r["collection"], "Collection", top=60, only_with_fail=True))
    print("\n## Root-cause groups (all non-pass, evaluated)\n")
    g = defaultdict(list)
    for r in rs:
        if r["outcome"] not in NOT_EVAL and r["outcome"] != "pass":
            g[signature(r)].append(r)
    for sig, v in sorted(g.items(), key=lambda x: -len(x[1])):
        mf = Counter(f"{r['manufacturer']} / {r['collection']}" for r in v).most_common(4)
        print(f"- **{len(v)}** `{sig}` — ctrl {sum(bool(r.get('control')) for r in v)}; "
              + "; ".join(f"{k} ({n})" for k, n in mf))
    print("\n## Not evaluated\n")
    for o in sorted(NOT_EVAL):
        v = [r for r in rs if r["outcome"] == o]
        if v:
            print(f"- {o}: {len(v)} (control {sum(bool(r.get('control')) for r in v)})")
    gb = sum(r["instance_size"] for r in rs if r["outcome"] not in ("download-error", "skipped-decoded-size")) / 1e9
    print(f"\n## Volume\n\n- {len(rs)} instances recorded, {gb:.2f} GB downloaded")
    print(f"- summed per-instance time {sum(r.get('total_s', 0) for r in rs) / 3600:.1f} h")
    ours_t = sorted(((r.get('ours') or {}).get('s') or 0) for r in rs if isinstance((r.get('ours') or {}).get('s'), (int, float)))
    if ours_t:
        print(f"- our decoder: median {ours_t[len(ours_t) // 2]:.3f} s, max {ours_t[-1]:.1f} s")


if __name__ == "__main__":
    main()
