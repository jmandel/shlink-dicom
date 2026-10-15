"""Extra JPEG-LS test vectors beyond the DICOM corpus, for the shl-codec-jpeg-ls tests.

Writes vectors/<name>.jls, <name>.json ({rows, columns, components, bits, near}) and
<name>.raw (CharLS's decode: uint16 little-endian, interleaved), covering:
  - the T.87 conformance streams shipped with pyjpegls (except the subsampled T8SS*);
  - CharLS-encoded synthetic images at every precision 2..16, NEAR 0/1/3, ILV 0/1/2, 1/3/4 components;
  - DCMTK-encoded streams with custom LSE thresholds/RESET;
  - HP colour transforms (APP8 "mrfx") injected into CharLS streams, decoded by CharLS;
  - restart intervals (DRI + RSTm), spliced from independently CharLS-encoded intervals,
    since a restart re-initialises the decoder as at the start of a scan.

Usage (from codec-corpus/):  uv run python formats/jpeg-ls/extra/gen_vectors.py
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import pydicom
from pydicom.dataset import FileMetaDataset
from pydicom.encaps import generate_frames
from pydicom.uid import ExplicitVRLittleEndian, generate_uid
import _CharLS  # pyjpegls' CharLS binding
import jpeg_ls

OUT = Path(__file__).parent / "vectors"
OUT.mkdir(exist_ok=True)


def charls_decode(buf: bytes) -> tuple[np.ndarray, dict]:
    hdr = _CharLS.read_header(bytes(buf))
    raw = _CharLS._decode(bytes(buf))
    bpp = (hdr["bits_per_sample"] + 7) // 8
    arr = np.frombuffer(bytes(raw), dtype="<u1" if bpp == 1 else "<u2")
    return arr, hdr


def read_pnm(p: Path) -> np.ndarray:
    b = p.read_bytes()
    parts = b.split(maxsplit=4)
    w, h, mv = int(parts[1]), int(parts[2]), int(parts[3])
    nc = 3 if parts[0] == b"P6" else 1
    a = np.frombuffer(parts[4], dtype=">u2" if mv > 255 else "u1")
    return a.reshape(h, w, nc)


def save(name: str, buf: bytes, near: int, orig: np.ndarray | None = None) -> None:
    """Write a vector. CharLS's output layout for multi-component data varies, so the
    reference is laid out as (rows, cols, nc) by matching against the encoder input `orig`:
    lossless must reproduce it exactly, near-lossless within NEAR."""
    arr, hdr = charls_decode(buf)
    rows, cols, nc = hdr["height"], hdr["width"], hdr["components"]
    cands = [arr.reshape(rows, cols, nc)]
    if nc > 1:
        cands += [arr.reshape(rows, nc, cols).transpose(0, 2, 1), arr.reshape(nc, rows, cols).transpose(1, 2, 0)]
        assert orig is not None, name
    if orig is not None:
        o = orig.astype(np.int64).reshape(rows, cols, nc)
        errs = [int(np.abs(c.astype(np.int64) - o).max()) for c in cands]
        best = int(np.argmin(errs))
        assert errs[best] <= near, (name, errs)
        arr = cands[best]
    else:
        arr = cands[0]
    (OUT / f"{name}.jls").write_bytes(bytes(buf))
    (OUT / f"{name}.raw").write_bytes(np.ascontiguousarray(arr, dtype="<u2").tobytes())
    (OUT / f"{name}.json").write_text(json.dumps(
        {"rows": rows, "columns": cols, "components": nc, "bits": hdr["bits_per_sample"], "near": near}))


def synth(rows: int, cols: int, nc: int, bits: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    maxv = (1 << bits) - 1
    y, x = np.mgrid[0:rows, 0:cols]
    planes = []
    for c in range(nc):
        smooth = (np.sin(x / 7 + c) * np.cos(y / 5) + 1) / 2 * maxv
        img = smooth.copy()
        img[rows // 3: rows // 2, :] = maxv // 3 + c  # flat band -> run mode
        img[:, cols // 2: cols // 2 + 3] = 0
        noise = rng.integers(0, maxv + 1, size=(rows, cols))
        img[(rows * 2) // 3:, : cols // 2] = noise[(rows * 2) // 3:, : cols // 2]
        img[rng.random((rows, cols)) < 0.02] = maxv
        planes.append(np.clip(np.rint(img), 0, maxv))
    return np.stack(planes, axis=-1).astype(np.uint16 if bits > 8 else np.uint8)


def charls_encode(a: np.ndarray, near: int, ilv: int, bits: int) -> bytes:
    rows, cols, nc = a.shape
    if nc == 1:
        data = a[..., 0]
    elif ilv == 0:
        data = a.transpose(2, 0, 1)
    else:  # ILV 1 and 2 both take pixel-interleaved input
        data = a
    return bytes(_CharLS._encode(np.ascontiguousarray(data).tobytes(), near, ilv, rows, cols, nc, bits))


def conformance() -> None:
    d = Path(jpeg_ls.__file__).parent / "tests" / "jlsimV100"
    for f in sorted(d.glob("*.JLS")):
        if f.name.startswith("T8SS"):
            continue
        near = 3 if "E3" in f.name else 0
        orig = read_pnm(d / ("TEST16.PGM" if f.name.startswith("T16") else "TEST8.PPM"))
        save("conf-" + f.stem.lower(), f.read_bytes(), near, None if f.name.startswith("T8ND") else orig)


def synthetic() -> None:
    for bits in range(2, 17):
        for near in (0, 1, 3):
            maxv = (1 << bits) - 1
            if near > maxv // 2:
                continue
            a = synth(23, 37, 1, bits, bits * 10 + near)
            save(f"cl-mono-b{bits}-n{near}", charls_encode(a, near, 0, bits), near, orig=a)
    for bits in (8, 12, 16):
        for nc in (3, 4):
            for ilv in (0, 1, 2):
                for near in (0, 2):
                    a = synth(19, 29, nc, bits, bits + nc + ilv + near)
                    save(f"cl-c{nc}-b{bits}-ilv{ilv}-n{near}", charls_encode(a, near, ilv, bits), near,
                         orig=a)
    for (r, c) in ((1, 1), (1, 17), (17, 1), (2, 2), (300, 3)):
        for nc, near, ilv in ((1, 0, 0), (3, 1, 2), (3, 0, 1)):
            a = synth(r, c, nc, 8, r * c + nc)
            try:
                buf = charls_encode(a, near, ilv, 8)
            except RuntimeError as e:  # the binding's output buffer is too small for tiny images
                print(f"edge {r}x{c} nc={nc}: CharLS refused: {e}")
                continue
            save(f"cl-edge-{r}x{c}-c{nc}-ilv{ilv}-n{near}", buf, near, orig=a)
    # Wide flat lines: long runs push RUNindex to its maximum.
    a = np.zeros((8, 5000, 1), np.uint8)
    a[4, 4000] = 200
    save("cl-longrun", charls_encode(a, 0, 0, 8), 0, orig=a)


def dcmtk(name: str, a: np.ndarray, bits: int, args: list[str], near: int) -> None:
    rows, cols, nc = a.shape
    ds = pydicom.Dataset()
    ds.file_meta = FileMetaDataset()
    ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.file_meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.7"
    ds.file_meta.MediaStorageSOPInstanceUID = generate_uid()
    ds.SOPClassUID = ds.file_meta.MediaStorageSOPClassUID
    ds.SOPInstanceUID = ds.file_meta.MediaStorageSOPInstanceUID
    ds.Rows, ds.Columns, ds.SamplesPerPixel = rows, cols, nc
    ds.PhotometricInterpretation = "RGB" if nc == 3 else "MONOCHROME2"
    if nc == 3:
        ds.PlanarConfiguration = 0
    ds.BitsAllocated = 8 if bits <= 8 else 16
    ds.BitsStored, ds.HighBit, ds.PixelRepresentation = bits, bits - 1, 0
    ds.PixelData = a.astype(np.uint8 if bits <= 8 else "<u2").tobytes()
    with tempfile.TemporaryDirectory() as t:
        src, dst = os.path.join(t, "in.dcm"), os.path.join(t, "out.dcm")
        ds.save_as(src, enforce_file_format=True)
        subprocess.run(["dcmcjpls", *args, src, dst], check=True)
        out = pydicom.dcmread(dst)
        frame = next(generate_frames(out.PixelData, number_of_frames=1))
    save(name, frame, near, orig=a)


def dcmtk_vectors() -> None:
    a = synth(33, 41, 1, 12, 7)
    dcmtk("dcmtk-lse-t-12", a, 12, ["+t1", "5", "+t2", "9", "+t3", "40", "+rs", "17"], 0)
    dcmtk("dcmtk-lse-t-12-n2", a, 12, ["+en", "+md", "2", "+t1", "5", "+t2", "9", "+t3", "40", "+rs", "17"], 2)
    a = synth(33, 41, 3, 8, 8)
    dcmtk("dcmtk-lse-rgb", a, 8, ["+t1", "4", "+t2", "6", "+t3", "9", "+rs", "31"], 0)
    dcmtk("dcmtk-cooked-rgb", a, 8, ["+pc", "+il"], 0)


def hp_forward(t: int, r, g, b, bits: int):
    rng = 1 << bits
    m, h = rng - 1, rng // 2
    r, g, b = (x.astype(np.int64) for x in (r, g, b))
    if t == 1:
        return (r - g + h) & m, g, (b - g + h) & m
    if t == 2:
        return (r - g + h) & m, g, (b - ((r + g) >> 1) + h) & m
    v2 = (b - g + h) & m
    v3 = (r - g + h) & m
    return (g + ((v2 + v3) >> 2) - rng // 4) & m, v2, v3


def hp_vectors() -> None:
    for bits in (8, 16):
        a = synth(21, 27, 3, bits, 99 + bits).astype(np.int64)
        for t in (1, 2, 3):
            v = np.stack(hp_forward(t, a[..., 0], a[..., 1], a[..., 2], bits), axis=-1)
            v = v.astype(np.uint8 if bits == 8 else np.uint16)
            # ILV 2 only: CharLS's own legacy-API decode of ILV 1 + transform does not round-trip.
            for ilv in (2,):
                buf = charls_encode(v, 0, ilv, bits)
                app8 = b"\xff\xe8\x00\x07mrfx" + bytes([t])
                buf = buf[:2] + app8 + buf[2:]
                try:
                    save(f"hp{t}-b{bits}-ilv{ilv}", buf, 0, orig=a)
                except Exception as e:  # noqa: BLE001
                    print(f"hp{t}-b{bits}-ilv{ilv}: CharLS refused: {e}")


def restart_vectors() -> None:
    for (nc, ilv, near, bits, ri, rows) in ((1, 0, 0, 8, 4, 18), (1, 0, 2, 12, 1, 7), (3, 1, 0, 8, 5, 15),
                                            (3, 2, 1, 16, 3, 13), (1, 0, 0, 8, 2, 40)):
        a = synth(rows, 64, nc, bits, rows + ri)
        pieces = [charls_encode(np.ascontiguousarray(a[y:y + ri]), near, ilv, bits) for y in range(0, rows, ri)]
        p0 = pieces[0]
        sos = p0.index(b"\xff\xda")
        head = bytearray(p0[:sos])
        sof = head.index(b"\xff\xf7")
        head[sof + 5: sof + 7] = rows.to_bytes(2, "big")
        sos_len = int.from_bytes(p0[sos + 2: sos + 4], "big")
        out = bytes(head) + b"\xff\xdd\x00\x04" + ri.to_bytes(2, "big") + p0[sos: sos + 2 + sos_len]
        for k, p in enumerate(pieces):
            ps = p.index(b"\xff\xda")
            body = p[ps + 2 + int.from_bytes(p[ps + 2: ps + 4], "big"): p.rindex(b"\xff\xd9")]
            out += body
            if k + 1 < len(pieces):
                out += bytes([0xFF, 0xD0 + k % 8])
        out += b"\xff\xd9"
        name = f"restart-c{nc}-ilv{ilv}-n{near}-b{bits}-ri{ri}"
        (OUT / f"{name}.jls").write_bytes(out)
        ref = np.concatenate([np.asarray(charls_ref(p, a[y:y + ri], near)) for p, y in zip(pieces, range(0, rows, ri))])
        (OUT / f"{name}.raw").write_bytes(np.ascontiguousarray(ref, dtype="<u2").tobytes())
        (OUT / f"{name}.json").write_text(json.dumps(
            {"rows": rows, "columns": 64, "components": nc, "bits": bits, "near": near}))


def charls_ref(buf: bytes, orig: np.ndarray, near: int) -> np.ndarray:
    save("tmp-piece", buf, near, orig)
    r = np.frombuffer((OUT / "tmp-piece.raw").read_bytes(), "<u2").reshape(orig.shape)
    for ext in ("jls", "raw", "json"):
        (OUT / f"tmp-piece.{ext}").unlink()
    return r


if __name__ == "__main__":
    conformance()
    synthetic()
    dcmtk_vectors()
    hp_vectors()
    restart_vectors()
    print(len(list(OUT.glob("*.jls"))), "vectors in", OUT)
