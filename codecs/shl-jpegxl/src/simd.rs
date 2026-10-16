//! Four f32 lanes. With wasm32 simd128 this is a v128 and every operation one instruction;
//! elsewhere a plain array the compiler may vectorise. Loads and stores go through fixed-size
//! array lanes, which LLVM turns into single vector loads and stores, so no unsafe is needed.
//! Every operation rounds exactly as the scalar code would.

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod imp {
    use core::arch::wasm32::*;

    #[derive(Clone, Copy)]
    pub struct F4(v128);

    impl F4 {
        #[inline(always)]
        pub fn load(s: &[f32]) -> F4 {
            let a: &[f32; 4] = s[..4].try_into().unwrap();
            F4(f32x4(a[0], a[1], a[2], a[3]))
        }
        #[inline(always)]
        pub fn store(self, d: &mut [f32]) {
            let a: &mut [f32; 4] = (&mut d[..4]).try_into().unwrap();
            a[0] = f32x4_extract_lane::<0>(self.0);
            a[1] = f32x4_extract_lane::<1>(self.0);
            a[2] = f32x4_extract_lane::<2>(self.0);
            a[3] = f32x4_extract_lane::<3>(self.0);
        }
        #[inline(always)]
        pub fn splat(v: f32) -> F4 {
            F4(f32x4_splat(v))
        }
        /// Four i32 converted to f32 (as `v as f32`).
        #[inline(always)]
        pub fn from_i32(s: &[i32]) -> F4 {
            let a: &[i32; 4] = s[..4].try_into().unwrap();
            F4(f32x4_convert_i32x4(i32x4(a[0], a[1], a[2], a[3])))
        }
        #[inline(always)]
        pub fn add(self, o: F4) -> F4 {
            F4(f32x4_add(self.0, o.0))
        }
        #[inline(always)]
        pub fn sub(self, o: F4) -> F4 {
            F4(f32x4_sub(self.0, o.0))
        }
        #[inline(always)]
        pub fn mul(self, o: F4) -> F4 {
            F4(f32x4_mul(self.0, o.0))
        }
        #[inline(always)]
        pub fn div(self, o: F4) -> F4 {
            F4(f32x4_div(self.0, o.0))
        }
        #[inline(always)]
        pub fn abs(self) -> F4 {
            F4(f32x4_abs(self.0))
        }
        /// `self.max(0.0)` as f32::max does it (NaN gives 0).
        #[inline(always)]
        pub fn max0(self) -> F4 {
            F4(f32x4_pmax(f32x4_splat(0.0), self.0))
        }
        /// Lanes where `self > o` take `a`, the others `b`.
        #[inline(always)]
        pub fn gt_select(self, o: F4, a: F4, b: F4) -> F4 {
            F4(v128_bitselect(a.0, b.0, f32x4_gt(self.0, o.0)))
        }
        /// Transposes the 4×4 matrix whose rows are `r`.
        #[inline(always)]
        pub fn transpose4(r: [F4; 4]) -> [F4; 4] {
            let t0 = i32x4_shuffle::<0, 4, 1, 5>(r[0].0, r[1].0);
            let t1 = i32x4_shuffle::<0, 4, 1, 5>(r[2].0, r[3].0);
            let t2 = i32x4_shuffle::<2, 6, 3, 7>(r[0].0, r[1].0);
            let t3 = i32x4_shuffle::<2, 6, 3, 7>(r[2].0, r[3].0);
            [
                F4(i64x2_shuffle::<0, 2>(t0, t1)),
                F4(i64x2_shuffle::<1, 3>(t0, t1)),
                F4(i64x2_shuffle::<0, 2>(t2, t3)),
                F4(i64x2_shuffle::<1, 3>(t2, t3)),
            ]
        }
        #[inline(always)]
        pub fn copysign(self, sign: F4) -> F4 {
            let m = f32x4_splat(-0.0);
            F4(v128_or(v128_andnot(self.0, m), v128_and(sign.0, m)))
        }
    }
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
mod imp {
    #[derive(Clone, Copy)]
    pub struct F4([f32; 4]);

    macro_rules! lanes {
        ($s:expr, $o:expr, $f:expr) => {
            F4([$f($s.0[0], $o.0[0]), $f($s.0[1], $o.0[1]), $f($s.0[2], $o.0[2]), $f($s.0[3], $o.0[3])])
        };
    }

    impl F4 {
        #[inline(always)]
        pub fn load(s: &[f32]) -> F4 {
            F4(s[..4].try_into().unwrap())
        }
        #[inline(always)]
        pub fn store(self, d: &mut [f32]) {
            d[..4].copy_from_slice(&self.0);
        }
        #[inline(always)]
        pub fn splat(v: f32) -> F4 {
            F4([v; 4])
        }
        #[inline(always)]
        pub fn from_i32(s: &[i32]) -> F4 {
            let a: &[i32; 4] = s[..4].try_into().unwrap();
            F4(a.map(|v| v as f32))
        }
        #[inline(always)]
        pub fn add(self, o: F4) -> F4 {
            lanes!(self, o, |a: f32, b: f32| a + b)
        }
        #[inline(always)]
        pub fn sub(self, o: F4) -> F4 {
            lanes!(self, o, |a: f32, b: f32| a - b)
        }
        #[inline(always)]
        pub fn mul(self, o: F4) -> F4 {
            lanes!(self, o, |a: f32, b: f32| a * b)
        }
        #[inline(always)]
        pub fn div(self, o: F4) -> F4 {
            lanes!(self, o, |a: f32, b: f32| a / b)
        }
        #[inline(always)]
        pub fn abs(self) -> F4 {
            F4(self.0.map(f32::abs))
        }
        #[inline(always)]
        pub fn max0(self) -> F4 {
            F4(self.0.map(|v| v.max(0.0)))
        }
        #[inline(always)]
        pub fn gt_select(self, o: F4, a: F4, b: F4) -> F4 {
            let mut r = b.0;
            for i in 0..4 {
                if self.0[i] > o.0[i] {
                    r[i] = a.0[i];
                }
            }
            F4(r)
        }
        #[inline(always)]
        pub fn copysign(self, sign: F4) -> F4 {
            lanes!(self, sign, f32::copysign)
        }
        #[inline(always)]
        pub fn transpose4(r: [F4; 4]) -> [F4; 4] {
            core::array::from_fn(|i| F4(core::array::from_fn(|j| r[j].0[i])))
        }
    }
}

pub use imp::F4;

#[cfg(test)]
mod tests {
    use super::F4;

    fn lanes(v: F4) -> [f32; 4] {
        let mut a = [0f32; 4];
        v.store(&mut a);
        a
    }

    /// Each lane operation must equal the scalar operation, special values included.
    #[test]
    fn lanes_match_scalar() {
        let xs = [0.0f32, -0.0, 1.5, -2.25, f32::NAN, f32::INFINITY, -f32::INFINITY, 1e-40, 3.0e38, -7.0, 0.1, 1.125];
        for a in xs.chunks(4) {
            for b in xs.chunks(4).rev() {
                let (va, vb) = (F4::load(a), F4::load(b));
                let check = |got: [f32; 4], f: &dyn Fn(f32, f32) -> f32| {
                    for i in 0..4 {
                        assert_eq!(got[i].to_bits(), f(a[i], b[i]).to_bits(), "{} {}", a[i], b[i]);
                    }
                };
                check(lanes(va.add(vb)), &|x, y| x + y);
                check(lanes(va.sub(vb)), &|x, y| x - y);
                check(lanes(va.mul(vb)), &|x, y| x * y);
                check(lanes(va.div(vb)), &|x, y| x / y);
                check(lanes(va.abs()), &|x, _| x.abs());
                check(lanes(va.max0()), &|x, _| x.max(0.0));
                check(lanes(va.copysign(vb)), &|x, y| x.copysign(y));
                check(lanes(va.gt_select(vb, F4::splat(1.0), F4::splat(2.0))), &|x, y| if x > y { 1.0 } else { 2.0 });
            }
        }
        let q = [0i32, -3, 1 << 30, i32::MIN];
        assert_eq!(lanes(F4::from_i32(&q)), q.map(|v| v as f32));
        let rows: [F4; 4] = core::array::from_fn(|r| F4::load(&[r as f32 * 4.0, r as f32 * 4.0 + 1.0, r as f32 * 4.0 + 2.0, r as f32 * 4.0 + 3.0]));
        let t = F4::transpose4(rows).map(lanes);
        for (r, row) in t.iter().enumerate() {
            for (c, &v) in row.iter().enumerate() {
                assert_eq!(v, (c * 4 + r) as f32);
            }
        }
    }
}
