"""Compares tiles decoded in the browser with a reference decode of the same frames.

    uv run --project codec-corpus python -I web/view/wsi-tools/ref_tiles.py TILES.json SLIDE_DIR

TILES.json: [{uid, frame, rows, columns, spp, b64, level, tx, ty}] from __wsi.tilePixels.
Reference: pydicom 3 with pylibjpeg (libjpeg for JPEG, OpenJPEG for JPEG 2000), frame by frame.
For JPEG 2000 with YBR_FULL_422 photometric, pydicom converts OpenJPEG's RGB output a second time
(codec-corpus/formats/jpeg2000/FORMAT.md, "The oracle is wrong for these cases"), so the
reference there is the raw OpenJPEG output (raw=True). Prints one line per tile and a summary;
exits 1 if any tile differs by more than the tolerance (0 for JPEG baseline, 2 for JPEG 2000 9/7).
"""
import base64, glob, json, os, sys
import numpy as np
import pydicom
from pydicom.pixels import pixel_array

tiles = json.load(open(sys.argv[1]))
files = {}
for p in glob.glob(os.path.join(sys.argv[2], "*.dcm")):
    files[pydicom.dcmread(p, stop_before_pixels=True).SOPInstanceUID] = p
worst = 0
bad = 0
for t in tiles:
    p = files[t["uid"]]
    ds = pydicom.dcmread(p, stop_before_pixels=True)
    ts = str(ds.file_meta.TransferSyntaxUID)
    j2k = ts in ("1.2.840.10008.1.2.4.90", "1.2.840.10008.1.2.4.91")
    raw = j2k and ds.PhotometricInterpretation == "YBR_FULL_422"
    ref = pixel_array(p, index=t["frame"], raw=raw)
    got = np.frombuffer(base64.b64decode(t["b64"]), dtype=np.uint8).reshape(t["rows"], t["columns"], t["spp"]) if t["spp"] > 1 else np.frombuffer(base64.b64decode(t["b64"]), dtype=np.uint8).reshape(t["rows"], t["columns"])
    ref = ref.reshape(got.shape)
    d = np.abs(ref.astype(np.int16) - got.astype(np.int16))
    tol = 2 if j2k and ts == "1.2.840.10008.1.2.4.91" else 0
    m = int(d.max())
    worst = max(worst, m)
    ok = m <= tol
    bad += not ok
    print(f"{'ok ' if ok else 'BAD'} level {t['level']} tile ({t['tx']},{t['ty']}) frame {t['frame']} {ts} {ds.PhotometricInterpretation}{' raw' if raw else ''}: "
          f"max |diff| {m}, {int((d > 0).sum())} of {d.size} samples differ (tolerance {tol}), mean {got.mean():.1f}")
print(f"{len(tiles)} tiles, {bad} over tolerance, worst |diff| {worst}")
sys.exit(1 if bad else 0)
