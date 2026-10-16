//! Decoding one modular channel: prediction, MA-tree context selection and entropy decoding.

use super::tree::{ChannelTree, Node, Predictor, GRADIENT_PROP, NUM_NONREF_PROPS, WP_PROP};
use super::wp::{WpHeader, WpState};
use super::Channel;
use crate::bits::{unpack_signed, BitReader};
use crate::entropy::{EntropyCode, SymbolReader};
use crate::error::{invalid, Result};

/// The neighbours of a sample, with the standard's edge rules applied.
#[derive(Clone, Copy, Debug, Default)]
pub struct Neighbours {
    pub left: i64,
    pub top: i64,
    pub topleft: i64,
    pub topright: i64,
    pub leftleft: i64,
    pub toptop: i64,
    pub toprightright: i64,
}

/// Neighbours of (x, y) in a row-major plane of width `w` (rows above y and the samples left
/// of x in row y must already be decoded).
#[inline(always)]
pub fn neighbours(data: &[i32], w: usize, x: usize, y: usize) -> Neighbours {
    let at = |xx: usize, yy: usize| i64::from(data[yy * w + xx]);
    let left = if x > 0 {
        at(x - 1, y)
    } else if y > 0 {
        at(x, y - 1)
    } else {
        0
    };
    let top = if y > 0 { at(x, y - 1) } else { left };
    let topleft = if x > 0 && y > 0 { at(x - 1, y - 1) } else { left };
    let topright = if x + 1 < w && y > 0 { at(x + 1, y - 1) } else { top };
    let leftleft = if x > 1 { at(x - 2, y) } else { left };
    let toptop = if y > 1 { at(x, y - 2) } else { top };
    let toprightright = if x + 2 < w && y > 0 { at(x + 2, y - 1) } else { topright };
    Neighbours { left, top, topleft, topright, leftleft, toptop, toprightright }
}

#[inline(always)]
pub fn clamped_gradient(n: i64, w: i64, l: i64) -> i64 {
    let m = n.min(w);
    let mx = n.max(w);
    let grad = (n as i32).wrapping_add(w as i32).wrapping_sub(l as i32) as i64;
    if l < m {
        mx
    } else if l > mx {
        m
    } else {
        grad
    }
}

#[inline(always)]
pub fn predict(p: Predictor, n: &Neighbours, wp_pred: i64) -> i64 {
    match p {
        Predictor::Zero => 0,
        Predictor::Left => n.left,
        Predictor::Top => n.top,
        Predictor::Average0 => (n.left + n.top) / 2,
        Predictor::Select => {
            let pp = n.left + n.top - n.topleft;
            let pa = (pp - n.left).abs();
            let pb = (pp - n.top).abs();
            if pa < pb {
                n.left
            } else {
                n.top
            }
        }
        Predictor::Gradient => clamped_gradient(n.left, n.top, n.topleft),
        Predictor::Weighted => wp_pred,
        Predictor::TopRight => n.topright,
        Predictor::TopLeft => n.topleft,
        Predictor::LeftLeft => n.leftleft,
        Predictor::Average1 => (n.left + n.topleft) / 2,
        Predictor::Average2 => (n.topleft + n.top) / 2,
        Predictor::Average3 => (n.top + n.topright) / 2,
        Predictor::Average4 => {
            (6 * n.top - 2 * n.toptop + 7 * n.left + n.leftleft + n.toprightright + 3 * n.topright + 8) / 16
        }
    }
}

#[inline(always)]
fn make_pixel(v: u32, multiplier: u32, guess: i64) -> i32 {
    (i64::from(unpack_signed(v)).wrapping_mul(i64::from(multiplier)).wrapping_add(guess)) as i32
}

const PROP_RANGE_FAST: i32 = 512 << 4;

pub struct ChannelCtx<'a> {
    pub code: &'a EntropyCode,
    pub tree: &'a ChannelTree,
    pub wp: &'a WpHeader,
}

