//! Frame rendering: turning decoded frame samples into the image (ISO/IEC 18181-1 Annex K–L
//! order, as libjxl's render pipeline): filters, patches, upsampling, colour transform,
//! blending onto the canvas, and reference-frame storage.

use crate::error::{invalid, Error, Result};
use crate::frame_header::{BlendMode, BlendingInfo};
use crate::headers::{ExtraChannel, ExtraChannelType};

/// One channel of samples.
#[derive(Clone, Debug, Default)]
pub struct Plane {
    pub w: usize,
    pub h: usize,
    pub data: Vec<f32>,
}

impl Plane {
    pub fn new(w: usize, h: usize) -> Result<Self> {
        let n = w.checked_mul(h).ok_or(Error::Limit("plane too large"))?;
        let mut data = Vec::new();
        data.try_reserve_exact(n).map_err(|_| Error::Limit("cannot allocate plane"))?;
        data.resize(n, 0.0);
        Ok(Plane { w, h, data })
    }

    #[inline(always)]
    pub fn row(&self, y: usize) -> &[f32] {
        &self.data[y * self.w..(y + 1) * self.w]
    }

    #[inline(always)]
    pub fn row_mut(&mut self, y: usize) -> &mut [f32] {
        &mut self.data[y * self.w..(y + 1) * self.w]
    }
}

/// Three colour planes followed by the extra channels.
#[derive(Clone, Debug, Default)]
pub struct FrameImage {
    pub planes: Vec<Plane>,
}

impl FrameImage {
    pub fn width(&self) -> usize {
        self.planes.first().map(|p| p.w).unwrap_or(0)
    }
    pub fn height(&self) -> usize {
        self.planes.first().map(|p| p.h).unwrap_or(0)
    }
}

