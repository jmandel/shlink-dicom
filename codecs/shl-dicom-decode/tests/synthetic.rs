//! End-to-end tests on DICOM files built in memory. Encapsulated cases use fake codecs injected
//! with `decode_file_with`, so frame splitting and normalisation are tested without real codecs.

use shl_codec_common::{ColorOut, DecodeError, DecodedFrame, FrameInfo, Result as CodecResult};
use shl_dicom_decode::{decode_file, decode_file_with, Error};

use shl_dicom_decode::syntax::{DEFLATED_LE as DEFLATED, EXPLICIT_BE, EXPLICIT_LE, IMPLICIT_LE};
const RLE: &str = "1.2.840.10008.1.2.5";

#[path = "support/ds.rs"]
mod ds;
use ds::{part10, Ds, Enc};

fn u16s(d: &[u8]) -> Vec<u16> {
    d.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect()
}

fn i16s(d: &[u8]) -> Vec<i16> {
    d.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect()
}

#[test]
fn explicit_le_signed_12_bit_is_sign_extended() {
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(1, "MONOCHROME2", None, None, 1, 3, 16, 12, 1);
    let px: Vec<u8> = [0x0800u16, 0xF7FF, 0x1005].iter().flat_map(|v| v.to_le_bytes()).collect();
    ds.elem(0x7FE0, 0x0010, b"OW", &px);
    let out = decode_file(&part10(EXPLICIT_LE, &ds.out, true)).unwrap();
    assert_eq!(i16s(&out.data), [-2048, 2047, 5]);
    assert!(out.signed);
}

#[test]
fn unsigned_bits_above_bits_stored_are_masked() {
    let mut ds = Ds::new(Enc::ImplicitLe);
    ds.image(1, "MONOCHROME2", None, None, 1, 2, 16, 10, 0);
    let px: Vec<u8> = [0xFC00u16 | 0x3FF, 0x0401].iter().flat_map(|v| v.to_le_bytes()).collect();
    ds.elem(0x7FE0, 0x0010, b"OW", &px);
    let out = decode_file(&part10(IMPLICIT_LE, &ds.out, true)).unwrap();
    assert_eq!(u16s(&out.data), [0x3FF, 0x001]);
}

#[test]
fn big_endian_16_and_32_bit_are_swapped() {
    let mut ds = Ds::new(Enc::ExplicitBe);
    ds.image(1, "MONOCHROME2", None, None, 1, 2, 16, 16, 0);
    ds.elem(0x7FE0, 0x0010, b"OW", &[0x12, 0x34, 0xAB, 0xCD]);
    let out = decode_file(&part10(EXPLICIT_BE, &ds.out, true)).unwrap();
    assert_eq!(u16s(&out.data), [0x1234, 0xABCD]);

    let mut ds = Ds::new(Enc::ExplicitBe);
    ds.image(1, "MONOCHROME2", None, None, 1, 1, 32, 32, 0);
    ds.elem(0x7FE0, 0x0010, b"OB", &[0x01, 0x02, 0x03, 0x04]);
    let out = decode_file(&part10(EXPLICIT_BE, &ds.out, true)).unwrap();
    assert_eq!(out.data, [0x04, 0x03, 0x02, 0x01]);
}

#[test]
fn big_endian_8_bit_in_ow_is_word_swapped() {
    // 1×3 8-bit in OW: the samples 1 2 3 + pad byte are stored as byte-swapped 16-bit words,
    // 02 01 00 03 (pydicom's `be_swap_ow` case).
    let mut ds = Ds::new(Enc::ExplicitBe);
    ds.image(1, "MONOCHROME2", None, None, 1, 3, 8, 8, 0);
    ds.elem(0x7FE0, 0x0010, b"OW", &[2, 1, 0, 3]);
    let out = decode_file(&part10(EXPLICIT_BE, &ds.out, true)).unwrap();
    assert_eq!(out.data, [1, 2, 3]);

    // The same bytes in OB are taken as they are.
    let mut ds = Ds::new(Enc::ExplicitBe);
    ds.image(1, "MONOCHROME2", None, None, 1, 3, 8, 8, 0);
    ds.elem(0x7FE0, 0x0010, b"OB", &[1, 2, 3, 0]);
    let out = decode_file(&part10(EXPLICIT_BE, &ds.out, true)).unwrap();
    assert_eq!(out.data, [1, 2, 3]);
}

#[test]
fn bit_packed_frames_are_not_byte_aligned() {
    // 3 frames of 1×3 pixels = 9 bits packed LSB first, frames run on across byte boundaries.
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(1, "MONOCHROME2", None, Some("3"), 1, 3, 1, 1, 0);
    // bits: f0 = 1 0 1, f1 = 1 1 0, f2 = 0 0 1  -> 0b0011_0101 0b0000_0001
    ds.elem(0x7FE0, 0x0010, b"OB", &[0b0011_0101, 0b0000_0001]);
    let out = decode_file(&part10(EXPLICIT_LE, &ds.out, true)).unwrap();
    assert_eq!(out.data, [1, 0, 1, 0, 1, 1, 0, 0, 1]);
    assert_eq!(out.frames, 3);
}

