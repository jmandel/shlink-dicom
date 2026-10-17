//! Transfer syntaxes (PS3.5 Section 10, PS3.6 Annex A): the one table the Rust code uses to tell
//! what a transfer syntax UID is. The decoder's codec dispatch, its "not supported" messages, the
//! transcoder's targets and the server's checks read it.

/// What a transfer syntax stores.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Pixel Data stored native (not encapsulated).
    Native,
    Rle,
    /// JPEG (ISO/IEC 10918-1): `lossless` for processes 14 and 15 (and their hierarchical forms),
    /// `hierarchical` for processes 16–29.
    Jpeg { lossless: bool, hierarchical: bool },
    JpegLs,
    /// JPEG 2000 (ISO/IEC 15444-1, and Part 2 multi-component for .92/.93).
    Jpeg2000 { part2: bool },
    Htj2k,
    JpegXl,
    /// Encapsulated Uncompressed Explicit VR Little Endian.
    EncapsulatedUncompressed,
    DeflatedImageFrame,
    Video,
    Jpip,
    Mime,
    Smpte2110,
}

/// One transfer syntax.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Syntax {
    pub uid: &'static str,
    pub name: &'static str,
    pub kind: Kind,
}

pub const IMPLICIT_LE: &str = "1.2.840.10008.1.2";
pub const EXPLICIT_LE: &str = "1.2.840.10008.1.2.1";
pub const DEFLATED_LE: &str = "1.2.840.10008.1.2.1.99";
pub const EXPLICIT_BE: &str = "1.2.840.10008.1.2.2";
/// GE private: an implicit VR little endian data set whose Pixel Data is big endian.
pub const GE_PRIVATE: &str = "1.2.840.113619.5.2";
pub const ENCAPSULATED_UNCOMPRESSED: &str = "1.2.840.10008.1.2.1.98";
pub const DEFLATED_IMAGE_FRAME: &str = "1.2.840.10008.1.2.8.1";
pub const JPEG_LOSSLESS_SV1: &str = "1.2.840.10008.1.2.4.70";
pub const JPEG_2000_LOSSLESS: &str = "1.2.840.10008.1.2.4.90";

const fn jpeg(uid: &'static str, name: &'static str, lossless: bool, hierarchical: bool) -> Syntax {
    Syntax { uid, name, kind: Kind::Jpeg { lossless, hierarchical } }
}
const fn s(uid: &'static str, name: &'static str, kind: Kind) -> Syntax {
    Syntax { uid, name, kind }
}

