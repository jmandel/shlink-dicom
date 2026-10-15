//! HT block decoder: cleanup, `SigProp` and `MagRef` passes (T.814 §7).
//!
//! Ported from `OpenJPH` `ojph_block_decoder32.cpp` (BSD-2-Clause). The
//! decoder writes **sign-magnitude** samples: bit 31 is the sign, and a
//! sample significant in the cleanup pass holds `mu << p | 1 << (p - 1)`
//! (magnitude plus half the quantization bin), where `p = 30 - missing_msbs`
//! is the cleanup pass's least significant bitplane. Use
//! [`super::sign_magnitude_to_coeff`] to map decoded samples back to `i32`
//! coefficients.
//!
//! Unlike the original — which deliberately over-reads its (padded) buffers —
//! every read here is bounds-checked, and every sample store is guarded so a
//! malformed codestream can never write outside `out[..height x stride]`.

extern crate alloc;

use alloc::vec::Vec;

use super::{Error, Result};

use super::BlockPasses;
use super::mel::MelDecoder;
use super::streams::{FwdReader, LocalBits, RevReader};
use super::tables::{DEC_VLC_TBL0, DEC_VLC_TBL1, UVLC_TBL0, UVLC_TBL1};

/// Neighbor-propagation masks for the `SigProp` membership scan, indexed by
/// the row (0..=3) of the sample that just became significant.
const SPP_PROPAGATION: [u32; 4] = [0x33, 0x76, 0xEC, 0xC8];

/// Sanity bound on `Scup` from T.814 (`scup <= 4079`).
const MAX_SCUP: usize = 4079;

/// Scratch buffers reused across code-blocks (shl patch: ndic allocates them per block).
#[derive(Default)]
pub(crate) struct HtScratch {
    scratch: Vec<u16>,
    v_n: Vec<u32>,
    prev_row_sig: Vec<u16>,
    dummy: Vec<u32>,
}

/// Clear `v` and resize it to `n` zeros, keeping its allocation.
fn zeroed<T: Copy + Default>(v: &mut Vec<T>, n: usize) -> &mut [T] {
    v.clear();
    v.resize(n, T::default());
    v
}

fn malformed(offset: usize, message: &str) -> Error {
    Error::Codestream {
        offset,
        message: message.into(),
    }
}

