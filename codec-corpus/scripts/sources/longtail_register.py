"""Register interesting long-tail files as corpus cases, de-duplicated by root cause.

    uv run python scripts/sources/longtail_register.py [--results ...] [--cap 300] [--per-group 3]
        [--max-mb 60] [--dry-run]

Reads prevalence/cache/longtail/results.jsonl (longtail_sweep.py). Every record whose outcome is not
pass/no-pixel-data/skipped-*/download-error is put in a root-cause group:
    outcome | transfer syntax | our stderr with numbers removed | first failing reference's error
Groups can be relabelled by prevalence/cache/longtail/groups.json ({"<signature substring>": "label"}),
written after diagnosis. From each group up to --per-group files are registered, preferring small
files and different manufacturers/collections, until --cap cases. The kept copy in
WORK/keep/<uuid>.dcm is registered with discover.register as idc-lt-<clue>-<hash8>, where <clue> is
the clue (and value) the instance was picked for, and hash8 the first 8 hex of sha256(SOPInstanceUID).
The chosen cases are written to prevalence/cache/longtail/registered.json.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from common import ROOT, load_cases, save_cases  # noqa: E402
from discover import register  # noqa: E402

import pydicom  # noqa: E402

D = ROOT / "prevalence" / "cache" / "longtail"
SKIP = {"pass", "no-pixel-data", "skipped-decoded-size", "download-error", "sweep-error"}
TS_SHORT = {
    "1.2.840.10008.1.2": "impl", "1.2.840.10008.1.2.1": "expl", "1.2.840.10008.1.2.2": "be",
    "1.2.840.10008.1.2.1.99": "defl", "1.2.840.10008.1.2.5": "rle",
    "1.2.840.10008.1.2.4.50": "jpgbase", "1.2.840.10008.1.2.4.51": "jpgext",
    "1.2.840.10008.1.2.4.57": "jpgll14", "1.2.840.10008.1.2.4.70": "jpgsv1",
    "1.2.840.10008.1.2.4.80": "jls", "1.2.840.10008.1.2.4.81": "jlsnear",
    "1.2.840.10008.1.2.4.90": "j2kr", "1.2.840.10008.1.2.4.91": "j2k",
}


def norm(s: str) -> str:
    s = re.sub(r"/[^ ]+", "<path>", s or "")
    s = re.sub(r"0x[0-9a-fA-F]+|\d+", "N", s)
    return s[:160]


def signature(r: dict) -> str:
    ref_err = ""
    for name, x in (r.get("refs") or {}).items():
        if not x.get("ok"):
            ref_err = f"{name}: {norm(x.get('err', ''))}"
            break
    ours = norm((r.get("ours") or {}).get("err", "")) if r["outcome"] != "mismatch" else norm(r.get("mismatch", "").split(";")[0])
    return f"{r['outcome']} | {TS_SHORT.get(r['ts'], r['ts'])} | {ours} | {ref_err if r['outcome'] in ('all-fail', 'refs-fail-we-decode') else ''}"


def slug(s: str, n: int = 16) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")[:n].strip("-") or "na"


def clue_tag(r: dict) -> str:
    if r.get("reason") == "control" or not r.get("covers"):
        return "random"
    c, _, v = r["covers"][0].partition("=")
    short = {"impl_ver": "implver", "impl_class": "implcls", "sop_class": "sop", "software": "sw",
             "image_type": "imgtype", "conversion_type": "conv", "spp_planar": "planar", "size_shape": "size",
             "smallest_value": "smallest", "presentation_lut": "plut", "rescale_type": "rescale",
             "lossy_method": "lossymeth", "lossy_ratio": "lossyratio", "high_bit": "highbit", "odd_dims": "odd",
             "photometric": "photo", "manufacturer": "mfr", "collection": "coll"}.get(c, c)
    if c in ("combo", "profile"):
        return short
    return f"{short}-{slug(v, 14)}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", type=Path, default=D / "results.jsonl")
    ap.add_argument("--cap", type=int, default=300)
    ap.add_argument("--per-group", type=int, default=3)
    ap.add_argument("--max-mb", type=float, default=60)
    ap.add_argument("--licenses", type=Path, default=D / "instance_licenses.json")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    recs = {}
    for line in a.results.read_text().splitlines():
        r = json.loads(line)
        recs[r["instance_uuid"]] = r          # later lines (re-checks) win
    labels = json.loads((D / "groups.json").read_text()) if (D / "groups.json").exists() else {}
    groups = defaultdict(list)
    for r in recs.values():
        if r["outcome"] in SKIP or not r.get("kept"):
            continue
        sig = signature(r)
        lab = next((v for k, v in labels.items() if k in sig), sig)
        groups[lab].append(r)
    lic = {}
    if a.licenses.exists():
        lic = {x["instance_uuid"]: x["license_short_name"] for x in json.loads(a.licenses.read_text())["rows"]}
    chosen = []
    # round-robin across groups so every root cause gets at least one case before any gets a second
    ordered = {}
    for lab, rs in groups.items():
        rs.sort(key=lambda r: (r["instance_size"] > a.max_mb * 1e6, r["instance_size"]))
        pick, seen = [], set()
        for r in rs:
            key = (r["manufacturer"], r["collection"])
            if key in seen and len(rs) > a.per_group:
                continue
            seen.add(key)
            pick.append(r)
            if len(pick) == a.per_group:
                break
        ordered[lab] = pick
    for k in range(a.per_group):
        for lab in sorted(ordered, key=lambda l: len(groups[l])):
            if k < len(ordered[lab]) and len(chosen) < a.cap:
                chosen.append((lab, ordered[lab][k]))
    print(f"{len(groups)} groups, {sum(len(v) for v in groups.values())} files, choosing {len(chosen)}")
    for lab in sorted(groups, key=lambda l: -len(groups[l])):
        print(f"  {len(groups[lab]):5}  {lab}")
    if a.dry_run:
        return 0
    out, budget, tags = [], {}, defaultdict(dict)
    for lab, r in chosen:
        p = Path(r["kept"])
        try:
            ds = pydicom.dcmread(p, stop_before_pixels=True, force=True)
            sop = str(ds.SOPInstanceUID)
        except Exception as e:  # noqa: BLE001
            print(f"unreadable {p}: {e}")
            continue
        cid = f"idc-lt-{clue_tag(r)}-{hashlib.sha256(sop.encode()).hexdigest()[:8]}"
        clues = {k: r[k] for k in ("ts", "sop_class", "manufacturer", "model", "software", "impl_class", "impl_ver",
                                   "src_ae", "conversion_type", "image_type", "modality", "photometric", "bits",
                                   "high_bit", "spp_planar", "frames", "lossy", "lossy_method", "lossy_ratio",
                                   "padding", "smallest_value", "rescale_type", "voi_lut", "palette", "icon",
                                   "overlay", "presentation_lut", "odd_dims", "size_shape", "year5", "profile")}
        source = {
            "kind": "idc", "collection": r["collection"], "sop_instance_uid": sop, "url": r["url"],
            "license": lic.get(r["instance_uuid"], ""), "series_uuid": r["series_uuid"],
            "instance_uuid": r["instance_uuid"], "picked_for": r.get("covers", [])[:6] or ["random control"],
            "longtail_outcome": r["outcome"], "longtail_group": lab, "clues": clues,
        }
        fmt = register(p, cid, source, budget, 10**6)
        if not fmt:
            print(f"NOT REGISTERED {cid} ({r['ts']}, {r['outcome']})")
            continue
        tags[fmt][cid] = ["idc", "idc-longtail", f"longtail:{r['outcome']}", f"profile:{r['profile']}"]
        out.append({"case": cid, "format": fmt, "group": lab, "outcome": r["outcome"], "size": r["instance_size"],
                    "instance_uuid": r["instance_uuid"]})
        print(f"{fmt:14} {cid:60} {lab[:80]}")
    for fmt, upd in tags.items():
        cases = [c for c in load_cases(fmt) if c["id"] in upd]
        for c in cases:
            c["tags"] = sorted(set(c.get("tags", [])) | set(upd[c["id"]]))
        save_cases(fmt, cases)
    (D / "registered.json").write_text(json.dumps(out, indent=1) + "\n")
    print(f"registered {len(out)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
