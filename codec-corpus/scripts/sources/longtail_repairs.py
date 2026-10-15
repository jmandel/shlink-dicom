"""Repaired copies for long-tail cases that lack Planar Configuration (prevalence/LONGTAIL.md).

    uv run python scripts/sources/longtail_repairs.py

For each registered idc-lt-* case in the "missing Planar Configuration" groups, write a copy with
(0028,0006) set to the layout the evidence supports, and register it as idc-lt-repair-planar<v>-<hash8>
(source kind "repair", "of" = the original case). No reference decodes the originals (pydicom needs
the element), so oracle.py gives them expect=error; the repaired copies get a normal oracle. The
coordinator can point each original at its copy with `oracle_case` (scripts/repairs.py pattern).
Evidence per file: the mean absolute horizontal neighbour difference of the two readings
(interleaved vs planar), and a visual check of the Philips file (planar reading is a clean CT
montage; the interleaved one tiles 3x3).
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import numpy as np
import pydicom

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from common import ROOT, load_cases, sample_path, save_cases, sha256_file  # noqa: E402
from discover import describe  # noqa: E402

D = ROOT / "prevalence" / "cache" / "longtail"


def roughness(a: np.ndarray) -> float:
    return float(np.abs(np.diff(a.astype(np.int16), axis=-2)).mean())


def main() -> int:
    reg = json.loads((D / "registered.json").read_text())
    out = []
    for r in reg:
        if not r["group"].startswith("missing Planar Configuration"):
            continue
        src = sample_path(r["format"], r["case"])
        ds = pydicom.dcmread(src, force=True)
        f = int(getattr(ds, "NumberOfFrames", 1) or 1)
        rows, cols = int(ds.Rows), int(ds.Columns)
        b = np.frombuffer(ds.PixelData[: f * rows * cols * 3], np.uint8)
        inter = roughness(b.reshape(f, rows, cols, 3))
        planar = roughness(b.reshape(f, 3, rows, cols).transpose(0, 2, 3, 1))
        pc = 0 if inter < planar else 1
        ds.PlanarConfiguration = pc
        cid = f"idc-lt-repair-planar{pc}-{r['case'].rsplit('-', 1)[1]}"
        dst = sample_path(r["format"], cid)
        ds.save_as(dst, enforce_file_format=True)
        orig = next(c for c in load_cases(r["format"]) if c["id"] == r["case"])
        entry = {"id": cid, "notes": "", "tags": ["repair", "idc-longtail"], **describe(pydicom.dcmread(dst)),
                 "source": {"kind": "repair", "of": r["case"], "license": orig["source"].get("license", ""),
                            "how": f"(0028,0006) Planar Configuration = {pc} added; neighbour difference "
                                   f"interleaved {inter:.2f}, planar {planar:.2f}"},
                 "sha256": sha256_file(dst), "size": dst.stat().st_size}
        save_cases(r["format"], [entry])
        out.append({"case": cid, "of": r["case"], "planar": pc, "interleaved_roughness": round(inter, 2),
                    "planar_roughness": round(planar, 2)})
        print(json.dumps(out[-1]))
    (D / "repairs.json").write_text(json.dumps(out, indent=1) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
