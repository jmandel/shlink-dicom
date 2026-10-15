"""Score every survey adapter on every extracted frame of the jpeg2000 and htj2k corpora.

Usage (from codec-corpus/, so numpy is available):
    uv run python ../codecs/survey-j2k/score.py [--format jpeg2000|htj2k] [--adapter NAME] [--json OUT]

Each adapter is target/release/a-<name> IN.j2c OUT.raw (see common/src/lib.rs for the protocol).
Normalisation follows CONTRACT.md: the decoder's values are reduced to Bits Stored (masked when
Pixel Representation is 0, sign-extended when 1) and compared with the oracle.

A "sign fix" variant is also tried, standing for a one-line wrapper fix: when SIZ says a component is
signed but the adapter reports unsigned output, subtract 2^(prec-1) (the decoder applied the
unsigned DC level shift to a signed component).

Outcomes per case: exact | tol (within max_abs) | wrong | error | panic | timeout; suffix "+sf"
when only the sign-fixed variant passes.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
CORPUS = HERE.parent.parent / "codec-corpus"
BIN = HERE / "target" / "release"
ADAPTERS = ["hayro", "dtk", "j2k", "openjp2", "ojpure", "oxideav", "rustj2k", "justjp2",
            "openjph", "ndic", "purej2k", "oxigdal"]


def parse_siz(cs: bytes):
    i = cs.find(b"\xff\x51")
    if i < 0:
        return None
    i += 4
    xsiz, ysiz, xo, yo = (int.from_bytes(cs[i + 2 + 4 * k:i + 6 + 4 * k], "big") for k in range(4))
    csiz = int.from_bytes(cs[i + 34:i + 36], "big")
    if len(cs) < i + 36 + 3 * csiz:
        return None
    comps = [((cs[i + 36 + 3 * c] & 0x7F) + 1, bool(cs[i + 36 + 3 * c] & 0x80)) for c in range(csiz)]
    return {"w": xsiz - xo, "h": ysiz - yo, "comps": comps}


def normalise(v: np.ndarray, bs: int, pixrep: int) -> np.ndarray:
    v = v.astype(np.int64)
    m = (1 << bs) - 1
    v = v & m
    if pixrep:
        v = np.where(v >= (1 << (bs - 1)), v - (1 << bs), v)
    return v


def run(adapter: str, frame: Path, timeout: float = 60.0):
    with tempfile.NamedTemporaryFile(suffix=".raw") as out:
        t0 = time.perf_counter()
        try:
            p = subprocess.run([str(BIN / f"a-{adapter}"), str(frame), out.name], capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return {"status": "timeout", "secs": timeout}
        dt = time.perf_counter() - t0
        if p.returncode != 0:
            st = "error" if p.returncode == 2 else "panic"
            msg = (p.stderr.decode(errors="replace").strip().splitlines() or [""])
            # keep the panic line, not the backtrace note
            msg = next((l for l in msg if "panicked" in l or "error" in l.lower()), msg[0])
            return {"status": st, "code": p.returncode, "msg": msg[:200], "secs": dt}
        meta = json.loads(p.stdout.decode().strip().splitlines()[-1])
        data = np.frombuffer(Path(out.name).read_bytes(), dtype="<i4")
        return {"status": "ok", "meta": meta, "data": data, "secs": dt}


def score_case(adapter: str, case_dir: Path):
    info = json.loads((case_dir / "info.json").read_text())
    frames = sorted(case_dir.glob("frame-*.bin"), key=lambda p: int(p.stem.split("-")[1]))
    res = {"case": info["case"], "adapter": adapter, "expect": info.get("expect")}
    if info.get("expect") == "error" or "extract_error" in info:
        # DICOM-level malformation; only record whether the codec survives the bytes.
        outs = [run(adapter, f) for f in frames]
        res["outcome"] = "n/a:" + ",".join(o["status"] for o in outs)
        res["secs"] = sum(o.get("secs", 0) for o in outs)
        return res
    oracle = np.load(info["oracle_npy"])
    bs, pr, ma = info["bits_stored"], info["pixel_representation"], info["max_abs"] or 0
    worst, total, outcome, msg, used_fix = 0, 0.0, "exact", "", False
    for k, f in enumerate(frames):
        o = run(adapter, f)
        total += o.get("secs", 0)
        if o["status"] != "ok":
            outcome, msg = o["status"], o.get("msg", "")
            break
        meta, data = o["meta"], o["data"]
        exp = oracle[k].astype(np.int64)
        rows, cols, spp = exp.shape
        if (meta["h"], meta["w"]) != (rows, cols) or data.size != rows * cols * spp:
            outcome, msg = "wrong", f"shape {meta} vs {exp.shape}"
            break
        got = data.reshape(rows, cols, spp).astype(np.int64)
        siz = parse_siz(f.read_bytes())
        if siz:
            # Wrapper step: clamp to the component's SIZ range (as OpenJPEG does after the inverse
            # DC shift); a no-op for lossless output.
            for c, (prec, sg) in enumerate(siz["comps"][:spp]):
                lo, hi = (-(1 << (prec - 1)), (1 << (prec - 1)) - 1) if (sg and meta.get("signed_out")) else (0, (1 << prec) - 1)
                if sg and not meta.get("signed_out"):
                    lo, hi = 0, (1 << prec) - 1
                got[..., c] = np.clip(got[..., c], lo, hi)
        d0 = int(np.abs(normalise(got, bs, pr) - exp).max())
        d = d0
        if d0 > ma and siz and not meta.get("signed_out") and any(s for _, s in siz["comps"]):
            fixed = got.astype(np.int64).copy()
            for c, (prec, sg) in enumerate(siz["comps"][:spp]):
                if sg:
                    fixed[..., c] -= 1 << (prec - 1)
            d1 = int(np.abs(normalise(fixed, bs, pr) - exp).max())
            if d1 < d0:
                d, used_fix = d1, True
        worst = max(worst, d)
    if outcome == "exact":
        outcome = "exact" if worst == 0 else ("tol" if worst <= ma else "wrong")
        if used_fix and outcome != "wrong":
            outcome += "+sf"
    res.update(outcome=outcome, max_diff=worst, max_abs=ma, secs=round(total, 4), msg=msg)
    return res


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--format", choices=["jpeg2000", "htj2k"], action="append")
    ap.add_argument("--adapter", action="append")
    ap.add_argument("--case")
    ap.add_argument("--json")
    a = ap.parse_args()
    results = []
    for fmt in a.format or ["jpeg2000", "htj2k"]:
        for case_dir in sorted((CORPUS / "formats" / fmt / "frames").iterdir()):
            if a.case and a.case not in case_dir.name:
                continue
            for ad in a.adapter or ADAPTERS:
                r = score_case(ad, case_dir)
                r["format"] = fmt
                results.append(r)
                print(f"{fmt:8} {ad:8} {r['case']:45} {r['outcome']:10} d={r.get('max_diff', '-')!s:>6} "
                      f"t={r.get('secs', 0):.3f} {r.get('msg', '')[:90]}", flush=True)
    if a.json:
        Path(a.json).write_text(json.dumps(results, indent=1))


if __name__ == "__main__":
    main()
