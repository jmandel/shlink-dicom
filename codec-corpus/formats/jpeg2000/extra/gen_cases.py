"""Extra JPEG 2000 cases for coding options the base corpus lacks (SURVEY.md, "Corpus gaps found"):
progression orders RPCL/PCRL/CPRL, explicit precincts, code-block style flags, small
code-blocks, multiple tiles (with image and tile offsets, tile-parts and PLT), SOP/EPH
markers, several quality layers, one and many resolution levels, and RGB without MCT.

Encoder: opj_compress from raw samples, so signed seeds work. Lossless cases take the seed
as ground truth; lossy ones get their oracle from the reference decoders.

Usage (from codec-corpus/):
    uv run python formats/jpeg2000/extra/gen_cases.py
    uv run python scripts/oracle.py --format jpeg2000
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from j2k_gen import make_case, opj  # noqa: E402

REV, LOSSY = "1.2.840.10008.1.2.4.90", "1.2.840.10008.1.2.4.91"

CASES = [
    # (seed, encoder label, transfer syntax, opj_compress args, photometric override)
    ("synth-u16-128x96", "opj-rpcl", REV, ["-p", "RPCL"], None),
    ("synth-u16-128x96", "opj-pcrl-prec-cb16", REV, ["-p", "PCRL", "-c", "[32,32],[32,32],[16,16]", "-b", "16,16"], None),
    ("synth-rgb8-60x40", "opj-cprl-tiles", REV, ["-p", "CPRL", "-t", "32,16", "-n", "4"], "YBR_RCT"),
    ("synth-rgb8-60x40", "opj-nomct", REV, ["-mct", "0", "-p", "RLCP"], "RGB"),
    ("pydicom-CT_small", "opj-cbstyle63", REV, ["-M", "63"], None),
    ("synth-s12-40x40", "opj-bypass-vcausal-tiles-offset", REV,
     ["-M", "9", "-t", "16,16", "-d", "5,3", "-T", "2,1", "-n", "3"], None),
    ("synth-s16-64x64", "opj-reset-termall-pterm", REV, ["-M", "22", "-b", "32,8", "-p", "RLCP"], None),
    ("synth-u16-3frame-32x32", "opj-tiles-sop-eph", REV, ["-t", "16,16", "-n", "4", "-SOP", "-EPH"], None),
    ("synth-u12-65x31", "opj-tiles-tp-plt", REV, ["-t", "32,16", "-n", "5", "-TP", "R", "-PLT", "-p", "RPCL"], None),
    ("synth-u8-64x48", "opj-n1", REV, ["-n", "1"], None),
    ("local-mri-slice", "opj-n8-cb4x4", REV, ["-n", "8", "-b", "4,4"], None),
    ("pydicom-MR_small", "opj-layers-rlcp", LOSSY, ["-r", "40,20,10", "-p", "RLCP"], None),
    ("synth-u16-128x96", "opj-97-tiles-prec-pcrl", LOSSY,
     ["-I", "-r", "10", "-t", "64,48", "-c", "[64,64],[32,32]", "-p", "PCRL"], None),
    ("synth-rgb8-60x40", "opj-97-ict-cprl-cbstyle", LOSSY, ["-I", "-r", "8", "-p", "CPRL", "-M", "41"], "YBR_ICT"),
    ("synth-s16-64x64", "opj-97-layers-tiles", LOSSY, ["-I", "-r", "30,10", "-t", "32,32", "-n", "5", "-TP", "L"], None),
]


def main() -> None:
    for sid, enc, ts, args, photometric in CASES:
        make_case("jpeg2000", sid, enc, ts, opj, args, photometric)


if __name__ == "__main__":
    main()
