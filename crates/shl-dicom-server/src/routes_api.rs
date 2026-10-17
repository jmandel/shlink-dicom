use std::convert::Infallible;
use axum::{
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{
        sse::{Event, Sse},
        IntoResponse, Response,
    },
    Json,
};
use futures_util::stream::StreamExt;
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::json;
use shl_dicom_core::crypto::{b64url_encode, random_bytes};
use tokio_stream::wrappers::BroadcastStream;
use crate::{
    routes_shl::request_origin,
    state::{
        build_link_resource_from_row, hash_passcode, is_valid_id22, now_unix,
        adopt_blob, new_storage_key, parse_file_name, record_file, sha256_bytes, AccessEvent, AppState, ShareFileEntry,
        DEFAULT_PASSCODE_ATTEMPTS, DEFAULT_SANDBOX_TTL_SECS, MAX_SHARE_TTL_SECS,
    },
};

fn extract_bearer(headers: &HeaderMap) -> Option<&str> {
    let auth = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    auth.strip_prefix("Bearer ").map(str::trim)
}

#[allow(clippy::result_large_err)] // the Err is the response to send
fn require_auth(state: &AppState, sid: &str, headers: &HeaderMap) -> Result<(), Response> {
    if !is_valid_id22(sid) || !state.catalog_has_share(sid) {
        return Err((StatusCode::NOT_FOUND, Json(json!({ "error": "share not found" }))).into_response());
    }
    let Some(token) = extract_bearer(headers) else {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "missing Bearer token" })),
        )
            .into_response());
    };
    if !state.verify_control_token(sid, token) {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "invalid control token or read-only share" })),
        )
            .into_response());
    }
    Ok(())
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShareExpiryRequest {
    /// Unix seconds. Clamped to at most `MAX_SHARE_TTL_SECS` from now; null or absent means that maximum
    /// (PATCH) or the default sandbox lifetime (POST).
    #[serde(default)]
    pub expires_at: Option<i64>,
}

fn clamp_share_expiry(requested: Option<i64>, fallback_ttl: i64) -> i64 {
    let now = now_unix();
    let max = now + MAX_SHARE_TTL_SECS;
    match requested {
        Some(t) => t.clamp(now + 60, max),
        None => (now + fallback_ttl).min(max),
    }
}

/// `POST /api/shares` (optional body `{ "expiresAt": unixSeconds }`)
pub async fn create_share(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let req: ShareExpiryRequest = if body.iter().all(|b| b.is_ascii_whitespace()) {
        ShareExpiryRequest::default()
    } else {
        match serde_json::from_slice(&body) {
            Ok(r) => r,
            Err(e) => {
                return (StatusCode::BAD_REQUEST, Json(json!({ "error": format!("invalid JSON: {e}") })))
                    .into_response()
            }
        }
    };
    let expires_at = Some(clamp_share_expiry(req.expires_at, DEFAULT_SANDBOX_TTL_SECS));
    let (sid, control_token) = match state.create_share(false, expires_at) {
        Ok(v) => v,
        Err(e) if e == "QUOTA_SHARES_EXCEEDED" => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({ "error": "maximum active sandbox shares exceeded" })),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e })),
            )
                .into_response();
        }
    };

    let origin = request_origin(&state, &headers);
    let Some(share) = state.build_share_resource(&sid, &origin) else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "failed to load created share" })),
        )
            .into_response();
    };

    (
        StatusCode::CREATED,
        Json(json!({
            "share": share,
            "controlToken": control_token,
        })),
    )
        .into_response()
}

/// `POST /api/shares/{sid}/clone`
pub async fn clone_share(
    State(state): State<AppState>,
    Path(source_sid): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !is_valid_id22(&source_sid) || !state.catalog_has_share(&source_sid) {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "source share not found" })),
        )
            .into_response();
    }
    let Some(src_conn_arc) = state.open_share_db(&source_sid) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "source share DB not found" })),
        )
            .into_response();
    };

    let expires_at = Some(now_unix() + DEFAULT_SANDBOX_TTL_SECS);
    let (new_sid, control_token) = match state.create_share(false, expires_at) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": e })),
            )
                .into_response();
        }
    };

    let Some(dst_conn_arc) = state.open_share_db(&new_sid) else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "failed to open cloned share DB" })),
        )
            .into_response();
    };

    // The clone names the same blobs (no bytes are copied); each gains a reference, but only one
    // whose count is still above 0 (`blob_ref`). Holding the source's database lock is not enough:
    // a delete may run over another connection (a pool miss, or the seed's own process replacing
    // the sample), release the last reference and trash the blob. Then the clone fails instead of
    // naming a deleted blob. Lock order: the source share, then the new share, then the catalog.
    let internal = |e: String| (StatusCode::INTERNAL_SERVER_ERROR, e);
    let copy_res: Result<(), (StatusCode, String)> = (|| {
        let src_conn = src_conn_arc.lock().unwrap();
        let rows: Vec<(String, String, i64)> = {
            let mut stmt = src_conn.prepare("SELECT file_id, storage_key, size FROM files").map_err(|e| internal(e.to_string()))?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))
                .map_err(|e| internal(e.to_string()))?
                .flatten()
                .collect();
            rows
        };
        let dst_conn = dst_conn_arc.lock().unwrap();
        for (fid, key, size) in rows {
            if !state.blob_ref(&key).map_err(internal)? {
                return Err((StatusCode::CONFLICT, "the source share is being deleted".into()));
            }
            if let Err(e) = record_file(&dst_conn, &fid, &key, size as u64) {
                let _ = state.blob_release(&key);
                return Err(internal(e));
            }
        }
        Ok(())
    })();

    if let Err((status, e)) = copy_res {
        let _ = state.delete_share(&new_sid);
        state.empty_trash_soon();
        return (status, Json(json!({ "error": e }))).into_response();
    }

    let origin = request_origin(&state, &headers);
    let share = state.build_share_resource(&new_sid, &origin).unwrap();
    (
        StatusCode::CREATED,
        Json(json!({
            "share": share,
            "controlToken": control_token,
        })),
    )
        .into_response()
}

/// `GET /api/shares/{sid}`
pub async fn get_share(
    State(state): State<AppState>,
    Path(sid): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = require_auth(&state, &sid, &headers) {
        return resp;
    }
    let origin = request_origin(&state, &headers);
    match state.build_share_resource(&sid, &origin) {
        Some(share) => (StatusCode::OK, Json(share)).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "share not found" }))).into_response(),
    }
}

