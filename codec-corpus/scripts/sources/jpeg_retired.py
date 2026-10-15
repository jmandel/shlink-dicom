"""Generate corpus cases for the retired JPEG processes: spectral selection and full progression
(.53, .55), arithmetic coding (.52, .54, .56, .58) and hierarchical (.59-.66).

No public DICOM files use these processes except two cornerstone3D test images (.53, .55; see
quirks.py), so the cases are encoded here from the corpus seeds (codec-corpus/seeds/) with:

  richter   Thomas Richter's libjpeg (github.com/thorfdbg/libjpeg, GPL-3.0; the `jpeg` tool) at
            commit 702114c, with jpeg_retired/richter-encoder.patch: lossless encoding without a
            DQT segment, and the lossless predictor taken from LJ_PREDICTOR. It writes every
            process: arithmetic, progressive, spectral selection (-v -qv), hierarchical (-y).
  turbo     libjpeg-turbo's cjpeg (-arithmetic, -progressive, -scans, -precision 12).
  dcmtk     dcmcjpeg +es / +ep (spectral selection and progressive, IJG).
  t81py     jpeg_retired/hier_lossless.py: lossless arithmetic and lossless hierarchical
            (processes 15, 28, 29). Richter's encoder writes hierarchical lossless differences
            its decoder does not reproduce, so these come from this small encoder instead.

Lossless cases use the seed as ground truth (truth = seed). Every generated file is registered in
formats/<fmt>/cases.json with its encoder and command; run oracle.py afterwards.

Usage:  uv run python scripts/sources/jpeg_retired.py [--tools DIR] [--only CASE_SUBSTRING]
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import pydicom
from pydicom.encaps import encapsulate

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE / "jpeg_retired"))
from common import ROOT, TRANSFER_SYNTAXES, load_cases, sample_path, save_cases, sha256_file  # noqa: E402
from discover import describe  # noqa: E402
import hier_lossless  # noqa: E402

RICHTER_COMMIT = "702114c"
TS = "1.2.840.10008.1.2.4."
LICENCE = "generated here from the corpus seeds (synthetic images and pydicom's MIT-licensed test images)"


def build_richter(tools: Path) -> Path:
    exe = tools / "libjpeg" / "jpeg"
    if exe.exists():
        return exe
    tools.mkdir(parents=True, exist_ok=True)
    src = tools / "libjpeg"
    if not src.exists():
        subprocess.run(["git", "clone", "-q", "https://github.com/thorfdbg/libjpeg", str(src)], check=True)
    subprocess.run(["git", "checkout", "-q", RICHTER_COMMIT], cwd=src, check=True)
    subprocess.run(["git", "apply", str(HERE / "jpeg_retired" / "richter-encoder.patch")], cwd=src, check=True)
    subprocess.run(["./configure"], cwd=src, check=True, capture_output=True)
    subprocess.run(["make", "-j8"], cwd=src, check=True, capture_output=True)
    return exe


def build_richter_spec(tools: Path) -> Path:
    """Richter's decoder with T.81 J.1.1.2 upsampling (jpeg_retired/richter-spec-upsampling.patch):
    its own upsampler keeps fractions and truncates once, not after each direction."""
    exe = tools / "libjpeg-spec" / "jpeg"
    if exe.exists():
        return exe
    src = tools / "libjpeg-spec"
    if not src.exists():
        subprocess.run(["git", "clone", "-q", "https://github.com/thorfdbg/libjpeg", str(src)], check=True)
    subprocess.run(["git", "checkout", "-q", RICHTER_COMMIT], cwd=src, check=True)
    for patch in ("richter-encoder.patch", "richter-spec-upsampling.patch"):
        subprocess.run(["git", "apply", str(HERE / "jpeg_retired" / patch)], cwd=src, check=True)
    subprocess.run(["./configure"], cwd=src, check=True, capture_output=True)
    subprocess.run(["make", "-j8"], cwd=src, check=True, capture_output=True)
    return exe


def _decode_pnm(exe: Path, jpg: bytes) -> np.ndarray:
    with tempfile.TemporaryDirectory() as td:
        (Path(td) / "in.jpg").write_bytes(jpg)
        subprocess.run([str(exe), str(Path(td) / "in.jpg"), str(Path(td) / "out.pnm")], check=True, capture_output=True)
        d = (Path(td) / "out.pnm").read_bytes()
    parts = d.split(maxsplit=4)
    w, h, mx = int(parts[1]), int(parts[2]), int(parts[3])
    n = 3 if parts[0] == b"P6" else 1
    return np.frombuffer(d[len(d) - w * h * n * (2 if mx > 255 else 1):], ">u2" if mx > 255 else "u1").astype(np.int64)


def hierarchical_tolerances(tools: Path) -> None:
    """Ruling for lossy hierarchical cases (formats/jpeg-dct/FORMAT.md): the only reference is
    Richter's libjpeg, whose upsampler is not T.81's. Allowed difference = how far Richter moves
    when only its upsampler is made T.81's (this file) + how far Richter is from IJG on the
    non-hierarchical counterpart (same seed and sampling, `richter-arith[-420]`)."""
    import json
    from pydicom.encaps import generate_frames
    orig, spec = build_richter(tools), build_richter_spec(tools)
    cases = load_cases("jpeg-dct")
    by_id = {c["id"]: c for c in cases}
    touched = []
    for c in cases:
        if "-richter-hier" not in c["id"]:
            continue
        ds = pydicom.dcmread(sample_path("jpeg-dct", c["id"]))
        frames = list(generate_frames(ds.PixelData, number_of_frames=int(getattr(ds, "NumberOfFrames", 1) or 1)))
        a = max(int(np.abs(_decode_pnm(orig, f) - _decode_pnm(spec, f)).max()) for f in frames)
        seed = c["source"]["seed"]
        twin = f"gen-{seed}-richter-arith" + ("-420" if "420" in c["id"] else "")
        oj = ROOT / "formats" / "jpeg-dct" / "oracle" / f"{twin}.json"
        refs = json.loads(oj.read_text())["references"]
        b = max(r.get("vs_oracle_max_abs", 0) for r in refs.values() if r.get("ok"))
        c["max_abs_override"] = a + b
        c["max_abs_reason"] = (f"hierarchical, Richter only: {a} (Richter vs Richter with T.81 J.1.1.2 upsampling, "
                               f"this file) + {b} (Richter vs IJG on {twin})")
        touched.append(c)
        print(f"{c['id']:60} max_abs {a + b} ({a} + {b})")
    del by_id
    save_cases("jpeg-dct", touched)


def load_seed(sid: str) -> tuple[np.ndarray, pydicom.Dataset]:
    ds = pydicom.dcmread(ROOT / "seeds" / f"{sid}.dcm")
    return np.load(ROOT / "seeds" / f"{sid}.npy"), ds


def unsigned(frame: np.ndarray, bits: int) -> np.ndarray:
    """The stored bit pattern of each sample, as an unsigned value of `bits` bits."""
    return frame.astype(np.int64) & ((1 << bits) - 1)


def write_pnm(path: Path, img: np.ndarray, maxval: int) -> None:
    h, w, n = img.shape
    body = img.astype(">u2" if maxval > 255 else "u1").tobytes()
    path.write_bytes(f"{'P6' if n == 3 else 'P5'}\n{w} {h}\n{maxval}\n".encode() + body)


def to_dicom(seed_ds: pydicom.Dataset, streams: list[bytes], ts: str, photometric: str, dst: Path) -> None:
    ds = seed_ds.copy()
    ds.file_meta = seed_ds.file_meta.copy()
    ds.file_meta.TransferSyntaxUID = ts
    ds.PhotometricInterpretation = photometric
    ds.PixelData = encapsulate(streams)
    ds["PixelData"].VR = "OB"
    ds["PixelData"].is_undefined_length = True
    if len(streams) > 1:
        ds.NumberOfFrames = len(streams)
    ds.save_as(dst, enforce_file_format=True)


def richter(exe: Path, args: list[str], predictor: int | None = None):
    def enc(img: np.ndarray, bits: int, td: Path) -> bytes:
        src, out = td / ("in.ppm" if img.shape[2] == 3 else "in.pgm"), td / "out.jpg"
        write_pnm(src, img, (1 << bits) - 1)
        env = dict(os.environ)
        if predictor:
            env["LJ_PREDICTOR"] = str(predictor)
        subprocess.run([str(exe)] + args + [str(src), str(out)], check=True, capture_output=True, env=env, timeout=120)
        data = out.read_bytes()
        if not data:
            raise RuntimeError("encoder wrote nothing")
        return data
    return enc


def cjpeg(args: list[str], scans: str | None = None):
    def enc(img: np.ndarray, bits: int, td: Path) -> bytes:
        src, out = td / ("in.ppm" if img.shape[2] == 3 else "in.pgm"), td / "out.jpg"
        write_pnm(src, img, (1 << bits) - 1)
        extra = ["-precision", str(bits)] if bits > 8 else []
        if scans:
            (td / "scans.txt").write_text(scans)
            extra += ["-scans", str(td / "scans.txt")]
        subprocess.run(["cjpeg"] + args + extra + ["-outfile", str(out), str(src)], check=True, capture_output=True, timeout=120)
        return out.read_bytes()
    return enc


def t81py(**kw):
    def enc(img: np.ndarray, bits: int, td: Path) -> bytes:
        return hier_lossless.encode(img, bits, **kw)
    return enc


# Spectral selection only (processes 6 and 8): no successive approximation.
SS_GREY = "0: 0 0 0 0;\n0: 1 5 0 0;\n0: 6 63 0 0;\n"
SS_COLOUR = "0,1,2: 0 0 0 0;\n0: 1 9 0 0;\n0: 10 63 0 0;\n1: 1 63 0 0;\n2: 1 63 0 0;\n"


def configs(exe: Path) -> list[tuple[str, str, str, object, str]]:
    """(name, transfer syntax, which seeds, encoder, command description)."""
    c = []
    q = ["-q", "85"]
    sub420 = ["-s", "1x1,2x2,2x2"]
    lossy_sets = [
        ("arith", "52", q + ["-a"]), ("arith-rst", "52", q + ["-a", "-z", "2"]),
        ("ss", "53", q + ["-v", "-qv", "-h"]), ("ss-arith", "54", q + ["-v", "-qv", "-a"]),
        ("prog", "55", q + ["-v", "-h"]), ("prog-arith", "56", q + ["-v", "-a"]),
        ("hier", "59", q + ["-y", "2", "-h"]), ("hier3-rst", "59", q + ["-y", "3", "-h", "-z", "1"]),
        ("hier-arith", "60", q + ["-y", "2", "-a"]),
        ("hier-ss", "61", q + ["-v", "-qv", "-y", "2", "-h"]), ("hier-ss-arith", "62", q + ["-v", "-qv", "-y", "2", "-a"]),
        ("hier-prog", "63", q + ["-v", "-y", "2", "-h"]), ("hier-prog-arith", "64", q + ["-v", "-y", "2", "-a"]),
    ]
    for name, ts, args in lossy_sets:
        c.append((f"richter-{name}", TS + ts, "lossy-grey", richter(exe, args), "jpeg " + " ".join(args)))
    for name, ts, args in [("arith-420", "52", q + ["-a"] + sub420), ("prog-arith-444", "56", q + ["-v", "-a"]),
                           ("hier-420", "59", q + ["-y", "2", "-h"] + sub420),
                           ("hier-prog-arith-420", "64", q + ["-v", "-y", "2", "-a"] + sub420)]:
        c.append((f"richter-{name}", TS + ts, "lossy-colour", richter(exe, args), "jpeg " + " ".join(args)))
    for name, ts, args, scans, which in [
        ("arith", "52", ["-quality", "85", "-arithmetic"], None, "lossy-grey"),
        ("arith-rst", "52", ["-quality", "85", "-arithmetic", "-restart", "1"], None, "lossy-grey"),
        ("prog", "55", ["-quality", "85", "-progressive"], None, "lossy-grey"),
        ("prog-arith", "56", ["-quality", "85", "-progressive", "-arithmetic"], None, "lossy-grey"),
        ("ss", "53", ["-quality", "85"], SS_GREY, "lossy-grey"),
        ("ss-arith", "54", ["-quality", "85", "-arithmetic"], SS_GREY, "lossy-grey"),
        ("prog-420", "55", ["-quality", "85", "-progressive", "-restart", "1"], None, "lossy-colour"),
        ("arith-420", "52", ["-quality", "85", "-arithmetic"], None, "lossy-colour"),
        ("ss-420", "53", ["-quality", "85"], SS_COLOUR, "lossy-colour"),
    ]:
        desc = "cjpeg " + " ".join(args) + (" -scans <spectral selection, no successive approximation>" if scans else "")
        c.append((f"turbo-{name}", TS + ts, which, cjpeg(args, scans), desc))
    for p in range(1, 8):
        c.append((f"richter-lossless-arith-p{p}", TS + "58", "lossless" if p == 1 else "lossless-one",
                  richter(exe, ["-p", "-c", "-a"], p), f"LJ_PREDICTOR={p} jpeg -p -c -a"))
    for name, ts, args in [("ss", "53", ["+es"]), ("prog", "55", ["+ep"])]:
        c.append((f"dcmtk-{name}", TS + ts, "lossy-grey", "dcmtk:" + " ".join(args), "dcmcjpeg " + " ".join(args)))
    for name, ts, kw in [
        ("arith-p1", "58", dict(arith=True, psv=1)), ("arith-p6-rst", "58", dict(arith=True, psv=6, restart_lines=2)),
        ("hier-p1", "65", dict(hierarchical=True, psv=1)), ("hier-p7-rst", "65", dict(hierarchical=True, psv=7, restart_lines=3)),
        ("hier-arith-p4", "66", dict(hierarchical=True, arith=True, psv=4)),
        ("hier-arith-p5-rst", "66", dict(hierarchical=True, arith=True, psv=5, restart_lines=2)),
    ]:
        c.append((f"t81py-{name}", TS + ts, "lossless", t81py(**kw), f"hier_lossless.encode({kw})"))
    return c


SEEDS = {
    "lossy-grey": ["synth-u8-64x48", "synth-u12-65x31", "pydicom-MR_small"],
    "lossy-colour": ["synth-rgb8-60x40"],
    "lossless-one": ["synth-u16-128x96"],
    "lossless": ["synth-u8-64x48", "synth-u12-65x31", "synth-u16-128x96", "synth-s16-64x64", "synth-rgb8-60x40",
                 "synth-u16-3frame-32x32", "pydicom-CT_small"],
}


def register(fmt: str, cid: str, path: Path, seed: str, encoder: str, command: str, truth_ok: bool) -> None:
    ds = pydicom.dcmread(path)
    cases = {c["id"]: c for c in load_cases(fmt)}
    entry = cases.get(cid, {"id": cid, "notes": "", "tags": ["retired-jpeg"]})
    entry.update(describe(ds))
    entry["source"] = {"kind": "generated", "seed": seed, "encoder": encoder, "command": command,
                       "script": "scripts/sources/jpeg_retired.py", "license": LICENCE}
    entry["truth"] = "seed" if truth_ok else "references"
    entry["sha256"] = sha256_file(path)
    entry["size"] = path.stat().st_size
    cases[cid] = entry
    save_cases(fmt, list(cases.values()))


# The only real files found: cornerstone3D test images (MIT), 12-bit CT, SOF2.
REAL = [
    ("ext-cs3d-CTImage.dcm_JPEGProcess6_8TransferSyntax_1.2.840.10008.1.2.4.53",
     "CTImage.dcm_JPEGProcess6_8TransferSyntax_1.2.840.10008.1.2.4.53.dcm", "retired JPEG spectral selection (.53)"),
    ("ext-cs3d-CTImage.dcm_JPEGProcess10_12TransferSyntax_1.2.840.10008.1.2.4.55",
     "CTImage.dcm_JPEGProcess10_12TransferSyntax_1.2.840.10008.1.2.4.55.dcm", "retired JPEG full progression (.55)"),
]


def register_real(cache: Path) -> None:
    from discover import register as register_file
    base = cache / "cs3d" / "packages" / "dicomImageLoader" / "testImages"
    for cid, name, quirk in REAL:
        path = base / name
        if not path.exists():
            print(f"missing {path} (see prevalence/QUIRKS.md for the source)")
            continue
        source = {"kind": "external", "origin": "cornerstonejs/cornerstone3D dicomImageLoader testImages",
                  "url": f"https://github.com/cornerstonejs/cornerstone3D/blob/main/packages/dicomImageLoader/testImages/{name}",
                  "license": "MIT", "quirk": quirk}
        fmt = register_file(path, cid, source, {}, 10**9)
        print(f"{fmt:14} {cid}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tools", type=Path, default=Path("/media/barracuda/jpeg-modes"))
    ap.add_argument("--only")
    ap.add_argument("--tolerances", action="store_true",
                    help="after oracle.py: set the hierarchical lossy tolerances (then run oracle.py again)")
    ap.add_argument("--quirks-cache", type=Path, default=Path.home() / ".cache" / "shl-quirks")
    a = ap.parse_args()
    if a.tolerances:
        hierarchical_tolerances(a.tools)
        return
    register_real(a.quirks_cache)
    exe = build_richter(a.tools)
    for name, ts, which, enc, command in configs(exe):
        fmt, _, lossy = TRANSFER_SYNTAXES[ts]
        for sid in SEEDS[which]:
            cid = f"gen-{sid}-{name}"
            if a.only and a.only not in cid:
                continue
            arr, sds = load_seed(sid)
            cmd = command
            bits, pr = int(sds.BitsStored), int(sds.PixelRepresentation)
            if lossy and (pr or bits > 12):
                # DCT takes unsigned 8 or 12-bit samples: shift a 16-bit or signed seed into 12 bits.
                a64 = arr.astype(np.int64) - int(arr.min())
                shift = max(0, int(a64.max()).bit_length() - 12)
                arr = a64 >> shift
                bits, pr = 12, 0
                sds = sds.copy()
                sds.BitsStored, sds.HighBit, sds.PixelRepresentation = 12, 11, 0
                cmd += f" (seed minus its minimum, >> {shift}, as unsigned 12-bit)"
            dst = sample_path(fmt, cid)
            dst.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(enc, str):
                # dcmcjpeg reads and writes DICOM itself.
                with tempfile.TemporaryDirectory() as td:
                    src = Path(td) / "in.dcm"
                    sds2 = sds.copy()
                    sds2.PixelData = np.ascontiguousarray(arr.astype("<u2" if bits > 8 else "u1")).tobytes()
                    sds2.save_as(src, enforce_file_format=True)
                    subprocess.run(["dcmcjpeg"] + enc.split(":", 1)[1].split() + [str(src), str(dst)], check=True, capture_output=True)
                register(fmt, cid, dst, sid, "dcmtk", cmd, False)
                print(f"{fmt:14} {cid}")
                continue
            try:
                streams = []
                with tempfile.TemporaryDirectory(dir="/media/barracuda" if Path("/media/barracuda").exists() else None) as td:
                    for k in range(arr.shape[0]):
                        img = unsigned(arr[k], bits)
                        if lossy and bits < 8:
                            raise RuntimeError("DCT needs 8 or 12 bits")
                        dct_bits = 8 if bits <= 8 else 12
                        streams.append(enc(img if img.ndim == 3 else img[..., None], dct_bits if lossy else bits, Path(td)))
                spp = arr.shape[3]
                if spp == 1:
                    photometric = "MONOCHROME2"
                elif lossy:
                    # cjpeg subsamples colour 4:2:0 by default.
                    subsampled = "420" in name or name.startswith("turbo")
                    photometric = "YBR_FULL_422" if subsampled else "YBR_FULL"
                else:
                    photometric = "RGB"
                to_dicom(sds, streams, ts, photometric, dst)
                register(fmt, cid, dst, sid, name.split("-")[0], cmd, not lossy)
                print(f"{fmt:14} {cid}")
            except Exception as e:  # noqa: BLE001
                dst.unlink(missing_ok=True)
                msg = str(e).strip().splitlines()
                print(f"{fmt:14} {cid}  SKIPPED ({msg[-1][:100] if msg else type(e).__name__})")


if __name__ == "__main__":
    main()
