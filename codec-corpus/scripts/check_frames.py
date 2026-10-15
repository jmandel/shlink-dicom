"""Check a candidate's frame-range decode (`--frames A-B`) against its own whole-file decode.

For every multi-frame corpus case the candidate decodes, one range of frames (chosen per case,
reproducibly) is decoded alone and must equal the same bytes of the whole decode. With --file,
any file is checked frame by frame in chunks instead, without a whole decode, which is how large
slides are checked: each chunk's output must have the size of its frames.

    uv run python scripts/check_frames.py --candidate ../codecs/target/coord/release/shl-dicom-decode
    uv run python scripts/check_frames.py --candidate ... --file BIG.dcm --frames 70035 --chunk 256
"""

from __future__ import annotations

import argparse
import json
import random
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import FORMAT_NAMES, load_cases, sample_path  # noqa: E402


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, timeout=600)


def corpus(cand: str, td: Path, case_filter: str | None) -> int:
    n = bad = 0
    full_out, part_out = td / "full.raw", td / "part.raw"
    for fmt in FORMAT_NAMES:
        for c in load_cases(fmt):
            if c.get("expect") != "decode" or c.get("frames", 1) < 2 or (case_filter and case_filter not in c["id"]):
                continue
            src = sample_path(fmt, c["id"])
            if not src.exists() or run([cand, str(src), str(full_out)]).returncode:
                continue
            full = full_out.read_bytes()
            f = c["frames"]
            fb = len(full) // f
            rnd = random.Random(c["id"])
            a = rnd.randrange(f)
            b = rnd.randrange(a, f)
            p = run([cand, "--frames", f"{a}-{b}", str(src), str(part_out)])
            n += 1
            if p.returncode or part_out.read_bytes() != full[a * fb:(b + 1) * fb]:
                bad += 1
                print(f"MISMATCH {fmt}/{c['id']} frames {a}-{b}: exit {p.returncode} {p.stderr.decode()[-200:]}")
    print(f"{n} multi-frame cases, {bad} mismatches")
    return 1 if bad else 0


def chunked(cand: str, td: Path, path: Path, frames: int, chunk: int) -> int:
    out = td / "chunk.raw"
    size = None
    for a in range(0, frames, chunk):
        b = min(frames, a + chunk) - 1
        p = run([cand, "--frames", f"{a}-{b}", str(path), str(out)])
        if p.returncode:
            print(f"frames {a}-{b}: exit {p.returncode} {p.stderr.decode()[-200:]}")
            return 1
        per, rem = divmod(out.stat().st_size, b - a + 1)
        if rem or (size is not None and per != size):
            print(f"frames {a}-{b}: {out.stat().st_size} bytes is not {b - a + 1} frames of {size}")
            return 1
        size = per
    print(f"{frames} frames decoded in chunks of {chunk}, {size} bytes each")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidate", required=True, help="path of shl-dicom-decode")
    ap.add_argument("--case")
    ap.add_argument("--file", type=Path)
    ap.add_argument("--frames", type=int, help="Number of Frames of --file")
    ap.add_argument("--chunk", type=int, default=256)
    a = ap.parse_args()
    with tempfile.TemporaryDirectory() as td:   # set TMPDIR to keep large outputs off a RAM /tmp
        if a.file:
            return chunked(a.candidate, Path(td), a.file, a.frames, a.chunk)
        return corpus(a.candidate, Path(td), a.case)


if __name__ == "__main__":
    sys.exit(main())