/// `PATCH /api/shares/{sid}`: `{ "expiresAt": unixSeconds | null }` (null: the longest allowed).
pub async fn patch_share(
    State(state): State<AppState>,
    Path(sid): Path<String>,
    headers: HeaderMap,
    Json(req): Json<ShareExpiryRequest>,
) -> Response {
    if let Err(resp) = require_auth(&state, &sid, &headers) {
        return resp;
    }
    let expires_at = clamp_share_expiry(req.expires_at, MAX_SHARE_TTL_SECS);
    if let Err(e) = state.set_share_expiry(&sid, expires_at) {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response();
    }
    let origin = request_origin(&state, &headers);
    match state.build_share_resource(&sid, &origin) {
        Some(share) => (StatusCode::OK, Json(share)).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "share not found" }))).into_response(),
    }
}

/// `DELETE /api/shares/{sid}`
pub async fn delete_share(
    State(state): State<AppState>,
    Path(sid): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = require_auth(&state, &sid, &headers) {
        return resp;
    }
    match state.delete_share(&sid) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        )
            .into_response(),
    }
}

/// `PUT /api/shares/{sid}/owner.jwe`
pub async fn put_owner_bundle(
    State(state): State<AppState>,
    Path(sid): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(resp) = require_auth(&state, &sid, &headers) {
        return resp;
    }
    if body.is_empty() || body.len() > 16 * 1024 * 1024 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid owner.jwe size" })),
        )
            .into_response();
    }
    let Some(conn_arc) = state.open_share_db(&sid) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let now = now_unix();
    let res = {
        let conn = conn_arc.lock().unwrap();
        conn.execute(
            "UPDATE share SET owner_bundle = ?1, owner_updated_at = ?2 WHERE id = 1",
            params![body.as_ref(), now],
        )
    };
    match res {
        Ok(_) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "size": body.len() })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `GET /api/shares/{sid}/owner.jwe`
pub async fn get_owner_bundle(
    State(state): State<AppState>,
    Path(sid): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = require_auth(&state, &sid, &headers) {
        return resp;
    }
    let Some(conn_arc) = state.open_share_db(&sid) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let bundle_opt: Option<Vec<u8>> = {
        let conn = conn_arc.lock().unwrap();
        conn.query_row("SELECT owner_bundle FROM share WHERE id = 1", [], |r| {
            r.get(0)
        })
        .optional()
        .ok()
        .flatten()
    };
    match bundle_opt {
        Some(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/jose")
            .body(Body::from(bytes))
            .unwrap(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "owner.jwe not set" })),
        )
            .into_response(),
    }
}

fn json_err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "error": msg.into() }))).into_response()
}

// ---------------------------------------------------------------------------------------------
// File uploads, following the IETF resumable uploads draft
// (draft-ietf-httpbis-resumable-upload-13). The upload resource is the file's own URL,
// /api/shares/{sid}/files/{fileId}.bin:
//   PUT   with Upload-Complete (and Upload-Length when known)   creates the upload (the body may be its start)
//   HEAD                                           Upload-Offset, Upload-Complete, Upload-Length, Upload-Limit
//   PATCH application/partial-upload, Upload-Offset, Upload-Complete   appends
//   DELETE                                         cancels (or deletes the finished file)
// A PUT without Upload-Complete sends a whole file in one request (not resumable).
// The length may be left out until it is known: an append gives Upload-Length, or the final
// append (Upload-Complete: ?1) fixes it at its end. The share's byte limit is then enforced as the
// bytes arrive. An upload of unknown length is stored with size UNKNOWN_LENGTH.
// The bytes of an interrupted request are kept; the client asks where to continue.

/// How long an upload request may go without receiving a byte.
const BODY_IDLE: std::time::Duration = std::time::Duration::from_secs(30);

/// `uploads.size` of an upload whose length is not known yet.
const UNKNOWN_LENGTH: i64 = -1;

const PROBLEM_MISMATCH: &str = "https://iana.org/assignments/http-problem-types#mismatching-upload-offset";
const PROBLEM_LENGTH: &str = "https://iana.org/assignments/http-problem-types#inconsistent-upload-length";

fn sf_bool(headers: &HeaderMap, name: &str) -> Option<Result<bool, ()>> {
    let v = headers.get(name)?.to_str().ok()?.trim().to_string();
    Some(match v.as_str() {
        "?1" => Ok(true),
        "?0" => Ok(false),
        _ => Err(()),
    })
}

/// A Structured Field Integer header (RFC 8941: at most 15 digits), as u64. Anything past
/// i64::MAX is refused: lengths are stored as SQLite integers, and sums of them must not wrap.
fn sf_int(headers: &HeaderMap, name: &str) -> Option<Result<u64, ()>> {
    let v = headers.get(name)?.to_str().ok()?;
    Some(v.trim().parse::<u64>().ok().filter(|&n| n <= i64::MAX as u64).ok_or(()))
}

fn problem(status: StatusCode, kind: &str, title: &str, extra: serde_json::Value) -> Response {
    let mut body = json!({ "type": kind, "title": title, "error": title });
    if let (Some(b), Some(e)) = (body.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            b.insert(k.clone(), v.clone());
        }
    }
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/problem+json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

