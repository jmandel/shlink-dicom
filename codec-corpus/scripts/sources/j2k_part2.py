"""JPEG 2000 Part 2 multi-component cases (1.2.840.10008.1.2.4.92 and .93) and their reference decoder.

No public DICOM file uses these transfer syntaxes, and no open-source decoder implements the
Part 2 multiple component transformation (T.801 Annex J): OpenJPEG 2.5.4 and Grok both refuse
a COD whose transformation type is above 1. OpenJPEG's Part 2 encoder (`opj_set_MCT`) writes
the marker segments but codes wrong components (its custom transform writes integers into the
float buffer of the 9/7 path), and `opj_compress -m` is not wired to its option parser. So the
cases are made here, and the reference is built from two parts:

- the codestream components, decoded by OpenJPEG (pylibjpeg-openjpeg) from a copy of the
  codestream with the Part 2 marker segments removed (Rsiz 0, COD transformation 0, every
  component marked signed so that no DC level shift is added);
- the inverse transformation of Annex J, written here in numpy from the standard, separately
  from the Rust decoder.

Encoding: the forward transformations of Annex J (J.3.1.1.2-4, J.3.1.2.2-4) are written here;
the transformed components are coded by OpenJPEG as signed components without a component
transform (5/3 for the reversible cases, 9/7 for the irreversible ones), and the CBD, MCT, MCC
and MCO marker segments are added to the main header. The seed is the ground truth of the
reversible (.92) cases.

Volumetric cases (each frame a component, PS3.5 A.4.4) are made only with --volumetric: the
CLI must split the Pixel Data into codestreams instead of frames to decode them.

The encoder is `j2k_part2/opj_mc_enc.c`, compiled against the system libopenjp2 on first use
into ~/.cache/shl-j2k-part2/.

Usage:  uv run python scripts/sources/j2k_part2.py [--volumetric]
"""

from __future__ import annotations

import argparse
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import ROOT, sample_path  # noqa: E402

TS_LOSSLESS = "1.2.840.10008.1.2.4.92"
TS_LOSSY = "1.2.840.10008.1.2.4.93"
HERE = Path(__file__).resolve().parent / "j2k_part2"
CACHE = Path.home() / ".cache" / "shl-j2k-part2"

SOT, COD, CBD, MCT, MCC, MCO = 0xFF90, 0xFF52, 0xFF78, 0xFF74, 0xFF75, 0xFF77


# --------------------------------------------------------------------------- marker segments

def seg(marker: int, body: bytes) -> bytes:
    return struct.pack(">HH", marker, len(body) + 2) + body


def cbd(comps: list[tuple[int, bool]]) -> bytes:
    """CBD (T.801 A.3.6): one bit depth for all when they are equal."""
    depth = [(p - 1) | (0x80 if s else 0) for p, s in comps]
    if len(set(depth)) == 1:
        return seg(CBD, struct.pack(">HB", 0x8000 | len(comps), depth[0]))
    return seg(CBD, struct.pack(">H", len(comps)) + bytes(depth))


ELEMENT = {"i16": (0, ">i2"), "i32": (1, ">i4"), "f32": (2, ">f4"), "f64": (3, ">f8")}
ARRAY = {"dependency": 0, "decorrelation": 1, "offset": 2}


def mct(index: int, array: str, element: str, values, parts: int = 1) -> bytes:
    """MCT (A.3.7), split into `parts` marker segments (a Zmct/Ymct series) if asked."""
    etype, dtype = ELEMENT[element]
    imct = index | (ARRAY[array] << 8) | (etype << 10)
    data = np.asarray(values, dtype=dtype).tobytes()
    size = np.dtype(dtype).itemsize
    n = len(data) // size
    cuts = [round(k * n / parts) * size for k in range(parts + 1)]
    out = b""
    for z in range(parts):
        head = struct.pack(">HHH", z, imct, parts - 1) if z == 0 else struct.pack(">HH", z, imct)
        out += seg(MCT, head + data[cuts[z]:cuts[z + 1]])
    return out


