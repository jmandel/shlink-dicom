#!/usr/bin/env bash
# Read-only commands that derive values in facts.json. Run from anywhere.
set -u
R=/home/jmandel/hobby/shlink-dicom
cd "$R"

echo "== 1. corpus_cases / corpus_real_cases: classify codec-corpus cases by pixel origin (committed formats/*/cases.json)"
python3 - <<'PY'
import json, glob, collections
cases = {}
for f in sorted(glob.glob('codec-corpus/formats/*/cases.json')):
    fmt = f.split('/')[2]
    for c in json.load(open(f))['cases']:
        cases[c['id']] = c
def origin(c, depth=0):
    s = c['source']; k = s['kind']
    if k in ('idc', 'external', 'pydicom', 'local'):
        return 'real-file'
    if k == 'generated' and 'seed' in s:
        sd = s['seed']
        return 'synthetic' if sd.startswith(('synth-', 'bench-')) else 'real-pixels-reencoded'
    ref = s.get('of') or s.get('from_case', '').split('/')[-1]
    if ref in cases:
        o = origin(cases[ref], depth + 1)
        if o == 'synthetic': return 'synthetic'
        return 'real-file-modified' if k in ('repair', 'strip') else 'real-pixels-reencoded'
    return 'unknown:' + k
cnt = collections.Counter(origin(c) for c in cases.values())
kinds = collections.Counter(c['source']['kind'] for c in cases.values())
print('total cases', len(cases))
print('by source.kind', dict(kinds))
print('by pixel origin', dict(cnt))
print('real (file as-is + modified real file + real pixels re-encoded):', len(cases) - cnt['synthetic'])
print('real files as found (idc/external/pydicom/local):', cnt['real-file'])
PY

echo "== 1. corpus_passing: summary of latest full check report (untracked reports/coord.json, 2026-10-15T12:27) and committed reports/foundation.json"
python3 - <<'PY'
import json, collections
for p in ('codec-corpus/reports/coord.json', 'codec-corpus/reports/foundation.json'):
    try:
        d = json.load(open(p))
    except Exception as e:
        print(p, 'unreadable', e); continue
    c = collections.Counter(r['outcome'] for r in d['results'])
    print(p, d.get('time'), 'results', len(d['results']), dict(c))
PY

echo "== 2. IDC long-tail sweep rows (committed LONGTAIL.md)"
grep -n -E "^\| (Random control|All evaluated|Long-tail selection)" codec-corpus/prevalence/LONGTAIL.md
grep -n -E "^A check of .shl-dicom-decode. against the reference decoders on 9,557" codec-corpus/prevalence/LONGTAIL.md | cut -c1-120
grep -n -E "^- \*\*Instances:\*\* (8|5 in|3 )" codec-corpus/prevalence/LONGTAIL.md
grep -n -E "Size:\*\* 58,784,975" codec-corpus/prevalence/SOURCES.md | cut -c1-120
python3 -c "
import json
for c in json.load(open('codec-corpus/formats/jpeg2000/cases.json'))['cases']:
    if c['id']=='idc-lt-combo-63dd4058': print('Leica case max_abs', c['max_abs'])
"

echo "== 3. display conformance (untracked scratch report from fef0a72's run, /media/barracuda/shlink-display-conformance/out/report.json)"
python3 - <<'PY'
import json, collections, re
try:
    r = json.load(open('/media/barracuda/shlink-display-conformance/out/report.json'))
except Exception as e:
    print('report missing', e); raise SystemExit
def cat(f):
    if '/shlink-dicom-objects/' in f: return 'idc'
    if 'shlink-display-conformance/synthetic' in f: return 'synthetic-edge'
    if 'codec-corpus' in f:
        n = f.split('/')[-1]
        return 'corpus-synthetic' if re.match(r'(gen-(synth|bench)|strip-pc-gen-synth|gen-unwrap-[a-z]+-gen-synth)', n) else 'corpus-real'
    return 'josh-sample'
