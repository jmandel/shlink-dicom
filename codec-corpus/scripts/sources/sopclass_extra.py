"""Cases for object types IDC lacks, for the object-type sweep: Enhanced CT/MR from public test
corpora, and Legacy Converted Enhanced CT/MR/PET derived from IDC classic series.

    uv run --with highdicom --with pydicom python scripts/sources/sopclass_extra.py ROOT

Reads ROOT/cases.json (sopclass_fetch.py); writes ROOT/extra/<case>/ and ROOT/cases-extra.json.
  enh-*   Enhanced CT and MR files from the public test corpora that quirks.py clones into
          ~/.cache/shl-quirks (fo-dicom MS-PL, Orthanc tests GPL-3.0); copied as they are.
  lce-*   sopclass_derive.py on an IDC CT, an oblique MR and a PET whose rescale differs between
          slices; the CT also with its frames shuffled and no dimension index.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pydicom

Q = Path.home() / ".cache" / "shl-quirks"
PUBLIC = [
    ("enh-ct-nema-ct0070", Q / "fo-dicom/Tests/FO-DICOM.Benchmark/Data/CT0070.dcm", "fo-dicom test data (MS-PL); NEMA Enhanced CT sample CT0070",
     "https://github.com/fo-dicom/fo-dicom/tree/development/Tests/FO-DICOM.Benchmark/Data"),
    ("enh-mr-fodicom-moveknee", Q / "fo-dicom/Tests/FO-DICOM.Tests/Test Data/MOVEKNEE.dcm", "fo-dicom test data (MS-PL)",
     "https://github.com/fo-dicom/fo-dicom/tree/development/Tests/FO-DICOM.Tests/Test%20Data"),
    ("enh-mr-orthanc-issue22", Q / "orthanc/Issue22.dcm", "Orthanc tests (GPL-3.0), file from a public issue report",
     "https://orthanc.uclouvain.be/hg/orthanc-tests/file/tip/Database/Issue22.dcm"),
    ("enh-mr-fodicom-gh1876", Q / "fo-dicom/Tests/FO-DICOM.Tests/Test Data/GH1876.dcm", "fo-dicom test data (MS-PL)",
     "https://github.com/fo-dicom/fo-dicom/tree/development/Tests/FO-DICOM.Tests/Test%20Data"),
    ("enh-mr-fodicom-2150", Q / "issues/fo-dicom_fo-dicom_2150/x-03306ca4d7b7d000c3fe59fa575db43d/series-000001_image-000001.dcm",
     "attachment to fo-dicom issue 2150 (public issue report)", "https://github.com/fo-dicom/fo-dicom/issues/2150"),
]
HERE = Path(__file__).resolve().parent


def series_uid(p: Path) -> str:
    return str(pydicom.dcmread(p, stop_before_pixels=True).SeriesInstanceUID)


def rescales(d: Path) -> int:
    return len({(str(x.get("RescaleSlope", 1)), str(x.get("RescaleIntercept", 0))) for x in (pydicom.dcmread(f, stop_before_pixels=True) for f in d.glob("*.dcm"))})


def main():
    root = Path(sys.argv[1])
    cases = json.load(open(root / "cases.json"))["cases"]
    extra = []
    for cid, src, lic, url in PUBLIC:
        if not src.exists():
            print(f"{cid}: {src} missing (run quirks.py)")
            continue
        d = root / "extra" / cid
        d.mkdir(parents=True, exist_ok=True)
        shutil.copy(src, d / "1.dcm")
        h = pydicom.dcmread(src, stop_before_pixels=True)
        uid = str(h.SeriesInstanceUID)
        extra.append({"id": cid, "sopClass": str(h.SOPClassUID), "short": cid.split("-")[0] + "-" + cid.split("-")[1], "primary": uid, "series": [uid],
                      "dirs": {uid: str(d)}, "why": "Enhanced class absent from IDC: public test corpus", "collection": "(public test corpus)",
                      "manufacturer": str(h.get("Manufacturer", "")), "modality": str(h.get("Modality", "")), "licence": lic, "source": url})
    dl = root / "dl"
    ct = [c for c in cases if c["short"] == "ct" and "regular" in c["why"]]
    mr = [c for c in cases if c["short"] == "mr" and "oblique" in c["why"]] or [c for c in cases if c["short"] == "mr"]
    pt = sorted([c for c in cases if c["short"] == "pt"], key=lambda c: -rescales(dl / c["primary"]))
    picks = [("lce-ct", ct[0], "ct", "spatial"), ("lce-ct-shuffled", ct[0], "ct", "shuffled"), ("lce-mr", mr[0], "mr", "spatial"), ("lce-pt", pt[0], "pt", "spatial")]
    for cid, src, kind, order in picks:
        d = root / "extra" / cid
        out = d / "1.dcm"
        if not out.exists():
            subprocess.run([sys.executable, str(HERE / "sopclass_derive.py"), str(dl / src["primary"]), str(out), kind, "--order", order], check=True)
        h = pydicom.dcmread(out, stop_before_pixels=True)
        uid = str(h.SeriesInstanceUID)
        extra.append({"id": cid, "sopClass": str(h.SOPClassUID), "short": cid, "primary": uid, "series": [uid], "dirs": {uid: str(d)},
                      "why": f"Legacy Converted Enhanced, absent from IDC: derived ({order} frames) from case {src['id']}",
                      "derivedFrom": src["primary"], "collection": src["collection"], "manufacturer": src["manufacturer"],
                      "modality": str(h.Modality), "licence": src["licence"] + " (derived)"})
        print(f"{cid}: from {src['id']} ({rescales(dl / src['primary'])} rescales)")
    json.dump({"cases": extra}, open(root / "cases-extra.json", "w"), indent=1)


if __name__ == "__main__":
    main()
