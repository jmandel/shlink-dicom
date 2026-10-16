"""HTJ2K cases that ojph_compress cannot write. The codestreams were made with the
oxideav-jpeg2000 0.0.17 encoder (lossless 5/3, five decomposition levels, one layer, RPCL, RCT
for colour; Kakadu is not available) and are stored in extra/oxideav/, so the cases rebuild
without it. FORMAT.md, STATUS, "Cases from the oxideav encoder", says what each kind shows.

- `mixed`: the T.814 MIXED set: each code-block is an HT block or a Part 1 (MQ) block. Each
  block was coded both ways, keeping the HT coding unless the MQ coding was markedly smaller.
  Neither reference decoder reads MIXED, so these cases rest on the seed alone.
- `refine`: HT code-blocks with SigProp and MagRef passes (three passes per block), which
  ojph_compress never writes. OpenJPEG decodes them to the seed.

Signed seeds were encoded as offset-binary samples with the SIZ sign bits then set, as in
gen_cases.py (FORMAT.md, Rulings); the stored codestreams already carry the sign bits.

Usage (from codec-corpus/):
    uv run python formats/htj2k/extra/gen_oxideav.py
    uv run python scripts/oracle.py --format htj2k --case oxideav
"""

from __future__ import annotations

import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "jpeg2000" / "extra"))
from j2k_gen import make_case  # noqa: E402

STORED = Path(__file__).resolve().parent / "oxideav"

REV, RPCL = "1.2.840.10008.1.2.4.201", "1.2.840.10008.1.2.4.202"

CASES = [
    # (mode, seed, transfer syntax). Block counts were taken with an instrumented decoder.
    ("mixed", "pydicom-CT_small", REV),    # signed 16-bit CT; 13 HT / 3 Part 1 blocks
    ("mixed", "synth-rgb8-60x40", RPCL),   # RGB with RCT; 10 HT / 38 Part 1 blocks
    ("refine", "pydicom-MR_small", REV),   # signed 16-bit MR; all 16 blocks have 3 passes
    ("refine", "synth-rgb8-60x40", RPCL),  # RGB with RCT; 44 of 48 blocks have 3 passes
]


def stored(sid: str, mode: str):
    cs = (STORED / f"gen-{sid}-oxideav-rev-{mode}.j2c").read_bytes()
    return lambda frame, bits, signed, args: cs


def main() -> None:
    for mode, sid, ts in CASES:
        make_case("htj2k", sid, f"oxideav-rev-{mode}", ts, stored(sid, mode), [mode])


if __name__ == "__main__":
    main()
