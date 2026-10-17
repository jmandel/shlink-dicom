//! Where encrypted files live: a `BlobStore`. The server keeps all state (catalog, share
//! databases, uploads in progress) in SQLite on local disk; only the finished `{fileId}.bin` blobs
//! sit behind this interface:
//!
//! - [`LocalFsStore`]: files under `{data-dir}/blobs/`;
//! - [`S3Store`]: objects in a private S3 bucket (any S3-compatible service), written with
//!   multipart uploads, read either through the server (`proxy`) or by a `307` to a presigned
//!   URL valid for 60 s (`redirect`). Objects are never public.
//!
//! A blob is named by its storage key, a random `{22 base64url chars}.bin` drawn for each upload,
//! so a key is never reused and names no share. A cloned share points at the same keys; the
//! catalog counts references (`blobs`) and a blob is deleted when the count reaches zero.
//!
//! An upload in progress is staged in `shares/{sid}/{fileId}.part` on local disk. The S3 store
//! sends it to the bucket as multipart parts while the upload goes on, so the staged file stays
//! about one part long; the local store renames it into place when it is complete.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Mutex,
    time::{Duration, Instant},
};
use futures_util::{Stream, TryStreamExt};
use rusty_s3::{
    actions::{AbortMultipartUpload, CompleteMultipartUpload, CreateMultipartUpload, UploadPart},
    Bucket, Credentials, S3Action, UrlStyle,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

pub type ByteStream = Pin<Box<dyn Stream<Item = Result<bytes::Bytes, std::io::Error>> + Send>>;

/// How a byte range reaches the reader.
pub enum ReadDelivery {
    /// The server streams it (a `206`).
    Stream(ByteStream),
    /// A presigned URL valid for 60 s, sent as a `307`.
    Redirect(String),
}

pub type BoxFuture<'a, T> = Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

/// Why a read failed.
#[derive(Debug)]
pub enum ReadError {
    /// The store has no such blob.
    NotFound,
    /// Anything else, for the log (never sent to clients).
    Failed(String),
}

pub trait BlobStore: Send + Sync {
    /// Where blobs are kept, for logs.
    fn describe(&self) -> String;

    /// Where one blob is: a file path, or `s3://bucket/object`.
    fn locate(&self, key: &str) -> String;

    /// Bytes `[start, end_inclusive]` of a blob.
    fn read_range<'a>(&'a self, key: &'a str, start: u64, end_inclusive: u64) -> BoxFuture<'a, Result<ReadDelivery, ReadError>>;

    /// The staged file's size at which it is sent on as a part; None when parts are never sent
    /// before the end (the local store).
    /// `total` is None while the upload's length is not known yet (it comes with the last append).
    fn part_target(&self, total: Option<u64>) -> Option<u64>;

    /// Starts a multipart upload for a file of `total` bytes, when this store sends parts.
    fn begin_upload<'a>(&'a self, key: &'a str, total: Option<u64>) -> BoxFuture<'a, Result<Option<String>, String>>;

    /// Sends the whole staged file as part `part_num`. Returns its ETag and size.
    fn flush_part<'a>(&'a self, key: &'a str, upload_id: &'a str, part_num: u32, staged: &'a Path) -> BoxFuture<'a, Result<(String, u64), String>>;

    /// Publishes a finished upload. With `upload_id`, every byte has been sent as a part and
    /// `parts` lists them in order; without, `staged` holds the whole file.
    fn complete_upload<'a>(
        &'a self,
        key: &'a str,
        upload_id: Option<&'a str>,
        parts: &'a [(u32, String)],
        staged: &'a Path,
    ) -> BoxFuture<'a, Result<(), String>>;

    /// Drops an unfinished multipart upload. One that is already gone counts as dropped.
    fn abort_upload<'a>(&'a self, key: &'a str, upload_id: &'a str) -> BoxFuture<'a, Result<(), String>>;

    /// Deletes a blob. One that is already gone counts as deleted.
    fn delete<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<(), String>>;

    /// Stores a whole local file as a blob (the server's sample). The file is consumed.
    fn put_file<'a>(&'a self, key: &'a str, path: &'a Path) -> BoxFuture<'a, Result<(), String>>;
}

// ------------------------------------------------------------------------------- local disk

/// Blobs as files: `{root}/{key}`.
pub struct LocalFsStore {
    pub root: PathBuf,
}

