use std::sync::Arc;
use axum::http::{header, StatusCode};
use rusqlite::params;
use serde_json::{json, Value};
use shl_dicom_core::{
    crypto::{b64url_encode, decode_key_32, decrypt_range, encrypt_file, random_bytes},
    jwe::encrypt_bundle_jwe,
    range::ciphertext_range,
};
use shl_dicom_server::{
    build_app_router,
    state::AppState,
    storage::{BlobStore, BoxFuture, LocalFsStore, ReadDelivery, ReadError, ReadMode, S3Config, S3Store},
};
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

/// The store the tests run against: local files, or S3 when SHL_TEST_S3_BUCKET is set (with
/// SHL_TEST_S3_ENDPOINT, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and SHL_TEST_S3_READ_MODE =
/// proxy | redirect). Each test uses its own key prefix.
fn test_store(dir: &std::path::Path) -> Arc<dyn BlobStore> {
    let Ok(bucket) = std::env::var("SHL_TEST_S3_BUCKET") else {
        return Arc::new(LocalFsStore { root: dir.join("blobs") });
    };
    Arc::new(
        S3Store::new(S3Config {
            endpoint: std::env::var("SHL_TEST_S3_ENDPOINT").ok(),
            bucket,
            region: "us-east-1".into(),
            access_key_id: std::env::var("AWS_ACCESS_KEY_ID").unwrap(),
            secret_access_key: std::env::var("AWS_SECRET_ACCESS_KEY").unwrap(),
            prefix: format!("test-{}/", b64url_encode(&random_bytes::<6>().unwrap())),
            read_mode: if std::env::var("SHL_TEST_S3_READ_MODE").as_deref() == Ok("redirect") { ReadMode::Redirect } else { ReadMode::Proxy },
            path_style: true,
        })
        .unwrap(),
    )
}

fn test_state(dir: &std::path::Path) -> AppState {
    AppState::with_store(dir, shl_dicom_server::state::Quotas::default(), test_store(dir)).unwrap()
}

/// Whether the store still has a blob (asks through the store, following a redirect).
async fn blob_exists(state: &AppState, key: &str) -> bool {
    match state.store.read_range(key, 0, 0).await {
        Err(_) => false,
        Ok(ReadDelivery::Stream(_)) => true,
        Ok(ReadDelivery::Redirect(url)) => reqwest::Client::new().get(url).header("Range", "bytes=0-0").send().await.is_ok_and(|r| r.status().is_success()),
    }
}

/// A file's storage key, from the share's database.
fn file_key(state: &AppState, sid: &str, fid: &str) -> String {
    let c = state.open_share_db(sid).unwrap();
    let conn = c.lock().unwrap();
    conn.query_row("SELECT storage_key FROM files WHERE file_id = ?1", params![fid], |r| r.get(0)).unwrap()
}

/// A store that fails on request: the next `flush_part`, or every `delete` while `fail_delete` is set. Over the local
/// store (which sends no parts) it keeps parts itself, as S3 would, so the part logic runs too.
struct Flaky {
    inner: Arc<dyn BlobStore>,
    parts_dir: std::path::PathBuf,
    fail_flush: std::sync::atomic::AtomicBool,
    fail_delete: std::sync::atomic::AtomicBool,
}

impl Flaky {
    fn new(inner: Arc<dyn BlobStore>, dir: &std::path::Path) -> Arc<Self> {
        Arc::new(Self {
            inner,
            parts_dir: dir.join("flaky-parts"),
            fail_flush: false.into(),
            fail_delete: false.into(),
        })
    }
    fn emulates_parts(&self) -> bool {
        self.inner.part_target(1).is_none()
    }
}

