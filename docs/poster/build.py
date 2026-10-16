#!/usr/bin/env python3
"""Build the shlink-dicom poster (48 x 36 in).

  python3 docs/poster/build.py            # refresh data (git, live site), write poster.html, render PNG + PDF
  python3 docs/poster/build.py --offline  # reuse data/*.json, just re-render

Every number on the poster comes from data/poster.json, which records a source for each one:
  data/trace.json     scripts/trace.mjs, live trace of one MRI slice from the /sample link
  data/codemap.json   scripts/codemap.py, line counts from git ls-tree on main
  data/timeline.json  scripts/timeline.py, git log on main
  data/facts.json     sourced facts (reports, docs, GitHub), re-checkable with data/facts_cmds.sh
"""
import json, os, subprocess, sys, html, math, base64, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
DATA = os.path.join(HERE, "data")
OFFLINE = "--offline" in sys.argv
W, H = 4608, 3456  # CSS px at 96/in = 48 x 36 in

def run(*a, **k):
    print("+", " ".join(a)); subprocess.run(a, check=True, cwd=HERE, **k)

if not OFFLINE:
    run("python3", "scripts/codemap.py", "main", os.path.join(DATA, "codemap.json"))
    run("python3", "scripts/timeline.py", os.path.join(DATA, "timeline.json"))
    run("node", "scripts/trace.mjs", "https://shlink-dicom.exe.xyz", os.path.join(DATA, "trace.json"))
    run(os.path.join(REPO, "codec-corpus/.venv/bin/python"), "-I", "scripts/slice_png.py")
    run("node", "scripts/qr.mjs", "https://shlink-dicom.exe.xyz/sample", os.path.join(HERE, "assets", "qr-sample.svg"))

load = lambda n: json.load(open(os.path.join(DATA, n)))
TR, CM, TL = load("trace.json"), load("codemap.json"), load("timeline.json")
FACTS = load("facts.json") if os.path.exists(os.path.join(DATA, "facts.json")) else {}
S = TR["slice"]

# ---------------------------------------------------------------- numbers with sources
P = {}          # id -> {display, value, source}
MISSING = []
def num(i, display, value=None, source=""):
    P[i] = {"display": display, "value": value if value is not None else display, "source": source}
    return html.escape(str(display))
def fact(i, fallback="—"):
    f = FACTS.get(i)
    if not f or f.get("ok") is False:
        MISSING.append(i)
        if not f: return html.escape(fallback)
    P[i] = {"display": f.get("display"), "value": f.get("value"), "source": f.get("source"), "quote": f.get("quote")}
    return html.escape(str(f.get("display")))
def fv(i, key="display", default=None):
    f = FACTS.get(i) or {}
    return f.get(key, default)

c = lambda n: f"{n:,}"
mb = lambda n: f"{n/1e6:.1f} MB"
TRS = "docs/poster/scripts/trace.mjs (live, " + TR["measuredAt"][:16].replace("T", " ") + "Z)"
jwe_kb = num("jwe_bytes", f"{round(TR['jwe']['bytes']/1000)} KB", TR["jwe"]["bytes"], TRS)
num("files_count", str(TR["filesCount"]), TR["filesCount"], TRS)
num("share_total", mb(TR["totalCiphertext"]), TR["totalCiphertext"], TRS)
num("bundle_instances", c(TR["bundle"]["instances"]), TR["bundle"]["instances"], TRS)
num("bundle_series", str(TR["bundle"]["series"]), TR["bundle"]["series"], TRS)
for k in ["fileBytes", "fileRecords", "firstRecord", "lastRecord", "range", "responseBytes", "records", "instanceOffset", "instanceBytes",
          "seriesOffset", "seriesBytes", "seriesFirstRecord", "seriesLastRecord", "seriesBefore", "offsetInFirstRecord", "tagsOk", "transferSyntax"]:
    num("slice_" + k, S[k], S[k], TRS)

# ---------------------------------------------------------------- helpers
def esc(s): return html.escape(str(s))
def data_uri(path, mime):
    return f"data:{mime};base64," + base64.b64encode(open(path, "rb").read()).decode()

ORANGE, BLUE, AQUA, GREY = "#eb6834", "#2a78d6", "#1baf7a", "#9aa0a6"
LANGCOL = {"Rust": ORANGE, "TypeScript": BLUE, "JavaScript": BLUE, "Python": AQUA}
LANGNAME = {"Rust": "Rust", "TypeScript": "TypeScript / JavaScript", "JavaScript": "TypeScript / JavaScript", "Python": "Python"}

# ---------------------------------------------------------------- treemap (squarified)
def squarify(items, x, y, w, h):
    """items: list of (value, payload) sorted desc. returns list of (payload, x, y, w, h)."""
    out = []
    items = [it for it in items if it[0] > 0]
    total = sum(v for v, _ in items)
    if not items or w <= 0 or h <= 0: return out
    scale = w * h / total
    rest = [(v * scale, p) for v, p in items]
    def worst(row, side):
        s = sum(a for a, _ in row); mx = max(a for a, _ in row); mn = min(a for a, _ in row)
        return max(side * side * mx / (s * s), (s * s) / (side * side * mn))
    while rest:
        side = min(w, h); row = [rest.pop(0)]
        while rest and worst(row + [rest[0]], side) <= worst(row, side):
            row.append(rest.pop(0))
        s = sum(a for a, _ in row)
        if w >= h:   # lay row as a column on the left
            cw = s / h; yy = y
            for a, p in row:
                hh = a / cw; out.append((p, x, yy, cw, hh)); yy += hh
            x += cw; w -= cw
        else:        # lay row along the top
            rh = s / w; xx = x
            for a, p in row:
                ww = a / rh; out.append((p, xx, y, ww, rh)); xx += ww
            y += rh; h -= rh
    return out

