"""Check shl-codec-jpeg's decode_frame_scaled on every jpeg-dct (and jpeg-lossless) frame.

For each case and each scale 1/2, 1/4, 1/8:
  * oracle: libjpeg-turbo's own scaled decode (turbo_scaled.c, built here against the system
    libjpeg-turbo >= 3.0, which also decodes 12-bit), compared sample for sample;
  * block average (the stated check for 12-bit, where no other scaled reference exists in common
    tools): our full decode averaged over each 2^s x 2^s block. libjpeg's reduced IDCTs are the
    exact block average of the 8x8 transform before rounding and range limiting, so on complete
    blocks with no sample clamped to 0 or the maximum the difference must be <= 1 (enforced for
    1-component cases). Clamped blocks (the full decode clipped overshoot the scaled one keeps
    out of the average) and partial edge blocks (which average the encoder's padding) are only
    reported.
Lossless and hierarchical frames must return Unsupported (exit 3).

Run from codec-corpus after extract_frames.py --format jpeg-dct / jpeg-lossless:
    uv run python formats/jpeg-dct/scaled/check_scaled.py [--case SUBSTRING]
Exits 1 if any oracle comparison differs by more than --tol (default 0).
"""
import argparse, json, os, subprocess, sys, tempfile
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
CORPUS = HERE.parents[2]
CODECS = CORPUS.parent / "codecs"
TARGET = Path(os.environ.get("CARGO_TARGET_DIR", CODECS / "target" / "scaled"))


def build(tmp):
    subprocess.run(["cc", "-O2", "-o", f"{tmp}/turbo_scaled", str(HERE / "turbo_scaled.c"), "-ljpeg"], check=True)
    subprocess.run(["cargo", "build", "-q", "--release", "-p", "shl-codec-jpeg", "--example", "scaled_dump"],
                   cwd=CODECS, check=True, env={**os.environ, "CARGO_TARGET_DIR": str(TARGET)})
    return f"{tmp}/turbo_scaled", str(TARGET / "release" / "examples" / "scaled_dump")


def ours(dump, case_dir, s, tmp):
    out = f"{tmp}/ours.raw"
    p = subprocess.run([dump, str(case_dir), str(s), out], capture_output=True, text=True)
    if p.returncode != 0:
        return p.returncode, p.stdout.strip()
    w, h, bps, spp = map(int, p.stdout.split())
    a = np.fromfile(out, dtype=np.uint8 if bps == 1 else (np.uint16 if bps == 2 else np.uint32))
    return 0, a.reshape(-1, h, w, spp).astype(np.int64)


def block_mean(full, s, maxval):
    """Block means of the full decode, and a mask of complete blocks with no clamped sample."""
    f, h, w, c = full.shape
    n = 1 << s
    hh, ww = -(-h // n), -(-w // n)
    pad = np.zeros((f, hh * n, ww * n, c))
    cnt = np.zeros((1, hh * n, ww * n, 1))
    pad[:, :h, :w] = full
    cnt[:, :h, :w] = 1
    blocks = pad.reshape(f, hh, n, ww, n, c)
    sums = blocks.sum(axis=(2, 4))
    cnts = cnt.reshape(1, hh, n, ww, n, 1).sum(axis=(2, 4))
    clean = ~((blocks == 0) | (blocks == maxval)).any(axis=(2, 4))
    clean[:, h // n:] = False
    clean[:, :, w // n:] = False
    return sums / cnts, clean


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", default="")
    ap.add_argument("--tol", type=int, default=0)
    args = ap.parse_args()
    bad = 0
    with tempfile.TemporaryDirectory() as tmp:
        turbo, dump = build(tmp)
        for fmt in ["jpeg-dct", "jpeg-lossless"]:
            for case_dir in sorted((CORPUS / "formats" / fmt / "frames").iterdir()):
                if args.case not in case_dir.name or not (case_dir / "info.json").exists():
                    continue
                info = json.loads((case_dir / "info.json").read_text())
                if info["expect"] != "decode":
                    continue
                if not all((case_dir / f"frame-{k}.bin").exists() for k in range(info["frames"])):
                    # Frames extract_frames.py could not split (the DICOM layer's job); the Rust
                    # corpus test skips these too.
                    print(f"{case_dir.name}: skipped, frames missing")
                    continue
                ycc = "1" if info["photometric"].startswith("YBR") else "0"
                rc, full = ours(dump, case_dir, 0, tmp)
                if rc != 0:
                    print(f"{case_dir.name}: full decode failed: {full}")
                    bad += 1
                    continue
                for s in (1, 2, 3):
                    rc, got = ours(dump, case_dir, s, tmp)
                    # Lossless and hierarchical JPEG have no reduced decode (the CLI falls back).
                    hierarchical = info.get("transfer_syntax", "") in {f"1.2.840.10008.1.2.4.{n}" for n in range(59, 67)}
                    if fmt == "jpeg-lossless" or hierarchical:
                        if rc != 3:
                            print(f"{case_dir.name} 1/{1 << s}: expected Unsupported, got rc {rc}")
                            bad += 1
                        continue
                    if rc != 0:
                        print(f"{case_dir.name} 1/{1 << s}: {got}")
                        bad += 1
                        continue
                    frames = []
                    for k in range(info["frames"]):
                        p = subprocess.run([turbo, str(case_dir / f"frame-{k}.bin"), str(1 << s), ycc, f"{tmp}/t.raw"],
                                           capture_output=True, text=True)
                        if p.returncode != 0:
                            frames = None
                            break
                        w, h, c = map(int, p.stdout.split())
                        dt = np.uint16 if os.path.getsize(f"{tmp}/t.raw") == 2 * w * h * c else np.uint8
                        frames.append(np.fromfile(f"{tmp}/t.raw", dtype=dt).reshape(h, w, c).astype(np.int64))
                    maxval = 255 if full.max() <= 255 and info["bits_stored"] <= 8 else 4095
                    avg, clean = block_mean(full, s, maxval)
                    bavg = np.abs(got - avg)
                    cmax = bavg[clean].max() if clean.any() else 0.0
                    line = f"{case_dir.name[:58]:58} 1/{1 << s} {got.shape[2]:4}x{got.shape[1]:<4}"
                    if frames is None:
                        line += f" turbo: refused ({p.stderr.strip()[:40]})"
                    else:
                        want = np.stack(frames)
                        if want.shape != got.shape:
                            line += f" turbo shape {want.shape} != ours {got.shape}"
                            bad += 1
                        else:
                            d = np.abs(got - want)
                            line += f" turbo max {d.max():3} differing {np.count_nonzero(d):6}"
                            if d.max() > args.tol:
                                bad += 1
                                line += "  <-- FAIL"
                    line += f" | block-avg: clean max {cmax:5.2f}, all max {bavg.max():6.1f} mean {bavg.mean():.3f}"
                    if info["samples_per_pixel"] == 1 and cmax > 1.0:
                        bad += 1
                        line += "  <-- FAIL (block average)"
                    print(line, flush=True)
    print(f"{bad} failing")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