#[test]
fn planar_rgb_is_interleaved_per_frame() {
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(3, "RGB", Some(1), Some("2"), 1, 2, 8, 8, 0);
    ds.elem(0x7FE0, 0x0010, b"OB", &[1, 2, 3, 4, 5, 6, 11, 12, 13, 14, 15, 16]);
    let out = decode_file(&part10(EXPLICIT_LE, &ds.out, true)).unwrap();
    assert_eq!(out.data, [1, 3, 5, 2, 4, 6, 11, 13, 15, 12, 14, 16]);
}

#[test]
fn ybr_full_422_is_expanded_and_converted() {
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(3, "YBR_FULL_422", Some(0), None, 1, 2, 8, 8, 0);
    // Y1 Y2 Cb Cr: neutral chroma -> grey
    ds.elem(0x7FE0, 0x0010, b"OB", &[10, 200, 128, 128]);
    let out = decode_file(&part10(EXPLICIT_LE, &ds.out, true)).unwrap();
    assert_eq!(out.data, [10, 10, 10, 200, 200, 200]);
    assert_eq!(out.photometric, "RGB");
}

#[test]
fn bare_dataset_and_meta_without_preamble() {
    let mut ds = Ds::new(Enc::ImplicitLe);
    ds.text(0x0008, 0x0060, b"CS", "OT");
    ds.image(1, "MONOCHROME2", None, None, 1, 2, 8, 8, 0);
    ds.elem(0x7FE0, 0x0010, b"OB", &[7, 9]);
    assert_eq!(decode_file(&ds.out).unwrap().data, [7, 9]);
    assert_eq!(decode_file(&part10(IMPLICIT_LE, &ds.out, false)).unwrap().data, [7, 9]);

    let mut be = Ds::new(Enc::ExplicitBe);
    be.text(0x0008, 0x0060, b"CS", "OT");
    be.image(1, "MONOCHROME2", None, None, 1, 1, 16, 16, 0);
    be.elem(0x7FE0, 0x0010, b"OW", &[0x01, 0x02]);
    assert_eq!(u16s(&decode_file(&be.out).unwrap().data), [0x0102]);
}

#[test]
fn deflated_dataset() {
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(1, "MONOCHROME2", None, None, 2, 2, 8, 8, 0);
    ds.elem(0x7FE0, 0x0010, b"OB", &[1, 2, 3, 4]);
    let deflated = miniz_oxide::deflate::compress_to_vec(&ds.out, 6);
    let out = decode_file(&part10(DEFLATED, &deflated, true)).unwrap();
    assert_eq!(out.data, [1, 2, 3, 4]);
    let mut bad = part10(DEFLATED, &deflated, true);
    bad.truncate(bad.len() - 5);
    assert!(matches!(decode_file(&bad), Err(Error::Invalid(_))));
}

#[test]
fn short_pixel_data_is_invalid_and_excess_is_ignored() {
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(1, "MONOCHROME2", None, Some("2"), 2, 2, 16, 16, 0);
    ds.elem(0x7FE0, 0x0010, b"OW", &[0; 14]);
    assert!(matches!(decode_file(&part10(EXPLICIT_LE, &ds.out, true)), Err(Error::Invalid(_))));

    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(1, "MONOCHROME2", None, None, 1, 1, 8, 8, 0);
    ds.elem(0x7FE0, 0x0010, b"OB", &[5, 0, 0, 0]);
    assert_eq!(decode_file(&part10(EXPLICIT_LE, &ds.out, true)).unwrap().data, [5]);
}

#[test]
fn truncated_file_is_invalid() {
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(1, "MONOCHROME2", None, None, 4, 4, 16, 16, 0);
    ds.elem(0x7FE0, 0x0010, b"OW", &[0; 32]);
    let mut f = part10(EXPLICIT_LE, &ds.out, true);
    f.truncate(f.len() - 10);
    assert!(matches!(decode_file(&f), Err(Error::Invalid(_))));
}

#[test]
fn missing_attributes_are_invalid() {
    // Only Rows: neither the size nor the sample width can be told from 2 bytes.
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.us(0x0028, 0x0010, 1);
    ds.elem(0x7FE0, 0x0010, b"OB", &[0, 0]);
    assert!(matches!(decode_file(&part10(EXPLICIT_LE, &ds.out, true)), Err(Error::Invalid(_))));
    // RGB without Planar Configuration: pydicom refuses it. One pixel reads the same either
    // way, so it decodes, with the inference reported.
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(3, "RGB", None, None, 1, 1, 8, 8, 0);
    ds.elem(0x7FE0, 0x0010, b"OB", &[1, 2, 3, 0]);
    let out = decode_file(&part10(EXPLICIT_LE, &ds.out, true)).unwrap();
    assert_eq!(out.data, [1, 2, 3]);
    assert_eq!(out.inferred.len(), 1);
}

#[test]
fn unknown_transfer_syntax_is_unsupported() {
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(1, "MONOCHROME2", None, None, 1, 1, 8, 8, 0);
    ds.encapsulated(&[], &[b"xx"]);
    let f = part10("1.2.840.10008.1.2.4.100", &ds.out, true);
    assert!(matches!(decode_file(&f), Err(Error::Unsupported(_))));
}

