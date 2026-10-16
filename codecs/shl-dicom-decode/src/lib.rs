//! DICOM file -> canonical pixels (codec-corpus/CONTRACT.md).
//!
//! [`decode_file`] takes the bytes of a DICOM file (Part 10, file meta without a preamble, or a
//! bare data set) and returns every frame as `(frames, rows, columns, samples)` little-endian
//! samples of Bits Allocated width, masked or sign-extended to Bits Stored, with YBR_FULL and
//! YBR_FULL_422 converted to RGB. This is what pydicom's `pixel_array(raw=False)` returns.
//!
//! Native pixel data is handled here; encapsulated pixel data is split into frames and each frame
//! is passed to the codec for its transfer syntax ([`codec_for`]): a codec crate, or for the two
//! encapsulated syntaxes that hold native frames (.1.98 and .8.1) the `unwrapped` module.
#![forbid(unsafe_code)]
#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod encaps;
mod float;
mod infer;
mod parse;
mod pixel;
mod retired;
mod scale;
mod unwrapped;

use std::fmt;

pub use infer::Inference;
use infer::{CodestreamInfo, Layout};

use parse::{
    Attributes, PixelValue, Syntax, TS_DEFLATED_LE, TS_EXPLICIT_BE, TS_EXPLICIT_LE, TS_GE_PRIVATE, TS_IMPLICIT_LE,
};
use shl_codec_common::{scaled_extent, ColorOut, DecodeError, DecodeFn, DecodeScaledFn, DecodedFrame, FrameInfo, Photometric};

/// Transfer syntax UID -> codec. Complete from the start so format agents never edit it.
pub fn codec_for(transfer_syntax: &str) -> Option<DecodeFn> {
    Some(match transfer_syntax {
        unwrapped::TS_ENCAPSULATED_UNCOMPRESSED => unwrapped::decode_encapsulated_uncompressed,
        unwrapped::TS_DEFLATED_IMAGE_FRAME => unwrapped::decode_deflated_frame,
        "1.2.840.10008.1.2.5" => shl_codec_rle::decode_frame,
        // Every JPEG process (T.81): baseline, extended, progressive, arithmetic, lossless and
        // hierarchical. The codec reads the process from the SOF marker.
        "1.2.840.10008.1.2.4.50" | "1.2.840.10008.1.2.4.51" | "1.2.840.10008.1.2.4.52" | "1.2.840.10008.1.2.4.53"
        | "1.2.840.10008.1.2.4.54" | "1.2.840.10008.1.2.4.55" | "1.2.840.10008.1.2.4.56" | "1.2.840.10008.1.2.4.57"
        | "1.2.840.10008.1.2.4.58" | "1.2.840.10008.1.2.4.59" | "1.2.840.10008.1.2.4.60" | "1.2.840.10008.1.2.4.61"
        | "1.2.840.10008.1.2.4.62" | "1.2.840.10008.1.2.4.63" | "1.2.840.10008.1.2.4.64" | "1.2.840.10008.1.2.4.65"
        | "1.2.840.10008.1.2.4.66" | "1.2.840.10008.1.2.4.70" => shl_codec_jpeg::decode_frame,
        "1.2.840.10008.1.2.4.80" | "1.2.840.10008.1.2.4.81" => shl_codec_jpeg_ls::decode_frame,
        "1.2.840.10008.1.2.4.90" | "1.2.840.10008.1.2.4.91" | "1.2.840.10008.1.2.4.92" | "1.2.840.10008.1.2.4.93" => {
            shl_codec_jpeg2000::decode_frame
        }
        #[cfg(feature = "jpegxl")]
        "1.2.840.10008.1.2.4.110" | "1.2.840.10008.1.2.4.111" | "1.2.840.10008.1.2.4.112" => shl_codec_jpegxl::decode_frame,
        "1.2.840.10008.1.2.4.201" | "1.2.840.10008.1.2.4.202" | "1.2.840.10008.1.2.4.203" => {
            shl_codec_htj2k::decode_frame
        }
        _ => return None,
    })
}

/// Transfer syntax -> the codec's own reduced-resolution decode, for codecs that have one. Every
/// other syntax is decoded at full size and box-downsampled by [`decode_file_scaled`].
pub fn scaled_codec_for(transfer_syntax: &str) -> Option<DecodeScaledFn> {
    Some(match transfer_syntax {
        // Lossless JPEG (.57, .70) has no reduced decode; the codec would return Unsupported.
        // The codec returns Unsupported for processes it has no reduced decode for.
        "1.2.840.10008.1.2.4.50" | "1.2.840.10008.1.2.4.51" | "1.2.840.10008.1.2.4.52" | "1.2.840.10008.1.2.4.53"
        | "1.2.840.10008.1.2.4.54" | "1.2.840.10008.1.2.4.55" | "1.2.840.10008.1.2.4.56" | "1.2.840.10008.1.2.4.59"
        | "1.2.840.10008.1.2.4.60" | "1.2.840.10008.1.2.4.61" | "1.2.840.10008.1.2.4.62" | "1.2.840.10008.1.2.4.63"
        | "1.2.840.10008.1.2.4.64" => shl_codec_jpeg::decode_frame_scaled,
        "1.2.840.10008.1.2.4.90" | "1.2.840.10008.1.2.4.91" | "1.2.840.10008.1.2.4.92" | "1.2.840.10008.1.2.4.93" => {
            shl_codec_jpeg2000::decode_frame_scaled
        }
        "1.2.840.10008.1.2.4.201" | "1.2.840.10008.1.2.4.202" | "1.2.840.10008.1.2.4.203" => {
            shl_codec_htj2k::decode_frame_scaled
        }
        _ => return None,
    })
}

/// Why a file was not decoded. Maps to the CLI exit codes of CONTRACT.md.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Malformed, or violates the standard (exit 2).
    Invalid(String),
    /// Valid, but not handled (exit 3).
    Unsupported(String),
}

