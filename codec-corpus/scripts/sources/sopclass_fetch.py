"""Download the object-type sweep's series, with the series they reference, and group them into cases.

    uv run --with idc-index --with pydicom python scripts/sources/sopclass_fetch.py SELECTION.json ROOT

SELECTION.json is sopclass_select.py's output. Files go to ROOT/dl/<SeriesInstanceUID>/ (public
S3 bucket idc-open-data via idc-index's s5cmd); ROOT/cases.json lists the cases:
  { id, sopClass, primary: series UID, series: [UIDs in the case], why, collection, licence, ... }
A case is one picked series plus every series it references that IDC has (Referenced Series
Sequence items, the SR evidence sequences, a segmentation's or structure set's referenced frame
of reference series, a registration's moving and fixed series), capped at REF_CAP_MB per case.
Data stays outside git.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import pydicom
from idc_index import index

REF_CAP_MB = 400
SHORT = {
    "1.2.840.10008.5.1.4.1.1.2": "ct", "1.2.840.10008.5.1.4.1.1.4": "mr", "1.2.840.10008.5.1.4.1.1.128": "pt",
    "1.2.840.10008.5.1.4.1.1.66": "raw", "1.2.840.10008.5.1.4.1.1.77.1.6": "sm", "1.2.840.10008.5.1.4.1.1.7": "sc",
    "1.2.840.10008.5.1.4.1.1.88.22": "sr-enh", "1.2.840.10008.5.1.4.1.1.66.4": "seg", "1.2.840.10008.5.1.4.1.1.1.2.1": "mg-proc",
    "1.2.840.10008.5.1.4.1.1.13.1.3": "bto", "1.2.840.10008.5.1.4.1.1.481.3": "rtstruct", "1.2.840.10008.5.1.4.1.1.1": "cr",
    "1.2.840.10008.5.1.4.1.1.1.2": "mg", "1.2.840.10008.5.1.4.1.1.91.1": "ann", "1.2.840.10008.5.1.4.1.1.88.34": "sr-3d",
    "1.2.840.10008.5.1.4.1.1.1.1": "dx", "1.2.840.10008.5.1.4.1.1.3.1": "us-mf", "1.2.840.10008.5.1.4.1.1.104.3": "stl",
    "1.2.840.10008.5.1.4.1.1.88.33": "sr-comp", "1.2.840.10008.5.1.4.1.1.6.1": "us", "1.2.840.10008.5.1.4.1.1.11.1": "gsps",
    "1.2.840.10008.5.1.4.1.1.30": "pmap", "1.2.840.10008.5.1.4.1.1.481.2": "rtdose", "1.2.840.10008.5.1.4.1.1.481.5": "rtplan",
    "1.2.840.10008.5.1.4.1.1.11.8": "abps", "1.2.840.10008.5.1.4.1.1.7.2": "sc-mf8", "1.2.840.10008.5.1.4.1.1.88.71": "sr-acq",
    "1.2.840.10008.5.1.4.1.1.13.1.5": "bpx-proc", "1.2.840.10008.5.1.4.1.1.13.1.4": "bpx", "1.2.840.10008.5.1.4.1.1.66.7": "seg-lm",
    "1.2.840.10008.5.1.4.1.1.20": "nm", "1.2.840.10008.5.1.4.1.1.66.1": "reg", "1.2.840.10008.5.1.4.1.1.12.1": "xa",
    "1.2.840.10008.5.1.4.1.1.88.59": "ko", "1.2.840.10008.5.1.4.1.1.12.2": "rf", "1.2.840.10008.5.1.4.1.1.67": "rwv",
    "1.2.840.10008.5.1.4.1.1.1.1.1": "dx-proc", "1.2.840.10008.5.1.4.1.1.88.67": "sr-dose",
}
# Classes whose referenced series belong in the case.
REFERRING = {"seg", "seg-lm", "rtstruct", "ann", "gsps", "abps", "pmap", "ko", "sr-enh", "sr-3d", "sr-comp", "sr-acq",
             "rtdose", "rtplan", "reg", "rwv", "sr-dose"}


def referenced_series(ds) -> set[str]:
    """Every Series Instance UID named inside a sequence of the dataset (not its own)."""
    out = set()
    own = str(ds.get("SeriesInstanceUID", ""))

    def walk(d, depth):
        for el in d:
            if el.VR == "SQ":
                for item in el.value:
                    v = item.get("SeriesInstanceUID")
                    if v:
                        out.add(str(v))
                    walk(item, depth + 1)
    walk(ds, 0)
    out.discard(own)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("selection")
    ap.add_argument("root", type=Path)
    a = ap.parse_args()
    sel = json.load(open(a.selection))["series"]
    dl = a.root / "dl"
    dl.mkdir(parents=True, exist_ok=True)
    c = index.IDCClient()
    df = c.index.set_index("SeriesInstanceUID")

    def fetch(uids):
        need = [u for u in uids if not (dl / u).is_dir() or not any((dl / u).iterdir())]
        if need:
            c.download_from_selection(seriesInstanceUID=need, downloadDir=str(dl), dirTemplate="%SeriesInstanceUID",
                                      quiet=True, show_progress_bar=False)
    fetch([s["SeriesInstanceUID"] for s in sel])
    cases = []
    for s in sel:
        uid = s["SeriesInstanceUID"]
        short = SHORT.get(s["SOPClassUID"], "x")
        cid = f"{short}-{re.sub(r'[^a-z0-9]+', '', s['collection_id'].lower())[:14]}-{uid[-8:].replace('.', '')}"
        if s["why"] == "random control":
            cid = "ctl-" + cid
        series = [uid]
        refs_missing = []
        if short in REFERRING:
            files = sorted((dl / uid).glob("*.dcm"))
            refs = set()
            for f in files[:5]:
                refs |= referenced_series(pydicom.dcmread(f, stop_before_pixels=True))
            budget = REF_CAP_MB
            for r in sorted(refs):
                if r not in df.index:
                    refs_missing.append(r)
                    continue
                mb = float(df.loc[r].series_size_MB)
                if mb > budget:
                    refs_missing.append(r)
                    continue
                budget -= mb
                series.append(r)
            fetch(series[1:])
        cases.append({"id": cid, "sopClass": s["SOPClassUID"], "short": short, "primary": uid, "series": series,
                      "refsNotInCase": refs_missing, "why": s["why"], "collection": s["collection_id"],
                      "manufacturer": s["Manufacturer"], "modality": s["Modality"], "licence": s["license_short_name"],
                      "sizeMB": round(sum(float(df.loc[u].series_size_MB) for u in series if u in df.index), 3)})
        print(f"{cid}: {len(series)} series, {cases[-1]['sizeMB']} MB" + (f", {len(refs_missing)} refs not in case" if refs_missing else ""), flush=True)
    json.dump({"idc_index_version": c.get_idc_version(), "cases": cases}, open(a.root / "cases.json", "w"), indent=1)
    print(f"{len(cases)} cases, {sum(x['sizeMB'] for x in cases) / 1000:.1f} GB")


if __name__ == "__main__":
    main()
