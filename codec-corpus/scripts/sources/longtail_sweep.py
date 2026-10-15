"""Long-tail sweep: download, decode with ours and the references, compare, record, delete.

    uv run python scripts/sources/longtail_sweep.py [--jobs 10] [--group control|cover|extra] [--limit N]
        [--results prevalence/cache/longtail/results.jsonl] [--decoder PATH] [--recheck OUTCOME ...]

Input: prevalence/cache/longtail/selection.json (longtail_select.py).
Per instance, in a bounded worker pool:
  1. download from the public IDC bucket into WORK/tmp/<uuid>/ (WORK defaults to
     /media/barracuda/shlink-dicom-sweep, an external disk; never /tmp, which is RAM-backed);
  2. probe the file structure in a subprocess (pixel data element, offset tables, fragments);
  3. run our decoder (codecs/target/longtail/release/shl-dicom-decode IN OUT);
  4. run every applicable reference through scripts/ref_decode.py, one subprocess per reference
     with a timeout (GDCM can abort);
  5. compare under CONTRACT.md / oracle.py rules: the first reference that decodes is the oracle;
     lossless syntaxes must match exactly, lossy ones within max(1, largest reference disagreement);
  6. append the outcome to the results file and delete the downloads. Files whose outcome is not
     "pass" are copied to WORK/keep/ for later registration (longtail_register.py).
Resumable: instances already in the results file are skipped. Budgets: --disk-gb for downloads
plus decoded outputs in flight, --mem-gb for estimated decode memory (6x the decoded size).
Instances whose decoded pixels exceed --max-decoded-gb are recorded as "skipped-decoded-size".

Outcomes: pass, mismatch, ref-dispute (ours equals a non-oracle reference on a lossless file whose
references disagree), our-crash, our-refusal-but-refs-decode, our-unsupported-but-refs-decode,
refs-fail-we-decode, all-fail, no-pixel-data, download-error, skipped-decoded-size.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent
sys.path.insert(0, str(SCRIPTS))
ROOT = SCRIPTS.parent
REPO = ROOT.parent
D = ROOT / "prevalence" / "cache" / "longtail"
PY = str(ROOT / ".venv" / "bin" / "python")
DEFAULT_WORK = Path("/media/barracuda/shlink-dicom-sweep")
DEFAULT_DECODER = REPO / "codecs" / "target" / "longtail" / "release" / "shl-dicom-decode"


# --------------------------------------------------------------------------- probe (subprocess)

def probe(path: Path) -> dict:
    """File structure facts, read with pydicom; run in its own process."""
    import warnings
    warnings.filterwarnings("ignore")
    import pydicom
    from pydicom.tag import Tag
    ds = pydicom.dcmread(path, force=True, defer_size="2 KB")
    meta = getattr(ds, "file_meta", None)
    out = {"ts": str(getattr(meta, "TransferSyntaxUID", "")) if meta is not None else "",
           "has_preamble": path.read_bytes()[128:132] == b"DICM"}
    for k in ("Rows", "Columns", "SamplesPerPixel", "BitsAllocated", "BitsStored", "HighBit",
              "PixelRepresentation", "PlanarConfiguration", "PhotometricInterpretation"):
        v = ds.get(k)
        try:
            out[k] = None if v in (None, "") else (str(v) if k == "PhotometricInterpretation" else int(v))
        except Exception:  # noqa: BLE001
            out[k] = repr(v)[:40]
    try:
        nf = ds.get("NumberOfFrames")
        out["NumberOfFrames"] = int(nf) if nf not in (None, "") else 1
    except Exception:  # noqa: BLE001
        out["NumberOfFrames"] = 1
    kinds = [n for n in ("PixelData", "FloatPixelData", "DoubleFloatPixelData") if n in ds]
    out["pixel_element"] = kinds[0] if kinds else None
    out["eot"] = Tag(0x7FE0, 0x0001) in ds
    out["eot_lengths"] = Tag(0x7FE0, 0x0002) in ds
    out["icon"] = "IconImageSequence" in ds
    out["n_elements_after_pixel"] = sum(1 for e in ds if e.tag > Tag(0x7FE0, 0x0010))
    if "PixelData" in ds:
        el = ds["PixelData"]
        out["pixel_undefined_length"] = bool(getattr(el, "is_undefined_length", False))
        pd = ds.PixelData
        out["pixel_bytes"] = len(pd)
        if out["pixel_undefined_length"]:
            frags, bot, i = [], None, 0
            while i + 8 <= len(pd):
                tag = int.from_bytes(pd[i:i + 4], "little")
                ln = int.from_bytes(pd[i + 4:i + 8], "little")
                if tag != 0xE000FFFE:
                    out["encaps_trailing_garbage"] = len(pd) - i
                    break
                if bot is None:
                    bot = ln // 4
                else:
                    frags.append(ln)
                i += 8 + ln
            out["bot_entries"] = bot
            out["n_fragments"] = len(frags)
            out["odd_fragments"] = sum(1 for f in frags if f % 2)
        else:
            ba = out["BitsAllocated"] or 0
            exp = (out["Rows"] or 0) * (out["Columns"] or 0) * (out["SamplesPerPixel"] or 1) * out["NumberOfFrames"]
            exp = (exp + 7) // 8 if ba == 1 else exp * ba // 8
            out["native_expected_bytes"] = exp
            out["native_excess_bytes"] = len(pd) - exp
    return out


# --------------------------------------------------------------------------- budgets

class Budget:
    def __init__(self, total: float):
        self.total, self.used, self.cv = total, 0.0, threading.Condition()

    def acquire(self, w: float) -> float:
        w = min(w, self.total)
        with self.cv:
            while self.used + w > self.total:
                self.cv.wait()
            self.used += w
        return w

    def release(self, w: float) -> None:
        with self.cv:
            self.used -= w
            self.cv.notify_all()


# --------------------------------------------------------------------------- compare

def compare_files(a: Path, b: Path, dtype) -> tuple[int, int]:
    import numpy as np
    x = np.memmap(a, dtype=dtype, mode="r")
    y = np.memmap(b, dtype=dtype, mode="r")
    if x.size != y.size:
        return -1, -1
    mx, nd, step = 0, 0, 1 << 25
    for i in range(0, x.size, step):
        d = np.abs(x[i:i + step].astype(np.int64) - y[i:i + step].astype(np.int64))
        if d.size:
            mx = max(mx, int(d.max()))
            nd += int((d > 0).sum())
    return mx, nd


def last_line(b: bytes) -> str:
    s = b.decode(errors="replace").strip().splitlines()
    return s[-1][:300] if s else ""


def run(cmd: list[str], timeout: float) -> dict:
    t0 = time.monotonic()
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=timeout)
        return {"exit": p.returncode, "s": round(time.monotonic() - t0, 3), "err": last_line(p.stderr)}
    except subprocess.TimeoutExpired:
        return {"exit": "timeout", "s": round(time.monotonic() - t0, 3), "err": f"timeout after {timeout:.0f}s"}


# --------------------------------------------------------------------------- one instance

def process(inst: dict, a, disk: Budget, mem: Budget) -> dict:
    from common import TRANSFER_SYNTAXES, expected_dtype
    from ref_decode import applicable
    t_start = time.monotonic()
    rec = {k: inst[k] for k in inst if k not in ("covers",)}
    rec["covers"] = inst.get("covers", [])[:12]
    exp = float(inst.get("expected_bytes") or 0)
    if exp > a.max_decoded_gb * 1e9:
        rec["outcome"] = "skipped-decoded-size"
        return rec
    dw = disk.acquire(inst["instance_size"] + 3 * exp)
    mw = mem.acquire(6 * exp + 3e8)
    work = a.work / "tmp" / inst["instance_uuid"]
    try:
        work.mkdir(parents=True, exist_ok=True)
        src = work / "in.dcm"
        t0 = time.monotonic()
        err = None
        kept = a.work / "keep" / f"{inst['instance_uuid']}.dcm"
        if a.from_keep and kept.exists():
            shutil.copyfile(kept, src)
        for attempt in range(0 if (a.from_keep and kept.exists()) else 3):
            try:
                with urllib.request.urlopen(inst["url"], timeout=300) as r, open(src, "wb") as f:
                    shutil.copyfileobj(r, f, 1 << 20)
                if src.stat().st_size != inst["instance_size"]:
                    raise IOError(f"size {src.stat().st_size} != {inst['instance_size']}")
                err = None
                break
            except Exception as e:  # noqa: BLE001
                err = repr(e)[:200]
                time.sleep(2 + 5 * attempt)
        rec["download_s"] = round(time.monotonic() - t0, 2)
        if err:
            rec.update(outcome="download-error", error=err)
            return rec
        pr = subprocess.run([PY, "-I", str(Path(__file__)), "--probe", str(src)], capture_output=True, timeout=600)
        try:
            pb = json.loads(pr.stdout)
        except Exception:  # noqa: BLE001
            pb = {"probe_error": last_line(pr.stderr)}
        rec["probe"] = pb
        ts = pb.get("ts") or inst["ts"]
        lossy = TRANSFER_SYNTAXES.get(ts, ("?", "", False))[2]
        rec["lossy"] = lossy
        tmo_ours = 60 + 120 * exp / 1e9
        tmo_ref = 180 + 300 * exp / 1e9
        ours_out = work / "ours.raw"
        ours = run([str(a.decoder), str(src), str(ours_out)], tmo_ours)
        rec["ours"] = ours
        refs = {}
        oracle_ref, oracle_path = None, None
        try:
            dtype = expected_dtype(int(pb.get("BitsAllocated") or 0), int(pb.get("PixelRepresentation") or 0))
            assert isinstance(pb.get("Rows"), int) and isinstance(pb.get("Columns"), int)
        except Exception:  # noqa: BLE001
            dtype = None
        if dtype is None:
            rec["probe_incomplete"] = True
        nbytes = None
        if dtype is not None and pb.get("Rows") and pb.get("Columns"):
            nbytes = pb["NumberOfFrames"] * pb["Rows"] * pb["Columns"] * (pb.get("SamplesPerPixel") or 1) * dtype.itemsize
        rec["canonical_bytes"] = nbytes
        ref_outs = {}
        ref_list = applicable(ts)
        if a.ybr422_j2k_raw and ts in ("1.2.840.10008.1.2.4.90", "1.2.840.10008.1.2.4.91") \
                and pb.get("PhotometricInterpretation") == "YBR_FULL_422":
            # Known reference issue: OpenJPEG already converts sYCC to RGB for subsampled
            # 3-component codestreams and pydicom converts again; decide with the unconverted output.
            ref_list = ["pydicom:pylibjpeg-raw", "openjpeg-cli"]
            rec["refs_rule"] = "j2k-ybr422-raw"
        for ref in ref_list:
            out = work / f"ref-{ref.replace(':', '_')}.raw"
            r = run([PY, str(SCRIPTS / "ref_decode.py"), "--ref", ref, str(src), str(out)], tmo_ref)
            r["ok"] = r["exit"] == 0 and out.exists() and (nbytes is None or out.stat().st_size == nbytes)
            if r["exit"] == 0 and not r["ok"]:
                r["err"] = f"wrote {out.stat().st_size if out.exists() else 0} bytes, expected {nbytes}"
            refs[ref] = r
            if r["ok"]:
                if oracle_ref is None:
                    oracle_ref, oracle_path = ref, out
                elif dtype is not None:
                    mx, nd = compare_files(oracle_path, out, dtype)
                    r["vs_oracle_max_abs"] = mx
                    ref_outs[ref] = out
            else:
                out.unlink(missing_ok=True)
        rec["refs"] = refs
        rec["oracle_ref"] = oracle_ref
        dis = [r.get("vs_oracle_max_abs", 0) for r in refs.values() if r.get("ok")]
        worst = max(dis) if dis else 0
        rec["refs_disagree_max_abs"] = worst
        allowed = max(1, worst) if lossy else 0
        rec["max_abs_allowed"] = allowed
        ours_ok = ours["exit"] == 0
        crashed = ours["exit"] == "timeout" or (isinstance(ours["exit"], int) and (ours["exit"] < 0 or ours["exit"] not in (0, 2, 3)))
        if crashed:
            rec["outcome"] = "our-crash"
        elif pb.get("pixel_element") is None and oracle_ref is None:
            rec["outcome"] = "no-pixel-data"
        elif oracle_ref is None:
            rec["outcome"] = "refs-fail-we-decode" if ours_ok else "all-fail"
        elif not ours_ok:
            rec["outcome"] = "our-unsupported-but-refs-decode" if ours["exit"] == 3 else "our-refusal-but-refs-decode"
        else:
            size = ours_out.stat().st_size if ours_out.exists() else 0
            if size != oracle_path.stat().st_size:
                rec["outcome"] = "mismatch"
                rec["mismatch"] = f"wrote {size} bytes, expected {oracle_path.stat().st_size}"
            elif dtype is None:
                rec["outcome"] = "pass" if ours_out.read_bytes() == oracle_path.read_bytes() else "mismatch"
                rec["mismatch"] = "byte comparison (probe could not read the pixel description)"
            else:
                mx, nd = compare_files(ours_out, oracle_path, dtype)
                rec["ours_max_abs"], rec["ours_pixels_differing"] = mx, nd
                if mx <= allowed:
                    rec["outcome"] = "pass"
                else:
                    matches = []
                    for ref, p in ref_outs.items():
                        m2, _ = compare_files(ours_out, p, dtype)
                        if m2 <= allowed:
                            matches.append(ref)
                    rec["ours_matches_refs"] = matches
                    rec["outcome"] = "ref-dispute" if matches and not lossy else "mismatch"
                    rec["mismatch"] = f"max |diff| {mx} > allowed {allowed}; {nd} samples differ"
        if rec["outcome"] not in ("pass", "no-pixel-data") and inst["instance_size"] <= a.keep_max_mb * 1e6:
            keep = a.work / "keep" / f"{inst['instance_uuid']}.dcm"
            keep.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, keep)
            rec["kept"] = str(keep)
        return rec
    except Exception as e:  # noqa: BLE001
        rec.update(outcome="sweep-error", error=repr(e)[:300])
        return rec
    finally:
        rec["total_s"] = round(time.monotonic() - t_start, 2)
        shutil.rmtree(work, ignore_errors=True)
        disk.release(dw)
        mem.release(mw)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", type=Path)
    ap.add_argument("--jobs", type=int, default=10)
    ap.add_argument("--group", action="append", choices=["control", "cover", "extra"])
    ap.add_argument("--limit", type=int)
    ap.add_argument("--selection", type=Path, default=D / "selection.json")
    ap.add_argument("--results", type=Path, default=D / "results.jsonl")
    ap.add_argument("--decoder", type=Path, default=DEFAULT_DECODER)
    ap.add_argument("--work", type=Path, default=DEFAULT_WORK)
    ap.add_argument("--disk-gb", type=float, default=40)
    ap.add_argument("--mem-gb", type=float, default=16)
    ap.add_argument("--max-decoded-gb", type=float, default=2)
    ap.add_argument("--keep-max-mb", type=float, default=500)
    ap.add_argument("--uuids", type=Path, help="file with instance_uuids to (re)run, one per line")
    ap.add_argument("--from-keep", action="store_true", help="use WORK/keep/<uuid>.dcm when present")
    ap.add_argument("--ybr422-j2k-raw", action="store_true",
                    help="JPEG 2000 YBR_FULL_422: references pylibjpeg-raw and openjpeg-cli only")
    a = ap.parse_args()
    if a.probe:
        print(json.dumps(probe(a.probe)))
        return 0
    sel = json.loads(a.selection.read_text())["instances"]
    done = set()
    if a.results.exists():
        for line in a.results.read_text().splitlines():
            try:
                done.add(json.loads(line)["instance_uuid"])
            except Exception:  # noqa: BLE001
                pass
    if a.uuids:
        want = set(a.uuids.read_text().split())
        todo = [i for i in sel if i["instance_uuid"] in want]
    else:
        order = {"control": 0, "cover": 1, "extra": 2}
        todo = [i for i in sel if i["instance_uuid"] not in done
                and (not a.group or i["reason"] in a.group or (i["control"] and "control" in a.group))]
        todo.sort(key=lambda i: (0 if i["control"] else order[i["reason"]] + 1))
    if a.limit:
        todo = todo[: a.limit]
    print(f"{len(todo)} to do ({len(done)} already done); decoder {a.decoder}", flush=True)
    disk, mem = Budget(a.disk_gb * 1e9), Budget(a.mem_gb * 1e9)
    lock = threading.Lock()
    counts: dict[str, int] = {}
    t0 = time.time()
    a.results.parent.mkdir(parents=True, exist_ok=True)

    def one(inst):
        rec = process(inst, a, disk, mem)
        rec["swept_at"] = time.strftime("%FT%T")
        with lock:
            with open(a.results, "a") as f:
                f.write(json.dumps(rec) + "\n")
            counts[rec["outcome"]] = counts.get(rec["outcome"], 0) + 1
            n = sum(counts.values())
            if rec["outcome"] != "pass" or n % 100 == 0:
                print(f"[{n}/{len(todo)} {time.time() - t0:.0f}s] {rec['outcome']:30} {rec['profile'][:70]} "
                      f"{(rec.get('ours') or {}).get('err', '')[:120]} {rec.get('mismatch', '')}", flush=True)
                if n % 100 == 0:
                    print("   counts:", counts, flush=True)

    with ThreadPoolExecutor(a.jobs) as ex:
        list(ex.map(one, todo))
    print("final counts:", counts, f"wall {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
