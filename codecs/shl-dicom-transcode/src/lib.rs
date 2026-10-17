//! Lossless re-encoding of uncompressed DICOM files, as either
//! - JPEG Lossless, Non-Hierarchical, First-Order Prediction (Process 14, Selection Value 1;
//!   1.2.840.10008.1.2.4.70), the lossless syntax every reader of the PS3.11 compressed-media
//!   profiles must decode; or
//! - JPEG 2000 Lossless (1.2.840.10008.1.2.4.90): smaller, slower to write
//!   (`shl-codec-jpeg2000-encode`).
//!
//! [`transcode_part10`] takes a Part 10 file and a target transfer syntax
//! ([`SUPPORTED_TRANSFER_SYNTAXES`]) and returns the re-encoded file, or [`Declined`] with the
//! reason; a caller that gets `Declined` keeps the input as it is. What changes:
//! - the file meta: Transfer Syntax UID, Implementation Class UID ([`IMPLEMENTATION_CLASS_UID`])
//!   and Implementation Version Name ([`IMPLEMENTATION_VERSION_NAME`] or
//!   [`IMPLEMENTATION_VERSION_NAME_J2K`], naming the codec), and its group length;
//! - Pixel Data, now encapsulated: one fragment per frame and a filled Basic Offset Table (an
//!   Extended Offset Table instead if an offset would pass 4 GiB);
//! - Planar Configuration becomes 0, which PS3.5 8.2.1 requires for JPEG: changed from 1, or added
//!   when it was missing on colour data and the decoder settled the layout from the pixels;
//! - an Implicit VR Little Endian data set is written as Explicit VR Little Endian, with VRs from
//!   the PS3.6 dictionary (UN for unknown private elements), and any group length elements are
//!   recomputed.
//!
//! Every other value keeps its bytes, and the SOP Instance UID stays (PS3.4 allows that for a
//! lossless transfer syntax change). Two checks run on every result before it is returned, and a
//! failure of either declines: the output decodes with this repository's decoder to exactly the
//! input's canonical pixels, and re-reading the output gives every non-pixel value byte for byte.
//!
//! Declined: data sets in Big Endian or deflated, already encapsulated pixel data, Float and
//! Double Float Pixel Data, Bits Allocated 1 or 32 (JPEG 2000 could cover 32-bit RT Dose later; the
//! encoder here stops at 16 bits), overlays kept in the pixel data's high bits, photometric
//! interpretations other than MONOCHROME1/2, PALETTE COLOR and RGB (YBR_FULL keeps its samples,
//! but dcmdjpeg converts YCbCr lossless JPEG to RGB by default with integer arithmetic that differs
//! from the standard conversion; YBR_FULL_422 would need subsampled components), attributes the
//! decoder had to infer other than Planar Configuration, and results that are not smaller.
//!
//! The output depends only on the input: Huffman tables and JPEG 2000 coding come from the image
//! alone, with fixed tie-breaking; threads (outside wasm) split independent work and do not change
//! the bytes; nothing reads a clock or a random source.
#![forbid(unsafe_code)]

mod dict;
mod ds;

use std::fmt;

use ds::{Elem, Reader, Value, Writer, PIXEL_DATA};

/// Transfer syntax of the output.
pub use shl_dicom_decode::syntax::JPEG_LOSSLESS_SV1;
/// (0002,0012) of a file this crate wrote: shlink-dicom's, so a recipient can tell the file was
/// re-encoded by its packer.
pub const IMPLEMENTATION_CLASS_UID: &str = "2.25.222098624467184222580709298353105703221";
/// (0002,0013) of a file this crate re-encoded as JPEG Lossless SV1.
pub const IMPLEMENTATION_VERSION_NAME: &str = "SHLDICOM_SV1_1";
/// JPEG 2000 Image Compression (Lossless Only).
pub use shl_dicom_decode::syntax::JPEG_2000_LOSSLESS;
/// (0002,0013) of a file this crate re-encoded as JPEG 2000 Lossless.
pub const IMPLEMENTATION_VERSION_NAME_J2K: &str = "SHLDICOM_J2K_1";
/// The transfer syntaxes [`transcode_part10`] writes.
pub const SUPPORTED_TRANSFER_SYNTAXES: [&str; 2] = [JPEG_LOSSLESS_SV1, JPEG_2000_LOSSLESS];

use shl_dicom_decode::syntax::{DEFLATED_LE, EXPLICIT_BE, EXPLICIT_LE, IMPLICIT_LE};

