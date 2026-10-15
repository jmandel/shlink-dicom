"""Derived test cases built from the public samples (run after fetch-samples.py):

  icc-photo   Visible Light Photographic Images (1.2.840.10008.5.1.4.1.1.77.1.4) carrying, at the top
              level, the ICC profiles and RGB pixels of the two slide thumbnails in case "icc"
              (IDC tcga_gbm, CC BY 3.0). One profile is LUT-based (A2B0 mft2, Lab PCS), one
              matrix/TRC. The slide viewer reads profiles from the Optical Path Sequence; this
              case exercises the photo path. References: the pixels through LittleCMS (Pillow
              ImageCms), relative colorimetric to sRGB, as references/<name>.srgb.png.

  uv run --no-project --with pydicom==3.0.2 --with pillow --with numpy python web/checks/objects/make-derived.py
  float-maps  Copies of the four Float Pixel Data cases of codec-corpus/formats/uncompressed (three
              IDC tcga_gbm Parametric Maps, CC BY 3.0, and cornerstone3D paramap-float.dcm, MIT),
              with reference renderings: real values (Real World Value Mapping) through a
              LINEAR_EXACT window (the file's, else the mapped range, else the data range),
              missing values black, as references/<file>.f<frame>.png.

  pmap-overlay  A float Parametric Map made over five slices of case volume-ct (copied with it): half
              the CT's resolution, values 0–100 % (Real World Value Mapping range 0–100), a
              missing-value corner; frame 1 names its source image, the others match by position.

  mpr-josh-ct, mpr-oblique-mr  Series of the Josh Example sample (data/samples, as extracted by
              sample-originals.py): the CT's 5 mm axial series (anisotropic: 0.83 mm pixels) and the
              MRI's FLAIR COR (an oblique acquisition, about 4.8° off coronal).

  mpr-tilt    The five-slice-spaced middle of case volume-ct with a 15° gantry tilt: each slice's
              position moved along its column direction by k·Δz·tan 15° (pixels unchanged), and
              Gantry/Detector Tilt set.

Adds the case to samples.json (replacing an earlier entry of the same id)."""
import hashlib, io, json
from pathlib import Path
import numpy as np
import pydicom
from pydicom.uid import generate_uid, ExplicitVRLittleEndian
from PIL import Image, ImageCms

HERE = Path(__file__).parent
man = json.loads((HERE / "samples.json").read_text())
root = Path(man["dataRoot"])
src = next(c for c in man["cases"] if c["id"] == "icc")
out_dir = root / "icc-photo"
(out_dir / "references").mkdir(parents=True, exist_ok=True)
study = generate_uid(entropy_srcs=['icc-photo study'])
files, details, refs = [], [], []
for k, f in enumerate(src["files"]):
    ds = pydicom.dcmread(root / "icc" / f)
    prof = bytes(ds.OpticalPathSequence[0].ICCProfile) if "OpticalPathSequence" in ds else bytes(ds.ICCProfile)
    rgb = ds.pixel_array.astype(np.uint8)
    if ds.PhotometricInterpretation != "RGB":
        raise SystemExit(f"{f}: {ds.PhotometricInterpretation}")
    p = pydicom.Dataset()
    p.file_meta = pydicom.dataset.FileMetaDataset()
    p.file_meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.77.1.4"
    p.file_meta.MediaStorageSOPInstanceUID = generate_uid(entropy_srcs=[f"icc-photo instance {k}"])
    p.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    p.SOPClassUID = p.file_meta.MediaStorageSOPClassUID
    p.SOPInstanceUID = p.file_meta.MediaStorageSOPInstanceUID
    p.StudyInstanceUID = study
    p.SeriesInstanceUID = generate_uid(entropy_srcs=[f"icc-photo series {k}"])
    p.Modality = "XC"
    p.PatientName = "TEST^ICC"
    p.PatientID = "ICC01"
    p.StudyDescription = "ICC profile test (slide thumbnails as photographs)"
    p.SeriesDescription = f"Photo with {'LUT' if b'A2B0' in prof[128:2000] else 'matrix'} ICC profile"
    p.SeriesNumber = k + 1
    p.InstanceNumber = 1
    p.SamplesPerPixel = 3
    p.PhotometricInterpretation = "RGB"
    p.PlanarConfiguration = 0
    p.Rows, p.Columns = rgb.shape[:2]
    p.BitsAllocated = p.BitsStored = 8
    p.HighBit = 7
    p.PixelRepresentation = 0
    p.ICCProfile = prof
    p.PixelData = rgb.tobytes()
    name = f"vl-photo-{k + 1}.dcm"
    p.save_as(out_dir / name, enforce_file_format=True)
    # Reference: LittleCMS, profile → sRGB.
    im = Image.fromarray(rgb, "RGB")
    srgb = ImageCms.createProfile("sRGB")
    t = ImageCms.buildTransform(ImageCms.ImageCmsProfile(io.BytesIO(prof)), srgb, "RGB", "RGB", renderingIntent=ImageCms.Intent.PERCEPTUAL)
    ImageCms.applyTransform(im, t).save(out_dir / "references" / f"{name}.srgb.png")
    files.append(name)
    data = (out_dir / name).read_bytes()
    desc = ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(io.BytesIO(prof))).strip()
    details.append({"file": name, "sha256": hashlib.sha256(data).hexdigest(), "sizeBytes": len(data), "iccDescription": desc})
    refs.append({"file": name, "output": f"references/{name}.srgb.png", "command": "Pillow ImageCms (LittleCMS 2), perceptual, profile → sRGB"})
