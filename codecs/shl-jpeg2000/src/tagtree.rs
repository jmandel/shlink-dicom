//! Tag trees (B.10.2).

/// A tag tree over a `w` × `h` grid of leaves, decoded incrementally.
pub(crate) struct TagTree {
    /// Levels from the leaves up: (width, height, offset into `nodes`).
    levels: Vec<(u32, u32, usize)>,
    /// Per node: (current lower bound, known exactly).
    value: Vec<u32>,
    known: Vec<bool>,
}

impl TagTree {
    pub(crate) fn new(w: u32, h: u32) -> Self {
        let mut levels = Vec::new();
        let (mut lw, mut lh, mut n) = (w.max(1), h.max(1), 0usize);
        loop {
            levels.push((lw, lh, n));
            n += (lw * lh) as usize;
            if lw == 1 && lh == 1 {
                break;
            }
            lw = lw.div_ceil(2);
            lh = lh.div_ceil(2);
        }
        Self { levels, value: vec![0; n], known: vec![false; n] }
    }

    /// Decode leaf (x, y) up to `threshold`: returns its value if it is below `threshold`, or
    /// some value ≥ `threshold` otherwise (B.10.2). `None` if the bits run out.
    pub(crate) fn read(&mut self, x: u32, y: u32, threshold: u32, bits: &mut crate::bits::HeaderBits<'_>) -> Option<u32> {
        // Path from the root down to the leaf.
        let mut path = [0usize; 34];
        let mut depth = 0;
        let (mut px, mut py) = (x, y);
        for &(lw, _, off) in &self.levels {
            path[depth] = off + (py * lw + px) as usize;
            depth += 1;
            px /= 2;
            py /= 2;
        }
        let mut low = 0u32;
        for i in (0..depth).rev() {
            let node = path[i];
            if low > self.value[node] {
                self.value[node] = low;
            }
            while !self.known[node] && self.value[node] < threshold {
                if bits.bit()? == 1 {
                    self.known[node] = true;
                } else {
                    self.value[node] += 1;
                }
            }
            low = self.value[node];
            if !self.known[node] {
                // Not resolved below the threshold: the leaf is at least `low` ≥ threshold.
                return Some(low);
            }
        }
        Some(low)
    }
}