impl Error {
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::Invalid(_) => 2,
            Self::Unsupported(_) => 3,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(m) => write!(f, "invalid: {m}"),
            Self::Unsupported(m) => write!(f, "unsupported: {m}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<DecodeError> for Error {
    fn from(e: DecodeError) -> Self {
        match e {
            DecodeError::Invalid(m) => Self::Invalid(m),
            DecodeError::Unsupported(m) => Self::Unsupported(m),
        }
    }
}

/// Decoded pixels in canonical form (CONTRACT.md).
#[derive(Debug, Clone)]
pub struct Canonical {
    /// Frames in `data`: all of them, or the requested range ([`decode_frames`]).
    pub frames: u32,
    /// Index of the first frame in `data` within the instance (0 unless a range was requested).
    pub first_frame: u32,
    /// Number of Frames of the instance.
    pub total_frames: u32,
    pub rows: u32,
    pub columns: u32,
    pub samples_per_pixel: u16,
    /// As declared. Bits Allocated 1 is returned as one byte per sample (0 or 1).
    pub bits_allocated: u16,
    pub bits_stored: u16,
    /// Pixel Representation 1: samples are two's complement.
    pub signed: bool,
    /// Float or Double Float Pixel Data: samples are IEEE 754 f32 (Bits Allocated 32) or f64
    /// (Bits Allocated 64), little-endian.
    pub float: bool,
    /// Photometric Interpretation of `data`: "RGB" after a YBR conversion, otherwise as declared.
    pub photometric: String,
    pub transfer_syntax: String,
    /// frames × rows × columns × samples, little-endian, [`Canonical::bytes_per_sample`] bytes each.
    pub data: Vec<u8>,
    /// Attributes that were missing or impossible and were filled in from other evidence
    /// (the codestream header, the pixel data length, or which planar layout is smoother).
    /// Empty for a well-formed file.
    pub inferred: Vec<Inference>,
}

impl Canonical {
    pub fn bytes_per_sample(&self) -> usize {
        usize::from(self.bits_allocated.div_ceil(8))
    }
}

/// Decode every frame of a DICOM file.
pub fn decode_file(bytes: &[u8]) -> Result<Canonical, Error> {
    decode_file_with(bytes, codec_for)
}

/// [`decode_file`] with a different codec table, for tests and for trying candidate codec crates
/// without touching the dispatch in [`codec_for`].
pub fn decode_file_with(bytes: &[u8], codecs: impl Fn(&str) -> Option<DecodeFn>) -> Result<Canonical, Error> {
    decode_inner(bytes, codecs, None, None)
}

/// Decode frames `first..first + count` only (`count` 0: every frame from `first`), at
/// 1/2^`scale_log2` size (0: full size). The pixels are byte-identical to the same frames of
/// [`decode_file`] or [`decode_file_scaled`]. Encapsulated frames outside the range are never
/// decoded, and native data is copied only for the range where its layout allows (otherwise
/// decoded whole and sliced). `first_frame` and `total_frames` of the result say where the
/// frames sit in the instance.
pub fn decode_frames(bytes: &[u8], first: usize, count: usize, scale_log2: u8) -> Result<Canonical, Error> {
    let range = Some((first, count));
    if scale_log2 == 0 {
        return decode_inner(bytes, codec_for, None, range);
    }
    decode_inner(bytes, codec_for, Some((scale_log2, &scaled_codec_for)), range)
}

/// [`decode_frames`] at full size with a different codec table, as [`decode_file_with`].
pub fn decode_frames_with(
    bytes: &[u8],
    first: usize,
    count: usize,
    codecs: impl Fn(&str) -> Option<DecodeFn>,
) -> Result<Canonical, Error> {
    decode_inner(bytes, codecs, None, Some((first, count)))
}

/// Decode every frame at 1/2^`scale_log2` of its size in each direction (CONTRACT.md,
/// "Reduced-resolution decode"): ceil(rows / 2^s) × ceil(columns / 2^s), same canonical form as
/// [`decode_file`]. Uses the codec's own reduced decode where [`scaled_codec_for`] has one,
/// and otherwise a full decode followed by a box downsample of the canonical pixels.
/// `scale_log2` 0 is [`decode_file`].
pub fn decode_file_scaled(bytes: &[u8], scale_log2: u8) -> Result<Canonical, Error> {
    decode_file_scaled_with(bytes, scale_log2, codec_for, scaled_codec_for)
}

/// [`decode_file_scaled`] with different codec tables, as [`decode_file_with`].
pub fn decode_file_scaled_with(
    bytes: &[u8],
    scale_log2: u8,
    codecs: impl Fn(&str) -> Option<DecodeFn>,
    scaled_codecs: impl Fn(&str) -> Option<DecodeScaledFn>,
) -> Result<Canonical, Error> {
    if scale_log2 == 0 {
        return decode_inner(bytes, codecs, None, None);
    }
    decode_inner(bytes, codecs, Some((scale_log2, &scaled_codecs)), None)
}

type ScaledTable<'a> = &'a dyn Fn(&str) -> Option<DecodeScaledFn>;

/// `range`: (first, count) of the frames to decode, count 0 meaning "to the end"; None for all.
fn decode_inner(
    bytes: &[u8],
    codecs: impl Fn(&str) -> Option<DecodeFn>,
    scaled: Option<(u8, ScaledTable<'_>)>,
    range: Option<(usize, usize)>,
) -> Result<Canonical, Error> {
    let mut c = decode_range(bytes, codecs, scaled, range)?;
    if range.is_none() {
        c.total_frames = c.frames;
    }
    Ok(c)
}

/// Resolve a requested frame range against Number of Frames.
fn frame_range(range: Option<(usize, usize)>, total: usize) -> Result<(usize, usize), Error> {
    let Some((first, count)) = range else { return Ok((0, total)) };
    let count = if count == 0 { total.saturating_sub(first) } else { count };
    match first.checked_add(count) {
        Some(end) if end <= total && count > 0 => Ok((first, count)),
        _ => Err(Error::Invalid(format!(
            "frames {first}..{} requested, the instance has {total}",
            first.saturating_add(count)
        ))),
    }
}

fn decode_range(
    bytes: &[u8],
    codecs: impl Fn(&str) -> Option<DecodeFn>,
    scaled: Option<(u8, ScaledTable<'_>)>,
    range: Option<(usize, usize)>,
) -> Result<Canonical, Error> {
    let prepared = parse::prepare(bytes)?;
    let ts = match &prepared.transfer_syntax {
        Some(ts) => ts.clone(),
        // pydicom names the syntax it guessed for a bare data set.
        None => match prepared.syntax {
            Syntax { explicit: false, .. } => TS_IMPLICIT_LE.to_string(),
            Syntax { little: true, .. } => TS_EXPLICIT_LE.to_string(),
            Syntax { little: false, .. } => TS_EXPLICIT_BE.to_string(),
        },
    };
    let native = is_native(&ts);
    // Refuse syntaxes without a codec before reading the data set, so the message names the
    // encoding.
    let codec = if native {
        None
    } else {
        Some(codecs(&ts).ok_or_else(|| Error::Unsupported(unsupported_syntax(&ts)))?)
    };
    let attrs = parse::read_dataset(&prepared.dataset, prepared.syntax)?;
    // How attribute values are encoded, and how native samples are: the GE private syntax has a
    // little endian data set with big endian Pixel Data.
    let little = ts != TS_EXPLICIT_BE;
    let pixel_little = little && ts != TS_GE_PRIVATE;

    let Some(pixel) = attrs.pixel.as_ref() else {
        if let Some((data, bits)) = attrs.float_pixel {
            if !native {
                return Err(Error::Invalid(format!("Float Pixel Data under the encapsulated transfer syntax {ts}")));
            }
            let total = number_of_frames(&attrs)?;
            let (first, count) = frame_range(range, total)?;
            let full = float::decode(&attrs, data, bits, little, pixel_little, &ts, total, first, count)?;
            return match scaled {
                None => Ok(full),
                Some((s, _)) => float::downsample(full, s),
            };
        }
        return Err(Error::Invalid("no Pixel Data (7FE0,0010)".into()));
    };
    let frames_n = number_of_frames(&attrs)?;
    let (first, count) = frame_range(range, frames_n)?;

    if native {
        let PixelValue::Native { data, vr } = pixel else {
            return Err(Error::Invalid(format!("undefined-length Pixel Data in native transfer syntax {ts}")));
        };
        let hints = Hints { native_len: Some(data.len()), codestream: None };
        let img = Image::from_attributes(&attrs, little, &ts, frames_n, &hints)?;
        let full = decode_native_range(&img, data, *vr, pixel_little, first, count)?;
        return match scaled {
            None => Ok(full),
            Some((s, _)) => downsample_canonical(&img, full, s),
        };
    }

    let Some(codec) = codec else {
        return Err(Error::Unsupported(unsupported_syntax(&ts)));
    };
    // Encapsulated pixel data stored with a defined length: read the items inside it.
    let reparsed;
    let (basic_offsets, fragments, note) = match pixel {
        PixelValue::Encapsulated { basic_offsets, fragments, note } => (*basic_offsets, fragments, note),
        PixelValue::Native { data, .. } => {
            reparsed = parse::parse_items(data, little)?;
            match &reparsed {
                PixelValue::Encapsulated { basic_offsets, fragments, note } => (*basic_offsets, fragments, note),
                PixelValue::Native { .. } => return Err(Error::Invalid("Pixel Data is not encapsulated".into())),
            }
        }
    };
    // JPEG 2000 Part 2 (.92, .93): the frames of a volume may be the components of one
    // codestream, or of one codestream per component collection (PS3.5 A.4.4). Such a volume is
    // decoded whole; a frame range is cut from it.
    if matches!(ts.as_str(), "1.2.840.10008.1.2.4.92" | "1.2.840.10008.1.2.4.93") {
        let streams = shl_codec_jpeg2000::codestreams(fragments.iter().map(|f| f.data));
        if !streams.is_empty() && streams.len() < frames_n {
            let hints = Hints { native_len: None, codestream: streams.first().and_then(|f| infer::peek_codestream(&ts, f)) };
            let mut img = Image::from_attributes(&attrs, little, &ts, frames_n, &hints)?;
            if let Some(n) = note {
                img.notes.push(Inference::new("PixelData", "tolerated", n.clone()));
            }
            let mut full = decode_volume(&img, &streams)?;
            if count != frames_n {
                let fb = full.data.len() / frames_n.max(1);
                full.data = full.data.get(fb * first..fb * (first + count)).map(<[u8]>::to_vec).unwrap_or_default();
                full.frames = u32::try_from(count).map_err(|_| Error::Unsupported("too many frames".into()))?;
                full.first_frame = u32::try_from(first).map_err(|_| Error::Unsupported("too many frames".into()))?;
            }
            return match scaled {
                None => Ok(full),
                Some((s, _)) => downsample_canonical(&img, full, s),
            };
        }
    }
    let extended = attrs.extended_offsets.zip(attrs.extended_lengths);
    let frames = encaps::split_frames(basic_offsets, fragments, extended, frames_n, little)?;
    let hints = Hints { native_len: None, codestream: frames.first().and_then(|f| infer::peek_codestream(&ts, f)) };
    let mut img = Image::from_attributes(&attrs, little, &ts, frames_n, &hints)?;
    if let Some(n) = note {
        img.notes.push(Inference::new("PixelData", "tolerated", n.clone()));
    }
    let selected = frames.get(first..first + count).unwrap_or(&[]);
    img.frames = count;
    img.first_frame = first;
    img.total_frames = frames_n;
    match scaled {
        None => decode_encapsulated(&img, selected, codec),
        Some((s, table)) => decode_encapsulated_scaled(&img, selected, codec, table(&ts), s),
    }
}

/// Evidence for filling in missing attributes, gathered before the Image Pixel module is read.
struct Hints {
    /// Native: the length of the Pixel Data value.
    native_len: Option<usize>,
    /// Encapsulated: what the first frame's codestream header says.
    codestream: Option<CodestreamInfo>,
}

/// Number of Frames: missing, empty or 0 means 1 (pydicom). A multi-valued IS uses its first value.
fn number_of_frames(a: &Attributes<'_>) -> Result<usize, Error> {
    let Some(s) = a.number_of_frames.map(parse::trim_text).filter(|s| !s.is_empty()) else {
        return Ok(1);
    };
    let first = s.split('\\').next().unwrap_or("").trim();
    let n: i64 = first.parse().map_err(|_| Error::Invalid(format!("Number of Frames {s:?}")))?;
    match n {
        0 => Ok(1),
        n if n < 0 => Err(Error::Invalid(format!("Number of Frames {n}"))),
        n => usize::try_from(n).map_err(|_| Error::Invalid(format!("Number of Frames {n}"))),
    }
}

/// Image Pixel module values, validated as pydicom validates them.
#[derive(Debug, Clone)]
struct Image {
    rows: u32,
    columns: u32,
    samples_per_pixel: u16,
    bits_allocated: u16,
    bits_stored: u16,
    pixel_representation: u16,
    photometric: Photometric,
    photometric_str: String,
    planar_configuration: u16,
    /// Native 3-sample data with no usable Planar Configuration: decided from the pixels.
    planar_unknown: bool,
    /// Palette tables, for ARGB.
    palette_descriptors: [Option<Vec<u8>>; 3],
    palette_data: [Option<Vec<u8>>; 3],
    /// Attribute values are little endian.
    little: bool,
    /// Native ACR-NEMA Bits Allocated 12: two samples packed in three bytes, unpacked into
    /// `bits_allocated` 16.
    packed12: bool,
    /// Frames to decode, starting at `first_frame` of the instance's `total_frames`.
    frames: usize,
    first_frame: usize,
    total_frames: usize,
    transfer_syntax: String,
    /// Inferences made so far.
    notes: Vec<Inference>,
}

fn us(v: Option<&[u8]>, little: bool, name: &str) -> Result<Option<u16>, Error> {
    match v {
        None | Some([]) => Ok(None),
        Some(b) => parse::read_u16(b, little)
            .map(Some)
            .ok_or_else(|| Error::Invalid(format!("{name} has a {}-byte value", b.len()))),
    }
}


impl Image {
    /// Read the Image Pixel module. Where an attribute is missing or impossible and the evidence
    /// in `hints` settles it, the value is filled in and recorded in `notes`; otherwise the file
    /// is refused, as pydicom refuses it.
    fn from_attributes(a: &Attributes<'_>, little: bool, ts: &str, frames: usize, hints: &Hints) -> Result<Self, Error> {
        let mut notes = Vec::new();
        let cs = hints.codestream;
        let native = hints.native_len.is_some();

        // Samples per Pixel and Photometric Interpretation: each can stand in for the other.
        let pm_text = a.photometric.map(parse::trim_text).unwrap_or_default();
        let pm_declared = (!pm_text.is_empty()).then(|| Photometric::parse(&pm_text));
        let mut ba_attr = us(a.bits_allocated, little, "Bits Allocated")?;
        let spp_attr = us(a.samples_per_pixel, little, "Samples per Pixel")?;
        // ACR-NEMA forms that GDCM reads: Bits Allocated 12 packs two samples in three bytes;
        // Bits Allocated 24 with no Samples per Pixel is one 8-bit RGB pixel.
        let packed12 = native && ba_attr == Some(12);
        if packed12 {
            notes.push(Inference::new(
                "BitsAllocated",
                16,
                "12: ACR-NEMA packed samples (two in three bytes), unpacked into 16 bits as GDCM does",
            ));
            ba_attr = Some(16);
        }
        let rgb24 = native
            && ba_attr == Some(24)
            && spp_attr.is_none()
            && matches!(pm_declared, None | Some(Photometric::Rgb));
        if rgb24 {
            notes.push(Inference::new("BitsAllocated", 8, "24 with no Samples per Pixel: ACR-NEMA 24-bit RGB, read as GDCM reads it"));
            ba_attr = Some(8);
        }
        let samples_per_pixel = match spp_attr {
            Some(v) => v,
            None if rgb24 => {
                notes.push(Inference::new("SamplesPerPixel", 3, "missing; Bits Allocated 24 is one 8-bit RGB pixel"));
                3
            }
            None => {
                let (v, why) = match (cs.filter(|c| matches!(c.components, 1 | 3)), pm_declared) {
                    (Some(c), _) => (c.components, format!("missing; the codestream {} has {} component(s)", c.source, c.components)),
                    (
                        None,
                        Some(
                            Photometric::Rgb
                            | Photometric::YbrFull
                            | Photometric::YbrFull422
                            | Photometric::YbrPartial420
                            | Photometric::YbrPartial422
                            | Photometric::YbrIct
                            | Photometric::YbrRct,
                        ),
                    ) => (3, format!("missing; Photometric Interpretation {pm_text} has 3 samples")),
                    (None, Some(Photometric::Monochrome1 | Photometric::Monochrome2 | Photometric::PaletteColor)) => {
                        (1, format!("missing; Photometric Interpretation {pm_text} has 1 sample"))
                    }
                    (None, _) if retired::Model::parse(&pm_text).is_some() => {
                        let n = retired::Model::parse(&pm_text).map_or(1, retired::Model::samples);
                        (n, format!("missing; Photometric Interpretation {pm_text} has {n} samples"))
                    }
                    _ => (1, "missing; 1 assumed, as GDCM does".to_string()),
                };
                notes.push(Inference::new("SamplesPerPixel", v, why));
                v
            }
        };
        let four = samples_per_pixel == 4 && native && retired::Model::parse(&pm_text).is_some_and(|m| m.samples() == 4);
        if samples_per_pixel != 1 && samples_per_pixel != 3 && !four {
            return Err(Error::Invalid(format!("Samples per Pixel {samples_per_pixel}")));
        }
        let photometric_str = match pm_declared {
            None => {
                let v = if samples_per_pixel == 3 { "RGB" } else { "MONOCHROME2" };
                notes.push(Inference::new(
                    "PhotometricInterpretation",
                    v,
                    format!("missing; {samples_per_pixel} sample(s) per pixel"),
                ));
                v.to_string()
            }
            Some(Photometric::Other) if samples_per_pixel == 1 => {
                notes.push(Inference::new(
                    "PhotometricInterpretation",
                    "MONOCHROME2",
                    format!("{pm_text:?} is not a defined term; 1 sample per pixel"),
                ));
                "MONOCHROME2".to_string()
            }
            Some(_) => pm_text,
        };
        let photometric = Photometric::parse(&photometric_str);
        let argb = photometric_str == "ARGB";

        // Bits Allocated: for encapsulated data an impossible or missing value is replaced by
        // the container for the codestream's precision (e.g. GDCM's FUJI file says 0xFFFF).
        let from_codestream = cs.and_then(|c| infer::container_bits(c.precision).map(|b| (b, c)));
        let mut bits_allocated = match (ba_attr, from_codestream) {
            (Some(b @ (1 | 8 | 16 | 32)), _) => b,
            (b, Some((v, c))) => {
                let what = b.map_or("missing".to_string(), |b| format!("{b} is not a valid value"));
                notes.push(Inference::new(
                    "BitsAllocated",
                    v,
                    format!("{what}; the codestream {} has {}-bit samples", c.source, c.precision),
                ));
                v
            }
            (Some(b), None) if b == 0 || b > 64 || (b != 1 && b % 8 != 0) => {
                return Err(Error::Invalid(format!("Bits Allocated {b}")))
            }
            (Some(b), None) => return Err(Error::Unsupported(format!("Bits Allocated {b}"))),
            (None, None) => 0, // native: from the data length below, once the size is known
        };

        // Rows and Columns: from the codestream, or (native, one of them known) from the length.
        let rows_attr = us(a.rows, little, "Rows")?.filter(|v| *v > 0).map(u32::from);
        let cols_attr = us(a.columns, little, "Columns")?.filter(|v| *v > 0).map(u32::from);
        let (rows, columns) = match (rows_attr, cols_attr, cs) {
            (Some(r), Some(c), _) => (r, c),
            (r, c, Some(info)) if info.rows > 0 && info.columns > 0 => {
                if r.is_none() {
                    notes.push(Inference::new("Rows", info.rows, format!("missing or 0; the codestream {} says {}", info.source, info.rows)));
                }
                if c.is_none() {
                    notes.push(Inference::new(
                        "Columns",
                        info.columns,
                        format!("missing or 0; the codestream {} says {}", info.source, info.columns),
                    ));
                }
                (r.unwrap_or(info.rows), c.unwrap_or(info.columns))
            }
            (Some(r), None, None) | (None, Some(r), None) if native && bits_allocated >= 8 => {
                let len = hints.native_len.unwrap_or(0);
                let per_line = usize::from(samples_per_pixel) * usize::from(bits_allocated / 8) * frames * r as usize;
                let other = (per_line > 0).then(|| len / per_line).filter(|n| *n > 0 && len - n * per_line <= 1);
                let Some(other) = other.and_then(|n| u32::try_from(n).ok()) else {
                    return Err(Error::Invalid("missing required element Rows or Columns".into()));
                };
                let name = if rows_attr.is_none() { "Rows" } else { "Columns" };
                notes.push(Inference::new(name, other, format!("missing; the only value that fits the {len}-byte Pixel Data")));
                if rows_attr.is_none() {
                    (other, r)
                } else {
                    (r, other)
                }
            }
            _ => return Err(Error::Invalid("missing required element (0028,0010) Rows or (0028,0011) Columns".into())),
        };

        // ACR-NEMA files written by LIBIDO store Rows and Columns the other way round; GDCM
        // swaps them on reading.
        let libido = native && a.recognition_code.is_some_and(|v| parse::trim_text(v).starts_with("ACRNEMA_LIBIDO"));
        let (rows, columns) = if libido && rows != columns {
            notes.push(Inference::new("Rows", columns, format!("{rows}; LIBIDO writes Rows and Columns swapped (Recognition Code ACRNEMA_LIBIDO), as GDCM reads it")));
            notes.push(Inference::new("Columns", rows, format!("{columns}; swapped with Rows")));
            (columns, rows)
        } else {
            (rows, columns)
        };

        if bits_allocated == 0 {
            // Native and missing: bytes per sample from the data length, if it is exactly 1, 2 or 4.
            let len = hints.native_len.unwrap_or(0);
            let samples = (rows as usize)
                .saturating_mul(columns as usize)
                .saturating_mul(usize::from(samples_per_pixel))
                .saturating_mul(frames);
            let bytes = (samples > 0).then(|| len / samples).filter(|b| matches!(b, 1 | 2 | 4) && len - b * samples <= 1);
            let Some(b) = bytes else {
                return Err(Error::Invalid("missing required element (0028,0100) Bits Allocated".into()));
            };
            bits_allocated = (b * 8) as u16;
            notes.push(Inference::new(
                "BitsAllocated",
                bits_allocated,
                format!("missing; the {len}-byte Pixel Data holds {b} byte(s) per sample"),
            ));
        }

        // Bits Stored: missing, 0 or above Bits Allocated means "all the bits there are", or
        // the codestream precision when it fits.
        let bits_stored = match us(a.bits_stored, little, "Bits Stored")? {
            Some(b) if b >= 1 && b <= bits_allocated => b,
            b => {
                let v = cs.map(|c| c.precision).filter(|p| (1..=bits_allocated).contains(p)).unwrap_or(bits_allocated);
                let what = match b {
                    None => "missing".to_string(),
                    Some(b) => format!("{b} is impossible with Bits Allocated {bits_allocated}"),
                };
                let source = match cs {
                    Some(c) if c.precision == v => format!("the codestream {} precision", c.source),
                    _ => "Bits Allocated".to_string(),
                };
                notes.push(Inference::new("BitsStored", v, format!("{what}; {source} used")));
                v
            }
        };

        let pixel_representation = match us(a.pixel_representation, little, "Pixel Representation")? {
            Some(v @ (0 | 1)) => v,
            Some(v) => return Err(Error::Invalid(format!("Pixel Representation {v}"))),
            None => {
                let (v, why) = match cs.and_then(|c| c.signed) {
                    Some(sg) => (u16::from(sg), "missing; the codestream SIZ says"),
                    None => (0, "missing; unsigned assumed, as GDCM and dcmtk do"),
                };
                notes.push(Inference::new("PixelRepresentation", v, why));
                v
            }
        };

        // Planar Configuration matters only for native 3-sample data. When it is missing or
        // impossible there, the decoder decides from the pixels (`decode_native`).
        let mut planar_unknown = false;
        let planar_configuration = match us(a.planar_configuration, little, "Planar Configuration")? {
            _ if samples_per_pixel == 1 => 0,
            None if samples_per_pixel == 4 => {
                notes.push(Inference::new("PlanarConfiguration", 0, format!("missing; {photometric_str} read as interleaved")));
                0
            }
            None if rgb24 => {
                notes.push(Inference::new("PlanarConfiguration", 0, "missing; ACR-NEMA 24-bit RGB is interleaved"));
                0
            }
            Some(v @ (0 | 1)) => v,
            declared => {
                let what = declared.map_or("missing".to_string(), |v| format!("{v} is not a valid value"));
                if !native {
                    notes.push(Inference::new(
                        "PlanarConfiguration",
                        0,
                        format!("{what}; not used for encapsulated transfer syntaxes (the codec decides the layout)"),
                    ));
                } else if photometric == Photometric::YbrFull422 || bits_allocated == 1 {
                    notes.push(Inference::new("PlanarConfiguration", 0, format!("{what}; {photometric_str} is always interleaved")));
                } else if declared.is_some() {
                    return Err(Error::Invalid(format!("Planar Configuration {}", declared.unwrap_or(0))));
                } else {
                    planar_unknown = true;
                }
                0
            }
        };

        Ok(Self {
            rows,
            columns,
            samples_per_pixel,
            bits_allocated,
            bits_stored,
            pixel_representation,
            photometric,
            photometric_str,
            planar_configuration,
            planar_unknown,
            packed12,
            palette_descriptors: a.palette_descriptors.map(|v| v.filter(|_| argb).map(<[u8]>::to_vec)),
            palette_data: a.palette_data.map(|v| v.filter(|_| argb).map(<[u8]>::to_vec)),
            little,
            frames,
            first_frame: 0,
            total_frames: frames,
            transfer_syntax: ts.to_string(),
            notes,
        })
    }

    /// Decide the layout of native 3-sample data with no Planar Configuration from its first
    /// frame (`data`: little-endian samples). See `infer::planar_layout`.
    fn with_planar_from_pixels(&self, data: &[u8]) -> Result<Self, Error> {
        let bps = self.bps();
        let frame_bytes = self.frame_samples()?.saturating_mul(bps);
        let frame = data.get(..frame_bytes).unwrap_or(data);
        let layout = infer::planar_layout(
            frame,
            self.rows as usize,
            self.columns as usize,
            bps,
            self.bits_stored,
            self.pixel_representation == 1,
        );
        let (pc, why) = match layout {
            Layout::Either => (0, "missing; both layouts give the same pixels".to_string()),
            Layout::Clear(pc, i, p) => (
                pc,
                format!(
                    "missing; the {} reading is clearly smoother (mean neighbour difference {i:.2} interleaved, {p:.2} planar)",
                    if pc == 1 { "planar" } else { "interleaved" }
                ),
            ),
            Layout::Ambiguous(i, p) if i == 0.0 && p == 0.0 => {
                return Err(Error::Invalid(format!(
                    "missing required element (0028,0006) Planar Configuration, and a {}×{} image is too small to tell the layout",
                    self.columns, self.rows
                )))
            }
            Layout::Ambiguous(i, p) => {
                return Err(Error::Invalid(format!(
                    "missing required element (0028,0006) Planar Configuration, and neither layout is clearly smoother \
                     (mean neighbour difference {i:.2} interleaved, {p:.2} planar)"
                )))
            }
        };
        let mut img = self.clone();
        img.planar_configuration = pc;
        img.planar_unknown = false;
        img.notes.push(Inference::new("PlanarConfiguration", pc, why));
        Ok(img)
    }

    fn bps(&self) -> usize {
        usize::from(self.bits_allocated.div_ceil(8))
    }

    /// The same image at 1/2^s size.
    fn scaled(&self, s: u8) -> Self {
        Self { rows: scaled_extent(self.rows, s), columns: scaled_extent(self.columns, s), ..self.clone() }
    }

    /// Samples in one frame.
    fn frame_samples(&self) -> Result<usize, Error> {
        (self.rows as usize)
            .checked_mul(self.columns as usize)
            .and_then(|n| n.checked_mul(usize::from(self.samples_per_pixel)))
            .ok_or_else(|| Error::Unsupported("image too large".into()))
    }

    fn frame_info(&self) -> FrameInfo {
        FrameInfo {
            rows: self.rows,
            columns: self.columns,
            samples_per_pixel: self.samples_per_pixel,
            bits_allocated: self.bits_allocated,
            bits_stored: self.bits_stored,
            pixel_representation: self.pixel_representation,
            photometric: self.photometric,
            planar_configuration: self.planar_configuration,
            transfer_syntax: self.transfer_syntax.clone(),
        }
    }

    fn canonical(&self, data: Vec<u8>, photometric: String) -> Result<Canonical, Error> {
        let n = |v: usize| u32::try_from(v).map_err(|_| Error::Unsupported("too many frames".into()));
        Ok(Canonical {
            frames: n(self.frames)?,
            first_frame: n(self.first_frame)?,
            total_frames: n(self.total_frames)?,
            rows: self.rows,
            columns: self.columns,
            samples_per_pixel: self.samples_per_pixel,
            bits_allocated: self.bits_allocated,
            bits_stored: self.bits_stored,
            signed: self.pixel_representation == 1,
            float: false,
            photometric,
            transfer_syntax: self.transfer_syntax.clone(),
            data,
            inferred: self.notes.clone(),
        })
    }
}

/// [`decode_native`] for frames `first..first + count`. Where each frame's bytes can be cut out of
/// the Pixel Data on their own, only those are copied; otherwise (bit-packed samples, a word swap,
/// a Planar Configuration decided from the first frame) the whole image is decoded and sliced.
fn decode_native_range(
    img: &Image,
    raw: &[u8],
    vr: Option<[u8; 2]>,
    little: bool,
    first: usize,
    count: usize,
) -> Result<Canonical, Error> {
    if first == 0 && count == img.frames {
        return decode_native(img, raw, vr, little);
    }
    let bps = img.bps();
    let separable = img.bits_allocated != 1 && !img.packed12 && !img.planar_unknown && (little || bps != 1);
    let frame_bytes = img.frame_samples()?.saturating_mul(bps);
    let stored = if is_422(img.photometric) { frame_bytes / 3 * 2 } else { frame_bytes };
    let mut c = if separable {
        let total = stored.saturating_mul(img.frames);
        if raw.len() < total {
            // Same refusal as a whole decode.
            return decode_native(img, raw, vr, little);
        }
        let part = raw.get(stored * first..stored * (first + count)).unwrap_or(&[]);
        decode_native(&Image { frames: count, ..img.clone() }, part, vr, little)?
    } else {
        let mut whole = decode_native(img, raw, vr, little)?;
        whole.data = whole.data.get(frame_bytes * first..frame_bytes * (first + count)).map(<[u8]>::to_vec).unwrap_or_default();
        whole
    };
    c.frames = u32::try_from(count).map_err(|_| Error::Unsupported("too many frames".into()))?;
    c.first_frame = u32::try_from(first).map_err(|_| Error::Unsupported("too many frames".into()))?;
    c.total_frames = u32::try_from(img.frames).map_err(|_| Error::Unsupported("too many frames".into()))?;
    Ok(c)
}

/// Native (uncompressed) pixel data, as pydicom's `_as_array_native` + reshape + corrections.
fn decode_native(img: &Image, raw: &[u8], vr: Option<[u8; 2]>, little: bool) -> Result<Canonical, Error> {
    let bps = img.bps();
    let total_samples =
        img.frame_samples()?.checked_mul(img.frames).ok_or_else(|| Error::Unsupported("image too large".into()))?;
    let ybr422 = is_422(img.photometric);

    // Bytes the declared image needs. YBR_FULL_422 stores 2 samples per pixel instead of 3.
    let needed = if img.bits_allocated == 1 {
        total_samples.div_ceil(8)
    } else if img.packed12 {
        total_samples.div_ceil(2).saturating_mul(3)
    } else {
        let frame_bytes = img
            .frame_samples()?
            .checked_mul(bps)
            .ok_or_else(|| Error::Unsupported("image too large".into()))?;
        let frame_bytes = if ybr422 { frame_bytes / 3 * 2 } else { frame_bytes };
        frame_bytes.checked_mul(img.frames).ok_or_else(|| Error::Unsupported("image too large".into()))?
    };
    if raw.len() < needed {
        return Err(Error::Invalid(format!(
            "Pixel Data has {} bytes, the image needs {needed} ({} frame(s) of {}×{}×{} at {} bits)",
            raw.len(),
            img.frames,
            img.rows,
            img.columns,
            img.samples_per_pixel,
            img.bits_allocated
        )));
    }

    let stored = raw.get(..needed).unwrap_or(&[]);
    // One-pass YBR_FULL_422 -> RGB is valid when nothing has to happen between the expansion and
    // the colour conversion: interleaved, unsigned 8-bit, no bits to mask.
    let fused_ybr422 = img.photometric == Photometric::YbrFull422
        && bps == 1
        && img.bits_allocated == 8
        && img.bits_stored == 8
        && img.pixel_representation == 0
        && img.samples_per_pixel == 3
        && img.planar_configuration == 0;
    let mut photometric = img.photometric;
    let mut expanded = false;
    let mut masked = false;
    let mut data = if img.bits_allocated == 1 {
        pixel::unpack_bits(raw, total_samples)?
    } else if img.packed12 {
        pixel::unpack_12(stored, total_samples)?
    } else if little && ybr422 && fused_ybr422 {
        // The usual case: expand and convert to RGB in one pass, straight from the file bytes.
        photometric = Photometric::Rgb;
        pixel::ybr_422_to_rgb(stored)?
    } else if little && ybr422 {
        // Expand straight from the file bytes, without an intermediate copy. YBR_PARTIAL_422
        // keeps its name, meaning "expanded" from here on.
        if photometric == Photometric::YbrFull422 {
            photometric = Photometric::YbrFull;
        }
        expanded = true;
        pixel::expand_ybr_422(stored, bps)?
    } else {
        let mut d = Vec::new();
        d.try_reserve_exact(needed)
            .map_err(|_| Error::Unsupported(format!("cannot allocate {needed} bytes for decoded pixels")))?;
        if !little && bps == 1 && vr == Some(*b"OW") {
            // 8-bit data in an OW element under big endian: the file swapped 16-bit words.
            d.extend((0..needed).map(|i| raw.get(i ^ 1).copied().unwrap_or(0)));
        } else if little && img.bits_allocated != 1 && !img.planar_unknown {
            // Bits Stored is applied while copying (a per-sample step, so it may come before
            // the planar interleave below), instead of in a second pass. Not when the planar
            // configuration is inferred from the samples, which looks at the unmasked values.
            pixel::extend_fixing_unused_bits(&mut d, stored, bps, img.bits_stored, img.pixel_representation == 1);
            masked = true;
        } else {
            d.extend_from_slice(stored);
        }
        if !little {
            pixel::swap_samples(&mut d, bps);
        }
        d
    };

    if photometric == Photometric::YbrFull422 {
        data = pixel::expand_ybr_422(&data, bps)?;
        photometric = Photometric::YbrFull;
    } else if photometric == Photometric::YbrPartial422 && !expanded {
        data = pixel::expand_ybr_422(&data, bps)?;
    }

    let resolved;
    let img = if img.planar_unknown {
        resolved = img.with_planar_from_pixels(&data)?;
        &resolved
    } else {
        img
    };
    if img.samples_per_pixel > 1 && img.planar_configuration == 1 {
        let frame_bytes = img.frame_samples()?.saturating_mul(bps);
        if frame_bytes > 0 {
            for frame in data.chunks_exact_mut(frame_bytes) {
                pixel::interleave(frame, usize::from(img.samples_per_pixel), bps)?;
            }
        }
    }

    if img.bits_allocated != 1 && !masked {
        pixel::fix_unused_bits(&mut data, bps, img.bits_stored, img.pixel_representation == 1);
    }

    if let Some(model) = retired::Model::parse(&img.photometric_str) {
        if img.pixel_representation != 0 || img.bits_allocated == 1 {
            return Err(Error::Unsupported(format!(
                "{} with Pixel Representation {} and Bits Allocated {}: only unsigned 8, 16 and 32-bit samples are converted",
                img.photometric_str, img.pixel_representation, img.bits_allocated
            )));
        }
        if usize::from(img.samples_per_pixel) != usize::from(model.samples()) {
            return Err(Error::Invalid(format!("{} with Samples per Pixel {}", img.photometric_str, img.samples_per_pixel)));
        }
        let palette = (model == retired::Model::Argb)
            .then(|| retired::Palette::read(
                img.palette_descriptors.each_ref().map(|v| v.as_deref()),
                img.palette_data.each_ref().map(|v| v.as_deref()),
                img.little,
                img.bits_stored,
            ))
            .flatten();
        if model == retired::Model::Argb && palette.is_none() {
            return Err(Error::Invalid("ARGB without readable Palette Color Lookup Tables".into()));
        }
        let rgb = retired::to_rgb(model, &data, bps, img.bits_stored, palette.as_ref());
        let out = Image { samples_per_pixel: 3, ..img.clone() };
        return out.canonical(rgb, "RGB".into());
    }
    let out_photometric = if photometric == Photometric::Rgb && img.photometric != Photometric::Rgb {
        "RGB".to_string() // converted by the one-pass YBR_FULL_422 path
    } else {
        to_rgb_if_ybr(img, photometric, &mut data)?
    };
    img.canonical(data, out_photometric)
}

fn is_422(p: Photometric) -> bool {
    matches!(p, Photometric::YbrFull422 | Photometric::YbrPartial422)
}

/// Convert YBR_FULL / YBR_FULL_422 samples to RGB as pydicom does, and YBR_PARTIAL_422 (already
/// expanded to three samples) by the inverse of its PS3.3 equations; 8-bit only. Returns the
/// photometric interpretation of the result.
fn to_rgb_if_ybr(img: &Image, photometric: Photometric, data: &mut [u8]) -> Result<String, Error> {
    match photometric {
        Photometric::YbrPartial422 if img.samples_per_pixel == 3 => {
            if img.bits_allocated != 8 || img.pixel_representation != 0 {
                return Err(Error::Unsupported(format!(
                    "{} with {} bits allocated (colour conversion is defined for unsigned 8-bit only)",
                    img.photometric_str, img.bits_allocated
                )));
            }
            retired::ybr_partial_to_rgb(data);
            Ok("RGB".into())
        }
        Photometric::YbrPartial420 if img.samples_per_pixel == 3 => Err(Error::Unsupported(
            "YBR_PARTIAL_420 outside a codestream: the standard defines it only inside MPEG-2, H.264 and HEVC streams".into(),
        )),
        Photometric::YbrFull | Photometric::YbrFull422 if img.samples_per_pixel == 3 => {
            if img.bits_allocated != 8 || img.pixel_representation != 0 {
                return Err(Error::Unsupported(format!(
                    "{} with {} bits allocated (colour conversion is defined for unsigned 8-bit only)",
                    img.photometric_str, img.bits_allocated
                )));
            }
            pixel::ybr_full_to_rgb(data);
            Ok("RGB".into())
        }
        _ => Ok(img.photometric_str.clone()),
    }
}

/// Decode each frame with the codec and normalise it to canonical form. Outside wasm, a large
/// multi-frame image is decoded on several threads, each taking a contiguous run of frames and
/// writing into its part of the output; the result and any error are those of a serial decode.
fn decode_encapsulated(img: &Image, frames: &[std::borrow::Cow<'_, [u8]>], codec: DecodeFn) -> Result<Canonical, Error> {
    let info = img.frame_info();
    let expected = info.frame_bytes().ok_or_else(|| Error::Unsupported("image too large".into()))?;
    let total = expected.checked_mul(frames.len()).ok_or_else(|| Error::Unsupported("image too large".into()))?;
    let decode_run = |first: usize, run: &[std::borrow::Cow<'_, [u8]>], dst: &mut [u8]| -> Result<String, Error> {
        let mut photometric = img.photometric_str.clone();
        for ((k, cs), slot) in run.iter().enumerate().zip(dst.chunks_exact_mut(expected.max(1))) {
            let decoded = codec(cs, &info)?;
            if decoded.data.len() != expected {
                return Err(Error::Invalid(format!(
                    "frame {}: codec returned {} bytes, expected {expected}",
                    first + k,
                    decoded.data.len()
                )));
            }
            photometric = normalise_frame(img, decoded, cs, slot)?;
        }
        Ok(photometric)
    };
    // One interleaved frame: normalise the codec's buffer in place instead of copying it.
    if frames.len() == 1 && expected > 0 {
        let cs = &frames[0];
        let mut decoded = codec(cs, &info)?;
        if decoded.data.len() != expected {
            return Err(Error::Invalid(format!("frame 0: codec returned {} bytes, expected {expected}", decoded.data.len())));
        }
        if !(decoded.planar && img.samples_per_pixel > 1) {
            let mut data = std::mem::take(&mut decoded.data);
            let photometric = finish_frame(img, decoded.color, cs, &mut data)?;
            return img.canonical(data, photometric);
        }
        let mut out = pixel::alloc(total)?;
        let photometric = normalise_frame(img, decoded, cs, &mut out)?;
        return img.canonical(out, photometric);
    }
    let threads = decode_threads(frames.len(), total);
    if threads <= 1 && expected > 0 {
        // One thread: append each frame to the output, which is reserved but not zeroed first.
        let mut out = pixel::reserve(total)?;
        let mut photometric = img.photometric_str.clone();
        for (k, cs) in frames.iter().enumerate() {
            let decoded = codec(cs, &info)?;
            if decoded.data.len() != expected {
                return Err(Error::Invalid(format!("frame {k}: codec returned {} bytes, expected {expected}", decoded.data.len())));
            }
            photometric = normalise_into(img, decoded, cs, expected, frames.len(), &mut out)?;
        }
        return img.canonical(out, photometric);
    }
    let mut out = pixel::alloc(total)?;
    let out_photometric = if threads <= 1 {
        decode_run(0, frames, &mut out)?
    } else {
        let per = frames.len().div_ceil(threads);
        let results: Vec<Result<String, Error>> = std::thread::scope(|scope| {
            let handles: Vec<_> = frames
                .chunks(per)
                .zip(out.chunks_mut(per * expected))
                .enumerate()
                .map(|(i, (run, dst))| scope.spawn(move || decode_run(i * per, run, dst)))
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap_or_else(|_| Err(Error::Invalid("a decoder thread panicked".into()))))
                .collect()
        });
        // The first error in frame order, as a serial decode would report.
        let mut last = img.photometric_str.clone();
        for r in results {
            last = r?;
        }
        last
    };
    img.canonical(out, out_photometric)
}

/// JPEG 2000 Part 2 codestreams that each hold several frames, as their components.
fn decode_volume(img: &Image, streams: &[Vec<u8>]) -> Result<Canonical, Error> {
    let info = img.frame_info();
    let expected = info.frame_bytes().ok_or_else(|| Error::Unsupported("image too large".into()))?;
    let mut out: Vec<u8> = Vec::new();
    let mut out_photometric = img.photometric_str.clone();
    let mut count = 0usize;
    for cs in streams {
        let (n, decoded) = shl_codec_jpeg2000::decode_frames(cs, &info)?;
        if expected == 0 || decoded.data.len() != n.saturating_mul(expected) {
            return Err(Error::Invalid(format!("codestream gave {} bytes for {n} frame(s)", decoded.data.len())));
        }
        count += n;
        if count > img.frames {
            return Err(Error::Invalid(format!("codestreams hold more than the {} frames", img.frames)));
        }
        for frame in decoded.data.chunks_exact(expected) {
            let one = DecodedFrame { data: frame.to_vec(), planar: decoded.planar, color: decoded.color };
            out_photometric = normalise_into(img, one, cs, expected, img.frames, &mut out)?;
        }
    }
    if count != img.frames {
        return Err(Error::Invalid(format!("codestreams hold {count} frames, Number of Frames is {}", img.frames)));
    }
    img.canonical(out, out_photometric)
}

/// Threads for decoding `frames` frames into `bytes` of output: one in wasm and for small
/// images, otherwise up to the machine's parallelism (at most 8), with at least 8 MB each.
fn decode_threads(frames: usize, bytes: usize) -> usize {
    #[cfg(target_arch = "wasm32")]
    {
        let _ = (frames, bytes);
        1
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let cpus = std::thread::available_parallelism().map_or(1, |n| n.get()).min(8);
        cpus.min(frames).min(bytes / (8 << 20)).max(1)
    }
}

/// Append one decoded frame of `img` (`expected` bytes) to `out` in canonical form (see
/// [`normalise_frame`]). `frames`: how many frames `out` will hold, for its first allocation.
fn normalise_into(
    img: &Image,
    decoded: DecodedFrame,
    cs: &[u8],
    expected: usize,
    frames: usize,
    out: &mut Vec<u8>,
) -> Result<String, Error> {
    if out.is_empty() {
        *out = pixel::reserve(expected.saturating_mul(frames))?;
    }
    let start = out.len();
    if decoded.data.len() == expected && !(decoded.planar && img.samples_per_pixel > 1) {
        // Interleaved: copy the frame in, then work on it in place (no zero fill first).
        out.extend_from_slice(&decoded.data);
        drop(decoded.data);
        return finish_frame(img, decoded.color, cs, out.get_mut(start..).unwrap_or(&mut []));
    }
    out.resize(start + expected, 0);
    normalise_frame(img, decoded, cs, out.get_mut(start..).unwrap_or(&mut []))
}

/// Write one decoded frame of `img` into `dst` (exactly one frame long) in canonical form: planar
/// interleave, Bits Stored, colour. Returns the photometric interpretation of the result.
fn normalise_frame(img: &Image, decoded: DecodedFrame, cs: &[u8], dst: &mut [u8]) -> Result<String, Error> {
    let bps = img.bps();
    if decoded.data.len() != dst.len() {
        return Err(Error::Invalid(format!("codec returned {} bytes, expected {}", decoded.data.len(), dst.len())));
    }
    if decoded.planar && img.samples_per_pixel > 1 {
        pixel::interleave_into(&decoded.data, dst, usize::from(img.samples_per_pixel), bps)?;
    } else {
        dst.copy_from_slice(&decoded.data);
    }
    drop(decoded.data);
    finish_frame(img, decoded.color, cs, dst)
}

/// The in-place part of [`normalise_frame`]: Bits Stored, then colour.
fn finish_frame(img: &Image, color: ColorOut, cs: &[u8], data: &mut [u8]) -> Result<String, Error> {
    let bps = img.bps();
    if img.bits_allocated != 1 {
        let signed = img.pixel_representation == 1;
        if is_jpeg2000(&img.transfer_syntax) {
            // Keep max(Bits Stored, SIZ precision) bits per component: when the codestream
            // carries more bits than Bits Stored says, pydicom keeps them (CONTRACT.md).
            let spp = usize::from(img.samples_per_pixel);
            let precisions = j2k_precisions(cs).unwrap_or_default();
            let bits: Vec<u16> = (0..spp)
                .map(|k| precisions.get(k).map_or(img.bits_stored, |&p| p.max(img.bits_stored)))
                .collect();
            pixel::fix_unused_bits_per_component(data, bps, &bits, signed);
        } else {
            pixel::fix_unused_bits(data, bps, img.bits_stored, signed);
        }
    }
    Ok(match color {
        ColorOut::Rgb => "RGB".into(),
        ColorOut::AsDeclared => match img.photometric {
            Photometric::YbrFull | Photometric::YbrFull422 | Photometric::YbrPartial422 => {
                to_rgb_if_ybr(img, img.photometric, data)?
            }
            Photometric::YbrPartial420 | Photometric::YbrIct | Photometric::YbrRct
                if img.samples_per_pixel == 3 =>
            {
                return Err(Error::Unsupported(format!(
                    "codec returned {} samples; it must return RGB for this photometric interpretation",
                    img.photometric_str
                )))
            }
            _ => img.photometric_str.clone(),
        },
    })
}

/// Box-downsample every frame of a full-size canonical result (the fallback for native data).
fn downsample_canonical(img: &Image, full: Canonical, s: u8) -> Result<Canonical, Error> {
    // The canonical samples per pixel (3 for the retired 4-sample colour models).
    let img = &Image { samples_per_pixel: full.samples_per_pixel, ..img.clone() };
    let small = img.scaled(s);
    let frame_bytes = img.frame_samples()?.saturating_mul(img.bps());
    let mut out = Vec::new();
    if frame_bytes > 0 {
        for frame in full.data.chunks_exact(frame_bytes) {
            downsample_frame(img, frame, s, &mut out)?;
        }
    }
    Ok(Canonical { rows: small.rows, columns: small.columns, data: out, ..full })
}

fn downsample_frame(img: &Image, frame: &[u8], s: u8, out: &mut Vec<u8>) -> Result<(), Error> {
    scale::box_downsample(
        frame,
        img.rows as usize,
        img.columns as usize,
        usize::from(img.samples_per_pixel),
        img.bps(),
        img.pixel_representation == 1,
        s,
        img.photometric == Photometric::PaletteColor,
        out,
    )
}

/// [`decode_encapsulated`] at 1/2^s. Per frame: the codec's reduced decode at 1/2^s if it has
/// one, else at the largest smaller reduction it supports followed by a box downsample of the
/// rest, else a full decode and box downsample. Each codec result is normalised at the size it
/// was decoded at, before any downsampling, so the fallback sees canonical pixels (RGB, Bits
/// Stored applied). An Invalid from the reduced decode falls back to the full decode, so
/// a reduced decode never refuses a frame the full decode accepts.
fn decode_encapsulated_scaled(
    img: &Image,
    frames: &[std::borrow::Cow<'_, [u8]>],
    codec: DecodeFn,
    scaled_codec: Option<DecodeScaledFn>,
    s: u8,
) -> Result<Canonical, Error> {
    let info = img.frame_info();
    let small = img.scaled(s);
    let small_bytes = small.frame_info().frame_bytes().ok_or_else(|| Error::Unsupported("image too large".into()))?;
    // Averaging palette indices is meaningless, so PALETTE COLOR always takes the fallback,
    // which picks samples instead of averaging them.
    let scaled_codec = scaled_codec.filter(|_| img.photometric != Photometric::PaletteColor);
    let mut out: Vec<u8> = Vec::new();
    let mut tmp: Vec<u8> = Vec::new();
    let mut out_photometric = img.photometric_str.clone();
    for (index, cs) in frames.iter().enumerate() {
        if out.is_empty() {
            let total = small_bytes.saturating_mul(frames.len());
            out.try_reserve_exact(total)
                .map_err(|_| Error::Unsupported(format!("cannot allocate {total} bytes for decoded pixels")))?;
        }
        let mut done = false;
        if let Some(scaled) = scaled_codec {
            for k in (1..=s).rev() {
                match scaled(cs, &info, k) {
                    Ok(d) => {
                        let at = img.scaled(k);
                        let bytes = at.frame_info().frame_bytes().unwrap_or(0);
                        if d.rows != at.rows || d.columns != at.columns || d.frame.data.len() != bytes {
                            return Err(Error::Invalid(format!(
                                "frame {index}: reduced decode returned {}×{} ({} bytes), expected {}×{} ({bytes} bytes)",
                                d.columns,
                                d.rows,
                                d.frame.data.len(),
                                at.columns,
                                at.rows
                            )));
                        }
                        if k == s {
                            out_photometric = normalise_into(&at, d.frame, cs, bytes, frames.len(), &mut out)?;
                        } else {
                            tmp.clear();
                            out_photometric = normalise_into(&at, d.frame, cs, bytes, 1, &mut tmp)?;
                            downsample_frame(&at, &tmp, s - k, &mut out)?;
                        }
                        done = true;
                        break;
                    }
                    Err(DecodeError::Unsupported(_)) => continue,
                    Err(DecodeError::Invalid(_)) => break,
                }
            }
        }
        if !done {
            let expected = info.frame_bytes().ok_or_else(|| Error::Unsupported("image too large".into()))?;
            let decoded = codec(cs, &info)?;
            if decoded.data.len() != expected {
                return Err(Error::Invalid(format!(
                    "frame {index}: codec returned {} bytes, expected {expected}",
                    decoded.data.len()
                )));
            }
            tmp.clear();
            out_photometric = normalise_into(img, decoded, cs, expected, 1, &mut tmp)?;
            downsample_frame(img, &tmp, s, &mut out)?;
        }
    }
    small.canonical(out, out_photometric)
}

/// Transfer syntaxes whose Pixel Data is stored native (not encapsulated).
pub fn is_native(ts: &str) -> bool {
    matches!(ts, TS_IMPLICIT_LE | TS_EXPLICIT_LE | TS_EXPLICIT_BE | TS_DEFLATED_LE | TS_GE_PRIVATE)
}

fn is_jpeg2000(ts: &str) -> bool {
    matches!(
        ts,
        "1.2.840.10008.1.2.4.90" | "1.2.840.10008.1.2.4.91" | "1.2.840.10008.1.2.4.92" | "1.2.840.10008.1.2.4.93"
            | "1.2.840.10008.1.2.4.201" | "1.2.840.10008.1.2.4.202" | "1.2.840.10008.1.2.4.203"
    )
}

/// Component precisions from a JPEG 2000 codestream's SIZ marker (ISO/IEC 15444-1 A.5.1):
/// SOC (FF4F) is followed by SIZ (FF51); Csiz is 38 bytes after the SIZ marker and component k's
/// Ssiz is at 40 + 3k, precision = (Ssiz & 0x7F) + 1. A JP2 wrapper is skipped by searching the
/// first 4 KiB for SOC + SIZ.
fn j2k_precisions(cs: &[u8]) -> Option<Vec<u16>> {
    let head = cs.get(..cs.len().min(4096))?;
    let at = head.windows(4).position(|w| w == [0xFF, 0x4F, 0xFF, 0x51])? + 2;
    let siz = cs.get(at..)?;
    let csiz = usize::from(parse::read_u16(siz.get(38..40)?, false)?);
    (0..csiz).map(|k| siz.get(40 + 3 * k).map(|s| u16::from(s & 0x7F) + 1)).collect()
}

/// A readable reason for a transfer syntax this decoder has no codec for.
fn unsupported_syntax(ts: &str) -> String {
    let name = match ts {
        "1.2.840.10008.1.2.4.100" | "1.2.840.10008.1.2.4.100.1" => "MPEG-2 video (Main Profile / Main Level)",
        "1.2.840.10008.1.2.4.101" | "1.2.840.10008.1.2.4.101.1" => "MPEG-2 video (Main Profile / High Level)",
        "1.2.840.10008.1.2.4.102" | "1.2.840.10008.1.2.4.102.1" | "1.2.840.10008.1.2.4.103"
        | "1.2.840.10008.1.2.4.103.1" | "1.2.840.10008.1.2.4.104" | "1.2.840.10008.1.2.4.104.1"
        | "1.2.840.10008.1.2.4.105" | "1.2.840.10008.1.2.4.105.1" | "1.2.840.10008.1.2.4.106"
        | "1.2.840.10008.1.2.4.106.1" => "MPEG-4 AVC / H.264 video",
        "1.2.840.10008.1.2.4.107" | "1.2.840.10008.1.2.4.108" => "HEVC / H.265 video",
        "1.2.840.10008.1.2.4.110" => "JPEG XL Lossless",
        "1.2.840.10008.1.2.4.111" => "JPEG XL JPEG Recompression",
        "1.2.840.10008.1.2.4.112" => "JPEG XL",
        "1.2.840.10008.1.2.4.52" | "1.2.840.10008.1.2.4.53" | "1.2.840.10008.1.2.4.54"
        | "1.2.840.10008.1.2.4.55" | "1.2.840.10008.1.2.4.56" | "1.2.840.10008.1.2.4.58"
        | "1.2.840.10008.1.2.4.59" | "1.2.840.10008.1.2.4.60" | "1.2.840.10008.1.2.4.61"
        | "1.2.840.10008.1.2.4.62" | "1.2.840.10008.1.2.4.63" | "1.2.840.10008.1.2.4.64"
        | "1.2.840.10008.1.2.4.65" | "1.2.840.10008.1.2.4.66" => {
            "retired JPEG process (progressive, arithmetic-coded or hierarchical)"
        }
        "1.2.840.10008.1.2.4.92" | "1.2.840.10008.1.2.4.93" => "JPEG 2000 Part 2 multi-component",
        "1.2.840.10008.1.2.4.94" | "1.2.840.10008.1.2.4.95" => "JPIP referenced pixel data",
        "1.2.840.10008.1.2.6.1" => "RFC 2557 MIME encapsulation",
        "1.2.840.10008.1.2.7.1" | "1.2.840.10008.1.2.7.2" | "1.2.840.10008.1.2.7.3" => "SMPTE ST 2110 video",
        _ => return format!("transfer syntax {ts} is not supported"),
    };
    format!("{name} ({ts}) is not supported; this decoder has no codec for it")
}
