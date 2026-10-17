//! The server's background work and the seed, run as the deployment runs them.
use shl_dicom_server::state::AppState;

mod common;
use common::part10;

fn temp_dir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("shl_bg_{name}_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// A round of the background loop removes expired capability URLs and expired shares.
#[tokio::test]
async fn a_gc_round_removes_expired_caps_and_shares() {
    let dir = temp_dir("gc");
    let state = AppState::new(&dir).unwrap();
    let (sid, _) = state.create_share(false, None).unwrap();
    let lid = "g".repeat(43);
    state.register_link_in_catalog(&sid, &lid).unwrap();
    // A capability URL that lives a second, then expires.
    let cap = state.mint_cap(&lid, 1).unwrap();
    let (expired, _) = state.create_share(false, None).unwrap();
    state.set_share_expiry(&expired, 1).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(2100));
    assert!(state.lookup_cap(&cap).is_none());

    state.gc_round(0).await;
    assert!(!state.share_db_path(&expired).exists(), "the expired share's file is gone");
    let count = |sql: &str| -> i64 {
        rusqlite::Connection::open(dir.join("catalog.db")).unwrap().query_row(sql, [], |r| r.get(0)).unwrap()
    };
    assert_eq!(count(&format!("SELECT COUNT(*) FROM shares WHERE sid = '{expired}'")), 0, "the expired share's row is gone");
    assert_eq!(count("SELECT COUNT(*) FROM caps"), 0, "the expired cap is gone");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Seeding again (as the bootstrap does while the server serves the current sample) leaves the
/// current sample in place; the server retires it once it has loaded the new one.
#[tokio::test(flavor = "multi_thread")]
async fn seeding_again_keeps_the_served_sample_until_the_server_loads_the_new_one() {
    let dir = temp_dir("reseed");
    let samples = dir.join("samples");
    std::fs::create_dir_all(&samples).unwrap();
    let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
    let dcm = part10("2.25.88.1.1");
    let mut h = tar::Header::new_gnu();
    h.set_size(dcm.len() as u64);
    h.set_mode(0o644);
    h.set_cksum();
    tar.append_data(&mut h, "a.dcm", dcm.as_slice()).unwrap();
    std::fs::write(samples.join("a.tgz"), tar.into_inner().unwrap().finish().unwrap()).unwrap();

    let server = AppState::new(&dir).unwrap();
    let first = shl_dicom_server::seed::seed_sample(&server, false).unwrap().sid;
    assert!(shl_dicom_server::seed::load_sample(&server, "http://localhost"));

    // The seed runs in its own process, alongside the server.
    let seed = AppState::alongside_server(&dir, Default::default(), server.store.clone()).unwrap();
    let second = shl_dicom_server::seed::seed_sample(&seed, false).unwrap().sid;
    assert_ne!(first, second);
    assert!(server.catalog_has_share(&first), "the seed deleted the sample the server still serves");

    // The server restarts and loads the new sample: now the old one goes.
    assert!(shl_dicom_server::seed::load_sample(&server, "http://localhost"));
    assert!(!server.catalog_has_share(&first));
    assert!(server.catalog_has_share(&second));
    let _ = std::fs::remove_dir_all(&dir);
}
