//! The array-based multiple component transformations of ITU-T T.801 |
//! ISO/IEC 15444-2 Annex J (JPEG 2000 Part 2), as DICOM uses them for the transfer syntaxes
//! 1.2.840.10008.1.2.4.92 and .93.
//!
//! Read from the main header: CBD (A.3.6), MCT (A.3.7), MCC (A.3.8) and MCO (A.3.9), with
//! series of marker segments (Zmct/Ymct, Zmcc/Ymcc) joined. Applied after every tile is
//! decoded, in place of the DC level shift (J.2.1): each MCO stage runs its MCC component
//! collections, each an array-based decorrelation (J.3.1.1) or dependency (J.3.1.2)
//! transformation, reversible or irreversible, with an optional offset array. Null
//! intermediate components are zero (J.2.3.1).
//!
//! Refused as unsupported: the wavelet-based transformation (J.3.2), and these marker
//! segments in a tile-part header (tile overrides; `codestream.rs` refuses them there).

#![allow(clippy::type_complexity, clippy::needless_range_loop)]

use crate::error::{Error, Result};

/// Rsiz bit 15: a Part 2 codestream (T.801 Table A.2).
pub const RSIZ_PART2: u16 = 0x8000;
/// Rsiz: the multiple component transformation capability.
pub const RSIZ_MCT: u16 = 0x0100;
/// SGcod multiple component transformation type (T.801 Table A.8): array-based.
pub const COD_MCT_ARRAY: u8 = 0x02;
/// SGcod: wavelet-based.
pub const COD_MCT_WAVELET: u8 = 0x04;
/// The largest number of components (CBD, MCC) T.801 allows.
const MAX_COMPONENTS: usize = 16_384;

/// One reconstructed image component from CBD.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutputComponent {
    pub precision: u8,
    pub signed: bool,
}

/// The Part 2 multiple component transformation marker segments of a main header.
#[derive(Debug, Clone, Default)]
pub struct Part2Header {
    pub cbd: Option<Vec<OutputComponent>>,
    /// MCT series by Imct (index | array type | element type): (Zmct, Ymct, data).
    mct: Vec<(u16, Vec<(u16, Option<u16>, Vec<u8>)>)>,
    /// MCC series by Imcc: (Zmcc, Ymcc and Qmcc if Zmcc = 0, data).
    mcc: Vec<(u8, Vec<(u16, Option<(u16, u16)>, Vec<u8>)>)>,
    /// MCO: the MCC index of each stage.
    pub mco: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Dependency,
    Decorrelation,
    Wavelet,
}

#[derive(Debug, Clone)]
struct Collection {
    kind: Kind,
    inputs: Vec<usize>,
    outputs: Vec<usize>,
    /// Tmcc: transform array index (bits 0-7), offset array index (8-15), reversible (16).
    tmcc: u32,
}

/// The transformation, validated against the number of codestream components.
#[derive(Debug, Clone)]
pub struct Part2Transform {
    pub outputs: Vec<OutputComponent>,
    stages: Vec<Vec<Step>>,
    /// Number of intermediate components after each stage (the last is the CBD count).
    sizes: Vec<usize>,
}

#[derive(Debug, Clone)]
struct Step {
    kind: Kind,
    reversible: bool,
    inputs: Vec<usize>,
    outputs: Vec<usize>,
    /// Row-major coefficients, in the order of J.3.1 for the kind (empty: the default array).
    coefficients: Vec<f64>,
    /// One per output component (empty: zero offsets).
    offsets: Vec<f64>,
}

fn invalid<T>() -> Result<T> {
    Err(Error::Invalid("Part 2 multiple component transformation".into()))
}

fn be16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*b.get(at)?, *b.get(at + 1)?]))
}