def mcc(index: int, collections: list[dict], parts: int = 1) -> bytes:
    """MCC (A.3.8). Each collection: kind (dependency/decorrelation), inputs, outputs,
    t (transform array index), o (offset array index), reversible."""
    body = b""
    for c in collections:
        x = {"dependency": 0, "decorrelation": 1}[c["kind"]]
        body += struct.pack(">BH", x, len(c["inputs"])) + bytes(c["inputs"])
        body += struct.pack(">H", len(c["outputs"])) + bytes(c["outputs"])
        tmcc = c.get("t", 0) | (c.get("o", 0) << 8) | (0x10000 if c["reversible"] else 0)
        body += tmcc.to_bytes(3, "big")
    cuts = [round(k * len(body) / parts) for k in range(parts + 1)]
    out = b""
    for z in range(parts):
        head = struct.pack(">HBHH", z, index, parts - 1, len(collections)) if z == 0 else struct.pack(">HB", z, index)
        out += seg(MCC, head + body[cuts[z]:cuts[z + 1]])
    return out


def mco(stages: list[int]) -> bytes:
    return seg(MCO, bytes([len(stages)] + stages))


def main_header_segments(cs: bytes):
    """(marker, start, end) of each main-header marker segment after SIZ, up to the first SOT."""
    pos = 4 + struct.unpack(">H", cs[4:6])[0]
    out = []
    while True:
        marker = struct.unpack(">H", cs[pos:pos + 2])[0]
        if marker == SOT:
            return out, pos
        length = struct.unpack(">H", cs[pos + 2:pos + 4])[0]
        out.append((marker, pos, pos + 2 + length))
        pos += 2 + length


def add_part2(cs: bytes, markers: bytes) -> bytes:
    """Rsiz |= Part 2 + MCT capability, COD transformation type 2 (array-based), and the
    marker segments inserted before the first tile-part."""
    b = bytearray(cs)
    rsiz = struct.unpack(">H", b[6:8])[0]
    b[6:8] = struct.pack(">H", rsiz | 0x8100)
    segs, sot = main_header_segments(bytes(b))
    cod = next(s for s in segs if s[0] == COD)
    b[cod[1] + 8] = 2
    return bytes(b[:sot]) + markers + bytes(b[sot:])


# --------------------------------------------------------------------------- encoder

def encoder() -> Path:
    exe = CACHE / "opj_mc_enc"
    src = HERE / "opj_mc_enc.c"
    if not exe.exists() or exe.stat().st_mtime < src.stat().st_mtime:
        CACHE.mkdir(parents=True, exist_ok=True)
        subprocess.run(["gcc", "-O2", "-o", str(exe), str(src), "-I/usr/include/openjpeg-2.5", "-lopenjp2"], check=True)
    return exe


def encode(comps: np.ndarray, prec: int, signed: bool, mode: str, rate: float = 0) -> bytes:
    """comps: (rows, cols, ncomp) integers."""
    rows, cols, nc = comps.shape
    with tempfile.TemporaryDirectory() as td:
        src, dst = Path(td) / "in.i32", Path(td) / "out.j2k"
        src.write_bytes(np.ascontiguousarray(comps.astype("<i4")).tobytes())
        subprocess.run([str(encoder()), str(src), str(cols), str(rows), str(nc), str(prec), str(int(signed)), str(dst), mode,
                        str(rate)], check=True, capture_output=True, timeout=300)
        return dst.read_bytes()


def fit(comps: np.ndarray) -> int:
    """Smallest signed precision holding every value. Codestream components are coded as
    signed so that the encoder applies no DC level shift: Part 2 decoding applies none."""
    lo, hi = int(comps.min()), int(comps.max())
    for p in range(2, 39):
        if -(1 << (p - 1)) <= lo and hi < (1 << (p - 1)):
            return p
    raise ValueError("too wide")


# --------------------------------------------------------------------------- forward transformations

def fwd_rev_dependency(w: list[np.ndarray], t: list[int], o: list[int]) -> list[np.ndarray]:
    """Inverse of J-15: C_i = W_i - o_i - floor(S_i / t_ii), S_i = sum_{j<i} t_ij W_j + floor(t_ii / 2)."""
    m = len(w)
    c = [w[0] - o[0]]
    for i in range(1, m):
        base = i * (i + 1) // 2 - 1
        scale = t[base + i]
        s = sum(t[base + j] * w[j] for j in range(i)) + scale // 2
        c.append(w[i] - o[i] - np.floor_divide(s, scale))
    return c


