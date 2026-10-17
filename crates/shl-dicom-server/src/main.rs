use std::path::PathBuf;
use std::sync::Arc;
use clap::{Args, Parser, Subcommand, ValueEnum};
use shl_dicom_server::{
    build_app_router,
    cli::{run_inspect_cli, run_pack_cli},
    seed::{load_sample, seed_sample},
    state::{AppState, Quotas},
    storage::{BlobStore, LocalFsStore, ReadMode, S3Config, S3Store},
};

#[derive(Clone, Copy, ValueEnum)]
enum ReadModeArg {
    /// The server reads the range from S3 and streams it
    Proxy,
    /// The server answers 307 with a presigned URL valid for 60 s
    Redirect,
}

/// Where encrypted files are kept: local disk (default) or a private S3 bucket.
#[derive(Args)]
struct StoreArgs {
    /// S3 bucket; when set, files go to S3 instead of {data-dir}/blobs
    #[arg(long, env = "SHL_S3_BUCKET")]
    s3_bucket: Option<String>,
    /// S3 endpoint URL (unset: the AWS endpoint for the region)
    #[arg(long, env = "SHL_S3_ENDPOINT")]
    s3_endpoint: Option<String>,
    /// S3 region, for request signing
    #[arg(long, env = "SHL_S3_REGION", default_value = "us-east-1")]
    s3_region: String,
    #[arg(long, env = "AWS_ACCESS_KEY_ID", hide_env_values = true)]
    s3_access_key_id: Option<String>,
    #[arg(long, env = "AWS_SECRET_ACCESS_KEY", hide_env_values = true)]
    s3_secret_access_key: Option<String>,
    /// Key prefix inside the bucket (for example "shl/")
    #[arg(long, env = "SHL_S3_PREFIX", default_value = "")]
    s3_prefix: String,
    /// How readers get S3 bytes
    #[arg(long, env = "SHL_S3_READ_MODE", value_enum, default_value = "proxy")]
    s3_read_mode: ReadModeArg,
    /// Path-style URLs (http://host/bucket/key), as MinIO and other local services need
    #[arg(long, env = "SHL_S3_PATH_STYLE", default_value_t = false)]
    s3_path_style: bool,
}

impl StoreArgs {
    fn store(&self, data_dir: &std::path::Path) -> Arc<dyn BlobStore> {
        let Some(bucket) = self.s3_bucket.clone() else {
            return Arc::new(LocalFsStore { root: data_dir.join("blobs") });
        };
        let (Some(id), Some(secret)) = (self.s3_access_key_id.clone(), self.s3_secret_access_key.clone()) else {
            eprintln!("--s3-bucket needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY");
            std::process::exit(2);
        };
        let s = S3Store::new(S3Config {
            endpoint: self.s3_endpoint.clone(),
            bucket,
            region: self.s3_region.clone(),
            access_key_id: id,
            secret_access_key: secret,
            prefix: self.s3_prefix.clone(),
            read_mode: match self.s3_read_mode {
                ReadModeArg::Proxy => ReadMode::Proxy,
                ReadModeArg::Redirect => ReadMode::Redirect,
            },
            path_style: self.s3_path_style,
        })
        .unwrap_or_else(|e| {
            eprintln!("S3 settings: {e}");
            std::process::exit(2);
        });
        Arc::new(s)
    }
}

/// "20G", "64M", "512K" or plain bytes.
fn parse_size(s: &str) -> Result<u64, String> {
    let s = s.trim();
    let (num, mul) = match s.chars().last() {
        Some('K' | 'k') => (&s[..s.len() - 1], 1u64 << 10),
        Some('M' | 'm') => (&s[..s.len() - 1], 1 << 20),
        Some('G' | 'g') => (&s[..s.len() - 1], 1 << 30),
        Some('T' | 't') => (&s[..s.len() - 1], 1 << 40),
        _ => (s, 1),
    };
    num.trim().parse::<u64>().map(|n| n * mul).map_err(|e| format!("{s}: {e}"))
}

