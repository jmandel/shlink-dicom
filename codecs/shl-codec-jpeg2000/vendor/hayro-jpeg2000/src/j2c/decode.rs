//! Decoding JPEG2000 code streams.
//!
//! This is the "core" module of the crate that orchestrates all
//! stages in such a way that a given codestream is decoded into its
//! component channels.

use alloc::boxed::Box;
use alloc::vec::Vec;

use super::bitplane::{BitPlaneDecodeBuffers, BitPlaneDecodeContext};
use super::build::{CodeBlock, Decomposition, Layer, Precinct, Segment, SubBand, SubBandType};
use super::codestream::{
    ComponentInfo, Header, ProgressionOrder, QuantizationStyle, WaveletTransform,
};
use super::idwt::IDWTOutput;
use super::progression::{
    IteratorInput, ProgressionData, component_position_resolution_layer_progression,
    layer_resolution_component_position_progression,
    position_component_resolution_layer_progression,
    resolution_layer_component_position_progression,
    resolution_position_component_layer_progression,
};
use super::tag_tree::TagNode;
use super::tile::{ComponentTile, ResolutionTile, Tile};
use super::{ComponentData, bitplane, build, idwt, mct, segment, tile};
use crate::error::{DecodingError, Result, TileError, ValidationError, bail};
use crate::j2c::segment::MAX_BITPLANE_COUNT;
use crate::math::SimdBuffer;
use crate::reader::BitReader;
use core::ops::Range;

pub(crate) fn decode<'a>(
    data: &'a [u8],
    header: &'a Header<'a>,
    ctx: &mut DecoderContext<'a>,
) -> Result<()> {
    let mut reader = BitReader::new(data);
    let tiles = tile::parse(&mut reader, header)?;

    if tiles.is_empty() {
        bail!(TileError::Invalid);
    }

    ctx.reset(header, &tiles[0])?;

    // shl patch 8: without MCT, the DC level shift is added while each tile is stored,
    // instead of in a separate pass over every channel afterwards (the same f32 additions).
    // shl patch 11: a Part 2 multiple component transformation replaces the level shift.
    let shift_in_store = !header.defer_level_shift
        && !tiles[0].mct
        && header.part2.is_none()
        && header.skipped_resolution_levels == 0;
    // shl patch 11: the transformation is read from the main header only, so every tile
    // must use it (a tile-part COD may switch it off).
    if header.part2.is_some() && tiles.iter().any(|t| t.mct_type != header.global_coding_style.mct_type) {
        bail!(crate::error::MarkerError::Unsupported);
    }
    let sole_tile = tiles.len() == 1;

    for tile in &tiles {
        trace!(
            "tile {} rect [{},{} {}x{}]",
            tile.idx,
            tile.rect.x0,
            tile.rect.y0,
            tile.rect.width(),
            tile.rect.height(),
        );

        let iter_input = IteratorInput::new(tile);

        let progression_iterator: Box<dyn Iterator<Item = ProgressionData>> =
            match tile.progression_order {
                ProgressionOrder::LayerResolutionComponentPosition => {
                    Box::new(layer_resolution_component_position_progression(iter_input))
                }
                ProgressionOrder::ResolutionLayerComponentPosition => {
                    Box::new(resolution_layer_component_position_progression(iter_input))
                }
                ProgressionOrder::ResolutionPositionComponentLayer => Box::new(
                    resolution_position_component_layer_progression(iter_input)
                        .ok_or(DecodingError::InvalidProgressionIterator)?,
                ),
                ProgressionOrder::PositionComponentResolutionLayer => Box::new(
                    position_component_resolution_layer_progression(iter_input)
                        .ok_or(DecodingError::InvalidProgressionIterator)?,
                ),
                ProgressionOrder::ComponentPositionResolutionLayer => Box::new(
                    component_position_resolution_layer_progression(iter_input)
                        .ok_or(DecodingError::InvalidProgressionIterator)?,
                ),
            };

        decode_tile(
            tile,
            header,
            progression_iterator,
            &mut ctx.tile_decode_context,
            &mut ctx.channel_data,
            &mut ctx.storage,
            shift_in_store,
            sole_tile,
        )?;
    }

    // Note that this assumes that either all tiles have MCT or none of them.
    // In theory, only some could have it... But hopefully no such cursed
    // images exist!
    if tiles[0].mct {
        mct::apply_inverse(&mut ctx.channel_data, &tiles[0].component_infos, header)?;
    }

    // shl patch 11: the Part 2 transformation, with no DC level shift (T.801 Annex J).
    if let Some(part2) = &header.part2 {
        let len = (header.size_data.image_width() as usize)
            .checked_mul(header.size_data.image_height() as usize)
            .ok_or(ValidationError::ImageTooLarge)?;
        part2.apply(&mut ctx.channel_data, len)?;
        return Ok(());
    }

    if !shift_in_store && !header.defer_level_shift {
        apply_sign_shift(&mut ctx.channel_data, &header.component_infos);
    }

    Ok(())
}

