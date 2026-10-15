"""Make test cases by encoding known pixel arrays ("seeds") with several encoders.

For lossless syntaxes the seed pixels are ground truth, independent of any decoder.
For lossy syntaxes the oracle comes from reference decoders (oracle.py).

Seeds:
  synth-*   deterministic synthetic images (gradients, edges, noise) covering
            8/12/16-bit, signed, RGB, odd sizes and multi-frame
  pydicom-* uncompressed pydicom test images (real MR/CT)
  local-*   one uncompressed slice from the local demo MRI, if present

Encoders: pydicom (RLE, JPEG-LS via CharLS, JPEG 2000 via OpenJPEG), DCMTK (dcmcjpeg,
dcmcjpls, dcmcrle) and OpenJPH (ojph_compress, for HTJ2K).

Usage:  uv run python scripts/generate.py [--only FORMAT]
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tarfile
import tempfile
import warnings
from pathlib import Path

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.encaps import encapsulate
from pydicom.uid import ExplicitVRLittleEndian, SecondaryCaptureImageStorage, generate_uid

sys.path.insert(0, str(Path(__file__).parent))
from common import ROOT, TRANSFER_SYNTAXES, canonical, load_cases, sample_path, save_cases, sha256_file  # noqa: E402
from discover import describe  # noqa: E402

warnings.filterwarnings("ignore")


# --------------------------------------------------------------------------- seeds

def synth(name: str, rows: int, cols: int, bits: int, signed: bool = False, spp: int = 1, frames: int = 1) -> tuple[str, np.ndarray, int, int]:
    rng = np.random.default_rng(sum(map(ord, name)))
    y, x = np.mgrid[0:rows, 0:cols]
    out = []
    lo, hi = (-(2 ** (bits - 1)), 2 ** (bits - 1) - 1) if signed else (0, 2**bits - 1)
    for f in range(frames):
        base = (x / max(cols - 1, 1) * 0.6 + y / max(rows - 1, 1) * 0.3 + 0.05 * f)
        base = base + (((x // 8 + y // 8 + f) % 2) * 0.1)          # checkerboard edges
        img = lo + base / base.max() * (hi - lo) * 0.9
        img = img + rng.normal(0, (hi - lo) * 0.01, size=img.shape)  # sensor-like noise
        img = np.clip(np.rint(img), lo, hi)
        if spp == 3:
            img = np.stack([img, np.roll(img, cols // 3, axis=1), hi + lo - img], axis=-1)
        out.append(img)
    dtype = np.dtype(("i" if signed else "u") + ("1" if bits <= 8 else "2"))
    arr = np.stack(out).astype(dtype)
    return name, arr, bits, 1 if signed else 0


def seeds() -> list[tuple[str, np.ndarray, int, int, str]]:
    """(seed id, array (frames, rows, cols[, spp]), bits stored, pixel representation, photometric)"""
    s = []
    for name, rows, cols, bits, signed, spp, frames in [
        ("synth-u8-64x48", 48, 64, 8, False, 1, 1),
        ("synth-u12-65x31", 31, 65, 12, False, 1, 1),
        ("synth-u16-128x96", 96, 128, 16, False, 1, 1),
        ("synth-s16-64x64", 64, 64, 16, True, 1, 1),
        ("synth-s12-40x40", 40, 40, 12, True, 1, 1),
        ("synth-rgb8-60x40", 40, 60, 8, False, 3, 1),
        ("synth-u16-3frame-32x32", 32, 32, 16, False, 1, 3),
        ("synth-u8-1x1", 1, 1, 8, False, 1, 1),
    ]:
        sid, arr, b, pr = synth(name, rows, cols, bits, signed, spp, frames)
        s.append((sid, arr, b, pr, "RGB" if spp == 3 else "MONOCHROME2"))
    from pydicom.data import get_testdata_file
    for name in ["MR_small.dcm", "CT_small.dcm"]:
        ds = pydicom.dcmread(get_testdata_file(name))
        arr = ds.pixel_array[None, ...]
        s.append((f"pydicom-{Path(name).stem}", arr, int(ds.BitsStored), int(ds.PixelRepresentation), "MONOCHROME2"))
    local = ROOT.parent / "data" / "samples" / "mri-brain-2020.tgz"
    if local.exists():
        with tempfile.TemporaryDirectory() as td, tarfile.open(local) as t:
            t.extractall(td, filter="data")
            files = sorted(Path(td).rglob("*.dcm"))
            ds = pydicom.dcmread(files[len(files) // 2])
            if str(ds.file_meta.TransferSyntaxUID) == ExplicitVRLittleEndian:
                s.append(("local-mri-slice", ds.pixel_array[None, ...], int(ds.BitsStored), int(ds.PixelRepresentation), "MONOCHROME2"))
    return s


def make_dataset(arr: np.ndarray, bits_stored: int, pr: int, photometric: str) -> Dataset:
    frames, rows, cols = arr.shape[:3]
    spp = arr.shape[3] if arr.ndim == 4 else 1
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = SecondaryCaptureImageStorage
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = Dataset()
    ds.file_meta = meta
    ds.SOPClassUID = SecondaryCaptureImageStorage
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID, ds.SeriesInstanceUID = generate_uid(), generate_uid()
    ds.Modality = "OT"
    ds.PatientName, ds.PatientID = "Synthetic^Seed", "SEED"
    ds.Rows, ds.Columns = rows, cols
    ds.SamplesPerPixel = spp
    ds.PhotometricInterpretation = photometric
    if spp == 3:
        ds.PlanarConfiguration = 0
    ds.BitsAllocated = 8 if arr.dtype.itemsize == 1 else 16
    ds.BitsStored, ds.HighBit, ds.PixelRepresentation = bits_stored, bits_stored - 1, pr
    if frames > 1:
        ds.NumberOfFrames = frames
    ds.PixelData = np.ascontiguousarray(arr.astype(arr.dtype.newbyteorder("<"))).tobytes()
    return ds


# --------------------------------------------------------------------------- encoders

def tool_version(cmd: list[str]) -> str:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        return (r.stdout + r.stderr).strip().splitlines()[0][:80]
    except Exception:
        return "?"


def enc_pydicom(src: Path, dst: Path, uid: str, **kw) -> None:
    ds = pydicom.dcmread(src)
    ds.compress(uid, **kw)
    ds.save_as(dst, enforce_file_format=True)


def enc_tool(src: Path, dst: Path, cmd: list[str]) -> None:
    subprocess.run(cmd + [str(src), str(dst)], check=True, capture_output=True, timeout=120)


def enc_openjph(src: Path, dst: Path, uid: str, args: list[str]) -> None:
    ds = pydicom.dcmread(src)
    if int(ds.PixelRepresentation) == 1:
        raise RuntimeError("PNM input cannot carry signed samples")
    arr = ds.pixel_array
    frames = int(getattr(ds, "NumberOfFrames", 1) or 1)
    arr = arr.reshape(frames, int(ds.Rows), int(ds.Columns), int(ds.SamplesPerPixel))
    maxval = 2 ** int(ds.BitsStored) - 1
    streams = []
    with tempfile.TemporaryDirectory() as td:
        for k in range(frames):
            spp = arr.shape[3]
            p = Path(td) / (f"{k}.ppm" if spp == 3 else f"{k}.pgm")
            body = arr[k].astype(">u2" if maxval > 255 else "u1").tobytes()
            p.write_bytes(f"{'P6' if spp == 3 else 'P5'}\n{ds.Columns} {ds.Rows}\n{maxval}\n".encode() + body)
            out = Path(td) / f"{k}.j2c"
            subprocess.run(["ojph_compress", "-i", str(p), "-o", str(out)] + args, check=True, capture_output=True, timeout=120)
            streams.append(out.read_bytes())
    ds.PixelData = encapsulate(streams)
    ds["PixelData"].VR = "OB"
    ds["PixelData"].is_undefined_length = True
    ds.file_meta.TransferSyntaxUID = uid
    ds.save_as(dst, enforce_file_format=True)


def encoders(bits: int, signed: bool, spp: int):
    """Yield (name, transfer syntax, callable(src, dst)) for encoders that accept this seed."""
    yield "pydicom-rle", "1.2.840.10008.1.2.5", lambda s, d: enc_pydicom(s, d, "1.2.840.10008.1.2.5")
    if shutil.which("dcmcrle"):
        yield "dcmtk-rle", "1.2.840.10008.1.2.5", lambda s, d: enc_tool(s, d, ["dcmcrle"])
    yield "charls-ls", "1.2.840.10008.1.2.4.80", lambda s, d: enc_pydicom(s, d, "1.2.840.10008.1.2.4.80")
    yield "charls-nl3", "1.2.840.10008.1.2.4.81", lambda s, d: enc_pydicom(s, d, "1.2.840.10008.1.2.4.81", jls_error=3)
    if shutil.which("dcmcjpls"):
        yield "dcmtk-ls", "1.2.840.10008.1.2.4.80", lambda s, d: enc_tool(s, d, ["dcmcjpls"])
    yield "openjpeg-rev", "1.2.840.10008.1.2.4.90", lambda s, d: enc_pydicom(s, d, "1.2.840.10008.1.2.4.90")
    yield "openjpeg-cr20", "1.2.840.10008.1.2.4.91", lambda s, d: enc_pydicom(
        s, d, "1.2.840.10008.1.2.4.91", j2k_cr=[20], photometric_interpretation="RGB" if spp == 3 else "MONOCHROME2")
    if shutil.which("dcmcjpeg"):
        if bits <= 8 and not signed:
            yield "ijg-baseline", "1.2.840.10008.1.2.4.50", lambda s, d: enc_tool(s, d, ["dcmcjpeg", "+eb"])
        if bits <= 12 and spp == 1:
            yield "ijg-extended", "1.2.840.10008.1.2.4.51", lambda s, d: enc_tool(s, d, ["dcmcjpeg", "+ee"])
        yield "ijg-lossless-sv1", "1.2.840.10008.1.2.4.70", lambda s, d: enc_tool(s, d, ["dcmcjpeg", "+e1"])
        for sv in range(1, 8):
            yield f"ijg-lossless-p14-sv{sv}", "1.2.840.10008.1.2.4.57", (
                lambda s, d, sv=sv: enc_tool(s, d, ["dcmcjpeg", "+el", "+sv", str(sv)]))
    if shutil.which("ojph_compress") and not signed:
        yield "openjph-rev", "1.2.840.10008.1.2.4.201", lambda s, d: enc_openjph(s, d, "1.2.840.10008.1.2.4.201", ["-reversible", "true"])
        yield "openjph-rev-rpcl", "1.2.840.10008.1.2.4.202", lambda s, d: enc_openjph(
            s, d, "1.2.840.10008.1.2.4.202", ["-reversible", "true", "-prog_order", "RPCL"])
        yield "openjph-q", "1.2.840.10008.1.2.4.203", lambda s, d: enc_openjph(s, d, "1.2.840.10008.1.2.4.203", ["-qstep", "0.01"])


# --------------------------------------------------------------------------- main

def register(fmt: str, case_id: str, path: Path, seed: str, encoder: str, truth_ok: bool) -> None:
    ds = pydicom.dcmread(path)
    cases = {c["id"]: c for c in load_cases(fmt)}
    entry = cases.get(case_id, {"id": case_id, "notes": "", "tags": []})
    entry.update(describe(ds))
    entry["source"] = {"kind": "generated", "seed": seed, "encoder": encoder}
    entry["truth"] = "seed" if truth_ok else "references"
    entry["sha256"] = sha256_file(path)
    entry["size"] = path.stat().st_size
    cases[case_id] = entry
    save_cases(fmt, list(cases.values()))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="limit to one format directory")
    a = ap.parse_args()
    seeds_dir = ROOT / "seeds"
    seeds_dir.mkdir(exist_ok=True)
    versions = {t: tool_version([t, "--version"]) for t in ["dcmcjpeg", "dcmcjpls", "dcmcrle"]}
    versions["ojph_compress"] = tool_version(["ojph_compress", "-v"])
    (seeds_dir / "TOOL_VERSIONS.txt").write_text("".join(f"{k}: {v}\n" for k, v in versions.items()))
    for sid, arr, bits, pr, photometric in seeds():
        src = seeds_dir / f"{sid}.dcm"
        make_dataset(arr, bits, pr, photometric).save_as(src, enforce_file_format=True)
        np.save(seeds_dir / f"{sid}.npy", canonical(arr, arr.shape[0], arr.shape[1], arr.shape[2],
                                                      arr.shape[3] if arr.ndim == 4 else 1))
        spp = arr.shape[3] if arr.ndim == 4 else 1
        if not a.only or a.only == "uncompressed":
            dst = sample_path("uncompressed", f"gen-{sid}")
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
            register("uncompressed", f"gen-{sid}", dst, sid, "none", True)
        for enc, ts, fn in encoders(bits, pr == 1, spp):
            fmt, _, lossy = TRANSFER_SYNTAXES[ts]
            if a.only and fmt != a.only:
                continue
            cid = f"gen-{sid}-{enc}"
            dst = sample_path(fmt, cid)
            dst.parent.mkdir(parents=True, exist_ok=True)
            try:
                fn(src, dst)
                register(fmt, cid, dst, sid, enc, not lossy)
                print(f"{fmt:14} {cid}")
            except Exception as e:
                dst.unlink(missing_ok=True)
                print(f"{fmt:14} {cid}  SKIPPED ({str(e).strip().splitlines()[-1][:90] if str(e).strip() else type(e).__name__})")


if __name__ == "__main__":
    main()
