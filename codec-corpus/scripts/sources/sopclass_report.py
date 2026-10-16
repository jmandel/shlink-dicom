"""Coverage tables for prevalence/SOPCLASS_SWEEP.md from the sweep's results.

    uv run --with pydicom python scripts/sources/sopclass_report.py ROOT CENSUS.json > tables.md

ROOT holds cases.json, cases-extra.json and results.json (web/checks/sop-sweep-checks.mjs).
Prints the coverage table by SOP class (of the primary series of each case), then one row per case
with its failed checks. A case passes when every check passed, is "unsupported" when the viewer
labelled the object as not displayed (and nothing failed), and fails otherwise.
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

from pydicom.uid import UID

root = Path(sys.argv[1])
census = {r["sop"]: r for r in json.load(open(sys.argv[2]))["rows"]}
cases = json.load(open(root / "cases.json"))["cases"] + json.load(open(root / "cases-extra.json"))["cases"]
res = json.load(open(root / "results.json"))
NAMES = {"1.2.840.10008.5.1.4.1.1.66.7": "Label Map Segmentation"}


def name(sop):
    n = UID(sop).name
    return NAMES.get(sop, n if n != sop else sop).replace(" Storage", "").replace("Image - For", "- For")


by = defaultdict(lambda: {"cases": 0, "pass": 0, "fail": 0, "unsupported": 0, "notrun": 0, "control": 0})
for c in cases:
    r = res.get(c["id"])
    b = by[c["sopClass"]]
    b["cases"] += 1
    b["control"] += c["why"] == "random control"
    b[r["verdict"] if r else "notrun"] += 1
def ctl(b):
    return f" ({b['control']} control)" if b["control"] else ""


order = sorted(by, key=lambda s: -int(census.get(s, {}).get("instances", 0)))
print("| SOP class | In IDC v25 (instances / series) | Sampled | Pass | Fail | Unsupported |")
print("|---|--:|--:|--:|--:|--:|")
for s in order:
    b = by[s]
    cen = census.get(s)
    idc = f"{int(cen['instances']):,} / {int(cen['series']):,}" if cen else "absent"
    print(f"| {name(s)} | {idc} | {b['cases']}{ctl(b)} | {b['pass']} | {b['fail']} | {b['unsupported']} |"
          + (f" ({b['notrun']} not run)" if b["notrun"] else ""))
for s in census:
    if s not in by:
        print(f"| {name(s)} | {int(census[s]['instances']):,} / {int(census[s]['series']):,} | 0 | – | – | – |")
tot = defaultdict(int)
for b in by.values():
    for k, v in b.items():
        tot[k] += v
print(f"| **All** | | **{tot['cases']}** | **{tot['pass']}** | **{tot['fail']}** | **{tot['unsupported']}** |")
print()
print("| Case | SOP class | Manufacturer / collection | Why picked | Verdict | Failed checks |")
print("|---|---|---|---|---|---|")
for c in cases:
    r = res.get(c["id"])
    if not r:
        continue
    fails = [f"{x['name']}: {x['detail'][:140]}" for x in r["checks"] if x["ok"] is False]
    why = c["why"].split(" (")[0]
    print(f"| `{c['id']}` | {name(c['sopClass'])} | {c.get('manufacturer') or ''} / {c['collection']} | {why} | {r['verdict']} | {'<br>'.join(f.replace('|', '/') for f in fails[:4])} |")
