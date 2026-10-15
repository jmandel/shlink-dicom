use rusqlite::params;
use shl_dicom_core::{
    crypto::{b64url_encode, random_bytes},
    jwe::encrypt_bundle_jwe,
    packer::{build_link_bundle, IngestSession},
    shl::{compute_shl_flag, encode_shlink_uri, ShlPayload},
};
use crate::state::{
    hash_passcode, now_unix, sha256_bytes, write_series_file_to_db, AppState, DemoShareInfo,
    DEFAULT_PASSCODE_ATTEMPTS,
};

const SEED_VERSION: u32 = 3;

/// Title and description of the sample share, from `samples/sample.json` when present.
#[derive(serde::Deserialize)]
struct SampleMeta {
    title: String,
    description: String,
}

fn sample_meta(state: &AppState) -> SampleMeta {
    std::fs::read_to_string(state.data_dir.join("samples").join("sample.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| SampleMeta {
            title: "Brain MRI + Wrist".into(),
            description: "2 studies (Brain MRI 14 series + Wrist X-Ray 3 series). Streams slices via HTTP 206 Range requests.".into(),
        })
}

#[derive(serde::Serialize, serde::Deserialize)]
struct PersistedSeed {
    version: u32,
    sid: String,
    lid_u: String,
    key_u: String,
    lid_p: String,
    key_p: String,
}

pub fn seed_demo_shares(state: &AppState, origin: &str) -> Result<(), String> {
    let seed_meta_path = state.data_dir.join("seeded_demos.json");
    if seed_meta_path.exists() {
        if let Ok(text) = std::fs::read_to_string(&seed_meta_path) {
            if let Ok(saved) = serde_json::from_str::<PersistedSeed>(&text) {
                if saved.version == SEED_VERSION
                    && state.catalog_has_share(&saved.sid)
                    && populate_demo_list(state, origin, &saved).is_ok()
                {
                    return Ok(());
                }
            }
        }
    }

    let samples_dir = state.data_dir.join("samples");
    std::fs::create_dir_all(&samples_dir).map_err(|e| e.to_string())?;

    // Every .tgz in samples/, in name order.
    let mut tgzs: Vec<_> = std::fs::read_dir(&samples_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "tgz"))
        .collect();
    if tgzs.is_empty() {
        return Ok(());
    }
    tgzs.sort();

    let mut ingest = IngestSession::new();
    for path in &tgzs {
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        ingest.ingest_tar_gz(&bytes).map_err(|e| e.to_string())?;
    }

    let packed = ingest
        .pack("2026-10-14T16:00:00Z")
        .map_err(|e| e.to_string())?;

    let meta = sample_meta(state);
    let (sid, _ctrl) = state.create_share(true, None)?;
    let conn_arc = state.open_share_db(&sid).ok_or("failed to open demo share DB")?;

    let mut all_allowed_files = Vec::new();
    {
        let mut conn = conn_arc.lock().unwrap();
        let _ = conn.execute_batch("PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY;");
        let owner_key = random_bytes::<32>().map_err(|e| e.to_string())?;
        let owner_jwe = encrypt_bundle_jwe(packed.owner_bundle_json.as_bytes(), &owner_key)
            .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE share SET owner_bundle = ?1, owner_updated_at = ?2 WHERE id = 1",
            params![owner_jwe.as_bytes(), now_unix()],
        )
        .map_err(|e| e.to_string())?;

        for sf in &packed.series_files {
            write_series_file_to_db(
                &mut conn,
                &sf.file_id,
                &sf.ciphertext,
                state.bytes_max,
                state.files_max,
            )?;
            all_allowed_files.push(sf.file_id.clone());
        }
    }

    // Link 1: U-mode Brain MRI + Wrist link
    let lid_u = b64url_encode(&random_bytes::<16>().unwrap());
    let key_u = random_bytes::<32>().unwrap();
    let bundle_u = build_link_bundle(
        &packed.owner_bundle_json,
        &[],
        &key_u,
        "2026-10-14T16:00:00Z",
    )
    .map_err(|e| e.to_string())?;

    insert_seeded_link(
        state,
        &sid,
        &lid_u,
        &format!("{} (Direct Link)", meta.title),
        false,
        None,
        &bundle_u.bundle_jwe,
        &all_allowed_files,
    )?;

    // Link 2: Passcode-protected + Long-Lived manifest link ("LP", passcode "1234")
    let lid_p = b64url_encode(&random_bytes::<16>().unwrap());
    let key_p = random_bytes::<32>().unwrap();
    let bundle_p = build_link_bundle(
        &packed.owner_bundle_json,
        &[],
        &key_p,
        "2026-10-14T16:00:00Z",
    )
    .map_err(|e| e.to_string())?;

    insert_seeded_link(
        state,
        &sid,
        &lid_p,
        &format!("{} (Passcode: 1234)", meta.title),
        true,
        Some("1234"),
        &bundle_p.bundle_jwe,
        &all_allowed_files,
    )?;

    let saved = PersistedSeed {
        version: SEED_VERSION,
        sid,
        lid_u,
        key_u: bundle_u.shl_key_b64,
        lid_p,
        key_p: bundle_p.shl_key_b64,
    };
    let _ = std::fs::write(
        &seed_meta_path,
        serde_json::to_string_pretty(&saved).unwrap_or_default(),
    );
    populate_demo_list(state, origin, &saved)?;
    Ok(())
}

