use std::collections::HashMap;
use sha2::{Digest, Sha256};
use shl_dicom_core::{
    bundle::{parse_study_index, PROFILE_URL},
    crypto::{b64url_decode, decode_key_32, decrypt_range, encrypt_series},
    dicom_io::{decode_dicom_slice, extract_dicom_from_tar_gz},
    export::{build_uncompressed_zip, split_series_instances},
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

#[test]
fn test_pack_and_lossless_roundtrip_mri_and_wrist() {
    let mri_tgz = std::fs::read("../../data/samples/mri-brain-2020.tgz")
        .expect("data/samples/mri-brain-2020.tgz must exist");
    let wrist_tgz = std::fs::read("../../data/samples/wrist-low-res.tgz")
        .expect("data/samples/wrist-low-res.tgz must exist");

    // Collect ground-truth SHA-256 of every original Part 10 DICOM instance by SOPInstanceUID
    let mut original_hashes: HashMap<String, String> = HashMap::new();
    for inst in extract_dicom_from_tar_gz(&mri_tgz).unwrap() {
        original_hashes.insert(inst.sop_instance_uid, sha256_hex(&inst.bytes));
    }
    for inst in extract_dicom_from_tar_gz(&wrist_tgz).unwrap() {
        original_hashes.insert(inst.sop_instance_uid, sha256_hex(&inst.bytes));
    }
    assert!(original_hashes.len() > 100);

    // Ingest both archives into a single multi-study Share
    let mut session = IngestSession::new();
    let mri_count = session.ingest_tar_gz(&mri_tgz).unwrap();
    let wrist_count = session.ingest_tar_gz(&wrist_tgz).unwrap();
    assert!(mri_count > 100);
    assert_eq!(wrist_count, 3);

    let packed = session.pack("2026-10-14T16:00:00Z").unwrap();
    assert_eq!(packed.index.studies.len(), 2, "expected 2 studies (Brain MRI + Wrist)");

    // Verify FHIR Bundle JSON declares the profile on both ImagingStudy resources
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

    // Map fileId -> ciphertext
    let file_map: HashMap<String, &[u8]> = packed
        .series_files
        .iter()
        .map(|f| (f.file_id.clone(), f.ciphertext.as_slice()))
        .collect();

    let mut verified_instances = 0usize;

    for study in &packed.index.studies {
        for series in &study.series {
            let ct = file_map.get(&series.file_id).expect("series file present");
            let series_key = series.key_bytes().unwrap();

            // 1. Whole-series decrypt + split_series_instances round-trip check
            let series_pt = decrypt_range(
                ct,
                0,
                series.plaintext_length,
                series.plaintext_length,
                &series_key,
            )
            .unwrap();
            let split = split_series_instances(&series_pt, series).unwrap();
            assert_eq!(split.len(), series.instances.len());

            for ((_name, dcm_bytes), inst_summary) in split.iter().zip(series.instances.iter()) {
                let expected_hash = original_hashes
                    .get(&inst_summary.uid)
                    .expect("SOPInstanceUID found in ground truth");
                assert_eq!(&sha256_hex(dcm_bytes), expected_hash);
                verified_instances += 1;
            }

            // 2. Single-instance Range read + pixel decode on the middle instance of each series
            let mid_idx = series.instances.len() / 2;
            let mid_inst = &series.instances[mid_idx];
            let r = ciphertext_range(
                mid_inst.offset,
                mid_inst.offset + mid_inst.length,
                series.plaintext_length,
            )
            .unwrap();
            let mid_dcm = decrypt_range(
                &ct[r.ciphertext_start as usize..r.ciphertext_end as usize],
                mid_inst.offset,
                mid_inst.offset + mid_inst.length,
                series.plaintext_length,
                &series_key,
            )
            .unwrap();
            assert_eq!(
                &sha256_hex(&mid_dcm),
                original_hashes.get(&mid_inst.uid).unwrap()
            );

            // Verify pixel decoding produces valid RGBA8 pixels
            let decoded = decode_dicom_slice(&mid_dcm, None, None).unwrap();
            assert!(decoded.width > 0 && decoded.height > 0);
            assert_eq!(
                decoded.rgba.len(),
                (decoded.width * decoded.height * 4) as usize
            );
        }
    }

    assert_eq!(verified_instances, original_hashes.len());

    // 3. Test build_link_bundle subsetting (only first series of first study)
    let first_file_id = packed.index.studies[0].series[0].file_id.clone();
    let link_shl_key = [0x55u8; 32];
    let link_out = build_link_bundle(
        &packed.owner_bundle_json,
        &[first_file_id.clone()],
        &link_shl_key,
        "2026-10-14T16:05:00Z",
    )
    .unwrap();
    assert_eq!(link_out.allowed_files, vec![format!("{first_file_id}.bin")]);
    let dec_link_bundle = decrypt_bundle_jwe(&link_out.bundle_jwe, &link_shl_key).unwrap();
    let link_index = parse_study_index(&dec_link_bundle).unwrap();
    assert_eq!(link_index.studies.len(), 1);
    assert_eq!(link_index.studies[0].series.len(), 1);

    // 4. Test uncompressed ZIP export on the Wrist series
    let wrist_study = packed
        .index
        .studies
        .iter()
        .find(|s| s.number_of_instances == 3)
        .unwrap();
    let wrist_series = &wrist_study.series[0];
    let wrist_ct = file_map.get(&wrist_series.file_id).unwrap();
    let wrist_pt = decrypt_range(
        wrist_ct,
        0,
        wrist_series.plaintext_length,
        wrist_series.plaintext_length,
        &wrist_series.key_bytes().unwrap(),
    )
    .unwrap();
    let wrist_files = split_series_instances(&wrist_pt, wrist_series).unwrap();
    let zip_bytes = build_uncompressed_zip(&wrist_files).unwrap();
    assert!(zip_bytes.len() > wrist_pt.len());
}

#[test]
fn test_jpeg12_against_dcmtk_dcmdjpeg() {
    let wrist_tgz = std::fs::read("../../data/samples/wrist-low-res.tgz").unwrap();
    let wrist_instances = extract_dicom_from_tar_gz(&wrist_tgz).unwrap();
    assert_eq!(wrist_instances.len(), 3);

    for (idx, inst) in wrist_instances.iter().enumerate() {
        let tmp_in = std::env::temp_dir().join(format!("shl_dicom_wrist_in_{idx}.dcm"));
        let tmp_out = std::env::temp_dir().join(format!("shl_dicom_wrist_out_{idx}.dcm"));
        std::fs::write(&tmp_in, &inst.bytes).unwrap();

        let status = std::process::Command::new("dcmdjpeg")
            .arg(&tmp_in)
            .arg(&tmp_out)
            .status()
            .expect("dcmdjpeg must run");
        assert!(status.success(), "dcmdjpeg failed on {}", inst.source_name);

        let dcmtk_uncompressed_bytes = std::fs::read(&tmp_out).unwrap();
        let _ = std::fs::remove_file(&tmp_in);
        let _ = std::fs::remove_file(&tmp_out);

        // Decode with our pure-Rust 12-bit JPEG decoder vs DCMTK's uncompressed output
        let ours = decode_dicom_slice(&inst.bytes, None, None).unwrap();
        let truth = decode_dicom_slice(&dcmtk_uncompressed_bytes, None, None).unwrap();

        assert_eq!(ours.width, truth.width);
        assert_eq!(ours.height, truth.height);
        assert_eq!(ours.rgba.len(), truth.rgba.len());

        // Compare every pixel's 8-bit windowed grayscale value (R channel)
        let num_pixels = (ours.width * ours.height) as usize;
        let mut total_diff = 0u64;
        let mut max_diff = 0u8;
        for px in 0..num_pixels {
            let a = ours.rgba[px * 4];
            let b = truth.rgba[px * 4];
            let diff = a.abs_diff(b);
            total_diff += diff as u64;
            max_diff = max_diff.max(diff);
        }
        let mad = total_diff as f64 / num_pixels as f64;
        println!(
            "{}: {}x{}, min={}..max={} (truth {}..{}), MAD={:.4}, max_diff={}",
            inst.source_name,
            ours.width,
            ours.height,
            ours.min_pixel,
            ours.max_pixel,
            truth.min_pixel,
            truth.max_pixel,
            mad,
            max_diff
        );
        // IDCT float vs integer rounding across 12-bit -> 8-bit windowing should have MAD < 0.2 and max_diff <= 1
        assert!(mad < 0.2, "MAD too high: {mad}");
        assert!(max_diff <= 1, "max_diff too high: {max_diff}");
    }
}
