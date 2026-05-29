//! `maple` — the standalone local binary.
//!
//! A single process that owns an embedded chDB (in-process ClickHouse) and
//! serves three things on one port:
//!   - OTLP/HTTP ingest (`POST /v1/{traces,logs,metrics}`)
//!   - a raw SQL query API for the bundled UI (`POST /local/query`)
//!   - the bundled SPA (everything else, with client-side-routing fallback)
//!
//! It reuses the production ingest's OTLP→NDJSON encoders (`maple_ingest::
//! telemetry::encode_local_*`) so local rows are shaped identically to cloud
//! rows, then writes them to chDB via the embedded schema + insert mappings.
//! Single-tenant: every row is pinned to `OrgId = "local"`.

use std::io::Read;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, State};
use axum::http::header::{CONTENT_ENCODING, CONTENT_TYPE};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use clap::{Args, Parser, Subcommand};
use flate2::read::GzDecoder;
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use prost::Message;
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::json;
use tower_http::cors::{Any, CorsLayer};

use maple_ingest::chdb::Chdb;
use maple_ingest::telemetry::{self, LocalBatch};

/// Pinned single-tenant org id. Must match the org the UI passes to every
/// `CH.compile(...)` and the placeholder the insert mappings substitute.
const ORG_ID: &str = "local";

/// SPA assets baked into the binary at compile time. `apps/local-ui` builds
/// here in a later phase; until then this holds a placeholder page.
#[derive(RustEmbed)]
#[folder = "ui-dist/"]
struct UiAssets;

/// The `maple-cli` query binary, baked into `maple` at compile time.
/// Built by the build script into `apps/ingest/cli-dist/` before `cargo build`
/// so rust-embed can pick it up. Extracted on first use to `~/.maple/`.
#[derive(RustEmbed)]
#[folder = "cli-dist/"]
struct CliAssets;

struct LocalState {
    chdb: Chdb,
}

#[derive(Parser)]
#[command(
    name = "maple",
    version,
    about = "Local Maple: OTLP ingest + embedded ClickHouse + UI",
    long_about = "Local Maple: OTLP ingest + embedded ClickHouse + UI.\n\n\
        Run `maple start` to start the server, then use the query subcommands\n\
        to inspect your telemetry. Query commands are forwarded to the bundled\n\
        `maple-cli` binary — run `maple <command> --help` for their flags."
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

/// Passthrough args for query subcommands forwarded to maple-cli.
/// All flags and positional arguments are accepted and forwarded verbatim.
#[derive(Args)]
struct PassthroughArgs {
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
}

#[derive(Subcommand)]
enum Commands {
    // ── Server ────────────────────────────────────────────────────────────────
    /// Start the local ingest + query server.
    Start(StartArgs),
    /// Stop a running `maple start` server.
    Stop(StopArgs),

    // ── Query (forwarded to maple-cli) ────────────────────────────────────────
    /// List services and their health metrics (p50/p95/p99, error rate).
    Services(PassthroughArgs),
    /// Search root traces with optional service / time / error filters.
    Traces(PassthroughArgs),
    /// Inspect all spans in a single trace.
    Trace(PassthroughArgs),
    /// Find the slowest root traces.
    #[command(name = "slow-traces")]
    SlowTraces(PassthroughArgs),
    /// Show the service dependency graph.
    #[command(name = "service-map")]
    ServiceMap(PassthroughArgs),
    /// Run a health + performance diagnosis for a service.
    Diagnose(PassthroughArgs),
    /// List error groups with fingerprints and occurrence counts.
    Errors(PassthroughArgs),
    /// Show detail for a single error group (stack trace, timeseries).
    Error(PassthroughArgs),
    /// Search log lines.
    Logs(PassthroughArgs),
    /// Mine recurring patterns from log lines.
    #[command(name = "log-patterns")]
    LogPatterns(PassthroughArgs),
    /// Explore span and resource attribute keys and values.
    Attributes(PassthroughArgs),
    /// List metric names in the local store.
    Metrics(PassthroughArgs),
    /// Run raw SQL against the embedded ClickHouse store.
    Query(PassthroughArgs),
}

#[derive(Args)]
struct StartArgs {
    /// Port for OTLP/HTTP ingest, the query API, and the bundled UI.
    #[arg(long, default_value_t = 4318)]
    port: u16,
    /// Directory for the embedded ClickHouse data (default: ~/.maple/data).
    #[arg(long)]
    data_dir: Option<PathBuf>,
}