impl Part2Header {
    /// CBD (A.3.6). `data` is the marker segment after Lcbd.
    pub fn read_cbd(&mut self, data: &[u8]) -> Result<()> {
        if self.cbd.is_some() {
            return invalid();
        }
        let n = be16(data, 0).ok_or(Error::Invalid("truncated CBD".into()))?;
        let count = usize::from(n & 0x7FFF);
        if count == 0 || count > MAX_COMPONENTS {
            return invalid();
        }
        let depth = |b: u8| -> Result<OutputComponent> {
            let precision = (b & 0x7F) + 1;
            if precision > 38 {
                return invalid();
            }
            Ok(OutputComponent { precision, signed: b & 0x80 != 0 })
        };
        let comps = if n & 0x8000 != 0 {
            if data.len() != 3 {
                return invalid();
            }
            vec![depth(data[2])?; count]
        } else {
            if data.len() != 2 + count {
                return invalid();
            }
            data[2..].iter().map(|&b| depth(b)).collect::<Result<Vec<_>>>()?
        };
        self.cbd = Some(comps);
        Ok(())
    }

    /// MCT (A.3.7). `data` is the marker segment after Lmct.
    pub fn read_mct(&mut self, data: &[u8]) -> Result<()> {
        let z = be16(data, 0).ok_or(Error::Invalid("truncated MCT".into()))?;
        let imct = be16(data, 2).ok_or(Error::Invalid("truncated MCT".into()))?;
        let (y, rest) = if z == 0 {
            (Some(be16(data, 4).ok_or(Error::Invalid("truncated MCT".into()))?), &data[6..])
        } else {
            (None, &data[4..])
        };
        if imct & 0xF000 != 0 || imct & 0xFF == 0 || (imct >> 8) & 3 == 3 {
            return invalid();
        }
        let series = match self.mct.iter_mut().find(|(i, _)| *i == imct) {
            Some((_, s)) => s,
            None => {
                self.mct.push((imct, Vec::new()));
                &mut self.mct.last_mut().ok_or(Error::Invalid("Part 2 multiple component transformation".into()))?.1
            }
        };
        series.push((z, y, rest.to_vec()));
        Ok(())
    }

    /// MCC (A.3.8). `data` is the marker segment after Lmcc.
    pub fn read_mcc(&mut self, data: &[u8]) -> Result<()> {
        let z = be16(data, 0).ok_or(Error::Invalid("truncated MCC".into()))?;
        let imcc = *data.get(2).ok_or(Error::Invalid("truncated MCC".into()))?;
        let (yq, rest) = if z == 0 {
            let y = be16(data, 3).ok_or(Error::Invalid("truncated MCC".into()))?;
            let q = be16(data, 5).ok_or(Error::Invalid("truncated MCC".into()))?;
            (Some((y, q)), &data[7..])
        } else {
            (None, &data[3..])
        };
        let series = match self.mcc.iter_mut().find(|(i, _)| *i == imcc) {
            Some((_, s)) => s,
            None => {
                self.mcc.push((imcc, Vec::new()));
                &mut self.mcc.last_mut().ok_or(Error::Invalid("Part 2 multiple component transformation".into()))?.1
            }
        };
        series.push((z, yq, rest.to_vec()));
        Ok(())
    }

    /// MCO (A.3.9). `data` is the marker segment after Lmco.
    pub fn read_mco(&mut self, data: &[u8]) -> Result<()> {
        let n = *data.first().ok_or(Error::Invalid("truncated MCO".into()))?;
        if self.mco.is_some() || data.len() != 1 + usize::from(n) {
            return invalid();
        }
        self.mco = Some(data[1..].to_vec());
        Ok(())
    }

