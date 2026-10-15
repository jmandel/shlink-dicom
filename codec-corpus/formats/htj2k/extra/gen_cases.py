"""Extra HTJ2K cases for what the base corpus lacks (SURVEY.md, "Corpus gaps found"): signed
input (12- and 16-bit, lossless and lossy), progression orders other than RPCL under .201
and .203, multiple tiles, tile-parts, small code-blocks and explicit precincts, and a real
16-bit MR slice.

Encoder: ojph_compress from raw samples (helpers in ../../jpeg2000/extra/j2k_gen.py), so
signed seeds work. .202 cases keep RPCL, as that transfer syntax requires. Lossless cases
take the seed as ground truth; lossy ones get their oracle from the reference decoders.

Usage (from codec-corpus/):
    uv run python formats/htj2k/extra/gen_cases.py
    uv run python scripts/oracle.py --format htj2k
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "jpeg2000" / "extra"))
from j2k_gen import make_case, ojph  # noqa: E402

REV, RPCL, LOSSY = "1.2.840.10008.1.2.4.201", "1.2.840.10008.1.2.4.202", "1.2.840.10008.1.2.4.203"
R = ["-reversible", "true"]

CASES = [
    # (seed, encoder label, transfer syntax, ojph_compress args, photometric override)
    ("synth-s16-64x64", "ojph-rev-signed", REV, R, None),
    ("synth-s12-40x40", "ojph-rev-signed-lrcp", REV, R + ["-prog_order", "LRCP"], None),
    ("pydicom-CT_small", "ojph-rev-rpcl-signed", RPCL, R + ["-prog_order", "RPCL"], None),
    ("synth-s16-64x64", "ojph-q-signed-cprl", LOSSY, ["-qstep", "0.005", "-prog_order", "CPRL"], None),
    ("synth-s12-40x40", "ojph-q-signed-tiles", LOSSY, ["-qstep", "0.01", "-tile_size", "{16,16}", "-num_decomps", "3"], None),
    ("synth-u16-128x96", "ojph-rev-tiles-lrcp", REV, R + ["-tile_size", "{64,48}", "-prog_order", "LRCP"], None),
    ("synth-u16-128x96", "ojph-rev-rpcl-tiles-tp", RPCL,
     R + ["-prog_order", "RPCL", "-tile_size", "{32,32}", "-tileparts", "R", "-tlm_marker", "true"], None),
    ("synth-u12-65x31", "ojph-rev-pcrl-cb16", REV, R + ["-prog_order", "PCRL", "-block_size", "{16,16}"], None),
    ("synth-rgb8-60x40", "ojph-q-cprl-tiles-prec", LOSSY,
     ["-qstep", "0.01", "-prog_order", "CPRL", "-tile_size", "{32,32}", "-num_decomps", "3",
      "-block_size", "{16,16}", "-precincts", "{32,32},{16,16}"], None),
    ("local-mri-slice", "ojph-rev-rpcl-tiles", RPCL, R + ["-prog_order", "RPCL", "-tile_size", "{64,64}"], None),
    ("synth-u16-3frame-32x32", "ojph-q-rlcp-tiles", LOSSY,
     ["-qstep", "0.005", "-prog_order", "RLCP", "-tile_size", "{16,16}", "-num_decomps", "2"], None),
]


def main() -> None:
    for sid, enc, ts, args, photometric in CASES:
        make_case("htj2k", sid, enc, ts, ojph, args, photometric)


if __name__ == "__main__":
    main()