/// Decodes channel `idx` of `channels` (earlier channels may be referenced by the tree).
pub fn decode_channel(
    br: &mut BitReader,
    r: &mut SymbolReader,
    cx: &ChannelCtx,
    channels: &mut [Channel],
    idx: usize,
) -> Result<()> {
    let (prev, rest) = channels.split_at_mut(idx);
    let ch = &mut rest[0];
    let (w, h) = (ch.w, ch.h);
    if w == 0 || h == 0 {
        return Ok(());
    }
    ch.alloc()?;
    let tree = cx.tree;
    let code = cx.code;
    if let [Node::Leaf { ctx, predictor, offset, multiplier }] = tree.nodes[..] {
        let ctx = ctx as usize;
        match predictor {
            Predictor::Zero => {
                if !r.copying() {
                    if let Some(v) = code.single_value(ctx) {
                        let px = make_pixel(v, multiplier, offset);
                        ch.data.fill(px);
                        r.advance_single(v, (w * h) as u64);
                        return Ok(());
                    }
                }
                for p in ch.data.iter_mut() {
                    let v = r.read_clustered(code, br, ctx);
                    *p = make_pixel(v, multiplier, offset);
                }
                return check(br);
            }
            Predictor::Gradient if offset == 0 && multiplier == 1 => {
                decode_gradient(br, r, code, &mut ch.data, w, h, |_| ctx);
                return check(br);
            }
            _ => {}
        }
    }
    if !tree.uses_wp {
        if let Some(lut) = tree.single_property_lut(GRADIENT_PROP as u32, Predictor::Gradient, PROP_RANGE_FAST) {
            decode_gradient(br, r, code, &mut ch.data, w, h, |g| {
                let i = (g.clamp(-i64::from(PROP_RANGE_FAST), i64::from(PROP_RANGE_FAST) - 1) + i64::from(PROP_RANGE_FAST)) as usize;
                usize::from(lut[i])
            });
            return check(br);
        }
    } else if let Some(lut) = tree.single_property_lut(WP_PROP as u32, Predictor::Weighted, PROP_RANGE_FAST) {
        decode_wp_lut(br, r, code, cx.wp, &mut ch.data, w, h, &lut);
        return check(br);
    }
    decode_general(br, r, cx, prev, ch)?;
    check(br)
}

fn check(br: &BitReader) -> Result<()> {
    if br.overrun() {
        invalid("truncated modular channel")
    } else {
        Ok(())
    }
}

