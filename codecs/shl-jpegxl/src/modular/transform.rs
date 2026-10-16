//! Modular transforms (ISO/IEC 18181-1 H.6): reversible colour transforms, palette and squeeze.

use super::tree::Predictor;
use super::wp::{WpHeader, WpState};
use super::{Channel, ModularImage};
use crate::bits::{bits, bits_offset, val, BitReader};
use crate::error::{invalid, Error, Result};

#[derive(Clone, Copy, Debug)]
pub struct SqueezeParams {
    pub horizontal: bool,
    pub in_place: bool,
    pub begin_c: u32,
    pub num_c: u32,
}

#[derive(Clone, Debug)]
pub enum Transform {
    Rct { begin_c: u32, rct_type: u32 },
    Palette { begin_c: u32, num_c: u32, nb_colors: u32, nb_deltas: u32, predictor: Predictor },
    Squeeze { params: Vec<SqueezeParams> },
}

impl Transform {
    pub fn read(br: &mut BitReader) -> Result<Self> {
        let begin_dist = [bits(3), bits_offset(6, 8), bits_offset(10, 72), bits_offset(13, 1096)];
        match br.u32([val(0), val(1), val(2), val(3)]) {
            0 => {
                let begin_c = br.u32(begin_dist);
                let rct_type = br.u32([val(6), bits(2), bits_offset(4, 2), bits_offset(6, 10)]);
                if rct_type >= 42 {
                    return invalid("RCT type");
                }
                Ok(Transform::Rct { begin_c, rct_type })
            }
            1 => {
                let begin_c = br.u32(begin_dist);
                let num_c = br.u32([val(1), val(3), val(4), bits_offset(13, 1)]);
                let nb_colors = br.u32([bits_offset(8, 0), bits_offset(10, 256), bits_offset(12, 1280), bits_offset(16, 5376)]);
                let nb_deltas = br.u32([val(0), bits_offset(8, 1), bits_offset(10, 257), bits_offset(16, 1281)]);
                let p = br.read(4);
                let predictor = match Predictor::from_u32(p) {
                    Some(p) => p,
                    None => return invalid("palette predictor"),
                };
                Ok(Transform::Palette { begin_c, num_c, nb_colors, nb_deltas, predictor })
            }
            2 => {
                let n = br.u32([val(0), bits_offset(4, 1), bits_offset(6, 9), bits_offset(8, 41)]);
                let mut params = Vec::with_capacity(n as usize);
                for _ in 0..n {
                    let horizontal = br.bit();
                    let in_place = br.bit();
                    let begin_c = br.u32(begin_dist);
                    let num_c = br.u32([val(1), val(2), val(3), bits_offset(4, 4)]);
                    params.push(SqueezeParams { horizontal, in_place, begin_c, num_c });
                }
                Ok(Transform::Squeeze { params })
            }
            _ => invalid("transform id"),
        }
    }

    /// Updates the channel list for this transform (before decoding).
    pub fn meta_apply(&mut self, img: &mut ModularImage) -> Result<()> {
        match self {
            Transform::Rct { begin_c, .. } => check_equal(img, *begin_c as usize, *begin_c as usize + 2),
            Transform::Palette { begin_c, num_c, nb_colors, nb_deltas, .. } => {
                let b = *begin_c as usize;
                let e = b.checked_add(*num_c as usize).and_then(|v| v.checked_sub(1)).ok_or(Error::Invalid("palette range"))?;
                check_equal(img, b, e)?;
                let nb = e - b + 1;
                if b >= img.nb_meta {
                    img.nb_meta += 1;
                } else {
                    if e >= img.nb_meta {
                        return invalid("palette channel range");
                    }
                    img.nb_meta = img.nb_meta + 2 - nb;
                }
                img.channels.drain(b + 1..=e);
                let w = (*nb_colors as usize).checked_add(*nb_deltas as usize).ok_or(Error::Invalid("palette size"))?;
                img.channels.insert(0, Channel::new(w, nb, -1, -1)?);
                Ok(())
            }
            Transform::Squeeze { params } => {
                if params.is_empty() {
                    *params = default_squeeze(img)?;
                }
                for p in params.iter() {
                    meta_squeeze(img, p)?;
                }
                Ok(())
            }
        }
    }

    pub fn inverse(&self, img: &mut ModularImage, wp: &WpHeader) -> Result<()> {
        match self {
            Transform::Rct { begin_c, rct_type } => inv_rct(img, *begin_c as usize, *rct_type),
            Transform::Palette { begin_c, nb_colors, nb_deltas, predictor, .. } => {
                inv_palette(img, *begin_c as usize, *nb_colors, *nb_deltas, *predictor, wp)
            }
            Transform::Squeeze { params } => {
                for p in params.iter().rev() {
                    inv_squeeze(img, p)?;
                }
                Ok(())
            }
        }
    }
}