def lang_bucket(l):
    return l if l in ("Rust", "Python") else ("TypeScript" if l in ("TypeScript", "JavaScript") else "Other")

def treemap_svg(w, h):
    groups = {}
    for lf in CM["leaves"]:
        if lf.get("upstream"): continue
        groups.setdefault(lf["group"], []).append(dict(lf))
    for r in CM.get("review", []):
        groups.setdefault(r["group"], []).append({"group": r["group"], "leaf": r["leaf"], "langs": r["langs"], "upstream": False, "review": True})
    gorder = ["Rust codecs", "Web app", "Verification", "Server and protocol core", "SMART Imaging sandbox", "Spec and reference"]
    gitems = sorted([(sum(sum(l["langs"].values()) for l in groups[g]), g) for g in gorder if g in groups], reverse=True)
    pad, head = 6, 44
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" class="tm">',
             '<defs><pattern id="hatch" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
             '<rect width="14" height="14" fill="#fff" fill-opacity="0.55"/><line x1="0" y1="0" x2="0" y2="14" stroke="#fff" stroke-width="6"/></pattern>'
             '<pattern id="dots" width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="6" cy="6" r="2.4" fill="#fff"/></pattern></defs>']
    for (gv, g), gx, gy, gw, gh in [((v, g), *r[1:]) for (v, g), r in zip(gitems, squarify([(v, (v, g)) for v, g in gitems], 0, 0, w, h))]:
        parts.append(f'<rect x="{gx+2:.1f}" y="{gy+2:.1f}" width="{gw-4:.1f}" height="{gh-4:.1f}" fill="#f1f0ec" stroke="#fff" stroke-width="4"/>')
        own = sum(sum(l["langs"].values()) for l in groups[g] if not l.get("upstream") and not l.get("review"))
        SHORT = {"SMART Imaging sandbox": "Sandbox", "Spec and reference": "Spec", "Server and protocol core": "Server, core"}
        fs = 30 if gw > 360 else 24
        label = f"{g} · {own:,}" if gw > 520 else g
        if len(label) * fs * 0.55 > gw - 24: label = SHORT.get(g, g)
        if len(label) * fs * 0.55 > gw - 24: label = ""
        parts.append(f'<text x="{gx+16:.1f}" y="{gy+34:.1f}" class="tmg" style="font-size:{fs}px">{esc(label)}</text>')
        leaves = sorted([(sum(l["langs"].values()), l) for l in groups[g]], key=lambda t: -t[0])
        for lf, x, y, ww, hh in squarify(leaves, gx + pad, gy + head, gw - 2 * pad, gh - head - pad):
            # language slices within the leaf
            langs = {}
            for l, n in lf["langs"].items(): langs[lang_bucket(l)] = langs.get(lang_bucket(l), 0) + n
            tot = sum(langs.values()); order = [k for k in ("Rust", "TypeScript", "Python", "Other") if k in langs]
            horiz = ww >= hh; off = 0
            for k in order:
                frac = langs[k] / tot; col = LANGCOL.get(k, GREY)
                if horiz: rx, ry, rw, rh = x + off * ww, y, frac * ww, hh
                else: rx, ry, rw, rh = x, y + off * hh, ww, frac * hh
                parts.append(f'<rect x="{rx:.1f}" y="{ry:.1f}" width="{max(rw,0):.1f}" height="{max(rh,0):.1f}" fill="{col}"/>')
                off += frac
            if lf.get("upstream"): parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{ww:.1f}" height="{hh:.1f}" fill="url(#hatch)"/>')
            if lf.get("review"): parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{ww:.1f}" height="{hh:.1f}" fill="url(#dots)"/>')
            parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{ww:.1f}" height="{hh:.1f}" fill="none" stroke="#fff" stroke-width="3"/>')
            n = sum(lf["langs"].values())
            name = lf["leaf"]
            if ww > 92 and hh > 46:
                fs = 26 if (ww > 330 and hh > 90) else (21 if ww > 150 else 18)
                maxch = int((ww - 20) / (fs * 0.52))
                words, lines, cur = name.split(), [], ""
                for wd in words:
                    if len(cur) + len(wd) + 1 > maxch and cur: lines.append(cur); cur = wd
                    else: cur = (cur + " " + wd).strip()
                lines.append(cur)
                maxl = max(1, int((hh - 14 - fs) / (fs * 1.15)))
                lines = lines[:maxl]
                ty = y + fs + 8
                for ln in lines:
                    cls = "tml dk" if lf.get("upstream") else "tml"
                    parts.append(f'<text x="{x+10:.1f}" y="{ty:.1f}" class="{cls}" style="font-size:{fs}px">{esc(ln)}</text>'); ty += fs * 1.15
                if ty + fs * 0.9 < y + hh:
                    parts.append(f'<text x="{x+10:.1f}" y="{ty+2:.1f}" class="{"tmn dk" if lf.get("upstream") else "tmn"}" style="font-size:{fs*0.85:.0f}px">{n:,}</text>')
    parts.append("</svg>")
    return "".join(parts)

OWN_TREE = sum(sum(l["langs"].values()) for l in CM["leaves"] if not l.get("upstream")) + sum(sum(r["langs"].values()) for r in CM.get("review", []))
UPSTREAM = [(sum(l["langs"].values()), l["leaf"]) for l in CM["leaves"] if l.get("upstream")]
UP_TOTAL = sum(v for v, _ in UPSTREAM)
TM_H, TM_GAP, TM_W_ALL = 425, 40, 2210
TM_W = round((TM_W_ALL - TM_GAP) / (1 + UP_TOTAL / OWN_TREE)); UP_W = TM_W_ALL - TM_GAP - TM_W

# ---------------------------------------------------------------- the traced stack
def stack_svg(w):
    rowh = 150; gap = 14; n = 10
    h = n * rowh + (n - 1) * gap
    labx, valx = 0, 540
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" class="stack">',
         '<defs><marker id="sa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z" fill="#8b9097"/></marker></defs>']
    rows = [
        ("1", "SMART Health Link", "#e07f22",
         [("mono", "…/view#shlink:/eyJ1cmwiOiJodHRwczovL3No…"),
          ("txt", f"After the #, which browsers never send. Holds the JWE's url, a {TR['linkKeyBytes']}-byte key, flag {TR['linkFlag']}.")]),
        ("2", "JWE", "#7b4fa8",
         [("big", f"bundle.jwe · {jwe_kb}"),
          ("txt", f"alg {TR['jwe']['header'].get('alg')}, enc {TR['jwe']['header'].get('enc')}, zip {TR['jwe']['header'].get('zip')}. One GET; opened with the link's key.")]),
        ("3", "FHIR Bundle", "#7b4fa8",
         [("big", f"1 Patient · {TR['bundle']['types'].get('ImagingStudy')} ImagingStudy · {TR['bundle']['types'].get('DiagnosticReport')} DiagnosticReport"),
          ("txt", f"Plain FHIR R4: {TR['bundle']['series']} series and {TR['bundle']['instances']:,} DICOM instances in all.")]),
        ("4", "ImagingStudy", "#7b4fa8",
         [("mono", "linked-file: the study's file id and 32-byte key"),
          ("mono", "instance-length: bytes in each instance"),
          ("txt", f"{S['seriesOffset']:,} ({S['seriesBefore']} series before series 16) + {S['instanceOffset']-S['seriesOffset']:,} (instances 1–10) = {S['instanceOffset']:,}, where instance 11 starts.")]),
        ("5", "Study file", "#2a78d6", [("strip", None)]),
        ("6", f"Records {S['firstRecord']}–{S['lastRecord']}", "#2a78d6", [("recs", None)]),
        ("7", "Range request", "#2a78d6",
         [("mono", f"GET …/{S['fileId']}.bin"), ("monob", f"Range: {S['range']}"),
          ("txt", f"→ {S['liveStatus']} Partial Content: {S['responseBytes']:,} bytes, {S['records']} records.")]),
        ("8", "GCM tag check", "#4f9d3a",
         [("big", f"{S['tagsOk']} of {S['records']} tags verified"),
          ("txt", "Nonce = record number. A changed, moved or missing record fails; its bytes are never used.")]),
        ("9", "DICOM file", "#4f9d3a",
         [("big", f"Instance 11: {S['instanceBytes']:,} bytes"),
          ("mono", f"{S['transferSyntax']}: JPEG Lossless, SV1"),
          ("txt", f"From byte {S['offsetInFirstRecord']:,} of record {S['firstRecord']}: preamble, DICM, header, Pixel Data.")]),
        ("10", "Pixels", "#4f9d3a", [("img", None)]),
    ]
    maxch = int((w - valx - 24) / 13.3)
    def wrapn(t):
        n_, line = 1, ""
        for wd in t.split():
            if len(line) + len(wd) + 1 > maxch: n_ += 1; line = wd
            else: line = (line + " " + wd).strip()
        return n_
    UNIT = {"big": 44, "mono": 37, "monob": 38, "strip": 112, "recs": 124, "img": 126}
    heights = [max(104, 26 + sum(UNIT[kd] if kd != "txt" else 35 * wrapn(t) for kd, t in ct) + 22) for _, _, _, ct in rows]
    h = sum(heights) + gap * (n - 1)
    o[0] = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" class="stack">'
    ys = [sum(heights[:i]) + gap * i for i in range(n)]
    for i, (k, name, col, content) in enumerate(rows):
        y = ys[i]; rowh = heights[i]
        o.append(f'<rect x="0" y="{y}" width="{w}" height="{rowh}" rx="14" fill="{col}" fill-opacity="0.07" stroke="{col}" stroke-opacity="0.55" stroke-width="2"/>')
        o.append(f'<circle cx="44" cy="{y+50}" r="24" fill="{col}"/><text x="44" y="{y+59}" class="sn" text-anchor="middle">{k}</text>')
        o.append(f'<text x="84" y="{y+60}" class="sh">{esc(name)}</text>')
        if i < n - 1:
            o.append(f'<line x1="44" y1="{y+rowh+2}" x2="44" y2="{y+rowh+gap-3}" stroke="#8b9097" stroke-width="3" marker-end="url(#sa)"/>')
        cy = y + 40
        for kind, txt in content:
            if kind == "big":
                o.append(f'<text x="{valx}" y="{cy+12}" class="sb">{esc(txt)}</text>'); cy += 44
            elif kind in ("mono", "monob"):
                o.append(f'<text x="{valx}" y="{cy+8}" class="{"smb" if kind=="monob" else "sm"}">{esc(txt)}</text>'); cy += 37
            elif kind == "txt":
                # wrap
                words = txt.split(); line = ""
                for wd in words:
                    if len(line) + len(wd) + 1 > maxch:
                        o.append(f'<text x="{valx}" y="{cy+8}" class="st">{esc(line)}</text>'); cy += 35; line = wd
                    else: line = (line + " " + wd).strip()
                o.append(f'<text x="{valx}" y="{cy+8}" class="st">{esc(line)}</text>'); cy += 35
            elif kind == "strip":
                sx, sw, sy, sh = valx, w - valx - 30, y + 62, 36
                nrec = S["fileRecords"]; X = lambda r: sx + r * sw / nrec
                o.append(f'<text x="{valx}" y="{y+42}" class="sb">{S["fileBytes"]:,} bytes · {nrec} records of 64 KiB</text>')
                o.append(f'<rect x="{sx}" y="{sy}" width="{sw}" height="{sh}" fill="#dbe7f6"/>')
                a1, a2 = X(S["seriesFirstRecord"]), X(S["seriesLastRecord"] + 1)
                o.append(f'<rect x="{a1:.1f}" y="{sy}" width="{a2-a1:.1f}" height="{sh}" fill="#2a78d6" fill-opacity="0.35"/>')
                b1, b2 = X(S["firstRecord"]), X(S["lastRecord"] + 1)
                o.append(f'<rect x="{b1:.1f}" y="{sy-6}" width="{max(b2-b1,6):.1f}" height="{sh+12}" fill="#2a78d6"/>')
                o.append(f'<text x="{sx}" y="{sy+sh+32}" class="st">series 16: records {S["seriesFirstRecord"]}–{S["seriesLastRecord"]} · instance 11: {S["firstRecord"]}–{S["lastRecord"]}</text>')
            elif kind == "recs":
                nr = S["records"]; rx, rw, ry, rh = valx, (w - valx - 30) / nr, y + 22, 66
                for j in range(nr):
                    x0 = rx + j * rw
                    o.append(f'<rect x="{x0:.1f}" y="{ry}" width="{rw-14:.1f}" height="{rh}" fill="#2a78d6" fill-opacity="0.85"/>')
                    o.append(f'<rect x="{x0+rw-14:.1f}" y="{ry}" width="8" height="{rh}" fill="#2b2f36"/>')
                    o.append(f'<text x="{x0+(rw-14)/2:.1f}" y="{ry+44}" class="sr" text-anchor="middle">{S["firstRecord"]+j}</text>')
                o.append(f'<text x="{valx}" y="{ry+rh+38}" class="st">Each: 65,520 encrypted bytes + a 16-byte tag (dark band).</text>')
            elif kind == "img":
                o.append(f'<image x="{valx}" y="{y+8}" width="134" height="134" href="{data_uri(os.path.join(HERE,"assets","slice.png"),"image/png")}"/>')
                o.append(f'<text x="{valx+170}" y="{y+62}" class="sb">T2 FSE AX, instance 11 of {S["instancesInSeries"]}</text>')
                o.append(f'<text x="{valx+170}" y="{y+104}" class="st">512 × 512, decoded in WebAssembly, windowed on the GPU.</text>')
    o.append("</svg>")
    return "".join(o), h

# ---------------------------------------------------------------- timeline
def timeline_html(w):
    ev = TL["events"]
    t0 = datetime.datetime.fromisoformat(TL["first"]["date"]); t1 = datetime.datetime.fromisoformat(TL["last"]["date"])
    span = (t1 - t0).total_seconds(); L, R = 30, w - 30
    X = lambda t: L + (datetime.datetime.fromisoformat(t) - t0).total_seconds() / span * (R - L)
    ax = 74
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} 120" width="{w}" height="120" class="tl">']
    o.append(f'<line x1="{L}" y1="{ax}" x2="{R}" y2="{ax}" stroke="#2b2f36" stroke-width="3"/>')
    tick = t0.replace(minute=0, second=0) + datetime.timedelta(hours=1)
    while tick <= t1:
        if tick.hour % 6 == 0:
            xx = L + (tick - t0).total_seconds() / span * (R - L)
            o.append(f'<line x1="{xx:.1f}" y1="{ax}" x2="{xx:.1f}" y2="{ax+14}" stroke="#2b2f36" stroke-width="2"/>')
            o.append(f'<text x="{xx:.1f}" y="{ax+42}" class="tlt" text-anchor="middle">{tick.strftime("%a %H:%M")}</text>')
        tick += datetime.timedelta(hours=1)
    lastx = -99; lane = 0
    for k, e in enumerate(ev):
        xx = X(e["date"])
        lane = lane + 1 if xx - lastx < 34 else 0; lastx = xx
        yy = ax - 18 - lane * 30
        o.append(f'<circle cx="{xx:.1f}" cy="{ax}" r="7" fill="#7b4fa8"/>')
        o.append(f'<text x="{xx:.1f}" y="{yy:.1f}" class="tln" text-anchor="middle">{k+1}</text>')
    o.append("</svg>")
    items = "".join(f'<li><b>{datetime.datetime.fromisoformat(e["date"]).strftime("%a %H:%M")}</b> {esc(e["label"])}</li>' for e in ev)
    return "".join(o) + f'<ol class="tll">{items}</ol>'

