"""Puts every fetched case's sample in formats/<fmt>/samples, from the mirror first (release
codec-corpus-1), then from its source, checked against the SHA-256 in cases.json.

Generated, repaired and stripped cases are made by generate.py and the scripts in sources/, not
fetched. A case whose file no source still has is left missing; check.py skips it. Files that
need a local clone (GDCM, Orthanc, fo-dicom, dcm4che, issue attachments) can also be put back by
sources/quirks.py.

Usage:  uv run python scripts/restore.py [--format FMT ...] [--case SUBSTRING]
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import FORMAT_NAMES, load_cases, sample_path  # noqa: E402
from mirror import fetch, raw_url  # noqa: E402

FETCHED = {"idc", "external", "pydicom"}


def pydicom_file(name: str):
    def write(dst: Path) -> None:
        from pydicom.data import get_testdata_file
        src = get_testdata_file(name)
        if not src:
            raise ValueError(f"pydicom has no test file {name}")
        shutil.copyfile(src, dst)
    return write


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--format", action="append", choices=FORMAT_NAMES)
    ap.add_argument("--case")
    a = ap.parse_args()
    got, missing = 0, []
    for fmt in a.format or FORMAT_NAMES:
        for c in load_cases(fmt):
            s = c.get("source", {})
            if s.get("kind") not in FETCHED or not c.get("sha256") or (a.case and a.case not in c["id"]):
                continue
            origins = [pydicom_file(s["name"])] if s["kind"] == "pydicom" else [u for u in [raw_url(s.get("url"))] if u]
            if fetch(sample_path(fmt, c["id"]), c["sha256"], "codec-corpus-1", origins):
                got += 1
            else:
                missing.append(f"{fmt}/{c['id']}")
    print(f"{got} samples in place; {len(missing)} missing (optional, skipped by check.py)")
    for m in missing:
        print(f"  missing {m}")


if __name__ == "__main__":
    main()
