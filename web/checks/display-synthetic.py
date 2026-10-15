"""Synthetic files for the LUT edges of the display transform (display-conformance.ts), each with
the rendering the standard plus our LUT depth rule calls for, as <name>.expect.png:

  uv run --project codec-corpus --with pillow python web/checks/display-synthetic.py [dir]

A 256 × 64 ramp over the stored range, MONOCHROME2 unless named otherwise:
  voi-overstated      VOI LUT declared 16 bits, entries 0–4095 (the CR quirk): 12-bit output
  voi-understated     VOI LUT declared 8 bits, entries 0–4095: 12-bit output (the data's)
  voi-8bit-words      VOI LUT of 8-bit entries, one per 16-bit word
  voi-8bit-packed     VOI LUT of 8-bit entries, two per word (OB)
  voi-signed-first    signed pixels, VOI LUT whose first mapped value is −1024 (US 64512)
  voi-65536           16-bit pixels, VOI LUT of 65536 entries (descriptor 0)
  mlut-overstated     Modality LUT declared 16 bits, entries 0–4095, then a window
  mono1-window        MONOCHROME1 with a window
  mono1-lut           MONOCHROME1 with a VOI LUT (inverted ramp)
  inverse-window      MONOCHROME2 with Presentation LUT Shape INVERSE
  sigmoid             VOI LUT Function SIGMOID
Expected levels: window per PS3.3 C.11.2.1.2.1 (LINEAR) or SIGMOID; LUT output scaled by
255 / (2^n − 1) with n from the depth rule (lutOutputBits in core/display.ts); MONOCHROME1 and
INVERSE invert; values truncated as the viewer's 8-bit stages do."""
import math, sys
from pathlib import Path
import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid
from PIL import Image

out = Path(sys.argv[1] if len(sys.argv) > 1 else "/media/barracuda/shlink-display-conformance/synthetic")
out.mkdir(parents=True, exist_ok=True)
W, H = 256, 64


def base(name, stored, bits=12, signed=False, pi="MONOCHROME2"):
    ds = Dataset()
    ds.file_meta = FileMetaDataset()
    ds.file_meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.1.1"  # Digital X-Ray
    ds.file_meta.MediaStorageSOPInstanceUID = generate_uid(entropy_srcs=[f"display {name}"])
    ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.SOPClassUID, ds.SOPInstanceUID = ds.file_meta.MediaStorageSOPClassUID, ds.file_meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID = generate_uid(entropy_srcs=["display study"])
    ds.SeriesInstanceUID = generate_uid(entropy_srcs=[f"display series {name}"])
    ds.Modality = "DX"
    ds.PatientName, ds.PatientID = "TEST^DISPLAY", "DISP01"
    ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, pi
    ds.Rows, ds.Columns = H, W
    ds.BitsAllocated, ds.BitsStored, ds.HighBit = 16, bits, bits - 1
    ds.PixelRepresentation = 1 if signed else 0
    ds.PixelData = stored.astype("<i2" if signed else "<u2").tobytes()
    return ds


def ramp(lo, hi):
    return np.tile(np.round(np.linspace(lo, hi, W)).astype(np.int64), (H, 1))


def lut_item(first, bits, data, entries=None, ob=False, signed_first=False):
    it = Dataset()
    n = len(data) if entries is None else entries
    # US, so a negative first value is stored as its 16-bit two's complement (64512 for −1024).
    it.add_new(0x00283002, "US", [n if n < 65536 else 0, first % 65536, bits])
    if ob:
        it.add_new(0x00283006, "OB", bytes(int(x) for x in data))
    else:
        it.add_new(0x00283006, "OW", np.asarray(data, "<u2").tobytes())
    it.LUTExplanation = "test"
    return it


def depth(declared, mx):
    """lutOutputBits in core/display.ts."""
    n = min(16, max(1, declared))
    needed = math.ceil(math.log2(mx + 1)) if mx > 0 else 1
    if needed > n:
        return min(16, needed)
    if mx < 2 ** (n - 2):
        return next(d for d in (8, 10, 12, 14, 16) if mx < 2**d)
    return n


