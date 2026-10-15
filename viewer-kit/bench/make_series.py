"""Make a synthetic 100-slice CT series for the pool benchmark and the demo.

Each slice is the bench's CT-like phantom (codecs/bench/scripts/make_cases.py `ct_like`), shifted,
scaled and re-noised per slice so slices compress differently. Stored values are HU + 1024
(12 bits in 16), Rescale Intercept -1024, window 40/400. The series is written once per encoder
to viewer-kit/data/ct100-<encoder>/NNN.dcm, with the seed volume as ct100-seed.npy (the oracle:
all encoders here are lossless) and a manifest viewer-kit/data/manifest.json.

Usage (from the repository root):
    uv run --project codec-corpus python viewer-kit/bench/make_series.py [--slices 100]
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.encaps import encapsulate
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

KIT = Path(__file__).resolve().parents[1]
ROOT = KIT.parent
sys.path.insert(0, str(ROOT / "codecs" / "bench" / "scripts"))
sys.path.insert(0, str(ROOT / "codec-corpus" / "scripts"))
from make_cases import ct_like  # noqa: E402

OUT = KIT / "data"


def volume(n: int) -> np.ndarray:
    base = ct_like()[0].astype(np.float64)
    rng = np.random.default_rng(100)
    out = np.empty((n,) + base.shape, np.uint16)
    yy, xx = np.mgrid[0 : base.shape[0], 0 : base.shape[1]]
    for k in range(n):
        t = k / max(1, n - 1)
        s = 0.9 + 0.15 * np.sin(np.pi * t)  # body grows then shrinks along z
        cy, cx = base.shape[0] / 2, base.shape[1] / 2
        sy = np.clip(((yy - cy) / s + cy).astype(int), 0, base.shape[0] - 1)
        sx = np.clip(((xx - cx) / s + cx + 3 * np.sin(6 * t)).astype(int), 0, base.shape[1] - 1)
        img = base[sy, sx] + rng.normal(0, 10, base.shape) * (base[sy, sx] > 200)
        out[k] = np.clip(np.rint(img), 0, 4095).astype(np.uint16)
    return out


def dataset(arr: np.ndarray, k: int, study: str, series: str) -> Dataset:
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CTImageStorage
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = Dataset()
    ds.file_meta = meta
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID, ds.SeriesInstanceUID = study, series
    ds.Modality = "CT"
    ds.PatientName, ds.PatientID = "Synthetic^Phantom", "CT100"
    ds.InstanceNumber = k + 1
    ds.ImagePositionPatient = [0, 0, -k * 2.5]
    ds.Rows, ds.Columns = arr.shape
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 12, 11, 0
    ds.RescaleIntercept, ds.RescaleSlope, ds.RescaleType = -1024, 1, "HU"
    ds.WindowCenter, ds.WindowWidth = 40, 400
    ds.PixelData = arr.astype("<u2").tobytes()
    return ds


def enc_dcmtk(src: Path, dst: Path, args: list[str]) -> None:
    subprocess.run(args + [str(src), str(dst)], check=True, capture_output=True)


def enc_pydicom(src: Path, dst: Path, uid: str) -> None:
    ds = pydicom.dcmread(src)
    ds.compress(uid)
    ds.save_as(dst, enforce_file_format=True)


def enc_ojph(src: Path, dst: Path) -> None:
    ds = pydicom.dcmread(src)
    arr = ds.pixel_array
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "a.pgm"
        p.write_bytes(f"P5\n{ds.Columns} {ds.Rows}\n4095\n".encode() + arr.astype(">u2").tobytes())
        o = Path(td) / "a.j2c"
        subprocess.run(["ojph_compress", "-i", str(p), "-o", str(o), "-reversible", "true"], check=True, capture_output=True)
        ds.PixelData = encapsulate([o.read_bytes()])
    ds["PixelData"].VR = "OB"
    ds["PixelData"].is_undefined_length = True
    ds.file_meta.TransferSyntaxUID = "1.2.840.10008.1.2.4.201"
    ds.save_as(dst, enforce_file_format=True)


ENCODERS = {
    "explicit-le": lambda s, d: shutil.copy(s, d),
    "jpeg-lossless-sv1": lambda s, d: enc_dcmtk(s, d, ["dcmcjpeg", "+e1"]),
    "jpeg-ls": lambda s, d: enc_pydicom(s, d, "1.2.840.10008.1.2.4.80"),
    "rle": lambda s, d: enc_pydicom(s, d, "1.2.840.10008.1.2.5"),
    "j2k-lossless": lambda s, d: enc_pydicom(s, d, "1.2.840.10008.1.2.4.90"),
    "htj2k-lossless": enc_ojph,
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--slices", type=int, default=100)
    ap.add_argument("--only", action="append")
    a = ap.parse_args()
    OUT.mkdir(exist_ok=True)
    vol = volume(a.slices)
    np.save(OUT / "ct100-seed.npy", vol)
    study, series = generate_uid(), generate_uid()
    manifest = {"about": __doc__.splitlines()[0], "slices": a.slices, "rows": 512, "columns": 512, "seed": "ct100-seed.npy", "series": {}}
    with tempfile.TemporaryDirectory() as td:
        srcs = []
        for k in range(a.slices):
            p = Path(td) / f"{k:03d}.dcm"
            dataset(vol[k], k, study, series).save_as(p, enforce_file_format=True)
            srcs.append(p)
        for name, enc in ENCODERS.items():
            if a.only and name not in a.only:
                continue
            d = OUT / f"ct100-{name}"
            d.mkdir(exist_ok=True)
            files = []
            for k, src in enumerate(srcs):
                dst = d / f"{k:03d}.dcm"
                enc(src, dst)
                files.append(f"ct100-{name}/{dst.name}")
            size = sum((OUT / f).stat().st_size for f in files)
            manifest["series"][name] = {"files": files, "bytes": size, "transfer_syntax": str(pydicom.dcmread(OUT / files[0], stop_before_pixels=True).file_meta.TransferSyntaxUID)}
            print(f"{name:20} {size / 1e6:7.1f} MB")
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))


if __name__ == "__main__":
    main()
