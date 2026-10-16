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

    let serve_dir = ServeDir::new("dist/web")
        .not_found_service(ServeFile::new("dist/web/index.html"));
    // Experience pages (see docs/EXPERIENCES.md "Routes"). Served without a trailing-slash
    // redirect so `/view#shlink:/…` loads in one request; the pages use relative asset paths.
    let page = |p: &str| ServeFile::new(format!("dist/web/{p}/index.html"));

    Router::new()
        // Zero-Knowledge Share & Link Control API
        .route("/api/shares", post(routes_api::create_share))
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
        .route("/shl/{lid}", post(routes_shl::post_shl_manifest))
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
        .layer(cors)
        .with_state(state)
}
