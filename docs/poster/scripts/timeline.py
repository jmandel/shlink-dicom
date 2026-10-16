#!/usr/bin/env python3
"""Timeline from git: chosen commits on main with their author dates (Central time)."""
import json, subprocess, os, sys
REPO = os.path.expanduser("~/hobby/shlink-dicom")
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, "docs/poster/data/timeline.json")
# (commit, short label). Labels are ours; dates and subjects come from git.
PICK = [
    ("00038df", "First commit: the proposal"),
    ("68e6b9a", "Pure-Rust decoders, test corpus, renderer"),
    ("ed67c94", "Viewer, share and How pages; SMART Imaging sandbox"),
    ("9cf4a1f", "Whole-slide viewer; deploy scripts"),
    ("f1dfcde", "IDC long-tail sweep"),
    ("f2eac46", "Sample data: Josh Example"),
    ("5d9efc3", "Decoders: float, every JPEG mode"),
    ("1dc953e", "Resumable uploads"),
    ("d3c8a1b", "One encrypted file per study"),
    ("e7f6169", "Local or S3 storage"),
    ("fef0a72", "Display checked against dcmtk and pydicom"),
    ("3671bd5", "Phone layout"),
    ("a9c6861", "Sandbox: transfer-syntax negotiation (PR #5)"),
    ("47a7023", "Lossless JPEG encoder and transcoder"),
    ("edf192e", "Lossless compression when sharing"),
]
def git(*a): return subprocess.run(["git", "-C", REPO, *a], capture_output=True, text=True, check=True).stdout.strip()
ev = []
for h, label in PICK:
    iso, subj = git("show", "-s", "--format=%aI%x00%s", h).split("\x00")
    ev.append({"commit": h, "label": label, "date": iso, "subject": subj})
ev.sort(key=lambda e: e["date"])
first = git("log", "--reverse", "--format=%h %aI", "main").split("\n")[0].split()
last = git("log", "-1", "--format=%h %aI", "main").split()
n = int(git("rev-list", "--count", "main"))
json.dump({"events": ev, "first": {"commit": first[0], "date": first[1]}, "last": {"commit": last[0], "date": last[1]}, "commits": n,
           "source": "git log on main (author dates); labels in docs/poster/scripts/timeline.py"}, open(OUT, "w"), indent=1)
print(n, first, last, len(ev))
