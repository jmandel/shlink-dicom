"""Index of the DICOM files a share holds, for the download checks:
  uv run --project codec-corpus python web/checks/sample-originals.py [--source] [archive, dir or file…] > /tmp/sample-originals.json
Default: the sample archives the server seeds from (data/samples/*.tgz), as the seed shares them:
uncompressed images re-encoded without loss by `shl-dicom-server compress` (the seed's own rules and
encoder), everything else as it is. Each re-encoded file is checked here against its source: same
pixels (pydicom, decoding with pylibjpeg or GDCM) and every element outside group 2 the same, apart
from Pixel Data and Planar Configuration. --source, or explicit paths: the files as they are.
Archives are extracted once per content (under /media/barracuda/shlink-sample-orig/<digest>/), so a
rebuilt sample never leaves a stale reference. Directories are searched for *.dcm.
Output: { sop: { path, size, series, study, source?, reencoded? } }, where `source` is the file it
was re-encoded from."""
import hashlib, json, subprocess, sys, tarfile
from pathlib import Path
import struct
import numpy as np
import pydicom
from pydicom.sequence import Sequence

ROOT = Path(__file__).resolve().parents[2]
CACHE = Path("/media/barracuda/shlink-sample-orig")
SERVER = ROOT / "target" / "release" / "shl-dicom-server"
SKIP = {0x7FE00010, 0x00280006}


def digest(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def extracted(tgz: Path) -> Path:
    d = CACHE / digest(tgz)
    if not (d / ".done").exists():
        d.mkdir(parents=True, exist_ok=True)
        with tarfile.open(tgz) as t:
            t.extractall(d, filter="data")
        (d / ".done").write_text(str(tgz))
    return d


def norm(e):
    """An element's value as comparable data: sequences item by item, and numbers or bytes as their
    little-endian bytes (implicit VR files read OW/US-ambiguous data such as LUT Data as bytes)."""
    v = e.value
    if isinstance(v, Sequence):
        return [{int(x.tag): norm(x) for x in item if int(x.tag) not in SKIP} for item in v]
    if isinstance(v, (bytes, bytearray)):
        return bytes(v)
    if e.VR in ("US", "SS", "OW", "US or SS", "US or OW", "US or SS or OW") and v is not None:
        vals = list(v) if hasattr(v, "__iter__") else [v]
        if all(isinstance(x, int) for x in vals):
            return b"".join(struct.pack("<H" if x >= 0 else "<h", x) for x in vals)
    return v


def same_except_pixels(a, b) -> str | None:
    pa, pb = a.pixel_array, b.pixel_array
    if pa.shape != pb.shape or pa.dtype != pb.dtype or not np.array_equal(pa, pb):
        return "pixels differ"
    ta = {int(e.tag): e for e in a if int(e.tag) not in SKIP}
    tb = {int(e.tag): e for e in b if int(e.tag) not in SKIP}
    if ta.keys() != tb.keys() or any(norm(ta[t]) != norm(tb[t]) for t in ta):
        return "elements differ"
    return None


def shared(tgz: Path) -> Path:
    """The archive's files as the seed shares them, each re-encoded one checked against its source."""
    d = CACHE / f"{digest(tgz)}-shared-{digest(SERVER)}"
    if not (d / ".done").exists():
        subprocess.run([str(SERVER), "compress", str(tgz), "--out", str(d)], check=True, stdout=subprocess.DEVNULL)
        src = {}
        for p in extracted(tgz).rglob("*.dcm"):
            src[str(pydicom.dcmread(p, stop_before_pixels=True, specific_tags=["SOPInstanceUID"]).SOPInstanceUID)] = p
        for p in d.rglob("*.dcm"):
            ds = pydicom.dcmread(p)
            orig = src[str(ds.SOPInstanceUID)]
            if p.read_bytes() == orig.read_bytes():
                continue
            why = same_except_pixels(pydicom.dcmread(orig), ds)
            if why:
                sys.exit(f"{p}: re-encoded file is not pixel-identical to {orig} ({why})")
        (d / ".done").write_text(str(tgz))
    return d


args = [a for a in sys.argv[1:] if not a.startswith("--")]
as_shared = not args and "--source" not in sys.argv
paths = [Path(a) for a in args] or sorted((ROOT / "data" / "samples").glob("*.tgz"))
out = {}
for a in paths:
    root = shared(a) if as_shared else extracted(a) if a.name.endswith(".tgz") else a
    sources = {}
    if as_shared:
        for p in extracted(a).rglob("*.dcm"):
            sources[str(pydicom.dcmread(p, stop_before_pixels=True, specific_tags=["SOPInstanceUID"]).SOPInstanceUID)] = p
    for p in sorted(root.rglob("*.dcm") if root.is_dir() else [root]):
        ds = pydicom.dcmread(p, stop_before_pixels=True, specific_tags=["SOPInstanceUID", "SeriesInstanceUID", "StudyInstanceUID"])
        uid = str(ds.SOPInstanceUID)
        e = {"path": str(p), "size": p.stat().st_size, "series": str(ds.SeriesInstanceUID), "study": str(ds.StudyInstanceUID)}
        if uid in sources:
            e["source"] = str(sources[uid])
            e["reencoded"] = e["size"] != sources[uid].stat().st_size or p.read_bytes() != sources[uid].read_bytes()
        out[uid] = e
json.dump(out, sys.stdout)
