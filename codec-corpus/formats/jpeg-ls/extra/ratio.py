"""Load-robust speed comparison with CharLS: for each benchmark case, decode one frame
codestream alternately with CharLS (pyjpegls) and with shl-codec-jpeg-ls's `examples/bench`,
keeping the minimum time per decode for each.

Needs the extracted frames (scripts/extract_frames.py --format jpeg-ls) and
  cd codecs && CARGO_TARGET_DIR=target/jpeg-ls cargo build --release -p shl-codec-jpeg-ls --example bench
Usage (from codec-corpus/):  uv run python formats/jpeg-ls/extra/ratio.py [rounds]
"""
import json, subprocess, time, sys, pathlib
import _CharLS  # pyjpegls' CharLS binding
HERE = pathlib.Path(__file__).resolve().parent
F = HERE.parent / 'frames'
B = str(HERE.parents[3] / 'codecs/target/jpeg-ls/release/examples/bench')
cases = ['gen-pydicom-CT_small-charls-ls','gen-bench-ct512-u16-charls-ls','gen-bench-dx2048-u12-charls-ls','gen-bench-dx2048-u12-charls-nl3',
         'gen-bench-cine-rgb8-640x480x30-charls-ls','ext-pylibjpeg-RG1_JLSL','idc-jls-mono2-u8of8-mf-seg-ncifnlcr-395ded29',
         'ext-cs3d-ColorImage.dcm_JPEGLSLosslessTransferSyntax_1.2.840.10008.1.2.4.80']
rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 3
import math; g = []
for c in cases:
    d = F / c; info = json.load(open(d / 'info.json'))
    fr = d / ('frame-5.bin' if (d / 'frame-5.bin').exists() else 'frame-0.bin')
    b = fr.read_bytes()
    px = info['rows'] * info['columns'] * info['samples_per_pixel']
    n = max(5, min(200, int(3e7 / px)))
    best_c = best_o = 1e9
    for _ in range(rounds):
        for _ in range(n):
            t = time.perf_counter(); _CharLS._decode(b); best_c = min(best_c, time.perf_counter() - t)
        out = subprocess.run([B, str(fr), str(info['rows']), str(info['columns']), str(info['samples_per_pixel']), str(info['bits_allocated'])], capture_output=True, text=True).stdout
        best_o = min(best_o, float(out.split(':')[1].split('ms')[0]) / 1e3)
    g.append(best_o / best_c)
    print(f"{c[:46]:46} charls {best_c*1e3:8.3f} ms  ours {best_o*1e3:8.3f} ms  ratio {best_o/best_c:5.2f}")
print("geomean ratio", round(math.exp(sum(map(math.log, g)) / len(g)), 3))
