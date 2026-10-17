"""Colour labels seen in real files that the generated cases lack, made from the RGB seeds.

- HTJ2K lossy (.203) labelled YBR_ICT, the label PS3.5 8.2.4 asks for when the codestream applies
  the irreversible colour transform (Aliza writes these). OpenJPH applies the ICT to three
  components by default; the generated `openjph-q` cases carry the same kind of stream labelled RGB.
- JPEG 2000 lossless (.90) labelled YBR_FULL (Aliza Medical Imaging writes these):
  - `ybr-full-nomct`: the seed converted to YBR_FULL samples (pydicom's matrix), coded without a
    component transform. The label is right; a decoder converts YBR_FULL to RGB.
  - `rct-ybr-full`: the RGB seed coded with the reversible colour transform (RCT) but labelled
    YBR_FULL. The label is wrong (PS3.5 8.2.4 asks for YBR_RCT); the codestream says RGB.

Encoders: ojph_compress (OpenJPH) and opj_compress (OpenJPEG), as generate.py uses them. Run
generate.py first so the seeds exist, then oracle.py for these cases.

Usage:  uv run python scripts/sources/relabelled.py
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import pydicom
from pydicom.encaps import encapsulate
from pydicom.pixels import convert_color_space

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import ROOT, sample_path  # noqa: E402
from generate import register  # noqa: E402

SEEDS = ["synth-rgb8-60x40"]


def ppm(arr: np.ndarray, path: Path) -> None:
    rows, cols, _ = arr.shape
    path.write_bytes(f"P6\n{cols} {rows}\n255\n".encode() + arr.astype("u1").tobytes())


def code(arr: np.ndarray, cmd: list[str], suffix: str) -> bytes:
    with tempfile.TemporaryDirectory() as td:
        src, out = Path(td) / "in.ppm", Path(td) / f"out.{suffix}"
        ppm(arr, src)
        subprocess.run(cmd + ["-i", str(src), "-o", str(out)], check=True, capture_output=True, timeout=120)
        return out.read_bytes()


def write(seed: Path, stream: bytes, ts: str, photometric: str, dst: Path) -> None:
    ds = pydicom.dcmread(seed)
    ds.PixelData = encapsulate([stream])
    ds["PixelData"].VR = "OB"
    ds["PixelData"].is_undefined_length = True
    ds.PhotometricInterpretation = photometric
    ds.file_meta.TransferSyntaxUID = ts
    dst.parent.mkdir(parents=True, exist_ok=True)
    ds.save_as(dst, enforce_file_format=True)


def mct(stream: bytes) -> int:
    """The COD segment's multiple component transformation byte."""
    i = stream.index(b"\xff\x52")
    return stream[i + 8]


def main() -> None:
    for sid in SEEDS:
        seed = ROOT / "seeds" / f"{sid}.dcm"
        rgb = pydicom.dcmread(seed).pixel_array
        made = []
        # HTJ2K lossy with the ICT, labelled YBR_ICT.
        s = code(rgb, ["ojph_compress", "-qstep", "0.01"], "j2c")
        assert mct(s) == 1, "OpenJPH did not apply the ICT"
        made.append(("htj2k", f"gen-{sid}-openjph-q-ybr-ict", s, "1.2.840.10008.1.2.4.203", "YBR_ICT", "openjph-q", False))
        # JPEG 2000 lossless: YBR_FULL samples without a component transform.
        ybr = convert_color_space(rgb, "RGB", "YBR_FULL")
        s = code(ybr, ["opj_compress", "-mct", "0"], "j2k")
        assert mct(s) == 0
        made.append(("jpeg2000", f"gen-{sid}-openjpeg-ybr-full-nomct", s, "1.2.840.10008.1.2.4.90", "YBR_FULL", "opj-mct0", False))
        # JPEG 2000 lossless: RGB with the RCT, mislabelled YBR_FULL.
        s = code(rgb, ["opj_compress", "-mct", "1"], "j2k")
        assert mct(s) == 1
        made.append(("jpeg2000", f"gen-{sid}-openjpeg-rct-ybr-full", s, "1.2.840.10008.1.2.4.90", "YBR_FULL", "opj-mct1", True))
        for fmt, cid, stream, ts, photometric, encoder, seed_is_truth in made:
            dst = sample_path(fmt, cid)
            write(seed, stream, ts, photometric, dst)
            register(fmt, cid, dst, sid, encoder, seed_is_truth)
            print(f"{fmt:10} {cid}")


if __name__ == "__main__":
    main()
