#!/usr/bin/env python3
"""Window the traced slice (data/slice.dcm, written by trace.mjs) with its own Window Center/Width and save assets/slice.png.
Run with the codec-corpus venv, which has pydicom and a JPEG Lossless decoder."""
import os, subprocess, pydicom, numpy as np
here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
d = pydicom.dcmread(os.path.join(here, "data", "slice.dcm"))
a = d.pixel_array.astype(float)
one = lambda v: float(v[0] if isinstance(v, pydicom.multival.MultiValue) else v)
wc, ww = one(d.WindowCenter), one(d.WindowWidth)
b = np.clip((a - (wc - ww / 2)) / ww * 255, 0, 255).astype("uint8")
pgm = os.path.join(here, "data", "slice.pgm")
open(pgm, "wb").write(b"P5 %d %d 255\n" % (d.Columns, d.Rows) + b.tobytes())
subprocess.run(["magick", pgm, os.path.join(here, "assets", "slice.png")], check=True); os.remove(pgm)
print("slice.png", d.Rows, d.Columns, d.file_meta.TransferSyntaxUID.name)
