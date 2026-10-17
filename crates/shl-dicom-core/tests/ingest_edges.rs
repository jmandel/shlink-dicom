//! Ingest edge cases: bare data sets (spec §11.1 step 3).
use std::io::Cursor;
use dicom_object::OpenFileOptions;
use dicom_transfer_syntax_registry::entries::IMPLICIT_VR_LITTLE_ENDIAN;
use shl_dicom_core::{
    crypto::decrypt_range,
    dicom_io::parse_dicom_bytes,
    packer::IngestSession,
    range::ciphertext_range,
};

/// A small explicit VR little endian Part 10 file.
fn part10(sop: &str) -> Vec<u8> {
    fn el(b: &mut Vec<u8>, g: u16, e: u16, vr: &[u8; 2], v: &[u8]) {
        let mut v = v.to_vec();
        if v.len() % 2 == 1 {
            v.push(if vr == b"UI" { 0 } else { b' ' });
        }
        b.extend_from_slice(&g.to_le_bytes());
        b.extend_from_slice(&e.to_le_bytes());
        b.extend_from_slice(vr);
        if matches!(vr, b"OB" | b"OW") {
            b.extend_from_slice(&[0, 0]);
            b.extend_from_slice(&(v.len() as u32).to_le_bytes());
        } else {
            b.extend_from_slice(&(v.len() as u16).to_le_bytes());
        }
        b.extend_from_slice(&v);
    }
    let mut meta = Vec::new();
    el(&mut meta, 0x0002, 0x0001, b"OB", &[0, 1]);
    el(&mut meta, 0x0002, 0x0002, b"UI", b"1.2.840.10008.5.1.4.1.1.1");
    el(&mut meta, 0x0002, 0x0003, b"UI", sop.as_bytes());
    el(&mut meta, 0x0002, 0x0010, b"UI", b"1.2.840.10008.1.2.1");
    let mut b = vec![0u8; 128];
    b.extend_from_slice(b"DICM");
    el(&mut b, 0x0002, 0x0000, b"UL", &(meta.len() as u32).to_le_bytes());
    b.extend_from_slice(&meta);
    el(&mut b, 0x0008, 0x0016, b"UI", b"1.2.840.10008.5.1.4.1.1.1");
    el(&mut b, 0x0008, 0x0018, b"UI", sop.as_bytes());
    el(&mut b, 0x0008, 0x0060, b"CS", b"CR");
    el(&mut b, 0x0010, 0x0010, b"PN", b"TEST^BARE");
    el(&mut b, 0x0020, 0x000D, b"UI", b"2.25.77");
    el(&mut b, 0x0020, 0x000E, b"UI", b"2.25.77.1");
    el(&mut b, 0x0020, 0x0013, b"IS", b"1");
    el(&mut b, 0x0028, 0x0002, b"US", &1u16.to_le_bytes());
    el(&mut b, 0x0028, 0x0004, b"CS", b"MONOCHROME2");
    el(&mut b, 0x0028, 0x0010, b"US", &8u16.to_le_bytes());
    el(&mut b, 0x0028, 0x0011, b"US", &8u16.to_le_bytes());
    el(&mut b, 0x0028, 0x0100, b"US", &16u16.to_le_bytes());
    el(&mut b, 0x0028, 0x0101, b"US", &12u16.to_le_bytes());
    el(&mut b, 0x0028, 0x0102, b"US", &11u16.to_le_bytes());
    el(&mut b, 0x0028, 0x0103, b"US", &0u16.to_le_bytes());
    el(&mut b, 0x7FE0, 0x0010, b"OW", &(0..64u16).flat_map(|i| (i * 13).to_le_bytes()).collect::<Vec<_>>());
    b
}

/// The data set of a Part 10 file, without preamble or meta.
fn data_set(p10: &[u8]) -> Vec<u8> {
    let at = p10.windows(4).position(|w| w == [0x08, 0x00, 0x16, 0x00]).unwrap();
    p10[at..].to_vec()
}