// ---- encapsulated, with fake codecs -------------------------------------------------------

/// "Codec" whose codestream is the frame stored planar (sample planes one after another).
fn planar_passthrough(cs: &[u8], info: &FrameInfo) -> CodecResult<DecodedFrame> {
    let n = info.frame_bytes().ok_or_else(|| DecodeError::Invalid("size".into()))?;
    if cs.len() < n {
        return Err(DecodeError::Invalid(format!("short frame {} < {n}", cs.len())));
    }
    Ok(DecodedFrame { data: cs[..n].to_vec(), planar: true, color: ColorOut::AsDeclared })
}

fn wrong_size(_: &[u8], _: &FrameInfo) -> CodecResult<DecodedFrame> {
    Ok(DecodedFrame { data: vec![0; 3], planar: false, color: ColorOut::AsDeclared })
}

fn says_rgb(cs: &[u8], info: &FrameInfo) -> CodecResult<DecodedFrame> {
    let mut f = planar_passthrough(cs, info)?;
    f.color = ColorOut::Rgb;
    f.planar = false;
    Ok(f)
}

fn with(f: shl_codec_common::DecodeFn) -> impl Fn(&str) -> Option<shl_codec_common::DecodeFn> {
    move |ts| (ts == RLE).then_some(f)
}

#[test]
fn encapsulated_frames_by_basic_offset_table_are_interleaved_and_converted() {
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(3, "YBR_FULL", Some(0), Some("2"), 1, 2, 8, 8, 0);
    // frame 0 in two fragments, frame 1 in one; planar Y Y Cb Cb Cr Cr with neutral chroma
    let f0a: &[u8] = &[50, 60, 128];
    let f0b: &[u8] = &[128, 128, 128];
    let f1: &[u8] = &[70, 80, 128, 128, 128, 128];
    let second = (8 + f0a.len() + 8 + f0b.len()) as u32;
    ds.encapsulated(&[0, second], &[f0a, f0b, f1]);
    let out = decode_file_with(&part10(RLE, &ds.out, true), with(planar_passthrough)).unwrap();
    assert_eq!(out.data, [50, 50, 50, 60, 60, 60, 70, 70, 70, 80, 80, 80]);
    assert_eq!(out.photometric, "RGB");
}

#[test]
fn encapsulated_one_fragment_per_frame_with_sign_extension() {
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(1, "MONOCHROME2", None, Some("2"), 1, 1, 16, 12, 1);
    ds.encapsulated(&[], &[&0x0FFFu16.to_le_bytes(), &0xF001u16.to_le_bytes()]);
    let out = decode_file_with(&part10(RLE, &ds.out, true), with(planar_passthrough)).unwrap();
    assert_eq!(i16s(&out.data), [-1, 1]);
}

#[test]
fn codec_rgb_output_is_not_converted_again() {
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(3, "YBR_FULL_422", Some(0), None, 1, 1, 8, 8, 0);
    ds.encapsulated(&[], &[&[10, 20, 30]]);
    let out = decode_file_with(&part10(RLE, &ds.out, true), with(says_rgb)).unwrap();
    assert_eq!(out.data, [10, 20, 30]);
}

#[test]
fn codec_output_of_the_wrong_size_is_invalid() {
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(1, "MONOCHROME2", None, None, 2, 2, 8, 8, 0);
    ds.encapsulated(&[], &[b"anything"]);
    assert!(matches!(decode_file_with(&part10(RLE, &ds.out, true), with(wrong_size)), Err(Error::Invalid(_))));
}

#[test]
fn fewer_fragments_than_frames_is_invalid() {
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(1, "MONOCHROME2", None, Some("3"), 1, 1, 8, 8, 0);
    ds.encapsulated(&[], &[&[1], &[2]]);
    assert!(matches!(
        decode_file_with(&part10(RLE, &ds.out, true), with(planar_passthrough)),
        Err(Error::Invalid(_))
    ));
}

// ---- robustness: mutated inputs must never panic -----------------------------------------

fn corpus_samples() -> Vec<Vec<u8>> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../codec-corpus/formats/uncompressed/samples");
    let mut v: Vec<_> = std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).collect())
        .unwrap_or_default();
    v.sort();
    v.into_iter().filter_map(|p| std::fs::read(p).ok()).filter(|b| b.len() < 600_000).collect()
}

fn zero_codec(_: &[u8], info: &FrameInfo) -> CodecResult<DecodedFrame> {
    let n = info.frame_bytes().filter(|n| *n < 1 << 26).ok_or_else(|| DecodeError::Unsupported("big".into()))?;
    Ok(DecodedFrame { data: vec![0; n], planar: info.samples_per_pixel == 3, color: ColorOut::AsDeclared })
}

