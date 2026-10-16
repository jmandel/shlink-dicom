//! Meta-adaptive context trees (ISO/IEC 18181-1 H.4.2).

use crate::bits::{unpack_signed, BitReader};
use crate::entropy::EntropyCode;
use crate::error::{invalid, Result};

pub const NUM_STATIC_PROPS: usize = 2;
pub const NUM_NONREF_PROPS: usize = 16;
pub const WP_PROP: usize = 15;
pub const GRADIENT_PROP: usize = 9;
pub const MAX_TREE_SIZE: usize = 1 << 22;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Predictor {
    Zero = 0,
    Left,
    Top,
    Average0,
    Select,
    Gradient,
    Weighted,
    TopRight,
    TopLeft,
    LeftLeft,
    Average1,
    Average2,
    Average3,
    Average4,
}

impl Predictor {
    pub fn from_u32(v: u32) -> Option<Self> {
        use Predictor::*;
        Some(match v {
            0 => Zero,
            1 => Left,
            2 => Top,
            3 => Average0,
            4 => Select,
            5 => Gradient,
            6 => Weighted,
            7 => TopRight,
            8 => TopLeft,
            9 => LeftLeft,
            10 => Average1,
            11 => Average2,
            12 => Average3,
            13 => Average4,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub enum Node {
    Split { property: u32, splitval: i32, left: u32, right: u32 },
    Leaf { ctx: u32, predictor: Predictor, offset: i64, multiplier: u32 },
}

pub type Tree = Vec<Node>;

const SPLIT_CTX: usize = 0;
const PROPERTY_CTX: usize = 1;
const PREDICTOR_CTX: usize = 2;
const OFFSET_CTX: usize = 3;
const MUL_LOG_CTX: usize = 4;
const MUL_BITS_CTX: usize = 5;

pub fn read_tree(br: &mut BitReader, limit: usize) -> Result<Tree> {
    let code = EntropyCode::read(br, 6)?;
    let prop_cluster = usize::from(code.context_map[PROPERTY_CTX]);
    if matches!(code.single_symbol(prop_cluster), Some(s) if s > 0) {
        return invalid("infinite MA tree");
    }
    let mut r = code.reader(br, 0)?;
    let limit = limit.min(MAX_TREE_SIZE);
    let mut tree: Tree = Vec::new();
    let mut to_decode = 1usize;
    let mut leaf_id = 0u32;
    while to_decode > 0 {
        if br.overrun() {
            return invalid("truncated MA tree");
        }
        if tree.len() > limit {
            return invalid("MA tree too large");
        }
        to_decode -= 1;
        let prop1 = r.read(&code, br, PROPERTY_CTX);
        if prop1 > 256 {
            return invalid("MA tree property");
        }
        if prop1 == 0 {
            let p = r.read(&code, br, PREDICTOR_CTX);
            let predictor = Predictor::from_u32(p).ok_or(crate::error::Error::Invalid("MA tree predictor"))?;
            let offset = i64::from(unpack_signed(r.read(&code, br, OFFSET_CTX)));
            let mul_log = r.read(&code, br, MUL_LOG_CTX);
            if mul_log >= 31 {
                return invalid("MA tree multiplier");
            }
            let mul_bits = r.read(&code, br, MUL_BITS_CTX);
            if mul_bits >= (1u32 << (31 - mul_log)) - 1 {
                return invalid("MA tree multiplier");
            }
            let multiplier = (mul_bits + 1) << mul_log;
            tree.push(Node::Leaf { ctx: leaf_id, predictor, offset, multiplier });
            leaf_id += 1;
            continue;
        }
        let splitval = unpack_signed(r.read(&code, br, SPLIT_CTX));
        let left = (tree.len() + to_decode + 1) as u32;
        tree.push(Node::Split { property: prop1 - 1, splitval, left, right: left + 1 });
        to_decode += 2;
    }
    if !r.check_final_state() {
        return invalid("MA tree ANS state");
    }
    br.check_end()?;
    validate(&tree)?;
    Ok(tree)
}

/// Rejects trees whose splits cannot be reached (libjxl's ValidateTree): every split value
/// must lie strictly inside the range its ancestors leave for that property.
fn validate(tree: &Tree) -> Result<()> {
    let num_props = tree
        .iter()
        .map(|n| match n {
            Node::Split { property, .. } => *property as usize + 1,
            _ => 0,
        })
        .max()
        .unwrap_or(0);
    let mut ranges = vec![(i32::MIN, i32::MAX); num_props];
    enum Step {
        Enter(usize),
        Right(usize, i32, i32),
        Pop(usize, i32),
    }
    let mut stack = vec![Step::Enter(0)];
    while let Some(step) = stack.pop() {
        if stack.len() >= 2048 * 3 {
            return invalid("MA tree too tall");
        }
        match step {
            Step::Enter(i) => {
                let Some(&Node::Split { property, splitval, left, .. }) = tree.get(i) else { continue };
                let p = property as usize;
                let (l, u) = ranges[p];
                if l > splitval || u <= splitval {
                    return invalid("MA tree split out of range");
                }
                ranges[p].0 = splitval + 1;
                stack.push(Step::Right(i, l, u));
                stack.push(Step::Enter(left as usize));
            }
            Step::Right(i, l, u) => {
                let Some(&Node::Split { property, splitval, right, .. }) = tree.get(i) else { continue };
                let p = property as usize;
                ranges[p] = (l, splitval);
                stack.push(Step::Pop(p, u));
                stack.push(Step::Enter(right as usize));
            }
            Step::Pop(p, u) => ranges[p].1 = u,
        }
    }
    Ok(())
}

/// A tree specialised to one channel: static properties resolved, leaf contexts clustered.
#[derive(Clone, Debug)]
pub struct ChannelTree {
    pub nodes: Vec<Node>,
    /// Number of properties the tree reads (16 + 4 per reference channel).
    pub num_props: usize,
    pub uses_wp: bool,
}

pub fn specialise(tree: &Tree, channel: i32, group: i32, context_map: &[u8]) -> ChannelTree {
    let statics = [channel, group];
    let mut nodes = Vec::new();
    let mut max_prop = 0usize;
    let mut uses_wp = false;
    // Breadth-first copy, skipping static decisions.
    let resolve = |mut i: usize| -> usize {
        while let Some(&Node::Split { property, splitval, left, right }) = tree.get(i) {
            if (property as usize) >= NUM_STATIC_PROPS {
                break;
            }
            i = if statics[property as usize] > splitval { left as usize } else { right as usize };
        }
        i
    };
    let mut queue = std::collections::VecDeque::new();
    queue.push_back(resolve(0));
    while let Some(i) = queue.pop_front() {
        match tree.get(i) {
            Some(&Node::Split { property, splitval, left, right }) => {
                max_prop = max_prop.max(property as usize + 1);
                if property as usize == WP_PROP {
                    uses_wp = true;
                }
                let base = (nodes.len() + queue.len() + 1) as u32;
                nodes.push(Node::Split { property, splitval, left: base, right: base + 1 });
                queue.push_back(resolve(left as usize));
                queue.push_back(resolve(right as usize));
            }
            Some(&Node::Leaf { ctx, predictor, offset, multiplier }) => {
                if predictor == Predictor::Weighted {
                    uses_wp = true;
                }
                let cluster = u32::from(*context_map.get(ctx as usize).unwrap_or(&0));
                nodes.push(Node::Leaf { ctx: cluster, predictor, offset, multiplier });
            }
            None => nodes.push(Node::Leaf { ctx: 0, predictor: Predictor::Zero, offset: 0, multiplier: 1 }),
        }
    }
    let num_props = if max_prop > NUM_NONREF_PROPS {
        NUM_NONREF_PROPS + (max_prop - NUM_NONREF_PROPS).div_ceil(4) * 4
    } else {
        NUM_NONREF_PROPS
    };
    ChannelTree { nodes, num_props, uses_wp }
}

impl ChannelTree {
    #[inline(always)]
    pub fn lookup(&self, props: &[i32]) -> (u32, Predictor, i64, u32) {
        let mut i = 0usize;
        loop {
            match self.nodes.get(i) {
                Some(&Node::Split { property, splitval, left, right }) => {
                    let v = props.get(property as usize).copied().unwrap_or(0);
                    i = if v > splitval { left as usize } else { right as usize };
                }
                Some(&Node::Leaf { ctx, predictor, offset, multiplier }) => return (ctx, predictor, offset, multiplier),
                None => return (0, Predictor::Zero, 0, 1),
            }
        }
    }

    /// If every split tests property `prop` with split values inside ±`range`, and every leaf
    /// has `predictor` with offset 0 and multiplier 1: the leaf cluster for each property value
    /// in -range..range (index value + range).
    pub fn single_property_lut(&self, prop: u32, predictor: Predictor, range: i32) -> Option<Vec<u8>> {
        for n in &self.nodes {
            match *n {
                Node::Split { property, splitval, .. } => {
                    if property != prop || splitval < -range || splitval >= range - 1 {
                        return None;
                    }
                }
                Node::Leaf { predictor: p, offset, multiplier, ctx } => {
                    if p != predictor || offset != 0 || multiplier != 1 || ctx > 255 {
                        return None;
                    }
                }
            }
        }
        let mut props = vec![0i32; prop as usize + 1];
        let mut lut = Vec::with_capacity(2 * range as usize);
        for v in -range..range {
            props[prop as usize] = v;
            lut.push(self.lookup(&props).0 as u8);
        }
        Some(lut)
    }
}
