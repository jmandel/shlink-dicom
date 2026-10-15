use std::sync::Arc;
use axum::http::{header, StatusCode};
use rusqlite::params;
use serde_json::{json, Value};
use shl_dicom_core::{
    crypto::{b64url_encode, decode_key_32, decrypt_range, encrypt_series, random_bytes},
    jwe::encrypt_bundle_jwe,
    range::ciphertext_range,
};
use shl_dicom_server::{build_app_router, state::AppState};
use tokio::net::TcpListener;

async fn spawn_test_server(state: AppState) -> String {
    let app = build_app_router(state);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

fn temp_data_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "shl_dicom_test_{}_{}",
        name,
        b64url_encode(&random_bytes::<6>().unwrap())
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test]
async fn test_zero_knowledge_upload_and_u_mode_range() {
    let dir = temp_data_dir("u_mode_range");
    let state = AppState::new(&dir).unwrap();
    let base = spawn_test_server(state).await;
    let client = reqwest::Client::new();

    // 1. Create share
    let create_resp: Value = client
        .post(format!("{base}/api/shares"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let sid = create_resp["share"]["id"].as_str().unwrap().to_string();
    let token = create_resp["controlToken"].as_str().unwrap().to_string();

    // Load F0 golden share fixtures
    let golden_jwe = std::fs::read_to_string("../../fixtures/golden/bundle.jwe").unwrap();
    let golden_bin = std::fs::read("../../fixtures/golden/AAECAwQFBgcICQoLDA0ODw.bin").unwrap();
    let file_id = "AAECAwQFBgcICQoLDA0ODw";

    // Upload owner.jwe and verify GET owner.jwe
    let put_owner = client
        .put(format!("{base}/api/shares/{sid}/owner.jwe"))
        .bearer_auth(&token)
        .body(golden_jwe.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(put_owner.status(), StatusCode::OK);

    let get_owner = client
        .get(format!("{base}/api/shares/{sid}/owner.jwe"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(get_owner.status(), StatusCode::OK);
    assert_eq!(get_owner.text().await.unwrap(), golden_jwe);

    // Upload golden .bin with matching X-Expected-Size
    let put_bin = client
        .put(format!("{base}/api/shares/{sid}/files/{file_id}.bin"))
        .bearer_auth(&token)
        .header("X-Expected-Size", golden_bin.len().to_string())
        .body(golden_bin.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(put_bin.status(), StatusCode::OK);

    // Create U-mode Link
    let link_resp: Value = client
        .post(format!("{base}/api/shares/{sid}/links"))
        .bearer_auth(&token)
        .json(&json!({
            "label": "Golden U-Mode",
            "allowedFiles": [format!("{file_id}.bin")]
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let lid = link_resp["id"].as_str().unwrap().to_string();
    assert_eq!(link_resp["flag"], "U");

    // Upload link bundle.jwe
    let put_bundle = client
        .put(format!("{base}/api/shares/{sid}/links/{lid}/bundle.jwe"))
        .bearer_auth(&token)
        .body(golden_jwe.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(put_bundle.status(), StatusCode::OK);

    // Fetch bundle.jwe via U-mode and check ETag + 304 Not Modified
    let get_b1 = client
        .get(format!("{base}/shl/{lid}/bundle.jwe?recipient=DrSmith"))
        .send()
        .await
        .unwrap();
    assert_eq!(get_b1.status(), StatusCode::OK);
    let etag = get_b1
        .headers()
        .get(header::ETAG)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert_eq!(get_b1.text().await.unwrap(), golden_jwe);

    let get_b2 = client
        .get(format!("{base}/shl/{lid}/bundle.jwe"))
        .header(header::IF_NONE_MATCH, &etag)
        .send()
        .await
        .unwrap();
    assert_eq!(get_b2.status(), StatusCode::NOT_MODIFIED);

    // Range read 1: Instance 2 ([70000, 150000) -> records 1..2, ciphertext bytes 65536..150048)
    let r = ciphertext_range(70_000, 150_000, 150_000).unwrap();
    let range_resp = client
        .get(format!("{base}/shl/{lid}/{file_id}.bin?recipient=DrSmith"))
        .header(header::RANGE, r.http_range_header())
        .header(header::ACCEPT_ENCODING, "gzip, br")
        .send()
        .await
        .unwrap();
    assert_eq!(range_resp.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        range_resp.headers().get(header::CONTENT_RANGE).unwrap(),
        "bytes 65536-150047/150048"
    );
    assert_eq!(
        range_resp
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .unwrap(),
        "*"
    );
    // Must NEVER carry Content-Encoding even when Accept-Encoding: gzip, br was sent
    assert!(range_resp.headers().get(header::CONTENT_ENCODING).is_none());

    let ct_slice = range_resp.bytes().await.unwrap();
    assert_eq!(ct_slice.len(), 150_048 - 65_536);
    let series_key = decode_key_32("ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8").unwrap();
    let inst2 = decrypt_range(&ct_slice, 70_000, 150_000, 150_000, &series_key).unwrap();
    let expected_inst2: Vec<u8> = (70_000..150_000).map(|k| (k % 251) as u8).collect();
    assert_eq!(inst2, expected_inst2);

    // Range read 2: First record only (bytes=0-65535)
    let r0_resp = client
        .get(format!("{base}/shl/{lid}/{file_id}.bin"))
        .header(header::RANGE, "bytes=0-65535")
        .send()
        .await
        .unwrap();
    assert_eq!(r0_resp.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        r0_resp.headers().get(header::CONTENT_RANGE).unwrap(),
        "bytes 0-65535/150048"
    );
    assert_eq!(r0_resp.bytes().await.unwrap().len(), 65_536);

    // Range read 3: Multi-range header rejected with 416
    let multi_resp = client
        .get(format!("{base}/shl/{lid}/{file_id}.bin"))
        .header(header::RANGE, "bytes=0-100, 200-300")
        .send()
        .await
        .unwrap();
    assert_eq!(multi_resp.status(), StatusCode::RANGE_NOT_SATISFIABLE);

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn test_size_quotas_and_409_foreign_key() {
    let dir = temp_data_dir("quotas_409");
    // Set small quota of 200 KB max
    let state = AppState::with_quotas(
        &dir,
        shl_dicom_server::state::Quotas { share_bytes: Some(200_000), share_files: Some(256), shares: Some(64), request_bytes: 64 << 20, cap_ttl_secs: 3600 },
    )
    .unwrap();
    let base = spawn_test_server(state).await;
    let client = reqwest::Client::new();

    let create_resp: Value = client
        .post(format!("{base}/api/shares"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let sid = create_resp["share"]["id"].as_str().unwrap().to_string();
    let token = create_resp["controlToken"].as_str().unwrap().to_string();

    let fid1 = b64url_encode(&[1u8; 16]);
    let fid2 = b64url_encode(&[2u8; 16]);
    let body_100k = vec![0xAAu8; 100_000];

    // 1. X-Expected-Size mismatch rejected with 400 and leaves no row
    let bad_sz = client
        .put(format!("{base}/api/shares/{sid}/files/{fid1}.bin"))
        .bearer_auth(&token)
        .header("X-Expected-Size", "99999")
        .body(body_100k.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(bad_sz.status(), StatusCode::BAD_REQUEST);

    // 2. Valid 100 KB upload succeeds
    let ok_up = client
        .put(format!("{base}/api/shares/{sid}/files/{fid1}.bin"))
        .bearer_auth(&token)
        .header("X-Expected-Size", "100000")
        .body(body_100k.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(ok_up.status(), StatusCode::OK);

    // 3. Second upload of 120 KB exceeds 200 KB quota -> 413 Payload Too Large & rolled back
    let over_quota = client
        .put(format!("{base}/api/shares/{sid}/files/{fid2}.bin"))
        .bearer_auth(&token)
        .body(vec![0xBBu8; 120_000])
        .send()
        .await
        .unwrap();
    assert_eq!(over_quota.status(), StatusCode::PAYLOAD_TOO_LARGE);

    let share_info: Value = client
        .get(format!("{base}/api/shares/{sid}"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(share_info["files"].as_array().unwrap().len(), 1);

    // 4. Create link referencing fid1.bin, then try deleting fid1.bin -> 409 Conflict!
    let link_resp: Value = client
        .post(format!("{base}/api/shares/{sid}/links"))
        .bearer_auth(&token)
        .json(&json!({ "allowedFiles": [format!("{fid1}.bin")] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let lid = link_resp["id"].as_str().unwrap().to_string();

    let del_conflict = client
        .delete(format!("{base}/api/shares/{sid}/files/{fid1}.bin"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(del_conflict.status(), StatusCode::CONFLICT);

    // Narrow allowedFiles on the link to [], then deleting fid1.bin succeeds with 204!
    let patch_ok = client
        .patch(format!("{base}/api/shares/{sid}/links/{lid}"))
        .bearer_auth(&token)
        .json(&json!({ "allowedFiles": [] }))
        .send()
        .await
        .unwrap();
    assert_eq!(patch_ok.status(), StatusCode::OK);

    let del_ok = client
        .delete(format!("{base}/api/shares/{sid}/files/{fid1}.bin"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(del_ok.status(), StatusCode::NO_CONTENT);

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn test_passcode_attempt_limit_and_concurrency() {
    let dir = temp_data_dir("passcode_concurrency");
    let state = AppState::new(&dir).unwrap();
    let base = spawn_test_server(state).await;
    let client = Arc::new(reqwest::Client::new());

    let create_resp: Value = client
        .post(format!("{base}/api/shares"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let sid = create_resp["share"]["id"].as_str().unwrap().to_string();
    let token = create_resp["controlToken"].as_str().unwrap().to_string();

    let link_resp: Value = client
        .post(format!("{base}/api/shares/{sid}/links"))
        .bearer_auth(&token)
        .json(&json!({
            "passcode": "correct-horse",
            "allowedFiles": []
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let lid = link_resp["id"].as_str().unwrap().to_string();

    client
        .put(format!("{base}/api/shares/{sid}/links/{lid}/bundle.jwe"))
        .bearer_auth(&token)
        .body("dummy..iv.ct.tag")
        .send()
        .await
        .unwrap();

    // Fire 10 concurrent wrong passcode attempts against the 5-attempt limit
    let mut handles = Vec::new();
    for _ in 0..10 {
        let c = client.clone();
        let url = format!("{base}/shl/{lid}");
        handles.push(tokio::spawn(async move {
            c.post(&url)
                .json(&json!({ "passcode": "wrong-guess" }))
                .send()
                .await
                .unwrap()
                .status()
        }));
    }

    let mut count_401 = 0;
    let mut count_404 = 0;
    for h in handles {
        match h.await.unwrap() {
            StatusCode::UNAUTHORIZED => count_401 += 1,
            StatusCode::NOT_FOUND => count_404 += 1,
            other => panic!("unexpected status: {other}"),
        }
    }
    assert_eq!(count_401, 5, "exactly 5 attempts must return 401");
    assert_eq!(count_404, 5, "remaining 5 concurrent attempts must return 404");

    // Subsequent attempt with the CORRECT passcode must also return 404!
    let after_exhausted = client
        .post(format!("{base}/shl/{lid}"))
        .json(&json!({ "passcode": "correct-horse" }))
        .send()
        .await
        .unwrap();
    assert_eq!(after_exhausted.status(), StatusCode::NOT_FOUND);

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn test_multiple_links_subset_scoping_and_orphan_sweep() {
    let dir = temp_data_dir("multi_links_sweep");
    let state = AppState::new(&dir).unwrap();
    let base = spawn_test_server(state.clone()).await;
    let client = reqwest::Client::new();

    let create_resp: Value = client
        .post(format!("{base}/api/shares"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let sid = create_resp["share"]["id"].as_str().unwrap().to_string();
    let token = create_resp["controlToken"].as_str().unwrap().to_string();

    let fid1 = b64url_encode(&[10u8; 16]);
    let fid2 = b64url_encode(&[20u8; 16]);
    let ct1 = encrypt_series(&vec![0x11u8; 10_000], &[0xAAu8; 32]).unwrap();
    let ct2 = encrypt_series(&vec![0x22u8; 10_000], &[0xBBu8; 32]).unwrap();

    for (fid, ct) in [(&fid1, &ct1), (&fid2, &ct2)] {
        client
            .put(format!("{base}/api/shares/{sid}/files/{fid}.bin"))
            .bearer_auth(&token)
            .body(ct.clone())
            .send()
            .await
            .unwrap();
    }

    // Link A: U-mode, only allowed fid1.bin
    let link_a: Value = client
        .post(format!("{base}/api/shares/{sid}/links"))
        .bearer_auth(&token)
        .json(&json!({ "allowedFiles": [format!("{fid1}.bin")] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let lid_a = link_a["id"].as_str().unwrap().to_string();
    client
        .put(format!("{base}/api/shares/{sid}/links/{lid_a}/bundle.jwe"))
        .bearer_auth(&token)
        .body("jwe-a")
        .send()
        .await
        .unwrap();

    // Link B: P+L mode, allowed both fid1.bin and fid2.bin
    let link_b: Value = client
        .post(format!("{base}/api/shares/{sid}/links"))
        .bearer_auth(&token)
        .json(&json!({
            "passcode": "9876",
            "longLived": true,
            "allowedFiles": [format!("{fid1}.bin"), format!("{fid2}.bin")]
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let lid_b = link_b["id"].as_str().unwrap().to_string();
    assert_eq!(link_b["flag"], "LP");
    client
        .put(format!("{base}/api/shares/{sid}/links/{lid_b}/bundle.jwe"))
        .bearer_auth(&token)
        .body("jwe-b")
        .send()
        .await
        .unwrap();

    // Verify Link A can read fid1.bin (200) but gets 404 for fid2.bin
    assert_eq!(
        client
            .get(format!("{base}/shl/{lid_a}/{fid1}.bin"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .get(format!("{base}/shl/{lid_a}/{fid2}.bin"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );

    // Verify Link B manifest response has status="can-change" and fhirVersion=4.0.1
    let manifest_b: Value = client
        .post(format!("{base}/shl/{lid_b}"))
        .json(&json!({ "passcode": "9876" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(manifest_b["status"], "can-change");
    assert_eq!(
        manifest_b["files"][0]["contentType"],
        "application/fhir+json;fhirVersion=4.0.1"
    );
    let cap_loc = manifest_b["files"][0]["location"].as_str().unwrap().to_string();
    let cap_prefix = cap_loc.strip_suffix("bundle.jwe").unwrap();

    // Multiple GET/Range requests under the same /cap/ prefix succeed
    for _ in 0..3 {
        assert_eq!(
            client
                .get(format!("{cap_prefix}{fid2}.bin"))
                .header(header::RANGE, "bytes=0-1023")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::PARTIAL_CONTENT
        );
    }

    // Delete Link A -> permanently 404; creating Link C gets a new lid and does not revive Link A
    assert_eq!(
        client
            .delete(format!("{base}/api/shares/{sid}/links/{lid_a}"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        client
            .get(format!("{base}/shl/{lid_a}/bundle.jwe"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    let link_c: Value = client
        .post(format!("{base}/api/shares/{sid}/links"))
        .bearer_auth(&token)
        .json(&json!({ "allowedFiles": [format!("{fid1}.bin")] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_ne!(link_c["id"].as_str().unwrap(), lid_a);
    assert_eq!(
        client
            .get(format!("{base}/shl/{lid_a}/bundle.jwe"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );

    // Delete Link B -> both /shl/{lid_b} and its /cap/ prefix return 404
    client
        .delete(format!("{base}/api/shares/{sid}/links/{lid_b}"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(
        client
            .get(&cap_loc)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );

    // Simulate a crash between share DB and catalog DB: insert an orphan link into share DB only
    let orphan_lid = b64url_encode(&[99u8; 16]);
    {
        let conn_arc = state.open_share_db(&sid).unwrap();
        let conn = conn_arc.lock().unwrap();
        conn.execute(
            "INSERT INTO links (lid, long_lived, online, created_at) VALUES (?1, 0, 1, 1000)",
            params![orphan_lid],
        )
        .unwrap();
    }
    // Orphan link is unreachable because it's not in catalog.db
    assert_eq!(
        client
            .get(format!("{base}/shl/{orphan_lid}/bundle.jwe"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn test_controls_mid_download_resumption_expiry_and_traversal() {
    let dir = temp_data_dir("controls_resumption_traversal");
    let state = AppState::new(&dir).unwrap();
    let base = spawn_test_server(state.clone()).await;
    let client = reqwest::Client::new();

    let create_resp: Value = client
        .post(format!("{base}/api/shares"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let sid = create_resp["share"]["id"].as_str().unwrap().to_string();
    let token = create_resp["controlToken"].as_str().unwrap().to_string();

    let golden_bin = std::fs::read("../../fixtures/golden/AAECAwQFBgcICQoLDA0ODw.bin").unwrap();
    let file_id = "AAECAwQFBgcICQoLDA0ODw";
    client
        .put(format!("{base}/api/shares/{sid}/files/{file_id}.bin"))
        .bearer_auth(&token)
        .body(golden_bin.clone())
        .send()
        .await
        .unwrap();

    let link_resp: Value = client
        .post(format!("{base}/api/shares/{sid}/links"))
        .bearer_auth(&token)
        .json(&json!({
            "passcode": "4321",
            "allowedFiles": [format!("{file_id}.bin")]
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let lid = link_resp["id"].as_str().unwrap().to_string();
    let shl_key = [0x33u8; 32];
    let dummy_jwe = encrypt_bundle_jwe(b"{}", &shl_key).unwrap();
    client
        .put(format!("{base}/api/shares/{sid}/links/{lid}/bundle.jwe"))
        .bearer_auth(&token)
        .body(dummy_jwe)
        .send()
        .await
        .unwrap();

    // 1. Resolve manifest to get token1, fetch record 0 (0..65536)
    let m1: Value = client
        .post(format!("{base}/shl/{lid}"))
        .json(&json!({ "passcode": "4321" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let prefix1 = m1["files"][0]["location"]
        .as_str()
        .unwrap()
        .strip_suffix("bundle.jwe")
        .unwrap()
        .to_string();

    let part1 = client
        .get(format!("{prefix1}{file_id}.bin"))
        .header(header::RANGE, "bytes=0-65535")
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(part1.len(), 65_536);

    // 2. End open sessions mid-download -> prefix1 immediately returns 404
    let end_resp: Value = client
        .post(format!("{base}/api/shares/{sid}/links/{lid}/end-sessions"))
        .bearer_auth(&token)
        .json(&json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(end_resp["revokedCount"], 1);
    assert_eq!(
        client
            .get(format!("{prefix1}{file_id}.bin"))
            .header(header::RANGE, "bytes=65536-150047")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );

    // 3. Re-resolve manifest to get prefix2, resume Range read from byte 65536, and verify full assembly!
    let m2: Value = client
        .post(format!("{base}/shl/{lid}"))
        .json(&json!({ "passcode": "4321" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let prefix2 = m2["files"][0]["location"]
        .as_str()
        .unwrap()
        .strip_suffix("bundle.jwe")
        .unwrap()
        .to_string();

    let part2 = client
        .get(format!("{prefix2}{file_id}.bin"))
        .header(header::RANGE, "bytes=65536-150047")
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();

    let mut reassembled = Vec::from(part1.as_ref());
    reassembled.extend_from_slice(&part2);
    let series_key = decode_key_32("ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8").unwrap();
    let decrypted_all = decrypt_range(&reassembled, 0, 150_000, 150_000, &series_key).unwrap();
    assert_eq!(decrypted_all.len(), 150_000);

    // 4. Take link offline -> 404; bring back online -> 200; set exp in the past -> 404
    client
        .patch(format!("{base}/api/shares/{sid}/links/{lid}"))
        .bearer_auth(&token)
        .json(&json!({ "online": false }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        client
            .get(format!("{prefix2}{file_id}.bin"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );

    client
        .patch(format!("{base}/api/shares/{sid}/links/{lid}"))
        .bearer_auth(&token)
        .json(&json!({ "online": true, "exp": 1000 }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        client
            .get(format!("{prefix2}{file_id}.bin"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );

    // 5. Path traversal and uncatalogued ID checks
    for bad_path in [
        "/shl/../../catalog.db/bundle.jwe",
        "/shl/%2e%2e%2fcatalog.db/bundle.jwe",
        "/shl/..%5ccatalog.db/bundle.jwe",
        "/shl/AAECAwQFBgcICQoLDA0ODw/../../catalog.db",
        "/shl/ZZZZZZZZZZZZZZZZZZZZZZ/bundle.jwe",
        "/cap/ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ/bundle.jwe",
    ] {
        let resp = client.get(format!("{base}{bad_path}")).send().await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND, "path {bad_path} must 404");
    }

    // 6. Delete share -> removes {sid}.db from disk
    let db_path = state.share_db_path(&sid);
    assert!(db_path.exists());
    assert_eq!(
        client
            .delete(format!("{base}/api/shares/{sid}"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    assert!(!db_path.exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn test_demo_seeding_cloning_expiry_and_parallel_uploads() {
    let dir = temp_data_dir("clone_expiry_parallel");
    let state = AppState::new(&dir).unwrap();
    let base = spawn_test_server(state.clone()).await;
    let client = Arc::new(reqwest::Client::new());

    // 1. Create a read-only share to stand in for a seeded demo share
    let (demo_sid, _unused_ctrl) = state.create_share(true, None).unwrap();
    let fid = b64url_encode(&[77u8; 16]);
    shl_dicom_server::state::store_series_file(&state, &demo_sid, &fid, &vec![0x55u8; 70_000]).unwrap();

    // Clone the read-only demo share into a controllable sandbox share
    let clone_resp: Value = client
        .post(format!("{base}/api/shares/{demo_sid}/clone"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let cloned_sid = clone_resp["share"]["id"].as_str().unwrap().to_string();
    let cloned_token = clone_resp["controlToken"].as_str().unwrap().to_string();
    assert_eq!(clone_resp["share"]["readOnly"], false);
    assert_eq!(clone_resp["share"]["files"].as_array().unwrap().len(), 1);
    assert_eq!(
        clone_resp["share"]["files"][0]["name"],
        format!("{fid}.bin")
    );

    // 2. Parallel uploads to two different shares proceed concurrently
    let s2_resp: Value = client
        .post(format!("{base}/api/shares"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let sid2 = s2_resp["share"]["id"].as_str().unwrap().to_string();
    let token2 = s2_resp["controlToken"].as_str().unwrap().to_string();

    let mut tasks = Vec::new();
    for (s, t, k) in [(&cloned_sid, &cloned_token, 1u8), (&sid2, &token2, 2u8)] {
        let c = client.clone();
        let b = base.clone();
        let s = s.clone();
        let t = t.clone();
        let new_fid = b64url_encode(&[k; 16]);
        tasks.push(tokio::spawn(async move {
            c.put(format!("{b}/api/shares/{s}/files/{new_fid}.bin"))
                .bearer_auth(&t)
                .body(vec![k; 131_072])
                .send()
                .await
                .unwrap()
                .status()
        }));
    }
    for task in tasks {
        assert_eq!(task.await.unwrap(), StatusCode::OK);
    }

    // 3. Expired sandbox share is removed by sweep and its .db file is deleted
    let (exp_sid, _) = state.create_share(false, Some(1000)).unwrap();
    let exp_db_path = state.share_db_path(&exp_sid);
    assert!(exp_db_path.exists());
    state.run_sweep().unwrap();
    assert!(!exp_db_path.exists());
    assert!(!state.catalog_has_share(&exp_sid));

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn test_chunked_resumable_upload_and_disk_range_reads() {
    let dir = temp_data_dir("chunked_upload");
    let state = AppState::new(&dir).unwrap();
    let base = spawn_test_server(state.clone()).await;
    let client = reqwest::Client::new();
    let created: Value = client.post(format!("{base}/api/shares")).send().await.unwrap().json().await.unwrap();
    let sid = created["share"]["id"].as_str().unwrap().to_string();
    let token = created["controlToken"].as_str().unwrap().to_string();
    let fid = b64url_encode(&[9u8; 16]);
    let url = format!("{base}/api/shares/{sid}/files/{fid}.bin");
    let data: Vec<u8> = (0..300_000u32).map(|i| (i * 7 % 251) as u8).collect();
    let head = |c: &reqwest::Client| c.head(&url).bearer_auth(&token).send();
    let append = |a: usize, b: usize, complete: bool| {
        client
            .patch(&url)
            .bearer_auth(&token)
            .header("Content-Type", "application/partial-upload")
            .header("Upload-Offset", a.to_string())
            .header("Upload-Complete", if complete { "?1" } else { "?0" })
            .body(data[a..b].to_vec())
            .send()
    };

    // No upload yet.
    assert_eq!(head(&client).await.unwrap().status(), StatusCode::NOT_FOUND);

    // Create it with its first bytes.
    let r = client
        .put(&url)
        .bearer_auth(&token)
        .header("Upload-Complete", "?0")
        .header("Upload-Length", data.len().to_string())
        .body(data[..100_000].to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::CREATED);
    assert_eq!(r.headers()["upload-offset"], "100000");
    assert_eq!(r.headers()["upload-complete"], "?0");

    // An append at the wrong offset: 409 with where the upload stands.
    let skip = append(200_000, 300_000, true).await.unwrap();
    assert_eq!(skip.status(), StatusCode::CONFLICT);
    assert_eq!(skip.headers()["upload-offset"], "100000");
    let p: Value = skip.json().await.unwrap();
    assert_eq!(p["type"], "https://iana.org/assignments/http-problem-types#mismatching-upload-offset");
    assert_eq!(p["expected-offset"], 100_000);

    // Offset retrieval, then continue.
    let h = head(&client).await.unwrap();
    assert_eq!(h.status(), StatusCode::NO_CONTENT);
    assert_eq!(h.headers()["upload-offset"], "100000");
    assert_eq!(h.headers()["upload-length"], "300000");
    assert_eq!(h.headers()["cache-control"], "no-store");
    assert!(h.headers()["upload-limit"].to_str().unwrap().contains("max-append-size="));
    let r = append(100_000, 200_000, false).await.unwrap();
    assert_eq!(r.status(), StatusCode::NO_CONTENT);
    assert_eq!(r.headers()["upload-offset"], "200000");
    // Completing with too few bytes is an inconsistent length.
    let short = append(200_000, 250_000, true).await.unwrap();
    assert_eq!(short.status(), StatusCode::BAD_REQUEST);
    let r = append(200_000, 300_000, true).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.headers()["upload-complete"], "?1");
    assert!(dir.join("shares").join(&sid).join(format!("{fid}.bin")).exists());
    let h = head(&client).await.unwrap();
    assert_eq!(h.headers()["upload-complete"], "?1");

    // Read ranges back through a link.
    let link: Value = client
        .post(format!("{base}/api/shares/{sid}/links"))
        .bearer_auth(&token)
        .json(&json!({ "allowedFiles": [format!("{fid}.bin")] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let lid = link["id"].as_str().unwrap();
    let rr = client
        .get(format!("{base}/shl/{lid}/{fid}.bin"))
        .header("Range", "bytes=65530-200009")
        .send()
        .await
        .unwrap();
    assert_eq!(rr.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(rr.headers()["content-range"], "bytes 65530-200009/300000");
    assert_eq!(rr.bytes().await.unwrap().as_ref(), &data[65_530..200_010]);
    let all = client.get(format!("{base}/shl/{lid}/{fid}.bin")).send().await.unwrap();
    assert_eq!(all.status(), StatusCode::OK);
    assert_eq!(all.bytes().await.unwrap().as_ref(), &data[..]);
}