impl LocalFsStore {
    fn path(&self, key: &str) -> PathBuf {
        self.root.join(key)
    }
    async fn place(&self, key: &str, from: &Path) -> Result<(), String> {
        let to = self.path(key);
        if let Some(dir) = to.parent() {
            tokio::fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
        }
        if let Ok(f) = std::fs::File::open(from) {
            let _ = f.sync_all();
        }
        tokio::fs::rename(from, &to).await.map_err(|e| e.to_string())
    }
}

impl BlobStore for LocalFsStore {
    fn describe(&self) -> String {
        format!("local files in {}", self.root.display())
    }
    fn locate(&self, key: &str) -> String {
        self.path(key).display().to_string()
    }
    fn read_range<'a>(&'a self, key: &'a str, start: u64, end_inclusive: u64) -> BoxFuture<'a, Result<ReadDelivery, ReadError>> {
        Box::pin(async move {
            let mut f = tokio::fs::File::open(self.path(key)).await.map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => ReadError::NotFound,
                _ => ReadError::Failed(format!("open {key}: {e}")),
            })?;
            f.seek(std::io::SeekFrom::Start(start)).await.map_err(|e| ReadError::Failed(e.to_string()))?;
            let s = tokio_util::io::ReaderStream::with_capacity(f.take(end_inclusive - start + 1), 256 * 1024);
            Ok(ReadDelivery::Stream(Box::pin(s)))
        })
    }
    fn part_target(&self, _: Option<u64>) -> Option<u64> {
        None
    }
    fn begin_upload<'a>(&'a self, _: &'a str, _: Option<u64>) -> BoxFuture<'a, Result<Option<String>, String>> {
        Box::pin(async { Ok(None) })
    }
    fn flush_part<'a>(&'a self, _: &'a str, _: &'a str, _: u32, _: &'a Path) -> BoxFuture<'a, Result<(String, u64), String>> {
        Box::pin(async { Err("the local store does not send parts".to_string()) })
    }
    fn complete_upload<'a>(&'a self, key: &'a str, _: Option<&'a str>, _: &'a [(u32, String)], staged: &'a Path) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(self.place(key, staged))
    }
    fn abort_upload<'a>(&'a self, _: &'a str, _: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    fn delete<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            match tokio::fs::remove_file(self.path(key)).await {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("delete {key}: {e}")),
                _ => Ok(()),
            }
        })
    }
    fn put_file<'a>(&'a self, key: &'a str, path: &'a Path) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(self.place(key, path))
    }
}

// ----------------------------------------------------------------------------------------- S3

/// How S3 blobs reach readers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadMode {
    /// The server reads the range from S3 and streams it.
    Proxy,
    /// The server answers `307` with a presigned URL valid for 60 s.
    Redirect,
}

pub struct S3Config {
    pub endpoint: Option<String>,
    pub bucket: String,
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub prefix: String,
    pub read_mode: ReadMode,
    pub path_style: bool,
}

pub struct S3Store {
    bucket: Bucket,
    creds: Credentials,
    prefix: String,
    http: reqwest::Client,
    read_mode: ReadMode,
    /// Presigned GET URLs by key, reused for 30 s (each is valid for 60 s).
    presigned: Mutex<HashMap<String, (Instant, String)>>,
}

const SIGN_TTL: Duration = Duration::from_secs(60);
const PRESIGN_REUSE: Duration = Duration::from_secs(30);
/// Below this, a file is sent with one PutObject at the end rather than a multipart upload.
const SINGLE_PUT_MAX: u64 = 8 << 20;
/// Part size for an upload whose length is not known yet.
const UNKNOWN_LENGTH_PART: u64 = 16 << 20;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// A request error without its URL: presigned URLs carry signatures and must not reach logs or clients.
fn http_err(what: &str, e: reqwest::Error) -> String {
    format!("S3 {what}: {}", e.without_url())
}