# ---------------------------------------------------------------- page
AG_DIR = os.path.expanduser("~/.claude/projects/-home-jmandel-hobby-smart-health-checkin/0c360f75-6e42-4bb2-af89-350946f294a1/subagents")
AGENTS = len([f for f in os.listdir(AG_DIR) if f.endswith(".jsonl")]) if os.path.isdir(AG_DIR) else None
if AGENTS is None: AGENTS = 42; MISSING.append("subagent_count (transcript directory not found; using the blog's 42)")
num("subagent_count", str(AGENTS), AGENTS, f"count of subagent transcripts (*.jsonl) in the coordinator session's subagents/ directory, {datetime.datetime.now().strftime('%d %b %H:%M')}; same method as the blog's footnote")
# object-type sweep, from the committed report on main
import re as _re
SW_PATH = "codec-corpus/prevalence/SOPCLASS_SWEEP.md"
SW = subprocess.run(["git", "-C", REPO, "show", f"main:{SW_PATH}"], capture_output=True, text=True).stdout
_m1 = _re.search(r"(\d+) cases covering (\d+) SOP classes", SW); _m2 = _re.search(r"(\d+) cases pass, (\d+) fail and (\d+) are unsupported", SW); _m3 = _re.search(r"failures come from (\w+) defects", SW)
SWEEP = {"cases": _m1.group(1), "classes": _m1.group(2), "pass": _m2.group(1), "fail": _m2.group(2), "unsupported": _m2.group(3), "defects": _m3.group(1)} if (_m1 and _m2 and _m3) else None
if SWEEP:
    for k, v in SWEEP.items(): num("sop_sweep_" + k, v, v, f"{SW_PATH} on main ({CM['commit']}), Summary")
