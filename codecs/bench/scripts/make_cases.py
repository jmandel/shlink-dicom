"""Generate the large synthetic benchmark images as normal codec-corpus cases.

Each seed below is a deterministic, modality-like image. It is written to codec-corpus/seeds/,
encoded with the corpus encoders (generate.py: pydicom/CharLS/OpenJPEG, DCMTK, OpenJPH), and
registered with generate.register() as `gen-<seed>-<encoder>` in that format's cases.json. The
oracle is then built with oracle.build(), so these cases are correctness-checked by check.py
like any other case. Only the cases made here are written back to cases.json.

Usage (from the repository root):
    uv run --project codec-corpus python codecs/bench/scripts/make_cases.py [--only SEED_SUBSTR]
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import numpy as np

CORPUS = Path(__file__).resolve().parents[3] / "codec-corpus"
sys.path.insert(0, str(CORPUS / "scripts"))
import generate  # noqa: E402
import oracle  # noqa: E402
from common import ROOT, TRANSFER_SYNTAXES, canonical, load_cases, oracle_paths, sample_path, save_cases  # noqa: E402


def smooth(a: np.ndarray, k: int) -> np.ndarray:
    """Cheap separable box blur (k passes approximate a Gaussian)."""
    for _ in range(2):
        for ax in (0, 1):
            c = np.cumsum(np.pad(a, [(k, k) if i == ax else (0, 0) for i in range(a.ndim)], mode="edge"), axis=ax)
            hi = np.take(c, range(2 * k, c.shape[ax]), axis=ax)
            lo = np.take(c, range(0, c.shape[ax] - 2 * k), axis=ax)
            a = (hi - lo) / (2 * k)
    return a


def ellipse(y, x, cy, cx, ry, rx):
    return ((y - cy) / ry) ** 2 + ((x - cx) / rx) ** 2 <= 1


def ct_like(rows=512, cols=512) -> np.ndarray:
    """Axial chest CT: air, body, lungs, spine and ribs; stored value = HU + 1024 (0..4095)."""
    rng = np.random.default_rng(512)
    y, x = np.mgrid[0:rows, 0:cols].astype(np.float64)
    img = np.zeros((rows, cols))
    body = ellipse(y, x, rows * 0.52, cols * 0.5, rows * 0.36, cols * 0.44)
    img[body] = 1024 + 40
    fat = body & ~ellipse(y, x, rows * 0.52, cols * 0.5, rows * 0.33, cols * 0.41)
    img[fat] = 1024 - 90
    for cx in (0.33, 0.67):
        img[ellipse(y, x, rows * 0.48, cols * cx, rows * 0.22, cols * 0.13)] = 1024 - 850
    img[ellipse(y, x, rows * 0.45, cols * 0.5, rows * 0.08, cols * 0.07)] = 1024 + 45   # heart
    img[ellipse(y, x, rows * 0.78, cols * 0.5, rows * 0.05, cols * 0.04)] = 1024 + 900  # vertebra
    ang = np.arctan2(y - rows * 0.52, x - cols * 0.5)
    rib_ring = ellipse(y, x, rows * 0.52, cols * 0.5, rows * 0.32, cols * 0.40) & ~ellipse(
        y, x, rows * 0.52, cols * 0.5, rows * 0.30, cols * 0.38)
    img[rib_ring & (np.sin(ang * 9) > 0.55)] = 1024 + 700
    img[(y > rows * 0.9) & (y < rows * 0.92) & (np.abs(x - cols / 2) < cols * 0.45)] = 1024 + 200  # table
    img = smooth(img, 1) + rng.normal(0, 12, img.shape) * body
    vessels = smooth(rng.normal(0, 1, img.shape), 3) > 0.35
    img[vessels & (img < 600) & (img > 50)] += 700
    return np.clip(np.rint(img), 0, 4095).astype(np.uint16)[None]


def dx_like(rows=2048, cols=2048) -> np.ndarray:
    """Chest radiograph, 12-bit: collimation, soft-tissue gradient, lungs, ribs, quantum noise."""
    rng = np.random.default_rng(2048)
    y, x = np.mgrid[0:rows, 0:cols].astype(np.float32) / max(rows, cols)
    img = 3300 - 900 * np.exp(-(((x - 0.5) / 0.32) ** 2)) * np.exp(-(((y - 0.55) / 0.5) ** 2))
    for cx in (0.33, 0.67):
        lung = np.exp(-(((x - cx) / 0.13) ** 2 + ((y - 0.45) / 0.25) ** 4))
        img -= 1300 * lung
    for k in range(10):
        arc = np.abs(y - (0.22 + k * 0.06) - 0.08 * np.cos((x - 0.5) * 6)) < 0.008
        img += 220 * arc * (np.abs(x - 0.5) > 0.04)
    img = smooth(img.astype(np.float64), 4)
    img += rng.normal(0, 1, img.shape) * np.sqrt(np.maximum(img, 1)) * 0.25
    img[(x < 0.04) | (x > 0.96) | (y < 0.03)] = 4000  # collimator edge
    return np.clip(np.rint(img), 0, 4095).astype(np.uint16)[None]


def cine_like(rows=480, cols=640, frames=30) -> np.ndarray:
    """Echo-like RGB cine: speckled sector, moving bright wall, colour-flow blob, text overlay."""
    rng = np.random.default_rng(30)
    y, x = np.mgrid[0:rows, 0:cols].astype(np.float64)
    r = np.hypot(y - 20, x - cols / 2)
    th = np.arctan2(x - cols / 2, y - 20)
    sector = (r < rows * 0.95) & (np.abs(th) < 0.75)
    speckle = smooth(rng.rayleigh(1.0, (rows, cols)), 1)
    out = np.zeros((frames, rows, cols, 3), np.uint8)
    for f in range(frames):
        ph = 2 * np.pi * f / frames
        wall = np.exp(-(((r - (220 + 25 * np.sin(ph))) / 14) ** 2))
        gray = (40 * speckle + 170 * wall * speckle) * sector * (1 - r / (rows * 1.3))
        g = np.clip(gray, 0, 255)
        rgb = np.stack([g, g, g], -1)
        blob = ellipse(y, x, 260 + 30 * np.sin(ph), cols / 2 + 20, 45, 30) & sector
        rgb[blob] = [200 * (0.5 + 0.5 * np.sin(ph)), 40, 200 * (0.5 - 0.5 * np.sin(ph))]
        rgb[8:24, 10:200] = 230 * ((x[8:24, 10:200] // 6 + f) % 3 == 0)[..., None]  # text-like overlay
        out[f] = np.clip(np.rint(rgb), 0, 255)
    return out


def photo_like(rows=2048, cols=2048) -> np.ndarray:
    """Colour pathology-like tile: pink stroma texture with purple nuclei."""
    rng = np.random.default_rng(4096)
    tex = smooth(rng.normal(0, 1, (rows, cols)), 6)
    tex = (tex - tex.min()) / (tex.max() - tex.min())
    rgb = np.stack([235 - 40 * tex, 170 - 70 * tex, 200 - 40 * tex], -1)
    nuclei = smooth((rng.random((rows, cols)) < 0.0015).astype(np.float64), 4) > 0.03
    rgb[nuclei] = [110, 70, 160]
    rgb += rng.normal(0, 3, rgb.shape)
    return np.clip(np.rint(rgb), 0, 255).astype(np.uint8)[None]


# seed id -> (generator, bits stored, photometric, encoders to use)
SEEDS = {
    "bench-ct512-u16": (ct_like, 16, "MONOCHROME2",
                        ["pydicom-rle", "charls-ls", "openjpeg-rev", "openjpeg-cr20", "ijg-lossless-sv1", "openjph-rev"]),
    "bench-dx2048-u12": (dx_like, 12, "MONOCHROME2",
                         ["pydicom-rle", "charls-ls", "charls-nl3", "openjpeg-rev", "openjpeg-cr20", "ijg-extended",
                          "ijg-lossless-sv1", "openjph-rev", "openjph-q"]),
    "bench-cine-rgb8-640x480x30": (cine_like, 8, "RGB",
                                   ["pydicom-rle", "charls-ls", "openjpeg-rev", "ijg-baseline", "openjph-rev"]),
    "bench-photo-rgb8-2048": (photo_like, 8, "RGB", ["ijg-baseline", "openjpeg-cr20", "openjph-q"]),
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    a = ap.parse_args()
    seeds_dir = ROOT / "seeds"
    for sid, (gen, bits, photometric, wanted) in SEEDS.items():
        if a.only and a.only not in sid:
            continue
        arr = gen()
        spp = arr.shape[3] if arr.ndim == 4 else 1
        src = seeds_dir / f"{sid}.dcm"
        generate.make_dataset(arr, bits, 0, photometric).save_as(src, enforce_file_format=True)
        np.save(seeds_dir / f"{sid}.npy", canonical(arr, arr.shape[0], arr.shape[1], arr.shape[2], spp))
        made: list[tuple[str, str]] = []
        dst = sample_path("uncompressed", f"gen-{sid}")
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
        generate.register("uncompressed", f"gen-{sid}", dst, sid, "none", True)
        made.append(("uncompressed", f"gen-{sid}"))
        for enc, ts, fn in generate.encoders(bits, False, spp):
            if enc not in wanted:
                continue
            fmt, _, lossy = TRANSFER_SYNTAXES[ts]
            cid = f"gen-{sid}-{enc}"
            dst = sample_path(fmt, cid)
            dst.parent.mkdir(parents=True, exist_ok=True)
            try:
                fn(src, dst)
                generate.register(fmt, cid, dst, sid, enc, not lossy)
                made.append((fmt, cid))
                print(f"{fmt:14} {cid}  {dst.stat().st_size / 1e6:.2f} MB")
            except Exception as e:  # noqa: BLE001
                dst.unlink(missing_ok=True)
                print(f"{fmt:14} {cid}  SKIPPED ({str(e).strip().splitlines()[-1][:90] if str(e).strip() else type(e).__name__})")
        # Oracle for just these cases (oracle.py's main would rewrite every case of the format).
        for fmt, cid in made:
            case = next(c for c in load_cases(fmt) if c["id"] == cid)
            rec = oracle.build(fmt, case)
            npy, js = oracle_paths(fmt, cid)
            npy.parent.mkdir(parents=True, exist_ok=True)
            arr_o = rec.pop("_array", None)
            if arr_o is not None:
                np.save(npy, arr_o)
            js.write_text(json.dumps(rec, indent=2) + "\n")
            for k in ("expect", "max_abs", "oracle_sha256", "confidence", "disputed"):
                if k in rec:
                    case[k] = rec[k]
            save_cases(fmt, [case])
            print(f"oracle {fmt:14} {cid:50} {rec['expect']} max_abs={rec['max_abs']}{' DISPUTED' if rec.get('disputed') else ''}")


if __name__ == "__main__":
    main()