#[test]
fn mutated_files_never_panic() {
    let mut seeds = corpus_samples();
    // Synthetic encapsulated seeds too.
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(3, "YBR_FULL", Some(0), Some("2"), 2, 2, 8, 8, 0);
    ds.encapsulated(&[0, 20], &[&[1; 12], &[2; 12]]);
    seeds.push(part10(RLE, &ds.out, true));
    let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut rnd = move || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    let iterations = std::env::var("SHL_FUZZ_ITERS").ok().and_then(|s| s.parse().ok()).unwrap_or(300usize);
    for i in 0..iterations {
        let seed = &seeds[i % seeds.len()];
        let mut f = seed.clone();
        // Mutate mostly the header region, where lengths and attributes live.
        let span = f.len().clamp(1, 2048);
        for _ in 0..(1 + rnd() % 8) {
            let at = (rnd() as usize) % span;
            match rnd() % 4 {
                0 => f[at] = rnd() as u8,
                1 => f[at] ^= 1 << (rnd() % 8),
                2 => f[at] = [0x00, 0xFF, 0x7F, 0x80][(rnd() % 4) as usize],
                _ => {
                    let cut = (rnd() as usize) % f.len().max(1);
                    f.truncate(cut);
                    break;
                }
            }
        }
        let _ = decode_file_with(&f, |ts| match ts {
            RLE => Some(zero_codec as shl_codec_common::DecodeFn),
            // The in-crate codecs for native frames run for real.
            "1.2.840.10008.1.2.1.98" | "1.2.840.10008.1.2.8.1" => shl_dicom_decode::codec_for(ts),
            _ => None,
        });
        let _ = shl_dicom_decode::decode_frames(&f, (rnd() % 4) as usize, (rnd() % 3) as usize, (rnd() % 3) as u8);
    }
}

// ---- real-world quirks (IDC and toolkit quirk sets) ---------------------------------------

