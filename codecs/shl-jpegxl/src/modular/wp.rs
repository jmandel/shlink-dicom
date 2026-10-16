//! The self-correcting weighted predictor (ISO/IEC 18181-1 H.5.2), integer-exact with libjxl.

use crate::bits::BitReader;
use crate::error::Result;

#[derive(Clone, Copy, Debug)]
pub struct WpHeader {
    pub p1c: i64,
    pub p2c: i64,
    pub p3ca: i64,
    pub p3cb: i64,
    pub p3cc: i64,
    pub p3cd: i64,
    pub p3ce: i64,
    pub w: [u32; 4],
}

impl Default for WpHeader {
    fn default() -> Self {
        WpHeader { p1c: 16, p2c: 10, p3ca: 7, p3cb: 7, p3cc: 7, p3cd: 0, p3ce: 0, w: [0xd, 0xc, 0xc, 0xc] }
    }
}

impl WpHeader {
    pub fn read(br: &mut BitReader) -> Result<Self> {
        if br.bit() {
            return Ok(WpHeader::default());
        }
        let mut r5 = || i64::from(br.read(5));
        let p1c = r5();
        let p2c = r5();
        let p3ca = r5();
        let p3cb = r5();
        let p3cc = r5();
        let p3cd = r5();
        let p3ce = r5();
        let w = [br.read(4), br.read(4), br.read(4), br.read(4)];
        Ok(WpHeader { p1c, p2c, p3ca, p3cb, p3cc, p3cd, p3ce, w })
    }
}

#[rustfmt::skip]
const DIVLOOKUP: [u32; 64] = [
    16777216, 8388608, 5592405, 4194304, 3355443, 2796202, 2396745, 2097152,
    1864135,  1677721, 1525201, 1398101, 1290555, 1198372, 1118481, 1048576,
    986895,   932067,  883011,  838860,  798915,  762600,  729444,  699050,
    671088,   645277,  621378,  599186,  578524,  559240,  541200,  524288,
    508400,   493447,  479349,  466033,  453438,  441505,  430185,  419430,
    409200,   399457,  390167,  381300,  372827,  364722,  356962,  349525,
    342392,   335544,  328965,  322638,  316551,  310689,  305040,  299593,
    294337,   289262,  284359,  279620,  275036,  270600,  266305,  262144,
];

/// Predictor state. Pixels must be predicted and updated in raster order. Instead of
/// libjxl's two error rows it keeps one row plus the neighbourhood in registers (the same
/// values: libjxl's rows add each new error into the entry to its upper right, so the N and
/// NW entries it reads hold N + W and NW + WW).
pub struct WpState {
    h: WpHeader,
    w: usize,
    x: usize,
    prediction: [i64; 4],
    pred: i64,
    row_true: Vec<i32>,
    row_err: Vec<[u32; 4]>,
    t_w: i32,
    t_nw: i32,
    t_n: i32,
    t_ne: i32,
    s_nw_ww: [u32; 4],
    s_n_w: [u32; 4],
    s_ne: [u32; 4],
}

#[inline(always)]
fn error_weight(x: u32, maxweight: u32) -> u32 {
    let x = u64::from(x);
    let shift = (63 - (x + 1).leading_zeros() as i32 - 5).max(0);
    4 + ((maxweight * DIVLOOKUP[(x >> shift) as usize & 63]) >> shift)
}

impl WpState {
    pub fn new(h: WpHeader, xsize: usize) -> Self {
        WpState {
            h,
            w: xsize,
            x: 0,
            prediction: [0; 4],
            pred: 0,
            row_true: vec![0; xsize.max(1)],
            row_err: vec![[0; 4]; xsize.max(1)],
            t_w: 0,
            t_nw: 0,
            t_n: 0,
            t_ne: 0,
            s_nw_ww: [0; 4],
            s_n_w: [0; 4],
            s_ne: [0; 4],
        }
    }