/// A decoder context for decoding JPEG2000 images.
#[derive(Default)]
pub struct DecoderContext<'a> {
    tile_decode_context: TileDecodeContext,
    /// The raw, decoded samples for each channel.
    pub(crate) channel_data: Vec<ComponentData>,
    storage: DecompositionStorage<'a>,
}

impl DecoderContext<'_> {
    fn reset(&mut self, header: &Header<'_>, initial_tile: &Tile<'_>) -> Result<()> {
        self.tile_decode_context.reset();
        self.storage.reset();

        self.channel_data.clear();
        let sample_count = (header.size_data.image_width() as usize)
            .checked_mul(header.size_data.image_height() as usize)
            .ok_or(ValidationError::ImageTooLarge)?;
        // TODO: SIMD Buffers should be reused across runs!
        for info in &initial_tile.component_infos {
            self.channel_data.push(ComponentData {
                container: SimdBuffer::zeros(sample_count),
                bit_depth: info.size_info.precision,
            });
        }

        Ok(())
    }
}

fn decode_tile<'a, 'b>(
    tile: &'b Tile<'a>,
    header: &Header<'_>,
    progression_iterator: Box<dyn Iterator<Item = ProgressionData> + '_>,
    tile_ctx: &mut TileDecodeContext,
    channel_data: &mut [ComponentData],
    storage: &mut DecompositionStorage<'a>,
    shift_in_store: bool,
    sole_tile: bool,
) -> Result<()> {
    storage.reset();

    // This is the method that orchestrates all steps.

    // First, we build the decompositions, including their sub-bands, precincts
    // and code blocks.
    build::build(tile, storage, header.skipped_resolution_levels)?;
    // Next, we parse the layers/segments for each code block.
    segment::parse(tile, progression_iterator, header, storage)?;

    // Interleave bitplane decoding, IDWT, and storage for each component tile
    // so we can reuse the coefficient and IDWT buffers.
    for (idx, component_info) in header.component_infos.iter().enumerate() {
        if idx > 0 {
            let count = storage.tile_decompositions[idx].coefficient_count;
            storage.coefficients[..count].fill(0.0);
        }
        // We then decode the bitplanes of each code block, yielding the
        // (possibly dequantized) coefficients of each code block.
        decode_component_tile_bit_planes(idx, tile, tile_ctx, storage, header)?;
        // Next, we apply the inverse discrete wavelet transform.
        idwt::apply(
            storage,
            tile_ctx,
            idx,
            header,
            component_info.wavelet_transform(),
        );
        // Finally, we store the raw samples for the tile area in the correct
        // location. Note that in case we have MCT, we are not applying it yet.
        // It will be applied in the very end once all tiles have been processed.
        // The reason we do this is that applying MCT requires access to the
        // data from _all_ components. If we didn't defer this until the end
        // we would have to collect the IDWT outputs of all components before
        // applying it. By not applying MCT here, we can get away with doing
        // IDWT and store on a per-component basis. Thus, we only need to
        // store one IDWT output at a time, allowing for better reuse of
        // allocations.
        store(
            tile,
            header,
            tile_ctx,
            &mut channel_data[idx],
            component_info,
            shift_in_store.then(|| (1_u32 << (component_info.size_info.precision - 1)) as f32),
            sole_tile,
        );
    }

    Ok(())
}