#[derive(Args)]
struct StopArgs {
    /// Data directory used to locate the PID file (default: ~/.maple/data).
    #[arg(long)]
    data_dir: Option<PathBuf>,
}

#[tokio::main]
async fn main() {
    match Cli::parse().command {
        Commands::Start(args) => start(args).await,
        Commands::Stop(args) => stop(args),
        // Forward every query subcommand to maple-cli, prepending its name.
        Commands::Services(a)    => forward_to_cli(prepend("services", a.args)),
        Commands::Traces(a)      => forward_to_cli(prepend("traces", a.args)),
        Commands::Trace(a)       => forward_to_cli(prepend("trace", a.args)),
        Commands::SlowTraces(a)  => forward_to_cli(prepend("slow-traces", a.args)),
        Commands::ServiceMap(a)  => forward_to_cli(prepend("service-map", a.args)),
        Commands::Diagnose(a)    => forward_to_cli(prepend("diagnose", a.args)),
        Commands::Errors(a)      => forward_to_cli(prepend("errors", a.args)),
        Commands::Error(a)       => forward_to_cli(prepend("error", a.args)),
        Commands::Logs(a)        => forward_to_cli(prepend("logs", a.args)),
        Commands::LogPatterns(a) => forward_to_cli(prepend("log-patterns", a.args)),
        Commands::Attributes(a)  => forward_to_cli(prepend("attributes", a.args)),
        Commands::Metrics(a)     => forward_to_cli(prepend("metrics", a.args)),
        Commands::Query(a)       => forward_to_cli(prepend("query", a.args)),
    }
}

fn prepend(name: &str, mut args: Vec<String>) -> Vec<String> {
    args.insert(0, name.to_string());
    args
}

