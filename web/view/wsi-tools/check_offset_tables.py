"""Checks files written by the offset-table rewrite with pydicom: the BOT/EOT pydicom reads must
give exactly the frames of the original (from a .frames file: u32 length + bytes, per frame).

    uv run --project codec-corpus python -I web/view/wsi-tools/check_offset_tables.py DIR
"""
import os, struct, sys
import pydicom
from pydicom.encaps import generate_frames, parse_basic_offsets

d = sys.argv[1]
def frames_file(p):
    b = open(p, "rb").read(); out = []; i = 0
    while i < len(b):
        n = struct.unpack_from("<I", b, i)[0]; out.append(b[i + 4:i + 4 + n]); i += 4 + n
    return out
ok = True
for name, ref in [("bot", "before"), ("eot", "before-eot")]:
    ds = pydicom.dcmread(os.path.join(d, f"{name}.dcm"))
    nf = int(ds.NumberOfFrames)
    eot = None
    if "ExtendedOffsetTable" in ds:
        eot = (ds.ExtendedOffsetTable, ds.ExtendedOffsetTableLengths)
    frames = list(generate_frames(ds.PixelData, number_of_frames=nf, extended_offsets=eot))
    want = frames_file(os.path.join(d, f"{ref}.frames"))
    import io
    from pydicom.filebase import DicomBytesIO
    bot = parse_basic_offsets(DicomBytesIO(ds.PixelData))
    same = frames == want
    ok &= same
    print(f"{name}: {nf} frames, BOT {bot}, EOT {'yes' if eot else 'no'}, frames identical to the original: {same}")
sys.exit(0 if ok else 1)
