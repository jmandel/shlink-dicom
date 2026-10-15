"""Convert the raw BigQuery export (cache/profiles-idc.csv, query in sql/idc_profiles.sql)
into the shared profile-table format (profiles-idc.csv). Rows without Bits Allocated
(SR, RTSTRUCT, other objects without pixel data) are dropped.

    uv run python prevalence/scripts/convert_idc_bq.py [RAW.csv] [OUT.csv]
"""
import csv
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pixprofile import FIELDS, PROFILE_COLUMNS, make_key  # noqa: E402

HERE = Path(__file__).resolve().parent.parent
raw = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "cache" / "profiles-idc.csv"
out = Path(sys.argv[2]) if len(sys.argv) > 2 else HERE / "profiles-idc.csv"
acc = defaultdict(lambda: [0, 0, 0])
dropped = 0
for r in csv.DictReader(open(raw)):
    if not r["BitsAllocated"]:
        dropped += int(r["instances"])
        continue
    key = make_key(r["TransferSyntaxUID"], r["PhotometricInterpretation"], r["BitsAllocated"], r["BitsStored"],
                   r["PixelRepresentation"], r["SamplesPerPixel"], r["PlanarConfiguration"],
                   "multi" if r["multiframe"] == "true" else "single")
    a = acc[(key, r["Modality"])]
    a[0] += int(r["instances"]); a[1] += int(r["series"]); a[2] += int(r["studies"])
with open(out, "w", newline="") as f:
    w = csv.DictWriter(f, PROFILE_COLUMNS)
    w.writeheader()
    for (key, mod), (i, s, st) in sorted(acc.items(), key=lambda kv: -kv[1][0]):
        w.writerow(dict(zip(FIELDS, key.split("|")), modality=mod, instances=i, series=s, studies=st))
print(f"{len(acc)} rows -> {out}; {dropped} instances without pixel data dropped")