/// Decodes one HT code-block into sign-magnitude samples.
///
/// * `coded` — the codeword segment: cleanup bytes (`passes.len_cleanup`)
///   followed by refinement bytes (`passes.len_refinement`).
/// * `out` — destination, row-major with `stride`; fully overwritten for the
///   `width x height` block.
/// * `missing_msbs` — number of missing magnitude bit-planes signaled in the
///   packet header; the cleanup LSB is `p = 30 - missing_msbs`.
/// * `stripe_causal` — the `SPcod` vertically-causal context flag.
///
/// # Errors
/// [`Error::Codestream`] on malformed input; never panics.
#[allow(clippy::too_many_lines, clippy::too_many_arguments)] // faithful port
#[allow(clippy::similar_names, clippy::many_single_char_names)] // T.814 names
pub(crate) fn decode_block(
    scratch_bufs: &mut HtScratch,
    coded: &[u8],
    out: &mut [u32],
    width: usize,
    height: usize,
    stride: usize,
    missing_msbs: u32,
    passes: &BlockPasses,
    stripe_causal: bool,
) -> Result<()> {
    let mut num_passes = passes.num_passes;
    let lengths1 = passes.len_cleanup;
    let lengths2 = passes.len_refinement;

    // ---- geometry & argument validation -------------------------------
    if width == 0 || height == 0 || width > 1024 || height > 1024 {
        return Err(Error::InvalidArgument {
            message: "code-block dimensions must be 1..=1024".into(),
        });
    }
    if width * height > 4096 {
        return Err(Error::InvalidArgument {
            message: "code-block area must be <= 4096 samples (T.800 §B.7)".into(),
        });
    }
    if stride < width || out.len() < (height - 1) * stride + width {
        return Err(Error::InvalidArgument {
            message: "output buffer too small for code-block geometry".into(),
        });
    }

    // ---- pass / precision validation (mirrors OpenJPH's guards) -------
    if num_passes > 1 && lengths2 == 0 {
        num_passes = 1; // malformed: refinement passes with no bytes
    }
    if num_passes > 3 {
        return Err(malformed(0, "more than 3 coding passes"));
    }
    if missing_msbs >= 30 {
        return Err(malformed(0, "missing MSBs >= 30: not decodable in 32 bits"));
    }
    if missing_msbs == 29 {
        num_passes = 1; // not enough precision for SigProp/MagRef
    }
    let p = 30 - missing_msbs;

    if lengths1 < 2 || lengths1 > coded.len() || lengths1 + lengths2 > coded.len() {
        return Err(malformed(0, "invalid code-block pass lengths"));
    }

    let lcup = lengths1;
    let scup = (usize::from(coded[lcup - 1]) << 4) + usize::from(coded[lcup - 2] & 0xF);
    if scup < 2 || scup > lcup || scup > MAX_SCUP {
        return Err(malformed(lcup - 2, "invalid Scup interface word"));
    }

    // ---- scratch buffers ----------------------------------------------
    // Two u16 entries per quad: `inf` (e_k<<12 | e_1<<8 | rho<<4 | len) and
    // `u_q`. One extra quad row absorbs the terminator writes of the last
    // row, mirroring the reference layout.
    let sstr = (width + 2 + 7) & !7;
    let quad_rows = height.div_ceil(2);
    // The same buffer is later re-packed in place into the `sigma` column
    // layout used by SigProp/MagRef (one u16 = 4 columns x 4 rows).
    let mstr = (width.div_ceil(4) + 2 + 7) & !7;
    let sig_rows = height.div_ceil(4);
    let scratch_len = ((quad_rows + 1) * sstr + 8).max((sig_rows + 1) * mstr + 8);
    let HtScratch { scratch, v_n: v_n_buf, prev_row_sig: prev_row_sig_buf, dummy } = scratch_bufs;
    let scratch = zeroed(scratch, scratch_len);

    let mmsbp2 = missing_msbs + 2;

    // ---- step 1: decode the VLC + MEL segments
    // (shl patch 5: the table indices are masked to the table sizes, 1024 and 256, which
    // they never exceed (c_q < 0x400, uvlc_mode <= 0xC0); the masks only let the compiler
    // drop the bounds checks.) ------------------------
    {
        let mut mel = MelDecoder::new(coded, lcup, scup);
        let mut vlc = RevReader::new_vlc(coded, lcup, scup);
        // shl patch 5: the VLC bit buffer in locals (see `LocalBits`).
        let mut vb = LocalBits::new(&vlc);

        let mut run = mel.get_run();

        // Initial row of quads (kappa = 1).
        let mut c_q: u32 = 0;
        let mut idx = 0usize;
        let mut x = 0usize;
        while x < width {
            // First quad of the pair.
            let vlc_val = vb.fetch(&mut vlc);
            let mut t0 = u32::from(DEC_VLC_TBL0[((c_q | (vlc_val & 0x7F)) & 0x3FF) as usize]);
            if c_q == 0 {
                // Zero context: quad significance comes from a MEL event.
                run -= 2;
                t0 = if run == -1 { t0 } else { 0 };
                if run < 0 {
                    run = mel.get_run();
                }
            }
            scratch[idx] = to_u16(t0);
            x += 2;

            // Context for the second quad (T.814 eq. 1).
            c_q = ((t0 & 0x10) << 3) | ((t0 & 0xE0) << 2);
            let vlc_val = vb.advance(t0 & 0x7);

            let mut t1 = u32::from(DEC_VLC_TBL0[((c_q | (vlc_val & 0x7F)) & 0x3FF) as usize]);
            if c_q == 0 && x < width {
                run -= 2;
                t1 = if run == -1 { t1 } else { 0 };
                if run < 0 {
                    run = mel.get_run();
                }
            }
            if x >= width {
                t1 = 0;
            }
            scratch[idx + 2] = to_u16(t1);
            x += 2;

            c_q = ((t1 & 0x10) << 3) | ((t1 & 0xE0) << 2);
            let vlc_val = vb.advance(t1 & 0x7);

            // u values for the pair (kappa = 1 on the initial row).
            let mut uvlc_mode = ((t0 & 0x8) << 3) | ((t1 & 0x8) << 4);
            if uvlc_mode == 0xC0 {
                // Both u offsets set: a MEL event signals min(u0, u1) > 2.
                run -= 2;
                uvlc_mode += if run == -1 { 0x40 } else { 0 };
                if run < 0 {
                    run = mel.get_run();
                }
            }
            let mut uvlc_entry = u32::from(UVLC_TBL0[(uvlc_mode + (vlc_val & 0x3F)) as usize]);
            let vlc_val = vb.advance(uvlc_entry & 0x7);
            uvlc_entry >>= 3;
            let len = uvlc_entry & 0xF;
            let tmp = vlc_val & ((1 << len) - 1);
            vb.advance(len);
            uvlc_entry >>= 4;
            let len0 = uvlc_entry & 0x7;
            uvlc_entry >>= 3;
            scratch[idx + 1] = to_u16(1 + (uvlc_entry & 7) + (tmp & !(0xFF << len0)));
            scratch[idx + 3] = to_u16(1 + (uvlc_entry >> 3) + (tmp >> len0));
            idx += 4;
        }
        scratch[idx] = 0;
        scratch[idx + 1] = 0;

        // Non-initial rows of quads.
        let mut y = 2usize;
        while y < height {
            let base = (y >> 1) * sstr;
            let above = base - sstr;
            let mut c_q: u32 = 0;
            let mut idx = 0usize;
            let mut x = 0usize;
            while x < width {
                // sigma of the n, ne, nf neighbors (T.814 eq. 2).
                c_q |= (u32::from(scratch[above + idx]) & 0xA0) << 2;
                c_q |= (u32::from(scratch[above + idx + 2]) & 0x20) << 4;

                let vlc_val = vb.fetch(&mut vlc);
                let mut t0 = u32::from(DEC_VLC_TBL1[((c_q | (vlc_val & 0x7F)) & 0x3FF) as usize]);
                if c_q == 0 {
                    run -= 2;
                    t0 = if run == -1 { t0 } else { 0 };
                    if run < 0 {
                        run = mel.get_run();
                    }
                }
                scratch[base + idx] = to_u16(t0);
                x += 2;

                // sigma of w, sw / nw / n, ne, nf for the second quad.
                c_q = ((t0 & 0x40) << 2) | ((t0 & 0x80) << 1);
                c_q |= u32::from(scratch[above + idx]) & 0x80;
                c_q |= (u32::from(scratch[above + idx + 2]) & 0xA0) << 2;
                c_q |= (u32::from(scratch[above + idx + 4]) & 0x20) << 4;
                let vlc_val = vb.advance(t0 & 0x7);

                let mut t1 = u32::from(DEC_VLC_TBL1[((c_q | (vlc_val & 0x7F)) & 0x3FF) as usize]);
                if c_q == 0 && x < width {
                    run -= 2;
                    t1 = if run == -1 { t1 } else { 0 };
                    if run < 0 {
                        run = mel.get_run();
                    }
                }
                if x >= width {
                    t1 = 0;
                }
                scratch[base + idx + 2] = to_u16(t1);
                x += 2;

                c_q = ((t1 & 0x40) << 2) | ((t1 & 0x80) << 1);
                c_q |= u32::from(scratch[above + idx + 2]) & 0x80;
                let vlc_val = vb.advance(t1 & 0x7);

                // u values (kappa is applied later, in the MagSgn step).
                let uvlc_mode = ((t0 & 0x8) << 3) | ((t1 & 0x8) << 4);
                let mut uvlc_entry = u32::from(UVLC_TBL1[((uvlc_mode + (vlc_val & 0x3F)) & 0xFF) as usize]);
                let vlc_val = vb.advance(uvlc_entry & 0x7);
                uvlc_entry >>= 3;
                let len = uvlc_entry & 0xF;
                let tmp = vlc_val & ((1 << len) - 1);
                vb.advance(len);
                uvlc_entry >>= 4;
                let len0 = uvlc_entry & 0x7;
                uvlc_entry >>= 3;
                scratch[base + idx + 1] = to_u16((uvlc_entry & 7) + (tmp & !(0xFF << len0)));
                scratch[base + idx + 3] = to_u16((uvlc_entry >> 3) + (tmp >> len0));
                idx += 4;
            }
            scratch[base + idx] = 0;
            scratch[base + idx + 1] = 0;
            y += 2;
        }
    }

    // ---- step 2: decode the MagSgn segment ----------------------------
    {
        // Exponent bookkeeping: v_n of the bottom sample of column pairs
        // (2k-1, 2k), used as the E-max context of the quad row below.
        let v_n_scratch = zeroed(v_n_buf, width / 2 + 4);
        let mut magsgn = FwdReader::<0xFF>::new(&coded[..lcup - scup]);

        // Decode one sample if its rho bit is set; returns (value, v_n).
        // Bits are always consumed, but the caller guards the store.
        // shl patch 5: the reader's bit buffer is kept in the locals `acc`/`nb` (registers)
        // and the reader is touched only to refill it, exactly as `fetch` would.
        let (mut acc, mut nb) = magsgn.buffer();

        // shl patch 5: the quad-pair rows go through `magsgn_rows`, which writes through row
        // slices (no per-sample index checks); the arithmetic and the order of reads from the
        // MagSgn stream are those of ndic's loops. A missing bottom row (odd height) is
        // decoded into `dummy` and dropped, as ndic decodes and does not store it.
        let mut y = 0usize;
        while y < height {
            let quads = &scratch[(y >> 1) * sstr..];
            let out_len = out.len();
            let (top, rest) = out[y * stride..].split_at_mut(stride.min(out_len - y * stride));
            let bottom: &mut [u32] = if y + 1 < height { &mut rest[..width] } else { zeroed(dummy, width) };
            magsgn_rows(
                &mut magsgn,
                &mut acc,
                &mut nb,
                &mut top[..width],
                bottom,
                quads,
                v_n_scratch,
                y == 0,
                mmsbp2,
                p,
            )?;
            y += 2;
        }
    }

    if num_passes < 2 {
        return Ok(());
    }

    // ---- re-pack quad significance into the column-oriented sigma map --
    // Each u16 covers 4 columns x 4 rows; bit (4*col + row) is sigma.
    {
        let mut y = 0usize;
        while y < height {
            let sp = (y >> 1) * sstr;
            let dpi = (y >> 2) * mstr;
            let mut sx = 0usize;
            let mut dx = 0usize;
            let mut x = 0usize;
            while x < width {
                let s0 = u32::from(scratch[sp + sx]);
                let s2 = u32::from(scratch[sp + sx + 2]);
                let s0b = u32::from(scratch[sp + sstr + sx]);
                let s2b = u32::from(scratch[sp + sstr + sx + 2]);
                let t0 = ((s0 & 0x30) >> 4)
                    | ((s0 & 0xC0) >> 2)
                    | ((s2 & 0x30) << 4)
                    | ((s2 & 0xC0) << 6);
                let t1 =
                    ((s0b & 0x30) >> 2) | (s0b & 0xC0) | ((s2b & 0x30) << 6) | ((s2b & 0xC0) << 8);
                scratch[dpi + dx] = to_u16(t0 | t1);
                sx += 4;
                dx += 1;
                x += 4;
            }
            scratch[dpi + dx] = 0;
            y += 4;
        }
        // One zeroed row below the block.
        let dpi = height.div_ceil(4) * mstr;
        let groups = width.div_ceil(4);
        for e in &mut scratch[dpi..=dpi + groups] {
            *e = 0;
        }
    }

    // ---- Significance Propagation pass --------------------------------
    {
        let groups = width.div_ceil(4);
        let prev_row_sig = zeroed(prev_row_sig_buf, groups + 2);
        let mut sigprop = FwdReader::<0>::new(&coded[lcup..lcup + lengths2]);

        let mut y = 0usize;
        while y < height {
            let mut pattern: u32 = match height - y {
                1 => 0x1111,
                2 => 0x3333,
                3 => 0x7777,
                _ => 0xFFFF,
            };

            let mut prev: u32 = 0;
            let cur_base = (y >> 2) * mstr;
            let dpp = y * stride;
            let mut gi = 0usize;
            let mut x = 0usize;
            while x < width {
                // Truncate the pattern for a partial rightmost group.
                let overhang = (x + 4).saturating_sub(width);
                pattern >>= overhang * 4;

                let ps = u32::from(prev_row_sig[gi]) | (u32::from(prev_row_sig[gi + 1]) << 16);
                let ns = u32::from(scratch[cur_base + mstr + gi])
                    | (u32::from(scratch[cur_base + mstr + gi + 1]) << 16);
                let cs = u32::from(scratch[cur_base + gi])
                    | (u32::from(scratch[cur_base + gi + 1]) << 16);

                let mut u = (ps & 0x8888_8888) >> 3; // row above the stripe
                if !stripe_causal {
                    u |= (ns & 0x1111_1111) << 3; // row below the stripe
                }

                // Candidate members: neighbors of significant samples.
                let mut mbr = cs;
                mbr |= (cs & 0x7777_7777) << 1;
                mbr |= (cs & 0xEEEE_EEEE) >> 1;
                mbr |= u;
                let t = mbr;
                mbr |= t << 4;
                mbr |= t >> 4;
                mbr |= prev >> 12;
                mbr &= pattern;
                mbr &= !cs;

                let mut new_sig = mbr;
                if new_sig != 0 {
                    let mut cwd = sigprop.fetch();
                    let mut cnt = 0u32;
                    let inv_sig = !cs & pattern;

                    let mut col_mask = 0xFu32;
                    let mut i = 0u32;
                    while i < 16 {
                        if (col_mask & new_sig) != 0 {
                            let mut sample_mask = 0x1111 & col_mask;
                            for row in 0..4u32 {
                                if new_sig & sample_mask != 0 {
                                    new_sig &= !sample_mask;
                                    if cwd & 1 != 0 {
                                        let t = SPP_PROPAGATION[row as usize] << i;
                                        new_sig |= t & inv_sig;
                                    }
                                    cwd >>= 1;
                                    cnt += 1;
                                }
                                sample_mask <<= 1;
                            }
                        }
                        col_mask <<= 4;
                        i += 4;
                    }

                    if new_sig != 0 {
                        // Read the sign bits of newly significant samples.
                        let val = 3 << (p - 2);
                        let mut col_mask = 0xFu32;
                        for col in 0..4usize {
                            if (col_mask & new_sig) != 0 {
                                let mut sample_mask = 0x1111 & col_mask;
                                for row in 0..4usize {
                                    if new_sig & sample_mask != 0 {
                                        out[dpp + x + col + row * stride] = (cwd << 31) | val;
                                        cwd >>= 1;
                                        cnt += 1;
                                    }
                                    sample_mask <<= 1;
                                }
                            }
                            col_mask <<= 4;
                        }
                    }
                    sigprop.advance(cnt);
                }

                new_sig |= cs;
                prev_row_sig[gi] = to_u16(new_sig & 0xFFFF);

                // Carry for the next group: this group's rightmost column.
                let t = new_sig;
                new_sig |= (t & 0x7777) << 1;
                new_sig |= (t & 0xEEEE) >> 1;
                prev = (new_sig | u) & 0xF000;

                gi += 1;
                x += 4;
            }
            y += 4;
        }
    }

    if num_passes < 3 {
        return Ok(());
    }

    // ---- Magnitude Refinement pass ------------------------------------
    {
        let mut magref = RevReader::new_mrp(coded, lcup, lengths2);
        let half = 1u32 << (p - 2);

        let mut y = 0usize;
        while y < height {
            let cur_base = (y >> 2) * mstr;
            let dpp = y * stride;
            let mut gi = 0usize;
            let mut i = 0usize;
            while i < width {
                let cwd_start = magref.fetch();
                let mut cwd = cwd_start;
                let sig = u32::from(scratch[cur_base + gi])
                    | (u32::from(scratch[cur_base + gi + 1]) << 16);
                if sig != 0 {
                    let mut col_mask = 0xFu32;
                    for j in 0..8usize {
                        if sig & col_mask != 0 {
                            let mut sample_mask = 0x1111_1111 & col_mask;
                            for k in 0..4usize {
                                if sig & sample_mask != 0 {
                                    // Refine bitplane p-1 of a cleanup-
                                    // significant sample.
                                    if i + j < width && y + k < height {
                                        let sym = ((1 - (cwd & 1)) << (p - 1)) | half;
                                        out[dpp + i + j + k * stride] ^= sym;
                                    }
                                    cwd >>= 1;
                                }
                                sample_mask <<= 1;
                            }
                        }
                        col_mask <<= 4;
                    }
                }
                magref.advance(sig.count_ones());
                gi += 2;
                i += 8;
            }
            y += 4;
        }
    }

    Ok(())
}