fn populate_demo_list(
    state: &AppState,
    origin: &str,
    saved: &PersistedSeed,
) -> Result<(), String> {
    let meta = sample_meta(state);
    let clean_origin = origin.trim_end_matches('/');
    let shlink_u = encode_shlink_uri(
        &ShlPayload {
            url: format!("{clean_origin}/shl/{}/bundle.jwe", saved.lid_u),
            key: saved.key_u.clone(),
            exp: None,
            flag: compute_shl_flag(false, false),
            label: Some(meta.title.clone()),
            v: Some(1),
        },
        Some(&format!("{clean_origin}/")),
    )
    .map_err(|e| e.to_string())?;

    let shlink_p = encode_shlink_uri(
        &ShlPayload {
            url: format!("{clean_origin}/shl/{}", saved.lid_p),
            key: saved.key_p.clone(),
            exp: None,
            flag: compute_shl_flag(true, true),
            label: Some("Passcode Demo (1234)".into()),
            v: Some(1),
        },
        Some(&format!("{clean_origin}/")),
    )
    .map_err(|e| e.to_string())?;

    let share_res = state
        .build_share_resource(&saved.sid, origin)
        .ok_or("missing seeded share resource")?;
    let mut demos = state.demo_shares.lock().unwrap();
    demos.clear();
    demos.push(DemoShareInfo {
        id: saved.sid.clone(),
        title: meta.title,
        description: meta.description,
        shlink_uri: shlink_u,
        passcode_hint: None,
        read_only: true,
        share: share_res.clone(),
    });
    demos.push(DemoShareInfo {
        id: saved.sid.clone(),
        title: "Passcode Demo (1234)".into(),
        description: "Manifest-mode link protected by passcode '1234'. Mints 1-hour /cap/{token}/ URLs.".into(),
        shlink_uri: shlink_p,
        passcode_hint: Some("1234".into()),
        read_only: true,
        share: share_res,
    });
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_seeded_link(
    state: &AppState,
    sid: &str,
    lid: &str,
    label: &str,
    long_lived: bool,
    passcode: Option<&str>,
    bundle_jwe: &str,
    file_ids: &[String],
) -> Result<(), String> {
    let conn_arc = state.open_share_db(sid).ok_or("missing share db")?;
    let now = now_unix();
    let etag_hash = sha256_bytes(bundle_jwe.as_bytes());
    let etag = format!("\"{}\"", b64url_encode(&etag_hash[..16]));

    let (salt_opt, hash_opt, rem_opt) = if let Some(p) = passcode {
        let salt = random_bytes::<16>().unwrap();
        let h = hash_passcode(&salt, p);
        (
            Some(salt.to_vec()),
            Some(h.to_vec()),
            Some(DEFAULT_PASSCODE_ATTEMPTS),
        )
    } else {
        (None, None, None)
    };

    {
        let mut conn = conn_arc.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO links (lid, label, long_lived, online, exp, passcode_salt, passcode_hash,
                                remaining_attempts, bundle, bundle_etag, bundle_updated_at, created_at)
             VALUES (?1, ?2, ?3, 1, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![
                lid,
                label,
                i64::from(long_lived),
                salt_opt,
                hash_opt,
                rem_opt,
                bundle_jwe.as_bytes(),
                etag,
                now
            ],
        )
        .map_err(|e| e.to_string())?;

        for fid in file_ids {
            tx.execute(
                "INSERT INTO link_files (lid, file_id) VALUES (?1, ?2)",
                params![lid, fid],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    state.register_link_in_catalog(sid, lid)?;
    Ok(())
}
