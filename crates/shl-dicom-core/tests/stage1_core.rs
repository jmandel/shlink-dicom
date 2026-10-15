use std::collections::HashMap;
use sha2::{Digest, Sha256};
use shl_dicom_core::{
    bundle::{parse_study_index, PROFILE_URL},
    crypto::{b64url_decode, decode_key_32, decrypt_range, encrypt_series},
    dicom_io::extract_dicom_from_tar_gz,
    jwe::{decrypt_bundle_jwe, encrypt_bundle_jwe},
    packer::{build_link_bundle, IngestSession},
    range::{ciphertext_length, ciphertext_range, RECORD_CIPHERTEXT, RECORD_PLAINTEXT},
    shl::{compute_shl_flag, decode_shlink_uri, encode_shlink_uri, ShlPayload},
};

fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn test_appendix_b_vector_and_f0_golden_share() {
    let series_key = decode_key_32("ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8").unwrap();
    let total: usize = 150_000;
    let plaintext: Vec<u8> = (0..total).map(|k| (k % 251) as u8).collect();

    assert_eq!(
        sha256_hex(&plaintext),
        "02675bf9284bd74223e98ceea96ebee4c9a469272ead358f462d89753f8c909b"
    );

    let ct = encrypt_series(&plaintext, &series_key).unwrap();
    assert_eq!(ct.len(), 150_048);
    assert_eq!(ct.len() as u64, ciphertext_length(total as u64));
    assert_eq!(
        sha256_hex(&ct),
        "f3205658d3fee29b343d3ba3ef20f52b3e66c2cb05974a93b65504866665fc4e"
    );

    let expected_tags = [
        "9a8421bd6740aeac5eb211cf59511b2f",
        "4cd810f700957e87ae68edc29e40caf9",
        "cf980ddc661684644fa17e5b00b08819",
    ];
    for (i, expected_tag) in expected_tags.iter().enumerate() {
        let start = i * RECORD_CIPHERTEXT as usize;
        let end = ((i + 1) * RECORD_CIPHERTEXT as usize).min(ct.len());
        let rec = &ct[start..end];
        let tag_hex: String = rec[rec.len() - 16..]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(&tag_hex, expected_tag, "record {i} tag mismatch");
    }

    // Whole-file round trip
    let whole = decrypt_range(&ct, 0, total as u64, total as u64, &series_key).unwrap();
    assert_eq!(whole, plaintext);

    // Instance 2 range read [70000, 150000)
    let r = ciphertext_range(70_000, 150_000, total as u64).unwrap();
    assert_eq!(r.first_record, 1);
    assert_eq!(r.last_record, 2);
    assert_eq!(r.ciphertext_start, 65_536);
    assert_eq!(r.ciphertext_end, 150_048);

    let inst2 = decrypt_range(
        &ct[r.ciphertext_start as usize..r.ciphertext_end as usize],
        70_000,
        150_000,
        total as u64,
        &series_key,
    )
    .unwrap();
    assert_eq!(inst2, &plaintext[70_000..150_000]);

    // Also verify F0 golden share fixtures produced by TypeScript reference
    let golden_jwe = std::fs::read_to_string("../../fixtures/golden/bundle.jwe").unwrap();
    let golden_bin = std::fs::read("../../fixtures/golden/AAECAwQFBgcICQoLDA0ODw.bin").unwrap();
    assert_eq!(golden_bin, ct);

    let shl_key = decode_key_32("QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8").unwrap();
    let bundle_bytes = decrypt_bundle_jwe(&golden_jwe, &shl_key).unwrap();
    let index = parse_study_index(&bundle_bytes).unwrap();
    assert_eq!(index.studies.len(), 1);
    assert_eq!(index.studies[0].series.len(), 1);
    assert_eq!(
        index.studies[0].series[0].file_id,
        "AAECAwQFBgcICQoLDA0ODw"
    );
    assert_eq!(index.studies[0].series[0].instances.len(), 2);
}

