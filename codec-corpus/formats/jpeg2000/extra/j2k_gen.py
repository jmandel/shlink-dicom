"""Helpers for the extra JPEG 2000 and HTJ2K cases (formats/jpeg2000/extra/gen_cases.py and
formats/htj2k/extra/gen_cases.py).

Each case takes an existing seed from codec-corpus/seeds/, encodes every frame with
opj_compress or ojph_compress from raw samples (so signed seeds work), wraps the
codestreams in the seed's data set, and registers the file with scripts/generate.py's
`register`, exactly as generate.py does for its own cases. The oracle then comes from
`scripts/oracle.py --format <fmt>`.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import pydicom
from pydicom.encaps import encapsulate

CORPUS = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(CORPUS / "scripts"))
from common import TRANSFER_SYNTAXES, sample_path  # noqa: E402
from generate import register  # noqa: E402


def seed(sid: str) -> tuple[pydicom.Dataset, np.ndarray]:
    """The seed data set and its pixels as (frames, rows, cols, samples)."""
    ds = pydicom.dcmread(CORPUS / "seeds" / f"{sid}.dcm")
    arr = ds.pixel_array
    f = int(getattr(ds, "NumberOfFrames", 1) or 1)
    return ds, arr.reshape(f, int(ds.Rows), int(ds.Columns), int(ds.SamplesPerPixel))


def _raw(frame: np.ndarray, bits: int, signed: bool, big_endian: bool) -> bytes:
    """Planar raw samples, one or two bytes each."""
    planes = np.moveaxis(frame, -1, 0)
    if bits <= 8:
        dt = "i1" if signed else "u1"
    else:
        dt = (">" if big_endian else "<") + ("i2" if signed else "u2")
    return np.ascontiguousarray(planes.astype(dt)).tobytes()


def opj(frame: np.ndarray, bits: int, signed: bool, args: list[str]) -> bytes:
    r, c, s = frame.shape
    with tempfile.TemporaryDirectory() as td:
        src, dst = Path(td) / "in.rawl", Path(td) / "out.j2k"
        src.write_bytes(_raw(frame, bits, signed, big_endian=False))
        fmt = f"{c},{r},{s},{bits},{'s' if signed else 'u'}"
        subprocess.run(["opj_compress", "-i", str(src), "-o", str(dst), "-F", fmt] + args,
                       check=True, capture_output=True, timeout=120)
        return dst.read_bytes()


def set_siz_signed(cs: bytes) -> bytes:
    """Set the sign bit of every SIZ Ssiz."""
    b = bytearray(cs)
    i = b.find(b"\xff\x51") + 2
    csiz = int.from_bytes(b[i + 36:i + 38], "big")
    for k in range(csiz):
        b[i + 38 + 3 * k] |= 0x80
    return bytes(b)


def ojph(frame: np.ndarray, bits: int, signed: bool, args: list[str]) -> bytes:
    """Encode with ojph_compress from raw samples.

    This build of ojph_compress mishandles signed input (raw samples are read as unsigned
    and clipped; TIFF int16 input gets an unsigned SIZ). So a signed frame is encoded as
    offset-binary unsigned samples, v + 2^(p-1), which ojph's DC level shift turns back
    into v before the wavelet transform, and then the SIZ sign bits are set. The coded data
    is then exactly what a signed encoder writes: signedness only decides whether the
    decoder applies the DC level shift (T.800 G.1.2).
    """
    r, c, s = frame.shape
    if signed:
        frame = frame.astype(np.int64) + (1 << (bits - 1))
    with tempfile.TemporaryDirectory() as td:
        src, dst = Path(td) / "in.yuv", Path(td) / "out.j2c"
        src.write_bytes(_raw(frame, bits, False, big_endian=False))
        sg = ",".join(["false"] * s)
        bd = ",".join([str(bits)] * s)
        ds_ = ",".join(["{1,1}"] * s)
        subprocess.run(["ojph_compress", "-i", str(src), "-o", str(dst), "-dims", f"{{{c},{r}}}",
                        "-num_comps", str(s), "-signed", sg, "-bit_depth", bd, "-downsamp", ds_] + args,
                       check=True, capture_output=True, timeout=120)
        cs = dst.read_bytes()
        return set_siz_signed(cs) if signed else cs


def make_case(fmt: str, sid: str, encoder: str, ts: str, encode, args: list[str],
              photometric: str | None = None) -> None:
    """Encode seed `sid` with `encode(frame, bits, signed, args)`, write and register the case."""
    assert TRANSFER_SYNTAXES[ts][0] == fmt, (ts, fmt)
    lossy = TRANSFER_SYNTAXES[ts][2]
    ds, arr = seed(sid)
    bits, signed = int(ds.BitsStored), int(ds.PixelRepresentation) == 1
    streams = [encode(arr[k], bits, signed, args) for k in range(arr.shape[0])]
    ds.PixelData = encapsulate(streams)
    ds["PixelData"].VR = "OB"
    ds["PixelData"].is_undefined_length = True
    ds.file_meta.TransferSyntaxUID = ts
    if photometric:
        ds.PhotometricInterpretation = photometric
    if lossy:
        ds.LossyImageCompression = "01"
    cid = f"gen-{sid}-{encoder}"
    dst = sample_path(fmt, cid)
    dst.parent.mkdir(parents=True, exist_ok=True)
    ds.save_as(dst, enforce_file_format=True)
    register(fmt, cid, dst, sid, encoder, not lossy)
    print(f"{fmt:10} {cid}  [{' '.join(args)}]")
