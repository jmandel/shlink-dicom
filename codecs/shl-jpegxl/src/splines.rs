//! Splines (ISO/IEC 18181-1 K.4): decoding and rendering, following libjxl's splines.cc.

use crate::bits::{unpack_signed, BitReader};
use crate::entropy::{ceil_log2, EntropyCode};
use crate::error::{invalid, Result};
use crate::render::Plane;

const QUANT_ADJ_CTX: usize = 0;
const START_CTX: usize = 1;
const NUM_SPLINES_CTX: usize = 2;
const NUM_POINTS_CTX: usize = 3;
const POINTS_CTX: usize = 4;
const DCT_CTX: usize = 5;
const MAX_CONTROL_POINTS: usize = 1 << 20;
const POS_LIMIT: i64 = 1 << 23;
const CHANNEL_WEIGHT: [f32; 4] = [0.0042, 0.075, 0.07, 0.3333];
const SQRT0_5: f32 = 0.707_106_78;
const SQRT2: f32 = 1.414_213_56;

#[derive(Clone, Debug)]
struct QuantizedSpline {
    deltas: Vec<(i64, i64)>,
    color: [[i32; 32]; 3],
    sigma: [i32; 32],
}

#[derive(Clone, Debug)]
pub struct Splines {
    quant_adjustment: i32,
    starts: Vec<(i64, i64)>,
    splines: Vec<QuantizedSpline>,
}

fn check_pos(x: i64, y: i64) -> Result<()> {
    if x >= POS_LIMIT || x <= -POS_LIMIT || y >= POS_LIMIT || y <= -POS_LIMIT {
        return invalid("spline coordinates out of bounds");
    }
    Ok(())
}

pub fn read_splines(br: &mut BitReader, num_pixels: usize) -> Result<Splines> {
    let code = EntropyCode::read(br, 6)?;
    let mut r = code.reader(br, 0)?;
    let num_splines = r.read(&code, br, NUM_SPLINES_CTX) as usize;
    let max_points = MAX_CONTROL_POINTS.min(num_pixels / 2);
    if num_splines > max_points || num_splines + 1 > max_points {
        return invalid("too many splines");
    }
    let num_splines = num_splines + 1;
    let mut starts = Vec::with_capacity(num_splines);
    let (mut lx, mut ly) = (0i64, 0i64);
    for i in 0..num_splines {
        let dx = r.read(&code, br, START_CTX);
        let dy = r.read(&code, br, START_CTX);
        let (x, y) = if i != 0 {
            (i64::from(unpack_signed(dx)) + lx, i64::from(unpack_signed(dy)) + ly)
        } else {
            (i64::from(dx), i64::from(dy))
        };
        check_pos(x, y)?;
        starts.push((x, y));
        lx = x;
        ly = y;
    }
    let quant_adjustment = unpack_signed(r.read(&code, br, QUANT_ADJ_CTX));
    let mut total_points = num_splines;
    let mut splines = Vec::with_capacity(num_splines);
    for _ in 0..num_splines {
        let n = r.read(&code, br, NUM_POINTS_CTX) as usize;
        if n > max_points {
            return invalid("too many spline control points");
        }
        total_points += n;
        if total_points > max_points {
            return invalid("too many spline control points");
        }
        let mut deltas = Vec::with_capacity(n);
        for _ in 0..n {
            let a = i64::from(unpack_signed(r.read(&code, br, POINTS_CTX)));
            let b = i64::from(unpack_signed(r.read(&code, br, POINTS_CTX)));
            if a.abs() >= 1 << 30 || b.abs() >= 1 << 30 {
                return invalid("spline delta out of bounds");
            }
            deltas.push((a, b));
            if br.overrun() {
                return invalid("truncated splines");
            }
        }
        let mut dct = || -> Result<[i32; 32]> {
            let mut d = [0i32; 32];
            for v in d.iter_mut() {
                *v = unpack_signed(r.read(&code, br, DCT_CTX));
                if *v == i32::MIN {
                    return invalid("spline DCT value");
                }
            }
            Ok(d)
        };
        let color = [dct()?, dct()?, dct()?];
        let sigma = dct()?;
        splines.push(QuantizedSpline { deltas, color, sigma });
    }
    if !r.check_final_state() {
        return invalid("splines ANS state");
    }
    Ok(Splines { quant_adjustment, starts, splines })
}

