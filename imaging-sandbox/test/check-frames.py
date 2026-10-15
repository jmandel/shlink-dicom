"""Reads every frame of a rewritten encapsulated DICOM file with pydicom,
through its Basic Offset Table, and compares it with the same frame of the
source file (read without a table).

    python check-frames.py REWRITTEN.dcm SOURCE.dcm

Prints one JSON line: frames, BOT entries, frames equal.
"""
import json
import sys

import pydicom
from pydicom.encaps import generate_frames, get_frame, parse_basic_offsets


def main(after_path: str, before_path: str) -> None:
    after = pydicom.dcmread(after_path)
    before = pydicom.dcmread(before_path)
    n = int(getattr(after, "NumberOfFrames", 1) or 1)
    offsets = parse_basic_offsets(after.PixelData)
    source_frames = list(generate_frames(before.PixelData, number_of_frames=n))
    equal = sum(
        1 for i in range(n) if get_frame(after.PixelData, i, number_of_frames=n) == source_frames[i]
    )
    print(json.dumps({"frames": n, "bot": len(offsets), "equal": equal, "source_frames": len(source_frames)}))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
