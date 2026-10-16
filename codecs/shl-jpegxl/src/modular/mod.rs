//! Modular mode (ISO/IEC 18181-1 Annex H): channel images, group headers and transforms.

pub mod decode;
pub mod transform;
pub mod tree;
pub mod wp;

use crate::bits::{bits_offset, val, BitReader};
use crate::entropy::EntropyCode;
use crate::error::{invalid, Error, Result};
use transform::Transform;
use tree::Tree;
use wp::WpHeader;

/// Largest number of samples in one channel (2^31 rows × columns is never reasonable).
const MAX_CHANNEL_SAMPLES: usize = 1 << 31;

#[derive(Clone, Debug)]
pub struct Channel {
    pub w: usize,
    pub h: usize,
    pub hshift: i32,
    pub vshift: i32,
    /// `w * h` samples once allocated; empty before.
    pub data: Vec<i32>,
}

impl Channel {
    pub fn new(w: usize, h: usize, hshift: i32, vshift: i32) -> Result<Self> {
        let mut c = Channel::placeholder(w, h, hshift, vshift);
        c.alloc()?;
        Ok(c)
    }

    pub fn placeholder(w: usize, h: usize, hshift: i32, vshift: i32) -> Self {
        Channel { w, h, hshift, vshift, data: Vec::new() }
    }

    /// Allocates (zero-filled) storage if not yet present.
    pub fn alloc(&mut self) -> Result<()> {
        let n = self.w.checked_mul(self.h).filter(|&n| n <= MAX_CHANNEL_SAMPLES).ok_or(Error::Limit("channel too large"))?;
        if self.data.len() != n {
            self.data.clear();
            self.data.try_reserve_exact(n).map_err(|_| Error::Limit("cannot allocate channel"))?;
            self.data.resize(n, 0);
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct ModularImage {
    pub channels: Vec<Channel>,
    pub nb_meta: usize,
    pub bit_depth: u32,
    pub transforms: Vec<Transform>,
    pub wp: WpHeader,
}

impl ModularImage {
    pub fn new(bit_depth: u32) -> Self {
        ModularImage { channels: Vec::new(), nb_meta: 0, bit_depth, transforms: Vec::new(), wp: WpHeader::default() }
    }

    /// Undoes the transforms in reverse order.
    pub fn undo_transforms(&mut self) -> Result<()> {
        for c in self.channels.iter_mut() {
            c.alloc()?;
        }
        while let Some(t) = self.transforms.pop() {
            let wp = self.wp;
            t.inverse(self, &wp)?;
        }
        Ok(())
    }
}

/// A tree with its histograms, shared by several streams (the global tree) or local.
pub struct TreeCode {
    pub tree: Tree,
    pub code: EntropyCode,
}

impl TreeCode {
    pub fn read(br: &mut BitReader, tree_limit: usize) -> Result<Self> {
        let tree = tree::read_tree(br, tree_limit)?;
        let code = EntropyCode::read(br, tree.len().div_ceil(2))?;
        Ok(TreeCode { tree, code })
    }
}

pub struct StreamOptions {
    /// Channels (other than meta channels) larger than this in either dimension are left for
    /// the group streams; this stream stops at the first one.
    pub max_chan_size: usize,
    /// The frame's group size, for the transform sanity check (`usize::MAX` to skip).
    pub group_dim: usize,
}

fn validate_dimensions(img: &ModularImage, group_dim: usize) -> Result<()> {
    if group_dim == usize::MAX {
        return Ok(());
    }
    for is_dc in [true, false] {
        let gd = group_dim * if is_dc { 8 } else { 1 };
        let mut c = img.nb_meta;
        while c < img.channels.len() {
            let ch = &img.channels[c];
            if ch.w > group_dim || ch.h > group_dim {
                break;
            }
            c += 1;
        }
        for ch in &img.channels[c..] {
            if ch.w == 0 || ch.h == 0 {
                continue;
            }
            let is_dc_ch = ch.hshift.min(ch.vshift) >= 3;
            if is_dc_ch != is_dc {
                continue;
            }
            let s = ch.hshift.max(ch.vshift).max(0) as u32;
            if s >= usize::BITS || (gd >> s) == 0 {
                return invalid("inconsistent transforms");
            }
        }
    }
    Ok(())
}

/// Decodes one modular sub-bitstream into `img` (its channel list already set up): group
/// header, transforms (meta-applied, not undone), and channel data.
pub fn decode_stream(
    br: &mut BitReader,
    img: &mut ModularImage,
    stream_id: usize,
    global: Option<&TreeCode>,
    opts: &StreamOptions,
) -> Result<()> {
    if img.channels.is_empty() {
        return Ok(());
    }
    let use_global = br.bit();
    img.wp = WpHeader::read(br)?;
    let nt = br.u32([val(0), val(1), bits_offset(4, 2), bits_offset(8, 18)]);
    let mut transforms = Vec::new();
    for _ in 0..nt {
        if br.overrun() {
            return invalid("truncated transforms");
        }
        transforms.push(Transform::read(br)?);
    }
    br.check_end()?;
    for t in transforms.iter_mut() {
        t.meta_apply(img)?;
    }
    img.transforms = transforms;
    validate_dimensions(img, opts.group_dim)?;

    let mut last = 0;
    let mut distance_multiplier = 0usize;
    let mut pixels: u64 = 0;
    let mut any = false;
    for (i, ch) in img.channels.iter().enumerate() {
        if i >= img.nb_meta && (ch.w > opts.max_chan_size || ch.h > opts.max_chan_size) {
            break;
        }
        last = i + 1;
        if ch.w == 0 || ch.h == 0 {
            continue;
        }
        any = true;
        distance_multiplier = distance_multiplier.max(ch.w);
        pixels += (ch.w * ch.h) as u64;
    }
    if !any {
        return Ok(());
    }
    let local;
    let tc = if use_global {
        match global {
            Some(g) if !g.tree.is_empty() => g,
            _ => return invalid("no global tree"),
        }
    } else {
        let limit = (1024 + pixels).min(1 << 20) as usize;
        local = TreeCode::read(br, limit)?;
        &local
    };
    let mut r = tc.code.reader(br, distance_multiplier.min(u32::MAX as usize) as u32)?;
    let wp = img.wp;
    for i in 0..last {
        let (w, h) = (img.channels[i].w, img.channels[i].h);
        if w == 0 || h == 0 {
            continue;
        }
        let ct = tree::specialise(&tc.tree, i as i32, stream_id as i32, &tc.code.context_map);
        let cx = decode::ChannelCtx { code: &tc.code, tree: &ct, wp: &wp };
        decode::decode_channel(br, &mut r, &cx, &mut img.channels, i)?;
    }
    if !r.check_final_state() {
        return invalid("modular ANS final state");
    }
    Ok(())
}
