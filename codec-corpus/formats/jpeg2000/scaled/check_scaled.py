"""Check the JPEG 2000 and HTJ2K decode_frame_scaled against OpenJPEG's own reduced decode.

For every jpeg2000 and htj2k frame (extract_frames.py output) and each scale 1/2, 1/4, 1/8:
  * ours: shl-codec-htj2k's scaled_dump example (JPEG 2000 frames go to shl-codec-jpeg2000);
  * oracle: `opj_decompress -r s` (OpenJPEG 2.5+, which also decodes HTJ2K), raw output.
Samples are compared modulo 2^precision, so signedness and representation rules (pydicom's sign
fixes) do not matter. Streams whose main COD says reversible 5/3 must match exactly; 9/7 streams
within max(the case's max_abs, our full-size difference from OpenJPEG on that frame).
A frame our codec refuses at reduced size (Unsupported) is counted with its reason; the CLI
then decodes it in full and downsamples.

Run from codec-corpus:  uv run python formats/jpeg2000/scaled/check_scaled.py [--case SUBSTR]
"""
import argparse, collections, json, os, re, shutil, subprocess, sys, tempfile
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
CORPUS = HERE.parents[2]
CODECS = CORPUS.parent / "codecs"
TARGET = Path(os.environ.get("CARGO_TARGET_DIR", CODECS / "target" / "scaled"))


def build():
    subprocess.run(["cargo", "build", "-q", "--release", "-p", "shl-codec-htj2k", "--example", "scaled_dump"],
                   cwd=CODECS, check=True, env={**os.environ, "CARGO_TARGET_DIR": str(TARGET)})
    return str(TARGET / "release" / "examples" / "scaled_dump")


def ours(dump, case_dir, k, s, tmp):
    """Frame k at 1/2^s as (h, w, c) int64, or (rc, message)."""
    d = Path(tmp) / "one"
    d.mkdir(exist_ok=True)
    info = json.loads((case_dir / "info.json").read_text())
    (d / "info.json").write_text(json.dumps({**info, "frames": 1}))
    shutil.copy(case_dir / f"frame-{k}.bin", d / "frame-0.bin")
    p = subprocess.run([dump, str(d), str(s), f"{tmp}/o.raw"], capture_output=True, text=True)
    if p.returncode != 0:
        return p.returncode, p.stdout.strip()
    w, h, bps, spp = map(int, p.stdout.split())
    a = np.fromfile(f"{tmp}/o.raw", dtype={1: np.uint8, 2: np.uint16, 4: np.uint32}[bps])
    return 0, a.reshape(h, w, spp).astype(np.int64)


def opj(frame, s, tmp):
    """OpenJPEG's decode at 1/2^s as ((h, w, c) int64, precision), or None."""
    data = frame.read_bytes()
    ext = "jp2" if data[4:8] == b"jP  " else "j2k"
    src = f"{tmp}/in.{ext}"
    Path(src).write_bytes(data)
    out = f"{tmp}/o.rawl"
    p = subprocess.run(["opj_decompress", "-i", src, "-o", out, "-r", str(s)], capture_output=True, text=True)
    comps = re.findall(r"Component \d+ characteristics: (\d+)x(\d+)x(\d+) (\w+)", p.stdout)
    if p.returncode != 0 or not comps or not os.path.exists(out):
        return None
    raw = Path(out).read_bytes()
    os.remove(out)
    planes, at = [], 0
    for w, h, prec, sign in comps:
        w, h, prec = int(w), int(h), int(prec)
        bps = 1 if prec <= 8 else 2
        dt = (np.int8 if sign == "signed" else np.uint8) if bps == 1 else (np.dtype("<i2") if sign == "signed" else np.dtype("<u2"))
        n = w * h
        planes.append(np.frombuffer(raw[at:at + n * bps], dtype=dt).reshape(h, w).astype(np.int64))
        at += n * bps
    if len({p.shape for p in planes}) != 1:
        return None
    return np.stack(planes, axis=-1), int(comps[0][2])


def reversible(frame):
    """Main-header COD wavelet: True for 5/3, False for 9/7, None if not found."""
    d = frame.read_bytes()
    i = d.find(b"\xff\x52")
    return None if i < 0 or i + 13 >= len(d) else d[i + 13] == 1


def moddiff(a, b, p):
    m = 1 << p
    d = np.mod(a - b, m)
    return np.minimum(d, m - d)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", default="")
    args = ap.parse_args()
    dump = build()
    bad, exact, within, unsupported, opj_refused = 0, 0, 0, collections.Counter(), 0
    with tempfile.TemporaryDirectory() as tmp:
        for fmt in ["jpeg2000", "htj2k"]:
            manifest = {c["id"]: c for c in json.loads((CORPUS / "formats" / fmt / "cases.json").read_text())["cases"]}
            for case_dir in sorted((CORPUS / "formats" / fmt / "frames").iterdir()):
                if args.case not in case_dir.name or not (case_dir / "info.json").exists():
                    continue
                info = json.loads((case_dir / "info.json").read_text())
                if info["expect"] != "decode":
                    continue
                frames = [case_dir / f"frame-{k}.bin" for k in range(info["frames"])]
                if not all(f.exists() for f in frames):
                    continue
                max_abs = manifest.get(case_dir.name, {}).get("max_abs", 0)
                for k, frame in enumerate(frames[:2]):  # first two frames of multi-frame cases
                    rev = reversible(frame)
                    base = None
                    for s in (1, 2, 3):
                        rc, got = ours(dump, case_dir, k, s, tmp)
                        label = f"{fmt}/{case_dir.name[:60]} f{k} 1/{1 << s}"
                        if rc == 3:
                            unsupported[re.sub(r"frame 0: unsupported: ", "", got)[:90]] += 1
                            continue
                        if rc != 0:
                            print(f"FAIL {label}: {got}")
                            bad += 1
                            continue
                        ref = opj(frame, s, tmp)
                        if ref is None:
                            opj_refused += 1
                            print(f"note {label}: OpenJPEG does not decode it at this scale")
                            continue
                        want, prec = ref
                        if want.shape != got.shape:
                            print(f"FAIL {label}: shape {got.shape}, OpenJPEG {want.shape}")
                            bad += 1
                            continue
                        d = moddiff(got, want, prec)
                        if d.max() == 0:
                            exact += 1
                            continue
                        if rev:
                            print(f"FAIL {label}: reversible, max diff {d.max()} ({np.count_nonzero(d)} samples)")
                            bad += 1
                            continue
                        if base is None:
                            rc0, full = ours(dump, case_dir, k, 0, tmp)
                            ref0 = opj(frame, 0, tmp)
                            base = int(moddiff(full, ref0[0], prec).max()) if rc0 == 0 and ref0 and ref0[0].shape == full.shape else 0
                        tol = max(max_abs, base, 1)
                        if d.max() > tol:
                            print(f"FAIL {label}: 9/7, max diff {d.max()} > {tol} (full-size diff {base})")
                            bad += 1
                        else:
                            within += 1
                            print(f"ok   {label}: 9/7, max diff {d.max()} (tolerance {tol}, full-size diff {base}, {np.count_nonzero(d)} samples differ)")
    print(f"exact {exact}, 9/7 within tolerance {within}, unsupported {sum(unsupported.values())}, OpenJPEG refused {opj_refused}, failing {bad}")
    for why, n in unsupported.most_common():
        print(f"  unsupported x{n}: {why}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