fn check_equal(img: &ModularImage, c1: usize, c2: usize) -> Result<()> {
    if c1 > img.channels.len() || c2 >= img.channels.len() || c2 < c1 {
        return invalid("transform channel range");
    }
    if c1 < img.nb_meta && c2 >= img.nb_meta {
        return invalid("transform mixes meta and non-meta channels");
    }
    let a = &img.channels[c1];
    for b in &img.channels[c1 + 1..=c2] {
        if a.w != b.w || a.h != b.h || a.hshift != b.hshift || a.vshift != b.vshift {
            return invalid("transform channels differ in size");
        }
    }
    Ok(())
}

fn default_squeeze(img: &ModularImage) -> Result<Vec<SqueezeParams>> {
    let first = img.nb_meta;
    let nb = img.channels.len().checked_sub(first).ok_or(Error::Invalid("squeeze"))?;
    let ch = img.channels.get(first).ok_or(Error::Invalid("squeeze without channels"))?;
    let (mut w, mut h) = (ch.w, ch.h);
    let mut out = Vec::new();
    if nb > 2 && img.channels[first + 1].w == w && img.channels[first + 1].h == h {
        out.push(SqueezeParams { horizontal: true, in_place: false, begin_c: first as u32 + 1, num_c: 2 });
        out.push(SqueezeParams { horizontal: false, in_place: false, begin_c: first as u32 + 1, num_c: 2 });
    }
    let base = SqueezeParams { horizontal: false, in_place: true, begin_c: first as u32, num_c: nb as u32 };
    if w <= h && h > 8 {
        out.push(base);
        h = h.div_ceil(2);
    }
    while w > 8 || h > 8 {
        if w > 8 {
            out.push(SqueezeParams { horizontal: true, ..base });
            w = w.div_ceil(2);
        }
        if h > 8 {
            out.push(SqueezeParams { horizontal: false, ..base });
            h = h.div_ceil(2);
        }
    }
    Ok(out)
}

fn squeeze_range(p: &SqueezeParams, n: usize) -> Result<(usize, usize)> {
    let b = p.begin_c as usize;
    let e = (b + p.num_c as usize).checked_sub(1).ok_or(Error::Invalid("squeeze range"))?;
    if b >= n || e >= n || p.num_c == 0 {
        return invalid("squeeze channel range");
    }
    Ok((b, e))
}

fn meta_squeeze(img: &mut ModularImage, p: &SqueezeParams) -> Result<()> {
    let (b, e) = squeeze_range(p, img.channels.len())?;
    if b < img.nb_meta {
        if e >= img.nb_meta {
            return invalid("squeeze mixes meta and non-meta channels");
        }
        if !p.in_place {
            return invalid("squeeze of meta channels must be in place");
        }
        img.nb_meta += p.num_c as usize;
    }
    let offset = if p.in_place { e + 1 } else { img.channels.len() };
    for c in b..=e {
        let ch = &mut img.channels[c];
        if ch.hshift > 30 || ch.vshift > 30 {
            return invalid("too many squeezes");
        }
        let (w, h) = (ch.w, ch.h);
        if w == 0 || h == 0 {
            return invalid("squeezing an empty channel");
        }
        let (rw, rh);
        if p.horizontal {
            ch.w = w.div_ceil(2);
            if ch.hshift >= 0 {
                ch.hshift += 1;
            }
            rw = w - w.div_ceil(2);
            rh = h;
        } else {
            ch.h = h.div_ceil(2);
            if ch.vshift >= 0 {
                ch.vshift += 1;
            }
            rw = w;
            rh = h - h.div_ceil(2);
        }
        let (hs, vs) = (ch.hshift, ch.vshift);
        ch.data = Vec::new();
        let at = offset + (c - b);
        if at > img.channels.len() {
            return invalid("squeeze residual position");
        }
        img.channels.insert(at, Channel::placeholder(rw, rh, hs, vs));
    }
    Ok(())
}

