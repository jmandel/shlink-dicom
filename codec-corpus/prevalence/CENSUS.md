# Encoding census

This file lists every way DICOM pixel data can be encoded, estimates how common each one is in files that patients and clinics hand over, and proposes which ones the decoder must support.

The measured numbers in `profiles-idc.csv` and `SOURCES.md` are a separate thing. This census is a desk study. Almost all of its prevalence statements come from conformance statements, specs, toolkit test corpora and issue trackers, not from counting clinical files. Each row says which kind of evidence it rests on.

Registry source: DICOM PS3.6 2026d, Table A-1 ([chapter_A.html](https://dicom.nema.org/medical/dicom/current/output/chtml/part06/chapter_A.html)), fetched 2026-10-14. Every row with Info Type "Transfer Syntax" is listed below, retired ones included.

The introduction years in the "Era / status" column are approximate. They are from memory of the supplement history and were not checked one by one; retirement years come from the registry.

## How to read the table

**Prevalence bands** are about clinical studies, which is the unit of patient CDs and portal downloads:
- **common:** in more than 1% of clinical studies
- **occasional:** 0.1–1%
- **rare:** under 0.1%, but still produced or still found in archives
- **extinct:** no longer produced, and no reports of real files found
- **not file storage:** defined for network streaming only, so it never appears in a file

A band followed by *(guess)* is my judgement from the evidence cited, not a measurement.

**Evidence quality**, given in the [references](#references):
- **M:** measured counts
- **S:** spec text
- **V:** vendor conformance statement or documentation
- **T:** toolkit source or test data (one real file per quirk, no frequency)
- **X:** expert talk or blog
- **A:** a single forum post or issue (anecdotal)

**Tiers:**
- **1:** must decode in Rust
- **2:** should support, in Rust or through the browser
- **3:** refuse with a clear message that names the encoding

### The only measured data: IDC

[R1] is from `profiles-idc.csv`, built by the prevalence agent: 58.5M instances, mostly CT, MR and PT. Share of instances by transfer syntax:

| Transfer syntax | Share of instances |
|---|---|
| Explicit VR LE | 72.2% |
| Implicit VR LE | 27.1% |
| JPEG Baseline (.50) | 0.38% (almost all SM) |
| JPEG 2000 Lossless (.90) | 0.096% (MR, MG, SM) |
| JPEG 2000 (.91) | 0.066% (SM) |
| JPEG Lossless SV1 (.70) | 0.063% (CT, MR, PT, CR, DX) |
| Explicit VR Big Endian | 0.052% |
| JPEG Extended (.51) | 0.046% |
| JPEG-LS Lossless (.80) | 261 instances (SEG) |
| Deflated Explicit VR LE | 129 instances (SEG) |

Nothing else appears: no RLE, no video, no HTJ2K.

IDC is a research archive. Much of it was decompressed during TCIA de-identification, and it has almost no US, XA, endoscopy or video. So it over-represents uncompressed data and under-represents the compressed encodings that dominate clinical US, XA and CD exports. Use it as a floor for the "native" share, not as a clinical distribution.

## 1. Transfer syntaxes

| Item | UID | Era / status | Where seen | Prevalence | Evidence | Tier |
|---|---|---|---|---|---|---|
| Implicit VR Little Endian | 1.2.840.10008.1.2 | 1993–, current (default) | Everything, especially older modalities, PACS exports and research archives. 27% of IDC instances. | common | R1 (M), R10, R12 (V) | 1 |
| Explicit VR Little Endian | 1.2.840.10008.1.2.1 | 1993–, current | The only image syntax in the STD-GEN-CD media profile, and the IHE PDI baseline. Fuji Synapse burns only this. Philips IntelliSpace decompresses lossless studies to this on media. 72% of IDC instances. | common (dominant on CDs) | R1 (M), R2, R3 (S), R5, R6 (V) | 1 |
| Explicit VR Big Endian | 1.2.840.10008.1.2.2 | Retired 2006 | Still offered in 2020–2024 conformance statements (Philips Azurion, Siemens Artis, Hologic Dimensions, Storz SCENARA), but no vendor makes it the default. 0.05% of IDC instances (CT, MR, PT). | rare | R1 (M), R11, R13, R14 (V), R15 (S) | 1 (cheap: byte swap) |
| Deflated Explicit VR LE | 1.2.840.10008.1.2.1.99 | 2001–, current | Meant for non-image objects such as SR. Seen in IDC on SEG only. | rare | R1 (M), R16 (S) | 1 (cheap: zlib inflate of the dataset) |
| Encapsulated Uncompressed Explicit VR LE | 1.2.840.10008.1.2.1.98 | 2023–, current | One native frame per fragment, for DICOMweb or WSI frame access. No device reported writing it. | rare *(guess)* | R17 (S), R18 (T) | 2 (cheap) |
| Deflated Image Frame Compression | 1.2.840.10008.1.2.8.1 | Sup 244, 2025 | Per-frame deflate. Intended for 1-bit SEG, including WSI segmentations. | rare *(guess)* | R19 (S) | 2 (cheap) |
| JPEG Baseline (Process 1) | 1.2.840.10008.1.2.4.50 | 1993–, current | US stills and cine (all vendors; YBR_FULL_422, the most common US compression), echo, WSI tiles (most scanners), SC, VL photos, lossy CD/DVD exports (Sectra, Philips pass lossy through), and the STD-GEN-DVD-JPEG reader requirement. | common | R1 (M), R2, R3 (S), R5, R7, R8, R9, R20, R21 (V), R22 (X) | 1 |
| JPEG Extended (Process 2 & 4; 12-bit lossy) | 1.2.840.10008.1.2.4.51 | 1993–, current | Lossy 12-bit CT/MR/XA from PACS lossy archiving and Sectra media export. 0.05% of IDC (CT). | occasional *(guess)* | R1 (M), R5, R13 (V) | 1 |
| JPEG Extended (Process 3 & 5) | 1.2.840.10008.1.2.4.52 | Retired 2001 (arithmetic coding) | No real files reported. | extinct | R23 (T, absence) | 3 |
| JPEG Spectral Selection, non-hierarchical (6 & 8) | 1.2.840.10008.1.2.4.53 | Retired 2001 | Cornerstone still decodes it; no file reports found. | extinct *(guess)* | R18 (T) | 3, or 2 if the JPEG decoder has progressive mode anyway |
| JPEG Spectral Selection, non-hierarchical (7 & 9) | 1.2.840.10008.1.2.4.54 | Retired 2001 (arithmetic) | None found. | extinct | — | 3 |
| JPEG Full Progression, non-hierarchical (10 & 12) | 1.2.840.10008.1.2.4.55 | Retired 2001 | Cornerstone decodes it; no file reports found. | extinct *(guess)* | R18 (T) | 3, or 2 as for .53 |
| JPEG Full Progression, non-hierarchical (11 & 13) | 1.2.840.10008.1.2.4.56 | Retired 2001 (arithmetic) | None found. | extinct | — | 3 |
| JPEG Lossless, non-hierarchical (Process 14, any predictor) | 1.2.840.10008.1.2.4.57 | 1993–, current | Older CT/MR/CR lossless, including GE 1990s media with known bitstream bugs. Philips IntelliSpace lists it. | occasional *(guess)* | R6 (V), R24 (X) | 1 (same decoder as .70) |
| JPEG Lossless, non-hierarchical (Process 15) | 1.2.840.10008.1.2.4.58 | Retired 2001 (arithmetic) | None found. | extinct | — | 3 |
| JPEG hierarchical processes 16–29 | 1.2.840.10008.1.2.4.59 – .66 | Retired 2001 | No implementations or file reports found. | extinct | R23 (T, absence) | 3 |
| JPEG Lossless SV1 (Process 14, predictor 1) | 1.2.840.10008.1.2.4.70 | 1993–, current | The workhorse lossless codec:<br>- XA/cardiac cine (Philips Azurion, Siemens Artis)<br>- CT/MR/CR/DX when compression is configured (Canon, Philips)<br>- Hologic mammo first choice<br>- US lossless option<br>- PACS lossless archives<br>- the STD-GEN-DVD-JPEG reader requirement<br>- 1990s–2000s cardiac CD-Rs. | common | R1 (M), R3 (S), R11, R13, R14, R25, R26 (V), R22 (X) | 1 |
| JPEG-LS Lossless | 1.2.840.10008.1.2.4.80 | 1999–, current | Hologic Dimensions mammo (offered after JPEG Lossless and native), dcm4chee-arc compression rules, research tools. Sectra uses a private LS variant internally. | rare to occasional *(guess)* | R1 (M), R14, R27, R5 (V), R28 (X) | 2 (high priority) |
| JPEG-LS Near-Lossless | 1.2.840.10008.1.2.4.81 | 1999–, current | No device reported writing it. | rare | — | 2 (same decoder as .80) |
| JPEG 2000 Lossless | 1.2.840.10008.1.2.4.90 | 2002–, current | PACS/VNA lossless archives (Fuji VNA, Sectra), Sectra DVD-J2K/USB-J2K media, GE LOGIQ option (YBR_RCT), Hologic mammo, WSI. 0.1% of IDC (MR, MG, SM). | common in some archives *(guess)* | R1 (M), R3, R4 (S), R5, R7, R29, R14 (V) | 1 |
| JPEG 2000 (lossy allowed) | 1.2.840.10008.1.2.4.91 | 2002–, current | Zeiss CIRRUS OCT (only option), WSI, lossy PACS archives passed through to media (Philips), GE LOGIQ option (YBR_ICT). | occasional *(guess)* | R1 (M), R6, R7, R30 (V), R22 (X) | 1 |
| JPEG 2000 Part 2 multi-component, lossless | 1.2.840.10008.1.2.4.92 | 2005–, current | No users found; GDCM does not list it; Cornerstone code path is commented out. | extinct *(guess)* | R31 (A), R18 (T) | 3 |
| JPEG 2000 Part 2 multi-component | 1.2.840.10008.1.2.4.93 | 2005–, current | Same as .92. | extinct *(guess)* | R31 (A) | 3 |
| JPIP Referenced | 1.2.840.10008.1.2.4.94 | 2005–, current | Pixel data is a URL to a JPIP server, not bytes. No deployments found. | extinct *(guess)* | R32 (S) | 3 |
| JPIP Referenced Deflate | 1.2.840.10008.1.2.4.95 | 2005–, current | Same as .94. | extinct *(guess)* | R32 (S) | 3 |
| MPEG2 Main Profile / Main Level | 1.2.840.10008.1.2.4.100 | 2004–, current | Older endoscopy and surgical recorders (Karl Storz SCENARA proposes it first). | rare to occasional for endoscopy studies; rare overall *(guess)* | R33 (V) | 3 (no browser decoder) |
| Fragmentable MPEG2 MP@ML | 1.2.840.10008.1.2.4.100.1 | 2020–, current | No devices found. | rare *(guess)* | — | 3 |
| MPEG2 Main Profile / High Level | 1.2.840.10008.1.2.4.101 | 2009–, current | HD endoscopy recorders, older. | rare *(guess)* | — | 3 |
| Fragmentable MPEG2 MP@HL | 1.2.840.10008.1.2.4.101.1 | 2020–, current | None found. | rare *(guess)* | — | 3 |
| MPEG-4 AVC/H.264 High Profile / Level 4.1 | 1.2.840.10008.1.2.4.102 | 2010–, current | Current endoscopy and surgical video (Hologic Omni 4K, Karl Storz SCENARA), Video Endoscopic and Video Photographic storage. | occasional within endoscopy/surgery; rare overall *(guess)* | R33, R34 (V), R35 (A) | 2 (browser `<video>`) |
| Fragmentable H.264 HP/L4.1 | 1.2.840.10008.1.2.4.102.1 | 2020–, current | None found. | rare *(guess)* | — | 2 (browser) |
| H.264 BD-compatible HP/L4.1 | 1.2.840.10008.1.2.4.103 | 2010–, current | Novanta/Med X Change Evolution4K; Storz accepts it. | rare *(guess)* | R36 (V) | 2 (browser) |
| Fragmentable H.264 BD-compatible HP/L4.1 | 1.2.840.10008.1.2.4.103.1 | 2020–, current | None found. | rare *(guess)* | — | 2 (browser) |
| H.264 HP/L4.2 for 2D video | 1.2.840.10008.1.2.4.104 | 2014–, current | Higher frame-rate surgical video. No specific devices found. | rare *(guess)* | — | 2 (browser) |
| Fragmentable H.264 HP/L4.2 2D | 1.2.840.10008.1.2.4.104.1 | 2020–, current | None found. | rare *(guess)* | — | 2 (browser) |
| H.264 HP/L4.2 for 3D video | 1.2.840.10008.1.2.4.105 | 2014–, current | Stereo surgical (robotic) video. None found. | rare *(guess)* | — | 2 (browser; shows one view) |
| Fragmentable H.264 HP/L4.2 3D | 1.2.840.10008.1.2.4.105.1 | 2020–, current | None found. | rare *(guess)* | — | 2 (browser) |
| H.264 Stereo High Profile / L4.2 | 1.2.840.10008.1.2.4.106 | 2014–, current | Stereo (MVC) surgical video. None found. | rare *(guess)* | — | 2 (browser decodes the base view only) |
| Fragmentable H.264 Stereo HP/L4.2 | 1.2.840.10008.1.2.4.106.1 | 2020–, current | None found. | rare *(guess)* | — | 2 (browser, base view) |
| HEVC/H.265 Main Profile / L5.1 | 1.2.840.10008.1.2.4.107 | 2016–, current | 4K endoscopy in principle. No device found writing it. | rare *(guess)* | R37 (S) | 2 (browser, where the platform has HEVC) |
| HEVC/H.265 Main 10 Profile / L5.1 | 1.2.840.10008.1.2.4.108 | 2016–, current | Same as .107. | rare *(guess)* | R37 (S) | 2 (browser, where supported) |
| JPEG XL Lossless | 1.2.840.10008.1.2.4.110 | Sup 232, 2024 | New. Cornerstone, Weasis and dcm4che decode it. | rare *(guess)* | R38 (S), R18 (T) | 2 |
| JPEG XL JPEG Recompression | 1.2.840.10008.1.2.4.111 | Sup 232, 2024 | Lossless repacking of baseline JPEG. Archive use. | rare *(guess)* | R38 (S) | 2 |
| JPEG XL | 1.2.840.10008.1.2.4.112 | Sup 232, 2024 | Philips Pathology Scanner SGi (2026) writes it for WSI, with XYB photometric. AWS HealthImaging stores lossy JPEG XL (2026). | rare now; growing in WSI and cloud *(guess)* | R39, R40 (V) | 2 |
| HTJ2K Lossless | 1.2.840.10008.1.2.4.201 | Sup 235, 2023 | Cloud archives and DICOMweb (Google Healthcare API offers it); Cornerstone3D/OHIF, pydicom and OpenJPEG decode it. | rare in files today; growing *(guess)* | R41 (S), R42, R43 (V), R18 (T) | 2 (high priority) |
| HTJ2K Lossless RPCL | 1.2.840.10008.1.2.4.202 | Sup 235, 2023 | AWS HealthImaging stores every lossless import as this. It reaches clients that request the stored syntax. | rare in files today; growing *(guess)* | R42 (V) | 2 (high priority) |
| HTJ2K (lossy allowed) | 1.2.840.10008.1.2.4.203 | Sup 235, 2023 | Same codec family as .201/.202. | rare *(guess)* | R41 (S) | 2 |
| JPIP HTJ2K Referenced | 1.2.840.10008.1.2.4.204 | Sup 235, 2023 | Pixel data is a URL. | extinct *(guess)* | — | 3 |
| JPIP HTJ2K Referenced Deflate | 1.2.840.10008.1.2.4.205 | Sup 235, 2023 | Same as .204. | extinct *(guess)* | — | 3 |
| RLE Lossless | 1.2.840.10008.1.2.5 | 1993–, current | US option on all major vendors (Philips EPIQ, GE LOGIQ with YBR_FULL, Canon Aplio, Siemens SC2000), some NM/SC, Philips IntelliSpace archives (decompressed on media). | occasional *(guess)* | R6, R7, R8, R20, R21 (V), R44 (S) | 1 |
| RFC 2557 MIME encapsulation | 1.2.840.10008.1.2.6.1 | Retired 2018 | Media type for email; not a pixel encoding. | extinct | — | 3 |
| XML Encoding | 1.2.840.10008.1.2.6.2 | Retired 2018 | Same. | extinct | — | 3 |
| SMPTE ST 2110-20 progressive video | 1.2.840.10008.1.2.7.1 | Sup 202, 2020 | Live IP video between OR devices. | not file storage | R45 (S) | 3 |
| SMPTE ST 2110-20 interlaced video | 1.2.840.10008.1.2.7.2 | Sup 202, 2020 | Same as .7.1. | not file storage | R45 (S) | 3 |
| SMPTE ST 2110-30 PCM audio | 1.2.840.10008.1.2.7.3 | Sup 202, 2020 | Audio only. | not file storage | R45 (S) | 3 |
| Papyrus 3 Implicit VR LE | 1.2.840.10008.1.20 | Retired 2015 | Geneva Papyrus 3 files (1990s, OsiriX era). GDCM keeps a sample and the `gdcmpap3` converter. | rare *(guess)* | R23 (T) | 3 |

### Private transfer syntaxes seen in real files

| Item | UID | Era / status | Where seen | Prevalence | Evidence | Tier |
|---|---|---|---|---|---|---|
| GE Implicit VR, big-endian pixel data | 1.2.840.113619.5.2 | 1990s–2000s GE | Older GE CT/MR files. The dataset is implicit LE but Pixel Data is big endian. DCMTK misreads it. | rare *(guess)* | R46 (T), R47 (A) | 2 (cheap: swap pixel bytes) |
| Philips "CT-private-ELE" | 1.3.46.670589.33.1.4.1 | Current Philips CT/MR | Default between Philips CT 7500 nodes. It is not confirmed whether files carrying this UID leave Philips systems; dicom-rs got a report of one. | rare *(guess)* | R12 (V), R48 (A) | 2 if it proves to be Explicit VR LE with a private label; otherwise 3 |
| Sectra private compression (e.g. "Sectra Compression LS") | 1.2.752.24.3.7.7 and others | Current Sectra internal storage | Internal to Sectra. Export to media is not documented to keep it. | rare in exports *(guess)* | R5 (V) | 3 |

## 2. Pixel-level variations independent of transfer syntax

| Item | Era / status | Where seen | Prevalence | Evidence | Tier |
|---|---|---|---|---|---|
| MONOCHROME2 | current | CT, MR, PT, NM, DX, most MG; 99% of IDC instances | common | R1 (M) | 1 |
| MONOCHROME1 | current | CR/DX, some MG, PT displays | common | R1 (M) | 1 |
| RGB (native, PC 0 or 1) | current | US, SC, VL photos, ophthalmology, WSI | common | R1 (M), R7, R20 (V) | 1 |
| PALETTE COLOR (8- or 16-bit LUT, including segmented LUTs) | current | US (older), NM, MR colour maps (72k IDC instances), SC | occasional | R1 (M), R7 (V) | 1 |
| YBR_FULL | current | RLE-compressed US (GE LOGIQ), native US in IDC | occasional | R1 (M), R7 (V), R44 (S) | 1 |
| YBR_FULL_422 (JPEG baseline and, unusually, native) | current | Almost all lossy-JPEG US, echo, WSI and VL. Native 4:2:2 also occurs. | common | R1 (M), R8, R9, R21 (V), R49 (T) | 1 |
| YBR_PARTIAL_420 | current | H.264/MPEG video (Hologic Omni 4K). The browser handles it inside `<video>`. | rare outside video | R34 (V) | 2 (video only) |
| YBR_PARTIAL_422 | retired 2017 | Only a dcm4che2 tool can create it; no vendor reports found. | extinct *(guess)* | R50 (T) | 3, or cheap to add |
| YBR_ICT / YBR_RCT | current | Lossy and lossless J2K (GE LOGIQ, WSI); 16.6k IDC instances | occasional | R1 (M), R7 (V) | 1 (part of J2K) |
| XYB | 2024– | JPEG XL WSI (Philips SGi) | rare | R39 (V) | 2 (with JPEG XL) |
| ARGB, CMYK, HSV | retired | No real files reported; GDCM does not read them. | extinct | R51 (T) | 3 |
| Bits Allocated 1 (packed bitplanes) | current | SEG (199k IDC instances), some overlays | common in SEG; rare in clinical exports | R1 (M) | 1 |
| Bits Allocated 8 | current | US, SC, XA (8-bit), VL, WSI | common | R1 (M) | 1 |
| Bits Allocated 16 with Bits Stored 10/12/13/14/15/16 | current | CT (12/16), MR, CR/DX (10–15), MG (12–14), XA (10/12) | common | R1 (M), R11, R13 (V) | 1 |
| Bits Allocated 32 (integer) | current | RT Dose grids (32-bit unsigned is routine for TPS export) | occasional in RT studies; rare overall | R1 (M), R52 (S) | 1 (cheap) |
| Float Pixel Data (7FE0,0008), 32-bit | 2015– | Parametric maps (dcmqi, research) | rare | R53 (S), R54 (A) | 2 |
| Double Float Pixel Data (7FE0,0009), 64-bit | 2015– | Parametric maps | rare | R53 (S) | 2 |
| Signed pixels (Pixel Representation 1) | current | CT, MR, RT dose (ERROR type); 40% of IDC instances, mostly CT | common | R1 (M) | 1 |
| Planar Configuration 1 (colour-by-plane) | current | Some US and RLE output (RLE is always by segment) | occasional | R1 (M), R55 (A) | 1 |
| Multi-frame | current | US cine, XA, NM, enhanced CT/MR, MG tomo, WSI, SEG | common | R1 (M) | 1 |
| Large tiled WSI (TILED_FULL, thousands of frames, pyramids) | 2017– | Pathology (JPEG baseline, J2K, now JPEG XL) | rare in patient exports today | R39 (V), R22 (X) | 2 (decode tiles; viewer is separate work) |
| Overlays in unused high bits | retired, still in old files | Older MR/CT. Mask to Bits Stored. | occasional in old archives *(guess)* | R56 (S), R57 (A) | 1 (masking) |
| Icon Image Sequence (with GE private-compressed icons) | current | Many vendors | common; ignorable | R46 (T) | 1 (skip the icon) |

## 3. Non-conforming files found in the wild

| Item | Where seen | Prevalence | Evidence | Tier |
|---|---|---|---|---|
| ACR-NEMA 1.0/2.0 files, or DICOM files without preamble and meta header | Siemens GBS/Magnetom, Toshiba, Fuji, Picker, GE DLX, IRAD US (1990s); raw implicit-LE dumps from some tools. The transfer syntax has to be guessed. | rare in current exports; occasional in old archives *(guess)* | R24 (X), R46 (T), R58 (A) | 2 (implicit-LE fallback with a heuristic) |
| Implicit-VR meta header | Older apps following a Part 10 draft (GE DLX) | rare | R24 (X), R46 (T) | 2 |
| Vendor-private compression inside private tags | GE Genesis pack/compress (pre-DICOM files); Elscint/Philips PMSCT_RLE1 (07a1,100a); Elscint Lossless Rice; Hologic DBT Secondary Capture with proprietary payload in (7E01,10xx) | rare overall. Hologic private DBT SC may be occasional in mammography archives from about 2011–2018 *(guess)* | R24 (X), R46 (T), R59, R60 (V/X), R61 (T) | 3, but show the standard centre slice for Hologic SC (it is in Pixel Data) and say the rest is proprietary |
| Philips iSyntax WSI | A Philips proprietary file format, not DICOM | n/a for DICOM | R62 (V) | 3 |
| JPEG stream inconsistent with its header: GE 1990s lossless (bad Huffman selector, inverted difference, wrong row predictor, big-endian items) | GE CT/MR/AW MOD media, 1990s | rare now *(guess)* | R24 (X) | 3 |
| Photometric Interpretation wrong for the JPEG content (YBR label with RGB data, or RGB label with YBR data) | Common in lossy colour JPEG from US and SC; addressed by CP-1262 and CP-1653 | occasional *(guess)* | R63 (A, maintainers), R64 (A), R65 (S) | 1 (follow the JFIF/Adobe markers and component IDs, with a documented rule) |
| DICOM bit depth differs from the JPEG SOF precision | Marconi, Philips Gyroscan, Siemens mosaic | rare | R66 (T) | 1 (trust the SOF) |
| SOF0 used where SOF1 is required | IJG-based encoders | rare | R67 (T) | 1 (accept) |
| 16-bit lossless JPEG with SSSS=16 handled wrongly (Cornell codec); predictor-6 overflow at 16 bits | Old encoders; GE images expect 32768 | rare *(guess)* | R68 (X), R69 (T), R23 (T) | 1: decode SSSS=16 correctly. 3: the broken variants, unless a real file turns up |
| Wrong Bits Stored, values above Bits Stored, J2K sign that disagrees with Pixel Representation | Toshiba J2K (both directions), OsiriX exports, Philips Brilliance | occasional *(guess)* | R57, R70, R71 (A), R46 (T) | 1 (trust the codestream for J2K signedness; mask to Bits Stored for display) |
| Odd-length last fragment, fragment length off by one, garbage terminator | Siemens, GE Signa, old GDCM output | rare | R66 (T) | 1 (tolerate) |
| Truncated or short Pixel Data | Several research sets (LIDC-IDRI), broken CD copies | rare *(guess)* | R72 (A) | 1 (decode what is present and flag the rest) |
| Empty Basic Offset Table with frames split over several fragments | Common and legal; heuristics needed | common | R73 (A/T) | 1 |
| JP2 file wrapper inside a J2K fragment (illegal) | Elscint, Marotech | rare | R74 (T) | 1 (skip the boxes) |
| Wrong Planar Configuration on colour US | Reported in Cornerstone | rare *(guess)* | R55 (A) | 2 |
| Non-DICOM CDs (viewer-only, proprietary formats) | 22% import failure on ED transfer CDs (2011), mostly for this reason | occasional (outside decoder scope) | R75 (peer-reviewed, via news) | out of scope |

## 4. Recommendations

### Tier 1: must decode in Rust
- **Transfer syntaxes:** Implicit LE, Explicit LE, Explicit BE, Deflated Explicit LE, JPEG Baseline (.50), JPEG Extended 8/12-bit (.51), JPEG Lossless (.57, .70), JPEG 2000 (.90, .91), RLE (.5).
  - This is exactly the set that STD-GEN-DVD-JPEG and -J2K, and IHE PDI with the DVD/USB options, oblige a reader to handle [R2, R3, R4].
  - It also covers everything any modality conformance statement we found writes for still images.
- **Pixel variations:**
  - MONOCHROME1/2, RGB, PALETTE COLOR (including segmented LUTs), YBR_FULL, YBR_FULL_422 (native and JPEG), YBR_ICT/RCT
  - Bits Allocated 1, 8, 16 and 32-bit integer, with any Bits Stored, signed or unsigned
  - Planar Configuration 0 and 1; multi-frame
- **Tolerance:** follow every "Tier 1" line in section 3.

### Tier 2: should support
- **JPEG-LS (.80, .81).** Mammography (Hologic) and dcm4chee archives. It has a small spec and CharLS-level complexity. Put it first in tier 2.
- **HTJ2K (.201–.203).** Cloud archives, AWS HealthImaging and Google, are starting to hand it out over DICOMweb. A portal built on them can produce it. It shares most of the J2K Part 1 code.
- **Encapsulated Uncompressed (.1.98) and Deflated Image Frame (.8.1).** These are cheap.
- **JPEG XL (.110–.112) with XYB.** A first vendor (Philips WSI) and AWS have adopted it. It is a large codec; this project decodes it with its own `shl-jpegxl`.
- **Float and Double Float Pixel Data.**
- **GE private big-endian syntax (1.2.840.113619.5.2), and files without a Part 10 header** (implicit-LE guess).
- **Retired progressive and spectral-selection JPEG (.53, .55).** Add only if the chosen JPEG decoder already does progressive Huffman.
- **H.264 (.102–.106 and the .x.1 variants) and HEVC (.107, .108): hand them to the browser.** See below.

### Tier 3: refuse with a message that names the encoding
- **JPEG:** arithmetic-coded processes (.52, .54, .56, .58) and hierarchical processes (.59–.66).
- **JPEG 2000 and JPIP:** J2K Part 2 multi-component (.92, .93); JPIP referenced (.94, .95, .204, .205), which hold no pixels.
- **Video and streaming:** MPEG-2 (.100, .101 and their fragmentable variants); SMPTE ST 2110 (.7.x).
- **Retired and private formats:**
  - RFC 2557, XML and Papyrus
  - vendor-private compression in private tags
  - Sectra internal private syntaxes
  - retired ARGB/CMYK/HSV and YBR_PARTIAL_422
- **For MPEG-2:** the message should say the study contains MPEG-2 video that the browser cannot play.
- **For Hologic private DBT Secondary Capture:** show the standard centre slice and explain that the other slices are in a proprietary format.

### Video: what to leave to the browser
DICOM requires H.264 and HEVC streams to be carried in an MPEG-2 Transport Stream or an MP4 container (PS3.5 §8.2.7, §8.2.8, §8.2.11; R37). MPEG-2 video's container is unconstrained (§8.2.5).

- **H.264, all of .102–.106 and the fragmentable .x.1 variants: leave it to `<video>`.** High Profile up to Level 4.2 plays in Chrome, Edge, Firefox and Safari.
  - **MP4 payload:** concatenate the fragments into a Blob with type `video/mp4`.
  - **MPEG-TS payload:** remux to fragmented MP4. This is a small, pure demux/mux step with no decoding; it can be done in Rust or with mux.js.
  - **Audio:** strip or ignore it if it is LPCM or AC-3. Those are allowed only in TS (§8.2.12), and browsers do not reliably play them.
  - **Stereo (.106) and 3D (.105):** the browser shows one view. Say so in the UI.
- **HEVC (.107, .108): leave it to `<video>` where the platform supports it,** and give a clear refusal elsewhere.
  - Safari supports it.
  - Chrome and Edge 107+ support it with a hardware decoder.
  - Firefox has recent support on Windows, macOS and Linux with VA-API.
  - Main 10 depends on hardware.
  - Detect support with `MediaSource.isTypeSupported` / `canPlayType('video/mp4; codecs="hvc1..."')` before trying.
- **MPEG-2: no browser plays it.** The only options are a WASM decoder (ffmpeg, so not pure Rust) or a server transcode, as Orthanc and OHIF do. Recommend tier 3.
- **Do not write a Rust video decoder.** Nothing in this census needs one.

### Coverage judgement (a reasoned guess, not a measurement)

Unit: clinical studies of the kind a patient brings on a CD or downloads from a portal. A study counts as covered if every image instance in it decodes.

**Reasoning:**
1. **CT, MR, PT, NM, CR, DX and most MG are the large majority of studies by count.** Clinical radiology volume is dominated by radiography, CT, US and MR. MG is a few percent.
   - These modalities write native or tier 1 compressed syntaxes in every conformance statement found [R11, R12, R13, R14, R25].
   - In IDC, the only measured source, 99.99% of instances use tier 1 syntaxes; the only exception is JPEG-LS on 261 SEG instances [R1].
2. **On media, products either burn Explicit LE or pass lossy JPEG/J2K through** [R5, R6]. The DVD and USB profiles that allow compression restrict it to tier 1 syntaxes [R3, R4].
3. **US and echo, roughly 15–25% of studies (my estimate), use JPEG baseline YBR_FULL_422, RLE, J2K or native.** All of those are tier 1.
4. **The gaps for tier 1 alone:**
   - JPEG-LS archives
   - HTJ2K from cloud archives
   - endoscopy and surgical video (mostly not in radiology PACS)
   - Hologic private DBT SC in mammography
   - old ACR-NEMA and GE files
   - float parametric maps
   - Each of these is plausibly in the 0.01–0.5% range of studies, but none is measured.

**Estimates:**
- **Tier 1 alone: roughly 97–99.5% of clinical studies.** The low end allows for archives that store JPEG-LS or HTJ2K, sites whose mammography studies include Hologic private SC (which fails the "every instance" rule even though the other images decode), and video studies.
- **Tiers 1 and 2: roughly 99–99.8%.** What remains is MPEG-2 video, proprietary private payloads and broken legacy files.

**Uncertainty:** these bands are guesses. They rest on conformance statements, which say what devices *can* send, not what sites configure. No published measurement of transfer-syntax mix on patient CDs or in clinical PACS was found (searched: Radiology/AJR CD-import studies, IHE PDI material, migration reports, Clunie's papers).

**How to firm up the numbers:** profile a sample of real patient CDs and portal downloads with `scripts/profile_local.py`. Even 50–100 studies would bound the tier 1 gap better than any desk research. Two specific checks:
- whether any exporters write J2K, JPEG-LS or HTJ2K by default
- how often Hologic private SC appears in mammography exports

## References

Quality codes: M measured, S spec, V vendor, T toolkit, X expert, A anecdotal.

- R1 (M): `profiles-idc.csv` in this directory, NCI Imaging Data Commons, 58.5M instances. Research archive; see `SOURCES.md` for its biases.
- R2 (S): PS3.11 STD-GEN-CD, Table D.3-1 https://dicom.nema.org/medical/dicom/current/output/chtml/part11/sect_D.3.html
- R3 (S): PS3.11 STD-GEN-DVD-JPEG/J2K, Table H.3-1 https://dicom.nema.org/medical/dicom/current/output/chtml/part11/sect_H.3.html
- R4 (S): PS3.11 USB/flash profiles https://dicom.nema.org/medical/dicom/current/output/chtml/part11/sect_J.3.html. IHE RAD TF-2 §4.47.4.1 (PDI): Explicit LE baseline; DVD/USB options allow JPEG lossy, lossless and J2K; no lossy compression "just for the purpose of exchange". https://www.ihe.net/uploadedFiles/Documents/Radiology/IHE_RAD_TF_Vol2.pdf
- R5 (V): Sectra PACS/IDS7 27.1 conformance statement: media export uses Explicit LE, .50, .51, .90; private Sectra compression internally. https://medical.sectra.com/conformance-statement-27-1/
- R6 (V): Philips IntelliSpace Radiology 4.5 conformance statement: lossy JPEG and J2K preserved on media; lossless JPEG, J2K and RLE decompressed to Explicit LE. https://www.documents.philips.com/assets/DICOM%20Conformance%20Statement/20220223/ec71a232364340868ac8ae450112da97.pdf
- R7 (V): GE LOGIQ E conformance statement: None, RLE, JPEG lossy and lossless, J2K, with matching photometric interpretations. http://web.archive.org/web/2024id_/https://www.gehealthcare.com/-/media/b2210e72245e4d4aa95d8d27d31404a9.pdf?la=en-us
- R8 (V): Siemens ACUSON NX2 conformance statement https://marketing.webassets.siemens-healthineers.com/1800000003468945/073d11f4d0f3/ACUSON_NX2_VA10_DICOM_Conformance_Statement.pdf
- R9 (V): Canon Aplio conformance statement https://www.medical.canon/Interoperability/dicom/2G985-040EN.pdf
- R10 (V): Fujifilm Synapse PACS 5.7: media written as STD-GEN-CD only. https://healthcaresolutions-us.fujifilm.com/wp-content/uploads/2023/02/DICOM_Conformance_Statement_5_7_above.pdf
- R11 (V): Philips Azurion R3.1 conformance statement (XA: ILE, ELE, EBE, JPEG Lossless SV1) https://www.documents.philips.com/assets/DICOM%20Conformance%20Statement/20240716/fb35f10fa3d5424ab752b1af00c1d760.pdf
- R12 (V): Philips Spectral CT 7500 conformance statement (default ELE/ILE; private 1.3.46.670589.33.1.4.1) https://www.documents.philips.com/assets/DICOM%20Conformance%20Statement/20231129/cb27c3ed3ba14584a0c9b0c900db5a83.pdf
- R13 (V): Siemens Artis zee VD12 conformance statement https://marketing.webassets.siemens-healthineers.com/e3c20cfae6f192aa/edadc8498200/Artis_zee_zeego_Q_Q.zen_VD12_DICOM_Conformance_Statement.pdf
- R14 (V): Hologic Dimensions v1.12 conformance statement (JPEG Lossless SV1, ELE, ILE, EBE, JPEG-LS, J2K lossless; private DBT encoding) https://hologic.com/sites/default/files/2023-09/Dimensions%20v1.12%20and%203Dimensions%20v2.3%20DICOM%20Conformance%20Statement%20%28RD-04751%29%20English%20Rev_001%2008-2023.pdf
- R15 (S): PS3.5 A.3 (Big Endian retired) https://dicom.nema.org/medical/dicom/current/output/chtml/part05/sect_A.3.html
- R16 (S): PS3.5 A.5 Deflated https://dicom.nema.org/medical/dicom/current/output/chtml/part05/sect_A.5.html
- R17 (S): PS3.5 A.4.11 Encapsulated Uncompressed https://dicom.nema.org/medical/dicom/current/output/chtml/part05/sect_A.4.11.html
- R18 (T): Cornerstone3D `decodeImageFrame.ts` (supported syntaxes, including a pre-standard HTJ2K UID 3.2.840.10008.1.2.4.96) https://github.com/cornerstonejs/cornerstone3D/blob/main/packages/dicomImageLoader/src/imageLoader/decodeImageFrame.ts
- R19 (S): PS3.5 §8.2.16 and A.4.13 Deflated Image Frame; Sup 244 slides https://dicom.nema.org/medical/dicom/current/output/chtml/part05/sect_8.2.16.html , https://dicomstandard.org/news-dir/progress/docs/sups/sup244-slides.pdf
- R20 (V): Philips EPIQ/Affiniti R9 conformance statement (US: ILE, ELE, .50, .70, RLE; cine without lossless JPEG) https://www.documents.philips.com/assets/DICOM%20Conformance%20Statement/20250227/0f8dddbc730e4f0188deb29100e392b8.pdf
- R21 (V): Siemens ACUSON SC2000 conformance statement https://marketing.webassets.siemens-healthineers.com/1800000001972495/15b67df071e9/sc2000_vb10_dcs-01972495_1800000001972495.pdf
- R22 (X): Clunie, FDA WSI talk 2024 ("mostly using baseline JPEG, some JPEG 2000") https://dclunie.com/papers/FDA_WSI_2024_Clunie.pdf ; Clunie, SPIE 2002 compression slides https://www.dclunie.com/papers/spie_mi_2002_compression.pdf
- R23 (T): GDCM test data (gdcmdata) https://github.com/malaterre/gdcmdata ; DCMTK dcmdjpeg man page https://manpages.ubuntu.com/manpages/jammy/man1/dcmdjpeg.1.html
- R24 (X): Clunie, Medical Image Format FAQ parts 2–4 https://ftp.lip6.fr/pub/doc/faqs/medical-image-faq/part2 , https://ftp.lip6.fr/pub/doc/faqs/medical-image-faq/part3 , https://ftp.lip6.fr/pub/doc/faqs/medical-image-faq/part4
- R25 (V): Canon Aquilion Start conformance statement https://www.medical.canon/Interoperability/dicom/2G985-053EN.pdf
- R26 (V): Philips Media Center R2.3 (burner) conformance statement https://www.documents.philips.com/assets/DICOM%20Conformance%20Statement/20220223/7f8e1e5670924928bcf3ae450113e16a.pdf
- R27 (V): dcm4chee-arc compression rules wiki https://github.com/dcm4che/dcm4chee-arc-light/wiki/Compression-of-received-images/Database-Schema
- R28 (X): Clunie, RSNA 2012 abstract on tomosynthesis compression https://archive.rsna.org/2012/12037671.html
- R29 (V): Fujifilm Synapse VNA 7 conformance statement https://healthcaresolutions-us.fujifilm.com/wp-content/uploads/2023/02/Synapse_VNA-Version_7_X_DICOM_Conformance.pdf
- R30 (V): Zeiss CIRRUS HD-OCT conformance statement https://aao.org/Assets/fb766ea1-7a4f-4389-9b87-81471b4d9434/637982426733130000/cirrus-hd-oct-6000-5000-500-dicom-conformance-statement-pdf
- R31 (A): ITK forum on J2K Part 2 https://discourse.itk.org/t/jpeg-2000-part-2-and-multicomponent-images/3994
- R32 (S): PS3.5 A.6 JPIP https://dicom.nema.org/medical/dicom/current/output/chtml/part05/sect_A.6.html
- R33 (V): Karl Storz SCENARA .media v3 conformance statement (MPEG-2 .100, H.264 .102) https://www.karlstorz.com/cps/rde/xbcr/karlstorz_assets/ASSETS/3634945.pdf
- R34 (V): Hologic Omni 4K DICOM guide (.102, YBR_PARTIAL_420) https://hologic.com/sites/default/files/2021-04/720-00042%20Rev%20A%20User%20Guide%2C%20DICOM%2C%20Omni%204K%20Video%20System.pdf
- R35 (A): OHIF community thread on video syntaxes https://community.ohif.org/t/support-for-1-2-840-10008-5-1-4-1-1-77-1-4-1-video-photographic-image-storage/253 ; Orthanc video FAQ (MPEG-2 unplayable in browsers) https://orthanc.uclouvain.be/book/faq/video.html ; Cornerstone video tutorial https://www.cornerstonejs.org/docs/tutorials/basic-video
- R36 (V): Novanta Evolution4K conformance statement https://novanta.com/advanced-surgery/wp-content/uploads/sites/11/2025/12/5020-19-F05-Rev3.0_Evolution4K-DICOM-Conformance-Statement.pdf
- R37 (S): PS3.5 §8.2.5, §8.2.7, §8.2.11 and §8.2.12 (video containers, audio) https://dicom.nema.org/medical/dicom/current/output/chtml/part05/sect_8.2.7.html , https://dicom.nema.org/medical/dicom/current/output/chtml/part05/sect_8.2.11.html
- R38 (S): PS3.5 §8.2.15 JPEG XL https://dicom.nema.org/medical/dicom/current/output/chtml/part05/sect_8.2.15.html
- R39 (V): Philips Pathology Scanner SGi 1.0 conformance statement (JPEG baseline and JPEG XL only, XYB, TILED_FULL) https://www.documents.philips.com/assets/DICOM%20Conformance%20Statement/20260428/2e216ab9b90d4f19984cb43a009f25d0.pdf
- R40 (V): AWS HealthImaging JPEG XL announcement https://aws.amazon.com/about-aws/whats-new/2026/01/aws-healthimaging-adds-jpeg-xl
- R41 (S): Supplement 235 HTJ2K https://www.dicomstandard.org/News-dir/ftsup/docs/sups/sup235.pdf
- R42 (V): AWS HealthImaging supported transfer syntaxes https://docs.aws.amazon.com/healthimaging/latest/devguide/supported-transfer-syntaxes.html
- R43 (V): Google Cloud Healthcare API DICOM conformance https://docs.cloud.google.com/healthcare-api/docs/dicom
- R44 (S): CP-1678 (YBR_FULL historically used with RLE for US) https://dicom.nema.org/medical/dicom/CP/cp1678_lb_YBR_FULL_JPEG_not_RLE.pdf
- R45 (S): Sup 202 real-time video https://www.dicomstandard.org/news/supplements/view/realtime-video
- R46 (T): GDCM broken-image index https://github.com/malaterre/GDCM/blob/master/Testing/Source/Data/gdcmMD5DataBrokenImages.cxx and gdcmdata (as R23)
- R47 (A): DCMTK ticket on the GE private syntax https://support.dcmtk.org/redmine/issues/686
- R48 (A): dicom-rs issue on the Philips private syntax https://github.com/Enet4/dicom-rs/issues/175
- R49 (T): highdicom issue on native YBR_FULL_422 https://github.com/ImagingDataCommons/highdicom/issues/235
- R50 (T): dcm4che2 rgb2ybr https://dcm4che.atlassian.net/wiki/display/d2/rgb2ybr
- R51 (T): GDCM conformance summary https://www.creatis.insa-lyon.fr/software/public/Gdcm/ConformanceSummary.html
- R52 (S): PS3.3 C.8.8.3 RT Dose https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.8.8.3.html
- R53 (S): PS3.3 C.8.32.2 Parametric Map https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.8.32.2.html
- R54 (A): Slicer forum on float pixel data https://discourse.slicer.org/t/conversion-of-fa-fractional-anisotropy-map-to-dicom-failing/33294
- R55 (A): Cornerstone3D issue 792 (US colour and planar configuration) https://github.com/cornerstonejs/cornerstone3D/issues/792
- R56 (S): PS3.5 chapter 8 (overlays in high bits retired) https://dicom.nema.org/medical/dicom/current/output/chtml/part05/chapter_8.html
- R57 (A): pydicom issue 2260 https://github.com/pydicom/pydicom/issues/2260 ; pydicom decoder options https://pydicom.github.io/pydicom/stable/guides/decoding/decoder_options.html
- R58 (A): pydicom issue 1661 https://github.com/pydicom/pydicom/issues/1661
- R59 (V): Hologic AWM conformance statement https://hologic.com/sites/default/files/awm_1.6_dicom_conformance_statement_man-02949_english_03_12_0.pdf
- R60 (X): Clunie, UPMC tomosynthesis collection https://dclunie.com/pixelmedimagearchive/upmcdigitalmammotomocollection/index.html
- R61 (T): Orthanc PMSCT_RLE1 decoder https://orthanc.uclouvain.be/hg/orthanc/rev/dbd74fa2f446 ; dcmlib post on Elscint Rice https://www.creatis.insa-lyon.fr/pipermail/dcmlib/2005-December/002400.html
- R62 (V): Philips iSyntax SDK https://www.philips.co.uk/healthcare/sites/pathology/about/sdk
- R63 (A): pydicom PR 878 https://github.com/pydicom/pydicom/pull/878
- R64 (A): dcm4che issue 543 https://github.com/dcm4che/dcm4che/issues/543
- R65 (S): CP-1262 https://dicom.nema.org/medical/dicom/CP/cp1262_vp.pdf ; CP-1653 https://dicom.nema.org/medical/dicom/CP/cp1653_04_PhotometricInterpretations.pdf
- R66 (T): GDCM `gdcmJPEGCodec.cxx` https://github.com/malaterre/GDCM/blob/master/Source/MediaStorageAndFileFormat/gdcmJPEGCodec.cxx
- R67 (T): DCMTK issue 620 https://support.dcmtk.org/redmine/issues/620
- R68 (X): comp.protocols.dicom, "Huffman code length 16 in lossless JPEG" (read from search snippets only) https://groups.google.com/g/comp.protocols.dicom/c/Yl5GkZ8ggOE
- R69 (T): GDCM patched libjpeg `jdlhuff.c` (SSSS=16 special case), in the GDCM repository under Utilities/gdcmjpeg
- R70 (A): pydicom issue 1149 https://github.com/pydicom/pydicom/issues/1149
- R71 (A): fo-dicom issue 738 https://github.com/fo-dicom/fo-dicom/issues/738
- R72 (A): pydicom issue 1188 https://github.com/pydicom/pydicom/issues/1188
- R73 (A/T): DCMTK forum https://forum.dcmtk.org/viewtopic.php?p=19259 ; Orthanc DicomFrameIndex.cpp https://orthanc.uclouvain.be/hg/orthanc/file/Orthanc-1.13.0/OrthancFramework/Sources/DicomParsing/Internals/DicomFrameIndex.cpp
- R74 (T): GDCM `gdcmJPEG2000Codec.cxx` https://github.com/malaterre/GDCM/blob/master/Source/MediaStorageAndFileFormat/gdcmJPEG2000Codec.cxx ; PS3.5 A.4.4 https://dicom.nema.org/medical/dicom/current/output/chtml/part05/sect_A.4.4.html
- R75 (peer-reviewed, read in secondary coverage): Sodickson et al., Radiology 2011, CD import for ED transfers https://www.auntminnie.com/imaging-informatics/enterprise-imaging/pacs-vna/article/15589342/dicom-cd-import-for-er-patients-enhances-utilization ; Clunie RSNA 2010 PDI slides https://dclunie.com/papers/rsna2010_pdi_clunie.pdf