#[inline(always)]
fn decode_sample(
    magsgn: &mut FwdReader<'_, 0xFF>,
    acc: &mut u64,
    nb: &mut u32,
    inf: u32,
    bit: u32,
    u_q: u32,
    p: u32,
) -> (u32, u32) {
    if inf & (1 << (4 + bit)) == 0 {
        return (0, 0);
    }
    if *nb < 32 {
        (*acc, *nb) = magsgn.top_up(*acc, *nb);
    }
    #[allow(clippy::cast_possible_truncation)]
    let ms_val = *acc as u32;
    let m_n = u_q - ((inf >> (12 + bit)) & 1);
    *acc >>= m_n;
    *nb = nb.saturating_sub(m_n);
    sample_value(ms_val, m_n, inf, bit, p)
}

/// The sample value and v_n from the MagSgn bits `ms_val` (bit 0 the sign, then the
/// magnitude bits) of a significant sample.
#[inline(always)]
fn sample_value(ms_val: u32, m_n: u32, inf: u32, bit: u32, p: u32) -> (u32, u32) {
    let mut v_n = ms_val & ((1u32 << m_n) - 1);
    v_n |= ((inf >> (8 + bit)) & 1) << m_n;
    v_n |= 1; // half the bin, for mid-point reconstruction
    // Wrapping like the reference's u32 arithmetic: a malformed
    // stream may produce out-of-range v_n, never a panic.
    let val = (ms_val << 31) | v_n.wrapping_add(2).wrapping_shl(p - 1);
    (val, v_n)
}