case = {
    "id": "icc-photo",
    "feature": "ICC profile on a photographic image (top-level ICC Profile)",
    "files": files,
    "source": "derived by make-derived.py from case icc (IDC tcga_gbm slide thumbnails)",
    "licence": "CC BY 3.0 (derived)",
    "sopClass": "1.2.840.10008.5.1.4.1.1.77.1.4",
    "notes": "Pixels and profiles from case icc, rewritten as VL Photographic Images",
    "fileDetails": details,
    "references": refs,
}
man["cases"] = [c for c in man["cases"] if c["id"] != "icc-photo"] + [case]
(HERE / "samples.json").write_text(json.dumps(man, indent=1) + "\n")
print("icc-photo:", files)


# ----------------------------------------------------------------------------- synthetic objects
# No public Encapsulated CDA, DICOM audio waveform or Encapsulated OBJ/MTL was found (see
# samples.json "tried"), so these are made here: fictional patient, generated UIDs.

def base_ds(sop_class, k, modality, study, series_desc):
    p = pydicom.Dataset()
    p.file_meta = pydicom.dataset.FileMetaDataset()
    p.file_meta.MediaStorageSOPClassUID = sop_class
    p.file_meta.MediaStorageSOPInstanceUID = generate_uid(entropy_srcs=[f"{series_desc} instance {k}"])
    p.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    p.SOPClassUID, p.SOPInstanceUID = sop_class, p.file_meta.MediaStorageSOPInstanceUID
    p.StudyInstanceUID = study
    p.SeriesInstanceUID = generate_uid(entropy_srcs=[f"{series_desc} series"])
    p.Modality = modality
    p.PatientName, p.PatientID = "TEST^SYNTHETIC", "SYN0002"
    p.StudyDescription = "Synthetic objects"
    p.SeriesDescription = series_desc
    p.SeriesNumber, p.InstanceNumber = k + 1, 1
    p.ContentDate = "20260101"
    return p


def add_case(cid, feature, files, notes):
    global man
    data = [{"file": f, "sha256": hashlib.sha256((root / cid / f).read_bytes()).hexdigest(), "sizeBytes": (root / cid / f).stat().st_size} for f in files]
    man["cases"] = [c for c in man["cases"] if c["id"] != cid] + [{
        "id": cid, "feature": feature, "files": files, "source": "synthetic, made by make-derived.py", "licence": "CC0 (synthetic)", "notes": notes, "fileDetails": data, "references": [],
    }]