/// SOP Class UIDs without pixel data to re-encode (one ending in "." is a prefix): SR (including
/// KO), encapsulated documents (PDF, CDA), presentation states, waveforms, Raw Data, spatial
/// registration and fiducials, surface segmentation, tractography results, RT structure sets,
/// treatment records and plans.
const NO_PIXEL_DATA: [&str; 14] = [
    "1.2.840.10008.5.1.4.1.1.88.",
    "1.2.840.10008.5.1.4.1.1.104.",
    "1.2.840.10008.5.1.4.1.1.11.",
    "1.2.840.10008.5.1.4.1.1.9.",
    "1.2.840.10008.5.1.4.1.1.66",
    "1.2.840.10008.5.1.4.1.1.66.1",
    "1.2.840.10008.5.1.4.1.1.66.2",
    "1.2.840.10008.5.1.4.1.1.66.3",
    "1.2.840.10008.5.1.4.1.1.66.5",
    "1.2.840.10008.5.1.4.1.1.66.6",
    "1.2.840.10008.5.1.4.1.1.481.3",
    "1.2.840.10008.5.1.4.1.1.481.4",
    "1.2.840.10008.5.1.4.1.1.481.5",
    "1.2.840.10008.5.1.4.1.1.481.8",
];

/// Image SOP classes kept as they are. Segmentation and Label Map Segmentation: receivers that
/// read them as segmentations (dcmqi and 3D Slicer, DCMTK's dcmseg) accept only uncompressed or
/// RLE data, not JPEG Lossless or JPEG 2000. Height Map Segmentation: its pixel data is Float
/// Pixel Data, which is native only (PS3.5 8.2).
const KEPT_NATIVE: [&str; 3] = [
    "1.2.840.10008.5.1.4.1.1.66.4",
    "1.2.840.10008.5.1.4.1.1.66.7",
    "1.2.840.10008.5.1.4.1.1.66.8",
];

/// Instances larger than this are kept as they are (encoding one takes about 3–4 times its size
/// in memory).
pub const MAX_INSTANCE_BYTES: u64 = 256 << 20;

/// Whether a packer should offer an instance to [`transcode_part10`]: uncompressed (implicit or
/// explicit VR little endian), of a SOP class that has pixel data, and at most
/// [`MAX_INSTANCE_BYTES`]. The Share page (through shl-dicom-wasm) and the server's seed use this
/// one rule; the encoder still declines what it cannot take.
pub fn is_uncompressed_image(transfer_syntax: &str, sop_class_uid: &str, len: u64) -> bool {
    matches!(transfer_syntax, IMPLICIT_LE | EXPLICIT_LE)
        && !NO_PIXEL_DATA.iter().any(|p| if p.ends_with('.') { sop_class_uid.starts_with(p) } else { sop_class_uid == *p })
        && !KEPT_NATIVE.contains(&sop_class_uid)
        && len <= MAX_INSTANCE_BYTES
}

/// Why a file was left as it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Declined(pub String);

impl fmt::Display for Declined {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Declined {}

/// Sizes of one call.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    pub input_bytes: usize,
    /// The output file, or the input's size when declined.
    pub output_bytes: usize,
    /// The native Pixel Data value.
    pub pixel_bytes_in: usize,
    /// The encapsulated Pixel Data value (items included); 0 when declined before encoding.
    pub pixel_bytes_out: usize,
    pub frames: u32,
}

fn no(m: impl Into<String>) -> Declined {
    Declined(m.into())
}

/// Re-encode a Part 10 file under `ts_uid`, losslessly. Supported: JPEG Lossless SV1
/// ([`JPEG_LOSSLESS_SV1`]). See the crate documentation.
pub fn transcode_part10(input: &[u8], ts_uid: &str) -> Result<Vec<u8>, Declined> {
    transcode_part10_report(input, ts_uid).0
}

/// [`transcode_part10`] with the sizes involved.
pub fn transcode_part10_report(input: &[u8], ts_uid: &str) -> (Result<Vec<u8>, Declined>, Report) {
    let mut report = Report { input_bytes: input.len(), output_bytes: input.len(), ..Report::default() };
    let r = match ts_uid {
        JPEG_LOSSLESS_SV1 | JPEG_2000_LOSSLESS => transcode(input, ts_uid, &mut report),
        other => Err(no(format!("transfer syntax {other} is not one this encoder writes"))),
    };
    if let Ok(out) = &r {
        report.output_bytes = out.len();
    }
    (r, report)
}

/// [`transcode_part10`] to JPEG Lossless SV1.
pub fn transcode_part10_sv1(input: &[u8]) -> Result<Vec<u8>, Declined> {
    transcode_part10(input, JPEG_LOSSLESS_SV1)
}

/// [`transcode_part10_report`] to JPEG Lossless SV1.
pub fn transcode_part10_sv1_report(input: &[u8]) -> (Result<Vec<u8>, Declined>, Report) {
    transcode_part10_report(input, JPEG_LOSSLESS_SV1)
}

