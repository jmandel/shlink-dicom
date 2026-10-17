"""Tables from perf/sessions results (JSON lines from run.mjs).

  python3 perf/sessions/aggregate.py results/*.jsonl [--max-load=N]

For each profile (net, device) and kind: per operation, p50 and p95 latency per build with the
sample count; then per session: stalls, stall time, session time, bytes, requests (medians).
--max-load leaves out sessions that ended with the machine's 1-minute load above N (another
job on the machine); how many were left out is printed.
"""
import json, sys
from collections import defaultdict

files = [a for a in sys.argv[1:] if not a.startswith("--")]
rows = [json.loads(l) for f in files for l in open(f) if l.strip()]
max_load = next((float(a.split("=")[1]) for a in sys.argv[1:] if a.startswith("--max-load=")), None)
if max_load is not None:
    kept = [r for r in rows if r.get("load", 0) <= max_load]
    print(f"Left out {len(rows) - len(kept)} of {len(rows)} sessions that ended with load above {max_load}.")
    rows = kept
builds = sorted({r["build"] for r in rows}, key=lambda b: (b != "main", b))


def pct(xs, p):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    return xs[min(len(xs) - 1, int(p * len(xs)))]


def med(xs):
    return pct(xs, 0.5)


def fmt(v, unit=""):
    if v is None:
        return "–"
    if unit == "MB":
        return f"{v / 1e6:.1f}"
    return f"{v:.0f}"


groups = defaultdict(list)
for r in rows:
    groups[(r["net"], r["device"], r["kind"])].append(r)

for (net, dev, kind), rs in sorted(groups.items()):
    print(f"\n### {kind} — {net}, {dev}  (sessions per build: " + ", ".join(f"{b} {sum(1 for r in rs if r['build'] == b)}" for b in builds) + ")")
    keys = []
    for r in rs:
        for o in r["ops"]:
            k = o["op"] + (":" + o["label"] if o.get("label") else "")
            if k not in keys:
                keys.append(k)
    print("| Operation | " + " | ".join(f"{b} p50 / p95 (n)" for b in builds) + " |")
    print("|---|" + "---|" * len(builds))
    for k in keys:
        cells = []
        for b in builds:
            ms, n, to = [], 0, 0
            for r in rs:
                if r["build"] != b:
                    continue
                for o in r["ops"]:
                    if o["op"] + (":" + o["label"] if o.get("label") else "") == k:
                        n += 1
                        if o.get("ms") is None:
                            to += 1
                        else:
                            ms.append(o["ms"])
            cells.append(f"{fmt(pct(ms, 0.5))} / {fmt(pct(ms, 0.95))} ({n}{', ' + str(to) + ' over cap' if to else ''})")
        print(f"| {k} | " + " | ".join(cells) + " |")
    for lab, f, unit in [("stalls", lambda r: r["stalls"], ""), ("stall ms", lambda r: r["stallMs"], ""), ("session ms", lambda r: r["totalMs"], ""), ("MB", lambda r: r["bytes"], "MB"), ("requests", lambda r: r["requests"], "")]:
        print(f"| session {lab} (median) | " + " | ".join(fmt(med([f(r) for r in rs if r["build"] == b]), unit) for b in builds) + " |")

if "--summary" in sys.argv:
    # One table per profile: each kind's open p50, its other operations' p50 / p95 (all of them
    # together), session time, MB and requests (medians), per build.
    profiles = sorted({(r["net"], r["device"]) for r in rows})
    for net, dev in profiles:
        print(f"\n### Summary — {net}, {dev}")
        print("| Kind | " + " | ".join(f"{b}: open · ops p50/p95 · session s · MB · req" for b in builds) + " |")
        print("|---|" + "---|" * len(builds))
        for kind in sorted({r["kind"] for r in rows if (r["net"], r["device"]) == (net, dev)}):
            cells = []
            for b in builds:
                rs = [r for r in rows if (r["net"], r["device"], r["kind"], r["build"]) == (net, dev, kind, b)]
                if not rs:
                    cells.append("–")
                    continue
                opens = [o["ms"] for r in rs for o in r["ops"] if o["op"] == "open"]
                rest = [o["ms"] for r in rs for o in r["ops"] if o["op"] != "open"]
                over = sum(1 for x in rest if x is None)
                cells.append(
                    f"{fmt(med(opens))} · {fmt(pct(rest, 0.5))}/{fmt(pct(rest, 0.95))}{f' ({over} over cap)' if over else ''} · "
                    f"{med([r['totalMs'] for r in rs]) / 1000:.1f} · {fmt(med([r['bytes'] for r in rs]), 'MB')} · {fmt(med([r['requests'] for r in rs]))}"
                )
            print(f"| {kind} | " + " | ".join(cells) + " |")
