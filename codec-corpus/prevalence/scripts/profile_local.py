"""Profile every DICOM file inside one or more .tgz/.tar/.zip archives or directories.

    uv run python prevalence/scripts/profile_local.py OUT_PREFIX PATH [PATH ...]

Writes OUT_PREFIX.csv (profile x modality counts) and OUT_PREFIX-sets.csv (profile sets
per series and per study). Files are read in memory with stop_before_pixels; nothing is
extracted to disk.
"""

from __future__ import annotations

import io
import sys
import tarfile
import zipfile
from pathlib import Path

import pydicom

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pixprofile import aggregate, key_from_dataset, write_tables  # noqa: E402


def iter_blobs(path: Path):
    if path.is_dir():
        for p in sorted(path.rglob("*")):
            if p.is_file():
                yield str(p), p.read_bytes()
    elif tarfile.is_tarfile(path):
        with tarfile.open(path) as t:
            for m in t:
                if m.isfile():
                    yield f"{path.name}:{m.name}", t.extractfile(m).read()
    elif zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            for n in z.namelist():
                if not n.endswith("/"):
                    yield f"{path.name}:{n}", z.read(n)


def main() -> None:
    out = Path(sys.argv[1])
    units = []
    skipped = 0
    for arg in sys.argv[2:]:
        for name, blob in iter_blobs(Path(arg)):
            try:
                ds = pydicom.dcmread(io.BytesIO(blob), stop_before_pixels=True)
            except Exception:
                skipped += 1
                continue
            if "BitsAllocated" not in ds:
                skipped += 1  # DICOMDIR, SR, presentation states, ...
                continue
            units.append((
                str(ds.get("StudyInstanceUID", name)),
                str(ds.get("SeriesInstanceUID", name)),
                str(ds.get("Modality", "")),
                key_from_dataset(ds),
                1,
            ))
    rows, ss, st = aggregate(units)
    write_tables(out, rows, ss, st)
    print(f"{len(units)} image instances, {skipped} other files skipped -> {out}.csv")


if __name__ == "__main__":
    main()
