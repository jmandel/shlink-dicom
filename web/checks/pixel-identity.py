"""Whether re-encoded DICOM files hold the same pixels as the files they came from, and nothing else changed:
  uv run --project codec-corpus python web/checks/pixel-identity.py pairs.json
pairs.json: [{"source": path, "shared": path}, …]. Decodes both with pydicom (pylibjpeg / GDCM for the
compressed side) and compares every frame exactly, then compares every data element outside group 2 except
Pixel Data and Planar Configuration. Prints JSON: { checked, identical, transferSyntaxes,
implementations, differ: [...] }."""
import json, sys
import struct
import numpy as np
import pydicom
from pydicom.sequence import Sequence

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


pairs = json.load(open(sys.argv[1]))
out = {"checked": 0, "identical": 0, "transferSyntaxes": {}, "implementations": {}, "differ": []}
SKIP = {0x7FE00010, 0x00280006}
for p in pairs:
    out["checked"] += 1
    a = pydicom.dcmread(p["source"])
    b = pydicom.dcmread(p["shared"])
    ts = str(b.file_meta.TransferSyntaxUID)
    out["transferSyntaxes"][ts] = out["transferSyntaxes"].get(ts, 0) + 1
    impl = f'{b.file_meta.get("ImplementationClassUID", "")} {b.file_meta.get("ImplementationVersionName", "")}'.strip()
    out["implementations"][impl] = out["implementations"].get(impl, 0) + 1
    why = None
    try:
        pa, pb = a.pixel_array, b.pixel_array
        if pa.shape != pb.shape or pa.dtype != pb.dtype or not np.array_equal(pa, pb):
            why = f"pixels differ ({pa.shape} {pa.dtype} vs {pb.shape} {pb.dtype})"
    except Exception as e:  # noqa: BLE001
        why = f"decode failed: {e}"
    if not why:
        ta = {int(e.tag): e for e in a if int(e.tag) not in SKIP}
        tb = {int(e.tag): e for e in b if int(e.tag) not in SKIP}
        if ta.keys() != tb.keys():
            why = f"elements differ: {sorted(set(ta) ^ set(tb))[:5]}"
        else:
            bad = [hex(t) for t in ta if norm(ta[t]) != norm(tb[t])]
            if bad:
                why = f"values differ: {bad[:5]}"
    if why:
        out["differ"].append({"source": p["source"], "why": why})
    else:
        out["identical"] += 1
json.dump(out, sys.stdout)
