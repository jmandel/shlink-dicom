"""IDC instances for the pet-rwvm-seg and rt-plan-set cases, merged into ../idc-selection.json.

CT-vs-PET-Ventilation-Imaging is the only IDC collection with Real World Value Mapping objects, and
no IDC study has both an RWVM and a SEG, so pet-rwvm-seg holds two studies: CT-PET-VI-15's RWVM
(SUVbw factors) with 20 contiguous slices of the PT series it maps, and a PSMA-PET-CT-Lesions SEG
with the 41 PT slices it references. rt-plan-set: Vestibular-Schwannoma-SEG VS-SEG-131's Gamma Knife
RT Plan and its "ROIs in MR T2" structure set with that MR series. All CC BY 4.0.

    uv run --with idc-index python web/checks/objects/sql/q8-content-gaps.py
"""
import json
from pathlib import Path

from idc_index import IDCClient

c = IDCClient()
SEL = Path(__file__).resolve().parent.parent / "idc-selection.json"
COLS = "collection_id, license_short_name, StudyInstanceUID, SeriesInstanceUID, SOPInstanceUID, SOPClassUID, Modality, TransferSyntaxUID, instance_size, crdc_series_uuid, crdc_instance_uuid"
RWVM = "1.3.6.1.4.1.14519.5.2.1.251940341101178920808064192542328352588"
VI15_PT = "1.3.6.1.4.1.14519.5.2.1.272123055161608800594737591932431832766"
PSMA_SEG = "1.3.6.1.4.1.14519.5.2.1.85873062368000652709549474375103102278"
PSMA_PT = "1.3.6.1.4.1.14519.5.2.1.181321739710927778209160059073207425062"
RTPLAN = "1.3.6.1.4.1.14519.5.2.1.228792382495649941952806093716428793979"
RTSTRUCT_T2 = "1.3.6.1.4.1.14519.5.2.1.224610269205985421367986816410978457110"
MR_T2 = "1.3.6.1.4.1.14519.5.2.1.277932022685732692159807028685158125644"


def instances(series: str) -> list[dict]:
    """Every instance of a series, from the series' own files (idc-index has series-level rows)."""
    import tempfile, pydicom
    row = c.sql_query(f"SELECT collection_id, license_short_name, crdc_series_uuid FROM index WHERE SeriesInstanceUID='{series}'").iloc[0]
    with tempfile.TemporaryDirectory(dir="/media/barracuda") as td:
        c.download_from_selection(seriesInstanceUID=[series], downloadDir=td, dirTemplate="", show_progress_bar=False)
        out = []
        for p in sorted(Path(td).rglob("*.dcm")):
            ds = pydicom.dcmread(p, stop_before_pixels=True)
            out.append(dict(collection_id=row.collection_id, license_short_name=row.license_short_name,
                            StudyInstanceUID=ds.StudyInstanceUID, SeriesInstanceUID=series, SOPInstanceUID=ds.SOPInstanceUID,
                            SOPClassUID=ds.SOPClassUID, Modality=ds.Modality, TransferSyntaxUID=ds.file_meta.TransferSyntaxUID,
                            instance_size=str(p.stat().st_size), crdc_series_uuid=row.crdc_series_uuid,
                            crdc_instance_uuid=p.stem, aws_bucket="idc-open-data",
                            _number=int(ds.get("InstanceNumber", 0) or 0),
                            _refs=[s.ReferencedSOPInstanceUID for f in ds.get("PerFrameFunctionalGroupsSequence", [])
                                   for d in f.get("DerivationImageSequence", []) for s in d.SourceImageSequence]))
        return sorted(out, key=lambda r: r["_number"])


def clean(rows):
    return [{k: str(v) for k, v in r.items() if not k.startswith("_")} for r in rows]


vi15 = instances(VI15_PT)
mid = len(vi15) // 2
seg = instances(PSMA_SEG)
refs = {u for r in seg for u in r["_refs"]}
psma = [r for r in instances(PSMA_PT) if r["SOPInstanceUID"] in refs]
sel = json.loads(SEL.read_text())
sel["pet-rwvm-seg"] = clean(instances(RWVM) + vi15[mid - 10: mid + 10] + seg + psma)
sel["rt-plan-set"] = clean(instances(RTPLAN) + instances(RTSTRUCT_T2) + instances(MR_T2))
SEL.write_text(json.dumps(sel, indent=1))
print({k: len(sel[k]) for k in ("pet-rwvm-seg", "rt-plan-set")})