/// Checks a bare file is wrapped (the data set's bytes unchanged after a new preamble and meta),
/// that the result reads as Part 10, and that it packs and decrypts to the wrapped bytes.
fn check_wrapped(name: &str, bare: Vec<u8>, ts: &str, keeps_data_set: bool) -> String {
    let p = parse_dicom_bytes(name, bare.clone()).unwrap_or_else(|e| panic!("{name}: {e}"));
    assert!(p.was_bare_wrapped, "{name}");
    assert_eq!(p.transfer_syntax_uid, ts, "{name}");
    assert_eq!(&p.bytes[128..132], b"DICM", "{name}");
    if keeps_data_set {
        assert!(p.bytes.ends_with(&bare), "{name}: the data set's bytes follow the new meta unchanged");
    }
    let again = parse_dicom_bytes(name, p.bytes.clone()).unwrap();
    assert!(!again.was_bare_wrapped);
    assert_eq!((again.sop_instance_uid.as_str(), again.study_instance_uid.as_str(), again.transfer_syntax_uid.as_str()), (p.sop_instance_uid.as_str(), p.study_instance_uid.as_str(), ts));
    OpenFileOptions::new().from_reader(Cursor::new(&p.bytes)).unwrap_or_else(|e| panic!("{name}: dicom-rs reads the whole wrapped file: {e}"));

    let mut s = IngestSession::new();
    assert!(s.ingest_dicom_bytes(name, bare).unwrap(), "{name}: {:?}", s.skipped());
    let packed = s.pack("2026-10-17T00:00:00Z").unwrap();
    let series = &packed.index.studies[0].series[0];
    let inst = &series.instances[0];
    let file = &packed.files[0];
    let key = series.file.key_bytes().unwrap();
    let r = ciphertext_range(inst.offset, inst.offset + inst.length, file.plaintext_len).unwrap();
    let got = decrypt_range(&file.ciphertext[r.ciphertext_start as usize..r.ciphertext_end as usize], inst.offset, inst.offset + inst.length, file.plaintext_len, &key).unwrap();
    assert_eq!(got, p.bytes, "{name}: the share holds the wrapped file");
    p.sop_instance_uid
}

#[test]
fn bare_explicit_and_implicit_data_sets_are_wrapped() {
    let p10 = part10("2.25.77.1.1");
    let explicit = data_set(&p10);
    assert_eq!(check_wrapped("explicit.dcm", explicit, "1.2.840.10008.1.2.1", true), "2.25.77.1.1");

    let obj = OpenFileOptions::new().from_reader(Cursor::new(&p10)).unwrap().into_inner();
    let mut implicit = Vec::new();
    obj.write_dataset_with_ts(&mut implicit, &IMPLICIT_VR_LITTLE_ENDIAN.erased()).unwrap();
    assert_eq!(check_wrapped("implicit.dcm", implicit, "1.2.840.10008.1.2", true), "2.25.77.1.1");

    // Only the preamble lost: the file meta is kept as it is.
    let no_preamble = p10[132..].to_vec();
    let p = parse_dicom_bytes("nopre.dcm", no_preamble.clone()).unwrap();
    assert!(p.was_bare_wrapped);
    assert_eq!(&p.bytes[132..], no_preamble.as_slice());
    assert_eq!(p.bytes[..132], p10[..132]);
}

/// Real files without Part 10 wrapping, from the codec corpus (`codec-corpus/formats/uncompressed/
/// samples`, generated, not committed; CODEC_CORPUS_SAMPLES overrides). Skipped when absent.
#[test]
fn real_bare_files_are_wrapped() {
    let dir = std::env::var("CODEC_CORPUS_SAMPLES").map(std::path::PathBuf::from).unwrap_or_else(|_| {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../codec-corpus/formats/uncompressed/samples")
    });
    let cases = [
        // implicit VR, starts with group 0008
        ("ext-gdcm-CR-MONO1-10-chest.dcm", "1.2.392.200036.9125.0.19950720112207", true),
        // implicit VR, starts with the private group 0003
        ("ext-gdcm-US-IRAD-NoPreambleStartWith0003.dcm", "1.2.840.113680.3.103.14954.2871468849.1240351.2", true),
        // a file meta written in implicit VR and no preamble: the meta is replaced
        ("ext-gdcm-PICKER-16-MONO2-No_DicomV3_Preamble.dcm", "2.16.840.1.113662.4.8796818069641.806071643.1320374725642836542", false),
    ];
    let mut n = 0;
    for (name, sop, keeps) in cases {
        let Ok(bare) = std::fs::read(dir.join(name)) else {
            eprintln!("skipped: {name} not in {}", dir.display());
            continue;
        };
        assert_eq!(check_wrapped(name, bare, "1.2.840.10008.1.2", keeps), sop);
        n += 1;
    }
    eprintln!("{n} real bare files checked");
    // ACR-NEMA files with no SOP Instance UID are still refused, with the reason.
    if let Ok(acr) = std::fs::read(dir.join("ext-fodicom-GH340.dcm")) {
        assert_eq!(parse_dicom_bytes("acr.dcm", acr).unwrap_err(), "no SOP Instance UID");
    }
}
