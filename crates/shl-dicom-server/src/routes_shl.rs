use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{TimeZone, Utc};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::json;
use crate::storage::{ReadDelivery, ReadError};
use crate::state::{
    hash_passcode, is_valid_id22, now_unix, parse_file_name, AccessEvent, AppState,
};

#[derive(Debug, Deserialize, Default)]
pub struct RecipientQuery {
    pub recipient: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct ManifestRequest {
    pub recipient: Option<String>,
    pub passcode: Option<String>,
}

pub fn request_origin(headers: &HeaderMap) -> String {
    let proto = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("http");
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("localhost:3000");
    format!("{proto}://{host}")
}

/// `GET /shl/{lid}/{tail}` where `{tail}` is either `bundle.jwe` or `{fileId}.bin`.
pub async fn get_shl_file(
    State(state): State<AppState>,
    Path((lid, tail)): Path<(String, String)>,
    Query(query): Query<RecipientQuery>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    if !is_valid_id22(&lid) {
        return not_found();
    }
    let Some(sid) = state.lookup_sid_by_lid(&lid) else {
        return not_found();
    };
    let path_str = format!("/shl/{lid}/{tail}");
    if tail == "bundle.jwe" {
        serve_bundle(&state, &sid, &lid, false, &path_str, query.recipient, &headers).await
    } else if let Some(file_id) = parse_file_name(&tail) {
        serve_series_file(
            &state,
            &sid,
            &lid,
            file_id,
            false,
            &path_str,
            query.recipient,
            method == Method::HEAD,
            &headers,
        )
        .await
    } else {
        not_found()
    }
}

/// `POST /shl/{lid}` — Manifest / passcode endpoint.
pub async fn post_shl_manifest(
    State(state): State<AppState>,
    Path(lid): Path<String>,
    headers: HeaderMap,
    body: Option<Json<ManifestRequest>>,
) -> Response {
    if !is_valid_id22(&lid) {
        return not_found();
    }
    let Some(sid) = state.lookup_sid_by_lid(&lid) else {
        return not_found();
    };
    let Some(conn_arc) = state.open_share_db(&sid) else {
        return not_found();
    };

    let req = body.map(|b| b.0).unwrap_or_default();
    let origin = request_origin(&headers);
    let now = now_unix();
    let path_str = format!("/shl/{lid}");

    let outcome = {
        let mut conn = conn_arc.lock().unwrap();
        let tx = match conn.transaction() {
            Ok(t) => t,
            Err(_) => return not_found(),
        };

        let row: Option<(bool, Option<i64>, bool, Option<Vec<u8>>, Option<Vec<u8>>, bool, Option<i64>)> = tx
            .query_row(
                "SELECT online != 0, exp, long_lived != 0, passcode_salt, passcode_hash,
                        bundle IS NOT NULL, bundle_updated_at
                 FROM links WHERE lid = ?1",
                params![lid],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                    ))
                },
            )
            .optional()
            .unwrap_or(None);

        let Some((online, exp, long_lived, salt_opt, hash_opt, has_bundle, updated_at)) = row else {
            return not_found();
        };

        if !online || !has_bundle || exp.is_some_and(|e| e <= now) {
            return not_found();
        }

        if let (Some(salt), Some(expected_hash)) = (salt_opt, hash_opt) {
            // Atomically decrement remaining_attempts before checking passcode
            let rem_opt: Option<i64> = tx
                .query_row(
                    "UPDATE links SET remaining_attempts = remaining_attempts - 1
                     WHERE lid = ?1 AND remaining_attempts > 0
                     RETURNING remaining_attempts",
                    params![lid],
                    |r| r.get(0),
                )
                .optional()
                .unwrap_or(None);

            let Some(remaining) = rem_opt else {
                let _ = tx.commit();
                return not_found();
            };

            let provided = req.passcode.as_deref().unwrap_or("");
            let actual_hash = hash_passcode(&salt, provided);
            if actual_hash.as_slice() != expected_hash.as_slice() {
                let _ = tx.commit();
                drop(conn);
                state.record_access(
                    &sid,
                    AccessEvent {
                        ts: now,
                        lid: Some(lid),
                        method: "POST".into(),
                        path: path_str,
                        range: None,
                        status: 401,
                        bytes: 0,
                        recipient: req.recipient,
                    },
                );
                return (
                    StatusCode::UNAUTHORIZED,
                    Json(json!({
                        "error": "invalid passcode",
                        "remainingAttempts": remaining,
                    })),
                )
                    .into_response();
            }

            // Passcode matched: restore the attempt in the same transaction
            let _ = tx.execute(
                "UPDATE links SET remaining_attempts = remaining_attempts + 1 WHERE lid = ?1",
                params![lid],
            );
        }

        if tx.commit().is_err() {
            return not_found();
        }
        (long_lived, updated_at)
    };

    let (long_lived, updated_at) = outcome;
    let Ok(cap_token) = state.mint_cap(&lid, state.quotas.cap_ttl_secs) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "failed to mint cap").into_response();
    };

    let last_updated_iso = Utc
        .timestamp_opt(updated_at.unwrap_or(now), 0)
        .single()
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| "2026-10-14T00:00:00Z".to_string());

    let mut manifest = json!({
        "files": [{
            "contentType": "application/fhir+json;fhirVersion=4.0.1",
            "location": format!("{}/cap/{}/bundle.jwe", origin.trim_end_matches('/'), cap_token),
            "lastUpdated": last_updated_iso,
        }]
    });
    if long_lived {
        manifest["status"] = json!("can-change");
    }

    let body_bytes = serde_json::to_vec(&manifest).unwrap_or_default();
    state.record_access(
        &sid,
        AccessEvent {
            ts: now,
            lid: Some(lid),
            method: "POST".into(),
            path: path_str,
            range: None,
            status: 200,
            bytes: body_bytes.len() as u64,
            recipient: req.recipient,
        },
    );

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Body::from(body_bytes))
        .unwrap()
}