#[inline(always)]
fn smooth_tendency(b: i64, a: i64, n: i64) -> i64 {
    let mut diff = 0i64;
    if b >= a && a >= n {
        diff = (4 * b - 3 * n - a + 6) / 12;
        if diff - (diff & 1) > 2 * (b - a) {
            diff = 2 * (b - a) + 1;
        }
        if diff + (diff & 1) > 2 * (a - n) {
            diff = 2 * (a - n);
        }
    } else if b <= a && a <= n {
        diff = (4 * b - 3 * n - a - 6) / 12;
        if diff + (diff & 1) < 2 * (b - a) {
            diff = 2 * (b - a) - 1;
        }
        if diff - (diff & 1) < 2 * (a - n) {
            diff = 2 * (a - n);
        }
    }
    diff
}

fn inv_squeeze(img: &mut ModularImage, p: &SqueezeParams) -> Result<()> {
    let (b, e) = squeeze_range(p, img.channels.len())?;
    let offset = if p.in_place { e + 1 } else { img.channels.len() + b - e - 1 };
    if b < img.nb_meta {
        if img.nb_meta <= p.num_c as usize {
            return invalid("squeeze meta channels");
        }
        img.nb_meta -= p.num_c as usize;
    }
    for c in b..=e {
        let rc = offset + c - b;
        if rc >= img.channels.len() || rc == c {
            return invalid("squeeze residual channel");
        }
        {
            let (ch, res) = (&img.channels[c], &img.channels[rc]);
            if ch.w < res.w || ch.h < res.h {
                return invalid("corrupted squeeze transform");
            }
        }
        let out = if p.horizontal { unsqueeze_h(&img.channels[c], &img.channels[rc])? } else { unsqueeze_v(&img.channels[c], &img.channels[rc])? };
        img.channels[c] = out;
    }
    if offset + (e - b + 1) > img.channels.len() {
        return invalid("squeeze residual channels");
    }
    img.channels.drain(offset..offset + (e - b + 1));
    Ok(())
}

fn unsqueeze_h(ch: &Channel, res: &Channel) -> Result<Channel> {
    if ch.w != (ch.w + res.w).div_ceil(2) || ch.h != res.h {
        return invalid("squeeze residual size");
    }
    if res.w == 0 {
        let mut c = ch.clone();
        c.hshift -= 1;
        return Ok(c);
    }
    let w = ch.w + res.w;
    let mut out = Channel::new(w, ch.h, ch.hshift - 1, ch.vshift)?;
    if res.h == 0 {
        return Ok(out);
    }
    for y in 0..ch.h {
        let avg_row = &ch.data[y * ch.w..(y + 1) * ch.w];
        let res_row = &res.data[y * res.w..(y + 1) * res.w];
        let o = &mut out.data[y * w..(y + 1) * w];
        for x in 0..res.w {
            let avg = i64::from(avg_row[x]);
            let next_avg = if x + 1 < ch.w { i64::from(avg_row[x + 1]) } else { avg };
            let left = if x > 0 { i64::from(o[2 * x - 1]) } else { avg };
            let tendency = smooth_tendency(left, avg, next_avg);
            let diff = i64::from(res_row[x]) + tendency;
            let a = avg + diff / 2;
            o[2 * x] = a as i32;
            o[2 * x + 1] = (a - diff) as i32;
        }
        if w & 1 == 1 {
            o[w - 1] = avg_row[ch.w - 1];
        }
    }
    Ok(out)
}

fn unsqueeze_v(ch: &Channel, res: &Channel) -> Result<Channel> {
    if ch.h != (ch.h + res.h).div_ceil(2) || ch.w != res.w {
        return invalid("squeeze residual size");
    }
    if res.h == 0 {
        let mut c = ch.clone();
        c.vshift -= 1;
        return Ok(c);
    }
    let h = ch.h + res.h;
    let w = ch.w;
    let mut out = Channel::new(w, h, ch.hshift, ch.vshift - 1)?;
    if w == 0 {
        return Ok(out);
    }
    for y in 0..res.h {
        let avg_row = &ch.data[y * w..(y + 1) * w];
        let ny = if y + 1 < ch.h { y + 1 } else { y };
        let navg_row = &ch.data[ny * w..(ny + 1) * w];
        let res_row = &res.data[y * w..(y + 1) * w];
        let (above, below) = out.data.split_at_mut(2 * y * w);
        let top_row: &[i32] = if y > 0 { &above[(2 * y - 1) * w..2 * y * w] } else { avg_row };
        let (o0, o1) = below.split_at_mut(w);
        for x in 0..w {
            let avg = i64::from(avg_row[x]);
            let next_avg = i64::from(navg_row[x]);
            let top = i64::from(top_row[x]);
            let tendency = smooth_tendency(top, avg, next_avg);
            let diff = i64::from(res_row[x]) + tendency;
            let v = avg + diff / 2;
            o0[x] = v as i32;
            o1[x] = (v - diff) as i32;
        }
    }
    if h & 1 == 1 {
        let y = ch.h - 1;
        out.data[2 * y * w..(2 * y + 1) * w].copy_from_slice(&ch.data[y * w..(y + 1) * w]);
    }
    Ok(out)
}