def fwd_rev_decorrelation(w: list[np.ndarray], t: list[int], o: list[int]) -> list[np.ndarray]:
    """Inverse of J-4 to J-6: the single-element steps in reverse order, each adding what the
    inverse step subtracts (J-7 to J-10)."""
    n = len(w)
    p = [wi - oi for wi, oi in zip(w, o)]
    for l in range(n, -1, -1):
        k = n - 1 - l if l < n else n - 1
        row = t[l * n:(l + 1) * n]
        scale = abs(row[k])
        s = sum(row[i] * p[i] for i in range(n) if i != k) + scale // 2
        q = np.floor_divide(s, scale)
        p[k] = p[k] + q if l < n else int(np.sign(row[k])) * p[k] + q
    return p


def fwd_irr_dependency(w: list[np.ndarray], t: list[float], o: list[float]) -> list[np.ndarray]:
    """Inverse of J-11/J-12 (J-13): C_i = W_i - o_i - sum_{j<i} t_ij W_j."""
    c = []
    for i in range(len(w)):
        base = i * (i - 1) // 2
        c.append(w[i] - o[i] - sum(t[base + j] * w[j] for j in range(i)))
    return c


# --------------------------------------------------------------------------- reference decoder

def parse_part2(cs: bytes) -> dict | None:
    """The Part 2 marker segments of the main header, or None when no transformation applies."""
    rsiz = struct.unpack(">H", cs[6:8])[0]
    segs, _ = main_header_segments(cs)
    cod = next(s for s in segs if s[0] == COD)
    if not (rsiz & 0x8000 and rsiz & 0x0100 and cs[cod[1] + 8] == 2):
        return None
    out = {"cbd": None, "mct": {}, "mcc": {}, "mco": None}
    for marker, a, b in segs:
        body = cs[a + 4:b]
        if marker == CBD:
            n = struct.unpack(">H", body[:2])[0]
            depths = [body[2]] * (n & 0x7FFF) if n & 0x8000 else list(body[2:])
            out["cbd"] = [((d & 0x7F) + 1, bool(d & 0x80)) for d in depths]
        elif marker == MCT:
            z, imct = struct.unpack(">HH", body[:4])
            rest = body[6:] if z == 0 else body[4:]
            out["mct"].setdefault(imct, {})[z] = rest
        elif marker == MCC:
            z, imcc = struct.unpack(">HB", body[:3])
            if z == 0:
                q = struct.unpack(">H", body[5:7])[0]
                out["mcc"].setdefault(imcc, {})["q"] = q
                rest = body[7:]
            else:
                rest = body[3:]
            out["mcc"].setdefault(imcc, {})[z] = rest
        elif marker == MCO:
            out["mco"] = list(body[1:1 + body[0]])
    return out


def strip_part2(cs: bytes) -> bytes:
    """The codestream as Part 1 with signed components: Rsiz 0, COD transformation 0, no
    CBD/MCT/MCC/MCO, every Ssiz signed (so OpenJPEG adds no DC level shift)."""
    segs, sot = main_header_segments(cs)
    b = bytearray(cs[:sot])
    b[6:8] = b"\x00\x00"
    csiz = struct.unpack(">H", b[40:42])[0]
    for k in range(csiz):
        b[42 + 3 * k] |= 0x80
    cod = next(s for s in segs if s[0] == COD)
    b[cod[1] + 8] = 0
    keep = bytearray(b[:segs[0][1]] if segs else b)
    for marker, a, e in segs:
        if marker not in (CBD, MCT, MCC, MCO):
            keep += b[a:e]
    return bytes(keep) + cs[sot:]


def array_values(p2: dict, index: int, array_type: int) -> np.ndarray:
    for imct, parts in p2["mct"].items():
        if imct & 0xFF == index and (imct >> 8) & 3 == array_type:
            data = b"".join(parts[z] for z in sorted(parts))
            dtype = [">i2", ">i4", ">f4", ">f8"][(imct >> 10) & 3]
            return np.frombuffer(data, dtype=dtype).astype(np.float64)
    raise ValueError(f"no MCT array {index} of type {array_type}")


