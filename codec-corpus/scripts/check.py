"""Run a candidate decoder over the corpus and compare it with the oracle.

The candidate is any command following CONTRACT.md. {in} and {out} are substituted:
    uv run python scripts/check.py --name rust \
        --candidate "../target/release/shl-dicom-decode {in} {out}" [--format jpeg-ls] [--case SUBSTR]

Outcomes per case
  pass         decoded within the allowed difference (or refused, exit 2, a file that should be
               refused)
  fail         decoded but wrong (shape, size or pixels), or refused a file it should decode; also
               a tolerance so loose that a constant 0 or 128 output would pass
  unsupported  exit code 3: the candidate says it does not handle this case yet
  crash        any exit code but 0, 2 and 3 (a Rust panic is 101), a signal, a timeout, or a
               candidate that cannot be run; the command runs without a shell
Exit status is 1 if any case fails or crashes (or, with --strict, is unsupported).

Writes reports/<name>.json; with --baseline reports/<other>.json it lists regressions.
"""

from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from common import FORMAT_NAMES, REPORTS, compare, load_cases, oracle_paths, sample_path  # noqa: E402


def constant_passes(oracle: np.ndarray, max_abs: float) -> int | None:
    """A constant output (0 or 128) that the tolerance would pass, if any: such a tolerance
    checks nothing. An oracle that is itself one value (a 1 x 1 image, an empty segment) is only
    matched by that value, so it is left out."""
    if oracle.size == 0:
        return None
    lo, hi = float(oracle.min()), float(oracle.max())
    if lo == hi:
        return None
    for c in (0, 128):
        if hi - c <= max_abs and c - lo <= max_abs:
            return c
    return None


def candidate_argv(template: str, src: Path, out: Path) -> list[str]:
    """The candidate command as an argument list, {in} and {out} substituted (no shell, so a
    wrapper's exit status is the decoder's own)."""
    return [t.replace("{in}", str(src)).replace("{out}", str(out)) for t in shlex.split(template)]


def run_case(fmt: str, case: dict, template: str, timeout: float) -> dict:
    """Runs one case. Exit codes (CONTRACT.md): 0 decoded, 2 refused, 3 unsupported; anything
    else, a signal or a command that cannot run is a crash."""
    cid = case["id"]
    res = {"format": fmt, "case": cid, "expect": case.get("expect")}
    src = sample_path(fmt, cid)
    npy, _ = oracle_paths(fmt, cid)
    if not src.exists() or case.get("expect") is None:
        res.update(outcome="skipped", reason="no sample or oracle; run discover/generate/oracle")
        return res
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "out.raw"
        t0 = time.monotonic()
        try:
            p = subprocess.run(candidate_argv(template, src, out), capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            res.update(outcome="crash", reason=f"timeout after {timeout}s")
            return res
        except OSError as e:
            res.update(outcome="crash", reason=f"cannot run the candidate: {e}")
            return res
        res["seconds"] = round(time.monotonic() - t0, 3)
        err = p.stderr.decode(errors="replace").strip().splitlines()
        res["stderr"] = err[-1][:300] if err else ""
        if p.returncode not in (0, 2, 3):
            res.update(outcome="crash", reason=f"exit {p.returncode}" if p.returncode >= 0 else f"signal {-p.returncode}")
            return res
        if p.returncode == 3:
            res.update(outcome="unsupported")
            return res
        if case["expect"] == "error":
            res.update(outcome="pass" if p.returncode == 2 else "fail",
                       reason=None if p.returncode == 2 else "decoded a file no reference can decode; check by hand")
            return res
        if p.returncode == 2:
            res.update(outcome="fail", reason="refused (exit 2) a file the references decode")
            return res
        oracle = np.load(npy, mmap_mode="r")
        c = constant_passes(oracle, case["max_abs"])
        if c is not None:
            res.update(outcome="fail", reason=f"max_abs {case['max_abs']} lets a constant {c} output pass: fix the tolerance")
            return res
        size = out.stat().st_size if out.exists() else 0
        if size != oracle.nbytes:
            res.update(outcome="fail", reason=f"wrote {size} bytes, expected {oracle.nbytes} "
                                              f"({oracle.dtype} {list(oracle.shape)})")
            return res
        cand = np.memmap(out, dtype=oracle.dtype, mode="r", shape=oracle.shape) if size else np.zeros(oracle.shape, oracle.dtype)
        cmp = compare(cand, oracle, case["max_abs"])
        res.update(cmp)
        res["outcome"] = "pass" if cmp["ok"] else "fail"
        return res


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidate", required=True, help='command with {in} and {out}')
    ap.add_argument("--name", required=True)
    ap.add_argument("--format", action="append", choices=FORMAT_NAMES)
    ap.add_argument("--case")
    ap.add_argument("--timeout", type=float, default=60)
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--baseline", type=Path)
    ap.add_argument("--strict", action="store_true", help="treat unsupported as failure")
    ap.add_argument("--quiet", action="store_true", help="print only the summary and problems")
    a = ap.parse_args()

    work = [(f, c) for f in (a.format or FORMAT_NAMES) for c in load_cases(f)
            if not a.case or a.case in c["id"]]
    with ThreadPoolExecutor(a.jobs) as ex:
        results = list(ex.map(lambda fc: run_case(fc[0], fc[1], a.candidate, a.timeout), work))

    summary: dict[str, dict[str, int]] = {}
    for r in results:
        s = summary.setdefault(r["format"], {})
        s[r["outcome"]] = s.get(r["outcome"], 0) + 1
        if not a.quiet or r["outcome"] in ("fail", "crash"):
            extra = r.get("reason") or (f"max|d|={r['max_abs_diff']}" if "max_abs_diff" in r else "")
            print(f"{r['outcome']:11} {r['format']:14} {r['case']:60} {extra}")
    print("\nsummary")
    for fmt, s in sorted(summary.items()):
        print(f"  {fmt:14} " + "  ".join(f"{k}={v}" for k, v in sorted(s.items())))

    REPORTS.mkdir(exist_ok=True)
    report = {"name": a.name, "candidate": a.candidate, "time": time.strftime("%Y-%m-%dT%H:%M:%S"),
              "summary": summary, "results": results}
    (REPORTS / f"{a.name}.json").write_text(json.dumps(report, indent=2) + "\n")

    if a.baseline and a.baseline.exists():
        before = {(r["format"], r["case"]): r["outcome"] for r in json.loads(a.baseline.read_text())["results"]}
        regressions = [r for r in results if before.get((r["format"], r["case"])) == "pass" and r["outcome"] != "pass"]
        for r in regressions:
            print(f"REGRESSION {r['format']} {r['case']}: {r['outcome']} {r.get('reason', '')}")
        if regressions:
            return 1

    bad = {"fail", "crash"} | ({"unsupported"} if a.strict else set())
    return 1 if any(r["outcome"] in bad for r in results) else 0


if __name__ == "__main__":
    sys.exit(main())
