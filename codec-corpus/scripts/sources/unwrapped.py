"""Generate Encapsulated Uncompressed (1.2.840.10008.1.2.1.98) and Deflated Image Frame Compression
(1.2.840.10008.1.2.8.1) cases from native corpus cases.

Each frame of the source becomes one fragment holding its native bytes (PS3.5 A.4.11): Bits
Allocated 1 frames are packed separately so each starts on a byte boundary, and odd-length
fragments get a pad byte. For .8.1 each fragment is that frame compressed with raw deflate
(RFC 1951, PS3.5 A.4.13). The new case's oracle is the source case's (`oracle_case`); oracle.py
also decodes it with `pydicom:unwrapped` and flags any disagreement.

Usage:  uv run python scripts/sources/unwrapped.py   (then oracle.py --format uncompressed --case gen-unwrap-)
"""

from __future__ import annotations

import sys
import tempfile
import warnings
import zlib
from pathlib import Path

import numpy as np
from pydicom.encaps import encapsulate
from pydicom.uid import UID

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import load_cases, sample_path, save_cases, sha256_file  # noqa: E402
from discover import describe  # noqa: E402
from ref_decode import read  # noqa: E402

warnings.filterwarnings("ignore")

SOURCES = [
    "gen-synth-u12-65x31",                                # odd width, 12 of 16 bits
    "gen-synth-s12-40x40",                                # signed
    "gen-synth-u16-3frame-32x32",                         # multi-frame
    "idc-expl-mono2-u1of1-mf-seg-stonybrook-4af45832",    # Bits Allocated 1, frames not byte-aligned
    "pydicom-SC_ybr_full_422_uncompressed",               # 4:2:2
    "pydicom-SC_rgb_2frame",                              # RGB multi-frame
    "pydicom-color-pl",                                   # Planar Configuration 1
    "pydicom-SC_rgb_32bit",                               # 32-bit
    "ext-gdcm-NM-PAL-16-PixRep1",                         # palette, signed, 31 frames
]

SYNTAXES = {"1.2.840.10008.1.2.1.98": "eu", "1.2.840.10008.1.2.8.1": "dif"}


def frames_of(ds) -> list[bytes]:
    n = int(getattr(ds, "NumberOfFrames", 1) or 1)
    r, c, s, ba = int(ds.Rows), int(ds.Columns), int(ds.SamplesPerPixel), int(ds.BitsAllocated)
    data = bytes(ds.PixelData)
    if ba == 1:
        bits = np.unpackbits(np.frombuffer(data, np.uint8), bitorder="little")
        per = r * c * s
        return [np.packbits(bits[k * per:(k + 1) * per], bitorder="little").tobytes() for k in range(n)]
    per = r * c * s * (ba // 8)
    if str(ds.PhotometricInterpretation) in ("YBR_FULL_422", "YBR_PARTIAL_422"):
        per = per // 3 * 2
    return [data[k * per:(k + 1) * per] for k in range(n)]


def deflate(b: bytes) -> bytes:
    z = zlib.compressobj(9, zlib.DEFLATED, -15)
    return z.compress(b) + z.flush()


def main() -> None:
    known = {c["id"]: c for c in load_cases("uncompressed")}
    added = []
    for src_id in SOURCES:
        src = sample_path("uncompressed", src_id)
        if src_id not in known or not src.exists():
            print(f"missing source {src_id}")
            continue
        for ts, short in SYNTAXES.items():
            cid = f"gen-unwrap-{short}-{src_id}"
            ds = read(src)
            frames = frames_of(ds)
            if ts.endswith(".8.1"):
                frames = [deflate(f) for f in frames]
            # pydicom 3.0 does not know .8.1; write as .1.98 (same padded length) and patch the UID.
            ds.file_meta.TransferSyntaxUID = UID("1.2.840.10008.1.2.1.98")
            ds.PixelData = encapsulate(frames, has_bot=True)
            ds["PixelData"].VR = "OB"
            ds["PixelData"].is_undefined_length = True
            dst = sample_path("uncompressed", cid)
            with tempfile.TemporaryDirectory() as td:
                tmp = Path(td) / "x.dcm"
                ds.save_as(tmp, implicit_vr=False, little_endian=True, enforce_file_format=False)
                out = tmp.read_bytes()
                if short == "dif":
                    head = out[:1024].replace(b"1.2.840.10008.1.2.1.98", b"1.2.840.10008.1.2.8.1\0", 1)
                    out = head + out[1024:]
                dst.write_bytes(out)
            entry = {
                "id": cid, "notes": f"{src_id} re-encoded as {ts}", "tags": ["generated", "encapsulated-native"],
                **describe(read(dst)),
                "source": {"kind": "generated", "of": src_id, "how": f"each frame one fragment{', raw deflate' if short == 'dif' else ''} (scripts/sources/unwrapped.py)",
                           "license": known[src_id].get("source", {}).get("license", "as the source case")},
                "sha256": sha256_file(dst), "size": dst.stat().st_size,
                "oracle_case": f"uncompressed/{src_id}",
                "ruling": "same pixels as the native source case",
            }
            added.append(entry)
            print(f"uncompressed   {cid}")
    save_cases("uncompressed", added)


if __name__ == "__main__":
    main()
