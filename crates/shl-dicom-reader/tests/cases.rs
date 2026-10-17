//! fixtures/reader/cases.json, the golden cases test/reader.test.ts also runs against the wasm.
use serde_json::Value;
use sha2::{Digest, Sha256};
use shl_dicom_reader::{read_bundle, read_index, read_link_value};

#[test]
fn golden_cases() {
    let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string("../../fixtures/reader/cases.json").unwrap()).unwrap();
    let mut failed = Vec::new();
    for c in &cases {
        let s = |k: &str| c[k].as_str().unwrap_or_default();
        let got: Result<Value, shl_dicom_core::ReadError> = match s("fn") {
            "parse_link" => read_link_value(s("text"), c["now"].as_f64().unwrap()),
            "manifest_location" => shl_dicom_core::shl::manifest_location(s("manifest").as_bytes()).map(Value::from),
            "decrypt_bundle" => read_bundle(s("jwe"), s("key")).map(|b| Value::from(Sha256::digest(&b).iter().map(|x| format!("{x:02x}")).collect::<String>())),
            "parse_index" => read_index(s("bundle").as_bytes()).map(|j| serde_json::from_str(&j).unwrap()),
            other => panic!("unknown fn {other}"),
        };
        let e = &c["expect"];
        let ok = match (&got, e.get("error"), e.get("ok").or(e.get("okSha256"))) {
            (Err(err), Some(code), _) => code == err.code,
            (Ok(v), None, Some(want)) => v == want,
            _ => false,
        };
        if !ok {
            failed.push(format!("{} {}: got {:?}", s("fn"), s("name"), got.map(|v| v.to_string())));
        }
    }
    assert!(failed.is_empty(), "{} of {} cases fail:\n{}", failed.len(), cases.len(), failed.join("\n"));
}

#[test]
fn frame_starts_follow_the_packer_rule() {
    use shl_dicom_reader::{has_frame_start_marker, is_frame_start};
    let jpeg = "1.2.840.10008.1.2.4.50";
    let j2k = "1.2.840.10008.1.2.4.90";
    let jxl = "1.2.840.10008.1.2.4.112";
    let rle = "1.2.840.10008.1.2.5";
    assert!(is_frame_start(jpeg, &[0xFF, 0xD8, 0xFF, 0xE0]) && !is_frame_start(jpeg, &[0x11, 0x22]));
    assert!(is_frame_start(j2k, &[0xFF, 0x4F, 0xFF, 0x51]) && is_frame_start(j2k, b"\0\0\0\x0CjP  "));
    assert!(!is_frame_start(j2k, b"\0\0\0\x0CJXL "));
    assert!(is_frame_start(jxl, &[0xFF, 0x0A, 0x00]) && is_frame_start(jxl, b"\0\0\0\x0CJXL ") && !is_frame_start(jxl, &[0xFF, 0xD8]));
    assert!(has_frame_start_marker(jxl) && !has_frame_start_marker(rle) && is_frame_start(rle, &[1, 2, 3]));
}