fn ov(v: &[u64]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

#[test]
fn extended_offset_table_with_header_in_length_falls_back() {
    // pydicom 3.0.1 (IDC Mirax): the first EOT length includes the 8-byte item header.
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(1, "MONOCHROME2", None, Some("2"), 1, 2, 8, 8, 0);
    ds.elem(0x7FE0, 0x0001, b"OV", &ov(&[0, 10]));
    ds.elem(0x7FE0, 0x0002, b"OV", &ov(&[10, 2]));
    ds.encapsulated(&[], &[&[1, 2], &[3, 4]]);
    let out = decode_file_with(&part10(RLE, &ds.out, true), with(planar_passthrough)).unwrap();
    assert_eq!(out.data, [1, 2, 3, 4]);
}

#[test]
fn basic_offset_table_off_item_starts_falls_back() {
    // GDCM 00191113.dcm: entries count 9 bytes per item header, one entry too many.
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(1, "MONOCHROME2", None, Some("4"), 1, 1, 8, 8, 0);
    ds.encapsulated(&[0, 10, 20, 30, 40], &[&[1], &[2], &[3], &[4]]);
    let out = decode_file_with(&part10(RLE, &ds.out, true), with(planar_passthrough)).unwrap();
    assert_eq!(out.data, [1, 2, 3, 4]);
}

#[test]
fn stray_top_level_item_is_skipped() {
    // fo-dicom #364: an (FFFE,E000) item tag among the top-level elements.
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.text(0x0018, 0x5020, b"LO", "x");
    ds.out.extend_from_slice(b"\xFE\xFF\x00\xE0\x04\x00\x00\x00junk");
    ds.image(1, "MONOCHROME2", None, None, 1, 2, 8, 8, 0);
    ds.elem(0x7FE0, 0x0010, b"OB", &[5, 6]);
    assert_eq!(decode_file(&part10(EXPLICIT_LE, &ds.out, true)).unwrap().data, [5, 6]);
}

#[test]
fn one_implicit_element_in_explicit_data_set_is_reread() {
    // DMCPACS_ExplicitImplicit_BogusIOP: (0008,0080) written implicit at the top level.
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.text(0x0008, 0x0060, b"CS", "MR");
    ds.out.extend_from_slice(b"\x08\x00\x80\x00\x03\x00\x00\x00abc");
    ds.image(1, "MONOCHROME2", None, None, 1, 2, 8, 8, 0);
    ds.elem(0x7FE0, 0x0010, b"OB", &[5, 6]);
    assert_eq!(decode_file(&part10(EXPLICIT_LE, &ds.out, true)).unwrap().data, [5, 6]);

    // TheralysGDCM120Bug: the implicit element is inside a sequence item, not its first element.
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.out.extend_from_slice(b"\x05\x20\x10\x00LO\x02\x00x ");
    ds.out.extend_from_slice(b"\x05\x20\x40\x14SQ\x00\x00\xFF\xFF\xFF\xFF");
    ds.out.extend_from_slice(b"\xFE\xFF\x00\xE0\xFF\xFF\xFF\xFF");
    ds.out.extend_from_slice(b"\x05\x20\x01\x14CS\x02\x00AB");
    ds.out.extend_from_slice(b"\x05\x20\x06\x14\x02\x00\x00\x00\x01\x02");
    ds.out.extend_from_slice(b"\xFE\xFF\x0D\xE0\x00\x00\x00\x00\xFE\xFF\xDD\xE0\x00\x00\x00\x00");
    ds.image(1, "MONOCHROME2", None, None, 1, 2, 8, 8, 0);
    ds.elem(0x7FE0, 0x0010, b"OB", &[7, 8]);
    assert_eq!(decode_file(&part10(EXPLICIT_LE, &ds.out, true)).unwrap().data, [7, 8]);
}

#[test]
fn whole_data_set_in_the_wrong_vr_is_still_refused() {
    let mut ds = Ds::new(Enc::ImplicitLe);
    ds.image(1, "MONOCHROME2", None, None, 1, 1, 8, 8, 0);
    ds.elem(0x7FE0, 0x0010, b"OB", &[1, 0]);
    assert!(matches!(decode_file(&part10(EXPLICIT_LE, &ds.out, true)), Err(Error::Invalid(_))));
}

#[test]
fn group_0002_after_the_meta_is_ignored() {
    // fo-dicom #1376: the real meta says one syntax; a second group 0002 block in the data set
    // says Explicit VR Little Endian and must not override it.
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.elem(0x0002, 0x0000, b"UL", &30u32.to_le_bytes());
    ds.text(0x0002, 0x0010, b"UI", "1.2.840.10008.1.2.1");
    ds.image(1, "MONOCHROME2", None, None, 1, 2, 8, 8, 0);
    ds.encapsulated(&[], &[&[9, 8]]);
    let out = decode_file_with(&part10(RLE, &ds.out, true), with(planar_passthrough)).unwrap();
    assert_eq!(out.data, [9, 8]);
    assert_eq!(out.transfer_syntax, RLE);
}

/// Fake J2K "codec": returns the bytes after a fixed 50-byte SOC+SIZ header as samples.
fn j2k_passthrough(cs: &[u8], info: &FrameInfo) -> CodecResult<DecodedFrame> {
    let n = info.frame_bytes().ok_or_else(|| DecodeError::Invalid("size".into()))?;
    let body = cs.get(50..50 + n).ok_or_else(|| DecodeError::Invalid("short".into()))?;
    Ok(DecodedFrame { data: body.to_vec(), planar: false, color: ColorOut::AsDeclared })
}

fn soc_siz(precisions: &[u8], signed: bool) -> Vec<u8> {
    let mut v = vec![0xFF, 0x4F, 0xFF, 0x51];
    v.extend_from_slice(&[0u8; 36]); // Lsiz, Rsiz, sizes and offsets
    v.extend_from_slice(&(precisions.len() as u16).to_be_bytes()); // Csiz at SIZ + 38
    for p in precisions {
        v.extend_from_slice(&[(p - 1) | if signed { 0x80 } else { 0 }, 1, 1]);
    }
    v.resize(50, 0);
    v
}

#[test]
fn jpeg2000_keeps_codestream_precision_above_bits_stored() {
    // Osirix10vs8BitsStored: SIZ precision 10, Bits Stored 8 -> keep 10 bits.
    const J2K: &str = "1.2.840.10008.1.2.4.90";
    let codecs = |ts: &str| (ts == J2K).then_some(j2k_passthrough as shl_codec_common::DecodeFn);
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(1, "MONOCHROME2", None, None, 1, 2, 16, 8, 0);
    let mut cs = soc_siz(&[10], false);
    cs.extend_from_slice(&[0xFF, 0x03, 0xFF, 0xF0]); // 0x03FF, 0xF0FF
    ds.encapsulated(&[], &[&cs]);
    let out = decode_file_with(&part10(J2K, &ds.out, true), codecs).unwrap();
    assert_eq!(u16s(&out.data), [0x03FF, 0x00FF]);

    // Precision below Bits Stored: Bits Stored wins.
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(1, "MONOCHROME2", None, None, 1, 1, 16, 12, 0);
    let mut cs = soc_siz(&[8], false);
    cs.extend_from_slice(&[0xFF, 0xFF]);
    ds.encapsulated(&[], &[&cs]);
    assert_eq!(u16s(&decode_file_with(&part10(J2K, &ds.out, true), codecs).unwrap().data), [0x0FFF]);

    // Not JPEG 2000: Bits Stored only, whatever the codestream holds.
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(1, "MONOCHROME2", None, None, 1, 1, 16, 8, 0);
    ds.encapsulated(&[], &[&[0xFF, 0x03]]);
    let out = decode_file_with(&part10(RLE, &ds.out, true), with(planar_passthrough)).unwrap();
    assert_eq!(u16s(&out.data), [0x00FF]);
}

#[test]
fn refusals_name_the_reason() {
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(1, "MONOCHROME2", None, None, 1, 1, 8, 8, 0);
    ds.encapsulated(&[], &[b"xx"]);
    let Err(Error::Unsupported(m)) = decode_file(&part10("1.2.840.10008.1.2.4.100", &ds.out, true)) else {
        panic!("MPEG-2 must be unsupported")
    };
    assert!(m.starts_with("MPEG-2 video") && m.contains("(1.2.840.10008.1.2.4.100)"), "{m}");
}

#[test]
fn ge_private_syntax_has_big_endian_pixels() {
    let mut ds = Ds::new(Enc::ImplicitLe);
    ds.image(1, "MONOCHROME2", None, None, 1, 2, 16, 12, 0);
    ds.elem(0x7FE0, 0x0010, b"OW", &[0x01, 0x02, 0x0A, 0xBC]);
    let out = decode_file(&part10("1.2.840.113619.5.2", &ds.out, true)).unwrap();
    assert_eq!(u16s(&out.data), [0x0102, 0x0ABC & 0x0FFF]);
}

#[test]
fn float_pixel_data_keeps_stored_values() {
    // Float Pixel Data: no Bits Stored or Pixel Representation; Bits Allocated inferred when absent.
    let vals = [1.5f32, -2.25, f32::NAN, 7.0];
    let le: Vec<u8> = vals.iter().flat_map(|v| v.to_le_bytes()).collect();
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.us(0x0028, 0x0002, 1);
    ds.text(0x0028, 0x0008, b"IS", "2");
    ds.us(0x0028, 0x0010, 1);
    ds.us(0x0028, 0x0011, 2);
    ds.elem(0x7FE0, 0x0008, b"OF", &le);
    let file = part10(EXPLICIT_LE, &ds.out, true);
    let out = decode_file(&file).unwrap();
    assert!(out.float && out.bits_allocated == 32 && out.frames == 2);
    assert_eq!(out.data, le);
    assert!(out.inferred.iter().any(|i| i.attribute == "BitsAllocated"));
    // Frame range: frame 1 alone.
    let one = shl_dicom_decode::decode_frames(&file, 1, 1, 0).unwrap();
    assert_eq!((one.frames, one.first_frame, one.total_frames), (1, 1, 2));
    assert_eq!(one.data, le[8..]);

    // Double Float Pixel Data in Explicit VR Big Endian: swapped per 8-byte sample.
    let mut ds = Ds::new(Enc::ExplicitBe);
    ds.us(0x0028, 0x0002, 1);
    ds.us(0x0028, 0x0010, 1);
    ds.us(0x0028, 0x0011, 1);
    ds.us(0x0028, 0x0100, 64);
    ds.elem(0x7FE0, 0x0009, b"OD", &(-3.5f64).to_be_bytes());
    let out = decode_file(&part10(EXPLICIT_BE, &ds.out, true)).unwrap();
    assert_eq!(out.data, (-3.5f64).to_le_bytes());
}

#[test]
fn missing_samples_per_pixel_means_one() {
    // gdcm-CR-DCMTK-16-NonSamplePerPix: GDCM assumes 1.
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.text(0x0028, 0x0004, b"CS", "MONOCHROME2");
    ds.us(0x0028, 0x0010, 1);
    ds.us(0x0028, 0x0011, 2);
    ds.us(0x0028, 0x0100, 16);
    ds.us(0x0028, 0x0101, 16);
    ds.us(0x0028, 0x0103, 0);
    ds.elem(0x7FE0, 0x0010, b"OW", &[1, 0, 2, 0]);
    assert_eq!(u16s(&decode_file(&part10(EXPLICIT_LE, &ds.out, true)).unwrap().data), [1, 2]);
}

// ---- inferring missing or impossible attributes -------------------------------------------

/// A smooth 3-sample test image, rows × cols, interleaved.
fn smooth_rgb(rows: usize, cols: usize) -> Vec<u8> {
    let mut v = Vec::new();
    for r in 0..rows {
        for c in 0..cols {
            let d = ((r as i32 - 12).pow(2) + (c as i32 - 20).pow(2)) as f64;
            v.extend_from_slice(&[(c * 6 % 256) as u8, (r * 7 % 256) as u8, (255.0 * (-d / 300.0).exp()) as u8]);
        }
    }
    v
}

fn planes_of(px: &[u8]) -> Vec<u8> {
    (0..3).flat_map(|s| px.iter().skip(s).step_by(3).copied()).collect()
}

fn rgb_without_planar(enc: Enc, rows: u16, cols: u16, pixels: &[u8]) -> Vec<u8> {
    let mut ds = Ds::new(enc);
    ds.image(3, "RGB", None, None, rows, cols, 8, 8, 0);
    ds.elem(0x7FE0, 0x0010, b"OB", pixels);
    let ts = if enc == Enc::ExplicitBe { EXPLICIT_BE } else { EXPLICIT_LE };
    part10(ts, &ds.out, true)
}

fn inferred<'a>(c: &'a shl_dicom_decode::Canonical, attr: &str) -> Option<&'a shl_dicom_decode::Inference> {
    c.inferred.iter().find(|i| i.attribute == attr)
}