    /// The array with this index and type (0 dependency, 1 decorrelation, 2 offset), its
    /// series joined in Zmct order, as values.
    fn array(&self, index: u8, array_type: u16) -> Result<Vec<f64>> {
        let Some((imct, series)) =
            self.mct.iter().find(|(i, _)| *i & 0xFF == u16::from(index) && (*i >> 8) & 3 == array_type)
        else {
            return invalid();
        };
        let bytes = join_series(series.iter().map(|(z, y, d)| (*z, *y, d.as_slice())))?;
        let element = (imct >> 10) & 3;
        let size = [2usize, 4, 4, 8][usize::from(element)];
        if bytes.len() % size != 0 {
            return invalid();
        }
        Ok(bytes
            .chunks_exact(size)
            .map(|c| match element {
                0 => f64::from(i16::from_be_bytes([c[0], c[1]])),
                1 => f64::from(i32::from_be_bytes([c[0], c[1], c[2], c[3]])),
                2 => f64::from(f32::from_be_bytes([c[0], c[1], c[2], c[3]])),
                _ => f64::from_be_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]),
            })
            .collect())
    }

    /// The component collections of the MCC series with this index.
    fn collections(&self, index: u8) -> Result<Vec<Collection>> {
        let Some((_, series)) = self.mcc.iter().find(|(i, _)| *i == index) else {
            return invalid();
        };
        let q = match series.iter().find(|(z, _, _)| *z == 0) {
            Some((_, Some((_, q)), _)) => *q,
            _ => return invalid(),
        };
        let bytes = join_series(series.iter().map(|(z, yq, d)| (*z, yq.map(|(y, _)| y), d.as_slice())))?;
        let mut at = 0usize;
        let mut byte = || -> Result<u8> {
            let b = *bytes.get(at).ok_or(Error::Invalid("Part 2 multiple component transformation".into()))?;
            at += 1;
            Ok(b)
        };
        let mut out = Vec::new();
        for _ in 0..q {
            let x = byte()?;
            let kind = match x & 3 {
                0 => Kind::Dependency,
                1 => Kind::Decorrelation,
                3 => Kind::Wavelet,
                _ => return invalid(),
            };
            let list = |byte: &mut dyn FnMut() -> Result<u8>| -> Result<Vec<usize>> {
                let n = u16::from_be_bytes([byte()?, byte()?]);
                let wide = n & 0x8000 != 0;
                let count = usize::from(n & 0x7FFF);
                if count == 0 || count > MAX_COMPONENTS {
                    return invalid();
                }
                (0..count)
                    .map(|_| {
                        Ok(if wide { usize::from(u16::from_be_bytes([byte()?, byte()?])) } else { usize::from(byte()?) })
                    })
                    .collect()
            };
            let inputs = list(&mut byte)?;
            let outputs = list(&mut byte)?;
            let tmcc = u32::from_be_bytes([0, byte()?, byte()?, byte()?]);
            if kind == Kind::Wavelet {
                // Omcc (32 bits).
                for _ in 0..4 {
                    byte()?;
                }
            }
            out.push(Collection { kind, inputs, outputs, tmcc });
        }
        if at != bytes.len() {
            return invalid();
        }
        Ok(out)
    }

    /// Build the transformation for `csiz` codestream components. Wavelet-based collections
    /// give `Error::Unsupported`; anything inconsistent gives `Error::Invalid`.
    pub fn transform(&self, csiz: usize) -> Result<Part2Transform> {
        let Some(outputs) = self.cbd.clone() else {
            return invalid();
        };
        let Some(mco) = &self.mco else {
            return invalid();
        };
        let mut stages = Vec::with_capacity(mco.len());
        for &index in mco {
            let mut steps = Vec::new();
            for c in self.collections(index)? {
                if c.kind == Kind::Wavelet {
                    return Err(Error::Unsupported("Part 2 wavelet-based multiple component transformation".into()));
                }
                let reversible = c.tmcc & 0x1_0000 != 0;
                let t_index = (c.tmcc & 0xFF) as u8;
                let o_index = ((c.tmcc >> 8) & 0xFF) as u8;
                let array_type = if c.kind == Kind::Dependency { 0 } else { 1 };
                let coefficients = if t_index == 0 { Vec::new() } else { self.array(t_index, array_type)? };
                let offsets = if o_index == 0 { Vec::new() } else { self.array(o_index, 2)? };
                let step = Step { kind: c.kind, reversible, inputs: c.inputs, outputs: c.outputs, coefficients, offsets };
                step.validate()?;
                steps.push(step);
            }
            stages.push(steps);
        }
        // Intermediate component counts (J-1): stage k reads NI_k components; NI_0 = Csiz and
        // the last stage writes NI_Nmco = Ncbd.
        let mut sizes = Vec::with_capacity(stages.len());
        for (k, steps) in stages.iter().enumerate() {
            let max_in = steps.iter().flat_map(|s| s.inputs.iter()).copied().max().ok_or(Error::Invalid("Part 2 multiple component transformation".into()))?;
            if k == 0 && max_in >= csiz {
                return invalid();
            }
            if k > 0 {
                sizes.push(max_in + 1);
            }
        }
        sizes.push(outputs.len());
        for (steps, &size) in stages.iter().zip(&sizes) {
            let mut seen = vec![false; size];
            for o in steps.iter().flat_map(|s| s.outputs.iter()) {
                match seen.get_mut(*o) {
                    Some(s) if !*s => *s = true,
                    // Out of range, or written twice in one stage (A.3.8).
                    _ => return invalid(),
                }
            }
        }
        Ok(Part2Transform { outputs, stages, sizes })
    }
}