/// shl patch 5: MagSgn decoding of one row of quads (two sample rows), as ndic's loops: the
/// first quad row (`initial`, kappa = 1) or a later one (kappa from `v_n_scratch`, the
/// exponents of the row above). Writes `v_n_scratch` in place for the next row.
#[allow(clippy::too_many_arguments)]
#[inline(always)]
fn magsgn_rows(
    magsgn: &mut FwdReader<'_, 0xFF>,
    acc: &mut u64,
    nb: &mut u32,
    top: &mut [u32],
    bottom: &mut [u32],
    quads: &[u16],
    v_n_scratch: &mut [u32],
    initial: bool,
    mmsbp2: u32,
    p: u32,
) -> Result<()> {
    let nq = top.len().div_ceil(2);
    let mut prev_v_n = 0u32;
    for (q, ((t, b), qd)) in top
        .chunks_mut(2)
        .zip(bottom.chunks_mut(2))
        .zip(quads.chunks_exact(2))
        .enumerate()
    {
        let inf = u32::from(qd[0]);
        let mut u_q = u32::from(qd[1]);
        if !initial {
            // kappa (T.814 eq. 5): 1 unless the quad has two or more
            // significant samples and the row above saw larger exponents.
            let mut gamma = inf & 0xF0;
            gamma &= gamma.wrapping_sub(0x10);
            let emax = v_n_scratch[q] | v_n_scratch[q + 1];
            let emax = 31 - (emax | 2).leading_zeros(); // E_max - 1
            u_q += if gamma != 0 { emax } else { 1 };
        }
        if u_q > mmsbp2 {
            return Err(malformed(0, "U_q exceeds the magnitude bound"));
        }
        let (val, _) = decode_sample(magsgn, acc, nb, inf, 0, u_q, p);
        t[0] = val;
        let (val, v_n) = decode_sample(magsgn, acc, nb, inf, 1, u_q, p);
        b[0] = val;
        v_n_scratch[q] = prev_v_n | v_n;
        prev_v_n = 0;
        if t.len() < 2 {
            break;
        }
        let (val, _) = decode_sample(magsgn, acc, nb, inf, 2, u_q, p);
        t[1] = val;
        let (val, v_n) = decode_sample(magsgn, acc, nb, inf, 3, u_q, p);
        b[1] = val;
        prev_v_n = v_n;
    }
    v_n_scratch[nq] = prev_v_n;
    Ok(())
}

/// Narrows an in-range `u32` scratch word to `u16`.
#[inline]
#[allow(clippy::cast_possible_truncation)]
fn to_u16(v: u32) -> u16 {
    debug_assert!(u16::try_from(v).is_ok());
    v as u16
}
