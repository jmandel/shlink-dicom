"""Series selection for the object-type sweep (prevalence/SOPCLASS_SWEEP.md).

    uv run --with idc-index python scripts/sources/sopclass_select.py CENSUS.json OUT.json [--seed 7]

CENSUS.json is longtail_bq.py's output for prevalence/sql/sopclass_census.sql (every SOP class in
IDC). Series come from the idc-index series table (the same IDC release, read locally, no
BigQuery), with its seg_index, rtstruct_index, ann_index and volume_geometry_index.

Per SOP class, a few series spread across manufacturers, then collections:
  - picks per class: PICKS below (default 3); every class present gets at least one;
  - size caps per class (CAP_MB), smallest first within each manufacturer/collection group;
  - CT, MR and PET volumes: at least 20 instances, one regular volume per group first, plus one
    oblique or irregular one from volume_geometry_index when present;
  - SEG, RTSTRUCT and ANN: candidates whose referenced series is also small (the referenced series
    is added to the case); other references (presentation states, SR, KO, maps) are resolved after
    download by sopclass_fetch.py.
A random control of --control series (uniform over all series under 250 MB) is added.
Each pick records why it was picked. Only UIDs and index metadata are written.
"""
from __future__ import annotations

import argparse
import json
import random

from idc_index import index

PICKS = {
    "1.2.840.10008.5.1.4.1.1.2": 8, "1.2.840.10008.5.1.4.1.1.4": 8, "1.2.840.10008.5.1.4.1.1.128": 5,
    "1.2.840.10008.5.1.4.1.1.66.4": 5, "1.2.840.10008.5.1.4.1.1.481.3": 3, "1.2.840.10008.5.1.4.1.1.7": 5,
    "1.2.840.10008.5.1.4.1.1.88.22": 3, "1.2.840.10008.5.1.4.1.1.77.1.6": 3, "1.2.840.10008.5.1.4.1.1.1": 3,
    "1.2.840.10008.5.1.4.1.1.1.2.1": 3, "1.2.840.10008.5.1.4.1.1.1.2": 3, "1.2.840.10008.5.1.4.1.1.1.1": 3,
    "1.2.840.10008.5.1.4.1.1.3.1": 3, "1.2.840.10008.5.1.4.1.1.6.1": 3, "1.2.840.10008.5.1.4.1.1.13.1.3": 3,
    "1.2.840.10008.5.1.4.1.1.20": 4, "1.2.840.10008.5.1.4.1.1.12.1": 3, "1.2.840.10008.5.1.4.1.1.12.2": 2,
    "1.2.840.10008.5.1.4.1.1.481.2": 2, "1.2.840.10008.5.1.4.1.1.66": 2, "1.2.840.10008.5.1.4.1.1.7.2": 2, "1.2.840.10008.5.1.4.1.1.13.1.4": 2, "1.2.840.10008.5.1.4.1.1.13.1.5": 2, "1.2.840.10008.5.1.4.1.1.91.1": 2,
    "1.2.840.10008.5.1.4.1.1.88.67": 1,
}
VOLUME = {"1.2.840.10008.5.1.4.1.1.2", "1.2.840.10008.5.1.4.1.1.4", "1.2.840.10008.5.1.4.1.1.128"}
CAP_MB = {"1.2.840.10008.5.1.4.1.1.77.1.6": 120, "1.2.840.10008.5.1.4.1.1.13.1.4": 120,
          "1.2.840.10008.5.1.4.1.1.13.1.5": 120, "1.2.840.10008.5.1.4.1.1.7.2": 80}