/// Join a series of marker segments in Zmct/Zmcc order: Z runs 0..=Y with no gaps.
fn join_series<'a>(parts: impl Iterator<Item = (u16, Option<u16>, &'a [u8])>) -> Result<Vec<u8>> {
    let mut parts: Vec<_> = parts.collect();
    parts.sort_by_key(|p| p.0);
    let last = match parts.first() {
        Some((0, Some(y), _)) => *y,
        _ => return invalid(),
    };
    if parts.len() != usize::from(last) + 1 || parts.iter().enumerate().any(|(i, p)| usize::from(p.0) != i) {
        return invalid();
    }
    Ok(parts.iter().flat_map(|p| p.2.iter().copied()).collect())
}

fn is_integer(v: f64) -> bool {
    v.is_finite() && v.abs() < 9.0e15 && (v as i64) as f64 == v
}

fn is_power_of_two(v: f64) -> bool {
    is_integer(v) && v >= 1.0 && (v as u64).is_power_of_two()
}

impl Step {
    fn n(&self) -> usize {
        self.inputs.len()
    }

    fn m(&self) -> usize {
        self.outputs.len()
    }

    /// The array sizes and value constraints of J.3.1 for this kind.
    fn validate(&self) -> Result<()> {
        let (n, m) = (self.n(), self.m());
        let coefficients = match (self.kind, self.reversible) {
            (Kind::Decorrelation, false) => m * n,
            (Kind::Decorrelation, true) | (Kind::Dependency, _) if n != m => return invalid(),
            (Kind::Decorrelation, true) => (n + 1) * n,
            (Kind::Dependency, false) => m * (m - 1) / 2,
            (Kind::Dependency, true) => m * (m + 1) / 2 - 1,
            (Kind::Wavelet, _) => return invalid(),
        };
        if !self.coefficients.is_empty() && self.coefficients.len() != coefficients {
            return invalid();
        }
        if !self.offsets.is_empty() && self.offsets.len() != m {
            return invalid();
        }
        if self.coefficients.iter().chain(&self.offsets).any(|v| !v.is_finite()) {
            return invalid();
        }
        if self.reversible {
            if self.coefficients.iter().chain(&self.offsets).any(|&v| !is_integer(v)) {
                return invalid();
            }
            if !self.coefficients.is_empty() {
                match self.kind {
                    Kind::Decorrelation => {
                        // Scale factors: t_l(N-1-l) for l < N, positive powers of 2, and
                        // |t_N(N-1)|.
                        for l in 0..n {
                            if !is_power_of_two(self.coefficients[l * n + (n - 1 - l)]) {
                                return invalid();
                            }
                        }
                        if !is_power_of_two(self.coefficients[n * n + n - 1].abs()) {
                            return invalid();
                        }
                    }
                    _ => {
                        for i in 1..m {
                            if !is_power_of_two(self.coefficients[dependency_index(i, i, true)]) {
                                return invalid();
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

/// Position of t_ij (j < i, or j = i when reversible) in a dependency array: t10, t20, t21, ...
/// (irreversible) or t10, t11, t20, t21, t22, ... (reversible).
fn dependency_index(i: usize, j: usize, reversible: bool) -> usize {
    if reversible { i * (i + 1) / 2 - 1 + j } else { i * (i - 1) / 2 + j }
}

impl Part2Transform {
    /// Apply every stage to the spatially reconstructed components, replacing them with the
    /// reconstructed image components (CBD). `len` is the number of samples per component.
    pub fn apply(&self, components: &mut Vec<Vec<f32>>, len: usize) -> Result<()> {
        let mut current: Vec<Option<Vec<f32>>> = std::mem::take(components).into_iter().map(Some).collect();
        for (steps, &size) in self.stages.iter().zip(&self.sizes) {
            let mut next: Vec<Option<Vec<f32>>> = (0..size).map(|_| None).collect();
            for step in steps {
                let inputs: Vec<Option<&[f32]>> =
                    step.inputs.iter().map(|&i| current.get(i).and_then(|c| c.as_deref())).collect();
                let mut outs: Vec<Vec<f32>> = (0..step.m()).map(|_| vec![0.0; len]).collect();
                step.run(&inputs, &mut outs, len);
                for (&o, data) in step.outputs.iter().zip(outs) {
                    *next.get_mut(o).ok_or_else(|| Error::Invalid("Part 2 multiple component transformation".into()))? = Some(data);
                }
            }
            current = next;
        }
        *components = current.into_iter().zip(&self.outputs).map(|(c, _)| c.unwrap_or_else(|| vec![0.0; len])).collect();
        Ok(())
    }
}

impl Step {
    /// Transform the collection's input components (None: a null component, all zero) into
    /// its output components.
    fn run(&self, inputs: &[Option<&[f32]>], outs: &mut [Vec<f32>], len: usize) {
        let (n, m) = (self.n(), self.m());
        let input = |j: usize, x: usize| -> f32 { inputs[j].and_then(|c| c.get(x)).copied().unwrap_or(0.0) };
        let offset = |i: usize| self.offsets.get(i).copied().unwrap_or(0.0);
        match (self.kind, self.reversible) {
            // J-2: W_i = sum_j t_ij C_j + o_i, in f32 as OpenJPEG's custom MCT does.
            (Kind::Decorrelation, false) => {
                let t: Vec<f32> = if self.coefficients.is_empty() {
                    (0..m * n).map(|k| if k / n == k % n { 1.0 } else { 0.0 }).collect()
                } else {
                    self.coefficients.iter().map(|&v| v as f32).collect()
                };
                let o: Vec<f32> = (0..m).map(|i| offset(i) as f32).collect();
                let mut c = vec![0.0f32; n];
                for x in 0..len {
                    for (j, cj) in c.iter_mut().enumerate() {
                        *cj = input(j, x);
                    }
                    for i in 0..m {
                        let mut acc = 0.0f32;
                        for j in 0..n {
                            acc += t[i * n + j] * c[j];
                        }
                        outs[i][x] = acc + o[i];
                    }
                }
            }
            // J-11, J-12: Y = C + o; W_i = sum_{j<i} t_ij W_j + Y_i.
            (Kind::Dependency, false) => {
                let t: Vec<f32> = self.coefficients.iter().map(|&v| v as f32).collect();
                let o: Vec<f32> = (0..m).map(|i| offset(i) as f32).collect();
                let mut w = vec![0.0f32; m];
                for x in 0..len {
                    for i in 0..m {
                        let mut acc = 0.0f32;
                        if !t.is_empty() {
                            for j in 0..i {
                                acc += t[dependency_index(i, j, false)] * w[j];
                            }
                        }
                        w[i] = acc + (input(i, x) + o[i]);
                        outs[i][x] = w[i];
                    }
                }
            }
            // J-4 to J-6, in integers.
            (Kind::Decorrelation, true) => {
                let t: Vec<i64> = if self.coefficients.is_empty() {
                    // The default array: t_N(N-1) = 1, t_i(N-1-i) = 1, all others 0.
                    (0..(n + 1) * n)
                        .map(|k| {
                            let (r, col) = (k / n, k % n);
                            i64::from((r < n && col == n - 1 - r) || (r == n && col == n - 1))
                        })
                        .collect()
                } else {
                    self.coefficients.iter().map(|&v| v as i64).collect()
                };
                let o: Vec<i64> = (0..n).map(|i| offset(i) as i64).collect();
                let mut p = vec![0i64; n];
                for x in 0..len {
                    for (j, pj) in p.iter_mut().enumerate() {
                        *pj = round_to_i64(input(j, x));
                    }
                    for l in 0..=n {
                        let k = if l < n { n - 1 - l } else { n - 1 };
                        let row = &t[l * n..(l + 1) * n];
                        let scale = row[k].abs();
                        let mut s = scale / 2;
                        for (i, (&ti, &pi)) in row.iter().zip(&p).enumerate() {
                            if i != k {
                                s = s.wrapping_add(ti.wrapping_mul(pi));
                            }
                        }
                        let q = s.div_euclid(scale);
                        p[k] = if l < n { p[k] - q } else { row[k].signum() * (p[k] - q) };
                    }
                    for i in 0..n {
                        outs[i][x] = (p[i] + o[i]) as f32;
                    }
                }
            }
            // J-14, J-15: Y = C + o; S_i = sum_{j<i} t_ij W_j + floor(t_ii / 2);
            // W_i = floor(S_i / t_ii) + Y_i.
            (Kind::Dependency, true) => {
                let t: Vec<i64> = self.coefficients.iter().map(|&v| v as i64).collect();
                let o: Vec<i64> = (0..m).map(|i| offset(i) as i64).collect();
                let mut w = vec![0i64; m];
                for x in 0..len {
                    for i in 0..m {
                        let y = round_to_i64(input(i, x)) + o[i];
                        w[i] = if t.is_empty() || i == 0 {
                            y
                        } else {
                            let scale = t[dependency_index(i, i, true)];
                            let mut s = scale / 2;
                            for j in 0..i {
                                s = s.wrapping_add(t[dependency_index(i, j, true)].wrapping_mul(w[j]));
                            }
                            s.div_euclid(scale) + y
                        };
                        outs[i][x] = w[i] as f32;
                    }
                }
            }
            (Kind::Wavelet, _) => {}
        }
    }
}

/// Reversible transforms work on integers: the 5/3 path gives exact integers in f32.
fn round_to_i64(v: f32) -> i64 {
    if v.is_finite() { (v + 0.5).floor() as i64 } else { 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(kind: Kind, reversible: bool, n: usize, coefficients: Vec<f64>, offsets: Vec<f64>) -> Step {
        Step { kind, reversible, inputs: (0..n).collect(), outputs: (0..n).collect(), coefficients, offsets }
    }

    fn run(s: &Step, input: &[Vec<f32>]) -> Vec<Vec<f32>> {
        let len = input[0].len();
        let ins: Vec<Option<&[f32]>> = input.iter().map(|v| Some(v.as_slice())).collect();
        let mut outs: Vec<Vec<f32>> = (0..s.m()).map(|_| vec![0.0; len]).collect();
        s.run(&ins, &mut outs, len);
        outs
    }

    /// Forward reversible dependency transform (the inverse of J-15): C_i = W_i - o_i -
    /// floor(S_i / t_ii).
    fn forward_dependency(t: &[i64], o: &[i64], w: &[i64]) -> Vec<i64> {
        let m = w.len();
        (0..m)
            .map(|i| {
                if i == 0 {
                    return w[0] - o[0];
                }
                let scale = t[dependency_index(i, i, true)];
                let mut s = scale / 2;
                for j in 0..i {
                    s += t[dependency_index(i, j, true)] * w[j];
                }
                w[i] - o[i] - s.div_euclid(scale)
            })
            .collect()
    }

    /// Forward reversible decorrelation (the inverse of J-4/J-5): the SERM steps in reverse
    /// order, each adding what the inverse step subtracts.
    fn forward_decorrelation(t: &[i64], o: &[i64], w: &[i64]) -> Vec<i64> {
        let n = w.len();
        let mut p: Vec<i64> = w.iter().zip(o).map(|(a, b)| a - b).collect();
        for l in (0..=n).rev() {
            let k = if l < n { n - 1 - l } else { n - 1 };
            let row = &t[l * n..(l + 1) * n];
            let scale = row[k].abs();
            let mut s = scale / 2;
            for i in 0..n {
                if i != k {
                    s += row[i] * p[i];
                }
            }
            let q = s.div_euclid(scale);
            p[k] = if l < n { p[k] + q } else { row[k].signum() * p[k] + q };
        }
        p
    }

    #[test]
    fn reversible_dependency_round_trips() {
        // 3 components: t10 = 1 (scale t11 = 1), t20 = -3, t21 = 5 (scale t22 = 4).
        let t = [1i64, 1, -3, 5, 4];
        let o = [7i64, -2, 100];
        let s = step(Kind::Dependency, true, 3, t.iter().map(|&v| v as f64).collect(), o.iter().map(|&v| v as f64).collect());
        s.validate().unwrap();
        let mut rng = 12345u64;
        let mut rand = || {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((rng >> 33) % 4096) as i64 - 2048
        };
        let originals: Vec<[i64; 3]> = (0..500).map(|_| [rand(), rand(), rand()]).collect();
        let coded: Vec<Vec<i64>> = originals.iter().map(|w| forward_dependency(&t, &o, w)).collect();
        let input: Vec<Vec<f32>> = (0..3).map(|c| coded.iter().map(|v| v[c] as f32).collect()).collect();
        let out = run(&s, &input);
        for (x, w) in originals.iter().enumerate() {
            for c in 0..3 {
                assert_eq!(out[c][x] as i64, w[c]);
            }
        }
    }

    #[test]
    fn reversible_decorrelation_round_trips() {
        // A SERM-style array for 3 components: rows 0..2 adjust P2, P1, P0 (scales 4, 2, 8),
        // row 3 adjusts P2 again with scale -2.
        let t = [3i64, -1, 4, 5, 2, -7, 8, 1, 2, -6, 3, -2];
        let o = [128i64, 0, -5];
        let s = step(Kind::Decorrelation, true, 3, t.iter().map(|&v| v as f64).collect(), o.iter().map(|&v| v as f64).collect());
        s.validate().unwrap();
        let mut rng = 99u64;
        let mut rand = || {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((rng >> 33) % 1024) as i64 - 300
        };
        let originals: Vec<[i64; 3]> = (0..500).map(|_| [rand(), rand(), rand()]).collect();
        let coded: Vec<Vec<i64>> = originals.iter().map(|w| forward_decorrelation(&t, &o, w)).collect();
        let input: Vec<Vec<f32>> = (0..3).map(|c| coded.iter().map(|v| v[c] as f32).collect()).collect();
        let out = run(&s, &input);
        for (x, w) in originals.iter().enumerate() {
            for c in 0..3 {
                assert_eq!(out[c][x] as i64, w[c], "sample {x} component {c}");
            }
        }
    }

    #[test]
    fn default_arrays_are_identities() {
        let input = vec![vec![1.0f32, -2.0, 300.0], vec![5.0, 6.0, 7.0]];
        for (kind, rev) in [(Kind::Decorrelation, false), (Kind::Decorrelation, true), (Kind::Dependency, false), (Kind::Dependency, true)] {
            let s = step(kind, rev, 2, vec![], vec![]);
            s.validate().unwrap();
            assert_eq!(run(&s, &input), input, "{kind:?} reversible={rev}");
        }
    }

    #[test]
    fn irreversible_decorrelation_matches_matrix() {
        // YCbCr -> RGB with offsets 128.
        let t = [1.0, 0.0, 1.402, 1.0, -0.344136, -0.714136, 1.0, 1.772, 0.0];
        let s = step(Kind::Decorrelation, false, 3, t.to_vec(), vec![128.0; 3]);
        let out = run(&s, &[vec![10.0], vec![-20.0], vec![30.0]]);
        let want = [10.0 + 1.402 * 30.0 + 128.0, 10.0 + 0.344136 * 20.0 - 0.714136 * 30.0 + 128.0, 10.0 - 1.772 * 20.0 + 128.0];
        for c in 0..3 {
            assert!((f64::from(out[c][0]) - want[c]).abs() < 1e-3);
        }
    }

    #[test]
    fn irreversible_dependency_predicts() {
        // t10 = 0.5, t20 = 0.25, t21 = -1.
        let s = step(Kind::Dependency, false, 3, vec![0.5, 0.25, -1.0], vec![1.0, 2.0, 3.0]);
        let out = run(&s, &[vec![10.0], vec![4.0], vec![-6.0]]);
        // W0 = 11; W1 = 0.5*11 + 6 = 11.5; W2 = 0.25*11 - 11.5 - 3 = -11.75.
        assert_eq!(out, vec![vec![11.0], vec![11.5], vec![-11.75]]);
    }

    #[test]
    fn bad_arrays_are_refused() {
        // Wrong length, non-integer reversible coefficient, zero scale factor.
        assert!(step(Kind::Decorrelation, false, 3, vec![1.0; 8], vec![]).validate().is_err());
        assert!(step(Kind::Dependency, true, 2, vec![0.5, 1.0], vec![]).validate().is_err());
        assert!(step(Kind::Dependency, true, 2, vec![1.0, 0.0], vec![]).validate().is_err());
        assert!(step(Kind::Decorrelation, true, 2, vec![1.0, 3.0, 3.0, 1.0, 0.0, 0.0], vec![]).validate().is_err());
    }

    fn seg(marker_body: &[u8]) -> Vec<u8> {
        marker_body.to_vec()
    }

    #[test]
    fn parses_series_and_builds_a_transform() {
        let mut h = Part2Header::default();
        h.read_cbd(&seg(&[0x80, 0x03, 0x07])).unwrap();
        // Decorrelation array index 1, 16-bit, split over two segments (Ymct = 1).
        h.read_mct(&seg(&[0, 0, 0x01, 0x01, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1])).unwrap();
        h.read_mct(&seg(&[0, 1, 0x01, 0x01, 0, 0, 0, 0, 0, 0, 0, 1])).unwrap();
        // MCC 3: one irreversible decorrelation collection over components 0,1,2.
        h.read_mcc(&seg(&[0, 0, 3, 0, 0, 0, 1, 1, 0, 3, 0, 1, 2, 0, 3, 0, 1, 2, 0, 0, 1])).unwrap();
        h.read_mco(&seg(&[1, 3])).unwrap();
        let t = h.transform(3).unwrap();
        assert_eq!(t.outputs.len(), 3);
        assert_eq!(t.stages[0][0].coefficients, vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
        // An MCO stage naming a missing MCC, and a missing series member, are refused.
        let mut bad = h.clone();
        bad.mco = Some(vec![9]);
        assert!(bad.transform(3).is_err());
        let mut bad = Part2Header::default();
        bad.read_cbd(&seg(&[0x80, 0x03, 0x07])).unwrap();
        bad.read_mct(&seg(&[0, 0, 0x01, 0x01, 0, 1, 0, 1])).unwrap();
        bad.read_mcc(&seg(&[0, 0, 3, 0, 0, 0, 1, 1, 0, 3, 0, 1, 2, 0, 3, 0, 1, 2, 0, 0, 1])).unwrap();
        bad.read_mco(&seg(&[1, 3])).unwrap();
        assert!(bad.transform(3).is_err());
    }
}