def collections(p2: dict, index: int) -> list[dict]:
    parts = p2["mcc"][index]
    data = b"".join(parts[z] for z in sorted(k for k in parts if k != "q"))
    pos, out = 0, []
    for _ in range(parts["q"]):
        x = data[pos]
        pos += 1
        lists = []
        for _ in range(2):
            n = struct.unpack(">H", data[pos:pos + 2])[0]
            pos += 2
            size = 2 if n & 0x8000 else 1
            count = n & 0x7FFF
            lists.append([int.from_bytes(data[pos + size * i:pos + size * (i + 1)], "big") for i in range(count)])
            pos += size * count
        tmcc = int.from_bytes(data[pos:pos + 3], "big")
        pos += 3
        if x & 3 == 3:
            raise NotImplementedError("wavelet-based multiple component transformation")
        out.append({"kind": "dependency" if x & 3 == 0 else "decorrelation", "inputs": lists[0], "outputs": lists[1],
                    "t": tmcc & 0xFF, "o": (tmcc >> 8) & 0xFF, "reversible": bool(tmcc & 0x10000)})
    return out


def inverse(p2: dict, comps: list[np.ndarray]) -> list[np.ndarray]:
    """Annex J: every MCO stage, every collection, in float64 (irreversible) or int64."""
    stage_list = [collections(p2, i) for i in p2["mco"]]
    sizes = [1 + max(i for c in st for i in c["inputs"]) for st in stage_list[1:]] + [len(p2["cbd"])]
    cur = comps
    shape = comps[0].shape
    for st, size in zip(stage_list, sizes):
        nxt = [None] * size
        for c in st:
            n, m = len(c["inputs"]), len(c["outputs"])
            x = [cur[i] if i < len(cur) and cur[i] is not None else np.zeros(shape) for i in c["inputs"]]
            t = array_values(p2, c["t"], 0 if c["kind"] == "dependency" else 1) if c["t"] else None
            o = array_values(p2, c["o"], 2) if c["o"] else np.zeros(m)
            if c["reversible"]:
                x = [np.floor(v.astype(np.float64) + 0.5).astype(np.int64) for v in x]
                o = o.astype(np.int64)
                t = None if t is None else t.astype(np.int64)
            if c["kind"] == "decorrelation" and not c["reversible"]:
                tm = np.eye(m, n) if t is None else t.reshape(m, n)
                w = [sum(tm[i, j] * x[j].astype(np.float64) for j in range(n)) + o[i] for i in range(m)]
            elif c["kind"] == "dependency" and not c["reversible"]:
                w = []
                for i in range(m):
                    acc = x[i].astype(np.float64) + o[i]
                    if t is not None:
                        acc = acc + sum(t[i * (i - 1) // 2 + j] * w[j] for j in range(i))
                    w.append(acc)
            elif c["kind"] == "dependency":
                w = []
                for i in range(m):
                    y = x[i] + o[i]
                    if t is None or i == 0:
                        w.append(y)
                        continue
                    base = i * (i + 1) // 2 - 1
                    scale = int(t[base + i])
                    s = sum(int(t[base + j]) * w[j] for j in range(i)) + scale // 2
                    w.append(np.floor_divide(s, scale) + y)
            else:
                if t is None:
                    t = np.zeros((n + 1) * n, dtype=np.int64)
                    for r in range(n):
                        t[r * n + n - 1 - r] = 1
                    t[n * n + n - 1] = 1
                p = list(x)
                for l in range(n + 1):
                    k = n - 1 - l if l < n else n - 1
                    row = [int(v) for v in t[l * n:(l + 1) * n]]
                    scale = abs(row[k])
                    s = sum(row[i] * p[i] for i in range(n) if i != k) + scale // 2
                    q = np.floor_divide(s, scale)
                    p[k] = p[k] - q if l < n else int(np.sign(row[k])) * (p[k] - q)
                w = [pi + oi for pi, oi in zip(p, o)]
            for j, out in zip(c["outputs"], w):
                nxt[j] = out
        cur = nxt
    return [np.zeros(shape) if c is None else c for c in cur]


def reference_decode(path: Path) -> np.ndarray:
    """Canonical pixels (CONTRACT.md) of a .92/.93 file: one codestream per fragment group,
    its output components frame after frame."""
    import openjpeg
    import pydicom
    from pydicom.encaps import generate_frames
    ds = pydicom.dcmread(path, force=True)
    frames = int(getattr(ds, "NumberOfFrames", 1) or 1)
    rows, cols, spp = int(ds.Rows), int(ds.Columns), int(ds.SamplesPerPixel)
    pr = int(getattr(ds, "PixelRepresentation", 0))
    dtype = np.dtype(("i" if pr else "u") + str(max(1, int(ds.BitsAllocated) // 8)))
    streams = codestreams(ds)
    out = []
    for cs in streams:
        p2 = parse_part2(cs)
        if p2 is None:
            arr = openjpeg.decode(cs).reshape(rows, cols, -1)
            comps = [arr[..., k] for k in range(arr.shape[-1])]
            out_bits = None
        else:
            arr = openjpeg.decode(strip_part2(cs)).reshape(rows, cols, -1).astype(np.int64)
            comps = inverse(p2, [arr[..., k] for k in range(arr.shape[-1])])
            out_bits = p2["cbd"]
        for f in range(len(comps) // spp):
            planes = []
            for s in range(spp):
                v = comps[f * spp + s]
                if out_bits is not None:
                    prec, signed = out_bits[f * spp + s]
                    lo, hi = (-(1 << (prec - 1)), (1 << (prec - 1)) - 1) if signed else (0, (1 << prec) - 1)
                    v = np.clip(np.floor(v.astype(np.float64) + 0.5), lo, hi)
                planes.append(v.astype(np.int64))
            out.append(np.stack(planes, axis=-1))
    if len(out) != frames:
        raise ValueError(f"{len(out)} frames decoded, Number of Frames is {frames}")
    return np.ascontiguousarray(np.stack(out).astype(dtype).astype(dtype.newbyteorder("<")))


def codestreams(ds) -> list[bytes]:
    """The JPEG 2000 codestreams in the Pixel Data: a new one starts at each fragment that
    begins with SOC + SIZ."""
    from pydicom.encaps import generate_fragments
    out: list[bytearray] = []
    for k, frag in enumerate(generate_fragments(ds.PixelData)):
        if k == 0:
            continue  # the Basic Offset Table item
        if frag[:4] == b"\xff\x4f\xff\x51" or not out:
            out.append(bytearray(frag))
        else:
            out[-1] += frag
    return [bytes(b) for b in out]


# --------------------------------------------------------------------------- cases

def write_dicom(dst: Path, arr: np.ndarray, bits: int, pr: int, photometric: str, ts: str, streams: list[bytes]) -> None:
    import pydicom
    from pydicom.encaps import encapsulate
    from generate import make_dataset
    ds = make_dataset(arr, bits, pr, photometric)
    ds.PixelData = encapsulate(streams)
    ds["PixelData"].VR = "OB"
    ds["PixelData"].is_undefined_length = True
    ds.file_meta.TransferSyntaxUID = ts
    if ts == TS_LOSSY:
        ds.LossyImageCompression = "01"
    dst.parent.mkdir(parents=True, exist_ok=True)
    ds.save_as(dst, enforce_file_format=True)
    pydicom.dcmread(dst)  # readable


def seed_arrays() -> dict[str, tuple[np.ndarray, int, int, str]]:
    """seed id -> (array (frames, rows, cols, spp), bits stored, pixel representation, photometric)."""
    import pydicom
    from pydicom.data import get_testdata_file
    out = {}
    for name in ["US1_UNCR.dcm", "SC_rgb.dcm", "SC_rgb_16bit.dcm", "CT_small.dcm", "emri_small.dcm"]:
        ds = pydicom.dcmread(get_testdata_file(name))
        f = int(getattr(ds, "NumberOfFrames", 1) or 1)
        arr = ds.pixel_array.reshape(f, int(ds.Rows), int(ds.Columns), int(ds.SamplesPerPixel))
        out[f"pydicom-{Path(name).stem}"] = (arr, int(ds.BitsStored), int(ds.PixelRepresentation), str(ds.PhotometricInterpretation))
    return out


def planes(arr: np.ndarray, frame: int = 0) -> list[np.ndarray]:
    return [arr[frame, ..., k].astype(np.int64) for k in range(arr.shape[-1])]


def coded(c: list[np.ndarray], markers: bytes, mode: str = "rev", rate: float = 0) -> bytes:
    """Code the transformed components and add the Part 2 marker segments."""
    comps = np.stack([np.rint(v).astype(np.int64) for v in c], axis=-1)
    # Lossy coding overshoots the component range; a spare bit keeps OpenJPEG's clamp to the
    # SIZ range (in the reference decoder) from cutting it, since Annex J clamps nothing
    # before the reconstructed image components.
    prec = fit(comps) + (1 if mode == "irr" else 0)
    return add_part2(encode(comps, prec, True, mode, rate), markers)


def build_cases(volumetric: bool) -> list[dict]:
    seeds = seed_arrays()
    cases = []

    def add(cid, seed, ts, streams, encoder_name, truth, notes, max_abs=None):
        arr, bits, pr, ph = seeds[seed]
        cases.append({"id": cid, "seed": seed, "ts": ts, "streams": streams, "encoder": encoder_name,
                      "truth": truth, "notes": notes, "arr": arr, "bits": bits, "pr": pr, "photometric": ph,
                      "max_abs": max_abs})

    rgb8 = (8, False)

    # Reversible decorrelation (SERM steps) on an ultrasound RGB frame; the MCT array is split
    # over two marker segments (a Zmct series) and the offsets are 16-bit.
    arr = seeds["pydicom-US1_UNCR"][0]
    w = planes(arr)
    t = [2, 1, 4, -3, 2, 1, 8, -1, 2, 1, -5, -4]          # rows 0-2 scales 4, 2, 8; row 3 scale -4
    o = [128, 128, 128]
    c = fwd_rev_decorrelation(w, t, o)
    markers = cbd([rgb8] * 3) + mct(1, "decorrelation", "i16", t, parts=2) + mct(2, "offset", "i16", o) + \
        mcc(1, [{"kind": "decorrelation", "inputs": [0, 1, 2], "outputs": [0, 1, 2], "t": 1, "o": 2, "reversible": True}]) + mco([1])
    add("gen-part2-US1_UNCR-rev-decorrelation", "pydicom-US1_UNCR", TS_LOSSLESS, [coded(c, markers)],
        "j2k_part2.py forward + OpenJPEG 5/3", True,
        "reversible array-based decorrelation; MCT series of two segments; integer offsets")

    # Reversible dependency (prediction of G from R, B from R and G) on 16-bit RGB, 32-bit
    # coefficients, offsets stored as 64-bit floats with integer values.
    arr = seeds["pydicom-SC_rgb_16bit"][0]
    w = planes(arr)
    t = [1, 1, 1, 1, 2]                                    # t10 t11 t20 t21 t22
    o = [32768, 0, 0]
    c = fwd_rev_dependency(w, t, o)
    markers = cbd([(16, False)] * 3) + mct(3, "dependency", "i32", t) + mct(4, "offset", "f64", o) + \
        mcc(7, [{"kind": "dependency", "inputs": [0, 1, 2], "outputs": [0, 1, 2], "t": 3, "o": 4, "reversible": True}]) + mco([7])
    add("gen-part2-SC_rgb_16bit-rev-dependency", "pydicom-SC_rgb_16bit", TS_LOSSLESS, [coded(c, markers)],
        "j2k_part2.py forward + OpenJPEG 5/3", True, "reversible array-based dependency, 16-bit RGB")

    # Two stages: stage 1 (MCC 2) is a dependency over a permuted collection plus an offset-only
    # collection; stage 2 (MCC 5) a reversible decorrelation. The MCC of stage 1 is a series.
    arr = seeds["pydicom-SC_rgb"][0]
    w = planes(arr)
    t2 = [1, 0, 2, -1, 1, 1, 4, 0, 0, 1, 1, 2]
    i1 = fwd_rev_decorrelation(w, t2, [0, 0, 0])               # stage 2 output -> its input
    t1 = [-1, 2]                                               # dependency over (I1[2], I1[0]) -> (I2[1], I2[0])
    dep_in = [i1[1], i1[0]]
    dep_c = fwd_rev_dependency(dep_in, t1, [0, 0])
    c = [None, None, None]
    c[2], c[0] = dep_c[0], dep_c[1]
    c[1] = i1[2] - 100
    markers = cbd([rgb8] * 3) + mct(5, "dependency", "i16", t1) + mct(6, "offset", "i32", [100]) + \
        mct(5, "decorrelation", "f32", t2) + \
        mcc(2, [{"kind": "dependency", "inputs": [2, 0], "outputs": [1, 0], "t": 5, "reversible": True},
                {"kind": "decorrelation", "inputs": [1], "outputs": [2], "o": 6, "reversible": True}], parts=2) + \
        mcc(5, [{"kind": "decorrelation", "inputs": [0, 1, 2], "outputs": [0, 1, 2], "t": 5, "reversible": True}]) + mco([2, 5])
    add("gen-part2-SC_rgb-two-stages", "pydicom-SC_rgb", TS_LOSSLESS, [coded(c, markers)],
        "j2k_part2.py forward + OpenJPEG 5/3", True,
        "two stages; permuted component collections; an offset-only collection; MCC series; 16/32-bit and float arrays")

    # Monochrome signed CT with an offset only (a one-component reversible dependency).
    arr = seeds["pydicom-CT_small"][0]
    w = planes(arr)
    c = [w[0] + 1024]
    markers = cbd([(16, True)]) + mct(1, "offset", "i16", [-1024]) + \
        mcc(1, [{"kind": "dependency", "inputs": [0], "outputs": [0], "o": 1, "reversible": True}]) + mco([1])
    add("gen-part2-CT_small-rev-offset", "pydicom-CT_small", TS_LOSSLESS, [coded(c, markers)],
        "j2k_part2.py forward + OpenJPEG 5/3", True, "signed monochrome; offset array only")

    # Irreversible decorrelation: RGB to YCbCr after removing 128, the inverse matrix in the
    # MCT array (32-bit floats), 9/7 with all bits and at 20:1.
    arr = seeds["pydicom-US1_UNCR"][0]
    w = [p.astype(np.float64) for p in planes(arr)]
    fwd = np.array([[0.299, 0.587, 0.114], [-0.168736, -0.331264, 0.5], [0.5, -0.418688, -0.081312]])
    c = [sum(fwd[i, j] * (w[j] - 128) for j in range(3)) for i in range(3)]
    inv = np.linalg.inv(fwd).astype(np.float32)
    markers = cbd([rgb8] * 3) + mct(1, "decorrelation", "f32", inv.ravel()) + mct(2, "offset", "f32", [128] * 3) + \
        mcc(1, [{"kind": "decorrelation", "inputs": [0, 1, 2], "outputs": [0, 1, 2], "t": 1, "o": 2, "reversible": False}]) + mco([1])
    for rate, suffix in [(0, ""), (20, "-cr20")]:
        add(f"gen-part2-US1_UNCR-irr-decorrelation{suffix}", "pydicom-US1_UNCR", TS_LOSSY, [coded(c, markers, "irr", rate)],
            f"j2k_part2.py forward + OpenJPEG 9/7{' 20:1' if rate else ''}", False,
            "irreversible array-based decorrelation (YCbCr) with offsets", max_abs=2)

    # Irreversible dependency with float coefficients (64-bit), 9/7.
    arr = seeds["pydicom-SC_rgb"][0]
    w = [p.astype(np.float64) for p in planes(arr)]
    t = [0.75, 0.5, 0.25]
    o = [128.0, 0.0, 0.0]
    c = fwd_irr_dependency(w, t, o)
    markers = cbd([rgb8] * 3) + mct(9, "dependency", "f64", t) + mct(10, "offset", "f64", o) + \
        mcc(3, [{"kind": "dependency", "inputs": [0, 1, 2], "outputs": [0, 1, 2], "t": 9, "o": 10, "reversible": False}]) + mco([3])
    add("gen-part2-SC_rgb-irr-dependency", "pydicom-SC_rgb", TS_LOSSY, [coded(c, markers, "irr")],
        "j2k_part2.py forward + OpenJPEG 9/7", False, "irreversible array-based dependency, float coefficients")

    if volumetric:
        # Each frame a component (PS3.5 A.4.4): the previous frame predicts the next.
        arr, bits, _, _ = seeds["pydicom-emri_small"]
        f = arr.shape[0]
        w = [arr[k, ..., 0].astype(np.int64) for k in range(f)]
        t = []
        for i in range(1, f):
            t += [0] * (i - 1) + [1, 1]                            # t_i(i-1) = 1, t_ii = 1
        c = fwd_rev_dependency(w, t, [0] * f)
        markers = cbd([(bits, False)] * f) + mct(1, "dependency", "i16", t) + \
            mcc(1, [{"kind": "dependency", "inputs": list(range(f)), "outputs": list(range(f)), "t": 1, "reversible": True}]) + mco([1])
        add("gen-part2-emri_small-volume", "pydicom-emri_small", TS_LOSSLESS, [coded(c, markers)],
            "j2k_part2.py forward + OpenJPEG 5/3", True, "volumetric: 10 frames as the components of one codestream")
        # The same volume as two component collections, one codestream (fragment) each.
        streams = []
        for part in (w[:5], w[5:]):
            tt = t[:5 * 6 // 2 - 1]
            c = fwd_rev_dependency(part, tt, [0] * 5)
            markers = cbd([(bits, False)] * 5) + mct(1, "dependency", "i16", tt) + \
                mcc(1, [{"kind": "dependency", "inputs": list(range(5)), "outputs": list(range(5)), "t": 1, "reversible": True}]) + mco([1])
            streams.append(coded(c, markers))
        add("gen-part2-emri_small-volume-2-codestreams", "pydicom-emri_small", TS_LOSSLESS, streams,
            "j2k_part2.py forward + OpenJPEG 5/3", True, "volumetric: 10 frames in two codestreams of 5 components")
    return cases


def main() -> None:
    import generate
    ap = argparse.ArgumentParser()
    ap.add_argument("--volumetric", action="store_true", help="also make the volumetric cases (needs CLI support)")
    a = ap.parse_args()
    if shutil.which("gcc") is None:
        raise SystemExit("gcc is needed to build the encoder")
    seeds_dir = ROOT / "seeds"
    seeds_dir.mkdir(exist_ok=True)
    for case in build_cases(a.volumetric):
        arr = case["arr"]
        np.save(seeds_dir / f"{case['seed']}.npy", np.ascontiguousarray(arr.astype(arr.dtype.newbyteorder("<"))))
        dst = sample_path("jpeg2000", case["id"])
        write_dicom(dst, arr, case["bits"], case["pr"], case["photometric"], case["ts"], case["streams"])
        generate.register("jpeg2000", case["id"], dst, case["seed"], case["encoder"], case["truth"])
        # Keep the notes and the licence of the seed with the case.
        from common import load_cases, save_cases
        entry = next(c for c in load_cases("jpeg2000") if c["id"] == case["id"])
        entry["notes"] = (case["notes"] + "; no independent decoder: the oracle is the seed or j2k-part2 "
                          "(OpenJPEG on the components plus numpy Annex J), since no available decoder reads Part 2 MCT")
        entry["tags"] = sorted(set(entry.get("tags", [])) | {"part2"})
        entry["source"]["seed_origin"] = "pydicom test data (pydicom-data, MIT)"
        entry["source"]["script"] = "scripts/sources/j2k_part2.py"
        if case["max_abs"] is not None:
            entry["max_abs_override"] = case["max_abs"]
            entry["max_abs_reason"] = ("the reference applies the inverse transformation to OpenJPEG's components "
                                       "rounded to integers; 0.5 per component times the 1.402 and 1.772 coefficients "
                                       "moves an output by up to 2 (jpeg2000 FORMAT.md, Part 2)")
        save_cases("jpeg2000", [entry])
        print(f"jpeg2000       {case['id']}")


if __name__ == "__main__":
    main()
