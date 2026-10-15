"""Register real, publicly offered DICOM files that exercise known quirks, edge cases and encoder bugs.

The files are downloaded by hand (see prevalence/QUIRKS.md for every URL) into a cache directory
outside the repository, by default ~/.cache/shl-quirks, laid out as:

  gdcmData/         git clone https://git.code.sf.net/p/gdcm/gdcmdata
  pylibjpeg-data/   git clone https://github.com/pydicom/pylibjpeg-data
  orthanc/          single files from https://orthanc.uclouvain.be/hg/orthanc-tests/raw-file/tip/Database/<path>
                    ('/' in <path> replaced by '_')
  cs3d/             sparse clone of https://github.com/cornerstonejs/cornerstone3D (packages/dicomImageLoader/testImages)
  clunie/           https://www.dclunie.com/images/signedrange/signedrangeimages.tar.bz2 and
                    https://www.dclunie.com/images/compressed/deflate_tests_release.tar.gz, extracted
  fo-dicom/         sparse clone of https://github.com/fo-dicom/fo-dicom (Tests)
  issues/           files attached to GitHub issues, as issues/<owner>_<repo>_<number>/<file>

Each file is registered with discover.register as case ext-<source>-<name>, with a `quirk` in its
source record and a quirk tag. Files whose transfer syntax is outside common.TRANSFER_SYNTAXES, or
that pydicom cannot read as Part 10 (no Transfer Syntax UID), are not registered; they are listed
in skipped.json next to the cache for the report.

Usage:  uv run python scripts/sources/quirks.py [--cache DIR] [--only SOURCE] [--id CASE_ID ...]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import TRANSFER_SYNTAXES, load_cases, save_cases  # noqa: E402
from discover import register  # noqa: E402

warnings.filterwarnings("ignore")

SOURCES = {
    "gdcm": {
        "dir": "gdcmData",
        "origin": "GDCM test data (gdcmData)",
        "url": "https://sourceforge.net/p/gdcm/gdcmdata/ci/master/tree/{path}",
        "license": "no explicit licence; GDCM project test data, publicly distributed for toolkit testing",
    },
    "pylibjpeg": {
        "dir": "pylibjpeg-data",
        "origin": "pydicom/pylibjpeg-data",
        "url": "https://github.com/pydicom/pylibjpeg-data/blob/main/{path}",
        "license": "MIT (repository); images collected from WG04, GDCM and pydicom issues",
    },
    "orthanc": {
        "dir": "orthanc",
        "origin": "Orthanc integration tests (orthanc-tests/Database)",
        "url": "https://orthanc.uclouvain.be/hg/orthanc-tests/file/tip/Database/{path}",
        "license": "GPL-3.0 repository; images posted publicly by Orthanc users or from GDCM/WG04 (see Database/README.txt)",
    },
    "cs3d": {
        "dir": "cs3d/packages/dicomImageLoader/testImages",
        "origin": "cornerstonejs/cornerstone3D dicomImageLoader testImages",
        "url": "https://github.com/cornerstonejs/cornerstone3D/blob/main/packages/dicomImageLoader/testImages/{path}",
        "license": "MIT",
    },
    "clunie": {
        "dir": "clunie",
        "origin": "David Clunie test images (dclunie.com)",
        "url": "https://www.dclunie.com/images/{archive}",
        "license": "no explicit licence; published by David Clunie as test images",
    },
    "fodicom": {
        "dir": "fo-dicom/Tests",
        "origin": "fo-dicom test data",
        "url": "https://github.com/fo-dicom/fo-dicom/blob/development/Tests/{path}",
        "license": "MS-PL (repository); test files contributed with issues",
    },
    "dcm4che": {
        "dir": "dcm4che",
        "origin": "dcm4che/dcm4che dcm4che-test-data",
        "url": "https://github.com/dcm4che/dcm4che/blob/master/dcm4che-test-data/src/main/resources/{path}",
        "license": "MPL-1.1/GPL-2.0/LGPL-2.1 tri-licence (repository)",
    },
    "issue": {
        "dir": "issues",
        "origin": "GitHub issue attachment",
        "url": "{url}",
        "license": "attached publicly to the issue by its reporter for debugging; no explicit licence",
    },
}

# (source, path relative to the source dir, quirk description, tags)
# Paths ending in a ".dcm" or bare name; orthanc paths use the original Database/ path.
CASES: list[tuple[str, str, str, list[str]]] = [
    # ---------------- GDCM gdcmData ----------------
    ("gdcm", "00191113.dcm", "multi-frame JPEG lossless (8-bit, 4 frames) from GDCM bug reports", ["multiframe-fragments"]),
    ("gdcm", "012345.002.050.dcm", "signed 16-bit JPEG lossless from a GDCM bug report", ["jpeg-lossless-signed"]),
    ("gdcm", "3E768EB7.dcm", "JPEG lossless 12-bit in 16 (GDCM regression file)", ["bits-stored-lt-precision"]),
    ("gdcm", "ACUSON-24-YBR_FULL-RLE.dcm", "RLE with YBR_FULL photometric (Acuson US)", ["rle-ybr-full"]),
    ("gdcm", "ACUSON-24-YBR_FULL-RLE-b.dcm", "RLE with YBR_FULL photometric, second Acuson variant", ["rle-ybr-full"]),
    ("gdcm", "ALOKA_SSD-8-MONO2-RLE-SQ.dcm", "RLE with undefined-length sequences before Pixel Data (Aloka)", ["rle", "odd-sequences"]),
    ("gdcm", "AMIInvalidPrivateDefinedLengthSQasUN.dcm", "private defined-length SQ stored as UN", ["parse-sq-as-un"]),
    ("gdcm", "BugGDCM2_UndefItemWrongVL.dcm", "undefined-length item with a wrong VL", ["parse-bad-item-length"]),
    ("gdcm", "Bug_Siemens_PrivateIconNoItem.dcm", "Siemens private icon sequence with no item, JPEG lossless", ["parse-icon-sequence"]),
    ("gdcm", "CT-SIEMENS-Icone-With-PaletteColor.dcm", "palette-colour icon inside a sequence, main image MONO2", ["parse-icon-sequence"]),
    ("gdcm", "CT-SIEMENS-MissingPixelDataInIconSQ.dcm", "icon image sequence without Pixel Data", ["parse-icon-sequence"]),
    ("gdcm", "CT_16b_signed-UsedBits13.dcm", "signed, Bits Stored 13 in 16 (sign extension from bit 12)", ["signed-bits-stored"]),
    ("gdcm", "DCMTK_JPEGExt_12Bits.dcm", "Bits Allocated 12 with JPEG Extended (illegal Bits Allocated)", ["bits-allocated-12"]),
    ("gdcm", "DMCPACS_ExplicitImplicit_BogusIOP.dcm", "explicit VR file switching to implicit VR mid-data set", ["parse-vr-switch"]),
    ("gdcm", "DX_J2K_0Padding.dcm", "J2K codestream followed by zero padding after EOC", ["j2k-trailing-padding"]),
    ("gdcm", "ELSCINT1_JP2vsJ2K.dcm", "JP2 file (boxes) inside a J2K fragment instead of a raw codestream (Elscint)", ["j2k-jp2-wrapper"]),
    ("gdcm", "ELSCINT1_LOSSLESS_RICE.dcm", "Elscint private lossless Rice compression inside native Pixel Data", ["private-compression"]),
    ("gdcm", "ELSCINT1_PMSCT_RLE1.dcm", "Elscint private PMSCT_RLE1 compression inside native Pixel Data", ["private-compression"]),
    ("gdcm", "EmptyIcon_Bug417.dcm", "empty icon image sequence", ["parse-icon-sequence"]),
    ("gdcm", "EnhancedWithIPPPerFrameIOPShared.dcm", "enhanced multi-frame JPEG lossless, 189 frames", ["multiframe"]),
    ("gdcm", "FUJI-ffff-MONO1-J2K.dcm", "Bits Allocated and Bits Stored 0xFFFF with J2K (Fuji); codestream says 16 bits", ["bits-allocated-bogus"]),
    ("gdcm", "GE_CT_With_Private_compressed-icon.dcm", "explicit VR big endian with a GE private compressed icon", ["big-endian", "parse-icon-sequence"]),
    ("gdcm", "GE_DLX-8-MONO2-Multiframe-Jpeg_Lossless.dcm", "GE DLX multi-frame JPEG lossless, 67 frames", ["multiframe-fragments"]),
    ("gdcm", "GE_DLX-8-MONO2-Multiframe.dcm", "GE DLX implicit VR multi-frame", ["multiframe"]),
    ("gdcm", "GE_DLX-8-MONO2-PrivateSyntax.dcm", "GE private implicit VR big endian syntax 1.2.840.113619.5.2", ["private-syntax"]),
    ("gdcm", "GE_GENESIS-16-MONO2-Uncompressed-UnusualVR.dcm", "unusual VRs in a GE Genesis conversion", ["parse-unusual-vr"]),
    ("gdcm", "GE_LOGIQBook-8-RGB-HugePreview.dcm", "RGB with a huge private preview before Pixel Data", ["parse-private-preview"]),
    ("gdcm", "GE_RHAPSODE-16-MONO2-JPEG-Fragments.dcm", "one JPEG lossless frame split over many fragments", ["frame-split-fragments"]),
    ("gdcm", "HardcopyColor_YBR_RCT_J2K_PC1.dcm", "YBR_RCT J2K with Planar Configuration 1 declared", ["j2k-planar-config"]),
    ("gdcm", "IM-0001-0066.CommandTag00.dcm", "group 0000 command elements inside a stored file", ["parse-command-group"]),
    ("gdcm", "ITK_GDCM124_MultiframeSecondaryCaptureInvalid.dcm", "multi-frame SC written by old ITK/GDCM with invalid attributes", ["multiframe"]),
    ("gdcm", "IllegalGroup2ImplicitTS.dcm", "group 0002 meta encoded implicit VR (illegal)", ["meta-implicit"]),
    ("gdcm", "JDDICOM_Sample2.dcm", "JPEG baseline RGB from JDDICOM", ["jpeg-colour-label"]),
    ("gdcm", "JPEGDefinedLengthSequenceOfFragments.dcm", "encapsulated JPEG Pixel Data with a defined length instead of undefined", ["encaps-defined-length"]),
    ("gdcm", "JPEGLosslessSeNonZero.dcm", "JPEG lossless SOS with Se != 0, Bits Allocated 12", ["jpeg-lossless-bad-sos", "bits-allocated-12"]),
    ("gdcm", "JPEGLosslessYBR_FULL_422.dcm", "JPEG lossless labelled YBR_FULL_422", ["jpeg-colour-label"]),
    ("gdcm", "JPEGNote_bogus.dcm", "JPEG baseline whose Rows/Columns/Photometric are bogus; the JPEG header is right", ["dicom-vs-jpeg-header"]),
    ("gdcm", "JPEGNote_empty.dcm", "JPEG baseline with empty Rows/Columns/Photometric", ["dicom-vs-jpeg-header"]),
    ("gdcm", "JPEGNote_missing.dcm", "JPEG baseline with Rows/Columns/Photometric missing", ["dicom-vs-jpeg-header"]),
    ("gdcm", "JPEG_LS_InvalidEscapeSequence_COM_padding.dcm", "JPEG-LS with COM marker padding and an invalid escape sequence", ["jpeg-ls-padding"]),
    ("gdcm", "JPEG_LossyYBR.dcm", "JPEG extended 8-bit colour labelled YBR_FULL; SOS Se=0 instead of 63 (pylibjpeg-data JPEGExtended_3s_1f_u_08_08 is the same file)", ["jpeg-colour-label", "jpeg-bad-sos"]),
    ("gdcm", "KODAK_CompressedIcon.dcm", "Kodak JPEG lossless with a compressed icon", ["parse-icon-sequence"]),
    ("gdcm", "LEADTOOLS_FLOWERS-16-MONO2-JpegLossless.dcm", "LEADTOOLS 16-bit JPEG lossless", ["leadtools"]),
    ("gdcm", "LEADTOOLS_FLOWERS-16-MONO2-RLE.dcm", "LEADTOOLS 16-bit RLE", ["leadtools"]),
    ("gdcm", "LEADTOOLS_FLOWERS-24-RGB-JpegLossless.dcm", "LEADTOOLS RGB JPEG lossless", ["leadtools"]),
    ("gdcm", "LEADTOOLS_FLOWERS-24-RGB-JpegLossy.dcm", "LEADTOOLS RGB JPEG baseline labelled RGB", ["leadtools", "jpeg-colour-label"]),
    ("gdcm", "LEADTOOLS_FLOWERS-8-MONO2-JpegLossy.dcm", "LEADTOOLS 8-bit JPEG baseline", ["leadtools"]),
    ("gdcm", "LEADTOOLS_FLOWERS-8-MONO2-RLE.dcm", "LEADTOOLS 8-bit RLE", ["leadtools"]),
    ("gdcm", "LEADTOOLS_FLOWERS-8-MONO2-Uncompressed.dcm", "MONO2 with Planar Configuration 1 present", ["planar-config-mono"]),
    ("gdcm", "LEADTOOLS_FLOWERS-8-PAL-RLE.dcm", "palette RLE with Planar Configuration 2 (illegal value)", ["planar-config-bogus", "palette"]),
    ("gdcm", "LEADTOOLS_FLOWERS-8-PAL-Uncompressed.dcm", "palette native with Planar Configuration 2 (illegal value)", ["planar-config-bogus", "palette"]),
    ("gdcm", "LJPEG_BuginGDCM12.dcm", "JPEG lossless written by GDCM 1.2 with a known bug", ["jpeg-lossless-encoder-bug"]),
    ("gdcm", "MARCONI_MxTWin-12-MONO2-JpegLossless-ZeroLengthSQ.dcm", "Marconi JPEG lossless: SOF precision differs from Bits Stored; zero-length SQ", ["dicom-vs-jpeg-header"]),
    ("gdcm", "MAROTECH_CT_JP2Lossy.dcm", "JP2 file wrapper inside a J2K fragment (Marotech)", ["j2k-jp2-wrapper"]),
    ("gdcm", "MEDILABInvalidCP246_EVRLESQasUN.dcm", "SQ written as UN in explicit VR (invalid under CP-246)", ["parse-sq-as-un"]),
    ("gdcm", "MEDILABValidCP246_EVRLESQasOB.dcm", "SQ written as OB in explicit VR, JPEG-LS", ["parse-sq-as-un"]),
    ("gdcm", "MITRA_CORNELL.dcm", "16-bit JPEG lossless from the Cornell codec (SSSS=16 handling)", ["jpeg-lossless-ssss16"]),
    ("gdcm", "MR-MONO2-12-shoulder.dcm", "JPEG lossless process 14 (.57), non-SV1 predictor", ["jpeg-lossless-57"]),
    ("gdcm", "MR16BitsAllocated_8BitsStored.dcm", "photometric 'MONOCHROME' (invalid), 8 of 16 bits stored, signed", ["photometric-bogus"]),
    ("gdcm", "MR_GE_with_Private_Compressed_Icon_0009_1110.dcm", "big endian with GE private compressed icon", ["big-endian", "parse-icon-sequence"]),
    ("gdcm", "MR_Philips-Intera_BreaksNOSHADOW.dcm", "Philips private sequences that break shadow parsing", ["parse-private-sq"]),
    ("gdcm", "MR_Philips_Intera_No_PrivateSequenceImplicitVR.dcm", "Philips implicit VR without private sequence", ["parse-private-sq"]),
    ("gdcm", "MR_Philips_Intera_PrivateSequenceExplicitVR_in_SQ_2001_e05f_item_wrong_lgt_use_NOSHADOWSEQ.dcm", "Philips private SQ item with wrong length", ["parse-bad-item-length"]),
    ("gdcm", "MR_Philips_Intera_PrivateSequenceImplicitVR.dcm", "Philips private sequence in implicit VR", ["parse-private-sq"]),
    ("gdcm", "MR_Philips_Intera_SwitchIndianess_noLgtSQItem_in_trueLgtSeq.dcm", "Philips: byte order switch inside a sequence", ["parse-endian-switch"]),
    ("gdcm", "NM-PAL-16-PixRep1.dcm", "16-bit PALETTE COLOR with Pixel Representation 1", ["palette", "signed-palette"]),
    ("gdcm", "NM_Kakadu44_SOTmarkerincons.dcm", "Kakadu 4.4 J2K with inconsistent SOT marker (Psot)", ["j2k-bad-sot"]),
    ("gdcm", "Osirix10vs8BitsStored.dcm", "J2K precision 10 while Bits Stored says 8 (OsiriX)", ["dicom-vs-j2k-header"]),
    ("gdcm", "OsirixFake16BitsStoredFakeSpacing.dcm", "J2K lossy with fake Bits Stored 16 (OsiriX)", ["dicom-vs-j2k-header"]),
    ("gdcm", "PET-GE-dicomwrite-PixelDataSQUN.dcm", "Pixel Data written as SQ/UN by MATLAB dicomwrite (GE PET)", ["pixel-data-as-sq"]),
    ("gdcm", "PET-GE-dicomwrite-PixelDataSQUNv2.dcm", "Pixel Data written as SQ/UN, variant 2", ["pixel-data-as-sq"]),
    ("gdcm", "PET-GE-dicomwrite-PixelDataSQUNv3.dcm", "Pixel Data written as SQ/UN, variant 3", ["pixel-data-as-sq"]),
    ("gdcm", "PHILIPS_Brilliance_ExtraBytesInOverlay.dcm", "extra bytes in overlay data (Philips Brilliance)", ["parse-overlay"]),
    ("gdcm", "PHILIPS_GDCM12xBug.dcm", "file damaged by a GDCM 1.2 writer bug", ["parse-writer-bug"]),
    ("gdcm", "PHILIPS_GDCM12xBug2.dcm", "file damaged by a GDCM 1.2 writer bug, variant 2", ["parse-writer-bug"]),
    ("gdcm", "PHILIPS_Gyroscan-12-Jpeg_Extended_Process_2_4.dcm", "Philips Gyroscan JPEG extended, SOF precision vs Bits Stored", ["dicom-vs-jpeg-header"]),
    ("gdcm", "PHILIPS_Gyroscan-12-MONO2-Jpeg_Lossless.dcm", "Philips Gyroscan JPEG lossless 12-bit", ["dicom-vs-jpeg-header"]),
    ("gdcm", "PHILIPS_Gyroscan-8-MONO2-Odd_Sequence.dcm", "odd-length sequence, 8 of 16 bits stored", ["parse-odd-length"]),
    ("gdcm", "PICKER-16-MONO2-Nested_icon.dcm", "nested icon sequences (Picker)", ["parse-icon-sequence"]),
    ("gdcm", "PICKER-16-MONO2-No_DicomV3_Preamble.dcm", "no 128-byte preamble (Picker)", ["no-preamble"]),
    ("gdcm", "PhilipsInteraSeqTermInvLen.dcm", "sequence delimiter with a non-zero length", ["parse-bad-delimiter"]),
    ("gdcm", "PrivateGEImplicitVRBigEndianTransferSyntax16Bits.dcm", "GE private implicit VR big endian syntax, 16-bit", ["private-syntax"]),
    ("gdcm", "RLEDebianBug816607Orig.dcm", "RLE file from Debian bug 816607", ["rle-bug-report"]),
    ("gdcm", "RadBWLossLess.dcm", "small JPEG lossless 16-bit", ["jpeg-lossless"]),
    ("gdcm", "DermaColorLossLess.dcm", "small RGB JPEG lossless", ["jpeg-lossless-rgb"]),
    ("gdcm", "SC16BitsAllocated_8BitsStoredJ2K.dcm", "J2K, 8 bits stored in 16; codestream precision differs", ["dicom-vs-j2k-header"]),
    ("gdcm", "SC16BitsAllocated_8BitsStoredJPEG.dcm", "JPEG lossless, 8 bits stored in 16; SOF precision differs", ["dicom-vs-jpeg-header"]),
    ("gdcm", "SIEMENS-12-Jpeg_Process_2_4-Lossy-a.dcm", "Siemens JPEG extended 12-bit", ["jpeg-extended-12"]),
    ("gdcm", "SIEMENS-MR-RGB-16Bits.dcm", "RGB with Bits Allocated 16, Bits Stored 12", ["rgb-16bit"]),
    ("gdcm", "SIEMENS_MOSAIC_12BitsStored-16BitsJPEG.dcm", "Siemens mosaic: JPEG SOF says 16 bits, Bits Stored 12", ["dicom-vs-jpeg-header"]),
    ("gdcm", "SIEMENS_SYNGO-12-MONO2-LUTWrongLength512.dcm", "LUT with wrong length", ["parse-lut"]),
    ("gdcm", "SignedShortLosslessBug.dcm", "signed 16-bit JPEG lossless process 14 with an encoder bug (pylibjpeg-data JPEGLossless_1s_1f_i_16_16_bad is the same file)", ["jpeg-lossless-signed", "jpeg-lossless-encoder-bug"]),
    ("gdcm", "THERALYS-12-MONO2-Uncompressed-Even_Length_Tag.dcm", "Theralys file with even-length tag oddities", ["parse-odd-length"]),
    ("gdcm", "TOSHIBA_J2K_OpenJPEGv2Regression.dcm", "Toshiba J2K that regressed in OpenJPEG 2", ["j2k-toshiba"]),
    ("gdcm", "TOSHIBA_J2K_SIZ0_PixRep1.dcm", "J2K SIZ unsigned while Pixel Representation is 1", ["j2k-sign-mismatch"]),
    ("gdcm", "TOSHIBA_J2K_SIZ1_PixRep0.dcm", "J2K SIZ signed while Pixel Representation is 0", ["j2k-sign-mismatch"]),
    ("gdcm", "TheralysGDCM120Bug.dcm", "file damaged by a GDCM 1.2.0 writer bug", ["parse-writer-bug"]),
    ("gdcm", "US-GE-4AICL142.dcm", "GE US JPEG baseline YBR_FULL_422", ["jpeg-colour-label"]),
    ("gdcm", "US-PAL-8-10x-echo.dcm", "RLE palette multi-frame echo", ["palette", "multiframe"]),
    ("gdcm", "US-RGB-8-epicard.dcm", "explicit VR big endian RGB, planar configuration 1", ["big-endian", "planar-config"]),
    ("gdcm", "UnexpectedSequenceDelimiterInFixedLengthSequence.dcm", "sequence delimiter inside a defined-length sequence", ["parse-bad-delimiter"]),
    ("gdcm", "XA-MONO2-8-12x-catheter.dcm", "XA multi-frame JPEG lossless", ["multiframe-fragments"]),
    ("gdcm", "fffc0000UN.dcm", "data set trailing padding (FFFC,0000) as UN", ["parse-trailing-padding"]),
    ("gdcm", "gdcm-CR-DCMTK-16-NonSamplePerPix.dcm", "Samples per Pixel missing", ["missing-samples-per-pixel"]),
    ("gdcm", "gdcm-JPEG-Extended.dcm", "JPEG extended 12-bit written by GDCM", ["jpeg-extended-12"]),
    ("gdcm", "gdcm-JPEG-LossLessThoravision.dcm", "Philips Thoravision JPEG lossless, 15 bits stored", ["jpeg-lossless"]),
    ("gdcm", "gdcm-US-ALOKA-16.dcm", "16-bit PALETTE COLOR US (Aloka) with segmented LUTs", ["palette"]),
    ("gdcm", "rle16loo.dcm", "16-bit palette RLE multi-frame", ["palette", "rle-16"]),
    ("gdcm", "rle16sti.dcm", "16-bit palette RLE single frame", ["palette", "rle-16"]),
    ("gdcm", "undefined_length_un_vr.dcm", "undefined-length element with VR UN", ["parse-undefined-un"]),
    ("gdcm", "MR-MONO2-8-16x-heart.dcm", "explicit VR multi-frame 8-bit", ["multiframe"]),
    ("gdcm", "JPEGLS_CharLS_10742.dcm", "file once produced by CharLS bug 10742 (now stored native)", ["jpeg-ls-encoder-bug"]),
    ("gdcm", "SIEMENS_MAGNETOM-12-MONO2-VRUN.dcm", "elements with VR UN in a Siemens file", ["parse-un"]),
    ("gdcm", "MR-Brucker-CineTagging-NonSquarePixels.dcm", "Bruker file, non-square pixels", ["parse-misc"]),
    ("gdcm", "KODAK-12-MONO1-Odd_Terminated_Sequence.dcm", "ACR-NEMA-like Kodak file with an odd sequence terminator, no meta", ["no-meta"]),
    ("gdcm", "CR-MONO1-10-chest.dcm", "no file meta, implicit VR guessed", ["no-meta"]),
    ("gdcm", "FUJI-10-MONO1-ACR_NEMA_2.dcm", "ACR-NEMA 2.0 file (Fuji)", ["acr-nema"]),
    ("gdcm", "SIEMENS_GBS_III-16-ACR_NEMA_1.acr", "ACR-NEMA 1.0 file (Siemens GBS)", ["acr-nema"]),
    ("gdcm", "US-IRAD-NoPreambleStartWith0003.dcm", "no preamble, starts with group 0003", ["no-meta"]),
    ("gdcm", "TOSHIBA_MRT150-16-MONO2-ACR_NEMA_2.dcm", "ACR-NEMA 2.0 file (Toshiba)", ["acr-nema"]),
    ("gdcm", "LIBIDO-24-ACR_NEMA-Rectangle.dcm", "ACR-NEMA 24-bit Libido file", ["acr-nema"]),
    ("gdcm", "gdcm-ACR-LibIDO.acr", "ACR-NEMA LIBIDO file: Rows and Columns stored swapped", ["acr-nema"]),
    ("gdcm", "MR_ELSCINT1_00e1_1042_SQ_feff_00e0_Item.dcm", "byte-swapped item tag (FEFF,00E0) in an Elscint SQ, no meta", ["no-meta"]),
    # ---------------- pylibjpeg-data ----------------
    ("pylibjpeg", "ljdata/ds/JPEG2000Lossless/966.dcm", "J2K with an invalid COM marker mid-codestream (pydicom #966)", ["j2k-bad-marker"]),
    ("pylibjpeg", "ljdata/ds/JPEG2000Lossless/966_fixed.dcm", "the same J2K with the bad COM marker removed (pydicom #966)", ["j2k-bad-marker"]),
    ("pylibjpeg", "ljdata/ds/JPEGExtended/RG2_JPLY.dcm", "JPEG extended with SOS Se=0 (should be 63), WG04 RG2", ["jpeg-bad-sos"]),
    ("pylibjpeg", "ljdata/ds/JPEGExtended/RG2_JPLY_fixed.dcm", "RG2_JPLY with Se fixed", ["jpeg-bad-sos"]),
    ("pylibjpeg", "ljdata/ds/JPEGLosslessSV1/532_JPEGLossless_VOI.dcm", "JPEG lossless with icon and 3 VOI LUTs", ["parse-icon-sequence"]),
    ("pylibjpeg", "ljdata/ds/JPEGLosslessSV1/JPEGLosslessP14SV1_3s_2f_u_08_08.dcm", "RGB JPEG lossless, 2 frames", ["jpeg-lossless-rgb", "multiframe"]),
    ("pylibjpeg", "ljdata/ds/JPEGBaseline/SC_rgb_jpeg_lossy_gdcm.dcm", "JPEG baseline from GDCM labelled RGB", ["jpeg-colour-label"]),
    ("pylibjpeg", "ljdata/ds/JPEGLSLossless/RG1_JLSL.dcm", "JPEG-LS lossless MONOCHROME1 15-bit", ["jpeg-ls"]),
    ("pylibjpeg", "ljdata/ds/JPEGLS/CT1_JLSN.dcm", "JPEG-LS near-lossless signed CT", ["jpeg-ls-signed"]),
    # ---------------- Orthanc ----------------
    ("orthanc", "2020-09-12-ELSCINT1-PMSCT_RLE1.dcm", "Elscint PMSCT_RLE1 private compression (Slicer discourse 8158)", ["private-compression"]),
    ("orthanc", "2020-09-11-Christopher-ELSCINT1-Raw.dcm", "Elscint raw companion of a PMSCT_RLE1 file", ["private-compression"]),
    ("orthanc", "2021-02-19-MalaterreCP246.dcm", "JPEG-LS with SQ encoded per CP-246", ["parse-sq-as-un"]),
    ("orthanc", "2022-03-08-RicSmi.dcm", "J2K lossless signed, user-reported", ["j2k-sign-mismatch"]),
    ("orthanc", "2022-11-14-RLEPlanarConfiguration.dcm", "RLE RGB with Planar Configuration 1 declared (RLE is always planar)", ["rle-planar-config"]),
    ("orthanc", "2023-04-21-RLEPlanarConfigurationYBR_FULL.dcm", "RLE YBR_FULL with Planar Configuration 1", ["rle-planar-config", "rle-ybr-full"]),
    ("orthanc", "2024-05-30-GuillemVela.dcm", "JPEG lossless user-reported decoding issue", ["jpeg-lossless"]),
    ("orthanc", "2026-05-26-oob-monochrome-46341.dcm", "Rows x Columns 46341^2 (int32 overflow) with tiny Pixel Data", ["oob-dimensions"]),
    ("orthanc", "2026-05-26-oob-monochrome-65535.dcm", "Rows x Columns 65535^2 with tiny Pixel Data", ["oob-dimensions"]),
    ("orthanc", "ColorTestMalaterre.dcm", "implicit VR RGB colour test (Debian bug 698417)", ["rgb"]),
    ("orthanc", "ColorTestImageJ.dcm", "RGB with Planar Configuration 1 (ImageJ cardio)", ["planar-config"]),
    ("orthanc", "Implicit-vr-us-palette.dcm", "implicit VR palette US", ["palette"]),
    ("orthanc", "Issue19.dcm", "native YBR_FULL (Orthanc issue 19)", ["native-ybr"]),
    ("orthanc", "Issue22.dcm", "multi-frame native (Orthanc issue 22: multi-frame decoding error)", ["multiframe"]),
    ("orthanc", "Issue29.dcm", "JPEG baseline YBR_FULL_422 (Orthanc issue 29)", ["jpeg-colour-label"]),
    ("orthanc", "Issue42.dcm", "H.264 video (Orthanc issue 42)", ["video"]),
    ("orthanc", "Issue94.dcm", "implicit VR signed (Orthanc issue 94)", ["signed"]),
    ("orthanc", "Issue124.dcm", "signed CT (Orthanc issue 124)", ["signed"]),
    ("orthanc", "Issue140.dcm", "3x3 JPEG lossless (Orthanc issue 140)", ["jpeg-lossless-tiny"]),
    ("orthanc", "Issue141.dcm", "Orthanc issue 141", ["misc"]),
    ("orthanc", "Issue143.dcm", "RGB (Orthanc issue 143)", ["rgb"]),
    ("orthanc", "Issue164.dcm", "multi-frame JPEG baseline YBR_FULL_422, 87 frames (Orthanc issue 164)", ["multiframe-fragments", "jpeg-colour-label"]),
    ("orthanc", "Issue169.dcm", "large RGB 3480x4248 (Orthanc issue 169)", ["large"]),
    ("orthanc", "LenaTwiceWithFragments.dcm", "two JPEG frames each split over fragments", ["frame-split-fragments"]),
    ("orthanc", "Multiframe.dcm", "Philips Integris multi-frame JPEG lossless, 76 frames", ["multiframe-fragments"]),
    ("orthanc", "PilatesArgenturGEUltrasoundOsiriX.dcm", "GE US RGB exported by OsiriX", ["rgb"]),
    ("orthanc", "KarstenHilbertRF.dcm", "RF image from a user report", ["misc"]),
    ("orthanc", "SignedCT.dcm", "signed CT", ["signed"]),
    ("orthanc", "US-multiframe-RGB48-RAW.dcm", "16-bit PALETTE COLOR multi-frame US (RGB48 LUT)", ["palette"]),
    ("orthanc", "US-multiframe-RGB48-RLE.dcm", "16-bit PALETTE COLOR multi-frame RLE", ["palette", "rle-16"]),
    ("orthanc", "Formats/jp2k91YBR-ICT.dcm", "J2K lossy YBR_ICT", ["j2k-ybr-ict"]),
    ("orthanc", "Formats/jpegls80-YBR-FULL.dcm", "JPEG-LS colour labelled YBR_FULL", ["jpeg-ls-colour-label"]),
    ("orthanc", "TransferSyntaxes/1.2.840.10008.1.2.4.51.dcm", "WG04 MG1_JPLY (JPEG extended 12-bit)", ["jpeg-extended-12"]),
    ("orthanc", "TransferSyntaxes/1.2.840.10008.1.2.4.50.dcm", "Philips US JPEG baseline YBR (GDCM US_DataSet)", ["jpeg-colour-label"]),
    # ---------------- cornerstone3D ----------------
    ("cs3d", "CT0012.fragmented_no_bot_jpeg_baseline.51.dcm", "two JPEG extended frames over many fragments, empty Basic Offset Table", ["frame-split-fragments", "empty-bot"]),
    ("cs3d", "us-multiframe-ybr-full-422.dcm", "native YBR_FULL_422 multi-frame (78 frames, subsampled native)", ["native-ybr-422"]),
    ("cs3d", "TestPattern_JPEG-Baseline_YBR422.dcm", "JPEG baseline YBR_FULL_422 test pattern", ["jpeg-colour-label"]),
    ("cs3d", "TestPattern_JPEG-Baseline_YBRFull.dcm", "JPEG baseline labelled YBR_FULL test pattern", ["jpeg-colour-label"]),
    ("cs3d", "TestPattern_JPEG-LS-Lossless.dcm", "JPEG-LS RGB test pattern", ["jpeg-ls-rgb"]),
    ("cs3d", "TestPattern_JPEG-LS-NearLossless.dcm", "JPEG-LS near-lossless RGB test pattern", ["jpeg-ls-rgb"]),
    ("cs3d", "TestPattern_JPEG-Lossless_RGB.dcm", "JPEG lossless RGB test pattern", ["jpeg-lossless-rgb"]),
    ("cs3d", "TestPattern_Palette_16.dcm", "palette with 16-bit LUT entries", ["palette"]),
    ("cs3d", "ColorImage.dcm_JPEGProcess14TransferSyntax_1.2.840.10008.1.2.4.57.dcm", "RGB JPEG lossless process 14 (.57)", ["jpeg-lossless-57", "jpeg-lossless-rgb"]),
    ("cs3d", "ColorImage.dcm_JPEGLSLosslessTransferSyntax_1.2.840.10008.1.2.4.80.dcm", "RGB JPEG-LS lossless", ["jpeg-ls-rgb"]),
    ("cs3d", "ColorImage.dcm_HTJ2KLosslessTransferSyntax_1.2.840.10008.1.2.4.201.dcm", "HTJ2K lossless YBR_RCT colour", ["htj2k-colour"]),
    ("cs3d", "CTImage.dcm_HTJ2KLosslessTransferSyntax_1.2.840.10008.1.2.4.201.dcm", "HTJ2K lossless signed CT", ["htj2k-signed"]),
    ("cs3d", "CTImage.dcm_JPEGProcess14TransferSyntax_1.2.840.10008.1.2.4.57.dcm", "signed CT JPEG lossless .57", ["jpeg-lossless-signed"]),
    ("cs3d", "CTImage.dcm_JPEGLSLossyTransferSyntax_1.2.840.10008.1.2.4.81.dcm", "signed CT JPEG-LS near-lossless", ["jpeg-ls-signed"]),
    ("cs3d", "CTImage.dcm_JPEGProcess10_12TransferSyntax_1.2.840.10008.1.2.4.55.dcm", "retired JPEG full progression (.55)", ["retired-jpeg"]),
    ("cs3d", "CTImage.dcm_JPEGProcess6_8TransferSyntax_1.2.840.10008.1.2.4.53.dcm", "retired JPEG spectral selection (.53)", ["retired-jpeg"]),
    ("cs3d", "CTImage.dcm_JPEGXLLosslessTransferSyntax_1.2.840.10008.1.2.4.110.dcm", "JPEG XL lossless", ["jpeg-xl"]),
    ("cs3d", "ColorImage.dcm_JPEGXLLosslessTransferSyntax_1.2.840.10008.1.2.4.110.dcm", "JPEG XL lossless colour", ["jpeg-xl"]),
    ("cs3d", "CTImage.dcm_EncapsulatedUncompressedExplicitVRLittleEndianTransferSyntax_1.2.840.10008.1.2.1.98.dcm", "Encapsulated Uncompressed (.1.98)", ["encapsulated-uncompressed"]),
    ("cs3d", "CTImage.dcm_DeflatedImageFrameCompressionTransferSyntax_1.2.840.10008.1.2.8.1.dcm", "Deflated Image Frame Compression (.8.1)", ["deflated-frame"]),
    ("cs3d", "ColorImage.dcm_DeflatedImageFrameCompressionTransferSyntax_1.2.840.10008.1.2.8.1.dcm", "Deflated Image Frame Compression, RGB (.8.1)", ["deflated-frame"]),
    ("cs3d", "CTImage.dcm_DeflatedExplicitVRLittleEndianTransferSyntax_1.2.840.10008.1.2.1.99.dcm", "Deflated Explicit VR LE CT", ["deflate"]),
    ("cs3d", "paramap-float.dcm", "Float Pixel Data parametric map", ["float-pixel-data"]),
    # ---------------- Clunie ----------------
    ("clunie", "signedrange/IMAGES/test9signedSmallNegativeNW/test9signedSmallNegativeNW.dcm", "signed, 9 bits stored", ["signed-bits-stored"]),
    ("clunie", "signedrange/IMAGES/test10signedNW/test10signedNW.dcm", "signed, 10 bits stored, full range", ["signed-bits-stored"]),
    ("clunie", "signedrange/IMAGES/test11signedSmallNegativeNW/test11signedSmallNegativeNW.dcm", "signed, 11 bits stored, small negatives", ["signed-bits-stored"]),
    ("clunie", "signedrange/IMAGES/test12signedNW/test12signedNW.dcm", "signed, 12 bits stored, full range", ["signed-bits-stored"]),
    ("clunie", "signedrange/IMAGES/test13signedLimitedNW/test13signedLimitedNW.dcm", "signed, 13 bits stored, limited range", ["signed-bits-stored"]),
    ("clunie", "signedrange/IMAGES/test14signed/test14signed.dcm", "signed, 14 bits stored", ["signed-bits-stored"]),
    ("clunie", "signedrange/IMAGES/test15signedSmallNegativeNW/test15signedSmallNegativeNW.dcm", "signed, 15 bits stored, small negatives", ["signed-bits-stored"]),
    ("clunie", "signedrange/IMAGES/test16signedLimited/test16signedLimited.dcm", "signed, 16 bits stored, limited range", ["signed-bits-stored"]),
    ("clunie", "signedrange/IMAGES/test11unsignedLimitedRescale/test11unsignedLimitedRescale.dcm", "unsigned 11 bits stored with rescale", ["bits-stored"]),
    # ---------------- fo-dicom (Tests/FO-DICOM.Tests/Test Data; GHnnn = fo-dicom issue nnn) ----------------
    ("fodicom", "FO-DICOM.Tests/Test Data/D_CLUNIE_CT1_RLE_FRAGS.dcm", "one RLE frame split over several fragments", ["frame-split-fragments", "rle"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/HasFragmentSequence.dcm", "multi-frame JPEG baseline, 96 frames, fragment sequence", ["multiframe-fragments"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/GH1049_planar_0.dcm", "native YBR_FULL_422, Planar Configuration 0 (fo-dicom #1049)", ["native-ybr-422"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/GH1049_planar_1.dcm", "native YBR_FULL_422 with Planar Configuration 1 (illegal for 422; fo-dicom #1049)", ["native-ybr-422", "planar-config-bogus"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/GH133.dcm", "encapsulated pixel data inside a sequence item (fo-dicom #133)", ["parse-icon-sequence"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/GH177_D_CLUNIE_CT1_IVRLE_BigEndian_ELE_undefinded_length.dcm", "CP-246 undefined-length SQ in an explicit data set (fo-dicom #177)", ["parse-sq-as-un"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/GH177_D_CLUNIE_CT1_IVRLE_BigEndian_undefined_length.dcm", "CP-246 implicit/big-endian undefined-length SQ as UN; pydicom fails to read (fo-dicom #177)", ["parse-sq-as-un"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/GH184.dcm", "signed JPEG lossless that fo-dicom failed to open (fo-dicom #184)", ["jpeg-lossless-signed"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/GH195.dcm", "JPEG extended 8-bit RGB (fo-dicom #195: buffer exception)", ["jpeg-colour-label"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/GH340.dcm", "no meta, Bits Allocated 12 (fo-dicom #340: render error)", ["no-meta", "bits-allocated-12"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/GH364.dcm", "Philips US JPEG-LS 8-bit (fo-dicom #364)", ["jpeg-ls"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/GH538-jpeg1.dcm", "JPEG baseline labelled YBR_FULL (fo-dicom #538)", ["jpeg-colour-label"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/GH538-jpeg14sv1.dcm", "RGB JPEG lossless (fo-dicom #538)", ["jpeg-lossless-rgb"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/GH626.dcm", "Planar Configuration on a MONO2 file with a bad private sequence (fo-dicom #626)", ["planar-config-mono", "parse-private-sq"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/GH064.dcm", "J2K file fo-dicom could not parse (fo-dicom #64)", ["j2k"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/GH1261.dcm", "single-coloured image, JPEG lossless (fo-dicom #1261)", ["jpeg-lossless-flat"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/GH1442.dcm", "XA multi-frame JPEG lossless (fo-dicom #1442)", ["multiframe-fragments"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/test_1847.dcm", "element length that is a blank character (fo-dicom #1847)", ["parse-bad-length"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/GH1876.dcm", "fo-dicom could not read Pixel Data (fo-dicom #1876)", ["parse-misc"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/GH1941.dcm", "invalid VR in group length (fo-dicom #1941)", ["parse-bad-vr"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/GH1376.dcm", "two file meta groups; the second overwrites the first (fo-dicom #1376)", ["meta-duplicate"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/GH1728.dcm", "overlay data present (fo-dicom #1728)", ["parse-overlay"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/OutOfBoundsOverlay.dcm", "overlay outside the image bounds", ["parse-overlay"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/JPEGwithIcon.dcm", "JPEG baseline with an icon sequence", ["parse-icon-sequence"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/DIRW0007", "JPEG baseline YBR_FULL_422 multi-frame, 65 frames", ["multiframe-fragments"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/multiframe.dcm", "JPEG baseline YBR_FULL_422 multi-frame, 140 frames", ["multiframe-fragments"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/10200904.dcm", "RLE palette multi-frame, 79 frames", ["palette", "multiframe"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/1403-OB.dcm", "3x3 RGB with OB Pixel Data", ["tiny"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/VL5_J2KI.dcm", "large J2K YBR_ICT (WG04 VL5)", ["j2k-ybr-ict"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/CR-ModalitySequenceLUT.dcm", "JPEG lossless MONOCHROME1 with modality LUT sequence", ["jpeg-lossless"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/ETIAM_video_002.dcm", "MPEG-2 video", ["video"]),
    ("fodicom", "FO-DICOM.Tests/Test Data/test_720.dcm", "H.264 video", ["video"]),
    # ---------------- dcm4che test data ----------------
    ("dcm4che", "YBR_422.dcm", "native YBR_FULL_422 (subsampled native layout)", ["native-ybr-422"]),
    ("dcm4che", "YBR_FULL-RLE.dcm", "RLE YBR_FULL with Planar Configuration 1", ["rle-ybr-full", "rle-planar-config"]),
    ("dcm4che", "jpeg-ls-Palette.dcm", "JPEG-LS PALETTE COLOR multi-frame", ["jpeg-ls", "palette"]),
    ("dcm4che", "jpeg-ls-Palette-multifragment.dcm", "JPEG-LS palette, frames split over several fragments", ["jpeg-ls", "palette", "frame-split-fragments"]),
    ("dcm4che", "ovly_p01.dcm", "overlay planes stored in the unused high bits of Pixel Data (Bits Stored 12 of 16)", ["overlay-in-high-bits"]),
    ("dcm4che", "cplx_p02.dcm", "two-frame 8-bit native, dcm4che test object", ["multiframe"]),
    ("dcm4che", "test16signed.dcm", "signed 16-bit native", ["signed"]),
    ("dcm4che", "MR-JPEGLosslessSV1.dcm", "JPEG lossless, Bits Stored 8 in 16; SOF precision vs Bits Stored", ["dicom-vs-jpeg-header"]),
    ("dcm4che", "CT-JPEGLosslessSV1.dcm", "JPEG lossless 12-bit CT", ["jpeg-lossless"]),
    ("dcm4che", "will-jxl.dcm", "JPEG XL JPEG recompression (.111), multi-frame", ["jpeg-xl"]),
    ("dcm4che", "3gb-bulk-data-truncated", "truncated file with multi-valued Rows/Columns and huge declared bulk data", ["truncated", "oob-dimensions"]),
]


def case_id(src: str, path: str) -> str:
    name = Path(path).name
    if name.lower().endswith(".dcm"):
        name = name[:-4]
    if src == "issue":
        name = path.split("/", 1)[0].split("_", 1)[1] + "-" + name
    return f"ext-{src}-" + re.sub(r"[^A-Za-z0-9._+-]", "_", name)


def local_path(cache: Path, src: str, path: str) -> Path:
    base = cache / SOURCES[src]["dir"]
    if src == "orthanc":
        return base / path.replace("/", "_")
    return base / path


def url_for(src: str, path: str, extra: dict) -> str:
    tpl = SOURCES[src]["url"]
    if src == "clunie":
        arch = "compressed/deflate_tests_release.tar.gz" if path.startswith("deflate") else "signedrange/signedrangeimages.tar.bz2"
        return tpl.format(archive=arch) + f" ({path.split('/', 1)[1]})"
    if src == "issue":
        return extra.get("url", "")
    return tpl.format(path=path)


def load_issue_cases(cache: Path) -> list[tuple[str, str, str, list[str], dict]]:
    """Issue attachments are described in issues/index.json: [{path, url, issue, quirk, tags}]."""
    idx = cache / "issues" / "index.json"
    if not idx.exists():
        return []
    out = []
    for e in json.loads(idx.read_text()):
        out.append(("issue", e["path"], e["quirk"], e.get("tags", []), {"url": e["url"], "issue": e["issue"]}))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", type=Path, default=Path.home() / ".cache" / "shl-quirks")
    ap.add_argument("--only")
    ap.add_argument("--id", action="append", help="register only these case ids (repeatable)")
    a = ap.parse_args()
    import pydicom

    todo = [(s, p, q, t, {}) for s, p, q, t in CASES] + load_issue_cases(a.cache)
    budget: dict[str, int] = {}
    registered, skipped = [], []
    for src, path, quirk, tags, extra in todo:
        if a.only and src != a.only:
            continue
        lp = local_path(a.cache, src, path)
        cid = case_id(src, path)
        if a.id and cid not in a.id:
            continue
        if not lp.exists():
            skipped.append({"id": cid, "path": str(lp), "reason": "not downloaded", "quirk": quirk})
            continue
        source = {
            "kind": "external",
            "origin": SOURCES[src]["origin"] + (f" {extra['issue']}" if "issue" in extra else ""),
            "url": url_for(src, path, extra),
            "license": SOURCES[src]["license"],
            "quirk": quirk,
        }
        fmt = register(lp, cid, source, budget, 10**9)
        if fmt is None:
            try:
                ds = pydicom.dcmread(lp, force=True, stop_before_pixels=True)
                ts = str(ds.file_meta.get("TransferSyntaxUID", "") or "")
            except Exception as e:  # noqa: BLE001
                ts = f"unreadable: {e}"
            reason = ("no Transfer Syntax UID (no Part 10 meta)" if not ts else
                      "transfer syntax not in TRANSFER_SYNTAXES" if ts not in TRANSFER_SYNTAXES else
                      "no Pixel Data or pydicom could not describe it")
            skipped.append({"id": cid, "path": str(lp), "transfer_syntax": ts, "reason": reason,
                            "quirk": quirk, "url": source["url"], "license": source["license"]})
            print(f"{'SKIP':14} {cid}  ({reason}; {ts})")
            continue
        cases = {c["id"]: c for c in load_cases(fmt)}
        entry = cases[cid]
        entry["tags"] = sorted(set(entry.get("tags", [])) | {"quirk", *tags})
        if not entry.get("notes"):
            entry["notes"] = quirk
        save_cases(fmt, [entry])
        registered.append({"id": cid, "format": fmt})
        print(f"{fmt:14} {cid}")
    if a.id:
        return   # a partial run leaves the full run's lists alone
    (a.cache / "skipped.json").write_text(json.dumps(skipped, indent=2) + "\n")
    (a.cache / "registered.json").write_text(json.dumps(registered, indent=2) + "\n")
    print(f"registered {len(registered)}, skipped {len(skipped)} (see {a.cache / 'skipped.json'})")


if __name__ == "__main__":
    main()
