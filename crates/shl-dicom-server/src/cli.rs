use std::path::{Path, PathBuf};
use chrono::Utc;
use shl_dicom_core::{
    bundle::parse_study_index,
    crypto::{decrypt_range, random_bytes},
    jwe::decrypt_bundle_jwe,
    packer::{build_link_bundle, IngestSession},
    range::ciphertext_range,
    shl::{compute_shl_flag, decode_shlink_uri, encode_shlink_uri, ShlPayload},
};

pub fn run_pack_cli(
    inputs: &[PathBuf],
    out_dir: &Path,
    base_url: Option<&str>,
    label: Option<&str>,
    add_offset_tables: bool,
) -> Result<(), String> {
    let mut session = IngestSession::new();
    for path in inputs {
        ingest_path(&mut session, path)?;
    }
    let missing = session.instances_missing_offset_tables();
    session.set_add_offset_tables(add_offset_tables);

    let now_iso = Utc::now().to_rfc3339();
    let packed = session.pack(&now_iso).map_err(|e| e.to_string())?;

    std::fs::create_dir_all(out_dir).map_err(|e| format!("create {:?}: {e}", out_dir))?;
    for sf in &packed.files {
        let bin_path = out_dir.join(format!("{}.bin", sf.file_id));
        std::fs::write(&bin_path, &sf.ciphertext)
            .map_err(|e| format!("write {:?}: {e}", bin_path))?;
    }

    let shl_key = random_bytes::<32>().map_err(|e| e.to_string())?;
    let link_out =
        build_link_bundle(&packed.owner_bundle_json, &[], &shl_key, &now_iso).map_err(|e| e.to_string())?;

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