/// Where an upload stands: `(offset, length, complete)`; None when there is no such upload.
fn upload_state(state: &AppState, sid: &str, file_id: &str) -> Option<(u64, Option<u64>, bool)> {
    let conn_arc = state.open_share_db(sid)?;
    let conn = conn_arc.lock().unwrap();
    if let Some(size) = conn
        .query_row("SELECT size FROM files WHERE file_id = ?1", params![file_id], |r| r.get::<_, i64>(0))
        .optional()
        .ok()
        .flatten()
    {
        return Some((size as u64, Some(size as u64), true));
    }
    let (size, flushed): (i64, i64) = conn
        .query_row("SELECT size, flushed_bytes FROM uploads WHERE file_id = ?1", params![file_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .ok()
        .flatten()?;
    // What has gone on to the store as parts, and what is staged locally.
    let staged = std::fs::metadata(state.part_path(sid, file_id)).map(|m| m.len()).unwrap_or(0);
    Some((flushed as u64 + staged, (size >= 0).then_some(size as u64), false))
}

fn upload_limit(state: &AppState) -> String {
    let mut s = format!("max-append-size={}", state.quotas.request_bytes);
    if let Some(m) = state.quotas.share_bytes {
        s.push_str(&format!(", max-size={m}"));
    }
    s
}

/// Upload-* headers describing an upload.
fn with_upload_headers(mut b: axum::http::response::Builder, state: &AppState, offset: u64, length: Option<u64>, complete: bool) -> axum::http::response::Builder {
    b = b
        .header("Upload-Offset", offset.to_string())
        .header("Upload-Complete", if complete { "?1" } else { "?0" })
        .header("Upload-Limit", upload_limit(state))
        .header(header::CACHE_CONTROL, "no-store");
    if let Some(l) = length {
        b = b.header("Upload-Length", l.to_string());
    }
    b
}

/// `HEAD /api/shares/{sid}/files/{name}`: where the upload stands, so a client can continue it.
pub async fn head_share_file(
    State(state): State<AppState>,
    Path((sid, name)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = require_auth(&state, &sid, &headers) {
        return resp;
    }
    let Some(file_id) = parse_file_name(&name) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    match upload_state(&state, &sid, file_id) {
        Some((offset, length, complete)) => with_upload_headers(Response::builder().status(StatusCode::NO_CONTENT), &state, offset, length, complete)
            .body(Body::empty())
            .unwrap(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// A store request that failed: the detail goes to the log, the client gets a plain 502.
fn store_failed(what: &str, e: String) -> Response {
    eprintln!("{what}: {e}");
    json_err(StatusCode::BAD_GATEWAY, "the file store did not respond as expected; ask HEAD where the upload stands and try again")
}

/// How a request's body is appended.
enum Append {
    /// Ok: the new offset.
    Ok(u64),
    /// The response to send; the file is back where the request started.
    Fail(Response),
    /// The connection dropped: the bytes that arrived are kept.
    Interrupted(u64),
}

/// The upload's bytes already sent on to the store as parts.
fn flushed_bytes(state: &AppState, sid: &str, file_id: &str) -> u64 {
    state
        .open_share_db(sid)
        .and_then(|c| c.lock().unwrap().query_row("SELECT flushed_bytes FROM uploads WHERE file_id = ?1", params![file_id], |r| r.get::<_, i64>(0)).ok())
        .unwrap_or(0) as u64
}

/// Streams `body` onto the staged `{fileId}.part` from upload offset `start`, never past `total`
/// and taking at most `max_body` bytes (else 413, keeping none of this body).
/// The staged file holds the bytes from `flushed_bytes` on.
async fn append_body(state: &AppState, sid: &str, file_id: &str, start: u64, total: Option<u64>, max_body: Option<u64>, body: Body) -> Append {
    use tokio::io::AsyncWriteExt;
    // A length not known yet: the share's byte limit is checked as the bytes arrive.
    let quota_end = match (total, state.quotas.share_bytes) {
        (None, Some(cap)) => cap.saturating_sub(share_bytes_in_use(state, sid, file_id)),
        _ => u64::MAX,
    };
    let part = state.part_path(sid, file_id);
    let flushed = flushed_bytes(state, sid, file_id);
    let Some(local) = start.checked_sub(flushed) else {
        return Append::Fail(json_err(StatusCode::CONFLICT, "that part of the upload has already been stored"));
    };
    let _ = tokio::fs::create_dir_all(state.staging_dir(sid)).await;
    let Ok(mut file) = tokio::fs::OpenOptions::new().create(true).write(true).truncate(false).open(&part).await else {
        return Append::Fail(json_err(StatusCode::INTERNAL_SERVER_ERROR, "could not open the upload file"));
    };
    if file.set_len(local).await.is_err() || tokio::io::AsyncSeekExt::seek(&mut file, std::io::SeekFrom::Start(local)).await.is_err() {
        return Append::Fail(json_err(StatusCode::INTERNAL_SERVER_ERROR, "could not position the upload file"));
    }
    let mut got: u64 = 0;
    let mut stream = body.into_data_stream();
    loop {
        // A body that stops arriving for BODY_IDLE ends the request; what came is kept.
        let next = match tokio::time::timeout(BODY_IDLE, stream.next()).await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(_) => {
                let _ = file.flush().await;
                return Append::Interrupted(start + got);
            }
        };
        let Ok(chunk) = next else {
            let _ = file.flush().await;
            return Append::Interrupted(start + got);
        };
        if total.is_some_and(|t| start + got + chunk.len() as u64 > t) {
            let _ = file.set_len(local).await;
            drain(&mut stream, state.quotas.request_bytes).await;
            return Append::Fail(problem(StatusCode::BAD_REQUEST, PROBLEM_LENGTH, "inconsistent length values for upload", json!({})));
        }
        if max_body.is_some_and(|m| got + chunk.len() as u64 > m) {
            let _ = file.set_len(local).await;
            drain(&mut stream, state.quotas.request_bytes).await;
            return Append::Fail(json_err(StatusCode::PAYLOAD_TOO_LARGE, format!("appends may be at most {} bytes", max_body.unwrap_or_default())));
        }
        if start + got + chunk.len() as u64 > quota_end {
            let _ = file.set_len(local).await;
            drain(&mut stream, state.quotas.request_bytes).await;
            return Append::Fail(json_err(StatusCode::PAYLOAD_TOO_LARGE, "QUOTA_BYTES_EXCEEDED"));
        }
        if file.write_all(&chunk).await.is_err() {
            let _ = file.set_len(local).await;
            return Append::Fail(json_err(StatusCode::INSUFFICIENT_STORAGE, "the server could not store the file"));
        }
        got += chunk.len() as u64;
    }
    let _ = file.flush().await;
    Append::Ok(start + got)
}

/// Reads and drops what is left of a refused request body, up to `limit` bytes (or until it stops
/// arriving), so the client finishes sending and reads the refusal. A server that answers and
/// closes while the client is still writing leaves it a broken pipe instead of the response on
/// some systems (macOS).
async fn drain(stream: &mut (impl futures_util::Stream<Item = Result<bytes::Bytes, axum::Error>> + Unpin), limit: u64) {
    let mut n = 0u64;
    while n < limit {
        match tokio::time::timeout(BODY_IDLE, stream.next()).await {
            Ok(Some(Ok(c))) => n += c.len() as u64,
            _ => break,
        }
    }
}

/// Encrypted bytes a share holds or has on the way, apart from upload `except`: finished files,
/// uploads of known length at their length, and uploads of unknown length at what has arrived.
fn share_bytes_in_use(state: &AppState, sid: &str, except: &str) -> u64 {
    let Some(c) = state.open_share_db(sid) else { return 0 };
    let (files, known, unknown): (i64, i64, Vec<(String, i64)>) = {
        let conn = c.lock().unwrap();
        let files = conn.query_row("SELECT COALESCE(SUM(size), 0) FROM files", [], |r| r.get(0)).unwrap_or(0);
        let known = conn
            .query_row("SELECT COALESCE(SUM(size), 0) FROM uploads WHERE size >= 0 AND file_id != ?1", params![except], |r| r.get(0))
            .unwrap_or(0);
        let unknown = conn
            .prepare("SELECT file_id, flushed_bytes FROM uploads WHERE size < 0 AND file_id != ?1")
            .and_then(|mut st| st.query_map(params![except], |r| Ok((r.get(0)?, r.get(1)?))).map(|rows| rows.flatten().collect()))
            .unwrap_or_default();
        (files, known, unknown)
    };
    let arrived: u64 = unknown
        .iter()
        .map(|(f, flushed)| *flushed as u64 + std::fs::metadata(state.part_path(sid, f)).map(|m| m.len()).unwrap_or(0))
        .sum();
    files as u64 + known as u64 + arrived
}

/// An upload's storage key, its multipart id, and the parts sent so far (number, ETag), in order.
type UploadRow = (String, Option<String>, Vec<(u32, String)>);

fn upload_row(state: &AppState, sid: &str, file_id: &str) -> Option<UploadRow> {
    let c = state.open_share_db(sid)?;
    let conn = c.lock().unwrap();
    let (key, id): (String, Option<String>) = conn
        .query_row("SELECT storage_key, s3_upload_id FROM uploads WHERE file_id = ?1", params![file_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .ok()?;
    let parts = conn
        .prepare("SELECT part_num, etag FROM upload_parts WHERE file_id = ?1 ORDER BY part_num")
        .and_then(|mut st| st.query_map(params![file_id], |r| Ok((r.get::<_, u32>(0)?, r.get::<_, String>(1)?))).map(|rows| rows.flatten().collect()))
        .unwrap_or_default();
    Some((key, id, parts))
}

/// Sends the staged bytes on to the store as the next part, when the store takes parts and
/// `force` (the last part) or the staged file has reached the store's part size.
///
/// The staged file is first renamed to `{fileId}.part.{n}`, so from then on its bytes no longer
/// count toward the upload's offset; they count again only once the part is recorded. A failure or
/// a crash in between leaves the offset at the last recorded part, and the client sends the rest
/// again. Appends always start a fresh `{fileId}.part`.
async fn flush_staged(state: &AppState, sid: &str, file_id: &str, total: Option<u64>, force: bool) -> Result<(), String> {
    let Some((key, Some(upload_id), parts)) = upload_row(state, sid, file_id) else { return Ok(()) };
    let Some(target) = state.store.part_target(total) else { return Ok(()) };
    let part = state.part_path(sid, file_id);
    let staged = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
    if staged == 0 || (!force && staged < target) {
        return Ok(());
    }
    let num = parts.last().map_or(1, |p| p.0 + 1);
    let sending = state.sending_path(sid, file_id, num);
    tokio::fs::rename(&part, &sending).await.map_err(|e| format!("stage part {num}: {e}"))?;
    let sent = async {
        let (etag, len) = state.store.flush_part(&key, &upload_id, num, &sending).await?;
        let c = state.open_share_db(sid).ok_or("share not found")?;
        let mut conn = c.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO upload_parts (file_id, part_num, etag, size) VALUES (?1, ?2, ?3, ?4)",
            params![file_id, num, etag, len as i64],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("UPDATE uploads SET flushed_bytes = flushed_bytes + ?1 WHERE file_id = ?2", params![len as i64, file_id])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
    .await;
    let _ = tokio::fs::remove_file(&sending).await;
    sent
}

/// Records the length of an upload begun without one.
fn set_upload_length(state: &AppState, sid: &str, file_id: &str, length: u64) {
    if let Some(c) = state.open_share_db(sid) {
        let _ = c.lock().unwrap().execute("UPDATE uploads SET size = ?1 WHERE file_id = ?2", params![length as i64, file_id]);
    }
}

/// Publishes a finished upload through the store and records the file.
async fn publish_file(state: &AppState, sid: &str, file_id: &str, size: u64) -> Result<ShareFileEntry, String> {
    let part = state.part_path(sid, file_id);
    flush_staged(state, sid, file_id, Some(size), true).await?;
    let (key, upload_id, parts) = upload_row(state, sid, file_id).ok_or("the upload is gone")?;
    match upload_id {
        Some(id) => state.store.complete_upload(&key, Some(&id), &parts, &part).await?,
        None => state.store.put_file(&key, &part).await?,
    }
    state.remove_staged(sid, file_id);
    adopt_blob(state, sid, file_id, &key, size)
}

fn finished(state: &AppState, status: StatusCode, entry: ShareFileEntry) -> Response {
    with_upload_headers(Response::builder().status(status), state, entry.size, Some(entry.size), true)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({ "name": entry.name, "size": entry.size, "uploadedAt": entry.uploaded_at, "complete": true }).to_string(),
        ))
        .unwrap()
}

/// Checks the share's limits for a new upload of `total` bytes and records it. A resumable upload
/// to a store that takes parts starts a multipart upload there.
async fn start_upload(state: &AppState, sid: &str, file_id: &str, total: Option<u64>, resumable: bool) -> Result<(), Response> {
    forget_upload(state, sid, file_id);
    let key = new_storage_key();
    let upload_id = if resumable {
        state.store.begin_upload(&key, total).await.map_err(|e| store_failed("start upload", e))?
    } else {
        None
    };
    let bytes = share_bytes_in_use(state, sid, file_id);
    let conn_arc = state.open_share_db(sid).ok_or_else(|| StatusCode::NOT_FOUND.into_response())?;
    let conn = conn_arc.lock().unwrap();
    let files: i64 = conn
        .query_row("SELECT (SELECT COUNT(*) FROM files) + (SELECT COUNT(*) FROM uploads)", [], |r| r.get(0))
        .unwrap_or(0);
    // A length not known yet is checked as its bytes arrive (append_body).
    let over = if state.quotas.share_files.is_some_and(|m| files as usize >= m) {
        Some("QUOTA_FILES_EXCEEDED")
    } else if state.quotas.share_bytes.is_some_and(|m| bytes.saturating_add(total.unwrap_or(0)) > m || (total.is_none() && bytes >= m)) {
        Some("QUOTA_BYTES_EXCEEDED")
    } else {
        None
    };
    if let Some(over) = over {
        if let Some(id) = &upload_id {
            state.trash_upload(&key, id);
            state.empty_trash_soon();
        }
        return Err(json_err(StatusCode::PAYLOAD_TOO_LARGE, over));
    }
    conn.execute(
        "INSERT INTO uploads (file_id, storage_key, size, s3_upload_id, flushed_bytes, started_at) VALUES (?1, ?2, ?3, ?4, 0, ?5)",
        params![file_id, key, total.map_or(UNKNOWN_LENGTH, |t| t as i64), upload_id, now_unix()],
    )
    .map_err(|e| json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let _ = std::fs::create_dir_all(state.staging_dir(sid));
    Ok(())
}

/// Drops an upload in progress: its staged bytes, its row and parts, and its multipart upload.
fn forget_upload(state: &AppState, sid: &str, file_id: &str) {
    state.remove_staged(sid, file_id);
    if let Some(c) = state.open_share_db(sid) {
        let conn = c.lock().unwrap();
        let row: Option<(String, Option<String>)> =
            conn.query_row("SELECT storage_key, s3_upload_id FROM uploads WHERE file_id = ?1", params![file_id], |r| Ok((r.get(0)?, r.get(1)?))).ok();
        let _ = conn.execute("DELETE FROM uploads WHERE file_id = ?1", params![file_id]);
        if let Some((key, Some(id))) = row {
            state.trash_upload(&key, &id);
            state.empty_trash_soon();
        }
    }
}

/// `PUT /api/shares/{sid}/files/{name}`
///
/// With `Upload-Complete`: creates a resumable upload whose body is the file's first bytes, with
/// `Upload-Length` when the length is known. Without: the whole file in one request
/// (`Content-Length` or `X-Expected-Size`), which is not resumable.
pub async fn put_share_file(
    State(state): State<AppState>,
    Path((sid, name)): Path<(String, String)>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if let Err(resp) = require_auth(&state, &sid, &headers) {
        return resp;
    }
    let Some(file_id) = parse_file_name(&name).map(String::from) else {
        return json_err(StatusCode::BAD_REQUEST, "file name must match ^[A-Za-z0-9_-]{22}\\.bin$");
    };
    let resumable = sf_bool(&headers, "upload-complete");
    let total = match resumable {
        Some(_) => match sf_int(&headers, "upload-length") {
            Some(Ok(n)) => Some(n),
            Some(Err(_)) => return json_err(StatusCode::BAD_REQUEST, "invalid Upload-Length"),
            None => None,
        },
        None => match sf_int(&headers, "x-expected-size").or_else(|| sf_int(&headers, "content-length")) {
            Some(Ok(n)) => Some(n),
            Some(Err(_)) => return json_err(StatusCode::BAD_REQUEST, "invalid X-Expected-Size header"),
            None => return json_err(StatusCode::LENGTH_REQUIRED, "send Content-Length, X-Expected-Size, or Upload-Complete with Upload-Length"),
        },
    };
    let complete_flag = match resumable {
        Some(Ok(b)) => b,
        Some(Err(_)) => return json_err(StatusCode::BAD_REQUEST, "invalid Upload-Complete"),
        None => true,
    };
    if total == Some(0) {
        return json_err(StatusCode::BAD_REQUEST, "file body must not be empty");
    }
    let Some(_guard) = state.claim_upload(&sid, &file_id) else {
        return json_err(StatusCode::CONFLICT, "another upload of this file is in progress");
    };
    if let Some((have, length, true)) = upload_state(&state, &sid, &file_id) {
        return if total.is_none() || length == total {
            with_upload_headers(Response::builder().status(StatusCode::OK), &state, have, Some(have), true).body(Body::empty()).unwrap()
        } else {
            json_err(StatusCode::CONFLICT, "fileId already exists with different content size")
        };
    }
    if let Err(resp) = start_upload(&state, &sid, &file_id, total, resumable.is_some()).await {
        return resp;
    }
    let end = match append_body(&state, &sid, &file_id, 0, total, None, body).await {
        Append::Ok(n) => n,
        Append::Fail(resp) => {
            if resumable.is_none() {
                forget_upload(&state, &sid, &file_id);
            }
            return resp;
        }
        Append::Interrupted(n) => {
            if resumable.is_none() {
                forget_upload(&state, &sid, &file_id);
            }
            return json_err(StatusCode::BAD_REQUEST, format!("the upload was interrupted after {n} bytes"));
        }
    };
    if complete_flag {
        // Complete without a length: the body was the whole file.
        let total = total.unwrap_or(end);
        if end != total || end == 0 {
            forget_upload(&state, &sid, &file_id);
            if resumable.is_none() {
                return json_err(StatusCode::BAD_REQUEST, format!("size mismatch: expected {total} bytes, got {end}"));
            }
            return problem(StatusCode::BAD_REQUEST, PROBLEM_LENGTH, "inconsistent length values for upload", json!({}));
        }
        return match publish_file(&state, &sid, &file_id, total).await {
            Ok(entry) => finished(&state, if resumable.is_some() { StatusCode::CREATED } else { StatusCode::OK }, entry),
            Err(e) => store_failed("publish upload", e),
        };
    }
    // Staged bytes of a part's size go on to the store. If that fails, the offset falls back to the
    // last part stored; the client asks HEAD and sends the rest again.
    if let Err(e) = flush_staged(&state, &sid, &file_id, total, false).await {
        return store_failed("send part", e);
    }
    with_upload_headers(Response::builder().status(StatusCode::CREATED), &state, end, total, false)
        .header(header::LOCATION, format!("/api/shares/{sid}/files/{file_id}.bin"))
        .body(Body::empty())
        .unwrap()
}

/// `PATCH /api/shares/{sid}/files/{name}` (`application/partial-upload`): appends to an upload.
pub async fn patch_share_file(
    State(state): State<AppState>,
    Path((sid, name)): Path<(String, String)>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if let Err(resp) = require_auth(&state, &sid, &headers) {
        return resp;
    }
    let Some(file_id) = parse_file_name(&name).map(String::from) else {
        return json_err(StatusCode::BAD_REQUEST, "invalid file name");
    };
    let ct = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
    if !ct.starts_with("application/partial-upload") {
        return json_err(StatusCode::UNSUPPORTED_MEDIA_TYPE, "appends must be application/partial-upload");
    }
    let (Some(Ok(offset)), Some(Ok(complete_flag))) = (sf_int(&headers, "upload-offset"), sf_bool(&headers, "upload-complete")) else {
        return json_err(StatusCode::BAD_REQUEST, "appends need Upload-Offset and Upload-Complete");
    };
    let Some(_guard) = state.claim_upload(&sid, &file_id) else {
        return json_err(StatusCode::CONFLICT, "another upload of this file is in progress");
    };
    let Some((have, length, complete)) = upload_state(&state, &sid, &file_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if complete {
        return problem(StatusCode::BAD_REQUEST, "about:blank", "the upload is already complete", json!({}));
    }
    if offset != have {
        let resp = problem(
            StatusCode::CONFLICT,
            PROBLEM_MISMATCH,
            "offset from request and upload resource do not match",
            json!({ "expected-offset": have, "provided-offset": offset }),
        );
        let (mut parts, b) = resp.into_parts();
        parts.headers.insert("Upload-Offset", have.to_string().parse().unwrap());
        parts.headers.insert("Upload-Complete", "?0".parse().unwrap());
        return Response::from_parts(parts, b);
    }
    // The length, once given, is fixed; an upload begun without one learns it from an append.
    let mut length = length;
    match (sf_int(&headers, "upload-length"), length) {
        (Some(Ok(l)), Some(known)) if l != known => {
            return problem(StatusCode::BAD_REQUEST, PROBLEM_LENGTH, "inconsistent length values for upload", json!({}));
        }
        (Some(Ok(l)), None) => {
            if l < have {
                return problem(StatusCode::BAD_REQUEST, PROBLEM_LENGTH, "inconsistent length values for upload", json!({}));
            }
            if state.quotas.share_bytes.is_some_and(|m| share_bytes_in_use(&state, &sid, &file_id).saturating_add(l) > m) {
                return json_err(StatusCode::PAYLOAD_TOO_LARGE, "QUOTA_BYTES_EXCEEDED");
            }
            set_upload_length(&state, &sid, &file_id, l);
            length = Some(l);
        }
        (Some(Err(_)), _) => return json_err(StatusCode::BAD_REQUEST, "invalid Upload-Length"),
        _ => {}
    }
    // Refused up front when Content-Length says so; a body without one is counted as it arrives.
    if let Some(Ok(cl)) = sf_int(&headers, "content-length") {
        if cl > state.quotas.request_bytes {
            return json_err(StatusCode::PAYLOAD_TOO_LARGE, format!("appends may be at most {} bytes", state.quotas.request_bytes));
        }
    }
    let end = match append_body(&state, &sid, &file_id, offset, length, Some(state.quotas.request_bytes), body).await {
        Append::Ok(n) => n,
        Append::Fail(resp) => return resp,
        Append::Interrupted(n) => return json_err(StatusCode::BAD_REQUEST, format!("the request was interrupted at offset {n}")),
    };
    if complete_flag {
        // The last append of an upload whose length was never given: the length is where it ends.
        let total = length.unwrap_or(end);
        if end != total || end == 0 {
            if let Ok(f) = tokio::fs::OpenOptions::new().write(true).open(state.part_path(&sid, &file_id)).await {
                let _ = f.set_len(offset - flushed_bytes(&state, &sid, &file_id)).await;
            }
            return problem(StatusCode::BAD_REQUEST, PROBLEM_LENGTH, "inconsistent length values for upload", json!({}));
        }
        return match publish_file(&state, &sid, &file_id, total).await {
            Ok(entry) => finished(&state, StatusCode::OK, entry),
            Err(e) => store_failed("publish upload", e),
        };
    }
    if let Err(e) = flush_staged(&state, &sid, &file_id, length, false).await {
        return store_failed("send part", e);
    }
    with_upload_headers(Response::builder().status(StatusCode::NO_CONTENT), &state, end, length, false).body(Body::empty()).unwrap()
}

/// `DELETE /api/shares/{sid}/files/{name}`
pub async fn delete_share_file(
    State(state): State<AppState>,
    Path((sid, name)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = require_auth(&state, &sid, &headers) {
        return resp;
    }
    let Some(file_id) = parse_file_name(&name) else {
        return json_err(StatusCode::BAD_REQUEST, "invalid file name");
    };
    // Not while a PUT or PATCH of this file is in progress: it would stage and record the file
    // again after the delete.
    let Some(_guard) = state.claim_upload(&sid, file_id) else {
        return json_err(StatusCode::CONFLICT, "an upload of this file is in progress");
    };
    let Some(conn_arc) = state.open_share_db(&sid) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let had_upload = upload_state(&state, &sid, file_id).is_some_and(|(_, _, complete)| !complete);
    if had_upload {
        forget_upload(&state, &sid, file_id);
    }
    // The blob's reference is dropped while the share's database is locked, as a clone adds its
    // references (lock order: the share, then the catalog).
    let res = {
        let conn = conn_arc.lock().unwrap();
        let key: Option<String> = conn.query_row("SELECT storage_key FROM files WHERE file_id = ?1", params![file_id], |r| r.get(0)).ok();
        let res = conn.execute("DELETE FROM files WHERE file_id = ?1", params![file_id]);
        if let (Ok(1), Some(key)) = (&res, &key) {
            // The file is gone either way; a failed release keeps the blob (never deletes one).
            if let Err(e) = state.blob_release(key) {
                eprintln!("share {sid}: {e} (the blob {key} stays)");
            }
        }
        res.map(|n| n + had_upload as usize)
    };
    match res {
        Ok(0) => StatusCode::NOT_FOUND.into_response(),
        Ok(_) => {
            state.empty_trash_soon();
            StatusCode::NO_CONTENT.into_response()
        }
        Err(rusqlite::Error::SqliteFailure(err, _))
            if err.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY =>
        {
            json_err(StatusCode::CONFLICT, "file is still referenced by one or more links")
        }
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLinkRequest {
    pub label: Option<String>,
    pub passcode: Option<String>,
    pub exp: Option<i64>,
    #[serde(default)]
    pub long_lived: bool,
    #[serde(default)]
    pub allowed_files: Vec<String>,
}

/// `POST /api/shares/{sid}/links`
pub async fn create_link(
    State(state): State<AppState>,
    Path(sid): Path<String>,
    headers: HeaderMap,
    Json(req): Json<CreateLinkRequest>,
) -> Response {
    if let Err(resp) = require_auth(&state, &sid, &headers) {
        return resp;
    }
    let Some(conn_arc) = state.open_share_db(&sid) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let mut file_ids = Vec::with_capacity(req.allowed_files.len());
    for fname in &req.allowed_files {
        let Some(fid) = parse_file_name(fname) else {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid allowed file name: {fname}") })),
            )
                .into_response();
        };
        file_ids.push(fid.to_string());
    }

    let lid = b64url_encode(&random_bytes::<16>().unwrap());
    let created_at = now_unix();
    let has_passcode = req.passcode.as_deref().is_some_and(|p| !p.is_empty());
    let (salt_opt, hash_opt, rem_opt) = if let Some(ref p) = req.passcode {
        if !p.is_empty() {
            let salt = random_bytes::<16>().unwrap();
            let h = hash_passcode(&salt, p);
            (
                Some(salt.to_vec()),
                Some(h.to_vec()),
                Some(DEFAULT_PASSCODE_ATTEMPTS),
            )
        } else {
            (None, None, None)
        }
    } else {
        (None, None, None)
    };

    // Rule: write share file first, catalog last.
    let db_res: Result<(), String> = (|| {
        let mut conn = conn_arc.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO links (lid, label, long_lived, online, exp, passcode_salt, passcode_hash, remaining_attempts, created_at)
             VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8)",
            params![
                lid,
                req.label,
                i64::from(req.long_lived),
                req.exp,
                salt_opt,
                hash_opt,
                rem_opt,
                created_at
            ],
        )
        .map_err(|e| e.to_string())?;

        for fid in &file_ids {
            tx.execute(
                "INSERT INTO link_files (lid, file_id) VALUES (?1, ?2)",
                params![lid, fid],
            )
            .map_err(|e| format!("allowed file {fid}.bin not found in share: {e}"))?;
        }
        tx.commit().map_err(|e| e.to_string())
    })();

    if let Err(e) = db_res {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e })),
        )
            .into_response();
    }

    if let Err(e) = state.register_link_in_catalog(&sid, &lid) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        )
            .into_response();
    }

    let origin = request_origin(&state, &headers);
    let conn = conn_arc.lock().unwrap();
    let link_res = build_link_resource_from_row(
        &conn,
        &origin,
        lid,
        req.label,
        req.long_lived,
        true,
        req.exp,
        has_passcode,
        rem_opt,
        false,
        created_at,
    )
    .unwrap();

    (StatusCode::CREATED, Json(link_res)).into_response()
}

/// `PUT /api/shares/{sid}/links/{lid}/bundle.jwe`
pub async fn put_link_bundle(
    State(state): State<AppState>,
    Path((sid, lid)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(resp) = require_auth(&state, &sid, &headers) {
        return resp;
    }
    if !is_valid_id22(&lid) || body.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid lid or empty bundle.jwe" })),
        )
            .into_response();
    }
    let Some(conn_arc) = state.open_share_db(&sid) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let etag_hash = sha256_bytes(&body);
    let etag = format!("\"{}\"", b64url_encode(&etag_hash[..16]));
    let now = now_unix();
    let origin = request_origin(&state, &headers);

    let conn = conn_arc.lock().unwrap();
    let changed = conn
        .execute(
            "UPDATE links SET bundle = ?1, bundle_etag = ?2, bundle_updated_at = ?3 WHERE lid = ?4",
            params![body.as_ref(), etag, now, lid],
        )
        .unwrap_or(0);

    if changed == 0 {
        return StatusCode::NOT_FOUND.into_response();
    }

    match load_link_resource(&conn, &origin, &lid) {
        Some(link) => (StatusCode::OK, Json(link)).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchLinkRequest {
    pub label: Option<Option<String>>,
    pub exp: Option<Option<i64>>,
    pub online: Option<bool>,
    pub allowed_files: Option<Vec<String>>,
}

/// `PATCH /api/shares/{sid}/links/{lid}`
pub async fn patch_link(
    State(state): State<AppState>,
    Path((sid, lid)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<PatchLinkRequest>,
) -> Response {
    if let Err(resp) = require_auth(&state, &sid, &headers) {
        return resp;
    }
    if !is_valid_id22(&lid) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(conn_arc) = state.open_share_db(&sid) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let origin = request_origin(&state, &headers);
    let mut conn = conn_arc.lock().unwrap();
    let tx = match conn.transaction() {
        Ok(t) => t,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response()
        }
    };

    let exists: bool = tx
        .query_row("SELECT 1 FROM links WHERE lid = ?1", params![lid], |_| Ok(true))
        .optional()
        .unwrap_or(None)
        .unwrap_or(false);
    if !exists {
        return StatusCode::NOT_FOUND.into_response();
    }

    if let Some(label_opt) = req.label {
        let _ = tx.execute(
            "UPDATE links SET label = ?1 WHERE lid = ?2",
            params![label_opt, lid],
        );
    }
    if let Some(exp_opt) = req.exp {
        let _ = tx.execute(
            "UPDATE links SET exp = ?1 WHERE lid = ?2",
            params![exp_opt, lid],
        );
    }
    if let Some(online) = req.online {
        let _ = tx.execute(
            "UPDATE links SET online = ?1 WHERE lid = ?2",
            params![i64::from(online), lid],
        );
    }
    if let Some(allowed) = req.allowed_files {
        let mut fids = Vec::with_capacity(allowed.len());
        for fname in &allowed {
            let Some(fid) = parse_file_name(fname) else {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": format!("invalid file name: {fname}") })),
                )
                    .into_response();
            };
            fids.push(fid.to_string());
        }
        let _ = tx.execute("DELETE FROM link_files WHERE lid = ?1", params![lid]);
        for fid in fids {
            if let Err(e) = tx.execute(
                "INSERT INTO link_files (lid, file_id) VALUES (?1, ?2)",
                params![lid, fid],
            ) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": format!("file {fid}.bin not in share: {e}") })),
                )
                    .into_response();
            }
        }
    }

    if let Err(e) = tx.commit() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response();
    }

    match load_link_resource(&conn, &origin, &lid) {
        Some(link) => (StatusCode::OK, Json(link)).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// `DELETE /api/shares/{sid}/links/{lid}`
pub async fn delete_link(
    State(state): State<AppState>,
    Path((sid, lid)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = require_auth(&state, &sid, &headers) {
        return resp;
    }
    if !is_valid_id22(&lid) {
        return StatusCode::NOT_FOUND.into_response();
    }
    // Rule: delete from catalog first (which cascades to caps), then from share DB. Only a link
    // of this share: the token proves nothing about other shares' links.
    match state.remove_link_from_catalog(&sid, &lid) {
        Ok(true) => {}
        Ok(false) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
    }
    if let Some(conn_arc) = state.open_share_db(&sid) {
        let conn = conn_arc.lock().unwrap();
        let _ = conn.execute("DELETE FROM links WHERE lid = ?1", params![lid]);
    }
    StatusCode::NO_CONTENT.into_response()
}

/// `POST /api/shares/{sid}/links/{lid}/end-sessions`
pub async fn end_link_sessions(
    State(state): State<AppState>,
    Path((sid, lid)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = require_auth(&state, &sid, &headers) {
        return resp;
    }
    if !is_valid_id22(&lid) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match state.revoke_caps_for_link(&sid, &lid) {
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Ok(Some(revoked_count)) => (
            StatusCode::OK,
            Json(json!({ "revokedCount": revoked_count })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct AccessQuery {
    pub since: Option<i64>,
    /// Only this link's events.
    pub lid: Option<String>,
    /// Newest first; default 500, at most 5000.
    pub limit: Option<i64>,
}

/// `GET /api/shares/{sid}/access?since=`
pub async fn get_share_access(
    State(state): State<AppState>,
    Path(sid): Path<String>,
    Query(query): Query<AccessQuery>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = require_auth(&state, &sid, &headers) {
        return resp;
    }
    state.flush_access(&sid);
    let Some(conn_arc) = state.open_share_db(&sid) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let since = query.since.unwrap_or(0);
    let lid_filter = query.lid.clone().unwrap_or_default();
    let limit = query.limit.unwrap_or(500).clamp(1, 5000);
    let conn = conn_arc.lock().unwrap();
    let mut stmt = match conn.prepare(
        "SELECT ts, lid, method, path, range, status, bytes, recipient
         FROM access_log WHERE ts >= ?1 AND (?2 = '' OR lid = ?2) ORDER BY ts DESC, rowid DESC LIMIT ?3",
    ) {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response()
        }
    };

    let events: Vec<AccessEvent> = stmt
        .query_map(params![since, lid_filter, limit], |r| {
            Ok(AccessEvent {
                ts: r.get(0)?,
                lid: r.get(1)?,
                method: r.get(2)?,
                path: r.get(3)?,
                range: r.get(4)?,
                status: r.get::<_, i64>(5)? as u16,
                bytes: r.get::<_, i64>(6)? as u64,
                recipient: r.get(7)?,
            })
        })
        .unwrap()
        .flatten()
        .collect();

    (StatusCode::OK, Json(json!({ "events": events }))).into_response()
}

/// `GET /api/shares/{sid}/events` — SSE live access log stream.
pub async fn get_share_events(
    State(state): State<AppState>,
    Path(sid): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = require_auth(&state, &sid, &headers) {
        return resp;
    }
    let rx = state.subscribe_events(&sid);
    let stream = BroadcastStream::new(rx).filter_map(|msg| async move {
        match msg {
            Ok(ev) => {
                let data = serde_json::to_string(&ev).ok()?;
                Some(Ok::<Event, Infallible>(Event::default().event("access").data(data)))
            }
            Err(_) => None,
        }
    });
    Sse::new(stream).into_response()
}

/// `GET /api/demo-shares`
pub async fn get_demo_shares(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let origin = request_origin(&state, &headers);
    let mut demos = state.demo_shares.lock().unwrap().clone();
    for d in &mut demos {
        if let Some(updated) = state.build_share_resource(&d.id, &origin) {
            d.share = updated;
        }
    }
    (StatusCode::OK, Json(json!({ "shares": demos }))).into_response()
}

fn load_link_resource(
    conn: &rusqlite::Connection,
    origin: &str,
    lid: &str,
) -> Option<crate::state::LinkResource> {
    let row = conn
        .query_row(
            "SELECT lid, label, long_lived != 0, online != 0, exp, passcode_hash IS NOT NULL,
                    remaining_attempts, bundle IS NOT NULL, created_at
             FROM links WHERE lid = ?1",
            params![lid],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, bool>(2)?,
                    r.get::<_, bool>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                    r.get::<_, bool>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                    r.get::<_, bool>(7)?,
                    r.get::<_, i64>(8)?,
                ))
            },
        )
        .ok()?;
    build_link_resource_from_row(
        conn, origin, row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8,
    )
}

/// `GET /sample` and `GET /sample/passcode`: 302 to the current sample in the viewer. The sample's
/// link changes whenever it is re-seeded; this address doesn't.
pub async fn sample_redirect(state: &AppState, headers: &HeaderMap, passcode: bool) -> Response {
    let link = state
        .demo_shares
        .lock()
        .unwrap()
        .iter()
        .find(|d| d.passcode_hint.is_some() == passcode)
        .and_then(|d| d.shlink_uri.find("shlink:/").map(|i| d.shlink_uri[i..].to_string()));
    let Some(link) = link else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "this server has no sample" }))).into_response();
    };
    let origin = request_origin(state, headers);
    Response::builder()
        .status(StatusCode::FOUND)
        .header(header::LOCATION, format!("{}/view#{link}", origin.trim_end_matches('/')))
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::empty())
        .unwrap()
}

pub async fn get_sample(State(state): State<AppState>, headers: HeaderMap) -> Response {
    sample_redirect(&state, &headers, false).await
}

pub async fn get_sample_passcode(State(state): State<AppState>, headers: HeaderMap) -> Response {
    sample_redirect(&state, &headers, true).await
}
