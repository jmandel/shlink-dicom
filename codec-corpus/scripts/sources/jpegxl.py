"""Register and generate JPEG XL cases (formats/jpeg-xl).

Real files (registered with discover.register):
  cornerstone3D testImages  CTImage / ColorImage, JPEG XL Lossless (.110)   MIT
  dcm4che-test-data         will-jxl.dcm, JPEG XL JPEG Recompression (.111), 27 frames
                            MPL-1.1/GPL-2.0/LGPL-2.1
They are read from the quirks cache (scripts/sources/quirks.py, default ~/.cache/shl-quirks).

Generated files: the corpus seeds (seeds/*.npy, made by generate.py) encoded frame by frame with
libjxl's cjxl and wrapped in DICOM, one fragment per frame:
  .110  cjxl -d 0 at effort 1 and 7 (lossless; the seed is the oracle). Signed seeds are encoded
        as their two's-complement bit pattern at Bits Stored precision.
  .112  cjxl -d 1 and -d 3 (VarDCT; colour is XYB inside the codestream) and -d 1 -m 1 (lossy
        modular); oracle from the references.
  .111  cjxl --lossless_jpeg=1 of the 8-bit JPEG Baseline corpus cases made from the seeds.

Benchmark cases (codecs/bench), from the large bench seeds (codecs/bench/scripts/make_cases.py)
and one real IDC radiograph, at the settings in BENCH and BENCH_FROM_CASES:
  bench-photo-rgb8-2048, bench-dx2048-u12   cjxl -d 1, -d 3 (photo only), -d 0 -e 1, -d 0 -e 7
  jpeg-lossless/idc-…-dx-midrcricor-…        its pixels (the case's oracle), cjxl -d 1 and -d 0 -e 1;
                                             CC BY-NC 4.0, like its source (MIDRC-RICORD-1C)

Usage:  uv run python scripts/sources/jpegxl.py [--cache DIR] [--bench-only]
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
import warnings
from pathlib import Path

import numpy as np
import pydicom
from pydicom.encaps import encapsulate, generate_frames

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import ROOT, load_cases, sample_path, save_cases, sha256_file  # noqa: E402
from discover import describe, register  # noqa: E402

warnings.filterwarnings("ignore")

# pydicom 3.0 predates the JPEG XL transfer syntaxes and will not write a file that uses them.
from pydicom._uid_dict import UID_dictionary  # noqa: E402
for _uid, _name in [("1.2.840.10008.1.2.4.110", "JPEG XL Lossless"),
                    ("1.2.840.10008.1.2.4.111", "JPEG XL JPEG Recompression"),
                    ("1.2.840.10008.1.2.4.112", "JPEG XL")]:
    UID_dictionary.setdefault(_uid, (_name, "Transfer Syntax", "", "", _name.replace(" ", "")))

FMT = "jpeg-xl"
SEEDS = ["synth-u8-64x48", "synth-u12-65x31", "synth-u16-128x96", "synth-s16-64x64", "synth-s12-40x40",
         "synth-rgb8-60x40", "synth-u16-3frame-32x32", "synth-u8-1x1", "pydicom-CT_small", "pydicom-MR_small"]

# Bench seeds -> the variants of generated() to make for them.
BENCH = {"bench-photo-rgb8-2048": ["d1", "d3", "lossless-e1", "lossless-e7"],
         "bench-dx2048-u12": ["d1", "lossless-e1", "lossless-e7"]}
# Real frames from other formats' cases (their oracle is the pixel source) -> variants.
BENCH_FROM_CASES = {("jpeg-lossless", "idc-jpgsv1-mono2-u12of16-sf-dx-midrcricor-10f1e4b4"): ["d1", "lossless-e1"]}

REAL = [
    ("cs3d", "cs3d/packages/dicomImageLoader/testImages/CTImage.dcm_JPEGXLLosslessTransferSyntax_1.2.840.10008.1.2.4.110.dcm",
     "https://github.com/cornerstonejs/cornerstone3D/blob/main/packages/dicomImageLoader/testImages/", "MIT",
     "cornerstonejs/cornerstone3D dicomImageLoader testImages"),
    ("cs3d", "cs3d/packages/dicomImageLoader/testImages/ColorImage.dcm_JPEGXLLosslessTransferSyntax_1.2.840.10008.1.2.4.110.dcm",
     "https://github.com/cornerstonejs/cornerstone3D/blob/main/packages/dicomImageLoader/testImages/", "MIT",
     "cornerstonejs/cornerstone3D dicomImageLoader testImages"),
    ("dcm4che", "dcm4che/will-jxl.dcm",
     "https://github.com/dcm4che/dcm4che/blob/master/dcm4che-test-data/src/main/resources/",
     "MPL-1.1/GPL-2.0/LGPL-2.1 tri-licence (repository)", "dcm4che dcm4che-test-data"),
]


def pnm(arr: np.ndarray, bits: int) -> bytes:
    """One frame (rows, cols[, 3]) of unsigned values below 2^bits as binary PGM/PPM."""
    rows, cols = arr.shape[:2]
    spp = arr.shape[2] if arr.ndim == 3 else 1
    maxval = (1 << bits) - 1
    body = arr.astype(">u2" if maxval > 255 else "u1").tobytes()
    return f"{'P6' if spp == 3 else 'P5'}\n{cols} {rows}\n{maxval}\n".encode() + body


def wrap(seed_dcm: Path, streams: list[bytes], ts: str, dst: Path, photometric: str | None = None) -> None:
    ds = pydicom.dcmread(seed_dcm)
    ds.PixelData = encapsulate(streams)
    ds["PixelData"].VR = "OB"
    ds["PixelData"].is_undefined_length = True
    ds.file_meta.TransferSyntaxUID = ts
    if photometric:
        ds.PhotometricInterpretation = photometric
    if "PlanarConfiguration" in ds:
        ds.PlanarConfiguration = 0
    ds.save_as(dst, enforce_file_format=True)


def add(cid: str, dst: Path, source: dict, truth_seed: bool) -> None:
    ds = pydicom.dcmread(dst)
    cases = {c["id"]: c for c in load_cases(FMT)}
    entry = cases.get(cid, {"id": cid, "notes": "", "tags": []})
    entry.update(describe(ds))
    entry["source"] = source
    entry["truth"] = "seed" if truth_seed else "references"
    entry["sha256"] = sha256_file(dst)
    entry["size"] = dst.stat().st_size
    cases[cid] = entry
    save_cases(FMT, list(cases.values()))
    print(f"{FMT:10} {cid}")


def cjxl(td: Path, data: bytes, ext: str, args: list[str]) -> bytes:
    src, out = td / f"in.{ext}", td / "out.jxl"
    src.write_bytes(data)
    subprocess.run(["cjxl", str(src), str(out), "--quiet", *args], check=True, capture_output=True, timeout=300)
    return out.read_bytes()


def variants_for(signed: bool, spp: int) -> list[tuple[str, str, list[str], str | None]]:
    v = [("lossless-e1", "1.2.840.10008.1.2.4.110", ["-d", "0", "-e", "1"], None),
         ("lossless-e7", "1.2.840.10008.1.2.4.110", ["-d", "0", "-e", "7"], None)]
    if not signed:
        xyb = "XYB" if spp == 3 else None
        v += [("d1", "1.2.840.10008.1.2.4.112", ["-d", "1"], xyb),
              ("d3", "1.2.840.10008.1.2.4.112", ["-d", "3"], xyb),
              ("d1-modular", "1.2.840.10008.1.2.4.112", ["-d", "1", "-m", "1"], xyb)]
    return v


def generated(seed_ids: list[str] = SEEDS, only: dict[str, list[str]] | None = None) -> None:
    seeds = ROOT / "seeds"
    for sid in seed_ids:
        npy, dcm = seeds / f"{sid}.npy", seeds / f"{sid}.dcm"
        if not npy.exists():
            print(f"{FMT:10} seed {sid} missing; run generate.py")
            continue
        arr = np.load(npy)                       # (frames, rows, cols, spp)
        ds = pydicom.dcmread(dcm)
        bits, signed, spp = int(ds.BitsStored), int(ds.PixelRepresentation) == 1, arr.shape[3]
        frames = [(arr[k].astype(np.int64) & ((1 << bits) - 1)) for k in range(arr.shape[0])]
        frames = [f[..., 0] if spp == 1 else f for f in frames]
        ext = "ppm" if spp == 3 else "pgm"
        variants = variants_for(signed, spp)
        if only is not None:
            variants = [v for v in variants if v[0] in only[sid]]
        for name, ts, args, photometric in variants:
            if min(arr.shape[1:3]) < 8 and name != "lossless-e7":
                continue                         # one tiny case is enough
            cid = f"gen-{sid}-cjxl-{name}"
            dst = sample_path(FMT, cid)
            dst.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(dir="/media/barracuda") as td:
                streams = [cjxl(Path(td), pnm(f, bits), ext, args) for f in frames]
            wrap(dcm, streams, ts, dst, photometric)
            add(cid, dst, {"kind": "generated", "seed": sid, "encoder": f"cjxl {' '.join(args)} (libjxl 0.12.0)"},
                ts == "1.2.840.10008.1.2.4.110")


def from_cases() -> None:
    """Bench cases from real frames of other formats' cases (BENCH_FROM_CASES)."""
    for (fmt, src_id), wanted in BENCH_FROM_CASES.items():
        src = sample_path(fmt, src_id)
        npy = ROOT / "formats" / fmt / "oracle" / f"{src_id}.npy"
        if not (src.exists() and npy.exists()):
            print(f"{FMT:10} {fmt}/{src_id} or its oracle missing")
            continue
        arr = np.load(npy)                       # (frames, rows, cols, spp)
        ds = pydicom.dcmread(src)
        bits, spp = int(ds.BitsStored), arr.shape[3]
        frames = [(arr[k].astype(np.int64) & ((1 << bits) - 1)) for k in range(arr.shape[0])]
        frames = [f[..., 0] if spp == 1 else f for f in frames]
        ext = "ppm" if spp == 3 else "pgm"
        short = src_id.split("-")[-2] + "-" + src_id.split("-")[-1]
        for name, ts, args, photometric in variants_for(int(ds.PixelRepresentation) == 1, spp):
            if name not in wanted:
                continue
            cid = f"gen-idc-{short}-cjxl-{name}"
            dst = sample_path(FMT, cid)
            dst.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(dir="/media/barracuda") as td:
                streams = [cjxl(Path(td), pnm(f, bits), ext, args) for f in frames]
            wrap(src, streams, ts, dst, photometric)
            add(cid, dst, {"kind": "generated", "from_case": f"{fmt}/{src_id}",
                           "encoder": f"cjxl {' '.join(args)} (libjxl 0.12.0)", "license": "CC BY-NC 4.0"}, False)