/// Tag -> VRs from the PS3.6 dictionary (`dict.rs`); None for a tag it does not list.
pub(crate) fn vrs_of(tag: u32) -> Option<&'static [[u8; 2]]> {
    if let Ok(k) = dict::EXACT.binary_search_by_key(&tag, |e| e.0) {
        return Some(dict::EXACT[k].1);
    }
    dict::MASKED.iter().find(|(mask, value, _)| tag & mask == *value).map(|e| e.2)
}

struct Meta<'a> {
    /// Bytes before the first meta element (a preamble and `DICM`, or only `DICM`).
    lead: &'a [u8],
    elems: Vec<(u16, [u8; 2], &'a [u8])>,
    ts: String,
    /// Where the data set starts.
    end: usize,
}

fn text(v: &[u8]) -> String {
    String::from_utf8_lossy(v).trim_matches(|c: char| c == '\0' || c.is_whitespace()).to_string()
}

/// The group 0002 file meta, Explicit VR Little Endian as PS3.10 requires.
fn read_meta(b: &[u8]) -> Result<Meta<'_>, Declined> {
    let start = if b.get(128..132) == Some(b"DICM") {
        132
    } else if b.get(..4) == Some(b"DICM") {
        4
    } else {
        return Err(no("not a Part 10 file (no DICM prefix)"));
    };
    let mut pos = start;
    let mut elems = Vec::new();
    let mut ts = None;
    while b.get(pos..pos + 2) == Some(&[0x02, 0x00]) {
        let element = b.get(pos + 2..pos + 4).map(|s| u16::from_le_bytes([s[0], s[1]])).ok_or_else(|| no("truncated meta"))?;
        let vr: [u8; 2] = b.get(pos + 4..pos + 6).and_then(|s| s.try_into().ok()).ok_or_else(|| no("truncated meta"))?;
        if !vr.iter().all(u8::is_ascii_uppercase) {
            return Err(no("the file meta is not Explicit VR"));
        }
        let long = matches!(&vr, b"OB" | b"UN" | b"UT" | b"SQ" | b"OW" | b"UR" | b"UC");
        let (len, vstart) = if long {
            (b.get(pos + 8..pos + 12).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as usize), pos + 12)
        } else {
            (b.get(pos + 6..pos + 8).map(|s| usize::from(u16::from_le_bytes([s[0], s[1]]))), pos + 8)
        };
        let len = len.ok_or_else(|| no("truncated meta"))?;
        let v = b.get(vstart..vstart + len).ok_or_else(|| no("truncated meta"))?;
        if element == 0x0010 {
            ts = Some(text(v));
        }
        if elems.last().is_some_and(|e: &(u16, [u8; 2], &[u8])| e.0 >= element) {
            // Readers end the meta at such an element and disagree on what follows.
            return Err(no(format!("file meta element (0002,{element:04X}) is repeated or out of order")));
        }
        elems.push((element, vr, v));
        pos = vstart + len;
    }
    let ts = ts.ok_or_else(|| no("the file meta has no Transfer Syntax UID"))?;
    Ok(Meta { lead: &b[..start], elems, ts, end: pos })
}

/// The new file meta: the input's elements with the transfer syntax and implementation set to
/// this writer's, and the group length recomputed.
fn write_meta(out: &mut Vec<u8>, meta: &Meta<'_>, ts: &str, version_name: &str) {
    let ui = |s: &str| {
        let mut v = s.as_bytes().to_vec();
        if v.len() % 2 == 1 {
            v.push(0);
        }
        v
    };
    let name = {
        let mut v = version_name.as_bytes().to_vec();
        if v.len() % 2 == 1 {
            v.push(b' ');
        }
        v
    };
    let mut elems: Vec<(u16, [u8; 2], Vec<u8>)> =
        meta.elems.iter().filter(|e| !matches!(e.0, 0x0000 | 0x0010 | 0x0012 | 0x0013)).map(|e| (e.0, e.1, e.2.to_vec())).collect();
    elems.push((0x0010, *b"UI", ui(ts)));
    elems.push((0x0012, *b"UI", ui(IMPLEMENTATION_CLASS_UID)));
    elems.push((0x0013, *b"SH", name));
    elems.sort_by_key(|e| e.0);
    let mut body = Vec::new();
    for (element, vr, v) in &elems {
        body.extend_from_slice(&[0x02, 0x00]);
        body.extend_from_slice(&element.to_le_bytes());
        body.extend_from_slice(vr);
        if matches!(vr, b"OB" | b"UN" | b"UT" | b"SQ" | b"OW" | b"UR" | b"UC") {
            body.extend_from_slice(&[0, 0]);
            body.extend_from_slice(&(v.len() as u32).to_le_bytes());
        } else {
            body.extend_from_slice(&(v.len() as u16).to_le_bytes());
        }
        body.extend_from_slice(v);
    }
    if meta.lead.len() == 132 {
        out.extend_from_slice(meta.lead);
    } else {
        out.extend_from_slice(&[0u8; 128]);
        out.extend_from_slice(b"DICM");
    }
    out.extend_from_slice(&[0x02, 0x00, 0x00, 0x00, b'U', b'L', 4, 0]);
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
}

