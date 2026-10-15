"""Build oracles for the idc-* cases only, in parallel, saving only those entries.

    uv run python scripts/sources/idc_oracle.py [--format FMT ...] [--prefix idc-] [--jobs 8]

Same logic as scripts/oracle.py (it calls oracle.build), but save_cases is passed only the
cases this run rebuilt, so concurrent edits by other agents to other cases are not overwritten.
"""
from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import numpy as np  # noqa: E402
from common import FORMAT_NAMES, load_cases, oracle_paths, sample_path, save_cases  # noqa: E402
from oracle import build  # noqa: E402


def one(args):
    fmt, case = args
    try:
        rec = build(fmt, case)
    except Exception as e:  # noqa: BLE001
        return fmt, case, {"error": repr(e)[:300]}
    npy, js = oracle_paths(fmt, case["id"])
    npy.parent.mkdir(parents=True, exist_ok=True)
    arr = rec.pop("_array", None)
    if arr is not None:
        np.save(npy, arr)
    js.write_text(json.dumps(rec, indent=2) + "\n")
    return fmt, case, rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--format", action="append", choices=FORMAT_NAMES)
    ap.add_argument("--prefix", default="idc-")
    ap.add_argument("--jobs", type=int, default=8)
    a = ap.parse_args()
    work = []
    for fmt in a.format or FORMAT_NAMES:
        for c in load_cases(fmt):
            if c["id"].startswith(a.prefix) and sample_path(fmt, c["id"]).exists():
                work.append((fmt, c))
    done = {}
    with ProcessPoolExecutor(a.jobs) as ex:
        for fmt, case, rec in ex.map(one, work):
            if "error" in rec and "expect" not in rec:
                print(f"{fmt:14} {case['id']:60} ORACLE ERROR {rec['error']}")
                continue
            for k in ("expect", "max_abs", "oracle_sha256", "confidence", "disputed"):
                if k in rec:
                    case[k] = rec[k]
            done.setdefault(fmt, []).append(case)
            flag = " DISPUTED" if rec.get("disputed") else ""
            print(f"{fmt:14} {case['id']:60} {rec['expect']:6} max_abs={rec['max_abs']}{flag}", flush=True)
    for fmt, cases in done.items():
        # re-read current entries so fields other agents changed meanwhile are kept
        cur = {c["id"]: c for c in load_cases(fmt)}
        merged = []
        for c in cases:
            base = cur.get(c["id"], c)
            for k in ("expect", "max_abs", "oracle_sha256", "confidence", "disputed"):
                if k in c:
                    base[k] = c[k]
            merged.append(base)
        save_cases(fmt, merged)


if __name__ == "__main__":
    main()
