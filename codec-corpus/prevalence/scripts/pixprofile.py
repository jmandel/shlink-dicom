"""The pixel profile: the tuple that decides whether a decoder can handle an instance.

Shared by the profiling scripts and coverage.py. A profile key is a '|'-joined string:

    transfer_syntax|photometric|bits_allocated|bits_stored|pixel_representation|samples_per_pixel|planar_configuration|frames

where frames is 'single' or 'multi'. Planar configuration is recorded as 0 when absent
or when samples_per_pixel is 1 (it has no meaning then).
"""

from __future__ import annotations

import csv
from collections import Counter, defaultdict
from pathlib import Path

FIELDS = [
    "transfer_syntax",
    "photometric",
    "bits_allocated",
    "bits_stored",
    "pixel_representation",
    "samples_per_pixel",
    "planar_configuration",
    "frames",
]

# Profile table: one row per (profile, modality).
PROFILE_COLUMNS = FIELDS + ["modality", "instances", "series", "studies"]
# Set table: one row per distinct set of profiles found in one series or one study.
SET_COLUMNS = ["level", "profiles", "count"]

TS_NAMES = {
    "1.2.840.10008.1.2": "Implicit VR LE",
    "1.2.840.10008.1.2.1": "Explicit VR LE",
    "1.2.840.10008.1.2.2": "Explicit VR BE",
    "1.2.840.10008.1.2.1.99": "Deflated Explicit VR LE",
    "1.2.840.10008.1.2.5": "RLE Lossless",
    "1.2.840.10008.1.2.4.50": "JPEG Baseline",
    "1.2.840.10008.1.2.4.51": "JPEG Extended",
    "1.2.840.10008.1.2.4.57": "JPEG Lossless P14",
    "1.2.840.10008.1.2.4.70": "JPEG Lossless SV1",
    "1.2.840.10008.1.2.4.80": "JPEG-LS Lossless",
    "1.2.840.10008.1.2.4.81": "JPEG-LS Near-Lossless",
    "1.2.840.10008.1.2.4.90": "JPEG 2000 Lossless",
    "1.2.840.10008.1.2.4.91": "JPEG 2000",
    "1.2.840.10008.1.2.4.201": "HTJ2K Lossless",
    "1.2.840.10008.1.2.4.202": "HTJ2K Lossless RPCL",
    "1.2.840.10008.1.2.4.203": "HTJ2K",
    "1.2.840.10008.1.2.4.100": "MPEG2 MP@ML",
    "1.2.840.10008.1.2.4.102": "MPEG-4 AVC/H.264",
    "1.2.840.10008.1.2.4.103": "MPEG-4 AVC/H.264 BD",
}


def _int(v, default=0) -> int:
    if v is None or v == "":
        return default
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def make_key(ts, photometric, ba, bs, pr, spp, pc, frames) -> str:
    spp_i = _int(spp, 1)
    pc_i = _int(pc, 0) if spp_i > 1 else 0
    fr = frames if frames in ("single", "multi") else ("multi" if _int(frames, 1) > 1 else "single")
    return "|".join(
        str(x)
        for x in (
            (ts or "").strip(),
            (photometric or "").strip(),
            _int(ba),
            _int(bs),
            _int(pr),
            spp_i,
            pc_i,
            fr,
        )
    )


def key_from_dataset(ds, ts: str | None = None) -> str:
    """Profile key from a pydicom Dataset read with stop_before_pixels=True."""
    if ts is None:
        ts = str(ds.file_meta.TransferSyntaxUID) if "TransferSyntaxUID" in getattr(ds, "file_meta", {}) else ""
    return make_key(
        ts,
        ds.get("PhotometricInterpretation", ""),
        ds.get("BitsAllocated"),
        ds.get("BitsStored"),
        ds.get("PixelRepresentation"),
        ds.get("SamplesPerPixel"),
        ds.get("PlanarConfiguration"),
        ds.get("NumberOfFrames", 1),
    )


def key_from_row(row: dict) -> str:
    return make_key(*(row.get(f) for f in FIELDS))


def key_from_case(case: dict) -> str:
    return make_key(
        case.get("transfer_syntax"),
        case.get("photometric"),
        case.get("bits_allocated"),
        case.get("bits_stored"),
        case.get("pixel_representation"),
        case.get("samples_per_pixel"),
        case.get("planar_configuration"),
        case.get("frames", 1),
    )


def describe(key: str) -> str:
    ts, ph, ba, bs, pr, spp, pc, fr = key.split("|")
    name = TS_NAMES.get(ts, ts)
    sign = "s" if pr == "1" else "u"
    planar = f" planar={pc}" if spp != "1" else ""
    return f"{name}, {ph}, {sign}{bs}/{ba}, spp={spp}{planar}, {fr}-frame"


def write_tables(prefix: Path, rows: list[dict], series_sets: Counter, study_sets: Counter) -> None:
    """rows: dicts with FIELDS + modality, instances, series, studies."""
    prefix.parent.mkdir(parents=True, exist_ok=True)
    with open(f"{prefix}.csv", "w", newline="") as f:
        w = csv.DictWriter(f, PROFILE_COLUMNS)
        w.writeheader()
        for r in sorted(rows, key=lambda r: -float(r["instances"])):
            w.writerow({k: r[k] for k in PROFILE_COLUMNS})
    with open(f"{prefix}-sets.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(SET_COLUMNS)
        for level, c in (("series", series_sets), ("study", study_sets)):
            for sig, n in c.most_common():
                w.writerow([level, sig, n])


def aggregate(units: list[tuple[str, str, str, str, float]]):
    """units: (study, series, modality, profile_key, instances).

    Returns (rows, series_sets, study_sets) ready for write_tables.
    """
    inst = defaultdict(float)
    ser = defaultdict(set)
    stu = defaultdict(set)
    series_profiles = defaultdict(set)
    study_profiles = defaultdict(set)
    for study, series, modality, key, n in units:
        inst[(key, modality)] += n
        ser[(key, modality)].add(series)
        stu[(key, modality)].add(study)
        series_profiles[series].add(key)
        study_profiles[study].add(key)
    rows = []
    for (key, modality), n in inst.items():
        r = dict(zip(FIELDS, key.split("|")))
        r.update(modality=modality, instances=round(n, 1), series=len(ser[(key, modality)]), studies=len(stu[(key, modality)]))
        rows.append(r)
    series_sets = Counter(";".join(sorted(s)) for s in series_profiles.values())
    study_sets = Counter(";".join(sorted(s)) for s in study_profiles.values())
    return rows, series_sets, study_sets
