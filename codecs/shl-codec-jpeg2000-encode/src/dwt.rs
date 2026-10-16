//! Forward reversible 5/3 wavelet transform (T.800 Annex F.4, Equations F-9 and F-10), for an image
//! whose origin is (0, 0): even-indexed samples are low-pass.

/// One 1D lifting pass on `x` (length `n` >= 2), writing the low-pass then the high-pass
/// coefficients to `out`.
fn fwd_1d(x: &[i32], out: &mut [i32]) {
    let n = x.len();
    let (nl, nh) = (n.div_ceil(2), n / 2);
    let (low, high) = out.split_at_mut(nl);
    // d[i] = x[2i+1] − ⌊(x[2i] + x[2i+2]) / 2⌋, with x[n] = x[n−2].
    for (i, d) in high.iter_mut().enumerate().take(nh) {
        let right = if 2 * i + 2 < n { x[2 * i + 2] } else { x[2 * i] };
        *d = x[2 * i + 1] - ((x[2 * i] + right) >> 1);
    }
    // s[i] = x[2i] + ⌊(d[i−1] + d[i] + 2) / 4⌋, with d[−1] = d[0] and d[nh] = d[nh−1].
    for (i, s) in low.iter_mut().enumerate() {
        let dl = if i > 0 { high[i - 1] } else { high[0] };
        let dr = if i < nh { high[i] } else { high[nh - 1] };
        *s = x[2 * i] + ((dl + dr + 2) >> 2);
    }
}

/// Transform `buf` (`w` × `h`, row stride `stride`) in place over `levels` levels, Mallat layout:
/// after each level the low-pass band of the region occupies its top-left corner.
pub(crate) fn forward(buf: &mut [i32], stride: usize, w: usize, h: usize, levels: u32) {
    let (mut cw, mut ch) = (w, h);
    let mut line = vec![0i32; w.max(h)];
    let mut tmp = vec![0i32; w.max(h)];
    for _ in 0..levels {
        // Vertical, then horizontal (2D_SD, F.4.2).
        if ch >= 2 {
            for x in 0..cw {
                for y in 0..ch {
                    line[y] = buf[y * stride + x];
                }
                fwd_1d(&line[..ch], &mut tmp[..ch]);
                for y in 0..ch {
                    buf[y * stride + x] = tmp[y];
                }
            }
        }
        if cw >= 2 {
            for y in 0..ch {
                let row = &mut buf[y * stride..y * stride + cw];
                line[..cw].copy_from_slice(row);
                fwd_1d(&line[..cw], row);
            }
        }
        cw = cw.div_ceil(2);
        ch = ch.div_ceil(2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The inverse (F.4.8), to check the forward transform round-trips.
    fn inv_1d(y: &[i32]) -> Vec<i32> {
        let n = y.len();
        let (nl, nh) = (n.div_ceil(2), n / 2);
        let (s, d) = y.split_at(nl);
        let mut x = vec![0i32; n];
        for i in 0..nl {
            let dl = if i > 0 { d[i - 1] } else { d[0] };
            let dr = if i < nh { d[i] } else { d[nh - 1] };
            x[2 * i] = s[i] - ((dl + dr + 2) >> 2);
        }
        for i in 0..nh {
            let right = if 2 * i + 2 < n { x[2 * i + 2] } else { x[2 * i] };
            x[2 * i + 1] = d[i] + ((x[2 * i] + right) >> 1);
        }
        x
    }

    #[test]
    fn one_d_round_trips() {
        for n in 2..20 {
            let x: Vec<i32> = (0..n as i32).map(|i| (i * 37 % 23) - 11).collect();
            let mut y = vec![0; n];
            fwd_1d(&x, &mut y);
            assert_eq!(inv_1d(&y), x, "n = {n}");
        }
    }
}
