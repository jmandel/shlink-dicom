"""Oracle for reformatted planes (display-checks.mjs and sop-sweep-checks.mjs): SimpleITK
resamples a series, written independently of the viewer, onto the plane's pixel grid; a slab
combines its planes with numpy.

  uv run --project codec-corpus --with simpleitk --with pillow python -I mpr-ref.py <job.json>

job.json: { files: [paths], spec: { origin, u, v, w, spacing, width, height, offsets, mode,
background }, window: { center, width, exact? }, out: "plane.png", lattice?: "sheared" | "orthogonal" }

The slices come from any mix of single-frame instances and frames of multi-frame instances, each
with its own geometry (Plane Position / Plane Orientation / Pixel Measures from the per-frame or
shared functional groups, else the top-level attributes) and rescale (Pixel Value Transformation
per frame, else Rescale Slope / Intercept), ordered by position along the normal. The series
becomes an ITK image whose index → patient map is the DICOM one: origin at the first slice's first
pixel, axes along the row and column cosines and along the step from slice to slice (not orthogonal
when the gantry was tilted; "orthogonal" forces the step onto the normal, which is what a viewer
that ignores tilt assumes). Linear interpolation, points outside are NaN; a slab takes the maximum,
minimum or mean of the planes' points that are inside.

When every slice has the same rescale, stored values are interpolated, rounded half up and then
rescaled (what the viewer does), and a negative slope swaps the slab's maximum and minimum. When
the rescale differs between slices, real values are interpolated: the meaningful answer, which a
viewer that interpolates stored values and applies one slice's rescale to all will not match.
Windowing is PS3.3 C.11.2.1.2 LINEAR, or LINEAR_EXACT with `exact`. With one rescale, the stored
values are also written next to the PNG (.npy), for checks that compare values."""
import json
import sys
from pathlib import Path

import numpy as np
import pydicom
import SimpleITK as sitk
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dicomlib import fg  # noqa: E402

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
if job.get("lattice") == "orthogonal":
    step = n * float(np.dot(step, n))
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
# With one negative slope, the largest stored value is the smallest real one.
flip = uniform and slope < 0
with np.errstate(all="ignore"):
    if len(planes) == 1:
        val = stack[0]
    elif spec["mode"] == "mip":
        val = np.nanmin(stack, 0) if flip else np.nanmax(stack, 0)
    elif spec["mode"] == "minip":
        val = np.nanmax(stack, 0) if flip else np.nanmin(stack, 0)
    else:
        val = np.nanmean(stack, 0)
if uniform:
    val = np.where(np.isnan(val), spec["background"], np.floor(val + 0.5))
    real = val * slope + icpt
else:
    # Outside: the viewer's background (a stored value) through the first slice's rescale.
    real = np.where(np.isnan(val), spec["background"] * slope + icpt, val)
c, wd = job["window"]["center"], job["window"]["width"]
if job["window"].get("exact"):
    y = (real - c) / wd + 0.5
else:
    y = (real - (c - 0.5)) / (wd - 1) + 0.5
out = np.clip(np.floor(np.clip(y, 0, 1) * 255 + 0.5), 0, 255).astype(np.uint8)
Image.fromarray(out, "L").convert("RGB").save(job["out"])
if uniform:
    np.save(job["out"].replace(".png", ".npy"), val)
print(json.dumps({"width": out.shape[1], "height": out.shape[0], "uniformRescale": uniform, "slices": len(slices),
                  "inside": float(np.mean(~np.isnan(stack).all(0)))}))
