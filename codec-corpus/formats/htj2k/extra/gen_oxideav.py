"""HTJ2K cases that ojph_compress cannot write, made with the vendored oxideav-jpeg2000 encoder
(Kakadu is not available). FORMAT.md, STATUS, "Cases from the oxideav encoder", says what
each kind shows.

- `mixed`: the T.814 MIXED set: each code-block is an HT block or a Part 1 (MQ) block. Each
  block is coded both ways and keeps the HT coding unless the MQ coding is markedly smaller.
  Neither reference decoder reads MIXED, so these cases rest on the seed alone.
- `refine`: HT code-blocks with SigProp and MagRef passes (three passes per block), which
  ojph_compress never writes. OpenJPH and OpenJPEG both decode them to the seed.

The encoder is the `encode_ht` example of shl-codec-htj2k: lossless 5/3, five decomposition
levels, one layer, RPCL, RCT for colour. Signed seeds are encoded as offset-binary samples and
then the SIZ sign bits are set, as in gen_cases.py (FORMAT.md, Rulings).

Usage (from codec-corpus/):
    (cd ../codecs && CARGO_TARGET_DIR=target/htj2k cargo build --release -p shl-codec-htj2k --example encode_ht)
    uv run python formats/htj2k/extra/gen_oxideav.py
    uv run python scripts/oracle.py --format htj2k --case oxideav
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "jpeg2000" / "extra"))
from j2k_gen import CORPUS, make_case, set_siz_signed  # noqa: E402

ENCODER = CORPUS.parent / "codecs" / "target" / "htj2k" / "release" / "examples" / "encode_ht"

REV, RPCL = "1.2.840.10008.1.2.4.201", "1.2.840.10008.1.2.4.202"

CASES = [
    # (mode, seed, transfer syntax). Block counts were taken with an instrumented decoder.
    ("mixed", "pydicom-CT_small", REV),    # signed 16-bit CT; 13 HT / 3 Part 1 blocks
    ("mixed", "synth-rgb8-60x40", RPCL),   # RGB with RCT; 10 HT / 38 Part 1 blocks
    ("refine", "local-mri-slice", REV),    # real 16-bit MR; all 16 blocks have 3 passes
    ("refine", "synth-rgb8-60x40", RPCL),  # RGB with RCT; 44 of 48 blocks have 3 passes
]


def encode_ht(frame: np.ndarray, bits: int, signed: bool, args: list[str]) -> bytes:
    r, c, s = frame.shape
    v = frame.astype(np.int64) + ((1 << (bits - 1)) if signed else 0)
    with tempfile.TemporaryDirectory() as td:
        src, dst = Path(td) / "in.raw", Path(td) / "out.j2c"
        src.write_bytes(np.ascontiguousarray(v.astype("<u2" if bits > 8 else "u1")).tobytes())
        subprocess.run([str(ENCODER), args[0], str(src), str(dst), str(c), str(r), str(s), str(bits)],
                       check=True, capture_output=True, timeout=120)
        cs = dst.read_bytes()
    return set_siz_signed(cs) if signed else cs


def main() -> None:
    if not ENCODER.exists():
        sys.exit(f"build the encoder first: {ENCODER}")
    for mode, sid, ts in CASES:
        make_case("htj2k", sid, f"oxideav-rev-{mode}", ts, encode_ht, [mode])


if __name__ == "__main__":
    main()
