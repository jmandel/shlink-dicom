use std::path::{Path, PathBuf};
use chrono::Utc;
use shl_dicom_core::{
    bundle::parse_study_index,
    crypto::{b64url_decode, decode_key_32, decrypt_range, random_bytes},
    jwe::{decrypt_bundle_jwe, encrypt_bundle_jwe_with_iv},
    packer::{build_link_bundle, IngestSession, StudyFile},
    range::ciphertext_range,
    shl::{compute_shl_flag, decode_shlink_uri, encode_shlink_uri, ShlPayload},
};

/// `pack --keys`: the link key, the Bundle's IV and lastUpdated, and each study's file id and key.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackKeys {
    shl_key: String,
    bundle_iv: String,
    last_updated: String,
    studies: std::collections::BTreeMap<String, PackKeyFile>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackKeyFile {
    file_id: String,
    key: String,
}

fn read_pack_keys(path: &Path) -> Result<PackKeys, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("read {:?}: {e}", path))?;
    let keys: PackKeys = serde_json::from_str(&text).map_err(|e| format!("{:?}: {e}", path))?;
    for (uid, f) in &keys.studies {
        if f.file_id.len() != 22 || b64url_decode(&f.file_id).ok().map(|b| b.len()) != Some(16) {
            return Err(format!("study {uid}: fileId must be 16 bytes, base64url without padding"));
        }
        decode_key_32(&f.key).map_err(|e| format!("study {uid}: key: {e}"))?;
    }
    decode_key_32(&keys.shl_key).map_err(|e| format!("shlKey: {e}"))?;
    if b64url_decode(&keys.bundle_iv).ok().map(|b| b.len()) != Some(12) {
        return Err("bundleIv must be 12 bytes, base64url without padding".into());
    }
    Ok(keys)
}

pub fn run_pack_cli(
    inputs: &[PathBuf],
    out_dir: &Path,
    base_url: Option<&str>,
    label: Option<&str>,
    add_offset_tables: bool,
    keys_path: Option<&Path>,
) -> Result<(), String> {
    let keys = keys_path.map(read_pack_keys).transpose()?;
    let mut session = IngestSession::new();
    for path in inputs {
        ingest_path(&mut session, path)?;
    }
    let missing = session.instances_missing_offset_tables();
    session.set_add_offset_tables(add_offset_tables);
    if let Some(k) = &keys {
        let mut files = std::collections::BTreeMap::new();
        for (uid, f) in &k.studies {
            files.insert(uid.clone(), StudyFile { file_id: f.file_id.clone(), key: decode_key_32(&f.key).map_err(|e| e.to_string())? });
        }
        session.set_study_files(files);
    }

    let now_iso = keys.as_ref().map(|k| k.last_updated.clone()).unwrap_or_else(|| Utc::now().to_rfc3339());
    let mut packed = session.pack(&now_iso).map_err(|e| e.to_string())?;
    if let Some(k) = &keys {
        packed.owner_bundle_json = stable_full_urls(&packed.owner_bundle_json)?;
        let packed_uids: std::collections::BTreeSet<&String> = packed.files.iter().map(|f| &f.study_uid).collect();
        for uid in k.studies.keys() {
            if !packed_uids.contains(uid) {
                return Err(format!("--keys lists study {uid}, which is not in the input"));
            }
        }
    }

    std::fs::create_dir_all(out_dir).map_err(|e| format!("create {:?}: {e}", out_dir))?;
    for sf in &packed.files {
        let bin_path = out_dir.join(format!("{}.bin", sf.file_id));
        std::fs::write(&bin_path, &sf.ciphertext)
            .map_err(|e| format!("write {:?}: {e}", bin_path))?;
    }

    let shl_key = match &keys {
        Some(k) => decode_key_32(&k.shl_key).map_err(|e| e.to_string())?,
        None => random_bytes::<32>().map_err(|e| e.to_string())?,
    };
    let mut link_out =
        build_link_bundle(&packed.owner_bundle_json, &[], &shl_key, &now_iso).map_err(|e| e.to_string())?;
    if let Some(k) = &keys {
        // The same Bundle under the same key and IV gives the same bundle.jwe. The caller checks
        // the Bundle is unchanged before publishing (a different Bundle needs a new IV).
        let iv: [u8; 12] = b64url_decode(&k.bundle_iv).map_err(|e| e.to_string())?.try_into().map_err(|_| "bundleIv")?;
        link_out.bundle_jwe = encrypt_bundle_jwe_with_iv(link_out.bundle_json.as_bytes(), &shl_key, &iv).map_err(|e| e.to_string())?;
    }

    let jwe_path = out_dir.join("bundle.jwe");
    std::fs::write(&jwe_path, &link_out.bundle_jwe)
        .map_err(|e| format!("write {:?}: {e}", jwe_path))?;
    let json_path = out_dir.join("bundle.json");
    std::fs::write(&json_path, &link_out.bundle_json)
        .map_err(|e| format!("write {:?}: {e}", json_path))?;

    let base = base_url.unwrap_or("https://host.example/share/");
    let url = if base.ends_with('/') {
        format!("{base}bundle.jwe")
    } else if base.ends_with(".jwe") {
        base.to_string()
    } else {
        format!("{base}/bundle.jwe")
    };

    let shlink = encode_shlink_uri(
        &ShlPayload {
            url,
            key: link_out.shl_key_b64,
            exp: None,
            flag: compute_shl_flag(false, false),
            label: Some(label.unwrap_or("DICOM Study").to_string()),
            v: Some(1),
        },
        None,
    )
    .map_err(|e| e.to_string())?;

    println!("Packed {} study/studies into {:?}:", packed.index.studies.len(), out_dir);
    if add_offset_tables {
        println!("  Added frame offset tables to {} of {} multi-frame instance(s) that lacked one", packed.offset_tables_added, missing);
    } else if missing > 0 {
        println!("  {missing} multi-frame instance(s) have no frame offset table; --add-offset-tables adds one");
    }
    for st in &packed.index.studies {
        println!(
            "  Study {} ({}): {} series, {} instances",
            st.study_instance_uid,
            st.description.as_deref().unwrap_or("no description"),
            st.number_of_series,
            st.number_of_instances
        );
    }
    println!("\nSHL URI:\n{shlink}");
    Ok(())
}

