//! Split encapsulated Pixel Data into one codestream per frame (PS3.5 A.4), in the order pydicom's
//! `generate_fragmented_frames` uses:
//!
//! 1. Extended Offset Table, when (7FE0,0001) and (7FE0,0002) are both present with equal counts
//!    and every entry is valid: each offset is the start of a fragment item and each length fits
//!    in that fragment;
//! 2. Basic Offset Table, when not empty and valid: entries strictly increasing, each the start of
//!    a fragment item;
//! 3. a single fragment is a single frame;
//! 4. [`crate::syntax::frame_starts`], the rule the packer adds offset tables by: a frame starts at
//!    each fragment that opens a codestream when exactly Number of Frames do, else one frame per
//!    fragment when the counts match;
//! 5. all fragments for a single frame when Number of Frames is 1;
//! 6. more fragments than frames: a frame starts at each fragment that opens a codestream, and
//!    frames past Number of Frames are ignored.
//!
//! An invalid table is ignored and the next method is used, as the references do: pydicom 3.0.1
//! writes EOT lengths that include the 8-byte item header (IDC Mirax slides), and some writers
//! count 9 bytes per item header in the BOT (GDCM's 00191113.dcm), which dcmtk ignores.
//!
//! The result must hold at least Number of Frames frames; extra frames are ignored.

use std::borrow::Cow;

use crate::parse::{read_u32, read_u64, Fragment};
use crate::Error;

fn invalid(msg: impl Into<String>) -> Error {
    Error::Invalid(msg.into())
}

fn concat<'a>(parts: &[&'a [u8]]) -> Result<Cow<'a, [u8]>, Error> {
    match parts {
        [one] => Ok(Cow::Borrowed(one)),
        _ => {
            // Bounded by the input size: fragments are slices of it.
            let total: usize = parts.iter().map(|p| p.len()).sum();
            let mut v = Vec::new();
            v.try_reserve_exact(total).map_err(|_| Error::Unsupported("cannot allocate frame".into()))?;
            for p in parts {
                v.extend_from_slice(p);
            }
            Ok(Cow::Owned(v))
        }
    }
}

/// Frame codestreams, at least `number_of_frames` of them (only the first `number_of_frames` are returned).
pub fn split_frames<'a>(
    ts: &str,
    basic_offsets: &[u8],
    fragments: &[Fragment<'a>],
    extended: Option<(&[u8], &[u8])>,
    number_of_frames: usize,
    little: bool,
) -> Result<Vec<Cow<'a, [u8]>>, Error> {
    let frames = group_fragments(ts, basic_offsets, fragments, extended, number_of_frames, little)?;
    if frames.len() < number_of_frames {
        return Err(invalid(format!(
            "encapsulated pixel data holds {} frame(s), Number of Frames is {number_of_frames}",
            frames.len()
        )));
    }
    frames.into_iter().take(number_of_frames).map(|parts| concat(&parts)).collect()
}

fn group_fragments<'a>(
    ts: &str,
    basic_offsets: &[u8],
    fragments: &[Fragment<'a>],
    extended: Option<(&[u8], &[u8])>,
    number_of_frames: usize,
    little: bool,
) -> Result<Vec<Vec<&'a [u8]>>, Error> {
    if let Some((offsets, lengths)) = extended {
        if offsets.len() % 8 == 0 && offsets.len() == lengths.len() && !offsets.is_empty() {
            if let Some(frames) = from_extended(offsets, lengths, fragments, little) {
                return Ok(frames);
            }
        }
    }

    if !basic_offsets.is_empty() {
        let bot: Vec<u64> = basic_offsets.chunks_exact(4).map(|b| u64::from(read_u32(b, little).unwrap_or(0))).collect();
        if basic_table_is_valid(&bot, fragments) {
            return Ok(from_basic(&bot, fragments));
        }
    }

    if fragments.is_empty() {
        return Err(invalid("encapsulated pixel data has no fragments"));
    }
    if fragments.len() == 1 {
        return Ok(vec![vec![fragments[0].data]]);
    }
    let heads = || fragments.iter().map(|f| &f.data[..f.data.len().min(8)]);
    if let Some(starts) = crate::syntax::frame_starts(ts, heads(), number_of_frames) {
        return Ok(grouped(fragments, &starts));
    }
    if number_of_frames == 1 {
        return Ok(vec![fragments.iter().map(|f| f.data).collect()]);
    }
    if let Some(test) = crate::syntax::frame_start_test(ts).filter(|_| fragments.len() > number_of_frames) {
        let starts: Vec<usize> = heads().enumerate().filter(|(i, h)| *i == 0 || test(h)).map(|(i, _)| i).collect();
        return Ok(grouped(fragments, &starts));
    }
    Err(invalid(format!(
        "no offset table and {} fragment(s) for {number_of_frames} frames",
        fragments.len()
    )))
}