fn inv_rct(img: &mut ModularImage, b: usize, rct_type: u32) -> Result<()> {
    check_equal(img, b, b + 2)?;
    if rct_type == 0 {
        return Ok(());
    }
    let permutation = (rct_type / 7) as usize;
    let custom = rct_type % 7;
    let n = img.channels[b].w * img.channels[b].h;
    if custom != 0 {
        let (c0, rest) = img.channels[b..b + 3].split_at_mut(1);
        let (c1, c2) = rest.split_at_mut(1);
        let (d0, d1, d2) = (&mut c0[0].data[..n], &mut c1[0].data[..n], &mut c2[0].data[..n]);
        if custom == 6 {
            for i in 0..n {
                let (y, co, cg) = (d0[i], d1[i], d2[i]);
                let tmp = y.wrapping_sub(cg >> 1);
                let g = cg.wrapping_add(tmp);
                let bb = tmp.wrapping_sub(co >> 1);
                let r = bb.wrapping_add(co);
                d0[i] = r;
                d1[i] = g;
                d2[i] = bb;
            }
        } else {
            let second = custom >> 1;
            let third = custom & 1;
            for i in 0..n {
                let first = d0[i];
                let mut s = d1[i];
                let mut t = d2[i];
                if third == 1 {
                    t = t.wrapping_add(first);
                }
                if second == 1 {
                    s = s.wrapping_add(first);
                } else if second == 2 {
                    s = s.wrapping_add(first.wrapping_add(t) >> 1);
                }
                d1[i] = s;
                d2[i] = t;
            }
        }
    }
    // Channel k of the output is input (k - permutation) in this rotation.
    let i0 = permutation % 3;
    let i1 = (permutation + 1 + permutation / 3) % 3;
    let i2 = (permutation + 2 - permutation / 3) % 3;
    let mut moved: Vec<Option<Channel>> = img.channels.drain(b..b + 3).map(Some).collect();
    let mut out: [Option<Channel>; 3] = [None, None, None];
    out[i0] = moved[0].take();
    out[i1] = moved[1].take();
    out[i2] = moved[2].take();
    let mut v = Vec::with_capacity(3);
    for o in out {
        v.push(o.ok_or(Error::Invalid("RCT permutation"))?);
    }
    img.channels.splice(b..b, v);
    Ok(())
}

#[rustfmt::skip]
const DELTA_PALETTE: [[i32; 3]; 72] = [
    [0, 0, 0], [4, 4, 4], [11, 0, 0], [0, 0, -13], [0, -12, 0], [-10, -10, -10],
    [-18, -18, -18], [-27, -27, -27], [-18, -18, 0], [0, 0, -32], [-32, 0, 0], [-37, -37, -37],
    [0, -32, -32], [24, 24, 45], [50, 50, 50], [-45, -24, -24], [-24, -45, -45], [0, -24, -24],
    [-34, -34, 0], [-24, 0, -24], [-45, -45, -24], [64, 64, 64], [-32, 0, -32], [0, -32, 0],
    [-32, 0, 32], [-24, -45, -24], [45, 24, 45], [24, -24, -45], [-45, -24, 24], [80, 80, 80],
    [64, 0, 0], [0, 0, -64], [0, -64, -64], [-24, -24, 45], [96, 96, 96], [64, 64, 0],
    [45, -24, -24], [34, -34, 0], [112, 112, 112], [24, -45, -45], [45, 45, -24], [0, -32, 32],
    [24, -24, 45], [0, 96, 96], [45, -24, 24], [24, -45, -24], [-24, -45, 24], [0, -64, 0],
    [96, 0, 0], [128, 128, 128], [64, 0, 64], [144, 144, 144], [96, 96, 0], [-36, -36, 36],
    [45, -24, -45], [45, -45, -24], [0, 0, -96], [0, 128, 128], [0, 96, 0], [45, 24, -45],
    [-128, 0, 0], [24, -45, 24], [-45, 24, -45], [64, 0, -64], [64, -64, -64], [96, 0, 96],
    [45, -45, 24], [24, 45, -45], [64, 64, -64], [128, 128, 0], [0, 0, -128], [-24, 45, -45],
];

