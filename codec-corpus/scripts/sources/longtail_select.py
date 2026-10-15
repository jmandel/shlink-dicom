"""Rarity-weighted set-cover selection for the long-tail sweep (prevalence/LONGTAIL.md).

    uv run python scripts/sources/longtail_select.py [--extra-max-n 100000] [--control 1000]

Input: prevalence/cache/longtail/candidates.json (longtail_bq.py on sql/longtail_candidates.sql).
Output: prevalence/cache/longtail/selection.json, one record per instance with all its clues and
why it was picked:
  cover    greedy set cover: every (clue, value) pair and every TS x impl_ver x manufacturer x
           model x software combination present in the candidate pool is covered at least once.
           Gain of an instance = sum over its uncovered pairs of n^-0.5 (n = IDC instances with that
           pair), divided by (1 + size / 100 MB), so rare pairs and small files go first.
  extra    the remaining pool candidates for pairs/combos with n <= --extra-max-n (the 2nd and 3rd
           picks for rare values), rarest first
  control  a uniform random sample: instances with MOD(ABS(FARM_FINGERPRINT(instance_uuid)), 40000)
           = 17, the --control smallest hashes of those
Instances over 500 MB are dropped from every group and listed in skipped_oversize.
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
D = ROOT / "prevalence" / "cache" / "longtail"
CLUES = ["ts", "sop_class", "manufacturer", "model", "software", "impl_class", "impl_ver", "src_ae",
         "conversion_type", "image_type", "modality", "photometric", "bits", "high_bit", "spp_planar", "frames",
         "lossy", "lossy_method", "lossy_ratio", "padding", "smallest_value", "rescale_type", "voi_lut", "palette",
         "icon", "overlay", "presentation_lut", "odd_dims", "size_shape", "collection", "year5", "profile"]
MAX_SIZE = 500_000_000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--extra-max-n", type=int, default=100000)
    ap.add_argument("--control", type=int, default=1000)
    a = ap.parse_args()
    rows = json.loads((D / "candidates.json").read_text())["rows"]
    freq = {}
    for r in rows:
        j = json.loads(r["j"])
        if r["kind"] == "freq":
            freq[(j["clue"], j["value"])] = int(j["n"])
        elif r["kind"] == "combo":
            freq[("combo", j["value"])] = int(j["n"])
    inst = {}
    for r in rows:
        if r["kind"] == "inst":
            j = json.loads(r["j"])
            j["h"] = int(j["h"])
            j["instance_size"] = int(j["instance_size"])
            inst[j["h"]] = j
    oversize = [i for i in inst.values() if i["instance_size"] > MAX_SIZE]
    pool = {h: i for h, i in inst.items() if i["instance_size"] <= MAX_SIZE}

    def pairs(i):
        return [(c, i[c]) for c in CLUES] + [("combo", i["combo"])]

    # pairs reachable in the pool
    reachable = defaultdict(list)
    for h, i in pool.items():
        for p in pairs(i):
            reachable[p].append(h)
    unreachable = [p for p in freq if p not in reachable]
    w = {p: freq[p] ** -0.5 for p in reachable}
    uncovered = set(reachable)
    picked: dict[int, dict] = {}
    # lazy greedy
    import heapq
    def gain(h):
        i = pool[h]
        return sum(w[p] for p in pairs(i) if p in uncovered) / (1 + i["instance_size"] / 1e8)
    heap = [(-gain(h), h) for h in pool]
    heapq.heapify(heap)
    while uncovered and heap:
        g, h = heapq.heappop(heap)
        if h in picked:
            continue
        g2 = gain(h)
        if g2 <= 0:
            continue
        if heap and -heap[0][0] > g2 + 1e-12:
            heapq.heappush(heap, (-g2, h))
            continue
        newly = [p for p in pairs(pool[h]) if p in uncovered]
        uncovered -= set(newly)
        rarest = min(newly, key=lambda p: freq[p])
        picked[h] = {"reason": "cover", "covers": [f"{c}={v}" for c, v in newly], "rarest_n": freq[rarest]}
    n_cover = len(picked)
    # extras: other candidates of rare pairs
    extra = []
    for h, i in pool.items():
        if h in picked:
            continue
        rarest = min(pairs(i), key=lambda p: freq.get(p, 10**12))
        if freq.get(rarest, 10**12) <= a.extra_max_n:
            extra.append((freq[rarest], h, rarest))
    extra.sort()
    for n, h, p in extra:
        picked[h] = {"reason": "extra", "covers": [f"{p[0]}={p[1]}"], "rarest_n": n}
    # control
    ctrl = sorted((h for h, i in inst.items() if abs(h) % 40000 == 17), key=lambda h: (abs(h) // 40000))[: a.control]
    ctrl_over = [h for h in ctrl if inst[h]["instance_size"] > MAX_SIZE]
    out = []
    for h in ctrl:
        if h in picked:
            picked[h]["control"] = True
        else:
            picked[h] = {"reason": "control", "covers": [], "rarest_n": None, "control": True}
    for h, meta in picked.items():
        i = inst[h]
        if i["instance_size"] > MAX_SIZE:
            continue
        out.append({**i, "h": str(h), **meta, "control": bool(meta.get("control")),
                    "url": f"https://{i['aws_bucket']}.s3.amazonaws.com/{i['series_uuid']}/{i['instance_uuid']}.dcm"})
    res = {
        "n_selected": len(out), "n_cover": n_cover, "n_extra": len(extra), "n_control": len(ctrl),
        "control_oversize": [str(h) for h in ctrl_over],
        "gb": sum(o["instance_size"] for o in out) / 1e9,
        "pairs_total": len(freq), "pairs_reachable": len(reachable), "pairs_unreachable": [list(p) for p in unreachable],
        "skipped_oversize": [{"instance_uuid": i["instance_uuid"], "size": i["instance_size"], "profile": i["profile"],
                              "collection": i["collection"]} for i in oversize],
        "freq": [{"clue": c, "value": v, "n": n} for (c, v), n in sorted(freq.items())],
        "instances": out,
    }
    (D / "selection.json").write_text(json.dumps(res, indent=0))
    print({k: v for k, v in res.items() if k not in ("freq", "instances", "skipped_oversize", "pairs_unreachable")})
    print("unreachable pairs:", unreachable[:20])
    for o in oversize:
        print("oversize", o["instance_size"] / 1e6, "MB", o["profile"], o["collection"])


if __name__ == "__main__":
    main()