#[test]
fn missing_planar_configuration_is_inferred_from_smoothness() {
    let (rows, cols) = (24usize, 40usize);
    let img = smooth_rgb(rows, cols);
    // Interleaved data without the attribute.
    let out = decode_file(&rgb_without_planar(Enc::ExplicitLe, rows as u16, cols as u16, &img)).unwrap();
    assert_eq!(out.data, img);
    assert_eq!(inferred(&out, "PlanarConfiguration").unwrap().value, "0");
    // The same image stored planar, also in big endian.
    for enc in [Enc::ExplicitLe, Enc::ExplicitBe] {
        let out = decode_file(&rgb_without_planar(enc, rows as u16, cols as u16, &planes_of(&img))).unwrap();
        assert_eq!(out.data, img);
        assert_eq!(inferred(&out, "PlanarConfiguration").unwrap().value, "1");
    }
    // A well-formed file reports nothing.
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(3, "RGB", Some(0), None, rows as u16, cols as u16, 8, 8, 0);
    ds.elem(0x7FE0, 0x0010, b"OB", &img);
    assert!(decode_file(&part10(EXPLICIT_LE, &ds.out, true)).unwrap().inferred.is_empty());
}

#[test]
fn planar_inference_refuses_when_it_cannot_tell() {
    // Noise: neither reading is smoother.
    let mut x: u32 = 99;
    let noise: Vec<u8> = (0..32 * 32 * 3)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            x as u8
        })
        .collect();
    let Err(Error::Invalid(m)) = decode_file(&rgb_without_planar(Enc::ExplicitLe, 32, 32, &noise)) else {
        panic!("noise must be refused")
    };
    assert!(m.contains("Planar Configuration"), "{m}");
    // Too small to judge.
    let tiny: Vec<u8> = (0..27u8).map(|i| i.wrapping_mul(37)).collect();
    assert!(matches!(decode_file(&rgb_without_planar(Enc::ExplicitLe, 3, 3, &tiny)), Err(Error::Invalid(_))));
    // A constant image reads the same either way.
    let out = decode_file(&rgb_without_planar(Enc::ExplicitLe, 3, 3, &[7; 27])).unwrap();
    assert_eq!(out.data, [7; 27]);
}

