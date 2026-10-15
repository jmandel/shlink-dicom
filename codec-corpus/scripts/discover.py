"""Collect sample files into formats/<fmt>/samples/ and register them in formats/<fmt>/cases.json.

Sources:
  pydicom   pydicom's test data (downloaded on demand from github.com/pydicom/pydicom-data)
  local     DICOM files under ../data/samples (the demo studies; never committed)
  generated files made by generate.py (registered there, not here)

Usage:  uv run python scripts/discover.py [--source pydicom|local|all] [--per-format N]
Re-running is safe: existing case entries keep their notes and expectations.
"""

from __future__ import annotations

import argparse
import shutil
import sys
import tarfile
import tempfile
import warnings
from pathlib import Path

import pydicom

sys.path.insert(0, str(Path(__file__).parent))
from common import ROOT, TRANSFER_SYNTAXES, load_cases, sample_path, save_cases, sha256_file  # noqa: E402
from ref_decode import is_float, read  # noqa: E402

warnings.filterwarnings("ignore")


def describe(ds) -> dict:
    """Image Pixel values of a data set read by ref_decode.read (Transfer Syntax UID guessed for a
    file without a Part 10 meta). Float and Double Float Pixel Data have Bits Allocated 32 and 64
    and no Bits Stored or Pixel Representation."""
    fl = is_float(ds)
    ba = int(getattr(ds, "BitsAllocated", 0) or 0)
    if fl:
        ba = 64 if "DoubleFloatPixelData" in ds else 32
    meta = {
        "transfer_syntax": str(ds.file_meta.TransferSyntaxUID),
        "rows": int(ds.Rows),
        "columns": int(ds.Columns),
        "frames": int(getattr(ds, "NumberOfFrames", 1) or 1),
        "samples_per_pixel": int(getattr(ds, "SamplesPerPixel", 1)),
        "bits_allocated": ba,
        "bits_stored": ba if fl else int(getattr(ds, "BitsStored", ba)),
        "pixel_representation": 0 if fl else int(getattr(ds, "PixelRepresentation", 0)),
        "photometric": str(getattr(ds, "PhotometricInterpretation", "")),
        "planar_configuration": int(getattr(ds, "PlanarConfiguration", 0) or 0),
    }
    if fl:
        meta["float_pixels"] = True
    return meta


def register(src: Path, case_id: str, source: dict, budget: dict[str, int], per_format: int) -> str | None:
    """Copy `src` into its format's samples and add or update its case. Files without a Part 10
    meta are registered under the transfer syntax pydicom's force=True reader guesses, tagged
    `no-part10-meta`."""
    try:
        head = pydicom.dcmread(src, stop_before_pixels=True, force=True)
        no_meta = "TransferSyntaxUID" not in getattr(head, "file_meta", {})
        full = read(src)
        ts = str(full.file_meta.TransferSyntaxUID)
        if not any(k in full for k in ("PixelData", "FloatPixelData", "DoubleFloatPixelData")) or ts not in TRANSFER_SYNTAXES:
            return None
        meta = describe(full)
    except Exception:
        return None
    fmt = TRANSFER_SYNTAXES[ts][0]
    cases = {c["id"]: c for c in load_cases(fmt)}
    if case_id not in cases and budget.get(fmt, 0) >= per_format:
        return None
    dst = sample_path(fmt, case_id)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)
    entry = cases.get(case_id, {"id": case_id, "notes": "", "tags": []})
    entry.update(meta)
    if no_meta and "no-part10-meta" not in entry["tags"]:
        entry["tags"].append("no-part10-meta")
    entry["source"] = source
    entry["sha256"] = sha256_file(dst)
    entry["size"] = dst.stat().st_size
    cases[case_id] = entry
    save_cases(fmt, list(cases.values()))
    budget[fmt] = budget.get(fmt, 0) + 1
    return fmt


def from_pydicom(budget, per_format) -> None:
    from pydicom.data import get_testdata_files
    for f in sorted(get_testdata_files("*")):
        p = Path(f)
        if p.suffix.lower() not in (".dcm", ""):
            continue
        fmt = register(p, f"pydicom-{p.stem}", {"kind": "pydicom", "name": p.name}, budget, per_format)
        if fmt:
            print(f"{fmt:14} pydicom-{p.stem}")


def from_local(budget, per_format) -> None:
    root = ROOT.parent / "data" / "samples"
    with tempfile.TemporaryDirectory() as td:
        for tgz in sorted(root.glob("*.tgz")):
            with tarfile.open(tgz) as t:
                t.extractall(td, filter="data")
        files = sorted(Path(td).rglob("*.dcm"))
        # one or two representatives per series is enough; keep the first and the middle file
        by_dir: dict[Path, list[Path]] = {}
        for f in files:
            by_dir.setdefault(f.parent, []).append(f)
        for d, fs in by_dir.items():
            for f in {fs[0], fs[len(fs) // 2]}:
                rel = f.relative_to(td)
                cid = "local-" + "-".join(rel.with_suffix("").parts)
                fmt = register(f, cid, {"kind": "local", "archive": "data/samples", "path": str(rel)}, budget, per_format)
                if fmt:
                    print(f"{fmt:14} {cid}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="all", choices=["pydicom", "local", "all"])
    ap.add_argument("--per-format", type=int, default=60)
    a = ap.parse_args()
    budget: dict[str, int] = {}
    if a.source in ("pydicom", "all"):
        from_pydicom(budget, a.per_format)
    if a.source in ("local", "all"):
        from_local(budget, a.per_format)


if __name__ == "__main__":
    main()
