"""Generate native cases for the retired colour photometric interpretations (ARGB, CMYK, HSV) and
for YBR_PARTIAL_422, from RGB corpus seeds. No real files with these are known.

The colour models, as the retired PS3.3 C.7.6.3.1.2 text (DICOM 2003 and earlier) defines them:
  HSV   hue, saturation and value planes (3 samples);
  CMYK  cyan, magenta, yellow and black planes (4 samples);
  ARGB  red, green and blue planes plus an alpha plane (4 samples, A first) that indexes the Palette
        Color Lookup Tables: where alpha > 0 the palette colour replaces the RGB colour.
YBR_PARTIAL_422 uses the forward equations of the current PS3.3 C.7.6.3.1.2 (Y = .2568R + .5041G +
.0979B + 16, ...), with Cb and Cr averaged over each horizontal pixel pair.

The standard gives no RGB conversion for HSV and CMYK; the oracle is DCMTK's dcm2img (the only
reader that implements these), via the `dcmtk-color` reference, so the cases carry
`oracle_ref: dcmtk-color`.

Usage:  uv run python scripts/sources/retired_photometrics.py
        uv run python scripts/oracle.py --format uncompressed --case gen-retired-
"""

from __future__ import annotations

import sys
import tempfile
import warnings
from pathlib import Path

import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import ROOT, sample_path, save_cases, sha256_file  # noqa: E402
from discover import describe  # noqa: E402
from ref_decode import read  # noqa: E402

warnings.filterwarnings("ignore")


def seed(name: str) -> np.ndarray:
    a = np.load(ROOT / "seeds" / f"{name}.npy")
    return a.reshape(a.shape[-3], a.shape[-2], a.shape[-1]) if a.ndim == 4 else a


def rgb_to_hsv(rgb: np.ndarray, maxv: int) -> np.ndarray:
    x = rgb.astype(np.float64) / maxv
    r, g, b = x[..., 0], x[..., 1], x[..., 2]
    v = x.max(-1)
    c = v - x.min(-1)
    s = np.where(v > 0, c / np.where(v > 0, v, 1), 0)
    cc = np.where(c > 0, c, 1)
    h = np.where(v == r, ((g - b) / cc) % 6, np.where(v == g, (b - r) / cc + 2, (r - g) / cc + 4))
    h = np.where(c > 0, h / 6, 0)
    return np.stack([np.round(h * maxv), np.round(s * maxv), np.round(v * maxv)], -1).astype(rgb.dtype)


def rgb_to_cmyk(rgb: np.ndarray, maxv: int) -> np.ndarray:
    x = rgb.astype(np.int64)
    k = maxv - x.max(-1)
    cmy = maxv - x - k[..., None]
    return np.concatenate([cmy, k[..., None]], -1).astype(rgb.dtype)