impl S3Store {
    pub fn new(c: S3Config) -> Result<Self, String> {
        let endpoint = c.endpoint.unwrap_or_else(|| format!("https://s3.{}.amazonaws.com", c.region));
        let style = if c.path_style { UrlStyle::Path } else { UrlStyle::VirtualHost };
        let bucket = Bucket::new(endpoint.parse().map_err(err)?, style, c.bucket, c.region).map_err(err)?;
        Ok(Self {
            bucket,
            creds: Credentials::new(c.access_key_id, c.secret_access_key),
            prefix: c.prefix,
            http: reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).build().map_err(err)?,
            read_mode: c.read_mode,
            presigned: Mutex::new(HashMap::new()),
        })
    }

    fn object(&self, key: &str) -> String {
        format!("{}{}", self.prefix, key)
    }

    fn presign_get(&self, key: &str) -> String {
        let now = Instant::now();
        let mut cache = self.presigned.lock().unwrap();
        if let Some((t, u)) = cache.get(key) {
            if now.duration_since(*t) < PRESIGN_REUSE {
                return u.clone();
            }
        }
        let u = self.bucket.get_object(Some(&self.creds), &self.object(key)).sign(SIGN_TTL).to_string();
        cache.retain(|_, (t, _)| now.duration_since(*t) < PRESIGN_REUSE);
        cache.insert(key.to_string(), (now, u.clone()));
        u
    }

    async fn ok(r: Result<reqwest::Response, reqwest::Error>, what: &str) -> Result<reqwest::Response, String> {
        let r = r.map_err(|e| http_err(what, e))?;
        if r.status().is_success() {
            return Ok(r);
        }
        let st = r.status();
        let body = r.text().await.unwrap_or_default();
        Err(format!("S3 {what}: {st} {}", body.chars().take(300).collect::<String>()))
    }

    async fn put_object_from(&self, key: &str, path: &Path) -> Result<(), String> {
        let f = tokio::fs::File::open(path).await.map_err(err)?;
        let len = f.metadata().await.map_err(err)?.len();
        let obj = self.object(key);
        let url = self.bucket.put_object(Some(&self.creds), &obj).sign(SIGN_TTL);
        let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(f));
        Self::ok(self.http.put(url).header("Content-Length", len).body(body).send().await, "PutObject").await?;
        Ok(())
    }

    async fn upload_part_from(&self, key: &str, upload_id: &str, part_num: u32, path: &Path, start: u64, len: u64) -> Result<String, String> {
        let mut f = tokio::fs::File::open(path).await.map_err(err)?;
        f.seek(std::io::SeekFrom::Start(start)).await.map_err(err)?;
        let obj = self.object(key);
        let url = UploadPart::new(&self.bucket, Some(&self.creds), &obj, part_num as u16, upload_id).sign(SIGN_TTL);
        let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(f.take(len)));
        let r = Self::ok(self.http.put(url).header("Content-Length", len).body(body).send().await, "UploadPart").await?;
        Ok(r.headers().get("etag").and_then(|v| v.to_str().ok()).ok_or("S3 UploadPart: no ETag")?.to_string())
    }

    async fn create_multipart(&self, key: &str) -> Result<String, String> {
        let obj = self.object(key);
        let url = CreateMultipartUpload::new(&self.bucket, Some(&self.creds), &obj).sign(SIGN_TTL);
        let body = Self::ok(self.http.post(url).send().await, "CreateMultipartUpload").await?.text().await.map_err(|e| http_err("CreateMultipartUpload", e))?;
        Ok(CreateMultipartUpload::parse_response(&body).map_err(err)?.upload_id().to_string())
    }

    async fn complete_multipart(&self, key: &str, upload_id: &str, parts: &[(u32, String)]) -> Result<(), String> {
        let obj = self.object(key);
        let (url, body) = {
            let a = CompleteMultipartUpload::new(&self.bucket, Some(&self.creds), &obj, upload_id, parts.iter().map(|(_, e)| e.as_str()));
            (a.sign(SIGN_TTL), a.body())
        };
        let r = Self::ok(self.http.post(url).body(body).send().await, "CompleteMultipartUpload").await?;
        // S3 can report a failure inside a 200.
        let text = r.text().await.unwrap_or_default();
        if text.contains("<Error>") {
            return Err(format!("S3 CompleteMultipartUpload: {}", text.chars().take(300).collect::<String>()));
        }
        Ok(())
    }
}

impl BlobStore for S3Store {
    fn describe(&self) -> String {
        format!(
            "S3 bucket {} at {} ({} reads)",
            self.bucket.name(),
            self.bucket.base_url(),
            if self.read_mode == ReadMode::Proxy { "proxied" } else { "redirected" }
        )
    }

    fn locate(&self, key: &str) -> String {
        format!("s3://{}/{}", self.bucket.name(), self.object(key))
    }