/// All decompositions for a single tile.
#[derive(Clone)]
pub(crate) struct TileDecompositions {
    pub(crate) first_ll_sub_band: usize,
    pub(crate) decompositions: Range<usize>,
    pub(crate) coefficient_count: usize,
}

impl TileDecompositions {
    pub(crate) fn sub_band_iter(
        &self,
        resolution: u8,
        decompositions: &[Decomposition],
    ) -> SubBandIter {
        let indices = if resolution == 0 {
            [
                self.first_ll_sub_band,
                self.first_ll_sub_band,
                self.first_ll_sub_band,
            ]
        } else {
            decompositions[self.decompositions.clone()][resolution as usize - 1].sub_bands
        };

        SubBandIter {
            next_idx: 0,
            indices,
            resolution,
        }
    }
}

#[derive(Clone)]
pub(crate) struct SubBandIter {
    resolution: u8,
    next_idx: usize,
    indices: [usize; 3],
}

impl Iterator for SubBandIter {
    type Item = usize;

    fn next(&mut self) -> Option<Self::Item> {
        let value = if self.resolution == 0 {
            if self.next_idx > 0 {
                None
            } else {
                Some(self.indices[0])
            }
        } else if self.next_idx >= self.indices.len() {
            None
        } else {
            Some(self.indices[self.next_idx])
        };

        self.next_idx += 1;

        value
    }
}

/// A buffer so that we can reuse allocations for layers/code blocks/etc.
/// across different tiles.
#[derive(Default)]
pub(crate) struct DecompositionStorage<'a> {
    pub(crate) segments: Vec<Segment<'a>>,
    pub(crate) layers: Vec<Layer>,
    pub(crate) code_blocks: Vec<CodeBlock>,
    pub(crate) precincts: Vec<Precinct>,
    pub(crate) tag_tree_nodes: Vec<TagNode>,
    pub(crate) coefficients: Vec<f32>,
    pub(crate) sub_bands: Vec<SubBand>,
    pub(crate) decompositions: Vec<Decomposition>,
    pub(crate) tile_decompositions: Vec<TileDecompositions>,
    /// shl patch 5: set by tier-2 when an HT code-block's pass layout is not one the HT
    /// path decodes.
    pub(crate) ht_unsupported: bool,
}

impl DecompositionStorage<'_> {
    fn reset(&mut self) {
        self.segments.clear();
        self.layers.clear();
        self.code_blocks.clear();
        // No need to clear the coefficients, as they will be resized
        // and then overridden.
        // self.coefficients.clear();
        self.precincts.clear();
        self.sub_bands.clear();
        self.decompositions.clear();
        self.tile_decompositions.clear();
        self.tag_tree_nodes.clear();
    }
}

/// A reusable context used during the decoding of a single tile.
///
/// Some of the fields are temporary in nature and reset after moving on to the
/// next tile, some contain global state.
#[derive(Default)]
pub(crate) struct TileDecodeContext {
    /// A reusable buffer for the IDWT output.
    pub(crate) idwt_output: IDWTOutput,
    /// A scratch buffer used during IDWT.
    pub(crate) idwt_scratch_buffer: Vec<f32>,
    /// A reusable context for decoding code blocks.
    pub(crate) bit_plane_decode_context: BitPlaneDecodeContext,
    /// Reusable buffers for decoding bitplanes.
    pub(crate) bit_plane_decode_buffers: BitPlaneDecodeBuffers,
    /// shl patch 5: reusable buffers for HT code-blocks.
    pub(crate) ht_scratch: super::ht::HtScratch,
    pub(crate) ht_coded: Vec<u8>,
    pub(crate) ht_samples: Vec<u32>,
}

