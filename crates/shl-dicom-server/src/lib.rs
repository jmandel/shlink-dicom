pub mod cli;
pub mod routes_api;
pub mod routes_shl;
pub mod seed;
pub mod state;

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
            Method::OPTIONS,
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            header::RANGE,
            header::IF_NONE_MATCH,
            HeaderName::from_static("x-expected-size"),
        ])
        .expose_headers([
            header::CONTENT_RANGE,
            header::CONTENT_LENGTH,
            header::ACCEPT_RANGES,
            header::ETAG,
        ]);

    let serve_dir = ServeDir::new("dist/web")
        .not_found_service(ServeFile::new("dist/web/index.html"));

    Router::new()
        // Zero-Knowledge Share & Link Control API
        .route("/api/shares", post(routes_api::create_share))
        .route("/api/shares/{sid}/clone", post(routes_api::clone_share))
        .route(
            "/api/shares/{sid}",
            get(routes_api::get_share).delete(routes_api::delete_share),
        )
        .route(
            "/api/shares/{sid}/owner.jwe",
            put(routes_api::put_owner_bundle).get(routes_api::get_owner_bundle),
        )
        .route(
            "/api/shares/{sid}/files/{name}",
            put(routes_api::put_share_file).delete(routes_api::delete_share_file),
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
        // Receiver-facing SHL & Capability Range Routes
        .route("/shl/{lid}", post(routes_shl::post_shl_manifest))
        .route("/shl/{lid}/{tail}", get(routes_shl::get_shl_file))
        .route("/cap/{token}/{tail}", get(routes_shl::get_cap_file))
        // Fallback to static web UI
        .fallback_service(serve_dir)
        .layer(DefaultBodyLimit::max(200 * 1024 * 1024))
        .layer(cors)
        .with_state(state)
}
