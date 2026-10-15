"""Reference decoder timings for PERF.md: decode the frames dumped by extract_frames.py with
libjpeg-turbo (Pillow, and libturbojpeg's tj3 API through ctypes for 12-bit and lossless),
pylibjpeg (Richter's libjpeg), and DCMTK dcmdjpeg (whole-file, includes DICOM I/O).

Run each backend with an interpreter that has it:
    python3 formats/jpeg-dct/perf_refs.py pil tj          # system Pillow / libturbojpeg
    .venv/bin/python formats/jpeg-dct/perf_refs.py pylibjpeg dcmdjpeg
Prints min and median ms per frame over several passes.
"""

import ctypes
import json
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
FORMATS = HERE.parent
CASES = [
    ("jpeg-dct", "pydicom-color3d_jpeg_baseline", 5),
    ("jpeg-dct", "local-wrist-lateral", 10),
    ("jpeg-dct", "gen-bench-photo-rgb8-2048-ijg-baseline", 5),
    ("jpeg-dct", "gen-bench-dx2048-u12-ijg-extended", 5),
    ("jpeg-lossless", "gen-bench-dx2048-u12-ijg-lossless-sv1", 10),
    ("jpeg-lossless", "gen-bench-ct512-u16-ijg-lossless-sv1", 40),
]


def load(fmt, case):
    d = FORMATS / fmt / "frames" / case
    info = json.loads((d / "info.json").read_text())
    frames = [(d / f"frame-{k}.bin").read_bytes() for k in range(info["frames"])]
    return info, frames


def timeit(fn, frames, passes):
    ts = []
    for _ in range(passes):
        t = time.perf_counter()
        for f in frames:
            fn(f)
        ts.append((time.perf_counter() - t) * 1000 / len(frames))
    return min(ts), statistics.median(ts)


def pil_backend():
    import io

    from PIL import Image

    def dec(b):
        im = Image.open(io.BytesIO(b))
        im.load()
        return im

    return dec


def tj_backend():
    tj = ctypes.CDLL("libturbojpeg.so.0")
    tj.tj3Init.restype = ctypes.c_void_p
    tj.tj3Init.argtypes = [ctypes.c_int]
    tj.tj3DecompressHeader.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t]
    tj.tj3Get.argtypes = [ctypes.c_void_p, ctypes.c_int]
    for name in ("tj3Decompress8", "tj3Decompress12", "tj3Decompress16"):
        getattr(tj, name).argtypes = [
            ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_int, ctypes.c_int
        ]
    h = tj.tj3Init(2)  # TJINIT_DECOMPRESS
    TJPARAM_JPEGWIDTH, TJPARAM_JPEGHEIGHT, TJPARAM_PRECISION, TJPARAM_COLORSPACE = 5, 6, 7, 8
    bufs = {}

    def dec(b):
        if tj.tj3DecompressHeader(h, b, len(b)) != 0:
            raise RuntimeError("tj3DecompressHeader failed")
        w, ht, prec = tj.tj3Get(h, TJPARAM_JPEGWIDTH), tj.tj3Get(h, TJPARAM_JPEGHEIGHT), tj.tj3Get(h, TJPARAM_PRECISION)
        gray = tj.tj3Get(h, TJPARAM_COLORSPACE) == 2  # TJCS_GRAY
        pf, nc = (6, 1) if gray else (0, 3)  # TJPF_GRAY / TJPF_RGB
        fn, bps = (tj.tj3Decompress8, 1) if prec <= 8 else (tj.tj3Decompress12, 2) if prec <= 12 else (tj.tj3Decompress16, 2)
        key = (w, ht, nc, bps)
        if key not in bufs:
            bufs[key] = ctypes.create_string_buffer(w * ht * nc * bps)
        if fn(h, b, len(b), bufs[key], 0, pf) != 0:
            raise RuntimeError("tj3Decompress failed")

    return dec


def pylibjpeg_backend():
    from libjpeg import decode

    return lambda b: decode(b)


def dcmdjpeg(fmt, case, passes):
    src = FORMATS / fmt / "samples" / f"{case}.dcm"
    info, _ = load(fmt, case)
    ts = []
    with tempfile.TemporaryDirectory() as td:
        for _ in range(passes):
            t = time.perf_counter()
            subprocess.run(["dcmdjpeg", str(src), str(Path(td) / "o.dcm")], check=True)
            ts.append((time.perf_counter() - t) * 1000 / info["frames"])
    return min(ts), statistics.median(ts)


def main():
    backends = sys.argv[1:] or ["pil", "tj"]
    for be in backends:
        for fmt, case, passes in CASES:
            info, frames = load(fmt, case)
            try:
                if be == "dcmdjpeg":
                    if not shutil.which("dcmdjpeg"):
                        raise RuntimeError("dcmdjpeg not on PATH")
                    mn, md = dcmdjpeg(fmt, case, max(3, passes // 3))
                else:
                    fn = {"pil": pil_backend, "tj": tj_backend, "pylibjpeg": pylibjpeg_backend}[be]()
                    fn(frames[0])
                    mn, md = timeit(fn, frames, passes)
                print(f"{be:10} {case:40} min {mn:8.3f} ms  median {md:8.3f} ms per frame")
            except Exception as e:  # noqa: BLE001
                print(f"{be:10} {case:40} n/a ({type(e).__name__}: {e})")


if __name__ == "__main__":
    main()
