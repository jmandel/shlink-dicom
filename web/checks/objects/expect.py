"""Expected values for the object checks, read with pydicom from the test set (samples.json).
   uv run --project codec-corpus python web/checks/objects/expect.py > /tmp/objects-expect.json
Per file: SOP class; SR content item and image reference counts; waveform channels and samples;
STL triangles; KOS references; SEG segments and frames; RT ROIs and contours (and, per image,
how many contours name it); PDF page count; presentation state windows."""
import json, re, struct, sys
from pathlib import Path
import pydicom
import numpy as np
from floatref import float_real, float_window, rw_item
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dicomlib import sr_counts  # noqa: E402

HERE = Path(__file__).parent
man = json.loads((HERE / "samples.json").read_text())
root = Path(man["dataRoot"])


out = {}
for case in man["cases"]:
    if case.get("found") is False:
        continue
    for f in case["files"]:
        p = root / case["id"] / f
        try:
            ds = pydicom.dcmread(p, force=True)
        except Exception as e:  # noqa: BLE001
            continue
        sop = str(ds.get("SOPClassUID", ""))
        e = {"case": case["id"], "sopClass": sop, "sopInstance": str(ds.get("SOPInstanceUID", "")), "series": str(ds.get("SeriesInstanceUID", ""))}
        if sop.startswith("1.2.840.10008.5.1.4.1.1.88."):
            sops = []
            e["srItems"], e["srRefs"] = sr_counts(ds.get("ContentSequence"), sops)
            e["srRefSops"] = sops
        if "WaveformSequence" in ds:
            e["waveform"] = [{"channels": int(g.NumberOfWaveformChannels), "samples": int(g.NumberOfWaveformSamples)} for g in ds.WaveformSequence]
        if sop.endswith(".104.3"):
            b = bytes(ds.EncapsulatedDocument)
            e["triangles"] = struct.unpack("<I", b[80:84])[0] if len(b) >= 84 and 84 + 50 * struct.unpack("<I", b[80:84])[0] == len(b) else len(re.findall(rb"endfacet", b))
        if sop.endswith(".104.2"):
            e["cdaSections"] = len(re.findall(rb"<section[ >]", bytes(ds.EncapsulatedDocument)))
        if sop.endswith(".104.4"):
            e["triangles"] = sum(len(l.split()) - 3 for l in bytes(ds.EncapsulatedDocument).decode().splitlines() if l.startswith("f "))
        if sop.endswith(".104.1"):
            b = bytes(ds.EncapsulatedDocument)
            e["pdfPages"] = len(re.findall(rb"/Type\s*/Page[^s]", b))
        if sop == "1.2.840.10008.5.1.4.1.1.66.4":
            e["segments"] = len(ds.SegmentSequence)
            e["segFrames"] = int(ds.get("NumberOfFrames", 1))
        if sop == "1.2.840.10008.5.1.4.1.1.481.3":
            per_image = {}
            for rc in ds.get("ROIContourSequence", []):
                for c in rc.get("ContourSequence", []):
                    for ci in c.get("ContourImageSequence", []):
                        u = str(ci.ReferencedSOPInstanceUID)
                        per_image[u] = per_image.get(u, 0) + 1
            e["rois"] = len(ds.get("ROIContourSequence", []))
            e["contours"] = sum(len(rc.get("ContourSequence", [])) for rc in ds.get("ROIContourSequence", []))
            e["contoursPerImage"] = per_image
        if sop == "1.2.840.10008.5.1.4.1.1.88.59":
            refs = [str(it.ReferencedSOPSequence[0].ReferencedSOPInstanceUID) for it in ds.get("ContentSequence", []) if it.get("ValueType") in ("IMAGE", "COMPOSITE", "WAVEFORM")]
            e["koRefs"] = len(refs)
            e["koRefSops"] = refs
        if sop.startswith("1.2.840.10008.5.1.4.1.1.11."):
            e["voi"] = [[float(v.WindowCenter if not hasattr(v.WindowCenter, "__len__") else v.WindowCenter[0]), float(v.WindowWidth if not hasattr(v.WindowWidth, "__len__") else v.WindowWidth[0])] for v in ds.get("SoftcopyVOILUTSequence", []) if "WindowCenter" in v]
            e["graphics"] = sum(len(a.get("GraphicObjectSequence", [])) + len(a.get("TextObjectSequence", [])) for a in ds.get("GraphicAnnotationSequence", []))
        if "FloatPixelData" in ds or "DoubleFloatPixelData" in ds:
            real = float_real(ds)
            c, w = float_window(ds, real)
            it = rw_item(ds)
            units = str(it.MeasurementUnitsCodeSequence[0].CodeValue) if it is not None and "MeasurementUnitsCodeSequence" in it else ""
            samples = []
            for k in sorted({0, real.shape[0] // 2}):
                fr = real[k]
                fin = np.where(np.isfinite(fr), fr, np.nan)
                pts = {np.unravel_index(np.nanargmax(fin), fr.shape), np.unravel_index(np.nanargmin(fin), fr.shape), (fr.shape[0] // 2, fr.shape[1] // 3)}
                nan = np.argwhere(np.isnan(fr))
                if len(nan):
                    pts.add(tuple(nan[0]))
                for y, x in sorted(pts):
                    v = float(fr[y, x])
                    samples.append({"frame": int(k), "x": int(x), "y": int(y), "value": None if v != v else v})
            e["float"] = {"window": [c, w], "units": units, "label": str(it.get("LUTLabel", "")) if it is not None else "", "samples": samples}
        if "IconImageSequence" in ds and "PixelData" in ds.IconImageSequence[0] and int(ds.IconImageSequence[0].get("BitsAllocated", 8)) == 8:
            it = ds.IconImageSequence[0]
            from pydicom.pixels import apply_color_lut
            n = int(it.Rows) * int(it.Columns) * int(it.get("SamplesPerPixel", 1))
            px = np.frombuffer(bytes(it.PixelData)[:n], np.uint8)
            px = px.reshape(int(it.Rows), int(it.Columns), -1).squeeze(-1) if int(it.get("SamplesPerPixel", 1)) == 1 else px.reshape(int(it.Rows), int(it.Columns), 3)
            if it.PhotometricInterpretation == "PALETTE COLOR":
                rgb = apply_color_lut(px, it)
                rgb = (rgb / 257).round() if rgb.max() > 255 else rgb
            elif it.SamplesPerPixel == 3:
                rgb = px
            else:
                g = 255 - px if it.PhotometricInterpretation == "MONOCHROME1" else px
                rgb = np.stack([g, g, g], -1)
            e["icon"] = {"size": f"{it.Columns}x{it.Rows}", "mean": [int(round(float(v))) for v in rgb.reshape(-1, 3).mean(0)]}
        out[f"{case['id']}/{f}"] = e
json.dump(out, sys.stdout, indent=1)
