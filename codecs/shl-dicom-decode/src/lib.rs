//! DICOM file -> canonical pixels (codec-corpus/CONTRACT.md).
//!
//! [`decode_file`] takes the bytes of a DICOM file (Part 10, file meta without a preamble, or a
//! bare data set) and returns every frame as `(frames, rows, columns, samples)` little-endian
//! samples of Bits Allocated width, masked or sign-extended to Bits Stored, with YBR_FULL and
//! YBR_FULL_422 converted to RGB. This is what pydicom's `pixel_array(raw=False)` returns.
//!
//! Native pixel data is handled here; encapsulated pixel data is split into frames and each frame
//! is passed to the codec crate for its transfer syntax ([`codec_for`]).
#![forbid(unsafe_code)]
#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod encaps;
mod parse;
mod pixel;
mod scale;

use std::fmt;

use parse::{Attributes, PixelValue, Syntax, TS_DEFLATED_LE, TS_EXPLICIT_BE, TS_EXPLICIT_LE, TS_IMPLICIT_LE};
use shl_codec_common::{scaled_extent, ColorOut, DecodeError, DecodeFn, DecodeScaledFn, DecodedFrame, FrameInfo, Photometric};

/// Transfer syntax UID -> codec. Complete from the start so format agents never edit it.
pub fn codec_for(transfer_syntax: &str) -> Option<DecodeFn> {
    Some(match transfer_syntax {
        "1.2.840.10008.1.2.5" => shl_codec_rle::decode_frame,
        "1.2.840.10008.1.2.4.50" | "1.2.840.10008.1.2.4.51" | "1.2.840.10008.1.2.4.57" | "1.2.840.10008.1.2.4.70" => {
            shl_codec_jpeg::decode_frame
        }
        "1.2.840.10008.1.2.4.80" | "1.2.840.10008.1.2.4.81" => shl_codec_jpeg_ls::decode_frame,
        "1.2.840.10008.1.2.4.90" | "1.2.840.10008.1.2.4.91" => shl_codec_jpeg2000::decode_frame,
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
        "1.2.840.10008.1.2.4.50" | "1.2.840.10008.1.2.4.51" => shl_codec_jpeg::decode_frame_scaled,
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
    pub frames: u32,
    pub rows: u32,
    pub columns: u32,
    pub samples_per_pixel: u16,
    /// As declared. Bits Allocated 1 is returned as one byte per sample (0 or 1).
    pub bits_allocated: u16,
    pub bits_stored: u16,
    /// Pixel Representation 1: samples are two's complement.
    pub signed: bool,
    /// Photometric Interpretation of `data`: "RGB" after a YBR conversion, otherwise as declared.
    pub photometric: String,
    pub transfer_syntax: String,
    /// frames × rows × columns × samples, little-endian, [`Canonical::bytes_per_sample`] bytes each.
    pub data: Vec<u8>,
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
    decode_inner(bytes, codecs, None)
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
        return decode_inner(bytes, codecs, None);
    }
    decode_inner(bytes, codecs, Some((scale_log2, &scaled_codecs)))
}

type ScaledTable<'a> = &'a dyn Fn(&str) -> Option<DecodeScaledFn>;

fn decode_inner(
    bytes: &[u8],
    codecs: impl Fn(&str) -> Option<DecodeFn>,
    scaled: Option<(u8, ScaledTable<'_>)>,
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
    let native = matches!(ts.as_str(), TS_IMPLICIT_LE | TS_EXPLICIT_LE | TS_EXPLICIT_BE | TS_DEFLATED_LE);
    // Refuse syntaxes without a codec before reading the data set: some (GE private big endian)
    // are not readable by the rules below, and the message should name the encoding.
    let codec = if native {
        None
    } else {
        Some(codecs(&ts).ok_or_else(|| Error::Unsupported(unsupported_syntax(&ts)))?)
    };
    let attrs = parse::read_dataset(&prepared.dataset, prepared.syntax)?;
    let little = ts != TS_EXPLICIT_BE;

    if attrs.pixel.is_none() && attrs.float_pixel_data {
        return Err(Error::Unsupported("float pixel data not supported (Float or Double Float Pixel Data)".into()));
    }
    let img = Image::from_attributes(&attrs, little, &ts)?;
    let Some(pixel) = attrs.pixel.as_ref() else {
        return Err(Error::Invalid("no Pixel Data (7FE0,0010)".into()));
    };

    if native {
        let PixelValue::Native { data, vr } = pixel else {
            return Err(Error::Invalid(format!("undefined-length Pixel Data in native transfer syntax {ts}")));
        };
        let full = decode_native(&img, data, *vr, little)?;
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
    let (basic_offsets, fragments) = match pixel {
        PixelValue::Encapsulated { basic_offsets, fragments } => (*basic_offsets, fragments),
        PixelValue::Native { data, .. } => {
            reparsed = parse::parse_items(data, little)?;
            match &reparsed {
                PixelValue::Encapsulated { basic_offsets, fragments } => (*basic_offsets, fragments),
                PixelValue::Native { .. } => return Err(Error::Invalid("Pixel Data is not encapsulated".into())),
            }
        }
    };
    let extended = attrs.extended_offsets.zip(attrs.extended_lengths);
    let frames = encaps::split_frames(basic_offsets, fragments, extended, img.frames, little)?;
    match scaled {
        None => decode_encapsulated(&img, &frames, codec),
        Some((s, table)) => decode_encapsulated_scaled(&img, &frames, codec, table(&ts), s),
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
    frames: usize,
    transfer_syntax: String,
}

fn us(v: Option<&[u8]>, little: bool, name: &str) -> Result<Option<u16>, Error> {
    match v {
        None | Some([]) => Ok(None),
        Some(b) => parse::read_u16(b, little)
            .map(Some)
            .ok_or_else(|| Error::Invalid(format!("{name} has a {}-byte value", b.len()))),
    }
}

fn required(v: Option<u16>, name: &str) -> Result<u16, Error> {
    v.ok_or_else(|| Error::Invalid(format!("missing required element {name}")))
}

impl Image {
    fn from_attributes(a: &Attributes<'_>, little: bool, ts: &str) -> Result<Self, Error> {
        let bits_allocated = required(us(a.bits_allocated, little, "Bits Allocated")?, "(0028,0100) Bits Allocated")?;
        if bits_allocated == 0 || bits_allocated > 64 || (bits_allocated != 1 && bits_allocated % 8 != 0) {
            return Err(Error::Invalid(format!("Bits Allocated {bits_allocated}")));
        }
        let bits_stored = required(us(a.bits_stored, little, "Bits Stored")?, "(0028,0101) Bits Stored")?;
        if bits_stored == 0 || bits_stored > bits_allocated {
            return Err(Error::Invalid(format!("Bits Stored {bits_stored} with Bits Allocated {bits_allocated}")));
        }
        let columns = required(us(a.columns, little, "Columns")?, "(0028,0011) Columns")?;
        let rows = required(us(a.rows, little, "Rows")?, "(0028,0010) Rows")?;
        if rows == 0 || columns == 0 {
            return Err(Error::Invalid(format!("{rows} rows × {columns} columns")));
        }
        let frames = match a.number_of_frames.map(parse::trim_text) {
            None => 1,
            Some(s) if s.is_empty() => 1,
            Some(s) => {
                // IS; pydicom treats 0 as 1. A multi-valued IS uses its first value.
                let first = s.split('\\').next().unwrap_or("").trim();
                let n: i64 = first.parse().map_err(|_| Error::Invalid(format!("Number of Frames {s:?}")))?;
                match n {
                    0 => 1,
                    n if n < 0 => return Err(Error::Invalid(format!("Number of Frames {n}"))),
                    n => usize::try_from(n).map_err(|_| Error::Invalid(format!("Number of Frames {n}")))?,
                }
            }
        };
        let photometric_str = a.photometric.map(parse::trim_text).unwrap_or_default();
        if photometric_str.is_empty() {
            return Err(Error::Invalid("missing required element (0028,0004) Photometric Interpretation".into()));
        }
        let pixel_representation =
            required(us(a.pixel_representation, little, "Pixel Representation")?, "(0028,0103) Pixel Representation")?;
        if pixel_representation > 1 {
            return Err(Error::Invalid(format!("Pixel Representation {pixel_representation}")));
        }
        // Missing Samples per Pixel means 1, as GDCM assumes (pydicom refuses).
        let samples_per_pixel = us(a.samples_per_pixel, little, "Samples per Pixel")?.unwrap_or(1);
        if samples_per_pixel != 1 && samples_per_pixel != 3 {
            return Err(Error::Invalid(format!("Samples per Pixel {samples_per_pixel}")));
        }
        let planar = us(a.planar_configuration, little, "Planar Configuration")?;
        let planar_configuration = if samples_per_pixel == 3 {
            let p = required(planar, "(0028,0006) Planar Configuration")?;
            if p > 1 {
                return Err(Error::Invalid(format!("Planar Configuration {p}")));
            }
            p
        } else {
            0
        };
        if !matches!(bits_allocated, 1 | 8 | 16 | 32) {
            return Err(Error::Unsupported(format!("Bits Allocated {bits_allocated}")));
        }
        Ok(Self {
            rows: u32::from(rows),
            columns: u32::from(columns),
            samples_per_pixel,
            bits_allocated,
            bits_stored,
            pixel_representation,
            photometric: Photometric::parse(&photometric_str),
            photometric_str,
            planar_configuration,
            frames,
            transfer_syntax: ts.to_string(),
        })
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
        Ok(Canonical {
            frames: u32::try_from(self.frames).map_err(|_| Error::Unsupported("too many frames".into()))?,
            rows: self.rows,
            columns: self.columns,
            samples_per_pixel: self.samples_per_pixel,
            bits_allocated: self.bits_allocated,
            bits_stored: self.bits_stored,
            signed: self.pixel_representation == 1,
            photometric,
            transfer_syntax: self.transfer_syntax.clone(),
            data,
        })
    }
}

/// Native (uncompressed) pixel data, as pydicom's `_as_array_native` + reshape + corrections.
fn decode_native(img: &Image, raw: &[u8], vr: Option<[u8; 2]>, little: bool) -> Result<Canonical, Error> {
    let bps = img.bps();
    let total_samples =
        img.frame_samples()?.checked_mul(img.frames).ok_or_else(|| Error::Unsupported("image too large".into()))?;
    let ybr422 = img.photometric == Photometric::YbrFull422;

    // Bytes the declared image needs. YBR_FULL_422 stores 2 samples per pixel instead of 3.
    let needed = if img.bits_allocated == 1 {
        total_samples.div_ceil(8)
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
    let fused_ybr422 = bps == 1
        && img.bits_allocated == 8
        && img.bits_stored == 8
        && img.pixel_representation == 0
        && img.samples_per_pixel == 3
        && img.planar_configuration == 0;
    let mut photometric = img.photometric;
    let mut data = if img.bits_allocated == 1 {
        pixel::unpack_bits(raw, total_samples)?
    } else if little && ybr422 && fused_ybr422 {
        // The usual case: expand and convert to RGB in one pass, straight from the file bytes.
        photometric = Photometric::Rgb;
        pixel::ybr_422_to_rgb(stored)?
    } else if little && ybr422 {
        // Expand straight from the file bytes, without an intermediate copy.
        photometric = Photometric::YbrFull;
        pixel::expand_ybr_422(stored, bps)?
    } else {
        let mut d = Vec::new();
        d.try_reserve_exact(needed)
            .map_err(|_| Error::Unsupported(format!("cannot allocate {needed} bytes for decoded pixels")))?;
        if !little && bps == 1 && vr == Some(*b"OW") {
            // 8-bit data in an OW element under big endian: the file swapped 16-bit words.
            d.extend((0..needed).map(|i| raw.get(i ^ 1).copied().unwrap_or(0)));
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
    }

    if img.samples_per_pixel > 1 && img.planar_configuration == 1 {
        let frame_bytes = img.frame_samples()?.saturating_mul(bps);
        if frame_bytes > 0 {
            for frame in data.chunks_exact_mut(frame_bytes) {
                pixel::interleave(frame, usize::from(img.samples_per_pixel), bps)?;
            }
        }
    }

    if img.bits_allocated != 1 {
        pixel::fix_unused_bits(&mut data, bps, img.bits_stored, img.pixel_representation == 1);
    }

    let out_photometric = if photometric == Photometric::Rgb && img.photometric != Photometric::Rgb {
        "RGB".to_string() // converted by the one-pass YBR_FULL_422 path
    } else {
        to_rgb_if_ybr(img, photometric, &mut data)?
    };
    img.canonical(data, out_photometric)
}

/// Convert YBR_FULL / YBR_FULL_422 samples to RGB as pydicom does (8-bit only). Returns the
/// photometric interpretation of the result.
fn to_rgb_if_ybr(img: &Image, photometric: Photometric, data: &mut [u8]) -> Result<String, Error> {
    match photometric {
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

/// Decode each frame with the codec and normalise it to canonical form.
fn decode_encapsulated(img: &Image, frames: &[std::borrow::Cow<'_, [u8]>], codec: DecodeFn) -> Result<Canonical, Error> {
    let info = img.frame_info();
    let expected = info.frame_bytes().ok_or_else(|| Error::Unsupported("image too large".into()))?;
    let mut out: Vec<u8> = Vec::new();
    let mut out_photometric = img.photometric_str.clone();
    for (index, cs) in frames.iter().enumerate() {
        let decoded = codec(cs, &info)?;
        if decoded.data.len() != expected {
            return Err(Error::Invalid(format!(
                "frame {index}: codec returned {} bytes, expected {expected}",
                decoded.data.len()
            )));
        }
        out_photometric = normalise_into(img, decoded, cs, expected, frames.len(), &mut out)?;
    }
    img.canonical(out, out_photometric)
}

/// Append one decoded frame of `img` (`expected` bytes) to `out` in canonical form: planar
/// interleave, Bits Stored, colour. `frames`: how many frames `out` will hold, for its first
/// allocation. Returns the photometric interpretation of the result.
fn normalise_into(
    img: &Image,
    decoded: DecodedFrame,
    cs: &[u8],
    expected: usize,
    frames: usize,
    out: &mut Vec<u8>,
) -> Result<String, Error> {
    let bps = img.bps();
    if out.is_empty() {
        let total = expected.saturating_mul(frames);
        out.try_reserve_exact(total)
            .map_err(|_| Error::Unsupported(format!("cannot allocate {total} bytes for decoded pixels")))?;
    }
    // The frame is normalised in place at the end of the output buffer.
    let start = out.len();
    if decoded.planar && img.samples_per_pixel > 1 {
        out.resize(start + expected, 0);
        let dst = out.get_mut(start..).unwrap_or(&mut []);
        pixel::interleave_into(&decoded.data, dst, usize::from(img.samples_per_pixel), bps)?;
    } else {
        out.extend_from_slice(&decoded.data);
    }
    drop(decoded.data);
    let data = out.get_mut(start..).unwrap_or(&mut []);
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
    Ok(match decoded.color {
        ColorOut::Rgb => "RGB".into(),
        ColorOut::AsDeclared => match img.photometric {
            Photometric::YbrFull | Photometric::YbrFull422 => to_rgb_if_ybr(img, img.photometric, data)?,
            Photometric::YbrPartial420 | Photometric::YbrPartial422 | Photometric::YbrIct | Photometric::YbrRct
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

fn is_jpeg2000(ts: &str) -> bool {
    matches!(
        ts,
        "1.2.840.10008.1.2.4.90" | "1.2.840.10008.1.2.4.91" | "1.2.840.10008.1.2.4.201" | "1.2.840.10008.1.2.4.202"
            | "1.2.840.10008.1.2.4.203"
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
        "1.2.840.10008.1.2.1.98" => "Encapsulated Uncompressed Explicit VR Little Endian",
        "1.2.840.10008.1.2.8.1" => "Deflated Image Frame Compression",
        "1.2.840.113619.5.2" => "GE private Implicit VR Big Endian",
        "1.2.840.10008.1.2.6.1" => "RFC 2557 MIME encapsulation",
        "1.2.840.10008.1.2.7.1" | "1.2.840.10008.1.2.7.2" | "1.2.840.10008.1.2.7.3" => "SMPTE ST 2110 video",
        _ => return format!("transfer syntax {ts} is not supported"),
    };
    format!("{name} ({ts}) is not supported; this decoder has no codec for it")
}