fn find<'e, 'a>(elems: &'e [Elem<'a>], tag: u32) -> Option<&'e Elem<'a>> {
    elems.iter().find(|e| e.tag == tag)
}

fn bytes_of<'a>(elems: &[Elem<'a>], tag: u32) -> Option<&'a [u8]> {
    match find(elems, tag).map(|e| &e.value) {
        Some(Value::Bytes(v)) => Some(v),
        _ => None,
    }
}

/// Whether the input to the VOI LUT can be negative, which decides the VR of a VOI LUT
/// Sequence's LUT Descriptor (PS3.3 C.11.2.1.1: SS when the output of the Rescale or Modality LUT
/// may be signed). A Modality LUT gives unsigned values; a rescale is applied to the stored range
/// (Bits Stored, Pixel Representation); with neither, the stored values themselves. Declines when
/// a VOI LUT is present and the rescale cannot be read.
fn voi_input_signed(elems: &[Elem<'_>], pixel_signed: bool, bits_stored: u32) -> Result<bool, Declined> {
    if find(elems, 0x0028_3010).is_none() {
        return Ok(pixel_signed);
    }
    if find(elems, 0x0028_3000).is_some() {
        return Ok(false);
    }
    let ds = |tag: u32| -> Result<Option<f64>, Declined> {
        let Some(v) = bytes_of(elems, tag) else { return Ok(None) };
        let t = text(v);
        let first = t.split('\\').next().unwrap_or("").trim();
        if first.is_empty() {
            return Ok(None);
        }
        first.parse::<f64>().map(Some).map_err(|_| no(format!("VOI LUT: rescale value {t:?} unreadable, so its LUT Descriptor's VR is unknown")))
    };
    let (Some(intercept), slope) = (ds(0x0028_1052)?, ds(0x0028_1053)?.unwrap_or(1.0)) else {
        return Ok(pixel_signed);
    };
    let bits = bits_stored.clamp(1, 32) as i32;
    let (lo, hi) = if pixel_signed { (-(2f64.powi(bits - 1)), 2f64.powi(bits - 1) - 1.0) } else { (0.0, 2f64.powi(bits) - 1.0) };
    Ok((lo * slope).min(hi * slope) + intercept < 0.0)
}

fn us(elems: &[Elem<'_>], tag: u32) -> Option<u16> {
    bytes_of(elems, tag).and_then(|v| v.get(..2)).map(|s| u16::from_le_bytes([s[0], s[1]]))
}

/// An input that passed every rule: its file meta, data set and canonical pixels.
struct Prepared<'a> {
    meta: Meta<'a>,
    explicit: bool,
    /// The data set bytes after the file meta.
    ds: &'a [u8],
    elems: Vec<Elem<'a>>,
    pixel_len: usize,
    /// The first frame's canonical pixels and attributes; `first.total_frames` frames in all.
    first: shl_dicom_decode::Canonical,
}

/// The codecs the self-check needs (the syntaxes written here), so a build of this crate
/// carries no other codec.
fn codecs(ts: &str) -> Option<shl_codec_common::DecodeFn> {
    match ts {
        JPEG_LOSSLESS_SV1 => Some(shl_codec_jpeg::decode_frame as shl_codec_common::DecodeFn),
        JPEG_2000_LOSSLESS => Some(shl_codec_jpeg2000::decode_frame as shl_codec_common::DecodeFn),
        _ => None,
    }
}

/// Frames `first..first + count` with our decoder: only those frames are decoded (and for
/// native data only their bytes copied), so memory follows the range, not the file.
fn decode_range(bytes: &[u8], first: usize, count: usize) -> Result<shl_dicom_decode::Canonical, shl_dicom_decode::Error> {
    shl_dicom_decode::decode_frames_with(bytes, first, count, codecs)
}

/// Frames decoded together in the encode and in the self-check: enough to keep per-call work
/// low, few enough to keep memory near one frame.
fn frames_per_chunk(frame_bytes: usize) -> usize {
    (4 << 20) / frame_bytes.max(1)
}

/// Read the input and apply the rules every encoding shares.
fn prepare(input: &[u8]) -> Result<Prepared<'_>, Declined> {
    let meta = read_meta(input)?;
    let explicit = match meta.ts.as_str() {
        EXPLICIT_LE => true,
        IMPLICIT_LE => false,
        EXPLICIT_BE => return Err(no("Explicit VR Big Endian data set")),
        DEFLATED_LE => return Err(no("deflated data set")),
        ts => return Err(no(format!("not uncompressed: transfer syntax {ts}"))),
    };
    let ds = &input[meta.end..];
    let (elems, _) = Reader { buf: ds, explicit }
        .elems(0, ds.len(), false, 0)
        .map_err(|e| no(format!("data set not readable: {e}")))?;
    if elems.iter().any(|e| matches!(e.tag, 0x7FE0_0008 | 0x7FE0_0009)) {
        return Err(no("Float or Double Float Pixel Data"));
    }
    let Some(pixel) = find(&elems, PIXEL_DATA) else {
        return Err(no("no Pixel Data"));
    };
    let pixel_len = match &pixel.value {
        Value::Bytes(v) => v.len(),
        _ => return Err(no("Pixel Data is not native")),
    };
    let photometric = bytes_of(&elems, 0x0028_0004).map(text).unwrap_or_default();
    // YBR_FULL is declined: the samples survive, but dcmdjpeg converts YCbCr lossless JPEG to RGB
    // by default with IJG's integer arithmetic, which differs from the standard conversion
    // (±1 on some pixels), so a dcmtk reader would not get the original image back.
    if !matches!(photometric.as_str(), "MONOCHROME1" | "MONOCHROME2" | "PALETTE COLOR" | "RGB") {
        return Err(no(format!("photometric interpretation {photometric:?} is not encoded (MONOCHROME1/2, PALETTE COLOR and RGB are)")));
    }
    // Overlays kept in the pixel data's unused high bits (60xx,0010 without 60xx,3000).
    for e in &elems {
        let (g, el) = ((e.tag >> 16) as u16, e.tag as u16);
        if (0x6000..=0x601E).contains(&g) && g % 2 == 0 && el == 0x0010 && find(&elems, (u32::from(g) << 16) | 0x3000).is_none() {
            return Err(no(format!("overlay group {g:04X} is stored in the pixel data's high bits")));
        }
    }
    // The first frame's canonical pixels and attributes. Frames are decoded in ranges later, so
    // the whole image is never held decoded.
    let before = decode_range(input, 0, 1).map_err(|e| no(format!("input does not decode: {e}")))?;
    // A missing Planar Configuration the decoder settled from the pixels is fine: the output
    // states it (0, as JPEG requires) and the pixel self-check guards the reading.
    let unsettled: Vec<_> = before.inferred.iter().filter(|i| i.attribute != "PlanarConfiguration").collect();
    if !unsettled.is_empty() {
        let what: Vec<String> = unsettled.iter().map(|i| format!("{} ({})", i.attribute, i.reason)).collect();
        return Err(no(format!("the decoder had to infer {}", what.join("; "))));
    }
    if before.float {
        return Err(no("Float or Double Float Pixel Data"));
    }
    if !matches!(before.bits_allocated, 8 | 16) {
        return Err(no(format!("Bits Allocated {} (8 and 16 are encoded)", before.bits_allocated)));
    }
    if before.bits_stored > 16 || before.bits_stored == 0 {
        return Err(no(format!("Bits Stored {}", before.bits_stored)));
    }
    if !matches!(before.samples_per_pixel, 1 | 3) {
        return Err(no(format!("Samples per Pixel {}", before.samples_per_pixel)));
    }
    if before.photometric != photometric {
        return Err(no(format!("{photometric} decodes as {}", before.photometric)));
    }
    Ok(Prepared { meta, explicit, ds, elems, pixel_len, first: before })
}