#[derive(Parser)]
#[command(name = "shl-dicom", about = "SMART Health Links DICOM Packer & Server")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Pack DICOM files, folders, .zip or .tgz archives into an SHL Bundle + one .bin file per study
    Pack {
        /// Input paths (.tgz, .zip, .dcm, or directory)
        #[arg(required = true)]
        inputs: Vec<PathBuf>,
        /// Output directory
        #[arg(long, default_value = "dist/pack")]
        out: PathBuf,
        /// Base URL where output files will be hosted
        #[arg(long)]
        base_url: Option<String>,
        /// SHL label
        #[arg(long)]
        label: Option<String>,
        /// Fill in the frame offset table of multi-frame files that lack one (Basic Offset Table, or
        /// Extended Offset Table past 4 GiB). Fragment bytes are unchanged.
        #[arg(long)]
        add_offset_tables: bool,
        /// Pack with given keys instead of random ones, so the same input gives the same files: a
        /// JSON file {"shlKey", "bundleIv", "lastUpdated", "studies": {"<StudyInstanceUID>":
        /// {"fileId", "key"}}}. Every study packed must be listed, and every listed study packed.
        /// Never give a file id and key to different content (spec/README.md §13).
        #[arg(long)]
        keys: Option<PathBuf>,
    },
    /// Re-encode the uncompressed images in DICOM files and .tgz archives without loss, as the seed
    /// and the Share page do (JPEG Lossless SV1, checked bit for bit), writing every file (re-encoded
    /// or as it was) under OUT at its path in the input. For checks: the files a share will hold.
    Compress {
        #[arg(required = true)]
        inputs: Vec<PathBuf>,
        #[arg(long)]
        out: PathBuf,
    },
    /// Inspect an shlink:/ URI and verify a single-instance HTTP 206 Range read
    Inspect {
        /// The shlink:/... or viewer#shlink:/... URI
        shlink: String,
        /// Optional passcode for P-mode links
        #[arg(long)]
        passcode: Option<String>,
    },
    /// Pack the server's sample (data-dir/samples/*.tgz, sample.json, reports.json) into a share,
    /// replacing an earlier one. Run at deploy time; `serve` only loads what this made.
    Seed {
        /// Data directory (catalog.db, shares/, samples/)
        #[arg(long, env = "SHL_DICOM_DATA_DIR", default_value = "./data")]
        data_dir: PathBuf,
        #[command(flatten)]
        store: StoreArgs,
    },
    /// Run the Zero-Knowledge SHL Server and Demo Web App
    Serve {
        /// Port to listen on
        #[arg(long, env = "PORT", default_value_t = 3000)]
        port: u16,
        /// Data directory for catalog.db and shares/{sid}.db
        #[arg(long, env = "SHL_DICOM_DATA_DIR", default_value = "./data")]
        data_dir: PathBuf,
        /// The server's public origin (for example https://shlink-dicom.exe.xyz): the only source
        /// of absolute URLs (the sample's links and redirect, manifest URLs). Unset: from
        /// X-Forwarded-Proto/-Host or Host, only safe behind a proxy that overwrites them
        #[arg(long, env = "SHL_PUBLIC_ORIGIN")]
        public_origin: Option<String>,
        /// Most encrypted bytes one share may hold (for example 20G); 0 for no limit
        #[arg(long, env = "SHL_MAX_SHARE_BYTES", default_value = "0", value_parser = parse_size)]
        max_share_bytes: u64,
        /// Most encrypted files one share may hold; 0 for no limit
        #[arg(long, env = "SHL_MAX_SHARE_FILES", default_value_t = 0)]
        max_share_files: usize,
        /// Most shares at once, not counting the server's sample; 0 for no limit
        #[arg(long, env = "SHL_MAX_SHARES", default_value_t = 256)]
        max_shares: usize,
        /// Largest upload chunk (for example 64M)
        #[arg(long, env = "SHL_MAX_CHUNK_BYTES", default_value = "64M", value_parser = parse_size)]
        max_chunk_bytes: u64,
        /// Lifetime of a passcode link's capability URL, in seconds
        #[arg(long, env = "SHL_CAP_TTL_SECS", default_value_t = 3600)]
        cap_ttl_secs: i64,
        #[command(flatten)]
        store: StoreArgs,
    },
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    match cli.command {
        Commands::Pack {
            inputs,
            out,
            base_url,
            label,
            add_offset_tables,
            keys,
        } => {
            if let Err(e) = run_pack_cli(&inputs, &out, base_url.as_deref(), label.as_deref(), add_offset_tables, keys.as_deref()) {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
        }
        Commands::Compress { inputs, out } => match shl_dicom_server::compress::compress_tree(&inputs, &out) {
            Ok(c) => println!(
                "Compressed {} of {} uncompressed images without loss: {:.1} MB → {:.1} MB",
                c.compressed,
                c.images,
                c.bytes_before as f64 / 1e6,
                c.bytes_after as f64 / 1e6
            ),
            Err(e) => {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
        },
        Commands::Inspect { shlink, passcode } => {
            if let Err(e) = run_inspect_cli(&shlink, passcode.as_deref()).await {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
        }
        Commands::Seed { data_dir, store } => {
            let t0 = std::time::Instant::now();
            // The service keeps running on this data directory while the seed works (the bootstrap
            // restarts it afterwards), so the seed runs none of the startup sweeps.
            let state = AppState::alongside_server(&data_dir, Quotas::default(), store.store(&data_dir)).expect("failed to initialize AppState");
            let result = seed_sample(&state);
            // The earlier sample's files, if any, leave the store now.
            state.empty_trash().await;
            match result {
                Ok(r) => {
                    let c = &r.compression;
                    println!(
                        "Sample packed in {:.1} s: share {}, {} files (one per study), {} instances, {:.1} MB",
                        t0.elapsed().as_secs_f64(),
                        r.sid,
                        r.files,
                        r.instances,
                        r.bytes as f64 / 1e6
                    );
                    println!(
                        "Compressed {} of {} uncompressed images without loss: {:.1} MB → {:.1} MB",
                        c.compressed,
                        c.images,
                        c.bytes_before as f64 / 1e6,
                        c.bytes_after as f64 / 1e6
                    );
                    for (why, n) in &c.declined {
                        println!("  kept as they were ({why}): {n}");
                    }
                    println!("Added frame offset tables to {} multi-frame instance(s) that lacked one", r.offset_tables_added);
                    if !r.skipped.is_empty() {
                        println!("Skipped {} file(s):", r.skipped.len());
                        for s in &r.skipped {
                            println!("  {}: {}", s.name, s.reason);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("Error: {e}");
                    std::process::exit(1);
                }
            }
        }
        Commands::Serve {
            port,
            data_dir,
            public_origin,
            max_share_bytes,
            max_share_files,
            max_shares,
            max_chunk_bytes,
            cap_ttl_secs,
            store,
        } => {
            let quotas = Quotas {
                share_bytes: (max_share_bytes > 0).then_some(max_share_bytes),
                share_files: (max_share_files > 0).then_some(max_share_files),
                shares: (max_shares > 0).then_some(max_shares),
                request_bytes: max_chunk_bytes,
                cap_ttl_secs,
            };
            let store = store.store(&data_dir);
            println!("Files: {}", store.describe());
            let mut state = AppState::with_store(&data_dir, quotas, store).expect("failed to initialize AppState");
            state.public_origin = public_origin.clone().map(|o| o.trim_end_matches('/').to_string());
            // Deleted files and dropped uploads leave the store in the background.
            let gc = state.clone();
            tokio::spawn(async move {
                for round in 0u64.. {
                    // Every 10 minutes: uploads abandoned for a day.
                    if round % 10 == 9 {
                        gc.sweep_stale_uploads();
                    }
                    // Every minute: expired capability URLs, and expired shares with their files.
                    if let Err(e) = gc.run_sweep() {
                        eprintln!("sweep: {e}");
                    }
                    gc.empty_trash().await;
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                }
            });
            let origin = public_origin.unwrap_or_else(|| format!("http://localhost:{port}"));
            if !load_sample(&state, &origin) {
                eprintln!("No sample share in {data_dir:?}: run `shl-dicom-server seed --data-dir {}`.", data_dir.display());
            }
            let app = build_app_router(state);
            let addr = format!("0.0.0.0:{port}");
            let listener = tokio::net::TcpListener::bind(&addr)
                .await
                .expect("failed to bind TCP listener");
            println!("shl-dicom-server listening on http://localhost:{port}");
            // TCP_NODELAY: a response whose body comes after its headers (an S3 range streamed through
            // the server) otherwise waits for the reader's delayed ACK, about 40 ms, before its body.
            use axum::serve::ListenerExt;
            let listener = listener.tap_io(|tcp| {
                let _ = tcp.set_nodelay(true);
            });
            axum::serve(listener, app).await.expect("server error");
        }
    }
}