def lut_levels(vals, first, data, bits):
    idx = np.clip(vals - first, 0, len(data) - 1)
    return np.floor(np.asarray(data)[idx] * (255 / (2 ** bits - 1)))


def window_levels(x, c, w):
    y = (x - (c - 0.5)) / (w - 1) + 0.5
    return np.floor(np.clip(y, 0, 1) * 255 + 0.5)


def identity(v8):
    """An 8-bit stage shown through the identity window (centre 128, width 256): each level as is."""
    return window_levels(v8, 128, 256)


cases = {}
s = ramp(0, 4095)
lut = np.arange(4096)

ds = base("voi-overstated", s); ds.VOILUTSequence = [lut_item(0, 16, lut)]
cases["voi-overstated"] = (ds, identity(lut_levels(s, 0, lut, depth(16, 4095))))
ds = base("voi-understated", s); ds.VOILUTSequence = [lut_item(0, 8, lut)]
cases["voi-understated"] = (ds, identity(lut_levels(s, 0, lut, depth(8, 4095))))
l8 = (np.arange(4096) // 16).astype(int)
ds = base("voi-8bit-words", s); ds.VOILUTSequence = [lut_item(0, 8, l8)]
cases["voi-8bit-words"] = (ds, identity(lut_levels(s, 0, l8, 8)))
ds = base("voi-8bit-packed", s); ds.VOILUTSequence = [lut_item(0, 8, l8, ob=True)]
cases["voi-8bit-packed"] = (ds, identity(lut_levels(s, 0, l8, 8)))
ss = ramp(-1024, 3071)
lsg = np.arange(4096)
ds = base("voi-signed-first", ss, bits=16, signed=True); ds.VOILUTSequence = [lut_item(-1024, 12, lsg, signed_first=True)]
cases["voi-signed-first"] = (ds, identity(lut_levels(ss, -1024, lsg, 12)))
s16 = ramp(0, 65535)
l16 = np.arange(65536)
ds = base("voi-65536", s16, bits=16); ds.VOILUTSequence = [lut_item(0, 16, l16, entries=65536)]
cases["voi-65536"] = (ds, identity(lut_levels(s16, 0, l16, 16)))
ds = base("mlut-overstated", s); m = Dataset(); m.LUTDescriptor = [4096, 0, 16]; m.add_new(0x00283006, "OW", lut.astype("<u2").tobytes()); m.ModalityLUTType = "US"
ds.ModalityLUTSequence = [m]; ds.WindowCenter, ds.WindowWidth = 2048, 4096
cases["mlut-overstated"] = (ds, window_levels(lut[s], 2048, 4096))
ds = base("mono1-window", s, pi="MONOCHROME1"); ds.WindowCenter, ds.WindowWidth = 2048, 4096
cases["mono1-window"] = (ds, 255 - window_levels(s, 2048, 4096))
ds = base("mono1-lut", s, pi="MONOCHROME1"); ds.VOILUTSequence = [lut_item(0, 12, lut)]
cases["mono1-lut"] = (ds, 255 - identity(lut_levels(s, 0, lut, 12)))
ds = base("inverse-window", s); ds.WindowCenter, ds.WindowWidth = 2048, 4096; ds.PresentationLUTShape = "INVERSE"
cases["inverse-window"] = (ds, 255 - window_levels(s, 2048, 4096))
ds = base("sigmoid", s); ds.WindowCenter, ds.WindowWidth = 2048, 2000; ds.VOILUTFunction = "SIGMOID"
sig = np.floor(255 / (1 + np.exp(-4 * (s - 2048) / 2000)))
cases["sigmoid"] = (ds, identity(sig))

for name, (ds, expect) in cases.items():
    ds.save_as(out / f"{name}.dcm", enforce_file_format=True)
    Image.fromarray(np.clip(expect, 0, 255).astype(np.uint8), "L").save(out / f"{name}.dcm.expect.png")
print(f"{len(cases)} cases in {out}")
