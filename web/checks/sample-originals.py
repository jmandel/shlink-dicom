"""Index of original DICOM files, for the download checks (byte-for-byte comparisons):
  uv run --project codec-corpus python web/checks/sample-originals.py [dir or file…] > /tmp/sample-originals.json
Default: the sample archives (data/samples/*.tgz) extracted in /media/barracuda/shlink-sample-orig.
Directories are searched for *.dcm. Output: { sop: { path, size, series, study } }."""
import json, sys
from pathlib import Path
import pydicom

args = [Path(a) for a in sys.argv[1:]] or [Path("/media/barracuda/shlink-sample-orig")]
out = {}
for p in sorted(f for a in args for f in (a.rglob("*.dcm") if a.is_dir() else [a])):
    ds = pydicom.dcmread(p, stop_before_pixels=True, specific_tags=["SOPInstanceUID", "SeriesInstanceUID", "StudyInstanceUID"])
    out[str(ds.SOPInstanceUID)] = {"path": str(p), "size": p.stat().st_size, "series": str(ds.SeriesInstanceUID), "study": str(ds.StudyInstanceUID)}
json.dump(out, sys.stdout)