syn_dir = root / "synthetic-objects"
syn_dir.mkdir(parents=True, exist_ok=True)
study2 = generate_uid(entropy_srcs=["synthetic objects study"])

# Encapsulated CDA: a structured body with a narrative table and list.
cda = """<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <title>Discharge summary (synthetic)</title>
  <component><structuredBody>
    <component><section><title>Findings</title><text><paragraph>No acute abnormality. <content styleCode="Bold">Synthetic test document.</content></paragraph>
      <list><item>First item</item><item>Second item</item></list></text></section></component>
    <component><section><title>Measurements</title><text><table><thead><tr><th>Name</th><th>Value</th></tr></thead>
      <tbody><tr><td>Length</td><td>12 mm</td></tr><tr><td>Width</td><td>8 mm</td></tr></tbody></table></text></section></component>
    <component><section><title>Plan</title><text>Follow up in six months.</text></section></component>
  </structuredBody></component>
</ClinicalDocument>"""
p = base_ds("1.2.840.10008.5.1.4.1.1.104.2", 0, "DOC", study2, "CDA document")
p.DocumentTitle = "Discharge summary (synthetic)"
p.MIMETypeOfEncapsulatedDocument = "text/xml"
p.BurnedInAnnotation = "NO"
p.EncapsulatedDocument = cda.encode() + (b"\0" if len(cda.encode()) % 2 else b"")
p.save_as(syn_dir / "cda.dcm", enforce_file_format=True)

# Basic Voice Audio: 2 s of 8 kHz mu-law, a 440 Hz tone that rises to 880 Hz.
t = np.arange(16000) / 8000.0
x = 0.5 * np.sin(2 * np.pi * (440 + 220 * t) * t)
# G.711 mu-law bytes are the complement of the companded magnitude with the sign in bit 7.
def ulaw(v):
    s = int(v * 32767)
    BIAS, CLIP = 0x84, 32635
    sign = 0x80 if s < 0 else 0
    s = min(abs(s), CLIP) + BIAS
    exp = 7
    for e in range(7, -1, -1):
        if s & (0x4000 >> (7 - e)):
            exp = e
            break
    else:
        exp = 0
    mant = (s >> (exp + 3)) & 0x0F
    return ~(sign | (exp << 4) | mant) & 0xFF
audio = bytes(ulaw(v) for v in x)
p = base_ds("1.2.840.10008.5.1.4.1.1.9.4.1", 1, "AU", study2, "Voice note")
w = pydicom.Dataset()
w.WaveformOriginality = "ORIGINAL"
w.NumberOfWaveformChannels = 1
w.NumberOfWaveformSamples = len(audio)
w.SamplingFrequency = 8000
w.MultiplexGroupLabel = "Voice"
ch = pydicom.Dataset()
src = pydicom.Dataset(); src.CodeValue, src.CodingSchemeDesignator, src.CodeMeaning = "AUDIO", "99SYN", "Audio channel"
ch.ChannelSourceSequence = [src]
ch.ChannelLabel = "Voice"
ch.WaveformBitsStored = 8
w.ChannelDefinitionSequence = [ch]
w.WaveformBitsAllocated = 8
w.WaveformSampleInterpretation = "MB"
w.WaveformData = audio + (b"\0" if len(audio) % 2 else b"")
p.WaveformSequence = [w]
p.save_as(syn_dir / "audio.dcm", enforce_file_format=True)

