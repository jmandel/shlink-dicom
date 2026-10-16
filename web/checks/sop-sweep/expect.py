"""Expected values for the object-type sweep (sop-sweep-checks.mjs), read with pydicom, not with the viewer's parser.

    uv run --project codec-corpus python -I web/checks/sop-sweep/expect.py ROOT

ROOT/cases.json (sopclass_fetch.py) and ROOT/cases-extra.json (derived and public-corpus cases,
sopclass_extra.py) list the cases; their files are under ROOT/dl/<SeriesInstanceUID>/. Writes
ROOT/expect.json: { case id: { series uid: series expectation } }.

Each series gets a category, from its SOP class (PS3.4 Annex B), independent of the viewer:
  volume  CT, MR, PET (classic, Enhanced, Legacy Converted), NM, RT dose: slices with geometry
  mf2d    multi-frame projection or 2D images (US, XA, RF, multi-frame SC, tomosynthesis, breast projection)
  image   single-frame 2D images (CR, DX, MG, SC, US)
  seg, rtstruct, pr, sr, ko, pdf, model, slide, ann, other
Image series: per slice (instance, frame) its position along the first slice's normal, rescale,
stored window and real values at five pixels; whether the slices form a regular volume.
Overlays: where they land (source image and the mask's or contour's centroid in its pixels).
"""
from __future__ import annotations

import json
import sys
import warnings
from pathlib import Path

import numpy as np
import pydicom

warnings.filterwarnings("ignore")
P = "1.2.840.10008.5.1.4.1.1."
CATEGORY = {
    "volume": ["2", "2.1", "2.2", "4", "4.1", "4.4", "128", "128.1", "130", "20", "481.2"],
    "mf2d": ["3.1", "12.1", "12.1.1", "12.2", "12.2.1", "7.2", "7.3", "7.1", "7.4", "13.1.3", "13.1.4", "13.1.5", "6.2"],
    "image": ["1", "1.1", "1.1.1", "1.2", "1.2.1", "1.3", "1.3.1", "7", "6.1", "77.1.4", "77.1.1", "77.1.2"],
    "seg": ["66.4", "66.7"], "rtstruct": ["481.3"], "pr": ["11.1", "11.2", "11.3", "11.4", "11.8"], "ko": ["88.59"],
    "pdf": ["104.1"], "model": ["104.3"], "slide": ["77.1.6"], "ann": ["91.1"], "pmap": ["30"],
}
CAT = {P + k: c for c, ks in CATEGORY.items() for k in ks}


def category(sop: str, ds) -> str:
    if sop in CAT:
        c = CAT[sop]
        # A single-frame-class image stored as multi-frame (US, SC) plays like the others.
        if c == "image" and int(ds.get("NumberOfFrames", 1) or 1) > 1:
            return "mf2d"
        return c
    if sop.startswith(P + "88."):
        return "sr"
    return "other"


def seq0(ds, kw):
    s = ds.get(kw)
    return s[0] if s else None


def fg(ds, frame, kw):
    """Functional group item `kw` for a frame: per-frame first, then shared (PS3.3 C.7.6.16)."""
    per = ds.get("PerFrameFunctionalGroupsSequence")
    if per is not None and frame < len(per):
        it = seq0(per[frame], kw)
        if it is not None:
            return it
    sh = ds.get("SharedFunctionalGroupsSequence")
    return seq0(sh[0], kw) if sh else None


def first_num(v):
    if v is None:
        return None
    try:
        return float(v[0]) if isinstance(v, (list, pydicom.multival.MultiValue)) else float(v)
    except Exception:  # noqa: BLE001
        return None


