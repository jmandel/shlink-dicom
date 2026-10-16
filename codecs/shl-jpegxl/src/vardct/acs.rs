//! Varblock transform types ("AC strategies", ISO/IEC 18181-1 I.2.1) and their natural
//! coefficient orders.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AcStrategy(pub u8);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Dct,
    Identity,
    Dct2x2,
    Dct4x4,
    Dct4x8,
    Dct8x4,
    Afv(u8),
}

pub const NUM_STRATEGIES: u8 = 27;

const COVERED_X: [u8; 27] = [1, 1, 1, 1, 2, 4, 1, 2, 1, 4, 2, 4, 1, 1, 1, 1, 1, 1, 8, 4, 8, 16, 8, 16, 32, 16, 32];
const COVERED_Y: [u8; 27] = [1, 1, 1, 1, 2, 4, 2, 1, 4, 1, 4, 2, 1, 1, 1, 1, 1, 1, 8, 8, 4, 16, 16, 8, 32, 32, 16];
const LOG2_COVERED: [u8; 27] = [0, 0, 0, 0, 2, 4, 1, 1, 2, 2, 3, 3, 0, 0, 0, 0, 0, 0, 6, 5, 5, 8, 7, 7, 10, 9, 9];
/// Coefficient order bucket of each strategy.
pub const STRATEGY_ORDER: [u8; 27] = [0, 1, 1, 1, 2, 3, 4, 4, 5, 5, 6, 6, 1, 1, 1, 1, 1, 1, 7, 8, 8, 9, 10, 10, 11, 12, 12];
/// Quantisation table of each strategy.
pub const QUANT_TABLE: [u8; 27] = [0, 1, 2, 3, 4, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 10, 10, 11, 12, 12, 13, 14, 14, 15, 16, 16];
/// Start (in 64-coefficient units) of each (order, channel) in the coefficient order table.
pub const COEFF_ORDER_OFFSET: [u32; 40] = [
    0, 1, 2, 3, 4, 5, 6, 10, 14, 18, 34, 50, 66, 68, 70, 72, 76, 80, 84, 92, 100, 108, 172, 236, 300, 332, 364, 396, 652, 908,
    1164, 1292, 1420, 1548, 2572, 3596, 4620, 5132, 5644, 6156,
];

impl AcStrategy {
    pub fn covered_x(self) -> usize {
        usize::from(COVERED_X[self.0 as usize])
    }
    pub fn covered_y(self) -> usize {
        usize::from(COVERED_Y[self.0 as usize])
    }
    pub fn log2_covered(self) -> usize {
        usize::from(LOG2_COVERED[self.0 as usize])
    }
    pub fn is_multiblock(self) -> bool {
        self.covered_x() > 1 || self.covered_y() > 1
    }
    pub fn order(self) -> usize {
        usize::from(STRATEGY_ORDER[self.0 as usize])
    }
    pub fn quant_table(self) -> usize {
        usize::from(QUANT_TABLE[self.0 as usize])
    }
    pub fn kind(self) -> Kind {
        match self.0 {
            1 => Kind::Identity,
            2 => Kind::Dct2x2,
            3 => Kind::Dct4x4,
            12 => Kind::Dct4x8,
            13 => Kind::Dct8x4,
            14..=17 => Kind::Afv(self.0 - 14),
            _ => Kind::Dct,
        }
    }

    /// Natural coefficient order: position (in the `min × max`-block coefficient layout) of
    /// each coefficient index, lowest frequencies (the LLF block) first.
    pub fn natural_order(self) -> Vec<u32> {
        let mut cx = self.covered_x();
        let mut cy = self.covered_y();
        if cy > cx {
            std::mem::swap(&mut cx, &mut cy);
        }
        let n = cx * cy * 64;
        let mut out = vec![0u32; n];
        let xs = cx / cy;
        let xsm = xs - 1;
        let xss = xs.trailing_zeros() as usize;
        let mut cur = cx * cy;
        let w = cx * 8;
        for i in 0..w {
            for j in 0..=i {
                let (mut x, mut y) = (j, i - j);
                if i % 2 == 1 {
                    std::mem::swap(&mut x, &mut y);
                }
                if y & xsm != 0 {
                    continue;
                }
                y >>= xss;
                let val = if x < cx && y < cy {
                    y * cx + x
                } else {
                    cur += 1;
                    cur - 1
                };
                out[val] = (y * w + x) as u32;
            }
        }
        for ip in (1..w).rev() {
            let i = ip - 1;
            for j in 0..=i {
                let (mut x, mut y) = (w - 1 - (i - j), w - 1 - j);
                if i % 2 == 1 {
                    std::mem::swap(&mut x, &mut y);
                }
                if y & xsm != 0 {
                    continue;
                }
                y >>= xss;
                out[cur] = (y * w + x) as u32;
                cur += 1;
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dct8_order_is_zigzag() {
        let o = AcStrategy(0).natural_order();
        assert_eq!(&o[..10], &[0, 1, 8, 16, 9, 2, 3, 10, 17, 24]);
        let mut s = o.clone();
        s.sort_unstable();
        assert_eq!(s, (0..64).collect::<Vec<u32>>());
    }

    #[test]
    fn orders_are_permutations() {
        for t in 0..NUM_STRATEGIES {
            let o = AcStrategy(t).natural_order();
            let mut s = o.clone();
            s.sort_unstable();
            assert_eq!(s, (0..o.len() as u32).collect::<Vec<u32>>(), "strategy {t}");
        }
    }
}
