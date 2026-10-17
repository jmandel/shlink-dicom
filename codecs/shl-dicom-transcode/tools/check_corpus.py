"""Re-encode corpus files (JPEG Lossless SV1, or with --ts JPEG 2000 Lossless) and decode the
results with independent reference decoders.

For every expect=decode case of the given formats (default: uncompressed), or every file under
--dir, the `transcode` example re-encodes the file. Each encoded file is then decoded by the references in REFS, and every result
must equal the original case's oracle exactly. Declines are listed with their reasons. Writes a JSON report.

It fails (exit 1) on a crash or a reference mismatch, and also when the corpus is not all there or
the encoder does less than it did: a case whose sample is missing, no cases at all, or, against
--baseline (default: check_corpus.baseline.json beside this script), fewer cases encoded than the
baseline or any case it encoded now declined. --update-baseline writes the baseline from this run.

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

# Independent decoders per output syntax: libjpeg (Richter), GDCM's IJG and dcmtk for SV1;
# OpenJPEG through pylibjpeg and through opj_decompress, and GDCM (also OpenJPEG) for JPEG 2000.
REFS = {
    "1.2.840.10008.1.2.4.70": ["pydicom:pylibjpeg", "pydicom:gdcm", "dcmtk"],
    "1.2.840.10008.1.2.4.90": ["pydicom:pylibjpeg", "pydicom:gdcm", "openjpeg-cli"],
}


def run(case: dict, fmt: str, tool: str, work: Path, ts: str) -> dict:
    src = Path(case["path"]) if fmt == "dir" else sample_path(fmt, case["id"])
    out = work / f"{case['id']}.sv1.dcm"
    r = {"case": case["id"], "format": fmt}
    p = subprocess.run([tool, str(src), str(out), ts], capture_output=True, timeout=600)
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
    for ref in REFS[ts]:
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
    ap.add_argument("--ts", default="1.2.840.10008.1.2.4.70", choices=sorted(REFS))
    ap.add_argument("--report", type=Path)
    ap.add_argument("--baseline", type=Path, default=Path(__file__).with_name("check_corpus.baseline.json"))
    ap.add_argument("--update-baseline", action="store_true")
    a = ap.parse_args()
    a.work.mkdir(parents=True, exist_ok=True)
    if a.dir:
        work = [("dir", {"id": "-".join(p.relative_to(a.dir).parts).removesuffix(".dcm"), "path": str(p)})
                for p in sorted(a.dir.rglob("*")) if p.is_file()]
    else:
        wanted = [(f, c) for f in (a.format or ["uncompressed"]) for c in load_cases(f)
                  if c.get("expect") == "decode" and (not a.case or a.case in c["id"])]
        missing = [f"{f}/{c['id']}" for f, c in wanted if not sample_path(f, c["id"]).exists()]
        if missing:
            print(f"FAIL: {len(missing)} case(s) have no sample (run discover/generate), e.g. {missing[:3]}")
            return 1
        work = wanted
    if not work:
        print("FAIL: no cases to check")
        return 1
    with ThreadPoolExecutor(a.jobs) as ex:
        results = list(ex.map(lambda fc: run(fc[1], fc[0], a.transcode, a.work, a.ts), work))
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
    bad = bool(counts.get("crash") or counts.get("reference-mismatch"))
    # Against the baseline: the encoder must still encode every case it did (a whole run only).
    encoded = sorted(f"{r['format']}/{r['case']}" for r in enc)
    if not a.dir and not a.case:
        key = f"{a.ts} {' '.join(sorted(a.format or ['uncompressed']))}"
        base = json.loads(a.baseline.read_text()) if a.baseline.exists() else {}
        if a.update_baseline:
            base[key] = {"cases": len(results), "encoded": encoded}
            a.baseline.write_text(json.dumps(base, indent=1) + "\n")
            print(f"baseline for {key}: {len(encoded)} of {len(results)} encoded")
        elif key in base:
            lost = sorted(set(base[key]["encoded"]) - set(encoded))
            if lost or len(encoded) < len(base[key]["encoded"]):
                print(f"FAIL: {len(encoded)} encoded, baseline {len(base[key]['encoded'])}; newly declined or failed: {lost}")
                bad = True
        else:
            print(f"FAIL: no baseline for {key} in {a.baseline} (run with --update-baseline once)")
            bad = True
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
