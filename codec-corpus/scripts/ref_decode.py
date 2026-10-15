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
import zlib
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import pydicom
from pydicom.dataset import FileMetaDataset
from pydicom.encaps import generate_frames
from pydicom.pixels import pixel_array
from pydicom.uid import UID

sys.path.insert(0, str(Path(__file__).parent))
from common import TRANSFER_SYNTAXES, canonical, expected_dtype  # noqa: E402

# name -> (implementation family, transfer syntax UIDs it handles or None for "ask pydicom")
REFERENCES: dict[str, str] = {
    "pydicom:pydicom": "pydicom-native",
    "pydicom:pylibjpeg": "pylibjpeg",          # family refined per syntax below
    "pydicom:gdcm": "gdcm",
    "pydicom:unwrapped": "pydicom-native",
    "gdcm-native": "gdcm",
    "dcmtk-color": "dcmtk",
    "pydicom:pyjpegls": "charls",
    "pydicom:pylibjpeg-raw": "openjpeg",
    "dcmtk": "dcmtk",
    "openjph": "openjph",
    "openjpeg-cli": "openjpeg",
    "imagecodecs-jxl": "libjxl",
    "libjpeg-richter": "libjpeg-richter",      # pylibjpeg-libjpeg on retired JPEG processes
    "libjpeg-turbo": "ijg",                    # libjpeg-turbo 3 (imagecodecs), per frame
    "djxl": "libjxl",
    "j2k-part2": "openjpeg+annex-j",           # sources/j2k_part2.py: OpenJPEG components + numpy Annex J
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


TS_ENCAPSULATED_UNCOMPRESSED = "1.2.840.10008.1.2.1.98"
TS_DEFLATED_IMAGE_FRAME = "1.2.840.10008.1.2.8.1"
TS_GE_PRIVATE = "1.2.840.113619.5.2"


def read(path: Path):
    """dcmread(force=True). A data set without a Part 10 meta (or without a Transfer Syntax UID in
    it) gets the transfer syntax pydicom guessed from its first element, so pixel_array works."""
    ds = pydicom.dcmread(path, force=True)
    if "TransferSyntaxUID" not in getattr(ds, "file_meta", {}):
        implicit, little = ds.original_encoding
        if not hasattr(ds, "file_meta") or ds.file_meta is None:
            ds.file_meta = FileMetaDataset()
        ds.file_meta.TransferSyntaxUID = UID(
            "1.2.840.10008.1.2" if implicit else "1.2.840.10008.1.2.1" if little else "1.2.840.10008.1.2.2")
    return ds


def is_float(ds) -> bool:
    return "FloatPixelData" in ds or "DoubleFloatPixelData" in ds


def geometry(ds) -> tuple[int, int, int, int, np.dtype]:
    frames = int(getattr(ds, "NumberOfFrames", 1) or 1)
    if is_float(ds):
        dt = expected_dtype(64 if "DoubleFloatPixelData" in ds else 32, 0, float_pixels=True)
    else:
        dt = expected_dtype(int(ds.BitsAllocated), int(getattr(ds, "PixelRepresentation", 0)))
    return frames, int(ds.Rows), int(ds.Columns), int(getattr(ds, "SamplesPerPixel", 1)), dt


def _from_pydicom(path: Path, plugin: str) -> np.ndarray:
    ds = read(path)
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
    ds = read(path)
    fmt = TRANSFER_SYNTAXES[str(ds.file_meta.TransferSyntaxUID)][0]
    tool = {"jpeg-dct": "dcmdjpeg", "jpeg-lossless": "dcmdjpeg", "jpeg-ls": "dcmdjpls", "rle": "dcmdrle"}.get(fmt)
    if tool is None or shutil.which(tool) is None:
        raise NotImplementedError(f"dcmtk has no decoder here for {fmt}")
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "out.dcm"
        subprocess.run([tool, str(path), str(out)], check=True, capture_output=True, timeout=120)
        return _from_pydicom(out, "pydicom")


# Retired JPEG processes (progressive, arithmetic, hierarchical): pydicom refuses these
# syntaxes, so the codestreams go to the libraries directly (see formats/jpeg-dct/FORMAT.md).
TS_RETIRED_JPEG_LOSSLESS = {"1.2.840.10008.1.2.4.58", "1.2.840.10008.1.2.4.65", "1.2.840.10008.1.2.4.66"}
TS_RETIRED_JPEG = {f"1.2.840.10008.1.2.4.{n}" for n in range(52, 67) if n != 57}


def _from_richter_retired(path: Path) -> np.ndarray:
    """Thomas Richter's libjpeg through pydicom's pylibjpeg plugin. That plugin is wired to the
    syntaxes pydicom knows, so the data set is relabelled in memory as JPEG Extended (or JPEG
    Lossless); libjpeg reads the process from the codestream's SOF marker either way."""
    ds = read(path)
    ts = str(ds.file_meta.TransferSyntaxUID)
    if ts not in TS_RETIRED_JPEG:
        raise NotImplementedError("only for retired JPEG processes")
    ds.file_meta.TransferSyntaxUID = "1.2.840.10008.1.2.4.57" if ts in TS_RETIRED_JPEG_LOSSLESS else "1.2.840.10008.1.2.4.51"
    if int(getattr(ds, "SamplesPerPixel", 1)) > 1:
        ds.PlanarConfiguration = 0
    arr = pixel_array(ds, decoding_plugin="pylibjpeg", raw=False)
    f, r, c, s, dt = geometry(ds)
    return canonical(arr.astype(dt, copy=False), f, r, c, s)


def _from_turbo(path: Path) -> np.ndarray:
    """libjpeg-turbo 3 via imagecodecs, one frame at a time: progressive and arithmetic DCT and
    Huffman lossless; no hierarchical or arithmetic lossless. Colour as the contract says: a
    JFIF or Adobe marker decides, otherwise the photometric (YBR_* is YCbCr)."""
    import imagecodecs
    ds, frames = _codestreams(path)
    if str(ds.file_meta.TransferSyntaxUID) not in TS_RETIRED_JPEG:
        raise NotImplementedError("only for retired JPEG processes")
    f, r, c, s, dt = geometry(ds)
    out = []
    for cs in frames:
        cspace = None
        if s == 3 and b"JFIF\x00" not in cs[:64] and b"Adobe" not in cs[:4096]:
            ybr = str(ds.PhotometricInterpretation).startswith("YBR")
            cspace = imagecodecs.JPEG8.CS.YCbCr if ybr else imagecodecs.JPEG8.CS.RGB
        a = imagecodecs.jpeg8_decode(cs, colorspace=cspace, outcolorspace=imagecodecs.JPEG8.CS.RGB if s == 3 else None)
        out.append(np.asarray(a).reshape(r, c, s))
    return canonical(np.stack(out).astype(dt), f, r, c, s)


def _codestreams(path: Path) -> tuple[object, list[bytes]]:
    ds = read(path)
    f = int(getattr(ds, "NumberOfFrames", 1) or 1)
    return ds, list(generate_frames(ds.PixelData, number_of_frames=f))


def _from_unwrapped(path: Path) -> np.ndarray:
    """Encapsulated Uncompressed (.1.98) and Deflated Image Frame Compression (.8.1): each frame's
    fragment(s) hold the native frame bytes, raw-deflated (RFC 1951) for .8.1 (PS3.5 A.4.11,
    A.4.13). The frames are unwrapped here and decoded as Explicit VR Little Endian by pydicom."""
    ds, frames = _codestreams(path)
    ts = str(ds.file_meta.TransferSyntaxUID)
    if ts not in (TS_ENCAPSULATED_UNCOMPRESSED, TS_DEFLATED_IMAGE_FRAME):
        raise NotImplementedError(f"not an unwrappable transfer syntax: {ts}")
    if ts == TS_DEFLATED_IMAGE_FRAME:
        frames = [zlib.decompress(fr, wbits=-15) for fr in frames]
    f, r, c, s, dt = geometry(ds)
    ba = int(ds.BitsAllocated)
    if ba == 1:
        # Each frame starts on a byte boundary; native data packs frames back to back.
        n = r * c * s
        bits = np.concatenate([np.unpackbits(np.frombuffer(fr, np.uint8), bitorder="little")[:n] for fr in frames])
        packed = np.packbits(bits, bitorder="little").tobytes()
    else:
        per = r * c * s * (ba // 8)
        if str(getattr(ds, "PhotometricInterpretation", "")) in ("YBR_FULL_422", "YBR_PARTIAL_422"):
            per = per // 3 * 2
        packed = b"".join(fr[:per] for fr in frames)
    ds.file_meta.TransferSyntaxUID = UID("1.2.840.10008.1.2.1")
    ds.PixelData = packed + b"\0" * (len(packed) % 2)
    ds["PixelData"].VR = "OB" if ba <= 8 else "OW"
    arr = pixel_array(ds, decoding_plugin="pydicom", raw=False)
    return canonical(arr.astype(dt, copy=False), f, r, c, s)


def _read_ascii_pnm(p: Path) -> np.ndarray:
    tok = p.read_bytes().split()
    magic, w, h = tok[0], int(tok[1]), int(tok[2])
    spp = 3 if magic == b"P3" else 1
    return np.array(tok[4:4 + w * h * spp], dtype=np.int64).reshape(h, w, spp)


def _from_dcmtk_color(path: Path) -> np.ndarray:
    """DCMTK's dcm2img rendering of a colour image as RGB at its stored depth (ASCII PNM with Bits
    Stored bits, so no rescaling): the reference for colour models only DCMTK converts (retired
    ARGB, CMYK, HSV; YBR_PARTIAL_422). Single-frame files only."""
    if shutil.which("dcm2img") is None:
        raise NotImplementedError("dcm2img not installed")
    ds = read(path)
    if int(getattr(ds, "NumberOfFrames", 1) or 1) != 1:
        raise NotImplementedError("dcmtk-color reads single-frame files")
    bits = int(getattr(ds, "BitsStored", ds.BitsAllocated))
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "o.pnm"
        subprocess.run(["dcm2img", "+opn", str(bits), str(path), str(out)], check=True, capture_output=True, timeout=120)
        arr = _read_ascii_pnm(out)
    dt = expected_dtype(int(ds.BitsAllocated), 0)
    return canonical(arr.astype(dt), 1, arr.shape[0], arr.shape[1], arr.shape[2])


def _from_gdcm_native(path: Path) -> np.ndarray:
    """gdcm.ImageReader without pydicom: reads files pydicom refuses (the GE private implicit VR big
    endian syntax, ACR-NEMA packed 12-bit and 24-bit RGB). The geometry is GDCM's own; the sample
    width is what GDCM's buffer holds. Monochrome, RGB and palette data only (returned as is)."""
    import gdcm
    r = gdcm.ImageReader()
    r.SetFileName(str(path))
    if not r.Read():
        raise RuntimeError("gdcm.ImageReader could not read the file")
    img = r.GetImage()
    pi = img.GetPhotometricInterpretation().GetString().strip()
    if pi not in ("MONOCHROME1", "MONOCHROME2", "RGB", "PALETTE COLOR"):
        raise NotImplementedError(f"gdcm-native returns {pi} unconverted")
    pf = img.GetPixelFormat()
    dims = [img.GetDimension(i) for i in range(img.GetNumberOfDimensions())]
    c, r_, f = dims[0], dims[1], (dims[2] if len(dims) > 2 else 1)
    s = pf.GetSamplesPerPixel()
    buf = img.GetBuffer().encode("utf-8", "surrogateescape")
    bps, rem = divmod(len(buf), f * r_ * c * s)
    if rem or bps not in (1, 2, 4):
        raise RuntimeError(f"GDCM buffer of {len(buf)} bytes does not fit {f}x{r_}x{c}x{s}")
    dt = np.dtype(("<i" if pf.GetPixelRepresentation() == 1 else "<u") + str(bps))
    return canonical(np.frombuffer(buf, dtype=dt), f, r_, c, s)


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
    """opj_decompress on one frame at a time, each written straight into the output array, so
    memory stays at about the decoded size (large slides have tens of thousands of frames)."""
    if shutil.which("opj_decompress") is None:
        raise NotImplementedError("opj_decompress not installed")
    ds = read(path)
    f, r, c, s, dt = geometry(ds)
    raw_dt = np.dtype(dt.kind + str(dt.itemsize)).newbyteorder("<")
    bits_stored = int(getattr(ds, "BitsStored", ds.BitsAllocated))
    out = np.empty((f, r, c, s), dtype=dt)
    precs: list[int] | None = None
    with tempfile.TemporaryDirectory() as td:
        src, dst = Path(td) / "f.j2k", Path(td) / "f.rawl"
        for k, cs in enumerate(generate_frames(ds.PixelData, number_of_frames=f)):
            if k >= f:
                break
            src.write_bytes(cs)
            subprocess.run(["opj_decompress", "-i", str(src), "-o", str(dst)], check=True, capture_output=True, timeout=120)
            planes = np.frombuffer(dst.read_bytes(), dtype=raw_dt).reshape(s, r, c).astype(np.int64)
            comps = _siz_components(cs)
            # opj_decompress writes signed components masked to their codestream precision;
            # sign-extend from that precision (SIZ Ssiz) before the contract's Bits Stored step.
            for comp, (signed, prec) in enumerate(comps[:s]):
                if signed:
                    v = planes[comp] & ((1 << prec) - 1)
                    planes[comp] = np.where(v >= (1 << (prec - 1)), v - (1 << prec), v)
            if precs is None:
                precs = [p for _, p in comps]
                # CONTRACT: JPEG 2000 keeps the codestream precision (from the first frame).
                bits_stored = min(max([bits_stored] + precs), int(ds.BitsAllocated))
            arr = np.moveaxis(planes, 0, -1) & ((1 << bits_stored) - 1)
            if dt.kind == "i":
                arr = np.where(arr >= (1 << (bits_stored - 1)), arr - (1 << bits_stored), arr)
            out[k] = arr.astype(dt)
    return np.ascontiguousarray(out)


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


def _from_jxl(path: Path, ref: str) -> np.ndarray:
    """libjxl, through imagecodecs or the djxl tool, one frame at a time. libjxl returns unsigned
    samples of the codestream's bit depth; signed data is the two's-complement bit pattern, so it
    is sign-extended from Bits Stored here (CONTRACT.md)."""
    ds, frames = _codestreams(path)
    f, r, c, s, dt = geometry(ds)
    out = []
    with tempfile.TemporaryDirectory() as td:
        for k, cs in enumerate(frames):
            if ref == "imagecodecs-jxl":
                import imagecodecs
                a = imagecodecs.jpegxl_decode(cs)
            else:
                if shutil.which("djxl") is None:
                    raise NotImplementedError("djxl not installed")
                src, dst = Path(td) / f"{k}.jxl", Path(td) / (f"{k}.ppm" if s == 3 else f"{k}.pgm")
                src.write_bytes(cs)
                subprocess.run(["djxl", str(src), str(dst)], check=True, capture_output=True, timeout=120)
                a = _read_pnm(dst)
            out.append(np.asarray(a).reshape(r, c, s).astype(np.int64))
    arr = np.stack(out)
    bits = int(getattr(ds, "BitsStored", ds.BitsAllocated))
    arr &= (1 << bits) - 1
    if dt.kind == "i":
        arr = np.where(arr >= (1 << (bits - 1)), arr - (1 << bits), arr)
    return canonical(arr.astype(dt), f, r, c, s)


def decode(path: Path, ref: str) -> np.ndarray:
    if ref.endswith("-raw") and ref.startswith("pydicom:"):
        # The plugin's own output without pydicom's YBR->RGB step: for codestreams the codec already
        # converts (e.g. OpenJPEG treats 3 components with subsampled chroma as sYCC). Ruling-only reference.
        ds = read(path)
        arr = pixel_array(ds, decoding_plugin=ref[len("pydicom:"):-len("-raw")], raw=True)
        f, r, c, s, dt = geometry(ds)
        return canonical(arr.astype(dt, copy=False), f, r, c, s)
    if ref == "pydicom:unwrapped":
        return _from_unwrapped(path)
    if ref.startswith("pydicom:"):
        return _from_pydicom(path, ref.split(":", 1)[1])
    if ref == "gdcm-native":
        return _from_gdcm_native(path)
    if ref == "dcmtk-color":
        return _from_dcmtk_color(path)
    if ref == "dcmtk":
        return _from_dcmtk(path)
    if ref == "openjph":
        return _from_openjph(path)
    if ref == "openjpeg-cli":
        return _from_openjpeg_cli(path)
    if ref == "libjpeg-richter":
        return _from_richter_retired(path)
    if ref == "libjpeg-turbo":
        return _from_turbo(path)
    if ref in ("imagecodecs-jxl", "djxl"):
        return _from_jxl(path, ref)
    if ref == "j2k-part2":
        sys.path.insert(0, str(Path(__file__).parent / "sources"))
        from j2k_part2 import reference_decode
        return reference_decode(path)
    raise ValueError(f"unknown reference {ref}")


def applicable(ts: str) -> list[str]:
    if ts in (TS_ENCAPSULATED_UNCOMPRESSED, TS_DEFLATED_IMAGE_FRAME):
        return ["pydicom:unwrapped"]
    if ts == TS_GE_PRIVATE:
        return ["gdcm-native"]
    if ts in TS_RETIRED_JPEG:
        return ["libjpeg-turbo", "libjpeg-richter", "dcmtk"]
    if ts in ("1.2.840.10008.1.2.4.92", "1.2.840.10008.1.2.4.93"):
        # JPEG 2000 Part 2 multi-component: no library applies Annex J (j2k_part2.py).
        return ["j2k-part2", "pydicom:pylibjpeg", "openjpeg-cli"]
    fmt = TRANSFER_SYNTAXES.get(ts, ("?", "", False))[0]
    return {
        "uncompressed": ["pydicom:pydicom", "pydicom:gdcm"],
        "rle": ["pydicom:pydicom", "pydicom:pylibjpeg", "pydicom:gdcm", "dcmtk"],
        "jpeg-dct": ["pydicom:pylibjpeg", "pydicom:gdcm", "dcmtk"],
        "jpeg-lossless": ["pydicom:pylibjpeg", "pydicom:gdcm", "dcmtk"],
        "jpeg-ls": ["pydicom:pyjpegls", "pydicom:pylibjpeg", "pydicom:gdcm", "dcmtk"],
        "jpeg2000": ["pydicom:pylibjpeg", "pydicom:gdcm", "openjpeg-cli"],
        "htj2k": ["pydicom:pylibjpeg", "openjph"],
        "jpeg-xl": ["imagecodecs-jxl", "djxl"],
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