def rgb_to_ybr_partial_422(rgb: np.ndarray) -> np.ndarray:
    x = rgb.astype(np.float64)
    r, g, b = x[..., 0], x[..., 1], x[..., 2]
    y = .2568 * r + .5041 * g + .0979 * b + 16
    cb = -.1482 * r - .2910 * g + .4392 * b + 128
    cr = .4392 * r - .3678 * g - .0714 * b + 128
    rows, cols = y.shape
    out = np.empty((rows, cols // 2, 4))
    out[..., 0], out[..., 1] = y[:, 0::2], y[:, 1::2]
    out[..., 2] = (cb[:, 0::2] + cb[:, 1::2]) / 2
    out[..., 3] = (cr[:, 0::2] + cr[:, 1::2]) / 2
    return np.clip(np.floor(out + 0.5), 0, 255).astype(np.uint8)


def dataset(pixels: bytes, rows: int, cols: int, spp: int, bits: int, pi: str, planar: int | None) -> Dataset:
    ds = Dataset()
    ds.file_meta = FileMetaDataset()
    ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.file_meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.7"
    ds.SOPClassUID = ds.file_meta.MediaStorageSOPClassUID
    ds.SOPInstanceUID = ds.file_meta.MediaStorageSOPInstanceUID = generate_uid()
    ds.Modality = "OT"
    ds.Rows, ds.Columns, ds.SamplesPerPixel = rows, cols, spp
    ds.PhotometricInterpretation = pi
    if planar is not None:
        ds.PlanarConfiguration = planar
    ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = bits, bits, bits - 1, 0
    ds.PixelData = pixels
    ds["PixelData"].VR = "OB" if bits == 8 else "OW"
    return ds


def add(cid: str, ds: Dataset, notes: str, seed_name: str) -> dict:
    dst = sample_path("uncompressed", cid)
    dst.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / "x.dcm"
        ds.save_as(tmp, enforce_file_format=True)
        dst.write_bytes(tmp.read_bytes())
    print(f"uncompressed   {cid}")
    return {"id": cid, "notes": notes, "tags": ["generated", "retired-photometric"], **describe(read(dst)),
            "source": {"kind": "generated", "seed": seed_name, "how": "scripts/sources/retired_photometrics.py",
                       "license": "generated from a corpus seed"},
            "sha256": sha256_file(dst), "size": dst.stat().st_size,
            "oracle_ref": "dcmtk-color",
            "ruling": "no RGB conversion is defined by the standard; DCMTK dcm2img is the reference"}


def planes(a: np.ndarray) -> bytes:
    return np.ascontiguousarray(np.moveaxis(a, -1, 0)).astype("<" + a.dtype.str[1:]).tobytes()


def main() -> None:
    cases = []
    for name, maxv in (("synth-rgb8-60x40", 255), ("pydicom-US1_UNCR", 255), ("pydicom-SC_rgb_16bit", 65535)):
        rgb = seed(name)
        rows, cols, _ = rgb.shape
        bits = 8 if maxv == 255 else 16
        dt = np.dtype("<u1" if bits == 8 else "<u2")
        rgb = rgb.astype(dt)
        hsv = rgb_to_hsv(rgb, maxv)
        cmyk = rgb_to_cmyk(rgb, maxv)
        for pc in (0, 1):
            data = hsv.tobytes() if pc == 0 else planes(hsv)
            cases.append(add(f"gen-retired-hsv-pc{pc}-{name}", dataset(data, rows, cols, 3, bits, "HSV", pc),
                             f"HSV from {name}, Planar Configuration {pc}", name))
            data = cmyk.tobytes() if pc == 0 else planes(cmyk)
            cases.append(add(f"gen-retired-cmyk-pc{pc}-{name}", dataset(data, rows, cols, 4, bits, "CMYK", pc),
                             f"CMYK from {name}, Planar Configuration {pc}", name))
        # ARGB: alpha indexes a palette over a band in the middle third of the rows.
        alpha = np.zeros((rows, cols), dt)
        band = slice(rows // 3, 2 * rows // 3)
        alpha[band] = (np.arange(cols) % 4 + 1).astype(dt)
        argb = np.concatenate([alpha[..., None], rgb], -1)
        for pc in (0, 1):
            data = argb.tobytes() if pc == 0 else planes(argb)
            ds = dataset(data, rows, cols, 4, bits, "ARGB", pc)
            # Palette entries as deep as the samples (DCMTK does not rescale the RGB planes to a
            # deeper palette, so the two must agree for its output to be a reference).
            lut_bits = bits
            entries = (np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0]]) * maxv).astype("<u2")
            for k, tag in enumerate(("Red", "Green", "Blue")):
                setattr(ds, f"{tag}PaletteColorLookupTableDescriptor", [len(entries), 0, lut_bits])
                setattr(ds, f"{tag}PaletteColorLookupTableData", entries[:, k].tobytes())
            cases.append(add(f"gen-retired-argb-pc{pc}-{name}", ds, f"ARGB from {name}, Planar Configuration {pc}", name))
        if bits == 8 and cols % 2 == 0:
            cases.append(add(f"gen-retired-ybrpartial422-{name}",
                             dataset(rgb_to_ybr_partial_422(rgb).tobytes(), rows, cols, 3, 8, "YBR_PARTIAL_422", 0),
                             f"YBR_PARTIAL_422 from {name}", name))
    for c in cases:
        if "ybrpartial" in c["id"]:
            c["ruling"] = "inverse of the PS3.3 C.7.6.3.1.2 equations; DCMTK dcm2img is the reference"
            c["max_abs_override"] = 2
            c["max_abs_reason"] = ("DCMTK uses 4-digit inverse coefficients and truncates; we invert the PS3.3 "
                                   "equations exactly and round, which is closer to the seed RGB")
    save_cases("uncompressed", cases)


if __name__ == "__main__":
    main()