def frame_geom(ds, k):
    """(position, row, col, spacing[row, col]) of frame k, or Nones."""
    pp = fg(ds, k, "PlanePositionSequence")
    po = fg(ds, k, "PlaneOrientationSequence")
    pm = fg(ds, k, "PixelMeasuresSequence")
    ipp = (pp or ds).get("ImagePositionPatient")
    iop = (po or ds).get("ImageOrientationPatient")
    ps = (pm or ds).get("PixelSpacing")
    if ipp is not None and "GridFrameOffsetVector" in ds and iop is not None:
        n = np.cross(np.array(iop[:3], float), np.array(iop[3:], float))
        ipp = list(np.array(ipp, float) + n * float(ds.GridFrameOffsetVector[k]))
    return (np.array(ipp, float) if ipp is not None else None,
            np.array(iop[:3], float) if iop is not None else None,
            np.array(iop[3:], float) if iop is not None else None,
            [float(ps[0]), float(ps[1])] if ps is not None else None)


def frame_rescale(ds, k):
    t = fg(ds, k, "PixelValueTransformationSequence")
    src = t if t is not None and "RescaleSlope" in t else ds
    return float(src.get("RescaleSlope", 1) or 1), float(src.get("RescaleIntercept", 0) or 0)


def frame_window(ds, k):
    v = fg(ds, k, "FrameVOILUTSequence")
    src = v if v is not None and "WindowCenter" in v else ds
    c, w = first_num(src.get("WindowCenter")), first_num(src.get("WindowWidth"))
    return [c, w] if c is not None and w is not None else None


def to_pixel(pos, row, col, sp, p):
    d = np.array(p, float) - pos
    return float(d @ row / sp[1]), float(d @ col / sp[0]), float(d @ np.cross(row, col))


def to_patient(pos, row, col, sp, x, y):
    return pos + row * x * sp[1] + col * y * sp[0]