impl TileDecodeContext {
    fn reset(&mut self) {
        // This method doesn't do anything, just keeping it there in case
        // it's needed in the future.
        // Bitplane decode context and buffers will be reset in the
        // corresponding methods. IDWT output and scratch buffer will be
        // overridden on demand, so those don't need to be reset either.
    }
}

fn decode_component_tile_bit_planes<'a>(
    component_idx: usize,
    tile: &Tile<'a>,
    tile_ctx: &mut TileDecodeContext,
    storage: &mut DecompositionStorage<'a>,
    header: &Header<'_>,
) -> Result<()> {
    let component_info = &tile.component_infos[component_idx];

    // Only decode the resolution levels we actually care about.
    for resolution in 0..component_info.num_resolution_levels() - header.skipped_resolution_levels {
        let tile_composition = &storage.tile_decompositions[component_idx];
        let sub_band_iter = tile_composition.sub_band_iter(resolution, &storage.decompositions);

        for sub_band_idx in sub_band_iter {
            decode_sub_band_bitplanes(
                sub_band_idx,
                resolution,
                component_info,
                tile_ctx,
                storage,
                header,
            )?;
        }
    }

    Ok(())
}

fn decode_sub_band_bitplanes(
    sub_band_idx: usize,
    resolution: u8,
    component_info: &ComponentInfo,
    tile_ctx: &mut TileDecodeContext,
    storage: &mut DecompositionStorage<'_>,
    header: &Header<'_>,
) -> Result<()> {
    let sub_band = &storage.sub_bands[sub_band_idx];

    let quantised =
        component_info.quantization_info.quantization_style != QuantizationStyle::NoQuantization;
    let irreversible = component_info.wavelet_transform() == WaveletTransform::Irreversible97;
    let dequantization_step = {
        if !quantised {
            1.0
        } else {
            let (exponent, mantissa) =
                component_info.exponent_mantissa(sub_band.sub_band_type, resolution)?;

            let r_b = {
                let log_gain = match sub_band.sub_band_type {
                    SubBandType::LowLow => 0,
                    SubBandType::LowHigh => 1,
                    SubBandType::HighLow => 1,
                    SubBandType::HighHigh => 2,
                };

                component_info.size_info.precision as u16 + log_gain
            };

            crate::math::pow2i(r_b as i32 - exponent as i32) * (1.0 + (mantissa as f32) / 2048.0)
        }
    };

    let num_bitplanes = {
        let (exponent, _) = component_info.exponent_mantissa(sub_band.sub_band_type, resolution)?;
        // Equation (E-2)
        let num_bitplanes = (component_info.quantization_info.guard_bits as u16)
            .checked_add(exponent)
            .and_then(|x| x.checked_sub(1))
            .ok_or(DecodingError::InvalidBitplaneCount)?;

        if num_bitplanes > MAX_BITPLANE_COUNT as u16 {
            bail!(DecodingError::TooManyBitplanes);
        }

        num_bitplanes as u8
    };

    // shl patch 5: HT code-blocks.
    if header.is_ht(&component_info.code_block_style())? {
        return decode_ht_sub_band(
            sub_band_idx,
            num_bitplanes,
            dequantization_step,
            irreversible,
            component_info.code_block_style().vertically_causal_context,
            tile_ctx,
            storage,
        );
    }

    for precinct in sub_band
        .precincts
        .clone()
        .map(|idx| &storage.precincts[idx])
    {
        for code_block in precinct
            .code_blocks
            .clone()
            .map(|idx| &storage.code_blocks[idx])
        {
            bitplane::decode(
                code_block,
                sub_band.sub_band_type,
                num_bitplanes,
                &component_info.coding_style.parameters.code_block_style,
                tile_ctx,
                storage,
                header.strict,
            )?;

            // Turn the signs and magnitudes into singular coefficients and
            // copy them into the sub-band.

            let x_offset = code_block.rect.x0 - sub_band.rect.x0;
            let y_offset = code_block.rect.y0 - sub_band.rect.y0;

            let base_store = &mut storage.coefficients[sub_band.coefficients.clone()];
            let mut base_idx = (y_offset * sub_band.rect.width()) as usize + x_offset as usize;

            for (coefficients, coefficient_states) in
                tile_ctx.bit_plane_decode_context.coefficient_rows()
            {
                let out_row = &mut base_store[base_idx..];

                for ((output, coefficient), coefficient_state) in
                    out_row.iter_mut().zip(coefficients).zip(coefficient_states)
                {
                    *output = coefficient.reconstructed(coefficient_state, irreversible);
                    *output *= dequantization_step;
                }

                base_idx += sub_band.rect.width() as usize;
            }
        }
    }

    Ok(())
}

