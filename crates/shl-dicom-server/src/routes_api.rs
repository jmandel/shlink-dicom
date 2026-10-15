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
        parse_series_filename, sha256_bytes, write_series_file_to_db, AccessEvent, AppState,
        DEFAULT_PASSCODE_ATTEMPTS, DEFAULT_SANDBOX_TTL_SECS,
    },
};

fn extract_bearer(headers: &HeaderMap) -> Option<&str> {
    let auth = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    auth.strip_prefix("Bearer ").map(str::trim)
}

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

/// `POST /api/shares`
pub async fn create_share(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let expires_at = Some(now_unix() + DEFAULT_SANDBOX_TTL_SECS);
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

    let origin = request_origin(&headers);
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

    // Copy series_files and series_records from source share to new sandbox share
    let copy_res: Result<(), String> = (|| {
        let src_conn = src_conn_arc.lock().unwrap();
        let mut dst_conn = dst_conn_arc.lock().unwrap();
        let _ = dst_conn.execute_batch("PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY;");
        let tx = dst_conn.transaction().map_err(|e| e.to_string())?;

        let mut stmt_files = src_conn
            .prepare("SELECT file_id, size, uploaded_at FROM series_files")
            .map_err(|e| e.to_string())?;
        let file_rows = stmt_files
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        for f in file_rows {
            let (fid, sz, up) = f.map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO series_files (file_id, size, uploaded_at) VALUES (?1, ?2, ?3)",
                params![fid, sz, up],
            )
            .map_err(|e| e.to_string())?;
        }

        let mut stmt_recs = src_conn
            .prepare("SELECT file_id, idx, bytes FROM series_records")
            .map_err(|e| e.to_string())?;
        let rec_rows = stmt_recs
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Vec<u8>>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        {
            let mut insert_rec = tx
                .prepare("INSERT INTO series_records (file_id, idx, bytes) VALUES (?1, ?2, ?3)")
                .map_err(|e| e.to_string())?;
            for rec in rec_rows {
                let (fid, idx, bytes) = rec.map_err(|e| e.to_string())?;
                insert_rec
                    .execute(params![fid, idx, bytes])
                    .map_err(|e| e.to_string())?;
            }
        }

        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })();

    if let Err(e) = copy_res {
        let _ = state.delete_share(&new_sid);
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        )
            .into_response();
    }

    let origin = request_origin(&headers);
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
    let origin = request_origin(&headers);
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

/// `PUT /api/shares/{sid}/files/{name}`
pub async fn put_share_file(
    State(state): State<AppState>,
    Path((sid, name)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(resp) = require_auth(&state, &sid, &headers) {
        return resp;
    }
    let Some(file_id) = parse_series_filename(&name) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "file name must match ^[A-Za-z0-9_-]{22}\\.bin$" })),
        )
            .into_response();
    };

    if body.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "series file body must not be empty" })),
        )
            .into_response();
    }

    if let Some(exp_hdr) = headers.get("x-expected-size").and_then(|v| v.to_str().ok()) {
        let Ok(expected_size) = exp_hdr.parse::<usize>() else {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "invalid X-Expected-Size header" })),
            )
                .into_response();
        };
        if body.len() != expected_size {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": format!("size mismatch: X-Expected-Size={}, got={}", expected_size, body.len())
                })),
            )
                .into_response();
        }
    }

    let Some(conn_arc) = state.open_share_db(&sid) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let res = {
        let mut conn = conn_arc.lock().unwrap();
        write_series_file_to_db(
            &mut conn,
            file_id,
            &body,
            state.bytes_max,
            state.files_max,
        )
    };

    match res {
        Ok(entry) => (StatusCode::OK, Json(entry)).into_response(),
        Err(e) if e == "QUOTA_BYTES_EXCEEDED" || e == "QUOTA_FILES_EXCEEDED" => (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({ "error": e })),
        )
            .into_response(),
        Err(e) if e == "IMMUTABLE_FILE_ID_CONFLICT" => (
            StatusCode::CONFLICT,
            Json(json!({ "error": "fileId already exists with different content size" })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        )
            .into_response(),
    }
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
    let Some(file_id) = parse_series_filename(&name) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid file name" })),
        )
            .into_response();
    };
    let Some(conn_arc) = state.open_share_db(&sid) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let res = {
        let conn = conn_arc.lock().unwrap();
        conn.execute("DELETE FROM series_files WHERE file_id = ?1", params![file_id])
    };

    match res {
        Ok(0) => StatusCode::NOT_FOUND.into_response(),
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(rusqlite::Error::SqliteFailure(err, _))
            if err.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY =>
        {
            (
                StatusCode::CONFLICT,
                Json(json!({ "error": "file is still referenced by one or more links" })),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
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
        let Some(fid) = parse_series_filename(fname) else {
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

    let origin = request_origin(&headers);
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
    let origin = request_origin(&headers);

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

    let origin = request_origin(&headers);
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
            let Some(fid) = parse_series_filename(fname) else {
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
    // Rule: delete from catalog first (which cascades to caps), then from share DB.
    let _ = state.remove_link_from_catalog(&lid);
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
    match state.revoke_caps_for_link(&lid) {
        Ok(revoked_count) => (
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
    let Some(conn_arc) = state.open_share_db(&sid) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let since = query.since.unwrap_or(0);
    let conn = conn_arc.lock().unwrap();
    let mut stmt = match conn.prepare(
        "SELECT ts, lid, method, path, range, status, bytes, recipient
         FROM access_log WHERE ts >= ?1 ORDER BY ts DESC LIMIT 500",
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
        .query_map(params![since], |r| {
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
    let origin = request_origin(&headers);
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
