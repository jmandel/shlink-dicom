"""Mutation fuzz of one survey adapter over the corpus codestreams (jpeg2000 + htj2k frames).

Usage (from codec-corpus/):
    uv run python ../codecs/survey-j2k/fuzz.py ADAPTER SECONDS [--seed N] [--only jpeg2000|htj2k]

Mutants whose SIZ width/height/component count differ from the seed file are skipped: the real
wrapper refuses those before calling the codec (it checks SIZ against DICOM Rows/Columns/Samples).
Each run: 10 s timeout, 4 GiB address-space limit. Outcomes: ok | err (exit 2) | panic (101) |
abort (SIGABRT, e.g. allocation failure) | signal (SIGSEGV/SIGBUS...: memory-safety bug) | timeout.
Crashing inputs are saved under fuzz-findings/<adapter>/, one per distinct crash site.
"""

from __future__ import annotations

import argparse
import collections
import random
import re
import resource
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
CORPUS = HERE.parent.parent / "codec-corpus" / "formats"
sys.path.insert(0, str(HERE))
from score import BIN, parse_siz  # noqa: E402

MAX_SEED_BYTES = 200_000  # keep runs fast: skip the very large real-world frames


def limits() -> None:
    resource.setrlimit(resource.RLIMIT_AS, (4 << 30, 4 << 30))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def mutate(b: bytearray, rng: random.Random) -> bytearray:
    b = bytearray(b)
    for _ in range(rng.choice([1, 1, 2, 3, 4, 8])):
        op = rng.randrange(7)
        n = len(b)
        if n < 4:
            break
        # bias half the mutations into the header (first 300 bytes: markers live there)
        pos = rng.randrange(min(n, 300)) if rng.random() < 0.5 else rng.randrange(n)
        if op == 0:
            b[pos] ^= 1 << rng.randrange(8)
        elif op == 1:
            b[pos] = rng.choice([0x00, 0xFF, 0x7F, 0x80, 0x01, rng.randrange(256)])
        elif op == 2:
            v = rng.choice([0, 0xFFFF, 0x8000, 0x7FFF, 1, rng.randrange(65536)])
            b[pos:pos + 2] = v.to_bytes(2, "big")
        elif op == 3:
            del b[rng.randrange(n // 2, n):]  # truncate
        elif op == 4:
            s = rng.randrange(n); e = min(n, s + rng.randrange(1, 64))
            b[pos:pos] = b[s:e]  # duplicate a chunk
        elif op == 5:
            s = rng.randrange(n); del b[s:s + rng.randrange(1, 32)]
        else:
            b[pos:pos + 4] = rng.randrange(1 << 32).to_bytes(4, "big")
    return b


def site(stderr: str) -> str:
    m = re.search(r"panicked at ([^\n]+?):(\d+):\d+", stderr)
    if m:
        f = m.group(1).split("/src/")[-1]
        return f"{f}:{m.group(2)}"
    if "memory allocation" in stderr:
        return "alloc-failure"
    if "stack overflow" in stderr:
        return "stack-overflow"
    return stderr.strip().splitlines()[-1][:80] if stderr.strip() else "?"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("adapter")
    ap.add_argument("seconds", type=float)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--only", choices=["jpeg2000", "htj2k"])
    a = ap.parse_args()
    rng = random.Random(a.seed)
    seeds = []
    for fmt in ([a.only] if a.only else ["jpeg2000", "htj2k"]):
        for f in sorted((CORPUS / fmt / "frames").glob("*/frame-0.bin")):
            data = f.read_bytes()
            siz = parse_siz(data)
            if siz and len(data) <= MAX_SEED_BYTES and "embedded-sequence" not in str(f):
                seeds.append((f.parent.name, data, (siz["w"], siz["h"], len(siz["comps"]))))
    out_dir = HERE / "fuzz-findings" / a.adapter
    counts = collections.Counter()
    sites: dict[str, tuple[str, str]] = {}
    t_end = time.time() + a.seconds
    with tempfile.TemporaryDirectory() as td:
        inp, outp = Path(td) / "in.j2c", Path(td) / "out.raw"
        while time.time() < t_end:
            name, data, dims = rng.choice(seeds)
            m = mutate(bytearray(data), rng)
            siz = parse_siz(bytes(m))
            if not siz or (siz["w"], siz["h"], len(siz["comps"])) != dims:
                counts["skipped(wrapper rejects SIZ)"] += 1
                continue
            inp.write_bytes(m)
            try:
                p = subprocess.run([str(BIN / f"a-{a.adapter}"), str(inp), str(outp)], capture_output=True,
                                   timeout=10, preexec_fn=limits)
                rc = p.returncode
                err = p.stderr.decode(errors="replace")
            except subprocess.TimeoutExpired:
                rc, err = "timeout", "timeout"
            if rc == 0:
                kind = "ok"
            elif rc == 2:
                kind = "err"
            elif rc == 101:
                kind = "panic"
            elif rc == "timeout":
                kind = "timeout"
            elif rc == -6 or rc == 134:
                kind = "abort"
            elif isinstance(rc, int) and rc < 0:
                kind = f"signal{-rc}"
            else:
                kind = f"exit{rc}"
            counts[kind] += 1
            if kind not in ("ok", "err"):
                s = f"{kind}:{site(err)}"
                if s not in sites:
                    out_dir.mkdir(parents=True, exist_ok=True)
                    fn = out_dir / f"{len(sites):03d}-{kind}.j2c"
                    fn.write_bytes(m)
                    sites[s] = (fn.name, name)
    execs = sum(v for k, v in counts.items() if not k.startswith("skipped"))
    print(f"adapter={a.adapter} execs={execs} {dict(counts)}")
    for s, (fn, seed) in sorted(sites.items()):
        print(f"  {s}  [{fn} from {seed}]")


if __name__ == "__main__":
    main()
