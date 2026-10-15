"""Reference decoders that produce the canonical pixel array (CONTRACT.md).

Each reference has a name and an `impl` family. Two references from the same family
(for example gdcm and pylibjpeg-openjpeg, which both wrap OpenJPEG) are not independent
evidence; oracle.py counts agreement by family.

CLI (also usable as a check.py candidate, to test the harness itself):
    uv run python scripts/ref_decode.py --ref pydicom:gdcm IN.dcm OUT.raw
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import pydicom
from pydicom.encaps import generate_frames
from pydicom.pixels import pixel_array

sys.path.insert(0, str(Path(__file__).parent))
from common import TRANSFER_SYNTAXES, canonical, expected_dtype  # noqa: E402

# name -> (implementation family, transfer syntax UIDs it handles or None for "ask pydicom")
REFERENCES: dict[str, str] = {
    "pydicom:pydicom": "pydicom-native",
    "pydicom:pylibjpeg": "pylibjpeg",          # family refined per syntax below
    "pydicom:gdcm": "gdcm",
    "pydicom:pyjpegls": "charls",
    "pydicom:pylibjpeg-raw": "openjpeg",
    "dcmtk": "dcmtk",
    "openjph": "openjph",
    "openjpeg-cli": "openjpeg",
}


def family(ref: str, ts: str) -> str:
    """Underlying codec library for a reference on a given transfer syntax."""
    fmt = TRANSFER_SYNTAXES.get(ts, ("?", "", False))[0]
    if ref == "pydicom:pylibjpeg":
        return {"jpeg-dct": "libjpeg-richter", "jpeg-lossless": "libjpeg-richter", "jpeg-ls": "libjpeg-richter",
                "jpeg2000": "openjpeg", "htj2k": "openjpeg", "rle": "pylibjpeg-rle"}.get(fmt, "pylibjpeg")
    if ref == "pydicom:gdcm":
        return {"jpeg-dct": "ijg", "jpeg-lossless": "ijg", "jpeg-ls": "charls", "jpeg2000": "openjpeg",
                "rle": "gdcm-rle"}.get(fmt, "gdcm")
    if ref == "dcmtk":
        return {"jpeg-dct": "ijg", "jpeg-lossless": "ijg", "jpeg-ls": "charls", "rle": "dcmtk-rle"}.get(fmt, "dcmtk")
    return REFERENCES[ref]


def geometry(ds) -> tuple[int, int, int, int, np.dtype]:
    frames = int(getattr(ds, "NumberOfFrames", 1) or 1)
    return frames, int(ds.Rows), int(ds.Columns), int(ds.SamplesPerPixel), expected_dtype(
        int(ds.BitsAllocated), int(getattr(ds, "PixelRepresentation", 0)))


def _from_pydicom(path: Path, plugin: str) -> np.ndarray:
    ds = pydicom.dcmread(path, force=True)
    # Ruling: Planar Configuration is irrelevant for JPEG-family and JPEG 2000 encapsulated data
    # (PS3.5 §8.2.1, §8.2.4); the codec output is always interleaved. pydicom applies a declared
    # Planar Configuration of 1 anyway and scrambles the image, so neutralise it before decoding.
    fmt = TRANSFER_SYNTAXES.get(str(ds.file_meta.TransferSyntaxUID), ("?", "", False))[0]
    if fmt in ("jpeg-dct", "jpeg-lossless", "jpeg-ls", "jpeg2000", "htj2k") and int(getattr(ds, "SamplesPerPixel", 1)) > 1:
        ds.PlanarConfiguration = 0
    arr = pixel_array(ds, decoding_plugin=plugin, raw=False)
    f, r, c, s, dt = geometry(ds)
    return canonical(arr.astype(dt, copy=False), f, r, c, s)


def _from_dcmtk(path: Path) -> np.ndarray:
    ds = pydicom.dcmread(path, stop_before_pixels=True, force=True)
    fmt = TRANSFER_SYNTAXES[str(ds.file_meta.TransferSyntaxUID)][0]
    tool = {"jpeg-dct": "dcmdjpeg", "jpeg-lossless": "dcmdjpeg", "jpeg-ls": "dcmdjpls", "rle": "dcmdrle"}.get(fmt)
    if tool is None or shutil.which(tool) is None:
        raise NotImplementedError(f"dcmtk has no decoder here for {fmt}")
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "out.dcm"
        subprocess.run([tool, str(path), str(out)], check=True, capture_output=True, timeout=120)
        return _from_pydicom(out, "pydicom")


def _codestreams(path: Path) -> tuple[object, list[bytes]]:
    ds = pydicom.dcmread(path, force=True)
    f = int(getattr(ds, "NumberOfFrames", 1) or 1)
    return ds, list(generate_frames(ds.PixelData, number_of_frames=f))


def _read_pnm(p: Path) -> np.ndarray:
    data = p.read_bytes()
    parts, i = [], 0
    while len(parts) < 4:
        while data[i:i + 1].isspace():
            i += 1
        if data[i:i + 1] == b"#":
            while data[i:i + 1] not in (b"\n", b""):
                i += 1
            continue
        j = i
        while not data[j:j + 1].isspace():
            j += 1
        parts.append(data[i:j])
        i = j
    i += 1
    magic, w, h, maxval = parts[0], int(parts[1]), int(parts[2]), int(parts[3])
    spp = 3 if magic == b"P6" else 1
    dt = ">u2" if maxval > 255 else "u1"
    return np.frombuffer(data[i:], dtype=dt, count=w * h * spp).reshape(h, w, spp)


def _from_openjph(path: Path) -> np.ndarray:
    if shutil.which("ojph_expand") is None:
        raise NotImplementedError("ojph_expand not installed")
    ds, frames = _codestreams(path)
    f, r, c, s, dt = geometry(ds)
    if dt.kind == "i":
        raise NotImplementedError("PNM output cannot carry signed samples")
    out = []
    with tempfile.TemporaryDirectory() as td:
        for k, cs in enumerate(frames):
            src, dst = Path(td) / f"{k}.j2c", Path(td) / (f"{k}.ppm" if s == 3 else f"{k}.pgm")
            src.write_bytes(cs)
            subprocess.run(["ojph_expand", "-i", str(src), "-o", str(dst)], check=True, capture_output=True, timeout=120)
            out.append(_read_pnm(dst))
    return canonical(np.stack(out).astype(dt), f, r, c, s)


def _from_openjpeg_cli(path: Path) -> np.ndarray:
    if shutil.which("opj_decompress") is None:
        raise NotImplementedError("opj_decompress not installed")
    ds, frames = _codestreams(path)
    f, r, c, s, dt = geometry(ds)
    raw_dt = np.dtype(dt.kind + str(dt.itemsize)).newbyteorder("<")
    out = []
    with tempfile.TemporaryDirectory() as td:
        for k, cs in enumerate(frames):
            src, dst = Path(td) / f"{k}.j2k", Path(td) / f"{k}.rawl"
            src.write_bytes(cs)
            subprocess.run(["opj_decompress", "-i", str(src), "-o", str(dst)], check=True, capture_output=True, timeout=120)
            planes = np.frombuffer(dst.read_bytes(), dtype=raw_dt).reshape(s, r, c).astype(np.int64)
            # opj_decompress writes signed components masked to their codestream precision;
            # sign-extend from that precision (SIZ Ssiz) before the contract's Bits Stored step.
            for comp, (signed, prec) in enumerate(_siz_components(cs)[:s]):
                if signed:
                    v = planes[comp] & ((1 << prec) - 1)
                    planes[comp] = np.where(v >= (1 << (prec - 1)), v - (1 << prec), v)
            out.append(np.moveaxis(planes, 0, -1))
    arr = np.stack(out)
    bits_stored = int(getattr(ds, "BitsStored", ds.BitsAllocated))
    precs = [p for _, p in _siz_components(frames[0])] if frames else []
    bits_stored = min(max([bits_stored] + precs), int(ds.BitsAllocated))   # CONTRACT: JPEG 2000 keeps codestream precision
    mask = (1 << bits_stored) - 1
    arr = arr & mask
    if dt.kind == "i":
        arr = np.where(arr >= (1 << (bits_stored - 1)), arr - (1 << bits_stored), arr)
    return canonical(arr.astype(dt), f, r, c, s)


def _siz_components(cs: bytes) -> list[tuple[bool, int]]:
    """(signed, precision) for each component, from the SIZ marker segment."""
    # SIZ immediately follows SOC (FF4F); searching for FF51 alone can hit data inside a JP2 box.
    j = cs.find(b"\xff\x4f\xff\x51")
    if j < 0:
        return []
    i = j + 2
    csiz = int.from_bytes(cs[i + 38:i + 40], "big")   # marker 2, Lsiz 2, Rsiz 2, 8 x 4-byte sizes
    comps = []
    for k in range(csiz):
        ssiz = cs[i + 40 + 3 * k]
        comps.append((bool(ssiz & 0x80), (ssiz & 0x7F) + 1))
    return comps


def decode(path: Path, ref: str) -> np.ndarray:
    if ref.endswith("-raw") and ref.startswith("pydicom:"):
        # The plugin's own output without pydicom's YBR->RGB step: for codestreams the codec already
        # converts (e.g. OpenJPEG treats 3 components with subsampled chroma as sYCC). Ruling-only reference.
        ds = pydicom.dcmread(path, force=True)
        arr = pixel_array(ds, decoding_plugin=ref[len("pydicom:"):-len("-raw")], raw=True)
        f, r, c, s, dt = geometry(ds)
        return canonical(arr.astype(dt, copy=False), f, r, c, s)
    if ref.startswith("pydicom:"):
        return _from_pydicom(path, ref.split(":", 1)[1])
    if ref == "dcmtk":
        return _from_dcmtk(path)
    if ref == "openjph":
        return _from_openjph(path)
    if ref == "openjpeg-cli":
        return _from_openjpeg_cli(path)
    raise ValueError(f"unknown reference {ref}")


def applicable(ts: str) -> list[str]:
    fmt = TRANSFER_SYNTAXES.get(ts, ("?", "", False))[0]
    return {
        "uncompressed": ["pydicom:pydicom", "pydicom:gdcm"],
        "rle": ["pydicom:pydicom", "pydicom:pylibjpeg", "pydicom:gdcm", "dcmtk"],
        "jpeg-dct": ["pydicom:pylibjpeg", "pydicom:gdcm", "dcmtk"],
        "jpeg-lossless": ["pydicom:pylibjpeg", "pydicom:gdcm", "dcmtk"],
        "jpeg-ls": ["pydicom:pyjpegls", "pydicom:pylibjpeg", "pydicom:gdcm", "dcmtk"],
        "jpeg2000": ["pydicom:pylibjpeg", "pydicom:gdcm", "openjpeg-cli"],
        "htj2k": ["pydicom:pylibjpeg", "openjph"],
    }.get(fmt, [])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True, choices=sorted(REFERENCES))
    ap.add_argument("input", type=Path)
    ap.add_argument("output", type=Path)
    a = ap.parse_args()
    try:
        arr = decode(a.input, a.ref)
    except NotImplementedError as e:
        print(f"unsupported: {e}", file=sys.stderr)
        return 3
    a.output.write_bytes(arr.tobytes())
    return 0


if __name__ == "__main__":
    sys.exit(main())
