"""Puts the object and display test files back under samples.json's dataRoot without rebuilding
samples.json: each file from the mirror first (github.com/jmandel/shlink-dicom-samples, release
objects-1), then from its source, checked against its pinned SHA-256. A file no source has any
more is left missing and its checks skip it. Cases made by make-derived.py and make-listed.py are
made by running those scripts, not fetched.

    uv run --project codec-corpus python web/checks/objects/restore.py [case ...]
"""
import json
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / "codec-corpus" / "scripts"))
from mirror import fetch, raw_url  # noqa: E402

m = json.loads((HERE / "samples.json").read_text())
root = Path(m["dataRoot"])
only = set(sys.argv[1:])


def pydicom_file(name: str):
    def write(dst: Path) -> None:
        from pydicom.data import get_testdata_file
        shutil.copyfile(get_testdata_file(name), dst)
    return write


got, missing = 0, []
for c in m["cases"]:
    if only and c["id"] not in only:
        continue
    for fd in c.get("fileDetails", []):
        if "path" not in fd or not fd.get("sha256"):
            continue
        src = fd.get("source", "")
        if src.startswith("pydicom.data.get_testdata_file("):
            origins = [pydicom_file(src.split("'")[1])]
        else:
            urls = re.findall(r"https?://\S+", src)
            origins = [u for u in (raw_url(x) for x in urls[-1:]) if u]
        if fetch(root / c["id"] / fd["path"], fd["sha256"], "objects-1", origins):
            got += 1
        else:
            missing.append(f"{c['id']}/{fd['path']}")
print(f"{got} files in place; {len(missing)} missing (optional, their checks skip them)")
for x in missing:
    print(f"  missing {x}")