else: MISSING.append("sop_sweep")
num("commits", str(TL["commits"]), TL["commits"], "git rev-list --count main")
num("first_commit", datetime.datetime.fromisoformat(TL["first"]["date"]).strftime("%a %d %b %H:%M"), TL["first"]["date"], "git log on main")
num("code_own", c(CM["total_own"]), CM["total_own"], "docs/poster/scripts/codemap.py on main " + CM["commit"])
gen = list(CM["generated"].values())[0] if CM["generated"] else None
if gen: num("code_generated", c(gen["lines"]), gen["lines"], gen["path"])

stack, stack_h = stack_svg(1500)
qr = open(os.path.join(HERE, "assets", "qr-sample.svg")).read()
art = data_uri(os.path.join(HERE, "assets", "header-art.png"), "image/png")

def groups_line():
    order = ["Web app", "Verification", "Rust codecs", "Server and protocol core", "SMART Imaging sandbox", "Spec and reference"]
    t = CM["totals"]
    return " · ".join(f"<b>{esc(g)}</b> {t.get(g,0):,}" for g in order if g in t) 

def src(i):
    f = FACTS.get(i)
    if not f: MISSING.append(i); return ""
    P[i] = {"display": f.get("display"), "value": f.get("value"), "source": f.get("source"), "quote": f.get("quote"), "note": f.get("note")}
    return ""