#[test]
fn encapsulated_data_does_not_need_planar_configuration() {
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(3, "RGB", None, None, 1, 2, 8, 8, 0);
    ds.encapsulated(&[], &[&[1, 2, 3, 4, 5, 6]]);
    let out = decode_file_with(&part10(RLE, &ds.out, true), with(planar_passthrough)).unwrap();
    assert_eq!(out.data, [1, 3, 5, 2, 4, 6]);
    assert!(inferred(&out, "PlanarConfiguration").unwrap().reason.contains("encapsulated"));
}

#[test]
fn bits_stored_missing_or_impossible_means_all_bits() {
    for bs in [None, Some(0u16), Some(20)] {
        let mut ds = Ds::new(Enc::ExplicitLe);
        ds.us(0x0028, 0x0002, 1);
        ds.text(0x0028, 0x0004, b"CS", "MONOCHROME2");
        ds.us(0x0028, 0x0010, 1);
        ds.us(0x0028, 0x0011, 1);
        ds.us(0x0028, 0x0100, 16);
        if let Some(b) = bs {
            ds.us(0x0028, 0x0101, b);
        }
        ds.us(0x0028, 0x0103, 0);
        ds.elem(0x7FE0, 0x0010, b"OW", &0xFFFFu16.to_le_bytes());
        let out = decode_file(&part10(EXPLICIT_LE, &ds.out, true)).unwrap();
        assert_eq!(u16s(&out.data), [0xFFFF], "{bs:?}");
        assert_eq!(inferred(&out, "BitsStored").unwrap().value, "16");
    }
}

#[test]
fn samples_and_photometric_stand_in_for_each_other() {
    // RGB without Samples per Pixel: 3.
    let img = smooth_rgb(16, 16);
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.text(0x0028, 0x0004, b"CS", "RGB");
    ds.us(0x0028, 0x0006, 0);
    for (e, v) in [(0x0010u16, 16u16), (0x0011, 16), (0x0100, 8), (0x0101, 8), (0x0103, 0)] {
        ds.us(0x0028, e, v);
    }
    ds.elem(0x7FE0, 0x0010, b"OB", &img);
    let out = decode_file(&part10(EXPLICIT_LE, &ds.out, true)).unwrap();
    assert_eq!((out.samples_per_pixel, out.data.len()), (3, img.len()));
    // No Photometric Interpretation: from Samples per Pixel.
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.us(0x0028, 0x0002, 1);
    for (e, v) in [(0x0010u16, 1u16), (0x0011, 2), (0x0100, 8), (0x0101, 8), (0x0103, 0)] {
        ds.us(0x0028, e, v);
    }
    ds.elem(0x7FE0, 0x0010, b"OB", &[3, 4]);
    let out = decode_file(&part10(EXPLICIT_LE, &ds.out, true)).unwrap();
    assert_eq!(out.photometric, "MONOCHROME2");
    // An undefined term with 1 sample reads as MONOCHROME2 (GDCM's MR16BitsAllocated_8BitsStored).
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.image(1, "MONOCHROME", None, None, 1, 2, 8, 8, 0);
    ds.elem(0x7FE0, 0x0010, b"OB", &[3, 4]);
    let out = decode_file(&part10(EXPLICIT_LE, &ds.out, true)).unwrap();
    assert_eq!((out.photometric.as_str(), out.data.as_slice()), ("MONOCHROME2", &[3u8, 4][..]));
}

