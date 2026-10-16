//! Tier-2 (T.800 Annex B.9–B.10): packet header bits with bit stuffing, and tag trees.

/// Packet header bit writer: after an 0xFF byte the next byte carries only 7 bits (B.10.1).
pub(crate) struct BitWriter<'a> {
    out: &'a mut Vec<u8>,
    buf: u32,
    /// Bits still free in `buf`.
    free: u32,
    /// Bits written into `buf` so far.
    used: u32,
}

impl<'a> BitWriter<'a> {
    pub(crate) fn new(out: &'a mut Vec<u8>) -> Self {
        Self { out, buf: 0, free: 8, used: 0 }
    }

    #[inline]
    pub(crate) fn bit(&mut self, b: u32) {
        self.buf = (self.buf << 1) | (b & 1);
        self.free -= 1;
        self.used += 1;
        if self.free == 0 {
            self.emit();
        }
    }

    pub(crate) fn bits(&mut self, v: u32, n: u32) {
        for k in (0..n).rev() {
            self.bit((v >> k) & 1);
        }
    }

    fn emit(&mut self) {
        let b = self.buf as u8;
        self.out.push(b);
        self.buf = 0;
        self.used = 0;
        self.free = if b == 0xFF { 7 } else { 8 };
    }

    /// Pad the last byte with zeros; if the header's last byte is 0xFF, add a zero byte so the
    /// packet body never follows an 0xFF directly (as OpenJPEG's opj_bio_flush does).
    pub(crate) fn finish(mut self) {
        if self.used > 0 {
            while self.free != 0 {
                self.buf <<= 1;
                self.free -= 1;
            }
            self.emit();
        }
        if self.out.last() == Some(&0xFF) && self.free == 7 {
            self.out.push(0);
        }
    }
}

/// A tag tree over a `w` × `h` grid of leaves (B.10.2), for one layer of encoding.
pub(crate) struct TagTree {
    /// Nodes level by level, leaves first; each (value, low, known).
    nodes: Vec<(u32, u32, bool)>,
    /// (offset, width, height) of each level.
    levels: Vec<(usize, usize, usize)>,
}

impl TagTree {
    pub(crate) fn new(w: usize, h: usize, leaves: &[u32]) -> Self {
        let mut levels = Vec::new();
        let mut nodes: Vec<(u32, u32, bool)> = leaves.iter().map(|&v| (v, 0, false)).collect();
        let (mut lw, mut lh, mut off) = (w, h, 0usize);
        levels.push((0, w, h));
        while lw > 1 || lh > 1 {
            let (pw, ph) = (lw.div_ceil(2), lh.div_ceil(2));
            let poff = nodes.len();
            for py in 0..ph {
                for px in 0..pw {
                    let mut v = u32::MAX;
                    for (dy, dx) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                        let (cy, cx) = (2 * py + dy, 2 * px + dx);
                        if cy < lh && cx < lw {
                            v = v.min(nodes[off + cy * lw + cx].0);
                        }
                    }
                    nodes.push((v, 0, false));
                }
            }
            levels.push((poff, pw, ph));
            off = poff;
            lw = pw;
            lh = ph;
        }
        Self { nodes, levels }
    }

    /// Code leaf (x, y) against `threshold` (B.10.2): for each node from the root down, a 0 for
    /// each step its value is above the running lower bound, and a 1 once it is reached.
    pub(crate) fn encode(&mut self, bw: &mut BitWriter<'_>, x: usize, y: usize, threshold: u32) {
        let mut path = Vec::with_capacity(self.levels.len());
        let (mut cx, mut cy) = (x, y);
        for &(off, w, _) in &self.levels {
            path.push(off + cy * w + cx);
            cx /= 2;
            cy /= 2;
        }
        let mut low = 0u32;
        for &i in path.iter().rev() {
            let node = &mut self.nodes[i];
            if low > node.1 {
                node.1 = low;
            } else {
                low = node.1;
            }
            while low < threshold {
                if low >= node.0 {
                    if !node.2 {
                        bw.bit(1);
                        node.2 = true;
                    }
                    break;
                }
                bw.bit(0);
                low += 1;
            }
            node.1 = low;
        }
    }
}