# Encapsulated OBJ (a cube, two materials) and the MTL it refers to.
mtl = b"newmtl red\nKd 0.9 0.2 0.2\nnewmtl blue\nKd 0.2 0.3 0.9\n"
obj = b"""v -10 -10 -10\nv 10 -10 -10\nv 10 10 -10\nv -10 10 -10\nv -10 -10 10\nv 10 -10 10\nv 10 10 10\nv -10 10 10
usemtl red
f 1 2 3 4\nf 5 8 7 6\nf 1 5 6 2
usemtl blue
f 2 6 7 3\nf 3 7 8 4\nf 5 1 4 8
"""
pm = base_ds("1.2.840.10008.5.1.4.1.1.104.5", 2, "M3D", study2, "Cube material")
pm.MIMETypeOfEncapsulatedDocument = "model/mtl"
pm.EncapsulatedDocument = mtl
pm.save_as(syn_dir / "cube.mtl.dcm", enforce_file_format=True)
po = base_ds("1.2.840.10008.5.1.4.1.1.104.4", 3, "M3D", study2, "Cube")
po.MIMETypeOfEncapsulatedDocument = "model/obj"
ref = pydicom.Dataset(); ref.ReferencedSOPClassUID, ref.ReferencedSOPInstanceUID = pm.SOPClassUID, pm.SOPInstanceUID
po.ReferencedSOPSequence = [ref]
po.EncapsulatedDocument = obj + (b"\0" if len(obj) % 2 else b"")
po.save_as(syn_dir / "cube.obj.dcm", enforce_file_format=True)

add_case("synthetic-objects", "Encapsulated CDA, Basic Voice Audio waveform, Encapsulated OBJ with MTL (no public samples found)",
         ["cda.dcm", "audio.dcm", "cube.mtl.dcm", "cube.obj.dcm"], "CDA: 3 sections, a table and a list; audio: 2 s of 8 kHz mu-law; OBJ: a cube of 12 triangles, 6 red and 6 blue")

# ----------------------------------------------------------------------------- float pixel data

import shutil, math
from floatref import float_real, float_window

