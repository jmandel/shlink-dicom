"""Index of original DICOM files, for the download checks (byte-for-byte comparisons):
  uv run --project codec-corpus python web/checks/sample-originals.py [archive, dir or file…] > /tmp/sample-originals.json
Default: the sample archives the server seeds from (data/samples/*.tgz), as they are now. Each
archive is extracted once per content (under /media/barracuda/shlink-sample-orig/<digest>/), so
a rebuilt sample never leaves a stale reference. Directories are searched for *.dcm.
Output: { sop: { path, size, series, study } }."""
import hashlib, json, sys, tarfile
from pathlib import Path
import pydicom

ROOT = Path(__file__).resolve().parents[2]
CACHE = Path("/media/barracuda/shlink-sample-orig")


def extracted(tgz: Path) -> Path:
    h = hashlib.sha256()
    with open(tgz, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    d = CACHE / h.hexdigest()[:16]
    if not (d / ".done").exists():
        d.mkdir(parents=True, exist_ok=True)
        with tarfile.open(tgz) as t:
            t.extractall(d, filter="data")
        (d / ".done").write_text(str(tgz))
    return d


args = [Path(a) for a in sys.argv[1:]] or sorted((ROOT / "data" / "samples").glob("*.tgz"))
roots = [extracted(a) if a.name.endswith(".tgz") else a for a in args]
out = {}
for p in sorted(f for a in roots for f in (a.rglob("*.dcm") if a.is_dir() else [a])):
    ds = pydicom.dcmread(p, stop_before_pixels=True, specific_tags=["SOPInstanceUID", "SeriesInstanceUID", "StudyInstanceUID"])
    out[str(ds.SOPInstanceUID)] = {"path": str(p), "size": p.stat().st_size, "series": str(ds.SeriesInstanceUID), "study": str(ds.StudyInstanceUID)}
json.dump(out, sys.stdout)
