# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = [
#   "pydicom==3.0.1",
#   "numpy==2.3.3",
#   "pylibjpeg==2.0.1",
#   "pylibjpeg-openjpeg==2.4.0",
#   "pylibjpeg-libjpeg==2.3.0",
# ]
# ///
"""Losslessly compressed copies of the dataset's uncompressed images, for
WADO-RS transfer syntax negotiation (argonautproject/smart-imaging PR #5).

    uv run scripts/make-variants.py --dataset build/dataset --out build/variants

For every instance stored uncompressed, it writes up to two copies:
- JPEG Lossless SV1 (1.2.840.10008.1.2.4.70), encoded by dcmtk's dcmcjpeg;
- JPEG 2000 Lossless (1.2.840.10008.1.2.4.90), encoded by OpenJPEG (through
  pylibjpeg-openjpeg and pydicom).

Neither encoder is the project's own code, so the copies also test interop.
A copy is kept only if it decodes (pydicom: libjpeg for SV1, OpenJPEG for
J2K) to exactly the original pixels, and its other attributes have the same
values (dcmcjpeg adds a Derivation Description; UIDs are kept).
The output is <out>/<transfer syntax UID>/<dataset path> plus
<out>/manifest.json. Copies are not part of the dataset's SHA256SUMS: their
bytes depend on the encoder versions, so they are checked by pixel identity.
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pydicom
from pydicom.config import settings

settings.reading_validation_mode = 1
settings.writing_validation_mode = 1

SV1 = "1.2.840.10008.1.2.4.70"
J2K = "1.2.840.10008.1.2.4.90"
UNCOMPRESSED = {"1.2.840.10008.1.2", "1.2.840.10008.1.2.1", "1.2.840.10008.1.2.2"}


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def same_pixels(a: pydicom.Dataset, b: pydicom.Dataset) -> bool:
    pa, pb = a.pixel_array, b.pixel_array
    return pa.shape == pb.shape and pa.dtype == pb.dtype and bool(np.array_equal(pa, pb))


# Attributes a lossless re-encoding may change: the pixel data itself, and
# Derivation Description, which dcmcjpeg adds to describe the compression.
ALLOWED_CHANGES = {0x7FE00010, 0x00082111}


def same_header(a: pydicom.Dataset, b: pydicom.Dataset) -> bool:
    ta = {e.tag: e.value for e in a if e.tag not in ALLOWED_CHANGES}
    tb = {e.tag: e.value for e in b if e.tag not in ALLOWED_CHANGES}
    return ta == tb


def make(job):
    src, rel, out_root = job
    data = open(src, "rb").read()
    ds = pydicom.dcmread(src)
    results = []
    for ts in (SV1, J2K):
        dest = os.path.join(out_root, ts, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        try:
            if ts == SV1:
                r = subprocess.run(["dcmcjpeg", "--encode-lossless-sv1", src, dest], capture_output=True, text=True)
                if r.returncode != 0:
                    raise RuntimeError(r.stderr.strip()[-300:])
            else:
                c = pydicom.dcmread(src)
                c.compress(J2K, encoding_plugin="pylibjpeg", generate_instance_uid=False)
                c.save_as(dest, enforce_file_format=True)
            out = pydicom.dcmread(dest)
            if str(out.file_meta.TransferSyntaxUID) != ts:
                raise RuntimeError(f"wrote {out.file_meta.TransferSyntaxUID}")
            if out.SOPInstanceUID != ds.SOPInstanceUID or out.StudyInstanceUID != ds.StudyInstanceUID:
                raise RuntimeError("UIDs changed")
            if not same_pixels(ds, out):
                raise RuntimeError("decoded pixels differ")
            if not same_header(ds, out):
                raise RuntimeError("attributes other than pixel data and Derivation Description changed")
            b = open(dest, "rb").read()
            results.append({"ts": ts, "path": os.path.join(ts, rel), "size": len(b), "sha256": sha256(b)})
        except Exception as e:  # keep going; the build reports failures
            if os.path.exists(dest):
                os.remove(dest)
            results.append({"ts": ts, "error": f"{type(e).__name__}: {e}"})
    return {"source": rel, "sourceSha256": sha256(data), "sourceSize": len(data), "sop": str(ds.SOPInstanceUID), "variants": results}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 2)
    a = ap.parse_args()
    if not shutil.which("dcmcjpeg"):
        sys.exit("dcmcjpeg (dcmtk) is required")
    manifest = json.load(open(os.path.join(a.dataset, "manifest.json")))
    tmp = a.out + ".tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    jobs = []
    for st in manifest["studies"]:
        for f in st["files"]:
            p = os.path.join(a.dataset, f["path"])
            ds = pydicom.dcmread(p, stop_before_pixels=True)
            if str(ds.file_meta.TransferSyntaxUID) in UNCOMPRESSED and "Rows" in ds:
                jobs.append((p, f["path"], tmp))
    with ProcessPoolExecutor(max_workers=a.jobs) as ex:
        entries = sorted(ex.map(make, jobs, chunksize=4), key=lambda e: e["source"])
    failures = [(e["source"], v["ts"], v["error"]) for e in entries for v in e["variants"] if "error" in v]
    version = subprocess.run(["dcmcjpeg", "--version"], capture_output=True, text=True).stdout.splitlines()[0].strip()
    import openjpeg
    out = {
        "_note": "Losslessly compressed copies of the uncompressed images (scripts/make-variants.py). Each copy decodes to exactly the original pixels.",
        "encoders": {SV1: version, J2K: f"OpenJPEG via pylibjpeg-openjpeg {openjpeg.__version__}"},
        "instances": entries,
        "failures": failures,
    }
    with open(os.path.join(tmp, "manifest.json"), "w") as fh:
        json.dump(out, fh, indent=1)
    shutil.rmtree(a.out, ignore_errors=True)
    os.rename(tmp, a.out)
    kept = sum(1 for e in entries for v in e["variants"] if "error" not in v)
    print(f"variants: {len(entries)} uncompressed instances, {kept} copies kept, {len(failures)} failures")
    for f in failures[:10]:
        print("  failed:", *f)


if __name__ == "__main__":
    main()
