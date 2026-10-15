"""Pick, download and register IDC sample instances as corpus cases.

    uv run python scripts/sources/idc_fetch.py [CANDIDATES.json] [--dry-run] [--jobs 8]

CANDIDATES.json is the output of scripts/sources/idc_bq.py on prevalence/sql/idc_samples.sql
(default prevalence/cache/idc/candidates.json). Selection:
  - uncompressed profiles: the best 'profile' candidate (small, few frames), plus the best one
    from a second collection when there is one;
  - compressed profiles: every candidate ('profile', 'encoder', 'impl', 'oldest').
Files are downloaded over HTTPS from the public IDC S3 buckets into prevalence/cache/idc/dl/
(gitignored) and registered with discover.register, which copies them into formats/<fmt>/samples/.
Case ids are idc-<description>-<first 8 hex of sha256(SOPInstanceUID)>.
The picked list with provenance is written to prevalence/cache/idc/picked.json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from common import ROOT, TRANSFER_SYNTAXES, load_cases, save_cases  # noqa: E402
from discover import register  # noqa: E402

import pydicom  # noqa: E402

CACHE = ROOT / "prevalence" / "cache" / "idc"
UNCOMPRESSED = {"1.2.840.10008.1.2", "1.2.840.10008.1.2.1", "1.2.840.10008.1.2.2"}
TS_SHORT = {
    "1.2.840.10008.1.2": "impl", "1.2.840.10008.1.2.1": "expl", "1.2.840.10008.1.2.2": "be",
    "1.2.840.10008.1.2.1.99": "defl", "1.2.840.10008.1.2.5": "rle",
    "1.2.840.10008.1.2.4.50": "jpgbase", "1.2.840.10008.1.2.4.51": "jpgext",
    "1.2.840.10008.1.2.4.57": "jpgll14", "1.2.840.10008.1.2.4.70": "jpgsv1",
    "1.2.840.10008.1.2.4.80": "jls", "1.2.840.10008.1.2.4.81": "jlsnear",
    "1.2.840.10008.1.2.4.90": "j2kr", "1.2.840.10008.1.2.4.91": "j2k",
    "1.2.840.10008.1.2.4.201": "htj2kr", "1.2.840.10008.1.2.4.202": "htj2krpcl", "1.2.840.10008.1.2.4.203": "htj2k",
}
PH_SHORT = {"MONOCHROME1": "mono1", "MONOCHROME2": "mono2", "RGB": "rgb", "PALETTE COLOR": "pal",
            "YBR_FULL": "ybrfull", "YBR_FULL_422": "ybr422", "YBR_ICT": "ict", "YBR_RCT": "rct",
            "YBR_PARTIAL_422": "ybrp422"}


def slug(s: str, n: int = 12) -> str:
    s = re.sub(r"[^a-z0-9]+", "", (s or "").lower())
    return s[:n]


def describe(r: dict) -> str:
    ts, ph, ba, bs, pr, spp, pc, fr = r["profile"].split("|")
    parts = [TS_SHORT.get(ts, slug(ts)), PH_SHORT.get(ph, slug(ph)), f"{'s' if pr == '1' else 'u'}{bs}of{ba}"]
    if spp != "1":
        parts.append(f"p{pc}")
    parts.append("mf" if fr == "multi" else "sf")
    parts.append(slug(r.get("Modality") or "", 4) or "na")
    who = slug(r.get("Manufacturer") or "", 10) or slug(r.get("collection_id") or "", 10)
    if who:
        parts.append(who)
    return "-".join(parts)


def order(r: dict):
    size = int(r["instance_size"])
    return (size > 20_000_000, int(r["nframes"]), size)


def select(rows: list[dict]) -> list[dict]:
    by_uuid: dict[str, dict] = {}
    for r in rows:
        u = r["instance_uuid"]
        if u in by_uuid:
            by_uuid[u]["reasons"].add(r["reason"])
        else:
            by_uuid[u] = dict(r, reasons={r["reason"]})
    picked = {}
    by_profile = defaultdict(list)
    for r in by_uuid.values():
        if "profile" in r["reasons"]:
            by_profile[r["profile"]].append(r)
    for prof, rs in by_profile.items():
        rs.sort(key=order)
        if prof.split("|")[0] in UNCOMPRESSED:
            picked[rs[0]["instance_uuid"]] = rs[0]
            other = [x for x in rs[1:] if x["collection_id"] != rs[0]["collection_id"]]
            if other:
                picked[other[0]["instance_uuid"]] = other[0]
    for r in by_uuid.values():
        if r["ts"] not in UNCOMPRESSED:
            picked[r["instance_uuid"]] = r
    return sorted(picked.values(), key=lambda r: (r["profile"], order(r)))


def url_of(r: dict) -> str:
    return f"https://{r['aws_bucket']}.s3.amazonaws.com/{r['series_uuid']}/{r['instance_uuid']}.dcm"


def download(r: dict) -> Path:
    dst = CACHE / "dl" / f"{r['instance_uuid']}.dcm"
    if dst.exists() and dst.stat().st_size == int(r["instance_size"]):
        return dst
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".part")
    with urllib.request.urlopen(url_of(r), timeout=300) as resp, open(tmp, "wb") as f:
        while chunk := resp.read(1 << 20):
            f.write(chunk)
    tmp.replace(dst)
    return dst


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("candidates", nargs="?", type=Path, default=CACHE / "candidates.json")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--jobs", type=int, default=8)
    a = ap.parse_args()
    rows = json.loads(a.candidates.read_text())["rows"]
    picked = select(rows)
    total = sum(int(r["instance_size"]) for r in picked)
    print(f"{len(picked)} instances, {total / 1e9:.2f} GB, {len({r['profile'] for r in picked})} profiles")
    if a.dry_run:
        for r in picked:
            print(f"  {int(r['instance_size']) / 1e6:8.2f} MB  {sorted(r['reasons'])}  {describe(r)}")
        return
    with ThreadPoolExecutor(a.jobs) as ex:
        paths = list(ex.map(download, picked))
    out = []
    budget: dict[str, int] = {}
    tag_updates = defaultdict(dict)
    for r, p in zip(picked, paths):
        try:
            ds = pydicom.dcmread(p, stop_before_pixels=True, force=True)
            sop = str(ds.SOPInstanceUID)
        except Exception as e:  # noqa: BLE001
            print(f"unreadable {p}: {e}")
            continue
        cid = f"idc-{describe(r)}-{hashlib.sha256(sop.encode()).hexdigest()[:8]}"
        source = {
            "kind": "idc",
            "collection": r["collection_id"],
            "sop_instance_uid": sop,
            "url": url_of(r),
            "license": r["license_short_name"],
            "manufacturer": r["Manufacturer"],
            "model": r["ManufacturerModelName"],
            "implementation_version": r["ImplementationVersionName"],
            "study_date": r["StudyDate"],
            "modality": r["Modality"],
            "series_uuid": r["series_uuid"],
            "instance_uuid": r["instance_uuid"],
            "picked_for": sorted(r["reasons"]),
        }
        fmt = register(p, cid, source, budget, 10**6)
        if not fmt:
            ts = str(getattr(getattr(ds, "file_meta", None), "TransferSyntaxUID", ""))
            print(f"NOT REGISTERED {cid} (ts {ts}, in table: {ts in TRANSFER_SYNTAXES})")
            continue
        tag_updates[fmt][cid] = ["idc", f"profile:{r['profile']}"] + [f"idc-{x}" for x in sorted(r["reasons"])]
        out.append({"case": cid, "format": fmt, "profile": r["profile"], "size": int(r["instance_size"]),
                    "nframes": int(r["nframes"]), **source})
        print(f"{fmt:14} {cid}")
    for fmt, upd in tag_updates.items():
        cases = [c for c in load_cases(fmt) if c["id"] in upd]
        for c in cases:
            c["tags"] = sorted(set(c.get("tags", [])) | set(upd[c["id"]]))
        save_cases(fmt, cases)
    (CACHE / "picked.json").write_text(json.dumps(out, indent=1) + "\n")
    print(f"registered {len(out)}")


if __name__ == "__main__":
    main()
