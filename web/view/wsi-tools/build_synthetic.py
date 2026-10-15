"""Builds synthetic whole-slide test files from real CC BY slides, for features IDC has no CC BY
example of (focal planes, several optical paths in one instance, TILED_SPARSE, JPEG XL).

    uv run --project codec-corpus python -I web/view/wsi-tools/build_synthetic.py OUT_DIR

Sources (web/view/WSI.md lists provenance):
  DX1  TCGA-LUAD TCGA-05-5425 FFPE H&E, JPEG 2000, levels 10000 and 2500 wide
  BS2  TCGA-05-5425 frozen H&E, JPEG baseline, levels 12000, 3000 and 1500 wide
  OHSU HTAN-OHSU multiplex immunofluorescence, 8-bit, 12 channels, one channel per instance

Writes one folder per slide:
  sparse-z/      TILED_SPARSE, three focal planes (Z −2, 0, +2 µm; the outer two blurred), background
                 tiles left out, frames in shuffled order; JPEG baseline
  full-z/        TILED_FULL, the same three planes in one instance per level (frames: column, row,
                 then focal plane); JPEG baseline
  fluor-3path/   TILED_FULL, three channels of the OHSU slide in one instance per level (frames:
                 column, row, then optical path); uncompressed
  jxl-lossless/  DX1 re-encoded as JPEG XL lossless (1.2.840.10008.1.2.4.110)
  jxl-lossy/     DX1 re-encoded as JPEG XL (1.2.840.10008.1.2.4.112), distance 1
  jxl-recompress/ BS2's JPEG tiles losslessly recompressed with cjxl (1.2.840.10008.1.2.4.111)
Each instance gets new SOP Instance and Series UIDs and a Series Description that says it is synthetic.
"""
import copy, glob, os, random, subprocess, sys, tempfile
import numpy as np
import imagecodecs
import pydicom
from pydicom.dataset import Dataset
from pydicom.encaps import encapsulate
from pydicom.sequence import Sequence
from pydicom.uid import generate_uid, ExplicitVRLittleEndian
from pydicom.pixels import pixel_array
from pydicom._uid_dict import UID_dictionary

# pydicom 3.0 predates the JPEG XL transfer syntaxes (DICOM 2023): register them so it writes them.
for _uid, _name, _kw in [("1.2.840.10008.1.2.4.110", "JPEG XL Lossless", "JPEGXLLossless"),
                         ("1.2.840.10008.1.2.4.111", "JPEG XL JPEG Recompression", "JPEGXLJPEGRecompression"),
                         ("1.2.840.10008.1.2.4.112", "JPEG XL", "JPEGXL")]:
    UID_dictionary.setdefault(_uid, (_name, "Transfer Syntax", "", "", _kw))

DL = "/media/barracuda/shlink-dicom-slides/dl"
DX1 = f"{DL}/study-26f5b0cf/SM-5b454b12-b716-471d-abde-f59ec88cf4ef"
BS2 = f"{DL}/study-26f5b0cf/SM-62828643-1ae6-4e24-b0e7-16b88a8d548b"
OHSU = f"{DL}/b67a9aee-2f12-4e9d-9e00-7130e5017545"
OUT = sys.argv[1]


def volumes(folder):
    """VOLUME instances of a folder, largest first."""
    out = []
    for p in glob.glob(f"{folder}/*.dcm"):
        ds = pydicom.dcmread(p, stop_before_pixels=True)
        if "VOLUME" in ds.ImageType:
            out.append((int(ds.TotalPixelMatrixColumns), p, ds))
    return sorted(out, key=lambda t: -t[0])


