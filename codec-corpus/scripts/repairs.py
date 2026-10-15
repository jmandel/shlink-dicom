"""Rulings that need a repaired copy of a quirky file to serve as its oracle.

Each repair writes a corrected file, registers it as its own case (so it is checked too), and points
the quirky original at it with `oracle_case`. Re-run after discover/quirk registration:
    uv run python scripts/repairs.py && uv run python scripts/oracle.py --case <ids>
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import warnings
from pathlib import Path

import pydicom

sys.path.insert(0, str(Path(__file__).parent))
from common import load_cases, remove_cases, sample_path, save_cases, sha256_file  # noqa: E402
from discover import describe  # noqa: E402

warnings.filterwarnings("ignore")


def add_case(fmt: str, cid: str, src: Path, source: dict, **extra) -> None:
    dst = sample_path(fmt, cid)
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src != dst:
        shutil.copyfile(src, dst)
    ds = pydicom.dcmread(dst, force=True)
    entry = {"id": cid, "notes": "", "tags": ["repair"], **describe(ds), "source": source,
             "sha256": sha256_file(dst), "size": dst.stat().st_size, **extra}
    save_cases(fmt, [entry])


def find(fmt: str, cid: str) -> dict | None:
    return next((c for c in load_cases(fmt) if c["id"] == cid), None)


def gh1376() -> None:
    """A second group 0002 inside the data set says uncompressed; the real header says JPEG Lossless SV1.
    PS3.10 §7.1: only the real header counts. Move to jpeg-lossless; oracle = dcmtk's decompression."""
    old = find("uncompressed", "ext-fodicom-GH1376")
    src = sample_path("uncompressed", "ext-fodicom-GH1376")
    if not src.exists() and find("jpeg-lossless", "ext-fodicom-GH1376"):
        return
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "dec.dcm"
        subprocess.run(["dcmdjpeg", str(src), str(out)], check=True, capture_output=True)
        add_case("uncompressed", "repair-fodicom-GH1376-dcmdjpeg", out,
                 {"kind": "repair", "of": "ext-fodicom-GH1376", "how": "dcmdjpeg (reads only the real file meta)"})
        moved = sample_path("jpeg-lossless", "ext-fodicom-GH1376")
        moved.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, moved)
    entry = dict(old or {"id": "ext-fodicom-GH1376", "tags": []})
    entry.update(transfer_syntax="1.2.840.10008.1.2.4.70", oracle_case="uncompressed/repair-fodicom-GH1376-dcmdjpeg",
                 ruling="file meta says JPEG Lossless SV1; a second group 0002 in the data set is ignored (PS3.10 §7.1)")
    for k in ("expect", "max_abs", "oracle_sha256", "confidence", "disputed"):
        entry.pop(k, None)
    save_cases("jpeg-lossless", [entry])
    remove_cases("uncompressed", {"ext-fodicom-GH1376"})


def patch_attr(fmt: str, cid: str, rid: str, how: str, ruling: str, **attrs) -> None:
    src = sample_path(fmt, cid)
    if not src.exists() or find(fmt, rid):   # idempotent: an existing repair keeps its oracle fields
        return
    ds = pydicom.dcmread(src, force=True)
    for k, v in attrs.items():
        setattr(ds, k, v)
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "fixed.dcm"
        ds.save_as(out)
        add_case(fmt, rid, out, {"kind": "repair", "of": cid, "how": how})
    c = find(fmt, cid)
    c.update(oracle_case=rid, ruling=ruling)
    c.pop("expect_override", None)
    save_cases(fmt, [c])


def cornell() -> None:
    """MITRA_CORNELL: lossless JPEG from the Cornell encoder, whose 16-bit Huffman bug garbles plain decodes.
    Oracle = dcmdjpeg with its Cornell workaround (+wc); our codec detects the bug and applies the same fix."""
    cid = "ext-gdcm-MITRA_CORNELL"
    src = sample_path("jpeg-lossless", cid)
    if not src.exists() or find("uncompressed", "repair-gdcm-MITRA_CORNELL-dcmdjpeg-wc"):
        return
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "dec.dcm"
        subprocess.run(["dcmdjpeg", "+wc", str(src), str(out)], check=True, capture_output=True)
        add_case("uncompressed", "repair-gdcm-MITRA_CORNELL-dcmdjpeg-wc", out,
                 {"kind": "repair", "of": cid, "how": "dcmdjpeg +wc (Cornell workaround)"})
    c = find("jpeg-lossless", cid)
    c.pop("expect_override", None)
    c.update(oracle_case="uncompressed/repair-gdcm-MITRA_CORNELL-dcmdjpeg-wc",
             ruling="Cornell 16-bit encoder bug: decode with dcmtk's workaround (+wc); clean shoulder MRI")
    save_cases("jpeg-lossless", [c])


def ybr_lossless() -> None:
    c = find("jpeg-lossless", "ext-gdcm-JPEGLosslessYBR_FULL_422")
    if c:
        c.update(oracle_ref="pydicom:pylibjpeg-raw",
                 ruling="lossless JPEG labelled YBR_FULL_422 but holds RGB (no subsampling in SOF, R=G=B on 97.8% of pixels); no colour conversion")
        save_cases("jpeg-lossless", [c])


def main() -> None:
    patch_attr("jpeg-dct", "ext-gdcm-DCMTK_JPEGExt_12Bits", "repair-gdcm-DCMTK_JPEGExt_12Bits-ba16",
               "Bits Allocated 12 -> 16", "Bits Allocated 12 is impossible for encapsulated data; inferred 16 from the 12-bit SOF (matches dcmdjpeg)", BitsAllocated=16)
    patch_attr("jpeg-lossless", "ext-gdcm-JPEGLosslessSeNonZero", "repair-gdcm-JPEGLosslessSeNonZero-ba16",
               "Bits Allocated 12 -> 16", "Bits Allocated 12 inferred as 16 from the 12-bit SOF (matches GDCM on the repaired copy)", BitsAllocated=16)
    patch_attr("jpeg2000", "ext-gdcm-FUJI-ffff-MONO1-J2K", "repair-gdcm-FUJI-ffff-ba16-bs16",
               "Bits Allocated/Stored 0xFFFF -> 16", "Bits Allocated/Stored 0xFFFF inferred as 16 from the SIZ precision (matches opj_decompress)", BitsAllocated=16, BitsStored=16)
    cornell()
    ybr_lossless()
    gh1376()
    patch_attr("uncompressed", "ext-gdcm-gdcm-CR-DCMTK-16-NonSamplePerPix", "repair-gdcm-NonSamplePerPix-spp1",
               "Samples per Pixel = 1 added", "missing Samples per Pixel defaults to 1 (GDCM behaviour)", SamplesPerPixel=1)
    patch_attr("uncompressed", "ext-gdcm-MR16BitsAllocated_8BitsStored", "repair-gdcm-MR16BA8BS-mono2",
               "Photometric MONOCHROME -> MONOCHROME2", "undefined photometric 'MONOCHROME' read as MONOCHROME2",
               PhotometricInterpretation="MONOCHROME2")


if __name__ == "__main__":
    main()