print('files', len(r), dict(collections.Counter(cat(x['file']) for x in r)))
for k in ('expected', 'dcmtk', 'pydicom'):
    rows = [x for x in r if 'max' in x.get(k, {})]
    agree = [x for x in rows if x[k]['max'] <= 1]
    print(k, 'compared', len(rows), 'within 1 grey level', len(agree))
rows = [x for x in r if 'max' in x.get('dcmtk', {})]
by = collections.Counter()
for x in rows:
    by[(cat(x['file']), x['dcmtk']['max'] <= 1)] += 1
print('dcmtk by origin (origin, agrees):', dict(by))
def bucket(x):
    d = x['dcmtk']
    if any(re.search(r'VOI LUT .*\((\d+)→(\d+) bits\)', f) and len(set(re.search(r'\((\d+)→(\d+)', f).groups())) == 2 for f in x['features']): return 'LUT depth rule (deliberate)'
    if d['over2'] <= 0.001: return 'within 2 on >=99.9% of pixels'
    if x['voi'] == 'minmax': return 'no window in file (min-max)'
    return 'other'
diff = [x for x in rows if x['dcmtk']['max'] > 1]
print('dcmtk differences', len(diff), dict(collections.Counter(bucket(x) for x in diff)))
for x in diff: print('  ', bucket(x), '|', cat(x['file']), '|', x['file'].split('/')[-1][:70], x['dcmtk'], 'pydicom:', x.get('pydicom', {}).get('max', x.get('pydicom', {}).get('error', '')[:40]))
PY

echo "== 4. encoder verification (untracked scratch reports in /media/barracuda/sv1, final-* runs 20:51-21:00 CDT 15 Oct)"
python3 - /media/barracuda/sv1/final-josh-1.2.840.10008.1.2.4.70.json /media/barracuda/sv1/final-josh-1.2.840.10008.1.2.4.90.json /media/barracuda/sv1/final-corpus-1.2.840.10008.1.2.4.70.json /media/barracuda/sv1/final-corpus-1.2.840.10008.1.2.4.90.json <<'PY'
import json, re, sys
for f in sys.argv[1:]:
    try: d = json.load(open(f))
    except Exception as e: print(f, 'missing', e); continue
    enc = [r for r in d if r['outcome'] == 'encoded']
    exact = sum(1 for r in enc if all(v == 'exact' for v in r['refs'].values()))
    refs = sorted(set(k for r in enc for k in r['refs']))
    ie = sum(r['input_bytes'] for r in enc); oe = sum(r['output_bytes'] for r in enc)
    syn = sum(1 for r in enc if re.match(r'(gen-(synth|bench)|strip-pc-gen-synth|gen-unwrap-[a-z]+-gen-synth)', r['case']))
    print(f.split('/')[-1], 'rows', len(d), 'encoded', len(enc), 'exact-under-all', exact, refs, 'bytes', ie, '->', oe, 'ratio %.3f' % (ie / oe), 'synthetic-encoded', syn)
PY
echo "== 4. measurement study with reference encoders (dcmcjpeg +e1, pydicom/OpenJPEG), /media/barracuda/compress-study/results"
python3 - <<'PY'
import json
try:
    inv = {r['path']: r for r in json.load(open('/media/barracuda/compress-study/results/inventory.json'))}
    enc = {r['path']: r for r in json.load(open('/media/barracuda/compress-study/results/enc-orig.json'))}
except Exception as e:
    print('missing', e); raise SystemExit
orig = sum(r['file_bytes'] for r in inv.values())
for s in ('jll', 'j2k', 'jls', 'htj2k'):
    t = sum(enc[p][s]['bytes'] if p in enc else r['file_bytes'] for p, r in inv.items())
    print(s, 'files', len(inv), 'bytes', orig, '->', t, 'ratio %.3f' % (orig / t))
PY
grep -n "ALL five studies" /media/barracuda/compress-study/results/sizes.md | head -1

