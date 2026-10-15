"""Real values and the default window of Float Pixel Data images, as the viewer should show them
(shared by make-derived.py for reference renderings and expect.py for expected values)."""
import numpy as np


def rw_item(ds, k=0):
    """First Real World Value Mapping item for frame k: per-frame, shared, top level."""
    for src in (ds.get("PerFrameFunctionalGroupsSequence", [None] * (k + 1))[k], (ds.get("SharedFunctionalGroupsSequence") or [None])[0], ds):
        if src is not None and "RealWorldValueMappingSequence" in src:
            return src.RealWorldValueMappingSequence[0]
    return None


def float_window(ds, real):
    """The file's window, else the range the mapping covers, else the finite data range (real values)."""
    for src in (ds.get("PerFrameFunctionalGroupsSequence", [None])[0], (ds.get("SharedFunctionalGroupsSequence") or [None])[0], ds):
        v = src.get("FrameVOILUTSequence", [src])[0] if src is not None else None
        if v is not None and "WindowCenter" in v and "WindowWidth" in v:
            c = v.WindowCenter[0] if hasattr(v.WindowCenter, "__len__") else v.WindowCenter
            w = v.WindowWidth[0] if hasattr(v.WindowWidth, "__len__") else v.WindowWidth
            if float(w) > 0:
                return float(c), float(w)
    it = rw_item(ds)
    if it is not None:
        first = it.get("DoubleFloatRealWorldValueFirstValueMapped", it.get("RealWorldValueFirstValueMapped"))
        last = it.get("DoubleFloatRealWorldValueLastValueMapped", it.get("RealWorldValueLastValueMapped"))
        if first is not None and last is not None and float(last) > float(first):
            m, b = float(it.get("RealWorldValueSlope", 1)), float(it.get("RealWorldValueIntercept", 0))
            lo, hi = sorted((float(first) * m + b, float(last) * m + b))
            return (lo + hi) / 2, hi - lo
    fin = real[np.isfinite(real)]
    lo, hi = float(fin.min()), float(fin.max())
    return (lo + hi) / 2, (hi - lo) or (abs(lo) or 1.0)


def float_real(ds):
    a = ds.pixel_array.astype(np.float64)
    if int(ds.get("NumberOfFrames", 1)) == 1:
        a = a[None]
    it = rw_item(ds)
    m, b = (float(it.get("RealWorldValueSlope", 1)), float(it.get("RealWorldValueIntercept", 0))) if it is not None else (1.0, 0.0)
    return a * m + b