def image_series(files):
    """Slices of an image series, in the order the viewer stacks them: instances by Instance
    Number then SOP Instance UID; one multi-frame instance: its frames in stored order."""
    dss = []
    for f in files:
        d = pydicom.dcmread(f)
        dss.append(d)
    dss.sort(key=lambda d: (int(d.get("InstanceNumber", 2 ** 31) or 2 ** 31), str(d.SOPInstanceUID)))
    slices, normal = [], None
    for d in dss:
        nf = int(d.get("NumberOfFrames", 1) or 1)
        spp = int(d.get("SamplesPerPixel", 1))
        arr = None
        try:
            arr = d.pixel_array
            if nf == 1:
                arr = arr[None] if spp == 1 else arr[None]
        except Exception as e:  # noqa: BLE001
            arr = None
            err = str(e)[:120]
        for k in range(nf):
            pos, row, col, sp = frame_geom(d, k)
            if normal is None and row is not None:
                normal = np.cross(row, col)
            slope, icpt = frame_rescale(d, k)
            s = {"uid": str(d.SOPInstanceUID), "frame": k, "rows": int(d.Rows), "cols": int(d.Columns),
                 "pos": None if pos is None or normal is None else float(pos @ normal),
                 "ipp": None if pos is None else [float(x) for x in pos],
                 "iop": None if row is None else [float(x) for x in np.concatenate([row, col])],
                 "spacing": sp, "slope": slope, "intercept": icpt, "window": frame_window(d, k)}
            if arr is not None and spp == 1 and str(d.get("PhotometricInterpretation", "")).startswith("MONO"):
                fr = arr[k]
                R, C = fr.shape
                pts = [(R // 4, C // 4), (R // 2, C // 2), (3 * R // 4, 3 * C // 4), (R // 2, C // 4), (R // 3, 2 * C // 3)]
                s["values"] = [{"x": x, "y": y, "stored": float(fr[y, x]), "real": float(fr[y, x]) * slope + icpt} for y, x in pts]
                s["constant"] = bool(fr.min() == fr.max())
            elif arr is None:
                s["decodeError"] = err
            slices.append(s)
    return dss, slices


def regular(slices):
    """True when the slices are parallel, equally sized, evenly spaced along one direction (viewer volume.ts rule)."""
    if len(slices) < 3 or any(s["ipp"] is None or s["iop"] is None or s["spacing"] is None for s in slices):
        return False, "fewer than 3 slices or no geometry"
    io = np.array(slices[0]["iop"])
    if any(np.abs(np.array(s["iop"]) - io).max() > 1e-3 for s in slices):
        return False, "slices are not parallel"
    if len({(s["rows"], s["cols"]) for s in slices}) > 1:
        return False, "slices differ in size"
    pos = sorted(s["pos"] for s in slices)
    gaps = np.diff(pos)
    dz = (pos[-1] - pos[0]) / (len(pos) - 1)
    if dz <= 1e-3:
        return False, "slices share a position"
    if np.any(np.abs(gaps - dz) > max(0.01, dz * 0.05)):
        return False, "slices are not evenly spaced"
    return True, ""


def sr_counts(items, sops):
    n = refs = 0
    for it in items or []:
        n += 1
        if it.get("ValueType") in ("IMAGE", "COMPOSITE", "WAVEFORM") and "ReferencedSOPSequence" in it:
            refs += 1
            sops.append(str(it.ReferencedSOPSequence[0].ReferencedSOPInstanceUID))
        a, b = sr_counts(it.get("ContentSequence"), sops)
        n += a
        refs += b
    return n, refs


def main():
    root = Path(sys.argv[1])
    cases = json.load(open(root / "cases.json"))["cases"]
    extra = root / "cases-extra.json"
    if extra.exists():
        cases += json.load(open(extra))["cases"]
    only = set(sys.argv[2:])
    out_path = root / "expect.json"
    out = json.load(open(out_path)) if out_path.exists() and only else {}
    for case in cases:
        if only and case["id"] not in only:
            continue
        exp = {}
        geo_by_sop = {}
        for uid in case["series"]:
            d = Path(case.get("dirs", {}).get(uid, root / "dl" / uid))
            files = sorted(d.glob("*.dcm"))
            if not files:
                exp[uid] = {"error": "no files"}
                continue
            h = pydicom.dcmread(files[0], stop_before_pixels=True)
            sop = str(h.SOPClassUID)
            e = {"sopClass": sop, "category": category(sop, h), "files": len(files), "modality": str(h.get("Modality", "")),
                 "description": str(h.get("SeriesDescription", ""))}
            cat = e["category"]
            try:
                if cat in ("volume", "mf2d", "image", "pmap"):
                    dss, slices = image_series(files)
                    e["slices"] = slices
                    e["frames"] = [int(x.get("NumberOfFrames", 1) or 1) for x in dss]
                    e["spp"] = int(dss[0].get("SamplesPerPixel", 1))
                    e["photometric"] = str(dss[0].get("PhotometricInterpretation", ""))
                    ok, why = regular(slices)
                    e["regularVolume"], e["notVolume"] = ok, why
                    for s in slices:
                        geo_by_sop[(s["uid"], s["frame"])] = s
                    del dss
                elif cat == "seg":
                    ds = pydicom.dcmread(files[0])
                    e["segments"] = len(ds.get("SegmentSequence", []))
                    e["segType"] = str(ds.get("SegmentationType", ""))
                    arr = ds.pixel_array
                    if int(ds.get("NumberOfFrames", 1)) == 1:
                        arr = arr[None]
                    fr = []
                    for k in range(arr.shape[0]):
                        src = None
                        di = fg(ds, k, "DerivationImageSequence")
                        if di is not None and di.get("SourceImageSequence"):
                            si = di.SourceImageSequence[0]
                            src = [str(si.ReferencedSOPInstanceUID), int(si.get("ReferencedFrameNumber", 1) or 1) - 1]
                        pos, row, col, sp = frame_geom(ds, k)
                        m = arr[k] > 0
                        if not m.any():
                            continue
                        ys, xs = np.nonzero(m)
                        c = None if pos is None else to_patient(pos, row, col, sp, float(xs.mean()), float(ys.mean()))
                        corners = None if pos is None else [[float(v) for v in to_patient(pos, row, col, sp, x, y)]
                                                            for x in (xs.min() - 0.5, xs.max() + 0.5) for y in (ys.min() - 0.5, ys.max() + 0.5)]
                        seg_id = fg(ds, k, "SegmentIdentificationSequence")
                        fr.append({"frame": k, "src": src, "centroid": None if c is None else [float(v) for v in c],
                                   "segment": int(seg_id.ReferencedSegmentNumber) if seg_id is not None else None, "pixels": int(m.sum()),
                                   "corners": corners})
                    e["segFrames"] = fr
                elif cat == "rtstruct":
                    ds = pydicom.dcmread(files[0])
                    per = {}
                    pts = {}
                    for rc in ds.get("ROIContourSequence", []):
                        for c in rc.get("ContourSequence", []):
                            data = np.array(c.get("ContourData", []), float).reshape(-1, 3)
                            refs = [str(ci.ReferencedSOPInstanceUID) for ci in c.get("ContourImageSequence", [])]
                            key = refs[0] if refs else f"z={data[0][2]:.2f}" if len(data) else "?"
                            per[key] = per.get(key, 0) + 1
                            pts.setdefault(key, []).append(data)
                    e["rois"] = len(ds.get("StructureSetROISequence", []))
                    e["contours"] = sum(per.values())
                    e["contoursPerImage"] = per
                    e["contourCentroid"] = {k: [float(v) for v in np.concatenate(v).mean(0)] for k, v in pts.items() if len(np.concatenate(v))}
                    e["contourPoints"] = {k: [[float(a) for a in q] for q in np.concatenate(v)] for k, v in pts.items() if len(np.concatenate(v))}
                elif cat == "pr":
                    ds = pydicom.dcmread(files[0])
                    e["voi"] = [[first_num(v.WindowCenter), first_num(v.WindowWidth)] for v in ds.get("SoftcopyVOILUTSequence", []) if "WindowCenter" in v]
                    e["refImages"] = [str(i.ReferencedSOPInstanceUID) for s in ds.get("ReferencedSeriesSequence", []) for i in s.get("ReferencedImageSequence", [])]
                    e["refSeries"] = [str(s.SeriesInstanceUID) for s in ds.get("ReferencedSeriesSequence", [])]
                    for bs in ds.get("BlendingSequence", []) or []:
                        e.setdefault("blendSeries", []).extend(str(s.SeriesInstanceUID) for s in bs.get("ReferencedSeriesSequence", []))
                    e["graphics"] = sum(len(a.get("GraphicObjectSequence", [])) + len(a.get("TextObjectSequence", [])) for a in ds.get("GraphicAnnotationSequence", []))
                elif cat in ("sr", "ko"):
                    ds = pydicom.dcmread(files[0])
                    sops = []
                    e["srItems"], e["srRefs"] = sr_counts(ds.get("ContentSequence"), sops)
                    e["srRefSops"] = sops
                    e["title"] = str(ds.ConceptNameCodeSequence[0].CodeMeaning) if ds.get("ConceptNameCodeSequence") else ""
                    if cat == "ko":
                        e["koRefs"] = len([i for i in ds.get("ContentSequence", []) if i.get("ValueType") in ("IMAGE", "COMPOSITE", "WAVEFORM")])
                elif cat == "model":
                    import re
                    import struct
                    ds = pydicom.dcmread(files[0])
                    b = bytes(ds.EncapsulatedDocument)
                    e["triangles"] = struct.unpack("<I", b[80:84])[0] if len(b) >= 84 and 84 + 50 * struct.unpack("<I", b[80:84])[0] == len(b) else len(re.findall(rb"endfacet", b))
                elif cat == "slide":
                    lv = []
                    for f in files:
                        d = pydicom.dcmread(f, stop_before_pixels=True)
                        it = list(d.get("ImageType", []))
                        lv.append({"type": it[2] if len(it) > 2 else "", "w": int(d.get("TotalPixelMatrixColumns", d.Columns)), "h": int(d.get("TotalPixelMatrixRows", d.Rows))})
                    vols = [x for x in lv if x["type"] == "VOLUME"]
                    e["levels"] = len({(x["w"], x["h"]) for x in vols})
                    e["base"] = max(vols, key=lambda x: x["w"]) if vols else None
                elif cat == "ann":
                    ds = pydicom.dcmread(files[0], stop_before_pixels=True)
                    e["groups"] = len(ds.get("AnnotationGroupSequence", []))
                else:
                    from pydicom.uid import UID
                    e["className"] = UID(sop).name
            except Exception as ex:  # noqa: BLE001
                e["expectError"] = f"{type(ex).__name__}: {str(ex)[:200]}"
            exp[uid] = e
        # Where overlays land: segmentation frames and contours on the case's images.
        for uid, e in exp.items():
            if e.get("category") == "seg":
                land = {}
                for f in e.get("segFrames", []):
                    # By position first (Plane Position is normative; Source Image references are
                    # informative and sometimes wrong), else by the source image reference.
                    tgt = None
                    if f["centroid"] is not None:
                        best = None
                        for s in geo_by_sop.values():
                            if s["ipp"] is None or s["iop"] is None or s["spacing"] is None:
                                continue
                            r, c = np.array(s["iop"][:3]), np.array(s["iop"][3:])
                            x, y, dist = to_pixel(np.array(s["ipp"]), r, c, s["spacing"], f["centroid"])
                            if 0 <= x < s["cols"] and 0 <= y < s["rows"] and (best is None or abs(dist) < best[0]):
                                best = (abs(dist), s)
                        if best and best[0] < 2.5:
                            tgt = best[1]
                    if tgt is None and f["src"] and tuple(f["src"]) in geo_by_sop:
                        tgt = geo_by_sop[tuple(f["src"])]
                    if tgt is not None and f["src"] and (tgt["uid"], tgt["frame"]) != tuple(f["src"]) and tuple(f["src"]) in geo_by_sop:
                        e["srcDisagrees"] = e.get("srcDisagrees", 0) + 1
                    if tgt is None or f["centroid"] is None:
                        continue
                    r, c = np.array(tgt["iop"][:3]), np.array(tgt["iop"][3:])
                    x, y, _ = to_pixel(np.array(tgt["ipp"]), r, c, tgt["spacing"], f["centroid"])
                    k = f"{tgt['uid']}/{tgt['frame']}"
                    land.setdefault(k, {"frames": 0, "pts": [], "box": []})
                    land[k]["frames"] += 1
                    land[k]["pts"].append([x, y, f["pixels"]])
                    land[k]["box"] += [to_pixel(np.array(tgt["ipp"]), r, c, tgt["spacing"], q)[:2] for q in f["corners"]]
                # Where the mask lands on the image: its bounding box in the image's pixels (edges of pixels).
                e["lands"] = {k: {"frames": v["frames"], "x": sum(p[0] * p[2] for p in v["pts"]) / sum(p[2] for p in v["pts"]),
                                  "y": sum(p[1] * p[2] for p in v["pts"]) / sum(p[2] for p in v["pts"]),
                                  "box": [min(b[0] for b in v["box"]), min(b[1] for b in v["box"]), max(b[0] for b in v["box"]), max(b[1] for b in v["box"])]}
                              for k, v in land.items()}
                e.pop("segFrames", None)
            if e.get("category") == "rtstruct":
                land = {}
                for k, cen in e.get("contourCentroid", {}).items():
                    tgt = geo_by_sop.get((k, 0))
                    if tgt is None or tgt["ipp"] is None:
                        continue
                    r, c = np.array(tgt["iop"][:3]), np.array(tgt["iop"][3:])
                    x, y, dist = to_pixel(np.array(tgt["ipp"]), r, c, tgt["spacing"], cen)
                    pts = [to_pixel(np.array(tgt["ipp"]), r, c, tgt["spacing"], q)[:2] for q in e["contourPoints"][k]]
                    land[f"{k}/0"] = {"contours": e["contoursPerImage"][k], "x": x, "y": y,
                                      "box": [min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)]}
                e["lands"] = land
                e.pop("contourPoints", None)
        out[case["id"]] = exp
        print(f"{case['id']}: " + ", ".join(f"{v.get('category')}{'!' if v.get('expectError') else ''}" for v in exp.values()), file=sys.stderr, flush=True)
    json.dump(out, open(out_path, "w"))


if __name__ == "__main__":
    main()