    /// Predicts the next sample from its neighbours; also returns property 15 (the largest of
    /// the neighbouring errors).
    #[inline(always)]
    #[allow(clippy::too_many_arguments)]
    pub fn predict(&mut self, _x: usize, _y: usize, n: i64, w: i64, ne: i64, nw: i64, nn: i64) -> (i64, i32) {
        let mut weights = [0u32; 4];
        for (i, wt) in weights.iter_mut().enumerate() {
            let s = self.s_nw_ww[i].wrapping_add(self.s_n_w[i]).wrapping_add(self.s_ne[i]);
            *wt = error_weight(s, self.h.w[i]);
        }
        let n = n.wrapping_shl(3);
        let w = w.wrapping_shl(3);
        let ne = ne.wrapping_shl(3);
        let nw = nw.wrapping_shl(3);
        let nn = nn.wrapping_shl(3);
        let te_w = i64::from(self.t_w);
        let te_n = i64::from(self.t_n);
        let te_nw = i64::from(self.t_nw);
        let te_ne = i64::from(self.t_ne);
        let sum_wn = te_n.wrapping_add(te_w);

        let mut p = te_w;
        if te_n.unsigned_abs() > p.unsigned_abs() {
            p = te_n;
        }
        if te_nw.unsigned_abs() > p.unsigned_abs() {
            p = te_nw;
        }
        if te_ne.unsigned_abs() > p.unsigned_abs() {
            p = te_ne;
        }
        let h = &self.h;
        self.prediction[0] = w.wrapping_add(ne).wrapping_sub(n);
        self.prediction[1] = n.wrapping_sub(sum_wn.wrapping_add(te_ne).wrapping_mul(h.p1c) >> 5);
        self.prediction[2] = w.wrapping_sub(sum_wn.wrapping_add(te_nw).wrapping_mul(h.p2c) >> 5);
        let t = te_nw
            .wrapping_mul(h.p3ca)
            .wrapping_add(te_n.wrapping_mul(h.p3cb))
            .wrapping_add(te_ne.wrapping_mul(h.p3cc))
            .wrapping_add(nn.wrapping_sub(n).wrapping_mul(h.p3cd))
            .wrapping_add(nw.wrapping_sub(w).wrapping_mul(h.p3ce));
        self.prediction[3] = n.wrapping_sub(t >> 5);

        let mut wsum: u32 = weights.iter().fold(0u32, |a, &b| a.wrapping_add(b));
        let log_weight = 31 - wsum.max(1).leading_zeros();
        let sh = log_weight.saturating_sub(4);
        wsum = 0;
        for wt in weights.iter_mut() {
            *wt >>= sh;
            wsum = wsum.wrapping_add(*wt);
        }
        let mut sum = i64::from(wsum >> 1) - 1;
        for i in 0..4 {
            sum = sum.wrapping_add(self.prediction[i].wrapping_mul(i64::from(weights[i])));
        }
        let div = i64::from(DIVLOOKUP[(wsum.wrapping_sub(1) & 63) as usize]);
        self.pred = sum.wrapping_mul(div) >> 24;

        if ((te_n ^ te_w) | (te_n ^ te_nw)) <= 0 {
            let mx = w.max(ne.max(n));
            let mn = w.min(ne.min(n));
            self.pred = self.pred.min(mx).max(mn);
        }
        ((self.pred.wrapping_add(3)) >> 3, p as i32)
    }

    /// Records the decoded value of the sample just predicted.
    #[inline(always)]
    pub fn update(&mut self, val: i64, _x: usize, _y: usize) {
        let val = val.wrapping_shl(3);
        let true_err = self.pred.wrapping_sub(val) as i32;
        let mut errs = [0u32; 4];
        for (i, e) in errs.iter_mut().enumerate() {
            *e = (self.prediction[i].wrapping_sub(val).unsigned_abs().wrapping_add(3) >> 3) as u32;
        }
        let x = self.x;
        if let Some(t) = self.row_true.get_mut(x) {
            *t = true_err;
        }
        if let Some(e) = self.row_err.get_mut(x) {
            *e = errs;
        }
        let x = x + 1;
        if x >= self.w {
            self.x = 0;
            self.t_w = 0;
            self.t_n = self.row_true[0];
            self.t_nw = self.t_n;
            self.s_n_w = self.row_err[0];
            self.s_nw_ww = self.s_n_w;
            if self.w <= 1 {
                self.t_ne = self.t_n;
                self.s_ne = self.s_n_w;
            } else {
                self.t_ne = self.row_true[1];
                self.s_ne = self.row_err[1];
            }
        } else {
            self.x = x;
            self.t_w = true_err;
            self.t_nw = self.t_n;
            self.t_n = self.t_ne;
            self.s_nw_ww = self.s_n_w;
            let mut snw = self.s_ne;
            for i in 0..4 {
                snw[i] = snw[i].wrapping_add(errs[i]);
            }
            self.s_n_w = snw;
            if x + 1 >= self.w {
                self.t_ne = self.t_n;
                self.s_ne = self.s_n_w;
            } else {
                self.t_ne = self.row_true[x + 1];
                self.s_ne = self.row_err[x + 1];
            }
        }
    }
}