#[test]
fn test_range_and_record_edge_cases() {
    let key = [0x42u8; 32];

    // 1. Exact multiple of 65,520 bytes (1 and 2 records)
    for mult in [1usize, 2usize] {
        let len = (RECORD_PLAINTEXT as usize) * mult;
        let pt: Vec<u8> = (0..len).map(|i| (i % 253) as u8).collect();
        let ct = encrypt_series(&pt, &key).unwrap();
        assert_eq!(ct.len(), (RECORD_CIPHERTEXT as usize) * mult);
        let dec = decrypt_range(&ct, 0, len as u64, len as u64, &key).unwrap();
        assert_eq!(dec, pt);
    }

    // 2. Instance spanning 4+ records (250,000 bytes), boundary starts, and short final record
    let len = 250_000u64;
    let pt: Vec<u8> = (0..len as usize).map(|i| (i * 7 % 255) as u8).collect();
    let ct = encrypt_series(&pt, &key).unwrap();

    // Range starting on exact record boundary (65,520) and ending inside record 3
    let r_bound = ciphertext_range(65_520, 200_000, len).unwrap();
    assert_eq!(r_bound.first_record, 1);
    assert_eq!(r_bound.skip_prefix, 0);
    let dec_bound = decrypt_range(
        &ct[r_bound.ciphertext_start as usize..r_bound.ciphertext_end as usize],
        65_520,
        200_000,
        len,
        &key,
    )
    .unwrap();
    assert_eq!(dec_bound, &pt[65_520..200_000]);

    // Range ending at exact end of short final record
    let r_end = ciphertext_range(200_000, len, len).unwrap();
    let dec_end = decrypt_range(
        &ct[r_end.ciphertext_start as usize..r_end.ciphertext_end as usize],
        200_000,
        len,
        len,
        &key,
    )
    .unwrap();
    assert_eq!(dec_end, &pt[200_000..]);

    // 3. 0-length or inverted or out-of-bounds range rejected
    assert!(ciphertext_range(100, 100, len).is_err());
    assert!(ciphertext_range(200, 100, len).is_err());
    assert!(ciphertext_range(0, len + 1, len).is_err());
}

#[test]
fn test_tamper_and_truncation() {
    let key = decode_key_32("ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8").unwrap();
    let total = 150_000u64;
    let pt: Vec<u8> = (0..total as usize).map(|k| (k % 251) as u8).collect();
    let ct = encrypt_series(&pt, &key).unwrap();

    // Flipped bit
    let mut flipped = ct.clone();
    flipped[70_000] ^= 1;
    assert!(decrypt_range(&flipped, 0, total, total, &key).is_err());

    // Swapped record 0 and record 1
    let mut swapped = ct.clone();
    let rec_len = RECORD_CIPHERTEXT as usize;
    swapped[0..rec_len].copy_from_slice(&ct[rec_len..2 * rec_len]);
    swapped[rec_len..2 * rec_len].copy_from_slice(&ct[0..rec_len]);
    assert!(decrypt_range(&swapped, 0, total, total, &key).is_err());

    // Truncated final record
    assert!(decrypt_range(&ct[..ct.len() - 10], 0, total, total, &key).is_err());

    // Wrong key
    let wrong_key = [0x99u8; 32];
    assert!(decrypt_range(&ct, 0, total, total, &wrong_key).is_err());
}

#[test]
fn test_jwe_and_shlink_roundtrip() {
    let shl_key = [0x11u8; 32];
    let sample_json = br#"{"resourceType":"Bundle","type":"collection","entry":[]}"#;

    let jwe1 = encrypt_bundle_jwe(sample_json, &shl_key).unwrap();
    let jwe2 = encrypt_bundle_jwe(sample_json, &shl_key).unwrap();

    let parts1: Vec<&str> = jwe1.split('.').collect();
    let parts2: Vec<&str> = jwe2.split('.').collect();
    assert_eq!(parts1.len(), 5);
    assert!(parts1[1].is_empty());
    // Distinct random 12-byte IVs
    assert_ne!(parts1[2], parts2[2]);
    assert_eq!(b64url_decode(parts1[2]).unwrap().len(), 12);

    let dec1 = decrypt_bundle_jwe(&jwe1, &shl_key).unwrap();
    assert_eq!(dec1, sample_json);

    // SHL URI roundtrip
    let payload = ShlPayload {
        url: "https://host.example/shl/abc/bundle.jwe".into(),
        key: "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8".into(),
        exp: Some(1_800_000_000),
        flag: compute_shl_flag(false, true),
        label: Some("Brain MRI".into()),
        v: Some(1),
    };
    assert_eq!(payload.flag.as_deref(), Some("LU"));
    let uri = encode_shlink_uri(&payload, Some("https://viewer.example/")).unwrap();
    assert!(uri.starts_with("https://viewer.example/#shlink:/"));
    let decoded = decode_shlink_uri(&uri).unwrap();
    assert_eq!(decoded, payload);
}

