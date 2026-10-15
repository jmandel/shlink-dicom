"""Compares tiles decoded in the browser with a reference decode of the same frames.

    uv run --project codec-corpus python -I web/view/wsi-tools/ref_tiles.py TILES.json SLIDE_DIR [SRGB.icc]

TILES.json: [{uid, frame, rows, columns, spp, bits, b64, level, tx, ty, plane, path, icc}] from
__wsi.tilePixels (decoded samples) or, with "icc": true, __wsi.tileRgb (what is drawn, after the
scanner's ICC profile).
References:
  - pydicom 3 with pylibjpeg (libjpeg, OpenJPEG), frame by frame; 1-bit segmentation frames unpacked;
  - JPEG XL frames: libjxl through imagecodecs (pydicom 3.0 has no JPEG XL decoder);
  - "icc": the reference decode converted with lcms2 (ImageMagick -profile) from the instance's ICC
    profile to SRGB.icc.
For JPEG 2000 with YBR_FULL_422, pydicom converts OpenJPEG's RGB output a second time
(codec-corpus/formats/jpeg2000/FORMAT.md), so the reference there is the raw output (raw=True).
Tolerances: 0 for lossless and JPEG baseline; 2 for JPEG 2000 9/7 and lossy JPEG XL (decoder
float differences); 1 for JPEG XL JPEG recompression (inverse DCT rounding); ICC: mean ≤ 1 and
max ≤ 12 (the 33³ table against lcms2).
Prints one line per tile and a summary; exits 1 if any tile is over its tolerance.
"""
import base64, glob, json, os, subprocess, sys, tempfile
import numpy as np
import imagecodecs
import pydicom
from pydicom.encaps import generate_frames
from pydicom.pixels import pixel_array
from pydicom._uid_dict import UID_dictionary

for _uid, _name, _kw in [("1.2.840.10008.1.2.4.110", "JPEG XL Lossless", "JPEGXLLossless"),
                         ("1.2.840.10008.1.2.4.111", "JPEG XL JPEG Recompression", "JPEGXLJPEGRecompression"),
                         ("1.2.840.10008.1.2.4.112", "JPEG XL", "JPEGXL")]:
    UID_dictionary.setdefault(_uid, (_name, "Transfer Syntax", "", "", _kw))
JXL = {"1.2.840.10008.1.2.4.110", "1.2.840.10008.1.2.4.111", "1.2.840.10008.1.2.4.112"}

tiles = json.load(open(sys.argv[1]))
srgb = sys.argv[3] if len(sys.argv) > 3 else None
files = {}
for p in glob.glob(os.path.join(sys.argv[2], "**/*.dcm"), recursive=True):
    files[pydicom.dcmread(p, stop_before_pixels=True).SOPInstanceUID] = p


def reference(p, ds, ts, frame):
    if ts in JXL:
        full = pydicom.dcmread(p)
        frames = generate_frames(full.PixelData, number_of_frames=int(full.NumberOfFrames))
        for k, f in enumerate(frames):
            if k == frame:
                return imagecodecs.jpegxl_decode(f)
    raw = ts in ("1.2.840.10008.1.2.4.90", "1.2.840.10008.1.2.4.91") and ds.PhotometricInterpretation == "YBR_FULL_422"
    return pixel_array(p, index=frame, raw=raw)


def icc_convert(rgb, profile):
    with tempfile.TemporaryDirectory() as d:
        h, w = rgb.shape[:2]
        open(f"{d}/in.ppm", "wb").write(f"P6\n{w} {h}\n255\n".encode() + rgb.astype(np.uint8).tobytes())
        open(f"{d}/p.icc", "wb").write(profile)
        subprocess.run(["magick", f"{d}/in.ppm", "-profile", f"{d}/p.icc", "-profile", srgb, f"{d}/out.ppm"], check=True)
        b = open(f"{d}/out.ppm", "rb").read()
        return np.frombuffer(b[len(b) - w * h * 3:], dtype=np.uint8).reshape(h, w, 3)


worst, bad = 0, 0
for t in tiles:
    p = files[t["uid"]]
    ds = pydicom.dcmread(p, stop_before_pixels=True)
    ts = str(ds.file_meta.TransferSyntaxUID)
    ref = reference(p, ds, ts, t["frame"])
    bits = t.get("bits", 8)
    dtype = np.uint16 if bits == 16 else np.uint8
    shape = (t["rows"], t["columns"], t["spp"]) if t["spp"] > 1 else (t["rows"], t["columns"])
    got = np.frombuffer(base64.b64decode(t["b64"]), dtype=dtype).reshape(shape)
    ref = np.asarray(ref).reshape(shape)
    label = ""
    if t.get("icc"):
        profile = bytes(ds.OpticalPathSequence[0].ICCProfile)
        ref = icc_convert(ref, profile)
        d = np.abs(ref.astype(np.int32) - got.astype(np.int32))
        m, mean = int(d.max()), float(d.mean())
        ok = m <= 12 and mean <= 1.0
        label = f"ICC→sRGB vs lcms2: max {m}, mean {mean:.3f}"
    else:
        d = np.abs(ref.astype(np.int32) - got.astype(np.int32))
        # 9/7 JPEG 2000 and lossy JPEG XL: decoders' float arithmetic differs; JPEG XL JPEG
        # recompression: each decoder's own inverse DCT, which may round differently by 1.
        tol = 2 if ts in ("1.2.840.10008.1.2.4.91", "1.2.840.10008.1.2.4.112") else 1 if ts == "1.2.840.10008.1.2.4.111" else 0
        m = int(d.max())
        ok = m <= tol
        label = f"max |diff| {m}, {int((d > 0).sum())} of {d.size} samples differ (tolerance {tol})"
    worst = max(worst, m)
    bad += not ok
    where = f"level {t['level']} tile ({t['tx']},{t['ty']}) plane {t.get('plane', 0)} path {t.get('path', 0)} frame {t['frame']}"
    print(f"{'ok ' if ok else 'BAD'} {where} {ts.split('.')[-1]} {ds.PhotometricInterpretation} {bits}-bit: {label}")
print(f"{len(tiles)} tiles, {bad} over tolerance, worst |diff| {worst}")
sys.exit(1 if bad else 0)
