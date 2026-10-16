//! The output buffer: rows of interleaved samples, little-endian, Bits Allocated wide.

use crate::invalid;
use shl_codec_common::Result;

pub(crate) struct Sink {
    data: Vec<u8>,
    row_bytes: usize,
}

impl Sink {
    pub(crate) fn new(w: usize, h: usize, n: usize, bps: usize) -> Result<Self> {
        let row_bytes = w
            .checked_mul(n)
            .and_then(|v| v.checked_mul(bps))
            .ok_or_else(|| invalid("frame size overflows"))?;
        let total = row_bytes.checked_mul(h).ok_or_else(|| invalid("frame size overflows"))?;
        Ok(Self { data: vec![0; total], row_bytes })
    }

    #[inline(always)]
    pub(crate) fn row(&mut self, y: usize) -> &mut [u8] {
        &mut self.data[y * self.row_bytes..(y + 1) * self.row_bytes]
    }

    pub(crate) fn into_data(self) -> Vec<u8> {
        self.data
    }
}

/// A decoded sample as the DCT planes store it: `u8` for 8-bit precision, `u16` otherwise.
pub(crate) trait Sample: Copy + Default + Into<i32> + 'static {
    /// Bytes per sample (used by the SIMD kernels' stores).
    #[allow(dead_code)]
    const BYTES: usize;
    /// From a value known to fit (at most the precision's maximum).
    fn from_u16(v: u16) -> Self;
}

impl Sample for u8 {
    const BYTES: usize = 1;
    #[inline(always)]
    fn from_u16(v: u16) -> Self {
        v as u8
    }
}

impl Sample for u16 {
    const BYTES: usize = 2;
    #[inline(always)]
    fn from_u16(v: u16) -> Self {
        v
    }
}

/// Write `src` to `out` at `bps` (1, 2 or 4) bytes per sample.
#[inline(always)]
pub(crate) fn put_row<T: Sample>(src: &[T], out: &mut [u8], bps: usize) {
    match bps {
        1 => {
            for (o, &s) in out.iter_mut().zip(src) {
                *o = s.into() as u8;
            }
        }
        2 => {
            for (o, &s) in out.chunks_exact_mut(2).zip(src) {
                o.copy_from_slice(&(s.into() as u16).to_le_bytes());
            }
        }
        _ => {
            for (o, &s) in out.chunks_exact_mut(4).zip(src) {
                o.copy_from_slice(&(s.into() as u16 as u32).to_le_bytes());
            }
        }
    }
}

/// Interleave one row of each component into `out`.
#[inline(always)]
pub(crate) fn interleave_row<T: Sample>(srcs: &[&[T]], out: &mut [u8], bps: usize) {
    if let [a, b, c] = srcs {
        match bps {
            1 => {
                #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
                let done = crate::simd::wasm::rgb_row8(a, b, c, out);
                #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
                let done = 0;
                let (a, b, c, out) = (&a[done..], &b[done..], &c[done..], &mut out[3 * done..]);
                for (o, ((&a, &b), &c)) in out.chunks_exact_mut(3).zip(a.iter().zip(b.iter()).zip(c.iter())) {
                    o.copy_from_slice(&[a.into() as u8, b.into() as u8, c.into() as u8]);
                }
                return;
            }
            2 => {
                for (o, ((&a, &b), &c)) in out.chunks_exact_mut(6).zip(a.iter().zip(b.iter()).zip(c.iter())) {
                    let [a, b, c] = [a, b, c].map(|v| (v.into() as u16).to_le_bytes());
                    o.copy_from_slice(&[a[0], a[1], b[0], b[1], c[0], c[1]]);
                }
                return;
            }
            _ => {}
        }
    }
    let n = srcs.len();
    for (c, src) in srcs.iter().enumerate() {
        for (x, &s) in src.iter().enumerate() {
            let i = (x * n + c) * bps;
            if let Some(o) = out.get_mut(i..i + bps) {
                put_row(&[s], o, bps);
            }
        }
    }
}
