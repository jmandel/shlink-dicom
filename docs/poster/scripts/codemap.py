#!/usr/bin/env python3
"""Count the project's own code on main, grouped by job and language.

Rules (all in this file so the poster can say exactly what was counted):
- Files: `git ls-files` at the ref given (default main). Lines = non-blank lines.
- Languages counted by extension: Rust, TypeScript, JavaScript, Python, C, SQL, Shell, CSS, HTML;
  Markdown only for the specification (PROPOSAL.md).
- Excluded: data and config (json, toml, lock, csv, yml), logs, patches, binaries, built output (dist/),
  docs other than the spec, and node_modules (never tracked).
- Vendored upstream code (codecs/*/vendor/<name>/) is counted separately and shown as upstream.
- Generated code (the DICOM dictionary) is counted separately.
- Optionally a branch's extra files (e.g. the JPEG 2000 encoder in review) are added as their own leaf.
"""
import json, subprocess, sys, os, re
from collections import defaultdict

REPO = os.path.expanduser("~/hobby/shlink-dicom")
REF = sys.argv[1] if len(sys.argv) > 1 else "main"
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(REPO, "docs/poster/data/codemap.json")

LANG = {"rs": "Rust", "ts": "TypeScript", "mjs": "JavaScript", "js": "JavaScript", "py": "Python",
        "c": "C", "sql": "SQL", "sh": "Shell", "css": "CSS", "html": "HTML"}
GENERATED = {"codecs/shl-dicom-transcode/src/dict.rs": "DICOM data dictionary (generated)"}

# (prefix, group, leaf label). First match wins. Order matters.
RULES = [
    ("codecs/shl-codec-jpeg2000/vendor/hayro-jpeg2000/", "Rust codecs", "hayro JPEG 2000 (upstream, patched)"),
    ("codecs/shl-codec-htj2k/vendor/oxideav-jpeg2000/", "Rust codecs", "oxideav JPEG 2000 / HTJ2K (upstream, patched)"),
    ("codecs/bench/", "Verification", "codec benchmarks"),
    ("codecs/survey-j2k/", "Verification", "JPEG 2000 library survey"),
    ("codecs/shl-dicom-wasm-bench/", "Verification", "codec benchmarks"),
    ("codecs/shl-codec-jpeg/", "Rust codecs", "JPEG (all modes)"),
    ("codecs/shl-codec-jpeg-ls/", "Rust codecs", "JPEG-LS"),
    ("codecs/shl-jpeg2000/", "Rust codecs", "JPEG 2000 and HTJ2K decoder"),
    ("codecs/shl-codec-jpeg2000-encode/", "Rust codecs", "JPEG 2000 encoder"),
    ("codecs/shl-codec-jpeg2000/", "Rust codecs", "JPEG 2000 glue"),
    ("codecs/shl-codec-htj2k/", "Rust codecs", "HTJ2K glue"),
    ("codecs/shl-jpegxl/", "Rust codecs", "JPEG XL decoder"),
    ("codecs/shl-codec-jpegxl/", "Rust codecs", "JPEG XL glue"),
    ("codecs/shl-codec-rle/", "Rust codecs", "RLE"),
    ("codecs/shl-codec-common/", "Rust codecs", "codec common"),
    ("codecs/shl-dicom-decode", "Rust codecs", "DICOM decode"),
    ("codecs/shl-dicom-transcode", "Rust codecs", "lossless encoder"),
    ("codecs/mpeg2-wasm/", "Rust codecs", "MPEG-2 video glue (C)"),
    ("crates/shl-dicom-server/", "Server and protocol core", "server"),
    ("crates/shl-dicom-core/", "Server and protocol core", "packer and protocol core"),
    ("crates/shl-dicom-wasm/", "Server and protocol core", "protocol core (wasm)"),
    ("web/checks/", "Verification", "web end-to-end checks"),
    ("web/core/", "Web app", "shared core"),
    ("web/view/", "Web app", "viewer"),
    ("web/share/", "Web app", "share"),
    ("web/how/", "Web app", "How it works"),
    ("web/landing/", "Web app", "landing"),
    ("web/shared/", "Web app", "shared core"),
    ("web/build.ts", "Web app", "build"),
    ("viewer-kit/src/", "Web app", "GPU renderer + worker pool"),
    ("viewer-kit/demo/", "Web app", "GPU renderer + worker pool"),
    ("viewer-kit/", "Verification", "renderer tests and benchmarks"),
    ("codec-corpus/", "Verification", "decoder corpus + IDC scripts"),
    ("imaging-sandbox/test/", "Verification", "sandbox tests"),
    ("imaging-sandbox/", "SMART Imaging sandbox", "sandbox server + data build"),
    ("perf-spikes/", "Verification", "speed spikes"),
    ("test/", "Verification", "protocol tests"),
    ("fixtures/", "Verification", "protocol tests"),
    ("deploy/", "Server and protocol core", "deploy scripts"),
    ("reference/", "Spec and reference", "reference code + test vector"),
    ("PROPOSAL.md", "Spec and reference", "specification (PROPOSAL.md)"),
]

