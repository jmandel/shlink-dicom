"""Shared definitions for the codec corpus: paths, transfer syntaxes, manifests and the pixel contract."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent          # codec-corpus/
FORMATS = ROOT / "formats"
REPORTS = ROOT / "reports"

# Transfer syntax -> (format directory, short name, lossy?)
# A format directory is the unit of parallel work (see AGENTS.md).
TRANSFER_SYNTAXES: dict[str, tuple[str, str, bool]] = {
    "1.2.840.10008.1.2":        ("uncompressed", "Implicit VR Little Endian", False),
    "1.2.840.10008.1.2.1":      ("uncompressed", "Explicit VR Little Endian", False),
    "1.2.840.10008.1.2.2":      ("uncompressed", "Explicit VR Big Endian", False),
    "1.2.840.10008.1.2.1.99":   ("uncompressed", "Deflated Explicit VR Little Endian", False),
    "1.2.840.10008.1.2.1.98":   ("uncompressed", "Encapsulated Uncompressed Explicit VR Little Endian", False),
    "1.2.840.10008.1.2.8.1":    ("uncompressed", "Deflated Image Frame Compression", False),
    "1.2.840.113619.5.2":       ("uncompressed", "GE Private Implicit VR Big Endian", False),
    "1.2.840.10008.1.2.5":      ("rle", "RLE Lossless", False),
    "1.2.840.10008.1.2.4.50":   ("jpeg-dct", "JPEG Baseline (Process 1)", True),
    "1.2.840.10008.1.2.4.51":   ("jpeg-dct", "JPEG Extended (Process 2 & 4)", True),
    "1.2.840.10008.1.2.4.52":   ("jpeg-dct", "JPEG Extended, arithmetic (Process 3 & 5)", True),
    "1.2.840.10008.1.2.4.53":   ("jpeg-dct", "JPEG Spectral Selection (Process 6 & 8)", True),
    "1.2.840.10008.1.2.4.54":   ("jpeg-dct", "JPEG Spectral Selection, arithmetic (Process 7 & 9)", True),
    "1.2.840.10008.1.2.4.55":   ("jpeg-dct", "JPEG Full Progression (Process 10 & 12)", True),
    "1.2.840.10008.1.2.4.56":   ("jpeg-dct", "JPEG Full Progression, arithmetic (Process 11 & 13)", True),
    "1.2.840.10008.1.2.4.57":   ("jpeg-lossless", "JPEG Lossless (Process 14)", False),
    "1.2.840.10008.1.2.4.58":   ("jpeg-lossless", "JPEG Lossless, arithmetic (Process 15)", False),
    "1.2.840.10008.1.2.4.59":   ("jpeg-dct", "JPEG Extended Hierarchical (Process 16 & 18)", True),
    "1.2.840.10008.1.2.4.60":   ("jpeg-dct", "JPEG Extended Hierarchical, arithmetic (Process 17 & 19)", True),
    "1.2.840.10008.1.2.4.61":   ("jpeg-dct", "JPEG Spectral Selection Hierarchical (Process 20 & 22)", True),
    "1.2.840.10008.1.2.4.62":   ("jpeg-dct", "JPEG Spectral Selection Hierarchical, arithmetic (Process 21 & 23)", True),
    "1.2.840.10008.1.2.4.63":   ("jpeg-dct", "JPEG Full Progression Hierarchical (Process 24 & 26)", True),
    "1.2.840.10008.1.2.4.64":   ("jpeg-dct", "JPEG Full Progression Hierarchical, arithmetic (Process 25 & 27)", True),
    "1.2.840.10008.1.2.4.65":   ("jpeg-lossless", "JPEG Lossless Hierarchical (Process 28)", False),
    "1.2.840.10008.1.2.4.66":   ("jpeg-lossless", "JPEG Lossless Hierarchical, arithmetic (Process 29)", False),
    "1.2.840.10008.1.2.4.70":   ("jpeg-lossless", "JPEG Lossless (Process 14, SV1)", False),
    "1.2.840.10008.1.2.4.80":   ("jpeg-ls", "JPEG-LS Lossless", False),
    "1.2.840.10008.1.2.4.81":   ("jpeg-ls", "JPEG-LS Near-Lossless", True),
    "1.2.840.10008.1.2.4.90":   ("jpeg2000", "JPEG 2000 Lossless", False),
    "1.2.840.10008.1.2.4.91":   ("jpeg2000", "JPEG 2000", True),
    "1.2.840.10008.1.2.4.92":   ("jpeg2000", "JPEG 2000 Part 2 Multi-component Lossless", False),
    "1.2.840.10008.1.2.4.93":   ("jpeg2000", "JPEG 2000 Part 2 Multi-component", True),
    "1.2.840.10008.1.2.4.110":  ("jpeg-xl", "JPEG XL Lossless", False),
    "1.2.840.10008.1.2.4.111":  ("jpeg-xl", "JPEG XL JPEG Recompression", True),
    "1.2.840.10008.1.2.4.112":  ("jpeg-xl", "JPEG XL", True),
    "1.2.840.10008.1.2.4.201":  ("htj2k", "HTJ2K Lossless", False),
    "1.2.840.10008.1.2.4.202":  ("htj2k", "HTJ2K Lossless RPCL", False),
    "1.2.840.10008.1.2.4.203":  ("htj2k", "HTJ2K", True),
}

FORMAT_NAMES = sorted({v[0] for v in TRANSFER_SYNTAXES.values()})


def format_dir(fmt: str) -> Path:
    return FORMATS / fmt


def sha256_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def load_cases(fmt: str) -> list[dict]:
    p = format_dir(fmt) / "cases.json"
    if not p.exists():
        return []
    return json.loads(p.read_text())["cases"]


def save_cases(fmt: str, cases: list[dict]) -> None:
    """Merge `cases` into formats/<fmt>/cases.json by id, under an exclusive lock.

    Several agents may add cases to the same format at once, so this never replaces the
    file wholesale: entries passed in are inserted or updated, and every other entry is kept.
    """
    import fcntl
    p = format_dir(fmt) / "cases.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p.with_suffix(".lock"), "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        current = {c["id"]: c for c in (json.loads(p.read_text())["cases"] if p.exists() else [])}
        for c in cases:
            current[c["id"]] = c
        merged = sorted(current.values(), key=lambda c: c["id"])
        tmp = p.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"format": fmt, "cases": merged}, indent=2) + "\n")
        tmp.replace(p)


def sample_path(fmt: str, case_id: str) -> Path:
    return format_dir(fmt) / "samples" / f"{case_id}.dcm"


def oracle_paths(fmt: str, case_id: str) -> tuple[Path, Path]:
    d = format_dir(fmt) / "oracle"
    return d / f"{case_id}.npy", d / f"{case_id}.json"


# ---------------------------------------------------------------------------
# Pixel contract (see CONTRACT.md). Every decoder, reference or candidate, is
# compared on this canonical form:
#   shape  (frames, rows, columns, samples_per_pixel)
#   dtype  unsigned/signed integer of Bits Allocated width (8/16/32), as stored;
#          float32/float64 for Float/Double Float Pixel Data;
#          no Modality LUT, no rescale, no windowing
#   colour YBR_* photometric interpretations converted to RGB; palette colour left as indices
#   bytes  little-endian, C order
# ---------------------------------------------------------------------------

def canonical(arr: np.ndarray, frames: int, rows: int, cols: int, spp: int) -> np.ndarray:
    a = np.asarray(arr)
    a = a.reshape(frames, rows, cols, spp)
    return np.ascontiguousarray(a.astype(a.dtype.newbyteorder("<")))


def expected_dtype(bits_allocated: int, pixel_representation: int, float_pixels: bool = False) -> np.dtype:
    if float_pixels:
        size = {32: 4, 64: 8}.get(bits_allocated)
        if size is None:
            raise ValueError(f"float pixel data with Bits Allocated {bits_allocated}")
        return np.dtype(f"<f{size}")
    kind = "i" if pixel_representation == 1 else "u"
    size = {1: 1, 8: 1, 16: 2, 32: 4}.get(bits_allocated)
    if size is None:
        raise ValueError(f"unsupported Bits Allocated {bits_allocated}")
    return np.dtype(f"<{kind}{size}")


def abs_diff(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Per-sample |a - b|. Integers as int64. Floats as float64, where two NaNs (or two equal
    infinities) count as equal and NaN against a number counts as an infinite difference."""
    if a.dtype.kind == "f" or b.dtype.kind == "f":
        x, y = a.astype(np.float64), b.astype(np.float64)
        same = (x == y) | (np.isnan(x) & np.isnan(y))
        with np.errstate(invalid="ignore"):
            d = np.where(same, 0.0, np.abs(x - y))
        return np.where(np.isnan(d), np.inf, d)
    return np.abs(a.astype(np.int64) - b.astype(np.int64))


