"""Reformat oracle for the object-type sweep: SimpleITK resamples a series onto the viewer's plane grid.

    uv run --project codec-corpus --with simpleitk --with pillow python -I mpr-oracle.py JOB.json

Like objects/mpr-ref.py, but the slices come from any mix of single-frame instances and frames of
multi-frame instances, each with its own geometry (Plane Position / Plane Orientation / Pixel
Measures from the per-frame or shared functional groups, else the top-level attributes) and its own
rescale (Pixel Value Transformation per frame, else Rescale Slope/Intercept). Slices are ordered by
position along the normal here, not by frame or instance number.

When every slice has the same rescale, stored values are interpolated, rounded half up and then
rescaled (what the viewer does). When the rescale differs between slices, real values are
interpolated: the meaningful answer, which a viewer that interpolates stored values and applies one
slice's rescale to all will not match.

JOB: { files: [paths], spec: { origin, u, v, w, spacing, width, height, offsets, mode, background },
       window: { center, width }, out: "plane.png" }
"""
import json
import sys

import numpy as np
import pydicom
import SimpleITK as sitk
from PIL import Image


def seq0(ds, kw):
    s = ds.get(kw)
    return s[0] if s else None


def fg(ds, frame, kw):
    per = ds.get("PerFrameFunctionalGroupsSequence")
    if per is not None and frame < len(per):
        it = seq0(per[frame], kw)
        if it is not None:
            return it
    sh = ds.get("SharedFunctionalGroupsSequence")
    return seq0(sh[0], kw) if sh else None


job = json.load(open(sys.argv[1]))
slices = []
for f in job["files"]:
    ds = pydicom.dcmread(f)
    arr = ds.pixel_array.astype(np.float64)
    nf = int(ds.get("NumberOfFrames", 1) or 1)
    if nf == 1:
        arr = arr[None]
    for k in range(nf):
        pp, po, pm, pt = (fg(ds, k, s) for s in ("PlanePositionSequence", "PlaneOrientationSequence", "PixelMeasuresSequence", "PixelValueTransformationSequence"))
        ipp = np.array((pp or ds).ImagePositionPatient, float)
        iop = np.array((po or ds).ImageOrientationPatient, float)
        ps = [float(x) for x in (pm or ds).PixelSpacing]
        if "GridFrameOffsetVector" in ds:
            ipp = ipp + np.cross(iop[:3], iop[3:]) * float(ds.GridFrameOffsetVector[k])
        src = pt if pt is not None and "RescaleSlope" in pt else ds
        slices.append(dict(ipp=ipp, iop=iop, ps=ps, px=arr[k], slope=float(src.get("RescaleSlope", 1) or 1), icpt=float(src.get("RescaleIntercept", 0) or 0)))
row, col = slices[0]["iop"][:3], slices[0]["iop"][3:]
n = np.cross(row, col)
slices.sort(key=lambda s: float(s["ipp"] @ n))
p0 = slices[0]["ipp"]
step = (slices[-1]["ipp"] - p0) / (len(slices) - 1)
sr, sc = slices[0]["ps"]
uniform = len({(s["slope"], s["icpt"]) for s in slices}) == 1
slope, icpt = slices[0]["slope"], slices[0]["icpt"]
vol = np.stack([s["px"] if uniform else s["px"] * s["slope"] + s["icpt"] for s in slices])
img = sitk.GetImageFromArray(vol)
img.SetOrigin(tuple(p0))
dz = float(np.linalg.norm(step))
img.SetSpacing((sc, sr, dz))
d = step / dz
img.SetDirection((row[0], col[0], d[0], row[1], col[1], d[1], row[2], col[2], d[2]))
spec = job["spec"]
u, v, w = (np.array(spec[k], float) for k in ("u", "v", "w"))
planes = []
for off in spec["offsets"]:
    ref = sitk.Image(int(spec["width"]), int(spec["height"]), 1, sitk.sitkFloat64)
    ref.SetSpacing((spec["spacing"], spec["spacing"], 1.0))
    ref.SetOrigin(tuple(np.array(spec["origin"], float) + w * off))
    ref.SetDirection((u[0], v[0], w[0], u[1], v[1], w[1], u[2], v[2], w[2]))
    r = sitk.Resample(img, ref, sitk.Transform(), sitk.sitkLinear, float("nan"), sitk.sitkFloat64)
    planes.append(sitk.GetArrayFromImage(r)[0])
stack = np.stack(planes)
with np.errstate(all="ignore"):
    if len(planes) == 1:
        val = stack[0]
    elif spec["mode"] == "mip":
        val = np.nanmax(stack, 0)
    elif spec["mode"] == "minip":
        val = np.nanmin(stack, 0)
    else:
        val = np.nanmean(stack, 0)
if uniform:
    real = np.where(np.isnan(val), spec["background"], np.floor(val + 0.5)) * slope + icpt
else:
    # Outside: the viewer's background (a stored value) through the first slice's rescale.
    real = np.where(np.isnan(val), spec["background"] * slope + icpt, val)
c, wd = job["window"]["center"], job["window"]["width"]
y = (real - (c - 0.5)) / (wd - 1) + 0.5
out = np.clip(np.floor(np.clip(y, 0, 1) * 255 + 0.5), 0, 255).astype(np.uint8)
Image.fromarray(out, "L").convert("RGB").save(job["out"])
print(json.dumps({"width": out.shape[1], "height": out.shape[0], "uniformRescale": uniform, "slices": len(slices),
                  "inside": float(np.mean(~np.isnan(stack).all(0)))}))