#[test]
fn native_size_from_the_data_length() {
    // Columns missing: 2 rows of 8-bit, 6 bytes -> 3 columns.
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.us(0x0028, 0x0002, 1);
    ds.text(0x0028, 0x0004, b"CS", "MONOCHROME2");
    for (e, v) in [(0x0010u16, 2u16), (0x0100, 8), (0x0101, 8), (0x0103, 0)] {
        ds.us(0x0028, e, v);
    }
    ds.elem(0x7FE0, 0x0010, b"OB", &[1, 2, 3, 4, 5, 6]);
    let out = decode_file(&part10(EXPLICIT_LE, &ds.out, true)).unwrap();
    assert_eq!((out.rows, out.columns), (2, 3));
    // Bits Allocated missing: 2×2 pixels in 8 bytes -> 16 bits.
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.us(0x0028, 0x0002, 1);
    ds.text(0x0028, 0x0004, b"CS", "MONOCHROME2");
    for (e, v) in [(0x0010u16, 2u16), (0x0011, 2), (0x0103, 0)] {
        ds.us(0x0028, e, v);
    }
    ds.elem(0x7FE0, 0x0010, b"OW", &[1, 0, 2, 0, 3, 0, 4, 0]);
    let out = decode_file(&part10(EXPLICIT_LE, &ds.out, true)).unwrap();
    assert_eq!((out.bits_allocated, u16s(&out.data)), (16, vec![1, 2, 3, 4]));
    // A length that fits no size is still refused.
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.us(0x0028, 0x0002, 1);
    ds.text(0x0028, 0x0004, b"CS", "MONOCHROME2");
    for (e, v) in [(0x0010u16, 2u16), (0x0011, 2), (0x0103, 0)] {
        ds.us(0x0028, e, v);
    }
    ds.elem(0x7FE0, 0x0010, b"OB", &[0; 12]);
    assert!(matches!(decode_file(&part10(EXPLICIT_LE, &ds.out, true)), Err(Error::Invalid(_))));
}

#[test]
fn encapsulated_attributes_from_the_codestream() {
    // JPEG 2000 with Bits Allocated/Stored 0xFFFF and no Rows/Columns/Pixel Representation:
    // all from SIZ (precision 12, signed, 2×1).
    const J2K: &str = "1.2.840.10008.1.2.4.90";
    let codecs = |ts: &str| (ts == J2K).then_some(j2k_passthrough as shl_codec_common::DecodeFn);
    let mut cs = vec![0xFF, 0x4F, 0xFF, 0x51, 0, 41, 0, 0];
    for v in [2u32, 1, 0, 0, 2, 1, 0, 0] {
        cs.extend_from_slice(&v.to_be_bytes());
    }
    cs.extend_from_slice(&[0, 1, 0x80 | 11, 1, 1]);
    cs.resize(50, 0);
    cs.extend_from_slice(&[0xFF, 0x0F, 0x01, 0x00]); // 0x0FFF (-1 in 12 bits), 0x0001
    let mut ds = Ds::new(Enc::ExplicitLe);
    ds.us(0x0028, 0x0002, 1);
    ds.text(0x0028, 0x0004, b"CS", "MONOCHROME2");
    ds.us(0x0028, 0x0100, 0xFFFF);
    ds.us(0x0028, 0x0101, 0xFFFF);
    ds.encapsulated(&[], &[&cs]);
    let out = decode_file_with(&part10(J2K, &ds.out, true), codecs).unwrap();
    assert_eq!((out.rows, out.columns, out.bits_allocated, out.bits_stored, out.signed), (1, 2, 16, 12, true));
    assert_eq!(i16s(&out.data), [-1, 1]);
    for a in ["Rows", "Columns", "BitsAllocated", "BitsStored", "PixelRepresentation"] {
        assert!(inferred(&out, a).is_some(), "{a}");
    }
}

#[test]
fn damaged_encapsulated_endings_are_tolerated() {
    let base = |ds: &mut Ds| {
        ds.image(1, "MONOCHROME2", None, None, 1, 2, 8, 8, 0);
        ds.out.extend_from_slice(b"\xE0\x7F\x10\x00OB\x00\x00\xFF\xFF\xFF\xFF");
        ds.out.extend_from_slice(b"\xFE\xFF\x00\xE0\x00\x00\x00\x00");
    };
    // Garbage where the sequence delimiter belongs.
    let mut ds = Ds::new(Enc::ExplicitLe);
    base(&mut ds);
    ds.out.extend_from_slice(b"\xFE\xFF\x00\xE0\x02\x00\x00\x00\x07\x08");
    ds.out.extend_from_slice(b"\x00\x00\x00\x00\x00\x00\x00\x00");
    let out = decode_file_with(&part10(RLE, &ds.out, true), with(planar_passthrough)).unwrap();
    assert_eq!(out.data, [7, 8]);
    assert!(inferred(&out, "PixelData").is_some());
    // A last fragment 1 byte longer than the data: tolerated. 10 bytes longer: truncated, refused.
    for (claimed, ok) in [(3u8, true), (12, false)] {
        let mut ds = Ds::new(Enc::ExplicitLe);
        base(&mut ds);
        ds.out.extend_from_slice(&[0xFE, 0xFF, 0x00, 0xE0, claimed, 0, 0, 0, 7, 8]);
        let r = decode_file_with(&part10(RLE, &ds.out, true), with(planar_passthrough));
        assert_eq!(r.is_ok(), ok, "{claimed}: {r:?}");
    }
}
