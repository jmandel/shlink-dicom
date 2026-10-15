"""Frame-wise verification of long-tail instances too large to decode whole (prevalence/LONGTAIL.md).

    uv run python scripts/sources/longtail_framewise.py [--results ...] [--chunk 16] [--sample 30]

For every instance recorded as "skipped-decoded-size" by longtail_sweep.py (multi-GB whole-slide
images), with bounded memory:
  1. download it to WORK/tmp/fw-<uuid>/ (WORK = /media/barracuda/shlink-dicom-sweep);
  2. hash pass: split the encapsulated Pixel Data into frames with pydicom (generate_frames),
     write CHUNK frames at a time into a temporary Part 10 file (the original header, Number of
     Frames = CHUNK, no Extended Offset Table, one fragment per frame, a Basic Offset Table), and
     decode it with our CLI. Record a SHA-256 per frame of every frame. Only one chunk is decoded
     at a time;
  3. ~SAMPLE frames (first, last, evenly spread, plus a few seeded-random ones): decode each again
     alone through our CLI (determinism: its hash must equal the hash pass), and with the
     references, each in its own subprocess with a timeout:
       pydicom:pylibjpeg, pydicom:gdcm   pixel_array(original file, index=i)  (pydicom's own framing)
       pydicom:pylibjpeg-raw             the same with raw=True (no YBR->RGB after OpenJPEG)
       openjpeg-cli                      opj_decompress on the one-frame file (JPEG 2000 only)
     The oracle is the first reference that decodes. For JPEG 2000 YBR_FULL_422, where OpenJPEG
     already converts sYCC and pydicom converts again, the oracle is pydicom:pylibjpeg-raw (else
     openjpeg-cli). Lossless: exact; lossy: max(1, largest disagreement between the references that
     agree with the oracle family), as in oracle.py;
  4. peak RSS of every subprocess is measured with os.wait4.
Results are appended to prevalence/cache/longtail/framewise.jsonl. Our framing of the full file
is not exercised by this mode (pydicom splits the frames); the main sweep covers it on smaller files.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent
sys.path.insert(0, str(SCRIPTS))
ROOT = SCRIPTS.parent
D = ROOT / "prevalence" / "cache" / "longtail"
PY = str(ROOT / ".venv" / "bin" / "python")
WORK = Path("/media/barracuda/shlink-dicom-sweep")
DECODER = ROOT.parent / "codecs" / "target" / "longtail" / "release" / "shl-dicom-decode"
J2K = {"1.2.840.10008.1.2.4.90", "1.2.840.10008.1.2.4.91"}
LOSSY = {"1.2.840.10008.1.2.4.50", "1.2.840.10008.1.2.4.51", "1.2.840.10008.1.2.4.91", "1.2.840.10008.1.2.4.81",
         "1.2.840.10008.1.2.4.203"}


def run_rss(cmd: list[str], timeout: float) -> dict:
    """Run cmd; peak RSS (MB) is the largest VmHWM read from /proc/<pid>/status while it runs
    (wait4's ru_maxrss would include the forking Python parent's pages)."""
    t0 = time.monotonic()
    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    deadline = t0 + timeout
    rc, ru = None, None
    hwm = 0
    errbuf = b""
    os.set_blocking(p.stderr.fileno(), False)
    while True:
        try:
            chunk = p.stderr.read()
            if chunk:
                errbuf += chunk
        except Exception:  # noqa: BLE001
            pass
        try:
            for ln in open(f"/proc/{p.pid}/status"):
                if ln.startswith("VmHWM:"):
                    hwm = max(hwm, int(ln.split()[1]))
        except Exception:  # noqa: BLE001
            pass
        pid, status, ru = os.wait4(p.pid, os.WNOHANG)
        if pid:
            rc = os.waitstatus_to_exitcode(status)
            break
        if time.monotonic() > deadline:
            p.kill()
            pid, status, ru = os.wait4(p.pid, 0)
            rc = "timeout"
            break
        time.sleep(0.02)
    try:
        errbuf += p.stderr.read() or b""
    except Exception:  # noqa: BLE001
        pass
    p.returncode = 0  # already reaped
    return {"exit": rc, "s": round(time.monotonic() - t0, 2), "rss_mb": round(hwm / 1024, 1),
            "err": (errbuf.decode(errors="replace").strip().splitlines() or [""])[-1][:300]}


# ----------------------------------------------------------------------------- subprocess helpers

def write_subset(src: Path, indices: list[int], dst: Path) -> None:
    """A Part 10 file with only the given frames (pydicom framing), one fragment per frame."""
    import pydicom
    from pydicom.encaps import encapsulate, generate_frames
    ds = pydicom.dcmread(src, force=True)
    n = int(ds.NumberOfFrames)
    want = set(indices)
    frames = {}
    for i, f in enumerate(generate_frames(ds.PixelData, number_of_frames=n)):
        if i in want:
            frames[i] = f
        if len(frames) == len(want):
            break
    _save(ds, [frames[i] for i in indices], dst)


def _save(ds, frames: list[bytes], dst: Path) -> None:
    from pydicom.encaps import encapsulate
    for kw in ("ExtendedOffsetTable", "ExtendedOffsetTableLengths", "PerFrameFunctionalGroupsSequence"):
        if kw in ds:
            del ds[kw]
    ds.NumberOfFrames = len(frames)
    ds.PixelData = encapsulate(frames, has_bot=True)
    ds["PixelData"].is_undefined_length = True
    ds["PixelData"].VR = "OB"
    ds.save_as(dst, enforce_file_format=False)


def chunk_files(src: Path, chunk: int, outdir: Path, start_file: int = 0):
    """Write every chunk of frames to outdir/chunk-<k>.dcm one at a time; the caller consumes them."""
    import pydicom
    from pydicom.encaps import generate_frames
    ds = pydicom.dcmread(src, force=True)
    n = int(ds.NumberOfFrames)
    pd = ds.PixelData
    buf, k = [], 0
    for f in generate_frames(pd, number_of_frames=n):
        buf.append(f)
        if len(buf) == chunk:
            yield k, buf
            k += 1
            buf = []
    if buf:
        yield k, buf


def ref_frames(src: Path, ref: str, indices: list[int], outdir: Path) -> None:
    """Decode the given frames of src with one reference; write <outdir>/<i>.raw."""
    import warnings
    warnings.filterwarnings("ignore")
    import numpy as np
    import pydicom
    from pydicom.pixels import pixel_array
    from common import expected_dtype
    hdr = pydicom.dcmread(src, stop_before_pixels=True, force=True)
    dt = expected_dtype(int(hdr.BitsAllocated), int(getattr(hdr, "PixelRepresentation", 0)))
    outdir.mkdir(parents=True, exist_ok=True)
    if ref == "openjpeg-cli":
        from ref_decode import _from_openjpeg_cli
        for i in indices:
            one = outdir / f"one-{i}.dcm"
            write_subset(src, [i], one)
            arr = _from_openjpeg_cli(one)
            one.unlink()
            (outdir / f"{i}.raw").write_bytes(np.ascontiguousarray(arr).tobytes())
        return
    plugin = ref.split(":", 1)[1]
    raw = plugin.endswith("-raw")
    plugin = plugin[: -len("-raw")] if raw else plugin
    for i in indices:
        arr = pixel_array(src, index=i, decoding_plugin=plugin, raw=raw)
        (outdir / f"{i}.raw").write_bytes(np.ascontiguousarray(arr.astype(dt.newbyteorder("<"), copy=False)).tobytes())


# ----------------------------------------------------------------------------- driver

def maxdiff(a: bytes, b: bytes, dt) -> int:
    import numpy as np
    if len(a) != len(b):
        return -1
    x = np.frombuffer(a, dt).astype(np.int64)
    y = np.frombuffer(b, dt).astype(np.int64)
    return int(np.abs(x - y).max()) if x.size else 0


def verify(inst: dict, a) -> dict:
    import numpy as np
    import pydicom
    from common import expected_dtype
    rec = {"instance_uuid": inst["instance_uuid"], "profile": inst["profile"], "size": inst["instance_size"],
           "manufacturer": inst["manufacturer"], "model": inst["model"], "collection": inst["collection"],
           "control": inst.get("control"), "url": inst["url"]}
    work = WORK / "tmp" / f"fw-{inst['instance_uuid']}"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    t0 = time.monotonic()
    try:
        src = work / "in.dcm"
        kept = WORK / "keep" / f"{inst['instance_uuid']}.dcm"
        if kept.exists():
            shutil.copyfile(kept, src)
        else:
            with urllib.request.urlopen(inst["url"], timeout=600) as r, open(src, "wb") as f:
                shutil.copyfileobj(r, f, 1 << 20)
        hdr = pydicom.dcmread(src, stop_before_pixels=True, force=True)
        n = int(hdr.NumberOfFrames)
        ts = str(hdr.file_meta.TransferSyntaxUID)
        ph = str(hdr.PhotometricInterpretation)
        dt = expected_dtype(int(hdr.BitsAllocated), int(getattr(hdr, "PixelRepresentation", 0)))
        rec.update(frames=n, ts=ts, photometric=ph, rows=int(hdr.Rows), columns=int(hdr.Columns))
        rnd = random.Random(inst["instance_uuid"])
        sample = sorted(set([0, n - 1] + [round(k * (n - 1) / (a.sample - 7)) for k in range(a.sample - 6)]
                            + rnd.sample(range(n), min(5, n))))
        rec["sample"] = sample
        # 1. hash pass, chunk by chunk, in a subprocess that writes chunk files; we decode each
        hashes: list[str | None] = [None] * n
        peak = {"ours": 0.0}
        ours_errors = []
        split = subprocess.Popen([PY, str(Path(__file__)), "--split", str(src), str(a.chunk), str(work)],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        empty = []
        for line in split.stdout:
            if line.startswith("empty "):
                empty.append(int(line.split()[1]))
                continue
            k, first, cnt, path = line.split()
            k, first, cnt = int(k), int(first), int(cnt)
            out = work / f"chunk-{k}.raw"
            r = run_rss([str(DECODER), path, str(out)], 120 + 10 * cnt)
            peak["ours"] = max(peak["ours"], r["rss_mb"])
            if r["exit"] == 0 and out.exists():
                data = out.read_bytes()
                fb = len(data) // cnt
                for j in range(cnt):
                    fr = data[j * fb:(j + 1) * fb]
                    hashes[first + j] = hashlib.sha256(fr).hexdigest()
                    if first + j in sample:
                        (work / f"ours-{first + j}.raw").write_bytes(fr)
            else:
                ours_errors.append({"chunk": k, "first": first, **r})
            out.unlink(missing_ok=True)
            Path(path).unlink(missing_ok=True)
        split.wait()
        rec["hash_pass"] = {"frames_hashed": sum(h is not None for h in hashes), "errors": ours_errors[:5],
                            "n_error_chunks": len(ours_errors), "split_exit": split.returncode,
                            "split_err": split.stderr.read()[-300:]}
        rec["empty_frames"] = {"count": len(empty), "first": empty[:1], "last": empty[-1:]}
        sample = [i for i in sample if i not in set(empty)]
        rec["sample"] = sample
        rec["frame_hashes_sha256"] = hashlib.sha256("".join(h or "-" for h in hashes).encode()).hexdigest()
        # 2. determinism: each sampled frame alone
        det_bad = []
        for i in sample:
            one = work / f"one-{i}.dcm"
            subprocess.run([PY, str(Path(__file__)), "--subset", str(src), str(i), str(one)], check=True, timeout=600)
            out = work / f"one-{i}.raw"
            r = run_rss([str(DECODER), str(one), str(out)], 120)
            peak["ours"] = max(peak["ours"], r["rss_mb"])
            h = hashlib.sha256(out.read_bytes()).hexdigest() if r["exit"] == 0 and out.exists() else None
            if h != hashes[i]:
                det_bad.append({"frame": i, "single": h, "chunk": hashes[i], "err": r["err"]})
            out.unlink(missing_ok=True)
            one.unlink(missing_ok=True)
        rec["determinism_mismatches"] = det_bad
        # 3. references on the sample
        refs = ["pydicom:pylibjpeg", "pydicom:gdcm"]
        if ts in J2K:
            refs += ["pydicom:pylibjpeg-raw", "openjpeg-cli"]
        refres = {}
        for ref in refs:
            od = work / f"ref-{ref.replace(':', '_')}"
            r = run_rss([PY, str(Path(__file__)), "--ref", ref, str(src), ",".join(map(str, sample)), str(od)],
                        1800)
            refres[ref] = r
        rec["refs"] = refres
        ok = [r for r in refs if refres[r]["exit"] == 0]
        if ts in J2K and ph == "YBR_FULL_422":
            pref = [r for r in ("pydicom:pylibjpeg-raw", "openjpeg-cli") if r in ok]
            others = [r for r in ("pydicom:pylibjpeg-raw", "openjpeg-cli") if r in ok]
        else:
            pref = [r for r in refs if r in ok and not r.endswith("-raw")]
            others = pref
        oracle = pref[0] if pref else None
        rec["oracle_ref"] = oracle
        per_frame = []
        if oracle:
            for i in sample:
                o = (work / f"ref-{oracle.replace(':', '_')}" / f"{i}.raw").read_bytes()
                dis = max([maxdiff(o, (work / f"ref-{r.replace(':', '_')}" / f"{i}.raw").read_bytes(), dt)
                           for r in others if r != oracle] or [0])
                allowed = max(1, dis) if ts in LOSSY else 0
                if ts in J2K and ph == "YBR_FULL_422":
                    # jpeg2000 FORMAT.md ruling: oracle pylibjpeg-raw, max_abs 2 (OpenJPEG's sYCC
                    # conversion vs ours differs by <= 2)
                    allowed = max(2, dis)
                op = work / f"ours-{i}.raw"
                d = maxdiff(op.read_bytes(), o, dt) if op.exists() else None
                per_frame.append({"frame": i, "ours_max_abs": d, "allowed": allowed, "refs_disagree": dis,
                                  "ok": d is not None and 0 <= d <= allowed})
        rec["per_frame"] = per_frame
        rec["frames_checked"] = len(per_frame)
        rec["frames_ok"] = sum(p["ok"] for p in per_frame)
        rec["peak_rss_mb"] = {"ours": peak["ours"],
                              **{r: refres[r]["rss_mb"] for r in refs}}
        if split.returncode != 0:
            rec["outcome"] = "framewise-error"
        elif ours_errors or rec["hash_pass"]["frames_hashed"] + len(empty) < n:
            rec["outcome"] = "our-error"
        elif det_bad:
            rec["outcome"] = "nondeterministic"
        elif not oracle:
            rec["outcome"] = "refs-fail"
        else:
            rec["outcome"] = "pass" if rec["frames_ok"] == len(per_frame) else "mismatch"
    except Exception as e:  # noqa: BLE001
        rec.update(outcome="framewise-error", error=repr(e)[:300])
    finally:
        rec["seconds"] = round(time.monotonic() - t0)
        shutil.rmtree(work, ignore_errors=True)
    return rec


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", type=Path, default=D / "results.jsonl")
    ap.add_argument("--out", type=Path, default=D / "framewise.jsonl")
    ap.add_argument("--chunk", type=int, default=16)
    ap.add_argument("--sample", type=int, default=30)
    ap.add_argument("--only")
    ap.add_argument("--uuids", type=Path, help="verify these instances (one uuid per line) instead of the skipped-size ones")
    ap.add_argument("--split", nargs=3)
    ap.add_argument("--subset", nargs=3)
    ap.add_argument("--ref", nargs=4)
    a = ap.parse_args()
    if a.split:
        src, chunk, outdir = Path(a.split[0]), int(a.split[1]), Path(a.split[2])
        import pydicom
        hdr = pydicom.dcmread(src, stop_before_pixels=True, force=True)
        first = 0
        sub = 0
        for k, frames in chunk_files(src, chunk, outdir):
            # empty frames (zero-length items) cannot be re-encapsulated; report them and decode
            # the non-empty runs of the chunk separately
            runs, cur, start = [], [], first
            for j, f in enumerate(frames):
                if len(f) < 2:
                    if cur:
                        runs.append((start, cur))
                    print("empty", first + j, flush=True)
                    cur, start = [], first + j + 1
                else:
                    cur.append(f)
            if cur:
                runs.append((start, cur))
            for rstart, rframes in runs:
                p = outdir / f"chunk-{sub}.dcm"
                _save(hdr.copy(), rframes, p)
                print(sub, rstart, len(rframes), p, flush=True)
                sub += 1
                # wait until the consumer has deleted the file, so at most one chunk is on disk
                while p.exists():
                    time.sleep(0.02)
            first += len(frames)
        return 0
    if a.subset:
        write_subset(Path(a.subset[0]), [int(x) for x in a.subset[1].split(",")], Path(a.subset[2]))
        return 0
    if a.ref:
        ref_frames(Path(a.ref[1]), a.ref[0], [int(x) for x in a.ref[2].split(",")], Path(a.ref[3]))
        return 0
    recs = {}
    for line in a.results.read_text().splitlines():
        r = json.loads(line)
        recs[r["instance_uuid"]] = r
    done = set()
    if a.out.exists():
        done = {json.loads(l)["instance_uuid"] for l in a.out.read_text().splitlines()}
    want = set(a.uuids.read_text().split()) if a.uuids else None
    todo = [r for r in recs.values()
            if (r["instance_uuid"] in want if want else r["outcome"] == "skipped-decoded-size")
            and r["instance_uuid"] not in done
            and (not a.only or a.only in r["instance_uuid"])]
    print(f"{len(todo)} instances to verify frame-wise", flush=True)
    for inst in todo:
        rec = verify(inst, a)
        with open(a.out, "a") as f:
            f.write(json.dumps(rec) + "\n")
        print(f"{rec['outcome']:16} {rec.get('frames')} frames, {rec.get('frames_ok')}/{rec.get('frames_checked')} sampled ok, "
              f"peak {rec.get('peak_rss_mb')} {rec['seconds']}s {rec['profile'][:60]} {rec.get('error', '')}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