def li(items): return "<ul>" + "".join(f"<li>{x}</li>" for x in items) + "</ul>"

questions = fv("design_questions", "value") or []
QEFFECT = ["No ZIP container: offsets in the ImagingStudy and the GCM tags already locate and protect every byte.",
           "No optional compression layer: DICOM already carries its own compression, so every client has one code path.",
           "No end-of-file marker: the Bundle states every length, so a cut-short file shows up in the arithmetic.",
           "No key derivation: each file has its own random key, carried in the Bundle."]
def qhtml():
    if not isinstance(questions, list) or not questions:
        MISSING.append("design_questions"); return "<p class='todo'>[design questions: source pending]</p>"
    P["design_questions"] = {"display": "4 questions", "value": questions, "source": fv("design_questions", "source")}
    out = []
    for q in questions[:4]:
        qt = q.get("q") if isinstance(q, dict) else str(q); ef = QEFFECT[questions.index(q)] if questions.index(q) < len(QEFFECT) else ""
        out.append(f'<div class="q"><p class="qq">“{esc(qt)}”</p><p class="qe">{esc(ef)}</p></div>')
    return "".join(out)

FEAT_VIEW = [("ct_mr_reformats_oblique_slabs", "CT and MR reformats: oblique planes, slabs"),
             ("xray_voi_luts", "X-rays with their VOI LUTs"),
             ("whole_slide_tiles", "Whole-slide pathology, tile by tile"),
             ("video", "Video, including MPEG-2"),
             ("sr", "Structured reports (dose)"),
             ("seg", "Segmentations"),
             ("pdf", "Encapsulated PDF"),
             ("reports_beside_images", "Reports beside the images"),
             ("study_download_zip_dicomdir", "Download: a ZIP with DICOMDIR"),
             ("dark_mode", "Dark mode"), ("phone_layout", "Phone layout")]
FEAT_SHARE = [("share_from_files_cd_dicomdir", "Files, a folder, a CD, an archive"),
              ("share_from_received_shl", "From a link someone sent"),
              ("share_from_smart_imaging_access", "From a provider, by SMART Imaging Access"),
              ("lossless_compression_sv1", "Lossless JPEG or JPEG 2000"),
              ("resumable_uploads", "Resumable uploads"),
              ("local_or_s3_storage", "Local disk or S3 storage"),
              ("owner_link_open_counts", "Owner link: open counts, revoke")]
def feats(lst):
    fl = fv("feature_list", "value") or {}
    out = []
    for k, name in lst:
        e = fl.get(k)
        if not e: MISSING.append("feature:" + k); continue
        if "BRANCH" in str(e.get("where", "")): continue
        P["feature:" + k] = {"display": name, "value": e.get("where"), "source": e.get("path")}
        out.append(esc(name))
    return '<ul class="two">' + "".join(f"<li>{x}</li>" for x in out) + "</ul>"

legend = "".join(f'<span class="lg"><i style="background:{col}"></i>{n}</span>' for n, col in [("Rust", ORANGE), ("TypeScript / JavaScript", BLUE), ("Python", AQUA), ("Other (SQL, C, shell, CSS, HTML, Markdown)", GREY)])
legend += ('<span class="lg"><i class="dot"></i>In review, not on main</span>' if CM.get("review") else '')