/// A synthetic explicit-VR-little-endian Part 10 file (fictional patient, 2.25 UIDs) whose
/// pixel data is `rows × cols` 16-bit values seeded by `seed`.
fn synthetic_dicom(study: &str, series: &str, sop: &str, modality: &str, series_no: i32, inst_no: i32, rows: u16, cols: u16, seed: u32) -> Vec<u8> {
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
    let sop_class: &[u8] = if modality == "CT" { b"1.2.840.10008.5.1.4.1.1.2" } else { b"1.2.840.10008.5.1.4.1.1.1" };
    let mut meta = Vec::new();
    el(&mut meta, 0x0002, 0x0001, b"OB", &[0, 1]);
    el(&mut meta, 0x0002, 0x0002, b"UI", sop_class);
    el(&mut meta, 0x0002, 0x0003, b"UI", sop.as_bytes());
    el(&mut meta, 0x0002, 0x0010, b"UI", b"1.2.840.10008.1.2.1");
    let mut b = vec![0u8; 128];
    b.extend_from_slice(b"DICM");
    el(&mut b, 0x0002, 0x0000, b"UL", &(meta.len() as u32).to_le_bytes());
    b.extend_from_slice(&meta);
    el(&mut b, 0x0008, 0x0016, b"UI", sop_class);
    el(&mut b, 0x0008, 0x0018, b"UI", sop.as_bytes());
    el(&mut b, 0x0008, 0x0020, b"DA", b"20260101");
    el(&mut b, 0x0008, 0x0060, b"CS", modality.as_bytes());
    el(&mut b, 0x0008, 0x1030, b"LO", format!("Synthetic {modality}").as_bytes());
    el(&mut b, 0x0010, 0x0010, b"PN", b"TEST^SYNTHETIC");
    el(&mut b, 0x0010, 0x0020, b"LO", b"SYN0001");
    el(&mut b, 0x0020, 0x000D, b"UI", study.as_bytes());
    el(&mut b, 0x0020, 0x000E, b"UI", series.as_bytes());
    el(&mut b, 0x0020, 0x0011, b"IS", series_no.to_string().as_bytes());
    el(&mut b, 0x0020, 0x0013, b"IS", inst_no.to_string().as_bytes());
    el(&mut b, 0x0028, 0x0002, b"US", &1u16.to_le_bytes());
    el(&mut b, 0x0028, 0x0004, b"CS", b"MONOCHROME2");
    el(&mut b, 0x0028, 0x0010, b"US", &rows.to_le_bytes());
    el(&mut b, 0x0028, 0x0011, b"US", &cols.to_le_bytes());
    el(&mut b, 0x0028, 0x0100, b"US", &16u16.to_le_bytes());
    el(&mut b, 0x0028, 0x0101, b"US", &12u16.to_le_bytes());
    el(&mut b, 0x0028, 0x0102, b"US", &11u16.to_le_bytes());
    el(&mut b, 0x0028, 0x0103, b"US", &0u16.to_le_bytes());
    let px: Vec<u8> = (0..rows as u32 * cols as u32)
        .flat_map(|i| (((i.wrapping_mul(2654435761) ^ seed) >> 7) as u16 & 0x0FFF).to_le_bytes())
        .collect();
    el(&mut b, 0x7FE0, 0x0010, b"OW", &px);
    b
}

