"""Synthetic objects a viewer lists but does not display: a Real World Value Mapping (PET SUV
factors) and an RT Plan, a few KB each and no pixel data. Case `listed-synthetic` in samples.json
(replacing an earlier entry of the same id); data in samples.json's dataRoot.

    uv run --project codec-corpus python web/checks/objects/make-listed.py
"""
import hashlib, json
from pathlib import Path

import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

HERE = Path(__file__).resolve().parent
CASE = "listed-synthetic"
man = json.loads((HERE / "samples.json").read_text())
out = Path(man["dataRoot"]) / CASE
out.mkdir(parents=True, exist_ok=True)
study = generate_uid(entropy_srcs=["listed-synthetic study"])


def base(sop_class: str, n: int, modality: str, desc: str) -> Dataset:
    ds = Dataset()
    ds.file_meta = FileMetaDataset()
    ds.file_meta.MediaStorageSOPClassUID = sop_class
    ds.file_meta.MediaStorageSOPInstanceUID = generate_uid(entropy_srcs=[f"{desc} instance"])
    ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.SOPClassUID, ds.SOPInstanceUID = sop_class, ds.file_meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID, ds.SeriesInstanceUID = study, generate_uid(entropy_srcs=[f"{desc} series"])
    ds.Modality = modality
    ds.PatientName, ds.PatientID = "TEST^SYNTHETIC", "SYN0003"
    ds.StudyDescription, ds.SeriesDescription = "Synthetic listed objects", desc
    ds.SeriesNumber, ds.InstanceNumber = n, 1
    ds.ContentDate, ds.ContentTime = "20260101", "120000"
    return ds


def code(value: str, scheme: str, meaning: str) -> Dataset:
    c = Dataset()
    c.CodeValue, c.CodingSchemeDesignator, c.CodeMeaning = value, scheme, meaning
    return c


# Real World Value Mapping: SUVbw for a PET series that is not in the share.
rw = base("1.2.840.10008.5.1.4.1.1.67", 1, "RWV", "PET SUV factors")
m = Dataset()
m.LUTLabel = "SUVbw"
m.LUTExplanation = "Standardized Uptake Value body weight"
m.MeasurementUnitsCodeSequence = [code("{SUVbw}g/ml", "UCUM", "Standardized Uptake Value body weight")]
m.RealWorldValueFirstValueMapped, m.RealWorldValueLastValueMapped = 0, 32767
m.RealWorldValueIntercept, m.RealWorldValueSlope = 0.0, 0.00214634
q = Dataset()
q.ConceptNameCodeSequence = [code("126400", "DCM", "Standardized Uptake Value")]
q.ConceptCodeSequence = [code("126410", "DCM", "SUV body weight calculation method")]
m.QuantityDefinitionSequence = [q]
ref = Dataset()
ref.ReferencedSOPClassUID = "1.2.840.10008.5.1.4.1.1.128"
ref.ReferencedSOPInstanceUID = generate_uid(entropy_srcs=["listed-synthetic absent PET image"])
item = Dataset()
item.ReferencedImageSequence = [ref]
item.RealWorldValueMappingSequence = [m]
rw.ReferencedImageRealWorldValueMappingSequence = [item]
rw.save_as(out / "rwvm.dcm", enforce_file_format=True)

# RT Plan: one fraction group, one static photon beam, no structure set or dose in the share.
rp = base("1.2.840.10008.5.1.4.1.1.481.5", 2, "RTPLAN", "Synthetic plan")
rp.RTPlanLabel, rp.RTPlanName, rp.RTPlanDate, rp.RTPlanTime = "SYN1", "Synthetic plan", "20260101", "120000"
rp.RTPlanGeometry = "PATIENT"
fg = Dataset()
fg.FractionGroupNumber, fg.NumberOfFractionsPlanned, fg.NumberOfBeams, fg.NumberOfBrachyApplicationSetups = 1, 5, 1, 0
rb = Dataset()
rb.ReferencedBeamNumber, rb.BeamMeterset = 1, 100.0
fg.ReferencedBeamSequence = [rb]
rp.FractionGroupSequence = [fg]
beam = Dataset()
beam.BeamNumber, beam.BeamName, beam.BeamType, beam.RadiationType = 1, "AP", "STATIC", "PHOTON"
beam.TreatmentDeliveryType, beam.NumberOfWedges, beam.NumberOfCompensators, beam.NumberOfBoli, beam.NumberOfBlocks = "TREATMENT", 0, 0, 0, 0
beam.FinalCumulativeMetersetWeight, beam.NumberOfControlPoints = 1.0, 2
cps = []
for k, w in enumerate([0.0, 1.0]):
    cp = Dataset()
    cp.ControlPointIndex, cp.CumulativeMetersetWeight = k, w
    if k == 0:
        cp.NominalBeamEnergy, cp.GantryAngle, cp.BeamLimitingDeviceAngle, cp.PatientSupportAngle = 6.0, 0.0, 0.0, 0.0
    cps.append(cp)
beam.ControlPointSequence = cps
rp.BeamSequence = [beam]
rp.save_as(out / "rtplan.dcm", enforce_file_format=True)

files = ["rwvm.dcm", "rtplan.dcm"]
case = {
    "id": CASE,
    "feature": "Objects a viewer lists but does not display: Real World Value Mapping (SUV factors) and RT Plan",
    "files": files,
    "source": "synthetic, made by make-listed.py",
    "licence": "CC0 (synthetic)",
    "notes": "RWVM: SUVbw mapping (slope 0.00214634) for a PET image not in the share; RT Plan: one fraction group, one static 6 MV beam, no structure set or dose. No pixel data.",
    "fileDetails": [{"file": f, "sha256": hashlib.sha256((out / f).read_bytes()).hexdigest(), "sizeBytes": (out / f).stat().st_size} for f in files],
    "references": [],
}
man["cases"] = [c for c in man["cases"] if c["id"] != CASE] + [case]
(HERE / "samples.json").write_text(json.dumps(man, indent=1) + "\n")
print(CASE, [(f, (out / f).stat().st_size) for f in files])