/// Extract the embedded `maple-cli` binary to `~/.maple/` (once per version)
/// and exec into it with the provided args.
///
/// The extracted path includes a short content hash so a new `maple` build
/// automatically re-extracts an updated CLI. Old versions are cleaned up.
/// Files written by a running process are not quarantined by macOS Gatekeeper,
/// so no `xattr` call is needed at runtime.
///
/// Dev fallback: if `CliAssets` is empty (build ran without `cli-dist/` present,
/// e.g. a raw `cargo run` in the dev checkout), prints a hint and exits.
fn forward_to_cli(args: Vec<String>) -> ! {
    let Some(asset) = CliAssets::get("maple-cli") else {
        eprintln!(
            "maple: the embedded query CLI was not found.\n\
             In a dev checkout, run the CLI directly:\n  \
             bun run apps/local-cli/src/bin.ts {}", args.join(" ")
        );
        std::process::exit(127);
    };

    // Derive an 8-hex-char stamp from the first 4 bytes of the content — fast,
    // no crypto dep needed. Collisions are harmless (worst case: stale extract).
    let bytes = asset.data.as_ref();
    let stamp = bytes.iter().take(4).fold(0u32, |acc, &b| acc.rotate_left(8) ^ b as u32);
    let stamp_hex = format!("{stamp:08x}");

    let extract_dir = std::env::var_os("HOME")
        .map(|h| std::path::PathBuf::from(h).join(".maple"))
        .unwrap_or_else(std::env::temp_dir);
    let cli_path = extract_dir.join(format!("maple-cli-{stamp_hex}"));

    if !cli_path.exists() {
        // Clean up old versions before writing the new one.
        if let Ok(entries) = std::fs::read_dir(&extract_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let s = name.to_string_lossy();
                if s.starts_with("maple-cli-") && s != format!("maple-cli-{stamp_hex}") {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        if let Err(e) = std::fs::create_dir_all(&extract_dir) {
            eprintln!("maple: failed to create {}: {e}", extract_dir.display());
            std::process::exit(1);
        }
        if let Err(e) = std::fs::write(&cli_path, bytes) {
            eprintln!("maple: failed to write {}: {e}", cli_path.display());
            std::process::exit(1);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Err(e) = std::fs::set_permissions(&cli_path, std::fs::Permissions::from_mode(0o755)) {
                eprintln!("maple: failed to chmod {}: {e}", cli_path.display());
                std::process::exit(1);
            }
        }
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = std::process::Command::new(&cli_path).args(&args).exec();
        eprintln!("maple: failed to exec {}: {err}", cli_path.display());
        std::process::exit(1);
    }
    #[cfg(not(unix))]
    {
        match std::process::Command::new(&cli_path).args(&args).status() {
            Ok(status) => std::process::exit(status.code().unwrap_or(1)),
            Err(err) => {
                eprintln!("maple: failed to run {}: {err}", cli_path.display());
                std::process::exit(1);
            }
        }
    }
}

async fn start(args: StartArgs) {
    let data_dir = args.data_dir.unwrap_or_else(default_data_dir);
    let pid_path = pid_file_path(&data_dir);

    if let Err(error) = std::fs::create_dir_all(&data_dir) {
        eprintln!("Failed to create data dir {}: {error}", data_dir.display());
        std::process::exit(1);
    }

    // --- already-running check -------------------------------------------
    if let Some(pid) = read_pid(&pid_path) {
        if is_process_alive(pid) {
            eprintln!("maple is already running (PID {pid}).");
            eprintln!("  Run `maple stop` to stop it.");
            std::process::exit(1);
        }
        // Stale PID file from a previous crash — remove it silently.
        let _ = std::fs::remove_file(&pid_path);
    }

    eprintln!("Opening chDB at {} (bootstrapping schema)...", data_dir.display());
    let chdb = match Chdb::start(data_dir, ORG_ID) {
        Ok(chdb) => chdb,
        Err(error) => {
            eprintln!("Failed to start chDB: {error}");
            std::process::exit(1);
        }
    };

    let state = Arc::new(LocalState { chdb });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([CONTENT_TYPE, CONTENT_ENCODING]);

    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/traces", post(handle_traces))
        .route("/v1/logs", post(handle_logs))
        .route("/v1/metrics", post(handle_metrics))
        .route("/local/query", post(handle_query))
        .fallback(serve_ui)
        .layer(cors)
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], args.port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("Failed to bind {addr}: {error}");
            std::process::exit(1);
        }
    };

    // --- write PID file ---------------------------------------------------
    let my_pid = std::process::id();
    if let Err(e) = std::fs::write(&pid_path, my_pid.to_string()) {
        eprintln!("Warning: could not write PID file {}: {e}", pid_path.display());
    }

    println!("maple listening on http://{addr}");
    println!("  OTLP/HTTP:  POST /v1/{{traces,logs,metrics}}");
    println!("  query API:  POST /local/query  {{ \"sql\": \"...\" }}");
    println!("  UI:         http://{addr}/");
    println!("  PID:        {my_pid}  (stop with `maple stop`)");

    let res = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await;

    // --- cleanup ----------------------------------------------------------
    let _ = std::fs::remove_file(&pid_path);
    if let Err(error) = res {
        eprintln!("Server error: {error}");
        std::process::exit(1);
    }
}

/// Stop a running `maple start` process by reading its PID file and sending SIGTERM.
fn stop(args: StopArgs) -> ! {
    let data_dir = args.data_dir.unwrap_or_else(default_data_dir);
    let pid_path = pid_file_path(&data_dir);

    let Some(pid) = read_pid(&pid_path) else {
        eprintln!("maple is not running (no PID file found at {}).", pid_path.display());
        std::process::exit(1);
    };

    if !is_process_alive(pid) {
        eprintln!("maple is not running (stale PID file; cleaning up).");
        let _ = std::fs::remove_file(&pid_path);
        std::process::exit(1);
    }

    send_signal(pid, "TERM");
    eprint!("Stopping maple (PID {pid})");

    // Wait up to 5 s for the process to exit.
    for _ in 0..50 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        eprint!(".");
        if !is_process_alive(pid) {
            let _ = std::fs::remove_file(&pid_path);
            eprintln!("\nmaple stopped.");
            std::process::exit(0);
        }
    }

    eprintln!("\nmaple did not stop within 5 s. Force-kill with: kill -9 {pid}");
    std::process::exit(1);
}

// --- process / PID helpers -----------------------------------------------

fn pid_file_path(data_dir: &PathBuf) -> PathBuf {
    // Place the PID file one level above the data dir (e.g. ~/.maple/maple.pid)
    // so `maple stop` can find it without knowing the full data path.
    data_dir
        .parent()
        .unwrap_or(data_dir.as_path())
        .join("maple.pid")
}

fn read_pid(path: &PathBuf) -> Option<u32> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

