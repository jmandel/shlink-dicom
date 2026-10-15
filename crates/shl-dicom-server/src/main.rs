use std::path::PathBuf;
use clap::{Parser, Subcommand};
use shl_dicom_server::{
    build_app_router,
    cli::{run_inspect_cli, run_pack_cli},
    seed::{load_sample, seed_sample},
    state::{AppState, Quotas},
};

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
    /// Pack DICOM files, folders, .zip or .tgz archives into an SHL Bundle + series .bin files
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
    },
    /// Run the Zero-Knowledge SHL Server and Demo Web App
    Serve {
        /// Port to listen on
        #[arg(long, env = "PORT", default_value_t = 3000)]
        port: u16,
        /// Data directory for catalog.db and shares/{sid}.db
        #[arg(long, env = "SHL_DICOM_DATA_DIR", default_value = "./data")]
        data_dir: PathBuf,
        /// Public origin URL used when pre-seeding demo links
        #[arg(long, env = "PUBLIC_ORIGIN")]
        public_origin: Option<String>,
        /// Most encrypted bytes one share may hold (for example 20G); 0 for no limit
        #[arg(long, env = "SHL_MAX_SHARE_BYTES", default_value = "0", value_parser = parse_size)]
        max_share_bytes: u64,
        /// Most series files one share may hold; 0 for no limit
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
        } => {
            if let Err(e) = run_pack_cli(&inputs, &out, base_url.as_deref(), label.as_deref(), add_offset_tables) {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
        }
        Commands::Inspect { shlink, passcode } => {
            if let Err(e) = run_inspect_cli(&shlink, passcode.as_deref()).await {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
        }
        Commands::Seed { data_dir } => {
            let t0 = std::time::Instant::now();
            let state = AppState::new(&data_dir).expect("failed to initialize AppState");
            match seed_sample(&state) {
                Ok(r) => println!(
                    "Sample packed in {:.1} s: share {}, {} series files, {} instances, {:.1} MB",
                    t0.elapsed().as_secs_f64(),
                    r.sid,
                    r.series,
                    r.instances,
                    r.bytes as f64 / 1e6
                ),
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
        } => {
            let quotas = Quotas {
                share_bytes: (max_share_bytes > 0).then_some(max_share_bytes),
                share_files: (max_share_files > 0).then_some(max_share_files),
                shares: (max_shares > 0).then_some(max_shares),
                request_bytes: max_chunk_bytes,
                cap_ttl_secs,
            };
            let state = AppState::with_quotas(&data_dir, quotas).expect("failed to initialize AppState");
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
            axum::serve(listener, app).await.expect("server error");
        }
    }
}