fn palette_value(palette: &Channel, index: i32, c: usize, bit_depth: u32) -> i32 {
    let size = palette.w as i64;
    let index = i64::from(index);
    if index < 0 {
        if c >= 3 {
            return 0;
        }
        let mut i = -(index + 1);
        i %= 1 + 2 * (DELTA_PALETTE.len() as i64 - 1);
        let mul = if i & 1 == 1 { 1 } else { -1 };
        let mut r = DELTA_PALETTE[((i + 1) >> 1) as usize][c] * mul;
        if bit_depth > 8 {
            r = r.wrapping_mul(1 << (bit_depth - 8).min(30));
        }
        r
    } else if index >= size && index < size + 64 {
        if c >= 3 {
            return 0;
        }
        let i = (index - size) >> (2 * c);
        let scale = ((i % 4) as u64 * ((1u64 << bit_depth) - 1)) >> 2;
        (scale as i64 + (1i64 << bit_depth.saturating_sub(3))) as i32
    } else if index >= size + 64 {
        if c >= 3 {
            return 0;
        }
        let mut i = index - size - 64;
        if c == 1 {
            i /= 5;
        } else if c == 2 {
            i /= 25;
        }
        (((i % 5) as u64 * ((1u64 << bit_depth) - 1)) >> 2) as i32
    } else {
        palette.data.get(c * palette.w + index as usize).copied().unwrap_or(0)
    }
}

fn inv_palette(img: &mut ModularImage, b: usize, _nb_colors: u32, nb_deltas: u32, predictor: Predictor, wp: &WpHeader) -> Result<()> {
    if img.nb_meta < 1 {
        return invalid("palette transform without palette");
    }
    let nb = img.channels[0].h;
    let c0 = b + 1;
    if c0 >= img.channels.len() {
        return invalid("palette channel out of range");
    }
    if nb < 1 {
        return invalid("palette with no channels");
    }
    let (w, h, hs, vs) = {
        let c = &img.channels[c0];
        (c.w, c.h, c.hshift, c.vshift)
    };
    for _ in 1..nb {
        img.channels.insert(c0 + 1, Channel::new(w, h, hs, vs)?);
    }
    let bit_depth = img.bit_depth.min(24);
    let palette = std::mem::replace(&mut img.channels[0], Channel::placeholder(0, 0, 0, 0));
    let result = (|| -> Result<()> {
        if w == 0 {
            return Ok(());
        }
        if nb_deltas == 0 && predictor == Predictor::Zero {
            if nb == 1 {
                let max = palette.w as i32 - 1;
                for v in img.channels[c0].data.iter_mut() {
                    let idx = (*v).max(0).min(max);
                    *v = palette_value(&palette, idx, 0, bit_depth);
                }
            } else {
                let idx = img.channels[c0].data.clone();
                for c in 0..nb {
                    for (o, &i) in img.channels[c0 + c].data.iter_mut().zip(idx.iter()) {
                        *o = palette_value(&palette, i, c, bit_depth);
                    }
                }
            }
            return Ok(());
        }
        let idx = std::mem::take(&mut img.channels[c0].data);
        img.channels[c0].data = vec![0; w * h];
        for c in 0..nb {
            let ch = &mut img.channels[c0 + c];
            let mut wps = if predictor == Predictor::Weighted { Some(WpState::new(*wp, w)) } else { None };
            for y in 0..h {
                for x in 0..w {
                    let index = idx[y * w + x];
                    let entry = i64::from(palette_value(&palette, index, c, bit_depth));
                    let v = if (index as i64) < i64::from(nb_deltas) {
                        let n = super::decode::neighbours(&ch.data, w, x, y);
                        let pred = match wps.as_mut() {
                            Some(s) => s.predict(x, y, n.top, n.left, n.topright, n.topleft, n.toptop).0,
                            None => super::decode::predict(predictor, &n, 0),
                        };
                        pred.wrapping_add(entry)
                    } else {
                        if let Some(s) = wps.as_mut() {
                            let n = super::decode::neighbours(&ch.data, w, x, y);
                            s.predict(x, y, n.top, n.left, n.topright, n.topleft, n.toptop);
                        }
                        entry
                    };
                    ch.data[y * w + x] = v as i32;
                    if let Some(s) = wps.as_mut() {
                        s.update(i64::from(v as i32), x, y);
                    }
                }
            }
        }
        Ok(())
    })();
    img.channels[0] = palette;
    result?;
    if c0 >= img.nb_meta {
        img.nb_meta -= 1;
    } else {
        if img.nb_meta + nb < 2 {
            return invalid("palette meta channels");
        }
        img.nb_meta = img.nb_meta + nb - 2;
    }
    img.channels.remove(0);
    Ok(())
}
