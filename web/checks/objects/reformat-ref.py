"""Reference reformat for display-checks.mjs: a sagittal or coronal plane through an axial CT
series, written independently of the viewer (numpy), windowed and saved as a grey PNG.
  python reformat-ref.py <dir> <sagittal|coronal> <index> <center> <width> <out.png> <files…>
Slices are ordered along the normal; the slice axis is resampled linearly to the in-plane
pixel spacing; patient superior is up. Window: DICOM PS3.3 C.11.2.1.2 (LINEAR)."""
import sys
import numpy as np
import pydicom
from PIL import Image

d, plane, index, c, w, out, *files = sys.argv[1:]
index, c, w = int(index), float(c), float(w)
ds = [pydicom.dcmread(f"{d}/{f}") for f in files]
row = np.array(ds[0].ImageOrientationPatient[:3], float)
col = np.array(ds[0].ImageOrientationPatient[3:], float)
n = np.cross(row, col)
ds.sort(key=lambda x: float(np.dot(np.array(x.ImagePositionPatient, float), n)))
pos = [float(np.dot(np.array(x.ImagePositionPatient, float), n)) for x in ds]
dz = (pos[-1] - pos[0]) / (len(pos) - 1)
vol = np.stack([x.pixel_array.astype(np.float64) * float(getattr(x, "RescaleSlope", 1)) + float(getattr(x, "RescaleIntercept", 0)) for x in ds])  # z, y, x
ps = [float(v) for v in ds[0].PixelSpacing]  # rows, columns
if plane == "sagittal":  # fix a column: x is the row direction
    sl = vol[:, :, index]  # z, y
    sp = ps[0]
else:  # coronal: fix a row
    sl = vol[:, index, :]  # z, x
    sp = ps[1]
depth = sl.shape[0]
out_rows = round((depth - 1) * dz / sp) + 1
zf = np.linspace(0, depth - 1, out_rows)
if n[2] > 0:
    zf = (depth - 1) - zf  # superior up
z0 = np.floor(zf).astype(int)
z1 = np.minimum(depth - 1, z0 + 1)
t = (zf - z0)[:, None]
# The viewer resamples stored values and rounds, then rescales: do the same.
slope = float(getattr(ds[0], "RescaleSlope", 1)); icpt = float(getattr(ds[0], "RescaleIntercept", 0))
stored = (sl - icpt) / slope
img = np.round(stored[z0] * (1 - t) + stored[z1] * t) * slope + icpt
y = ((img - (c - 0.5)) / (w - 1) + 0.5)
y = np.clip(np.floor(y * 255 + 0.5), 0, 255).astype(np.uint8)
Image.fromarray(y, "L").convert("RGB").save(out)