/// Transfer syntaxes this crate writes, with the Implementation Version Name each gets.
fn version_name(ts: &str) -> Option<&'static str> {
    match ts {
        JPEG_LOSSLESS_SV1 => Some(IMPLEMENTATION_VERSION_NAME),
        JPEG_2000_LOSSLESS => Some(IMPLEMENTATION_VERSION_NAME_J2K),
        _ => None,
    }
}

fn transcode(input: &[u8], ts: &str, report: &mut Report) -> Result<Vec<u8>, Declined> {
    let p = prepare(input)?;
    report.pixel_bytes_in = p.pixel_len;
    report.frames = p.first.total_frames;
    let fragments = encode_frames(input, &p.first, ts)?;
    wrap(input, p, ts, fragments, report)
}

/// The JPEG precision for canonical samples: Bits Stored, but at least 2, and at least 9 in a
/// 16-bit container, since readers size their output by the precision.
fn precision(b: &shl_dicom_decode::Canonical) -> u8 {
    b.bits_stored.max(if b.bits_allocated == 16 { 9 } else { 2 }) as u8
}

/// One frame's codestream from its canonical bytes (`b` describes the image).
fn encode_frame(frame: &[u8], b: &shl_dicom_decode::Canonical, ts: &str) -> Result<Vec<u8>, Declined> {
    let precision = precision(b);
    let mask = ((1u32 << precision) - 1) as u16;
    let bps = b.bytes_per_sample();
    if ts == JPEG_2000_LOSSLESS {
        // JPEG 2000 takes the values: unsigned below 2^P, signed sign-extended.
        let samples: Vec<i32> = match (bps, b.signed) {
            (1, false) => frame.iter().map(|&v| i32::from(v) & i32::from(mask)).collect(),
            (1, true) => frame.iter().map(|&v| i32::from(v as i8)).collect(),
            (_, false) => frame.chunks_exact(2).map(|v| i32::from(u16::from_le_bytes([v[0], v[1]]) & mask)).collect(),
            (_, true) => frame.chunks_exact(2).map(|v| i32::from(i16::from_le_bytes([v[0], v[1]]))).collect(),
        };
        return shl_codec_jpeg2000_encode::encode_lossless(&samples, b.columns, b.rows, b.samples_per_pixel, precision, b.signed)
            .map_err(|e| no(format!("encoder: {e}")));
    }
    shl_codec_jpeg::encode_lossless_sv1_le(frame, bps, b.columns, b.rows, b.samples_per_pixel as u8, precision)
        .map_err(|e| no(format!("encoder: {e}")))
}

