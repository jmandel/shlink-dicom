"""Print the pyramid attributes and pixel-data framing of each instance in a slide folder."""
import sys, glob, os, struct
import pydicom
for p in sorted(glob.glob(os.path.join(sys.argv[1], "*.dcm"))):
    ds = pydicom.dcmread(p, stop_before_pixels=True)
    it = list(ds.get("ImageType", []))
    eot = "ExtendedOffsetTable" in ds
    # pixel data offset and BOT
    with open(p, "rb") as f:
        data = f.read(min(os.path.getsize(p), 8 << 20))
    i = data.find(b"\xe0\x7f\x10\x00")
    bot = None
    if i >= 0 and data[i+8:i+12] == b"\xff\xff\xff\xff":
        j = i + 12
        bot = struct.unpack("<I", data[j+4:j+8])[0]
    print(os.path.basename(p)[:8], os.path.getsize(p), it, ds.get("TransferSyntaxUID", ds.file_meta.TransferSyntaxUID),
          ds.get("PhotometricInterpretation"), "tpm", ds.get("TotalPixelMatrixColumns"), ds.get("TotalPixelMatrixRows"),
          "tile", ds.Columns, ds.Rows, "frames", ds.get("NumberOfFrames"), ds.get("DimensionOrganizationType"),
          "pixdata@", i, "BOTlen", bot, "EOT", eot, "PerFrameFG" , "PerFrameFunctionalGroupsSequence" in ds,
          "Spacing", getattr(ds.SharedFunctionalGroupsSequence[0].PixelMeasuresSequence[0], "PixelSpacing", None) if "SharedFunctionalGroupsSequence" in ds else None,
          ds.get("ImplementationVersionName", ds.file_meta.get("ImplementationVersionName")))
ds = pydicom.dcmread(p, stop_before_pixels=True)
for k in ["StudyInstanceUID", "SeriesInstanceUID", "ContainerIdentifier", "PatientID", "PatientName", "Manufacturer", "ManufacturerModelName", "StudyDate", "SeriesDescription", "ClinicalTrialProtocolID"]:
    print(k, ds.get(k))
