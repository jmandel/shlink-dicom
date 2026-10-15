"""References for display-conformance.ts, and the comparison.

  uv run --project codec-corpus python web/checks/display-conformance.py [out dir]

For every file display-conformance.ts rendered: dcmtk's dcm2img with the same VOI rule (+Wi 1,
+Wl 1 or +Wm; frame 1; overlays off), and pydicom's apply_modality_lut and apply_voi_lut as a second opinion
(its output scaled to 8 bits over the range pydicom windows onto: Bits Stored, rescaled, or the
Modality LUT's depth, for a window; the VOI LUT descriptor's bits for a LUT; MONOCHROME1 and Presentation LUT Shape INVERSE inverted), and for the
synthetic edge cases (display-synthetic.py) the rendering the rule calls for (<file>.expect.png). Writes
report.json and prints the agreement: grey levels apart, per reference."""
import json, subprocess, sys
from pathlib import Path
import numpy as np
from PIL import Image

out = Path(sys.argv[1] if len(sys.argv) > 1 else "/media/barracuda/shlink-display-conformance/out")
index = json.loads((out / "index.json").read_text())


def pgm(path):
    b = path.read_bytes()
    parts = b.split(b"\n", 3)
    w, h = map(int, parts[1].split())
    return np.frombuffer(parts[3][: w * h], np.uint8).reshape(h, w)


def compare(a, b):
    if a.shape != b.shape:
        return {"error": f"size {b.shape[1]}x{b.shape[0]} vs ours {a.shape[1]}x{a.shape[0]}"}
    d = np.abs(a.astype(int) - b.astype(int))
    return {"max": int(d.max()), "mean": round(float(d.mean()), 3), "over2": round(float((d > 2).mean()), 5)}


def pydicom_ref(f, voi):
    import pydicom
    from pydicom.pixels import apply_modality_lut, apply_voi_lut
    ds = pydicom.dcmread(f)
    a = ds.pixel_array
    if int(ds.get("NumberOfFrames", 1)) > 1:
        a = a[0]
    m = apply_modality_lut(a, ds)
    if voi == "lut":
        v = apply_voi_lut(m, ds, index=0, prefer_lut=True).astype(np.float64)
        bits = int(ds.VOILUTSequence[0].LUTDescriptor[2])
        y = np.floor(v * 255 / (2 ** bits - 1))
    elif voi == "file-window":
        if "WindowCenter" not in ds:
            # Enhanced images keep windows in the functional groups; apply_voi_lut reads the top level only.
            raise ValueError("window only in the functional groups (pydicom reads the top level)")
        v = apply_voi_lut(m, ds, index=0, prefer_lut=False).astype(np.float64)
        # The output range pydicom's apply_windowing maps onto (pydicom.pixels.processing).
        if "ModalityLUTSequence" in ds:
            lo, hi = 0, 2 ** int(ds.ModalityLUTSequence[0].LUTDescriptor[2]) - 1
        else:
            bits = int(ds.BitsStored)
            lo, hi = (-(2 ** (bits - 1)), 2 ** (bits - 1) - 1) if int(ds.PixelRepresentation) == 1 else (0, 2**bits - 1)
            if ds.get("RescaleSlope") is not None:
                k, b = float(ds.RescaleSlope), float(ds.get("RescaleIntercept") or 0)
                lo, hi = sorted((lo * k + b, hi * k + b))
        y = np.floor((v - lo) * 255 / (hi - lo) + 0.5)
    else:
        return None
    y = np.clip(y, 0, 255)
    inverse = str(ds.PhotometricInterpretation) == "MONOCHROME1"
    if str(ds.get("PresentationLUTShape", "")).upper() == "INVERSE" and not inverse:
        inverse = True
    return (255 - y if inverse else y).astype(np.uint8)


report = []
for r in index:
    if r.get("skip"):
        continue
    ours = pgm(out / f"{r['id']}.ours.pgm")
    opt = {"file-window": ["+Wi", "1"], "lut": ["+Wl", "1"], "minmax": ["+Wm"]}[r["voi"]]
    ref = out / f"{r['id']}.dcmtk.png"
    row = {**r}
    # -O: overlays are drawn by layers.ts, not burnt into the pixels.
    p = subprocess.run(["dcm2img", "--write-png", "-O", "+F", "1", *opt, r["file"], str(ref)], capture_output=True, text=True)
    row["dcmtk"] = compare(ours, np.asarray(Image.open(ref).convert("L"))) if p.returncode == 0 and ref.exists() else {"error": (p.stderr.strip().splitlines() or ["failed"])[-1][:160]}
    exp = Path(r["file"] + ".expect.png")
    if exp.exists():
        row["expected"] = compare(ours, np.asarray(Image.open(exp).convert("L")))
    try:
        y = pydicom_ref(r["file"], r["voi"])
        row["pydicom"] = compare(ours, y) if y is not None else {"error": "no VOI to compare (min-max)"}
    except Exception as e:  # noqa: BLE001
        row["pydicom"] = {"error": str(e)[:160]}
    report.append(row)

(out / "report.json").write_text(json.dumps(report, indent=1))
for k in ("expected", "dcmtk", "pydicom"):
    rows = [x for x in report if "max" in x.get(k, {})]
    agree = [x for x in rows if x[k]["max"] <= 1]
    close = [x for x in rows if 1 < x[k]["max"] and x[k]["over2"] <= 0.001]
    print(f"{k}: {len(rows)} compared, {len(agree)} within 1 grey level, {len(close)} more within 2 on ≥99.9% of pixels, {len(rows) - len(agree) - len(close)} differ; {len(report) - len(rows)} without a reference")