impl BlobStore for Flaky {
    fn describe(&self) -> String {
        self.inner.describe()
    }
    fn locate(&self, key: &str) -> String {
        self.inner.locate(key)
    }
    fn read_range<'a>(&'a self, key: &'a str, start: u64, end: u64) -> BoxFuture<'a, Result<ReadDelivery, ReadError>> {
        self.inner.read_range(key, start, end)
    }
    fn part_target(&self, total: u64) -> Option<u64> {
        self.inner.part_target(total).or(Some(8 << 20))
    }
    fn begin_upload<'a>(&'a self, key: &'a str, total: u64) -> BoxFuture<'a, Result<Option<String>, String>> {
        if self.emulates_parts() {
            return Box::pin(async { Ok(Some("emulated".to_string())) });
        }
        self.inner.begin_upload(key, total)
    }
    fn flush_part<'a>(&'a self, key: &'a str, upload_id: &'a str, part_num: u32, staged: &'a std::path::Path) -> BoxFuture<'a, Result<(String, u64), String>> {
        Box::pin(async move {
            if self.fail_flush.swap(false, std::sync::atomic::Ordering::SeqCst) {
                return Err("injected part failure".to_string());
            }
            if !self.emulates_parts() {
                return self.inner.flush_part(key, upload_id, part_num, staged).await;
            }
            std::fs::create_dir_all(&self.parts_dir).unwrap();
            let len = std::fs::copy(staged, self.parts_dir.join(format!("{key}.{part_num}"))).map_err(|e| e.to_string())?;
            Ok((format!("etag{part_num}"), len))
        })
    }
    fn complete_upload<'a>(&'a self, key: &'a str, upload_id: Option<&'a str>, parts: &'a [(u32, String)], staged: &'a std::path::Path) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            if !self.emulates_parts() || upload_id.is_none() {
                return self.inner.complete_upload(key, upload_id, parts, staged).await;
            }
            let whole = self.parts_dir.join(format!("{key}.whole"));
            let mut out = Vec::new();
            for (n, _) in parts {
                out.extend(std::fs::read(self.parts_dir.join(format!("{key}.{n}"))).unwrap());
            }
            std::fs::write(&whole, out).unwrap();
            self.inner.put_file(key, &whole).await
        })
    }
    fn abort_upload<'a>(&'a self, key: &'a str, upload_id: &'a str) -> BoxFuture<'a, Result<(), String>> {
        if self.emulates_parts() {
            return Box::pin(async { Ok(()) });
        }
        self.inner.abort_upload(key, upload_id)
    }
    fn delete<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            if self.fail_delete.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("injected delete failure".to_string());
            }
            self.inner.delete(key).await
        })
    }
    fn put_file<'a>(&'a self, key: &'a str, path: &'a std::path::Path) -> BoxFuture<'a, Result<(), String>> {
        self.inner.put_file(key, path)
    }
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
    let state = test_state(&dir);
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
        .header(header::ORIGIN, "https://viewer.example")
        .send()
        .await
        .unwrap();
    assert_eq!(range_resp.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        range_resp.headers().get(header::CONTENT_RANGE).unwrap(),
        "bytes 65536-150047/150048"
    );
    // Cross-origin readers are allowed: "*" from this server, or the origin echoed by the bucket
    // a redirect led to.
    let acao = range_resp.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap();
    assert!(acao == "*" || acao == "https://viewer.example", "{acao:?}");
    // Must NEVER carry Content-Encoding even when Accept-Encoding: gzip, br was sent
    assert!(range_resp.headers().get(header::CONTENT_ENCODING).is_none());

    let ct_slice = range_resp.bytes().await.unwrap();
    assert_eq!(ct_slice.len(), 150_048 - 65_536);
    let file_key = decode_key_32("ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8").unwrap();
    let inst2 = decrypt_range(&ct_slice, 70_000, 150_000, 150_000, &file_key).unwrap();
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
    let state = AppState::with_store(
        &dir,
        shl_dicom_server::state::Quotas { share_bytes: Some(200_000), share_files: Some(256), shares: Some(64), request_bytes: 64 << 20, cap_ttl_secs: 3600 },
        test_store(&dir),
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
    let state = test_state(&dir);
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
    let state = test_state(&dir);
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
    let ct1 = encrypt_file(&vec![0x11u8; 10_000], &[0xAAu8; 32]).unwrap();
    let ct2 = encrypt_file(&vec![0x22u8; 10_000], &[0xBBu8; 32]).unwrap();

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
    let state = test_state(&dir);
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
    let file_key = decode_key_32("ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8").unwrap();
    let decrypted_all = decrypt_range(&reassembled, 0, 150_000, 150_000, &file_key).unwrap();
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
    let state = test_state(&dir);
    let base = spawn_test_server(state.clone()).await;
    let client = Arc::new(reqwest::Client::new());

    // 1. Create a read-only share to stand in for a seeded demo share
    let (demo_sid, _unused_ctrl) = state.create_share(true, None).unwrap();
    let fid = b64url_encode(&[77u8; 16]);
    shl_dicom_server::state::store_file(&state, &demo_sid, &fid, &vec![0x55u8; 70_000]).await.unwrap();

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
    let state = test_state(&dir);
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
    assert!(blob_exists(&state, &file_key(&state, &sid, &fid)).await);
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

#[tokio::test]
async fn test_sample_redirects() {
    let dir = temp_data_dir("sample_redirect");
    let state = test_state(&dir);
    let base = spawn_test_server(state.clone()).await;
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();

    // No sample yet.
    assert_eq!(client.get(format!("{base}/sample")).send().await.unwrap().status(), StatusCode::NOT_FOUND);

    let (sid, _) = state.create_share(true, None).unwrap();
    let share = state.build_share_resource(&sid, &base).unwrap();
    for (uri, hint) in [("http://seeded.example/#shlink:/PUBLIC", None), ("http://seeded.example/#shlink:/PASSCODE", Some("1234".to_string()))] {
        state.demo_shares.lock().unwrap().push(shl_dicom_server::state::DemoShareInfo {
            id: sid.clone(),
            title: "Sample".into(),
            description: String::new(),
            shlink_uri: uri.into(),
            passcode_hint: hint,
            read_only: true,
            share: share.clone(),
        });
    }
    for (path, link) in [("/sample", "shlink:/PUBLIC"), ("/sample/passcode", "shlink:/PASSCODE")] {
        let r = client.get(format!("{base}{path}")).send().await.unwrap();
        assert_eq!(r.status(), StatusCode::FOUND);
        assert_eq!(r.headers()[header::CACHE_CONTROL], "no-store");
        let loc = r.headers()[header::LOCATION].to_str().unwrap();
        assert!(loc.ends_with(&format!("/view#{link}")), "{loc}");
    }
}

/// A cloned share names the same blob; the blob outlives the source share and goes when the
/// last share naming it is deleted.
#[tokio::test]
async fn test_clone_shares_blobs_by_reference() {
    let dir = temp_data_dir("blob_refs");
    let state = test_state(&dir);
    let base = spawn_test_server(state.clone()).await;
    let client = reqwest::Client::new();
    let (src, _) = state.create_share(true, None).unwrap();
    let fid = b64url_encode(&[42u8; 16]);
    let data: Vec<u8> = (0..300_000u32).map(|i| (i % 253) as u8).collect();
    shl_dicom_server::state::store_file(&state, &src, &fid, &data).await.unwrap();
    let key = file_key(&state, &src, &fid);
    assert!(!key.contains(&src), "storage keys name no share: {key}");
    let clone: Value = client.post(format!("{base}/api/shares/{src}/clone")).send().await.unwrap().json().await.unwrap();
    let (sid, token) = (clone["share"]["id"].as_str().unwrap().to_string(), clone["controlToken"].as_str().unwrap().to_string());

    // The source goes; the clone still serves the file.
    state.delete_share(&src).unwrap();
    state.empty_trash().await;
    assert!(blob_exists(&state, &key).await, "blob deleted while a clone still names it");
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
    let r = client.get(format!("{base}/shl/{lid}/{fid}.bin")).header("Range", "bytes=1000-1999").send().await.unwrap();
    assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(r.bytes().await.unwrap().as_ref(), &data[1000..2000]);

    // The clone goes too: now the blob is deleted.
    assert_eq!(client.delete(format!("{base}/api/shares/{sid}")).bearer_auth(&token).send().await.unwrap().status(), StatusCode::NO_CONTENT);
    state.empty_trash().await;
    assert!(!blob_exists(&state, &key).await, "blob left behind");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A 20 MiB resumable upload in 3 MiB appends, one of them cut off mid-body: the server keeps
/// what arrived, the client continues from HEAD's offset, and (on S3) the file goes up as
/// multipart parts while the upload runs. Range reads across part boundaries come back exact.
#[tokio::test]
async fn test_resumable_upload_with_parts_and_an_interrupted_append() {
    let dir = temp_data_dir("resumable_parts");
    let state = test_state(&dir);
    let base = spawn_test_server(state.clone()).await;
    let client = reqwest::Client::new();
    let created: Value = client.post(format!("{base}/api/shares")).send().await.unwrap().json().await.unwrap();
    let sid = created["share"]["id"].as_str().unwrap().to_string();
    let token = created["controlToken"].as_str().unwrap().to_string();
    let fid = b64url_encode(&[5u8; 16]);
    let url = format!("{base}/api/shares/{sid}/files/{fid}.bin");
    let total = 20 << 20;
    let data: Vec<u8> = (0..total as u32).map(|i| (i.wrapping_mul(2654435761) >> 24) as u8).collect();
    let r = client.put(&url).bearer_auth(&token).header("Upload-Complete", "?0").header("Upload-Length", total.to_string()).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::CREATED);

    let offset = |c: reqwest::Client| {
        let (u, t) = (url.clone(), token.clone());
        async move { c.head(&u).bearer_auth(&t).send().await.unwrap().headers()["upload-offset"].to_str().unwrap().parse::<usize>().unwrap() }
    };
    let mut off = 0usize;
    let mut cut = false;
    while off < total {
        let end = (off + (3 << 20)).min(total);
        let chunk = data[off..end].to_vec();
        if !cut && off >= 6 << 20 {
            // An append whose body stops part-way: 1 MiB arrives, then the connection fails.
            cut = true;
            let first = chunk[..1 << 20].to_vec();
            let body = reqwest::Body::wrap_stream(futures_util::stream::iter(vec![
                Ok::<Vec<u8>, std::io::Error>(first),
                Err(std::io::Error::other("connection dropped")),
            ]));
            let _ = client
                .patch(&url)
                .bearer_auth(&token)
                .header("Content-Type", "application/partial-upload")
                .header("Upload-Offset", off.to_string())
                .header("Upload-Complete", "?0")
                .body(body)
                .send()
                .await;
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            let now = offset(client.clone()).await;
            assert!(now >= off && now <= off + (1 << 20), "offset {now} after a cut append from {off}");
            off = now;
            continue;
        }
        let r = client
            .patch(&url)
            .bearer_auth(&token)
            .header("Content-Type", "application/partial-upload")
            .header("Upload-Offset", off.to_string())
            .header("Upload-Complete", if end == total { "?1" } else { "?0" })
            .body(chunk)
            .send()
            .await
            .unwrap();
        assert!(r.status().is_success(), "append at {off}: {}", r.status());
        off = end;
    }
    assert!(cut);
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
    for (a, b) in [(0usize, 99usize), (8 << 20, (8 << 20) + 99), ((8 << 20) - 50, (8 << 20) + 50), (total - 100, total - 1), (6 << 20, (9 << 20) + 7)] {
        let r = client.get(format!("{base}/shl/{lid}/{fid}.bin")).header("Range", format!("bytes={a}-{b}")).send().await.unwrap();
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT, "range {a}-{b}");
        assert_eq!(r.bytes().await.unwrap().as_ref(), &data[a..=b], "range {a}-{b}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// In redirect mode a series read is a 307 to a presigned URL (no-store), which serves the range.
#[tokio::test]
async fn test_redirect_reads() {
    if std::env::var("SHL_TEST_S3_READ_MODE").as_deref() != Ok("redirect") {
        return;
    }
    let dir = temp_data_dir("redirect_reads");
    let state = test_state(&dir);
    let base = spawn_test_server(state.clone()).await;
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
    let created: Value = client.post(format!("{base}/api/shares")).send().await.unwrap().json().await.unwrap();
    let sid = created["share"]["id"].as_str().unwrap().to_string();
    let token = created["controlToken"].as_str().unwrap().to_string();
    let fid = b64url_encode(&[7u8; 16]);
    let data: Vec<u8> = (0..200_000u32).map(|i| (i % 241) as u8).collect();
    let r = client.put(format!("{base}/api/shares/{sid}/files/{fid}.bin")).bearer_auth(&token).body(data.clone()).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
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
    let lid = link["id"].as_str().unwrap().to_string();
    let r = client.get(format!("{base}/shl/{lid}/{fid}.bin")).header("Range", "bytes=100-199").send().await.unwrap();
    assert_eq!(r.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(r.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(r.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    let to = r.headers()[header::LOCATION].to_str().unwrap().to_string();
    assert!(to.contains("X-Amz-Signature="), "{to}");
    assert!(!to.contains(&sid), "the presigned URL names no share");
    // HEAD is answered by the server (a presigned URL is for GET only).
    let h = client.head(format!("{base}/shl/{lid}/{fid}.bin")).header("Range", "bytes=100-199").send().await.unwrap();
    assert_eq!(h.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(h.headers()[header::CONTENT_LENGTH], "100");
    assert_eq!(h.headers()[header::ACCEPT_RANGES], "bytes");
    let got = reqwest::Client::new().get(&to).header("Range", "bytes=100-199").send().await.unwrap();
    assert_eq!(got.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(got.bytes().await.unwrap().as_ref(), &data[100..200]);
    // Revoked: no more redirects.
    client.delete(format!("{base}/api/shares/{sid}/links/{lid}")).bearer_auth(&token).send().await.unwrap();
    let r = client.get(format!("{base}/shl/{lid}/{fid}.bin")).header("Range", "bytes=100-199").send().await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Deleting an unfinished upload aborts its multipart upload in S3 (parts already sent are gone).
#[tokio::test]
async fn test_deleting_an_upload_aborts_its_multipart_upload() {
    let Ok(bucket_name) = std::env::var("SHL_TEST_S3_BUCKET") else { return };
    let dir = temp_data_dir("abort_upload");
    let state = test_state(&dir);
    let base = spawn_test_server(state.clone()).await;
    let client = reqwest::Client::new();
    let created: Value = client.post(format!("{base}/api/shares")).send().await.unwrap().json().await.unwrap();
    let sid = created["share"]["id"].as_str().unwrap().to_string();
    let token = created["controlToken"].as_str().unwrap().to_string();
    let fid = b64url_encode(&[9u8; 16]);
    let url = format!("{base}/api/shares/{sid}/files/{fid}.bin");
    client.put(&url).bearer_auth(&token).header("Upload-Complete", "?0").header("Upload-Length", (20u64 << 20).to_string()).send().await.unwrap();
    let r = client
        .patch(&url)
        .bearer_auth(&token)
        .header("Content-Type", "application/partial-upload")
        .header("Upload-Offset", "0")
        .header("Upload-Complete", "?0")
        .body(vec![1u8; 9 << 20])
        .send()
        .await
        .unwrap();
    assert!(r.status().is_success());
    let (upload_id, parts): (String, i64) = {
        let c = state.open_share_db(&sid).unwrap();
        let conn = c.lock().unwrap();
        (
            conn.query_row("SELECT s3_upload_id FROM uploads WHERE file_id = ?1", rusqlite::params![fid], |r| r.get(0)).unwrap(),
            conn.query_row("SELECT COUNT(*) FROM upload_parts WHERE file_id = ?1", rusqlite::params![fid], |r| r.get(0)).unwrap(),
        )
    };
    assert_eq!(parts, 1, "9 MiB staged should have gone up as one part");
    let bucket = rusty_s3::Bucket::new(std::env::var("SHL_TEST_S3_ENDPOINT").unwrap().parse().unwrap(), rusty_s3::UrlStyle::Path, bucket_name, "us-east-1").unwrap();
    let creds = rusty_s3::Credentials::new(std::env::var("AWS_ACCESS_KEY_ID").unwrap(), std::env::var("AWS_SECRET_ACCESS_KEY").unwrap());
    let key: String = state.open_share_db(&sid).unwrap().lock().unwrap().query_row("SELECT storage_key FROM uploads WHERE file_id = ?1", params![fid], |r| r.get(0)).unwrap();
    let object = state.store.locate(&key);
    let object = object.splitn(4, '/').nth(3).unwrap().to_string(); // s3://bucket/<object>
    use rusty_s3::S3Action;
    let list = || rusty_s3::actions::ListParts::new(&bucket, Some(&creds), &object, &upload_id).sign(std::time::Duration::from_secs(60));
    assert_eq!(client.get(list()).send().await.unwrap().status(), StatusCode::OK, "the multipart upload exists");
    assert_eq!(client.delete(&url).bearer_auth(&token).send().await.unwrap().status(), StatusCode::NO_CONTENT);
    state.empty_trash().await;
    let st = client.get(list()).send().await.unwrap().status();
    assert_eq!(st, StatusCode::NOT_FOUND, "ListParts after the abort");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A part that fails on its way to the store leaves the upload where the last stored part ended:
/// the append gets a 502, HEAD reports that offset (never more), and the client sends the rest
/// again. A leftover `{fileId}.part.{n}` from a crash doesn't count either.
#[tokio::test]
async fn test_a_failed_part_rolls_the_offset_back() {
    let dir = temp_data_dir("failed_part");
    let flaky = Flaky::new(test_store(&dir), &dir);
    let state = AppState::with_store(&dir, shl_dicom_server::state::Quotas::default(), flaky.clone()).unwrap();
    let base = spawn_test_server(state.clone()).await;
    let client = reqwest::Client::new();
    let created: Value = client.post(format!("{base}/api/shares")).send().await.unwrap().json().await.unwrap();
    let sid = created["share"]["id"].as_str().unwrap().to_string();
    let token = created["controlToken"].as_str().unwrap().to_string();
    let fid = b64url_encode(&[11u8; 16]);
    let url = format!("{base}/api/shares/{sid}/files/{fid}.bin");
    let total = 20usize << 20;
    let data: Vec<u8> = (0..total as u32).map(|i| (i.wrapping_mul(2246822519) >> 24) as u8).collect();
    let r = client.put(&url).bearer_auth(&token).header("Upload-Complete", "?0").header("Upload-Length", total.to_string()).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::CREATED);
    let append = |off: usize, end: usize| {
        let (c, u, t, body) = (client.clone(), url.clone(), token.clone(), data[off..end].to_vec());
        async move {
            c.patch(&u)
                .bearer_auth(&t)
                .header("Content-Type", "application/partial-upload")
                .header("Upload-Offset", off.to_string())
                .header("Upload-Complete", if end == total { "?1" } else { "?0" })
                .body(body)
                .send()
                .await
                .unwrap()
        }
    };
    let offset = || {
        let (c, u, t) = (client.clone(), url.clone(), token.clone());
        async move { c.head(&u).bearer_auth(&t).send().await.unwrap().headers()["upload-offset"].to_str().unwrap().parse::<usize>().unwrap() }
    };
    // 3 + 3 MiB stay staged; the third append reaches the 8 MiB part size and the part fails.
    assert!(append(0, 3 << 20).await.status().is_success());
    assert!(append(3 << 20, 6 << 20).await.status().is_success());
    flaky.fail_flush.store(true, std::sync::atomic::Ordering::SeqCst);
    let r = append(6 << 20, 9 << 20).await;
    assert_eq!(r.status(), StatusCode::BAD_GATEWAY);
    let body = r.text().await.unwrap();
    assert!(!body.contains("injected"), "store detail kept out of the response: {body}");
    assert_eq!(offset().await, 0, "nothing was stored yet");
    // A stray part file from a crash mid-send doesn't count toward the offset.
    std::fs::write(state.sending_path(&sid, &fid, 1), vec![0u8; 1000]).unwrap();
    assert_eq!(offset().await, 0);
    // Continue from HEAD's offset to the end.
    let mut off = offset().await;
    while off < total {
        let end = (off + (3 << 20)).min(total);
        let r = append(off, end).await;
        assert!(r.status().is_success(), "append at {off}: {}", r.status());
        off = end;
        if end < total {
            assert_eq!(offset().await, end);
        }
    }
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
    for (a, b) in [(0usize, 99usize), ((8 << 20) - 50, (8 << 20) + 50), (total - 100, total - 1)] {
        let r = reqwest::get(format!("{base}/shl/{lid}/{fid}.bin")).await.unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(&r.bytes().await.unwrap()[a..=b], &data[a..=b], "range {a}-{b}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// A blob whose delete fails stays in the trash and goes on the next try.
#[tokio::test]
async fn test_a_failed_delete_stays_in_the_trash() {
    let dir = temp_data_dir("trash_retry");
    let flaky = Flaky::new(test_store(&dir), &dir);
    let state = AppState::with_store(&dir, shl_dicom_server::state::Quotas::default(), flaky.clone()).unwrap();
    let (sid, _) = state.create_share(true, None).unwrap();
    let fid = b64url_encode(&[12u8; 16]);
    shl_dicom_server::state::store_file(&state, &sid, &fid, &[7u8; 5000]).await.unwrap();
    let key = file_key(&state, &sid, &fid);
    flaky.fail_delete.store(true, std::sync::atomic::Ordering::SeqCst);
    state.delete_share(&sid).unwrap();
    state.empty_trash().await;
    assert!(blob_exists(&state, &key).await, "the failed delete is retried later");
    flaky.fail_delete.store(false, std::sync::atomic::Ordering::SeqCst);
    state.empty_trash().await;
    assert!(!blob_exists(&state, &key).await, "deleted on the second try");
    let _ = std::fs::remove_dir_all(&dir);
}

/// The sweep drops uploads started more than a day ago: the row, the staged bytes, and (on S3)
/// the multipart upload.
#[tokio::test]
async fn test_the_sweep_drops_stale_uploads() {
    let dir = temp_data_dir("stale_uploads");
    let state = test_state(&dir);
    let base = spawn_test_server(state.clone()).await;
    let client = reqwest::Client::new();
    let created: Value = client.post(format!("{base}/api/shares")).send().await.unwrap().json().await.unwrap();
    let sid = created["share"]["id"].as_str().unwrap().to_string();
    let token = created["controlToken"].as_str().unwrap().to_string();
    let url = |fid: &str| format!("{base}/api/shares/{sid}/files/{fid}.bin");
    let (old, new) = (b64url_encode(&[13u8; 16]), b64url_encode(&[14u8; 16]));
    for fid in [&old, &new] {
        let r = client
            .put(url(fid))
            .bearer_auth(&token)
            .header("Upload-Complete", "?0")
            .header("Upload-Length", (20u64 << 20).to_string())
            .body(vec![3u8; 1000])
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::CREATED);
    }
    let day_ago = shl_dicom_server::state::now_unix() - shl_dicom_server::state::STALE_UPLOAD_SECS - 60;
    state.open_share_db(&sid).unwrap().lock().unwrap().execute("UPDATE uploads SET started_at = ?1 WHERE file_id = ?2", params![day_ago, old]).unwrap();
    state.sweep_stale_uploads();
    state.empty_trash().await;
    assert_eq!(client.head(url(&old)).bearer_auth(&token).send().await.unwrap().status(), StatusCode::NOT_FOUND, "stale upload dropped");
    assert!(!state.part_path(&sid, &old).exists(), "its staged bytes are gone");
    let h = client.head(url(&new)).bearer_auth(&token).send().await.unwrap();
    assert_eq!(h.headers()["upload-offset"], "1000", "a recent upload is kept");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A file whose blob is missing from the store reads as 404, not 502. HEAD needs no store read.
#[tokio::test]
async fn test_a_missing_blob_is_not_found() {
    if std::env::var("SHL_TEST_S3_READ_MODE").as_deref() == Ok("redirect") {
        return; // the bucket answers that read
    }
    let dir = temp_data_dir("missing_blob");
    let state = test_state(&dir);
    let base = spawn_test_server(state.clone()).await;
    let client = reqwest::Client::new();
    let created: Value = client.post(format!("{base}/api/shares")).send().await.unwrap().json().await.unwrap();
    let sid = created["share"]["id"].as_str().unwrap().to_string();
    let token = created["controlToken"].as_str().unwrap().to_string();
    let fid = b64url_encode(&[15u8; 16]);
    let r = client.put(format!("{base}/api/shares/{sid}/files/{fid}.bin")).bearer_auth(&token).body(vec![9u8; 4096]).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
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
    let h = client.head(format!("{base}/shl/{lid}/{fid}.bin")).send().await.unwrap();
    assert_eq!(h.status(), StatusCode::OK);
    assert_eq!(h.headers()[header::CONTENT_LENGTH], "4096");
    state.store.delete(&file_key(&state, &sid, &fid)).await.unwrap();
    let r = client.get(format!("{base}/shl/{lid}/{fid}.bin")).header("Range", "bytes=0-9").send().await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    let _ = std::fs::remove_dir_all(&dir);
}