/// Replaces each entry's random `urn:uuid:` fullUrl with one derived from its resource type and id,
/// so packing the same input gives the same Bundle.
fn stable_full_urls(bundle_json: &str) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut b: serde_json::Value = serde_json::from_str(bundle_json).map_err(|e| e.to_string())?;
    for entry in b["entry"].as_array_mut().into_iter().flatten() {
        let r = &entry["resource"];
        let name = format!("{}/{}", r["resourceType"].as_str().unwrap_or(""), r["id"].as_str().unwrap_or(""));
        let mut h: [u8; 16] = Sha256::digest(format!("shlink-dicom fullUrl {name}").as_bytes())[..16].try_into().unwrap();
        h[6] = (h[6] & 0x0f) | 0x50; // version 5 layout (name-based, SHA)
        h[8] = (h[8] & 0x3f) | 0x80;
        let x: String = h.iter().map(|b| format!("{b:02x}")).collect();
        entry["fullUrl"] = serde_json::json!(format!("urn:uuid:{}-{}-{}-{}-{}", &x[0..8], &x[8..12], &x[12..16], &x[16..20], &x[20..32]));
    }
    serde_json::to_string(&b).map_err(|e| e.to_string())
}

fn ingest_path(session: &mut IngestSession, path: &Path) -> Result<(), String> {
    if path.is_dir() {
        let entries = std::fs::read_dir(path).map_err(|e| format!("read_dir {:?}: {e}", path))?;
        for entry in entries.flatten() {
            ingest_path(session, &entry.path())?;
        }
        return Ok(());
    }
    let name = path.to_string_lossy().into_owned();
    let bytes = std::fs::read(path).map_err(|e| format!("read {:?}: {e}", path))?;
    if name.ends_with(".tgz") || name.ends_with(".tar.gz") {
        session.ingest_tar_gz(&bytes).map_err(|e| e.to_string())?;
    } else if name.ends_with(".zip") {
        session.ingest_zip(&bytes).map_err(|e| e.to_string())?;
    } else {
        let _ = session.ingest_dicom_bytes(&name, bytes);
    }
    Ok(())
}