/// Fragments grouped into frames, each starting at one of `starts` (fragment indices, from 0).
fn grouped<'a>(fragments: &[Fragment<'a>], starts: &[usize]) -> Vec<Vec<&'a [u8]>> {
    let ends = starts.iter().skip(1).copied().chain([fragments.len()]);
    starts.iter().zip(ends).map(|(&a, b)| fragments[a..b].iter().map(|f| f.data).collect()).collect()
}

/// Fragment offsets increase, so a binary search finds the fragment an entry points at.
fn fragment_at<'a, 'f>(fragments: &'f [Fragment<'a>], offset: u64) -> Option<&'f Fragment<'a>> {
    fragments.binary_search_by_key(&offset, |f| f.offset).ok().and_then(|i| fragments.get(i))
}

fn basic_table_is_valid(bot: &[u64], fragments: &[Fragment<'_>]) -> bool {
    bot.windows(2).all(|w| w[0] < w[1]) && bot.iter().all(|&o| fragment_at(fragments, o).is_some())
}

/// pydicom's Basic Offset Table walk: a fragment starts a new frame when its offset reaches the
/// next table entry; everything from the last entry on belongs to the last frame.
fn from_basic<'a>(bot: &[u64], fragments: &[Fragment<'a>]) -> Vec<Vec<&'a [u8]>> {
    let mut frames = Vec::new();
    let mut frame = Vec::new();
    let mut index = 0usize;
    let last = bot.len().saturating_sub(1);
    for f in fragments {
        if index == last {
            frame.push(f.data);
            continue;
        }
        let next = bot.get(index + 1).copied().unwrap_or(u64::MAX);
        if f.offset < next {
            frame.push(f.data);
        } else {
            frames.push(std::mem::take(&mut frame));
            index += 1;
            frame.push(f.data);
        }
    }
    frames.push(frame);
    frames
}