def recompressed() -> None:
    """.111 from the corpus's own JPEG Baseline cases (8-bit, made by dcmcjpeg from the seeds)."""
    for case in load_cases("jpeg-dct"):
        if not (case["id"].startswith("gen-synth-") and case["id"].endswith("-ijg-baseline")):
            continue
        src = sample_path("jpeg-dct", case["id"])
        if not src.exists():
            continue
        ds = pydicom.dcmread(src)
        n = int(getattr(ds, "NumberOfFrames", 1) or 1)
        with tempfile.TemporaryDirectory(dir="/media/barracuda") as td:
            streams = [cjxl(Path(td), bytes(f), "jpg", ["--lossless_jpeg=1"])
                       for f in generate_frames(ds.PixelData, number_of_frames=n)]
        cid = case["id"].replace("-ijg-baseline", "-ijg-baseline-cjxl-jpeg")
        dst = sample_path(FMT, cid)
        dst.parent.mkdir(parents=True, exist_ok=True)
        ds.PixelData = encapsulate(streams)
        ds["PixelData"].VR = "OB"
        ds["PixelData"].is_undefined_length = True
        ds.file_meta.TransferSyntaxUID = "1.2.840.10008.1.2.4.111"
        ds.save_as(dst, enforce_file_format=True)
        add(cid, dst, {"kind": "generated", "from_case": f"jpeg-dct/{case['id']}",
                       "encoder": "cjxl --lossless_jpeg=1 (libjxl 0.12.0)"}, False)


def real(cache: Path) -> None:
    budget: dict[str, int] = {}
    for src, rel, url, lic, origin in REAL:
        p = cache / rel
        if not p.exists():
            print(f"{FMT:10} missing {p}")
            continue
        cid = f"ext-{src}-{Path(rel).stem}"
        fmt = register(p, cid, {"kind": "external", "origin": origin, "url": url + p.name, "license": lic},
                       budget, 10**6)
        print(f"{fmt or 'SKIPPED':10} {cid}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", type=Path, default=Path.home() / ".cache" / "shl-quirks")
    ap.add_argument("--bench-only", action="store_true", help="make only the benchmark cases")
    a = ap.parse_args()
    if shutil.which("cjxl") is None:
        sys.exit("cjxl not installed")
    if not a.bench_only:
        real(a.cache)
        generated()
        recompressed()
    generated(list(BENCH), BENCH)
    from_cases()


if __name__ == "__main__":
    main()
