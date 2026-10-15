"""BigQuery helper for the long-tail sweep (prevalence/LONGTAIL.md).

    uv run python scripts/sources/longtail_bq.py SQL_FILE OUT.json [--dry-run] [--max-gb 20]
    uv run python scripts/sources/longtail_bq.py --column-costs COL [COL ...]

Like idc_bq.py, but decodes nested REPEATED/RECORD results, appends each job's cost to
prevalence/cache/longtail/bq_log.jsonl, and can dry-run single columns to price them.
Bills to fhir-org-starter-project.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from idc_bq import call  # noqa: E402

ROOT = HERE.parent.parent
LOG = ROOT / "prevalence" / "cache" / "longtail" / "bq_log.jsonl"
PROJECT = "fhir-org-starter-project"
TABLE = "bigquery-public-data.idc_current.dicom_all"
BASE = f"https://bigquery.googleapis.com/bigquery/v2/projects/{PROJECT}"


def token() -> str:
    return subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True).strip()


def dry_run(sql: str, tok: str | None = None) -> float:
    tok = tok or token()
    d = call(f"{BASE}/jobs", {"configuration": {"dryRun": True, "query": {"query": sql, "useLegacySql": False}}}, tok)
    return int(d["statistics"]["totalBytesProcessed"]) / 1e9


def _decode(v, field):
    if v is None:
        return None
    if field.get("mode") == "REPEATED":
        return [_decode(x["v"], {**field, "mode": "NULLABLE"}) for x in v]
    if field["type"] in ("RECORD", "STRUCT"):
        return {f["name"]: _decode(c["v"], f) for f, c in zip(field["fields"], v["f"])}
    return v


def run(sql: str, max_gb: float, label: str) -> dict:
    tok = token()
    gb = dry_run(sql, tok)
    print(f"dry run: {gb:.2f} GB", flush=True)
    if gb > max_gb:
        raise SystemExit(f"refusing: {gb:.2f} GB > {max_gb}")
    job = call(f"{BASE}/jobs", {"configuration": {"query": {"query": sql, "useLegacySql": False}}}, tok)
    jid, loc = job["jobReference"]["jobId"], job["jobReference"].get("location", "US")
    t0 = time.time()
    while True:
        st = call(f"{BASE}/jobs/{jid}?location={loc}", None, tok, "GET")
        if st["status"]["state"] == "DONE":
            break
        time.sleep(3)
    if "errorResult" in st["status"]:
        raise SystemExit(json.dumps(st["status"]))
    q = st["statistics"]["query"]
    processed, billed = int(q.get("totalBytesProcessed", 0)) / 1e9, int(q.get("totalBytesBilled", 0)) / 1e9
    rows, page = [], None
    while True:
        url = f"{BASE}/queries/{jid}?location={loc}&maxResults=5000" + (f"&pageToken={page}" if page else "")
        res = call(url, None, tok, "GET")
        fields = res["schema"]["fields"]
        for r in res.get("rows", []):
            rows.append({f["name"]: _decode(c["v"], f) for f, c in zip(fields, r["f"])})
        page = res.get("pageToken")
        if not page:
            break
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG, "a") as f:
        f.write(json.dumps({"label": label, "job": jid, "gb_processed": processed, "gb_billed": billed,
                            "rows": len(rows), "seconds": round(time.time() - t0), "time": time.strftime("%FT%T")}) + "\n")
    print(f"done: {len(rows)} rows, {processed:.2f} GB processed, {billed:.2f} GB billed", flush=True)
    return {"sql": sql, "job": jid, "gb_processed": processed, "gb_billed": billed, "rows": rows}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sql", nargs="?")
    ap.add_argument("out", nargs="?")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--max-gb", type=float, default=20)
    ap.add_argument("--column-costs", nargs="+")
    a = ap.parse_args()
    if a.column_costs:
        tok = token()
        for c in a.column_costs:
            print(f"{c:45} {dry_run(f'SELECT {c} FROM `{TABLE}`', tok):8.2f} GB", flush=True)
        return
    sql = Path(a.sql).read_text()
    if a.dry_run:
        print(f"dry run: {dry_run(sql):.2f} GB")
        return
    res = run(sql, a.max_gb, Path(a.sql).stem)
    Path(a.out).write_text(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
