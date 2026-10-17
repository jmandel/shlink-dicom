"""A multi-frame Enhanced MR Color Image (1.2.840.10008.5.1.4.1.1.4.3) in JPEG Baseline, YBR_FULL_422.

No openly licensed file of this kind was found: IDC has no Enhanced MR, the NEMA WG16 Enhanced MR
samples are grayscale, and pydicom's colour JPEG Baseline multi-frame is Ultrasound. So it is made
here: a synthetic colour volume (6 frames of 80x64) in an Enhanced MR Color data set with shared
and per-frame functional groups, compressed by DCMTK's dcmcjpeg +eb (JPEG Baseline, YCbCr with
4:2:2 subsampling, one fragment per frame).

Usage:  uv run python scripts/sources/enhanced_color.py
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import sample_path  # noqa: E402
from generate import register  # noqa: E402

CASE = "gen-enhanced-mr-color-80x64x6-ijg-baseline"
SOP = "1.2.840.10008.5.1.4.1.1.4.3"


def volume(rows: int, cols: int, frames: int) -> np.ndarray:
    y, x = np.mgrid[0:rows, 0:cols]
    arr = np.zeros((frames, rows, cols, 3), np.uint8)
    for f in range(frames):
        arr[f, ..., 0] = (x * 3 + f * 20) % 256
        arr[f, ..., 1] = (y * 4) % 256
        arr[f, ..., 2] = ((x // 8 + y // 8 + f) % 2) * 200 + 30
    return arr


def dataset(arr: np.ndarray) -> Dataset:
    frames, rows, cols, _ = arr.shape
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = SOP
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = Dataset()
    ds.file_meta = meta
    ds.SOPClassUID, ds.SOPInstanceUID = SOP, meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = generate_uid(), generate_uid(), generate_uid()
    ds.Modality = "MR"
    ds.PatientName, ds.PatientID = "Synthetic^Seed", "SEED"
    ds.ImageType = ["DERIVED", "PRIMARY", "COLOR", "NONE"]
    ds.Rows, ds.Columns, ds.NumberOfFrames = rows, cols, frames
    ds.SamplesPerPixel, ds.PhotometricInterpretation, ds.PlanarConfiguration = 3, "RGB", 0
    ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 8, 8, 7, 0
    shared = Dataset()
    pm = Dataset()
    pm.PixelSpacing, pm.SliceThickness = [1, 1], 1
    shared.PixelMeasuresSequence = [pm]
    po = Dataset()
    po.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    shared.PlaneOrientationSequence = [po]
    ds.SharedFunctionalGroupsSequence = [shared]
    per = []
    for f in range(frames):
        g = Dataset()
        pp = Dataset()
        pp.ImagePositionPatient = [0, 0, f]
        g.PlanePositionSequence = [pp]
        fc = Dataset()
        fc.StackID, fc.InStackPositionNumber = "1", f + 1
        g.FrameContentSequence = [fc]
        per.append(g)
    ds.PerFrameFunctionalGroupsSequence = per
    ds.PixelData = arr.tobytes()
    return ds


def main() -> None:
    dst = sample_path("jpeg-dct", CASE)
    dst.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "native.dcm"
        dataset(volume(64, 80, 6)).save_as(src, enforce_file_format=True)
        subprocess.run(["dcmcjpeg", "+eb", str(src), str(dst)], check=True, capture_output=True, timeout=120)
    register("jpeg-dct", CASE, dst, "enhanced-mr-color-80x64x6", "ijg-baseline", False)
    print(f"jpeg-dct   {CASE}")


if __name__ == "__main__":
    main()