/// `GET /cap/{token}/{tail}` where `{tail}` is `bundle.jwe` or `{fileId}.bin`.
pub async fn get_cap_file(
    State(state): State<AppState>,
    Path((token, tail)): Path<(String, String)>,
    Query(query): Query<RecipientQuery>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let Some((sid, lid)) = state.lookup_cap(&token) else {
        return not_found();
    };
    let path_str = format!("/cap/{token}/{tail}");
    if tail == "bundle.jwe" {
        serve_bundle(&state, &sid, &lid, true, &path_str, query.recipient, &headers).await
    } else if let Some(file_id) = parse_file_name(&tail) {
        serve_series_file(
            &state,
            &sid,
            &lid,
            file_id,
            true,
            &path_str,
            query.recipient,
            method == Method::HEAD,
            &headers,
        )
        .await
    } else {
        not_found()
    }
}

async fn serve_bundle(
    state: &AppState,
    sid: &str,
    lid: &str,
    via_cap: bool,
    path_str: &str,
    recipient: Option<String>,
    headers: &HeaderMap,
) -> Response {
    let Some(conn_arc) = state.open_share_db(sid) else {
        return not_found();
    };
    let now = now_unix();
    let row: Option<(bool, Option<i64>, bool, Option<Vec<u8>>, Option<String>)> = {
        let conn = conn_arc.lock().unwrap();
        conn.query_row(
            "SELECT online != 0, exp, passcode_hash IS NOT NULL, bundle, bundle_etag
             FROM links WHERE lid = ?1",
            params![lid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .unwrap_or(None)
    };

    let Some((online, exp, has_passcode, Some(bundle_bytes), etag_opt)) = row else {
        return not_found();
    };

    if !online || exp.is_some_and(|e| e <= now) || (!via_cap && has_passcode) {
        return not_found();
    }

    let etag = etag_opt.unwrap_or_else(|| "\"v1\"".to_string());
    if let Some(inm) = headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) {
        if inm.trim() == etag {
            state.record_access(
                sid,
                AccessEvent {
                    ts: now,
                    lid: Some(lid.to_string()),
                    method: "GET".into(),
                    path: path_str.to_string(),
                    range: None,
                    status: 304,
                    bytes: 0,
                    recipient,
                },
            );
            return Response::builder()
                .status(StatusCode::NOT_MODIFIED)
                .header(header::ETAG, etag)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "ETag, Content-Length")
                .body(Body::empty())
                .unwrap();
        }
    }

    state.record_access(
        sid,
        AccessEvent {
            ts: now,
            lid: Some(lid.to_string()),
            method: "GET".into(),
            path: path_str.to_string(),
            range: None,
            status: 200,
            bytes: bundle_bytes.len() as u64,
            recipient,
        },
    );

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/jose")
        .header(header::CONTENT_LENGTH, bundle_bytes.len().to_string())
        .header(header::ETAG, etag)
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "ETag, Content-Length")
        .body(Body::from(bundle_bytes))
        .unwrap()
}