/// shl patch 5: decode the HT code-blocks of one sub-band (T.814 clause 7) into hayro's
/// coefficient buffer.
///
/// The block decoder returns sign-magnitude samples with bitplane `b` at bit
/// `31 - Mb + b` and a half-bin bit one plane below each sample's last decoded plane, so:
/// - reversible: `magnitude >> (31 - Mb)` is the integer coefficient when every plane was
///   decoded, and already includes the mid-point `2^(bp-1)` when the lowest `bp` planes
///   were not, which is what `Coefficient::reconstructed` gives for Part 1 blocks;
/// - irreversible: `magnitude · 2^-(31 - Mb)` is the coefficient plus the mid-point, as
///   `reconstructed` gives with `irreversible` set (E-6).
///
/// Errors are `HtUnsupported`, so the caller can try another decoder.
fn decode_ht_sub_band(
    sub_band_idx: usize,
    num_bitplanes: u8,
    dequantization_step: f32,
    irreversible: bool,
    vertically_causal: bool,
    tile_ctx: &mut TileDecodeContext,
    storage: &mut DecompositionStorage<'_>,
) -> Result<()> {
    use super::ht::{BlockPasses, decode_block};

    let sub_band = &storage.sub_bands[sub_band_idx];
    let band_width = sub_band.rect.width() as usize;
    let k = u32::from(num_bitplanes);
    let shift = 31_u32.saturating_sub(k);
    // 2^-shift, exactly.
    let scale = f32::from_bits((127 - shift) << 23) * dequantization_step;

    for precinct in sub_band.precincts.clone().map(|idx| &storage.precincts[idx]) {
        for code_block in precinct.code_blocks.clone().map(|idx| &storage.code_blocks[idx]) {
            let (w, h) = (code_block.rect.width() as usize, code_block.rect.height() as usize);
            if w == 0 || h == 0 {
                continue;
            }
            let x_offset = (code_block.rect.x0 - sub_band.rect.x0) as usize;
            let y_offset = (code_block.rect.y0 - sub_band.rect.y0) as usize;
            let band = &mut storage.coefficients[sub_band.coefficients.clone()];
            let rows = band[y_offset * band_width + x_offset..]
                .chunks_mut(band_width)
                .take(h)
                .map(|row| &mut row[..w]);

            // Gather the cleanup segment, then the refinement segment.
            let coded = &mut tile_ctx.ht_coded;
            coded.clear();
            let mut len_cleanup = 0;
            for idx in [0, 1] {
                for layer in &storage.layers[code_block.layers.clone()] {
                    for segment in layer.segments.clone().map(|r| &storage.segments[r]).unwrap_or(&[]) {
                        if segment.idx == idx {
                            coded.extend_from_slice(segment.data);
                        }
                    }
                }
                if idx == 0 {
                    len_cleanup = coded.len();
                }
            }
            let passes = u32::from(code_block.number_of_coding_passes);

            let cleanup_pass = match code_block.ht_cleanup_pass {
                Some(c) if passes > u32::from(c) && len_cleanup > 0 => u32::from(c),
                // Not included, placeholder passes only, or an empty cleanup segment: zero.
                _ => {
                    for row in rows {
                        row.fill(0.0);
                    }
                    continue;
                }
            };
            let missing_msbs = u32::from(code_block.missing_bit_planes) + cleanup_pass / 3;
            if k > 31 || missing_msbs >= k {
                bail!(DecodingError::HtUnsupported);
            }
            // decode_block writes every sample of the block (its tests check this on a
            // buffer filled with junk), so the buffer is only resized, not cleared.
            let samples = &mut tile_ctx.ht_samples;
            samples.resize(w * h, 0);
            #[cfg(feature = "ht-reference")]
            super::ht::reference::record(coded, w, h, missing_msbs, passes - cleanup_pass, len_cleanup, vertically_causal);
            decode_block(
                &mut tile_ctx.ht_scratch,
                coded,
                samples,
                w,
                h,
                w,
                missing_msbs,
                &BlockPasses {
                    num_passes: passes - cleanup_pass,
                    len_cleanup,
                    len_refinement: coded.len() - len_cleanup,
                },
                vertically_causal,
            )
            .map_err(|_| DecodingError::HtUnsupported)?;

            for (row, src) in rows.zip(samples.chunks_exact(w)) {
                if irreversible {
                    for (out, &sm) in row.iter_mut().zip(src) {
                        let v = (sm & 0x7FFF_FFFF) as f32 * scale;
                        *out = if sm >> 31 != 0 { -v } else { v };
                    }
                } else {
                    for (out, &sm) in row.iter_mut().zip(src) {
                        let v = ((sm & 0x7FFF_FFFF) >> shift) as f32 * dequantization_step;
                        *out = if sm >> 31 != 0 { -v } else { v };
                    }
                }
            }
        }
    }

    Ok(())
}