/// One codestream per frame of `input`, decoding frames a chunk at a time. Outside wasm, chunks of
/// a large multi-frame image go to several threads; the codestreams are the same either way.
fn encode_frames(input: &[u8], first: &shl_dicom_decode::Canonical, ts: &str) -> Result<Vec<Vec<u8>>, Declined> {
    let frames = first.total_frames as usize;
    let frame_bytes = first.data.len();
    let per = frames_per_chunk(frame_bytes).clamp(1, frames.max(1));
    let starts: Vec<usize> = (0..frames).step_by(per).collect();
    let run = |start: usize| -> Result<Vec<Vec<u8>>, Declined> {
        let n = per.min(frames - start);
        let c = if start == 0 && n == 1 {
            None
        } else {
            Some(decode_range(input, start, n).map_err(|e| no(format!("input does not decode: {e}")))?)
        };
        let data = c.as_ref().map_or(&first.data, |c| &c.data);
        data.chunks_exact(frame_bytes.max(1)).take(n).map(|f| encode_frame(f, first, ts)).collect()
    };
    let parts = map_parallel(&starts, frames * frame_bytes, run);
    let mut out = Vec::with_capacity(frames);
    for part in parts {
        out.extend(part?);
    }
    if out.len() != frames {
        return Err(no("decoded pixel data does not hold every frame"));
    }
    Ok(out)
}

/// `f` over `items`, in order; outside wasm on up to 8 threads, one per 4 MiB of input.
fn map_parallel<T: Sync + Copy, R: Send>(items: &[T], bytes: usize, f: impl Fn(T) -> R + Sync) -> Vec<R> {
    let threads = shl_codec_common::parallel::threads(items.len().min(bytes / (4 << 20)));
    shl_codec_common::parallel::map_chunks(items, threads, || (), |_, &t| f(t))
}

/// Benchmark builds only (`--features bench`): the stages of a transcode, timed separately.
#[cfg(feature = "bench")]
#[doc(hidden)]
pub mod bench {
    use super::*;

    /// An input's canonical pixels, decoded once.
    pub struct Frames(shl_dicom_decode::Canonical);

    impl Frames {
        /// None when the transcoder would decline the input.
        pub fn new(input: &[u8]) -> Option<Self> {
            prepare(input).ok()?;
            decode_range(input, 0, 0).ok().map(Self)
        }

        /// Encode every frame (no self-checks); the total codestream bytes.
        pub fn encode(&self, ts: &str) -> usize {
            let fb = self.0.data.len() / (self.0.frames.max(1) as usize);
            self.0.data.chunks_exact(fb.max(1)).map(|f| encode_frame(f, &self.0, ts).map_or(0, |c| c.len())).sum()
        }

        /// Native pixel bytes.
        pub fn bytes(&self) -> usize {
            self.0.data.len()
        }
    }

    /// The decoder alone, on any file (the self-check's cost on an encoded output).
    pub fn decode_len(input: &[u8]) -> usize {
        decode_range(input, 0, 0).map_or(0, |c| c.data.len())
    }
}

