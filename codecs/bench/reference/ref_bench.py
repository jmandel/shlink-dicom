"""Native speed of the reference C/C++ libraries on the benchmark cases, timed in-process.

For each case the frames are split out once with pydicom (not timed); one "run" is the decode of
every frame's codestream, so the number is comparable with our `codec` stage. GDCM is timed on
the whole file (parse + decode), comparable with our `total`. All libraries run single-threaded
(OpenJPEG through imagecodecs is asked for one thread; the others do not thread).

Checks: each library's output must have the expected number of samples per frame. Pixel values
are not compared (these are the references); a size mismatch marks the record failed.

Usage (repository root):
    uv run --project codec-corpus --with pillow --with imagecodecs \
        python codecs/bench/reference/ref_bench.py [--format FMT] [--case SUBSTR] [--ids ID,...] > out.jsonl
"""

from __future__ import annotations

import argparse
import io
import json
import math
import sys
import time
import warnings
from pathlib import Path

import os

os.environ.setdefault("OPJ_NUM_THREADS", "1")  # OpenJPEG reads this when a codec is created

import numpy as np  # noqa: E402
import pydicom  # noqa: E402
from pydicom.encaps import generate_frames  # noqa: E402

warnings.filterwarnings("ignore")
BENCH = Path(__file__).resolve().parents[1]
CORPUS = BENCH.parents[1] / "codec-corpus" / "formats"


def libraries(fmt: str, case: dict):
    """(name, family, kind, callable). kind = 'frame' (takes codestream) or 'file' (takes path)."""
    import imagecodecs
    import jpeg_ls
    import libjpeg
    import openjpeg
    import rle
    out = []
    bits = case["bits_stored"]
    if fmt == "jpeg-dct":
        if bits <= 8:
            from PIL import Image

            def pil(cs):
                im = Image.open(io.BytesIO(cs))
                im.draft(None, None)
                return np.asarray(im)
            out.append(("libjpeg-turbo (Pillow)", "libjpeg-turbo", "frame", pil))
        out.append(("libjpeg-turbo (imagecodecs)", "libjpeg-turbo", "frame", lambda cs: imagecodecs.jpeg8_decode(cs)))
        out.append(("libjpeg (pylibjpeg)", "libjpeg-richter", "frame", lambda cs: libjpeg.decode(cs)))
    elif fmt == "jpeg-lossless":
        out.append(("libjpeg-turbo (imagecodecs)", "libjpeg-turbo", "frame", lambda cs: imagecodecs.jpeg8_decode(cs)))
        out.append(("libjpeg (pylibjpeg)", "libjpeg-richter", "frame", lambda cs: libjpeg.decode(cs)))
    elif fmt == "jpeg-ls":
        out.append(("CharLS (pyjpegls)", "charls", "frame", lambda cs: jpeg_ls.decode_from_buffer(cs)))
        out.append(("libjpeg (pylibjpeg)", "libjpeg-richter", "frame", lambda cs: libjpeg.decode(cs)))
    elif fmt == "jpeg2000":
        out.append(("OpenJPEG (pylibjpeg)", "openjpeg", "frame", lambda cs: openjpeg.decode(cs)))
    elif fmt == "htj2k":
        out.append(("OpenJPH (imagecodecs)", "openjph", "frame", lambda cs: imagecodecs.htj2k_decode(cs)))
        out.append(("OpenJPEG (pylibjpeg)", "openjpeg", "frame", lambda cs: openjpeg.decode(cs)))
    elif fmt == "rle":
        out.append(("pylibjpeg-rle (Rust)", "pylibjpeg-rle", "frame-ds", lambda cs, ds: rle.decode_pixel_data(cs, ds)))
    if fmt != "uncompressed":
        out.append(("GDCM (whole file)", "gdcm", "file", gdcm_decode))
    return out


def gdcm_decode(path: str):
    import gdcm
    r = gdcm.ImageReader()
    r.SetFileName(path)
    if not r.Read():
        raise RuntimeError("gdcm read failed")
    img = r.GetImage()
    buf = img.GetBuffer()
    return buf


def stats(xs):
    xs = sorted(xs)

    def q(p):
        if len(xs) == 1:
            return xs[0]
        k = (len(xs) - 1) * p
        lo, hi = math.floor(k), math.ceil(k)
        return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)
    return {"p10": q(0.1), "median": q(0.5), "p90": q(0.9)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--format", action="append")
    ap.add_argument("--case")
    ap.add_argument("--ids", help="comma-separated manifest ids (<format>/<case>) to run")
    ap.add_argument("--manifest", default=str(BENCH / "cases.json"))
    a = ap.parse_args()
    man = json.loads(Path(a.manifest).read_text())
    d = man["defaults"]
    for entry in man["cases"]:
        fmt, cid = entry["id"].split("/", 1)
        if a.format and fmt not in a.format:
            continue
        if a.case and a.case not in entry["id"]:
            continue
        if a.ids and entry["id"] not in a.ids.split(","):
            continue
        path = CORPUS / fmt / "samples" / f"{cid}.dcm"
        if not path.exists():
            continue
        case = next(c for c in json.loads((CORPUS / fmt / "cases.json").read_text())["cases"] if c["id"] == cid)
        ds = pydicom.dcmread(path)
        nf = int(getattr(ds, "NumberOfFrames", 1) or 1)
        frames = []
        if fmt != "uncompressed":
            frames = list(generate_frames(ds.PixelData, number_of_frames=nf))
        samples = case["rows"] * case["columns"] * case["samples_per_pixel"]
        for name, family, kind, fn in libraries(fmt, case):
            rec = {"case": entry["id"], "runner": "ref", "build": name, "family": family}
            cpu_ms: list[float] = []

            def once():
                t, c = time.perf_counter(), time.process_time()
                if kind == "file":
                    outs = [fn(str(path))]
                elif kind == "frame-ds":
                    outs = [fn(cs, ds) for cs in frames]
                else:
                    outs = [fn(cs) for cs in frames]
                wall = (time.perf_counter() - t) * 1000
                cpu_ms.append((time.process_time() - c) * 1000)
                return wall, outs
            try:
                cold, outs = once()
                if kind == "file":
                    n_ok = len(outs[0]) >= nf * samples * (case["bits_allocated"] // 8)
                else:
                    n_ok = all(np.asarray(o).size in (samples, samples * (case["bits_allocated"] // 8)) for o in outs)
                est = cold
                for _ in range(max(d["warmup"] - 1, 0)):
                    est, _ = once()
                n = 3 if est > 2000 else max(d["min_runs"], min(d["max_runs"], math.ceil(d["budget_ms"] / max(est, 1e-3))))
                runs = [once()[0] for _ in range(n)]
                cpu = stats(cpu_ms[-n:])["median"]
                # CPU time well above wall time means the library used more than one thread.
                rec.update(status=0, cold_ms=cold, n=n, stats={"total": stats(runs)},
                           cpu_over_wall=round(cpu / max(stats(runs)["median"], 1e-6), 2),
                           verify={"ok": bool(n_ok), "kind": "size",
                                   **({} if n_ok else {"reason": "unexpected output size"})})
            except Exception as e:  # noqa: BLE001
                rec.update(status=2, msg=f"{type(e).__name__}: {str(e)[:200]}")
            print(json.dumps(rec), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