def ls(ref):
    return subprocess.run(["git", "-C", REPO, "ls-tree", "-r", "--name-only", ref], check=True, capture_output=True, text=True).stdout.split("\n")

def lines(ref, path):
    blob = subprocess.run(["git", "-C", REPO, "show", f"{ref}:{path}"], capture_output=True).stdout
    return sum(1 for l in blob.decode("utf-8", "replace").split("\n") if l.strip())

def lang_of(path):
    if path == "PROPOSAL.md": return "Markdown"
    if "/dist/" in path: return None
    ext = path.rsplit(".", 1)[-1] if "." in path else ""
    return LANG.get(ext)

def classify(path):
    for pre, g, leaf in RULES:
        if path.startswith(pre): return g, leaf
    return None, None

def count(ref, files, extra_leaf=None):
    leaves = defaultdict(lambda: defaultdict(int)); skipped = defaultdict(int); generated = {}
    for p in files:
        if not p: continue
        lang = lang_of(p)
        if not lang: continue
        n = lines(ref, p)
        if p in GENERATED:
            generated[GENERATED[p]] = {"lines": n, "path": p, "language": lang}; continue
        g, leaf = classify(p)
        if extra_leaf: g, leaf = extra_leaf
        if not g: skipped[p] += n; continue
        leaves[(g, leaf)][lang] += n
    return leaves, skipped, generated

files = ls(REF)
leaves, skipped, generated = count(REF, files)
sha = subprocess.run(["git", "-C", REPO, "rev-parse", "--short", REF], capture_output=True, text=True).stdout.strip()

# Optional: the JPEG 2000 encoder in review on branch j2k-encoder (files not on main)
review = []
br = "j2k-encoder"
if subprocess.run(["git", "-C", REPO, "rev-parse", "--verify", "-q", br], capture_output=True).returncode == 0:
    onlybr = [p for p in subprocess.run(["git", "-C", REPO, "diff", "--name-only", "--diff-filter=A", f"{REF}...{br}"], capture_output=True, text=True).stdout.split("\n") if p.startswith("codecs/shl-codec-jpeg2000-encode/")]
    l2, _, _ = count(br, onlybr, extra_leaf=("Rust codecs", "JPEG 2000 encoder (in review)"))
    bsha = subprocess.run(["git", "-C", REPO, "rev-parse", "--short", br], capture_output=True, text=True).stdout.strip()
    for k, v in l2.items():
        review.append({"group": k[0], "leaf": k[1], "langs": dict(v), "branch": br, "commit": bsha})

out = {"ref": REF, "commit": sha, "rule": "non-blank lines of tracked source files; see docs/poster/scripts/codemap.py",
       "leaves": [{"group": g, "leaf": leaf, "langs": dict(v), "upstream": "upstream" in leaf} for (g, leaf), v in sorted(leaves.items())],
       "review": review, "generated": generated,
       "skipped_source_files": dict(sorted(skipped.items(), key=lambda x: -x[1]))}
tot = defaultdict(int)
for x in out["leaves"]:
    key = ("upstream" if x["upstream"] else x["group"])
    tot[key] += sum(x["langs"].values())
out["totals"] = dict(tot)
out["total_own"] = sum(v for k, v in tot.items() if k != "upstream")
json.dump(out, open(OUT, "w"), indent=1)
print(json.dumps({"commit": sha, "totals": out["totals"], "own": out["total_own"], "generated": generated, "review": review, "skipped": list(out["skipped_source_files"].items())[:15]}, indent=1))
