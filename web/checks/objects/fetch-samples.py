"""Fetch the DICOM object-type and display-fidelity sample set, render DCMTK references, write samples.json.

    uv run --project codec-corpus python web/checks/objects/fetch-samples.py [--out DIR] [--no-refs] [--only CASE ...]

Data goes to --out (default /media/barracuda/shlink-dicom-objects/<case-id>/), not into git.
Every file is pinned by sha256 in samples.json after the first run; later runs verify against it.

Sources (in order of preference used when picking):
  pydicom test data (pydicom.data.get_testdata_file), GDCM gdcmData, highdicom, dcm4che, fo-dicom,
  orthanc-tests, David Clunie's deflate test set, itk-wasm-testing-data, dcm2bq, and NCI Imaging
  Data Commons (public S3 bucket; the instance list is idc-selection.json, chosen with the SQL in sql/).
Local clones under ~/.cache/shl-quirks (made by codec-corpus/scripts/sources/quirks.py) are used
when present; otherwise the file is downloaded from its public URL.

References (DCMTK 3.7, /usr/bin), written to <case>/references/, commands run from the case folder:
  dcmdump FILE                               every file
  dcm2img --write-png FILE OUT               every file with pixel data (frame 1; overlays drawn by default)
  dcm2img --write-png +Wi n FILE OUT         for each stored window n (Window Center/Width)
  dcm2img --write-png +Wl n FILE OUT         for each VOI LUT Sequence item n
  dcm2img --write-png -O FILE OUT            files with 60xx overlays (overlays suppressed)
  dsr2html FILE OUT                          SR and KOS
  dcmp2pgm -p PR IMAGE OUT.pgm + magick      GSPS whose referenced image is in the case
  dcmdecap FILE OUT                          encapsulated PDF/CDA/STL
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import urllib.parse
import urllib.request
from pathlib import Path

import pydicom
from pydicom.uid import UID

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "samples.json"
IDC_SELECTION = HERE / "idc-selection.json"
QUIRKS = Path.home() / ".cache" / "shl-quirks"

LIC = {
    "pydicom": "MIT (pydicom/pydicom-data test data; see pydicom data/test_files/README.txt for each file's origin)",
    "gdcm": "GDCM licence (BSD-3-Clause style), gdcmData test images, redistributed as in pydicom's test data",
    "highdicom": "MIT (ImagingDataCommons/highdicom data/test_files)",
    "dcm4che": "MPL-1.1 / GPL-2.0 / LGPL-2.1 (dcm4che tri-licence; dcm4che-test-data)",
    "fodicom": "MS-PL (fo-dicom test data)",
    "orthanc": "GPL-3.0 (orthanc-tests repository Database/; file from a public issue report)",
    "clunie": "David Clunie public test images (dclunie.com, freely distributed, no explicit licence)",
    "dcm2bq": "Apache-2.0 (GoogleCloudPlatform/dcm2bq test data); embedded PDF is NationalRad's public sample report",
}

URL = {
    "gdcm": "https://sourceforge.net/p/gdcm/gdcmdata/ci/master/tree/{p}?format=raw",
    "highdicom": "https://raw.githubusercontent.com/ImagingDataCommons/highdicom/master/data/test_files/{p}",
    "dcm4che": "https://raw.githubusercontent.com/dcm4che/dcm4che/master/dcm4che-test-data/src/main/resources/{p}",
    "fodicom": "https://raw.githubusercontent.com/fo-dicom/fo-dicom/development/Tests/{p}",
    "orthanc": "https://orthanc.uclouvain.be/hg/orthanc-tests/raw-file/tip/Database/{p}",
    "itk": "https://gin.g-node.org/InsightSoftwareConsortium/itk-wasm-testing-data/raw/main/test/Input/{p}",
    "dcm2bq": "https://media.githubusercontent.com/media/GoogleCloudPlatform/dcm2bq/main/test/files/dcm/{p}",
    "clunie": "https://www.dclunie.com/images/compressed/deflate_tests_release.tar.gz#{p}",
}
LOCAL = {
    "gdcm": QUIRKS / "gdcmData",
    "dcm4che": QUIRKS / "dcm4che",
    "fodicom": QUIRKS / "fo-dicom" / "Tests",
    "orthanc": QUIRKS / "orthanc",
    "clunie": QUIRKS / "clunie" / "deflate",
}


def S(kind, p, dest=None, **extra):
    return dict(kind=kind, p=p, dest=dest or Path(p).name, **extra)


# Hand-written case list. IDC files for a case come from idc-selection.json[case id] (kind "idc").
CASES = [
    dict(id="sr-measurement", feature="TID 1500 Measurement Report (Enhanced SR) with image and SEG references",
         notes="QIN-Prostate-Repeatability. Enhanced SR, TID 1500 'Imaging Measurement Report' for the ADC series: "
               "per-lesion measurement groups (volume, ADC statistics) that reference the SEG segments (Referenced Segment) "
               "and the 20 ADC MR source images. The referenced SEG (BINARY, 80 frames) and the whole ADC MR series are included.",
         files=[]),
    dict(id="sr-dose", feature="X-Ray Radiation Dose SR (CT dose, TID 10011)",
         notes="COVID-19-NY-SBU. X-Ray Radiation Dose SR SOP 1.2.840.10008.5.1.4.1.1.88.67, TID 10011 CT Radiation Dose report "
               "(CT accumulated dose data, per-acquisition CTDIvol/DLP). The only dose SR in IDC. Dose SRs reference the "
               "procedure step, not images, so no image series is included.",
         files=[]),
    dict(id="sr-basic-or-enhanced", feature="Basic Text, Enhanced and Comprehensive text SR",
         notes="Three text SRs: Basic Text SR (pydicom reportsi.dcm: CONTAINER with CODE, TEXT, PNAME and two IMAGE items whose referenced images are not available), "
               "Enhanced SR (Clunie deflate test 'report', uncompressed variant), and Comprehensive SR TID 4200 Breast Imaging "
               "Report (IDC BREAST-DIAGNOSIS, PixelMed conversion of a structured breast report).",
         files=[S("pydicom", "reportsi.dcm", "basic-text-sr_reportsi.dcm"),
                S("clunie", "deflate_tests/report", "enhanced-sr_clunie-report.dcm")]),
    dict(id="pdf", feature="Encapsulated PDF",
         notes="Two Encapsulated PDF instances (1.2.840.10008.5.1.4.1.1.104.1): dcm2bq test file (DCMTK-made, wraps a one-page "
               "NationalRad sample radiology report; empty patient module) and an itk-wasm test file that wraps a Chrome-printed "
               "rendering of the BREAST-DIAGNOSIS TID 4200 SR (patient 'Breast Diagnosis 010001'). IDC has no Encapsulated PDF.",
         files=[S("dcm2bq", "pdf.dcm", "dcm2bq-pdf.dcm"),
                S("itk", "104.1-SR-printed-to-pdf.dcm", "itk-104.1-SR-printed-to-pdf.dcm",
                  licence="itk-wasm-testing-data (no licence file; itk-wasm is Apache-2.0); content derived from TCIA BREAST-DIAGNOSIS (CC BY 3.0)")]),
    dict(id="cda", feature="Encapsulated CDA", found=False, files=[],
         notes="No public Encapsulated CDA (1.2.840.10008.5.1.4.1.1.104.2) instance found.",
         tried="IDC dicom_all SOP class census (none); GitHub code search for the SOP class UID and for *cda*.dcm files; "
               "pydicom, GDCM, dcm4che, fo-dicom, orthanc-tests, highdicom, itk-wasm test data; web search. "
               "One could be made with DCMTK cda2dcm/dcmencap from a public HL7 C-CDA sample, but that would be synthetic."),
    dict(id="seg", feature="Segmentation: binary with referenced MR series, plus fractional with referenced CT",
         notes="(1) PROSTATE-MRI-US-BIOPSY (IDC): two BINARY SEGs (prostate gland; lesion 1), 21 frames each, one per source "
               "slice, Derivation/Source Image references to the included 21-slice AX T2 MR series. "
               "(2) highdicom test data: seg_image_ct_true_fractional.dcm (FRACTIONAL, PROBABILITY, Maximum Fractional Value) "
               "and seg_image_ct_binary.dcm, both referencing the included highdicom ct_image.dcm.",
         files=[S("highdicom", "seg_image_ct_true_fractional.dcm", "highdicom/seg_image_ct_true_fractional.dcm"),
                S("highdicom", "seg_image_ct_binary.dcm", "highdicom/seg_image_ct_binary.dcm"),
                S("highdicom", "ct_image.dcm", "highdicom/ct_image.dcm")]),
    dict(id="rtstruct", feature="RT Structure Set with referenced CT series",
         notes="Pediatric-CT-SEG (IDC). RTSTRUCT (2.8 MB, many organ ROIs as CLOSED_PLANAR contours) whose Contour Image "
               "Sequence references all 42 slices of the included CT series (512x512, implicit VR).",
         files=[]),
    dict(id="pmap", feature="Parametric Map",
         notes="(1) TCGA-GBM (IDC): 'Aggressiveness Score Map' Parametric Map (float, 120x90, one frame) derived from a "
               "whole-slide image; it references base level instance ...1637519535681.8.0 (43 MB, not included). Included instead "
               "are three lower-resolution instances of that same slide series (levels .22.0 and .29.0, thumbnail .15.0), which "
               "share the Frame of Reference and Total Pixel Matrix geometry. "
               "(2) pydicom parametric_map_float.dcm (128x128 float, no referenced images). Both maps use Float Pixel Data (7FE0,0008) "
               "with a Real World Value Mapping; DCMTK dcm2img cannot render Float Pixel Data, so only dcmdump references exist "
               "for them (the slide levels have PNG renders).",
         files=[S("pydicom", "parametric_map_float.dcm", "pydicom/parametric_map_float.dcm")]),
    dict(id="gsps", feature="Grayscale Softcopy Presentation State with referenced images",
         notes="(1) RIDER Lung CT (IDC): two GSPS, each referencing one included CT slice: Softcopy VOI LUT (window -600/1200) "
               "and Displayed Area Selection (MAGNIFY with Presentation Pixel Magnification Ratio in one, SCALE TO FIT crop in "
               "the other). A Comprehensive SR 'Lesion Designator' references the first GSPS and its image. IDC GSPS have no "
               "graphic annotations. (2) orthanc-tests Issue168.dcm: GSPS from Lunit with Graphic Annotation Sequence (2 graphic "
               "objects, 4 text objects with CSS text style); its referenced image is not public, so it has no reference render. "
               "The dcmp2pgm references apply the GSPS VOI window; in these outputs the displayed-area crop/magnify is not "
               "visible (full 512x512 frame), so check displayed-area handling against the attribute values, not the PNG.",
         files=[S("orthanc", "Issue168.dcm", "orthanc-Issue168-gsps-graphics.dcm")]),
    dict(id="ps-blending", feature="Advanced Blending Presentation State (colour/blending PS)",
         notes="HTAN-WUSTL (IDC): Advanced Blending Presentation State referencing 4 channels of a multiplexed fluorescence "
               "slide. The referenced slide instances are not included, so the PS can only be listed. "
               "No public Colour Softcopy or Pseudo-colour PS was found.",
         files=[]),
    dict(id="kos", feature="Key Object Selection with referenced images",
         notes="(1) itk-wasm test file 88.59-KeyObjectSelection-SR.dcm: a QIN-Breast-DCE-MRI 'Manifest' KOS trimmed to 4 "
               "references in one series; the 4 referenced MR instances are included (from IDC). (The original IDC KOS lists "
               "3,584 instances in 28 series.) (2) fo-dicom GH1958.dcm: 'Of Interest' KOS with 9 references in 5 series; the "
               "referenced images are not public.",
         files=[S("itk", "88.59-KeyObjectSelection-SR.dcm", "itk-88.59-KeyObjectSelection-SR.dcm",
                  licence="itk-wasm-testing-data (no licence file; itk-wasm is Apache-2.0); derived from TCIA QIN-Breast-DCE-MRI (CC BY 3.0)"),
                S("fodicom", "FO-DICOM.Tests/Test Data/GH1958.dcm", "fodicom-GH1958-kos.dcm")]),
    dict(id="waveform-ecg", feature="12-lead ECG and haemodynamic waveforms",
         notes="pydicom waveform_ecg.dcm: 12-lead ECG Waveform Storage (two multiplex groups of 12 channels, 16-bit SS, 1000 Hz; 10,000 and 1,200 samples). Clunie "
               "deflate test 'wave': Hemodynamic Waveform Storage. No public General Audio Waveform instance was found "
               "(searched IDC census, test-data repositories, GitHub file search).",
         files=[S("pydicom", "waveform_ecg.dcm", "ecg-12lead_pydicom.dcm"),
                S("clunie", "deflate_tests/wave", "hemodynamic_clunie-wave.dcm")]),
    dict(id="model-stl", feature="Encapsulated STL",
         notes="PROSTATE-MRI-US-BIOPSY (IDC): two Encapsulated STL surfaces (prostate; lesion 1) from the same study as the "
               "seg case (Frame of Reference shared with that MR), 62 KB and 418 KB. "
               "No public Encapsulated OBJ/MTL (1.2.840.10008.5.1.4.1.1.104.4/.5) was found (IDC census, GitHub file search).",
         files=[]),
    dict(id="other-nonimage", feature="Objects a viewer can only list",
         notes="RT Plan (pydicom rtplan.dcm), RT Dose (pydicom rtdose.dcm; it has 15-frame dose-grid pixel data with "
               "Dose Grid Scaling), MR Spectroscopy (gdcmData MR_Spectroscopy_SIEMENS_OF.dcm, Spectroscopy Data instead of "
               "pixels), Real World Value Mapping (IDC CT-vs-PET-Ventilation-Imaging 'PET SUV Factors', references a 159-slice "
               "PET series that is not included).",
         files=[S("pydicom", "rtplan.dcm", "rtplan_pydicom.dcm"), S("pydicom", "rtdose.dcm", "rtdose_pydicom.dcm"),
                S("gdcm", "MR_Spectroscopy_SIEMENS_OF.dcm", "mrs_gdcm-MR_Spectroscopy_SIEMENS_OF.dcm")]),
    dict(id="modality-lut-seq", feature="Modality LUT Sequence",
         notes="pydicom mlut_18.dcm (IHE MESA display test image): Modality LUT Sequence with signed descriptor "
               "4096\\-2048\\16 and no Rescale. fo-dicom CR-ModalitySequenceLUT.dcm: CR with a Modality LUT Sequence "
               "(1024\\0\\16, 'CRTLUT') and also Rescale Slope/Intercept 1/0 present, although the standard allows only one of the two.",
         files=[S("pydicom", "mlut_18.dcm"), S("fodicom", "FO-DICOM.Tests/Test Data/CR-ModalitySequenceLUT.dcm", "fodicom-CR-ModalitySequenceLUT.dcm")]),
    dict(id="voi-lut-seq", feature="VOI LUT Sequence; VOI LUT Function SIGMOID and LINEAR_EXACT",
         notes="pydicom vlut_04.dcm (IHE MESA, one VOI LUT in VOI LUT Sequence). gdcmData DX_GE_FALCON_SNOWY-VOI.dcm "
               "(DX, VOI LUT Sequence with 3 LUTs of 16384 entries, plus 3 windows NORMAL/HARDER/SOFTER). IDC CMMD MG with "
               "VOI LUT Function SIGMOID (window 128/256, 8-bit). IDC CMB-CRC MR with VOI LUT Function LINEAR_EXACT "
               "(window 2046.5/4093).",
         files=[S("pydicom", "vlut_04.dcm"), S("gdcm", "DX_GE_FALCON_SNOWY-VOI.dcm", "gdcm-DX_GE_FALCON_SNOWY-VOI.dcm")]),
    dict(id="pres-lut-shape", feature="Presentation LUT Shape INVERSE",
         notes="IDC BREAST-DIAGNOSIS MG (512x512, MONOCHROME1) with Presentation LUT Shape INVERSE and windows; also only "
               "Imager Pixel Spacing.",
         files=[]),
    dict(id="window-presets", feature="Several Window Center/Width values with explanations",
         notes="gdcmData DX_GE_FALCON_SNOWY-VOI.dcm: 3 windows (4290/2612, 4290/1959, 4290/3919) explained NORMAL\\HARDER\\SOFTER, "
               "plus a VOI LUT Sequence. gdcmData CT-SIEMENS-Icone-With-PaletteColor.dcm: CT with 2 windows (40/350, -500/1500) "
               "explained WINDOW1\\WINDOW2 and a palette-colour icon.",
         files=[S("gdcm", "DX_GE_FALCON_SNOWY-VOI.dcm", "gdcm-DX_GE_FALCON_SNOWY-VOI.dcm"),
                S("gdcm", "CT-SIEMENS-Icone-With-PaletteColor.dcm", "gdcm-CT-SIEMENS-Icone-With-PaletteColor.dcm")]),
    dict(id="overlay-separate", feature="60xx overlay in Overlay Data (60xx,3000)",
         notes="pydicom/gdcm MR-SIEMENS-DICOM-WithOverlays.dcm: overlay group 6000, Overlay Bit Position 0, Overlay Data "
               "element, plus 2 windows and a palette icon.",
         files=[S("pydicom", "MR-SIEMENS-DICOM-WithOverlays.dcm")]),
    dict(id="overlay-highbits", feature="Overlays embedded in unused high bits of Pixel Data",
         notes="dcm4che-test-data ovly_p01.dcm: 4 overlay groups; 6000 at Overlay Bit Position 15 and 6002 at bit 14 live in "
               "the unused high bits of Pixel Data (no Overlay Data); 6004 and 6006 use separate Overlay Data. The burned-in text says 'You should see 6 lines of text identified as "
               "overlays 1 thru 6' but the file declares only these 4 overlay groups; DCMTK draws 4 labelled lines plus two "
               "unlabelled underlines.",
         files=[S("dcm4che", "ovly_p01.dcm", "dcm4che-ovly_p01.dcm")]),
    dict(id="icc", feature="ICC Profile (0028,2000)",
         notes="TCGA-GBM (IDC) whole-slide thumbnails (VL WSI, RGB, uncompressed): one with a 142 KB scanner ICC profile, "
               "one with a 3 KB sRGB profile and Color Space SRGB. (The pmap case's slide levels carry the 142 KB profile too.)",
         files=[]),
    dict(id="enhanced-mf", feature="Enhanced multi-frame with per-frame functional groups",
         notes="pydicom eCT_Supplemental.dcm: Enhanced CT (NEMA CT0012), 2 frames 512x512; per-frame Frame Content and "
               "Plane Position; shared Plane Orientation, Pixel Measures, Frame VOI LUT, Pixel Value Transformation, Real World "
               "Value Mapping; supplemental 16-bit palette colour LUT. fo-dicom mr_brucker.dcm: Enhanced MR (Bruker), 4 frames "
               "128x256 (non-square matrix); per-frame Frame Content and Plane Position; shared Plane Orientation and Pixel "
               "Measures. (pydicom emri_small.dcm was rejected: it has no functional group sequences.)",
         files=[S("pydicom", "eCT_Supplemental.dcm"), S("fodicom", "FO-DICOM.Tests/Test Data/mr_brucker.dcm", "fodicom-mr_brucker-enhanced-mr.dcm")]),
    dict(id="volume-ct", feature="Small CT volume for MPR",
         notes="Pancreatic-CT-CBCT-SEG (IDC): 64 contiguous axial slices, 384x384, 2.5 mm, uncompressed, one orientation.",
         files=[]),
    dict(id="cine-mf", feature="Multi-frame with Frame Time and with Frame Time Vector",
         notes="gdcmData XA-MONO2-8-12x-catheter.dcm: XA, 12 frames, Frame Time 33 ms. gdcmData GE_DLX-8-MONO2-Multiframe.dcm: "
               "XA, 56 frames 8-bit, implicit VR, Frame Time Vector (0, 80, 80, ... ms; first value 0 per the standard).",
         files=[S("gdcm", "XA-MONO2-8-12x-catheter.dcm", "gdcm-XA-MONO2-8-12x-catheter.dcm"),
                S("gdcm", "GE_DLX-8-MONO2-Multiframe.dcm", "gdcm-GE_DLX-8-MONO2-Multiframe.dcm")]),
    dict(id="calibration", feature="Pixel Spacing vs Imager Pixel Spacing; Pixel Spacing Calibration Type",
         notes="IDC MIDRC-RICORD-1c DX (JPEG lossless SV1): Pixel Spacing 0.194311 and Imager Pixel Spacing 0.2 with Pixel "
               "Spacing Calibration Type GEOMETRY and Description 'Corrected by the SOD and SID' (licence CC BY-NC 4.0). "
               "IDC BREAST-DIAGNOSIS MG: Imager Pixel Spacing 0.024 only, no Pixel Spacing.",
         files=[]),
]


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def download(url: str, dst: Path):
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "shlink-dicom-samples"})
    with urllib.request.urlopen(req, timeout=300) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f)
    tmp.replace(dst)


def obtain(spec: dict, dst: Path, cache: Path) -> str:
    """Put the file at dst; return a provenance string."""
    kind, p = spec["kind"], spec["p"]
    if kind == "pydicom":
        from pydicom.data import get_testdata_file
        src = get_testdata_file(p)
        shutil.copyfile(src, dst)
        return f"pydicom.data.get_testdata_file('{p}') (pydicom {pydicom.__version__})"
    if kind == "idc":
        url = f"https://{spec['aws_bucket']}.s3.amazonaws.com/{spec['crdc_series_uuid']}/{spec['crdc_instance_uuid']}.dcm"
        c = cache / "idc" / f"{spec['crdc_instance_uuid']}.dcm"
        if not c.exists():
            download(url, c)
        shutil.copyfile(c, dst)
        return url
    if kind == "clunie":
        tgz = cache / "clunie" / "deflate_tests_release.tar.gz"
        local = LOCAL["clunie"] / p
        if local.exists():
            shutil.copyfile(local, dst)
        else:
            if not tgz.exists():
                download(URL["clunie"].split("#")[0], tgz)
            with tarfile.open(tgz) as t:
                with t.extractfile(p) as f, open(dst, "wb") as o:
                    shutil.copyfileobj(f, o)
        return URL["clunie"].format(p=p)
    url = URL[kind].format(p=urllib.parse.quote(p))
    local = LOCAL.get(kind, Path("/nonexistent")) / p
    if local.exists():
        shutil.copyfile(local, dst)
    else:
        download(url, dst)
    return url


def describe(p: Path) -> dict:
    ds = pydicom.dcmread(p, force=True, defer_size=4096)
    sop = str(ds.get("SOPClassUID", ""))
    ts = str(ds.file_meta.get("TransferSyntaxUID", "")) if hasattr(ds, "file_meta") else ""
    feats = []
    for g in range(0x6000, 0x6020, 2):
        if (g, 0x0010) in ds:
            bp = ds.get((g, 0x0102))
            feats.append(f"overlay {g:04X}: bit position {bp.value if bp is not None else '-'}, "
                         f"{'Overlay Data' if (g, 0x3000) in ds else 'no Overlay Data'}")
    for kw in ["ModalityLUTSequence", "VOILUTSequence", "VOILUTFunction", "PresentationLUTShape", "ICCProfile",
               "ColorSpace", "FrameTime", "FrameTimeVector", "PerFrameFunctionalGroupsSequence", "PixelSpacing",
               "ImagerPixelSpacing", "PixelSpacingCalibrationType", "PixelSpacingCalibrationDescription", "WindowCenter",
               "WindowWidth", "WindowCenterWidthExplanation", "SegmentationType", "SegmentationFractionalType",
               "GraphicAnnotationSequence", "SoftcopyVOILUTSequence", "DisplayedAreaSelectionSequence",
               "WaveformSequence", "MIMETypeOfEncapsulatedDocument", "NumberOfFrames", "PhotometricInterpretation"]:
        if kw in ds:
            el = ds[kw]
            if el.VR == "SQ":
                feats.append(f"{kw} ({len(el.value)} item{'s' if len(el.value) != 1 else ''})")
            elif el.VR in ("OB", "OW", "UN"):
                feats.append(f"{kw} ({len(el.value)} bytes)")
            else:
                v = el.value
                v = "\\".join(str(x) for x in v) if isinstance(v, (list, pydicom.multival.MultiValue)) else str(v)
                feats.append(f"{kw}={v[:80]}")
    if "OpticalPathSequence" in ds and any("ICCProfile" in it for it in ds.OpticalPathSequence):
        feats.append("ICCProfile in OpticalPathSequence")
    try:
        sop_name = UID(sop).name
    except Exception:
        sop_name = sop
    return dict(sopClassUID=sop, sopClass=sop_name, transferSyntax=ts, modality=str(ds.get("Modality", "")),
                sopInstanceUID=str(ds.get("SOPInstanceUID", "")), seriesInstanceUID=str(ds.get("SeriesInstanceUID", "")),
                rows=ds.get("Rows"), columns=ds.get("Columns"), detected=feats,
                hasPixels=any(t in ds for t in ("PixelData", "FloatPixelData", "DoubleFloatPixelData")),
                nWindows=len(ds.WindowCenter) if "WindowCenter" in ds and ds["WindowCenter"].VM > 1 else (1 if "WindowCenter" in ds else 0),
                nVoiLuts=len(ds.get("VOILUTSequence", [])), hasOverlay=any((g, 0x0010) in ds for g in range(0x6000, 0x6020, 2)),
                refImage=[str(r.ReferencedSOPInstanceUID) for s in ds.get("ReferencedSeriesSequence", [])
                          for r in s.get("ReferencedImageSequence", [])])


def run(cmd: list[str], cwd: Path, refs: list, rel: str, out: str):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    ok = r.returncode == 0 and (cwd / out).exists()
    refs.append(dict(file=rel, output=out if ok else None, command=" ".join(_q(c) for c in cmd), ok=ok,
                     **({} if ok else {"error": (r.stderr or r.stdout).strip()[-300:]})))
    return ok


def _q(s: str) -> str:
    return s if all(c.isalnum() or c in "-_./+=:" for c in s) else "'" + s.replace("'", "'\\''") + "'"


def references(case_dir: Path, files: list[dict]) -> list[dict]:
    refdir = case_dir / "references"
    if refdir.exists():
        shutil.rmtree(refdir)
    refdir.mkdir()
    refs: list = []
    by_sop = {f["sopInstanceUID"]: f["path"] for f in files}
    for f in files:
        rel = f["path"]
        stem = "references/" + rel.replace("/", "__")
        with open(case_dir / (stem + ".dcmdump.txt"), "w") as o:
            r = subprocess.run(["dcmdump", rel], cwd=case_dir, stdout=o, stderr=subprocess.STDOUT)
        refs.append(dict(file=rel, output=stem + ".dcmdump.txt", command=f"dcmdump {_q(rel)}", ok=r.returncode == 0))
        sop = f["sopClassUID"]
        if sop.startswith("1.2.840.10008.5.1.4.1.1.88."):
            run(["dsr2html", rel, stem + ".html"], case_dir, refs, rel, stem + ".html")
        if sop.startswith("1.2.840.10008.5.1.4.1.1.104."):
            ext = {"104.1": "pdf", "104.2": "xml", "104.3": "stl", "104.4": "obj", "104.5": "mtl"}[sop.rsplit(".", 2)[-2] + "." + sop.rsplit(".", 1)[-1]]
            run(["dcmdecap", rel, f"{stem}.{ext}"], case_dir, refs, rel, f"{stem}.{ext}")
        if sop == "1.2.840.10008.5.1.4.1.1.11.1":
            for uid in f["refImage"]:
                if uid in by_sop:
                    img = by_sop[uid]
                    pgm = f"{stem}.applied-to.{img.replace('/', '__')}.pgm"
                    if run(["dcmp2pgm", "-p", rel, img, pgm], case_dir, refs, rel, pgm):
                        png = pgm[:-4] + ".png"
                        run(["magick", pgm, png], case_dir, refs, rel, png)
                        (case_dir / pgm).unlink()
        if f["hasPixels"] and sop not in ("1.2.840.10008.5.1.4.1.1.481.2",):
            variants = [("", [])]
            variants += [(f".win{n}", ["+Wi", str(n)]) for n in range(1, f["nWindows"] + 1)]
            variants += [(f".voilut{n}", ["+Wl", str(n)]) for n in range(1, f["nVoiLuts"] + 1)]
            if f["hasOverlay"]:
                variants.append((".no-overlays", ["-O"]))
            for suf, args in variants:
                out = f"{stem}{suf}.png"
                run(["dcm2img", "--write-png", *args, rel, out], case_dir, refs, rel, out)
    return refs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("/media/barracuda/shlink-dicom-objects"))
    ap.add_argument("--no-refs", action="store_true")
    ap.add_argument("--only", nargs="*")
    a = ap.parse_args()
    cache = a.out / "_cache"
    idc = json.loads(IDC_SELECTION.read_text())
    old = {c["id"]: c for c in json.loads(MANIFEST.read_text())["cases"]} if MANIFEST.exists() else {}
    pinned = {(c["id"], fd["path"]): fd["sha256"] for c in old.values() for fd in c.get("fileDetails", [])}
    out_cases = []
    for case in CASES:
        cid = case["id"]
        if a.only and cid not in a.only:
            if cid in old:
                out_cases.append(old[cid])
            continue
        case_dir = a.out / cid
        specs = list(case["files"])
        for r in idc.get(cid, []):
            sub = f"idc-{r['collection_id']}/{r['Modality'].lower()}-{r['SeriesInstanceUID'][-10:]}"
            specs.append(dict(kind="idc", p=r["SOPInstanceUID"], dest=f"{sub}/{r['SOPInstanceUID']}.dcm",
                              licence=f"{r['license_short_name']} (IDC collection {r['collection_id']})", **r))
        details = []
        for s in specs:
            dst = case_dir / s["dest"]
            dst.parent.mkdir(parents=True, exist_ok=True)
            src = obtain(s, dst, cache)
            d = describe(dst)
            digest = sha256(dst)
            want = pinned.get((cid, s["dest"]))
            if want and want != digest:
                raise SystemExit(f"{cid}/{s['dest']}: sha256 {digest} != pinned {want}")
            src_desc = src
            if s["kind"] == "idc":
                src_desc = (f"IDC {s['collection_id']} SeriesInstanceUID {s['SeriesInstanceUID']} "
                            f"SOPInstanceUID {s['SOPInstanceUID']} via {src}")
            elif s["kind"] in ("gdcm", "fodicom", "dcm4che", "orthanc", "highdicom", "itk", "dcm2bq", "clunie"):
                src_desc = f"{s['kind']} {s['p']}: {src}"
            details.append(dict(path=s["dest"], source=src_desc, licence=s.get("licence") or LIC[s["kind"]],
                                sizeBytes=dst.stat().st_size, sha256=digest, **d))
            print(f"  {cid}: {s['dest']} {dst.stat().st_size} {d['sopClass']}")
        refs = [] if a.no_refs or not details else references(case_dir, details)
        entry = dict(id=cid, feature=case["feature"], found=case.get("found", True),
                     files=[d["path"] for d in details],
                     source=sorted({d["source"].split(" via ")[0].split(" SOPInstanceUID")[0] if d["source"].startswith("IDC") else d["source"] for d in details}),
                     licence=sorted({d["licence"] for d in details}),
                     sopClass=sorted({d["sopClass"] for d in details}),
                     transferSyntax=sorted({UID(d["transferSyntax"]).name for d in details if d["transferSyntax"]}),
                     sizeBytes=sum(d["sizeBytes"] for d in details),
                     notes=case["notes"])
        if case.get("tried"):
            entry["tried"] = case["tried"]
        entry["references"] = [{k: v for k, v in r.items() if k != "ok"} | ({} if r["ok"] else {"failed": True}) for r in refs]
        entry["fileDetails"] = [{k: v for k, v in d.items() if k not in ("hasPixels", "nWindows", "nVoiLuts", "hasOverlay", "refImage")} for d in details]
        out_cases.append(entry)
    doc = dict(
        description="Real public DICOM samples for viewer object-type and display-fidelity work. Data lives outside git "
                    "under dataRoot/<id>/; rebuild with fetch-samples.py. references[] are DCMTK outputs (commands run "
                    "from the case folder).",
        dataRoot=str(a.out), dcmtk=subprocess.run(["dcm2img", "--version"], capture_output=True, text=True).stdout.splitlines()[0].strip(" $"),
        cases=out_cases)
    MANIFEST.write_text(json.dumps(doc, indent=1) + "\n")
    print(f"wrote {MANIFEST}: {len(out_cases)} cases, {sum(c['sizeBytes'] for c in out_cases) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