corpus = HERE.parents[2] / "codec-corpus" / "formats" / "uncompressed" / "samples"
fm_dir = root / "float-maps"
(fm_dir / "references").mkdir(parents=True, exist_ok=True)
fm_files = ["idc-lt-sop-1-2-840-10008-9c519f08.dcm", "idc-lt-sop-1-2-840-10008-a1cc97dd.dcm", "idc-lt-sop-1-2-840-10008-eb217aa0.dcm", "ext-cs3d-paramap-float.dcm"]
for f in fm_files:
    shutil.copyfile(corpus / f, fm_dir / f)
    ds = pydicom.dcmread(fm_dir / f)
    real = float_real(ds)
    c, w = float_window(ds, real)
    for k in sorted({0, real.shape[0] // 2}):
        y = np.clip((real[k] - c) / w + 0.5, 0, 1)
        lv = np.where(np.isnan(real[k]), 0, np.floor(y * 255 + 0.5)).astype(np.uint8)
        Image.fromarray(lv, "L").convert("RGB").save(fm_dir / "references" / f"{f}.f{k}.png")
add_case("float-maps", "Float Pixel Data parametric maps (codec-corpus cases), with numpy reference renderings", fm_files,
         "Three IDC tcga_gbm Aggressiveness Score Maps (CC BY 3.0, window 0.5/1 in the file) and cornerstone3D paramap-float.dcm (MIT; ADC in m2/s, 20 frames, no window)")
man["cases"][-1]["licence"] = ["CC BY 3.0 (IDC collection tcga_gbm)", "MIT (cornerstonejs/cornerstone3D test images)"]
man["cases"][-1]["source"] = "codec-corpus/formats/uncompressed/cases.json (ids as the file names)"

# A float parametric map over five CT slices.
vc = next(c for c in man["cases"] if c["id"] == "volume-ct")
cts = sorted((pydicom.dcmread(root / "volume-ct" / f) for f in vc["files"]), key=lambda d: float(d.ImagePositionPatient[2]))
mid = len(cts) // 2
picked = cts[mid - 2: mid + 3]
po_dir = root / "pmap-overlay"
po_dir.mkdir(parents=True, exist_ok=True)
ct_names = []
for d in picked:
    n = f"ct-{d.InstanceNumber:04d}.dcm"
    d.save_as(po_dir / n)
    ct_names.append(n)
ct0 = picked[0]
R, C = int(ct0.Rows) // 2, int(ct0.Columns) // 2
sr, sc = float(ct0.PixelSpacing[0]), float(ct0.PixelSpacing[1])
iop = [float(v) for v in ct0.ImageOrientationPatient]
rowd, cold = np.array(iop[:3]), np.array(iop[3:])
yy, xx = np.mgrid[0:R, 0:C]
pm = base_ds("1.2.840.10008.5.1.4.1.1.30", 0, "CT", str(ct0.StudyInstanceUID), "Perfusion fraction (synthetic)")
pm.StudyInstanceUID = ct0.StudyInstanceUID
pm.PatientName, pm.PatientID = ct0.PatientName, ct0.PatientID
pm.FrameOfReferenceUID = ct0.FrameOfReferenceUID
pm.SeriesNumber = 900
pm.ImageType = ["DERIVED", "PRIMARY"]
pm.ContentLabel = "FRACTION"
pm.ContentDescription = "Synthetic map for overlay checks"
pm.SamplesPerPixel = 1
pm.PhotometricInterpretation = "MONOCHROME2"
pm.Rows, pm.Columns = R, C
pm.BitsAllocated = 32
pm.NumberOfFrames = len(picked)
frames, per = [], []
for k, d in enumerate(picked):
    # Distance from a point that moves with the slice: 0 % at it, 100 % at 120 map pixels.
    v = np.clip(np.hypot(xx - C * (0.4 + 0.05 * k), yy - R * 0.5) / 120.0 * 100.0, 0, 100).astype(np.float32)
    v[:8, :8] = np.nan
    frames.append(v)
    fg = pydicom.Dataset()
    pos = np.array([float(x) for x in d.ImagePositionPatient]) + rowd * (sc / 2) + cold * (sr / 2)
    pp = pydicom.Dataset(); pp.ImagePositionPatient = [f"{x:.6f}" for x in pos]
    fg.PlanePositionSequence = [pp]
    if k == 0:
        src_img = pydicom.Dataset(); src_img.ReferencedSOPClassUID, src_img.ReferencedSOPInstanceUID = d.SOPClassUID, d.SOPInstanceUID
        der = pydicom.Dataset(); der.SourceImageSequence = [src_img]
        fg.DerivationImageSequence = [der]
    per.append(fg)
pm.PerFrameFunctionalGroupsSequence = per
sh = pydicom.Dataset()
po = pydicom.Dataset(); po.ImageOrientationPatient = ct0.ImageOrientationPatient; sh.PlaneOrientationSequence = [po]
meas = pydicom.Dataset(); meas.PixelSpacing = [sr * 2, sc * 2]; meas.SliceThickness = ct0.SliceThickness; sh.PixelMeasuresSequence = [meas]
rw = pydicom.Dataset()
rw.LUTLabel = "Fraction"
rw.LUTExplanation = "Synthetic fraction"
rw.RealWorldValueIntercept, rw.RealWorldValueSlope = 0.0, 1.0
rw.DoubleFloatRealWorldValueFirstValueMapped, rw.DoubleFloatRealWorldValueLastValueMapped = 0.0, 100.0
u = pydicom.Dataset(); u.CodeValue, u.CodingSchemeDesignator, u.CodeMeaning = "%", "UCUM", "Percent"
rw.MeasurementUnitsCodeSequence = [u]
sh.RealWorldValueMappingSequence = [rw]
pm.SharedFunctionalGroupsSequence = [sh]
rs = pydicom.Dataset(); rs.SeriesInstanceUID = ct0.SeriesInstanceUID
rs.ReferencedInstanceSequence = []
for d in picked:
    r = pydicom.Dataset(); r.ReferencedSOPClassUID, r.ReferencedSOPInstanceUID = d.SOPClassUID, d.SOPInstanceUID
    rs.ReferencedInstanceSequence.append(r)
pm.ReferencedSeriesSequence = [rs]
pm.FloatPixelData = np.stack(frames).astype("<f4").tobytes()
pm.save_as(po_dir / "pmap.dcm", enforce_file_format=True)
add_case("pmap-overlay", "Float Parametric Map over CT slices (synthetic map, CT from volume-ct)", ct_names + ["pmap.dcm"],
         "Map: 5 frames at half the CT's resolution, 0–100 % with the Real World Value Mapping range 0–100, NaN in the top-left 8x8; frame 1 has a Derivation Image source, frames 2–5 match by position")
man["cases"][-1]["licence"] = ["CC BY 4.0 (IDC collection pancreatic_ct_cbct_seg) for the CT", "CC0 (synthetic) for the map"]


# ----------------------------------------------------------------------------- reformats

import glob
sample = Path("/media/barracuda/shlink-sample-orig")
def sample_series(archive, description):
    files = sorted(glob.glob(str(sample / "*" / archive / "*" / "*.dcm")))
    out = [f for f in files if str(pydicom.dcmread(f, stop_before_pixels=True).get("SeriesDescription", "")) == description]
    if not out:
        raise SystemExit(f"{archive}: no series {description!r} (run web/checks/sample-originals.py first)")
    return out

for cid, archive, desc, feature in [
    ("mpr-josh-ct", "ct-abdomen-pelvis-2012", "ABD/PEL", "Josh Example CT, 5 mm axial (anisotropic), for reformats"),
    ("mpr-oblique-mr", "mri-brain-2020", "FLAIR COR", "Josh Example MRI FLAIR COR, an oblique acquisition, for reformats"),
]:
    d = root / cid
    d.mkdir(parents=True, exist_ok=True)
    names = []
    for f in sample_series(archive, desc):
        names.append(Path(f).name)
        shutil.copyfile(f, d / Path(f).name)
    add_case(cid, feature, names, "copied from the Josh Example sample (public, de-identified)")
    man["cases"][-1]["licence"] = "Josh Example sample: published by Josh Mandel for testing"

vt = root / "mpr-tilt"
vt.mkdir(parents=True, exist_ok=True)
tilt = math.radians(15)
cts = sorted((pydicom.dcmread(root / "volume-ct" / f) for f in next(c for c in man["cases"] if c["id"] == "volume-ct")["files"]), key=lambda d: float(d.ImagePositionPatient[2]))
names = []
for k, d in enumerate(cts):
    row = np.array([float(x) for x in d.ImageOrientationPatient[:3]]); colv = np.array([float(x) for x in d.ImageOrientationPatient[3:]])
    nrm = np.cross(row, colv)
    p0 = np.array([float(x) for x in cts[0].ImagePositionPatient])
    dz = float(np.dot(np.array([float(x) for x in d.ImagePositionPatient]) - p0, nrm))
    pos = np.array([float(x) for x in d.ImagePositionPatient]) + colv * dz * math.tan(tilt)
    d.ImagePositionPatient = [f"{x:.6f}" for x in pos]
    d.GantryDetectorTilt = "15"
    d.SeriesInstanceUID = generate_uid(entropy_srcs=["mpr-tilt series"])
    d.SOPInstanceUID = d.file_meta.MediaStorageSOPInstanceUID = generate_uid(entropy_srcs=[f"mpr-tilt {k}"])
    d.SeriesDescription = "Synthetic 15 degree gantry tilt"
    n = f"tilt-{k:03d}.dcm"
    d.save_as(vt / n)
    names.append(n)
add_case("mpr-tilt", "CT with a 15° gantry tilt (synthetic: volume-ct with sheared slice positions), for reformats", names,
         "Positions moved along the column direction by k·Δz·tan 15°; pixel data unchanged")
man["cases"][-1]["licence"] = ["CC BY 4.0 (IDC collection pancreatic_ct_cbct_seg)"]

(HERE / "samples.json").write_text(json.dumps(man, indent=1) + "\n")
print("synthetic-objects, float-maps and pmap-overlay, mpr cases written")