pub async fn run_inspect_cli(shlink_uri: &str, passcode: Option<&str>) -> Result<(), String> {
    let payload = decode_shlink_uri(shlink_uri).map_err(|e| e.to_string())?;
    let shl_key = payload.key_bytes().map_err(|e| e.to_string())?;
    let client = reqwest::Client::new();

    let (bundle_jwe, base_url) = if payload.is_u_mode() {
        let resp = client
            .get(&payload.url)
            .query(&[("recipient", "shl-dicom-cli")])
            .send()
            .await
            .map_err(|e| format!("GET {}: {e}", payload.url))?;
        if !resp.status().is_success() {
            return Err(format!("GET {} returned {}", payload.url, resp.status()));
        }
        let jwe = resp.text().await.map_err(|e| e.to_string())?;
        (jwe, payload.url.clone())
    } else {
        let body = serde_json::json!({
            "recipient": "shl-dicom-cli",
            "passcode": passcode,
        });
        let resp = client
            .post(&payload.url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("POST {}: {e}", payload.url))?;
        if !resp.status().is_success() {
            return Err(format!("POST {} returned {}", payload.url, resp.status()));
        }
        let manifest: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let loc = manifest["files"][0]["location"]
            .as_str()
            .ok_or("manifest missing files[0].location")?
            .to_string();
        let jwe_resp = client
            .get(&loc)
            .send()
            .await
            .map_err(|e| format!("GET {loc}: {e}"))?;
        if !jwe_resp.status().is_success() {
            return Err(format!("GET {loc} returned {}", jwe_resp.status()));
        }
        let jwe = jwe_resp.text().await.map_err(|e| e.to_string())?;
        (jwe, loc)
    };

    let bundle_bytes = decrypt_bundle_jwe(&bundle_jwe, &shl_key).map_err(|e| e.to_string())?;
    let index = parse_study_index(&bundle_bytes).map_err(|e| e.to_string())?;

    println!(
        "Patient: {} (DOB: {})",
        index.patient_name.as_deref().unwrap_or("Unknown"),
        index.patient_birth_date.as_deref().unwrap_or("Unknown")
    );
    for st in &index.studies {
        println!(
            "Study {} ({}): {} series, {} instances",
            st.study_instance_uid,
            st.description.as_deref().unwrap_or("-"),
            st.number_of_series,
            st.number_of_instances
        );
    }

    // Verify a single-instance HTTP 206 Range request on the first series' middle instance
    if let Some(first_study) = index.studies.first() {
        if let Some(first_series) = first_study.series.first() {
            let mid_idx = first_series.instances.len() / 2;
            let inst = &first_series.instances[mid_idx];
            let r = ciphertext_range(
                inst.offset,
                inst.offset + inst.length,
                first_series.file.plaintext_length,
            )
            .map_err(|e| e.to_string())?;
            let base_prefix = base_url
                .rsplit_once('/')
                .map(|(p, _)| format!("{p}/"))
                .unwrap_or_else(|| format!("{base_url}/"));
            let file_url = format!("{base_prefix}{}.bin", first_series.file.file_id);

            let resp = client
                .get(&file_url)
                .header(reqwest::header::RANGE, r.http_range_header())
                .send()
                .await
                .map_err(|e| format!("Range GET {file_url}: {e}"))?;
            let status = resp.status();
            let ct_slice = resp.bytes().await.map_err(|e| e.to_string())?;
            let dcm = decrypt_range(
                &ct_slice,
                inst.offset,
                inst.offset + inst.length,
                first_series.file.plaintext_length,
                &first_series.file.key_bytes().map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            println!(
                "Verified Range read ({}) -> HTTP {}, decrypted instance {} ({} bytes, magic={:?})",
                r.http_range_header(),
                status,
                inst.uid,
                dcm.len(),
                std::str::from_utf8(&dcm[128..132]).unwrap_or("?")
            );
        }
    }

    Ok(())
}
