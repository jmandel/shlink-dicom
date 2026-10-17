//! `pack --keys`: the recorded Bundle and plaintext hashes are filled in on the first pack, the
//! same input packs again under the same keys, and changed input is refused before anything is
//! written (a key and nonce must never encrypt different content).
#[path = "../../../codecs/shl-dicom-decode/tests/support/ds.rs"]
mod ds;

use ds::{part10_meta, Ds, Enc};
use shl_dicom_server::cli::run_pack_cli;

const STUDY: &str = "2.25.4242";
/// The link's folder (pack hosts the output in OUT/<segment>/).
const SEGMENT: &str = "YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8";

/// A one-instance CT whose pixels depend on `seed`.
fn ct(seed: u8) -> Vec<u8> {
    let class = "1.2.840.10008.5.1.4.1.1.2";
    let mut d = Ds::new(Enc::ExplicitLe);
    d.ui(0x0008, 0x0016, class).ui(0x0008, 0x0018, "2.25.4242.1.1").text(0x0008, 0x0060, b"CS", "CT");
    d.ui(0x0020, 0x000D, STUDY).ui(0x0020, 0x000E, "2.25.4242.1").text(0x0020, 0x0013, b"IS", "1");
    d.image(1, "MONOCHROME2", None, None, 4, 4, 8, 8, 0);
    d.elem(0x7FE0, 0x0010, b"OW", &[seed; 16]);
    part10_meta("1.2.840.10008.1.2.1", &[(0x0002, class), (0x0003, "2.25.4242.1.1")], &d.out, true)
}

#[test]
fn pack_keys_records_hashes_and_refuses_changed_input() {
    let dir = std::env::temp_dir().join(format!("shl-pack-keys-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("in")).unwrap();
    let input = dir.join("in/ct.dcm");
    std::fs::write(&input, ct(1)).unwrap();
    let keys = dir.join("keys.json");
    std::fs::write(
        &keys,
        serde_json::json!({
            "shlKey": "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8",
            "bundleIv": "AQIDBAUGBwgJCgsM",
            "lastUpdated": "2026-10-17T00:00:00Z",
            "segment": SEGMENT,
            "studies": { STUDY: { "fileId": "AAECAwQFBgcICQoLDA0ODw", "key": "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8" } },
        })
        .to_string(),
    )
    .unwrap();
    let pack = |out: &str| run_pack_cli(&[dir.join("in")], &dir.join(out), None, None, false, Some(&keys), false);

    pack("a").unwrap();
    let recorded: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&keys).unwrap()).unwrap();
    assert_eq!(recorded["bundleSha256"].as_str().unwrap().len(), 64);
    assert_eq!(recorded["studies"][STUDY]["plaintextSha256"].as_str().unwrap().len(), 64);

    // The same input: the same files.
    pack("b").unwrap();
    for f in ["bundle.jwe", "AAECAwQFBgcICQoLDA0ODw.bin"] {
        let read = |out: &str| std::fs::read(dir.join(out).join(SEGMENT).join(f)).unwrap();
        assert_eq!(read("a"), read("b"), "{f}");
    }

    // Changed pixels under the same keys: refused, and nothing written.
    std::fs::write(&input, ct(2)).unwrap();
    let err = pack("c").unwrap_err();
    assert!(err.contains("the input changed"), "{err}");
    assert!(!dir.join("c").exists());
    std::fs::remove_dir_all(&dir).unwrap();
}
