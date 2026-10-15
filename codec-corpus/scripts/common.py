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
    "1.2.840.10008.1.2.5":      ("rle", "RLE Lossless", False),
    "1.2.840.10008.1.2.4.50":   ("jpeg-dct", "JPEG Baseline (Process 1)", True),
    "1.2.840.10008.1.2.4.51":   ("jpeg-dct", "JPEG Extended (Process 2 & 4)", True),
    "1.2.840.10008.1.2.4.57":   ("jpeg-lossless", "JPEG Lossless (Process 14)", False),
    "1.2.840.10008.1.2.4.70":   ("jpeg-lossless", "JPEG Lossless (Process 14, SV1)", False),
    "1.2.840.10008.1.2.4.80":   ("jpeg-ls", "JPEG-LS Lossless", False),
    "1.2.840.10008.1.2.4.81":   ("jpeg-ls", "JPEG-LS Near-Lossless", True),
    "1.2.840.10008.1.2.4.90":   ("jpeg2000", "JPEG 2000 Lossless", False),
    "1.2.840.10008.1.2.4.91":   ("jpeg2000", "JPEG 2000", True),
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
#          no Modality LUT, no rescale, no windowing
#   colour YBR_* photometric interpretations converted to RGB; palette colour left as indices
#   bytes  little-endian, C order
# ---------------------------------------------------------------------------

def canonical(arr: np.ndarray, frames: int, rows: int, cols: int, spp: int) -> np.ndarray:
    a = np.asarray(arr)
    a = a.reshape(frames, rows, cols, spp)
    return np.ascontiguousarray(a.astype(a.dtype.newbyteorder("<")))


def expected_dtype(bits_allocated: int, pixel_representation: int) -> np.dtype:
    kind = "i" if pixel_representation == 1 else "u"
    size = {1: 1, 8: 1, 16: 2, 32: 4}.get(bits_allocated)
    if size is None:
        raise ValueError(f"unsupported Bits Allocated {bits_allocated}")
    return np.dtype(f"<{kind}{size}")


def compare(candidate: np.ndarray, oracle: np.ndarray, max_abs: int) -> dict:
    if candidate.shape != oracle.shape:
        return {"ok": False, "reason": f"shape {candidate.shape} != {oracle.shape}"}
    diff = np.abs(candidate.astype(np.int64) - oracle.astype(np.int64))
    mx = int(diff.max()) if diff.size else 0
    out = {
        "max_abs_diff": mx,
        "mean_abs_diff": float(diff.mean()) if diff.size else 0.0,
        "pixels_differing": int((diff > 0).sum()),
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