/// Returns true if a process with this PID is currently alive (signal 0).
fn is_process_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn send_signal(pid: u32, sig: &str) {
    let _ = std::process::Command::new("kill")
        .args([&format!("-{sig}"), &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// Resolves when SIGINT (Ctrl-C) or SIGTERM is received.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl-C handler");
    };

    #[cfg(unix)]
    let sigterm = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let sigterm = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = sigterm => {},
    }
}

fn default_data_dir() -> PathBuf {
    match std::env::var_os("HOME") {
        Some(home) => PathBuf::from(home).join(".maple").join("data"),
        None => PathBuf::from(".maple").join("data"),
    }
}

async fn health() -> &'static str {
    "OK"
}

// --- OTLP ingest -----------------------------------------------------------

async fn handle_traces(State(state): State<Arc<LocalState>>, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    let raw = match decompress(&headers, &body) {
        Ok(raw) => raw,
        Err(response) => return response,
    };
    let request: ExportTraceServiceRequest = match decode(&headers, &raw) {
        Ok(request) => request,
        Err(response) => return response,
    };
    match telemetry::encode_local_traces(ORG_ID, &request) {
        Ok(batches) => ingest_batches(&state.chdb, batches).await,
        Err(error) => server_error(format!("encode traces: {error}")),
    }
}

async fn handle_logs(State(state): State<Arc<LocalState>>, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    let raw = match decompress(&headers, &body) {
        Ok(raw) => raw,
        Err(response) => return response,
    };
    let request: ExportLogsServiceRequest = match decode(&headers, &raw) {
        Ok(request) => request,
        Err(response) => return response,
    };
    match telemetry::encode_local_logs(ORG_ID, &request) {
        Ok(batches) => ingest_batches(&state.chdb, batches).await,
        Err(error) => server_error(format!("encode logs: {error}")),
    }
}

async fn handle_metrics(State(state): State<Arc<LocalState>>, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    let raw = match decompress(&headers, &body) {
        Ok(raw) => raw,
        Err(response) => return response,
    };
    let request: ExportMetricsServiceRequest = match decode(&headers, &raw) {
        Ok(request) => request,
        Err(response) => return response,
    };
    match telemetry::encode_local_metrics(ORG_ID, &request) {
        Ok(batches) => ingest_batches(&state.chdb, batches).await,
        Err(error) => server_error(format!("encode metrics: {error}")),
    }
}

async fn ingest_batches(chdb: &Chdb, batches: Vec<LocalBatch>) -> Response {
    let mut accepted = 0usize;
    for batch in batches {
        accepted += batch.row_count;
        if let Err(error) = chdb.insert(batch.datasource, batch.payload).await {
            return server_error(format!("chDB insert: {error}"));
        }
    }
    (StatusCode::OK, Json(json!({ "accepted": accepted }))).into_response()
}

/// gzip is the only content-encoding OTLP/HTTP exporters use; anything else is
/// rejected so a mislabeled body can't be silently fed to the decoder.
fn decompress(headers: &HeaderMap, body: &[u8]) -> Result<Vec<u8>, Response> {
    match headers.get(CONTENT_ENCODING).and_then(|value| value.to_str().ok()) {
        None => Ok(body.to_vec()),
        Some("gzip") => {
            let mut decoder = GzDecoder::new(body);
            let mut out = Vec::new();
            decoder
                .read_to_end(&mut out)
                .map_err(|_| bad_request("invalid gzip body"))?;
            Ok(out)
        }
        Some(other) => Err(bad_request(format!("unsupported content-encoding: {other}"))),
    }
}

/// Decode an OTLP request as protobuf (default) or JSON (when the content-type
/// says so). The proto types derive serde via the `with-serde` feature.
fn decode<T>(headers: &HeaderMap, raw: &[u8]) -> Result<T, Response>
where
    T: Message + Default + for<'de> Deserialize<'de>,
{
    let is_json = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|content_type| content_type.contains("json"))
        .unwrap_or(false);

    if is_json {
        serde_json::from_slice::<T>(raw).map_err(|_| bad_request("invalid OTLP JSON payload"))
    } else {
        T::decode(raw).map_err(|_| bad_request("invalid OTLP protobuf payload"))
    }
}

// --- Query API -------------------------------------------------------------

#[derive(Deserialize)]
struct QueryBody {
    sql: String,
}

