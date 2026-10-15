"""Run a BigQuery SQL file against the public IDC tables via the REST API.

    uv run python scripts/sources/idc_bq.py SQL_FILE OUT.json [--dry-run] [--project P]

Bills to --project (default fhir-org-starter-project). Always dry-run first; the dry run
prints totalBytesProcessed. A real run refuses to go above --max-gb (default 15).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import time
import urllib.error
import urllib.request


def call(url, body, token, method="POST"):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, method=method,
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HTTP {e.code}: {e.read().decode()[:2000]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sql")
    ap.add_argument("out")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--project", default="fhir-org-starter-project")
    ap.add_argument("--max-gb", type=float, default=15)
    a = ap.parse_args()
    token = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True).strip()
    sql = open(a.sql).read()
    base = f"https://bigquery.googleapis.com/bigquery/v2/projects/{a.project}"
    dry = call(f"{base}/jobs", {"configuration": {"dryRun": True, "query": {"query": sql, "useLegacySql": False}}}, token)
    gb = int(dry["statistics"]["totalBytesProcessed"]) / 1e9
    print(f"dry run: {gb:.2f} GB")
    if a.dry_run:
        return
    if gb > a.max_gb:
        raise SystemExit(f"refusing: {gb:.2f} GB > {a.max_gb}")
    job = call(f"{base}/jobs", {"configuration": {"query": {"query": sql, "useLegacySql": False}}}, token)
    jid = job["jobReference"]["jobId"]
    loc = job["jobReference"].get("location", "US")
    while True:
        st = call(f"{base}/jobs/{jid}?location={loc}", None, token, "GET")
        if st["status"]["state"] == "DONE":
            break
        time.sleep(2)
    if "errorResult" in st["status"]:
        raise SystemExit(json.dumps(st["status"]))
    billed = int(st["statistics"]["query"].get("totalBytesBilled", 0)) / 1e9
    processed = int(st["statistics"]["query"].get("totalBytesProcessed", 0)) / 1e9
    rows, fields, token_ = [], None, None
    while True:
        url = f"{base}/queries/{jid}?location={loc}&maxResults=10000" + (f"&pageToken={token_}" if token_ else "")
        res = call(url, None, token, "GET")
        fields = [f["name"] for f in res["schema"]["fields"]]
        for r in res.get("rows", []):
            rows.append({k: c["v"] for k, c in zip(fields, r["f"])})
        token_ = res.get("pageToken")
        if not token_:
            break
    json.dump({"sql": sql, "job": jid, "gb_processed": processed, "gb_billed": billed, "rows": rows}, open(a.out, "w"), indent=1)
    print(f"done: {len(rows)} rows, {processed:.2f} GB processed, {billed:.2f} GB billed")


if __name__ == "__main__":
    main()