HTML = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Your Images, in Your Hands: poster</title>
<style>
@page {{ size: 48in 36in; margin: 0; }}
:root {{ --ink:#1d1e20; --muted:#55595f; --rule:#d9d6cf; --bg:#fcfbf9; --purple:#7b4fa8; --orange:#e07f22; --blue:#2a78d6; --green:#4f9d3a; --red:#d9423a; --yellow:#e9b824; }}
* {{ box-sizing:border-box; }}
html,body {{ margin:0; padding:0; background:var(--bg); }}
body {{ width:{W}px; height:{H}px; position:relative; overflow:hidden; color:var(--ink); font-family:"Noto Sans",system-ui,sans-serif; font-size:30px; line-height:1.42; }}
.serif {{ font-family:"Noto Serif",Georgia,serif; }}
code,.mono {{ font-family:"Source Code Pro",monospace; font-size:0.92em; }}
.box {{ position:absolute; }}
h2 {{ font-family:"Noto Serif",Georgia,serif; font-size:58px; line-height:1.1; margin:0 0 22px; padding-top:18px; border-top:6px solid var(--ink); }}
h2 .k {{ color:var(--muted); font-weight:400; font-size:40px; margin-right:16px; }}
h3 {{ font-size:31px; margin:16px 0 6px; letter-spacing:0.01em; }}
p {{ margin:0 0 16px; }}
ul {{ margin:0 0 12px; padding-left:34px; }} li {{ margin:0 0 8px; }}
ul.two {{ columns:2; column-gap:40px; font-size:26px; line-height:1.3; }} ul.two li {{ break-inside:avoid; margin:0 0 6px; }}
.muted {{ color:var(--muted); }} .small {{ font-size:25px; line-height:1.38; }}
.todo {{ color:#b00; font-weight:700; }}
/* title band */
.title h1 {{ font-family:"Noto Serif",Georgia,serif; font-size:150px; line-height:1.0; margin:0; letter-spacing:-0.01em; }}
.title .sub {{ font-size:66px; color:#2f6fae; margin:22px 0 0; line-height:1.15; }}
.title .thesis {{ font-size:40px; margin:34px 0 0; max-width:2050px; line-height:1.35; }}
.title .by {{ font-size:34px; margin-top:26px; color:var(--muted); }}
.qrbox {{ text-align:center; font-size:27px; }}
.qrbox svg {{ width:400px; height:400px; display:block; margin:0 auto 10px; }}
/* stack */
.stack text {{ fill:var(--ink); font-family:"Noto Sans",system-ui,sans-serif; }}
.stack .sh {{ font-size:36px; font-weight:700; }} .stack .sn {{ font-size:28px; font-weight:700; fill:#fff; }}
.stack .sb {{ font-size:36px; font-weight:700; }} .stack .sb2 {{ font-size:30px; font-weight:700; font-family:"Source Code Pro",monospace; }}
.stack .st {{ font-size:27px; fill:#3d4147; }} .stack .sm {{ font-size:28px; font-family:"Source Code Pro",monospace; }}
.stack .smb {{ font-size:32px; font-weight:700; font-family:"Source Code Pro",monospace; fill:#174f94; }} .stack .sr {{ font-size:26px; font-weight:700; fill:#fff; }}
.client {{ border:2px solid var(--rule); border-radius:14px; padding:20px 22px; margin:0 0 20px; background:#fff; }}
.client b {{ font-size:32px; display:block; margin-bottom:6px; }}
.client .tag {{ display:inline-block; font-size:22px; padding:2px 12px; border-radius:20px; background:#e9f3e6; color:#2f6b22; margin-bottom:8px; }}
.client .tag.no {{ background:#eef0f2; color:#55595f; }}
/* trust */
.trust {{ display:grid; grid-template-columns:1fr 1fr 1fr; gap:14px; margin:6px 0 18px; }}
.trust div {{ border:2px solid var(--rule); border-radius:12px; padding:14px 16px; font-size:25px; line-height:1.35; background:#fff; }}
.trust b {{ display:block; font-size:28px; margin-bottom:6px; }}
.trust .pu {{ border-color:#7b4fa8; }} .trust .ho {{ border-color:#8b9097; background:#f4f3f0; }} .trust .gr {{ border-color:#4f9d3a; }}
/* evidence */
.stat {{ display:flex; gap:20px; align-items:baseline; margin:0 0 12px; }}
.stat .n {{ font-family:"Noto Serif",Georgia,serif; font-size:50px; font-weight:700; min-width:290px; line-height:1; white-space:nowrap; }}
.stat .d {{ font-size:25px; line-height:1.32; }}
.slot {{ border:3px dashed #b8b2a6; border-radius:12px; padding:18px 20px; color:var(--muted); font-size:26px; }}
/* code map */
.tm text {{ font-family:"Noto Sans",system-ui,sans-serif; }} .tm .tmg {{ font-weight:700; fill:var(--ink); }} .tm .tml {{ fill:#fff; font-weight:700; }} .tm .tmn {{ fill:#fff; }} .tm .dk {{ fill:#5a2a10; }}
.lg {{ display:inline-flex; align-items:center; gap:10px; margin:0 26px 8px 0; font-size:24px; }}
.lg i {{ width:28px; height:28px; display:inline-block; border-radius:4px; }}
.lg i.ghat {{ background:repeating-linear-gradient(45deg,#dcd9d2 0 5px,#f3f2ee 5px 11px); border:2px dashed #b9b5ad; }}
.lg i.dot {{ background:radial-gradient(circle,#fff 3px,#eb6834 3.5px) 0 0/10px 10px; }}
/* built */
.tl text {{ font-family:"Noto Sans",system-ui,sans-serif; fill:var(--ink); }} .tl .tlt {{ font-size:24px; fill:var(--muted); }}
.tl .tln {{ font-size:22px; font-weight:700; fill:#7b4fa8; }}
.tll {{ columns:2; column-gap:30px; font-size:22px; line-height:1.27; margin:8px 0 0; padding-left:40px; }} .tll li {{ margin:0 0 6px; break-inside:avoid; }} .tll li::marker {{ color:#7b4fa8; font-weight:700; }}
.q {{ border-left:6px solid var(--purple); padding:2px 0 2px 18px; margin:0 0 12px; }}
.q .qq {{ font-family:"Noto Serif",Georgia,serif; font-size:29px; font-style:italic; margin:0 0 4px; line-height:1.3; }}
.q .qe {{ font-size:23px; color:var(--muted); margin:0; }}
.agentline {{ font-size:24px; line-height:1.38; margin:-6px 0 16px; }} .agentline b {{ font-family:"Noto Serif",Georgia,serif; font-size:34px; }}
.agents {{ display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin:4px 0 22px; }}
.agents div {{ border:2px solid var(--rule); border-radius:12px; padding:10px 16px; font-size:23px; background:#fff; line-height:1.3; }}
.agents b {{ font-size:40px; font-family:"Noto Serif",Georgia,serif; display:block; }}
footer {{ position:absolute; left:88px; right:88px; bottom:22px; border-top:3px solid var(--ink); padding-top:10px; font-size:23px; line-height:1.45; }}
footer b {{ font-weight:700; }}
</style></head><body>

<div class="box title" style="left:88px; top:70px; width:2400px;">
  <h1>Your Images, in Your Hands</h1>
  <p class="sub">Sharing whole imaging studies with a SMART Health Link</p>
  <p class="thesis">One link can carry a complete imaging study: every DICOM file, pixels unchanged, end-to-end encrypted on a host that never holds the key. Any app that can fetch and decrypt can open it.</p>
  <p class="by">Josh Mandel · shlink-dicom · October 2026</p>
</div>
<img class="box" src="{art}" style="left:2440px; top:40px; height:560px;" alt="">
<div class="box qrbox" style="left:4100px; top:90px; width:420px;">{qr}<b>Open the sample</b><br><span class="mono">shlink-dicom.exe.xyz/sample</span></div>

<!-- column 1 -->
<div class="box" style="left:88px; top:630px; width:1100px;">
  <h2>The question</h2>
  <p>Patients have a legal right to copies of their imaging. In practice a study usually arrives on a CD, or can be looked at in a provider's portal.</p>
  <p><b>SMART Health Links</b> share health records by link or QR code: a URL to an encrypted file plus the key to open it.</p>
  <p><b>SMART Imaging Access</b> lets patients use any app they choose to fetch imaging from their providers through standard APIs (FHIR and DICOMweb).</p>
  <p class="serif" style="font-size:42px; line-height:1.22; margin:20px 0 6px;"><b>Can one link carry a whole study, every DICOM file, in a form any app can fetch?</b></p>

  <h2 style="margin-top:34px;">Trust and lifecycle</h2>
  <div class="trust">
    <div class="pu"><b>Sharer's device</b>Reads the files, can compress them losslessly, encrypts each study under its own key. Sees the study.</div>
    <div class="ho"><b>Host</b>Stores bundle.jwe and one encrypted file per study. Sees random file names, sizes and byte ranges; no names, UIDs or keys.</div>
    <div class="gr"><b>Recipient's device</b>Opens the link, checks every record, decrypts, decodes. Sees the study.</div>
  </div>
  <p>Plaintext exists only on the two devices. The key travels in the link, after the <code>#</code>.</p>
  {li([
    "<b>Owner link.</b> No accounts. The owner page shows how often each link was opened, and revokes it: then the server answers 404.",
    "<b>Re-share a subset without re-uploading.</b> Each study has its own key, so a link to one study is just a new bundle.jwe holding that study's key.",
    f"<b>Storage.</b> Local disk, or a private S3 bucket. Reads go through the server by default; in redirect mode the presigned URLs last 60 seconds at most.{src('s3_presign_window')}",
  ])}

  <h2 style="margin-top:30px;">Standards work</h2>
  {li([
    f"<b>Pull request #5</b> to argonautproject/smart-imaging (open): transfer-syntax negotiation for WADO-RS.{src('smart_imaging_pr5')}",
    f"<b>Issue #2</b> (open): the token response example omits token_type and scope.{src('smart_imaging_issue2')}",
    f"<b>Issue #3</b> (open): what apps send for transfer syntax, and what happens when it is omitted.{src('smart_imaging_issue3')}",
    f"Building a strict server and client against the guide found <b>14 places</b> where it was unclear.{src('guide_unclear_count')}",
    "The profile and its extensions use URLs under the HL7 SMART Health Cards and Links guide, proposed for publication there.",
  ])}
</div>

<!-- column 2: the stack -->
<div class="box" style="left:1252px; top:630px; width:2104px;">
  <h2>One slice, from link to pixels</h2>
  <p class="muted" style="margin:-8px 0 22px; font-size:27px;">Traced by script on the live sample, {datetime.datetime.fromisoformat(TR['measuredAt'].replace('Z','+00:00')).astimezone().strftime('%d %b %Y, %H:%M %Z')}: brain MRI, series 16, instance 11. The share: {TR['filesCount']} encrypted files, one per study, {mb(TR['totalCiphertext'])}.</p>
  <div style="display:flex; gap:44px;">
    <div style="width:1500px;">{stack}</div>
    <div style="width:560px;">
      <h3 style="margin-top:0;">Clients that can follow the same link</h3>
      <p class="small muted">The link and files are plain HTTP, FHIR and DICOM. Any program that can fetch, check and decrypt can use them.</p>
      <div class="client"><span class="tag">built: /view</span><b>Browser viewer</b>Fetches only the records for the images on screen, one Range request each.</div>
      <div class="client"><span class="tag">built: receiver.js</span><b>Download script</b>About 60 lines of fetch and WebCrypto: resolve the link, decrypt the Bundle, read and check records.</div>
      <div class="client"><span class="tag no">possible, not built here</span><b>PACS import</b>Fetch each study file whole, check every tag, write the original DICOM files into the archive.</div>
      <div class="client"><span class="tag no">possible, not built here</span><b>Research pipeline</b>Read the Bundle's index, fetch just the series it needs, and decode them with its own tools.</div>
    </div>
  </div>
</div>

<!-- column 3 -->
<div class="box" style="left:3420px; top:630px; width:1100px;">
  <h2>What it does</h2>
  <h3>Viewer</h3>{feats(FEAT_VIEW)}
  <h3>Sharing</h3>{feats(FEAT_SHARE)}

  <h2 style="margin-top:22px;">Evidence from real files</h2>
  <h3 style="margin-top:6px;">Decoders, against reference decoders</h3>
  <div class="stat"><span class="n">1,000 / 1,000</span><span class="d">random IDC files decoded exactly as the references do (95% interval 99.62–100%){src('idc_random_control')}</span></div>
  <div class="stat"><span class="n">9,522 / 9,537</span><span class="d">IDC files picked for rare scanners, software and encodings passed. The 15 others: 8 lack Planar Configuration (now inferred), 4 Leica JPEG 2000 off by ≤3 (ruled acceptable), 3 float maps (now decoded).{src('idc_longtail_pass')}</span></div>
  <div class="stat"><span class="n">{fv('corpus_real_cases','display','—').split(' ')[0]}</span><span class="d">real-image cases in the decoder test corpus, all passing{src('corpus_real_cases')}</span></div>
  <div class="stat"><span class="n">867 / 885</span><span class="d">renderings of real files on which dcmtk agrees within one grey level. The 18 others: 7 from our VOI LUT bit-depth rule, 8 with no stored window, 2 off by two levels, 1 where pydicom sides with us.{src('display_conformance')}</span></div>
  <p class="small muted" style="margin:0 0 4px;">JPEG 2000 and HTJ2K results re-checked with the new decoder: corpus byte-identical; 185 IDC long-tail JPEG 2000 files with the same outcome.{src('j2k_recheck')}</p>
  <h3>Lossless encoders</h3>
  <div class="stat"><span class="n">2.46×</span><span class="d">smaller with lossless JPEG (SV1) on Josh's five studies, 403 → 164 MB. Every image decodes bit-exact in libjpeg, GDCM and dcmtk.{src('encoder_ratio_sv1')}</span></div>
  <div class="stat"><span class="n">2.96×</span><span class="d">with lossless JPEG 2000, 403 → 136 MB; bit-exact under three OpenJPEG-based decoders.{src('encoder_ratio_j2k')}</span></div>
  <h3>Scripted browser checks</h3>
  <p class="small">Live: How it works 254 / 255 (one task took 109 ms; the limit is 100){src('e2e_checks_how')} · sandbox 153 / 153.{src('e2e_checks')}</p>
  <h3>Object types, viewed end to end</h3>
  <div class="stat"><span class="n">{SWEEP['pass']} / {SWEEP['cases']}</span><span class="d">cases pass, across {SWEEP['classes']} object types: all in IDC, plus five it lacks.{src('sop_census')} {SWEEP['fail']} fail, from {SWEEP['defects']} defects being fixed; {SWEEP['unsupported']} are labelled not displayed, with a download.</span></div>
  <p class="small muted" style="margin:0;">IDC has no Enhanced or Legacy Converted CT, MR or PET; those came from public test files and series derived from IDC.</p>
</div>

<!-- bottom: code map -->
<div class="box" style="left:88px; top:2545px; width:2210px;">
  <h2>The code, by job and language</h2>
  <div style="margin:-6px 0 12px;">{legend}</div>
  {treemap_svg(2210, TM_H)}
  <p class="small" style="margin:10px 0 4px;">{groups_line()}</p>
  <p class="small muted" style="margin-top:0;">{c(CM['total_own'])} non-blank lines of the project's own code on main ({CM['commit']}){(', plus ' + c(OWN_TREE-CM['total_own']) + ' lines in review') if OWN_TREE > CM['total_own'] else ''}. The generated DICOM dictionary is not counted.</p>
  <p class="small" style="margin:6px 0 0;">JPEG XL uses the jxl-oxide library. Everything else, including every JPEG 2000 and HTJ2K decoder and both encoders, is this project's code.</p>
</div>

<!-- bottom: how it was built -->
<div class="box" style="left:2362px; top:2545px; width:2158px;">
  <h2>How it was built</h2>
  <p class="agentline"><b>1</b> Claude Code session as coordinator, which owned the shared files, ran the checks and made the commits · <b>{AGENTS}</b> Claude subagents, each owning a directory · <b>1</b> pi session running Gemini, which built the first server and web page · <b>1</b> Codex session for the illustrations</p>
  <div style="display:flex; gap:44px;">
    <div style="width:1060px;"><h3 style="margin-top:0;">{TL['commits']} commits on main, first to latest</h3>{timeline_html(1060)}</div>
    <div style="width:1054px;"><h3 style="margin-top:0;">Questions that removed design layers</h3>{qhtml()}</div>
  </div>
</div>

<footer>
  <div><b>Links</b> · site <span class="mono">shlink-dicom.exe.xyz</span> · sample <span class="mono">shlink-dicom.exe.xyz/sample</span> · code and spec <span class="mono">github.com/jmandel/shlink-dicom</span> (PROPOSAL.md) · SMART Imaging sandbox <span class="mono">smart-imaging-sandbox.exe.xyz</span></div>
  <div><b>Data</b> · MRI, CT and X-rays: Josh Mandel's own, de-identified as Josh Example · lung slide: CPTAC-LUAD, CC BY 4.0 · shlink-dicom is a tech demo</div>
</footer>
</body></html>"""

open(os.path.join(HERE, "poster.html"), "w").write(HTML)
json.dump({"numbers": P, "missing": sorted(set(MISSING)), "built": datetime.datetime.now().isoformat(timespec="seconds")},
          open(os.path.join(DATA, "poster.json"), "w"), indent=1, default=str)
print("missing:", sorted(set(MISSING)))
run("node", "scripts/render.mjs")