fn apply_sign_shift(channel_data: &mut [ComponentData], component_infos: &[ComponentInfo]) {
    use crate::math::{Level, dispatch, f32x8};

    for (channel, component_info) in channel_data.iter_mut().zip(component_infos.iter()) {
        let offset = (1_u32 << (component_info.size_info.precision - 1)) as f32;
        dispatch!(Level::new(), simd => {
            let offset_v = f32x8::splat(simd, offset);
            for chunk in channel.container.chunks_exact_mut(8) {
                let v = f32x8::from_slice(simd, chunk);
                (v + offset_v).store(chunk);
            }
        });
    }
}

fn store<'a>(
    tile: &'a Tile<'a>,
    header: &Header<'_>,
    tile_ctx: &mut TileDecodeContext,
    channel_data: &mut ComponentData,
    component_info: &ComponentInfo,
    // shl patch 8: the DC level shift to add while storing, if `apply_sign_shift` is skipped.
    offset: Option<f32>,
    // shl patch 8: the tile is the only one.
    sole_tile: bool,
) {
    let idwt_output = &mut tile_ctx.idwt_output;

    // shl patch 8: when the IDWT output is exactly the image (one tile, no sub-sampling or
    // reduced resolution, output rectangle = image area), the copy below would reproduce it
    // sample for sample; take the buffer instead and add the offset in place.
    let size = &header.size_data;
    if sole_tile
        && header.skipped_resolution_levels == 0
        && component_info.size_info.horizontal_resolution == 1
        && component_info.size_info.vertical_resolution == 1
        && idwt_output.rect.x0 == size.image_area_x_offset
        && idwt_output.rect.y0 == size.image_area_y_offset
        && idwt_output.rect.width() == size.image_width()
        && idwt_output.rect.height() == size.image_height()
    {
        if channel_data.container.swap_in(&mut idwt_output.coefficients) {
            if let Some(offset) = offset {
                let n = channel_data.container.truncated().len();
                for v in &mut channel_data.container[..n] {
                    *v += offset;
                }
            }
            return;
        }
    }

    // shl patch 10: at a reduced resolution a small tile can be empty; nothing to store.
    if header.skipped_resolution_levels > 0 && (idwt_output.rect.width() == 0 || idwt_output.rect.height() == 0) {
        return;
    }

    let component_tile = ComponentTile::new(tile, component_info);
    let resolution_tile = ResolutionTile::new(
        component_tile,
        component_info.num_resolution_levels() - 1 - header.skipped_resolution_levels,
    );

    let (scale_x, scale_y) = (
        component_info.size_info.horizontal_resolution,
        component_info.size_info.vertical_resolution,
    );

    let (image_x_offset, image_y_offset) = (
        header.size_data.image_area_x_offset,
        header.size_data.image_area_y_offset,
    );

    if scale_x == 1 && scale_y == 1 {
        // If no sub-sampling, use a fast path where we copy rows of coefficients
        // at once.

        // The rect of the IDWT output corresponds to the rect of the highest
        // decomposition level of the tile, which is usually not 1:1 aligned
        // with the actual tile rectangle. We also need to account for the
        // offset of the reference grid.

        let skip_x = image_x_offset.saturating_sub(idwt_output.rect.x0);
        let skip_y = image_y_offset.saturating_sub(idwt_output.rect.y0);

        let input_row_iter = idwt_output
            .coefficients
            .chunks_exact(idwt_output.rect.width() as usize)
            .skip(skip_y as usize)
            .take(idwt_output.rect.height() as usize);

        let output_row_iter = channel_data
            .container
            .chunks_exact_mut(header.size_data.image_width() as usize)
            .skip(resolution_tile.rect.y0.saturating_sub(image_y_offset) as usize);

        for (input_row, output_row) in input_row_iter.zip(output_row_iter) {
            let input_row = &input_row[skip_x as usize..];
            let output_row = &mut output_row
                [resolution_tile.rect.x0.saturating_sub(image_x_offset) as usize..]
                [..input_row.len()];

            match offset {
                Some(offset) => {
                    for (o, &i) in output_row.iter_mut().zip(input_row) {
                        *o = i + offset;
                    }
                }
                None => output_row.copy_from_slice(input_row),
            }
        }
    } else {
        let image_width = header.size_data.image_width();
        let image_height = header.size_data.image_height();

        let x_shrink_factor = header.size_data.x_shrink_factor;
        let y_shrink_factor = header.size_data.y_shrink_factor;

        let x_offset = header
            .size_data
            .image_area_x_offset
            .div_ceil(x_shrink_factor);
        let y_offset = header
            .size_data
            .image_area_y_offset
            .div_ceil(y_shrink_factor);

        // shl patch 10: at a reduced resolution the IDWT output covers the resolution tile, not
        // the full-size component tile, so index it from its own origin (the same origin at
        // full resolution, where this path is unchanged).
        let (origin_x, origin_y) = if header.skipped_resolution_levels > 0 {
            (idwt_output.rect.x0, idwt_output.rect.y0)
        } else {
            (component_tile.rect.x0, component_tile.rect.y0)
        };

        // Otherwise, copy sample by sample.
        for y in resolution_tile.rect.y0..resolution_tile.rect.y1 {
            let relative_y = (y - origin_y) as usize;
            let reference_grid_y = (scale_y as u32 * y) / y_shrink_factor;

            for x in resolution_tile.rect.x0..resolution_tile.rect.x1 {
                let relative_x = (x - origin_x) as usize;
                let reference_grid_x = (scale_x as u32 * x) / x_shrink_factor;

                let sample = idwt_output.coefficients
                    [relative_y * idwt_output.rect.width() as usize + relative_x]
                    + offset.unwrap_or(0.0);

                for x_position in u32::max(reference_grid_x, x_offset)
                    ..u32::min(reference_grid_x + scale_x as u32, image_width + x_offset)
                {
                    for y_position in u32::max(reference_grid_y, y_offset)
                        ..u32::min(reference_grid_y + scale_y as u32, image_height + y_offset)
                    {
                        let pos = (y_position - y_offset) as usize * image_width as usize
                            + (x_position - x_offset) as usize;

                        channel_data.container[pos] = sample;
                    }
                }
            }
        }
    }
}
