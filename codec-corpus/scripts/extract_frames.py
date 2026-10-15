"""Dump each case's per-frame codestreams and frame parameters, for codec-level tests and debugging
without going through the shl-dicom-decode CLI.

Writes formats/<fmt>/frames/<case>/info.json (FrameInfo fields + expect + max_abs + oracle path)
and frame-<k>.bin (the encapsulated codestream of frame k, fragments already joined).

Usage:  uv run python scripts/extract_frames.py --format jpeg-ls [--case SUBSTR]
"""

from __future__ import annotations

import argparse
import json
import sys
import warnings
from pathlib import Path

import pydicom
from pydicom.encaps import generate_frames

sys.path.insert(0, str(Path(__file__).parent))
from common import FORMAT_NAMES, format_dir, load_cases, oracle_paths, sample_path  # noqa: E402

warnings.filterwarnings("ignore")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--format", required=True, choices=[f for f in FORMAT_NAMES if f != "uncompressed"])
    ap.add_argument("--case")
    a = ap.parse_args()
    for case in load_cases(a.format):
        if a.case and a.case not in case["id"]:
            continue
        src = sample_path(a.format, case["id"])
        if not src.exists():
            continue
        out = format_dir(a.format) / "frames" / case["id"]
        out.mkdir(parents=True, exist_ok=True)
        try:
            ds = pydicom.dcmread(src, force=True)
            n = int(getattr(ds, "NumberOfFrames", 1) or 1)
            frames = list(generate_frames(ds.PixelData, number_of_frames=n))
        except Exception as e:  # noqa: BLE001
            (out / "info.json").write_text(json.dumps({"case": case["id"], "extract_error": str(e)}, indent=2))
            continue
        for k, f in enumerate(frames):
            (out / f"frame-{k}.bin").write_bytes(f)
        info = {k: case.get(k) for k in ("rows", "columns", "samples_per_pixel", "bits_allocated", "bits_stored",
                                          "pixel_representation", "photometric", "planar_configuration",
                                          "transfer_syntax", "frames", "expect", "max_abs")}
        info["case"] = case["id"]
        info["oracle_npy"] = str(oracle_paths(a.format, case["id"])[0])
        (out / "info.json").write_text(json.dumps(info, indent=2) + "\n")
        print(f"{case['id']}: {len(frames)} frame(s)")


if __name__ == "__main__":
    main()