/// Build the output file around `fragments` and run both self-checks.
fn wrap(input: &[u8], p: Prepared<'_>, ts: &str, fragments: Vec<Vec<u8>>, report: &mut Report) -> Result<Vec<u8>, Declined> {
    let name = version_name(ts).ok_or_else(|| no(format!("transfer syntax {ts} is not one this writer produces")))?;
    let Prepared { meta, explicit, ds, mut elems, pixel_len, first, .. } = p;
    let frames = first.total_frames as usize;
    if fragments.len() != frames {
        return Err(no(format!("{} codestreams for {frames} frames", fragments.len())));
    }
    if fragments.iter().any(|f| f.is_empty()) {
        return Err(no("an empty codestream"));
    }

    // Offsets of each fragment item from the first one; past 4 GiB an Extended Offset Table.
    let mut offsets = Vec::with_capacity(fragments.len());
    let mut at = 0u64;
    for f in &fragments {
        offsets.push(at);
        at += 8 + (f.len() as u64 + f.len() as u64 % 2);
    }
    let large = at > u64::from(u32::MAX);
    let bot: Vec<u8> = if large { Vec::new() } else { offsets.iter().flat_map(|&o| (o as u32).to_le_bytes()).collect() };
    // BOT item, fragment items, sequence delimiter.
    report.pixel_bytes_out = 8 + bot.len() + at as usize + 8;
    if report.pixel_bytes_out >= pixel_len {
        return Err(no(format!("not smaller: {} bytes encoded against {pixel_len} native", report.pixel_bytes_out)));
    }
    if large {
        let eot: Vec<u8> = offsets.iter().flat_map(|o| o.to_le_bytes()).collect();
        let eotl: Vec<u8> = fragments.iter().flat_map(|f| (f.len() as u64).to_le_bytes()).collect();
        elems.retain(|e| !matches!(e.tag, 0x7FE0_0001 | 0x7FE0_0002));
        let at = elems.iter().position(|e| e.tag == PIXEL_DATA).unwrap_or(elems.len());
        elems.insert(at, Elem { tag: 0x7FE0_0002, vr: *b"OV", value: Value::Owned(eotl) });
        elems.insert(at, Elem { tag: 0x7FE0_0001, vr: *b"OV", value: Value::Owned(eot) });
    }
    let at = elems.iter().position(|e| e.tag == PIXEL_DATA).unwrap_or(0);
    elems[at] = Elem {
        tag: PIXEL_DATA,
        vr: *b"OB",
        value: Value::Encapsulated { bot, fragments },
    };
    // Planar Configuration 0, which JPEG requires: changed from 1, or added where it was missing
    // and the decoder settled the layout from the pixels.
    let planar_changed = us(&elems, 0x0028_0006) == Some(1);
    let planar_added = first.samples_per_pixel == 3 && find(&elems, 0x0028_0006).is_none();
    if planar_changed {
        if let Some(e) = elems.iter_mut().find(|e| e.tag == 0x0028_0006) {
            e.value = Value::Owned(vec![0, 0]);
        }
    } else if planar_added {
        let at = elems.iter().position(|e| e.tag > 0x0028_0006).unwrap_or(elems.len());
        elems.insert(at, Elem { tag: 0x0028_0006, vr: *b"US", value: Value::Owned(vec![0, 0]) });
    }
    let mut out = Vec::with_capacity(meta.end + report.pixel_bytes_out + ds.len().saturating_sub(pixel_len));
    write_meta(&mut out, &meta, ts, name);
    let ds_start = out.len();
    let voi_signed = voi_input_signed(&elems, first.signed, u32::from(first.bits_stored))?;
    Writer { signed: first.signed, voi_signed }
        .elems(&mut out, &elems)
        .map_err(|e| no(format!("cannot write the data set as Explicit VR: {e}")))?;
    drop(elems);

    // Check 1: every non-pixel value is unchanged.
    let in_elems = Reader { buf: ds, explicit }.elems(0, ds.len(), false, 0).map_err(no)?.0;
    let written = &out[ds_start..];
    let out_elems = Reader { buf: written, explicit: true }
        .elems(0, written.len(), false, 0)
        .map_err(|e| no(format!("self-check: output data set not readable: {e}")))?
        .0;
    let skip = [PIXEL_DATA, 0x7FE0_0001, 0x7FE0_0002, 0x0028_0006];
    // Bytes and VR: a value with the same bytes under another VR (US read as SS) has changed.
    let (a, b) = (ds::flatten(&in_elems, &skip), ds::flatten(&out_elems, &skip));
    if a.len() != b.len() || a.iter().zip(&b).any(|(x, y)| x.0 != y.0 || x.2 != y.2) {
        return Err(no("self-check mismatch: a non-pixel value changed"));
    }
    if let Some((x, y)) = a.iter().zip(&b).find(|(x, y)| !ds::vr_kept(*x.0.last().unwrap(), x.1, y.1)) {
        let t = x.0.last().unwrap();
        return Err(no(format!("self-check mismatch: ({:04X},{:04X}) VR {} became {}", t >> 16, t & 0xFFFF, String::from_utf8_lossy(&x.1), String::from_utf8_lossy(&y.1))));
    }
    if !planar_changed && !planar_added && bytes_of(&in_elems, 0x0028_0006) != bytes_of(&out_elems, 0x0028_0006) {
        return Err(no("self-check mismatch: Planar Configuration changed"));
    }
    drop((in_elems, out_elems));

    // Check 2: the output decodes to exactly the input's pixels, every frame, compared a chunk of
    // frames at a time.
    let per = frames_per_chunk(first.data.len()).clamp(1, frames.max(1));
    for start in (0..frames).step_by(per) {
        let n = per.min(frames - start);
        // A single frame is already decoded (`first`); others are decoded again a chunk at a time.
        let decoded;
        let before = if start == 0 && n == 1 {
            &first
        } else {
            decoded = decode_range(input, start, n).map_err(|e| no(format!("input does not decode: {e}")))?;
            &decoded
        };
        let after = decode_range(&out, start, n).map_err(|e| no(format!("self-check: output does not decode: {e}")))?;
        let same = (after.frames, after.total_frames, after.rows, after.columns, after.samples_per_pixel, after.bits_allocated)
            == (before.frames, before.total_frames, before.rows, before.columns, before.samples_per_pixel, before.bits_allocated)
            && (after.bits_stored, after.signed) == (before.bits_stored, before.signed)
            && after.photometric == before.photometric
            && same_bytes(&after.data, &before.data);
        if !same {
            return Err(no("self-check mismatch: the encoded pixels do not decode to the input's"));
        }
    }
    Ok(out)
}