#[allow(clippy::too_many_arguments)]
async fn serve_series_file(
    state: &AppState,
    sid: &str,
    lid: &str,
    file_id: &str,
    via_cap: bool,
    path_str: &str,
    recipient: Option<String>,
    head: bool,
    headers: &HeaderMap,
) -> Response {
    let Some(conn_arc) = state.open_share_db(sid) else {
        return not_found();
    };
    let now = now_unix();
    let range_hdr_str = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(String::from);

    // The link must allow the file; then its size and where its bytes are.
    let (file_size, key): (u64, String) = {
        let conn = conn_arc.lock().unwrap();
        let link_ok: Option<(bool, Option<i64>, bool)> = conn
            .query_row(
                "SELECT l.online != 0, l.exp, l.passcode_hash IS NOT NULL
                 FROM links l
                 JOIN link_files lf ON lf.lid = l.lid
                 WHERE l.lid = ?1 AND lf.file_id = ?2",
                params![lid, file_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .unwrap_or(None);

        let Some((online, exp, has_passcode)) = link_ok else {
            return not_found();
        };
        if !online || exp.is_some_and(|e| e <= now) || (!via_cap && has_passcode) {
            return not_found();
        }

        let row: Option<(i64, String)> = conn
            .query_row("SELECT size, storage_key FROM files WHERE file_id = ?1", params![file_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .unwrap_or(None);
        let Some((sz, key)) = row else {
            return not_found();
        };
        (sz as u64, key)
    };

    if file_size == 0 {
        return not_found();
    }

    let parsed_range = match range_hdr_str.as_deref() {
        Some(hdr) => match parse_single_http_range(hdr, file_size) {
            Ok(Some((a, b))) => Some((a, b)),
            Ok(None) => None,
            Err(()) => {
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{file_size}"))
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .body(Body::empty())
                    .unwrap();
            }
        },
        None => None,
    };

    let (start_byte, end_byte_inclusive, status_code) = match parsed_range {
        Some((a, b)) => (a, b, StatusCode::PARTIAL_CONTENT),
        None => (0, file_size - 1, StatusCode::OK),
    };

    let len = end_byte_inclusive - start_byte + 1;
    let mut builder = Response::builder()
        .status(status_code)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, len.to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        // Share data is kept in memory only, never across page loads (Josh, 16 Oct): no browser
        // or shared cache stores encrypted files.
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Content-Range, Content-Length, Accept-Ranges",
        );
    if status_code == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!(
                "bytes {start_byte}-{end_byte_inclusive}/{file_size}"
            ))
            .unwrap(),
        );
    }
    // HEAD is answered here, in every mode (a presigned URL is for GET only).
    if head {
        return builder.body(Body::empty()).unwrap();
    }

    // The store streams the range, or names a presigned URL to send the reader to.
    let delivery = match state.store.read_range(&key, start_byte, end_byte_inclusive).await {
        Ok(d) => d,
        Err(ReadError::NotFound) => {
            eprintln!("read {key}: not in the store");
            return not_found();
        }
        Err(ReadError::Failed(e)) => {
            eprintln!("read {key}: {e}");
            return Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Body::empty())
                .unwrap();
        }
    };

    state.record_access(
        sid,
        AccessEvent {
            ts: now,
            lid: Some(lid.to_string()),
            method: "GET".into(),
            path: path_str.to_string(),
            range: range_hdr_str,
            status: status_code.as_u16(),
            bytes: len,
            recipient,
        },
    );

    let body = match delivery {
        ReadDelivery::Stream(s) => Body::from_stream(s),
        // Redirect mode: the browser repeats its Range request to the presigned URL. The access
        // log records the requested bytes.
        ReadDelivery::Redirect(url) => {
            return Response::builder()
                .status(StatusCode::TEMPORARY_REDIRECT)
                .header(header::LOCATION, url)
                .header(header::CACHE_CONTROL, "no-store")
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Body::empty())
                .unwrap();
        }
    };
    builder.body(body).unwrap()
}

/// Parses a single HTTP `Range: bytes=a-b` header.
/// Returns `Err(())` (`416`) if the range is invalid or out of bounds.
/// Multi-range requests are rejected with `Err(())` (`416`) or ignored per §10.1.
fn parse_single_http_range(hdr: &str, file_size: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(rest) = hdr.trim().strip_prefix("bytes=") else {
        return Ok(None);
    };
    if rest.contains(',') {
        // Reject multi-range requests
        return Err(());
    }
    let Some((start_s, end_s)) = rest.split_once('-') else {
        return Err(());
    };
    let start_s = start_s.trim();
    let end_s = end_s.trim();

    if start_s.is_empty() {
        // Suffix range `bytes=-N`
        let suffix: u64 = end_s.parse().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        let start = file_size.saturating_sub(suffix);
        Ok(Some((start, file_size - 1)))
    } else {
        let start: u64 = start_s.parse().map_err(|_| ())?;
        if start >= file_size {
            return Err(());
        }
        let end: u64 = if end_s.is_empty() {
            file_size - 1
        } else {
            end_s.parse::<u64>().map_err(|_| ())?.min(file_size - 1)
        };
        if start > end {
            return Err(());
        }
        Ok(Some((start, end)))
    }
}

fn not_found() -> Response {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Body::from("Not Found"))
        .unwrap()
}
