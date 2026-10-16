//! Codestream headers (ISO/IEC 18181-1 Annex A and B): size, image metadata, colour encoding,
//! extra channels and the custom transform data.

use crate::bits::{bits, bits_offset, unpack_signed, val, BitReader};
use crate::error::{invalid, Result};

const SIZE_DIST: [(u32, u32); 4] = [bits_offset(9, 1), bits_offset(13, 1), bits_offset(18, 1), bits_offset(30, 1)];

fn ratio(r: u32, ysize: u32) -> u32 {
    let (n, d): (u64, u64) = match r {
        1 => (1, 1),
        2 => (12, 10),
        3 => (4, 3),
        4 => (3, 2),
        5 => (16, 9),
        6 => (5, 4),
        _ => (2, 1),
    };
    (u64::from(ysize) * n / d) as u32
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Size {
    pub width: u32,
    pub height: u32,
}

pub fn read_size(br: &mut BitReader) -> Size {
    let small = br.bit();
    let height = if small { (br.read(5) + 1) * 8 } else { br.u32(SIZE_DIST) };
    let r = br.read(3);
    let width = if r != 0 {
        ratio(r, height)
    } else if small {
        (br.read(5) + 1) * 8
    } else {
        br.u32(SIZE_DIST)
    };
    Size { width, height }
}

fn read_preview_size(br: &mut BitReader) -> Size {
    let div8 = br.bit();
    let d8 = [val(16), val(32), bits_offset(5, 1), bits_offset(9, 33)];
    let px = [bits_offset(6, 1), bits_offset(8, 65), bits_offset(10, 321), bits_offset(12, 1345)];
    let height = if div8 { br.u32(d8) * 8 } else { br.u32(px) };
    let r = br.read(3);
    let width = if r != 0 {
        ratio(r, height)
    } else if div8 {
        br.u32(d8) * 8
    } else {
        br.u32(px)
    };
    Size { width, height }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BitDepth {
    pub float: bool,
    pub bits: u32,
    pub exp_bits: u32,
}

impl Default for BitDepth {
    fn default() -> Self {
        BitDepth { float: false, bits: 8, exp_bits: 0 }
    }
}

fn read_bit_depth(br: &mut BitReader) -> Result<BitDepth> {
    let float = br.bit();
    if !float {
        let bits = br.u32([val(8), val(10), val(12), bits_offset(6, 1)]);
        if bits > 31 {
            return invalid("bits_per_sample");
        }
        Ok(BitDepth { float, bits, exp_bits: 0 })
    } else {
        let bits = br.u32([val(32), val(16), val(24), bits_offset(6, 1)]);
        let exp_bits = br.read(4) + 1;
        let mant = bits as i32 - exp_bits as i32 - 1;
        if !(2..=8).contains(&exp_bits) || !(2..=23).contains(&mant) {
            return invalid("floating point bit depth");
        }
        Ok(BitDepth { float, bits, exp_bits })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExtraChannelType {
    Alpha,
    Depth,
    SpotColor,
    SelectionMask,
    Black,
    Cfa,
    Thermal,
    NonOptional,
    Optional,
}

#[derive(Clone, Debug)]
pub struct ExtraChannel {
    pub kind: ExtraChannelType,
    pub bit_depth: BitDepth,
    pub dim_shift: u32,
    pub alpha_associated: bool,
    pub spot_color: [f32; 4],
}

fn read_name(br: &mut BitReader) -> Result<()> {
    let len = br.u32([val(0), bits(4), bits_offset(5, 16), bits_offset(10, 48)]);
    for _ in 0..len {
        br.read(8);
    }
    if br.overrun() {
        return invalid("truncated name");
    }
    Ok(())
}

fn read_extra_channel(br: &mut BitReader) -> Result<ExtraChannel> {
    let mut ec = ExtraChannel {
        kind: ExtraChannelType::Alpha,
        bit_depth: BitDepth::default(),
        dim_shift: 0,
        alpha_associated: false,
        spot_color: [0.0; 4],
    };
    if br.bit() {
        return Ok(ec);
    }
    ec.kind = match br.enum_val()? {
        0 => ExtraChannelType::Alpha,
        1 => ExtraChannelType::Depth,
        2 => ExtraChannelType::SpotColor,
        3 => ExtraChannelType::SelectionMask,
        4 => ExtraChannelType::Black,
        5 => ExtraChannelType::Cfa,
        6 => ExtraChannelType::Thermal,
        15 => ExtraChannelType::NonOptional,
        16 => ExtraChannelType::Optional,
        _ => return invalid("extra channel type"),
    };
    ec.bit_depth = read_bit_depth(br)?;
    ec.dim_shift = br.u32([val(0), val(3), val(4), bits_offset(3, 1)]);
    if ec.dim_shift > 3 {
        return invalid("extra channel dim_shift");
    }
    read_name(br)?;
    match ec.kind {
        ExtraChannelType::Alpha => ec.alpha_associated = br.bit(),
        ExtraChannelType::SpotColor => {
            for c in ec.spot_color.iter_mut() {
                *c = br.f16()?;
            }
        }
        ExtraChannelType::Cfa => {
            br.u32([val(1), bits(2), bits_offset(4, 3), bits_offset(8, 19)]);
        }
        ExtraChannelType::NonOptional => return invalid("unknown extra channel type"),
        _ => {}
    }
    Ok(ec)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColourSpace {
    Rgb,
    Gray,
    Xyb,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TransferFunction {
    Bt709,
    Unknown,
    Linear,
    Srgb,
    Pq,
    Dci,
    Hlg,
    /// Gamma as the exponent applied when encoding (the stored value / 1e7, in (0, 1]).
    Gamma(f64),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WhitePoint {
    D65,
    E,
    Dci,
    Custom(f64, f64),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Primaries {
    Srgb,
    Bt2100,
    P3,
    Custom([(f64, f64); 3]),
}

#[derive(Clone, Debug, PartialEq)]
pub struct ColourEncoding {
    pub want_icc: bool,
    pub colour_space: ColourSpace,
    pub white_point: WhitePoint,
    pub primaries: Primaries,
    pub tf: TransferFunction,
    pub rendering_intent: u32,
}

impl Default for ColourEncoding {
    fn default() -> Self {
        ColourEncoding {
            want_icc: false,
            colour_space: ColourSpace::Rgb,
            white_point: WhitePoint::D65,
            primaries: Primaries::Srgb,
            tf: TransferFunction::Srgb,
            rendering_intent: 1,
        }
    }
}

impl ColourEncoding {
    pub fn is_gray(&self) -> bool {
        self.colour_space == ColourSpace::Gray
    }
}

fn read_customxy(br: &mut BitReader) -> (f64, f64) {
    let d = [bits(19), bits_offset(19, 524288), bits_offset(20, 1048576), bits_offset(21, 2097152)];
    let x = unpack_signed(br.u32(d));
    let y = unpack_signed(br.u32(d));
    (f64::from(x) / 1e6, f64::from(y) / 1e6)
}

fn read_colour_encoding(br: &mut BitReader) -> Result<ColourEncoding> {
    let mut ce = ColourEncoding::default();
    if br.bit() {
        return Ok(ce);
    }
    ce.want_icc = br.bit();
    ce.colour_space = match br.enum_val()? {
        0 => ColourSpace::Rgb,
        1 => ColourSpace::Gray,
        2 => ColourSpace::Xyb,
        3 => ColourSpace::Unknown,
        _ => return invalid("colour space"),
    };
    if ce.want_icc {
        return Ok(ce);
    }
    if ce.colour_space != ColourSpace::Xyb {
        ce.white_point = match br.enum_val()? {
            1 => WhitePoint::D65,
            2 => {
                let (x, y) = read_customxy(br);
                WhitePoint::Custom(x, y)
            }
            10 => WhitePoint::E,
            11 => WhitePoint::Dci,
            _ => return invalid("white point"),
        };
    }
    if ce.colour_space != ColourSpace::Xyb && ce.colour_space != ColourSpace::Gray {
        ce.primaries = match br.enum_val()? {
            1 => Primaries::Srgb,
            2 => {
                let r = read_customxy(br);
                let g = read_customxy(br);
                let b = read_customxy(br);
                Primaries::Custom([r, g, b])
            }
            9 => Primaries::Bt2100,
            11 => Primaries::P3,
            _ => return invalid("primaries"),
        };
    }
    if ce.colour_space == ColourSpace::Xyb {
        ce.tf = TransferFunction::Gamma(1.0 / 3.0);
    } else if br.bit() {
        let g = br.read(24);
        if g == 0 || g > 10_000_000 || u64::from(g) * 8192 < 10_000_000 {
            return invalid("gamma");
        }
        ce.tf = TransferFunction::Gamma(f64::from(g) / 1e7);
    } else {
        ce.tf = match br.enum_val()? {
            1 => TransferFunction::Bt709,
            2 => TransferFunction::Unknown,
            8 => TransferFunction::Linear,
            13 => TransferFunction::Srgb,
            16 => TransferFunction::Pq,
            17 => TransferFunction::Dci,
            18 => TransferFunction::Hlg,
            _ => return invalid("transfer function"),
        };
    }
    ce.rendering_intent = br.enum_val()?;
    if ce.rendering_intent > 3 {
        return invalid("rendering intent");
    }
    if ce.colour_space == ColourSpace::Unknown || ce.tf == TransferFunction::Unknown {
        return invalid("unknown colour space or transfer function without ICC");
    }
    Ok(ce)
}

#[derive(Clone, Copy, Debug)]
pub struct ToneMapping {
    pub intensity_target: f32,
    pub min_nits: f32,
    pub relative_to_max_display: bool,
    pub linear_below: f32,
}

impl Default for ToneMapping {
    fn default() -> Self {
        ToneMapping { intensity_target: 255.0, min_nits: 0.0, relative_to_max_display: false, linear_below: 0.0 }
    }
}

fn read_tone_mapping(br: &mut BitReader) -> Result<ToneMapping> {
    let mut t = ToneMapping::default();
    if br.bit() {
        return Ok(t);
    }
    t.intensity_target = br.f16()?;
    if t.intensity_target <= 0.0 {
        return invalid("intensity target");
    }
    t.min_nits = br.f16()?;
    if t.min_nits < 0.0 || t.min_nits > t.intensity_target {
        return invalid("min nits");
    }
    t.relative_to_max_display = br.bit();
    t.linear_below = br.f16()?;
    if t.linear_below < 0.0 || (t.relative_to_max_display && t.linear_below > 1.0) {
        return invalid("linear below");
    }
    Ok(t)
}

#[derive(Clone, Copy, Debug)]
pub struct Animation {
    pub tps_numerator: u32,
    pub tps_denominator: u32,
    pub num_loops: u32,
    pub have_timecodes: bool,
}

#[derive(Clone, Debug)]
pub struct ImageMetadata {
    pub orientation: u32,
    pub intrinsic_size: Option<Size>,
    pub preview: Option<Size>,
    pub animation: Option<Animation>,
    pub bit_depth: BitDepth,
    pub modular_16bit_buffers: bool,
    pub extra_channels: Vec<ExtraChannel>,
    pub xyb_encoded: bool,
    pub colour: ColourEncoding,
    pub tone_mapping: ToneMapping,
}

impl Default for ImageMetadata {
    fn default() -> Self {
        ImageMetadata {
            orientation: 1,
            intrinsic_size: None,
            preview: None,
            animation: None,
            bit_depth: BitDepth::default(),
            modular_16bit_buffers: true,
            extra_channels: Vec::new(),
            xyb_encoded: true,
            colour: ColourEncoding::default(),
            tone_mapping: ToneMapping::default(),
        }
    }
}

pub fn read_metadata(br: &mut BitReader) -> Result<ImageMetadata> {
    let mut m = ImageMetadata::default();
    if br.bit() {
        return Ok(m);
    }
    let extra_fields = br.bit();
    if extra_fields {
        m.orientation = br.read(3) + 1;
        if br.bit() {
            m.intrinsic_size = Some(read_size(br));
        }
        if br.bit() {
            m.preview = Some(read_preview_size(br));
        }
        if br.bit() {
            m.animation = Some(Animation {
                tps_numerator: br.u32([val(100), val(1000), bits_offset(10, 1), bits_offset(30, 1)]),
                tps_denominator: br.u32([val(1), val(1001), bits_offset(8, 1), bits_offset(10, 1)]),
                num_loops: br.u32([val(0), bits(3), bits(16), bits(32)]),
                have_timecodes: br.bit(),
            });
        }
    }
    m.bit_depth = read_bit_depth(br)?;
    m.modular_16bit_buffers = br.bit();
    let num_ec = br.u32([val(0), val(1), bits_offset(4, 2), bits_offset(12, 1)]);
    for _ in 0..num_ec {
        if br.overrun() {
            return invalid("truncated extra channels");
        }
        m.extra_channels.push(read_extra_channel(br)?);
    }
    m.xyb_encoded = br.bit();
    m.colour = read_colour_encoding(br)?;
    if extra_fields {
        m.tone_mapping = read_tone_mapping(br)?;
    }
    br.extensions()?;
    Ok(m)
}

#[allow(clippy::excessive_precision)]
pub const DEFAULT_INVERSE_OPSIN: [[f32; 3]; 3] = [
    [11.031566901960783, -9.866943921568629, -0.16462299647058826],
    [-3.254147380392157, 4.418770392156863, -0.16462299647058826],
    [-3.6588512862745097, 2.7129230470588235, 1.9459282392156863],
];
#[allow(clippy::excessive_precision)]
pub const DEFAULT_OPSIN_BIAS: [f32; 3] = [-0.0037930732552754493; 3];
#[allow(clippy::excessive_precision)]
pub const DEFAULT_QUANT_BIAS: [f32; 4] =
    [1.0 - 0.05465007330715401, 1.0 - 0.07005449891748593, 1.0 - 0.049935103337343655, 0.145];

#[derive(Clone, Debug)]
pub struct OpsinInverse {
    pub matrix: [[f32; 3]; 3],
    pub bias: [f32; 3],
    pub quant_bias: [f32; 3],
    pub quant_bias_numerator: f32,
}

impl Default for OpsinInverse {
    fn default() -> Self {
        OpsinInverse {
            matrix: DEFAULT_INVERSE_OPSIN,
            bias: DEFAULT_OPSIN_BIAS,
            quant_bias: [DEFAULT_QUANT_BIAS[0], DEFAULT_QUANT_BIAS[1], DEFAULT_QUANT_BIAS[2]],
            quant_bias_numerator: DEFAULT_QUANT_BIAS[3],
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct TransformData {
    pub opsin: OpsinInverse,
    pub upsampling2: Option<Vec<f32>>,
    pub upsampling4: Option<Vec<f32>>,
    pub upsampling8: Option<Vec<f32>>,
}

pub fn read_transform_data(br: &mut BitReader, xyb_encoded: bool) -> Result<TransformData> {
    let mut t = TransformData::default();
    if br.bit() {
        return Ok(t);
    }
    if xyb_encoded && !br.bit() {
        for row in t.opsin.matrix.iter_mut() {
            for v in row.iter_mut() {
                *v = br.f16()?;
            }
        }
        for v in t.opsin.bias.iter_mut() {
            *v = br.f16()?;
        }
        for v in t.opsin.quant_bias.iter_mut() {
            *v = br.f16()?;
        }
        t.opsin.quant_bias_numerator = br.f16()?;
    }
    let mask = br.read(3);
    let mut read_n = |n: usize| -> Result<Vec<f32>> { (0..n).map(|_| br.f16()).collect() };
    if mask & 1 != 0 {
        t.upsampling2 = Some(read_n(15)?);
    }
    if mask & 2 != 0 {
        t.upsampling4 = Some(read_n(55)?);
    }
    if mask & 4 != 0 {
        t.upsampling8 = Some(read_n(210)?);
    }
    Ok(t)
}

/// Everything before the first frame.
#[derive(Clone, Debug)]
pub struct Headers {
    pub size: Size,
    pub metadata: ImageMetadata,
    pub transform: TransformData,
    pub icc: Option<Vec<u8>>,
}

impl Headers {
    /// Width and height after orientation is applied (orientations 5–8 transpose).
    pub fn oriented_size(&self) -> Size {
        if self.metadata.orientation > 4 {
            Size { width: self.size.height, height: self.size.width }
        } else {
            self.size
        }
    }
}

/// Reads the signature and headers; returns them and leaves `br` at the first frame (byte
/// aligned).
pub fn read_headers(br: &mut BitReader) -> Result<Headers> {
    if br.read(16) != 0x0AFF {
        return invalid("not a JPEG XL codestream");
    }
    let size = read_size(br);
    if size.width == 0 || size.height == 0 {
        return invalid("zero image size");
    }
    let metadata = read_metadata(br)?;
    let transform = read_transform_data(br, metadata.xyb_encoded)?;
    let icc = if metadata.colour.want_icc { Some(crate::icc::read_icc(br)?) } else { None };
    br.check_end()?;
    br.jump_to_byte_boundary()?;
    Ok(Headers { size, metadata, transform, icc })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ratios() {
        assert_eq!(ratio(1, 100), 100);
        assert_eq!(ratio(2, 100), 120);
        assert_eq!(ratio(5, 9), 16);
        assert_eq!(ratio(7, 3), 6);
    }
}
