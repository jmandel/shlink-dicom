pub mod cli;
pub mod compress;
pub mod routes_api;
pub mod routes_shl;
pub mod sample_pack;
pub mod seed;
pub mod state;
pub mod storage;

use axum::{
    extract::DefaultBodyLimit,
    http::{header, HeaderName, Method},
    routing::{get, patch, post, put},
    Router,
};
use tower_http::{
    cors::{Any, CorsLayer},
    services::{ServeDir, ServeFile},
};
use crate::state::AppState;

pub fn build_app_router(state: AppState) -> Router {
    let limit = std::sync::Arc::new(tokio::sync::Semaphore::new(state.quotas.max_requests));
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::HEAD,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            header::RANGE,
            header::IF_NONE_MATCH,
            HeaderName::from_static("x-expected-size"),
            HeaderName::from_static("upload-offset"),
            HeaderName::from_static("upload-complete"),
            HeaderName::from_static("upload-length"),
        ])
        .expose_headers([
            header::CONTENT_RANGE,
            header::CONTENT_LENGTH,
            header::ACCEPT_RANGES,
            header::ETAG,
            header::LOCATION,
            HeaderName::from_static("upload-offset"),
            HeaderName::from_static("upload-complete"),
            HeaderName::from_static("upload-length"),
            HeaderName::from_static("upload-limit"),
        ]);

    // web/build.ts writes .br and .gz copies of compressible files; browsers that accept them get them.
    let serve_dir = ServeDir::new("dist/web")
        .precompressed_br()
        .precompressed_gzip()
        .not_found_service(ServeFile::new("dist/web/index.html").precompressed_br().precompressed_gzip());
    // Experience pages (see docs/EXPERIENCES.md "Routes"). Served without a trailing-slash
    // redirect so `/view#shlink:/…` loads in one request; the pages use relative asset paths.
    let page = |p: &str| ServeFile::new(format!("dist/web/{p}/index.html")).precompressed_br().precompressed_gzip();

    Router::new()
        // Zero-Knowledge Share & Link Control API
        // Bodies anyone can send without a token stay small.
        .route("/api/shares", post(routes_api::create_share).layer(DefaultBodyLimit::max(SMALL_BODY)))
        .route("/api/shares/{sid}/clone", post(routes_api::clone_share))
        .route(
            "/api/shares/{sid}",
            get(routes_api::get_share)
                .patch(routes_api::patch_share)
                .delete(routes_api::delete_share),
        )
        .route(
            "/api/shares/{sid}/owner.jwe",
            put(routes_api::put_owner_bundle).get(routes_api::get_owner_bundle),
        )
        .route(
            "/api/shares/{sid}/files/{name}",
            put(routes_api::put_share_file)
                .patch(routes_api::patch_share_file)
                .head(routes_api::head_share_file)
                .delete(routes_api::delete_share_file),
        )
        .route("/api/shares/{sid}/links", post(routes_api::create_link))
        .route(
            "/api/shares/{sid}/links/{lid}/bundle.jwe",
            put(routes_api::put_link_bundle),
        )
        .route("/api/shares/{sid}/links/{lid}/bundle", get(routes_api::get_link_bundle))
        .route(
            "/api/shares/{sid}/links/{lid}",
            patch(routes_api::patch_link).delete(routes_api::delete_link),
        )
        .route(
            "/api/shares/{sid}/links/{lid}/end-sessions",
            post(routes_api::end_link_sessions),
        )
        .route("/api/shares/{sid}/access", get(routes_api::get_share_access))
        .route("/api/shares/{sid}/events", get(routes_api::get_share_events))
        .route("/api/demo-shares", get(routes_api::get_demo_shares))
        // A stable address for the current sample, whatever its link is after a re-seed.
        .route("/sample", get(routes_api::get_sample))
        .route("/sample/passcode", get(routes_api::get_sample_passcode))
        // Receiver-facing SHL & Capability Range Routes
        .route("/shl/{lid}", post(routes_shl::post_shl_manifest).layer(DefaultBodyLimit::max(SMALL_BODY)))
        .route("/shl/{lid}/{tail}", get(routes_shl::get_shl_file))
        .route("/cap/{token}/{tail}", get(routes_shl::get_cap_file))
        // Experiences: landing (/), View, How it works, Share
        .route_service("/view", page("view"))
        .route_service("/view/", page("view"))
        .route_service("/how", page("how"))
        .route_service("/how/", page("how"))
        .route_service("/share", page("share"))
        .route_service("/share/", page("share"))
        .route_service("/share/manage", page("share/manage"))
        .route_service("/share/manage/", page("share/manage"))
        // Static files (assets, config.json); unknown paths get the landing page
        .fallback_service(serve_dir)
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024)) // JSON and JWE bodies; encrypted files stream (routes_api::put_share_file)
        .layer(axum::middleware::from_fn(static_cache))
        .layer(cors)
        .layer(axum::middleware::from_fn(security_headers))
        .layer(axum::middleware::from_fn_with_state(limit, at_most))
        .with_state(state)
}

/// Largest body of a request that needs no token (creating a share, asking for a manifest).
pub const SMALL_BODY: usize = 16 * 1024;

/// At most `max_requests` requests in a handler at once; past that, 503 with Retry-After at once
/// rather than a queue. (A response body that streams after its handler has returned, such as a
/// file read, no longer holds its place.)
async fn at_most(
    axum::extract::State(limit): axum::extract::State<std::sync::Arc<tokio::sync::Semaphore>>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let Ok(_permit) = limit.try_acquire() else {
        return axum::response::Response::builder()
            .status(axum::http::StatusCode::SERVICE_UNAVAILABLE)
            .header(header::RETRY_AFTER, "5")
            .body(axum::body::Body::from("the server is busy; try again shortly"))
            .unwrap();
    };
    next.run(req).await
}

/// On every response: send no Referer onward (link URLs carry keys in their fragment and ids in
/// their path), and have browsers use the Content-Type as given.
async fn security_headers(req: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(header::REFERRER_POLICY, axum::http::HeaderValue::from_static("no-referrer"));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, axum::http::HeaderValue::from_static("nosniff"));
    res
}

/// Cache-Control for the site's own files (the API and SHL routes set their own). Assets named
/// with their content hash (`?v=` from web/build.ts, or a `chunk-<hash>.js` name) never change,
/// so browsers keep them for a year without asking; everything else is checked on each use
/// (`no-cache`, answered with 304 when unchanged).
async fn static_cache(req: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
    let path = req.uri().path().to_owned();
    let versioned = req.uri().query().is_some_and(|q| q.split('&').any(|kv| kv.starts_with("v=")));
    let mut res = next.run(req).await;
    let own = ["/api/", "/shl/", "/cap/", "/sample"].iter().any(|p| path.starts_with(p));
    if own || res.headers().contains_key(header::CACHE_CONTROL) {
        return res;
    }
    let immutable = res.status().is_success()
        && path.starts_with("/assets/")
        && (versioned || path.rsplit('/').next().is_some_and(|f| f.starts_with("chunk-") && f.ends_with(".js")));
    let value = if immutable { "public, max-age=31536000, immutable" } else { "no-cache" };
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, axum::http::HeaderValue::from_static(value));
    // The .br/.gz copies are chosen by Accept-Encoding.
    h.append(header::VARY, axum::http::HeaderValue::from_static("accept-encoding"));
    res
}
