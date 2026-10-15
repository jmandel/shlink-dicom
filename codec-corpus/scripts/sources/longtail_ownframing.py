"""Hash every frame of the frame-wise instances through our own framing (prevalence/LONGTAIL.md).

    uv run python scripts/sources/longtail_ownframing.py [--chunk 16]

longtail_framewise.py splits frames with pydicom. This runs longtail_frames (a wrapper around
shl-dicom-decode-wasm::decode_frames, which uses shl-dicom-decode's own parse.rs/encaps.rs
framing) with `hashall`, CHUNK frames per call, and compares the per-frame SHA-256 digest
(sha256 of the concatenated per-frame hex digests, "-" for an empty frame) with the frame-wise
record. Peak RSS is the largest VmHWM seen while polling /proc. Writes ownframing.jsonl.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import time
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from longtail_framewise import D, WORK, run_rss  # noqa: E402

TOOL = HERE.parent.parent.parent / "codecs" / "target" / "longtail" / "release" / "longtail-frames"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--chunk", type=int, default=16)
    a = ap.parse_args()
    recs = []
    for f in ("framewise.jsonl", "framewise_leica.jsonl"):
        if (D / f).exists():
            recs += [json.loads(l) for l in (D / f).read_text().splitlines()]
    out = D / "ownframing.jsonl"
    done = {json.loads(l)["instance_uuid"] for l in out.read_text().splitlines()} if out.exists() else set()
    for r in recs:
        if r["instance_uuid"] in done or "frame_hashes_sha256" not in r:
            continue
        work = WORK / "tmp" / f"own-{r['instance_uuid']}"
        work.mkdir(parents=True, exist_ok=True)
        src = work / "in.dcm"
        kept = WORK / "keep" / f"{r['instance_uuid']}.dcm"
        if kept.exists():
            shutil.copyfile(kept, src)
        else:
            for attempt in range(5):
                try:
                    with urllib.request.urlopen(r["url"], timeout=600) as resp, open(src, "wb") as fh:
                        shutil.copyfileobj(resp, fh, 1 << 20)
                    break
                except OSError:
                    if attempt == 4:
                        raise
                    time.sleep(20 * (attempt + 1))
        hashes_file = work / "hashes.txt"
        res = run_rss(["sh", "-c", f'exec "{TOOL}" hashall "{src}" {a.chunk} > "{hashes_file}"'], 7200)
        hashes = {}
        err = None
        for line in hashes_file.read_text().splitlines():
            p = line.split(maxsplit=2)
            if p[0] == "error":
                err = line
            elif p[0] != "total":
                hashes[int(p[0])] = p[1]
        n = r["frames"]
        empty = r.get("empty_frames", {}).get("count", 0)
        joined = "".join(hashes.get(i, "-") for i in range(n))
        digest = hashlib.sha256(joined.encode()).hexdigest()
        rec = {"instance_uuid": r["instance_uuid"], "frames": n, "frames_hashed": len(hashes), "empty_frames": empty,
               "error": err, "exit": res["exit"], "seconds": res["s"], "peak_rss_mb": res["rss_mb"],
               "matches_pydicom_framing": digest == r["frame_hashes_sha256"]}
        with open(out, "a") as fh:
            fh.write(json.dumps(rec) + "\n")
        print(json.dumps(rec), flush=True)
        shutil.rmtree(work, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