DEFAULT_CAP = 150
REF_CAP = 200


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("census")
    ap.add_argument("out")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--control", type=int, default=20)
    ap.add_argument("--rescale", help="longtail_bq.py output of prevalence/sql/sopclass_rescale_varies.sql: adds series whose rescale differs between slices")
    a = ap.parse_args()
    rng = random.Random(a.seed)
    census = {r["sop"]: r for r in json.load(open(a.census))["rows"]}
    c = index.IDCClient()
    for n in ("seg_index", "rtstruct_index", "ann_index", "volume_geometry_index"):
        c.fetch_index(n)
    df = c.index.copy()
    df["Manufacturer"] = df["Manufacturer"].fillna("(none)").str.strip().replace("", "(none)")
    size = dict(zip(df.SeriesInstanceUID, df.series_size_MB))
    geo = c.volume_geometry_index.set_index("SeriesInstanceUID")
    refs = {}
    for name, col in (("seg_index", "segmented_SeriesInstanceUID"), ("rtstruct_index", "referenced_SeriesInstanceUID"),
                      ("ann_index", "referenced_SeriesInstanceUID")):
        t = getattr(c, name)
        for uid, r in zip(t.SeriesInstanceUID, t[col]):
            refs[uid] = r if isinstance(r, str) else (list(r)[0] if hasattr(r, '__len__') and len(r) else None)
    seg_type = dict(zip(c.seg_index.SeriesInstanceUID, c.seg_index.SegmentationType))
    picked, seen = [], set()

    def take(row, why):
        uid = row.SeriesInstanceUID
        if uid in seen:
            return False
        seen.add(uid)
        rec = {k: (None if str(row[k]) == "nan" else row[k]) for k in (
            "SeriesInstanceUID", "StudyInstanceUID", "collection_id", "Modality", "SOPClassUID", "sop_class_name",
            "Manufacturer", "ManufacturerModelName", "instanceCount", "series_size_MB", "license_short_name",
            "TransferSyntaxUID", "SeriesDescription", "crdc_series_uuid", "aws_bucket", "series_aws_url")}
        rec["instanceCount"] = int(rec["instanceCount"])
        rec["series_size_MB"] = round(float(rec["series_size_MB"]), 3)
        rec["why"] = why
        if uid in refs and refs[uid]:
            rec["referenced_series"] = refs[uid]
            rec["referenced_size_MB"] = round(float(size.get(refs[uid], 0)), 3)
        if uid in seg_type:
            rec["SegmentationType"] = seg_type[uid]
        if uid in geo.index:
            g = geo.loc[uid]
            rec["geometry"] = {k: (None if str(g[k]) == "nan" else (bool(g[k]) if isinstance(g[k], (bool,)) or str(g[k]) in ("True", "False") else float(g[k])))
                               for k in ("regularly_spaced_3d_volume", "orthogonal_orientation", "obliquity_degrees", "uniform_slice_spacing")}
        picked.append(rec)
        return True

    for sop, cen in sorted(census.items(), key=lambda kv: -int(kv[1]["instances"])):
        k = PICKS.get(sop, 3)
        cap = CAP_MB.get(sop, DEFAULT_CAP)
        pool = df[(df.SOPClassUID == sop) & (df.series_size_MB <= cap)]
        if pool.empty:  # everything is big: the smallest one
            pool = df[df.SOPClassUID == sop].nsmallest(1, "series_size_MB")
        if sop in refs_classes():
            pool = pool[pool.SeriesInstanceUID.map(lambda u: refs.get(u) is not None and size.get(refs.get(u), 1e9) <= REF_CAP)]
            if pool.empty:
                pool = df[df.SOPClassUID == sop].nsmallest(1, "series_size_MB")
        if sop in VOLUME:
            pool = pool[(pool.instanceCount >= 20) & (pool.instanceCount <= 400)]
        n0 = len(picked)
        if sop in VOLUME:
            vol = pool[pool.SeriesInstanceUID.map(lambda u: u in geo.index and bool(geo.loc[u].regularly_spaced_3d_volume))]
            odd = pool[pool.SeriesInstanceUID.map(lambda u: u in geo.index and (not bool(geo.loc[u].orthogonal_orientation)))]
            spread(vol, k - 1, rng, take, "regular volume, spread by manufacturer then collection")
            if not odd.empty:
                take(odd.sample(1, random_state=a.seed).iloc[0], "oblique slices (volume_geometry_index orthogonal_orientation false)")
            else:
                spread(pool, 1, rng, take, "extra volume")
        elif sop == "1.2.840.10008.5.1.4.1.1.66.4":
            for t in ("BINARY", "FRACTIONAL", "LABELMAP"):
                sub = pool[pool.SeriesInstanceUID.map(lambda u: seg_type.get(u) == t)]
                spread(sub, 1 if t != "BINARY" else k - 2, rng, take, f"SegmentationType {t}")
        else:
            spread(pool, k, rng, take, "spread by manufacturer then collection")
        print(f"{cen['instances']:>9} {sop:34} {len(picked) - n0} picked (pool {len(pool)})")
    if a.rescale:
        # Per-slice rescale (two thirds of IDC's PET series): one or two examples per class and manufacturer.
        ex = [r for r in json.load(open(a.rescale))["rows"] if r["kind"] == "example"]
        want = {"1.2.840.10008.5.1.4.1.1.128": 4, "1.2.840.10008.5.1.4.1.1.2": 1, "1.2.840.10008.5.1.4.1.1.4": 1}
        by = df.set_index("SeriesInstanceUID")
        for r in sorted(ex, key=lambda r: (r["sop"], -int(r["rescales"]))):
            if want.get(r["sop"], 0) <= 0 or r["series"] not in by.index or int(r["n"]) < 30:
                continue
            row = by.loc[r["series"]].copy()
            row["SeriesInstanceUID"] = r["series"]
            if take(row, f"rescale differs between slices ({r['rescales']} rescales over {r['n']} instances; {r['manu']} / {r['coll']})"):
                want[r["sop"]] -= 1
    pool = df[df.series_size_MB <= 250]
    n = 0
    for i in rng.sample(range(len(pool)), len(pool)):
        if n >= a.control:
            break
        if take(pool.iloc[i], "random control"):
            n += 1
    total = sum(p["series_size_MB"] + p.get("referenced_size_MB", 0) for p in picked)
    print(f"{len(picked)} series, about {total / 1000:.1f} GB with referenced series")
    json.dump({"idc_index_version": c.get_idc_version(), "seed": a.seed, "series": picked}, open(a.out, "w"), indent=1, default=str)


def refs_classes():
    return {"1.2.840.10008.5.1.4.1.1.66.4", "1.2.840.10008.5.1.4.1.1.481.3", "1.2.840.10008.5.1.4.1.1.91.1"}


def spread(pool, k, rng, take, why):
    """k series: round-robin over manufacturers (in random order), within a manufacturer over its
    collections, within a collection a series near the median size first, then others at random."""
    if pool.empty or k <= 0:
        return
    groups = {}
    for (m, col), g in pool.groupby(["Manufacturer", "collection_id"]):
        g = g.sort_values("series_size_MB")
        order = [len(g) // 2] + rng.sample([i for i in range(len(g)) if i != len(g) // 2], min(len(g) - 1, 20))
        groups.setdefault(m, []).append([g.iloc[i] for i in order])
    mans = list(groups)
    rng.shuffle(mans)
    got = 0
    while got < k and any(any(c) for c in groups.values()):
        for m in mans:
            cols = groups[m]
            while cols and not cols[0]:
                cols.pop(0)
            if got >= k or not cols:
                continue
            row = cols[0].pop(0)
            cols.append(cols.pop(0))
            if take(row, f"{why} ({m} / {row.collection_id})"):
                got += 1


if __name__ == "__main__":
    main()