fn inv_adjusted_quant(a: i32) -> f32 {
    if a >= 0 {
        1.0 / (1.0 + 0.125 * a as f32)
    } else {
        1.0 - 0.125 * a as f32
    }
}

struct Spline {
    points: Vec<(f32, f32)>,
    color: [[f32; 32]; 3],
    sigma: [f32; 32],
}

fn dequantize(q: &QuantizedSpline, start: (i64, i64), adj: i32, ytox: f32, ytob: f32, image_size: u64, total_area: &mut u64) -> Result<Spline> {
    let area_limit = (1024 * image_size + (1u64 << 32)).min(1u64 << 42);
    let (px, py) = (start.0 as f32, start.1 as f32);
    check_pos(px as i64, py as i64)?;
    let (mut cx, mut cy) = (px as i64, py as i64);
    let mut points = vec![(cx as f32, cy as f32)];
    let (mut dx, mut dy) = (0i64, 0i64);
    let mut manhattan = 0u64;
    for &(a, b) in &q.deltas {
        dx += a;
        dy += b;
        manhattan = manhattan.saturating_add(dx.unsigned_abs() + dy.unsigned_abs());
        if manhattan > area_limit {
            return invalid("spline too long");
        }
        check_pos(dx, dy)?;
        cx += dx;
        cy += dy;
        check_pos(cx, cy)?;
        points.push((cx as f32, cy as f32));
    }
    let inv_quant = inv_adjusted_quant(adj);
    let mut color = [[0f32; 32]; 3];
    for c in 0..3 {
        for i in 0..32 {
            let f = if i == 0 { SQRT0_5 } else { 1.0 };
            color[c][i] = q.color[c][i] as f32 * f * CHANNEL_WEIGHT[c] * inv_quant;
        }
    }
    for i in 0..32 {
        color[0][i] += ytox * color[1][i];
        color[2][i] += ytob * color[1][i];
    }
    let mut cmax = [0u64; 3];
    for c in 0..3 {
        for i in 0..32 {
            cmax[c] = cmax[c].saturating_add((inv_quant * (q.color[c][i] as f32).abs()).ceil() as u64);
        }
    }
    cmax[0] = cmax[0].saturating_add((ytox.abs().ceil() as u64).saturating_mul(cmax[1]));
    cmax[2] = cmax[2].saturating_add((ytob.abs().ceil() as u64).saturating_mul(cmax[1]));
    let max_color = cmax[0].max(cmax[1]).max(cmax[2]);
    let logcolor = u64::from(ceil_log2(max_color.saturating_add(1).min(u64::from(u32::MAX)) as u32)).max(1);
    let weight_limit = ((area_limit as f32 / logcolor as f32) / manhattan.max(1) as f32).sqrt().ceil();
    let mut sigma = [0f32; 32];
    let mut width_estimate = 0u64;
    for i in 0..32 {
        let f = if i == 0 { SQRT0_5 } else { 1.0 };
        sigma[i] = q.sigma[i] as f32 * f * CHANNEL_WEIGHT[3] * inv_quant;
        let wf = (inv_quant * (q.sigma[i] as f32).abs()).ceil();
        let w = weight_limit.min(wf.max(1.0)) as u64;
        width_estimate = width_estimate.saturating_add(w.saturating_mul(w).saturating_mul(logcolor));
    }
    *total_area = total_area.saturating_add(width_estimate.saturating_mul(manhattan));
    if *total_area > area_limit {
        return invalid("splines cover too much area");
    }
    Ok(Spline { points, color, sigma })
}

