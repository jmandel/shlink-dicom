"""Legacy Converted Enhanced CT, MR and PET made from IDC classic series, for the object-type sweep.

    uv run --with highdicom python scripts/sources/sopclass_derive.py SRC_DIR OUT.dcm {ct,mr,pt} [--order spatial|shuffled]

IDC holds no Enhanced or Legacy Converted Enhanced CT, MR or PET today (prevalence/SOPCLASS_CENSUS.md),
so the viewer's per-frame functional-group path is exercised on conversions of real classic series:
the same pixels and geometry, moved into per-frame and shared functional groups by highdicom's
LegacyConverted* classes (the converter IDC itself has used). Per-slice Rescale Slope/Intercept and
windows land in per-frame Pixel Value Transformation and Frame VOI LUT items when they differ.
  spatial   highdicom's default: frames sorted spatially, with a dimension index
  shuffled  frames in a fixed pseudo-random order, no dimension index (valid DICOM: a viewer must
            order the frames by Plane Position (Patient), not by frame number)
Derived files stay in scratch with the source collection's licence; nothing is committed.
"""
from __future__ import annotations

import argparse
import random
from pathlib import Path

import highdicom as hd
import pydicom
from highdicom.legacy import LegacyConvertedEnhancedCTImage, LegacyConvertedEnhancedMRImage, LegacyConvertedEnhancedPETImage

CLS = {"ct": LegacyConvertedEnhancedCTImage, "mr": LegacyConvertedEnhancedMRImage, "pt": LegacyConvertedEnhancedPETImage}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("kind", choices=CLS)
    ap.add_argument("--order", choices=["spatial", "shuffled"], default="spatial")
    a = ap.parse_args()
    ds = [pydicom.dcmread(f) for f in sorted(a.src.glob("*.dcm"))]
    ds = [d for d in ds if "PixelData" in d]
    for d in ds:
        d.decompress() if d.file_meta.TransferSyntaxUID.is_compressed else None
    kw = {}
    if a.order == "shuffled":
        ds.sort(key=lambda d: int(d.InstanceNumber))
        random.Random(11).shuffle(ds)
        kw["include_dimension_index"] = False
    img = CLS[a.kind](legacy_datasets=ds, series_instance_uid=hd.UID(), series_number=900 + len(a.order),
                      sop_instance_uid=hd.UID(), instance_number=1, **kw)
    img.SeriesDescription = f"Legacy converted ({a.order} frames) of: {ds[0].get('SeriesDescription', '')}"[:64]
    a.out.parent.mkdir(parents=True, exist_ok=True)
    img.save_as(a.out)
    print(f"{a.out}: {img.NumberOfFrames} frames, {a.out.stat().st_size} bytes")


if __name__ == "__main__":
    main()
