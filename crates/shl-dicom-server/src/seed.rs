use rusqlite::params;
use shl_dicom_core::{
    crypto::{b64url_encode, random_bytes},
    jwe::encrypt_bundle_jwe,
    packer::build_link_bundle,
    shl::{compute_shl_flag, encode_shlink_uri, ShlPayload},
};
use crate::sample_pack::pack_samples;
use crate::state::{
    hash_passcode, new_link_id, now_unix, sha256_bytes, AppState, DemoShareInfo,
    DEFAULT_PASSCODE_ATTEMPTS,
};

// 6: link ids of 32 random bytes.
// 7: the Bundle JWE carries cty application/fhir+json.
pub const SEED_VERSION: u32 = 7;

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
    /// Earlier samples, deleted by the server once it has loaded this one. The seed runs while the
    /// server still serves the previous sample, so it must not delete that one itself.
    #[serde(default)]
    retired: Vec<String>,
}

/// Loads the sample made by `shl-dicom-server seed` (`seeded_demos.json`). Never packs anything,
/// so a restart is immediate. Returns false when there is no sample.
pub fn load_sample(state: &AppState, origin: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(state.data_dir.join("seeded_demos.json")) else {
        return false;
    };
    let path = state.data_dir.join("seeded_demos.json");
    let Ok(mut saved) = serde_json::from_str::<PersistedSeed>(&text) else {
        return false;
    };
    if !(saved.version == SEED_VERSION && state.catalog_has_share(&saved.sid) && populate_demo_list(state, origin, &saved).is_ok()) {
        return false;
    }
    // This sample is served now: the ones it replaced go.
    if !saved.retired.is_empty() {
        for sid in std::mem::take(&mut saved.retired) {
            if sid != saved.sid {
                let _ = state.delete_share(&sid);
            }
        }
        let _ = std::fs::write(&path, serde_json::to_string_pretty(&saved).unwrap_or_default());
        state.empty_trash_soon();
    }
    true
}

/// What `seed_sample` did, for the CLI's report.
pub struct SeedReport {
    pub sid: String,
    /// Encrypted files written: one per study.
    pub files: usize,
    pub instances: usize,
    pub bytes: u64,
    /// Images re-encoded without loss, and their bytes before and after.
    pub compression: crate::compress::CompressStats,
    /// Multi-frame instances given a frame offset table.
    pub offset_tables_added: usize,
    /// Archive members that are not DICOM instances, with the reason.
    pub skipped: Vec<shl_dicom_core::dicom_io::Skipped>,
}

