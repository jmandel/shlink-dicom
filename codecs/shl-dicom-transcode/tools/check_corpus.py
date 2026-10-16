"""Re-encode corpus files as JPEG Lossless SV1 and decode the results with the reference decoders.

For every expect=decode case of the given formats (default: uncompressed), or every file under
--dir, the `transcode` example re-encodes the file. Each encoded file is then decoded by pydicom with pylibjpeg (Richter's
libjpeg), by pydicom with GDCM, and by dcmtk's dcmdjpeg, and every result must equal the original
case's oracle exactly. Declines are listed with their reasons. Writes a JSON report.

    cd codec-corpus
    uv run python ../codecs/shl-dicom-transcode/tools/check_corpus.py \
        --transcode /path/to/target/release/examples/transcode --work /media/barracuda/sv1/work
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

CORPUS = Path.cwd()
sys.path.insert(0, str(CORPUS / "scripts"))
from common import load_cases, oracle_paths, sample_path  # noqa: E402
from ref_decode import decode as ref_decode  # noqa: E402

REFS = ["pydicom:pylibjpeg", "pydicom:gdcm", "dcmtk"]


def run(case: dict, fmt: str, tool: str, work: Path) -> dict:
    src = Path(case["path"]) if fmt == "dir" else sample_path(fmt, case["id"])
    out = work / f"{case['id']}.sv1.dcm"
    r = {"case": case["id"], "format": fmt}
    p = subprocess.run([tool, str(src), str(out)], capture_output=True, timeout=600)
    line = p.stdout.decode().strip()
    if p.returncode != 0:
        r.update(outcome="crash", detail=f"exit {p.returncode} {p.stderr.decode()[-200:]}")
        return r
    if line.startswith("declined"):
        r.update(outcome="declined", reason=line[len("declined "):])
        return r
    _, ib, ob, pin, pout, frames, ms = line.split()
    r.update(outcome="encoded", input_bytes=int(ib), output_bytes=int(ob), pixel_in=int(pin), pixel_out=int(pout),
             frames=int(frames), ms=float(ms))
    # The original's pixels: the corpus oracle, or for --dir files pydicom's own decode.
    oracle = ref_decode(src, "pydicom:pydicom") if fmt == "dir" else np.load(oracle_paths(fmt, case["id"])[0], mmap_mode="r")
    refs = {}
    for ref in REFS:
        q = subprocess.run([sys.executable, str(CORPUS / "scripts" / "ref_decode.py"), "--ref", ref, str(out), str(work / f"{case['id']}.{ref.replace(':', '_')}.raw")],
                           capture_output=True, timeout=600)
        raw = work / f"{case['id']}.{ref.replace(':', '_')}.raw"
        if q.returncode != 0:
            refs[ref] = f"failed: {q.stderr.decode().strip().splitlines()[-1:]}"
        else:
            data = raw.read_bytes()
            ok = len(data) == oracle.nbytes and np.array_equal(np.frombuffer(data, oracle.dtype).reshape(oracle.shape), oracle)
            refs[ref] = "exact" if ok else "DIFFERS"
        raw.unlink(missing_ok=True)
    r["refs"] = refs
    if any(v != "exact" for v in refs.values()):
        r["outcome"] = "reference-mismatch"
    out.unlink(missing_ok=True)
    return r


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--transcode", required=True)
    ap.add_argument("--work", type=Path, required=True)
    ap.add_argument("--format", action="append")
    ap.add_argument("--case")
    ap.add_argument("--dir", type=Path, help="check every file under this directory instead of the corpus")
    ap.add_argument("--jobs", type=int, default=6)
    ap.add_argument("--report", type=Path)
    a = ap.parse_args()
    a.work.mkdir(parents=True, exist_ok=True)
    if a.dir:
        work = [("dir", {"id": "-".join(p.relative_to(a.dir).parts).removesuffix(".dcm"), "path": str(p)})
                for p in sorted(a.dir.rglob("*")) if p.is_file()]
    else:
        work = [(f, c) for f in (a.format or ["uncompressed"]) for c in load_cases(f)
                if c.get("expect") == "decode" and sample_path(f, c["id"]).exists() and (not a.case or a.case in c["id"])]
    with ThreadPoolExecutor(a.jobs) as ex:
        results = list(ex.map(lambda fc: run(fc[1], fc[0], a.transcode, a.work), work))
    counts = Counter(r["outcome"] for r in results)
    for r in results:
        if r["outcome"] in ("crash", "reference-mismatch"):
            print(r["outcome"], r["case"], r.get("detail") or r.get("refs"))
    reasons = Counter(r["reason"].split(":")[0] for r in results if r["outcome"] == "declined")
    enc = [r for r in results if r["outcome"] == "encoded"]
    pin, pout = sum(r["pixel_in"] for r in enc), sum(r["pixel_out"] for r in enc)
    ms = sum(r["ms"] for r in enc)
    print(dict(counts))
    for k, v in reasons.most_common():
        print(f"  declined {v:4}  {k}")
    if enc:
        print(f"pixel data {pin / 1e6:.1f} MB -> {pout / 1e6:.1f} MB (ratio {pin / pout:.2f}); "
              f"transcode with both checks {pin / 1e6 / (ms / 1000):.1f} MB/s over {len(enc)} files")
    if a.report:
        a.report.write_text(json.dumps(results, indent=1) + "\n")
    return 1 if counts.get("crash") or counts.get("reference-mismatch") else 0


if __name__ == "__main__":
    sys.exit(main())
