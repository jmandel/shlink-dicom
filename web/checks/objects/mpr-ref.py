"""Oracle for reformatted planes (display-checks.mjs): SimpleITK resamples the series, written
independently of the viewer, onto the plane's pixel grid; a slab combines its planes with numpy.

  uv run --project codec-corpus --with simpleitk --with pillow python mpr-ref.py <job.json>

job.json: { files: [paths], spec: { origin, u, v, w, spacing, width, height, offsets, mode,
background }, window: { center, width, exact }, out: "plane.png", lattice: "sheared" | "orthogonal" }

The series becomes an ITK image whose index → patient map is the DICOM one: origin at the first
slice's first pixel, axes along the row and column cosines and along the step from slice to slice
(not orthogonal when the gantry was tilted; "orthogonal" forces the step onto the normal, which is
what a viewer that ignores tilt assumes). Linear interpolation, points outside are NaN; a slab takes
the maximum, minimum or mean of the planes' points that are inside. Values are rounded half up
(as the viewer does) and windowed: PS3.3 C.11.2.1.2 LINEAR, or LINEAR_EXACT."""
import json, math, sys
import numpy as np
import pydicom
import SimpleITK as sitk
from PIL import Image

job = json.load(open(sys.argv[1]))
ds = [pydicom.dcmread(f) for f in job["files"]]
row = np.array(ds[0].ImageOrientationPatient[:3], float)
col = np.array(ds[0].ImageOrientationPatient[3:], float)
n = np.cross(row, col)
ds.sort(key=lambda x: float(np.dot(np.array(x.ImagePositionPatient, float), n)))
p0 = np.array(ds[0].ImagePositionPatient, float)
step = (np.array(ds[-1].ImagePositionPatient, float) - p0) / (len(ds) - 1)
if job.get("lattice") == "orthogonal":
    step = n * float(np.dot(step, n))
sr, sc = (float(v) for v in ds[0].PixelSpacing)
slope = float(getattr(ds[0], "RescaleSlope", 1))
icpt = float(getattr(ds[0], "RescaleIntercept", 0))
vol = np.stack([x.pixel_array.astype(np.float64) for x in ds])  # z, y, x: stored values
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
        val = np.nanmax(stack, 0) if slope >= 0 else np.nanmin(stack, 0)
    elif spec["mode"] == "minip":
        val = np.nanmin(stack, 0) if slope >= 0 else np.nanmax(stack, 0)
    else:
        val = np.nanmean(stack, 0)
val = np.where(np.isnan(val), spec["background"], np.floor(val + 0.5))
real = val * slope + icpt
c, wd = job["window"]["center"], job["window"]["width"]
if job["window"].get("exact"):
    y = (real - c) / wd + 0.5
else:
    y = (real - (c - 0.5)) / (wd - 1) + 0.5
out = np.clip(np.floor(np.clip(y, 0, 1) * 255 + 0.5), 0, 255).astype(np.uint8)
Image.fromarray(out, "L").convert("RGB").save(job["out"])
# Stored values too, for checks that compare values rather than grey levels.
np.save(job["out"].replace(".png", ".npy"), val)
print(json.dumps({"width": out.shape[1], "height": out.shape[0], "inside": float(np.mean(~np.isnan(stack).all(0)))}))