def whole_image(path):
    """The level's total pixel matrix as one array (TILED_FULL sources)."""
    ds = pydicom.dcmread(path)
    rows, cols = int(ds.TotalPixelMatrixRows), int(ds.TotalPixelMatrixColumns)
    th, tw = int(ds.Rows), int(ds.Columns)
    across = -(-cols // tw)
    spp = int(ds.SamplesPerPixel)
    img = np.zeros((-(-rows // th) * th, across * tw, spp), dtype=np.uint8)
    for f in range(int(ds.NumberOfFrames)):
        a = pixel_array(ds, index=f)
        if a.ndim == 2:
            a = a[:, :, None]
        ty, tx = divmod(f, across)
        img[ty * th:(ty + 1) * th, tx * tw:(tx + 1) * tw] = a
    return img[:rows, :cols], ds


def box_blur(img, r):
    """Box blur of radius r, twice (close to a Gaussian), on an HxWxC uint8 array."""
    out = img.astype(np.float32)
    for _ in range(2):
        for axis in (0, 1):
            c = np.cumsum(np.pad(out, [(r + 1, r) if a == axis else (0, 0) for a in range(3)], mode="edge"), axis=axis)
            hi = np.take(c, np.arange(2 * r + 1, c.shape[axis]), axis=axis)
            lo = np.take(c, np.arange(0, c.shape[axis] - 2 * r - 1), axis=axis)
            out = (hi - lo) / (2 * r + 1)
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)


def tiles_of(img, tw, th):
    rows, cols = img.shape[:2]
    across, down = -(-cols // tw), -(-rows // th)
    pad = np.zeros((down * th, across * tw, img.shape[2]), dtype=np.uint8)
    pad[:rows, :cols] = img
    for ty in range(down):
        for tx in range(across):
            yield tx, ty, pad[ty * th:(ty + 1) * th, tx * tw:(tx + 1) * tw]


def base_header(src, desc, series_uid):
    ds = copy.deepcopy(src)
    for k in ["PixelData", "PerFrameFunctionalGroupsSequence", "ExtendedOffsetTable", "ExtendedOffsetTableLengths", "DimensionIndexSequence", "DimensionOrganizationSequence"]:
        if k in ds:
            del ds[k]
    ds.SOPInstanceUID = generate_uid()
    ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.SeriesInstanceUID = series_uid
    ds.SeriesDescription = desc
    ds.ContainerIdentifier = getattr(src, "ContainerIdentifier", "synthetic")
    return ds


def plane_position(col, row, z, spacing):
    pp = Dataset()
    pp.ColumnPositionInTotalImagePixelMatrix = col
    pp.RowPositionInTotalImagePixelMatrix = row
    pp.XOffsetInSlideCoordinateSystem = f"{(row - 1) * spacing:.6f}"[:16]
    pp.YOffsetInSlideCoordinateSystem = f"{(col - 1) * spacing:.6f}"[:16]
    pp.ZOffsetInSlideCoordinateSystem = f"{z:.3f}"
    return pp


def save(ds, frames, ts, folder, name, photometric=None):
    ds.file_meta.TransferSyntaxUID = ts
    if photometric:
        ds.PhotometricInterpretation = photometric
    ds.NumberOfFrames = len(frames)
    if ts == ExplicitVRLittleEndian:
        ds.PixelData = b"".join(frames)
        ds["PixelData"].VR = "OB"
    else:
        ds.PixelData = encapsulate(frames, has_bot=True)
        ds["PixelData"].is_undefined_length = True
        ds["PixelData"].VR = "OB"
        ds.LossyImageCompression = "01" if ts not in ("1.2.840.10008.1.2.4.110",) else "00"
    os.makedirs(folder, exist_ok=True)
    ds.save_as(f"{folder}/{name}.dcm", enforce_file_format=True)
    print(f"  {folder.split('/')[-1]}/{name}.dcm  {len(frames)} frames  {os.path.getsize(f'{folder}/{name}.dcm') / 1e6:.1f} MB")


def jpeg(tile):
    return imagecodecs.jpeg8_encode(tile, level=85, subsampling="422" if tile.shape[2] == 3 else None)


def build_focal(kind):
    """sparse-z (TILED_SPARSE, per-frame Z) or full-z (TILED_FULL, focal planes in one instance)."""
    folder = f"{OUT}/{kind}"
    series_uid = generate_uid()
    rng = random.Random(7)
    zs = [-2.0, 0.0, 2.0]
    for width, path, src in volumes(DX1):
        img, full = whole_image(path)
        spacing = float(full.SharedFunctionalGroupsSequence[0].PixelMeasuresSequence[0].PixelSpacing[0])
        # Out of focus: blurred by about 1.5 and 3 µm at the base level (0.5 µm pixels).
        r1, r2 = (3, 6) if width > 5000 else (1, 2)
        planes = [box_blur(img, r1), img, box_blur(img, r2)]
        tw = th = int(full.Columns)
        ds = base_header(full, f"Synthetic {'TILED_SPARSE' if kind == 'sparse-z' else 'TILED_FULL'}, 3 focal planes (from TCGA-05-5425 DX1)", series_uid)
        ds.PhotometricInterpretation = "YBR_FULL_422"
        ds.SamplesPerPixel = 3
        ds.PlanarConfiguration = 0
        ds.TotalPixelMatrixFocalPlanes = 3
        ds.ImageType = ["DERIVED", "PRIMARY", "VOLUME", "RESAMPLED" if width < 10000 else "NONE"]
        frames, per = [], []
        if kind == "sparse-z":
            ds.DimensionOrganizationType = "TILED_SPARSE"
            entries = []
            for zi, plane in enumerate(planes):
                for tx, ty, t in tiles_of(plane, tw, th):
                    # Background (glass): leave the tile out, as sparse layouts allow.
                    if t.mean() > 214 and t.std() < 9:
                        continue
                    entries.append((tx, ty, zs[zi], t))
            rng.shuffle(entries)
            for tx, ty, z, t in entries:
                frames.append(jpeg(t))
                fg = Dataset()
                fg.PlanePositionSlideSequence = Sequence([plane_position(tx * tw + 1, ty * th + 1, z, spacing)])
                per.append(fg)
            ds.PerFrameFunctionalGroupsSequence = Sequence(per)
        else:
            ds.DimensionOrganizationType = "TILED_FULL"
            for plane in planes:
                for tx, ty, t in tiles_of(plane, tw, th):
                    frames.append(jpeg(t))
        save(ds, frames, "1.2.840.10008.1.2.4.50", folder, f"level-{width}")


def build_fluor():
    folder = f"{OUT}/fluor-3path"
    series_uid = generate_uid()
    want = ["NUCLEI", "CD45", "PDL1"]
    by_width = {}
    for width, path, ds in volumes(OHSU):
        name = ds.OpticalPathSequence[0].OpticalPathDescription
        if name in want:
            by_width.setdefault(width, {})[name] = path
    for width, paths in sorted(by_width.items(), reverse=True):
        srcs = [pydicom.dcmread(paths[n]) for n in want]
        first = srcs[0]
        ds = base_header(first, "Synthetic: 3 fluorescence channels in one instance (from HTAN-OHSU)", series_uid)
        ds.NumberOfOpticalPaths = 3
        ds.DimensionOrganizationType = "TILED_FULL"
        ds.OpticalPathSequence = Sequence([copy.deepcopy(s.OpticalPathSequence[0]) for s in srcs])
        frames = []
        for s in srcs:
            n = int(s.NumberOfFrames)
            raw = s.PixelData
            fb = int(s.Rows) * int(s.Columns)
            frames.extend(raw[k * fb:(k + 1) * fb] for k in range(n))
        save(ds, frames, ExplicitVRLittleEndian, folder, f"level-{width}")


def build_jxl():
    for kind, ts in [("jxl-lossless", "1.2.840.10008.1.2.4.110"), ("jxl-lossy", "1.2.840.10008.1.2.4.112")]:
        folder = f"{OUT}/{kind}"
        series_uid = generate_uid()
        for width, path, src in volumes(DX1):
            img, full = whole_image(path)
            tw = th = int(full.Columns)
            ds = base_header(full, f"Synthetic: DX1 as JPEG XL {'lossless' if kind == 'jxl-lossless' else 'lossy'}", series_uid)
            ds.DimensionOrganizationType = "TILED_FULL"
            ds.SamplesPerPixel = 3
            ds.PlanarConfiguration = 0
            frames = [imagecodecs.jpegxl_encode(t, lossless=True) if kind == "jxl-lossless" else imagecodecs.jpegxl_encode(t, distance=1.0) for _, _, t in tiles_of(img, tw, th)]
            save(ds, frames, ts, folder, f"level-{width}", photometric="RGB")
    # JPEG recompression: BS2's own JPEG tiles, losslessly repacked by cjxl (the JPEG is recoverable).
    folder = f"{OUT}/jxl-recompress"
    series_uid = generate_uid()
    with tempfile.TemporaryDirectory() as tmp:
        for width, path, src in volumes(BS2)[1:]:  # all but the 12000-wide base, to keep it small
            ds_full = pydicom.dcmread(path)
            from pydicom.encaps import generate_frames
            jp = list(generate_frames(ds_full.PixelData, number_of_frames=int(ds_full.NumberOfFrames)))
            out = []
            for k, j in enumerate(jp):
                a, b = f"{tmp}/{k}.jpg", f"{tmp}/{k}.jxl"
                open(a, "wb").write(j)
                subprocess.run(["cjxl", "--quiet", "--lossless_jpeg=1", a, b], check=True)
                out.append(open(b, "rb").read())
            ds = base_header(ds_full, "Synthetic: frozen H&E as JPEG XL JPEG recompression (from TCGA-05-5425 BS2)", series_uid)
            ds.DimensionOrganizationType = "TILED_FULL"
            save(ds, out, "1.2.840.10008.1.2.4.111", folder, f"level-{width}")


if __name__ == "__main__":
    which = sys.argv[2:] or ["sparse-z", "full-z", "fluor-3path", "jxl"]
    for w in which:
        print(w)
        if w in ("sparse-z", "full-z"):
            build_focal(w)
        elif w == "fluor-3path":
            build_fluor()
        elif w == "jxl":
            build_jxl()