#[allow(clippy::excessive_precision)]
fn fast_cosf(x: f32) -> f32 {
    let pi = std::f64::consts::PI;
    let pi2 = (pi * 2.0) as f32;
    let pi2_inv = (0.5 / pi) as f32;
    let npi2 = (x * pi2_inv).floor() * pi2;
    let xmodpi2 = x - npi2;
    let x_pi = xmodpi2.min(pi2 - xmodpi2);
    let above = x_pi >= (pi / 2.0) as f32;
    let x_pihalf = if above { pi as f32 - x_pi } else { x_pi };
    let xs = x_pihalf * 0.25;
    let x2 = xs * xs;
    let x4 = x2 * x2;
    let pre = x4 * 0.06960438 + (x2 * -0.84087373 + 1.68179268);
    let s1 = pre * pre + -1.414213562;
    let s2 = s1 * s1 + -1.0;
    if above {
        -s2
    } else {
        s2
    }
}

#[allow(clippy::excessive_precision)]
fn fast_erff(x: f32) -> f32 {
    let a = x.abs();
    let d1 = a * 7.77394369e-02 + 2.05260015e-04;
    let d2 = d1 * a + 2.32120216e-01;
    let d3 = d2 * a + 2.77820801e-01;
    let d4 = d3 * a + 1.0;
    let d5 = d4 * d4;
    let inv = 1.0 / d5;
    let r = 1.0 - inv * inv;
    if x <= 0.0 {
        -r
    } else {
        r
    }
}

fn continuous_idct(dct: &[f32; 32], t: f32) -> f32 {
    let pi = std::f64::consts::PI;
    let mut result = 0f32;
    for (i, &d) in dct.iter().enumerate() {
        let m = (pi / 32.0 * i as f64) as f32;
        result += SQRT2 * (d * fast_cosf(m * (t + 0.5)));
    }
    result
}

fn catmull_rom(mut pts: Vec<(f32, f32)>) -> Vec<(f32, f32)> {
    if pts.len() <= 1 {
        return pts;
    }
    let mut out = Vec::with_capacity((pts.len() - 1) * 16 + 1);
    let first = (pts[0].0 + (pts[0].0 - pts[1].0), pts[0].1 + (pts[0].1 - pts[1].1));
    pts.insert(0, first);
    let n = pts.len();
    let last = (pts[n - 1].0 + (pts[n - 1].0 - pts[n - 2].0), pts[n - 1].1 + (pts[n - 1].1 - pts[n - 2].1));
    pts.push(last);
    for start in 0..pts.len() - 3 {
        let p = &pts[start..start + 4];
        out.push(p[1]);
        let mut d = [0f32; 3];
        let mut t = [0f32; 4];
        for k in 0..3 {
            d[k] = (p[k + 1].0 - p[k].0).hypot(p[k + 1].1 - p[k].1).sqrt();
            t[k + 1] = t[k] + d[k];
        }
        for i in 1..16 {
            let tt = d[0] + (i as f32 / 16.0) * d[1];
            let mut a = [(0f32, 0f32); 3];
            for k in 0..3 {
                let f = (tt - t[k]) / d[k];
                a[k] = (p[k].0 + f * (p[k + 1].0 - p[k].0), p[k].1 + f * (p[k + 1].1 - p[k].1));
            }
            let mut b = [(0f32, 0f32); 2];
            for k in 0..2 {
                let f = (tt - t[k]) / (d[k] + d[k + 1]);
                b[k] = (a[k].0 + f * (a[k + 1].0 - a[k].0), a[k].1 + f * (a[k + 1].1 - a[k].1));
            }
            let f = (tt - t[1]) / d[1];
            out.push((b[0].0 + f * (b[1].0 - b[0].0), b[0].1 + f * (b[1].1 - b[0].1)));
        }
    }
    out.push(pts[pts.len() - 2]);
    out
}

