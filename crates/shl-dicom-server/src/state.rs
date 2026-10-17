use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use rusqlite::{params, Connection, OptionalExtension};
use crate::storage::{BlobStore, LocalFsStore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use shl_dicom_core::{
    crypto::{b64url_encode, random_bytes},
    shl::compute_shl_flag,
};
use tokio::sync::broadcast;

/// Server settings for uploads (see `serve --help`). `None` means no limit.
#[derive(Debug, Clone)]
pub struct Quotas {
    /// Total encrypted bytes one share may hold.
    pub share_bytes: Option<u64>,
    /// Series files one share may hold.
    pub share_files: Option<usize>,
    /// Shares that may exist at once (not counting the server's own sample).
    pub shares: Option<usize>,
    /// Largest body of one upload append.
    pub request_bytes: u64,
    /// Lifetime of a passcode link's capability URL (`/cap/{token}/…`), in seconds.
    pub cap_ttl_secs: i64,
}

impl Default for Quotas {
    fn default() -> Self {
        Self { share_bytes: None, share_files: None, shares: Some(256), request_bytes: 64 * 1024 * 1024, cap_ttl_secs: DEFAULT_CAP_TTL_SECS }
    }
}

pub const DEFAULT_SANDBOX_TTL_SECS: i64 = 24 * 3600; // 24 hours
pub const DEFAULT_CAP_TTL_SECS: i64 = 3600; // 1 hour
/// Longest lifetime a sharer may ask for with `POST /api/shares` or `PATCH /api/shares/{sid}`.
pub const MAX_SHARE_TTL_SECS: i64 = 31 * 24 * 3600;
pub const DEFAULT_PASSCODE_ATTEMPTS: i64 = 5;
/// An upload not finished this long after it started is dropped by the sweep.
pub const STALE_UPLOAD_SECS: i64 = 24 * 3600;
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

pub fn parse_file_name(name: &str) -> Option<&str> {
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

/// Whether two hashes are equal, taking the same time wherever they differ. (Only the length,
/// which is public, ends it early.)
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let diff = a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y));
    std::hint::black_box(diff) == 0
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
    /// null: no limit.
    pub bytes_max: Option<u64>,
    pub files_max: Option<usize>,
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
    pub quotas: Quotas,
    /// The server's public origin (`https://host`), the only source of absolute URLs when set
    /// (see `routes_shl::request_origin`).
    pub public_origin: Option<String>,
    /// `{sid}/{fileId}` uploads in progress (one request at a time per file).
    pub uploading: Arc<Mutex<std::collections::HashSet<String>>>,
    /// Where finished files live (local disk or S3).
    pub store: Arc<dyn BlobStore>,
    catalog: Arc<Mutex<Connection>>,
    pool: Arc<Mutex<ShareDbPool>>,
    events: Arc<Mutex<HashMap<String, broadcast::Sender<AccessEvent>>>>,
    pub demo_shares: Arc<Mutex<Vec<DemoShareInfo>>>,
    /// Access events not yet in their share's access_log (see `record_access`).
    access: Arc<AccessQueue>,
}

/// Access events on their way to the share databases. Reads append here and return; a writer
/// thread stores them every ACCESS_FLUSH_MS, one transaction per share, so a read never waits for
/// a SQLite write (on a busy disk an INSERT can block for seconds). Anything that reads the access
/// log calls `flush_access` first, so it sees every event recorded before it.
#[derive(Default)]
struct AccessQueue {
    pending: Mutex<HashMap<String, Vec<AccessEvent>>>,
    /// Held while events are taken from `pending` and written, so a flush sees them written.
    writing: Mutex<()>,
}

const ACCESS_FLUSH_MS: u64 = 25;
/// Longest recipient name kept in the access log (bytes).
pub const MAX_RECIPIENT_BYTES: usize = 256;
/// Access events kept per share; older ones are dropped as new ones are written.
pub const ACCESS_LOG_ROWS: i64 = 10_000;