/// A two-study share built from synthetic files: a 4-slice CT given as a .tgz (each slice crosses
/// a 65,520-byte record boundary) and a CR given as a loose file. Checks that packing keeps every
/// file byte-identical, that whole-series and single-instance Range reads decrypt to the
/// originals, and that a link Bundle can carry a subset.
#[test]
fn test_pack_and_lossless_roundtrip() {
    let ct_study = "2.25.1001";
    let ct_series = "2.25.1001.1";
    let ct_files: Vec<(String, Vec<u8>)> = (0..4)
        .map(|k| {
            let sop = format!("2.25.1001.1.{}", k + 1);
            (format!("CT/{k}.dcm"), synthetic_dicom(ct_study, ct_series, &sop, "CT", 1, k + 1, 256, 200, k as u32 * 7919))
        })
        .collect();
    let cr = synthetic_dicom("2.25.2002", "2.25.2002.1", "2.25.2002.1.1", "CR", 1, 1, 512, 400, 42);

    let mut tgz = Vec::new();
    {
        let gz = flate2::write::GzEncoder::new(&mut tgz, flate2::Compression::fast());
        let mut tar = tar::Builder::new(gz);
        for (name, bytes) in &ct_files {
            let mut h = tar::Header::new_gnu();
            h.set_size(bytes.len() as u64);
            h.set_mode(0o644);
            h.set_cksum();
            tar.append_data(&mut h, name, bytes.as_slice()).unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap();
    }

    let mut original_hashes: HashMap<String, String> = HashMap::new();
    for (k, (_, bytes)) in ct_files.iter().enumerate() {
        original_hashes.insert(format!("2.25.1001.1.{}", k + 1), sha256_hex(bytes));
    }
    original_hashes.insert("2.25.2002.1.1".into(), sha256_hex(&cr));
    for inst in extract_dicom_from_tar_gz(&tgz).unwrap() {
        assert_eq!(sha256_hex(&inst.bytes), original_hashes[&inst.sop_instance_uid]);
    }

    let mut session = IngestSession::new();
    assert_eq!(session.ingest_tar_gz(&tgz).unwrap(), 4);
    assert!(session.ingest_dicom_bytes("cr.dcm", cr.clone()).unwrap());
    let packed = session.pack("2026-10-14T16:00:00Z").unwrap();
    assert_eq!(packed.index.studies.len(), 2);

    let raw_bundle: serde_json::Value = serde_json::from_str(&packed.owner_bundle_json).unwrap();
    let imaging_studies: Vec<&serde_json::Value> = raw_bundle["entry"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| &e["resource"])
        .filter(|r| r["resourceType"] == "ImagingStudy")
        .collect();
    assert_eq!(imaging_studies.len(), 2);
    for st in &imaging_studies {
        assert_eq!(st["meta"]["profile"][0], PROFILE_URL);
    }

    let file_map: HashMap<String, &[u8]> = packed
        .series_files
        .iter()
        .map(|f| (f.file_id.clone(), f.ciphertext.as_slice()))
        .collect();

    let mut verified_instances = 0usize;
    for study in &packed.index.studies {
        for series in &study.series {
            let ct = file_map.get(&series.file_id).expect("series file present");
            assert_eq!(ct.len() as u64, ciphertext_length(series.plaintext_length));
            let series_key = series.key_bytes().unwrap();

            // Whole series: decrypt, then cut at the Bundle's instance offsets.
            let series_pt = decrypt_range(ct, 0, series.plaintext_length, series.plaintext_length, &series_key).unwrap();
            for inst in &series.instances {
                let bytes = &series_pt[inst.offset as usize..(inst.offset + inst.length) as usize];
                assert_eq!(&sha256_hex(bytes), &original_hashes[&inst.uid]);
                verified_instances += 1;
            }

            // One instance: the Range read §9.3 plans.
            for inst in &series.instances {
                let r = ciphertext_range(inst.offset, inst.offset + inst.length, series.plaintext_length).unwrap();
                let dcm = decrypt_range(
                    &ct[r.ciphertext_start as usize..r.ciphertext_end as usize],
                    inst.offset,
                    inst.offset + inst.length,
                    series.plaintext_length,
                    &series_key,
                )
                .unwrap();
                assert_eq!(&sha256_hex(&dcm), &original_hashes[&inst.uid]);
            }
        }
    }
    assert_eq!(verified_instances, original_hashes.len());

    // A link Bundle with one series.
    let first_file_id = packed.index.studies[0].series[0].file_id.clone();
    let link_shl_key = [0x55u8; 32];
    let link_out = build_link_bundle(&packed.owner_bundle_json, &[first_file_id.clone()], &link_shl_key, "2026-10-14T16:05:00Z").unwrap();
    assert_eq!(link_out.allowed_files, vec![format!("{first_file_id}.bin")]);
    let dec_link_bundle = decrypt_bundle_jwe(&link_out.bundle_jwe, &link_shl_key).unwrap();
    let link_index = parse_study_index(&dec_link_bundle).unwrap();
    assert_eq!(link_index.studies.len(), 1);
    assert_eq!(link_index.studies[0].series.len(), 1);
}