fn equally_spaced(points: &[(f32, f32)]) -> Vec<((f32, f32), f32)> {
    let mut out = Vec::new();
    let Some(&first) = points.first() else { return out };
    let mut current = first;
    out.push((current, 1.0));
    let mut next = 0usize;
    while next < points.len() {
        let mut previous = current;
        let mut from_prev = 0f32;
        loop {
            if next == points.len() {
                out.push((previous, from_prev));
                return out;
            }
            let p = points[next];
            let to_next = ((p.0 - previous.0) * (p.0 - previous.0) + (p.1 - previous.1) * (p.1 - previous.1)).sqrt();
            if from_prev + to_next >= 1.0 {
                let f = (1.0 - from_prev) / to_next;
                current = (previous.0 + f * (p.0 - previous.0), previous.1 + f * (p.1 - previous.1));
                out.push((current, 1.0));
                break;
            }
            from_prev += to_next;
            previous = p;
            next += 1;
        }
    }
    out
}

struct Segment {
    cx: f32,
    cy: f32,
    color: [f32; 3],
    inv_sigma: f32,
    s4i: f32,
    max_dist: f32,
    y0: usize,
    y1: usize,
}

/// Adds the splines to the three XYB planes (`w × h`).
pub fn draw(sp: &Splines, planes: &mut [Plane], ytox: f32, ytob: f32) -> Result<()> {
    let (w, h) = (planes[0].w, planes[0].h);
    let mut total_area = 0u64;
    let mut segments = Vec::new();
    for (i, q) in sp.splines.iter().enumerate() {
        let s = dequantize(q, sp.starts[i], sp.quant_adjustment, ytox, ytob, (w * h) as u64, &mut total_area)?;
        if s.points.windows(2).any(|p| p[0] == p[1]) {
            return invalid("identical successive spline control points");
        }
        let inter = catmull_rom(s.points.clone());
        let pts = equally_spaced(&inter);
        if pts.len() < 2 {
            continue;
        }
        let arc = (pts.len() - 2) as f32 + pts[pts.len() - 1].1;
        if arc <= 0.0 {
            continue;
        }
        let inv_arc = 1.0 / arc;
        for (k, &(pt, mult)) in pts.iter().enumerate() {
            let progress = (k as f32 * inv_arc).min(1.0);
            let mut color = [0f32; 3];
            for c in 0..3 {
                color[c] = continuous_idct(&s.color[c], 31.0 * progress);
            }
            let sigma = continuous_idct(&s.sigma, 31.0 * progress);
            let intensity = mult;
            if !(sigma.is_finite() && sigma != 0.0 && (1.0 / sigma).is_finite() && intensity.is_finite()) {
                continue;
            }
            let mut max_color = 0.01f32;
            for c in color.iter() {
                max_color = max_color.max((c * intensity).abs());
            }
            let md = (-2.0 * sigma * sigma * (0.1f32.ln() * 5.0 - max_color.ln())).sqrt();
            let y0 = ((pt.1 - md).round() as i64).max(0);
            let y1 = (((pt.1 + md).round() as i64) + 1).min(h as i64);
            if y1 <= y0 {
                continue;
            }
            segments.push(Segment { cx: pt.0, cy: pt.1, color, inv_sigma: 1.0 / sigma, s4i: 0.25 * sigma * intensity, max_dist: md, y0: y0 as usize, y1: y1 as usize });
        }
    }
    for s in &segments {
        let start = (s.cx - s.max_dist).round() as i64;
        let end = (s.cx + s.max_dist).round() as i64;
        if end < 0 || start >= w as i64 {
            continue;
        }
        let x0 = start.max(0) as usize;
        let x1 = ((end + 1).min(w as i64)) as usize;
        for y in s.y0..s.y1 {
            let dy = y as f32 - s.cy;
            for x in x0..x1 {
                let dx = x as f32 - s.cx;
                let dist = (dx * dx + dy * dy).sqrt();
                let f = fast_erff((dist * 0.5 + 0.353_553_39) * s.inv_sigma) - fast_erff((dist * 0.5 - 0.353_553_39) * s.inv_sigma);
                let li = s.s4i * (f * f);
                for c in 0..3 {
                    let v = &mut planes[c].data[y * w + x];
                    *v = s.color[c] * li + *v;
                }
            }
        }
    }
    Ok(())
}
