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

struct LocalState {
    chdb: Chdb,
}

#[derive(Parser)]
#[command(name = "maple", version, about = "Local Maple: OTLP ingest + embedded ClickHouse + UI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Start the local ingest + query server.
    Start(StartArgs),
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

#[tokio::main]
async fn main() {
    match Cli::parse().command {
        Commands::Start(args) => start(args).await,
    }
}

async fn start(args: StartArgs) {
    let data_dir = args.data_dir.unwrap_or_else(default_data_dir);
    if let Err(error) = std::fs::create_dir_all(&data_dir) {
        eprintln!("Failed to create data dir {}: {error}", data_dir.display());
        std::process::exit(1);
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

    println!("maple listening on http://{addr}");
    println!("  OTLP/HTTP:  POST /v1/{{traces,logs,metrics}}");
    println!("  query API:  POST /local/query  {{ \"sql\": \"...\" }}");
    println!("  UI:         http://{addr}/");

    if let Err(error) = axum::serve(listener, app).await {
        eprintln!("Server error: {error}");
        std::process::exit(1);
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
    match state.chdb.query(body.sql).await {
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
