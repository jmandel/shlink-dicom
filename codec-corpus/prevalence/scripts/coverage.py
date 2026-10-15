"""Combine a prevalence profile table with a check.py report into coverage estimates.

    uv run python prevalence/scripts/coverage.py PROFILES.csv REPORT.json [--sets SETS.csv] [--top 25]

PROFILES.csv  a profile table (profiles-<source>.csv): one row per (profile, modality)
              with instances, series and studies.
SETS.csv      the matching set table (default: PROFILES stem + '-sets.csv'): how many series
              and studies contain each distinct set of profiles. Without it, series and
              study coverage cannot be computed exactly and are reported as unavailable.
REPORT.json   a check.py report (codec-corpus/reports/<name>.json).

A profile is PASSING when at least one corpus case with that profile and expect=decode
passed, and no expect=decode case with that profile failed, crashed or was unsupported.
A series or study is covered only if every profile it contains is passing.

Two match levels are reported:
- exact: the case has exactly the instance's profile (transfer syntax, photometric,
  bits allocated, bits stored, pixel representation, samples per pixel, planar
  configuration, single/multi-frame);
- relaxed: same transfer syntax, photometric, bits allocated, samples per pixel and planar
  configuration; bits stored, signedness and frame count may differ. This is an upper
  bound that assumes a decoder that handles one bit depth handles its neighbours.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pixprofile import describe, key_from_case, key_from_row  # noqa: E402

CORPUS = Path(__file__).resolve().parents[2]
BAD = {"fail", "crash", "unsupported"}


def relax(key: str) -> str:
    ts, ph, ba, bs, pr, spp, pc, fr = key.split("|")
    return "|".join((ts, ph, ba, spp, pc))


def load_cases() -> dict[tuple[str, str], dict]:
    out = {}
    for f in sorted((CORPUS / "formats").glob("*/cases.json")):
        fmt = f.parent.name
        for c in json.loads(f.read_text())["cases"]:
            out[(fmt, c["id"])] = c
    return out


def profile_status(report: dict, cases: dict) -> tuple[dict, dict, dict]:
    """Return ({key: status}, {relaxed key: status}, {key: [case ids]}) for every corpus profile."""
    outcomes = defaultdict(list)
    relaxed = defaultdict(list)
    ids = defaultdict(list)
    for r in report["results"]:
        c = cases.get((r["format"], r["case"]))
        if c is None or c.get("expect") != "decode" or r["outcome"] == "skipped":
            continue
        k = key_from_case(c)
        outcomes[k].append(r["outcome"])
        relaxed[relax(k)].append(r["outcome"])
        ids[k].append(f"{r['format']}/{r['case']}:{r['outcome']}")
    # Profiles present in the corpus but absent from this report still count as "in corpus".
    for (fmt, cid), c in cases.items():
        if c.get("expect") == "decode":
            k = key_from_case(c)
            outcomes.setdefault(k, [])
            relaxed.setdefault(relax(k), [])

    def status(os_: list[str]) -> str:
        if not os_:
            return "untested"
        if any(o in BAD for o in os_):
            return "failing"
        return "passing" if "pass" in os_ else "untested"

    return ({k: status(v) for k, v in outcomes.items()}, {k: status(v) for k, v in relaxed.items()}, ids)


def pct(a: float, b: float) -> str:
    return f"{100 * a / b:6.2f}%" if b else "   n/a"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("profiles", type=Path)
    ap.add_argument("report", type=Path)
    ap.add_argument("--sets", type=Path)
    ap.add_argument("--top", type=int, default=25)
    ap.add_argument("--blind", type=int, default=20, help="blind-spot profiles to list")
    a = ap.parse_args()

    report = json.loads(a.report.read_text())
    cases = load_cases()
    exact, relaxed, ids = profile_status(report, cases)

    rows = list(csv.DictReader(open(a.profiles)))
    inst = defaultdict(float)
    mods = defaultdict(lambda: defaultdict(float))
    for r in rows:
        k = key_from_row(r)
        inst[k] += float(r["instances"])
        mods[k][r["modality"]] += float(r["instances"])
    total = sum(inst.values())

    def ok_exact(k):
        return exact.get(k) == "passing"

    def ok_relaxed(k):
        return relaxed.get(relax(k)) == "passing"

    print(f"Prevalence source: {a.profiles.name}  ({total:,.0f} image instances, {len(inst)} profiles)")
    print(f"Decoder report:    {a.report.name}  (candidate: {report.get('candidate', '?')})")
    print()

    sets_path = a.sets or a.profiles.with_name(a.profiles.stem + "-sets.csv")
    sets = defaultdict(list)
    if sets_path.exists():
        for r in csv.DictReader(open(sets_path)):
            sets[r["level"]].append((r["profiles"].split(";"), int(r["count"])))

    print("Coverage                 exact     relaxed")
    print(f"  instances           {pct(sum(v for k, v in inst.items() if ok_exact(k)), total)}   "
          f"{pct(sum(v for k, v in inst.items() if ok_relaxed(k)), total)}")
    for level in ("series", "study"):
        if level in sets:
            n = sum(c for _, c in sets[level])
            e = sum(c for p, c in sets[level] if all(ok_exact(k) for k in p))
            rl = sum(c for p, c in sets[level] if all(ok_relaxed(k) for k in p))
            label = "series" if level == "series" else "studies"
            print(f"  {label:<8} {n:>10,} {pct(e, n)}   {pct(rl, n)}")
        else:
            print(f"  {level:<19}    n/a       n/a   (no {sets_path.name})")
    print()

    print(f"Top {a.top} profiles by instances (status: exact / relaxed)")
    for k, v in sorted(inst.items(), key=lambda kv: -kv[1])[: a.top]:
        m = ", ".join(f"{mm}" for mm, _ in sorted(mods[k].items(), key=lambda x: -x[1])[:4])
        print(f"  {pct(v, total)}  {exact.get(k, 'no case'):9} / {relaxed.get(relax(k), 'no case'):9}  {describe(k)}  [{m}]")
    print()

    failing = [(k, v) for k, v in inst.items() if exact.get(k) == "failing"]
    if failing:
        print("Profiles with failing cases")
        for k, v in sorted(failing, key=lambda kv: -kv[1]):
            bad = [i for i in ids[k] if not i.endswith(":pass")]
            print(f"  {pct(v, total)}  {describe(k)}: {', '.join(bad[:4])}")
        print()

    blind = [(k, v) for k, v in inst.items() if k not in exact]
    print(f"Blind spots: profiles with no corpus case ({pct(sum(v for _, v in blind), total).strip()} of instances)")
    for k, v in sorted(blind, key=lambda kv: -kv[1])[: a.blind]:
        m = ", ".join(mm for mm, _ in sorted(mods[k].items(), key=lambda x: -x[1])[:4])
        near = "relaxed match passes" if ok_relaxed(k) else ("relaxed match in corpus" if relax(k) in relaxed else "nothing close")
        print(f"  {pct(v, total)} {v:>12,.0f}  {describe(k)}  [{m}]  ({near})")
    if len(blind) > a.blind:
        rest = sorted(blind, key=lambda kv: -kv[1])[a.blind:]
        print(f"  ... {len(rest)} more, {sum(v for _, v in rest):,.0f} instances in total")
    print()
    print("Suggested cases: the blind spots with nothing close in the corpus, largest first")
    for k, v in sorted(blind, key=lambda kv: -kv[1]):
        if relax(k) not in relaxed:
            ts, ph, ba, bs, pr, spp, pc, fr = k.split("|")
            print(f"  ts={ts} photometric={ph} bits_allocated={ba} bits_stored={bs} pixel_representation={pr} "
                  f"samples_per_pixel={spp} planar_configuration={pc} frames={'>1' if fr == 'multi' else '1'}  "
                  f"({v:,.0f} instances)")

if __name__ == "__main__":
    main()
