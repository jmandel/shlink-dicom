"""Build the oracle for every case: decode with each applicable reference decoder,
decide the expected pixels and the allowed difference, and record how sure we are.

Rules
  truth = seed        (generated lossless cases) the seed pixels are the oracle; every
                      reference must reproduce them exactly or the case is marked disputed
  truth = references  the first successful reference (preference order in ref_decode.applicable)
                      is the oracle
    lossless syntax   allowed |diff| = 0; references from different families must agree exactly
    lossy syntax      allowed |diff| = max(1, largest disagreement between references)
  no reference decodes the file  -> expect = "error": a candidate must refuse it cleanly

Writes formats/<fmt>/oracle/<case>.npy and .json, and copies the expectation
(expect, max_abs, oracle_sha256, confidence) into cases.json.

Usage:  uv run python scripts/oracle.py [--format FMT ...] [--case SUBSTRING]
"""

from __future__ import annotations

import argparse
import json
import sys
import warnings
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from common import (FORMAT_NAMES, ROOT, TRANSFER_SYNTAXES, abs_diff, load_cases, oracle_paths, sample_path,  # noqa: E402
                    save_cases, sha256_bytes)
from ref_decode import applicable, decode, family  # noqa: E402

warnings.filterwarnings("ignore")


def build(fmt: str, case: dict) -> dict:
    path = sample_path(fmt, case["id"])
    ts = case["transfer_syntax"]
    lossy = TRANSFER_SYNTAXES[ts][2]
    results: dict[str, dict] = {}
    arrays: dict[str, np.ndarray] = {}
    for ref in applicable(ts):
        info = {"family": family(ref, ts)}
        try:
            arr = decode(path, ref)
            arrays[ref] = arr
            info.update(ok=True, sha256=sha256_bytes(arr.tobytes()), dtype=str(arr.dtype), shape=list(arr.shape))
        except NotImplementedError as e:
            info.update(ok=False, skipped=str(e))
        except Exception as e:  # noqa: BLE001
            msg = str(e).strip().splitlines()
            info.update(ok=False, error=(msg[-1] if msg else type(e).__name__)[:200])
        results[ref] = info

    rec = {"case": case["id"], "format": fmt, "transfer_syntax": ts, "lossy": lossy, "references": results}
    truth = None
    # Rulings recorded in cases.json (see the format's FORMAT.md for evidence):
    #   expect_override: "error"         no valid decoding exists; a candidate must refuse
    #   oracle_ref:      "<reference>"   use this reference as the oracle (others are known wrong here)
    #   oracle_case:     "<case id>"     use another case's oracle (e.g. a repaired copy of the same image)
    if case.get("expect_override") == "error":
        rec.update(expect="error", max_abs=None, confidence="ruling: " + case.get("ruling", "see FORMAT.md"))
        return rec
    if case.get("oracle_case"):
        ofmt, ocase = case["oracle_case"].split("/", 1) if "/" in case["oracle_case"] else (fmt, case["oracle_case"])
        npy, _ = oracle_paths(ofmt, ocase)
        truth = np.load(npy)
        rec["oracle_from"] = f"case:{case['oracle_case']}"
    elif case.get("oracle_ref") and case["oracle_ref"] not in arrays:
        try:
            arrays[case["oracle_ref"]] = decode(path, case["oracle_ref"])
            results[case["oracle_ref"]] = {"family": family(case["oracle_ref"], ts), "ok": True, "ruling_only": True}
        except Exception as e:  # noqa: BLE001
            results[case["oracle_ref"]] = {"ok": False, "error": str(e)[:200], "ruling_only": True}
    if truth is None and case.get("oracle_ref") in arrays:
        truth = arrays[case["oracle_ref"]]
        rec["oracle_from"] = case["oracle_ref"]
    elif truth is None and case.get("truth") == "seed":
        truth = np.load(ROOT / "seeds" / f"{case['source']['seed']}.npy")
        rec["oracle_from"] = "seed"
    elif truth is None and arrays:
        primary = next(iter(arrays))
        truth = arrays[primary]
        rec["oracle_from"] = primary

    if truth is None:
        rec.update(expect="error", max_abs=None, confidence="no reference decodes this file")
        return rec

    disagreements = []
    for ref, arr in arrays.items():
        if arr.shape != truth.shape:
            results[ref]["vs_oracle"] = f"shape {list(arr.shape)}"
            disagreements.append(10**9)
            continue
        dd = abs_diff(arr, truth)
        d = (float(dd.max()) if dd.dtype.kind == "f" else int(dd.max())) if arr.size else 0
        results[ref]["vs_oracle_max_abs"] = d
        disagreements.append(d)
    agreeing = sorted({results[r]["family"] for r, a in arrays.items() if results[r].get("vs_oracle_max_abs") == 0})
    worst = max(disagreements) if disagreements else 0

    if case.get("oracle_ref") or case.get("oracle_case"):
        # A ruling picked the oracle; references that disagree are known to be wrong here.
        worst = 0 if not lossy else worst
    if lossy:
        max_abs = max(1, worst if worst < 10**9 else 1)
        confidence = f"lossy; {len(arrays)} reference(s); families agreeing exactly: {agreeing}"
        disputed = worst >= 10**9
    else:
        max_abs = 0
        disputed = worst != 0
        confidence = ("ground truth from seed" if rec["oracle_from"] == "seed" else "lossless consensus") + \
            f"; families agreeing: {agreeing}"
    if not lossy and rec["oracle_from"] != "seed" and len(agreeing) < 2:
        confidence += "; WEAK (fewer than two independent families)"
    if case.get("max_abs_override") is not None:
        max_abs = int(case["max_abs_override"])
        confidence += f"; max_abs set by ruling ({case.get('max_abs_reason', 'see FORMAT.md')})"
    rec.update(expect="decode", max_abs=max_abs, disputed=disputed, confidence=confidence,
               dtype=str(truth.dtype), shape=list(truth.shape), oracle_sha256=sha256_bytes(truth.tobytes()))
    rec["_array"] = truth
    return rec


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--format", action="append", choices=FORMAT_NAMES)
    ap.add_argument("--case")
    a = ap.parse_args()
    for fmt in a.format or FORMAT_NAMES:
        cases = load_cases(fmt)
        touched = []
        for case in cases:
            if a.case and a.case not in case["id"]:
                continue
            if not sample_path(fmt, case["id"]).exists():
                print(f"{fmt:14} {case['id']}: sample missing (run discover/generate)")
                continue
            rec = build(fmt, case)
            npy, js = oracle_paths(fmt, case["id"])
            npy.parent.mkdir(parents=True, exist_ok=True)
            arr = rec.pop("_array", None)
            if arr is not None:
                np.save(npy, arr)
            js.write_text(json.dumps(rec, indent=2) + "\n")
            for k in ("expect", "max_abs", "oracle_sha256", "confidence", "disputed"):
                if k in rec:
                    case[k] = rec[k]
            touched.append(case)
            flag = " DISPUTED" if rec.get("disputed") else ""
            print(f"{fmt:14} {case['id']:60} {rec['expect']:6} max_abs={rec['max_abs']}{flag}")
        if touched:
            save_cases(fmt, touched)   # merge only what we rebuilt; other agents may be adding cases


if __name__ == "__main__":
    main()