def compare(candidate: np.ndarray, oracle: np.ndarray, max_abs: float) -> dict:
    """Max and mean |diff| and the count of differing samples, in chunks of 4M samples so that
    memory stays near the size of the two arrays (they may be memory-mapped)."""
    if candidate.shape != oracle.shape:
        return {"ok": False, "reason": f"shape {candidate.shape} != {oracle.shape}"}
    a, b = candidate.reshape(-1), oracle.reshape(-1)
    mx, total, differing = 0, 0.0, 0
    step = 1 << 22
    for i in range(0, a.size, step):
        d = abs_diff(a[i:i + step], b[i:i + step])
        if d.size:
            m = float(d.max()) if d.dtype.kind == "f" else int(d.max())
            mx = max(mx, m)
            total += float(d.sum())
            differing += int((d > 0).sum())
    out = {
        "max_abs_diff": mx,
        "mean_abs_diff": total / a.size if a.size else 0.0,
        "pixels_differing": differing,
    }
    out["ok"] = mx <= max_abs
    if not out["ok"]:
        out["reason"] = f"max |diff| {mx} > allowed {max_abs}"
    return out


def remove_cases(fmt: str, ids: set[str]) -> None:
    """Delete cases (and their samples/oracles) from a format, under the same lock as save_cases."""
    import fcntl
    p = format_dir(fmt) / "cases.json"
    with open(p.with_suffix(".lock"), "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        cur = json.loads(p.read_text())["cases"]
        kept = [c for c in cur if c["id"] not in ids]
        tmp = p.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"format": fmt, "cases": kept}, indent=2) + "\n")
        tmp.replace(p)
    for cid in ids:
        sample_path(fmt, cid).unlink(missing_ok=True)
        for q in oracle_paths(fmt, cid):
            q.unlink(missing_ok=True)