/// A frame kept for later frames (blending source or patch source).
#[derive(Clone, Debug)]
pub struct Reference {
    pub image: FrameImage,
    /// Saved before the colour transform (usable by patches, not by blending).
    pub before_ct: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PatchMode {
    None,
    Replace,
    Add,
    Mul,
    BlendAbove,
    BlendBelow,
    AwAddAbove,
    AwAddBelow,
}

#[derive(Clone, Copy, Debug)]
pub struct PatchBlending {
    pub mode: PatchMode,
    pub alpha_channel: usize,
    pub clamp: bool,
}

impl PatchBlending {
    pub fn from_frame(b: &BlendingInfo) -> Self {
        let mode = match b.mode {
            BlendMode::Replace => PatchMode::Replace,
            BlendMode::Add => PatchMode::Add,
            BlendMode::Mul => PatchMode::Mul,
            BlendMode::Blend => PatchMode::BlendAbove,
            BlendMode::AlphaWeightedAdd => PatchMode::AwAddAbove,
        };
        PatchBlending { mode, alpha_channel: b.alpha_channel as usize, clamp: b.clamp }
    }
}

#[inline(always)]
fn clamp01(x: f32) -> f32 {
    x.clamp(0.0, 1.0)
}

fn alpha_blend(bg: f32, bga: f32, fg: f32, fga: f32, premul: bool, clamp: bool) -> f32 {
    let fa = if clamp { clamp01(fga) } else { fga };
    if premul {
        fg + bg * (1.0 - fa)
    } else {
        let new_a = 1.0 - (1.0 - fa) * (1.0 - bga);
        let rnew = if new_a > 0.0 { 1.0 / new_a } else { 0.0 };
        (fg * fa + bg * bga * (1.0 - fa)) * rnew
    }
}

fn alpha_of(fga: f32, bga: f32, clamp: bool) -> f32 {
    let fa = if clamp { clamp01(fga) } else { fga };
    1.0 - (1.0 - fa) * (1.0 - bga)
}

/// libjxl's PerformBlending for one pixel span: `bg` and `fg` hold 3 + n channel values per
/// pixel position; the result is written to `out` (which may alias neither).
pub fn blend_pixel(bg: &[f32], fg: &[f32], out: &mut [f32], color: &PatchBlending, ec: &[PatchBlending], eci: &[ExtraChannel]) {
    let has_alpha = eci.iter().any(|e| e.kind == ExtraChannelType::Alpha);
    let n = eci.len();
    for i in 0..n {
        let b = &ec[i];
        let a = b.alpha_channel;
        let premul = eci.get(a).map(|e| e.alpha_associated).unwrap_or(false);
        out[3 + i] = match b.mode {
            PatchMode::Add => bg[3 + i] + fg[3 + i],
            PatchMode::BlendAbove => {
                if a == i {
                    alpha_of(fg[3 + a], bg[3 + a], b.clamp)
                } else {
                    alpha_blend(bg[3 + i], bg[3 + a], fg[3 + i], fg[3 + a], premul, b.clamp)
                }
            }
            PatchMode::BlendBelow => {
                if a == i {
                    alpha_of(bg[3 + a], fg[3 + a], b.clamp)
                } else {
                    alpha_blend(fg[3 + i], fg[3 + a], bg[3 + i], bg[3 + a], premul, b.clamp)
                }
            }
            PatchMode::AwAddAbove => {
                if a == i {
                    bg[3 + i]
                } else {
                    bg[3 + i] + fg[3 + i] * if b.clamp { clamp01(fg[3 + a]) } else { fg[3 + a] }
                }
            }
            PatchMode::AwAddBelow => {
                if a == i {
                    fg[3 + i]
                } else {
                    fg[3 + i] + bg[3 + i] * if b.clamp { clamp01(bg[3 + a]) } else { bg[3 + a] }
                }
            }
            PatchMode::Mul => bg[3 + i] * if b.clamp { clamp01(fg[3 + i]) } else { fg[3 + i] },
            PatchMode::Replace => fg[3 + i],
            PatchMode::None => bg[3 + i],
        };
    }
    let a = color.alpha_channel;
    let premul = eci.get(a).map(|e| e.alpha_associated).unwrap_or(false);
    match color.mode {
        PatchMode::Add => {
            for c in 0..3 {
                out[c] = bg[c] + fg[c];
            }
        }
        PatchMode::AwAddAbove | PatchMode::AwAddBelow => {
            let (bot, top) = if color.mode == PatchMode::AwAddAbove { (bg, fg) } else { (fg, bg) };
            if has_alpha && 3 + a < top.len() {
                let ta = if color.clamp { clamp01(top[3 + a]) } else { top[3 + a] };
                for c in 0..3 {
                    out[c] = bot[c] + top[c] * ta;
                }
            } else {
                for c in 0..3 {
                    out[c] = bg[c] + fg[c];
                }
            }
        }
        PatchMode::BlendAbove | PatchMode::BlendBelow => {
            let (bot, top) = if color.mode == PatchMode::BlendAbove { (bg, fg) } else { (fg, bg) };
            if has_alpha && 3 + a < top.len() {
                for c in 0..3 {
                    out[c] = alpha_blend(bot[c], bot[3 + a], top[c], top[3 + a], premul, color.clamp);
                }
                out[3 + a] = alpha_of(top[3 + a], bot[3 + a], color.clamp);
            } else {
                out[..3].copy_from_slice(&fg[..3]);
            }
        }
        PatchMode::Mul => {
            for c in 0..3 {
                out[c] = bg[c] * if color.clamp { clamp01(fg[c]) } else { fg[c] };
            }
        }
        PatchMode::Replace => out[..3].copy_from_slice(&fg[..3]),
        PatchMode::None => out[..3].copy_from_slice(&bg[..3]),
    }
}

/// Blends `fg` (rectangle at (fx0, fy0) of the canvas) onto `canvas` in place; `bg` gives
/// the background per channel (None means zeros).
pub fn blend_rect(
    canvas: &mut FrameImage,
    bg: &[Option<&Plane>],
    fg: &FrameImage,
    fx0: i64,
    fy0: i64,
    color: &PatchBlending,
    ec: &[PatchBlending],
    eci: &[ExtraChannel],
) {
    let nc = canvas.planes.len();
    let cw = canvas.width() as i64;
    let ch = canvas.height() as i64;
    // Background everywhere first.
    for c in 0..nc {
        match bg.get(c).copied().flatten() {
            Some(p) if p.w == canvas.planes[c].w && p.h == canvas.planes[c].h => canvas.planes[c].data.copy_from_slice(&p.data),
            _ => canvas.planes[c].data.fill(0.0),
        }
    }
    let fw = fg.width() as i64;
    let fh = fg.height() as i64;
    let x_start = fx0.max(0);
    let x_end = (fx0 + fw).min(cw);
    let y_start = fy0.max(0);
    let y_end = (fy0 + fh).min(ch);
    if x_start >= x_end || y_start >= y_end {
        return;
    }
    let mut bgp = vec![0f32; nc];
    let mut fgp = vec![0f32; nc];
    let mut out = vec![0f32; nc];
    for y in y_start..y_end {
        let fy = (y - fy0) as usize;
        for x in x_start..x_end {
            let fx = (x - fx0) as usize;
            let ci = y as usize * cw as usize + x as usize;
            for c in 0..nc {
                bgp[c] = canvas.planes[c].data[ci];
                fgp[c] = fg.planes.get(c).map(|p| p.data[fy * p.w + fx]).unwrap_or(0.0);
            }
            blend_pixel(&bgp, &fgp, &mut out, color, ec, eci);
            for c in 0..nc {
                canvas.planes[c].data[ci] = out[c];
            }
        }
    }
}

/// A patch: copy of a reference-frame rectangle blended into the frame (K.3).
#[derive(Clone, Debug)]
pub struct Patch {
    pub reference: usize,
    pub rx0: usize,
    pub ry0: usize,
    pub w: usize,
    pub h: usize,
    pub x: usize,
    pub y: usize,
    /// Colour blending, then one per extra channel.
    pub blending: Vec<PatchBlending>,
}

pub fn apply_patches(img: &mut FrameImage, patches: &[Patch], refs: &[Option<Reference>; 4], eci: &[ExtraChannel]) -> Result<()> {
    let nc = img.planes.len();
    let mut bgp = vec![0f32; nc];
    let mut fgp = vec![0f32; nc];
    let mut out = vec![0f32; nc];
    let iw = img.width();
    let ih = img.height();
    for p in patches {
        let r = refs[p.reference].as_ref().ok_or(Error::Invalid("patch reference missing"))?;
        let ri = &r.image;
        if r.image.planes.len() < nc {
            return invalid("patch reference has too few channels");
        }
        for yy in 0..p.h {
            let y = p.y + yy;
            if y >= ih {
                break;
            }
            for xx in 0..p.w {
                let x = p.x + xx;
                if x >= iw {
                    break;
                }
                for c in 0..nc {
                    bgp[c] = img.planes[c].data[y * img.planes[c].w + x];
                    let rp = &ri.planes[c];
                    fgp[c] = rp.data.get((p.ry0 + yy) * rp.w + p.rx0 + xx).copied().unwrap_or(0.0);
                }
                blend_pixel(&bgp, &fgp, &mut out, &p.blending[0], &p.blending[1..], eci);
                for c in 0..nc {
                    let w = img.planes[c].w;
                    img.planes[c].data[y * w + x] = out[c];
                }
            }
        }
    }
    Ok(())
}