async fn handle_query(State(state): State<Arc<LocalState>>, Json(body): Json<QueryBody>) -> Response {
    // This handler owns the output FORMAT: it wraps line-delimited rows into a
    // JSON array, so it always runs the query as `FORMAT JSONEachRow` regardless
    // of what the caller sent (`CH.compile(...)` appends `FORMAT JSON`). Callers
    // POST `compiled.sql` verbatim.
    match state.chdb.query(force_json_each_row(&body.sql)).await {
        Ok(bytes) => {
            // chDB returns JSONEachRow (one JSON object per line). Wrap the
            // lines into a JSON array without re-parsing each row.
            let text = String::from_utf8_lossy(&bytes);
            let rows: Vec<&str> = text.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
            let array = format!("[{}]", rows.join(","));
            ([(CONTENT_TYPE, "application/json")], array).into_response()
        }
        Err(error) => server_error(format!("query failed: {error}")),
    }
}

/// Strip a trailing `FORMAT <ident>` clause (optionally followed by `;`) and
/// re-append `FORMAT JSONEachRow`, making the server the single owner of the
/// output format. `<ident>` must be a bare identifier bounded by whitespace on
/// both sides so we only strip a real trailing clause, not e.g. a `formatX`
/// column reference. Case-insensitive; ASCII-lowercasing preserves byte length,
/// so indices map back to the original string.
fn force_json_each_row(sql: &str) -> String {
    let mut s = sql.trim_end();
    if let Some(stripped) = s.strip_suffix(';') {
        s = stripped.trim_end();
    }

    let lower = s.to_ascii_lowercase();
    if let Some(pos) = lower.rfind("format") {
        let before_ok = pos == 0 || s[..pos].chars().next_back().is_some_and(char::is_whitespace);
        let rest = &s[pos + "format".len()..];
        let after_ok = rest.starts_with(char::is_whitespace);
        let ident = rest.trim();
        let is_ident = !ident.is_empty() && ident.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if before_ok && after_ok && is_ident {
            s = s[..pos].trim_end();
        }
    }

    format!("{s}\nFORMAT JSONEachRow")
}

// --- Bundled SPA -----------------------------------------------------------

async fn serve_ui(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    if let Some(asset) = UiAssets::get(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        return ([(CONTENT_TYPE, mime.as_ref())], asset.data.into_owned()).into_response();
    }

    // Unknown path with no file extension → client-side route; serve the SPA
    // shell so the router can take over.
    match UiAssets::get("index.html") {
        Some(asset) => ([(CONTENT_TYPE, "text/html")], asset.data.into_owned()).into_response(),
        None => (StatusCode::NOT_FOUND, "UI not built").into_response(),
    }
}

// --- Errors ----------------------------------------------------------------

fn bad_request(message: impl Into<String>) -> Response {
    (StatusCode::BAD_REQUEST, message.into()).into_response()
}

fn server_error(message: impl Into<String>) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, message.into()).into_response()
}

#[cfg(test)]
mod tests {
    use super::force_json_each_row;

    #[test]
    fn replaces_trailing_format_json() {
        assert_eq!(force_json_each_row("SELECT 1 FORMAT JSON"), "SELECT 1\nFORMAT JSONEachRow");
    }

    #[test]
    fn appends_when_no_format_clause() {
        assert_eq!(force_json_each_row("SELECT 1"), "SELECT 1\nFORMAT JSONEachRow");
    }

    #[test]
    fn idempotent_on_json_each_row() {
        assert_eq!(force_json_each_row("SELECT 1 FORMAT JSONEachRow"), "SELECT 1\nFORMAT JSONEachRow");
    }

    #[test]
    fn tolerates_trailing_semicolon_and_whitespace() {
        assert_eq!(force_json_each_row("SELECT 1 FORMAT JSON ;  "), "SELECT 1\nFORMAT JSONEachRow");
    }

    #[test]
    fn case_insensitive_keyword() {
        assert_eq!(force_json_each_row("select 1 format json"), "select 1\nFORMAT JSONEachRow");
    }

    #[test]
    fn does_not_strip_format_function_call() {
        // A trailing `formatDateTime(...)` is not a FORMAT clause and must survive.
        let sql = "SELECT formatDateTime(ts, '%F') AS day";
        assert_eq!(force_json_each_row(sql), format!("{sql}\nFORMAT JSONEachRow"));
    }
}
