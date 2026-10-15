"""Write the codestreams for the JPEG 2000 / HTJ2K speed check (FORMAT.md, STATUS).

Synthetic smooth-plus-noise 16-bit frames (as scripts/generate.py's `synth`) at 512x512 and
2048x2048, each encoded lossless with opj_compress (JPEG 2000) and ojph_compress (HTJ2K),
plus 640x480 RGB frames taken from the corpus. Each file is <name>.j2c with a <name>.json
giving the FrameInfo fields.

Usage (from codec-corpus/):
    uv run python formats/jpeg2000/extra/bench_frames.py OUT_DIR
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from j2k_gen import CORPUS, ojph, opj  # noqa: E402


def synth(n: int) -> np.ndarray:
    rng = np.random.default_rng(n)
    y, x = np.mgrid[0:n, 0:n]
    base = x / (n - 1) * 0.6 + y / (n - 1) * 0.3 + ((x // 8 + y // 8) % 2) * 0.1
    img = base / base.max() * 65535 * 0.9 + rng.normal(0, 655, size=base.shape)
    return np.clip(np.rint(img), 0, 65535).astype(np.uint16)[..., None]


def main() -> None:
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)

    def write(name: str, cs: bytes, rows: int, cols: int, spp: int, ba: int, bs: int, pr: int, photometric: str):
        (out / f"{name}.j2c").write_bytes(cs)
        (out / f"{name}.json").write_text(json.dumps(dict(rows=rows, columns=cols, samples_per_pixel=spp,
                                                          bits_allocated=ba, bits_stored=bs,
                                                          pixel_representation=pr, photometric=photometric)))

    for n in (512, 2048):
        img = synth(n)
        write(f"j2k-u16-{n}", opj(img, 16, False, []), n, n, 1, 16, 16, 0, "MONOCHROME2")
        write(f"htj2k-u16-{n}", ojph(img, 16, False, ["-reversible", "true"]), n, n, 1, 16, 16, 0, "MONOCHROME2")
    for fmt, case, name, ph in [
        ("jpeg2000", "pydicom-693_J2KR", "j2k-real-s16-512", "MONOCHROME2"),
        ("jpeg2000", "pydicom-US1_J2KR", "j2k-rgb-640x480", "YBR_RCT"),
        ("htj2k", "pydicom-HTJ2KLossless_08_RGB", "htj2k-rgb-640x480", "RGB"),
    ]:
        d = CORPUS / "formats" / fmt / "frames" / case
        info = json.loads((d / "info.json").read_text())
        shutil.copyfile(d / "frame-0.bin", out / f"{name}.j2c")
        (out / f"{name}.json").write_text(json.dumps({k: info[k] for k in (
            "rows", "columns", "samples_per_pixel", "bits_allocated", "bits_stored", "pixel_representation")}
            | {"photometric": ph}))
    for p in sorted(out.glob("*.j2c")):
        print(f"{p.name:28} {p.stat().st_size:>10} bytes")


if __name__ == "__main__":
    main()