/// Packs `samples/*.tgz` (with `samples/reports.json`) into a new read-only sample share, streaming
/// one record at a time into the share's files, and makes its two links. Replaces an earlier sample.
pub fn seed_sample(state: &AppState) -> Result<SeedReport, String> {
    let samples_dir = state.data_dir.join("samples");
    let seed_meta_path = state.data_dir.join("seeded_demos.json");
    let previous = std::fs::read_to_string(&seed_meta_path).ok().and_then(|t| serde_json::from_str::<PersistedSeed>(&t).ok());

    let (sid, _ctrl) = state.create_share(true, None)?;
    let scratch = state.data_dir.join(format!("seed-scratch-{sid}"));
    let packed = match pack_samples(state, &sid, &samples_dir, &scratch, "2026-10-14T16:00:00Z") {
        Ok(p) => p,
        Err(e) => {
            let _ = state.delete_share(&sid);
            return Err(e);
        }
    };
    let owner_bundle_json = packed.owner_bundle_json.clone();
    let conn_arc = state.open_share_db(&sid).ok_or("failed to open the sample's database")?;
    {
        let conn = conn_arc.lock().unwrap();
        let owner_key = random_bytes::<32>().map_err(|e| e.to_string())?;
        let owner_jwe = encrypt_bundle_jwe(owner_bundle_json.as_bytes(), &owner_key).map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE share SET owner_bundle = ?1, owner_updated_at = ?2 WHERE id = 1",
            params![owner_jwe.as_bytes(), now_unix()],
        )
        .map_err(|e| e.to_string())?;
    }
    let meta = sample_meta(state);
    let all_allowed_files = packed.file_ids.clone();

    // Link 1: U-mode Brain MRI + Wrist link
    let lid_u = new_link_id();
    let key_u = random_bytes::<32>().unwrap();
    let bundle_u = build_link_bundle(
        &owner_bundle_json,
        None,
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
        false,
        &bundle_u.bundle_jwe,
        &all_allowed_files,
    )?;

    // Link 2: Passcode-protected + Long-Lived manifest link ("LP", passcode "1234")
    let lid_p = new_link_id();
    let key_p = random_bytes::<32>().unwrap();
    let bundle_p = build_link_bundle(
        &owner_bundle_json,
        None,
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
        // Its passcode is published, so wrong guesses must not lock it for everyone.
        true,
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
        // The earlier sample stays until the server has loaded this one (load_sample), so /sample
        // never points at a deleted share while the server still serves the earlier one.
        retired: previous
            .map(|p| p.retired.into_iter().chain(std::iter::once(p.sid)).collect())
            .unwrap_or_default(),
    };
    std::fs::write(&seed_meta_path, serde_json::to_string_pretty(&saved).unwrap_or_default()).map_err(|e| e.to_string())?;
    Ok(SeedReport {
        sid: saved.sid,
        files: packed.file_ids.len(),
        instances: packed.instances,
        bytes: packed.bytes,
        compression: packed.compression,
        offset_tables_added: packed.offset_tables_added,
        skipped: packed.skipped,
    })
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
        description: "Manifest-mode link protected by passcode '1234'. Mints 1-hour /cap/{token}/ URLs. Wrong passcodes never lock this demo link: after the fifth, the count starts again.".into(),
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
    refill_attempts: bool,
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
                                remaining_attempts, refill_attempts, bundle, bundle_etag, bundle_updated_at, created_at)
             VALUES (?1, ?2, ?3, 1, NULL, ?4, ?5, ?6, ?10, ?7, ?8, ?9, ?9)",
            params![
                lid,
                label,
                i64::from(long_lived),
                salt_opt,
                hash_opt,
                rem_opt,
                bundle_jwe.as_bytes(),
                etag,
                now,
                i64::from(refill_attempts)
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

#[cfg(test)]
mod tests {
    /// The server deletes the samples a new one replaced only once it has loaded the new one.
    #[test]
    fn the_server_retires_the_previous_sample_after_loading_the_new_one() {
        let dir = std::env::temp_dir().join(format!("seed_retire_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = crate::state::AppState::new(&dir).unwrap();
        let (old, _) = state.create_share(true, None).unwrap();
        let (new, _) = state.create_share(true, None).unwrap();
        let (lu, lp) = ("u".repeat(43), "p".repeat(43));
        super::insert_seeded_link(&state, &new, &lu, "u", false, None, false, "x", &[]).unwrap();
        super::insert_seeded_link(&state, &new, &lp, "p", true, Some("1234"), true, "x", &[]).unwrap();
        let saved = super::PersistedSeed { version: super::SEED_VERSION, sid: new.clone(), lid_u: lu, key_u: "k".repeat(43), lid_p: lp, key_p: "k".repeat(43), retired: vec![old.clone()] };
        std::fs::write(dir.join("seeded_demos.json"), serde_json::to_string(&saved).unwrap()).unwrap();
        assert!(state.catalog_has_share(&old), "the seed leaves the previous sample in place");
        assert!(super::load_sample(&state, "http://localhost"));
        assert!(!state.catalog_has_share(&old));
        assert!(state.catalog_has_share(&new));
        let again: super::PersistedSeed = serde_json::from_str(&std::fs::read_to_string(dir.join("seeded_demos.json")).unwrap()).unwrap();
        assert!(again.retired.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The sample's passcode link is the only one the seed makes refill.
    #[test]
    fn the_seed_marks_only_the_passcode_link_refill() {
        let dir = std::env::temp_dir().join(format!("seed_refill_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = crate::state::AppState::new(&dir).unwrap();
        let (sid, _) = state.create_share(true, None).unwrap();
        super::insert_seeded_link(&state, &sid, &"a".repeat(43), "u", false, None, false, "x", &[]).unwrap();
        super::insert_seeded_link(&state, &sid, &"b".repeat(43), "p", true, Some("1234"), true, "x", &[]).unwrap();
        let c = state.open_share_db(&sid).unwrap();
        let conn = c.lock().unwrap();
        let get = |lid: String| -> (i64, Option<i64>) {
            conn.query_row("SELECT refill_attempts, remaining_attempts FROM links WHERE lid = ?1", [lid], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
        };
        assert_eq!(get("a".repeat(43)), (0, None));
        assert_eq!(get("b".repeat(43)), (1, Some(crate::state::DEFAULT_PASSCODE_ATTEMPTS)));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