/// Every transfer syntax the code knows.
pub static SYNTAXES: &[Syntax] = &[
    s(IMPLICIT_LE, "Implicit VR Little Endian", Kind::Native),
    s(EXPLICIT_LE, "Explicit VR Little Endian", Kind::Native),
    s(DEFLATED_LE, "Deflated Explicit VR Little Endian", Kind::Native),
    s(EXPLICIT_BE, "Explicit VR Big Endian", Kind::Native),
    s(GE_PRIVATE, "GE private implicit VR little endian, big endian pixels", Kind::Native),
    s(ENCAPSULATED_UNCOMPRESSED, "Encapsulated Uncompressed Explicit VR Little Endian", Kind::EncapsulatedUncompressed),
    s(DEFLATED_IMAGE_FRAME, "Deflated Image Frame Compression", Kind::DeflatedImageFrame),
    s("1.2.840.10008.1.2.5", "RLE Lossless", Kind::Rle),
    jpeg("1.2.840.10008.1.2.4.50", "JPEG Baseline (Process 1)", false, false),
    jpeg("1.2.840.10008.1.2.4.51", "JPEG Extended (Process 2 & 4)", false, false),
    jpeg("1.2.840.10008.1.2.4.52", "JPEG Extended (Process 3 & 5)", false, false),
    jpeg("1.2.840.10008.1.2.4.53", "JPEG Spectral Selection, Non-Hierarchical (Process 6 & 8)", false, false),
    jpeg("1.2.840.10008.1.2.4.54", "JPEG Spectral Selection, Non-Hierarchical (Process 7 & 9)", false, false),
    jpeg("1.2.840.10008.1.2.4.55", "JPEG Full Progression, Non-Hierarchical (Process 10 & 12)", false, false),
    jpeg("1.2.840.10008.1.2.4.56", "JPEG Full Progression, Non-Hierarchical (Process 11 & 13)", false, false),
    jpeg("1.2.840.10008.1.2.4.57", "JPEG Lossless, Non-Hierarchical (Process 14)", true, false),
    jpeg("1.2.840.10008.1.2.4.58", "JPEG Lossless, Non-Hierarchical (Process 15)", true, false),
    jpeg("1.2.840.10008.1.2.4.59", "JPEG Extended, Hierarchical (Process 16 & 18)", false, true),
    jpeg("1.2.840.10008.1.2.4.60", "JPEG Extended, Hierarchical (Process 17 & 19)", false, true),
    jpeg("1.2.840.10008.1.2.4.61", "JPEG Spectral Selection, Hierarchical (Process 20 & 22)", false, true),
    jpeg("1.2.840.10008.1.2.4.62", "JPEG Spectral Selection, Hierarchical (Process 21 & 23)", false, true),
    jpeg("1.2.840.10008.1.2.4.63", "JPEG Full Progression, Hierarchical (Process 24 & 26)", false, true),
    jpeg("1.2.840.10008.1.2.4.64", "JPEG Full Progression, Hierarchical (Process 25 & 27)", false, true),
    jpeg("1.2.840.10008.1.2.4.65", "JPEG Lossless, Hierarchical (Process 28)", true, true),
    jpeg("1.2.840.10008.1.2.4.66", "JPEG Lossless, Hierarchical (Process 29)", true, true),
    jpeg(JPEG_LOSSLESS_SV1, "JPEG Lossless, Non-Hierarchical, First-Order Prediction (Process 14, SV1)", true, false),
    s("1.2.840.10008.1.2.4.80", "JPEG-LS Lossless", Kind::JpegLs),
    s("1.2.840.10008.1.2.4.81", "JPEG-LS Lossy (Near-Lossless)", Kind::JpegLs),
    s(JPEG_2000_LOSSLESS, "JPEG 2000 Image Compression (Lossless Only)", Kind::Jpeg2000 { part2: false }),
    s("1.2.840.10008.1.2.4.91", "JPEG 2000 Image Compression", Kind::Jpeg2000 { part2: false }),
    s("1.2.840.10008.1.2.4.92", "JPEG 2000 Part 2 Multi-component Image Compression (Lossless Only)", Kind::Jpeg2000 { part2: true }),
    s("1.2.840.10008.1.2.4.93", "JPEG 2000 Part 2 Multi-component Image Compression", Kind::Jpeg2000 { part2: true }),
    s("1.2.840.10008.1.2.4.94", "JPIP referenced pixel data", Kind::Jpip),
    s("1.2.840.10008.1.2.4.95", "JPIP referenced pixel data", Kind::Jpip),
    s("1.2.840.10008.1.2.4.100", "MPEG-2 video (Main Profile / Main Level)", Kind::Video),
    s("1.2.840.10008.1.2.4.100.1", "MPEG-2 video (Main Profile / Main Level)", Kind::Video),
    s("1.2.840.10008.1.2.4.101", "MPEG-2 video (Main Profile / High Level)", Kind::Video),
    s("1.2.840.10008.1.2.4.101.1", "MPEG-2 video (Main Profile / High Level)", Kind::Video),
    s("1.2.840.10008.1.2.4.102", "MPEG-4 AVC / H.264 video", Kind::Video),
    s("1.2.840.10008.1.2.4.102.1", "MPEG-4 AVC / H.264 video", Kind::Video),
    s("1.2.840.10008.1.2.4.103", "MPEG-4 AVC / H.264 video", Kind::Video),
    s("1.2.840.10008.1.2.4.103.1", "MPEG-4 AVC / H.264 video", Kind::Video),
    s("1.2.840.10008.1.2.4.104", "MPEG-4 AVC / H.264 video", Kind::Video),
    s("1.2.840.10008.1.2.4.104.1", "MPEG-4 AVC / H.264 video", Kind::Video),
    s("1.2.840.10008.1.2.4.105", "MPEG-4 AVC / H.264 video", Kind::Video),
    s("1.2.840.10008.1.2.4.105.1", "MPEG-4 AVC / H.264 video", Kind::Video),
    s("1.2.840.10008.1.2.4.106", "MPEG-4 AVC / H.264 video", Kind::Video),
    s("1.2.840.10008.1.2.4.106.1", "MPEG-4 AVC / H.264 video", Kind::Video),
    s("1.2.840.10008.1.2.4.107", "HEVC / H.265 video", Kind::Video),
    s("1.2.840.10008.1.2.4.108", "HEVC / H.265 video", Kind::Video),
    s("1.2.840.10008.1.2.4.110", "JPEG XL Lossless", Kind::JpegXl),
    s("1.2.840.10008.1.2.4.111", "JPEG XL JPEG Recompression", Kind::JpegXl),
    s("1.2.840.10008.1.2.4.112", "JPEG XL", Kind::JpegXl),
    s("1.2.840.10008.1.2.4.201", "High-Throughput JPEG 2000 Image Compression (Lossless Only)", Kind::Htj2k),
    s("1.2.840.10008.1.2.4.202", "High-Throughput JPEG 2000 with RPCL Options Image Compression (Lossless Only)", Kind::Htj2k),
    s("1.2.840.10008.1.2.4.203", "High-Throughput JPEG 2000 Image Compression", Kind::Htj2k),
    s("1.2.840.10008.1.2.6.1", "RFC 2557 MIME encapsulation", Kind::Mime),
    s("1.2.840.10008.1.2.7.1", "SMPTE ST 2110 video", Kind::Smpte2110),
    s("1.2.840.10008.1.2.7.2", "SMPTE ST 2110 video", Kind::Smpte2110),
    s("1.2.840.10008.1.2.7.3", "SMPTE ST 2110 video", Kind::Smpte2110),
];

/// The table entry for `uid`, if known.
pub fn lookup(uid: &str) -> Option<&'static Syntax> {
    SYNTAXES.iter().find(|s| s.uid == uid)
}

/// What `uid` stores, if known.
pub fn kind(uid: &str) -> Option<Kind> {
    lookup(uid).map(|s| s.kind)
}

/// Transfer syntaxes whose Pixel Data is stored native (not encapsulated).
pub fn is_native(uid: &str) -> bool {
    kind(uid) == Some(Kind::Native)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uids_are_unique_and_match_the_constants() {
        for (i, a) in SYNTAXES.iter().enumerate() {
            assert!(SYNTAXES[i + 1..].iter().all(|b| b.uid != a.uid), "{} listed twice", a.uid);
        }
        for uid in [IMPLICIT_LE, EXPLICIT_LE, DEFLATED_LE, EXPLICIT_BE, GE_PRIVATE] {
            assert!(is_native(uid), "{uid}");
        }
        assert_eq!(kind(JPEG_LOSSLESS_SV1), Some(Kind::Jpeg { lossless: true, hierarchical: false }));
        assert_eq!(kind(JPEG_2000_LOSSLESS), Some(Kind::Jpeg2000 { part2: false }));
        assert_eq!(kind("1.2.3"), None);
    }
}