echo "== 5. latest check summary lines in scratch logs (untracked)"
for f in /media/barracuda/pack-view.out /media/barracuda/pack-share2.out /tmp/howprobe/full-sv1-.log /tmp/howprobe/full-j2k-.log /tmp/howprobe/full-native-.log /tmp/q-wsi.log /media/barracuda/pack-big.out /media/barracuda/sop-sweep/checks-final.log /media/barracuda/j2k-share2.out; do
  [ -f "$f" ] && echo "$(stat -c '%y' "$f" | cut -c1-16) $f :: $(grep -E '^[0-9]+/[0-9]+ (checks )?passed|pass, [0-9]+ unsupported' "$f" | tail -1)"
done
grep -n -o "live e2e passes 153/153[^.]*" docs/COORDINATION.md
grep -n -o -E "(remote e2e 109/109|e2e 124/124, data-check 24/24|sandbox e2e 130/130[^.]*)" docs/COORDINATION.md

echo "== 6. SOP class census (origin/main, commit 8a5368e)"
git show origin/main:codec-corpus/prevalence/SOPCLASS_CENSUS.md | grep -n -E "^38 SOP classes|^- \*\*38 SOP classes"
git show origin/main:codec-corpus/prevalence/SOPCLASS_CENSUS.md | awk '/^\| SOP class \| UID/{f=1;next} f&&/^\|---/{next} f&&/^\|/{n++} f&&!/^\|/{f=0} END{print "table rows:", n}'

echo "== 7. unclear points in the IG (imaging-sandbox/CONFORMANCE.md)"
awk '/^## Unclear points in the IG/{f=1;next} /^## /{f=0} f' imaging-sandbox/CONFORMANCE.md | grep -c -E '^[0-9]+\. \*\*'

echo "== 8. upstream PR/issues (read-only)"
gh pr view 5 -R argonautproject/smart-imaging --json title,state,url,createdAt 2>/dev/null
gh issue view 2 -R argonautproject/smart-imaging --json title,state,url,createdAt 2>/dev/null
gh issue view 3 -R argonautproject/smart-imaging --json title,state,url,createdAt 2>/dev/null

echo "== 9. S3 presign TTL and default read mode"
git grep -n -E "const SIGN_TTL|const PRESIGN_REUSE" main -- crates/shl-dicom-server/src/storage.rs
git grep -n -E 'SHL_S3_READ_MODE", value_enum, default_value' main -- crates/shl-dicom-server/src/main.rs

echo "== 10. subagent transcripts in the coordinator session (local Claude Code records)"
python3 - <<'PY'
import json, glob, os, collections
d = os.path.expanduser('~/.claude/projects/-home-jmandel-hobby-smart-health-checkin/0c360f75-6e42-4bb2-af89-350946f294a1/subagents')
rows = []
for m in glob.glob(d + '/agent-*.meta.json'):
    j = json.load(open(m)); f = m.replace('.meta.json', '.jsonl')
    ts = json.loads(open(f).readline()).get('timestamp', '?') if os.path.exists(f) else '?'
    rows.append((ts, j.get('spawnDepth', 1)))
cut = '2026-10-15T23:45'   # 18:45 CDT, the blog sync that says 42
print('all transcripts now', len(rows), 'by depth', dict(collections.Counter(r[1] for r in rows)))
print('started before 18:45 CDT 15 Oct', sum(1 for r in rows if r[0] < cut), 'by depth', dict(collections.Counter(r[1] for r in rows if r[0] < cut)))
PY
f=$(ls ~/.pi/agent/sessions/--home-jmandel-hobby-shlink-dicom--/2026-10-14T20-16-22-993Z_*.jsonl 2>/dev/null | head -1); [ -n "$f" ] && grep -o '"model":"[^"]*"' "$f" | sort | uniq -c

echo "== 13. first commit"
git log --reverse --format='%h %ad %s' --date=iso | head -1
TZ=America/Chicago git log --reverse --format='%ad' --date=format-local:'%a %d %b %Y %H:%M %Z' | head -1