fn from_extended<'a>(
    offsets: &[u8],
    lengths: &[u8],
    fragments: &[Fragment<'a>],
    little: bool,
) -> Option<Vec<Vec<&'a [u8]>>> {
    let mut frames = Vec::new();
    for (o, l) in offsets.chunks_exact(8).zip(lengths.chunks_exact(8)) {
        let offset = read_u64(o, little)?;
        let length = read_u64(l, little)?;
        // The table points at item tags; each frame is one fragment's value or a prefix of it
        // (PS3.5 A.4: with an Extended Offset Table each frame is one fragment).
        let frag = fragment_at(fragments, offset)?;
        let len = usize::try_from(length).ok().filter(|n| *n <= frag.data.len())?;
        frames.push(vec![frag.data.get(..len)?]);
    }
    Some(frames)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frags<'a>(parts: &[&'a [u8]]) -> Vec<Fragment<'a>> {
        let mut off = 0u64;
        parts
            .iter()
            .map(|p| {
                let f = Fragment { offset: off, data: p };
                off += 8 + p.len() as u64;
                f
            })
            .collect()
    }

    fn le32(v: &[u32]) -> Vec<u8> {
        v.iter().flat_map(|x| x.to_le_bytes()).collect()
    }

    #[test]
    fn basic_offset_table_groups_fragments() {
        let f = frags(&[b"aa", b"bb", b"cc"]);
        // frame 0 = aa + bb, frame 1 = cc (offset 20)
        let out = split_frames("", &le32(&[0, 20]), &f, None, 2, true).unwrap();
        assert_eq!(out[0].as_ref(), b"aabb");
        assert_eq!(out[1].as_ref(), b"cc");
    }

    #[test]
    fn one_fragment_per_frame() {
        let f = frags(&[b"a", b"b", b"c"]);
        let out = split_frames("", &[], &f, None, 3, true).unwrap();
        assert_eq!(out.len(), 3);
        assert_eq!(out[2].as_ref(), b"c");
    }

    #[test]
    fn single_frame_takes_all_fragments() {
        let f = frags(&[b"ab", b"cd"]);
        let out = split_frames("", &[], &f, None, 1, true).unwrap();
        assert_eq!(out[0].as_ref(), b"abcd");
    }

    const JPEG_BASELINE: &str = "1.2.840.10008.1.2.4.50";
    const JPEG_XL: &str = "1.2.840.10008.1.2.4.112";

    #[test]
    fn codestream_start_markers_split_frames() {
        // JPEG frames over two fragments each; the second ends in padding after its EOI.
        let f = frags(&[b"\xFF\xD8x", b"y\xFF\xD9", b"\xFF\xD8z", b"w\xFF\xD9\0\0\0\0\0\0\0\0\0\0"]);
        let out = split_frames(JPEG_BASELINE, &[], &f, None, 2, true).unwrap();
        assert_eq!(out[0].as_ref(), b"\xFF\xD8xy\xFF\xD9");
        assert_eq!(out[1].as_ref(), b"\xFF\xD8zw\xFF\xD9\0\0\0\0\0\0\0\0\0\0");
        // JPEG XL: a bare codestream and a container, each over two fragments, then a third frame.
        let box_ = b"\0\0\0\x0CJXL \x0D\x0A\x87\x0A";
        let f = frags(&[b"\xFF\x0Aa", b"b", box_, b"c", b"\xFF\x0Ad"]);
        let out = split_frames(JPEG_XL, &[], &f, None, 3, true).unwrap();
        assert_eq!(out.iter().map(|c| c.len()).collect::<Vec<_>>(), [4, 13, 3]);
        // More codestreams than frames: the first ones are the frames.
        let f = frags(&[b"\xFF\x0Aa", b"b", b"\xFF\x0Ac", b"\xFF\x0Ad"]);
        let out = split_frames(JPEG_XL, &[], &f, None, 2, true).unwrap();
        assert_eq!(out[0].as_ref(), b"\xFF\x0Aab");
        assert_eq!(out[1].as_ref(), b"\xFF\x0Ac");
    }

    #[test]
    fn too_few_fragments_is_invalid() {
        let f = frags(&[b"a", b"b"]);
        assert!(split_frames("", &[], &f, None, 3, true).is_err());
    }

    #[test]
    fn extended_offset_table() {
        let f = frags(&[b"aaaa", b"bbb"]);
        let offs: Vec<u8> = [0u64, 12].iter().flat_map(|x| x.to_le_bytes()).collect();
        let lens: Vec<u8> = [4u64, 3].iter().flat_map(|x| x.to_le_bytes()).collect();
        let out = split_frames("", &[], &f, Some((&offs, &lens)), 2, true).unwrap();
        assert_eq!(out[1].as_ref(), b"bbb");
    }

    #[test]
    fn invalid_extended_offset_table_falls_back() {
        // pydicom 3.0.1 (IDC Mirax): the first length includes the 8-byte item header.
        let f = frags(&[b"aaaa", b"bbb"]);
        let offs: Vec<u8> = [0u64, 12].iter().flat_map(|x| x.to_le_bytes()).collect();
        let lens: Vec<u8> = [12u64, 3].iter().flat_map(|x| x.to_le_bytes()).collect();
        let out = split_frames("", &[], &f, Some((&offs, &lens)), 2, true).unwrap();
        assert_eq!(out[0].as_ref(), b"aaaa");
        assert_eq!(out[1].as_ref(), b"bbb");
        // An offset that is not an item start: falls back to the (valid) Basic Offset Table.
        let bad: Vec<u8> = [0u64, 13].iter().flat_map(|x| x.to_le_bytes()).collect();
        let lens: Vec<u8> = [4u64, 3].iter().flat_map(|x| x.to_le_bytes()).collect();
        let out = split_frames("", &le32(&[0, 12]), &f, Some((&bad, &lens)), 2, true).unwrap();
        assert_eq!(out[1].as_ref(), b"bbb");
    }

    #[test]
    fn invalid_basic_offset_table_falls_back() {
        // GDCM 00191113.dcm: 9 bytes counted per item header, and one entry too many.
        let f = frags(&[b"a", b"b", b"c", b"d"]);
        let out = split_frames("", &le32(&[0, 10, 20, 30, 40]), &f, None, 4, true).unwrap();
        assert_eq!(out.iter().map(|c| c.as_ref()).collect::<Vec<_>>(), [b"a", b"b", b"c", b"d"]);
        // Entries that do not increase are invalid too.
        let f = frags(&[b"a", b"b"]);
        let out = split_frames("", &le32(&[9, 0]), &f, None, 2, true).unwrap();
        assert_eq!(out[0].as_ref(), b"a");
    }
}
