use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use shl_dicom_core::{
    crypto::{b64url_encode, random_bytes},
    range::RECORD_CIPHERTEXT,
    shl::compute_shl_flag,
};
use tokio::sync::broadcast;

pub const DEFAULT_BYTES_MAX: u64 = 500 * 1024 * 1024; // 500 MiB per share
pub const DEFAULT_FILES_MAX: usize = 256;
pub const DEFAULT_MAX_SANDBOX_SHARES: usize = 64;
pub const DEFAULT_SANDBOX_TTL_SECS: i64 = 24 * 3600; // 24 hours
pub const DEFAULT_CAP_TTL_SECS: i64 = 3600; // 1 hour
/// Longest lifetime a sharer may ask for with `POST /api/shares` or `PATCH /api/shares/{sid}`.
pub const MAX_SHARE_TTL_SECS: i64 = 31 * 24 * 3600;
pub const DEFAULT_PASSCODE_ATTEMPTS: i64 = 5;
const MAX_OPEN_SHARE_DBS: usize = 64;

pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

pub fn is_valid_id22(s: &str) -> bool {
    s.len() == 22
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn is_valid_token43(s: &str) -> bool {
    s.len() == 43
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn parse_series_filename(name: &str) -> Option<&str> {
    let stem = name.strip_suffix(".bin")?;
    is_valid_id22(stem).then_some(stem)
}

pub fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

pub fn hash_passcode(salt: &[u8], passcode: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(salt);
    hasher.update(passcode.as_bytes());
    hasher.finalize().into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareFileEntry {
    pub name: String,
    pub size: u64,
    pub uploaded_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareQuota {
    pub bytes_used: u64,
    pub bytes_max: u64,
    pub files_max: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkResource {
    pub id: String,
    pub label: Option<String>,
    pub url: String,
    pub flag: Option<String>,
    pub exp: Option<i64>,
    pub online: bool,
    pub long_lived: bool,
    pub has_passcode: bool,
    pub remaining_attempts: Option<i64>,
    pub has_bundle: bool,
    pub allowed_files: Vec<String>,
    pub created_at: i64,
    pub last_access_at: Option<i64>,
    pub access_count: u64,
    /// Successful Bundle fetches (`bundle.jwe` answered 200 or 304): how often the link was opened.
    #[serde(default)]
    pub open_count: u64,
    #[serde(default)]
    pub last_opened_at: Option<i64>,
    /// Bytes served through this link (Bundle, manifest and series files).
    #[serde(default)]
    pub bytes_served: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareResource {
    pub id: String,
    pub created_at: i64,
    pub expires_at: Option<i64>,
    pub read_only: bool,
    pub has_owner_bundle: bool,
    pub files: Vec<ShareFileEntry>,
    pub quota: ShareQuota,
    pub links: Vec<LinkResource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessEvent {
    pub ts: i64,
    pub lid: Option<String>,
    pub method: String,
    pub path: String,
    pub range: Option<String>,
    pub status: u16,
    pub bytes: u64,
    pub recipient: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DemoShareInfo {
    pub id: String,
    pub title: String,
    pub description: String,
    pub shlink_uri: String,
    pub passcode_hint: Option<String>,
    pub read_only: bool,
    pub share: ShareResource,
}

struct ShareDbPool {
    order: VecDeque<String>,
    conns: HashMap<String, Arc<Mutex<Connection>>>,
}

impl ShareDbPool {
    fn new() -> Self {
        Self {
            order: VecDeque::new(),
            conns: HashMap::new(),
        }
    }

    fn get(&mut self, sid: &str) -> Option<Arc<Mutex<Connection>>> {
        if let Some(conn) = self.conns.get(sid).cloned() {
            self.order.retain(|x| x != sid);
            self.order.push_back(sid.to_string());
            Some(conn)
        } else {
            None
        }
    }

    fn insert(&mut self, sid: String, conn: Arc<Mutex<Connection>>) {
        if !self.conns.contains_key(&sid) && self.order.len() >= MAX_OPEN_SHARE_DBS {
            if let Some(evicted) = self.order.pop_front() {
                self.conns.remove(&evicted);
            }
        }
        self.order.retain(|x| x != &sid);
        self.order.push_back(sid.clone());
        self.conns.insert(sid, conn);
    }

    fn remove(&mut self, sid: &str) -> Option<Arc<Mutex<Connection>>> {
        self.order.retain(|x| x != sid);
        self.conns.remove(sid)
    }
}

#[derive(Clone)]
pub struct AppState {
    pub data_dir: PathBuf,
    pub bytes_max: u64,
    pub files_max: usize,
    pub max_sandbox_shares: usize,
    catalog: Arc<Mutex<Connection>>,
    pool: Arc<Mutex<ShareDbPool>>,
    events: Arc<Mutex<HashMap<String, broadcast::Sender<AccessEvent>>>>,
    pub demo_shares: Arc<Mutex<Vec<DemoShareInfo>>>,
}

impl AppState {
    pub fn new(data_dir: impl AsRef<Path>) -> Result<Self, String> {
        Self::with_quotas(
            data_dir,
            DEFAULT_BYTES_MAX,
            DEFAULT_FILES_MAX,
            DEFAULT_MAX_SANDBOX_SHARES,
        )
    }

    pub fn with_quotas(
        data_dir: impl AsRef<Path>,
        bytes_max: u64,
        files_max: usize,
        max_sandbox_shares: usize,
    ) -> Result<Self, String> {
        let data_dir = data_dir.as_ref().to_path_buf();
        let shares_dir = data_dir.join("shares");
        std::fs::create_dir_all(&shares_dir)
            .map_err(|e| format!("create shares dir {:?}: {e}", shares_dir))?;

        let catalog_path = data_dir.join("catalog.db");
        let conn = Connection::open(&catalog_path)
            .map_err(|e| format!("open catalog {:?}: {e}", catalog_path))?;
        init_catalog_db(&conn).map_err(|e| format!("init catalog: {e}"))?;

        let state = Self {
            data_dir,
            bytes_max,
            files_max,
            max_sandbox_shares,
            catalog: Arc::new(Mutex::new(conn)),
            pool: Arc::new(Mutex::new(ShareDbPool::new())),
            events: Arc::new(Mutex::new(HashMap::new())),
            demo_shares: Arc::new(Mutex::new(Vec::new())),
        };
        state.run_sweep()?;
        Ok(state)
    }

    pub fn share_db_path(&self, sid: &str) -> PathBuf {
        self.data_dir.join("shares").join(format!("{sid}.db"))
    }

    /// Startup and periodic sweep: removes expired caps, expired sandbox shares,
    /// orphan share `.db` files on disk, and orphan links inside share DBs.
    pub fn run_sweep(&self) -> Result<(), String> {
        let now = now_unix();
        let expired_sids: Vec<String> = {
            let cat = self.catalog.lock().unwrap();
            let _ = cat.execute("DELETE FROM caps WHERE expires_at <= ?1", params![now]);

            let mut stmt = cat
                .prepare("SELECT sid FROM shares WHERE expires_at IS NOT NULL AND expires_at <= ?1")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![now], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            let mut sids = Vec::new();
            for r in rows {
                if let Ok(sid) = r {
                    sids.push(sid);
                }
            }
            for sid in &sids {
                let _ = cat.execute("DELETE FROM shares WHERE sid = ?1", params![sid]);
            }
            sids
        };

        for sid in expired_sids {
            self.remove_share_files(&sid);
        }

        // Remove any shares/*.db file whose sid has no catalog row
        let shares_dir = self.data_dir.join("shares");
        if let Ok(entries) = std::fs::read_dir(&shares_dir) {
            for entry in entries.flatten() {
                let fname = entry.file_name();
                let Some(name_str) = fname.to_str() else {
                    continue;
                };
                if let Some(sid) = name_str.strip_suffix(".db") {
                    if !is_valid_id22(sid) || !self.catalog_has_share(sid) {
                        self.remove_share_files(sid);
                    }
                }
            }
        }
        Ok(())
    }

    pub fn catalog_has_share(&self, sid: &str) -> bool {
        if !is_valid_id22(sid) {
            return false;
        }
        let now = now_unix();
        let cat = self.catalog.lock().unwrap();
        cat.query_row(
            "SELECT 1 FROM shares WHERE sid = ?1 AND (expires_at IS NULL OR expires_at > ?2)",
            params![sid, now],
            |_| Ok(()),
        )
        .is_ok()
    }

    pub fn lookup_share_meta(&self, sid: &str) -> Option<(i64, Option<i64>, bool)> {
        if !is_valid_id22(sid) {
            return None;
        }
        let now = now_unix();
        let cat = self.catalog.lock().unwrap();
        cat.query_row(
            "SELECT created_at, expires_at, read_only FROM shares WHERE sid = ?1 AND (expires_at IS NULL OR expires_at > ?2)",
            params![sid, now],
            |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)),
        )
        .ok()
    }

    pub fn lookup_sid_by_lid(&self, lid: &str) -> Option<String> {
        if !is_valid_id22(lid) {
            return None;
        }
        let now = now_unix();
        let cat = self.catalog.lock().unwrap();
        cat.query_row(
            "SELECT s.sid FROM links l JOIN shares s ON s.sid = l.sid
             WHERE l.lid = ?1 AND (s.expires_at IS NULL OR s.expires_at > ?2)",
            params![lid, now],
            |r| r.get(0),
        )
        .ok()
    }

    pub fn lookup_cap(&self, token: &str) -> Option<(String, String)> {
        if !is_valid_token43(token) {
            return None;
        }
        let now = now_unix();
        let cat = self.catalog.lock().unwrap();
        cat.query_row(
            "SELECT s.sid, c.lid FROM caps c
             JOIN links l ON l.lid = c.lid
             JOIN shares s ON s.sid = l.sid
             WHERE c.token = ?1 AND c.expires_at > ?2 AND (s.expires_at IS NULL OR s.expires_at > ?2)",
            params![token, now],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok()
    }

    pub fn mint_cap(&self, lid: &str, ttl_secs: i64) -> Result<String, String> {
        let token_bytes = random_bytes::<32>().map_err(|e| e.to_string())?;
        let token = b64url_encode(&token_bytes);
        let expires_at = now_unix() + ttl_secs;
        let cat = self.catalog.lock().unwrap();
        cat.execute(
            "INSERT INTO caps (token, lid, expires_at) VALUES (?1, ?2, ?3)",
            params![token, lid, expires_at],
        )
        .map_err(|e| e.to_string())?;
        Ok(token)
    }

    pub fn revoke_caps_for_link(&self, lid: &str) -> Result<usize, String> {
        let cat = self.catalog.lock().unwrap();
        cat.execute("DELETE FROM caps WHERE lid = ?1", params![lid])
            .map_err(|e| e.to_string())
    }

    pub fn open_share_db(&self, sid: &str) -> Option<Arc<Mutex<Connection>>> {
        if !self.catalog_has_share(sid) {
            return None;
        }
        {
            let mut pool = self.pool.lock().unwrap();
            if let Some(conn) = pool.get(sid) {
                return Some(conn);
            }
        }
        let path = self.share_db_path(sid);
        if !path.exists() {
            return None;
        }
        let conn = Connection::open(&path).ok()?;
        init_share_db(&conn).ok()?;

        // Sweep any orphan links in this share file that have no catalog entry
        let valid_lids: Vec<String> = {
            let cat = self.catalog.lock().unwrap();
            let mut stmt = cat
                .prepare("SELECT lid FROM links WHERE sid = ?1")
                .ok()?;
            let res: Vec<String> = stmt
                .query_map(params![sid], |r| r.get::<_, String>(0))
                .ok()?
                .flatten()
                .collect();
            res
        };
        {
            let mut stmt = conn.prepare("SELECT lid FROM links").ok()?;
            let all_lids: Vec<String> = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .ok()?
                .flatten()
                .collect();
            for lid in all_lids {
                if !valid_lids.iter().any(|v| v == &lid) {
                    let _ = conn.execute("DELETE FROM links WHERE lid = ?1", params![lid]);
                }
            }
        }

        let arc = Arc::new(Mutex::new(conn));
        self.pool.lock().unwrap().insert(sid.to_string(), arc.clone());
        Some(arc)
    }

    pub fn create_share(
        &self,
        read_only: bool,
        expires_at: Option<i64>,
    ) -> Result<(String, String), String> {
        let _ = self.run_sweep();
        if !read_only {
            let active_sandbox: usize = {
                let cat = self.catalog.lock().unwrap();
                cat.query_row(
                    "SELECT COUNT(*) FROM shares WHERE read_only = 0",
                    [],
                    |r| r.get::<_, usize>(0),
                )
                .unwrap_or(0)
            };
            if active_sandbox >= self.max_sandbox_shares {
                return Err("QUOTA_SHARES_EXCEEDED".into());
            }
        }

        let sid = b64url_encode(&random_bytes::<16>().map_err(|e| e.to_string())?);
        let control_token = b64url_encode(&random_bytes::<32>().map_err(|e| e.to_string())?);
        let token_hash = sha256_bytes(control_token.as_bytes());
        let created_at = now_unix();

        // Rule: when creating, write the share file first and the catalog last.
        let path = self.share_db_path(&sid);
        let conn = Connection::open(&path).map_err(|e| e.to_string())?;
        init_share_db(&conn).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO share (id, control_token_hash) VALUES (1, ?1)",
            params![token_hash.as_slice()],
        )
        .map_err(|e| e.to_string())?;

        self.pool
            .lock()
            .unwrap()
            .insert(sid.clone(), Arc::new(Mutex::new(conn)));

        {
            let cat = self.catalog.lock().unwrap();
            cat.execute(
                "INSERT INTO shares (sid, created_at, expires_at, read_only) VALUES (?1, ?2, ?3, ?4)",
                params![sid, created_at, expires_at, i64::from(read_only)],
            )
            .map_err(|e| e.to_string())?;
        }

        Ok((sid, control_token))
    }

    /// Sets a sandbox share's expiry (catalog). Read-only shares are never changed.
    pub fn set_share_expiry(&self, sid: &str, expires_at: i64) -> Result<(), String> {
        let cat = self.catalog.lock().unwrap();
        cat.execute(
            "UPDATE shares SET expires_at = ?1 WHERE sid = ?2 AND read_only = 0",
            params![expires_at, sid],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    pub fn delete_share(&self, sid: &str) -> Result<(), String> {
        // Rule: when deleting, write the catalog first and remove the share file last.
        {
            let cat = self.catalog.lock().unwrap();
            cat.execute("DELETE FROM shares WHERE sid = ?1", params![sid])
                .map_err(|e| e.to_string())?;
        }
        self.remove_share_files(sid);
        self.events.lock().unwrap().remove(sid);
        Ok(())
    }

    fn remove_share_files(&self, sid: &str) {
        if let Some(conn_arc) = self.pool.lock().unwrap().remove(sid) {
            drop(conn_arc);
        }
        let base = self.share_db_path(sid);
        let _ = std::fs::remove_file(&base);
        let _ = std::fs::remove_file(format!("{}-wal", base.display()));
        let _ = std::fs::remove_file(format!("{}-shm", base.display()));
    }

    pub fn verify_control_token(&self, sid: &str, bearer: &str) -> bool {
        let Some((_, _, read_only)) = self.lookup_share_meta(sid) else {
            return false;
        };
        if read_only {
            return false;
        }
        let Some(conn_arc) = self.open_share_db(sid) else {
            return false;
        };
        let conn = conn_arc.lock().unwrap();
        let Ok(stored_hash) = conn.query_row(
            "SELECT control_token_hash FROM share WHERE id = 1",
            [],
            |r| r.get::<_, Vec<u8>>(0),
        ) else {
            return false;
        };
        let provided_hash = sha256_bytes(bearer.as_bytes());
        stored_hash.as_slice() == provided_hash.as_slice()
    }

    pub fn register_link_in_catalog(&self, sid: &str, lid: &str) -> Result<(), String> {
        let cat = self.catalog.lock().unwrap();
        cat.execute(
            "INSERT INTO links (lid, sid) VALUES (?1, ?2)",
            params![lid, sid],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn remove_link_from_catalog(&self, lid: &str) -> Result<(), String> {
        let cat = self.catalog.lock().unwrap();
        cat.execute("DELETE FROM links WHERE lid = ?1", params![lid])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn build_share_resource(&self, sid: &str, origin: &str) -> Option<ShareResource> {
        let (created_at, expires_at, read_only) = self.lookup_share_meta(sid)?;
        let conn_arc = self.open_share_db(sid)?;
        let conn = conn_arc.lock().unwrap();

        let has_owner_bundle: bool = conn
            .query_row(
                "SELECT owner_bundle IS NOT NULL FROM share WHERE id = 1",
                [],
                |r| r.get::<_, bool>(0),
            )
            .unwrap_or(false);

        let mut files = Vec::new();
        let mut bytes_used = 0u64;
        {
            let mut stmt = conn
                .prepare("SELECT file_id, size, uploaded_at FROM series_files ORDER BY uploaded_at, file_id")
                .ok()?;
            let rows = stmt
                .query_map([], |r| {
                    let fid: String = r.get(0)?;
                    let size: i64 = r.get(1)?;
                    let uploaded_at: i64 = r.get(2)?;
                    Ok(ShareFileEntry {
                        name: format!("{fid}.bin"),
                        size: size as u64,
                        uploaded_at,
                    })
                })
                .ok()?;
            for row in rows.flatten() {
                bytes_used += row.size;
                files.push(row);
            }
        }

        let mut links = Vec::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT lid, label, long_lived, online, exp, passcode_hash IS NOT NULL,
                            remaining_attempts, bundle IS NOT NULL, created_at
                     FROM links ORDER BY created_at, lid",
                )
                .ok()?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, i64>(2)? != 0,
                        r.get::<_, i64>(3)? != 0,
                        r.get::<_, Option<i64>>(4)?,
                        r.get::<_, bool>(5)?,
                        r.get::<_, Option<i64>>(6)?,
                        r.get::<_, bool>(7)?,
                        r.get::<_, i64>(8)?,
                    ))
                })
                .ok()?;
            for row in rows.flatten() {
                let (lid, label, long_lived, online, exp, has_passcode, remaining_attempts, has_bundle, link_created) = row;
                if let Some(link_res) = build_link_resource_from_row(
                    &conn,
                    origin,
                    lid,
                    label,
                    long_lived,
                    online,
                    exp,
                    has_passcode,
                    remaining_attempts,
                    has_bundle,
                    link_created,
                ) {
                    links.push(link_res);
                }
            }
        }

        Some(ShareResource {
            id: sid.to_string(),
            created_at,
            expires_at,
            read_only,
            has_owner_bundle,
            files,
            quota: ShareQuota {
                bytes_used,
                bytes_max: self.bytes_max,
                files_max: self.files_max,
            },
            links,
        })
    }

    pub fn subscribe_events(&self, sid: &str) -> broadcast::Receiver<AccessEvent> {
        let mut map = self.events.lock().unwrap();
        let sender = map
            .entry(sid.to_string())
            .or_insert_with(|| broadcast::channel(256).0);
        sender.subscribe()
    }

    pub fn record_access(&self, sid: &str, ev: AccessEvent) {
        if let Some(conn_arc) = self.open_share_db(sid) {
            let conn = conn_arc.lock().unwrap();
            let _ = conn.execute(
                "INSERT INTO access_log (ts, lid, method, path, range, status, bytes, recipient)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    ev.ts,
                    ev.lid,
                    ev.method,
                    ev.path,
                    ev.range,
                    ev.status as i64,
                    ev.bytes as i64,
                    ev.recipient
                ],
            );
        }
        if let Some(sender) = self.events.lock().unwrap().get(sid) {
            let _ = sender.send(ev);
        }
    }
}

pub fn build_link_resource_from_row(
    conn: &Connection,
    origin: &str,
    lid: String,
    label: Option<String>,
    long_lived: bool,
    online: bool,
    exp: Option<i64>,
    has_passcode: bool,
    remaining_attempts: Option<i64>,
    has_bundle: bool,
    created_at: i64,
) -> Option<LinkResource> {
    let mut allowed_files = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT file_id FROM link_files WHERE lid = ?1 ORDER BY file_id")
            .ok()?;
        let rows = stmt
            .query_map(params![lid], |r| r.get::<_, String>(0))
            .ok()?;
        for fid in rows.flatten() {
            allowed_files.push(format!("{fid}.bin"));
        }
    }

    let (access_count, last_access_at, bytes_served, open_count, last_opened_at): (u64, Option<i64>, u64, u64, Option<i64>) = conn
        .query_row(
            "SELECT COUNT(*), MAX(ts), COALESCE(SUM(bytes), 0),
                    COALESCE(SUM(CASE WHEN path LIKE '%/bundle.jwe' AND status IN (200, 304) THEN 1 ELSE 0 END), 0),
                    MAX(CASE WHEN path LIKE '%/bundle.jwe' AND status IN (200, 304) THEN ts END)
             FROM access_log WHERE lid = ?1",
            params![lid],
            |r| {
                Ok((
                    r.get::<_, i64>(0)? as u64,
                    r.get(1)?,
                    r.get::<_, i64>(2)? as u64,
                    r.get::<_, i64>(3)? as u64,
                    r.get(4)?,
                ))
            },
        )
        .unwrap_or((0, None, 0, 0, None));

    let clean_origin = origin.trim_end_matches('/');
    let url = if has_passcode {
        format!("{clean_origin}/shl/{lid}")
    } else {
        format!("{clean_origin}/shl/{lid}/bundle.jwe")
    };
    let flag = compute_shl_flag(has_passcode, long_lived);

    Some(LinkResource {
        id: lid,
        label,
        url,
        flag,
        exp,
        online,
        long_lived,
        has_passcode,
        remaining_attempts,
        has_bundle,
        allowed_files,
        created_at,
        last_access_at,
        access_count,
        open_count,
        last_opened_at,
        bytes_served,
    })
}

pub fn write_series_file_to_db(
    conn: &mut Connection,
    file_id: &str,
    ciphertext: &[u8],
    bytes_max: u64,
    files_max: usize,
) -> Result<ShareFileEntry, String> {
    let uploaded_at = now_unix();
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let (existing_count, existing_bytes): (usize, i64) = tx
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(size), 0) FROM series_files WHERE file_id != ?1",
            params![file_id],
            |r| Ok((r.get::<_, i64>(0)? as usize, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;

    if existing_count >= files_max {
        return Err("QUOTA_FILES_EXCEEDED".into());
    }
    if (existing_bytes as u64) + (ciphertext.len() as u64) > bytes_max {
        return Err("QUOTA_BYTES_EXCEEDED".into());
    }

    // Immutable rule: if file_id already exists, reject if size differs; otherwise replace/idempotent
    let existing_size: Option<i64> = tx
        .query_row(
            "SELECT size FROM series_files WHERE file_id = ?1",
            params![file_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(prev_sz) = existing_size {
        if prev_sz as usize != ciphertext.len() {
            return Err("IMMUTABLE_FILE_ID_CONFLICT".into());
        }
        tx.execute("DELETE FROM series_records WHERE file_id = ?1", params![file_id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM series_files WHERE file_id = ?1", params![file_id])
            .map_err(|e| e.to_string())?;
    }

    tx.execute(
        "INSERT INTO series_files (file_id, size, uploaded_at) VALUES (?1, ?2, ?3)",
        params![file_id, ciphertext.len() as i64, uploaded_at],
    )
    .map_err(|e| e.to_string())?;

    {
        let mut insert_rec = tx
            .prepare("INSERT INTO series_records (file_id, idx, bytes) VALUES (?1, ?2, ?3)")
            .map_err(|e| e.to_string())?;
        for (idx, chunk) in ciphertext.chunks(RECORD_CIPHERTEXT as usize).enumerate() {
            insert_rec
                .execute(params![file_id, idx as i64, chunk])
                .map_err(|e| e.to_string())?;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(ShareFileEntry {
        name: format!("{file_id}.bin"),
        size: ciphertext.len() as u64,
        uploaded_at,
    })
}

fn init_catalog_db(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;
         PRAGMA user_version = 1;

         CREATE TABLE IF NOT EXISTS shares (
           sid         TEXT PRIMARY KEY,
           created_at  INTEGER NOT NULL,
           expires_at  INTEGER,
           read_only   INTEGER NOT NULL DEFAULT 0
         );

         CREATE TABLE IF NOT EXISTS links (
           lid  TEXT PRIMARY KEY,
           sid  TEXT NOT NULL REFERENCES shares(sid) ON DELETE CASCADE
         );

         CREATE TABLE IF NOT EXISTS caps (
           token       TEXT PRIMARY KEY,
           lid         TEXT NOT NULL REFERENCES links(lid) ON DELETE CASCADE,
           expires_at  INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS caps_expiry ON caps(expires_at);",
    )
}

fn init_share_db(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;
         PRAGMA journal_size_limit = 16777216;
         PRAGMA user_version = 1;

         CREATE TABLE IF NOT EXISTS share (
           id                  INTEGER PRIMARY KEY CHECK (id = 1),
           control_token_hash  BLOB NOT NULL,
           owner_bundle        BLOB,
           owner_updated_at    INTEGER
         );

         CREATE TABLE IF NOT EXISTS series_files (
           file_id      TEXT PRIMARY KEY,
           size         INTEGER NOT NULL,
           uploaded_at  INTEGER NOT NULL
         );

         CREATE TABLE IF NOT EXISTS series_records (
           file_id  TEXT    NOT NULL REFERENCES series_files(file_id) ON DELETE CASCADE,
           idx      INTEGER NOT NULL,
           bytes    BLOB    NOT NULL,
           PRIMARY KEY (file_id, idx)
         ) WITHOUT ROWID;

         CREATE TABLE IF NOT EXISTS links (
           lid                 TEXT PRIMARY KEY,
           label               TEXT,
           long_lived          INTEGER NOT NULL,
           online              INTEGER NOT NULL DEFAULT 1,
           exp                 INTEGER,
           passcode_salt       BLOB,
           passcode_hash       BLOB,
           remaining_attempts  INTEGER,
           bundle              BLOB,
           bundle_etag         TEXT,
           bundle_updated_at   INTEGER,
           created_at          INTEGER NOT NULL
         );

         CREATE TABLE IF NOT EXISTS link_files (
           lid      TEXT NOT NULL REFERENCES links(lid) ON DELETE CASCADE,
           file_id  TEXT NOT NULL REFERENCES series_files(file_id),
           PRIMARY KEY (lid, file_id)
         ) WITHOUT ROWID;

         CREATE TABLE IF NOT EXISTS access_log (
           ts         INTEGER NOT NULL,
           lid        TEXT,
           method     TEXT NOT NULL,
           path       TEXT NOT NULL,
           range      TEXT,
           status     INTEGER NOT NULL,
           bytes      INTEGER NOT NULL,
           recipient  TEXT
         );
         CREATE INDEX IF NOT EXISTS access_ts ON access_log(ts);",
    )
}