/// Gradient predictor everywhere; `ctx_of(left + top - topleft)` picks the cluster.
#[inline(always)]
fn decode_gradient(
    br: &mut BitReader,
    r: &mut SymbolReader,
    code: &EntropyCode,
    data: &mut [i32],
    w: usize,
    h: usize,
    ctx_of: impl Fn(i64) -> usize,
) {
    for y in 0..h {
        let (above, cur) = data.split_at_mut(y * w);
        let cur = &mut cur[..w];
        if y == 0 {
            let mut left = 0i64;
            for p in cur.iter_mut() {
                // top = topleft = left on the first row.
                let ctx = ctx_of(left);
                let v = r.read_clustered(code, br, ctx);
                *p = make_pixel(v, 1, left);
                left = i64::from(*p);
            }
            continue;
        }
        let top_row = &above[(y - 1) * w..y * w];
        // x = 0: left = topleft = top.
        {
            let top = i64::from(top_row[0]);
            let ctx = ctx_of(top);
            let v = r.read_clustered(code, br, ctx);
            cur[0] = make_pixel(v, 1, top);
        }
        for x in 1..w {
            let left = i64::from(cur[x - 1]);
            let top = i64::from(top_row[x]);
            let topleft = i64::from(top_row[x - 1]);
            let ctx = ctx_of(left + top - topleft);
            let guess = clamped_gradient(left, top, topleft);
            let v = r.read_clustered(code, br, ctx);
            cur[x] = make_pixel(v, 1, guess);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn decode_wp_lut(
    br: &mut BitReader,
    r: &mut SymbolReader,
    code: &EntropyCode,
    wp: &WpHeader,
    data: &mut [i32],
    w: usize,
    h: usize,
    lut: &[u8],
) {
    let mut st = WpState::new(*wp, w);
    let range = i64::from(PROP_RANGE_FAST);
    for y in 0..h {
        for x in 0..w {
            let n = neighbours(data, w, x, y);
            let (guess, maxerr) = st.predict(x, y, n.top, n.left, n.topright, n.topleft, n.toptop);
            let i = (i64::from(maxerr).clamp(-range, range - 1) + range) as usize;
            let v = r.read_clustered(code, br, usize::from(lut[i]));
            let px = make_pixel(v, 1, guess);
            data[y * w + x] = px;
            st.update(i64::from(px), x, y);
        }
    }
}

/// Fills properties 3..=14 from the neighbours (property 8 uses the previous property 9).
#[inline(always)]
fn fill_props(p: &mut [i32], x: usize, n: &Neighbours) {
    p[3] = x as i32;
    p[4] = n.top.abs() as i32;
    p[5] = n.left.abs() as i32;
    p[6] = n.top as i32;
    p[7] = n.left as i32;
    p[8] = (n.left - i64::from(p[9])) as i32;
    p[9] = (n.left + n.top - n.topleft) as i32;
    p[10] = (n.left - n.topleft) as i32;
    p[11] = (n.topleft - n.top) as i32;
    p[12] = (n.top - n.topright) as i32;
    p[13] = (n.top - n.toptop) as i32;
    p[14] = (n.left - n.leftleft) as i32;
}

fn decode_general(br: &mut BitReader, r: &mut SymbolReader, cx: &ChannelCtx, prev: &[Channel], ch: &mut Channel) -> Result<()> {
    let tree = cx.tree;
    let code = cx.code;
    let (w, h) = (ch.w, ch.h);
    let num_refs = (tree.num_props - NUM_NONREF_PROPS) / 4;
    // Reference channels: earlier channels of identical geometry, nearest first.
    let refs: Vec<&Channel> = prev
        .iter()
        .rev()
        .filter(|c| c.w == w && c.h == h && c.hshift == ch.hshift && c.vshift == ch.vshift && c.data.len() == w * h)
        .take(num_refs)
        .collect();
    let mut ref_props = vec![0i32; num_refs * 4 * w];
    let mut props = vec![0i32; tree.num_props];
    let mut st = if tree.uses_wp { Some(WpState::new(*cx.wp, w)) } else { None };
    let static_ch = 0; // channel/group properties were resolved when the tree was specialised
    let _ = static_ch;
    for y in 0..h {
        if num_refs > 0 {
            ref_props.fill(0);
            for (k, rc) in refs.iter().enumerate() {
                let row = &rc.data[y * w..(y + 1) * w];
                let prow = if y > 0 { &rc.data[(y - 1) * w..y * w] } else { row };
                for x in 0..w {
                    let v = i64::from(row[x]);
                    let vleft = if x > 0 { i64::from(row[x - 1]) } else { 0 };
                    let vtop = if y > 0 { i64::from(prow[x]) } else { vleft };
                    let vtopleft = if x > 0 && y > 0 { i64::from(prow[x - 1]) } else { vleft };
                    let pred = clamped_gradient(vleft, vtop, vtopleft);
                    let o = x * num_refs * 4 + k * 4;
                    ref_props[o] = v.abs() as i32;
                    ref_props[o + 1] = v as i32;
                    ref_props[o + 2] = (v - pred).abs() as i32;
                    ref_props[o + 3] = (v - pred) as i32;
                }
            }
        }
        props[2] = y as i32;
        props[9] = 0;
        for x in 0..w {
            let n = neighbours(&ch.data, w, x, y);
            fill_props(&mut props, x, &n);
            let mut wp_pred = 0;
            if let Some(s) = st.as_mut() {
                let (p, maxerr) = s.predict(x, y, n.top, n.left, n.topright, n.topleft, n.toptop);
                wp_pred = p;
                props[WP_PROP] = maxerr;
            }
            if num_refs > 0 {
                let o = x * num_refs * 4;
                props[NUM_NONREF_PROPS..].copy_from_slice(&ref_props[o..o + num_refs * 4]);
            }
            let (ctx, predictor, offset, multiplier) = tree.lookup(&props);
            let guess = offset.wrapping_add(predict(predictor, &n, wp_pred));
            let v = r.read_clustered(code, br, ctx as usize);
            let px = make_pixel(v, multiplier, guess);
            ch.data[y * w + x] = px;
            if let Some(s) = st.as_mut() {
                s.update(i64::from(px), x, y);
            }
        }
        if br.overrun() {
            return invalid("truncated modular channel");
        }
    }
    Ok(())
}