impl AppState {
    pub fn new(data_dir: impl AsRef<Path>) -> Result<Self, String> {
        Self::with_quotas(data_dir, Quotas::default())
    }

    /// Files on local disk, under `{data-dir}/blobs/`.
    pub fn with_quotas(data_dir: impl AsRef<Path>, quotas: Quotas) -> Result<Self, String> {
        let root = data_dir.as_ref().join("blobs");
        Self::with_store(data_dir, quotas, Arc::new(LocalFsStore { root }))
    }

    /// The server's state, after the startup sweeps (orphan files and links, expired shares, stale
    /// uploads), which assume no other process is using the data directory.
    pub fn with_store(data_dir: impl AsRef<Path>, quotas: Quotas, store: Arc<dyn BlobStore>) -> Result<Self, String> {
        let state = Self::alongside_server(data_dir, quotas, store)?;
        state.run_sweep()?;
        state.sweep_orphan_files();
        state.sweep_stale_uploads();
        Ok(state)
    }

    /// The state without the startup sweeps, for `seed`, which runs while the server is serving
    /// the same data directory. There the orphan scan would take a share the server is creating
    /// (its file is written before its catalog row) for a crash's leftover and delete it.
    pub fn alongside_server(data_dir: impl AsRef<Path>, quotas: Quotas, store: Arc<dyn BlobStore>) -> Result<Self, String> {
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
            quotas,
            public_origin: None,
            uploading: Arc::new(Mutex::new(std::collections::HashSet::new())),
            store,
            catalog: Arc::new(Mutex::new(conn)),
            pool: Arc::new(Mutex::new(ShareDbPool::new())),
            events: Arc::new(Mutex::new(HashMap::new())),
            demo_shares: Arc::new(Mutex::new(Vec::new())),
            access: Arc::new(AccessQueue::default()),
        };
        {
            // The writer keeps its own clone of the state. Once every other clone is dropped (as
            // in tests), it writes what is queued and ends.
            let st = state.clone();
            std::thread::Builder::new()
                .name("access-log".into())
                .spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_millis(ACCESS_FLUSH_MS));
                    let q = &st.access;
                    let _w = q.writing.lock().unwrap();
                    let batch = std::mem::take(&mut *q.pending.lock().unwrap());
                    for (sid, evs) in batch {
                        st.write_access(&sid, &evs);
                    }
                    if Arc::strong_count(q) <= 1 {
                        return;
                    }
                })
                .map_err(|e| format!("access-log thread: {e}"))?;
        }
        Ok(state)
    }

    pub fn share_db_path(&self, sid: &str) -> PathBuf {
        self.data_dir.join("shares").join(format!("{sid}.db"))
    }

    /// A share's uploads in progress are staged on local disk: `shares/{sid}/{fileId}.part`.
    pub fn staging_dir(&self, sid: &str) -> PathBuf {
        self.data_dir.join("shares").join(sid)
    }

    pub fn part_path(&self, sid: &str, file_id: &str) -> PathBuf {
        self.staging_dir(sid).join(format!("{file_id}.part"))
    }

    /// A staged part on its way to the store: `{fileId}.part.{n}`. Its bytes count toward the
    /// upload's offset only once the part is recorded.
    pub fn sending_path(&self, sid: &str, file_id: &str, part_num: u32) -> PathBuf {
        self.staging_dir(sid).join(format!("{file_id}.part.{part_num}"))
    }

    /// Removes an upload's staged files: `{fileId}.part` and any `{fileId}.part.{n}`.
    pub fn remove_staged(&self, sid: &str, file_id: &str) {
        let _ = std::fs::remove_file(self.part_path(sid, file_id));
        let prefix = format!("{file_id}.part.");
        if let Ok(entries) = std::fs::read_dir(self.staging_dir(sid)) {
            for e in entries.flatten() {
                if e.file_name().to_str().is_some_and(|n| n.starts_with(&prefix)) {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }

    // ---------------------------------------------------------------- blobs and their references

    /// A clone's reference to a blob some share already names: only while its count is above 0.
    /// False when the blob is on its way to the trash (its last share was just deleted), so the
    /// clone can't keep it. SQLite serializes this against `blob_release`, across processes too
    /// (the seed deletes the previous sample from its own process).
    pub fn blob_ref(&self, key: &str) -> Result<bool, String> {
        let cat = self.catalog.lock().unwrap();
        cat.execute("UPDATE blobs SET ref_count = ref_count + 1 WHERE storage_key = ?1 AND ref_count > 0", params![key])
            .map(|n| n == 1)
            .map_err(|e| e.to_string())
    }

    /// One more file row names this blob: a new blob (an upload, the seed).
    pub fn blob_add(&self, key: &str) -> Result<(), String> {
        let cat = self.catalog.lock().unwrap();
        cat.execute(
            "INSERT INTO blobs (storage_key, ref_count) VALUES (?1, 1)
             ON CONFLICT(storage_key) DO UPDATE SET ref_count = ref_count + 1",
            params![key],
        )
        .map(|_| ())
        .map_err(|e| format!("blob reference: {e}"))
    }

    /// One fewer; the blob goes to the trash (deleted by `empty_trash`) only when this release
    /// took its count to 0. A key with no row, or a failed write, trashes nothing: a blob is never
    /// deleted on a guess.
    pub fn blob_release(&self, key: &str) -> Result<(), String> {
        let cat = self.catalog.lock().unwrap();
        let left: Option<i64> = cat
            .query_row(
                "UPDATE blobs SET ref_count = ref_count - 1 WHERE storage_key = ?1 RETURNING ref_count",
                params![key],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| format!("blob release: {e}"))?;
        if left == Some(0) {
            let tx = cat.unchecked_transaction().map_err(|e| e.to_string())?;
            if tx.execute("DELETE FROM blobs WHERE storage_key = ?1 AND ref_count <= 0", params![key]).map_err(|e| e.to_string())? == 1 {
                tx.execute("INSERT INTO trash (storage_key, upload_id) VALUES (?1, NULL)", params![key]).map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// A blob no file names, to delete from the store.
    pub fn trash_blob(&self, key: &str) {
        let cat = self.catalog.lock().unwrap();
        let _ = cat.execute("INSERT INTO trash (storage_key, upload_id) VALUES (?1, NULL)", params![key]);
    }

    /// An unfinished multipart upload to drop.
    pub fn trash_upload(&self, key: &str, upload_id: &str) {
        let cat = self.catalog.lock().unwrap();
        let _ = cat.execute("INSERT INTO trash (storage_key, upload_id) VALUES (?1, ?2)", params![key, upload_id]);
    }

    /// Deletes trashed blobs and aborts trashed uploads in the store. An item stays in the trash
    /// until the store confirms it is gone.
    pub async fn empty_trash(&self) {
        let items: Vec<(i64, String, Option<String>)> = {
            let cat = self.catalog.lock().unwrap();
            let mut st = match cat.prepare("SELECT rowid, storage_key, upload_id FROM trash") {
                Ok(s) => s,
                Err(_) => return,
            };
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map(|rows| rows.flatten().collect()).unwrap_or_default()
        };
        for (rowid, key, upload_id) in items {
            let done = match upload_id {
                Some(id) => self.store.abort_upload(&key, &id).await,
                None => self.store.delete(&key).await,
            };
            match done {
                Ok(()) => {
                    let _ = self.catalog.lock().unwrap().execute("DELETE FROM trash WHERE rowid = ?1", params![rowid]);
                }
                Err(e) => eprintln!("trash: {e} (will retry)"),
            }
        }
    }

    /// Empties the trash in the background, when there is a runtime.
    pub fn empty_trash_soon(&self) {
        if let Ok(h) = tokio::runtime::Handle::try_current() {
            let me = self.clone();
            h.spawn(async move { me.empty_trash().await });
        }
    }

    /// Removes expired caps and expired shares (with their files). Safe to run at any time, from
    /// any request: a share's files are removed only by whoever deletes its catalog row.
    pub fn run_sweep(&self) -> Result<(), String> {
        let now = now_unix();
        let expired_sids: Vec<String> = {
            let cat = self.catalog.lock().unwrap();
            let _ = cat.execute("DELETE FROM caps WHERE expires_at <= ?1", params![now]);

            let mut stmt = cat
                .prepare("SELECT sid FROM shares WHERE expires_at IS NOT NULL AND expires_at <= ?1")
                .map_err(|e| e.to_string())?;
            let sids: Vec<String> = stmt
                .query_map(params![now], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .flatten()
                .collect();
            // Only the sweep that removed the row removes the files.
            sids.into_iter()
                .filter(|sid| cat.execute("DELETE FROM shares WHERE sid = ?1", params![sid]) == Ok(1))
                .collect()
        };

        for sid in expired_sids {
            self.remove_share_files(&sid);
        }
        Ok(())
    }

    /// Startup only: removes share files (`shares/{sid}.db`, `shares/{sid}/`) with no catalog row.
    ///
    /// Invariant: a share's catalog row exists exactly while its files are meant to. Creating a
    /// share writes its file first and its catalog row last; deleting one removes the catalog row
    /// first and its files last, and only the caller whose DELETE removed the row removes the files
    /// (so each file's blob reference is released once). While the server runs, a file with no row
    /// is a share being created or being deleted, so only a crash leaves orphans, and this scan
    /// runs before any request can be in flight.
    fn sweep_orphan_files(&self) {
        let shares_dir = self.data_dir.join("shares");
        let Ok(entries) = std::fs::read_dir(&shares_dir) else { return };
        let has_row = |sid: &str| {
            is_valid_id22(sid)
                && self
                    .catalog
                    .lock()
                    .unwrap()
                    .query_row("SELECT 1 FROM shares WHERE sid = ?1", params![sid], |_| Ok(()))
                    .is_ok()
        };
        for entry in entries.flatten() {
            let fname = entry.file_name();
            let Some(name_str) = fname.to_str() else {
                continue;
            };
            if let Some(sid) = name_str.strip_suffix(".db") {
                if !has_row(sid) {
                    self.remove_share_files(sid);
                } else {
                    self.sweep_orphan_links(sid);
                }
            } else if entry.path().is_dir() && !has_row(name_str) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }

    /// Startup only: removes links in a share's database that have no catalog row. Creating a link
    /// writes the share's row first and the catalog's last, so while the server runs such a row may
    /// be a link being created; only a crash leaves one behind.
    fn sweep_orphan_links(&self, sid: &str) {
        let Ok(conn) = Connection::open_with_flags(self.share_db_path(sid), rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE) else { return };
        let _ = conn.execute_batch("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
        let valid: std::collections::HashSet<String> = {
            let cat = self.catalog.lock().unwrap();
            cat.prepare("SELECT lid FROM links WHERE sid = ?1")
                .and_then(|mut st| st.query_map(params![sid], |r| r.get(0)).map(|rows| rows.flatten().collect()))
                .unwrap_or_default()
        };
        let lids: Vec<String> = conn
            .prepare("SELECT lid FROM links")
            .and_then(|mut st| st.query_map([], |r| r.get(0)).map(|rows| rows.flatten().collect()))
            .unwrap_or_default();
        for lid in lids.into_iter().filter(|l| !valid.contains(l)) {
            let _ = conn.execute("DELETE FROM links WHERE lid = ?1", params![lid]);
        }
    }

    /// Drops uploads started more than `STALE_UPLOAD_SECS` ago: their rows, staged files and
    /// multipart uploads. Uploads with a request in progress are left alone.
    pub fn sweep_stale_uploads(&self) {
        let cutoff = now_unix() - STALE_UPLOAD_SECS;
        let sids: Vec<String> = {
            let cat = self.catalog.lock().unwrap();
            cat.prepare("SELECT sid FROM shares")
                .and_then(|mut st| st.query_map([], |r| r.get(0)).map(|rows| rows.flatten().collect()))
                .unwrap_or_default()
        };
        let mut trashed = false;
        for sid in sids {
            // Opened directly, so the sweep doesn't churn the pool of open databases.
            let path = self.share_db_path(&sid);
            let Ok(conn) = Connection::open(&path) else { continue };
            let _ = conn.execute_batch("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
            let stale: Vec<(String, String, Option<String>)> = conn
                .prepare("SELECT file_id, storage_key, s3_upload_id FROM uploads WHERE started_at < ?1")
                .and_then(|mut st| st.query_map(params![cutoff], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map(|rows| rows.flatten().collect()))
                .unwrap_or_default();
            for (fid, key, upload_id) in stale {
                let Some(_busy) = self.claim_upload(&sid, &fid) else { continue };
                if conn.execute("DELETE FROM uploads WHERE file_id = ?1", params![fid]).is_err() {
                    continue;
                }
                self.remove_staged(&sid, &fid);
                if let Some(id) = upload_id {
                    self.trash_upload(&key, &id);
                    trashed = true;
                }
            }
        }
        if trashed {
            self.empty_trash_soon();
        }
    }

    /// Marks `{sid}/{fileId}` as having a request in progress; None when one already has.
    pub fn claim_upload(&self, sid: &str, file_id: &str) -> Option<UploadClaim> {
        let key = format!("{sid}/{file_id}");
        self.uploading.lock().unwrap().insert(key.clone()).then(|| UploadClaim(self.clone(), key))
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

    /// Ends a link's capability URLs; `None` when share `sid` has no link `lid`.
    pub fn revoke_caps_for_link(&self, sid: &str, lid: &str) -> Result<Option<usize>, String> {
        let cat = self.catalog.lock().unwrap();
        let ours = cat
            .query_row("SELECT 1 FROM links WHERE lid = ?1 AND sid = ?2", params![lid, sid], |_| Ok(()))
            .optional()
            .map_err(|e| e.to_string())?
            .is_some();
        if !ours {
            return Ok(None);
        }
        cat.execute("DELETE FROM caps WHERE lid = ?1", params![lid])
            .map(Some)
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
            if self.quotas.shares.is_some_and(|max| active_sandbox >= max) {
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
        // Rule: when deleting, write the catalog first and remove the share file last (see
        // `sweep_orphan_files`).
        {
            let cat = self.catalog.lock().unwrap();
            let removed = cat
                .execute("DELETE FROM shares WHERE sid = ?1", params![sid])
                .map_err(|e| e.to_string())?;
            if removed == 0 {
                // Already deleted (another request, or the sweep): its files are theirs to remove.
                return Ok(());
            }
        }
        self.remove_share_files(sid);
        self.events.lock().unwrap().remove(sid);
        Ok(())
    }

    fn remove_share_files(&self, sid: &str) {
        // Its files' blobs lose a reference, and unfinished uploads are dropped. (The catalog row
        // may be gone already, so the database is opened directly.) It leaves the pool now.
        let db = self.pool.lock().unwrap().remove(sid).or_else(|| {
            let path = self.share_db_path(sid);
            let conn = path.exists().then(|| Connection::open(&path).ok()).flatten()?;
            let _ = conn.execute_batch("PRAGMA busy_timeout = 5000;");
            Some(Arc::new(Mutex::new(conn)))
        });
        if let Some(conn_arc) = &db {
            // Each row is deleted before its reference is released, so a second run (after a crash
            // part way through) releases nothing twice. Lock order: the share, then the catalog.
            let conn = conn_arc.lock().unwrap();
            let files: Vec<(String, String)> = conn
                .prepare("SELECT file_id, storage_key FROM files")
                .and_then(|mut st| st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map(|rows| rows.flatten().collect()))
                .unwrap_or_default();
            let uploads: Vec<(String, String, Option<String>)> = conn
                .prepare("SELECT file_id, storage_key, s3_upload_id FROM uploads")
                .and_then(|mut st| st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map(|rows| rows.flatten().collect()))
                .unwrap_or_default();
            let _ = conn.execute("DELETE FROM link_files", []);
            for (fid, key) in files {
                if conn.execute("DELETE FROM files WHERE file_id = ?1", params![fid]) == Ok(1) {
                    if let Err(e) = self.blob_release(&key) {
                        eprintln!("share {sid}: {e} (the blob {key} stays)");
                    }
                }
            }
            for (fid, key, upload_id) in uploads {
                if conn.execute("DELETE FROM uploads WHERE file_id = ?1", params![fid]) == Ok(1) {
                    if let Some(id) = upload_id {
                        self.trash_upload(&key, &id);
                    }
                }
            }
        }
        // Closed before its files go (on Linux an open file can be removed; not everywhere).
        // A request still holding this connection keeps it open until it finishes.
        drop(db);
        let _ = std::fs::remove_dir_all(self.staging_dir(sid));
        self.empty_trash_soon();
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
        ct_eq(&stored_hash, &provided_hash)
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

    /// Removes share `sid`'s link `lid` from the catalog (its caps cascade); false when the share
    /// has no such link.
    pub fn remove_link_from_catalog(&self, sid: &str, lid: &str) -> Result<bool, String> {
        let cat = self.catalog.lock().unwrap();
        cat.execute("DELETE FROM links WHERE lid = ?1 AND sid = ?2", params![lid, sid])
            .map(|n| n > 0)
            .map_err(|e| e.to_string())
    }

    pub fn build_share_resource(&self, sid: &str, origin: &str) -> Option<ShareResource> {
        let (created_at, expires_at, read_only) = self.lookup_share_meta(sid)?;
        self.flush_access(sid);
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
                .prepare("SELECT file_id, size, uploaded_at FROM files ORDER BY uploaded_at, file_id")
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
                bytes_max: self.quotas.share_bytes,
                files_max: self.quotas.share_files,
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

    /// Records an access: queued for the share's access_log (written within ACCESS_FLUSH_MS, off
    /// the request's path) and sent to SSE subscribers at once.
    pub fn record_access(&self, sid: &str, mut ev: AccessEvent) {
        // The recipient is whatever the client says: kept to MAX_RECIPIENT_BYTES.
        if let Some(r) = ev.recipient.as_mut() {
            if r.len() > MAX_RECIPIENT_BYTES {
                let mut end = MAX_RECIPIENT_BYTES;
                while !r.is_char_boundary(end) {
                    end -= 1;
                }
                r.truncate(end);
            }
        }
        if let Some(sender) = self.events.lock().unwrap().get(sid) {
            let _ = sender.send(ev.clone());
        }
        self.access.pending.lock().unwrap().entry(sid.to_string()).or_default().push(ev);
    }

    /// Writes a share's queued access events now (call before reading its access_log).
    pub fn flush_access(&self, sid: &str) {
        let _w = self.access.writing.lock().unwrap();
        let evs = self.access.pending.lock().unwrap().remove(sid);
        if let Some(evs) = evs {
            self.write_access(sid, &evs);
        }
    }

    fn write_access(&self, sid: &str, evs: &[AccessEvent]) {
        let Some(conn_arc) = self.open_share_db(sid) else { return };
        let mut conn = conn_arc.lock().unwrap();
        let Ok(tx) = conn.transaction() else { return };
        {
            let Ok(mut stmt) = tx.prepare_cached(
                "INSERT INTO access_log (ts, lid, method, path, range, status, bytes, recipient)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            ) else {
                return;
            };
            for ev in evs {
                let _ = stmt.execute(params![
                    ev.ts,
                    ev.lid,
                    ev.method,
                    ev.path,
                    ev.range,
                    ev.status as i64,
                    ev.bytes as i64,
                    ev.recipient
                ]);
            }
        }
        // Only the newest ACCESS_LOG_ROWS events are kept.
        let _ = tx.execute(
            "DELETE FROM access_log WHERE rowid <= (SELECT MAX(rowid) FROM access_log) - ?1",
            params![ACCESS_LOG_ROWS],
        );
        let _ = tx.commit();
    }
}

#[allow(clippy::too_many_arguments)] // one per column of the row
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

/// A request in progress on an upload; dropping it ends the claim.
pub struct UploadClaim(AppState, String);
impl Drop for UploadClaim {
    fn drop(&mut self) {
        self.0.uploading.lock().unwrap().remove(&self.1);
    }
}

/// A fresh storage key for a new blob: random, so it is never reused and names no share.
pub fn new_storage_key() -> String {
    format!("{}.bin", b64url_encode(&random_bytes::<16>().expect("random bytes")))
}

/// Records a complete file (already in the store under `storage_key`) in the share's database.
pub fn record_file(conn: &Connection, file_id: &str, storage_key: &str, size: u64) -> Result<ShareFileEntry, String> {
    let uploaded_at = now_unix();
    conn.execute(
        "INSERT INTO files (file_id, storage_key, size, uploaded_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(file_id) DO NOTHING",
        params![file_id, storage_key, size as i64, uploaded_at],
    )
    .map_err(|e| e.to_string())?;
    let _ = conn.execute("DELETE FROM uploads WHERE file_id = ?1", params![file_id]);
    Ok(ShareFileEntry { name: format!("{file_id}.bin"), size, uploaded_at })
}

/// Records a blob just put in the store as share `sid`'s file, under the share's lock: the file
/// row first, then its reference. If the share has gone meanwhile (deleted, or expired), the blob
/// goes to the trash instead. A delete takes the catalog row away before it takes the share's
/// lock, so with the lock held and the row still there, the delete will see this file and release
/// it; with the row gone, nothing would, so nothing keeps the blob.
pub fn adopt_blob(state: &AppState, sid: &str, file_id: &str, key: &str, size: u64) -> Result<ShareFileEntry, String> {
    let orphan = |why: String| {
        state.trash_blob(key);
        state.empty_trash_soon();
        Err(why)
    };
    let Some(conn_arc) = state.open_share_db(sid) else { return orphan("share not found".into()) };
    let conn = conn_arc.lock().unwrap();
    if !state.catalog_has_share(sid) {
        return orphan("share not found".into());
    }
    match record_file(&conn, file_id, key, size) {
        Ok(entry) => match state.blob_add(key) {
            Ok(()) => Ok(entry),
            Err(e) => {
                let _ = conn.execute("DELETE FROM files WHERE file_id = ?1", params![file_id]);
                orphan(e)
            }
        },
        Err(e) => orphan(e),
    }
}

/// Stores a whole file and records it, with no quota check (tests). Uploads go through
/// `PUT /api/shares/{sid}/files/{name}`; the sample through `seed`.
pub async fn store_file(state: &AppState, sid: &str, file_id: &str, ciphertext: &[u8]) -> Result<ShareFileEntry, String> {
    std::fs::create_dir_all(state.staging_dir(sid)).map_err(|e| e.to_string())?;
    let part = state.part_path(sid, file_id);
    std::fs::write(&part, ciphertext).map_err(|e| e.to_string())?;
    let key = new_storage_key();
    state.store.put_file(&key, &part).await?;
    adopt_blob(state, sid, file_id, &key, ciphertext.len() as u64)
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
         CREATE INDEX IF NOT EXISTS caps_expiry ON caps(expires_at);

         -- How many file rows (in any share) name each blob; a clone adds references, not bytes.
         CREATE TABLE IF NOT EXISTS blobs (
           storage_key  TEXT PRIMARY KEY,
           ref_count    INTEGER NOT NULL
         );

         -- Blobs no file names any more, and unfinished multipart uploads, to remove from the store.
         CREATE TABLE IF NOT EXISTS trash (
           storage_key  TEXT NOT NULL,
           upload_id    TEXT
         );",
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

         -- Complete encrypted files. The bytes are in the blob store under storage_key (random,
         -- never reused), which a cloned share shares with its source.
         CREATE TABLE IF NOT EXISTS files (
           file_id      TEXT PRIMARY KEY,
           storage_key  TEXT NOT NULL,
           size         INTEGER NOT NULL,
           uploaded_at  INTEGER NOT NULL
         );

         -- Uploads in progress. Upload-Offset = flushed_bytes + the size of shares/{sid}/{file_id}.part.
         CREATE TABLE IF NOT EXISTS uploads (
           file_id        TEXT PRIMARY KEY,
           storage_key    TEXT NOT NULL,           -- the blob it will become
           size           INTEGER NOT NULL,        -- -1 until the length is known
           s3_upload_id   TEXT,
           flushed_bytes  INTEGER NOT NULL DEFAULT 0,
           started_at     INTEGER NOT NULL
         );

         -- Parts already sent to S3 for an upload in progress.
         CREATE TABLE IF NOT EXISTS upload_parts (
           file_id   TEXT NOT NULL REFERENCES uploads(file_id) ON DELETE CASCADE,
           part_num  INTEGER NOT NULL,
           etag      TEXT NOT NULL,
           size      INTEGER NOT NULL,
           PRIMARY KEY (file_id, part_num)
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
           -- 1: wrong passcodes never lock the link; the count starts again (the public sample's
           -- passcode demo, whose passcode is published). Set only by the seed, never by the API.
           refill_attempts     INTEGER NOT NULL DEFAULT 0,
           bundle              BLOB,
           bundle_etag         TEXT,
           bundle_updated_at   INTEGER,
           created_at          INTEGER NOT NULL
         );

         CREATE TABLE IF NOT EXISTS link_files (
           lid      TEXT NOT NULL REFERENCES links(lid) ON DELETE CASCADE,
           file_id  TEXT NOT NULL REFERENCES files(file_id),
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
         CREATE INDEX IF NOT EXISTS access_ts ON access_log(ts);
         CREATE INDEX IF NOT EXISTS access_lid ON access_log(lid);",
    )?;
    // Share databases made before links had refill_attempts.
    if conn.prepare("SELECT refill_attempts FROM links LIMIT 0").is_err() {
        conn.execute_batch("ALTER TABLE links ADD COLUMN refill_attempts INTEGER NOT NULL DEFAULT 0;")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::ct_eq;

    #[test]
    fn an_older_share_database_gains_refill_attempts() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE links (lid TEXT PRIMARY KEY, label TEXT, long_lived INTEGER NOT NULL, online INTEGER NOT NULL DEFAULT 1,
               exp INTEGER, passcode_salt BLOB, passcode_hash BLOB, remaining_attempts INTEGER, bundle BLOB, bundle_etag TEXT,
               bundle_updated_at INTEGER, created_at INTEGER NOT NULL);
             INSERT INTO links (lid, long_lived, remaining_attempts, created_at) VALUES ('x', 0, 5, 0);",
        )
        .unwrap();
        super::init_share_db(&conn).unwrap();
        super::init_share_db(&conn).unwrap();
        let v: i64 = conn.query_row("SELECT refill_attempts FROM links WHERE lid = 'x'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 0);
    }

    #[test]
    fn ct_eq_compares_bytes() {
        assert!(ct_eq(b"", b""));
        assert!(ct_eq(&[7u8; 32], &[7u8; 32]));
        let mut b = [7u8; 32];
        b[31] = 6;
        assert!(!ct_eq(&[7u8; 32], &b));
        b[31] = 7;
        b[0] = 0;
        assert!(!ct_eq(&[7u8; 32], &b));
        assert!(!ct_eq(&[7u8; 32], &[7u8; 31]));
    }
}
