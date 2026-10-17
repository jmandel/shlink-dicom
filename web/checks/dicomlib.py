"""Helpers the Python check scripts share (pydicom), so each is written once.

Scripts import it after putting web/checks on sys.path (they also run with python -I, which leaves
the script's own folder off it):
    sys.path.insert(0, str(Path(__file__).resolve().parents[N]))
"""
import struct

from pydicom.sequence import Sequence

#: Elements a re-encode may change: Pixel Data and Planar Configuration.
PIXEL_TAGS = {0x7FE00010, 0x00280006}


def seq0(ds, kw):
    """First item of sequence `kw`, or None."""
    s = ds.get(kw)
    return s[0] if s else None


def fg(ds, frame, kw):
    """Functional group item `kw` for a frame: per-frame first, then shared (PS3.3 C.7.6.16)."""
    per = ds.get("PerFrameFunctionalGroupsSequence")
    if per is not None and frame < len(per):
        it = seq0(per[frame], kw)
        if it is not None:
            return it
    sh = ds.get("SharedFunctionalGroupsSequence")
    return seq0(sh[0], kw) if sh else None


def norm(e, skip=PIXEL_TAGS):
    """An element's value as comparable data: sequences item by item, and numbers or bytes as their
    little-endian bytes (implicit VR files read OW/US-ambiguous data such as LUT Data as bytes)."""
    v = e.value
    if isinstance(v, Sequence):
        return [{int(x.tag): norm(x, skip) for x in item if int(x.tag) not in skip} for item in v]
    if isinstance(v, (bytes, bytearray)):
        return bytes(v)
    if e.VR in ("US", "SS", "OW", "US or SS", "US or OW", "US or SS or OW") and v is not None:
        vals = list(v) if hasattr(v, "__iter__") else [v]
        if all(isinstance(x, int) for x in vals):
            return b"".join(struct.pack("<H" if x >= 0 else "<h", x) for x in vals)
    return v


def sr_counts(items, sops):
    """Content items in an SR tree and how many reference an image, waveform or composite object
    (whose SOP Instance UIDs are appended to `sops`)."""
    n = refs = 0
    for it in items or []:
        n += 1
        if it.get("ValueType") in ("IMAGE", "COMPOSITE", "WAVEFORM") and "ReferencedSOPSequence" in it:
            refs += 1
            sops.append(str(it.ReferencedSOPSequence[0].ReferencedSOPInstanceUID))
        a, b = sr_counts(it.get("ContentSequence"), sops)
        n += a
        refs += b
    return n, refs
