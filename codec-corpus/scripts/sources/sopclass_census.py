"""Writes the table part of prevalence/SOPCLASS_CENSUS.md from the census query's output.

    uv run --with pydicom python scripts/sources/sopclass_census.py CENSUS.json > table.md

CENSUS.json is longtail_bq.py's output for prevalence/sql/sopclass_census.sql.
"""
import json
import sys

from pydicom.uid import UID

rows = json.load(open(sys.argv[1]))["rows"]
tot_i = sum(int(r["instances"]) for r in rows)
tot_s = sum(int(r["series"]) for r in rows)
print("| SOP class | UID | Instances | Series | Multi-frame instances | Collections | Manufacturers (top) | Modalities | TB |")
print("|---|---|--:|--:|--:|--:|---|---|--:|")
for r in rows:
    name = UID(r["sop"]).name
    if name == r["sop"]:
        name = {"1.2.840.10008.5.1.4.1.1.66.7": "Label Map Segmentation Storage"}.get(r["sop"], "?")
    i, s, mf = int(r["instances"]), int(r["series"]), int(r["multiframe"])
    man = r["manufacturers"]
    top = ", ".join(f"{m['v']} ({int(m['n']):,})" for m in man[:3])
    more = int(r["n_manufacturers"]) - 3
    mods = ", ".join(m["v"] for m in r["modalities"][:4]) + (" …" if len(r["modalities"]) > 4 else "")
    print(f"| {name.replace(' Storage', '')} | `{r['sop']}` | {i:,} | {s:,} | {mf:,} | {r['n_collections']} | {top}{f' +{more}' if more > 0 else ''} | {mods} | {int(r['bytes']) / 1e12:.2f} |")
print(f"\n{len(rows)} SOP classes; {tot_i:,} instances; {tot_s:,} series (a series counted once per SOP class it holds).")
