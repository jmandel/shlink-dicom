use std::path::PathBuf;
use clap::{Parser, Subcommand};
use shl_dicom_server::{
    build_app_router,
    cli::{run_inspect_cli, run_pack_cli},
    seed::seed_demo_shares,
    state::AppState,
};

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
    },
    /// Inspect an shlink:/ URI and verify a single-instance HTTP 206 Range read
    Inspect {
        /// The shlink:/... or viewer#shlink:/... URI
        shlink: String,
        /// Optional passcode for P-mode links
        #[arg(long)]
        passcode: Option<String>,
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
        } => {
            if let Err(e) = run_pack_cli(&inputs, &out, base_url.as_deref(), label.as_deref()) {
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
        Commands::Serve {
            port,
            data_dir,
            public_origin,
        } => {
            let state = AppState::new(&data_dir).expect("failed to initialize AppState");
            let origin = public_origin.unwrap_or_else(|| format!("http://localhost:{port}"));
            println!("Seeding demo shares in {:?}...", data_dir);
            if let Err(e) = seed_demo_shares(&state, &origin) {
                eprintln!("Warning: demo seeding failed: {e}");
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