    fn read_range<'a>(&'a self, key: &'a str, start: u64, end_inclusive: u64) -> BoxFuture<'a, Result<ReadDelivery, ReadError>> {
        Box::pin(async move {
            let url = self.presign_get(key);
            if self.read_mode == ReadMode::Redirect {
                return Ok(ReadDelivery::Redirect(url));
            }
            let r = self
                .http
                .get(url)
                .header("Range", format!("bytes={start}-{end_inclusive}"))
                .send()
                .await
                .map_err(|e| ReadError::Failed(http_err("GetObject", e)))?;
            // Only the asked-for bytes may be streamed: a 206 for the range, or a 200 when the
            // range is the whole object.
            let whole = start == 0 && r.content_length() == Some(end_inclusive + 1);
            match r.status().as_u16() {
                206 => {}
                200 if whole => {}
                404 => return Err(ReadError::NotFound),
                st => return Err(ReadError::Failed(format!("S3 GetObject {key}: status {st} for bytes {start}-{end_inclusive}"))),
            }
            Ok(ReadDelivery::Stream(Box::pin(r.bytes_stream().map_err(|e| std::io::Error::other(e.without_url())))))
        })
    }

    fn part_target(&self, total: Option<u64>) -> Option<u64> {
        // S3: parts of at least 5 MiB (but the last), at most 10,000 parts. A length not known yet
        // gets 16 MiB parts: files up to 160 GB.
        let Some(total) = total else { return Some(UNKNOWN_LENGTH_PART) };
        let per = total.div_ceil(9500).div_ceil(64 << 10) * (64 << 10);
        Some(per.max(8 << 20))
    }

    fn begin_upload<'a>(&'a self, key: &'a str, total: Option<u64>) -> BoxFuture<'a, Result<Option<String>, String>> {
        Box::pin(async move {
            // A length not known yet may be large: multipart (a single small part completes fine).
            if total.is_some_and(|t| t <= SINGLE_PUT_MAX) {
                return Ok(None);
            }
            Ok(Some(self.create_multipart(key).await?))
        })
    }

    fn flush_part<'a>(&'a self, key: &'a str, upload_id: &'a str, part_num: u32, staged: &'a Path) -> BoxFuture<'a, Result<(String, u64), String>> {
        Box::pin(async move {
            let len = tokio::fs::metadata(staged).await.map_err(err)?.len();
            let etag = self.upload_part_from(key, upload_id, part_num, staged, 0, len).await?;
            Ok((etag, len))
        })
    }

    fn complete_upload<'a>(
        &'a self,
        key: &'a str,
        upload_id: Option<&'a str>,
        parts: &'a [(u32, String)],
        staged: &'a Path,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            match upload_id {
                None => self.put_object_from(key, staged).await?,
                Some(id) => self.complete_multipart(key, id, parts).await?,
            }
            let _ = tokio::fs::remove_file(staged).await;
            Ok(())
        })
    }

    fn abort_upload<'a>(&'a self, key: &'a str, upload_id: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let obj = self.object(key);
            let url = AbortMultipartUpload::new(&self.bucket, Some(&self.creds), &obj, upload_id).sign(SIGN_TTL);
            let r = self.http.delete(url).send().await.map_err(|e| http_err("AbortMultipartUpload", e))?;
            // 404 (NoSuchUpload): already aborted or completed.
            if r.status().is_success() || r.status().as_u16() == 404 {
                return Ok(());
            }
            Err(format!("S3 AbortMultipartUpload {key}: status {}", r.status()))
        })
    }

    fn delete<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.presigned.lock().unwrap().remove(key);
            let url = self.bucket.delete_object(Some(&self.creds), &self.object(key)).sign(SIGN_TTL);
            let r = self.http.delete(url).send().await.map_err(|e| http_err("DeleteObject", e))?;
            if r.status().is_success() || r.status().as_u16() == 404 {
                return Ok(());
            }
            Err(format!("S3 DeleteObject {key}: status {}", r.status()))
        })
    }

    fn put_file<'a>(&'a self, key: &'a str, path: &'a Path) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let total = tokio::fs::metadata(path).await.map_err(err)?.len();
            if total <= SINGLE_PUT_MAX {
                self.put_object_from(key, path).await?;
            } else {
                let target = self.part_target(Some(total)).unwrap();
                let id = self.create_multipart(key).await?;
                let mut parts = Vec::new();
                let mut at = 0;
                while at < total {
                    let len = target.min(total - at);
                    match self.upload_part_from(key, &id, parts.len() as u32 + 1, path, at, len).await {
                        Ok(etag) => parts.push((parts.len() as u32 + 1, etag)),
                        Err(e) => {
                            let _ = self.abort_upload(key, &id).await;
                            return Err(e);
                        }
                    }
                    at += len;
                }
                if let Err(e) = self.complete_multipart(key, &id, &parts).await {
                    let _ = self.abort_upload(key, &id).await;
                    return Err(e);
                }
            }
            let _ = tokio::fs::remove_file(path).await;
            Ok(())
        })
    }
}
