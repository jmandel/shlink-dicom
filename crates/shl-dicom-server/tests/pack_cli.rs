//! `pack` puts what is hosted under a random 256-bit folder name.
use shl_dicom_core::crypto::{b64url_decode, b64url_encode};
use shl_dicom_server::cli::{pack_link_url, run_pack_cli};

mod common;
use common::part10;

fn folders(out: &std::path::Path) -> Vec<String> {
    std::fs::read_dir(out).unwrap().flatten().filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().into_owned()).collect()
}

#[test]
fn pack_hosts_its_files_under_a_256_bit_folder() {
    let dir = std::env::temp_dir().join(format!("pack_segment_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let input = dir.join("a.dcm");
    std::fs::write(&input, part10("2.25.88.1.1")).unwrap();

    let out1 = dir.join("out1");
    run_pack_cli(std::slice::from_ref(&input), &out1, Some("https://host.example/x/"), None, false, None).unwrap();
    let f1 = folders(&out1);
    assert_eq!(f1.len(), 1);
    assert_eq!(b64url_decode(&f1[0]).unwrap().len(), 32, "{}", f1[0]);
    let hosted: Vec<String> = std::fs::read_dir(out1.join(&f1[0])).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert!(hosted.contains(&"bundle.jwe".to_string()) && hosted.iter().any(|n| n.ends_with(".bin")), "{hosted:?}");
    assert!(!hosted.contains(&"bundle.json".to_string()), "the plaintext Bundle is not in the hosted folder");
    assert!(out1.join("bundle.json").exists());

    // Another pack, another folder.
    let out2 = dir.join("out2");
    run_pack_cli(std::slice::from_ref(&input), &out2, None, None, false, None).unwrap();
    assert_ne!(folders(&out2)[0], f1[0]);

    // --keys with a segment keeps it (an update in place).
    let segment = b64url_encode(&[9u8; 32]);
    let keys = dir.join("keys.json");
    std::fs::write(
        &keys,
        serde_json::json!({
            "shlKey": b64url_encode(&[1u8; 32]), "bundleIv": b64url_encode(&[2u8; 12]), "lastUpdated": "2026-10-17T00:00:00Z",
            "studies": { "2.25.88": { "fileId": b64url_encode(&[3u8; 16]), "key": b64url_encode(&[4u8; 32]) } },
            "segment": segment,
        })
        .to_string(),
    )
    .unwrap();
    let out3 = dir.join("out3");
    run_pack_cli(std::slice::from_ref(&input), &out3, None, None, false, Some(&keys)).unwrap();
    assert_eq!(folders(&out3), vec![segment.clone()]);
    // A short segment is refused.
    std::fs::write(&keys, std::fs::read_to_string(&keys).unwrap().replace(&segment, &b64url_encode(&[9u8; 16]))).unwrap();
    assert!(run_pack_cli(&[input], &dir.join("out4"), None, None, false, Some(&keys)).is_err());

    assert_eq!(pack_link_url("https://h.example/x", &segment).unwrap(), format!("https://h.example/x/{segment}/bundle.jwe"));
    assert!(pack_link_url("https://h.example/x/bundle.jwe", &segment).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}