/// `a == b`, eight bytes at a time: in wasm, `[u8]` equality calls a `memcmp` that compares one
/// byte at a time.
fn same_bytes(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let (wa, wb) = (a.chunks_exact(8), b.chunks_exact(8));
    let tail = wa.remainder() == wb.remainder();
    // Fold the differences instead of returning at the first, so the loop has no branch.
    let diff = wa.zip(wb).fold(0u64, |acc, (x, y)| {
        acc | (u64::from_ne_bytes(x.try_into().unwrap_or_default()) ^ u64::from_ne_bytes(y.try_into().unwrap_or_default()))
    });
    tail && diff == 0
}

#[cfg(test)]
mod tests {
    /// A panic in a frame-encoding thread reaches the caller; it never leaves frames out silently.
    #[test]
    #[should_panic(expected = "item 5")]
    fn a_worker_panic_is_raised() {
        let items: Vec<u32> = (0..8).collect();
        let _ = map_parallel(&items, 64 << 20, |x| if x == 5 { panic!("item 5") } else { x });
    }

    #[test]
    fn which_instances_are_offered_to_the_encoder() {
        let mb = 1 << 20;
        for (sop, want) in [
            ("1.2.840.10008.5.1.4.1.1.2", true),         // CT
            ("1.2.840.10008.5.1.4.1.1.481.2", true),     // RT Dose
            ("1.2.840.10008.5.1.4.1.1.66.4", false),     // Segmentation
            ("1.2.840.10008.5.1.4.1.1.66.7", false),     // Label Map Segmentation
            ("1.2.840.10008.5.1.4.1.1.66.8", false),     // Height Map Segmentation
            ("1.2.840.10008.5.1.4.1.1.66", false),       // Raw Data
            ("1.2.840.10008.5.1.4.1.1.66.5", false),     // Surface Segmentation
            ("1.2.840.10008.5.1.4.1.1.88.59", false),    // Key Object Selection
            ("1.2.840.10008.5.1.4.1.1.104.1", false),    // Encapsulated PDF
            ("1.2.840.10008.5.1.4.1.1.481.5", false),    // RT Plan
        ] {
            assert_eq!(is_uncompressed_image(EXPLICIT_LE, sop, mb), want, "{sop}");
        }
        assert!(!is_uncompressed_image(EXPLICIT_BE, "1.2.840.10008.5.1.4.1.1.2", mb));
        assert!(!is_uncompressed_image(JPEG_LOSSLESS_SV1, "1.2.840.10008.5.1.4.1.1.2", mb));
        assert!(!is_uncompressed_image(IMPLICIT_LE, "1.2.840.10008.5.1.4.1.1.2", MAX_INSTANCE_BYTES + 1));
    }

    use super::*;

    #[test]
    fn same_bytes_finds_any_difference() {
        let a: Vec<u8> = (0..37u8).collect();
        assert!(same_bytes(&a, &a.clone()));
        assert!(!same_bytes(&a, &a[..36]));
        for i in 0..a.len() {
            let mut b = a.clone();
            b[i] ^= 0x10;
            assert!(!same_bytes(&a, &b), "byte {i}");
        }
        assert!(same_bytes(&[], &[]));
    }

    #[test]
    fn dictionary_lookups() {
        assert_eq!(vrs_of(0x0010_0010), Some(&[*b"PN"][..]));
        assert_eq!(vrs_of(0x6002_3000), Some(&[*b"OB", *b"OW"][..]));
        assert!(vrs_of(0x0009_1001).is_none());
    }
}
