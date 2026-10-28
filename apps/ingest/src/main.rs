// The tonic `#[async_trait]` export handlers nest deep enough that, with the
// `#[hotpath::measure]` futures layered inside them under `--features hotpath`,
// rustc's layout query overflows the default limit of 128.
#![recursion_limit = "256"]

// Under `--features hotpath-alloc`, `#[hotpath::main(allocator = ...)]` installs
// its own counting allocator wrapped around jemalloc, so this static must step
// aside or the two `#[global_allocator]`s collide at link time.
#[cfg(not(feature = "hotpath-alloc"))]
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

mod autumn;
mod rules_gateway;
mod sources;
mod task_protection;

use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use autumn::{AutumnEntitlements, AutumnTracker};
use axum::body::Bytes;
use axum::extract::DefaultBodyLimit;
use axum::extract::MatchedPath;
use axum::extract::Path;
use axum::extract::Query;
use axum::extract::Request;
use axum::extract::State;
use axum::http::header::{HeaderName, AUTHORIZATION, CONTENT_ENCODING, CONTENT_TYPE, RETRY_AFTER};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use chrono::DateTime;
use dashmap::DashMap;
use flate2::write::GzEncoder;
use flate2::Compression;
use hmac::{Hmac, Mac};
use maple_ingest::ai_session;
use maple_ingest::aws::CredentialsProvider as AwsCredentialsProvider;
use maple_ingest::aws_metric_stream;
use maple_ingest::clickhouse_insert_mappings::SCHEMA_VERSION as CLICKHOUSE_SCHEMA_VERSION;
use maple_ingest::decompress::{gunzip_bounded, gunzip_len_bounded, GunzipError};
use maple_ingest::gcp_logging;
use maple_ingest::gcp_push_auth::{GooglePushAuth, PushAuthError};
use maple_ingest::ingest_rules::{self, IngestSignal, RuleStats};
use maple_ingest::metrics;
use maple_ingest::otel::{
    accept_internal_span, auth_internal_span, build_resource, decode_internal_span,
    entitlement_internal_span, forward_client_span, grpc_server_span, parse_internal_span,
    record_stage_error, rejection_loses_data, resolve_config_internal_span, ResourceConfig,
};
use maple_ingest::otlp_json;
use maple_ingest::r2::{replay_object_key, ReplayBlobStore};
use maple_ingest::session_analytics::{
    derive_referrer_host, sanitize_product_event, sanitize_session_event, sanitize_session_meta,
    take_billable_session_start,
};
use maple_ingest::telemetry::{
    AttributeMappingRule, ClickHouseBreakerConfig, ClickHouseTarget, ClickHouseTargetProvider,
    DatasourceNames, ExportDestination, HttpClient, MappingOperation, MappingSourceContext,
    PipelineError, SamplingPolicy, TelemetryPipeline, TelemetrySignal, TinybirdConfig,
};
use maple_ingest::usage_metrics::{billable_gb, usage_cardinality_view, UsageMetrics};
use maple_ingest::wal_store::WalSegmentStore;
use moka::future::Cache;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge;
use opentelemetry_otlp::{
    Compression as OtlpCompression, LogExporter, MetricExporter, Protocol, SpanExporter,
    WithExportConfig, WithHttpConfig,
};
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, InstrumentationScope, KeyValue};
use opentelemetry_proto::tonic::logs::v1::{LogRecord, ResourceLogs, ScopeLogs};
use opentelemetry_proto::tonic::resource::v1::Resource;
use opentelemetry_sdk::logs::log_processor_with_async_runtime::BatchLogProcessor;
use opentelemetry_sdk::logs::SdkLoggerProvider;
use opentelemetry_sdk::metrics::periodic_reader_with_async_runtime::PeriodicReader;
use opentelemetry_sdk::metrics::{SdkMeterProvider, Temporality};
use opentelemetry_sdk::runtime::Tokio as OtelTokio;
use opentelemetry_sdk::trace::span_processor_with_async_runtime::BatchSpanProcessor;
use opentelemetry_sdk::trace::{
    BatchConfigBuilder, Sampler, SamplingDecision, SamplingResult, SdkTracerProvider, ShouldSample,
};
use prost::Message;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use sha2::Sha256;
use rules_gateway::{IngestRuleResolver, IngestRuleRows, IngestRuleStatRow, IngestRuleStatsSink};
use sources::{
    OverrideMode, PauseWindow, SourceConfigRow, SourcePolicy, SourceRateLimiter, SourceRef,
    SourceSignal, MAX_PUBLIC_ID_LEN, SOURCE_ID_ATTRIBUTE, SOURCE_TOKEN_PREFIX,
};
use tower_http::cors::{Any, CorsLayer};
use tracing::Instrument;
use tracing::{debug, error, info, warn, Span};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::Layer as _;

const INGEST_SOURCE: &str = "maple-ingest-gateway";
const CLOUDFLARE_LOGPUSH_SOURCE: &str = "cloudflare-logpush";

/// Bearer token literal that the maple-onboard skill (and our docs) inline as a
/// placeholder while the user hasn't created a real ingest key yet. The
/// gateway accepts it from anyone, returns 200, and discards the body — so the
/// instrumented app's full bootstrap path can run end-to-end before the user
/// has signed up. See `skills/maple-onboard/SKILL.md`.
const SENTINEL_TOKEN: &str = "MAPLE_TEST";
const SENTINEL_ORG_ID: &str = "sentinel";

/// Fixed input for the startup HMAC fingerprint. Hashing this with the
/// configured `MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY` yields a value that operators
/// can diff against the API's fingerprint to detect env-var drift between the
/// two services. The sentinel must stay byte-identical with the API
/// (`packages/db/src/ingest-key-hash.ts`); changing it on one side without the
/// other defeats the comparison.
const HMAC_FINGERPRINT_SENTINEL: &str = "MAPLE_HMAC_FINGERPRINT_V1";

fn is_sentinel_token(token: &str) -> bool {
    token == SENTINEL_TOKEN
}

type HmacSha256 = Hmac<Sha256>;

/// Credentials for the S3-compatible endpoint that holds replay chunk payloads.
#[derive(Clone)]
struct ReplayBlobStoreConfig {
    endpoint: String,
    bucket: String,
    access_key_id: String,
    secret_access_key: String,
    region: String,
    timeout: Duration,
}

/// Where sealed WAL segments are shipped so a task that dies without draining
/// does not take its backlog with it. Unset means the WAL is local-only, which
/// is what self-hosted and local runs use.
#[derive(Clone, Debug)]
struct WalStoreSettings {
    store: maple_ingest::wal_store::WalStoreConfig,
    /// Static credentials, when the deployment supplies them instead of relying
    /// on the task role.
    access_key_id: Option<String>,
    secret_access_key: Option<String>,
}

#[derive(Clone)]
struct AppConfig {
    port: u16,
    otlp_grpc_port: Option<u16>,
    forward_endpoint: String,
    forward_timeout: Duration,
    /// Head-sampling ratio for the gateway's own traces, in (0, 1].
    self_trace_sample_ratio: f64,
    write_mode: WriteMode,
    tinybird: TinybirdConfig,
    max_request_body_bytes: usize,
    /// Ceiling on a gzip body after decompression; past it the request is a 413.
    max_decoded_body_bytes: usize,
    org_max_in_flight: u64,
    /// Gateway instances sharing each source's requests/second limit.
    rate_limit_fleet_size: u32,
    /// Per-org cap on concurrent GCP Pub/Sub pushes, inside `org_max_in_flight`.
    gcp_org_max_in_flight: u64,
    /// Wall-clock deadline for one HTTP request, or `Duration::ZERO` to run
    /// without one. See `request_timeout_middleware`.
    request_timeout: Duration,
    require_tls: bool,
    key_store_backend: KeyStoreBackend,
    clickhouse_encryption_key: Option<[u8; 32]>,
    lookup_hmac_key: String,
    autumn_secret_key: Option<String>,
    autumn_api_url: String,
    autumn_flush_interval_secs: u64,
    autumn_allow_ttl_secs: u64,
    autumn_deny_ttl_secs: u64,
    ingest_key_cache_ttl_secs: u64,
    org_routing_cache_ttl_secs: u64,
    /// `INGEST_RULES_ENABLED` (default on): apply customer drop/redact rules. Off reads nothing and costs nothing.
    ingest_rules_enabled: bool,
    /// `INGEST_RULES_CACHE_TTL_SECS`: how long an org's compiled rules are reused.
    ingest_rules_cache_ttl_secs: u64,
    /// Ceiling on the total decompressed rrweb payload a single replay session
    /// may accumulate. 0 disables the cap. See `ReplaySessionBudget`.
    replay_max_session_bytes: u64,
    /// Where replay chunk payloads are stored. `None` — the default, and the
    /// only option for self-hosted and BYO-ClickHouse deployments — keeps the
    /// rrweb JSON inline in the `session_replay_events` row. `Some` diverts the
    /// payload to R2 and writes a thin index row with an empty `events`.
    replay_blob_store: Option<ReplayBlobStoreConfig>,
    /// The org Maple's own telemetry is filed under (`maple_org_id` on every
    /// self-telemetry resource, which the downstream collector writes into
    /// `OrgId`). Required, with no default: the old `"internal"` fallback was a
    /// string no org has, so an unset value did not disable self-telemetry — it
    /// wrote a full stream of traces, logs and metrics into the warehouse under
    /// an id nothing can read. Failing at boot is the only honest option.
    internal_org_id: String,
    /// Whether `Cf-IPCountry` on an inbound request can be believed.
    ///
    /// Off by default, and that default is the safe one: container deployments
    /// can expose a direct origin where any client can set the header itself.
    /// Enable it only on deployments where every path to the process is
    /// terminated by Cloudflare. Off simply writes `''`, which is what the
    /// column held before this existed — it cannot regress anything.
    trust_proxy_geo: bool,
    /// How long a graceful shutdown may spend exporting the WAL backlog before
    /// exiting anyway. Must fit inside the ECS `stopTimeout` (SIGTERM → SIGKILL
    /// window) or the drain is cut off mid-flight.
    shutdown_drain_secs: u64,
    wal_store: Option<WalStoreSettings>,
    /// The 401 body for a key this instance does not know. See
    /// `invalid_ingest_key_message`.
    invalid_key_message: &'static str,
    /// `INGEST_BLOCKED_KEYS`: keys refused at origin whatever header spelling carries them.
    blocked_ingest_keys: Arc<HashSet<String>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WriteMode {
    Tinybird,
    Forward,
    Dual,
}

impl WriteMode {
    fn from_env() -> Result<Self, String> {
        let raw = std::env::var("INGEST_WRITE_MODE")
            .unwrap_or_else(|_| "tinybird".to_owned())
            .trim()
            .to_ascii_lowercase();
        match raw.as_str() {
            "tinybird" | "native" => Ok(Self::Tinybird),
            "forward" | "collector" => Ok(Self::Forward),
            "dual" | "dual_write" => Ok(Self::Dual),
            _ => Err("INGEST_WRITE_MODE must be tinybird, forward, or dual".to_owned()),
        }
    }

    fn uses_tinybird(self) -> bool {
        matches!(self, Self::Tinybird | Self::Dual)
    }

    fn uses_forward(self) -> bool {
        matches!(self, Self::Forward | Self::Dual)
    }
}

fn uses_native_pipeline_for(write_mode: WriteMode, destination: ExportDestination) -> bool {
    write_mode.uses_tinybird() || destination == ExportDestination::ClickHouse
}

fn uses_forward_path_for(write_mode: WriteMode, destination: ExportDestination) -> bool {
    write_mode.uses_forward() && destination != ExportDestination::ClickHouse
}

#[derive(Clone)]
enum KeyStoreBackend {
    // No-DB local backend: every well-formed ingest key resolves to a single
    // override org. Selected for single-tenant local dev so contributors don't
    // need database credentials to boot the service.
    Static { org_id: String },
    // PlanetScale Postgres backend used in multi-tenant / production deploys.
    // `url` is the standard pg connection string (PSBouncer port 6432, sslmode
    // require); the API service writes ingest-key rows to the same database.
    Postgres { url: String },
}

impl AppConfig {
    #[expect(
        clippy::too_many_lines,
        reason = "one branch per environment variable, read in the order the deployment docs list \
                  them"
    )]
    fn from_env() -> Result<Self, String> {
        let port = parse_u16(
            "INGEST_PORT",
            std::env::var("INGEST_PORT")
                .ok()
                .or_else(|| std::env::var("PORT").ok()),
            3474,
        )?;
        let otlp_grpc_port = parse_optional_u16(
            "INGEST_OTLP_GRPC_PORT",
            std::env::var("INGEST_OTLP_GRPC_PORT").ok(),
        )?;
        let write_mode = WriteMode::from_env()?;

        let forward_endpoint = std::env::var("INGEST_FORWARD_OTLP_ENDPOINT")
            .unwrap_or_else(|_| "http://127.0.0.1:4318".to_owned())
            .trim()
            .trim_end_matches('/')
            .to_owned();

        if forward_endpoint.is_empty() {
            return Err("INGEST_FORWARD_OTLP_ENDPOINT is required".to_owned());
        }
        let self_trace_sample_ratio = parse_sample_ratio(
            "INGEST_SELF_TRACE_SAMPLE_RATIO",
            std::env::var("INGEST_SELF_TRACE_SAMPLE_RATIO").ok(),
            1.0,
        )?;

        let internal_org_id = std::env::var("MAPLE_INTERNAL_ORG_ID")
            .unwrap_or_default()
            .trim()
            .to_owned();

        if internal_org_id.is_empty() {
            return Err("MAPLE_INTERNAL_ORG_ID is required".to_owned());
        }

        let forward_timeout_ms = parse_u64(
            "INGEST_FORWARD_TIMEOUT_MS",
            std::env::var("INGEST_FORWARD_TIMEOUT_MS").ok(),
            10_000,
        )?;

        // Shared by the pipeline (which runs the heartbeat task) and the store
        // config (which decides how stale a heartbeat has to be).
        let heartbeat_secs = parse_u64(
            "INGEST_WAL_S3_HEARTBEAT_SECS",
            std::env::var("INGEST_WAL_S3_HEARTBEAT_SECS").ok(),
            maple_ingest::wal_store::DEFAULT_HEARTBEAT_INTERVAL.as_secs(),
        )?;

        let tinybird = TinybirdConfig {
            endpoint: std::env::var("TINYBIRD_HOST")
                .unwrap_or_default()
                .trim()
                .trim_end_matches('/')
                .to_owned(),
            token: std::env::var("TINYBIRD_TOKEN")
                .unwrap_or_default()
                .trim()
                .to_owned(),
            queue_dir: PathBuf::from(
                std::env::var("INGEST_QUEUE_DIR")
                    .unwrap_or_else(|_| "/var/lib/maple-ingest/wal".to_owned()),
            ),
            queue_max_bytes: parse_u64(
                "INGEST_QUEUE_MAX_BYTES",
                std::env::var("INGEST_QUEUE_MAX_BYTES").ok(),
                20 * 1024 * 1024 * 1024,
            )?,
            org_queue_max_bytes: parse_u64(
                "INGEST_ORG_QUEUE_MAX_BYTES",
                std::env::var("INGEST_ORG_QUEUE_MAX_BYTES").ok(),
                1024 * 1024 * 1024,
            )?,
            queue_channel_capacity: parse_usize(
                "INGEST_QUEUE_CHANNEL_CAPACITY",
                std::env::var("INGEST_QUEUE_CHANNEL_CAPACITY").ok(),
                100_000,
            )?,
            wal_shards: parse_usize(
                "INGEST_WAL_SHARDS",
                std::env::var("INGEST_WAL_SHARDS").ok(),
                (num_cpus::get().max(1) * 2).max(2),
            )?,
            wal_segment_max_bytes: parse_u64(
                "INGEST_WAL_SEGMENT_MAX_BYTES",
                std::env::var("INGEST_WAL_SEGMENT_MAX_BYTES").ok(),
                maple_ingest::telemetry::WAL_SEGMENT_MAX_BYTES,
            )?,
            wal_store_heartbeat_interval: Duration::from_secs(heartbeat_secs),
            // 5 minutes. Telemetry that has waited this long has already missed
            // the dashboards and alerts it was collected for, and exporting it
            // competes with the fresh rows trying to catch up. 0 disables the
            // bound, restoring the previous behaviour of queueing until the byte
            // caps or the channel slots run out.
            queue_max_age: Duration::from_secs(parse_u64(
                "INGEST_QUEUE_MAX_AGE_SECS",
                std::env::var("INGEST_QUEUE_MAX_AGE_SECS").ok(),
                300,
            )?),
            batch_max_rows: parse_usize(
                "INGEST_BATCH_MAX_ROWS",
                std::env::var("INGEST_BATCH_MAX_ROWS").ok(),
                5_000,
            )?,
            batch_max_bytes: parse_usize(
                "INGEST_BATCH_MAX_BYTES",
                std::env::var("INGEST_BATCH_MAX_BYTES").ok(),
                4 * 1024 * 1024,
            )?,
            batch_max_wait: Duration::from_millis(parse_u64(
                "INGEST_BATCH_MAX_WAIT_MS",
                std::env::var("INGEST_BATCH_MAX_WAIT_MS").ok(),
                100,
            )?),
            export_concurrency_per_shard: parse_usize(
                "INGEST_TINYBIRD_CONCURRENCY_PER_SHARD",
                std::env::var("INGEST_TINYBIRD_CONCURRENCY_PER_SHARD").ok(),
                1,
            )?,
            export_max_attempts: parse_u32(
                "INGEST_EXPORT_MAX_ATTEMPTS",
                std::env::var("INGEST_EXPORT_MAX_ATTEMPTS").ok(),
                20,
            )?,
            clickhouse_export_timeout: Duration::from_millis(parse_u64(
                "INGEST_CLICKHOUSE_EXPORT_TIMEOUT_MS",
                std::env::var("INGEST_CLICKHOUSE_EXPORT_TIMEOUT_MS").ok(),
                3_000,
            )?),
            clickhouse_breaker: ClickHouseBreakerConfig {
                // 0 disables the breaker (full retry budget on every batch).
                failure_threshold: parse_u32(
                    "INGEST_CLICKHOUSE_BREAKER_FAILURE_THRESHOLD",
                    std::env::var("INGEST_CLICKHOUSE_BREAKER_FAILURE_THRESHOLD").ok(),
                    ClickHouseBreakerConfig::default().failure_threshold,
                )?,
                cooldown: Duration::from_millis(parse_u64(
                    "INGEST_CLICKHOUSE_BREAKER_COOLDOWN_MS",
                    std::env::var("INGEST_CLICKHOUSE_BREAKER_COOLDOWN_MS").ok(),
                    duration_millis(ClickHouseBreakerConfig::default().cooldown),
                )?),
            },
            clickhouse_allow_private_endpoints: clickhouse_allow_private_endpoints(
                std::env::var("INGEST_CLICKHOUSE_ALLOW_PRIVATE_ENDPOINTS").ok(),
                std::env::var("MAPLE_SELF_HOSTED_MODE").ok(),
            )?,
            datasources: DatasourceNames::from_env(),
            datasource_session_replays: std::env::var("INGEST_TINYBIRD_DATASOURCE_SESSION_REPLAYS")
                .unwrap_or_else(|_| "session_replays".to_owned()),
            datasource_session_replay_events: std::env::var(
                "INGEST_TINYBIRD_DATASOURCE_SESSION_REPLAY_EVENTS",
            )
            .unwrap_or_else(|_| "session_replay_events".to_owned()),
            datasource_session_events: std::env::var("INGEST_TINYBIRD_DATASOURCE_SESSION_EVENTS")
                .unwrap_or_else(|_| "session_events".to_owned()),
            datasource_product_events: std::env::var("INGEST_TINYBIRD_DATASOURCE_PRODUCT_EVENTS")
                .unwrap_or_else(|_| "product_events".to_owned()),
        };
        if write_mode.uses_tinybird() {
            tinybird.validate()?;
        } else {
            tinybird.validate_for_pipeline(false)?;
        }

        let max_request_body_bytes = parse_usize(
            "INGEST_MAX_REQUEST_BODY_BYTES",
            std::env::var("INGEST_MAX_REQUEST_BODY_BYTES").ok(),
            20 * 1024 * 1024,
        )?;
        let max_decoded_body_bytes = parse_usize(
            "INGEST_MAX_DECODED_BODY_BYTES",
            std::env::var("INGEST_MAX_DECODED_BODY_BYTES").ok(),
            max_request_body_bytes.saturating_mul(8),
        )?;
        if max_decoded_body_bytes < max_request_body_bytes {
            return Err(
                "INGEST_MAX_DECODED_BODY_BYTES must be at least INGEST_MAX_REQUEST_BODY_BYTES"
                    .to_owned(),
            );
        }
        let org_max_in_flight = parse_u64(
            "INGEST_ORG_MAX_IN_FLIGHT",
            std::env::var("INGEST_ORG_MAX_IN_FLIGHT").ok(),
            1_000,
        )?;
        if org_max_in_flight == 0 {
            return Err("INGEST_ORG_MAX_IN_FLIGHT must be greater than 0".to_owned());
        }
        let rate_limit_fleet_size =
            parse_fleet_size(std::env::var("INGEST_RATE_LIMIT_FLEET_SIZE").ok())?;
        // Pub/Sub pushes one log entry per request, and every request is its own
        // WAL fsync on the org's lane. This bounds how deep one org's pushes can
        // queue on that lane, ahead of every other request sharing it. Pub/Sub
        // slows down on the 429.
        let gcp_org_max_in_flight = parse_u64(
            "INGEST_GCP_ORG_MAX_IN_FLIGHT",
            std::env::var("INGEST_GCP_ORG_MAX_IN_FLIGHT").ok(),
            32,
        )?;
        if gcp_org_max_in_flight == 0 {
            return Err("INGEST_GCP_ORG_MAX_IN_FLIGHT must be greater than 0".to_owned());
        }

        // 30s. Comfortably above a healthy p99 (single-digit ms) and below the
        // load balancer idle timeout, so the gateway answers rather than having
        // the connection cut out from under it. 0 disables the deadline.
        let request_timeout = Duration::from_secs(parse_u64(
            "INGEST_REQUEST_TIMEOUT_SECS",
            std::env::var("INGEST_REQUEST_TIMEOUT_SECS").ok(),
            30,
        )?);

        let require_tls = parse_bool(
            "INGEST_REQUIRE_TLS",
            std::env::var("INGEST_REQUIRE_TLS").ok(),
            false,
        )?;

        if require_tls && !forward_endpoint.starts_with("https://") {
            return Err(
                "INGEST_REQUIRE_TLS=true requires an https INGEST_FORWARD_OTLP_ENDPOINT".to_owned(),
            );
        }

        let key_store_backend = resolve_key_store_backend()?;
        let clickhouse_encryption_key = match &key_store_backend {
            // The Postgres key store decrypts BYO-ClickHouse credentials from
            // org_clickhouse_settings, so it needs the encryption key.
            KeyStoreBackend::Postgres { .. } => {
                let raw = std::env::var("MAPLE_INGEST_KEY_ENCRYPTION_KEY")
                    .map_err(|_| "MAPLE_INGEST_KEY_ENCRYPTION_KEY is required".to_owned())?;
                Some(parse_base64_aes256_gcm_key(&raw)?)
            }
            KeyStoreBackend::Static { .. } => None,
        };

        let lookup_hmac_key = std::env::var("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY")
            .map_err(|_| "MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY is required".to_owned())?
            .trim()
            .to_owned();

        if lookup_hmac_key.is_empty() {
            return Err("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY is required".to_owned());
        }

        let autumn_secret_key = std::env::var("AUTUMN_SECRET_KEY")
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty());

        let autumn_api_url = std::env::var("AUTUMN_API_URL")
            .unwrap_or_else(|_| "https://api.useautumn.com".to_owned())
            .trim()
            .trim_end_matches('/')
            .to_owned();

        let autumn_flush_interval_secs = parse_u64(
            "AUTUMN_FLUSH_INTERVAL_SECS",
            std::env::var("AUTUMN_FLUSH_INTERVAL_SECS").ok(),
            1,
        )?;

        // How long an entitlement decision is reused. Allows are cached long
        // enough to take Autumn off the hot path; denials briefly, so an org
        // that has just paid is not held at 402 for a full allow window.
        let autumn_allow_ttl_secs = parse_u64(
            "AUTUMN_ENTITLEMENT_ALLOW_TTL_SECS",
            std::env::var("AUTUMN_ENTITLEMENT_ALLOW_TTL_SECS").ok(),
            60,
        )?;
        let autumn_deny_ttl_secs = parse_u64(
            "AUTUMN_ENTITLEMENT_DENY_TTL_SECS",
            std::env::var("AUTUMN_ENTITLEMENT_DENY_TTL_SECS").ok(),
            5,
        )?;

        let ingest_key_cache_ttl_secs = parse_u64(
            "INGEST_KEY_CACHE_TTL_SECS",
            std::env::var("INGEST_KEY_CACHE_TTL_SECS").ok(),
            60,
        )?;

        // Routing (self-managed + ClickHouse-readiness flags) is re-read per
        // ingest request on a cache miss. A 1s TTL made that ~11 QPS against
        // org_clickhouse_settings — 961k statements a day, a quarter of ALL
        // traffic on the application database — to observe a value that changes
        // when an operator finishes a schema apply. 30s matches the sampling and
        // attribute-mapping caches; the only cost is that an org flipping to
        // ClickHouse-ready keeps routing to Tinybird for up to another 30s.
        let org_routing_cache_ttl_secs = parse_u64(
            "INGEST_ORG_ROUTING_CACHE_TTL_SECS",
            std::env::var("INGEST_ORG_ROUTING_CACHE_TTL_SECS").ok(),
            30,
        )?;

        // On by default, so a self-hosted gateway applies the rules its dashboard lets admins save;
        // the managed deploy sets it explicitly per stage.
        let ingest_rules_enabled = parse_bool(
            "INGEST_RULES_ENABLED",
            std::env::var("INGEST_RULES_ENABLED").ok(),
            true,
        )?;
        let ingest_rules_cache_ttl_secs = parse_u64(
            "INGEST_RULES_CACHE_TTL_SECS",
            std::env::var("INGEST_RULES_CACHE_TTL_SECS").ok(),
            30,
        )?;

        // 1 GiB of decompressed rrweb per session. Sized as an absurdity guard,
        // not a product tier: the observed p99 session is ~594 MB, so this only
        // trips on runaway recordings (canvas capture, unmasked media, a page
        // that never stops mutating) while leaving genuinely heavy sessions
        // untouched.
        let replay_max_session_bytes = parse_u64(
            "INGEST_REPLAY_MAX_SESSION_BYTES",
            std::env::var("INGEST_REPLAY_MAX_SESSION_BYTES").ok(),
            1024 * 1024 * 1024,
        )?;

        // Replay payload storage. An unset endpoint is the signal for "keep the
        // rrweb JSON inline in ClickHouse" — that is what self-hosted and
        // BYO-ClickHouse deployments run, and it is also how this ships dark on
        // the managed path until the credentials are set. Anything half-set is a
        // misconfiguration we refuse to boot on rather than silently falling
        // back to inline, which would look identical in metrics until someone
        // noticed the warehouse bill hadn't moved.
        let replay_blob_store = {
            let endpoint = std::env::var("INGEST_REPLAY_R2_ENDPOINT")
                .ok()
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty());
            match endpoint {
                None => None,
                Some(endpoint) => {
                    let required = |name: &str| -> Result<String, String> {
                        std::env::var(name)
                            .ok()
                            .map(|v| v.trim().to_owned())
                            .filter(|v| !v.is_empty())
                            .ok_or_else(|| {
                                format!("{name} is required when INGEST_REPLAY_R2_ENDPOINT is set")
                            })
                    };
                    let timeout_ms = parse_u64(
                        "INGEST_REPLAY_R2_TIMEOUT_MS",
                        std::env::var("INGEST_REPLAY_R2_TIMEOUT_MS").ok(),
                        5_000,
                    )?;
                    Some(ReplayBlobStoreConfig {
                        endpoint,
                        bucket: required("INGEST_REPLAY_R2_BUCKET")?,
                        access_key_id: required("INGEST_REPLAY_R2_ACCESS_KEY_ID")?,
                        secret_access_key: required("INGEST_REPLAY_R2_SECRET_ACCESS_KEY")?,
                        region: std::env::var("INGEST_REPLAY_R2_REGION")
                            .ok()
                            .map(|v| v.trim().to_owned())
                            .filter(|v| !v.is_empty())
                            .unwrap_or_else(|| "auto".to_owned()),
                        timeout: Duration::from_millis(timeout_ms),
                    })
                }
            }
        };

        // Default off — see the field doc. Set it on services that are only
        // reachable through Cloudflare.
        let trust_proxy_geo = parse_bool(
            "MAPLE_INGEST_TRUST_PROXY_GEO",
            std::env::var("MAPLE_INGEST_TRUST_PROXY_GEO").ok(),
            false,
        )?;

        // 90s fits inside the deployed 120s stopTimeout with margin for the
        // in-flight-request drain that runs before it.
        // WAL durability tier. An unset bucket keeps the WAL local-only, which
        // is the self-hosted and local-dev shape; on ECS the task role signs the
        // requests, so credentials are optional here.
        let wal_store = match std::env::var("INGEST_WAL_S3_BUCKET")
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
        {
            None => None,
            Some(bucket) => {
                let region = std::env::var("INGEST_WAL_S3_REGION")
                    .ok()
                    .map(|v| v.trim().to_owned())
                    .filter(|v| !v.is_empty())
                    .or_else(|| std::env::var("AWS_REGION").ok())
                    .ok_or_else(|| {
                        "INGEST_WAL_S3_REGION is required when INGEST_WAL_S3_BUCKET is set"
                            .to_owned()
                    })?;
                let endpoint = std::env::var("INGEST_WAL_S3_ENDPOINT")
                    .ok()
                    .map(|v| v.trim().to_owned())
                    .filter(|v| !v.is_empty())
                    .unwrap_or_else(|| format!("https://s3.{region}.amazonaws.com"));
                Some(WalStoreSettings {
                    store: maple_ingest::wal_store::WalStoreConfig {
                        endpoint,
                        bucket,
                        region,
                        prefix: std::env::var("INGEST_WAL_S3_PREFIX")
                            .ok()
                            .map(|v| v.trim().to_owned())
                            .filter(|v| !v.is_empty())
                            .unwrap_or_else(|| "wal".to_owned()),
                        timeout: Duration::from_millis(parse_u64(
                            "INGEST_WAL_S3_TIMEOUT_MS",
                            std::env::var("INGEST_WAL_S3_TIMEOUT_MS").ok(),
                            10_000,
                        )?),
                        orphan_after: Duration::from_secs(parse_u64(
                            "INGEST_WAL_S3_ORPHAN_AFTER_SECS",
                            std::env::var("INGEST_WAL_S3_ORPHAN_AFTER_SECS").ok(),
                            maple_ingest::wal_store::DEFAULT_ORPHAN_AFTER.as_secs(),
                        )?),
                        heartbeat_interval: Duration::from_secs(heartbeat_secs),
                    },
                    access_key_id: std::env::var("INGEST_WAL_S3_ACCESS_KEY_ID").ok(),
                    secret_access_key: std::env::var("INGEST_WAL_S3_SECRET_ACCESS_KEY").ok(),
                })
            }
        };

        let invalid_key_message =
            invalid_ingest_key_message(std::env::var("MAPLE_REGION").ok().as_deref())?;

        let shutdown_drain_secs = parse_u64(
            "INGEST_SHUTDOWN_DRAIN_SECS",
            std::env::var("INGEST_SHUTDOWN_DRAIN_SECS").ok(),
            90,
        )?;

        Ok(Self {
            port,
            otlp_grpc_port,
            forward_endpoint,
            forward_timeout: Duration::from_millis(forward_timeout_ms),
            self_trace_sample_ratio,
            write_mode,
            tinybird,
            max_request_body_bytes,
            max_decoded_body_bytes,
            org_max_in_flight,
            rate_limit_fleet_size,
            gcp_org_max_in_flight,
            request_timeout,
            require_tls,
            key_store_backend,
            clickhouse_encryption_key,
            lookup_hmac_key,
            autumn_secret_key,
            autumn_api_url,
            autumn_flush_interval_secs,
            autumn_allow_ttl_secs,
            autumn_deny_ttl_secs,
            ingest_key_cache_ttl_secs,
            org_routing_cache_ttl_secs,
            ingest_rules_enabled,
            ingest_rules_cache_ttl_secs,
            replay_max_session_bytes,
            replay_blob_store,
            internal_org_id,
            trust_proxy_geo,
            shutdown_drain_secs,
            wal_store,
            invalid_key_message,
            blocked_ingest_keys: Arc::new(parse_blocked_ingest_keys(
                std::env::var("INGEST_BLOCKED_KEYS").ok().as_deref(),
            )),
        })
    }
}

// Pick a KeyStore backend from env. `INGEST_KEY_STORE_BACKEND`
// (static|postgres) wins when set; otherwise `MAPLE_SELF_HOSTED_MODE=
// single_tenant` implies static; in all other cases we use Postgres (the
// production backend).
fn resolve_key_store_backend() -> Result<KeyStoreBackend, String> {
    let backend_override = std::env::var("INGEST_KEY_STORE_BACKEND")
        .ok()
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty());

    let self_hosted_mode = std::env::var("MAPLE_SELF_HOSTED_MODE")
        .ok()
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty());

    #[derive(PartialEq)]
    enum Want {
        Static,
        Postgres,
    }

    let want = match backend_override.as_deref() {
        Some("static") => Want::Static,
        Some("postgres" | "pg") => Want::Postgres,
        Some(other) => {
            return Err(format!(
                "INGEST_KEY_STORE_BACKEND must be `static` or `postgres`, got `{other}`"
            ));
        }
        None => {
            if self_hosted_mode.as_deref() == Some("single_tenant") {
                Want::Static
            } else {
                Want::Postgres
            }
        }
    };

    if want == Want::Static {
        let org_id = std::env::var("MAPLE_ORG_ID_OVERRIDE")
            .map_err(|_| {
                "MAPLE_ORG_ID_OVERRIDE is required for the static key store backend".to_owned()
            })?
            .trim()
            .to_owned();
        if org_id.is_empty() {
            return Err(
                "MAPLE_ORG_ID_OVERRIDE is required for the static key store backend".to_owned(),
            );
        }
        return Ok(KeyStoreBackend::Static { org_id });
    }

    let url = std::env::var("MAPLE_PG_URL")
        .map_err(|_| "MAPLE_PG_URL is required for the postgres key store backend".to_owned())?
        .trim()
        .to_owned();
    if url.is_empty() {
        return Err("MAPLE_PG_URL is required for the postgres key store backend".to_owned());
    }

    Ok(KeyStoreBackend::Postgres { url })
}

struct IngestKeyResolver {
    store: Arc<dyn KeyStore>,
    lookup_hmac_key: String,
    cache: Cache<String, IngestKeyIdentity>,
    // Authoritative "no such key" results, so an unknown-key flood is absorbed
    // here instead of amplifying into a Postgres lookup per request.
    negative_cache: Cache<String, ()>,
    routing: Arc<OrgRoutingResolver>,
    /// Source ids whose `last_used_at` was written recently, each held for its write interval.
    recent_key_uses: Cache<String, Duration>,
    /// Token source ids whose `last_rejected_at` was written within the last minute.
    recent_key_rejections: Cache<String, ()>,
    /// (org id, claim as received) to whether it names one of the org's pull sources,
    /// for `maple_source_id` values sent with the default keys.
    source_claims: Cache<(String, String), SourceClaim>,
    /// Emergency block list, checked before any cache or store lookup.
    blocked_keys: Arc<HashSet<String>>,
}

/// How often one token source's `last_used_at` is rewritten per gateway instance.
const SOURCE_USE_WRITE_INTERVAL: Duration = Duration::from_mins(1);
/// The same for a default source, which every public/private key request touches.
const DEFAULT_SOURCE_USE_WRITE_INTERVAL: Duration = Duration::from_mins(5);
/// Distinct `maple_source_id` claims checked per request; the rest stay unverified.
const MAX_SOURCE_CLAIMS: usize = 8;

/// Expires each recent-use entry after the interval stored as its value.
struct SourceUseExpiry;

impl moka::Expiry<String, Duration> for SourceUseExpiry {
    fn expire_after_create(
        &self,
        _key: &String,
        interval: &Duration,
        _created_at: Instant,
    ) -> Option<Duration> {
        Some(*interval)
    }
}

/// A cached answer for one `maple_source_id` claim. The pause window is kept
/// rather than a verdict, so a timed pause ends at its deadline while cached.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SourceClaim {
    Unclaimable,
    Claimable(PauseWindow),
}

/// Verified claims split by whether their source is paused right now.
#[derive(Debug, Default, PartialEq, Eq)]
struct VerifiedClaims {
    active: Vec<String>,
    paused: Vec<String>,
}

fn source_claims_cache(ttl: Duration) -> Cache<(String, String), SourceClaim> {
    Cache::builder()
        .time_to_live(ttl)
        .max_capacity(50_000)
        .build()
}

fn recent_key_uses_cache() -> Cache<String, Duration> {
    Cache::builder()
        .expire_after(SourceUseExpiry)
        .max_capacity(50_000)
        .build()
}

fn recent_key_rejections_cache() -> Cache<String, ()> {
    Cache::builder()
        .time_to_live(SOURCE_USE_WRITE_INTERVAL)
        .max_capacity(50_000)
        .build()
}

struct CloudflareConnectorResolver {
    store: Arc<dyn KeyStore>,
    lookup_hmac_key: String,
    cache: Cache<String, CloudflareConnectorIdentity>,
    routing: Arc<OrgRoutingResolver>,
}

const CLOUDFLARE_CONNECTORS_TABLE: &str = "cloudflare_logpush_connectors";
const GCP_CONNECTORS_TABLE: &str = "gcp_connectors";

/// How often one connector's health columns are rewritten per outcome. Pub/Sub
/// pushes one log entry per request, so an unthrottled write is one UPDATE per
/// log line.
const GCP_CONNECTOR_HEALTH_WRITE_INTERVAL: Duration = Duration::from_mins(1);

/// Setup reports one connector may write per `GCP_SETUP_REPORT_WINDOW`. A run
/// sends at most two (logs, metrics); the rest is headroom for runs pasted
/// again and Pub/Sub redeliveries. Each report is a Postgres write on the pool
/// key resolution uses, so a connector that sends more is refused.
const GCP_SETUP_REPORTS_PER_WINDOW: u32 = 10;
const GCP_SETUP_REPORT_WINDOW: Duration = Duration::from_mins(1);

struct GcpConnectorResolver {
    store: Arc<dyn KeyStore>,
    lookup_hmac_key: String,
    /// Keyed on (connector id, secret hash).
    cache: Cache<(String, String), GcpConnectorIdentity>,
    // A deleted connector's subscription keeps pushing every log line, and
    // Pub/Sub redelivers each 401; this keeps that off Postgres.
    negative_cache: Cache<(String, String), ()>,
    routing: Arc<OrgRoutingResolver>,
    /// (connector id, succeeded) pairs already written within
    /// `GCP_CONNECTOR_HEALTH_WRITE_INTERVAL`.
    recent_health_writes: Cache<(String, bool), ()>,
    /// Setup reports per connector in the current `GCP_SETUP_REPORT_WINDOW`.
    recent_setup_reports: Cache<String, Arc<AtomicU32>>,
    /// Verifies the ID tokens Pub/Sub signs pushes with.
    push_auth: GooglePushAuth,
}

const AWS_CONNECTIONS_TABLE: &str = "aws_connections";

/// How often one AWS connection's stream health columns are rewritten per
/// outcome. A busy stream delivers every few seconds.
const AWS_STREAM_HEALTH_WRITE_INTERVAL: Duration = Duration::from_mins(1);

struct AwsConnectionResolver {
    store: Arc<dyn KeyStore>,
    lookup_hmac_key: String,
    /// Keyed on (connection id, stream secret hash).
    cache: Cache<(String, String), AwsConnectionIdentity>,
    // A deleted connection's Firehose keeps delivering and retrying each 401;
    // this keeps that off Postgres.
    negative_cache: Cache<(String, String), ()>,
    routing: Arc<OrgRoutingResolver>,
    /// (connection id, succeeded) pairs already written within
    /// `AWS_STREAM_HEALTH_WRITE_INTERVAL`.
    recent_health_writes: Cache<(String, bool), ()>,
}

struct OrgRoutingResolver {
    store: Arc<dyn KeyStore>,
    cache: Cache<String, OrgRouting>,
    last_known: DashMap<String, OrgRouting>,
}

struct SamplingPolicyResolver {
    store: Arc<dyn KeyStore>,
    cache: Cache<String, SamplingPolicy>,
}

struct AttributeMappingResolver {
    store: Arc<dyn KeyStore>,
    cache: Cache<String, Arc<Vec<AttributeMappingRule>>>,
}

struct ClickHouseTargetResolver {
    store: Arc<dyn KeyStore>,
    encryption_key: Option<[u8; 32]>,
    cache: Cache<String, ClickHouseTarget>,
    /// Orgs that resolved to "no ready target" — no row, or a row stamped with a
    /// schema revision this binary predates.
    ///
    /// Without this, `None` was the one outcome nothing remembered, so the export
    /// retry loop re-queried Postgres on every one of its
    /// `INGEST_EXPORT_MAX_ATTEMPTS` attempts, for every batch, for as long as the
    /// org stayed unresolvable — against the same pool (`max_size(8)`, no checkout
    /// timeout) the accept path resolves ingest keys through. The TTL is short
    /// because the fix for an unresolvable org is a row change that should take
    /// effect without a deploy.
    negative_cache: Cache<String, ()>,
}

/// How often per-rule ingest stats are written to `org_ingest_rule_stats`.
const INGEST_RULE_STATS_FLUSH_INTERVAL: Duration = Duration::from_mins(1);

/// How long a resolved ClickHouse target is reused.
const CLICKHOUSE_TARGET_TTL: Duration = Duration::from_mins(1);
/// How long "no ready ClickHouse target" is remembered. Matches the ingest-key
/// negative cache: long enough to collapse a retry storm, short enough that
/// provisioning an org's target takes effect promptly.
const CLICKHOUSE_TARGET_NEGATIVE_TTL: Duration = Duration::from_secs(30);

impl ClickHouseTargetResolver {
    fn new(store: Arc<dyn KeyStore>, encryption_key: Option<[u8; 32]>, capacity: u64) -> Self {
        Self {
            store,
            encryption_key,
            cache: Cache::builder()
                .time_to_live(CLICKHOUSE_TARGET_TTL)
                .max_capacity(capacity)
                .build(),
            negative_cache: Cache::builder()
                .time_to_live(CLICKHOUSE_TARGET_NEGATIVE_TTL)
                .max_capacity(capacity)
                .build(),
        }
    }
}

/// Database-agnostic surface used by the resolvers. Implementations:
/// `StaticKeyStore` (local dev / single-tenant) and `PostgresKeyStore`
/// (PlanetScale Postgres in production, where the API service writes ingest-key
/// rows). Both back the same operations.
#[async_trait::async_trait]
trait KeyStore: Send + Sync {
    /// A public/private key by hash, with its org's default source in the same row.
    async fn fetch_ingest_key(
        &self,
        key_hash: &str,
        hash_column: &'static str,
    ) -> Result<Option<OrgKeyRow>, String>;

    /// A `maple_src_` key by hash, paused or not; unknown keys are `None`.
    async fn fetch_source_by_token_hash(&self, key_hash: &str)
        -> Result<Option<SourceRow>, String>;

    /// Stamps `last_used_at` on a source whose data the gateway just accepted.
    async fn record_source_used(&self, key_id: &str, now_ms: i64) -> Result<(), String>;

    /// Stamps `last_rejected_at` and the reason on a token source whose request was refused.
    async fn record_source_rejected(
        &self,
        key_id: &str,
        now_ms: i64,
        reason: &str,
    ) -> Result<(), String>;

    /// The subset of `source_ids` (uuids) that are the org's `kind = 'integration'`
    /// sources, the only ones a default-key sender may claim. One round trip.
    async fn claimable_source_ids(
        &self,
        org_id: &str,
        source_ids: &[String],
    ) -> Result<Vec<PullSourceRow>, String>;

    async fn fetch_connector(
        &self,
        connector_id: &str,
        secret_hash: &str,
    ) -> Result<Option<ConnectorRow>, String>;

    async fn fetch_gcp_connector(
        &self,
        connector_id: &str,
        secret_hash: &str,
    ) -> Result<Option<GcpConnectorRow>, String>;

    /// For a push signed by Google: the caller checks the signing account.
    async fn fetch_gcp_connector_by_id(
        &self,
        connector_id: &str,
    ) -> Result<Option<GcpConnectorRow>, String>;

    async fn fetch_sampling_policy(
        &self,
        org_id: &str,
    ) -> Result<Option<SamplingPolicyRow>, String>;

    async fn fetch_attribute_mappings(
        &self,
        org_id: &str,
    ) -> Result<Vec<AttributeMappingRow>, String>;

    /// The org's enabled ingest rules in `position` order, and its hash salt.
    async fn fetch_ingest_rules(&self, org_id: &str) -> Result<IngestRuleRows, String>;

    /// Adds per-rule counts into `org_ingest_rule_stats`, one statement for all `rows`.
    async fn record_ingest_rule_stats(&self, rows: &[IngestRuleStatRow]) -> Result<(), String>;

    async fn fetch_clickhouse_target(
        &self,
        org_id: &str,
    ) -> Result<Option<ClickHouseTargetRow>, String>;

    async fn fetch_org_routing(&self, org_id: &str) -> Result<Option<OrgRouting>, String>;

    /// `table` is one of the `*_CONNECTORS_TABLE` constants, never user input.
    async fn record_connector_success(
        &self,
        table: &'static str,
        connector_id: &str,
        now_ms: i64,
    ) -> Result<(), String>;

    async fn record_connector_failure(
        &self,
        table: &'static str,
        connector_id: &str,
        error: &str,
        now_ms: i64,
    ) -> Result<(), String>;

    /// What a Google Cloud setup script run reported it applied.
    async fn record_gcp_setup_report(
        &self,
        connector_id: &str,
        report: gcp_logging::SetupReport,
        now_ms: i64,
    ) -> Result<(), String>;

    /// An AWS connection by id and metric stream secret hash.
    async fn fetch_aws_connection(
        &self,
        connection_id: &str,
        secret_hash: &str,
    ) -> Result<Option<AwsConnectionRow>, String>;

    /// Stamps `stream_last_received_at` and clears `stream_last_error`
    /// (`error == None`), or writes `stream_last_error`.
    async fn record_aws_stream_health(
        &self,
        connection_id: &str,
        error: Option<&str>,
        now_ms: i64,
    ) -> Result<(), String>;
}

#[derive(Clone, Debug)]
struct KeyRow {
    org_id: String,
    self_managed: bool,
    clickhouse_ready: bool,
}

#[derive(Clone, Debug)]
struct OrgKeyRow {
    key: KeyRow,
    /// `sources.id` of the org's default source; `None` if it has none.
    default_source_id: Option<String>,
}

/// An integration ("pull") source and its pause window.
#[derive(Clone, Debug, PartialEq, Eq)]
struct PullSourceRow {
    /// The `sources.id` uuid.
    id: String,
    pause: PauseWindow,
}

impl PullSourceRow {
    /// A connector's source to stamp and its pause window; none is never paused.
    fn stamped(row: Option<Self>) -> (Option<SourceRef>, PauseWindow) {
        row.and_then(|row| Some((SourceRef::from_id(row.id)?, row.pause)))
            .map_or((None, PauseWindow::default()), |(source, pause)| {
                (Some(source), pause)
            })
    }
}

#[derive(Clone, Debug)]
struct SourceRow {
    key: KeyRow,
    /// `None` when the store has no sources table (static backend).
    config: Option<SourceConfigRow>,
}

#[derive(Clone, Debug)]
struct ConnectorRow {
    org_id: String,
    service_name: String,
    zone_name: String,
    dataset: String,
    self_managed: bool,
    clickhouse_ready: bool,
    /// The connector's `sources` row, joined through `source_id`.
    source: Option<PullSourceRow>,
}

#[derive(Clone, Debug)]
struct GcpConnectorRow {
    org_id: String,
    /// The host project: its push service account signs the connector's pushes.
    project_id: String,
    logs_enabled: bool,
    /// What a setup run last reported; `None` before any report.
    applied_logs_enabled: Option<bool>,
    self_managed: bool,
    clickhouse_ready: bool,
    /// The connector's `sources` row, joined through `source_id`.
    source: Option<PullSourceRow>,
}

#[derive(Clone, Debug)]
struct AwsConnectionRow {
    org_id: String,
    self_managed: bool,
    clickhouse_ready: bool,
    /// The connection's `sources` row, joined through `source_id`.
    source: Option<PullSourceRow>,
}

#[derive(Clone, Debug)]
struct SamplingPolicyRow {
    trace_sample_ratio: f64,
    always_keep_error_spans: bool,
    always_keep_slow_spans_ms: Option<u64>,
}

#[derive(Clone, Debug)]
struct AttributeMappingRow {
    source_context: String,
    source_key: String,
    target_key: String,
    operation: String,
}

#[derive(Clone)]
struct IngestKeyIdentity {
    org_id: String,
    key_type: IngestKeyType,
    key_id: String,
    source: Option<Arc<SourcePolicy>>,
    default_source: Option<SourceRef>,
}

impl IngestKeyIdentity {
    fn into_resolved(self, routing: &OrgRouting) -> ResolvedIngestKey {
        ResolvedIngestKey {
            org_id: self.org_id,
            key_type: self.key_type,
            key_id: self.key_id,
            self_managed: routing.self_managed,
            clickhouse_ready: routing.clickhouse_ready,
            source: self.source,
            default_source: self.default_source,
        }
    }
}

#[derive(Clone)]
struct CloudflareConnectorIdentity {
    connector_id: String,
    org_id: String,
    service_name: String,
    zone_name: String,
    dataset: String,
    secret_key_id: String,
    /// The connector's source, stamped on its logs.
    source: Option<SourceRef>,
    /// That source's pause window, judged per push so a timed pause ends on time.
    source_pause: PauseWindow,
}

impl CloudflareConnectorIdentity {
    fn into_resolved(self, routing: &OrgRouting) -> ResolvedCloudflareConnector {
        ResolvedCloudflareConnector {
            connector_id: self.connector_id,
            org_id: self.org_id,
            service_name: self.service_name,
            zone_name: self.zone_name,
            dataset: self.dataset,
            secret_key_id: self.secret_key_id,
            self_managed: routing.self_managed,
            clickhouse_ready: routing.clickhouse_ready,
            source: self.source,
            source_pause: self.source_pause,
        }
    }
}

#[derive(Clone)]
struct GcpConnectorIdentity {
    org_id: String,
    secret_key_id: String,
    logs_enabled: bool,
    confirms_log_forwarding: bool,
    /// The connector's integration source, stamped on its logs.
    source: Option<SourceRef>,
    /// That source's pause window, judged per push so a timed pause ends on time.
    source_pause: PauseWindow,
}

impl GcpConnectorIdentity {
    fn into_resolved(self, routing: &OrgRouting) -> ResolvedGcpConnector {
        ResolvedGcpConnector {
            logs_enabled: self.logs_enabled,
            confirms_log_forwarding: self.confirms_log_forwarding,
            source_pause: self.source_pause,
            key: ResolvedIngestKey {
                org_id: self.org_id,
                key_type: IngestKeyType::Connector,
                key_id: self.secret_key_id,
                self_managed: routing.self_managed,
                clickhouse_ready: routing.clickhouse_ready,
                source: None,
                default_source: self.source,
            },
        }
    }
}

#[derive(Clone)]
struct AwsConnectionIdentity {
    org_id: String,
    secret_key_id: String,
    /// The connection's integration source, stamped on its metrics.
    source: Option<SourceRef>,
    /// That source's pause window, judged per delivery so a timed pause ends on time.
    source_pause: PauseWindow,
}

impl AwsConnectionIdentity {
    fn into_resolved(self, routing: &OrgRouting) -> ResolvedAwsConnection {
        ResolvedAwsConnection {
            source_pause: self.source_pause,
            key: ResolvedIngestKey {
                org_id: self.org_id,
                key_type: IngestKeyType::Connector,
                key_id: self.secret_key_id,
                self_managed: routing.self_managed,
                clickhouse_ready: routing.clickhouse_ready,
                source: None,
                default_source: self.source,
            },
        }
    }
}

#[derive(Clone, Debug, Default)]
struct OrgRouting {
    self_managed: bool,
    clickhouse_ready: bool,
}

impl OrgRouting {
    fn from_key_row(row: &KeyRow) -> Self {
        Self {
            self_managed: row.self_managed,
            clickhouse_ready: row.clickhouse_ready,
        }
    }

    fn from_connector_row(row: &ConnectorRow) -> Self {
        Self {
            self_managed: row.self_managed,
            clickhouse_ready: row.clickhouse_ready,
        }
    }
}

/// The Autumn feature ID that session replay meters as. A `&'static str` for the same
/// reason `Signal::path()` is: it is simultaneously the billing feature, the
/// spend-cap key, and the usage metric's `signal` dimension, and those three must
/// never drift apart.
const BROWSER_SESSIONS_FEATURE_ID: &str = "browser_sessions";

/// The Autumn feature ID product events meter as — one unit per event, whether
/// it arrived on `/v1/events` or as a `type == "custom"` row on
/// `/v1/sessionEvents` (a browser `track()` call is the same product event as a
/// server-side one; only the transport differs).
const PRODUCT_EVENTS_FEATURE_ID: &str = "product_events";

/// What a DENIED Autumn entitlement means for the batch in flight.
#[derive(Clone, Copy, PartialEq, Eq)]
enum OnDenied {
    /// 402 the request: the metered feature IS the payload, so an exhausted
    /// allowance is a reason not to accept it (session starts, `/v1/events`).
    Reject,
    /// Keep the batch and record the usage fail-open. For a feature that is only
    /// PART of the payload — the `type == "custom"` rows of a session-events
    /// batch — a rejection would also drop the clicks, navigations and errors
    /// beside them, which is the incoherent outcome the `browser_sessions` gate
    /// exists to avoid. Autumn also answers `allowed: false` for a customer that
    /// simply has no balance for the feature yet (a plan item not pushed, or not
    /// granted to a live subscription), so denial here must never break ingest.
    MeterAnyway,
}

/// Meter `value` units of `feature_id` around a WAL enqueue: gate on the cached
/// entitlement decision, run `enqueue`, then record the quantity through the
/// retrying tracker. Usage is only ever recorded after the enqueue succeeds, so
/// a rejected payload is never billed and a provider outage never drops usage.
/// `value <= 0` gates and meters nothing.
///
/// This is the one shape every count-metered handler uses (session starts on
/// the metadata endpoint, product events on both event endpoints); keeping it in
/// one place is what stops the gate → enqueue → track ordering drifting between
/// them.
async fn metered_enqueue<T, F, Fut>(
    state: &AppState,
    org_id: &str,
    feature_id: &'static str,
    value: f64,
    on_denied: OnDenied,
    enqueue: F,
) -> Result<T, ApiError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<T, ApiError>>,
{
    // A request that bills nothing is not gated: a session-event batch carrying
    // no new session starts rides on the gate its metadata request already
    // passed. Callers that must gate regardless check `entitlement_rejection`
    // themselves.
    if value > 0.0 && org_id != SENTINEL_ORG_ID {
        if let Some(error) = entitlement_rejection(state, org_id, feature_id).await {
            if on_denied == OnDenied::Reject {
                return Err(error);
            }
            warn!(
                org_id,
                feature_id, value, "Autumn denied the feature; metering fail-open"
            );
        }
    }

    let accepted = enqueue().await?;

    // Usage is recorded only after the WAL commit, through the retrying tracker
    // that batches it. Nothing bills from the request path.
    if org_id != SENTINEL_ORG_ID && value > 0.0 {
        if let Some(tracker) = &state.autumn_tracker {
            tracker.track(org_id, feature_id, value);
        }
    }
    Ok(accepted)
}

/// The 402 Autumn's entitlement check produces for `feature_id`, or `None` when
/// the org may ingest it.
///
/// Rejects when the org has no active subscription or has exhausted a hard-capped
/// allotment. Fails open on any Autumn error (see `AutumnEntitlements::is_allowed`).
/// Inert unless `AUTUMN_SECRET_KEY` is set.
async fn entitlement_rejection(
    state: &AppState,
    org_id: &str,
    // `&'static str` because `entitlement_internal_span` records it as a span
    // field; every caller already has one (`Signal::path()`, the feature consts).
    feature_id: &'static str,
) -> Option<ApiError> {
    let entitlements = state.autumn_entitlements.as_ref()?;
    // Parent for the existing `autumn.check` client span, so a cache miss that
    // blocks on Autumn is visible even when the HTTP call itself is fast.
    let entitlement_span = entitlement_internal_span(feature_id);
    let entitlement_span_handle = entitlement_span.clone();
    let allowed = entitlements
        .is_allowed(org_id, feature_id)
        .instrument(entitlement_span)
        .await;
    entitlement_span_handle.record("maple.billing.allowed", allowed);
    if allowed {
        return None;
    }
    // `debug!`, not `warn!`: this runs once per refused request. The denial is
    // already on the span, and `AutumnEntitlements::post_check` warns with
    // Autumn's answer each time the decision is fetched.
    debug!(
        org_id,
        feature_id, "Ingestion blocked: plan limit reached or no active subscription"
    );
    Some(ApiError::new(
        StatusCode::PAYMENT_REQUIRED,
        "Plan limit reached or no active subscription",
    ))
}

#[derive(Clone, Debug)]
struct ClickHouseTargetRow {
    ch_url: String,
    ch_user: String,
    ch_password_ciphertext: Option<String>,
    ch_password_iv: Option<String>,
    ch_password_tag: Option<String>,
    ch_database: String,
    schema_version: String,
}

struct AppState {
    config: AppConfig,
    /// The raw `reqwest::Client` in normal builds; the hotpath-instrumented
    /// wrapper (same request API) under `--features hotpath`.
    http_client: HttpClient,
    telemetry_pipeline: Option<TelemetryPipeline>,
    /// Set once the key store has answered a probe. Drives `/ready`; never
    /// `/health` — see the comment on `health()`.
    key_store_ready: Arc<AtomicBool>,
    resolver: IngestKeyResolver,
    org_inflight_limiter: OrgInFlightLimiter,
    key_rate_limiter: SourceRateLimiter,
    /// GCP pushes only, taken before `org_inflight_limiter`.
    gcp_inflight_limiter: OrgInFlightLimiter,
    sampling_resolver: SamplingPolicyResolver,
    attribute_mapping_resolver: AttributeMappingResolver,
    /// Each org's compiled ingest rules; inert unless `INGEST_RULES_ENABLED`.
    ingest_rule_resolver: IngestRuleResolver,
    /// Per-rule counts awaiting the next flush to `org_ingest_rule_stats`.
    ingest_rule_stats: Arc<IngestRuleStatsSink>,
    cloudflare_resolver: CloudflareConnectorResolver,
    gcp_resolver: GcpConnectorResolver,
    aws_resolver: AwsConnectionResolver,
    autumn_tracker: Option<AutumnTracker>,
    autumn_entitlements: Option<AutumnEntitlements>,
    /// Per-org ingest volume, on its own delta-temporality provider. Recorded
    /// from the same accepted quantity as the Autumn reservation/fallback so the
    /// warehouse is ground truth for what the gateway metered. `None` when metric
    /// export is skipped (local dev, or a loopback endpoint).
    usage_metrics: Option<Arc<UsageMetrics>>,
    replay_session_budget: ReplaySessionBudget,
    /// `Some` when replay payloads go to R2; `None` keeps them inline in the
    /// `session_replay_events` row. See `AppConfig::replay_blob_store`.
    replay_blob_store: Option<ReplayBlobStore>,
}

#[derive(Clone)]
struct ResolvedIngestKey {
    org_id: String,
    key_type: IngestKeyType,
    key_id: String,
    // When true, the org has an active BYO Tinybird configuration and its OTLP
    // payloads must be routed to the self-managed collector pool rather than the
    // shared pool. Computed from a LEFT JOIN with `org_clickhouse_settings` at
    // resolve time; cached alongside the rest of the key so the hot path stays
    // branch-free beyond a single boolean check.
    self_managed: bool,
    // Native direct ClickHouse ingest is stricter: the connection is healthy
    // and the applied schema version equals this binary's ClickHouse migration
    // version (SCHEMA_VERSION) — NOT the Tinybird-coupled PROJECT_REVISION, so a
    // Tinybird-only schema change can't silently un-ready a BYO-CH org.
    clickhouse_ready: bool,
    /// Policy of a `maple_src_` key; `None` for default keys and the static store.
    source: Option<Arc<SourcePolicy>>,
    /// Stamped when no token source applies: the org's default source for its
    /// public/private keys, or a connector's integration source.
    default_source: Option<SourceRef>,
}

impl ResolvedIngestKey {
    /// The `sources.id` this request counts against: its token source, else the default.
    fn source_row_id(&self) -> Option<&str> {
        self.source
            .as_ref()
            .map(|source| source.id.as_str())
            .or_else(|| {
                self.default_source
                    .as_ref()
                    .map(|source| source.id.as_str())
            })
    }

    /// The `src_` id stamped when the sender names no verified source of its own.
    fn source_public_id(&self) -> Option<&str> {
        self.source
            .as_ref()
            .map(|source| source.public_id.as_str())
            .or_else(|| {
                self.default_source
                    .as_ref()
                    .map(|source| source.public_id.as_str())
            })
    }

    /// Default public/private key traffic may name its own source; a token never can.
    fn accepts_source_claims(&self) -> bool {
        self.source.is_none()
            && matches!(
                self.key_type,
                IngestKeyType::Public | IngestKeyType::Private
            )
    }
}

#[derive(Clone)]
struct ResolvedCloudflareConnector {
    connector_id: String,
    org_id: String,
    service_name: String,
    zone_name: String,
    dataset: String,
    secret_key_id: String,
    // Mirrors ResolvedIngestKey.self_managed so Cloudflare Logpush payloads route
    // to the self-managed pool when the owning org has BYO Tinybird active.
    self_managed: bool,
    clickhouse_ready: bool,
    source: Option<SourceRef>,
    /// A paused source's batches are acked and dropped.
    source_pause: PauseWindow,
}

struct ResolvedGcpConnector {
    /// False once the org turns log forwarding off; the sink may still push.
    logs_enabled: bool,
    /// A signed push to a connector no setup run has reported on: one set up
    /// with Terraform, which sends no report. The push itself proves the sink,
    /// topic and subscription are in place.
    confirms_log_forwarding: bool,
    /// The integration source's pause window: a paused source's entries are acked and dropped.
    source_pause: PauseWindow,
    key: ResolvedIngestKey,
}

struct ResolvedAwsConnection {
    /// The integration source's pause window: a paused source's deliveries are acked and dropped.
    source_pause: PauseWindow,
    key: ResolvedIngestKey,
}

/// What an acked Firehose delivery did.
enum AwsStreamOutcome {
    Accepted {
        item_count: usize,
    },
    /// The body or a record can never decode, so a retry is pointless.
    Undecodable,
    /// The connection's integration source is paused.
    SourcePaused,
}

/// What an accepted Cloudflare Logpush request did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LogpushOutcome {
    Accepted,
    /// Cloudflare's destination-validation ping when the job is created.
    Validation,
    /// The connector's source is paused: acked, nothing stored or billed.
    SourcePaused,
}

/// What an acked GCP push did.
enum GcpPushOutcome {
    Accepted,
    /// The body can never parse, so redelivering it is pointless.
    NotALogEntry,
    /// The connector has log forwarding turned off.
    LogsDisabled,
    /// A setup script run saying what it applied: recorded on the connector,
    /// not a log.
    SetupReport,
    /// The connector's integration source is paused.
    SourcePaused,
}

#[derive(Clone, Copy)]
enum IngestKeyType {
    Public,
    Private,
    Connector,
    Source,
}

impl IngestKeyType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Private => "private",
            Self::Connector => "connector",
            Self::Source => "source",
        }
    }
}

#[derive(Clone, Copy)]
enum Signal {
    Traces,
    Logs,
    Metrics,
}

impl Signal {
    fn path(self) -> &'static str {
        match self {
            Self::Traces => "traces",
            Self::Logs => "logs",
            Self::Metrics => "metrics",
        }
    }

    fn source_signal(self) -> SourceSignal {
        match self {
            Self::Traces => SourceSignal::Traces,
            Self::Logs => SourceSignal::Logs,
            Self::Metrics => SourceSignal::Metrics,
        }
    }

    fn ingest_signal(self) -> IngestSignal {
        match self {
            Self::Traces => IngestSignal::Traces,
            Self::Logs => IngestSignal::Logs,
            Self::Metrics => IngestSignal::Metrics,
        }
    }
}

enum DecodedPayload {
    Traces(ExportTraceServiceRequest),
    Logs(ExportLogsServiceRequest),
    Metrics(ExportMetricsServiceRequest),
}

impl DecodedPayload {
    fn signal(&self) -> Signal {
        match self {
            Self::Traces(_) => Signal::Traces,
            Self::Logs(_) => Signal::Logs,
            Self::Metrics(_) => Signal::Metrics,
        }
    }

    fn encoded_len(&self) -> usize {
        match self {
            Self::Traces(request) => request.encoded_len(),
            Self::Logs(request) => request.encoded_len(),
            Self::Metrics(request) => request.encoded_len(),
        }
    }

    fn resource_count(&self) -> usize {
        match self {
            Self::Traces(request) => request.resource_spans.len(),
            Self::Logs(request) => request.resource_logs.len(),
            Self::Metrics(request) => request.resource_metrics.len(),
        }
    }

    fn item_count(&self) -> usize {
        match self {
            Self::Traces(request) => count_trace_items(request),
            Self::Logs(request) => count_log_items(request),
            Self::Metrics(request) => count_metric_items(request),
        }
    }

    fn encode(&self, payload_format: PayloadFormat) -> Result<Vec<u8>, ApiError> {
        match (self, payload_format) {
            (Self::Traces(request), PayloadFormat::Protobuf) => Ok(request.encode_to_vec()),
            (Self::Logs(request), PayloadFormat::Protobuf) => Ok(request.encode_to_vec()),
            (Self::Metrics(request), PayloadFormat::Protobuf) => Ok(request.encode_to_vec()),
            (Self::Traces(request), PayloadFormat::Json) => serde_json::to_vec(request)
                .map_err(|_| ApiError::service_unavailable("Failed to serialize traces payload")),
            (Self::Logs(request), PayloadFormat::Json) => serde_json::to_vec(request)
                .map_err(|_| ApiError::service_unavailable("Failed to serialize logs payload")),
            (Self::Metrics(request), PayloadFormat::Json) => serde_json::to_vec(request)
                .map_err(|_| ApiError::service_unavailable("Failed to serialize metrics payload")),
        }
    }
}

struct InFlightGuard;

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        metrics::request_finished();
    }
}

#[derive(Clone)]
struct OrgInFlightLimiter {
    max_per_org: u64,
    counts: Arc<DashMap<String, Arc<AtomicU64>>>,
    /// The `org_throttled` reason.
    throttle_reason: &'static str,
    /// Only the org-wide limiter owns the per-org in-flight gauge; a route's
    /// limiter writing the same series would overwrite it.
    records_gauge: bool,
}

struct OrgInFlightPermit {
    org_id: String,
    counter: Arc<AtomicU64>,
    records_gauge: bool,
}

impl OrgInFlightLimiter {
    fn new(max_per_org: u64) -> Self {
        Self {
            max_per_org,
            counts: Arc::new(DashMap::new()),
            throttle_reason: "in_flight",
            records_gauge: true,
        }
    }

    /// A tighter cap for one route, taken on top of the org-wide one.
    fn for_route(max_per_org: u64, throttle_reason: &'static str) -> Self {
        Self {
            throttle_reason,
            records_gauge: false,
            ..Self::new(max_per_org)
        }
    }

    fn try_acquire(&self, org_id: &str) -> Option<OrgInFlightPermit> {
        let counter = self
            .counts
            .entry(org_id.to_owned())
            .or_insert_with(|| Arc::new(AtomicU64::new(0)))
            .clone();

        loop {
            let current = counter.load(Ordering::Relaxed);
            if current >= self.max_per_org {
                metrics::org_throttled(org_id, self.throttle_reason);
                return None;
            }
            if counter
                .compare_exchange(current, current + 1, Ordering::AcqRel, Ordering::Relaxed)
                .is_ok()
            {
                if self.records_gauge {
                    metrics::org_requests_in_flight(org_id, current + 1);
                }
                return Some(OrgInFlightPermit {
                    org_id: org_id.to_owned(),
                    counter,
                    records_gauge: self.records_gauge,
                });
            }
        }
    }
}

impl Drop for OrgInFlightPermit {
    fn drop(&mut self) {
        let current = self.counter.fetch_sub(1, Ordering::AcqRel);
        if self.records_gauge {
            metrics::org_requests_in_flight(&self.org_id, current.saturating_sub(1));
        }
    }
}

/// Public error envelope, matching the shape every other Maple HTTP surface
/// emits (`docs/api-v2.md#errors`).
///
/// The gateway used to answer with a bare `{"error": "<sentence>"}`, so a client
/// had nothing to branch on and no way to tell a retryable queue stall from a
/// permanent server bug. `_tag` is the stable semantic identity (the wire
/// counterpart of an Effect `Schema.TaggedError` tag), `type`/`code` are
/// presentation categories, `title`/`message` are safe copy, and
/// `retryable`/`recovery`/`retry_after_seconds` say what to do next without
/// parsing prose.
#[derive(Serialize)]
struct ErrorBody {
    error: PublicError,
}

#[derive(Serialize)]
struct PublicError {
    #[serde(rename = "_tag")]
    tag: &'static str,
    r#type: &'static str,
    code: &'static str,
    title: &'static str,
    message: String,
    retryable: bool,
    recovery: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_seconds: Option<u64>,
}

/// The identity half of an `ApiError`: everything about a failure that is fixed
/// at compile time, so a tag can never drift from its code, copy, or retry
/// semantics. Internal cause strings (WAL paths, upstream bodies, driver
/// messages) are deliberately *not* here — they stay on the span and in the
/// handler's log line, per `docs/api-v2.md#errors`.
#[derive(Clone, Copy, Debug)]
struct FailureKind {
    tag: &'static str,
    code: &'static str,
    title: &'static str,
    recovery: &'static str,
    retryable: bool,
    /// Stable `error.type` span/metric label. The status-derived kinds keep the
    /// existing vocabulary; explicitly named failures narrow it.
    error_kind: &'static str,
    retry_after_seconds: Option<u64>,
}

impl FailureKind {
    /// Generic fallback for the many call sites that only have a status and a
    /// sentence. Named failures below are preferred for anything a client or a
    /// dashboard needs to tell apart.
    fn for_status(status: StatusCode) -> &'static Self {
        match status {
            StatusCode::UNAUTHORIZED => &INGEST_UNAUTHORIZED,
            StatusCode::BAD_REQUEST => &INGEST_BAD_REQUEST,
            StatusCode::PAYMENT_REQUIRED => &INGEST_PLAN_LIMIT_REACHED,
            StatusCode::UNSUPPORTED_MEDIA_TYPE => &INGEST_UNSUPPORTED_MEDIA_TYPE,
            StatusCode::PAYLOAD_TOO_LARGE => &INGEST_PAYLOAD_TOO_LARGE,
            StatusCode::TOO_MANY_REQUESTS => &INGEST_RATE_LIMITED,
            StatusCode::SERVICE_UNAVAILABLE => &INGEST_SERVICE_UNAVAILABLE,
            _ => &INGEST_INTERNAL_ERROR,
        }
    }
}

static INGEST_UNAUTHORIZED: FailureKind = FailureKind {
    tag: "@maple/ingest/Unauthorized",
    code: "ingest_unauthorized",
    title: "Ingest key rejected",
    recovery: "reauthenticate",
    retryable: false,
    error_kind: "auth",
    retry_after_seconds: None,
};

static INGEST_BAD_REQUEST: FailureKind = FailureKind {
    tag: "@maple/ingest/BadRequest",
    code: "ingest_bad_request",
    title: "Malformed ingest request",
    recovery: "fix_request",
    retryable: false,
    error_kind: "bad_request",
    retry_after_seconds: None,
};

/// A replay chunk whose body was never a gzip stream. The SDK validates the
/// gzip magic before it posts, so this only ever comes from something else
/// executing the beacon — crawlers rendering the page and tearing it down
/// mid-flush account for ~10k a day. Its own `error_kind` keeps it out of
/// `rejection_loses_data`: refusing it loses no telemetry, so the span stays
/// `Ok` like every other caller-side rejection.
static INGEST_REPLAY_BODY_NOT_GZIP: FailureKind = FailureKind {
    tag: "@maple/ingest/ReplayBodyNotGzip",
    code: "ingest_replay_body_not_gzip",
    title: "Replay chunk is not a gzip stream",
    recovery: "fix_request",
    retryable: false,
    error_kind: "malformed_body",
    retry_after_seconds: None,
};

static INGEST_PLAN_LIMIT_REACHED: FailureKind = FailureKind {
    tag: "@maple/ingest/PlanLimitReached",
    code: "ingest_plan_limit_reached",
    title: "Ingestion blocked by plan limits",
    recovery: "contact_support",
    retryable: false,
    error_kind: "billing",
    retry_after_seconds: None,
};

static INGEST_UNSUPPORTED_MEDIA_TYPE: FailureKind = FailureKind {
    tag: "@maple/ingest/UnsupportedMediaType",
    code: "ingest_unsupported_media_type",
    title: "Unsupported content type",
    recovery: "fix_request",
    retryable: false,
    error_kind: "unsupported_media",
    retry_after_seconds: None,
};

static INGEST_PAYLOAD_TOO_LARGE: FailureKind = FailureKind {
    tag: "@maple/ingest/PayloadTooLarge",
    code: "ingest_payload_too_large",
    title: "Payload too large",
    recovery: "fix_request",
    retryable: false,
    error_kind: "payload_too_large",
    retry_after_seconds: None,
};

static INGEST_RATE_LIMITED: FailureKind = FailureKind {
    tag: "@maple/ingest/RateLimited",
    code: "ingest_rate_limited",
    title: "Ingest rate limit reached",
    recovery: "retry",
    retryable: true,
    error_kind: "throttle",
    retry_after_seconds: Some(1),
};

/// A source past its `expires_at`. Checked per request because the
/// positive auth cache can outlive the deadline.
static INGEST_KEY_EXPIRED: FailureKind = FailureKind {
    tag: "@maple/ingest/IngestKeyExpired",
    code: "ingest_key_expired",
    title: "Ingest key expired",
    recovery: "reauthenticate",
    retryable: false,
    error_kind: "auth",
    retry_after_seconds: None,
};

/// A source whose allow-list does not include this signal.
static INGEST_SIGNAL_NOT_ALLOWED: FailureKind = FailureKind {
    tag: "@maple/ingest/SignalNotAllowed",
    code: "ingest_signal_not_allowed",
    title: "Signal not allowed for this ingest key",
    recovery: "fix_request",
    retryable: false,
    error_kind: "forbidden",
    retry_after_seconds: None,
};

/// A source over its requests/second limit. Buckets hold one second
/// of burst, so a token is always back within a second.
static INGEST_KEY_RATE_LIMITED: FailureKind = FailureKind {
    tag: "@maple/ingest/IngestKeyRateLimited",
    code: "ingest_key_rate_limited",
    title: "Ingest key rate limit reached",
    recovery: "retry",
    retryable: true,
    error_kind: "throttle",
    retry_after_seconds: Some(1),
};

static INGEST_SERVICE_UNAVAILABLE: FailureKind = FailureKind {
    tag: "@maple/ingest/ServiceUnavailable",
    code: "ingest_unavailable",
    title: "Ingest gateway unavailable",
    recovery: "retry",
    retryable: true,
    error_kind: "unavailable",
    retry_after_seconds: Some(5),
};

/// The org's ingest rules could not be loaded and none were before. Refused rather
/// than stored unredacted; safe to resend once the rule store answers.
static INGEST_RULES_UNAVAILABLE: FailureKind = FailureKind {
    tag: "@maple/ingest/IngestRulesUnavailable",
    code: "ingest_rules_unavailable",
    title: "Ingest rules unavailable",
    recovery: "retry",
    retryable: true,
    error_kind: "rules_unavailable",
    retry_after_seconds: Some(5),
};

static INGEST_INTERNAL_ERROR: FailureKind = FailureKind {
    tag: "@maple/ingest/InternalError",
    code: "ingest_internal_error",
    title: "Ingest gateway error",
    recovery: "contact_support",
    retryable: false,
    error_kind: "error",
    retry_after_seconds: None,
};

/// The request outran `INGEST_REQUEST_TIMEOUT_SECS` and was abandoned.
///
/// 503 rather than 504: nothing upstream timed out, this gateway gave up on its
/// own work. Retryable — the batch was not acknowledged, so resending it is the
/// correct response.
static INGEST_REQUEST_TIMEOUT: FailureKind = FailureKind {
    tag: "@maple/ingest/RequestTimeout",
    code: "ingest_request_timeout",
    title: "Ingest request timed out",
    recovery: "retry",
    retryable: true,
    error_kind: "timeout",
    retry_after_seconds: Some(5),
};

/// The per-org byte budget is full: the caller's batch was refused, nothing was
/// written, and the same batch will be accepted once the lane drains.
static INGEST_THROTTLED: FailureKind = FailureKind {
    tag: "@maple/ingest/OrgQueueThrottled",
    code: "ingest_queue_throttled",
    title: "Ingest queue full for this org",
    recovery: "retry",
    retryable: true,
    error_kind: "throttle",
    retry_after_seconds: Some(1),
};

/// An export lane's channel is full — usually a slow downstream target (a
/// customer's own ClickHouse) backing the lane up. Retryable, caller's data
/// untouched, and deliberately *not* an error span (`otel_status_for_rejection`).
static INGEST_BACKPRESSURE: FailureKind = FailureKind {
    tag: "@maple/ingest/ExportLaneBackpressure",
    code: "ingest_export_lane_full",
    title: "Ingest export lane saturated",
    recovery: "retry",
    retryable: true,
    error_kind: "backpressure",
    retry_after_seconds: Some(2),
};

/// The durable queue (WAL) could not take the batch — disk I/O, a full lane
/// file, or a closed writer. Server fault, but the batch is safe to resend.
static INGEST_QUEUE_UNAVAILABLE: FailureKind = FailureKind {
    tag: "@maple/ingest/QueueUnavailable",
    code: "ingest_queue_unavailable",
    title: "Ingest queue unavailable",
    recovery: "retry",
    retryable: true,
    error_kind: "queue_unavailable",
    retry_after_seconds: Some(5),
};

/// The decoded payload could not be encoded for the warehouse. This is a
/// gateway bug or an unrepresentable record, not a transient condition —
/// resending the identical batch fails the same way.
static INGEST_ENCODE_FAILED: FailureKind = FailureKind {
    tag: "@maple/ingest/PayloadEncodeFailed",
    code: "ingest_encode_failed",
    title: "Telemetry could not be encoded for storage",
    recovery: "contact_support",
    retryable: false,
    error_kind: "encode",
    retry_after_seconds: None,
};

/// The upstream collector answered with a 5xx, or its response could not be
/// read. Distinct from a queue failure: nothing about the caller's batch is
/// wrong and the forward is safe to repeat.
static INGEST_COLLECTOR_UNAVAILABLE: FailureKind = FailureKind {
    tag: "@maple/ingest/CollectorUnavailable",
    code: "ingest_collector_unavailable",
    title: "Upstream collector unavailable",
    recovery: "retry",
    retryable: true,
    error_kind: "collector_unavailable",
    retry_after_seconds: Some(5),
};

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    kind: &'static FailureKind,
    message: String,
    /// Internal cause, kept off the wire. Recorded as the span's reject reason
    /// so a 503 in the dashboard names the underlying I/O failure.
    detail: Option<String>,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            kind: FailureKind::for_status(status),
            message: message.into(),
            detail: None,
        }
    }

    /// Attach an explicit failure identity, replacing the status-derived one.
    fn tagged(status: StatusCode, kind: &'static FailureKind, message: impl Into<String>) -> Self {
        Self {
            status,
            kind,
            message: message.into(),
            detail: None,
        }
    }

    /// Internal cause for telemetry only — never serialized.
    fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, message)
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    fn unsupported_media_type(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, message)
    }

    fn payload_too_large(message: impl Into<String>) -> Self {
        Self::new(StatusCode::PAYLOAD_TOO_LARGE, message)
    }

    fn too_many_requests(message: impl Into<String>) -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, message)
    }

    fn service_unavailable(message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, message)
    }

    /// Stable `error.type` label for this error. Reuses the same vocabulary as
    /// `handle_signal_inner` so the native replay/session handlers produce
    /// categorizable spans instead of "Unknown Error".
    fn error_kind(&self) -> &'static str {
        self.kind.error_kind
    }

    /// What `maple.ingest.reject_reason` records: the safe message plus the
    /// internal cause when there is one.
    fn reason(&self) -> String {
        match &self.detail {
            Some(detail) => format!("{}: {detail}", self.message),
            None => self.message.clone(),
        }
    }

    /// v2 error `type`, the closed status-family vocabulary from
    /// `docs/api-v2.md#errors`.
    fn error_type(&self) -> &'static str {
        match self.status {
            StatusCode::UNAUTHORIZED => "authentication_error",
            StatusCode::PAYMENT_REQUIRED => "payment_error",
            StatusCode::FORBIDDEN => "permission_error",
            StatusCode::NOT_FOUND => "not_found_error",
            StatusCode::CONFLICT => "conflict_error",
            StatusCode::TOO_MANY_REQUESTS => "rate_limit_error",
            status if status.is_server_error() => "api_error",
            _ => "invalid_request_error",
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let retry_after = self.kind.retry_after_seconds;
        let body = ErrorBody {
            error: PublicError {
                tag: self.kind.tag,
                r#type: self.error_type(),
                code: self.kind.code,
                title: self.kind.title,
                message: self.message,
                retryable: self.kind.retryable,
                recovery: self.kind.recovery,
                retry_after_seconds: retry_after,
            },
        };
        let mut response = (self.status, axum::Json(body)).into_response();
        if let Some(seconds) = retry_after {
            if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
                response.headers_mut().insert(RETRY_AFTER, value);
            }
        }
        response
    }
}

/// Abandon a request that has outrun `timeout` and answer 503.
///
/// Without this the gateway had no deadline anywhere on the accept path, so
/// saturation did not surface as errors at all: requests queued on the WAL
/// append and sat there. p95 went to tens of seconds while every per-route error
/// rate stayed flat near zero, because a hung request is not a failed one. The
/// per-org in-flight cap, the only limiter that fires under this, is a
/// concurrency bound with no time bound, so its permits were held for the whole
/// stall rather than turning anything away.
///
/// Dropping the handler future is what makes this shed rather than merely
/// report: the WAL append it was waiting on is abandoned and
/// `OrgBytesReservation` returns the bytes it had reserved. The `spawn_blocking`
/// already in flight is not cancellable and still completes its write; that
/// frame is simply never sent to its lane, and the lane's cursor passes over it.
async fn request_timeout_middleware(
    State(timeout): State<Duration>,
    request: Request,
    next: Next,
) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    // The metric gets the matched route pattern, not the raw path: the logpush
    // routes carry a path parameter (`/v1/logpush/gcp/{connector_id}`), and
    // labelling by raw path would add a metric series per connector. This
    // layer sits on the `Router`, so routing has already run and the extension is
    // populated; "unknown" only appears if that ever stops being true.
    let matched_path = request
        .extensions()
        .get::<MatchedPath>()
        .map_or("unknown", MatchedPath::as_str)
        .to_owned();
    let Ok(response) = tokio::time::timeout(timeout, next.run(request)).await else {
        metrics::request_timed_out(&matched_path);
        warn!(
            %method,
            path,
            timeout_secs = timeout.as_secs(),
            "Abandoning ingest request that exceeded the gateway timeout"
        );
        return ApiError::tagged(
            StatusCode::SERVICE_UNAVAILABLE,
            &INGEST_REQUEST_TIMEOUT,
            "Ingest gateway timed out while accepting this request",
        )
        .into_response();
    };
    response
}

/// OTEL span status (`otel.status_code`) for a rejected request.
///
/// 5xx is always `Error` (server fault). Below that, see `rejection_loses_data`:
/// a rejection that drops the caller's telemetry is an `Error`, a rejection of
/// the caller itself is not.
fn otel_status_for_rejection(status: u16, error_kind: &str) -> &'static str {
    if status >= 500 || rejection_loses_data(error_kind) {
        "Error"
    } else {
        "Ok"
    }
}

/// Record why a request was rejected, on the server span.
///
/// `otel.status_description` cannot be the sole carrier: it resolves to
/// `Status::error(reason)`, and the SDK keeps only the winner of `Ok > Error >
/// Unset` — so on a rejection left deliberately `Ok`, the description is dropped
/// and the span records *that* a request was refused but never *why*. The reason
/// therefore always gets its own attribute, and the description is additionally
/// written where an `Error` status will keep it. Counterpart of
/// `record_stage_error` for the stage spans.
fn record_rejection_reason(span: &Span, status: u16, error_kind: &str, reason: &str) {
    span.record("maple.ingest.reject_reason", reason);
    if otel_status_for_rejection(status, error_kind) == "Error" {
        span.record("otel.status_description", reason);
    } else {
        span.record("otel.status_code", "Ok");
    }
}

/// gRPC counterpart of `otel_status_for_rejection`, applying the same rule: a
/// caller-caused rejection leaves the SERVER span `Ok`, only a server-side
/// failure is `Error`. `accept_grpc_decoded` maps the pipeline's 429 to
/// `ResourceExhausted` and everything else to `Unavailable`, so the split here
/// mirrors the 4xx/5xx split on the HTTP path. tonic's own refusals of an export
/// are classified here too: `Unimplemented` is a `grpc-encoding` these services
/// do not accept, this path's 415.
fn grpc_otel_status_for_rejection(code: tonic::Code) -> &'static str {
    match code {
        tonic::Code::Unauthenticated
        | tonic::Code::PermissionDenied
        | tonic::Code::ResourceExhausted
        | tonic::Code::Unimplemented
        | tonic::Code::InvalidArgument
        | tonic::Code::NotFound
        | tonic::Code::FailedPrecondition
        | tonic::Code::OutOfRange
        | tonic::Code::Cancelled => "Ok",
        _ => "Error",
    }
}

/// Fully-qualified `rpc.service` names, per the OTel semantic conventions.
const GRPC_TRACE_SERVICE: &str = "opentelemetry.proto.collector.trace.v1.TraceService";
const GRPC_LOGS_SERVICE: &str = "opentelemetry.proto.collector.logs.v1.LogsService";
const GRPC_METRICS_SERVICE: &str = "opentelemetry.proto.collector.metrics.v1.MetricsService";

/// Record the resolved caller on the current gRPC server span, mirroring what
/// `handle_signal_inner` records on the HTTP one.
fn record_grpc_identity(resolved: &ResolvedIngestKey) {
    let span = Span::current();
    span.record("maple.org_id", resolved.org_id.as_str());
    span.record("maple.ingest.key_type", resolved.key_type.as_str());
    if let Some(source_id) = resolved.source_public_id() {
        span.record("maple.source.id", source_id);
    }
}

/// Fill in the deferred outcome fields on a gRPC server span. tonic answers a
/// failed unary call trailers-only, with `grpc-status` in the response headers;
/// a response without one succeeded.
fn record_grpc_outcome(span: &Span, response: &Response) {
    let Some(status) = tonic::Status::from_header_map(response.headers()) else {
        span.record("rpc.grpc.status_code", tonic::Code::Ok as i32);
        span.record("otel.status_code", "Ok");
        return;
    };
    let code = status.code();
    span.record("rpc.grpc.status_code", code as i32);
    span.record("error.type", code.description());
    span.record("maple.ingest.reject_reason", status.message());
    if grpc_otel_status_for_rejection(code) == "Error" {
        // See `record_rejection_reason`: the description is only kept on a span
        // whose status stays `Error`.
        span.record("otel.status_description", status.message());
    } else {
        span.record("otel.status_code", "Ok");
    }
}

/// Map a telemetry pipeline rejection to the client-facing HTTP error.
///
/// Transient queue conditions (`Throttled` = per-org byte cap, `Backpressure` =
/// lane channel full) are retryable and surface as **429** — via
/// `otel_status_for_rejection` these become `Ok` spans, so a customer's slow
/// BYO-ClickHouse target (which backs the lane up) does not flood our error
/// dashboards as "Unknown Error" 503s. Genuine backend failures
/// (`QueueUnavailable` = WAL I/O, `Encode`) stay **503** and are labeled via
/// `otel.status_description` on the handler span.
///
/// Single source of truth for both the OTLP signal path and the session-replay
/// handlers, which previously diverged (the replay paths blanket-mapped every
/// variant to 503).
fn api_error_from_pipeline(error: &PipelineError) -> ApiError {
    match error {
        PipelineError::Throttled(detail) => ApiError::tagged(
            StatusCode::TOO_MANY_REQUESTS,
            &INGEST_THROTTLED,
            "This org's ingest queue is at capacity. No data was written; resend this batch after the suggested delay.",
        )
        .with_detail(*detail),
        PipelineError::Backpressure(detail) => ApiError::tagged(
            StatusCode::TOO_MANY_REQUESTS,
            &INGEST_BACKPRESSURE,
            "The export lane for this org is saturated. No data was written; resend this batch after the suggested delay.",
        )
        .with_detail(*detail),
        PipelineError::QueueUnavailable(detail) => ApiError::tagged(
            StatusCode::SERVICE_UNAVAILABLE,
            &INGEST_QUEUE_UNAVAILABLE,
            "Maple could not durably queue this batch. No data was written; resend it after the suggested delay.",
        )
        .with_detail(detail.clone()),
        PipelineError::Encode(detail) => ApiError::tagged(
            StatusCode::SERVICE_UNAVAILABLE,
            &INGEST_ENCODE_FAILED,
            "Maple could not encode this batch for storage. Resending the same payload will fail again — contact support with this request's trace id.",
        )
        .with_detail(detail.clone()),
    }
}

/// A forward to the upstream collector could not be completed. `message` is the
/// safe, caller-facing sentence; `detail` is the internal cause, which stays on
/// the span and out of the response body.
fn collector_unavailable(message: &'static str, detail: impl Into<String>) -> ApiError {
    ApiError::tagged(
        StatusCode::SERVICE_UNAVAILABLE,
        &INGEST_COLLECTOR_UNAVAILABLE,
        message,
    )
    .with_detail(detail)
}

/// Resolve the deployment environment in maple's canonical priority order.
/// MAPLE_ENVIRONMENT is what apps/api/alchemy.run.ts and friends set via
/// resolveDeploymentEnvironment(stage); RAILWAY_ENVIRONMENT_NAME is Railway's
/// free runtime label; DEPLOYMENT_ENV is a manual override of last resort.
fn resolve_deployment_env() -> String {
    std::env::var("MAPLE_ENVIRONMENT")
        .or_else(|_| std::env::var("RAILWAY_ENVIRONMENT_NAME"))
        .or_else(|_| std::env::var("DEPLOYMENT_ENV"))
        .unwrap_or_else(|_| "development".to_owned())
}

struct TelemetryProviders {
    tracer: SdkTracerProvider,
    logger: SdkLoggerProvider,
}

/// Registry-wide filter: what reaches the OTel span layer. Spans are always
/// `info`, so this must stay at `info` regardless of log verbosity.
const SPAN_FILTER_DIRECTIVES: &str = "maple_ingest=info,tower_http=info";
/// Default per-layer filter for the stdout and OTLP-log layers (`RUST_LOG`
/// overrides). Hot-path `info!` logs are dropped in production by default.
const LOG_FILTER_DIRECTIVES: &str = "maple_ingest=warn,tower_http=warn";

#[expect(
    clippy::too_many_lines,
    reason = "linear construction of one OTel pipeline; every step feeds the next"
)]
fn init_tracing(
    forward_endpoint: &str,
    bind_port: u16,
    service_instance_id: &str,
    internal_org_id: &str,
    trace_sample_ratio: f64,
) -> Option<TelemetryProviders> {
    // Two filters on purpose. The registry-wide filter is pinned at `info`
    // because every gateway span (`ingest`, `ingest.authenticate`, the Postgres
    // client spans, …) is an `info_span!`; a global `warn` filter discards them
    // before `tracing_opentelemetry` ever sees them and the gateway goes silent
    // in its own traces. Log verbosity is a per-layer filter on the stdout and
    // OTLP-log layers only: `RUST_LOG` still overrides it, default `warn`.
    let env_filter = tracing_subscriber::EnvFilter::new(SPAN_FILTER_DIRECTIVES);
    let log_filter = || {
        tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| LOG_FILTER_DIRECTIVES.into())
    };

    let fmt_layer = tracing_subscriber::fmt::layer()
        .with_target(false)
        .compact()
        .with_filter(log_filter());

    let deployment_env = resolve_deployment_env();
    let forward_explicit = std::env::var("INGEST_FORWARD_OTLP_ENDPOINT").is_ok();
    let skip_dev = deployment_env == "development" && !forward_explicit;
    let loopback = endpoint_loopback_to_self(forward_endpoint, bind_port);

    if skip_dev || loopback {
        if loopback {
            eprintln!(
                "INGEST_FORWARD_OTLP_ENDPOINT={forward_endpoint} resolves to this server's bind port {bind_port}; skipping OTel exporter to avoid recursion"
            );
        }
        tracing_subscriber::registry()
            .with(env_filter)
            .with(fmt_layer)
            .init();
        return None;
    }

    let resource = build_resource(ResourceConfig {
        service_name: "ingest",
        service_namespace: "core",
        service_version: env!("CARGO_PKG_VERSION"),
        service_instance_id: service_instance_id.to_owned(),
        deployment_env,
        internal_org_id: internal_org_id.to_owned(),
    });

    let exporter = match SpanExporter::builder()
        .with_http()
        .with_endpoint(format!("{forward_endpoint}/v1/traces"))
        .with_protocol(Protocol::HttpBinary)
        .with_compression(OtlpCompression::Gzip)
        .build()
    {
        Ok(exporter) => exporter,
        Err(error) => {
            eprintln!(
                "Failed to build OTLP span exporter: {error}; falling back to stdout-only tracing"
            );
            tracing_subscriber::registry()
                .with(env_filter)
                .with(fmt_layer)
                .init();
            return None;
        }
    };
    let log_exporter = match LogExporter::builder()
        .with_http()
        .with_endpoint(format!("{forward_endpoint}/v1/logs"))
        .with_protocol(Protocol::HttpBinary)
        .with_compression(OtlpCompression::Gzip)
        .build()
    {
        Ok(exporter) => exporter,
        Err(error) => {
            eprintln!(
                "Failed to build OTLP log exporter: {error}; falling back to stdout-only tracing"
            );
            tracing_subscriber::registry()
                .with(env_filter)
                .with(fmt_layer)
                .init();
            return None;
        }
    };

    // Sized for the per-request child spans (ingest.authenticate / .decode /
    // .parse / .accept / .encode_rows / .wal_commit): a sampled request emits ~7
    // spans, not 1. At 2048 the queue held only a few seconds of that volume, so
    // a brief export stall silently dropped spans, parents and children alike.
    // Head volume is INGEST_SELF_TRACE_SAMPLE_RATIO (see `SelfTraceSampler`);
    // the queue is sized for the unsampled default.
    let batch_config = BatchConfigBuilder::default()
        .with_max_queue_size(8192)
        .with_max_export_batch_size(1024)
        .with_scheduled_delay(Duration::from_secs(5))
        .build();

    let processor = BatchSpanProcessor::builder(exporter, OtelTokio)
        .with_batch_config(batch_config)
        .build();

    let provider = SdkTracerProvider::builder()
        .with_resource(resource.clone())
        .with_sampler(SelfTraceSampler::new(trace_sample_ratio))
        .with_span_processor(processor)
        .build();
    // The runtime argument is not optional here: the runtime-less
    // `logs::BatchLogProcessor` drives exports from its own OS thread
    // ("OpenTelemetry.Logs.BatchProcessor"), which has no Tokio reactor, and the
    // reqwest-backed OTLP exporter panics there with "there is no reactor
    // running". Spans and metrics already use their async-runtime variants.
    let log_processor = BatchLogProcessor::builder(log_exporter, OtelTokio)
        .with_batch_config(
            opentelemetry_sdk::logs::BatchConfigBuilder::default()
                .with_max_queue_size(2048)
                .with_max_export_batch_size(512)
                .with_scheduled_delay(Duration::from_secs(5))
                .build(),
        )
        .build();
    let logger_provider = SdkLoggerProvider::builder()
        .with_resource(resource)
        .with_log_processor(log_processor)
        .build();

    let tracer = provider.tracer("maple-ingest");
    let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);
    let log_layer = OpenTelemetryTracingBridge::new(&logger_provider).with_filter(log_filter());

    tracing_subscriber::registry()
        .with(env_filter)
        .with(fmt_layer)
        .with(log_layer)
        .with(otel_layer)
        .init();

    opentelemetry::global::set_tracer_provider(provider.clone());

    Some(TelemetryProviders {
        tracer: provider,
        logger: logger_provider,
    })
}

/// Head sampler for the gateway's own traces: whole traces by trace id, children
/// following their parent. Sampled spans carry `SampleRate` = 1/ratio, which
/// Maple's throughput math weights by, so request rates still read true.
#[derive(Clone, Debug)]
struct SelfTraceSampler {
    inner: Sampler,
    sample_rate: Option<opentelemetry::KeyValue>,
}

impl SelfTraceSampler {
    fn new(ratio: f64) -> Self {
        Self {
            inner: Sampler::ParentBased(Box::new(Sampler::TraceIdRatioBased(ratio))),
            sample_rate: (ratio < 1.0)
                .then(|| opentelemetry::KeyValue::new("SampleRate", 1.0 / ratio)),
        }
    }
}

impl ShouldSample for SelfTraceSampler {
    fn should_sample(
        &self,
        parent_context: Option<&opentelemetry::Context>,
        trace_id: opentelemetry::trace::TraceId,
        name: &str,
        span_kind: &opentelemetry::trace::SpanKind,
        attributes: &[opentelemetry::KeyValue],
        links: &[opentelemetry::trace::Link],
    ) -> SamplingResult {
        let mut result =
            self.inner
                .should_sample(parent_context, trace_id, name, span_kind, attributes, links);
        if let (SamplingDecision::RecordAndSample, Some(rate)) =
            (&result.decision, &self.sample_rate)
        {
            result.attributes.push(rate.clone());
        }
        result
    }
}

/// Wire up OTLP metric export, mirroring `init_tracing`. The gateway's own
/// operational metrics are pushed to `{forward_endpoint}/v1/metrics` on a
/// periodic interval — the same downstream collector → Tinybird pipeline that
/// carries its traces. Returns `None` (metrics become no-ops) when export is
/// skipped in local dev or would loop back onto this server.
fn init_metrics(
    forward_endpoint: &str,
    bind_port: u16,
    service_instance_id: &str,
    internal_org_id: &str,
) -> Option<SdkMeterProvider> {
    let deployment_env = resolve_deployment_env();
    let forward_explicit = std::env::var("INGEST_FORWARD_OTLP_ENDPOINT").is_ok();
    let skip_dev = deployment_env == "development" && !forward_explicit;
    if skip_dev || endpoint_loopback_to_self(forward_endpoint, bind_port) {
        return None;
    }

    let resource = build_resource(ResourceConfig {
        service_name: "ingest",
        service_namespace: "core",
        service_version: env!("CARGO_PKG_VERSION"),
        service_instance_id: service_instance_id.to_owned(),
        deployment_env,
        internal_org_id: internal_org_id.to_owned(),
    });

    let exporter = match MetricExporter::builder()
        .with_http()
        .with_endpoint(format!("{forward_endpoint}/v1/metrics"))
        .with_protocol(Protocol::HttpBinary)
        .with_compression(OtlpCompression::Gzip)
        .build()
    {
        Ok(exporter) => exporter,
        Err(error) => {
            eprintln!("Failed to build OTLP metric exporter: {error}; metrics disabled");
            return None;
        }
    };

    let reader = PeriodicReader::builder(exporter, OtelTokio)
        .with_interval(Duration::from_secs(30))
        .build();

    let provider = SdkMeterProvider::builder()
        .with_resource(resource)
        .with_reader(reader)
        .build();

    opentelemetry::global::set_meter_provider(provider.clone());

    Some(provider)
}

/// Wire up the per-org ingest volume pipeline. Deliberately a *second* meter
/// provider rather than more instruments on the global one, for three reasons:
///
/// - Temporality is an exporter setting in opentelemetry 0.31, and these metrics
///   need [`Temporality::Delta`] to be exact (see `usage_metrics` module docs).
///   Flipping the shared exporter would silently change every operational metric.
/// - It is never installed with `set_meter_provider`, so nothing can accidentally
///   bind a cumulative operational instrument to the delta exporter.
/// - A 60s interval halves the row count versus the operational provider's 30s,
///   which under delta costs nothing but chart granularity below a minute.
///
/// Shares `service_instance_id` with `init_metrics` so both providers describe
/// one process. Skipped under exactly the same conditions as `init_metrics`.
fn init_usage_metrics(
    forward_endpoint: &str,
    bind_port: u16,
    service_instance_id: &str,
    internal_org_id: &str,
) -> Option<UsageMetrics> {
    let deployment_env = resolve_deployment_env();
    let forward_explicit = std::env::var("INGEST_FORWARD_OTLP_ENDPOINT").is_ok();
    let skip_dev = deployment_env == "development" && !forward_explicit;
    if skip_dev || endpoint_loopback_to_self(forward_endpoint, bind_port) {
        return None;
    }

    let resource = build_resource(ResourceConfig {
        service_name: "ingest",
        service_namespace: "core",
        service_version: env!("CARGO_PKG_VERSION"),
        service_instance_id: service_instance_id.to_owned(),
        deployment_env,
        internal_org_id: internal_org_id.to_owned(),
    });

    let exporter = match MetricExporter::builder()
        .with_http()
        .with_endpoint(format!("{forward_endpoint}/v1/metrics"))
        .with_protocol(Protocol::HttpBinary)
        .with_compression(OtlpCompression::Gzip)
        .with_temporality(Temporality::Delta)
        .build()
    {
        Ok(exporter) => exporter,
        Err(error) => {
            eprintln!(
                "Failed to build OTLP usage metric exporter: {error}; usage metrics disabled"
            );
            return None;
        }
    };

    let reader = PeriodicReader::builder(exporter, OtelTokio)
        .with_interval(Duration::from_mins(1))
        .build();

    let provider = SdkMeterProvider::builder()
        .with_resource(resource)
        .with_reader(reader)
        .with_view(usage_cardinality_view)
        .build();

    Some(UsageMetrics::new(provider))
}

fn endpoint_loopback_to_self(forward_endpoint: &str, bind_port: u16) -> bool {
    let Ok(parsed) = url::Url::parse(forward_endpoint) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or("");
    let port = parsed.port_or_known_default().unwrap_or(0);
    let host_is_loopback = matches!(host, "127.0.0.1" | "localhost" | "::1" | "0.0.0.0");
    host_is_loopback && port == bind_port
}

#[tokio::main]
#[hotpath::main(allocator = tikv_jemallocator::Jemalloc)]
#[expect(
    clippy::too_many_lines,
    reason = "process wiring, in start-up order: config, telemetry, state, router, serve, shutdown"
)]
async fn main() {
    drop(dotenvy::dotenv());
    // No-op unless `--features hotpath`: exports tokio runtime metrics (workers,
    // park/unpark, queue depth) into the profiler report alongside function timings.
    hotpath::tokio_runtime!();

    let config = match AppConfig::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("Configuration error: {error}");
            std::process::exit(1);
        }
    };

    // One UUID per process, shared by the trace and metric resources so both
    // signals attribute to the same `service.instance.id`.
    let service_instance_id = uuid::Uuid::new_v4().to_string();
    let telemetry_providers = init_tracing(
        &config.forward_endpoint,
        config.port,
        &service_instance_id,
        &config.internal_org_id,
        config.self_trace_sample_ratio,
    );
    let meter_provider = init_metrics(
        &config.forward_endpoint,
        config.port,
        &service_instance_id,
        &config.internal_org_id,
    );
    let usage_metrics = init_usage_metrics(
        &config.forward_endpoint,
        config.port,
        &service_instance_id,
        &config.internal_org_id,
    )
    .map(Arc::new);

    let http_client = match Client::builder()
        .timeout(config.forward_timeout)
        .pool_max_idle_per_host(256)
        .pool_idle_timeout(Duration::from_secs(30))
        .http2_keep_alive_interval(Duration::from_secs(20))
        .http2_keep_alive_timeout(Duration::from_secs(5))
        .build()
    {
        // `http!` is identity unless `--features hotpath`, where it reports
        // per-endpoint request counts/latency/errors (Tinybird, ClickHouse,
        // the forward collector, Autumn, R2 — all outbound calls share this pool).
        Ok(client) => hotpath::http!(client, label = "outbound"),
        Err(error) => {
            eprintln!("HTTP client init error: {error}");
            std::process::exit(1);
        }
    };

    // The API service writes ingest-key rows to PlanetScale Postgres, so ingest
    // reads them from the same place. We probe at boot, but only config errors
    // (a malformed URL) are fatal — an unreachable database boots DEGRADED and
    // retries in the background. Deploy-time validation lives on `/ready`, not on
    // process exit, so a bad deploy never goes ready while a transient database
    // fault can no longer kill a healthy running fleet.
    let key_store_ready = Arc::new(AtomicBool::new(false));
    let store: Arc<dyn KeyStore> =
        match build_key_store(&config, Arc::clone(&key_store_ready)).await {
            Ok(store) => store,
            Err(error) => {
                eprintln!("Key store init error: {error}");
                std::process::exit(1);
            }
        };

    // The Postgres key store resolves BYO-ClickHouse export targets from
    // org_clickhouse_settings (the Static backend has no DB to resolve from).
    // This must stay in lockstep with routing: `fetch_org_routing` marks orgs
    // clickhouse_ready and sends frames down the ClickHouse path, so the export
    // worker needs a target provider for the same backend or it would drop every
    // batch with "no ready target resolved".
    let direct_clickhouse_possible =
        matches!(config.key_store_backend, KeyStoreBackend::Postgres { .. });
    let clickhouse_target_provider: Option<Arc<dyn ClickHouseTargetProvider>> =
        if direct_clickhouse_possible {
            Some(Arc::new(ClickHouseTargetResolver::new(
                Arc::clone(&store),
                config.clickhouse_encryption_key,
                10_000,
            )) as Arc<dyn ClickHouseTargetProvider>)
        } else {
            None
        };

    // Credentials come from the ECS task role unless the deployment supplies a
    // key pair — the same choice the replay bucket makes, except that on ECS the
    // role is the default rather than the exception.
    let wal_segment_store = config.wal_store.as_ref().and_then(|settings| {
        let credentials = match (&settings.access_key_id, &settings.secret_access_key) {
            (Some(key), Some(secret)) => Some(AwsCredentialsProvider::from_static(
                key.clone(),
                secret.clone(),
            )),
            _ => AwsCredentialsProvider::from_ecs_environment(http_client.clone()),
        };
        let Some(credentials) = credentials else {
            warn!(
                bucket = settings.store.bucket,
                "INGEST_WAL_S3_BUCKET is set but no credentials are available; the WAL stays local-only"
            );
            return None;
        };
        info!(
            bucket = settings.store.bucket,
            prefix = settings.store.prefix,
            "WAL segments will be shipped to the durability object store"
        );
        Some(Arc::new(WalSegmentStore::new(
            http_client.clone(),
            &settings.store,
            Arc::new(credentials),
        )))
    });

    let telemetry_pipeline = if config.write_mode.uses_tinybird() || direct_clickhouse_possible {
        match TelemetryPipeline::new_with_object_store(
            config.tinybird.clone(),
            http_client.clone(),
            clickhouse_target_provider,
            config.write_mode.uses_tinybird(),
            wal_segment_store,
        )
        .await
        {
            Ok(pipeline) => Some(pipeline),
            Err(error) => {
                eprintln!("Telemetry pipeline init error: {error}");
                std::process::exit(1);
            }
        }
    } else {
        None
    };

    // Handle kept out of AppState for the post-shutdown WAL drain, plus the
    // scale-in protection loop (a no-op off ECS — see `task_protection`).
    let drain_pipeline = telemetry_pipeline.clone();
    let drain_deadline = Duration::from_secs(config.shutdown_drain_secs);
    if let Some(pipeline) = telemetry_pipeline.clone() {
        task_protection::spawn(pipeline);
    }

    let autumn_tracker = config.autumn_secret_key.as_ref().map(|key| {
        AutumnTracker::spawn(
            key.clone(),
            &config.autumn_api_url,
            config.autumn_flush_interval_secs,
        )
    });

    // A configured Autumn account is the billing authority. Native balance
    // checks and customer controls must not be bypassable by a second flag.
    let autumn_entitlements = config.autumn_secret_key.as_ref().map(|key| {
        AutumnEntitlements::new(
            http_client.clone(),
            key.clone(),
            &config.autumn_api_url,
            config.autumn_allow_ttl_secs,
            config.autumn_deny_ttl_secs,
        )
    });

    let ingest_key_cache = Cache::builder()
        .time_to_live(Duration::from_secs(config.ingest_key_cache_ttl_secs))
        .max_capacity(1_000)
        .build();
    // Short TTL so a freshly created key starts working within seconds even
    // after the SDK raced ahead of provisioning.
    let ingest_key_negative_cache = Cache::builder()
        .time_to_live(Duration::from_secs(30))
        .max_capacity(10_000)
        .build();

    let cloudflare_connector_cache = Cache::builder()
        .time_to_live(Duration::from_secs(config.ingest_key_cache_ttl_secs))
        .max_capacity(1_000)
        .build();
    let org_routing_cache = Cache::builder()
        .time_to_live(Duration::from_secs(config.org_routing_cache_ttl_secs))
        .max_capacity(10_000)
        .build();
    let sampling_policy_cache = Cache::builder()
        .time_to_live(Duration::from_secs(30))
        .max_capacity(10_000)
        .build();
    let attribute_mapping_cache = Cache::builder()
        .time_to_live(Duration::from_secs(30))
        .max_capacity(10_000)
        .build();

    let org_routing_resolver = Arc::new(OrgRoutingResolver {
        store: Arc::clone(&store),
        cache: org_routing_cache,
        last_known: DashMap::new(),
    });

    // Rule stats go to Postgres every minute; the static store's write is a no-op.
    let ingest_rule_stats = Arc::new(IngestRuleStatsSink::default());
    let ingest_rules_enabled = config.ingest_rules_enabled;
    if ingest_rules_enabled {
        tokio::spawn(rules_gateway::run_stats_flusher(
            Arc::clone(&ingest_rule_stats),
            Arc::clone(&store),
            INGEST_RULE_STATS_FLUSH_INTERVAL,
        ));
    }
    let stats_store = Arc::clone(&store);

    // Same pooled client as every other outbound call; `http_client` itself is
    // moved into the state below.
    let http_client_for_blobs = http_client.clone();

    let state = Arc::new(AppState {
        key_store_ready: Arc::clone(&key_store_ready),
        resolver: IngestKeyResolver {
            store: Arc::clone(&store),
            lookup_hmac_key: config.lookup_hmac_key.clone(),
            cache: ingest_key_cache,
            negative_cache: ingest_key_negative_cache,
            routing: Arc::clone(&org_routing_resolver),
            recent_key_uses: recent_key_uses_cache(),
            recent_key_rejections: recent_key_rejections_cache(),
            source_claims: source_claims_cache(Duration::from_secs(
                config.ingest_key_cache_ttl_secs,
            )),
            blocked_keys: Arc::clone(&config.blocked_ingest_keys),
        },
        org_inflight_limiter: OrgInFlightLimiter::new(config.org_max_in_flight),
        key_rate_limiter: SourceRateLimiter::new(config.rate_limit_fleet_size),
        gcp_inflight_limiter: OrgInFlightLimiter::for_route(
            config.gcp_org_max_in_flight,
            "gcp_in_flight",
        ),
        sampling_resolver: SamplingPolicyResolver {
            store: Arc::clone(&store),
            cache: sampling_policy_cache,
        },
        attribute_mapping_resolver: AttributeMappingResolver {
            store: Arc::clone(&store),
            cache: attribute_mapping_cache,
        },
        ingest_rule_resolver: IngestRuleResolver::new(
            Arc::clone(&store),
            config.ingest_rules_enabled,
            Duration::from_secs(config.ingest_rules_cache_ttl_secs),
            10_000,
        ),
        ingest_rule_stats: Arc::clone(&ingest_rule_stats),
        cloudflare_resolver: CloudflareConnectorResolver {
            store: Arc::clone(&store),
            lookup_hmac_key: config.lookup_hmac_key.clone(),
            cache: cloudflare_connector_cache,
            routing: Arc::clone(&org_routing_resolver),
        },
        gcp_resolver: GcpConnectorResolver::new(
            Arc::clone(&store),
            config.lookup_hmac_key.clone(),
            Arc::clone(&org_routing_resolver),
            Duration::from_secs(config.ingest_key_cache_ttl_secs),
            GooglePushAuth::new(http_client.clone()),
        ),
        aws_resolver: AwsConnectionResolver::new(
            Arc::clone(&store),
            config.lookup_hmac_key.clone(),
            org_routing_resolver,
            Duration::from_secs(config.ingest_key_cache_ttl_secs),
        ),
        telemetry_pipeline,
        http_client,
        config: config.clone(),
        autumn_tracker,
        autumn_entitlements,
        usage_metrics: usage_metrics.clone(),
        replay_session_budget: ReplaySessionBudget::new(config.replay_max_session_bytes),
        replay_blob_store: config.replay_blob_store.as_ref().map(|blob| {
            ReplayBlobStore::new(
                http_client_for_blobs,
                &blob.endpoint,
                blob.bucket.clone(),
                blob.access_key_id.clone(),
                blob.secret_access_key.clone(),
                blob.region.clone(),
                blob.timeout,
            )
        }),
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            AUTHORIZATION,
            CONTENT_TYPE,
            CONTENT_ENCODING,
            HeaderName::from_static("x-maple-ingest-key"),
            // SDK identity hint, sent by every browser SDK on every request. Not
            // allowing it fails preflight for the whole SDK, not just this header.
            HeaderName::from_static(SDK_HINT_HEADER),
            // Session-replay chunk metadata headers (POST /v1/sessionReplays/blob).
            // Without these the browser preflight blocks the cross-origin blob upload.
            HeaderName::from_static("x-maple-session-id"),
            HeaderName::from_static("x-maple-chunk-seq"),
            HeaderName::from_static("x-maple-is-checkpoint"),
            HeaderName::from_static("x-maple-event-count"),
            HeaderName::from_static("x-maple-duration-ms"),
        ]);

    let grpc_state = Arc::clone(&state);
    let request_timeout = config.request_timeout;
    let app = Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/v1/traces", post(handle_traces))
        .route("/v1/logs", post(handle_logs))
        .route("/v1/metrics", post(handle_metrics))
        .route("/v1/sessionReplays/meta", post(handle_replay_meta))
        .route("/v1/sessionReplays/blob", post(handle_replay_blob))
        .route("/v1/sessionEvents", post(handle_session_events))
        .route("/v1/events", post(handle_product_events))
        .route(
            "/v1/logpush/cloudflare/http_requests/{connector_id}",
            post(handle_cloudflare_logpush_http_requests),
        )
        .route("/v1/logpush/gcp/{connector_id}", post(handle_gcp_logpush))
        .route(
            "/v1/firehose/aws/{connection_id}",
            post(handle_aws_firehose),
        )
        .layer(cors)
        .layer(DefaultBodyLimit::max(config.max_request_body_bytes))
        .with_state(state);

    // Outermost, and applied after `with_state` so it carries its own state: the
    // deadline has to cover the whole stack, body collection included, or a
    // request stalled before it reaches a handler is still unbounded.
    let app = if request_timeout.is_zero() {
        warn!("INGEST_REQUEST_TIMEOUT_SECS=0: serving without a request deadline");
        app
    } else {
        app.layer(axum::middleware::from_fn_with_state(
            request_timeout,
            request_timeout_middleware,
        ))
    };

    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", config.port)).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("Failed to bind ingest server: {error}");
            std::process::exit(1);
        }
    };

    // First 8 chars of HMAC(lookup_hmac_key, fixed sentinel). One-way, so safe
    // to log — operators can diff this against the API's fingerprint to detect
    // env-var drift between the two services without ever printing the secret.
    let hmac_fingerprint = hash_ingest_key(HMAC_FINGERPRINT_SENTINEL, &config.lookup_hmac_key)
        .map_or_else(
            |_| "<error>".to_owned(),
            |h| h.chars().take(8).collect::<String>(),
        );

    {
        // Emit a single startup span so the dashboard has an authoritative
        // "ingest is alive" signal independent of customer traffic. Lives only
        // for the duration of this block, then gets exported by the batch
        // processor.
        let span = tracing::info_span!(
            "startup",
            otel.kind = "internal",
            "maple.ingest.port" = config.port,
            "maple.ingest.forward_endpoint" = %config.forward_endpoint,
            "maple.ingest.require_tls" = config.require_tls,
            "maple.ingest.hmac_fingerprint" = %hmac_fingerprint,
        );
        let _enter = span.enter();
        info!(
            port = config.port,
            forward_endpoint = %config.forward_endpoint,
            require_tls = config.require_tls,
            max_body_bytes = config.max_request_body_bytes,
            hmac_fingerprint = %hmac_fingerprint,
            "Maple ingest server listening"
        );
    }

    if let Some(grpc_port) = config.otlp_grpc_port {
        tokio::spawn(run_grpc_server(grpc_state, grpc_port));
    }

    let serve_result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await;

    // Intake has stopped (graceful shutdown drained in-flight requests), but
    // the WAL sits on ephemeral storage that dies with the task — export what
    // it still holds before exiting. The export workers stay alive until the
    // process ends, so this only has to wait for them.
    if let Some(pipeline) = drain_pipeline {
        let remaining = pipeline.drain_wal(drain_deadline).await;
        if remaining == 0 {
            info!("WAL drained clean on shutdown");
        } else {
            warn!(
                remaining_bytes = remaining,
                deadline_secs = drain_deadline.as_secs(),
                "Shutdown drain deadline hit with WAL backlog remaining"
            );
        }
        // Even a clean drain runs this: it marks the owner retired, so a
        // successor claims anything left instead of waiting out the staleness
        // window. With a backlog it also seals and ships the tail, which is the
        // difference between "replays if this task's storage survives" (it does
        // not — Fargate ephemeral storage dies with the task) and "replays".
        let shipped = pipeline.flush_wal_to_object_store().await;
        if shipped > 0 {
            info!(
                shipped_bytes = shipped,
                "Shipped the undrained WAL tail to the object store"
            );
        }
    }

    // Counts since the last periodic flush; best effort like the flusher itself.
    if ingest_rules_enabled {
        ingest_rule_stats.flush(stats_store.as_ref()).await;
    }

    if let Some(providers) = telemetry_providers {
        // Flush buffered spans on graceful exit. Errors here are non-fatal —
        // the process is shutting down anyway.
        drop(providers.tracer.shutdown());
        drop(providers.logger.shutdown());
    }

    if let Some(provider) = meter_provider {
        // Flush the final metric export on graceful exit.
        drop(provider.shutdown());
    }

    if let Some(usage) = usage_metrics {
        // Load-bearing, unlike the cumulative provider above: a delta interval
        // that is never collected is lost outright rather than folded into the
        // next export, so skipping this silently under-reports billable volume.
        usage.shutdown();
    }

    if let Err(error) = serve_result {
        eprintln!("Ingest server failed: {error}");
        std::process::exit(1);
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        drop(tokio::signal::ctrl_c().await);
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
}

async fn run_grpc_server(state: Arc<AppState>, port: u16) {
    let addr = ([0, 0, 0, 0], port).into();
    let server = tonic::transport::Server::builder().add_routes(grpc_router(state).into());

    info!(port, "Maple OTLP gRPC server listening");
    if let Err(error) = server.serve_with_shutdown(addr, shutdown_signal()).await {
        error!(error = %error, "OTLP gRPC server failed");
    }
}

/// The three OTLP services behind `grpc_admission`.
fn grpc_router(state: Arc<AppState>) -> Router {
    use opentelemetry_proto::tonic::collector::logs::v1::logs_service_server::LogsServiceServer;
    use opentelemetry_proto::tonic::collector::metrics::v1::metrics_service_server::MetricsServiceServer;
    use opentelemetry_proto::tonic::collector::trace::v1::trace_service_server::TraceServiceServer;

    tonic::service::Routes::new(TraceServiceServer::new(GrpcTraceService {
        state: Arc::clone(&state),
    }))
    .add_service(LogsServiceServer::new(GrpcLogsService {
        state: Arc::clone(&state),
    }))
    .add_service(MetricsServiceServer::new(GrpcMetricsService {
        state: Arc::clone(&state),
    }))
    .into_axum_router()
    .layer(axum::middleware::from_fn_with_state(state, grpc_admission))
}

/// A gRPC frame holding one zero-length (all-default) message, uncompressed.
const EMPTY_GRPC_MESSAGE: &[u8] = &[0, 0, 0, 0, 0];

/// Authenticate and entitlement-gate an OTLP/gRPC export on its headers alone.
///
/// tonic reads and decodes the whole message before a service method runs, so a
/// check inside `export` runs only after the request it refuses has been
/// received and decoded. Made here, in front of the services, an unknown key or
/// a denied org is turned away before any of the message is read. The resolved
/// key reaches `export` through the request extensions.
async fn grpc_admission(
    State(state): State<Arc<AppState>>,
    mut request: Request,
    next: Next,
) -> Response {
    // Not an OTLP export: tonic answers `Unimplemented`.
    let Some((rpc_service, signal)) = grpc_export_route(request.uri().path()) else {
        return next.run(request).await;
    };
    let span = grpc_server_span(rpc_service, signal.path());
    let span_handle = span.clone();
    let response = async move {
        let admitted = admit_grpc_export(&state, request.headers(), signal).await;
        match admitted {
            Ok((resolved, admission)) => {
                if admission == KeyAdmission::Drop {
                    // Paused: hand tonic one empty message instead of the upload, so
                    // nothing is read or decoded and the client still gets an OK reply.
                    *request.body_mut() = axum::body::Body::from(EMPTY_GRPC_MESSAGE);
                    request.headers_mut().remove("grpc-encoding");
                    request
                        .headers_mut()
                        .remove(axum::http::header::CONTENT_LENGTH);
                }
                request.extensions_mut().insert(resolved);
                request.extensions_mut().insert(admission);
                next.run(request).await
            }
            Err(status) => status.into_http(),
        }
    }
    .instrument(span)
    .await;
    record_grpc_outcome(&span_handle, &response);
    response
}

async fn admit_grpc_export(
    state: &AppState,
    headers: &HeaderMap,
    signal: Signal,
) -> Result<(ResolvedIngestKey, KeyAdmission), tonic::Status> {
    let resolved = resolve_grpc_ingest_key(state, headers).await?;
    record_grpc_identity(&resolved);
    let admission = authorize_source(state, &resolved, &[signal.source_signal()])
        .await
        .map_err(|error| grpc_status_for_key_rejection(&error))?;
    if admission == KeyAdmission::Ingest && resolved.org_id != SENTINEL_ORG_ID {
        if let Some(error) = entitlement_rejection(state, &resolved.org_id, signal.path()).await {
            return Err(tonic::Status::resource_exhausted(error.message));
        }
    }
    Ok((resolved, admission))
}

/// gRPC code for an `authorize_source` rejection.
fn grpc_status_for_key_rejection(error: &ApiError) -> tonic::Status {
    let message = error.message.clone();
    match error.status {
        StatusCode::UNAUTHORIZED => tonic::Status::unauthenticated(message),
        StatusCode::FORBIDDEN => tonic::Status::permission_denied(message),
        StatusCode::TOO_MANY_REQUESTS => tonic::Status::resource_exhausted(message),
        _ => tonic::Status::unavailable(message),
    }
}

/// The OTLP service and signal a gRPC request path exports to.
fn grpc_export_route(path: &str) -> Option<(&'static str, Signal)> {
    let service = path.strip_prefix('/')?.strip_suffix("/Export")?;
    [
        (GRPC_TRACE_SERVICE, Signal::Traces),
        (GRPC_LOGS_SERVICE, Signal::Logs),
        (GRPC_METRICS_SERVICE, Signal::Metrics),
    ]
    .into_iter()
    .find(|(name, _)| *name == service)
}

/// The key `grpc_admission` resolved for this request.
fn grpc_admitted_key<T>(
    request: &mut tonic::Request<T>,
) -> Result<(ResolvedIngestKey, KeyAdmission), tonic::Status> {
    let extensions = request.extensions_mut();
    let resolved = extensions
        .remove::<ResolvedIngestKey>()
        .ok_or_else(|| tonic::Status::internal("Internal error"))?;
    let admission = extensions
        .remove::<KeyAdmission>()
        .unwrap_or(KeyAdmission::Ingest);
    Ok((resolved, admission))
}

#[derive(Clone)]
struct GrpcTraceService {
    state: Arc<AppState>,
}

#[derive(Clone)]
struct GrpcLogsService {
    state: Arc<AppState>,
}

#[derive(Clone)]
struct GrpcMetricsService {
    state: Arc<AppState>,
}

#[tonic::async_trait]
impl opentelemetry_proto::tonic::collector::trace::v1::trace_service_server::TraceService
    for GrpcTraceService
{
    async fn export(
        &self,
        mut request: tonic::Request<ExportTraceServiceRequest>,
    ) -> Result<
        tonic::Response<
            opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceResponse,
        >,
        tonic::Status,
    > {
        let (resolved, admission) = grpc_admitted_key(&mut request)?;
        let inner = request.into_inner();
        // Sized before enrichment injects resource attributes, so this is the
        // client's own payload size — the same basis as the HTTP path's
        // `decoded_payload.len()`.
        let decoded_bytes = inner.encoded_len();
        let mut decoded = DecodedPayload::Traces(inner);
        let (admission, claims) =
            admit_grpc_claims(&self.state, admission, &mut decoded, &resolved).await;
        accept_grpc_decoded(
            &self.state,
            Signal::Traces,
            decoded,
            &resolved,
            admission,
            decoded_bytes,
            &claims,
        )
        .await?;
        Ok(tonic::Response::new(
            opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceResponse {
                partial_success: None,
            },
        ))
    }
}

#[tonic::async_trait]
impl opentelemetry_proto::tonic::collector::logs::v1::logs_service_server::LogsService
    for GrpcLogsService
{
    async fn export(
        &self,
        mut request: tonic::Request<ExportLogsServiceRequest>,
    ) -> Result<
        tonic::Response<opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceResponse>,
        tonic::Status,
    > {
        let (resolved, admission) = grpc_admitted_key(&mut request)?;
        let inner = request.into_inner();
        let decoded_bytes = inner.encoded_len();
        let mut decoded = DecodedPayload::Logs(inner);
        let (admission, claims) =
            admit_grpc_claims(&self.state, admission, &mut decoded, &resolved).await;
        accept_grpc_decoded(
            &self.state,
            Signal::Logs,
            decoded,
            &resolved,
            admission,
            decoded_bytes,
            &claims,
        )
        .await?;
        Ok(tonic::Response::new(
            opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceResponse {
                partial_success: None,
            },
        ))
    }
}

#[tonic::async_trait]
impl opentelemetry_proto::tonic::collector::metrics::v1::metrics_service_server::MetricsService
    for GrpcMetricsService
{
    async fn export(
        &self,
        mut request: tonic::Request<ExportMetricsServiceRequest>,
    ) -> Result<
        tonic::Response<
            opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceResponse,
        >,
        tonic::Status,
    > {
        let (resolved, admission) = grpc_admitted_key(&mut request)?;
        let inner = request.into_inner();
        let decoded_bytes = inner.encoded_len();
        let mut decoded = DecodedPayload::Metrics(inner);
        let (admission, claims) =
            admit_grpc_claims(&self.state, admission, &mut decoded, &resolved).await;
        accept_grpc_decoded(
            &self.state,
            Signal::Metrics,
            decoded,
            &resolved,
            admission,
            decoded_bytes,
            &claims,
        )
        .await?;
        Ok(tonic::Response::new(
            opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceResponse {
                partial_success: None,
            },
        ))
    }
}

/// Verifies a gRPC export's source claims; a batch of only paused pull sources
/// becomes a `Drop`, so the client still gets an OK reply.
async fn admit_grpc_claims(
    state: &AppState,
    admission: KeyAdmission,
    decoded: &mut DecodedPayload,
    resolved: &ResolvedIngestKey,
) -> (KeyAdmission, ClaimOutcome) {
    // A paused source's export reaches here empty (see `grpc_admission`).
    if admission != KeyAdmission::Ingest {
        return (admission, ClaimOutcome::default());
    }
    let claims = verify_claims_and_enrich(state, decoded, resolved).await;
    let admission = if claims.all_paused {
        KeyAdmission::Drop
    } else {
        admission
    };
    (admission, claims)
}

/// Accept a decoded export, already authenticated and entitlement-gated by
/// `grpc_admission`.
/// `decoded_bytes` is the export's size as received; only the share the claims and
/// ingest rules leave is metered.
async fn accept_grpc_decoded(
    state: &AppState,
    signal: Signal,
    mut decoded: DecodedPayload,
    resolved: &ResolvedIngestKey,
    admission: KeyAdmission,
    decoded_bytes: usize,
    claims: &ClaimOutcome,
) -> Result<(), tonic::Status> {
    // The sentinel token is a PUBLIC constant, so anything it carries is
    // attacker-authored and must never be stored. Discarded here for the same
    // reasons and with the same shape as `handle_signal_inner`'s HTTP
    // short-circuit: success to the client, nothing resolved, nothing forwarded.
    if resolved.org_id == SENTINEL_ORG_ID {
        metrics::sentinel(signal.path());
        Span::current().record("maple.ingest.key_type", "sentinel");
        debug!("Sentinel token; skipping forward");
        return Ok(());
    }
    // A paused key, decided at admission so a pause ending mid-upload cannot bill it.
    if admission == KeyAdmission::Drop {
        return Ok(());
    }

    let _org_inflight_permit = state
        .org_inflight_limiter
        .try_acquire(&resolved.org_id)
        .ok_or_else(|| tonic::Status::resource_exhausted("Per-org ingest limit exceeded"))?;
    let item_count = decoded.item_count();
    let mut retained = claims.retained;

    let result = process_decoded_payload(
        state,
        signal,
        PayloadFormat::Protobuf,
        None,
        &mut decoded,
        resolved,
        &mut retained,
    )
    .await;

    match result {
        Ok(_) => {
            state.resolver.note_source_use(resolved, claims.kept_claim);
            state
                .resolver
                .note_claimed_source_use(&claims.claimed_sources);
            let decoded_bytes = retained.metered_bytes(decoded_bytes);
            if resolved.org_id != SENTINEL_ORG_ID && decoded_bytes > 0 {
                if let Some(usage) = &state.usage_metrics {
                    usage.record(
                        &resolved.org_id,
                        signal.path(),
                        decoded_bytes as u64,
                        retained.metered_items(item_count) as u64,
                    );
                }
                if let Some(tracker) = &state.autumn_tracker {
                    tracker.track(
                        &resolved.org_id,
                        signal.path(),
                        billable_gb(decoded_bytes as u64),
                    );
                }
            }
            Ok(())
        }
        Err(error) => {
            if error.status == StatusCode::TOO_MANY_REQUESTS {
                Err(tonic::Status::resource_exhausted(error.message))
            } else {
                Err(tonic::Status::unavailable(error.message))
            }
        }
    }
}

async fn resolve_grpc_ingest_key(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<ResolvedIngestKey, tonic::Status> {
    let token = extract_ingest_key(headers)
        .ok_or_else(|| tonic::Status::unauthenticated("Missing ingest key"))?;

    if is_sentinel_token(&token) {
        return Ok(ResolvedIngestKey {
            org_id: SENTINEL_ORG_ID.to_owned(),
            key_type: IngestKeyType::Public,
            key_id: "sentinel".to_owned(),
            self_managed: false,
            clickhouse_ready: false,
            source: None,
            default_source: None,
        });
    }

    state
        .resolver
        .resolve_ingest_key(&token)
        .await
        .map_err(|_| tonic::Status::unavailable("Ingest authentication unavailable"))?
        .ok_or_else(|| tonic::Status::unauthenticated(state.config.invalid_key_message))
}

/// Liveness only — deliberately independent of Postgres.
///
/// If this ever starts reporting database health, a database outage becomes a
/// platform-driven restart loop, which is the exact failure this endpoint's
/// separation from `/ready` exists to prevent.
async fn health() -> &'static str {
    "OK"
}

/// Readiness — false until the key store has answered at least once.
///
/// This is the deploy gate that `std::process::exit(1)` used to be: a genuinely
/// broken deploy (bad credentials, missing schema) never goes ready and the
/// platform can roll it back, without a transient fault killing live tasks.
async fn ready(State(state): State<Arc<AppState>>) -> Response {
    if state.key_store_ready.load(Ordering::Relaxed) {
        (StatusCode::OK, "READY").into_response()
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "DEGRADED: key store unavailable",
        )
            .into_response()
    }
}

// The request entry points (`handle_*`, `handle_*_inner`, `accept_grpc_decoded`)
// are deliberately not `#[hotpath::measure]`d: wrapping their futures pushed the
// fully-inlined request state machine over the 2 MB tokio worker stack
// (release overflowed at the axum handlers, debug one level down). The stages
// underneath (`resolve_ingest_key`, `decode_otlp_payload`,
// `process_decoded_payload`, `forward_to_collector`, and the pipeline in
// `telemetry.rs`) are measured and add up to the same work.
async fn handle_traces(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    handle_signal(state, headers, body, Signal::Traces).await
}

async fn handle_logs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    handle_signal(state, headers, body, Signal::Logs).await
}

async fn handle_metrics(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    handle_signal(state, headers, body, Signal::Metrics).await
}

// Session replay ingest

/// Running total of decompressed rrweb bytes per in-flight replay session, used
/// to stop a runaway recording from writing an unbounded amount into
/// `session_replay_events`.
///
/// Deliberately best-effort and process-local. Sessions are short-lived and a
/// browser holds one origin connection for their duration, so a single replica
/// normally sees every chunk of a session; across N replicas the effective
/// ceiling degrades to roughly N x the configured limit. That is fine for an
/// absurdity guard — it still turns "unbounded" into "bounded" — but it is why
/// this must not be relied on as a billing-accurate quota.
///
/// Entries expire on idle rather than at a fixed age so a genuinely long session
/// keeps its accumulated total, while abandoned ones fall out of the map.
struct ReplaySessionBudget {
    totals: Cache<String, Arc<AtomicU64>>,
    limit: u64,
}

impl ReplaySessionBudget {
    fn new(limit: u64) -> Self {
        Self {
            totals: Cache::builder()
                .time_to_idle(Duration::from_hours(2))
                .max_capacity(100_000)
                .build(),
            limit,
        }
    }

    fn key(org_id: &str, session_id: &str) -> String {
        format!("{org_id}:{session_id}")
    }

    /// True once the session has already exceeded its ceiling. Checked before
    /// gunzipping so rejected chunks cost no decompression CPU.
    async fn is_exhausted(&self, org_id: &str, session_id: &str) -> bool {
        if self.limit == 0 {
            return false;
        }
        match self.totals.get(&Self::key(org_id, session_id)).await {
            Some(total) => total.load(Ordering::Relaxed) >= self.limit,
            None => false,
        }
    }

    /// Add a chunk's decompressed size and return the session's new total. The
    /// chunk that crosses the limit is still accepted, so playback truncates at
    /// a chunk boundary instead of on a partial payload; every chunk after it is
    /// rejected by `is_exhausted`.
    async fn add(&self, org_id: &str, session_id: &str, bytes: u64) -> u64 {
        if self.limit == 0 {
            return 0;
        }
        let counter = self
            .totals
            .get_with(Self::key(org_id, session_id), async {
                Arc::new(AtomicU64::new(0))
            })
            .await;
        counter.fetch_add(bytes, Ordering::Relaxed) + bytes
    }
}

/// Header every Maple SDK stamps on every ingest request: `<sdk-name>/<version>`,
/// e.g. `maple-browser/0.3.0` or `maple-effect-sdk-client/0.7.0`.
///
/// Browsers do not let a page set `user-agent`, and until this existed a
/// rejected request from a browser SDK carried NOTHING that said which SDK or
/// version produced it — a malformed replay chunk could not be traced back to a
/// release. Recorded as `maple.sdk` on every request span. Must stay in the CORS
/// allow-list: an SDK that sends it against a gateway that doesn't allow it
/// fails preflight, and with it every browser request.
const SDK_HINT_HEADER: &str = "x-maple-sdk";
/// Longest `x-maple-sdk` / `user-agent` value recorded; longer ones are cut so
/// a hostile client cannot bloat span attributes.
const CLIENT_IDENTITY_MAX_LEN: usize = 128;

/// Record who sent this request on the current handler span: `maple.sdk` from
/// `SDK_HINT_HEADER`, `user_agent.original` from `user-agent`. Both fields must
/// be declared `Empty` on the span. Missing headers record nothing, so an
/// absent value reads as absent rather than as an empty string.
fn record_client_identity(span: &Span, headers: &HeaderMap) {
    if let Some(sdk) = replay_header(headers, SDK_HINT_HEADER) {
        span.record("maple.sdk", truncate_chars(&sdk, CLIENT_IDENTITY_MAX_LEN));
    }
    if let Some(ua) = replay_header(headers, "user-agent") {
        span.record(
            "user_agent.original",
            truncate_chars(&ua, CLIENT_IDENTITY_MAX_LEN),
        );
    }
}

fn truncate_chars(value: &str, max: usize) -> &str {
    match value.char_indices().nth(max) {
        Some((idx, _)) => &value[..idx],
        None => value,
    }
}

/// Turn a gunzip failure on the replay blob path into the 400 the SDK expects,
/// after recording what the body actually looked like on the current span.
///
/// The prefix and content-type go on the span, not into the message: the
/// message is the error fingerprint, and a per-body hex prefix in it would
/// split one cause into thousands of issues. `first_bytes` is what tells a
/// gzip stream (`1f8b08`) apart from JSON someone forgot to compress (`5b7b`)
/// or a stringified byte array (`33312c31...`).
fn replay_gunzip_rejection(headers: &HeaderMap, body: &[u8], error: &std::io::Error) -> ApiError {
    let span = Span::current();
    span.record(
        "maple.replay.body_prefix",
        hex_prefix(body, REPLAY_BODY_PREFIX_BYTES).as_str(),
    );
    if let Some(content_type) = replay_header(headers, "content-type") {
        span.record(
            "http.request.header.content-type",
            truncate_chars(&content_type, CLIENT_IDENTITY_MAX_LEN),
        );
    }
    let message = format!("failed to gunzip replay chunk: {error}");
    if looks_like_gzip_member(body) {
        ApiError::bad_request(message)
    } else {
        ApiError::tagged(
            StatusCode::BAD_REQUEST,
            &INGEST_REPLAY_BODY_NOT_GZIP,
            message,
        )
    }
}

const REPLAY_BODY_PREFIX_BYTES: usize = 16;

/// A gzip member is a 10-byte header (`1f 8b`, compression method `08`, a
/// flags byte with its three reserved high bits clear) plus an 8-byte trailer.
/// A body shorter than that, or whose header says otherwise, was never a
/// stream the SDK produced; a body that passes may still be a truncated real
/// recording, which is a lost chunk and stays an `Error`.
const GZIP_MEMBER_MIN_LEN: usize = 18;
const GZIP_METHOD_DEFLATE: u8 = 0x08;
const GZIP_RESERVED_FLAGS: u8 = 0xe0;

fn looks_like_gzip_member(body: &[u8]) -> bool {
    body.len() >= GZIP_MEMBER_MIN_LEN
        && body.starts_with(&[0x1f, 0x8b, GZIP_METHOD_DEFLATE])
        && body[3] & GZIP_RESERVED_FLAGS == 0
}

fn hex_prefix(body: &[u8], n: usize) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(n * 2);
    for byte in body.iter().take(n) {
        out.push(char::from(HEX[usize::from(byte >> 4)]));
        out.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    out
}

fn replay_header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// Storage-key-safe session id: bounded length, alphanumeric + `-`/`_` only, so
/// a malicious value can't poison the `{org_id}/{session_id}` keying in ClickHouse.
fn is_safe_replay_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Two-letter ISO country for a session, derived from `Cf-IPCountry`.
///
/// Server-derived on purpose: the client never gets a say, so `Country` cannot
/// be spoofed into a competitor's dashboard. The strict shape check also bounds
/// the `LowCardinality(String)` dictionary to ~250 values no matter what
/// arrives — an unbounded dictionary on that column would degrade every query
/// on the table for that org.
///
/// Returns `""` (the column default) when geo is untrusted, absent, or
/// unrecognized. Cloudflare's `XX` (unknown) and `T1` (Tor exit) are mapped to
/// `""` as well: they are not countries, and leaving them in makes every
/// breakdown carry two junk buckets.
///
/// The client IP is deliberately never read or stored — country is all we take.
fn derive_country(headers: &HeaderMap, trust_proxy_geo: bool) -> String {
    if !trust_proxy_geo {
        return String::new();
    }
    let Some(raw) = replay_header(headers, "cf-ipcountry") else {
        return String::new();
    };
    if raw.len() != 2 || !raw.bytes().all(|b| b.is_ascii_alphabetic()) {
        return String::new();
    }
    let code = raw.to_ascii_uppercase();
    if code == "XX" || code == "T1" {
        return String::new();
    }
    code
}

/// What happens to an admitted request's data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeyAdmission {
    Ingest,
    /// A paused source: answer with success, store and bill nothing.
    Drop,
}

/// Per-request checks for a source: expiry, signal allow-list, pause
/// and rate limit, in that order. Admits default keys unchanged.
/// `signals` is any-of: the key must allow at least one of them.
async fn authorize_source(
    state: &AppState,
    resolved_key: &ResolvedIngestKey,
    signals: &[SourceSignal],
) -> Result<KeyAdmission, ApiError> {
    let Some(source) = &resolved_key.source else {
        return Ok(KeyAdmission::Ingest);
    };
    let now_ms = current_time_millis();
    if source.is_expired(now_ms) {
        warn!(key_id = %source.public_id, "Source expired");
        return Err(ApiError::tagged(
            StatusCode::UNAUTHORIZED,
            &INGEST_KEY_EXPIRED,
            "Ingest key expired",
        ));
    }
    if !signals.iter().any(|signal| source.allows(*signal)) {
        let names = signals
            .iter()
            .map(|signal| signal.as_str())
            .collect::<Vec<_>>()
            .join(" or ");
        warn!(
            key_id = %source.public_id,
            signal = names.as_str(),
            "Source denied for signal"
        );
        // A paused source drops what it is sent; a refusal now would surface only after resume.
        if !source.is_paused(now_ms) {
            state.resolver.note_source_rejection(
                resolved_key,
                format!("Sent {names}, which this source does not allow"),
            );
        }
        return Err(ApiError::tagged(
            StatusCode::FORBIDDEN,
            &INGEST_SIGNAL_NOT_ALLOWED,
            format!("This ingest key is not allowed to send {names}"),
        ));
    }
    if source.is_paused(now_ms) {
        let signal = signals.first().map_or("unknown", |signal| signal.as_str());
        metrics::source_paused_drop(&resolved_key.org_id, signal);
        Span::current().record("maple.ingest.reject_reason", "source_paused");
        debug!(key_id = %source.public_id, "Source paused; dropping");
        return Ok(KeyAdmission::Drop);
    }
    if let Some(rps) = source.rate_limit_rps {
        if !state.key_rate_limiter.try_acquire(&source.id, rps).await {
            metrics::org_throttled(&resolved_key.org_id, "key_rate_limit");
            warn!(
                key_id = %source.public_id,
                rate_limit_rps = rps,
                "Source rate limit exceeded"
            );
            state.resolver.note_source_rejection(
                resolved_key,
                format!("Rate limited at {rps} requests per second"),
            );
            return Err(ApiError::tagged(
                StatusCode::TOO_MANY_REQUESTS,
                &INGEST_KEY_RATE_LIMITED,
                format!("Ingest key rate limit of {rps} requests per second exceeded"),
            ));
        }
    }
    Ok(KeyAdmission::Ingest)
}

/// Auth shared by the replay and session endpoints. `Ok(None)` is the sentinel
/// token or a paused key: silently dropped like the OTLP path.
async fn resolve_replay_key(
    state: &AppState,
    headers: &HeaderMap,
    signals: &[SourceSignal],
) -> Result<Option<ResolvedIngestKey>, ApiError> {
    let ingest_key =
        extract_ingest_key(headers).ok_or_else(|| ApiError::unauthorized("Missing ingest key"))?;
    if is_sentinel_token(&ingest_key) {
        return Ok(None);
    }
    let resolved = state
        .resolver
        .resolve_ingest_key(&ingest_key)
        .await
        .map_err(|_| ApiError::service_unavailable("Ingest authentication unavailable"))?
        .ok_or_else(|| ApiError::unauthorized(state.config.invalid_key_message))?;
    match authorize_source(state, &resolved, signals).await? {
        KeyAdmission::Ingest => Ok(Some(resolved)),
        KeyAdmission::Drop => Ok(None),
    }
}

async fn handle_replay_meta(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    metrics::request_started();
    let _guard = InFlightGuard;
    let span = tracing::info_span!(
        "ingest_replay_meta",
        otel.name = "POST /v1/sessionReplays/meta",
        otel.kind = "server",
        otel.status_code = tracing::field::Empty,
        otel.status_description = tracing::field::Empty,
        "maple.ingest.reject_reason" = tracing::field::Empty,
        "http.request.method" = "POST",
        "http.route" = "/v1/sessionReplays/meta",
        "http.request.body.size" = body.len(),
        "http.response.status_code" = tracing::field::Empty,
        "error.type" = tracing::field::Empty,
        "maple.signal" = "session_replays",
        "maple.org_id" = tracing::field::Empty,
        "maple.ingest.clickhouse_ready" = tracing::field::Empty,
        "maple.ingest.destination" = tracing::field::Empty,
        "maple.sdk" = tracing::field::Empty,
        "user_agent.original" = tracing::field::Empty,
    );
    record_client_identity(&span, &headers);
    let span_handle = span.clone();
    match handle_replay_meta_inner(&state, &headers, body)
        .instrument(span)
        .await
    {
        Ok(count) => {
            span_handle.record("http.response.status_code", 200u16);
            span_handle.record("otel.status_code", "Ok");
            (StatusCode::OK, axum::Json(AcceptedBody { accepted: count })).into_response()
        }
        Err(error) => {
            let status = error.status.as_u16();
            span_handle.record("http.response.status_code", status);
            span_handle.record("error.type", error.error_kind());
            record_rejection_reason(
                &span_handle,
                status,
                error.error_kind(),
                error.reason().as_str(),
            );
            error.into_response()
        }
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "one linear request pass with an early return at each rejection; helpers would thread \
              a dozen locals back and forth"
)]
async fn handle_replay_meta_inner(
    state: &AppState,
    headers: &HeaderMap,
    body: Bytes,
) -> Result<usize, ApiError> {
    let Some(resolved_key) = resolve_replay_key(state, headers, &[SourceSignal::Sessions]).await?
    else {
        return Ok(0);
    };
    let org_id = resolved_key.org_id.clone();
    Span::current().record("maple.org_id", org_id.as_str());
    Span::current().record(
        "maple.ingest.clickhouse_ready",
        resolved_key.clickhouse_ready,
    );
    let destination = native_destination_for(&resolved_key);
    Span::current().record("maple.ingest.destination", destination.as_str());

    let _org_inflight_permit =
        state
            .org_inflight_limiter
            .try_acquire(&org_id)
            .ok_or_else(|| {
                warn!(org_id = %org_id, "Per-org in-flight ingest limit exceeded");
                ApiError::too_many_requests("Per-org ingest limit exceeded")
            })?;

    let pipeline = native_rows_pipeline_for(
        state,
        destination,
        "Session replay storage is not configured",
    )?;

    // NDJSON: one session-metadata object per line. The org_id is always taken
    // from the authenticated key, never from the client-supplied body.
    //
    // Meter one browser session per visit to Autumn: the SDK claims a visit once
    // per visitor per 30-minute idle window across tabs and subdomains, and marks
    // the claiming session's rows `billable_start: 1`. See
    // `take_billable_session_start` for the rule and its legacy-SDK fallback.
    let country = derive_country(headers, state.config.trust_proxy_geo);
    let mut rows: Vec<Vec<u8>> = Vec::new();
    let mut session_starts: u64 = 0;
    for line in body.split(|&b| b == b'\n') {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let mut value: serde_json::Value = serde_json::from_slice(line)
            .map_err(|e| ApiError::bad_request(format!("invalid session metadata JSON: {e}")))?;
        let obj = value
            .as_object_mut()
            .ok_or_else(|| ApiError::bad_request("session metadata must be a JSON object"))?;
        obj.insert(
            "org_id".to_owned(),
            serde_json::Value::String(org_id.clone()),
        );
        // Server-derived fields, forced alongside org_id so the three stay
        // visibly paired: whatever the client sent is overwritten, including
        // with an empty string. Both the active and ended rows get them, which
        // matters because ReplacingMergeTree replaces the whole row — a country
        // present only on v1 would be erased by the v2 merge.
        obj.insert(
            "country".to_owned(),
            serde_json::Value::String(country.clone()),
        );
        let referrer = obj
            .get("referrer")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_owned();
        let current_host = obj
            .get("host")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_owned();
        let referrer_host = derive_referrer_host(&referrer, &current_host);
        obj.insert(
            "referrer_host".to_owned(),
            serde_json::Value::String(referrer_host),
        );
        // Everything else on this row is client-supplied, including six
        // LowCardinality columns. Clamp before it reaches the warehouse — the
        // SDK's own trimming ships in customer JavaScript.
        sanitize_session_meta(obj);
        if take_billable_session_start(obj) {
            session_starts += 1;
        }
        rows.push(
            serde_json::to_vec(&value).map_err(|e| {
                ApiError::bad_request(format!("failed to re-serialize metadata: {e}"))
            })?,
        );
    }

    if rows.is_empty() {
        return Ok(0);
    }
    let count = rows.len();
    #[expect(
        clippy::cast_precision_loss,
        reason = "a single request carries far fewer than 2^53 session starts"
    )]
    let billable_sessions = session_starts as f64;
    metered_enqueue(
        state,
        &org_id,
        BROWSER_SESSIONS_FEATURE_ID,
        billable_sessions,
        OnDenied::Reject,
        || async {
            pipeline
                .accept_rows_to(
                    &org_id,
                    state.config.tinybird.datasource_session_replays.clone(),
                    rows,
                    TelemetrySignal::SessionReplays,
                    destination,
                )
                .await
                .map_err(|e| {
                    warn!(org_id = %org_id, error = %e, "session metadata enqueue rejected");
                    api_error_from_pipeline(&e)
                })
        },
    )
    .await?;

    state.resolver.note_source_use(&resolved_key, false);
    Ok(count)
}

async fn handle_session_events(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    metrics::request_started();
    let _guard = InFlightGuard;
    let span = tracing::info_span!(
        "ingest_session_events",
        otel.name = "POST /v1/sessionEvents",
        otel.kind = "server",
        otel.status_code = tracing::field::Empty,
        otel.status_description = tracing::field::Empty,
        "maple.ingest.reject_reason" = tracing::field::Empty,
        "http.request.method" = "POST",
        "http.route" = "/v1/sessionEvents",
        "http.request.body.size" = body.len(),
        "http.response.status_code" = tracing::field::Empty,
        "error.type" = tracing::field::Empty,
        "maple.signal" = "session_events",
        "maple.org_id" = tracing::field::Empty,
        "maple.ingest.clickhouse_ready" = tracing::field::Empty,
        "maple.ingest.destination" = tracing::field::Empty,
        "maple.session_events.dropped" = tracing::field::Empty,
        "maple.session_events.denied" = tracing::field::Empty,
        "maple.product_events.metered" = tracing::field::Empty,
        "maple.sdk" = tracing::field::Empty,
        "user_agent.original" = tracing::field::Empty,
    );
    record_client_identity(&span, &headers);
    let span_handle = span.clone();
    match handle_session_events_inner(&state, &headers, body)
        .instrument(span)
        .await
    {
        Ok(count) => {
            span_handle.record("http.response.status_code", 200u16);
            span_handle.record("otel.status_code", "Ok");
            (StatusCode::OK, axum::Json(AcceptedBody { accepted: count })).into_response()
        }
        Err(error) => {
            let status = error.status.as_u16();
            span_handle.record("http.response.status_code", status);
            span_handle.record("error.type", error.error_kind());
            record_rejection_reason(
                &span_handle,
                status,
                error.error_kind(),
                error.reason().as_str(),
            );
            error.into_response()
        }
    }
}

async fn handle_session_events_inner(
    state: &AppState,
    headers: &HeaderMap,
    body: Bytes,
) -> Result<usize, ApiError> {
    // `custom` rows are browser `track()` product events, so a source token needs
    // `events` for those and `sessions` for the rest; disallowed rows are dropped.
    let Some(resolved_key) = resolve_replay_key(
        state,
        headers,
        &[SourceSignal::Sessions, SourceSignal::Events],
    )
    .await?
    else {
        return Ok(0);
    };
    let allows = |signal| {
        resolved_key
            .source
            .as_ref()
            .is_none_or(|source| source.allows(signal))
    };
    let (allow_sessions, allow_events) =
        (allows(SourceSignal::Sessions), allows(SourceSignal::Events));
    let org_id = resolved_key.org_id.clone();
    Span::current().record("maple.org_id", org_id.as_str());
    Span::current().record(
        "maple.ingest.clickhouse_ready",
        resolved_key.clickhouse_ready,
    );
    let destination = native_destination_for(&resolved_key);
    Span::current().record("maple.ingest.destination", destination.as_str());

    let _org_inflight_permit =
        state
            .org_inflight_limiter
            .try_acquire(&org_id)
            .ok_or_else(|| {
                warn!(org_id = %org_id, "Per-org in-flight ingest limit exceeded");
                ApiError::too_many_requests("Per-org ingest limit exceeded")
            })?;

    // Same Autumn gate as the metadata endpoint. Automatic session events
    // (clicks, navigations, errors, ...) are not separately metered —
    // `browser_sessions` remains their billed unit — but they must still be
    // entitlement-gated: an out-of-quota org whose metadata rows are rejected
    // while its event stream keeps writing is the incoherent half of the old
    // design. `type == "custom"` rows are different: a browser `track()` call is
    // a product event, and it is metered as `product_events` below (same unit as
    // `/v1/events`). The REJECTION here deliberately stays on `browser_sessions`:
    // an exhausted product-events allowance is billed as usage_based overage and
    // must not 402 a whole session transcript.
    if org_id != SENTINEL_ORG_ID {
        if let Some(error) =
            entitlement_rejection(state, &org_id, BROWSER_SESSIONS_FEATURE_ID).await
        {
            return Err(error);
        }
    }

    let pipeline = native_rows_pipeline_for(
        state,
        destination,
        "Session event storage is not configured",
    )?;

    // NDJSON: one distilled session-event object per line. As with replay
    // metadata, org_id is taken from the authenticated key, never the body.
    let mut rows: Vec<Vec<u8>> = Vec::new();
    let mut dropped: u64 = 0;
    let mut custom_events: u64 = 0;
    let mut denied: u64 = 0;
    for line in body.split(|&b| b == b'\n') {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let mut value: serde_json::Value = serde_json::from_slice(line)
            .map_err(|e| ApiError::bad_request(format!("invalid session event JSON: {e}")))?;
        let obj = value
            .as_object_mut()
            .ok_or_else(|| ApiError::bad_request("session event must be a JSON object"))?;
        // Unknown `Type` values and oversized message/attribute payloads would
        // bloat this table's LowCardinality dictionaries, which degrades every
        // query on it for that org. Drop or clamp the row rather than failing
        // the batch — see `sanitize_session_event`.
        if !sanitize_session_event(obj) {
            dropped += 1;
            continue;
        }
        let is_custom = obj.get("type").and_then(|v| v.as_str()) == Some("custom");
        if !(if is_custom {
            allow_events
        } else {
            allow_sessions
        }) {
            denied += 1;
            continue;
        }
        if is_custom {
            custom_events += 1;
        }
        obj.insert(
            "org_id".to_owned(),
            serde_json::Value::String(org_id.clone()),
        );
        rows.push(
            serde_json::to_vec(&value)
                .map_err(|e| ApiError::bad_request(format!("failed to re-serialize event: {e}")))?,
        );
    }

    if denied > 0 {
        Span::current().record("maple.session_events.denied", denied);
    }
    if dropped > 0 {
        Span::current().record("maple.session_events.dropped", dropped);
        warn!(
            org_id = %org_id,
            dropped,
            "dropped session events with an unrecognized type"
        );
    }

    if rows.is_empty() {
        return Ok(0);
    }
    let count = rows.len();
    Span::current().record("maple.product_events.metered", custom_events);
    // Only the custom rows are metered; the automatic ones ride on the
    // session's `browser_sessions` unit. A batch with no custom rows reserves
    // nothing (`metered_enqueue` skips zero) and just enqueues.
    metered_enqueue(
        state,
        &org_id,
        PRODUCT_EVENTS_FEATURE_ID,
        custom_events as f64,
        OnDenied::MeterAnyway,
        || async {
            pipeline
                .accept_rows_to(
                    &org_id,
                    state.config.tinybird.datasource_session_events.clone(),
                    rows,
                    TelemetrySignal::SessionEvents,
                    destination,
                )
                .await
                .map_err(|e| {
                    warn!(org_id = %org_id, error = %e, "session events enqueue rejected");
                    api_error_from_pipeline(&e)
                })
        },
    )
    .await?;
    state.resolver.note_source_use(&resolved_key, false);
    Ok(count)
}

async fn handle_product_events(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    metrics::request_started();
    let _guard = InFlightGuard;
    let span = tracing::info_span!(
        "ingest_product_events",
        otel.name = "POST /v1/events",
        otel.kind = "server",
        otel.status_code = tracing::field::Empty,
        otel.status_description = tracing::field::Empty,
        "maple.ingest.reject_reason" = tracing::field::Empty,
        "http.request.method" = "POST",
        "http.route" = "/v1/events",
        "http.request.body.size" = body.len(),
        "http.response.status_code" = tracing::field::Empty,
        "error.type" = tracing::field::Empty,
        "maple.signal" = "product_events",
        "maple.org_id" = tracing::field::Empty,
        "maple.ingest.clickhouse_ready" = tracing::field::Empty,
        "maple.ingest.destination" = tracing::field::Empty,
        "maple.product_events.dropped" = tracing::field::Empty,
        "maple.product_events.metered" = tracing::field::Empty,
    );
    let span_handle = span.clone();
    match handle_product_events_inner(&state, &headers, body)
        .instrument(span)
        .await
    {
        Ok(count) => {
            span_handle.record("http.response.status_code", 200u16);
            span_handle.record("otel.status_code", "Ok");
            (StatusCode::OK, axum::Json(AcceptedBody { accepted: count })).into_response()
        }
        Err(error) => {
            let status = error.status.as_u16();
            span_handle.record("http.response.status_code", status);
            span_handle.record("error.type", error.error_kind());
            record_rejection_reason(
                &span_handle,
                status,
                error.error_kind(),
                error.message.as_str(),
            );
            error.into_response()
        }
    }
}

/// `POST /v1/events` — product events posted directly by backends and mobile
/// apps (browser rows reach `product_events` through the `session_events`
/// materialized view instead). Same auth, NDJSON framing and per-row drop
/// policy as `/v1/sessionEvents`; the row shape is fixed by
/// `sanitize_product_event`. Entitlement-gated and metered as `product_events`,
/// one unit per row that reaches the WAL.
async fn handle_product_events_inner(
    state: &AppState,
    headers: &HeaderMap,
    body: Bytes,
) -> Result<usize, ApiError> {
    let resolved_key = match resolve_replay_key(state, headers, &[SourceSignal::Events]).await? {
        Some(resolved_key) => resolved_key,
        None => return Ok(0),
    };
    let org_id = resolved_key.org_id.clone();
    Span::current().record("maple.org_id", org_id.as_str());
    Span::current().record(
        "maple.ingest.clickhouse_ready",
        resolved_key.clickhouse_ready,
    );
    let destination = native_destination_for(&resolved_key);
    Span::current().record("maple.ingest.destination", destination.as_str());

    let _org_inflight_permit =
        state
            .org_inflight_limiter
            .try_acquire(&org_id)
            .ok_or_else(|| {
                warn!(org_id = %org_id, "Per-org in-flight ingest limit exceeded");
                ApiError::too_many_requests("Per-org ingest limit exceeded")
            })?;

    // Product events are their own metered feature, but they are NOT gated on
    // it — same reasoning as the `type == "custom"` rows on `/v1/sessionEvents`.
    // Autumn answers `allowed: false` for a customer that simply has no balance
    // for the feature yet (a plan item not pushed, or not granted to a live
    // subscription), which is every org until the `atmn push` in the rollout
    // checklist lands. A gate here would turn that window into a 402 on every
    // backend and mobile event — including the API's own signup/plan emits —
    // and `decide_allowed` reads a well-formed `allowed: false` as a real
    // denial, so the fail-open in `is_allowed` never rescues it. The quantity is
    // still reserved and recorded per accepted row below.
    let pipeline = native_rows_pipeline_for(
        state,
        destination,
        "Product event storage is not configured",
    )?;

    // One receipt time for the whole batch: rows without a `timestamp` all
    // land at the moment the request arrived, not spread across the parse.
    let received_at = chrono::Utc::now();
    let mut rows: Vec<Vec<u8>> = Vec::new();
    let mut dropped: u64 = 0;
    for line in body.split(|&b| b == b'\n') {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let mut value: serde_json::Value = serde_json::from_slice(line)
            .map_err(|e| ApiError::bad_request(format!("invalid product event JSON: {e}")))?;
        let obj = value
            .as_object_mut()
            .ok_or_else(|| ApiError::bad_request("product event must be a JSON object"))?;
        if !sanitize_product_event(obj, received_at) {
            dropped += 1;
            continue;
        }
        // org_id comes from the authenticated key, never the body — the
        // sanitizer already discarded whatever the client sent under that name.
        obj.insert(
            "org_id".to_string(),
            serde_json::Value::String(org_id.clone()),
        );
        rows.push(
            serde_json::to_vec(&value)
                .map_err(|e| ApiError::bad_request(format!("failed to re-serialize event: {e}")))?,
        );
    }

    if dropped > 0 {
        Span::current().record("maple.product_events.dropped", dropped);
        warn!(
            org_id = %org_id,
            dropped,
            "dropped malformed product events (name, source or timestamp)"
        );
    }

    if rows.is_empty() {
        return Ok(0);
    }
    // Metered quantity = rows actually enqueued, i.e. after the sanitiser's
    // drops — a malformed line is neither stored nor billed.
    let count = rows.len();
    Span::current().record("maple.product_events.metered", count as u64);
    metered_enqueue(
        state,
        &org_id,
        PRODUCT_EVENTS_FEATURE_ID,
        count as f64,
        // Fail-open, matching the entitlement decision above: a denial here is
        // far more likely to mean "the feature is not provisioned yet" than
        // "this org is over its allowance", and dropping a backend's buffered
        // batch is not a recoverable outcome for the caller.
        OnDenied::MeterAnyway,
        || async {
            pipeline
                .accept_rows_to(
                    &org_id,
                    state.config.tinybird.datasource_product_events.clone(),
                    rows,
                    TelemetrySignal::ProductEvents,
                    destination,
                )
                .await
                .map_err(|e| {
                    warn!(org_id = %org_id, error = %e, "product events enqueue rejected");
                    api_error_from_pipeline(&e)
                })
        },
    )
    .await?;
    state.resolver.note_source_use(&resolved_key, false);
    Ok(count)
}

/// Bounded gunzip of a replay chunk into text. Invalid UTF-8 reads as the
/// same error `read_to_string` raised, so the rejection fingerprint holds.
fn gunzip_replay_text(body: &[u8], max_decoded: usize) -> Result<String, GunzipError> {
    let bytes = gunzip_bounded(body, max_decoded)?;
    String::from_utf8(bytes).map_err(|_| {
        GunzipError::Invalid(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "stream did not contain valid UTF-8",
        ))
    })
}

async fn handle_replay_blob(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    metrics::request_started();
    let _guard = InFlightGuard;
    let span = tracing::info_span!(
        "ingest_replay_blob",
        otel.name = "POST /v1/sessionReplays/blob",
        otel.kind = "server",
        otel.status_code = tracing::field::Empty,
        otel.status_description = tracing::field::Empty,
        "maple.ingest.reject_reason" = tracing::field::Empty,
        "http.request.method" = "POST",
        "http.route" = "/v1/sessionReplays/blob",
        "http.request.body.size" = body.len(),
        "http.response.status_code" = tracing::field::Empty,
        "error.type" = tracing::field::Empty,
        "maple.signal" = "session_replays",
        "maple.org_id" = tracing::field::Empty,
        "maple.ingest.clickhouse_ready" = tracing::field::Empty,
        "maple.ingest.destination" = tracing::field::Empty,
        "maple.replay.truncated" = tracing::field::Empty,
        "maple.replay.storage" = tracing::field::Empty,
        "maple.replay.object_key" = tracing::field::Empty,
        "maple.replay.blob_put_ms" = tracing::field::Empty,
        "maple.replay.blob_attempts" = tracing::field::Empty,
        "maple.replay.blob_status" = tracing::field::Empty,
        "maple.replay.blob_error_kind" = tracing::field::Empty,
        "maple.replay.blob_request_id" = tracing::field::Empty,
        "maple.replay.blob_cf_ray" = tracing::field::Empty,
        "maple.replay.body_prefix" = tracing::field::Empty,
        "http.request.header.content-type" = tracing::field::Empty,
        "maple.sdk" = tracing::field::Empty,
        "user_agent.original" = tracing::field::Empty,
    );
    record_client_identity(&span, &headers);
    let span_handle = span.clone();
    match handle_replay_blob_inner(&state, &headers, body)
        .instrument(span)
        .await
    {
        Ok(()) => {
            span_handle.record("http.response.status_code", 200u16);
            span_handle.record("otel.status_code", "Ok");
            StatusCode::OK.into_response()
        }
        Err(error) => {
            let status = error.status.as_u16();
            span_handle.record("http.response.status_code", status);
            span_handle.record("error.type", error.error_kind());
            record_rejection_reason(
                &span_handle,
                status,
                error.error_kind(),
                error.reason().as_str(),
            );
            error.into_response()
        }
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "one linear request pass with an early return at each rejection; helpers would thread \
              a dozen locals back and forth"
)]
async fn handle_replay_blob_inner(
    state: &AppState,
    headers: &HeaderMap,
    body: Bytes,
) -> Result<(), ApiError> {
    let Some(resolved_key) = resolve_replay_key(state, headers, &[SourceSignal::Sessions]).await?
    else {
        return Ok(());
    };
    let org_id = resolved_key.org_id.clone();
    Span::current().record("maple.org_id", org_id.as_str());
    Span::current().record(
        "maple.ingest.clickhouse_ready",
        resolved_key.clickhouse_ready,
    );
    let destination = native_destination_for(&resolved_key);
    Span::current().record("maple.ingest.destination", destination.as_str());

    let _org_inflight_permit =
        state
            .org_inflight_limiter
            .try_acquire(&org_id)
            .ok_or_else(|| {
                warn!(org_id = %org_id, "Per-org in-flight ingest limit exceeded");
                ApiError::too_many_requests("Per-org ingest limit exceeded")
            })?;

    let pipeline = native_rows_pipeline_for(
        state,
        destination,
        "Session replay storage is not configured",
    )?;

    let session_id = replay_header(headers, "x-maple-session-id")
        .ok_or_else(|| ApiError::bad_request("missing x-maple-session-id header"))?;
    if !is_safe_replay_id(&session_id) {
        return Err(ApiError::bad_request("invalid x-maple-session-id"));
    }
    // The org id comes from the resolved key rather than the request, so this is
    // a guard against a malformed key row, not against the caller. It matters
    // because the id is now a path segment in a signed URL, not just a quoted
    // SQL param.
    if state.replay_blob_store.is_some() && !is_safe_replay_id(&org_id) {
        return Err(ApiError::service_unavailable(
            "organization id is not storage-key safe",
        ));
    }
    let chunk_seq: u32 = replay_header(headers, "x-maple-chunk-seq")
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| ApiError::bad_request("missing or invalid x-maple-chunk-seq header"))?;
    let is_checkpoint: u8 = replay_header(headers, "x-maple-is-checkpoint")
        .map_or(0, |v| u8::from(v == "1" || v.eq_ignore_ascii_case("true")));
    let event_count: u32 = replay_header(headers, "x-maple-event-count")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let duration_ms: u32 = replay_header(headers, "x-maple-duration-ms")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    // Drop chunks for a session that already blew its byte ceiling before paying
    // to decompress them. The SDK treats a non-2xx as a dropped chunk and does
    // not retry, so this ends the recording cleanly rather than looping.
    if state
        .replay_session_budget
        .is_exhausted(&org_id, &session_id)
        .await
    {
        metrics::replay_session_chunk_dropped(&org_id);
        return Err(ApiError::payload_too_large(
            "session replay exceeded its maximum recorded size",
        ));
    }

    // The SDK gzips the rrweb event array (native CompressionStream).
    //
    // With a blob store configured we never need the decompressed text — the
    // gzip is stored verbatim — but we still decode it, for two reasons: this is
    // what rejects malformed gzip from a hostile client, and `byte_size` is a
    // published API field and the input to `ReplaySessionBudget`, whose ceiling
    // is denominated in *decompressed* bytes. So decode and discard, counting.
    // What that avoids is the part that actually cost: materializing a
    // multi-megabyte String, JSON-escaping it, and pushing it through the WAL.
    // Both branches stop at the same decoded ceiling as the OTLP routes.
    let max_decoded = state.config.max_decoded_body_bytes;
    let gunzip_rejection = |e: GunzipError| match e {
        GunzipError::Invalid(e) => replay_gunzip_rejection(headers, &body, &e),
        GunzipError::TooLarge => ApiError::payload_too_large("decompressed replay chunk too large"),
    };
    let (events_json, byte_size) = if state.replay_blob_store.is_some() {
        let byte_size = gunzip_len_bounded(&body, max_decoded).map_err(gunzip_rejection)?;
        (None, byte_size)
    } else {
        let events_json = gunzip_replay_text(&body, max_decoded).map_err(gunzip_rejection)?;
        let byte_size = events_json.len() as u64;
        (Some(events_json), byte_size)
    };

    // Accept the chunk that crosses the ceiling so the recording truncates on a
    // chunk boundary; `is_exhausted` rejects everything after it.
    let session_bytes = state
        .replay_session_budget
        .add(&org_id, &session_id, byte_size)
        .await;
    let limit = state.config.replay_max_session_bytes;
    if limit > 0 && session_bytes >= limit {
        warn!(
            org_id = %org_id,
            session_id = %session_id,
            session_bytes,
            limit,
            "session replay hit its byte ceiling; truncating recording"
        );
        Span::current().record("maple.replay.truncated", true);
        metrics::replay_session_truncated(&org_id);
    }

    // Store the payload before the row that indexes it. The ordering is the
    // invariant: a row must never point at an object that isn't there, and a
    // failed PUT returns non-2xx so the SDK drops the chunk (it already does not
    // retry) rather than leaving an unplayable gap in a listed session. The
    // reverse — an object with no row — is harmless and gets swept by the
    // bucket's lifecycle rule.
    let events_json = match (&state.replay_blob_store, events_json) {
        (Some(store), _) => {
            let key = replay_object_key(&org_id, &session_id, chunk_seq);
            Span::current().record("maple.replay.storage", "r2");
            Span::current().record("maple.replay.object_key", key.as_str());
            let started = Instant::now();
            // Verbatim gzip: ~10x smaller at rest than the JSON text, no
            // recompression, and the Content-Encoding lets a reader hand the
            // bytes to a browser to inflate.
            let outcome = store
                .put_object(&key, body.to_vec(), "application/json", Some("gzip"))
                .await
                .map_err(|e| {
                    // Everything Cloudflare support asks for, on the span rather
                    // than only in the message: the request id and ray are
                    // unrecoverable once the response is gone, and the error kind
                    // separates "R2 is overloaded" from "our request is wrong"
                    // without parsing an XML body out of a log line.
                    let span = Span::current();
                    span.record("maple.replay.blob_error_kind", e.error_kind());
                    span.record("maple.replay.blob_attempts", e.attempts);
                    if let Some(status) = e.status() {
                        span.record("maple.replay.blob_status", status);
                    }
                    if let Some(request_id) = e.request_id() {
                        span.record("maple.replay.blob_request_id", request_id);
                    }
                    if let Some(cf_ray) = e.cf_ray() {
                        span.record("maple.replay.blob_cf_ray", cf_ray);
                    }
                    warn!(
                        org_id = %org_id,
                        session_id = %session_id,
                        chunk_seq,
                        error_kind = e.error_kind(),
                        request_id = e.request_id().unwrap_or_default(),
                        cf_ray = e.cf_ray().unwrap_or_default(),
                        error = %e,
                        "replay chunk blob upload failed"
                    );
                    metrics::replay_blob_put_failed(&org_id);
                    // The store error is the only thing that says *why* the PUT
                    // failed. Without it the span carries a bare 503 and the
                    // failure is undiagnosable from the dashboard.
                    ApiError::service_unavailable("failed to store replay chunk")
                        .with_detail(e.to_string())
                })?;
            let span = Span::current();
            span.record(
                "maple.replay.blob_put_ms",
                i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX),
            );
            // Recorded on success too: an attempt count above 1 is a transient
            // R2 failure this absorbed, and the only warning that the bucket is
            // degrading before it starts losing chunks outright.
            span.record("maple.replay.blob_attempts", outcome.attempts);
            span.record("maple.replay.blob_status", 200u16);
            // The index row carries the chunk's metadata; the payload lives in
            // R2 under a key derived from (OrgId, SessionId, ChunkSeq). An empty
            // `events` is what marks the row as blob-backed on read — the SDK
            // never posts an empty chunk, so it cannot occur otherwise.
            String::new()
        }
        (None, Some(events_json)) => {
            Span::current().record("maple.replay.storage", "inline");
            events_json
        }
        // Unreachable: `events_json` is only `None` when a store is configured.
        (None, None) => {
            return Err(ApiError::service_unavailable(
                "replay chunk was neither stored nor decoded",
            ))
        }
    };

    // Row → session_replay_events. Tinybird parses the space-separated datetime
    // into DateTime64(9); `events` is stored verbatim as a String column.
    let timestamp = chrono::Utc::now()
        .format("%Y-%m-%d %H:%M:%S%.9f")
        .to_string();
    let row = serde_json::json!({
        "org_id": org_id,
        "session_id": session_id,
        "chunk_seq": chunk_seq,
        "timestamp": timestamp,
        "duration_ms": duration_ms,
        "event_count": event_count,
        "byte_size": byte_size,
        "events": events_json,
        "is_checkpoint": is_checkpoint,
    });
    let serialized = serde_json::to_vec(&row).map_err(|e| {
        ApiError::service_unavailable(format!("failed to serialize replay events: {e}"))
    })?;
    pipeline
        .accept_rows_to(
            &org_id,
            state
                .config
                .tinybird
                .datasource_session_replay_events
                .clone(),
            vec![serialized],
            TelemetrySignal::SessionReplays,
            destination,
        )
        .await
        .map_err(|e| {
            warn!(org_id = %org_id, error = %e, "session replay blob enqueue rejected");
            api_error_from_pipeline(&e)
        })?;
    state.resolver.note_source_use(&resolved_key, false);
    Ok(())
}

#[derive(Serialize)]
struct AcceptedBody {
    accepted: usize,
}

#[derive(Deserialize)]
struct LogpushQuery {
    secret: Option<String>,
}

async fn handle_cloudflare_logpush_http_requests(
    State(state): State<Arc<AppState>>,
    Path(connector_id): Path<String>,
    Query(query): Query<LogpushQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    handle_cloudflare_logpush(state, connector_id, query.secret, headers, body).await
}

async fn handle_signal(
    state: Arc<AppState>,
    headers: HeaderMap,
    body: Bytes,
    signal: Signal,
) -> Response {
    let start = Instant::now();
    let body_bytes = body.len();

    metrics::request_started();
    let _guard = InFlightGuard;

    let route = format!("/v1/{}", signal.path());
    let otel_name = format!("POST {route}");
    let span = tracing::info_span!(
        "ingest",
        otel.name = %otel_name,
        otel.kind = "server",
        otel.status_code = tracing::field::Empty,
        otel.status_description = tracing::field::Empty,
        "maple.ingest.reject_reason" = tracing::field::Empty,
        "http.request.method" = "POST",
        "http.route" = %route,
        "http.request.body.size" = body_bytes,
        "http.response.status_code" = tracing::field::Empty,
        "error.type" = tracing::field::Empty,
        "maple.signal" = signal.path(),
        "maple.org_id" = tracing::field::Empty,
        "maple.ingest.key_type" = tracing::field::Empty,
        "maple.source.id" = tracing::field::Empty,
        "maple.ingest.self_managed" = tracing::field::Empty,
        "maple.ingest.clickhouse_ready" = tracing::field::Empty,
        "maple.ingest.destination" = tracing::field::Empty,
        "maple.ingest.rules.count" = tracing::field::Empty,
        "maple.ingest.rules.dropped_items" = tracing::field::Empty,
        "maple.ingest.rules.redacted_values" = tracing::field::Empty,
        "maple.ingest.payload_format" = tracing::field::Empty,
        "maple.ingest.content_encoding" = tracing::field::Empty,
        "maple.ingest.decoded_bytes" = tracing::field::Empty,
        "maple.ingest.item_count" = tracing::field::Empty,
        "maple.sdk" = tracing::field::Empty,
        "user_agent.original" = tracing::field::Empty,
    );
    record_client_identity(&span, &headers);
    let span_handle = span.clone();

    let result = handle_signal_inner(&state, &headers, body, signal)
        .instrument(span)
        .await;
    let duration = start.elapsed();

    match result {
        Ok((response, item_count, org_id, decoded_bytes)) => {
            let status_code = response.status().as_u16();
            span_handle.record("http.response.status_code", status_code);
            span_handle.record("otel.status_code", "Ok");
            metrics::request_completed(signal.path(), "ok", "none", duration.as_secs_f64());
            // Usage and billing are emitted together, from one value, behind one
            // guard — they must never drift. `signal.path()` is both the Autumn
            // feature id and the metric's `signal` dimension. A paused key reports 0 bytes.
            if org_id != SENTINEL_ORG_ID && decoded_bytes > 0 {
                let feature_id = signal.path();
                if let Some(usage) = &state.usage_metrics {
                    usage.record(&org_id, feature_id, decoded_bytes as u64, item_count as u64);
                }
                if let Some(tracker) = &state.autumn_tracker {
                    tracker.track(&org_id, feature_id, billable_gb(decoded_bytes as u64));
                }
            }
            response
        }
        Err((error, error_kind)) => {
            let status = error.status.as_u16();
            span_handle.record("http.response.status_code", status);
            span_handle.record("error.type", error_kind);
            record_rejection_reason(&span_handle, status, error_kind, error.reason().as_str());
            metrics::request_completed(signal.path(), "error", error_kind, duration.as_secs_f64());
            error.into_response()
        }
    }
}

async fn handle_cloudflare_logpush(
    state: Arc<AppState>,
    connector_id: String,
    secret: Option<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let start = Instant::now();
    let body_bytes = body.len();

    metrics::request_started();
    let _guard = InFlightGuard;

    let route = format!("/v1/logpush/cloudflare/http_requests/{connector_id}");
    let otel_name = format!("POST {route}");
    let span = tracing::info_span!(
        "cloudflare_logpush",
        otel.name = %otel_name,
        otel.kind = "server",
        otel.status_code = tracing::field::Empty,
        otel.status_description = tracing::field::Empty,
        "maple.ingest.reject_reason" = tracing::field::Empty,
        "http.request.method" = "POST",
        "http.route" = "/v1/logpush/cloudflare/http_requests/{connector_id}",
        "http.request.body.size" = body_bytes,
        "http.response.status_code" = tracing::field::Empty,
        "error.type" = tracing::field::Empty,
        "maple.signal" = "logs",
        "maple.org_id" = tracing::field::Empty,
        "maple.cloudflare.connector_id" = %connector_id,
        "maple.cloudflare.dataset" = "http_requests",
        "maple.cloudflare.is_validation" = tracing::field::Empty,
        "maple.ingest.self_managed" = tracing::field::Empty,
        "maple.ingest.clickhouse_ready" = tracing::field::Empty,
        "maple.ingest.destination" = tracing::field::Empty,
        "maple.ingest.rules.count" = tracing::field::Empty,
        "maple.ingest.rules.dropped_items" = tracing::field::Empty,
        "maple.ingest.rules.redacted_values" = tracing::field::Empty,
        "maple.ingest.item_count" = tracing::field::Empty,
    );
    let span_handle = span.clone();

    let result =
        handle_cloudflare_logpush_inner(&state, &connector_id, secret.as_deref(), &headers, body)
            .instrument(span)
            .await;
    let duration = start.elapsed();

    match result {
        Ok((response, item_count, org_id, outcome)) => {
            let status_code = response.status().as_u16();
            let is_validation = outcome == LogpushOutcome::Validation;
            span_handle.record("http.response.status_code", status_code);
            span_handle.record("otel.status_code", "Ok");
            span_handle.record("maple.ingest.item_count", item_count);
            span_handle.record("maple.cloudflare.is_validation", is_validation);
            if outcome == LogpushOutcome::SourcePaused {
                span_handle.record("maple.ingest.reject_reason", "source_paused");
            }
            metrics::request_completed("logs", "ok", "none", duration.as_secs_f64());
            if outcome != LogpushOutcome::SourcePaused {
                metrics::cloudflare_batch("http_requests", is_validation);
            }
            debug!(
                status = status_code,
                duration_ms = duration_millis(duration),
                item_count,
                org_id = %org_id,
                "Cloudflare Logpush request processed"
            );
            response
        }
        Err((error, error_kind)) => {
            let status = error.status.as_u16();
            span_handle.record("http.response.status_code", status);
            span_handle.record("error.type", error_kind);
            record_rejection_reason(&span_handle, status, error_kind, error.reason().as_str());
            metrics::request_completed("logs", "error", error_kind, duration.as_secs_f64());
            if error_kind == "auth" {
                metrics::cloudflare_auth_failure("http_requests");
            }
            if error_kind == "parse" {
                metrics::cloudflare_parse_failure("http_requests");
            }
            error.into_response()
        }
    }
}

/// Returns Ok((response, item_count, org_id, decoded_bytes)) or
/// Err((ApiError, error_kind_label)).
#[expect(
    clippy::cognitive_complexity,
    clippy::too_many_lines,
    reason = "one linear request pass with an early return at each rejection; helpers would thread \
              a dozen locals back and forth"
)]
async fn handle_signal_inner(
    state: &AppState,
    headers: &HeaderMap,
    body: Bytes,
    signal: Signal,
) -> Result<(Response, usize, String, usize), (ApiError, &'static str)> {
    let ingest_key = extract_ingest_key(headers).ok_or_else(|| {
        warn!("Missing ingest key");
        (ApiError::unauthorized("Missing ingest key"), "auth")
    })?;

    if is_sentinel_token(&ingest_key) {
        metrics::sentinel(signal.path());
        Span::current().record("maple.org_id", SENTINEL_ORG_ID);
        Span::current().record("maple.ingest.key_type", "sentinel");
        Span::current().record("maple.ingest.self_managed", false);
        Span::current().record("maple.ingest.clickhouse_ready", false);
        debug!("Sentinel token; skipping resolve and forward");
        return Ok((
            StatusCode::OK.into_response(),
            0,
            SENTINEL_ORG_ID.to_owned(),
            0,
        ));
    }

    let key_resolve_start = Instant::now();
    // Own span so a cache miss that falls through to PSBouncer is attributable
    // per-request, not just visible in the key_resolution_duration histogram.
    // `postgres.query` (see `postgres_client_span`) nests under this on a miss.
    let auth_span = auth_internal_span();
    let auth_span_handle = auth_span.clone();
    let resolved_key = state
        .resolver
        .resolve_ingest_key(&ingest_key)
        .instrument(auth_span)
        .await
        .map_err(|error| {
            error!(error = %error, "Ingest key resolution failed");
            // The resolver being down is our fault (503), unlike a bad key.
            record_stage_error(&auth_span_handle, "auth_unavailable", &error, true);
            (
                ApiError::service_unavailable("Ingest authentication unavailable"),
                "auth",
            )
        })?
        .ok_or_else(|| {
            warn!("Unknown ingest key");
            record_stage_error(&auth_span_handle, "auth", "Unknown ingest key", false);
            (
                ApiError::unauthorized(state.config.invalid_key_message),
                "auth",
            )
        })?;
    metrics::key_resolution_duration(key_resolve_start.elapsed().as_secs_f64());
    auth_span_handle.record("maple.ingest.key_type", resolved_key.key_type.as_str());
    // Truncated HMAC, not the key itself — enough to find the row in Postgres.
    auth_span_handle.record("maple.ingest.key_id", resolved_key.key_id.as_str());
    auth_span_handle.record("maple.org_id", resolved_key.org_id.as_str());
    auth_span_handle.record("maple.ingest.self_managed", resolved_key.self_managed);
    auth_span_handle.record(
        "maple.ingest.clickhouse_ready",
        resolved_key.clickhouse_ready,
    );

    Span::current().record("maple.org_id", resolved_key.org_id.as_str());
    Span::current().record("maple.ingest.key_type", resolved_key.key_type.as_str());
    Span::current().record("maple.ingest.self_managed", resolved_key.self_managed);
    Span::current().record(
        "maple.ingest.clickhouse_ready",
        resolved_key.clickhouse_ready,
    );
    if let Some(source_id) = resolved_key.source_public_id() {
        auth_span_handle.record("maple.source.id", source_id);
        Span::current().record("maple.source.id", source_id);
    }
    debug!(
        resolve_ms = duration_millis(key_resolve_start.elapsed()),
        "Authenticated"
    );

    let admission = authorize_source(state, &resolved_key, &[signal.source_signal()])
        .await
        .map_err(|error| {
            let error_kind = error.error_kind();
            (error, error_kind)
        })?;
    if admission == KeyAdmission::Drop {
        return Ok((
            StatusCode::OK.into_response(),
            0,
            resolved_key.org_id.clone(),
            0,
        ));
    }

    let _org_inflight_permit = state
        .org_inflight_limiter
        .try_acquire(&resolved_key.org_id)
        .ok_or_else(|| {
            warn!(
                org_id = %resolved_key.org_id,
                "Per-org in-flight ingest limit exceeded"
            );
            (
                ApiError::too_many_requests("Per-org ingest limit exceeded"),
                "throttle",
            )
        })?;

    if body.len() > state.config.max_request_body_bytes {
        warn!(
            body_bytes = body.len(),
            max_bytes = state.config.max_request_body_bytes,
            "Payload too large"
        );
        return Err((
            ApiError::payload_too_large("Request body too large"),
            "payload_too_large",
        ));
    }

    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/x-protobuf")
        .to_ascii_lowercase();

    let payload_format = detect_payload_format(&content_type).map_err(|e| {
        warn!(content_type = %content_type, "Unsupported content type");
        (e, "unsupported_media")
    })?;
    Span::current().record("maple.ingest.payload_format", payload_format.label());

    let content_encoding = headers
        .get(CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty() && value != "identity");
    Span::current().record(
        "maple.ingest.content_encoding",
        content_encoding.as_deref().unwrap_or("identity"),
    );

    metrics::request_body_bytes(signal.path(), body.len() as u64);

    // Before the body is decoded, so a denied org's request is not gunzipped
    // and parsed only to be refused.
    if resolved_key.org_id != SENTINEL_ORG_ID {
        if let Some(error) = entitlement_rejection(state, &resolved_key.org_id, signal.path()).await
        {
            return Err((error, "billing_limit"));
        }
    }

    let encoding_label = content_encoding.as_deref().unwrap_or("identity");
    // Synchronous, so the span is entered rather than instrumented. Scoped so the
    // span closes on the decompress itself and not on the rest of the handler.
    let decoded_payload = {
        let decode_span = decode_internal_span(encoding_label, body.len());
        let _guard = decode_span.enter();
        let decoded_payload = decode_payload(
            &body,
            content_encoding.as_deref(),
            state.config.max_decoded_body_bytes,
        )
        .map_err(|e| {
            // Over the decoded ceiling is the same refusal as an oversized body.
            if e.status == StatusCode::PAYLOAD_TOO_LARGE {
                warn!(body_bytes = body.len(), "Decoded payload too large");
                record_stage_error(&decode_span, "payload_too_large", &e.message, false);
                return (e, "payload_too_large");
            }
            warn!(body_bytes = body.len(), "Failed to decode payload");
            record_stage_error(&decode_span, "decode", &e.message, false);
            metrics::org_data_loss(&resolved_key.org_id, signal.path(), "decode");
            (e, "decode")
        })?;
        decode_span.record("maple.ingest.decoded_bytes", decoded_payload.len());
        decoded_payload
    };

    Span::current().record("maple.ingest.decoded_bytes", decoded_payload.len());
    debug!(
        decoded_bytes = decoded_payload.len(),
        encoding = encoding_label,
        "Payload decoded"
    );
    metrics::decoded_body_bytes(signal.path(), decoded_payload.len() as u64);

    let mut decoded = {
        let parse_span = parse_internal_span(payload_format.label(), signal.path());
        let _guard = parse_span.enter();
        let decoded =
            decode_otlp_payload(signal, payload_format, &decoded_payload).map_err(|e| {
                warn!(
                    format = payload_format.label(),
                    signal = signal.path(),
                    org_id = resolved_key.org_id.as_str(),
                    key_type = resolved_key.key_type.as_str(),
                    decoded_bytes = decoded_payload.len(),
                    reason = %e.message,
                    "Invalid OTLP payload"
                );
                // The reason previously only reached the log; on the span it
                // is what tells you *why* a customer's SDK is being rejected.
                record_stage_error(&parse_span, "enrich", &e.message, false);
                metrics::org_data_loss(&resolved_key.org_id, signal.path(), "enrich");
                (e, "enrich")
            })?;
        parse_span.record("maple.ingest.item_count", decoded.item_count());
        decoded
    };
    let mut claims = verify_claims_and_enrich(state, &mut decoded, &resolved_key).await;
    if claims.all_paused {
        // Like a paused token source: success to the sender, nothing written or billed.
        return Ok((
            StatusCode::OK.into_response(),
            0,
            resolved_key.org_id.clone(),
            0,
        ));
    }
    let kept_claim = claims.kept_claim;
    let item_count = decoded.item_count();

    Span::current().record("maple.ingest.item_count", item_count);
    debug!(item_count, "Payload enriched");
    metrics::items_accepted(signal.path(), item_count as u64);

    let response_result = process_decoded_payload(
        state,
        signal,
        payload_format,
        content_encoding.as_deref(),
        &mut decoded,
        &resolved_key,
        &mut claims.retained,
    )
    .await;
    // Only the share left after paused-source drops and ingest rules is metered.
    let decoded_bytes = claims.metered_bytes(decoded_payload.len());
    let item_count = claims.retained.metered_items(item_count);

    let response = response_result.map_err(|error| (error, "forward"))?;
    if response.status().is_success() {
        state.resolver.note_source_use(&resolved_key, kept_claim);
        state
            .resolver
            .note_claimed_source_use(&claims.claimed_sources);
    }

    Ok((
        response,
        item_count,
        resolved_key.org_id.clone(),
        decoded_bytes,
    ))
}

#[expect(
    clippy::cognitive_complexity,
    clippy::too_many_lines,
    reason = "one linear request pass with an early return at each rejection; helpers would thread \
              a dozen locals back and forth"
)]
async fn handle_cloudflare_logpush_inner(
    state: &AppState,
    connector_id: &str,
    secret: Option<&str>,
    headers: &HeaderMap,
    body: Bytes,
) -> Result<(Response, usize, String, LogpushOutcome), (ApiError, &'static str)> {
    let secret = secret
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            warn!("Missing Cloudflare connector secret");
            (
                ApiError::unauthorized("Invalid connector credentials"),
                "auth",
            )
        })?;

    let resolved = state
        .cloudflare_resolver
        .resolve_connector(connector_id, secret)
        .await
        .map_err(|error| {
            error!(error = %error, connector_id, "Cloudflare connector resolution failed");
            (
                ApiError::service_unavailable("Connector authentication unavailable"),
                "auth",
            )
        })?
        .ok_or_else(|| {
            warn!(connector_id, "Invalid Cloudflare connector credentials");
            (
                ApiError::unauthorized("Invalid connector credentials"),
                "auth",
            )
        })?;

    Span::current().record("maple.org_id", resolved.org_id.as_str());
    Span::current().record("maple.ingest.self_managed", resolved.self_managed);
    Span::current().record("maple.ingest.clickhouse_ready", resolved.clickhouse_ready);

    debug!(
        connector_id = %resolved.connector_id,
        org_id = %resolved.org_id,
        key_id = %resolved.secret_key_id,
        "Authenticated Cloudflare Logpush connector"
    );
    // A paused source: acked like a paused GCP connector, nothing stored or billed.
    if resolved.source_pause.is_paused(current_time_millis()) {
        metrics::source_paused_drop(&resolved.org_id, Signal::Logs.path());
        debug!(
            org_id = %resolved.org_id,
            connector_id = %resolved.connector_id,
            "Cloudflare Logpush source paused; batch acked and dropped"
        );
        return Ok((
            StatusCode::OK.into_response(),
            0,
            resolved.org_id.clone(),
            LogpushOutcome::SourcePaused,
        ));
    }
    let _org_inflight_permit = state
        .org_inflight_limiter
        .try_acquire(&resolved.org_id)
        .ok_or_else(|| {
            warn!(
                org_id = %resolved.org_id,
                connector_id = %resolved.connector_id,
                "Per-org in-flight ingest limit exceeded"
            );
            (
                ApiError::too_many_requests("Per-org ingest limit exceeded"),
                "throttle",
            )
        })?;

    if body.len() > state.config.max_request_body_bytes {
        warn!(
            body_bytes = body.len(),
            max_bytes = state.config.max_request_body_bytes,
            connector_id = %resolved.connector_id,
            "Cloudflare Logpush payload too large"
        );
        state
            .cloudflare_resolver
            .record_failure(&resolved.connector_id, "Request body too large")
            .await;
        return Err((
            ApiError::payload_too_large("Request body too large"),
            "payload_too_large",
        ));
    }

    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/x-ndjson")
        .to_ascii_lowercase();

    if !is_supported_cloudflare_content_type(&content_type) {
        state
            .cloudflare_resolver
            .record_failure(&resolved.connector_id, "Unsupported content type")
            .await;
        return Err((
            ApiError::unsupported_media_type(
                "Unsupported content type for Cloudflare Logpush payload",
            ),
            "unsupported_media",
        ));
    }

    let content_encoding = headers
        .get(CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty() && value != "identity");

    // Before the body is decoded, as in `handle_signal_inner`. Cloudflare's
    // destination-validation ping is gated with everything else: it can only be
    // told apart from a log batch by decoding it.
    if resolved.org_id != SENTINEL_ORG_ID {
        if let Some(error) =
            entitlement_rejection(state, &resolved.org_id, Signal::Logs.path()).await
        {
            return Err((error, "billing_limit"));
        }
    }

    let decoded_payload = match decode_payload(
        &body,
        content_encoding.as_deref(),
        state.config.max_decoded_body_bytes,
    ) {
        Ok(decoded) => decoded,
        Err(error) => {
            state
                .cloudflare_resolver
                .record_failure(&resolved.connector_id, &error.message)
                .await;
            let reason = if error.status == StatusCode::PAYLOAD_TOO_LARGE {
                "payload_too_large"
            } else {
                "decode"
            };
            return Err((error, reason));
        }
    };

    let parsed = match parse_cloudflare_payload(&decoded_payload) {
        Ok(parsed) => parsed,
        Err(error) => {
            state
                .cloudflare_resolver
                .record_failure(&resolved.connector_id, &error.message)
                .await;
            return Err((error, "parse"));
        }
    };

    match parsed {
        ParsedCloudflarePayload::Validation => {
            info!(connector_id = %resolved.connector_id, "Cloudflare validation ping accepted");
            Ok((
                StatusCode::OK.into_response(),
                0,
                resolved.org_id.clone(),
                LogpushOutcome::Validation,
            ))
        }
        ParsedCloudflarePayload::Records(records) => {
            let request = build_cloudflare_logs_request(&resolved, records);
            let item_count = count_log_items(&request);
            metrics::cloudflare_records(&resolved.dataset, item_count as u64);

            let resolved_key = ResolvedIngestKey {
                org_id: resolved.org_id.clone(),
                key_type: IngestKeyType::Connector,
                key_id: resolved.secret_key_id.clone(),
                self_managed: resolved.self_managed,
                clickhouse_ready: resolved.clickhouse_ready,
                source: None,
                default_source: resolved.source.clone(),
            };
            let mut decoded = DecodedPayload::Logs(request);
            let mut retained = Retained::default();
            let response = match process_decoded_payload(
                state,
                Signal::Logs,
                PayloadFormat::Protobuf,
                None,
                &mut decoded,
                &resolved_key,
                &mut retained,
            )
            .await
            {
                Ok(response) => response,
                Err(error) => {
                    state
                        .cloudflare_resolver
                        .record_failure(&resolved.connector_id, &error.message)
                        .await;
                    return Err((error, "forward"));
                }
            };

            state
                .cloudflare_resolver
                .record_success(&resolved.connector_id)
                .await;
            state.resolver.note_source_use(&resolved_key, false);

            // Only the share the ingest rules left is metered.
            let metered_bytes = retained.metered_bytes(decoded_payload.len());
            if resolved.org_id != SENTINEL_ORG_ID && metered_bytes > 0 {
                if let Some(usage) = &state.usage_metrics {
                    usage.record(
                        &resolved.org_id,
                        Signal::Logs.path(),
                        metered_bytes as u64,
                        retained.metered_items(item_count) as u64,
                    );
                }
                if let Some(tracker) = &state.autumn_tracker {
                    tracker.track(
                        &resolved.org_id,
                        Signal::Logs.path(),
                        billable_gb(metered_bytes as u64),
                    );
                }
            }

            Ok((
                response,
                item_count,
                resolved.org_id.clone(),
                LogpushOutcome::Accepted,
            ))
        }
    }
}

/// Receives a Cloud Logging sink's Pub/Sub push subscription: one `LogEntry`
/// per request, unwrapped. Pub/Sub acks on 102/200/201/202/204 and redelivers
/// on anything else until the message's retention expires.
async fn handle_gcp_logpush(
    State(state): State<Arc<AppState>>,
    Path(connector_id): Path<String>,
    Query(query): Query<LogpushQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let start = Instant::now();

    metrics::request_started();
    let _guard = InFlightGuard;

    let span = tracing::info_span!(
        "gcp_logpush",
        otel.name = "POST /v1/logpush/gcp/{connector_id}",
        otel.kind = "server",
        otel.status_code = tracing::field::Empty,
        otel.status_description = tracing::field::Empty,
        "maple.ingest.reject_reason" = tracing::field::Empty,
        "http.request.method" = "POST",
        "http.route" = "/v1/logpush/gcp/{connector_id}",
        "http.request.body.size" = body.len(),
        "http.response.status_code" = tracing::field::Empty,
        "error.type" = tracing::field::Empty,
        "maple.signal" = "logs",
        "maple.org_id" = tracing::field::Empty,
        "maple.gcp.connector_id" = tracing::field::Empty,
        "maple.gcp.setup_report" = tracing::field::Empty,
        "maple.gcp.push_auth" = tracing::field::Empty,
        "maple.ingest.self_managed" = tracing::field::Empty,
        "maple.ingest.clickhouse_ready" = tracing::field::Empty,
        "maple.ingest.destination" = tracing::field::Empty,
        "maple.ingest.rules.count" = tracing::field::Empty,
        "maple.ingest.rules.dropped_items" = tracing::field::Empty,
        "maple.ingest.rules.redacted_values" = tracing::field::Empty,
        "maple.ingest.item_count" = tracing::field::Empty,
    );
    let span_handle = span.clone();

    // Set up by the current script or Terraform: a token Pub/Sub signed.
    // Earlier subscriptions carry the secret in the URL.
    let token = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let credential = match (token, query.secret.as_deref()) {
        (Some(token), _) => Some(GcpPushCredential::Token(token)),
        (None, Some(secret)) => Some(GcpPushCredential::Secret(secret)),
        (None, None) => None,
    };
    let result = handle_gcp_logpush_inner(&state, &connector_id, credential, body)
        .instrument(span)
        .await;
    let duration = start.elapsed().as_secs_f64();

    match result {
        Ok((response, outcome)) => {
            span_handle.record("http.response.status_code", response.status().as_u16());
            match outcome {
                GcpPushOutcome::Accepted => {
                    span_handle.record("otel.status_code", "Ok");
                    span_handle.record("maple.ingest.item_count", 1);
                    metrics::request_completed("logs", "ok", "none", duration);
                    metrics::gcp_entry();
                }
                GcpPushOutcome::NotALogEntry => {
                    // Acked, but the entry is gone: an `Error` like every other
                    // rejection that loses the sender's data.
                    span_handle.record("error.type", "decode");
                    record_rejection_reason(
                        &span_handle,
                        200,
                        "decode",
                        "Push payload is not a LogEntry",
                    );
                    metrics::request_completed("logs", "error", "decode", duration);
                    metrics::gcp_parse_failure();
                }
                GcpPushOutcome::LogsDisabled => {
                    // The org asked for this, so it is neither an error nor
                    // data loss: `Ok`, told apart by the reject reason.
                    record_rejection_reason(
                        &span_handle,
                        200,
                        "logs_disabled",
                        "Log forwarding is turned off for this connector",
                    );
                    metrics::request_completed("logs", "ok", "none", duration);
                    metrics::gcp_disabled_drop();
                }
                GcpPushOutcome::SetupReport => {
                    span_handle.record("otel.status_code", "Ok");
                    span_handle.record("maple.gcp.setup_report", true);
                    metrics::request_completed("logs", "ok", "none", duration);
                }
                GcpPushOutcome::SourcePaused => {
                    span_handle.record("otel.status_code", "Ok");
                    span_handle.record("maple.ingest.reject_reason", "source_paused");
                    metrics::request_completed("logs", "ok", "none", duration);
                }
            }
            response
        }
        Err((error, error_kind)) => {
            let status = error.status.as_u16();
            span_handle.record("http.response.status_code", status);
            span_handle.record("error.type", error_kind);
            record_rejection_reason(&span_handle, status, error_kind, error.reason().as_str());
            metrics::request_completed("logs", "error", error_kind, duration);
            if error_kind == "auth" {
                metrics::gcp_auth_failure();
            }
            error.into_response()
        }
    }
}

enum GcpPushCredential<'a> {
    Token(&'a str),
    Secret(&'a str),
}

/// Returns Ok((ack response, what the ack means)) or
/// Err((ApiError, error_kind_label)).
async fn handle_gcp_logpush_inner(
    state: &AppState,
    connector_id: &str,
    credential: Option<GcpPushCredential<'_>>,
    body: Bytes,
) -> Result<(Response, GcpPushOutcome), (ApiError, &'static str)> {
    let unauthorized = || {
        (
            ApiError::unauthorized("Invalid connector credentials"),
            "auth",
        )
    };
    let credential = credential.filter(|credential| match credential {
        GcpPushCredential::Token(value) | GcpPushCredential::Secret(value) => {
            !value.trim().is_empty()
        }
    });
    let (Some(credential), true) = (credential, is_connector_id(connector_id)) else {
        warn!("Missing GCP connector credentials or malformed connector id");
        return Err(unauthorized());
    };
    Span::current().record("maple.gcp.connector_id", connector_id);

    let lookup = match credential {
        GcpPushCredential::Token(token) => {
            Span::current().record("maple.gcp.push_auth", "oidc");
            state
                .gcp_resolver
                .resolve_connector_by_token(connector_id, token.trim())
                .await
        }
        GcpPushCredential::Secret(secret) => {
            Span::current().record("maple.gcp.push_auth", "secret");
            state
                .gcp_resolver
                .resolve_connector(connector_id, secret.trim())
                .await
        }
    };
    let resolved = lookup
        .map_err(|error| {
            error!(error = %error, connector_id, "GCP connector resolution failed");
            (
                ApiError::service_unavailable("Connector authentication unavailable"),
                "auth",
            )
        })?
        .ok_or_else(|| {
            warn!(connector_id, "Invalid GCP connector credentials");
            unauthorized()
        })?;
    let org_id = resolved.key.org_id.as_str();

    Span::current().record("maple.org_id", org_id);
    if resolved.confirms_log_forwarding {
        state
            .gcp_resolver
            .confirm_log_forwarding(connector_id)
            .await;
    }
    Span::current().record("maple.ingest.self_managed", resolved.key.self_managed);
    Span::current().record(
        "maple.ingest.clickhouse_ready",
        resolved.key.clickhouse_ready,
    );

    let _gcp_inflight_permit = state
        .gcp_inflight_limiter
        .try_acquire(org_id)
        .ok_or_else(|| {
            // Not `warn!`: a busy sink meets this cap by design, once per
            // refused log line. `org_throttled` counts it.
            debug!(
                org_id,
                connector_id, "Per-org in-flight GCP push limit exceeded"
            );
            (
                ApiError::too_many_requests("Per-org ingest limit exceeded"),
                "throttle",
            )
        })?;

    // A setup script run reporting what it applied. Ahead of everything a log
    // goes through: it is told to a connector whose log forwarding is off as
    // well, and it is neither stored nor metered. A report that cannot be
    // written is refused, so Pub/Sub delivers it again.
    if let Some(report) = gcp_logging::parse_setup_report(&body) {
        if !state
            .gcp_resolver
            .take_setup_report_slot(connector_id)
            .await
        {
            warn!(org_id, connector_id, "GCP setup report rate limit exceeded");
            return Err((
                ApiError::too_many_requests("Too many setup reports"),
                "throttle",
            ));
        }
        state
            .gcp_resolver
            .store
            .record_gcp_setup_report(connector_id, report, current_time_millis())
            .await
            .map_err(|error| {
                error!(error = %error, connector_id, "Failed to record GCP setup report");
                (
                    ApiError::service_unavailable("Setup report could not be recorded"),
                    "setup_report",
                )
            })?;
        return Ok((StatusCode::OK.into_response(), GcpPushOutcome::SetupReport));
    }

    // Acked, not rejected: the sink keeps pushing until the customer removes
    // it, and Pub/Sub would redeliver every refused entry for its retention.
    // Ahead of the entitlement check and metering, so nothing is billed.
    if !resolved.logs_enabled {
        debug!(
            org_id,
            connector_id, "GCP log forwarding is off; entry acked and dropped"
        );
        return Ok((StatusCode::OK.into_response(), GcpPushOutcome::LogsDisabled));
    }
    // A paused integration source: acked like a paused token source, nothing stored or billed.
    if resolved.source_pause.is_paused(current_time_millis()) {
        metrics::source_paused_drop(org_id, Signal::Logs.path());
        debug!(
            org_id,
            connector_id, "GCP integration source paused; entry acked and dropped"
        );
        return Ok((StatusCode::OK.into_response(), GcpPushOutcome::SourcePaused));
    }

    let _org_inflight_permit = state
        .org_inflight_limiter
        .try_acquire(org_id)
        .ok_or_else(|| {
            warn!(
                org_id,
                connector_id, "Per-org in-flight ingest limit exceeded"
            );
            (
                ApiError::too_many_requests("Per-org ingest limit exceeded"),
                "throttle",
            )
        })?;

    let Some(entry) = gcp_logging::parse_log_entry(&body) else {
        // Not `warn!`: a wrapped subscription fails this way on every log line.
        debug!(
            org_id,
            connector_id,
            body_bytes = body.len(),
            "GCP push payload is not a LogEntry; acked and dropped"
        );
        metrics::org_data_loss(org_id, Signal::Logs.path(), "decode");
        state
            .gcp_resolver
            .record_health(connector_id, Some(gcp_logging::NOT_A_LOG_ENTRY))
            .await;
        return Ok((StatusCode::OK.into_response(), GcpPushOutcome::NotALogEntry));
    };

    if let Some(error) = entitlement_rejection(state, org_id, Signal::Logs.path()).await {
        state
            .gcp_resolver
            .record_health(connector_id, Some(gcp_logging::OVER_PLAN_LIMIT))
            .await;
        return Err((error, "billing_limit"));
    }
    let request = gcp_logging::build_logs_request(
        &entry,
        &gcp_logging::Connector {
            id: connector_id,
            org_id,
            source_id: resolved.key.source_public_id(),
        },
        current_time_unix_nano(),
    );
    let mut retained = Retained::default();
    let response = match process_decoded_payload(
        state,
        Signal::Logs,
        PayloadFormat::Protobuf,
        None,
        &mut DecodedPayload::Logs(request),
        &resolved.key,
        &mut retained,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            state
                .gcp_resolver
                .record_health(connector_id, Some(gcp_logging::ENTRY_NOT_STORED))
                .await;
            return Err((error, "forward"));
        }
    };
    state.gcp_resolver.record_health(connector_id, None).await;
    state.resolver.note_source_use(&resolved.key, false);

    // Metered on the push body, scaled to what the ingest rules left; nothing when they dropped it.
    let metered_bytes = retained.metered_bytes(body.len());
    if metered_bytes > 0 {
        if let Some(usage) = &state.usage_metrics {
            usage.record(
                org_id,
                Signal::Logs.path(),
                metered_bytes as u64,
                retained.metered_items(1) as u64,
            );
        }
        if let Some(tracker) = &state.autumn_tracker {
            tracker.track(org_id, Signal::Logs.path(), billable_gb(metered_bytes as u64));
        }
    }

    Ok((response, GcpPushOutcome::Accepted))
}

/// Connector ids are generated by the API; anything outside this alphabet is
/// refused before it reaches this handler's span, its logs, or Postgres.
/// The push service account a connector's setup creates in its host project,
/// named as `gcpConnectorResourceNames` in `@maple/domain/gcp` names it.
fn gcp_push_service_account(connector_id: &str, project_id: &str) -> String {
    let hex: String = connector_id
        .chars()
        .filter(|c| *c != '-')
        .take(19)
        .collect();
    format!("maple-push-{hex}@{project_id}.iam.gserviceaccount.com")
}

fn is_connector_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// The plaintext stream secret Firehose sends with every delivery.
const FIREHOSE_ACCESS_KEY_HEADER: &str = "x-amz-firehose-access-key";
const FIREHOSE_REQUEST_ID_HEADER: &str = "x-amz-firehose-request-id";

/// What Firehose's HTTP endpoint destination expects back.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FirehoseResponseBody<'a> {
    request_id: &'a str,
    timestamp: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_message: Option<&'a str>,
}

fn firehose_response(status: StatusCode, request_id: &str, error: Option<&ApiError>) -> Response {
    let body = FirehoseResponseBody {
        request_id,
        timestamp: current_time_millis(),
        error_message: error.map(|error| error.message.as_str()),
    };
    let mut response = (status, axum::Json(body)).into_response();
    let retry_after = error.and_then(|error| error.kind.retry_after_seconds);
    if let Some(value) =
        retry_after.and_then(|seconds| HeaderValue::from_str(&seconds.to_string()).ok())
    {
        response.headers_mut().insert(RETRY_AFTER, value);
    }
    response
}

/// Receives a CloudWatch metric stream through Amazon Data Firehose's HTTP
/// endpoint destination. Firehose retries anything but a 200 until its retry
/// window ends, so a delivery that can never decode is acked.
async fn handle_aws_firehose(
    State(state): State<Arc<AppState>>,
    Path(connection_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let start = Instant::now();

    metrics::request_started();
    let _guard = InFlightGuard;

    let span = tracing::info_span!(
        "aws_firehose",
        otel.name = "POST /v1/firehose/aws/{connection_id}",
        otel.kind = "server",
        otel.status_code = tracing::field::Empty,
        otel.status_description = tracing::field::Empty,
        "maple.ingest.reject_reason" = tracing::field::Empty,
        "http.request.method" = "POST",
        "http.route" = "/v1/firehose/aws/{connection_id}",
        "http.request.body.size" = body.len(),
        "http.response.status_code" = tracing::field::Empty,
        "error.type" = tracing::field::Empty,
        "maple.signal" = "metrics",
        "maple.org_id" = tracing::field::Empty,
        "maple.aws.connection_id" = tracing::field::Empty,
        "maple.ingest.self_managed" = tracing::field::Empty,
        "maple.ingest.clickhouse_ready" = tracing::field::Empty,
        "maple.ingest.destination" = tracing::field::Empty,
        "maple.ingest.rules.count" = tracing::field::Empty,
        "maple.ingest.rules.dropped_items" = tracing::field::Empty,
        "maple.ingest.rules.redacted_values" = tracing::field::Empty,
        "maple.ingest.decoded_bytes" = tracing::field::Empty,
        "maple.ingest.item_count" = tracing::field::Empty,
    );
    let span_handle = span.clone();

    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    // The body's `requestId` replaces this once the body is read.
    let mut request_id = header(FIREHOSE_REQUEST_ID_HEADER)
        .unwrap_or_default()
        .to_owned();
    let content_encoding = header(CONTENT_ENCODING.as_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty() && value != "identity");
    let result = handle_aws_firehose_inner(
        &state,
        &connection_id,
        header(FIREHOSE_ACCESS_KEY_HEADER),
        content_encoding.as_deref(),
        &body,
        &mut request_id,
    )
    .instrument(span)
    .await;
    let duration = start.elapsed().as_secs_f64();
    let signal = Signal::Metrics.path();

    match result {
        Ok(outcome) => {
            span_handle.record("http.response.status_code", StatusCode::OK.as_u16());
            match outcome {
                AwsStreamOutcome::Accepted { item_count } => {
                    span_handle.record("otel.status_code", "Ok");
                    span_handle.record("maple.ingest.item_count", item_count);
                    metrics::request_completed(signal, "ok", "none", duration);
                }
                AwsStreamOutcome::Undecodable => {
                    // Acked, but the metrics are gone: an `Error` like every
                    // other rejection that loses the sender's data.
                    span_handle.record("error.type", "decode");
                    record_rejection_reason(
                        &span_handle,
                        200,
                        "decode",
                        "Firehose delivery is not OpenTelemetry 1.0 metric stream records",
                    );
                    metrics::request_completed(signal, "error", "decode", duration);
                }
                AwsStreamOutcome::SourcePaused => {
                    span_handle.record("otel.status_code", "Ok");
                    span_handle.record("maple.ingest.reject_reason", "source_paused");
                    metrics::request_completed(signal, "ok", "none", duration);
                }
            }
            firehose_response(StatusCode::OK, &request_id, None)
        }
        Err((error, error_kind)) => {
            let status = error.status.as_u16();
            span_handle.record("http.response.status_code", status);
            span_handle.record("error.type", error_kind);
            record_rejection_reason(&span_handle, status, error_kind, error.reason().as_str());
            metrics::request_completed(signal, "error", error_kind, duration);
            firehose_response(error.status, &request_id, Some(&error))
        }
    }
}

/// Returns what the ack means, or Err((ApiError, error_kind_label)).
/// `request_id` takes the body's `requestId` once the body is read.
async fn handle_aws_firehose_inner(
    state: &AppState,
    connection_id: &str,
    access_key: Option<&str>,
    content_encoding: Option<&str>,
    body: &Bytes,
    request_id: &mut String,
) -> Result<AwsStreamOutcome, (ApiError, &'static str)> {
    let unauthorized = || {
        (
            ApiError::unauthorized("Invalid connection credentials"),
            "auth",
        )
    };
    let access_key = access_key.map(str::trim).filter(|key| !key.is_empty());
    let (Some(access_key), true) = (access_key, is_aws_connection_id(connection_id)) else {
        warn!("Missing Firehose access key or malformed AWS connection id");
        return Err(unauthorized());
    };
    Span::current().record("maple.aws.connection_id", connection_id);

    let resolved = state
        .aws_resolver
        .resolve_connection(connection_id, access_key)
        .await
        .map_err(|error| {
            error!(error = %error, connection_id, "AWS connection resolution failed");
            (
                ApiError::service_unavailable("Connection authentication unavailable"),
                "auth",
            )
        })?
        .ok_or_else(|| {
            warn!(connection_id, "Invalid AWS metric stream credentials");
            unauthorized()
        })?;
    let org_id = resolved.key.org_id.as_str();
    let signal = Signal::Metrics.path();

    Span::current().record("maple.org_id", org_id);
    Span::current().record("maple.ingest.self_managed", resolved.key.self_managed);
    Span::current().record(
        "maple.ingest.clickhouse_ready",
        resolved.key.clickhouse_ready,
    );

    // A paused integration source: acked like a paused token source, nothing stored or billed.
    if resolved.source_pause.is_paused(current_time_millis()) {
        metrics::source_paused_drop(org_id, signal);
        debug!(
            org_id,
            connection_id, "AWS integration source paused; delivery acked and dropped"
        );
        return Ok(AwsStreamOutcome::SourcePaused);
    }

    let _org_inflight_permit = state
        .org_inflight_limiter
        .try_acquire(org_id)
        .ok_or_else(|| {
            warn!(
                org_id,
                connection_id, "Per-org in-flight ingest limit exceeded"
            );
            (
                ApiError::too_many_requests("Per-org ingest limit exceeded"),
                "throttle",
            )
        })?;

    // Before the body is decoded, so a denied org's delivery is not gunzipped.
    if let Some(error) = entitlement_rejection(state, org_id, signal).await {
        state
            .aws_resolver
            .record_health(connection_id, Some(aws_metric_stream::OVER_PLAN_LIMIT))
            .await;
        return Err((error, "billing_limit"));
    }

    let Some(requests) = read_delivery(
        state,
        connection_id,
        org_id,
        content_encoding,
        body,
        request_id,
    )
    .await?
    else {
        return Ok(AwsStreamOutcome::Undecodable);
    };
    let item_count = store_delivery(state, connection_id, &resolved.key, &requests).await?;
    Ok(AwsStreamOutcome::Accepted { item_count })
}

/// The delivery's metric requests, or `None` for one that can never decode
/// (already acked and recorded as lost). Sets `request_id` from the body.
async fn read_delivery(
    state: &AppState,
    connection_id: &str,
    org_id: &str,
    content_encoding: Option<&str>,
    body: &Bytes,
    request_id: &mut String,
) -> Result<Option<Vec<ExportMetricsServiceRequest>>, (ApiError, &'static str)> {
    let max_decoded = state.config.max_decoded_body_bytes;
    let payload = match decode_payload(body, content_encoding, max_decoded) {
        Ok(payload) => payload,
        Err(error) if error.status == StatusCode::PAYLOAD_TOO_LARGE => {
            return Err(refuse_oversized_delivery(state, connection_id, org_id).await);
        }
        Err(_) => {
            ack_undecodable_delivery(state, connection_id, org_id).await;
            return Ok(None);
        }
    };
    let Some(delivery) = aws_metric_stream::parse_delivery(&payload) else {
        ack_undecodable_delivery(state, connection_id, org_id).await;
        return Ok(None);
    };
    if let Some(body_request_id) = &delivery.request_id {
        request_id.clone_from(body_request_id);
    }
    match delivery.metric_requests(max_decoded) {
        Ok(requests) => Ok(Some(requests)),
        Err(aws_metric_stream::RecordError::TooLarge) => {
            Err(refuse_oversized_delivery(state, connection_id, org_id).await)
        }
        Err(aws_metric_stream::RecordError::Unreadable) => {
            ack_undecodable_delivery(state, connection_id, org_id).await;
            Ok(None)
        }
    }
}

/// Converts, stores and meters a delivery's metrics; returns the points stored.
async fn store_delivery(
    state: &AppState,
    connection_id: &str,
    key: &ResolvedIngestKey,
    requests: &[ExportMetricsServiceRequest],
) -> Result<usize, (ApiError, &'static str)> {
    let org_id = key.org_id.as_str();
    let signal = Signal::Metrics.path();
    // Metered as CloudWatch sent it, not as the larger expansion Maple stores.
    let received_bytes: usize = requests.iter().map(Message::encoded_len).sum();
    Span::current().record("maple.ingest.decoded_bytes", received_bytes);

    let mut decoded = DecodedPayload::Metrics(aws_metric_stream::build_metrics_request(
        requests,
        &aws_metric_stream::Connection {
            id: connection_id,
            org_id,
            source_id: key.source_public_id(),
        },
    ));
    let item_count = decoded.item_count();
    let mut retained = Retained::default();
    if item_count > 0 {
        if let Err(error) = process_decoded_payload(
            state,
            Signal::Metrics,
            PayloadFormat::Protobuf,
            None,
            &mut decoded,
            key,
            &mut retained,
        )
        .await
        {
            state
                .aws_resolver
                .record_health(connection_id, Some(aws_metric_stream::DELIVERY_NOT_STORED))
                .await;
            return Err((error, "forward"));
        }
    }
    state.aws_resolver.record_health(connection_id, None).await;
    state.resolver.note_source_use(key, false);

    // Only the share the ingest rules left is metered.
    let metered_bytes = retained.metered_bytes(received_bytes);
    let stored = retained.metered_items(item_count);
    if stored > 0 && metered_bytes > 0 {
        if let Some(usage) = &state.usage_metrics {
            usage.record(org_id, signal, metered_bytes as u64, stored as u64);
        }
        if let Some(tracker) = &state.autumn_tracker {
            tracker.track(org_id, signal, billable_gb(metered_bytes as u64));
        }
    }
    Ok(stored)
}

/// A delivery that can never decode: acked so Firehose does not retry it, and
/// counted as lost.
async fn ack_undecodable_delivery(state: &AppState, connection_id: &str, org_id: &str) {
    // Not `warn!`: a stream in the wrong output format fails this way on every delivery.
    debug!(
        org_id,
        connection_id, "AWS metric stream delivery cannot be decoded; acked and dropped"
    );
    metrics::org_data_loss(org_id, Signal::Metrics.path(), "decode");
    state
        .aws_resolver
        .record_health(connection_id, Some(aws_metric_stream::UNREADABLE_DELIVERY))
        .await;
}

/// Firehose does not retry a 413, so the delivery is lost.
async fn refuse_oversized_delivery(
    state: &AppState,
    connection_id: &str,
    org_id: &str,
) -> (ApiError, &'static str) {
    warn!(
        org_id,
        connection_id, "AWS metric stream delivery decodes past the size limit"
    );
    metrics::org_data_loss(org_id, Signal::Metrics.path(), "payload_too_large");
    state
        .aws_resolver
        .record_health(connection_id, Some(aws_metric_stream::DELIVERY_TOO_LARGE))
        .await;
    (
        ApiError::payload_too_large("Decoded delivery too large"),
        "payload_too_large",
    )
}

/// `aws_connections.id` is a lowercase UUID; anything else is refused before
/// it reaches Postgres.
fn is_aws_connection_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
        })
}

enum ParsedCloudflarePayload {
    Validation,
    Records(Vec<JsonMap<String, JsonValue>>),
}

fn is_supported_cloudflare_content_type(content_type: &str) -> bool {
    content_type.contains("json")
        || content_type.contains("ndjson")
        || content_type.contains("text/plain")
        || content_type == "application/octet-stream"
}

fn parse_cloudflare_payload(payload: &[u8]) -> Result<ParsedCloudflarePayload, ApiError> {
    let text = std::str::from_utf8(payload)
        .map_err(|_| ApiError::bad_request("Cloudflare Logpush payload must be UTF-8 JSON"))?;
    let trimmed = text.trim();

    if trimmed.is_empty() {
        return Err(ApiError::bad_request(
            "Cloudflare Logpush payload was empty",
        ));
    }

    if trimmed.contains('\n') && !trimmed.starts_with('[') {
        let mut records = Vec::new();
        for line in trimmed.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let value: JsonValue = serde_json::from_str(line)
                .map_err(|_| ApiError::bad_request("Invalid Cloudflare NDJSON payload"))?;
            match value {
                JsonValue::Object(object) => records.push(object),
                _ => {
                    return Err(ApiError::bad_request(
                        "Cloudflare NDJSON payload must contain JSON objects",
                    ))
                }
            }
        }

        if records.is_empty() {
            return Err(ApiError::bad_request(
                "Cloudflare Logpush payload was empty",
            ));
        }

        return Ok(ParsedCloudflarePayload::Records(records));
    }

    if trimmed.starts_with('[') {
        let value: JsonValue = serde_json::from_str(trimmed)
            .map_err(|_| ApiError::bad_request("Invalid Cloudflare JSON array payload"))?;
        return extract_cloudflare_records(value);
    }

    if trimmed.starts_with('{') {
        let value: JsonValue = serde_json::from_str(trimmed)
            .map_err(|_| ApiError::bad_request("Invalid Cloudflare JSON payload"))?;
        return extract_cloudflare_records(value);
    }

    Err(ApiError::bad_request(
        "Cloudflare Logpush payload must be a JSON object, JSON array, or NDJSON",
    ))
}

fn extract_cloudflare_records(value: JsonValue) -> Result<ParsedCloudflarePayload, ApiError> {
    match value {
        JsonValue::Object(object) => {
            if object.len() == 1
                && object
                    .get("content")
                    .and_then(JsonValue::as_str)
                    .is_some_and(|value| value == "tests")
            {
                return Ok(ParsedCloudflarePayload::Validation);
            }

            Ok(ParsedCloudflarePayload::Records(vec![object]))
        }
        JsonValue::Array(values) => {
            let mut records = Vec::with_capacity(values.len());
            for value in values {
                match value {
                    JsonValue::Object(object) => records.push(object),
                    _ => {
                        return Err(ApiError::bad_request(
                            "Cloudflare JSON array payload must contain JSON objects",
                        ))
                    }
                }
            }

            if records.is_empty() {
                return Err(ApiError::bad_request(
                    "Cloudflare Logpush payload was empty",
                ));
            }

            Ok(ParsedCloudflarePayload::Records(records))
        }
        _ => Err(ApiError::bad_request(
            "Cloudflare Logpush payload must be a JSON object, JSON array, or NDJSON",
        )),
    }
}

fn build_cloudflare_logs_request(
    resolved: &ResolvedCloudflareConnector,
    records: Vec<JsonMap<String, JsonValue>>,
) -> ExportLogsServiceRequest {
    let log_records = records
        .into_iter()
        .map(|record| build_cloudflare_log_record(resolved, &record))
        .collect();

    ExportLogsServiceRequest {
        resource_logs: vec![ResourceLogs {
            resource: Some(Resource {
                attributes: build_cloudflare_resource_attributes(resolved),
                dropped_attributes_count: 0,
                entity_refs: Vec::new(),
            }),
            schema_url: String::new(),
            scope_logs: vec![ScopeLogs {
                scope: Some(InstrumentationScope {
                    name: "cloudflare.logpush".to_owned(),
                    version: "http_requests".to_owned(),
                    attributes: Vec::new(),
                    dropped_attributes_count: 0,
                }),
                schema_url: String::new(),
                log_records,
            }],
        }],
    }
}

fn build_cloudflare_resource_attributes(resolved: &ResolvedCloudflareConnector) -> Vec<KeyValue> {
    let mut attributes = vec![
        string_attribute("maple_org_id", &resolved.org_id),
        string_attribute("maple_ingest_source", CLOUDFLARE_LOGPUSH_SOURCE),
        string_attribute("maple_ingest_key_type", IngestKeyType::Connector.as_str()),
        string_attribute("cloud.provider", "cloudflare"),
        string_attribute("cloudflare.dataset", &resolved.dataset),
        string_attribute("cloudflare.zone_name", &resolved.zone_name),
        string_attribute("maple_cloudflare_connector_id", &resolved.connector_id),
        string_attribute("service.name", &resolved.service_name),
    ];
    if let Some(source) = &resolved.source {
        attributes.push(string_attribute(SOURCE_ID_ATTRIBUTE, &source.public_id));
    }
    attributes
}

fn build_cloudflare_log_record(
    _resolved: &ResolvedCloudflareConnector,
    record: &JsonMap<String, JsonValue>,
) -> LogRecord {
    let timestamp = record
        .get("EdgeStartTimestamp")
        .and_then(parse_cloudflare_timestamp)
        .or_else(|| {
            record
                .get("EdgeEndTimestamp")
                .and_then(parse_cloudflare_timestamp)
        })
        .unwrap_or_else(current_time_unix_nano);

    let status_code = record
        .get("EdgeResponseStatus")
        .and_then(parse_status_code)
        .unwrap_or(0);
    let (severity_text, severity_number) = severity_from_status(status_code);
    let body = build_cloudflare_body(record, status_code);
    let attributes = record
        .iter()
        .filter_map(|(key, value)| json_value_to_attribute(key, value))
        .collect();

    LogRecord {
        time_unix_nano: timestamp,
        observed_time_unix_nano: timestamp,
        severity_number,
        severity_text: severity_text.to_owned(),
        body: Some(AnyValue {
            value: Some(any_value::Value::StringValue(body)),
        }),
        attributes,
        dropped_attributes_count: 0,
        flags: 0,
        trace_id: Vec::new(),
        span_id: Vec::new(),
        event_name: String::new(),
    }
}

fn build_cloudflare_body(record: &JsonMap<String, JsonValue>, status_code: u16) -> String {
    let method = record
        .get("ClientRequestMethod")
        .and_then(JsonValue::as_str)
        .unwrap_or("UNKNOWN");
    let host = record
        .get("ClientRequestHost")
        .and_then(JsonValue::as_str)
        .unwrap_or("-");
    let uri = record
        .get("ClientRequestURI")
        .and_then(JsonValue::as_str)
        .unwrap_or("");

    format!("{method} {host}{uri} -> {status_code}")
}

fn parse_status_code(value: &JsonValue) -> Option<u16> {
    value
        .as_u64()
        .and_then(|value| u16::try_from(value).ok())
        .or_else(|| value.as_str().and_then(|value| value.parse::<u16>().ok()))
}

fn severity_from_status(status_code: u16) -> (&'static str, i32) {
    if status_code >= 500 {
        return ("ERROR", 17);
    }
    if status_code >= 400 {
        return ("WARN", 13);
    }

    ("INFO", 9)
}

fn parse_cloudflare_timestamp(value: &JsonValue) -> Option<u64> {
    match value {
        JsonValue::Number(number) => number.as_u64().map(normalize_numeric_timestamp),
        JsonValue::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return None;
            }
            if let Ok(value) = trimmed.parse::<u64>() {
                return Some(normalize_numeric_timestamp(value));
            }
            DateTime::parse_from_rfc3339(trimmed)
                .ok()
                .and_then(|value| value.timestamp_nanos_opt())
                .and_then(|value| u64::try_from(value).ok())
        }
        _ => None,
    }
}

fn normalize_numeric_timestamp(value: u64) -> u64 {
    if value >= 1_000_000_000_000_000 {
        return value;
    }

    value.saturating_mul(1_000_000_000)
}

fn current_time_unix_nano() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| {
            u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
        })
}

fn string_attribute(key: &str, value: &str) -> KeyValue {
    KeyValue {
        key: key.to_owned(),
        key_strindex: 0,
        value: Some(AnyValue {
            value: Some(any_value::Value::StringValue(value.to_owned())),
        }),
    }
}

fn json_value_to_attribute(key: &str, value: &JsonValue) -> Option<KeyValue> {
    let string_value = match value {
        JsonValue::Null => return None,
        JsonValue::String(value) => value.clone(),
        JsonValue::Bool(value) => value.to_string(),
        JsonValue::Number(value) => value.to_string(),
        JsonValue::Array(_) | JsonValue::Object(_) => serde_json::to_string(value).ok()?,
    };

    Some(string_attribute(key, &string_value))
}

fn extract_ingest_key(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    {
        if value.len() > 7 && value[..7].eq_ignore_ascii_case("Bearer ") {
            let token = value[7..].trim();
            if !token.is_empty() {
                return Some(token.to_owned());
            }
        }
    }

    headers
        .get("x-maple-ingest-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

#[derive(Clone, Copy)]
enum PayloadFormat {
    Protobuf,
    Json,
}

impl PayloadFormat {
    fn content_type(self) -> &'static str {
        match self {
            Self::Protobuf => "application/x-protobuf",
            Self::Json => "application/json",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Protobuf => "protobuf",
            Self::Json => "json",
        }
    }
}

fn detect_payload_format(content_type: &str) -> Result<PayloadFormat, ApiError> {
    if content_type.contains("json") {
        return Ok(PayloadFormat::Json);
    }

    if content_type.contains("protobuf") || content_type == "application/octet-stream" {
        return Ok(PayloadFormat::Protobuf);
    }

    Err(ApiError::unsupported_media_type(
        "Unsupported content type (expected OTLP protobuf/json)",
    ))
}

#[hotpath::measure]
fn decode_payload(
    body: &Bytes,
    content_encoding: Option<&str>,
    max_decoded: usize,
) -> Result<Vec<u8>, ApiError> {
    match content_encoding {
        None => Ok(body.to_vec()),
        Some("gzip") => gunzip_bounded(body.as_ref(), max_decoded).map_err(|e| match e {
            GunzipError::Invalid(_) => ApiError::bad_request("Invalid gzip body"),
            GunzipError::TooLarge => {
                ApiError::payload_too_large("Decompressed request body too large")
            }
        }),
        Some(_) => Err(ApiError::unsupported_media_type(
            "Unsupported content-encoding",
        )),
    }
}

#[hotpath::measure]
fn encode_payload(payload: &[u8], content_encoding: Option<&str>) -> Result<Vec<u8>, ApiError> {
    match content_encoding {
        None => Ok(payload.to_vec()),
        Some("gzip") => {
            let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
            encoder
                .write_all(payload)
                .map_err(|_| ApiError::service_unavailable("Failed to encode gzip payload"))?;
            encoder
                .finish()
                .map_err(|_| ApiError::service_unavailable("Failed to encode gzip payload"))
        }
        Some(_) => Err(ApiError::unsupported_media_type(
            "Unsupported content-encoding",
        )),
    }
}

#[hotpath::measure]
fn decode_otlp_payload(
    signal: Signal,
    payload_format: PayloadFormat,
    payload: &[u8],
) -> Result<DecodedPayload, ApiError> {
    match (signal, payload_format) {
        (Signal::Traces, PayloadFormat::Protobuf) => {
            let request = ExportTraceServiceRequest::decode(payload)
                .map_err(|e| invalid_payload("traces", "protobuf", e))?;
            Ok(DecodedPayload::Traces(request))
        }
        (Signal::Logs, PayloadFormat::Protobuf) => {
            let request = ExportLogsServiceRequest::decode(payload)
                .map_err(|e| invalid_payload("logs", "protobuf", e))?;
            Ok(DecodedPayload::Logs(request))
        }
        (Signal::Metrics, PayloadFormat::Protobuf) => {
            let request = ExportMetricsServiceRequest::decode(payload)
                .map_err(|e| invalid_payload("metrics", "protobuf", e))?;
            Ok(DecodedPayload::Metrics(request))
        }
        (Signal::Traces, PayloadFormat::Json) => {
            let request: ExportTraceServiceRequest =
                decode_otlp_json(payload, "traces", "resourceSpans")?;
            Ok(DecodedPayload::Traces(request))
        }
        (Signal::Logs, PayloadFormat::Json) => {
            let request: ExportLogsServiceRequest =
                decode_otlp_json(payload, "logs", "resourceLogs")?;
            Ok(DecodedPayload::Logs(request))
        }
        (Signal::Metrics, PayloadFormat::Json) => {
            let request: ExportMetricsServiceRequest =
                decode_otlp_json(payload, "metrics", "resourceMetrics")?;
            Ok(DecodedPayload::Metrics(request))
        }
    }
}

/// What `verify_claims_and_enrich` found in a payload's `maple_source_id` claims.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct ClaimOutcome {
    /// `sources.id` of each verified, unpaused claim; their resources were kept.
    claimed_sources: Vec<String>,
    /// A resource carried a verified claim of its own (a poller's batch), paused or
    /// not, so the batch never counts as default-source use.
    kept_claim: bool,
    /// Every resource named a paused source and was dropped: answer success, write nothing.
    all_paused: bool,
    /// What paused-source drops (and later the ingest rules) left of the payload.
    retained: Retained,
}

/// The share of a payload still stored after paused-source drops and ingest rules,
/// so only that share is metered. Never above what was received.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Retained {
    /// (kept, received) as a product of each step's encoded sizes; `None` when nothing changed.
    share: Option<(u128, u128)>,
    /// Items left after the ingest rules dropped some, recounted from the payload.
    kept_items: Option<usize>,
}

impl Retained {
    /// Folds in one step that took the encoded payload from `before` to `after` bytes.
    /// Capped at 1, so masking or hashing that grows a value never bills more.
    fn retain(&mut self, before: usize, after: usize) {
        if before == 0 {
            return;
        }
        let after = after.min(before);
        let (kept, received) = self.share.unwrap_or((1, 1));
        self.share = Some((kept * after as u128, received * before as u128));
    }

    /// `original` bytes scaled to the retained share; unchanged when nothing changed.
    fn metered_bytes(&self, original: usize) -> usize {
        match self.share {
            Some((kept, received)) if received > 0 => {
                let scaled = original as u128 * kept / received;
                usize::try_from(scaled).unwrap_or(original)
            }
            _ => original,
        }
    }

    /// `items` as counted before the rules, or what is left when they dropped some.
    fn metered_items(&self, items: usize) -> usize {
        self.kept_items.unwrap_or(items)
    }
}

impl ClaimOutcome {
    /// `original` bytes scaled to the share left after the drops; unchanged when none was.
    fn metered_bytes(&self, original: usize) -> usize {
        self.retained.metered_bytes(original)
    }
}

/// Checks the sender's own `maple_source_id` values against the org, drops the
/// resources of paused pull sources, then enriches what is left.
async fn verify_claims_and_enrich(
    state: &AppState,
    decoded: &mut DecodedPayload,
    resolved_key: &ResolvedIngestKey,
) -> ClaimOutcome {
    let claims = claimed_source_ids(decoded, resolved_key);
    let overflow = overflow_source_claims(decoded, &claims);
    let mut verified = if claims.is_empty() {
        VerifiedClaims::default()
    } else {
        state
            .resolver
            .verify_source_claims(&resolved_key.org_id, claims)
            .await
    };
    // Claims past the cap get no store lookup (it bounds the query), but one the
    // cache knows as paused is still dropped, so the cap is no way around a pause.
    if !overflow.is_empty() {
        let paused = state
            .resolver
            .cached_paused_claims(&resolved_key.org_id, overflow)
            .await;
        verified.paused.extend(paused);
    }
    let before = (!verified.paused.is_empty()).then(|| decoded.encoded_len());
    let dropped = drop_paused_resources(decoded, &verified.paused);
    let all_paused = dropped && decoded.resource_count() == 0;
    let mut retained = Retained::default();
    if let Some(before) = before.filter(|_| dropped) {
        retained.retain(before, decoded.encoded_len());
    }
    if dropped {
        metrics::source_paused_drop(&resolved_key.org_id, decoded.signal().path());
        if all_paused {
            Span::current().record("maple.ingest.reject_reason", "source_paused");
        }
        debug!(org_id = %resolved_key.org_id, all_paused, "Paused pull source; resources dropped");
    }
    enrich_decoded_payload(decoded, resolved_key, &verified.active);
    ClaimOutcome {
        claimed_sources: verified
            .active
            .iter()
            .filter_map(|claim| sources::source_uuid_from_public_id(claim))
            .collect(),
        kept_claim: !verified.active.is_empty() || dropped,
        all_paused,
        retained,
    }
}

/// Removes every resource whose `maple_source_id` is one of `paused`. True when any was.
fn drop_paused_resources(decoded: &mut DecodedPayload, paused: &[String]) -> bool {
    if paused.is_empty() {
        return false;
    }
    let keep = |resource: Option<&Resource>| {
        resource
            .and_then(|resource| source_id_claim(&resource.attributes))
            .is_none_or(|claim| !paused.iter().any(|id| id == claim))
    };
    let before = decoded.resource_count();
    match decoded {
        DecodedPayload::Traces(request) => {
            request.resource_spans.retain(|r| keep(r.resource.as_ref()));
        }
        DecodedPayload::Logs(request) => {
            request.resource_logs.retain(|r| keep(r.resource.as_ref()));
        }
        DecodedPayload::Metrics(request) => {
            request
                .resource_metrics
                .retain(|r| keep(r.resource.as_ref()));
        }
    }
    decoded.resource_count() < before
}

/// Stamps the tenant and source onto a decoded payload. `verified_claims` are the
/// sender's own `maple_source_id` values `verify_source_claims` accepted.
fn enrich_decoded_payload(
    decoded: &mut DecodedPayload,
    resolved_key: &ResolvedIngestKey,
    verified_claims: &[String],
) {
    match decoded {
        DecodedPayload::Traces(request) => {
            enrich_trace_request(request, resolved_key, verified_claims)
        }
        DecodedPayload::Logs(request) => {
            enrich_logs_request(request, resolved_key, verified_claims)
        }
        DecodedPayload::Metrics(request) => {
            enrich_metrics_request(request, resolved_key, verified_claims);
        }
    }
}

/// OTLP/JSON decode, via the leniency pass in `otlp_json`.
///
/// Deserializing straight into the generated types rejects encodings the spec
/// says a receiver must accept (a `time_unix_nano` sent as a JSON number) and,
/// for metrics, silently discards the data points instead of failing. So the
/// payload goes through `serde_json::Value` first and is normalized onto the
/// encoding the derives handle. See `otlp_json` for the full list.
fn decode_otlp_json<T: serde::de::DeserializeOwned>(
    payload: &[u8],
    signal: &str,
    root_field: &str,
) -> Result<T, ApiError> {
    let mut json: serde_json::Value =
        serde_json::from_slice(payload).map_err(|e| invalid_payload(signal, "JSON", e))?;
    otlp_json::normalize(&mut json, root_field);
    serde_json::from_value(json).map_err(|e| invalid_payload(signal, "JSON", e))
}

/// The parser's own complaint is the only thing that says *which* field a
/// customer's SDK got wrong, so it goes in the response body (and from there
/// onto the span) rather than being flattened into "Invalid OTLP payload".
/// Bounded because it is attacker-influenced and lands on a span attribute.
fn invalid_payload(signal: &str, format: &str, error: impl std::fmt::Display) -> ApiError {
    let mut detail = error.to_string();
    if detail.len() > MAX_PAYLOAD_ERROR_DETAIL {
        detail.truncate(
            (0..=MAX_PAYLOAD_ERROR_DETAIL)
                .rev()
                .find(|i| detail.is_char_boundary(*i))
                .unwrap_or(0),
        );
        detail.push('…');
    }
    ApiError::bad_request(format!("Invalid OTLP {signal} {format} payload: {detail}"))
}

const MAX_PAYLOAD_ERROR_DETAIL: usize = 200;

fn count_trace_items(request: &ExportTraceServiceRequest) -> usize {
    request
        .resource_spans
        .iter()
        .flat_map(|rs| &rs.scope_spans)
        .map(|ss| ss.spans.len())
        .sum()
}

fn count_log_items(request: &ExportLogsServiceRequest) -> usize {
    request
        .resource_logs
        .iter()
        .flat_map(|rl| &rl.scope_logs)
        .map(|sl| sl.log_records.len())
        .sum()
}

fn count_metric_items(request: &ExportMetricsServiceRequest) -> usize {
    request
        .resource_metrics
        .iter()
        .flat_map(|rm| &rm.scope_metrics)
        .map(|sm| sm.metrics.len())
        .sum()
}

fn enrich_trace_request(
    request: &mut ExportTraceServiceRequest,
    resolved_key: &ResolvedIngestKey,
    verified_claims: &[String],
) {
    for resource_span in &mut request.resource_spans {
        let resource = resource_span.resource.get_or_insert_with(Resource::default);
        enrich_resource_attributes(&mut resource.attributes, resolved_key, verified_claims);
    }
    ai_session::stamp_trace_request(request);
}

fn enrich_logs_request(
    request: &mut ExportLogsServiceRequest,
    resolved_key: &ResolvedIngestKey,
    verified_claims: &[String],
) {
    for resource_log in &mut request.resource_logs {
        let resource = resource_log.resource.get_or_insert_with(Resource::default);
        enrich_resource_attributes(&mut resource.attributes, resolved_key, verified_claims);
    }
}

fn enrich_metrics_request(
    request: &mut ExportMetricsServiceRequest,
    resolved_key: &ResolvedIngestKey,
    verified_claims: &[String],
) {
    for resource_metric in &mut request.resource_metrics {
        let resource = resource_metric
            .resource
            .get_or_insert_with(Resource::default);
        enrich_resource_attributes(&mut resource.attributes, resolved_key, verified_claims);
    }
}

/// A resource's `maple_source_id`, when it is a string.
fn source_id_claim(attributes: &[KeyValue]) -> Option<&str> {
    let value = attributes
        .iter()
        .find(|attribute| attribute.key == SOURCE_ID_ATTRIBUTE)?
        .value
        .as_ref()?;
    match value.value.as_ref()? {
        any_value::Value::StringValue(claim) => Some(claim.as_str()),
        _ => None,
    }
}

/// The first `MAX_SOURCE_CLAIMS` distinct `maple_source_id` values a default-key
/// sender put on its resources (Maple's pollers name their own source). Empty for other keys.
fn claimed_source_ids(decoded: &DecodedPayload, resolved_key: &ResolvedIngestKey) -> Vec<String> {
    if !resolved_key.accepts_source_claims() {
        return Vec::new();
    }
    let mut claims: Vec<String> = Vec::new();
    for claim in sized_source_claims(decoded) {
        if !claims.iter().any(|seen| seen == claim) {
            claims.push(claim.to_owned());
            // Claims past the cap are never looked up, so they stay unverified.
            if claims.len() == MAX_SOURCE_CLAIMS {
                break;
            }
        }
    }
    claims
}

/// Distinct claims past the `MAX_SOURCE_CLAIMS` cap, i.e. not in `looked_up`.
/// Empty unless the cap was reached.
fn overflow_source_claims(decoded: &DecodedPayload, looked_up: &[String]) -> Vec<String> {
    if looked_up.len() < MAX_SOURCE_CLAIMS {
        return Vec::new();
    }
    let mut seen = std::collections::HashSet::new();
    sized_source_claims(decoded)
        .filter(|claim| !looked_up.iter().any(|known| known == claim) && seen.insert(*claim))
        .map(str::to_owned)
        .collect()
}

/// Each resource's `maple_source_id`, skipping any longer than a valid id:
/// those are never decoded or cached, so they stay unverified.
fn sized_source_claims(decoded: &DecodedPayload) -> impl Iterator<Item = &str> {
    let resources: Vec<Option<&Resource>> = match decoded {
        DecodedPayload::Traces(request) => request
            .resource_spans
            .iter()
            .map(|r| r.resource.as_ref())
            .collect(),
        DecodedPayload::Logs(request) => request
            .resource_logs
            .iter()
            .map(|r| r.resource.as_ref())
            .collect(),
        DecodedPayload::Metrics(request) => request
            .resource_metrics
            .iter()
            .map(|r| r.resource.as_ref())
            .collect(),
    };
    resources
        .into_iter()
        .flatten()
        .filter_map(|resource| source_id_claim(&resource.attributes))
        .filter(|claim| claim.len() <= MAX_PUBLIC_ID_LEN)
}

fn enrich_resource_attributes(
    attributes: &mut Vec<KeyValue>,
    resolved_key: &ResolvedIngestKey,
    verified_claims: &[String],
) {
    // A default-key sender keeps its own source id only once verified as the org's.
    let kept_claim = source_id_claim(attributes)
        .filter(|claim| {
            resolved_key.accepts_source_claims()
                && verified_claims.iter().any(|verified| verified == claim)
        })
        .map(str::to_owned);
    attributes.retain(|attribute| {
        let key = attribute.key.as_str();
        key != "org_id" && key != "maple_org_id" && key != SOURCE_ID_ATTRIBUTE
    });

    // Overrides go first so the maple_* stamps below always win.
    if let Some(source) = &resolved_key.source {
        apply_resource_attribute_overrides(attributes, source);
    }

    upsert_string_attribute(attributes, "maple_org_id", &resolved_key.org_id);
    upsert_string_attribute(
        attributes,
        "maple_ingest_key_type",
        resolved_key.key_type.as_str(),
    );
    upsert_string_attribute(attributes, "maple_ingest_source", INGEST_SOURCE);
    if let Some(source_id) = kept_claim
        .as_deref()
        .or_else(|| resolved_key.source_public_id())
    {
        upsert_string_attribute(attributes, SOURCE_ID_ATTRIBUTE, source_id);
    }
}

fn apply_resource_attribute_overrides(attributes: &mut Vec<KeyValue>, policy: &SourcePolicy) {
    for attribute in &policy.resource_attributes {
        // Parsing already drops these; checked again since it guards tenancy.
        if sources::is_protected_attribute(&attribute.key) {
            continue;
        }
        match attribute.mode {
            OverrideMode::Set => {
                upsert_string_attribute(attributes, &attribute.key, &attribute.value);
            }
            OverrideMode::Default => {
                if !attributes
                    .iter()
                    .any(|existing| existing.key == attribute.key)
                {
                    upsert_string_attribute(attributes, &attribute.key, &attribute.value);
                }
            }
        }
    }
}

fn upsert_string_attribute(attributes: &mut Vec<KeyValue>, key: &str, value: &str) {
    if let Some(attribute) = attributes.iter_mut().find(|attribute| attribute.key == key) {
        attribute.value = Some(AnyValue {
            value: Some(any_value::Value::StringValue(value.to_owned())),
        });
        return;
    }

    attributes.push(KeyValue {
        key: key.to_owned(),
        key_strindex: 0,
        value: Some(AnyValue {
            value: Some(any_value::Value::StringValue(value.to_owned())),
        }),
    });
}

fn native_destination_for(resolved_key: &ResolvedIngestKey) -> ExportDestination {
    if resolved_key.clickhouse_ready {
        ExportDestination::ClickHouse
    } else {
        ExportDestination::Tinybird
    }
}

fn native_rows_pipeline_for<'a>(
    state: &'a AppState,
    destination: ExportDestination,
    unavailable_message: &'static str,
) -> Result<&'a TelemetryPipeline, ApiError> {
    if destination == ExportDestination::Tinybird && !state.config.write_mode.uses_tinybird() {
        return Err(ApiError::service_unavailable(unavailable_message));
    }
    state
        .telemetry_pipeline
        .as_ref()
        .ok_or_else(|| ApiError::service_unavailable(unavailable_message))
}

#[hotpath::measure]
#[expect(
    clippy::cognitive_complexity,
    reason = "a retry loop whose branches are the retry policy"
)]
async fn forward_to_collector(
    state: &AppState,
    signal: Signal,
    content_type: &str,
    content_encoding: Option<&str>,
    body: Vec<u8>,
    resolved_key: &ResolvedIngestKey,
) -> Result<Response, ApiError> {
    let endpoint = state.config.forward_endpoint.as_str();
    let upstream_pool = "shared";

    let url = format!("{endpoint}/v1/{}", signal.path());
    let outbound_bytes = body.len();
    Span::current().record("maple.ingest.upstream_pool", upstream_pool);
    Span::current().record("url.full", url.as_str());
    if let Ok(parsed) = url::Url::parse(&url) {
        if let Some(host) = parsed.host_str() {
            Span::current().record("server.address", host);
        }
    }

    debug!(url = %url, upstream_pool, outbound_bytes, "Forwarding to collector");

    let mut request_builder = state
        .http_client
        .request(Method::POST, &url)
        .header(CONTENT_TYPE, content_type)
        .body(body);

    if let Some(content_encoding) = content_encoding {
        request_builder = request_builder.header(CONTENT_ENCODING, content_encoding);
    }

    let forward_start = Instant::now();
    let response = request_builder.send().await.map_err(|error| {
        let forward_duration = forward_start.elapsed();
        Span::current().record("error.type", "transport");
        Span::current().record("otel.status_code", "Error");
        metrics::forward_duration(signal.path(), upstream_pool, forward_duration.as_secs_f64());
        metrics::forward_response(signal.path(), "error", upstream_pool);
        error!(
            error = %error,
            signal = signal.path(),
            org_id = %resolved_key.org_id,
            key_id = %resolved_key.key_id,
            upstream_pool,
            url = %url,
            "Collector forwarding failed"
        );
        collector_unavailable(
            "Maple could not reach the upstream collector. No data was stored; resend this batch after the suggested delay.",
            error.to_string(),
        )
    })?;

    let forward_duration = forward_start.elapsed();
    metrics::forward_duration(signal.path(), upstream_pool, forward_duration.as_secs_f64());

    let upstream_status_code = response.status().as_u16();
    Span::current().record("http.response.status_code", upstream_status_code);
    Span::current().record(
        "otel.status_code",
        if response.status().is_success() {
            "Ok"
        } else {
            "Error"
        },
    );
    let status_bucket = match upstream_status_code {
        200..=299 => "2xx",
        400..=499 => "4xx",
        500..=599 => "5xx",
        _ => "other",
    };
    metrics::forward_response(signal.path(), status_bucket, upstream_pool);

    debug!(
        upstream_status = upstream_status_code,
        forward_ms = duration_millis(forward_duration),
        "Collector response"
    );

    if response.status().is_server_error() {
        error!(
            upstream_status = upstream_status_code,
            signal = signal.path(),
            org_id = %resolved_key.org_id,
            "Collector returned error"
        );
        return Err(collector_unavailable(
            "The upstream collector rejected this batch with a server error. No data was stored; resend it after the suggested delay.",
            format!("collector responded {upstream_status_code}"),
        ));
    }

    relay_collector_response(response, upstream_status_code, signal, resolved_key).await
}

/// Copy the collector's own (non-5xx) answer back to the caller verbatim, so an
/// OTLP partial-success body reaches the SDK unchanged.
async fn relay_collector_response(
    response: reqwest::Response,
    upstream_status_code: u16,
    signal: Signal,
    resolved_key: &ResolvedIngestKey,
) -> Result<Response, ApiError> {
    let status = StatusCode::from_u16(upstream_status_code).unwrap_or(StatusCode::BAD_GATEWAY);

    let upstream_content_type = response.headers().get(CONTENT_TYPE).cloned();
    let upstream_body = response.bytes().await.map_err(|error| {
        error!(
            error = %error,
            signal = signal.path(),
            org_id = %resolved_key.org_id,
            key_id = %resolved_key.key_id,
            "Failed reading collector response"
        );
        collector_unavailable(
            "Maple could not read the upstream collector's response. The batch may or may not have been stored; resend it after the suggested delay.",
            error.to_string(),
        )
    })?;

    let mut response = Response::builder().status(status);
    if let Some(content_type) = upstream_content_type {
        response = response.header(CONTENT_TYPE, content_type);
    }

    response
        .body(axum::body::Body::from(upstream_body))
        .map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Maple could not relay the upstream collector's response.",
            )
            .with_detail(error.to_string())
        })
}

/// What one payload's rule pass did, recorded once the payload is written.
struct RulesApplied {
    rules: Arc<rules_gateway::OrgRules>,
    stats: RuleStats,
}

/// Applies the org's ingest rules in place and folds what they removed into `retained`.
/// `None` when the feature is off or no rule reads the signal, at no cost. A rule lookup
/// with nothing to fall back on refuses the payload rather than storing it unredacted.
async fn apply_ingest_rules(
    state: &AppState,
    decoded: &mut DecodedPayload,
    org_id: &str,
    retained: &mut Retained,
) -> Result<Option<RulesApplied>, ApiError> {
    let resolver = &state.ingest_rule_resolver;
    if !resolver.enabled() || org_id == SENTINEL_ORG_ID {
        return Ok(None);
    }
    let rules = resolver.resolve_rules(org_id).await.map_err(|_| {
        ApiError::tagged(
            StatusCode::SERVICE_UNAVAILABLE,
            &INGEST_RULES_UNAVAILABLE,
            "Ingest rules could not be loaded; retry shortly",
        )
    })?;
    let signal = decoded.signal();
    if !rules.compiled.covers(signal.ingest_signal()) {
        return Ok(None);
    }
    let mut stats = RuleStats::default();
    match decoded {
        DecodedPayload::Traces(request) => {
            ingest_rules::apply_traces(&rules.compiled, request, &mut stats);
        }
        DecodedPayload::Logs(request) => ingest_rules::apply_logs(&rules.compiled, request, &mut stats),
        DecodedPayload::Metrics(request) => {
            ingest_rules::apply_metrics(&rules.compiled, request, &mut stats);
        }
    }
    let span = Span::current();
    span.record("maple.ingest.rules.count", rules.compiled.len());
    span.record("maple.ingest.rules.dropped_items", stats.total.dropped);
    span.record("maple.ingest.rules.redacted_values", stats.total.redacted_values);
    if stats.total.dropped > 0 || stats.total.redacted_values > 0 {
        // One walk, only when something changed. Redaction's size change is not tracked, so
        // `before` is after plus the dropped bytes: drops are discounted, redaction never bills more.
        let after = decoded.encoded_len();
        let dropped_bytes = usize::try_from(stats.total.dropped_bytes).unwrap_or(usize::MAX);
        retained.retain(after.saturating_add(dropped_bytes), after);
        if stats.total.dropped > 0 {
            retained.kept_items = Some(decoded.item_count());
            metrics::ingest_rules_dropped_bytes(org_id, signal.path(), stats.total.dropped_bytes);
        }
    }
    Ok(Some(RulesApplied { rules, stats }))
}

/// Adds a written payload's rule counts to the stats sink.
fn record_rule_stats(state: &AppState, signal: Signal, applied: Option<&RulesApplied>) {
    if let Some(applied) = applied {
        state.ingest_rule_stats.record(
            signal.path(),
            &applied.rules,
            &applied.stats,
            current_time_millis(),
        );
    }
}

#[hotpath::measure]
async fn process_decoded_payload(
    state: &AppState,
    signal: Signal,
    payload_format: PayloadFormat,
    content_encoding: Option<&str>,
    decoded: &mut DecodedPayload,
    resolved_key: &ResolvedIngestKey,
    retained: &mut Retained,
) -> Result<Response, ApiError> {
    // Before the native/forward split: the WAL, S3 shipping and the collector never see raw values.
    let applied = apply_ingest_rules(state, decoded, &resolved_key.org_id, retained).await?;
    if applied.is_some() && decoded.resource_count() == 0 {
        // Every record was dropped by a rule: success to the sender, nothing written.
        record_rule_stats(state, signal, applied.as_ref());
        return Ok(StatusCode::OK.into_response());
    }
    let destination = native_destination_for(resolved_key);
    Span::current().record("maple.ingest.destination", destination.as_str());

    if uses_native_pipeline_for(state.config.write_mode, destination) {
        accept_native_decoded_payload(state, signal, decoded, resolved_key, destination)
            .instrument(accept_internal_span(signal.path(), destination.as_str()))
            .await?;
        if destination == ExportDestination::ClickHouse {
            record_rule_stats(state, signal, applied.as_ref());
            return Ok(StatusCode::OK.into_response());
        }
    }

    if uses_forward_path_for(state.config.write_mode, destination) {
        let outbound_payload = decoded.encode(payload_format)?;
        let outbound_body = encode_payload(&outbound_payload, content_encoding)?;
        let outbound_bytes = outbound_body.len();
        let forward_span = forward_client_span("collector", outbound_bytes, signal.path());
        let response = forward_to_collector(
            state,
            signal,
            payload_format.content_type(),
            content_encoding,
            outbound_body,
            resolved_key,
        )
        .instrument(forward_span)
        .await?;
        // Counted once the collector took the batch, like the bytes it is billed for.
        if response.status().is_success() {
            record_rule_stats(state, signal, applied.as_ref());
        }
        return Ok(response);
    }

    record_rule_stats(state, signal, applied.as_ref());
    Ok(StatusCode::OK.into_response())
}

#[hotpath::measure]
async fn accept_native_decoded_payload(
    state: &AppState,
    signal: Signal,
    decoded: &DecodedPayload,
    resolved_key: &ResolvedIngestKey,
    destination: ExportDestination,
) -> Result<(), ApiError> {
    let pipeline = state
        .telemetry_pipeline
        .as_ref()
        .ok_or_else(|| ApiError::service_unavailable("Telemetry pipeline is not configured"))?;
    let native_start = Instant::now();
    let stats = match decoded {
        DecodedPayload::Traces(request) => {
            // Both lookups are 30s-TTL cached; the span exists so a TTL miss that
            // stalls on PSBouncer is attributable instead of vanishing into
            // native_accept_duration.
            let config_span = resolve_config_internal_span();
            let config_span_handle = config_span.clone();
            let (policy, attribute_mappings) = async {
                let policy = state
                    .sampling_resolver
                    .resolve_policy(&resolved_key.org_id)
                    .await;
                let attribute_mappings = state
                    .attribute_mapping_resolver
                    .resolve_mappings(&resolved_key.org_id)
                    .await;
                (policy, attribute_mappings)
            }
            .instrument(config_span)
            .await;
            config_span_handle.record("maple.ingest.sampling_ratio", policy.trace_sample_ratio);
            config_span_handle.record(
                "maple.ingest.attribute_mapping_count",
                attribute_mappings.len(),
            );
            pipeline
                .accept_traces_to(
                    &resolved_key.org_id,
                    request,
                    &policy,
                    attribute_mappings.as_slice(),
                    destination,
                )
                .await
        }
        DecodedPayload::Logs(request) => {
            pipeline
                .accept_logs_to(&resolved_key.org_id, request, destination)
                .await
        }
        DecodedPayload::Metrics(request) => {
            pipeline
                .accept_metrics_to(&resolved_key.org_id, request, destination)
                .await
        }
    }
    .map_err(|error| {
        let api_error = api_error_from_pipeline(&error);
        error!(
            error = %error,
            signal = signal.path(),
            org_id = %resolved_key.org_id,
            "Native telemetry pipeline rejected payload"
        );
        record_stage_error(
            &Span::current(),
            error.kind(),
            &error.to_string(),
            error.is_server_fault(),
        );
        api_error
    })?;
    metrics::native_accept_duration(signal.path(), native_start.elapsed().as_secs_f64());
    metrics::native_rows(signal.path(), stats.rows as u64);
    if stats.dropped > 0 {
        metrics::native_sampled_dropped(signal.path(), stats.dropped as u64);
    }
    Span::current().record("maple.ingest.native_rows", stats.rows as u64);
    Span::current().record("maple.ingest.sampled_dropped", stats.dropped as u64);
    Ok(())
}

impl OrgRoutingResolver {
    async fn resolve_org_routing(&self, org_id: &str) -> Result<OrgRouting, String> {
        if let Some(cached) = self.cache.get(org_id).await {
            return Ok(cached);
        }

        match self.store.fetch_org_routing(org_id).await {
            Ok(row) => {
                let routing = row.unwrap_or_default();
                self.remember_org_routing(org_id, routing.clone()).await;
                Ok(routing)
            }
            Err(error) => {
                if let Some(stale) = self.last_known.get(org_id) {
                    warn!(
                        org_id,
                        error = %error,
                        "Org routing refresh failed; serving last-known routing"
                    );
                    Ok(stale.clone())
                } else {
                    warn!(
                        org_id,
                        error = %error,
                        "Org routing refresh failed with no last-known routing; using managed Tinybird path"
                    );
                    Ok(OrgRouting::default())
                }
            }
        }
    }

    async fn remember_org_routing(&self, org_id: &str, routing: OrgRouting) {
        self.last_known.insert(org_id.to_owned(), routing.clone());
        self.cache.insert(org_id.to_owned(), routing).await;
    }
}

impl IngestKeyResolver {
    /// The claimed `src_` ids that name one of the org's pull sources. Only the
    /// first `MAX_SOURCE_CLAIMS` distinct claims count; uncached ones are checked in
    /// one query. Answers are cached; a store error leaves the rest unverified.
    /// Pause is judged against the current clock, not when the answer was cached.
    async fn verify_source_claims(&self, org_id: &str, claims: Vec<String>) -> VerifiedClaims {
        let now_ms = current_time_millis();
        let mut verified = VerifiedClaims::default();
        let mut keep = |claim: String, pause: PauseWindow| {
            if pause.is_paused(now_ms) {
                verified.paused.push(claim);
            } else {
                verified.active.push(claim);
            }
        };
        // (claim as received, its uuid) for claims the cache has no answer for.
        let mut unknown: Vec<(String, String)> = Vec::new();
        let mut seen: Vec<String> = Vec::new();
        for claim in claims {
            if seen.len() == MAX_SOURCE_CLAIMS {
                break;
            }
            if seen.contains(&claim) {
                continue;
            }
            seen.push(claim.clone());
            let cache_key = (org_id.to_owned(), claim);
            match self.source_claims.get(&cache_key).await {
                Some(SourceClaim::Claimable(pause)) => keep(cache_key.1, pause),
                Some(SourceClaim::Unclaimable) => {}
                None => match sources::source_uuid_from_public_id(&cache_key.1) {
                    Some(uuid) => unknown.push((cache_key.1, uuid)),
                    None => {
                        self.source_claims
                            .insert(cache_key, SourceClaim::Unclaimable)
                            .await;
                    }
                },
            }
        }
        if unknown.is_empty() {
            return verified;
        }
        let uuids: Vec<String> = unknown.iter().map(|(_, uuid)| uuid.clone()).collect();
        let found = match self.store.claimable_source_ids(org_id, &uuids).await {
            Ok(found) => found,
            Err(error) => {
                warn!(
                    org_id,
                    error, "Source claim lookup failed; replacing the claims"
                );
                return verified;
            }
        };
        for (claim, uuid) in unknown {
            let answer = found
                .iter()
                .find(|row| row.id == uuid)
                .map_or(SourceClaim::Unclaimable, |row| {
                    SourceClaim::Claimable(row.pause)
                });
            if let SourceClaim::Claimable(pause) = answer {
                keep(claim.clone(), pause);
            }
            self.source_claims
                .insert((org_id.to_owned(), claim), answer)
                .await;
        }
        verified
    }

    /// The `claims` the cache already knows as paused pull sources of the org. No
    /// store lookup, so claims past the cap stay bounded yet cannot bypass a pause.
    async fn cached_paused_claims(&self, org_id: &str, claims: Vec<String>) -> Vec<String> {
        let now_ms = current_time_millis();
        let mut paused = Vec::new();
        for claim in claims {
            let cache_key = (org_id.to_owned(), claim);
            if let Some(SourceClaim::Claimable(pause)) = self.source_claims.get(&cache_key).await {
                if pause.is_paused(now_ms) {
                    paused.push(cache_key.1);
                }
            }
        }
        paused
    }

    /// Stamps `last_used_at` for the source whose data was accepted (token, default
    /// or a connector's), at most once per write interval and off the request path. A batch
    /// that kept a verified claim (a poller) does not count as default-source use.
    fn note_source_use(&self, resolved: &ResolvedIngestKey, kept_claim: bool) {
        if kept_claim {
            return;
        }
        let Some(source_id) = resolved.source_row_id() else {
            return;
        };
        let interval = if resolved.accepts_source_claims() {
            DEFAULT_SOURCE_USE_WRITE_INTERVAL
        } else {
            SOURCE_USE_WRITE_INTERVAL
        };
        self.record_source_use(source_id, interval);
    }

    /// Stamps `last_used_at` for each verified integration source a batch kept data for.
    fn note_claimed_source_use(&self, source_ids: &[String]) {
        for source_id in source_ids {
            self.record_source_use(source_id, SOURCE_USE_WRITE_INTERVAL);
        }
    }

    /// Writes `last_used_at` off the request path, at most once per `interval` per source.
    fn record_source_use(&self, source_id: &str, interval: Duration) {
        // Most requests land inside the window; skip them without spawning.
        if self.recent_key_uses.contains_key(source_id) {
            return;
        }
        let store = Arc::clone(&self.store);
        let recent = self.recent_key_uses.clone();
        let key_id = source_id.to_owned();
        // Its own root span, so the request span does not wait on this write.
        let span = tracing::info_span!(parent: None, "record_source_use");
        span.follows_from(Span::current().id());
        tokio::spawn(
            async move {
                if !recent
                    .entry(key_id.clone())
                    .or_insert(interval)
                    .await
                    .is_fresh()
                {
                    return;
                }
                if let Err(error) = store
                    .record_source_used(&key_id, current_time_millis())
                    .await
                {
                    debug!(key_id, error, "Failed to record source use");
                }
            }
            .instrument(span),
        );
    }

    /// Stamps why a token source's request was refused, at most once a minute per source and
    /// off the request path, so its health turns Failing until data is accepted again.
    fn note_source_rejection(&self, resolved: &ResolvedIngestKey, reason: String) {
        let Some(source) = &resolved.source else {
            return;
        };
        if self.recent_key_rejections.contains_key(&source.id) {
            return;
        }
        let store = Arc::clone(&self.store);
        let recent = self.recent_key_rejections.clone();
        let key_id = source.id.clone();
        let span = tracing::info_span!(parent: None, "record_source_rejection");
        span.follows_from(Span::current().id());
        tokio::spawn(
            async move {
                if !recent.entry(key_id.clone()).or_insert(()).await.is_fresh() {
                    return;
                }
                if let Err(error) = store
                    .record_source_rejected(&key_id, current_time_millis(), &reason)
                    .await
                {
                    debug!(key_id, error, "Failed to record source rejection");
                }
            }
            .instrument(span),
        );
    }

    #[hotpath::measure]
    async fn resolve_ingest_key(&self, raw_key: &str) -> Result<Option<ResolvedIngestKey>, String> {
        // `raw_key` is already normalized by `extract_ingest_key`, so no header
        // spelling the edge rule misses can carry a blocked key past this.
        if self.blocked_keys.contains(raw_key) {
            return Ok(None);
        }
        // Recorded on `ingest.authenticate` when this runs under the HTTP path;
        // a no-op elsewhere (the field is only declared on that span).
        if let Some(identity) = self.cache.get(raw_key).await {
            Span::current().record("maple.ingest.cache_hit", true);
            let routing = self.routing.resolve_org_routing(&identity.org_id).await?;
            return Ok(Some(identity.into_resolved(&routing)));
        }
        Span::current().record("maple.ingest.cache_hit", false);

        if self.negative_cache.get(raw_key).await.is_some() {
            return Ok(None);
        }

        let key_type = infer_ingest_key_type(raw_key);
        let Some(key_type) = key_type else {
            return Ok(None);
        };

        let key_hash = hash_ingest_key(raw_key, &self.lookup_hmac_key)?;

        // LEFT JOIN against org_clickhouse_settings so the initial routing state
        // is resolved in the same roundtrip as org_id. Warm auth-cache hits keep
        // the key identity cached while the separate org-routing cache refreshes
        // ClickHouse readiness on its own TTL.
        let found = match key_type {
            IngestKeyType::Public | IngestKeyType::Private => {
                let hash_column = if matches!(key_type, IngestKeyType::Public) {
                    "public_key_hash"
                } else {
                    "private_key_hash"
                };
                self.store
                    .fetch_ingest_key(&key_hash, hash_column)
                    .await?
                    .map(|row| (row.key, None, row.default_source_id))
            }
            IngestKeyType::Source => self
                .store
                .fetch_source_by_token_hash(&key_hash)
                .await?
                .map(|row| (row.key, row.config, None)),
            IngestKeyType::Connector => return Ok(None),
        };
        let Some((row, source_config_row, default_source_id)) = found else {
            // Only a genuine "no row" is cached — store errors surface above and
            // must stay retryable.
            self.negative_cache.insert(raw_key.to_owned(), ()).await;
            return Ok(None);
        };

        let routing = OrgRouting::from_key_row(&row);
        // Read with the key and cached with it; a missing row stamps nothing.
        let default_source = default_source_id.and_then(SourceRef::from_id);
        let identity = IngestKeyIdentity {
            org_id: row.org_id.clone(),
            key_type,
            key_id: key_hash.chars().take(16).collect(),
            source: source_config_row
                .as_ref()
                .map(|config| Arc::new(SourcePolicy::from_row(config))),
            default_source,
        };

        self.cache
            .insert(raw_key.to_owned(), identity.clone())
            .await;
        self.routing
            .remember_org_routing(&identity.org_id, routing.clone())
            .await;

        Ok(Some(identity.into_resolved(&routing)))
    }
}

impl CloudflareConnectorResolver {
    async fn resolve_connector(
        &self,
        connector_id: &str,
        raw_secret: &str,
    ) -> Result<Option<ResolvedCloudflareConnector>, String> {
        let cache_key = format!("{connector_id}:{raw_secret}");
        if let Some(identity) = self.cache.get(&cache_key).await {
            let routing = self.routing.resolve_org_routing(&identity.org_id).await?;
            return Ok(Some(identity.into_resolved(&routing)));
        }

        let secret_hash = hash_ingest_key(raw_secret, &self.lookup_hmac_key)?;
        let Some(row) = self
            .store
            .fetch_connector(connector_id, &secret_hash)
            .await?
        else {
            return Ok(None);
        };

        let routing = OrgRouting::from_connector_row(&row);
        let (source, source_pause) = PullSourceRow::stamped(row.source);
        let identity = CloudflareConnectorIdentity {
            connector_id: connector_id.to_owned(),
            org_id: row.org_id.clone(),
            service_name: row.service_name,
            zone_name: row.zone_name,
            dataset: row.dataset,
            secret_key_id: secret_hash.chars().take(16).collect(),
            source,
            source_pause,
        };

        self.cache.insert(cache_key, identity.clone()).await;
        self.routing
            .remember_org_routing(&identity.org_id, routing.clone())
            .await;

        Ok(Some(identity.into_resolved(&routing)))
    }

    /// Connector health bookkeeping is best-effort: every caller is on a path
    /// that has already decided the request's outcome, so a failed write is
    /// logged here rather than propagated.
    async fn record_success(&self, connector_id: &str) {
        if let Err(error) = self
            .store
            .record_connector_success(
                CLOUDFLARE_CONNECTORS_TABLE,
                connector_id,
                current_time_millis(),
            )
            .await
        {
            debug!(connector_id, error, "Failed to record connector success");
        }
    }

    async fn record_failure(&self, connector_id: &str, error_message: &str) {
        if let Err(error) = self
            .store
            .record_connector_failure(
                CLOUDFLARE_CONNECTORS_TABLE,
                connector_id,
                error_message,
                current_time_millis(),
            )
            .await
        {
            debug!(connector_id, error, "Failed to record connector failure");
        }
    }
}

impl GcpConnectorResolver {
    fn new(
        store: Arc<dyn KeyStore>,
        lookup_hmac_key: String,
        routing: Arc<OrgRoutingResolver>,
        cache_ttl: Duration,
        push_auth: GooglePushAuth,
    ) -> Self {
        Self {
            store,
            lookup_hmac_key,
            cache: Cache::builder()
                .time_to_live(cache_ttl)
                .max_capacity(10_000)
                .build(),
            negative_cache: Cache::builder()
                .time_to_live(Duration::from_secs(30))
                .max_capacity(10_000)
                .build(),
            routing,
            recent_health_writes: Cache::builder()
                .time_to_live(GCP_CONNECTOR_HEALTH_WRITE_INTERVAL)
                .max_capacity(20_000)
                .build(),
            // The TTL runs from the first report, so each entry is one window.
            recent_setup_reports: Cache::builder()
                .time_to_live(GCP_SETUP_REPORT_WINDOW)
                .max_capacity(10_000)
                .build(),
            push_auth,
        }
    }

    /// Whether this connector may write another setup report in this window.
    async fn take_setup_report_slot(&self, connector_id: &str) -> bool {
        let count = self
            .recent_setup_reports
            .get_with_by_ref(connector_id, async { Arc::new(AtomicU32::new(0)) })
            .await;
        count.fetch_add(1, Ordering::Relaxed) < GCP_SETUP_REPORTS_PER_WINDOW
    }

    async fn resolve_connector(
        &self,
        connector_id: &str,
        raw_secret: &str,
    ) -> Result<Option<ResolvedGcpConnector>, String> {
        let secret_hash = hash_ingest_key(raw_secret, &self.lookup_hmac_key)?;
        let cache_key = (connector_id.to_owned(), secret_hash);
        if let Some(identity) = self.cache.get(&cache_key).await {
            let routing = self.routing.resolve_org_routing(&identity.org_id).await?;
            return Ok(Some(identity.into_resolved(&routing)));
        }
        if self.negative_cache.contains_key(&cache_key) {
            return Ok(None);
        }

        let Some(row) = self
            .store
            .fetch_gcp_connector(connector_id, &cache_key.1)
            .await?
        else {
            self.negative_cache.insert(cache_key, ()).await;
            return Ok(None);
        };

        let routing = OrgRouting {
            self_managed: row.self_managed,
            clickhouse_ready: row.clickhouse_ready,
        };
        let (source, source_pause) = PullSourceRow::stamped(row.source);
        let identity = GcpConnectorIdentity {
            org_id: row.org_id,
            secret_key_id: cache_key.1.chars().take(16).collect(),
            logs_enabled: row.logs_enabled,
            confirms_log_forwarding: false,
            source,
            source_pause,
        };

        self.cache.insert(cache_key, identity.clone()).await;
        self.routing
            .remember_org_routing(&identity.org_id, routing.clone())
            .await;

        Ok(Some(identity.into_resolved(&routing)))
    }

    /// A push Pub/Sub signed as the connector's push service account, for an
    /// audience naming this connector. `Err` only when Google's keys can't be
    /// fetched, which a redelivery may get past.
    async fn resolve_connector_by_token(
        &self,
        connector_id: &str,
        token: &str,
    ) -> Result<Option<ResolvedGcpConnector>, String> {
        let now_secs = u64::try_from(current_time_millis() / 1000).unwrap_or_default();
        let push = match self.push_auth.verify(token, now_secs).await {
            Ok(push) => push,
            Err(PushAuthError::Invalid(reason)) => {
                debug!(connector_id, reason, "GCP push token refused");
                return Ok(None);
            }
            Err(PushAuthError::KeysUnavailable(error)) => return Err(error),
        };
        // The audience is the receiver URL; its host is whatever the
        // subscription was given, the path names the connector.
        let audience_path = url::Url::parse(&push.audience)
            .map(|url| url.path().to_owned())
            .unwrap_or_default();
        if audience_path != format!("/v1/logpush/gcp/{connector_id}") {
            debug!(connector_id, "GCP push token is for another audience");
            return Ok(None);
        }

        let cache_key = (connector_id.to_owned(), format!("oidc:{}", push.email));
        if let Some(identity) = self.cache.get(&cache_key).await {
            let routing = self.routing.resolve_org_routing(&identity.org_id).await?;
            return Ok(Some(identity.into_resolved(&routing)));
        }
        if self.negative_cache.contains_key(&cache_key) {
            return Ok(None);
        }
        let row = self
            .store
            .fetch_gcp_connector_by_id(connector_id)
            .await?
            .filter(|row| push.email == gcp_push_service_account(connector_id, &row.project_id));
        let Some(row) = row else {
            self.negative_cache.insert(cache_key, ()).await;
            return Ok(None);
        };

        let (source, source_pause) = PullSourceRow::stamped(row.source);
        let routing = OrgRouting {
            self_managed: row.self_managed,
            clickhouse_ready: row.clickhouse_ready,
        };
        let identity = GcpConnectorIdentity {
            org_id: row.org_id,
            // Names the signing account, as a secret's hash prefix names the secret.
            secret_key_id: push.email.chars().take(16).collect(),
            logs_enabled: row.logs_enabled,
            confirms_log_forwarding: row.applied_logs_enabled.is_none(),
            source,
            source_pause,
        };
        self.cache.insert(cache_key, identity.clone()).await;
        self.routing
            .remember_org_routing(&identity.org_id, routing.clone())
            .await;
        Ok(Some(identity.into_resolved(&routing)))
    }

    /// Records log forwarding as set up, once. The cached identities stop
    /// asking first, so a busy sink writes once rather than once per entry
    /// until the write lands; a failed write lets a later push try again.
    async fn confirm_log_forwarding(&self, connector_id: &str) {
        // Collected first: the cache's iterator is not held across an await.
        let pending: Vec<_> = self
            .cache
            .iter()
            .filter(|(key, identity)| key.0 == connector_id && identity.confirms_log_forwarding)
            .collect();
        for (key, identity) in &pending {
            let confirmed = GcpConnectorIdentity {
                confirms_log_forwarding: false,
                ..identity.clone()
            };
            self.cache.insert((**key).clone(), confirmed).await;
        }
        let report = gcp_logging::SetupReport {
            logs: Some(true),
            metrics: None,
        };
        if let Err(error) = self
            .store
            .record_gcp_setup_report(connector_id, report, current_time_millis())
            .await
        {
            warn!(error = %error, connector_id, "Failed to record GCP log forwarding as set up");
            for (key, _) in &pending {
                self.cache.invalidate(&**key).await;
            }
        }
    }

    /// Writes `last_received_at` (`error == None`) or `last_error`, at most
    /// once per connector and outcome per interval. Best-effort: the request's
    /// outcome is already decided, so a failed write is only logged.
    ///
    /// A written failure lets the next success through, so the error does not
    /// outlive the entry Pub/Sub delivers again: at most one failure and two
    /// successes are written per interval.
    async fn record_health(&self, connector_id: &str, error: Option<&str>) {
        let throttle_key = (connector_id.to_owned(), error.is_none());
        let throttle = self.recent_health_writes.entry(throttle_key).or_insert(());
        if !throttle.await.is_fresh() {
            return;
        }

        let now_ms = current_time_millis();
        let written = match error {
            None => {
                self.store
                    .record_connector_success(GCP_CONNECTORS_TABLE, connector_id, now_ms)
                    .await
            }
            Some(error) => {
                self.recent_health_writes
                    .invalidate(&(connector_id.to_owned(), true))
                    .await;
                self.store
                    .record_connector_failure(GCP_CONNECTORS_TABLE, connector_id, error, now_ms)
                    .await
            }
        };
        if let Err(error) = written {
            debug!(connector_id, error, "Failed to record GCP connector health");
        }
    }
}

impl AwsConnectionResolver {
    fn new(
        store: Arc<dyn KeyStore>,
        lookup_hmac_key: String,
        routing: Arc<OrgRoutingResolver>,
        cache_ttl: Duration,
    ) -> Self {
        Self {
            store,
            lookup_hmac_key,
            cache: Cache::builder()
                .time_to_live(cache_ttl)
                .max_capacity(10_000)
                .build(),
            negative_cache: Cache::builder()
                .time_to_live(Duration::from_secs(30))
                .max_capacity(10_000)
                .build(),
            routing,
            recent_health_writes: Cache::builder()
                .time_to_live(AWS_STREAM_HEALTH_WRITE_INTERVAL)
                .max_capacity(20_000)
                .build(),
        }
    }

    async fn resolve_connection(
        &self,
        connection_id: &str,
        raw_secret: &str,
    ) -> Result<Option<ResolvedAwsConnection>, String> {
        let secret_hash = hash_ingest_key(raw_secret, &self.lookup_hmac_key)?;
        let cache_key = (connection_id.to_owned(), secret_hash);
        if let Some(identity) = self.cache.get(&cache_key).await {
            let routing = self.routing.resolve_org_routing(&identity.org_id).await?;
            return Ok(Some(identity.into_resolved(&routing)));
        }
        if self.negative_cache.contains_key(&cache_key) {
            return Ok(None);
        }

        let Some(row) = self
            .store
            .fetch_aws_connection(connection_id, &cache_key.1)
            .await?
        else {
            self.negative_cache.insert(cache_key, ()).await;
            return Ok(None);
        };

        let routing = OrgRouting {
            self_managed: row.self_managed,
            clickhouse_ready: row.clickhouse_ready,
        };
        let (source, source_pause) = PullSourceRow::stamped(row.source);
        let identity = AwsConnectionIdentity {
            org_id: row.org_id,
            secret_key_id: cache_key.1.chars().take(16).collect(),
            source,
            source_pause,
        };

        self.cache.insert(cache_key, identity.clone()).await;
        self.routing
            .remember_org_routing(&identity.org_id, routing.clone())
            .await;

        Ok(Some(identity.into_resolved(&routing)))
    }

    /// Writes `stream_last_received_at` (`error == None`) or `stream_last_error`,
    /// at most once per connection and outcome per interval. Best-effort, like
    /// `GcpConnectorResolver::record_health`: a written failure lets the next
    /// success through so the error does not outlive the retried delivery.
    async fn record_health(&self, connection_id: &str, error: Option<&str>) {
        let throttle_key = (connection_id.to_owned(), error.is_none());
        let throttle = self.recent_health_writes.entry(throttle_key).or_insert(());
        if !throttle.await.is_fresh() {
            return;
        }
        if error.is_some() {
            self.recent_health_writes
                .invalidate(&(connection_id.to_owned(), true))
                .await;
        }
        if let Err(write_error) = self
            .store
            .record_aws_stream_health(connection_id, error, current_time_millis())
            .await
        {
            debug!(
                connection_id,
                error = write_error,
                "Failed to record AWS stream health"
            );
        }
    }
}

impl SamplingPolicyResolver {
    #[hotpath::measure]
    async fn resolve_policy(&self, org_id: &str) -> SamplingPolicy {
        if let Some(policy) = self.cache.get(org_id).await {
            return policy;
        }

        let policy = match self.store.fetch_sampling_policy(org_id).await {
            Ok(Some(row)) => SamplingPolicy {
                trace_sample_ratio: row.trace_sample_ratio,
                always_keep_error_spans: row.always_keep_error_spans,
                always_keep_slow_spans_ms: row.always_keep_slow_spans_ms,
            },
            Ok(None) => SamplingPolicy::default(),
            Err(error) => {
                warn!(
                    org_id,
                    error = %error,
                    "Sampling policy lookup failed; using unsampled default"
                );
                SamplingPolicy::default()
            }
        };
        self.cache.insert(org_id.to_owned(), policy.clone()).await;
        policy
    }
}

/// Translates a stored mapping row into a usable rule, dropping rows whose
/// `source_context` / `operation` strings fall outside the known enums.
fn parse_attribute_mapping_row(row: AttributeMappingRow) -> Option<AttributeMappingRule> {
    let source_context = match row.source_context.as_str() {
        "span" => MappingSourceContext::Span,
        "resource" => MappingSourceContext::Resource,
        other => {
            warn!(
                source_context = other,
                "Skipping attribute mapping with unknown source context"
            );
            return None;
        }
    };
    let operation = match row.operation.as_str() {
        "move" => MappingOperation::Move,
        "copy" => MappingOperation::Copy,
        other => {
            warn!(
                operation = other,
                "Skipping attribute mapping with unknown operation"
            );
            return None;
        }
    };
    Some(AttributeMappingRule {
        source_context,
        source_key: row.source_key,
        target_key: row.target_key,
        operation,
    })
}

impl AttributeMappingResolver {
    #[hotpath::measure]
    async fn resolve_mappings(&self, org_id: &str) -> Arc<Vec<AttributeMappingRule>> {
        if let Some(rules) = self.cache.get(org_id).await {
            return rules;
        }

        let rules = match self.store.fetch_attribute_mappings(org_id).await {
            Ok(rows) => Arc::new(
                rows.into_iter()
                    .filter_map(parse_attribute_mapping_row)
                    .collect::<Vec<_>>(),
            ),
            Err(error) => {
                warn!(
                    org_id,
                    error = %error,
                    "Attribute mapping lookup failed; ingesting without remapping"
                );
                Arc::new(Vec::new())
            }
        };
        self.cache
            .insert(org_id.to_owned(), Arc::clone(&rules))
            .await;
        rules
    }
}

/// The schema revision this binary needs an org's ClickHouse to be at, as a
/// number. Non-numeric (legacy hash) revisions parse to 0, which is older than
/// every real migration — the same "not ready" answer they get today.
fn required_schema_revision() -> i32 {
    CLICKHOUSE_SCHEMA_VERSION.parse().unwrap_or(0)
}

/// Is an org's stamped schema revision new enough for this binary to write to?
///
/// Deliberately `>=` rather than `==`. Migrations only ever add columns or widen
/// types, and every INSERT names its columns explicitly, so an older binary
/// writing into a newer schema is safe — the columns it doesn't know about take
/// their DEFAULT. Equality instead made *any* skew a routing change: between
/// stamping an org at the new revision and rolling out the matching binary, the
/// org fell back to Tinybird and its own ClickHouse silently missed that window.
/// With `>=` the org keeps writing to its own cluster throughout the rollout.
///
/// The comparison is numeric on purpose: these are stored as text, and as text
/// "12" sorts before "9", so a string `>=` would strand every org.
fn schema_revision_is_compatible(stamped: &str) -> bool {
    schema_revision_at_least(stamped, required_schema_revision())
}

/// The comparison itself, with `needed` passed in so it is testable without
/// depending on whatever revision this binary happens to be pinned to.
fn schema_revision_at_least(stamped: &str, needed: i32) -> bool {
    stamped.parse::<i32>().unwrap_or(-1) >= needed
}

/// SQL predicate matching `schema_revision_is_compatible`, for the routing
/// queries. Kept next to it so the two can never drift — if they disagree,
/// routing sends frames down the ClickHouse path that the target resolver then
/// refuses, and the export worker drops the batch.
///
/// `CASE` rather than `regex AND cast`: legacy revisions were content hashes,
/// and `'2967fa9b'::int` raises rather than returning false. Postgres does not
/// promise to evaluate `AND` left-to-right — it may reorder on cost, and a
/// regex match costs more than a cast — so the guard has to be `CASE`, which
/// *is* defined to short-circuit. Getting this wrong fails the whole query,
/// which would take down every ingest-key lookup, not just one org's routing.
const SCHEMA_REVISION_COMPATIBLE_SQL: &str =
    "(CASE WHEN s.schema_version ~ '^[0-9]+$' THEN s.schema_version::int ELSE -1 END >= $1)";

/// A `GcpConnectorRow`'s columns over `gcp_connectors c` joined to
/// `org_clickhouse_settings s`, with the schema revision as `$1`.
fn gcp_connector_columns() -> String {
    format!(
        "c.org_id, c.project_id, c.logs_enabled, c.applied_logs_enabled, \
         COALESCE(s.sync_status = 'connected', false) AS self_managed, \
         COALESCE(s.sync_status = 'connected' AND {SCHEMA_REVISION_COMPATIBLE_SQL}, false) AS clickhouse_ready, \
         {CONNECTOR_SOURCE_COLUMNS}"
    )
}

/// A connector `c`'s own source, read in the connector's query: all null without one.
const CONNECTOR_SOURCE_JOIN: &str =
    "LEFT JOIN sources src ON src.id = c.source_id AND src.org_id = c.org_id";
const CONNECTOR_SOURCE_COLUMNS: &str = "src.id AS source_id, \
    (EXTRACT(EPOCH FROM src.paused_at) * 1000)::bigint AS source_paused_at_ms, \
    (EXTRACT(EPOCH FROM src.paused_until) * 1000)::bigint AS source_paused_until_ms";

fn connector_source(row: &tokio_postgres::Row) -> Option<PullSourceRow> {
    let id: Option<String> = row.get("source_id");
    id.map(|id| PullSourceRow {
        id,
        pause: PauseWindow {
            paused_at_ms: row.get("source_paused_at_ms"),
            paused_until_ms: row.get("source_paused_until_ms"),
        },
    })
}

/// A `PullSourceRow`'s columns over `sources`.
const PULL_SOURCE_COLUMNS: &str = "id, \
    (EXTRACT(EPOCH FROM paused_at) * 1000)::bigint AS paused_at_ms, \
    (EXTRACT(EPOCH FROM paused_until) * 1000)::bigint AS paused_until_ms";

fn pull_source_row(row: &tokio_postgres::Row) -> Result<PullSourceRow, String> {
    let decode_error =
        |error: tokio_postgres::Error| format!("postgres pull source row decode failed: {error}");
    Ok(PullSourceRow {
        id: row.try_get("id").map_err(decode_error)?,
        pause: PauseWindow {
            paused_at_ms: row.try_get("paused_at_ms").map_err(decode_error)?,
            paused_until_ms: row.try_get("paused_until_ms").map_err(decode_error)?,
        },
    })
}

fn gcp_connector_row(row: &tokio_postgres::Row) -> GcpConnectorRow {
    GcpConnectorRow {
        org_id: row.get("org_id"),
        project_id: row.get("project_id"),
        logs_enabled: row.get("logs_enabled"),
        applied_logs_enabled: row.get("applied_logs_enabled"),
        self_managed: row.get("self_managed"),
        clickhouse_ready: row.get("clickhouse_ready"),
        source: connector_source(row),
    }
}

#[async_trait::async_trait]
impl ClickHouseTargetProvider for ClickHouseTargetResolver {
    async fn resolve_clickhouse_target(
        &self,
        org_id: &str,
    ) -> Result<Option<ClickHouseTarget>, String> {
        if let Some(target) = self.cache.get(org_id).await {
            return Ok(Some(target));
        }
        // Checked after the positive cache so a resolvable org never pays for it.
        if self.negative_cache.get(org_id).await.is_some() {
            return Ok(None);
        }

        let Some(row) = self.store.fetch_clickhouse_target(org_id).await? else {
            self.negative_cache.insert(org_id.to_owned(), ()).await;
            return Ok(None);
        };
        if !schema_revision_is_compatible(&row.schema_version) {
            self.negative_cache.insert(org_id.to_owned(), ()).await;
            return Ok(None);
        }

        let password = match (
            row.ch_password_ciphertext.as_deref(),
            row.ch_password_iv.as_deref(),
            row.ch_password_tag.as_deref(),
        ) {
            (Some(ciphertext), Some(iv), Some(tag)) => {
                let key = self.encryption_key.as_ref().ok_or_else(|| {
                    "MAPLE_INGEST_KEY_ENCRYPTION_KEY is required to decrypt ClickHouse credentials".to_owned()
                })?;
                decrypt_aes256_gcm(ciphertext, iv, tag, key)?
            }
            (None, None, None) => String::new(),
            _ => {
                return Err(
                    "ClickHouse password encryption fields must be all present or all null"
                        .to_owned(),
                )
            }
        };

        let target = ClickHouseTarget {
            endpoint: row.ch_url.trim().trim_end_matches('/').to_owned(),
            user: row.ch_user,
            password,
            database: row.ch_database,
        };
        if target.endpoint.is_empty() || target.user.is_empty() || target.database.is_empty() {
            return Err("ClickHouse target is missing url, user, or database".to_owned());
        }
        let endpoint_url = url::Url::parse(&target.endpoint)
            .map_err(|error| format!("ClickHouse target endpoint URL is invalid: {error}"))?;
        if !target.password.is_empty() && endpoint_url.scheme() != "https" {
            return Err(
                "ClickHouse target endpoint must use https when a password is configured"
                    .to_owned(),
            );
        }
        self.cache.insert(org_id.to_owned(), target.clone()).await;
        Ok(Some(target))
    }
}

/// PlanetScale Postgres-backed KeyStore. A pooled direct connection (PSBouncer
/// 6432, no Hyperdrive — Railway dials PlanetScale). Uses `$N` placeholders,
/// native booleans, and `to_timestamp()` for the epoch-ms connector timestamps
/// (those columns are `timestamptz`). A 60s in-process cache and HMAC
/// fingerprinting sit upstream.
struct PostgresKeyStore {
    pool: deadpool_postgres::Pool,
    /// Target identity for the DB client spans, read off the parsed connection
    /// string once at startup. Without a `db.namespace` these spans collapse
    /// into the per-system generic node on the service map instead of naming
    /// the database they actually hit.
    target: PostgresTarget,
}

/// The `db.namespace` / `server.address` / `server.port` of the configured
/// origin. Derived from `MAPLE_PG_URL` rather than hardcoded so self-hosted and
/// local deployments report the database they really talk to.
#[derive(Clone, Debug, Default)]
struct PostgresTarget {
    namespace: String,
    address: String,
    port: u16,
}

impl PostgresTarget {
    fn from_config(config: &tokio_postgres::Config) -> Self {
        let address = match config.get_hosts().first() {
            Some(tokio_postgres::config::Host::Tcp(host)) => host.clone(),
            Some(tokio_postgres::config::Host::Unix(path)) => path.to_string_lossy().into_owned(),
            None => String::new(),
        };
        Self {
            namespace: config.get_dbname().unwrap_or_default().to_owned(),
            address,
            port: config.get_ports().first().copied().unwrap_or_default(),
        }
    }
}

/// One multi-row upsert adding counts into `org_ingest_rule_stats`; 8 parameters per row.
/// Rows must have distinct keys, or Postgres refuses to update a row twice.
fn ingest_rule_stats_upsert_sql(rows: usize) -> String {
    let mut sql = String::from(
        "INSERT INTO org_ingest_rule_stats \
         (org_id, rule_id, bucket, signal, matched, dropped, dropped_bytes, redacted_values) VALUES ",
    );
    for row in 0..rows {
        let p = row * 8;
        if row > 0 {
            sql.push_str(", ");
        }
        sql.push_str(&format!(
            "(${}, ${}, to_timestamp(${}::bigint / 1000.0), ${}, ${}::bigint, ${}::bigint, ${}::bigint, ${}::bigint)",
            p + 1,
            p + 2,
            p + 3,
            p + 4,
            p + 5,
            p + 6,
            p + 7,
            p + 8
        ));
    }
    sql.push_str(
        " ON CONFLICT (org_id, rule_id, bucket, signal) DO UPDATE SET \
         matched = org_ingest_rule_stats.matched + EXCLUDED.matched, \
         dropped = org_ingest_rule_stats.dropped + EXCLUDED.dropped, \
         dropped_bytes = org_ingest_rule_stats.dropped_bytes + EXCLUDED.dropped_bytes, \
         redacted_values = org_ingest_rule_stats.redacted_values + EXCLUDED.redacted_values",
    );
    sql
}

/// One Postgres client span.
///
/// `operation`/`collection` are the SQL verb and primary table, NOT the Rust
/// method name: `db.operation.name` composes with `db.collection.name` into the
/// query-shape label the warehouse groups on, so a method name there produces a
/// label like "fetch_ingest_key" that no SQL-shaped view can line up with the
/// same table hit from the API. The method name rides on `code.function.name`,
/// which keeps existing log/dashboard filters working.
fn postgres_client_span(
    method: &'static str,
    operation: &'static str,
    collection: &'static str,
    target: &PostgresTarget,
) -> Span {
    tracing::info_span!(
        "postgres.query",
        otel.kind = "client",
        "db.system.name" = "postgresql",
        "db.operation.name" = operation,
        "db.collection.name" = collection,
        "db.namespace" = %target.namespace,
        "server.address" = %target.address,
        "server.port" = target.port,
        "code.function.name" = method,
        "peer.service" = "planetscale-postgres",
    )
}

/// Flatten an error's source chain into one line.
///
/// `tokio_postgres::Error`'s `Display` is the bare string "db error" — the
/// SQLSTATE, the pooler's rejection reason, the TLS failure all live in
/// `source()`. During the 2026-08-09 outage every log line read
/// `fetch_ingest_key failed: db error`, which could not distinguish a refused
/// connection from exhausted pooler slots from rejected credentials.
fn error_chain(error: &(dyn std::error::Error + 'static)) -> String {
    let mut parts = vec![error.to_string()];
    let mut source = error.source();
    while let Some(inner) = source {
        parts.push(inner.to_string());
        source = inner.source();
    }
    parts.join(": ")
}

impl PostgresKeyStore {
    fn new(url: &str) -> Result<Self, String> {
        let pg_config = url
            .parse::<tokio_postgres::Config>()
            .map_err(|error| format!("invalid MAPLE_PG_URL: {error}"))?;

        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let tls_config = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|error| format!("rustls config failed: {error}"))?
            .with_root_certificates(roots)
            .with_no_client_auth();
        let tls = tokio_postgres_rustls::MakeRustlsConnect::new(tls_config);

        // Read the target identity before the config is moved into the manager.
        let target = PostgresTarget::from_config(&pg_config);

        let mgr = deadpool_postgres::Manager::from_config(
            pg_config,
            tls,
            deadpool_postgres::ManagerConfig {
                recycling_method: deadpool_postgres::RecyclingMethod::Fast,
            },
        );
        let pool = deadpool_postgres::Pool::builder(mgr)
            .max_size(8)
            .build()
            .map_err(|error| format!("postgres pool build failed: {error}"))?;

        Ok(Self { pool, target })
    }

    async fn client(&self) -> Result<deadpool_postgres::Object, String> {
        self.pool
            .get()
            .await
            .map_err(|error| format!("postgres pool checkout failed: {}", error_chain(&error)))
    }

    /// Startup gate — runs the production lookup query with a stub hash so any
    /// auth/schema/network/TLS issue exits the process instead of 503'ing every
    /// request.
    async fn probe(&self) -> Result<(), String> {
        let client = self.client().await?;
        client
            .query(
                // Exercises the routing join used by production lookups.
                "SELECT k.org_id, \
                        COALESCE(s.sync_status = 'connected', false) AS self_managed \
                 FROM org_ingest_keys k \
                 LEFT JOIN org_clickhouse_settings s ON s.org_id = k.org_id \
                 WHERE k.private_key_hash = $1 LIMIT 1",
                &[&"__ingest_probe_no_match__"],
            )
            .instrument(postgres_client_span(
                "probe",
                "SELECT",
                "org_ingest_keys",
                &self.target,
            ))
            .await
            .map(|_| ())
            .map_err(|error| format!("postgres probe query failed: {}", error_chain(&error)))
    }
}

#[async_trait::async_trait]
impl KeyStore for PostgresKeyStore {
    async fn fetch_ingest_key(
        &self,
        key_hash: &str,
        hash_column: &'static str,
    ) -> Result<Option<OrgKeyRow>, String> {
        // hash_column is a compile-time constant chosen by the resolver, never
        // user input, so safe to interpolate. The default source rides the same row.
        let revision = required_schema_revision();
        let sql = format!(
            "SELECT k.org_id, \
                    COALESCE(s.sync_status = 'connected', false) AS self_managed, \
                    COALESCE(s.sync_status = 'connected' AND {SCHEMA_REVISION_COMPATIBLE_SQL}, false) AS clickhouse_ready, \
                    ds.id AS default_source_id \
             FROM org_ingest_keys k \
             LEFT JOIN org_clickhouse_settings s ON s.org_id = k.org_id \
             LEFT JOIN sources ds ON ds.org_id = k.org_id AND ds.kind = 'default' \
             WHERE k.{hash_column} = $2 LIMIT 1"
        );
        let client = self.client().await?;
        let rows = client
            .query(&sql, &[&revision, &key_hash])
            .instrument(postgres_client_span(
                "fetch_ingest_key",
                "SELECT",
                "org_ingest_keys",
                &self.target,
            ))
            .await
            .map_err(|error| {
                format!("postgres fetch_ingest_key failed: {}", error_chain(&error))
            })?;
        let Some(row) = rows.into_iter().next() else {
            return Ok(None);
        };
        Ok(Some(OrgKeyRow {
            key: KeyRow {
                org_id: row.get("org_id"),
                self_managed: row.get("self_managed"),
                clickhouse_ready: row.get("clickhouse_ready"),
            },
            default_source_id: row.get("default_source_id"),
        }))
    }

    async fn fetch_source_by_token_hash(
        &self,
        key_hash: &str,
    ) -> Result<Option<SourceRow>, String> {
        // jsonb read as text: tokio-postgres here has no serde feature.
        let revision = required_schema_revision();
        let sql = format!(
            "SELECT k.id, k.org_id, \
                    k.allowed_signals::text AS allowed_signals, \
                    k.rate_limit_rps, \
                    k.resource_attributes::text AS resource_attributes, \
                    (EXTRACT(EPOCH FROM k.expires_at) * 1000)::bigint AS expires_at_ms, \
                    (EXTRACT(EPOCH FROM k.paused_at) * 1000)::bigint AS paused_at_ms, \
                    (EXTRACT(EPOCH FROM k.paused_until) * 1000)::bigint AS paused_until_ms, \
                    COALESCE(s.sync_status = 'connected', false) AS self_managed, \
                    COALESCE(s.sync_status = 'connected' AND {SCHEMA_REVISION_COMPATIBLE_SQL}, false) AS clickhouse_ready \
             FROM sources k \
             LEFT JOIN org_clickhouse_settings s ON s.org_id = k.org_id \
             WHERE k.key_hash = $2 AND k.key_hash IS NOT NULL LIMIT 1"
        );
        let client = self.client().await?;
        let rows = client
            .query(&sql, &[&revision, &key_hash])
            .instrument(postgres_client_span(
                "fetch_source_by_token_hash",
                "SELECT",
                "sources",
                &self.target,
            ))
            .await
            .map_err(|error| {
                format!(
                    "postgres fetch_source_by_token_hash failed: {}",
                    error_chain(&error)
                )
            })?;
        let Some(row) = rows.into_iter().next() else {
            return Ok(None);
        };
        let decode_error =
            |error: tokio_postgres::Error| format!("postgres source row decode failed: {error}");
        let config = SourceConfigRow {
            id: row.try_get("id").map_err(decode_error)?,
            allowed_signals_json: row.try_get("allowed_signals").map_err(decode_error)?,
            rate_limit_rps: row.try_get("rate_limit_rps").map_err(decode_error)?,
            resource_attributes_json: row
                .try_get::<_, Option<String>>("resource_attributes")
                .map_err(decode_error)?
                .unwrap_or_default(),
            expires_at_ms: row.try_get("expires_at_ms").map_err(decode_error)?,
            paused_at_ms: row.try_get("paused_at_ms").map_err(decode_error)?,
            paused_until_ms: row.try_get("paused_until_ms").map_err(decode_error)?,
        };
        Ok(Some(SourceRow {
            key: KeyRow {
                org_id: row.try_get("org_id").map_err(decode_error)?,
                self_managed: row.try_get("self_managed").map_err(decode_error)?,
                clickhouse_ready: row.try_get("clickhouse_ready").map_err(decode_error)?,
            },
            config: Some(config),
        }))
    }

    async fn fetch_connector(
        &self,
        connector_id: &str,
        secret_hash: &str,
    ) -> Result<Option<ConnectorRow>, String> {
        let revision = required_schema_revision();
        let client = self.client().await?;
        let sql = format!(
            "SELECT c.org_id, c.service_name, c.zone_name, c.dataset, \
                    COALESCE(s.sync_status = 'connected', false) AS self_managed, \
                    COALESCE(s.sync_status = 'connected' AND {SCHEMA_REVISION_COMPATIBLE_SQL}, false) AS clickhouse_ready, \
                    {CONNECTOR_SOURCE_COLUMNS} \
             FROM cloudflare_logpush_connectors c \
             LEFT JOIN org_clickhouse_settings s ON s.org_id = c.org_id \
             {CONNECTOR_SOURCE_JOIN} \
             WHERE c.id = $2 AND c.secret_hash = $3 AND c.enabled = true LIMIT 1"
        );
        let rows = client
            .query(&sql, &[&revision, &connector_id, &secret_hash])
            .instrument(postgres_client_span(
                "fetch_connector",
                "SELECT",
                "cloudflare_logpush_connectors",
                &self.target,
            ))
            .await
            .map_err(|error| format!("postgres fetch_connector failed: {error}"))?;
        let Some(row) = rows.into_iter().next() else {
            return Ok(None);
        };
        Ok(Some(ConnectorRow {
            org_id: row.get("org_id"),
            service_name: row.get("service_name"),
            zone_name: row.get("zone_name"),
            dataset: row.get("dataset"),
            self_managed: row.get("self_managed"),
            clickhouse_ready: row.get("clickhouse_ready"),
            source: connector_source(&row),
        }))
    }

    async fn fetch_gcp_connector(
        &self,
        connector_id: &str,
        secret_hash: &str,
    ) -> Result<Option<GcpConnectorRow>, String> {
        let revision = required_schema_revision();
        let client = self.client().await?;
        // No `enabled` column: deleting the row is how a connector is turned off.
        let columns = gcp_connector_columns();
        let sql = format!(
            "SELECT {columns} \
             FROM gcp_connectors c \
             LEFT JOIN org_clickhouse_settings s ON s.org_id = c.org_id \
             {CONNECTOR_SOURCE_JOIN} \
             WHERE c.id = $2 AND c.secret_hash = $3 LIMIT 1"
        );
        let rows = client
            .query(&sql, &[&revision, &connector_id, &secret_hash])
            .instrument(postgres_client_span(
                "fetch_gcp_connector",
                "SELECT",
                GCP_CONNECTORS_TABLE,
                &self.target,
            ))
            .await
            .map_err(|error| format!("postgres fetch_gcp_connector failed: {error}"))?;
        Ok(rows.first().map(gcp_connector_row))
    }

    async fn fetch_gcp_connector_by_id(
        &self,
        connector_id: &str,
    ) -> Result<Option<GcpConnectorRow>, String> {
        let revision = required_schema_revision();
        let client = self.client().await?;
        let columns = gcp_connector_columns();
        let sql = format!(
            "SELECT {columns} \
             FROM gcp_connectors c \
             LEFT JOIN org_clickhouse_settings s ON s.org_id = c.org_id \
             {CONNECTOR_SOURCE_JOIN} \
             WHERE c.id = $2 LIMIT 1"
        );
        let rows = client
            .query(&sql, &[&revision, &connector_id])
            .instrument(postgres_client_span(
                "fetch_gcp_connector_by_id",
                "SELECT",
                GCP_CONNECTORS_TABLE,
                &self.target,
            ))
            .await
            .map_err(|error| format!("postgres fetch_gcp_connector_by_id failed: {error}"))?;
        Ok(rows.first().map(gcp_connector_row))
    }

    async fn fetch_sampling_policy(
        &self,
        org_id: &str,
    ) -> Result<Option<SamplingPolicyRow>, String> {
        let client = self.client().await?;
        let rows = client
            .query(
                "SELECT trace_sample_ratio, always_keep_error_spans, always_keep_slow_spans_ms \
                 FROM org_ingest_sampling_policies WHERE org_id = $1 LIMIT 1",
                &[&org_id],
            )
            .instrument(postgres_client_span(
                "fetch_sampling_policy",
                "SELECT",
                "org_ingest_sampling_policies",
                &self.target,
            ))
            .await
            .map_err(|error| format!("postgres fetch_sampling_policy failed: {error}"))?;
        let Some(row) = rows.into_iter().next() else {
            return Ok(None);
        };
        let slow_ms: Option<i32> = row.get("always_keep_slow_spans_ms");
        Ok(Some(SamplingPolicyRow {
            trace_sample_ratio: row.get("trace_sample_ratio"),
            always_keep_error_spans: row.get("always_keep_error_spans"),
            always_keep_slow_spans_ms: slow_ms.and_then(|v| u64::try_from(v).ok()),
        }))
    }

    async fn fetch_attribute_mappings(
        &self,
        org_id: &str,
    ) -> Result<Vec<AttributeMappingRow>, String> {
        let client = self.client().await?;
        let rows = client
            .query(
                "SELECT source_context, source_key, target_key, operation \
                 FROM org_ingest_attribute_mappings WHERE org_id = $1 AND enabled = true",
                &[&org_id],
            )
            .instrument(postgres_client_span(
                "fetch_attribute_mappings",
                "SELECT",
                "org_ingest_attribute_mappings",
                &self.target,
            ))
            .await
            .map_err(|error| format!("postgres fetch_attribute_mappings failed: {error}"))?;
        Ok(rows
            .into_iter()
            .map(|row| AttributeMappingRow {
                source_context: row.get("source_context"),
                source_key: row.get("source_key"),
                target_key: row.get("target_key"),
                operation: row.get("operation"),
            })
            .collect())
    }

    async fn fetch_ingest_rules(&self, org_id: &str) -> Result<IngestRuleRows, String> {
        let client = self.client().await?;
        // `spec_json::text`: tokio-postgres has no serde_json feature here, so it is parsed later.
        let rows = client
            .query(
                "SELECT r.id, r.spec_json::text AS spec_json, s.hash_salt \
                 FROM org_ingest_rules r \
                 LEFT JOIN org_ingest_rule_settings s ON s.org_id = r.org_id \
                 WHERE r.org_id = $1 AND r.enabled \
                 ORDER BY r.position, r.created_at, r.id",
                &[&org_id],
            )
            .instrument(postgres_client_span(
                "fetch_ingest_rules",
                "SELECT",
                "org_ingest_rules",
                &self.target,
            ))
            .await
            .map_err(|error| format!("postgres fetch_ingest_rules failed: {error}"))?;
        // NULL until the org's first hash rule is created, so nothing can hash with it yet.
        let hash_salt = rows
            .first()
            .and_then(|row| row.get::<_, Option<String>>("hash_salt"))
            .unwrap_or_default();
        Ok(IngestRuleRows {
            rules: rows
                .iter()
                .map(|row| (row.get("id"), row.get("spec_json")))
                .collect(),
            hash_salt,
        })
    }

    async fn record_ingest_rule_stats(&self, rows: &[IngestRuleStatRow]) -> Result<(), String> {
        if rows.is_empty() {
            return Ok(());
        }
        let numbers: Vec<[i64; 5]> = rows
            .iter()
            .map(|row| {
                let count = |value: u64| i64::try_from(value).unwrap_or(i64::MAX);
                [
                    row.bucket_ms,
                    count(row.counts.matched),
                    count(row.counts.dropped),
                    count(row.counts.dropped_bytes),
                    count(row.counts.redacted_values),
                ]
            })
            .collect();
        let mut params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
            Vec::with_capacity(rows.len() * 8);
        for (row, values) in rows.iter().zip(&numbers) {
            params.push(&row.org_id);
            params.push(&row.rule_id);
            params.push(&values[0]);
            params.push(&row.signal);
            params.extend(values[1..].iter().map(|value| value as &(dyn tokio_postgres::types::ToSql + Sync)));
        }
        let client = self.client().await?;
        client
            .execute(ingest_rule_stats_upsert_sql(rows.len()).as_str(), &params)
            .instrument(postgres_client_span(
                "record_ingest_rule_stats",
                "INSERT",
                "org_ingest_rule_stats",
                &self.target,
            ))
            .await
            .map_err(|error| format!("postgres record_ingest_rule_stats failed: {error}"))?;
        Ok(())
    }

    async fn fetch_clickhouse_target(
        &self,
        org_id: &str,
    ) -> Result<Option<ClickHouseTargetRow>, String> {
        let revision = required_schema_revision();
        let client = self.client().await?;
        let rows = client
            .query(
                "SELECT ch_url, ch_user, ch_password_ciphertext, ch_password_iv, ch_password_tag, \
                        ch_database, schema_version \
                 FROM org_clickhouse_settings \
                 WHERE org_id = $1 AND sync_status = 'connected' \
                   AND CASE WHEN schema_version ~ '^[0-9]+$' \
                            THEN schema_version::int ELSE -1 END >= $2 LIMIT 1",
                &[&org_id, &revision],
            )
            .instrument(postgres_client_span(
                "fetch_clickhouse_target",
                "SELECT",
                "org_clickhouse_settings",
                &self.target,
            ))
            .await
            .map_err(|error| format!("postgres fetch_clickhouse_target failed: {error}"))?;
        let Some(row) = rows.into_iter().next() else {
            return Ok(None);
        };
        Ok(Some(ClickHouseTargetRow {
            ch_url: row.get("ch_url"),
            ch_user: row.get("ch_user"),
            ch_password_ciphertext: row.get("ch_password_ciphertext"),
            ch_password_iv: row.get("ch_password_iv"),
            ch_password_tag: row.get("ch_password_tag"),
            ch_database: row.get("ch_database"),
            schema_version: row.get("schema_version"),
        }))
    }

    async fn fetch_org_routing(&self, org_id: &str) -> Result<Option<OrgRouting>, String> {
        let revision = required_schema_revision();
        let client = self.client().await?;
        let rows = client
            .query(
                // Anchored on a one-row scalar subquery so an org without a
                // BYO-ClickHouse config still resolves to shared routing.
                &format!(
                    "SELECT COALESCE(s.sync_status = 'connected', false) AS self_managed, \
                            COALESCE(s.sync_status = 'connected' AND {SCHEMA_REVISION_COMPATIBLE_SQL}, false) AS clickhouse_ready \
                     FROM (SELECT $2::text AS org_id) o \
                     LEFT JOIN org_clickhouse_settings s ON s.org_id = o.org_id LIMIT 1"
                ),
                &[&revision, &org_id],
            )
            .instrument(postgres_client_span("fetch_org_routing", "SELECT", "org_clickhouse_settings", &self.target))
            .await
            .map_err(|error| format!("postgres fetch_org_routing failed: {error}"))?;
        let Some(row) = rows.into_iter().next() else {
            return Ok(None);
        };
        Ok(Some(OrgRouting {
            self_managed: row.get("self_managed"),
            clickhouse_ready: row.get("clickhouse_ready"),
        }))
    }

    async fn record_source_used(&self, key_id: &str, now_ms: i64) -> Result<(), String> {
        let client = self.client().await?;
        client
            .execute(
                "UPDATE sources \
                 SET last_used_at = to_timestamp($1::bigint / 1000.0) \
                 WHERE id = $2",
                &[&now_ms, &key_id],
            )
            .instrument(postgres_client_span(
                "record_source_used",
                "UPDATE",
                "sources",
                &self.target,
            ))
            .await
            .map(|_| ())
            .map_err(|error| format!("postgres record_source_used failed: {error}"))
    }

    async fn record_source_rejected(
        &self,
        key_id: &str,
        now_ms: i64,
        reason: &str,
    ) -> Result<(), String> {
        let client = self.client().await?;
        client
            .execute(
                "UPDATE sources \
                 SET last_rejected_at = to_timestamp($1::bigint / 1000.0), last_rejection = $2 \
                 WHERE id = $3",
                &[&now_ms, &reason, &key_id],
            )
            .instrument(postgres_client_span(
                "record_source_rejected",
                "UPDATE",
                "sources",
                &self.target,
            ))
            .await
            .map(|_| ())
            .map_err(|error| format!("postgres record_source_rejected failed: {error}"))
    }

    async fn claimable_source_ids(
        &self,
        org_id: &str,
        source_ids: &[String],
    ) -> Result<Vec<PullSourceRow>, String> {
        let client = self.client().await?;
        let rows = client
            .query(
                &format!(
                    "SELECT {PULL_SOURCE_COLUMNS} FROM sources \
                     WHERE org_id = $1 AND id = ANY($2) AND kind = 'integration'"
                ),
                &[&org_id, &source_ids],
            )
            .instrument(postgres_client_span(
                "claimable_source_ids",
                "SELECT",
                "sources",
                &self.target,
            ))
            .await
            .map_err(|error| format!("postgres claimable_source_ids failed: {error}"))?;
        rows.iter().map(pull_source_row).collect()
    }

    async fn record_connector_success(
        &self,
        table: &'static str,
        connector_id: &str,
        now_ms: i64,
    ) -> Result<(), String> {
        let client = self.client().await?;
        client
            .execute(
                &format!(
                    "UPDATE {table} \
                     SET last_received_at = to_timestamp($1::bigint / 1000.0), \
                         last_error = NULL, \
                         updated_at = to_timestamp($1::bigint / 1000.0) \
                     WHERE id = $2"
                ),
                &[&now_ms, &connector_id],
            )
            .instrument(postgres_client_span(
                "record_connector_success",
                "UPDATE",
                table,
                &self.target,
            ))
            .await
            .map(|_| ())
            .map_err(|error| format!("postgres record_connector_success failed: {error}"))
    }

    async fn record_connector_failure(
        &self,
        table: &'static str,
        connector_id: &str,
        error: &str,
        now_ms: i64,
    ) -> Result<(), String> {
        let client = self.client().await?;
        client
            .execute(
                &format!(
                    "UPDATE {table} \
                     SET last_error = $1, updated_at = to_timestamp($2::bigint / 1000.0) \
                     WHERE id = $3"
                ),
                &[&error, &now_ms, &connector_id],
            )
            .instrument(postgres_client_span(
                "record_connector_failure",
                "UPDATE",
                table,
                &self.target,
            ))
            .await
            .map(|_| ())
            .map_err(|err| format!("postgres record_connector_failure failed: {err}"))
    }

    async fn record_gcp_setup_report(
        &self,
        connector_id: &str,
        report: gcp_logging::SetupReport,
        now_ms: i64,
    ) -> Result<(), String> {
        let client = self.client().await?;
        // A capability the run did not report keeps what an earlier run said.
        // Log forwarding set up again answers whatever the last push failed on.
        client
            .execute(
                "UPDATE gcp_connectors \
                 SET applied_logs_enabled = COALESCE($1::boolean, applied_logs_enabled), \
                     applied_metrics_enabled = COALESCE($2::boolean, applied_metrics_enabled), \
                     setup_reported_at = to_timestamp($3::bigint / 1000.0), \
                     last_error = CASE WHEN $1::boolean THEN NULL ELSE last_error END, \
                     updated_at = to_timestamp($3::bigint / 1000.0) \
                 WHERE id = $4",
                &[&report.logs, &report.metrics, &now_ms, &connector_id],
            )
            .instrument(postgres_client_span(
                "record_gcp_setup_report",
                "UPDATE",
                GCP_CONNECTORS_TABLE,
                &self.target,
            ))
            .await
            .map(|_| ())
            .map_err(|error| format!("postgres record_gcp_setup_report failed: {error}"))
    }

    async fn fetch_aws_connection(
        &self,
        connection_id: &str,
        secret_hash: &str,
    ) -> Result<Option<AwsConnectionRow>, String> {
        let revision = required_schema_revision();
        let client = self.client().await?;
        let sql = format!(
            "SELECT c.org_id, \
             COALESCE(s.sync_status = 'connected', false) AS self_managed, \
             COALESCE(s.sync_status = 'connected' AND {SCHEMA_REVISION_COMPATIBLE_SQL}, false) AS clickhouse_ready, \
             {CONNECTOR_SOURCE_COLUMNS} \
             FROM aws_connections c \
             LEFT JOIN org_clickhouse_settings s ON s.org_id = c.org_id \
             {CONNECTOR_SOURCE_JOIN} \
             WHERE c.id = $2 AND c.stream_secret_hash = $3 LIMIT 1"
        );
        let rows = client
            .query(&sql, &[&revision, &connection_id, &secret_hash])
            .instrument(postgres_client_span(
                "fetch_aws_connection",
                "SELECT",
                AWS_CONNECTIONS_TABLE,
                &self.target,
            ))
            .await
            .map_err(|error| format!("postgres fetch_aws_connection failed: {error}"))?;
        Ok(rows.first().map(|row| AwsConnectionRow {
            org_id: row.get("org_id"),
            self_managed: row.get("self_managed"),
            clickhouse_ready: row.get("clickhouse_ready"),
            source: connector_source(row),
        }))
    }

    async fn record_aws_stream_health(
        &self,
        connection_id: &str,
        error: Option<&str>,
        now_ms: i64,
    ) -> Result<(), String> {
        let client = self.client().await?;
        // `updated_at` is left alone: it tracks the connection's settings, not its traffic.
        let written = match error {
            None => {
                client
                    .execute(
                        "UPDATE aws_connections \
                         SET stream_last_received_at = to_timestamp($1::bigint / 1000.0), \
                             stream_last_error = NULL \
                         WHERE id = $2",
                        &[&now_ms, &connection_id],
                    )
                    .instrument(postgres_client_span(
                        "record_aws_stream_health",
                        "UPDATE",
                        AWS_CONNECTIONS_TABLE,
                        &self.target,
                    ))
                    .await
            }
            Some(error) => {
                client
                    .execute(
                        "UPDATE aws_connections SET stream_last_error = $1 WHERE id = $2",
                        &[&error, &connection_id],
                    )
                    .instrument(postgres_client_span(
                        "record_aws_stream_health",
                        "UPDATE",
                        AWS_CONNECTIONS_TABLE,
                        &self.target,
                    ))
                    .await
            }
        };
        written
            .map(|_| ())
            .map_err(|err| format!("postgres record_aws_stream_health failed: {err}"))
    }
}

// Local-dev / single-tenant KeyStore: every well-formed ingest key resolves to
// the configured org. No DB, no network. Connector flows are no-ops since
// the logpush receivers need connector rows, which only Postgres holds.
struct StaticKeyStore {
    org_id: String,
}

#[async_trait::async_trait]
impl KeyStore for StaticKeyStore {
    async fn fetch_ingest_key(
        &self,
        _key_hash: &str,
        _hash_column: &'static str,
    ) -> Result<Option<OrgKeyRow>, String> {
        Ok(Some(OrgKeyRow {
            key: KeyRow {
                org_id: self.org_id.clone(),
                self_managed: false,
                clickhouse_ready: false,
            },
            default_source_id: None,
        }))
    }

    async fn fetch_source_by_token_hash(
        &self,
        _key_hash: &str,
    ) -> Result<Option<SourceRow>, String> {
        Ok(Some(SourceRow {
            key: KeyRow {
                org_id: self.org_id.clone(),
                self_managed: false,
                clickhouse_ready: false,
            },
            config: None,
        }))
    }

    async fn fetch_connector(
        &self,
        _connector_id: &str,
        _secret_hash: &str,
    ) -> Result<Option<ConnectorRow>, String> {
        Ok(None)
    }

    async fn fetch_gcp_connector(
        &self,
        _connector_id: &str,
        _secret_hash: &str,
    ) -> Result<Option<GcpConnectorRow>, String> {
        Ok(None)
    }

    async fn fetch_gcp_connector_by_id(
        &self,
        _connector_id: &str,
    ) -> Result<Option<GcpConnectorRow>, String> {
        Ok(None)
    }

    async fn fetch_sampling_policy(
        &self,
        _org_id: &str,
    ) -> Result<Option<SamplingPolicyRow>, String> {
        Ok(None)
    }

    async fn fetch_attribute_mappings(
        &self,
        _org_id: &str,
    ) -> Result<Vec<AttributeMappingRow>, String> {
        Ok(Vec::new())
    }

    async fn fetch_ingest_rules(&self, _org_id: &str) -> Result<IngestRuleRows, String> {
        Ok(IngestRuleRows::default())
    }

    async fn record_ingest_rule_stats(&self, _rows: &[IngestRuleStatRow]) -> Result<(), String> {
        Ok(())
    }

    async fn fetch_clickhouse_target(
        &self,
        _org_id: &str,
    ) -> Result<Option<ClickHouseTargetRow>, String> {
        Ok(None)
    }

    async fn fetch_org_routing(&self, _org_id: &str) -> Result<Option<OrgRouting>, String> {
        Ok(None)
    }

    async fn record_source_used(&self, _key_id: &str, _now_ms: i64) -> Result<(), String> {
        Ok(())
    }

    async fn record_source_rejected(
        &self,
        _key_id: &str,
        _now_ms: i64,
        _reason: &str,
    ) -> Result<(), String> {
        Ok(())
    }

    async fn claimable_source_ids(
        &self,
        _org_id: &str,
        _source_ids: &[String],
    ) -> Result<Vec<PullSourceRow>, String> {
        Ok(Vec::new())
    }

    async fn record_connector_success(
        &self,
        _table: &'static str,
        _connector_id: &str,
        _now_ms: i64,
    ) -> Result<(), String> {
        Ok(())
    }

    async fn record_connector_failure(
        &self,
        _table: &'static str,
        _connector_id: &str,
        _error: &str,
        _now_ms: i64,
    ) -> Result<(), String> {
        Ok(())
    }

    async fn record_gcp_setup_report(
        &self,
        _connector_id: &str,
        _report: gcp_logging::SetupReport,
        _now_ms: i64,
    ) -> Result<(), String> {
        Ok(())
    }

    async fn fetch_aws_connection(
        &self,
        _connection_id: &str,
        _secret_hash: &str,
    ) -> Result<Option<AwsConnectionRow>, String> {
        Ok(None)
    }

    async fn record_aws_stream_health(
        &self,
        _connection_id: &str,
        _error: Option<&str>,
        _now_ms: i64,
    ) -> Result<(), String> {
        Ok(())
    }
}

/// Same comma-separated `INGEST_BLOCKED_KEYS` the edge WAF rule is built from.
fn parse_blocked_ingest_keys(raw: Option<&str>) -> HashSet<String> {
    raw.unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
        .collect()
}

fn infer_ingest_key_type(raw_key: &str) -> Option<IngestKeyType> {
    if raw_key.starts_with("maple_pk_") {
        return Some(IngestKeyType::Public);
    }

    if raw_key.starts_with("maple_sk_") {
        return Some(IngestKeyType::Private);
    }

    if raw_key.starts_with(SOURCE_TOKEN_PREFIX) {
        return Some(IngestKeyType::Source);
    }

    None
}

fn hash_ingest_key(raw_key: &str, lookup_hmac_key: &str) -> Result<String, String> {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(lookup_hmac_key.as_bytes())
        .map_err(|error| format!("Invalid HMAC key: {error}"))?;
    mac.update(raw_key.as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

fn parse_base64_aes256_gcm_key(raw: &str) -> Result<[u8; 32], String> {
    let decoded = STANDARD
        .decode(raw.trim())
        .map_err(|_| "MAPLE_INGEST_KEY_ENCRYPTION_KEY must be base64".to_owned())?;
    decoded.try_into().map_err(|bytes: Vec<u8>| {
        format!(
            "MAPLE_INGEST_KEY_ENCRYPTION_KEY must be base64 for exactly 32 bytes, got {} bytes",
            bytes.len()
        )
    })
}

fn decrypt_aes256_gcm(
    ciphertext: &str,
    iv: &str,
    tag: &str,
    key: &[u8; 32],
) -> Result<String, String> {
    let ciphertext = STANDARD
        .decode(ciphertext)
        .map_err(|_| "ClickHouse password ciphertext is not base64".to_owned())?;
    let iv = STANDARD
        .decode(iv)
        .map_err(|_| "ClickHouse password iv is not base64".to_owned())?;
    let tag = STANDARD
        .decode(tag)
        .map_err(|_| "ClickHouse password tag is not base64".to_owned())?;
    if iv.len() != 12 {
        return Err(format!(
            "ClickHouse password iv must be 12 bytes for AES-GCM, got {} bytes",
            iv.len()
        ));
    }
    if tag.len() != 16 {
        return Err(format!(
            "ClickHouse password tag must be 16 bytes for AES-GCM, got {} bytes",
            tag.len()
        ));
    }

    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|error| format!("Invalid AES-256-GCM key: {error}"))?;
    let mut sealed = ciphertext;
    sealed.extend_from_slice(&tag);
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&iv), sealed.as_ref())
        .map_err(|_| "Decryption failed".to_owned())?;
    String::from_utf8(plaintext).map_err(|_| "Decrypted password was not UTF-8".to_owned())
}

fn current_time_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}

/// Milliseconds of a measured duration. Every caller is timing an in-process
/// operation, so the saturating conversion only has to be total — the ceiling
/// it saturates at is half a billion years.
fn duration_millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

/// Build the KeyStore for this process. The `Static` variant resolves any
/// well-formed ingest key to a single configured org — used for single-tenant
/// local dev so contributors don't need database credentials to boot the service.
/// The `Postgres` variant reads `org_ingest_keys` from PlanetScale through
/// PSBouncer (the API service writes to the same database); a probe query runs at
/// startup so any auth/schema/network issue surfaces here instead of 503'ing
/// every request.
#[expect(
    clippy::cognitive_complexity,
    reason = "one arm per key-store backend, each fully configured in place"
)]
async fn build_key_store(
    config: &AppConfig,
    ready: Arc<AtomicBool>,
) -> Result<Arc<dyn KeyStore>, String> {
    match &config.key_store_backend {
        KeyStoreBackend::Static { org_id } => {
            info!(
                backend = "static",
                org_id = %org_id,
                "Key store backend selected"
            );
            ready.store(true, Ordering::Relaxed);
            Ok(Arc::new(StaticKeyStore {
                org_id: org_id.clone(),
            }))
        }
        KeyStoreBackend::Postgres { url } => {
            info!(
                backend = "planetscale-postgres",
                "Key store backend selected"
            );
            // A malformed MAPLE_PG_URL is operator error, fixable in seconds, and
            // can never resolve on its own — that stays fatal.
            let store = Arc::new(PostgresKeyStore::new(url)?);

            // A failing probe is NOT fatal. It used to `exit(1)`, which turned any
            // transient Postgres/PSBouncer fault into a restart loop: every boot
            // reopened pool connections against the very component that was
            // struggling, and each restart wiped the in-memory key + routing
            // caches, so nothing could serve stale and nothing could recover
            // without an operator. Boot degraded and re-probe in the background
            // instead — auth 503s until Postgres returns, then heals by itself.
            match store.probe().await {
                Ok(()) => {
                    info!("Postgres startup probe succeeded");
                    ready.store(true, Ordering::Relaxed);
                }
                Err(error) => {
                    error!(
                        %error,
                        "Postgres startup probe failed; booting DEGRADED (ingest auth will 503 until Postgres recovers). /ready stays false; /health stays OK so the platform does not restart-loop this task."
                    );
                    spawn_key_store_reprobe(Arc::clone(&store), ready);
                }
            }

            Ok(store)
        }
    }
}

/// Re-probe Postgres until it answers, then flip the readiness flag.
///
/// Backoff is capped and jittered: an un-jittered fleet retrying in lockstep is
/// how a recovering pooler gets knocked straight back over.
fn spawn_key_store_reprobe(store: Arc<PostgresKeyStore>, ready: Arc<AtomicBool>) {
    tokio::spawn(async move {
        let mut delay_ms: u64 = 1_000;
        loop {
            // Cheap per-iteration jitter without pulling in `rand`; recomputed
            // each pass so replicas that booted together drift apart.
            let jitter_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |elapsed| u64::from(elapsed.subsec_nanos()) % 1_000);
            tokio::time::sleep(Duration::from_millis(delay_ms + jitter_ms)).await;

            match store.probe().await {
                Ok(()) => {
                    info!("Postgres reachable again; key store READY");
                    ready.store(true, Ordering::Relaxed);
                    return;
                }
                Err(error) => {
                    warn!(%error, delay_ms, "Postgres re-probe failed; still degraded");
                    delay_ms = (delay_ms * 2).min(30_000);
                }
            }
        }
    });
}

/// Keys live in one region's database, so a valid key sent to the other
/// region's ingest is indistinguishable from a bogus one here. `MAPLE_REGION`
/// is set only on the hosted prd fleets; unset (self-hosted, local, previews)
/// keeps the plain message, since there is no sibling instance to point at.
fn invalid_ingest_key_message(region: Option<&str>) -> Result<&'static str, String> {
    let region = region.unwrap_or_default().trim().to_ascii_lowercase();
    match region.as_str() {
        "" => Ok("Invalid ingest key"),
        "us" => Ok(concat!(
            "Invalid ingest key. Keys are region-specific: if your Maple org is in the EU, ",
            "send to https://ingest.eu.maple.dev."
        )),
        "eu" => Ok(concat!(
            "Invalid ingest key. Keys are region-specific: if your Maple org is in the US, ",
            "send to https://ingest.maple.dev."
        )),
        other => Err(format!("MAPLE_REGION must be us or eu, got {other:?}")),
    }
}

/// Whether BYO ClickHouse exports may reach private addresses. Off for the
/// managed deployment, whose tenants share its network; on by default for a
/// self-hosted install, where ClickHouse usually sits on an internal name.
fn clickhouse_allow_private_endpoints(
    raw: Option<String>,
    self_hosted_mode: Option<String>,
) -> Result<bool, String> {
    // Same reading as the key store backend: only `single_tenant` is self-hosted.
    let self_hosted = self_hosted_mode.as_deref() == Some("single_tenant");
    parse_bool(
        "INGEST_CLICKHOUSE_ALLOW_PRIVATE_ENDPOINTS",
        raw,
        self_hosted,
    )
}

fn parse_bool(name: &str, raw: Option<String>, default: bool) -> Result<bool, String> {
    let Some(raw) = raw else {
        return Ok(default);
    };

    let value = raw.trim().to_ascii_lowercase();
    if value.is_empty() {
        return Ok(default);
    }

    match value.as_str() {
        "1" | "true" => Ok(true),
        "0" | "false" => Ok(false),
        _ => Err(format!("{name} must be true/false or 1/0")),
    }
}

fn parse_u16(name: &str, raw: Option<String>, default: u16) -> Result<u16, String> {
    let Some(raw) = raw else {
        return Ok(default);
    };

    let value = raw.trim();
    if value.is_empty() {
        return Ok(default);
    }

    value
        .parse::<u16>()
        .map_err(|_| format!("{name} must be a valid u16"))
}

fn parse_optional_u16(name: &str, raw: Option<String>) -> Result<Option<u16>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let value = raw.trim();
    if value.is_empty() || value == "0" {
        return Ok(None);
    }
    value
        .parse::<u16>()
        .map(Some)
        .map_err(|_| format!("{name} must be a valid u16"))
}

fn parse_u64(name: &str, raw: Option<String>, default: u64) -> Result<u64, String> {
    let Some(raw) = raw else {
        return Ok(default);
    };

    let value = raw.trim();
    if value.is_empty() {
        return Ok(default);
    }

    value
        .parse::<u64>()
        .map_err(|_| format!("{name} must be a positive integer"))
}

/// A sampling ratio in (0, 1]. Zero is refused rather than read as "off": it
/// would silence the gateway's traces while every other signal keeps flowing.
fn parse_sample_ratio(name: &str, raw: Option<String>, default: f64) -> Result<f64, String> {
    let Some(raw) = raw else {
        return Ok(default);
    };

    let value = raw.trim();
    if value.is_empty() {
        return Ok(default);
    }

    value
        .parse::<f64>()
        .ok()
        .filter(|ratio| *ratio > 0.0 && *ratio <= 1.0)
        .ok_or_else(|| format!("{name} must be a number in (0, 1]"))
}

fn parse_u32(name: &str, raw: Option<String>, default: u32) -> Result<u32, String> {
    let Some(raw) = raw else {
        return Ok(default);
    };

    let value = raw.trim();
    if value.is_empty() {
        return Ok(default);
    }

    value
        .parse::<u32>()
        .map_err(|_| format!("{name} must be a positive integer"))
}

fn parse_usize(name: &str, raw: Option<String>, default: usize) -> Result<usize, String> {
    let Some(raw) = raw else {
        return Ok(default);
    };

    let value = raw.trim();
    if value.is_empty() {
        return Ok(default);
    }

    value
        .parse::<usize>()
        .map_err(|_| format!("{name} must be a positive integer"))
}

fn parse_fleet_size(raw: Option<String>) -> Result<u32, String> {
    let fleet_size = parse_u64("INGEST_RATE_LIMIT_FLEET_SIZE", raw, 1)?;
    match u32::try_from(fleet_size) {
        Ok(fleet_size) if fleet_size > 0 => Ok(fleet_size),
        _ => Err("INGEST_RATE_LIMIT_FLEET_SIZE must be a positive integer".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn clickhouse_private_endpoints_are_opt_in_or_self_hosted() {
        let allow = |raw: Option<&str>, mode: Option<&str>| {
            clickhouse_allow_private_endpoints(raw.map(str::to_owned), mode.map(str::to_owned))
        };
        assert_eq!(allow(None, None), Ok(false));
        assert_eq!(allow(Some("true"), None), Ok(true));
        assert_eq!(allow(None, Some("single_tenant")), Ok(true));
        assert_eq!(allow(Some("false"), Some("single_tenant")), Ok(false));
        // Only the value the key store reads as self-hosted turns the opt-in on.
        assert_eq!(allow(None, Some("false")), Ok(false));
        assert_eq!(allow(None, Some("multi_tenant")), Ok(false));
        assert!(allow(Some("maybe"), None).is_err());
    }

    use super::*;
    // `AtomicBool` is only used by the test fakes below; keeping it out of the
    // top-level import avoids an unused-import warning in non-test bin builds.
    use opentelemetry_proto::tonic::metrics::v1::metric;
    use std::sync::atomic::AtomicBool;

    /// The blob path's length count, unbounded and with its `io::Error`, for the rejection tests.
    fn decompressed_len(body: &[u8]) -> Result<u64, std::io::Error> {
        gunzip_len_bounded(body, usize::MAX).map_err(|e| match e {
            GunzipError::Invalid(e) => e,
            GunzipError::TooLarge => std::io::Error::other("unreachable under usize::MAX"),
        })
    }

    #[test]
    fn self_trace_sample_ratio_must_be_in_the_unit_interval() {
        let parse = |raw: &str| parse_sample_ratio("RATIO", Some(raw.to_owned()), 1.0);
        assert_eq!(parse_sample_ratio("RATIO", None, 1.0), Ok(1.0));
        assert_eq!(parse(" "), Ok(1.0));
        assert_eq!(parse("0.05"), Ok(0.05));
        assert_eq!(parse("1"), Ok(1.0));
        for invalid in ["0", "-0.1", "1.5", "NaN", "inf", "five percent"] {
            assert!(parse(invalid).is_err(), "{invalid} must refuse to boot");
        }
    }

    #[test]
    fn sampled_self_spans_carry_their_sample_rate() {
        use opentelemetry::trace::{
            SpanContext, SpanId, SpanKind, TraceContextExt, TraceFlags, TraceId, TraceState,
        };

        let sample = |sampler: &SelfTraceSampler, parent: Option<&opentelemetry::Context>, id| {
            sampler.should_sample(
                parent,
                TraceId::from(id),
                "ingest",
                &SpanKind::Server,
                &[],
                &[],
            )
        };
        let sample_rate = |result: &SamplingResult| {
            result
                .attributes
                .iter()
                .find(|kv| kv.key.as_str() == "SampleRate")
                .map(|kv| kv.value.clone())
        };

        let sampled = SelfTraceSampler::new(0.05);
        // The ratio sampler keeps a trace when its id's low 64 bits fall under
        // ratio * 2^64, so 1 is always kept and u128::MAX never is.
        let root = sample(&sampled, None, 1);
        assert_eq!(root.decision, SamplingDecision::RecordAndSample);
        assert_eq!(sample_rate(&root), Some(opentelemetry::Value::F64(20.0)));
        let dropped = sample(&sampled, None, u128::MAX);
        assert_eq!(dropped.decision, SamplingDecision::Drop);
        assert_eq!(sample_rate(&dropped), None);

        // Children follow the root's decision and are weighted the same.
        let parent = opentelemetry::Context::new().with_remote_span_context(SpanContext::new(
            TraceId::from(u128::MAX),
            SpanId::from(7),
            TraceFlags::SAMPLED,
            false,
            TraceState::default(),
        ));
        let child = sample(&sampled, Some(&parent), u128::MAX);
        assert_eq!(child.decision, SamplingDecision::RecordAndSample);
        assert_eq!(sample_rate(&child), Some(opentelemetry::Value::F64(20.0)));

        // Unsampled, nothing is added: a SampleRate of 1 would only cost bytes.
        let unsampled = sample(&SelfTraceSampler::new(1.0), None, u128::MAX);
        assert_eq!(unsampled.decision, SamplingDecision::RecordAndSample);
        assert_eq!(sample_rate(&unsampled), None);
    }

    #[test]
    fn invalid_key_message_points_at_the_other_region() {
        assert_eq!(invalid_ingest_key_message(None), Ok("Invalid ingest key"));
        assert_eq!(
            invalid_ingest_key_message(Some("us")),
            Ok(concat!(
                "Invalid ingest key. Keys are region-specific: if your Maple org is in the EU, ",
                "send to https://ingest.eu.maple.dev."
            ))
        );
        assert_eq!(
            invalid_ingest_key_message(Some(" EU ")),
            Ok(concat!(
                "Invalid ingest key. Keys are region-specific: if your Maple org is in the US, ",
                "send to https://ingest.maple.dev."
            ))
        );
        assert!(invalid_ingest_key_message(Some("apac")).is_err());
    }

    #[test]
    fn postgres_target_is_derived_from_the_connection_string() {
        let config = "postgres://user:pw@psbouncer.example.com:6432/maple_prod"
            .parse::<tokio_postgres::Config>()
            .unwrap();
        let target = PostgresTarget::from_config(&config);
        assert_eq!(target.namespace, "maple_prod");
        assert_eq!(target.address, "psbouncer.example.com");
        assert_eq!(target.port, 6432);
    }

    #[test]
    fn postgres_client_span_declares_db_identity() {
        // A field that isn't declared here can't be filtered or grouped on, and
        // an absent `db.namespace` drops the span into the generic per-system
        // node on the service map instead of naming the database.
        let target = PostgresTarget {
            namespace: "maple_prod".to_owned(),
            address: "psbouncer.example.com".to_owned(),
            port: 6432,
        };
        let span = postgres_client_span("fetch_ingest_key", "SELECT", "org_ingest_keys", &target);
        for field in [
            "db.system.name",
            "db.operation.name",
            "db.collection.name",
            "db.namespace",
            "server.address",
            "server.port",
            "peer.service",
            "code.function.name",
        ] {
            assert!(span.has_field(field), "span is missing field `{field}`");
        }
    }

    #[test]
    fn hash_is_deterministic() {
        let hash_a = hash_ingest_key("maple_pk_123", "secret").unwrap();
        let hash_b = hash_ingest_key("maple_pk_123", "secret").unwrap();
        assert_eq!(hash_a, hash_b);
    }

    /// Rejections of the *caller* stay `Ok` — a rotated key or a 429 storm is
    /// high-volume and expected, and must not page anyone.
    #[test]
    fn caller_fault_rejections_do_not_mark_the_span_error() {
        assert_eq!(otel_status_for_rejection(401, "auth"), "Ok"); // missing/invalid ingest key
        assert_eq!(otel_status_for_rejection(402, "error"), "Ok"); // billing limit
        assert_eq!(otel_status_for_rejection(413, "payload_too_large"), "Ok");
        assert_eq!(otel_status_for_rejection(415, "unsupported_media"), "Ok");
        assert_eq!(otel_status_for_rejection(429, "throttle"), "Ok");
        assert_eq!(otel_status_for_rejection(429, "forward"), "Ok"); // pipeline shed
    }

    /// Rejections that destroy the sender's telemetry are `Error` regardless of
    /// status class. This is the regression that let a bug drop 99.2% of one
    /// org's logs for over a day while every dashboard read 0%.
    #[test]
    fn data_loss_rejections_mark_the_span_error_even_at_4xx() {
        assert_eq!(otel_status_for_rejection(400, "enrich"), "Error");
        assert_eq!(otel_status_for_rejection(400, "decode"), "Error");
        assert_eq!(otel_status_for_rejection(400, "bad_request"), "Error");
        assert_eq!(otel_status_for_rejection(400, "malformed_body"), "Ok"); // never a gzip stream

        assert!(rejection_loses_data("enrich"));
        assert!(rejection_loses_data("decode"));
        assert!(rejection_loses_data("bad_request"));
        assert!(!rejection_loses_data("auth"));
        assert!(!rejection_loses_data("throttle"));
        assert!(!rejection_loses_data("payload_too_large"));
        assert!(!rejection_loses_data("forward"));
    }

    #[test]
    fn server_faults_stay_error() {
        // e.g. auth resolver unavailable → 503.
        assert_eq!(otel_status_for_rejection(500, "error"), "Error");
        assert_eq!(otel_status_for_rejection(503, "unavailable"), "Error");
        assert_eq!(otel_status_for_rejection(503, "forward"), "Error");
    }

    /// Every label `rejection_loses_data` claims must actually be producible, or
    /// the rule silently covers nothing — the failure mode it exists to prevent.
    #[test]
    fn data_loss_labels_match_the_kinds_the_gateway_emits() {
        assert_eq!(ApiError::bad_request("x").error_kind(), "bad_request");
        // `decode` and `enrich` are the stage labels attached in
        // `handle_signal_inner`; they reach the span via the Err tuple.
        for stage in ["decode", "enrich"] {
            assert!(
                rejection_loses_data(stage),
                "{stage} is emitted as an error.type but is not classified"
            );
        }
    }

    #[test]
    fn api_error_kind_maps_status_to_stable_label() {
        // The native replay/session handlers derive `error.type` from this so
        // their spans are categorizable instead of "Unknown Error".
        assert_eq!(ApiError::unauthorized("x").error_kind(), "auth");
        assert_eq!(ApiError::bad_request("x").error_kind(), "bad_request");
        assert_eq!(
            ApiError::unsupported_media_type("x").error_kind(),
            "unsupported_media"
        );
        assert_eq!(
            ApiError::payload_too_large("x").error_kind(),
            "payload_too_large"
        );
        assert_eq!(ApiError::too_many_requests("x").error_kind(), "throttle");
        assert_eq!(
            ApiError::service_unavailable("x").error_kind(),
            "unavailable"
        );
        assert_eq!(
            ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "x").error_kind(),
            "error"
        );
    }

    #[tokio::test]
    async fn api_error_body_uses_the_tagged_error_envelope() {
        let response = api_error_from_pipeline(&PipelineError::QueueUnavailable(
            "wal lane 46 is full".into(),
        ))
        .into_response();

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            response.headers().get(RETRY_AFTER).unwrap(),
            HeaderValue::from_static("5")
        );

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: JsonValue = serde_json::from_slice(&body).unwrap();
        let error = &body["error"];
        assert_eq!(error["_tag"], "@maple/ingest/QueueUnavailable");
        assert_eq!(error["type"], "api_error");
        assert_eq!(error["code"], "ingest_queue_unavailable");
        assert_eq!(error["retryable"], true);
        assert_eq!(error["recovery"], "retry");
        assert_eq!(error["retry_after_seconds"], 5);
        // The internal cause is telemetry-only: it never reaches the wire.
        assert!(!body.to_string().contains("wal lane 46"));
    }

    #[test]
    fn pipeline_failures_carry_distinct_tags_and_retry_semantics() {
        let queue = api_error_from_pipeline(&PipelineError::QueueUnavailable("wal closed".into()));
        let encode = api_error_from_pipeline(&PipelineError::Encode("bad row".into()));

        // Both are 503, but one is worth retrying and the other never is — the
        // single "Telemetry backend unavailable" string said neither.
        assert_eq!(queue.status, encode.status);
        assert_ne!(queue.kind.tag, encode.kind.tag);
        assert!(queue.kind.retryable);
        assert!(!encode.kind.retryable);
        assert_eq!(encode.kind.recovery, "contact_support");

        // The cause survives on the span even though it is off the wire.
        assert!(queue.reason().contains("wal closed"));
    }

    #[test]
    fn pipeline_error_kinds_match_the_pipeline_vocabulary() {
        for error in [
            PipelineError::Throttled("x"),
            PipelineError::Backpressure("x"),
            PipelineError::QueueUnavailable("x".into()),
            PipelineError::Encode("x".into()),
        ] {
            assert_eq!(api_error_from_pipeline(&error).error_kind(), error.kind());
        }
    }

    #[test]
    fn api_error_from_pipeline_maps_variants_to_status() {
        // Transient queue conditions are retryable → 429 (classified Ok via
        // otel_status_for_rejection, so a stalled BYO-ClickHouse target backing
        // the lane up does not flood the error dashboards as "Unknown Error").
        assert_eq!(
            api_error_from_pipeline(&PipelineError::Throttled("x")).status,
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(
            api_error_from_pipeline(&PipelineError::Backpressure("x")).status,
            StatusCode::TOO_MANY_REQUESTS
        );
        // Genuine backend failures stay 503 (Error), now labeled via the span's
        // otel.status_description rather than surfacing as "Unknown Error".
        assert_eq!(
            api_error_from_pipeline(&PipelineError::QueueUnavailable("x".into())).status,
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            api_error_from_pipeline(&PipelineError::Encode("x".into())).status,
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(otel_status_for_rejection(429, "forward"), "Ok");
        assert_eq!(otel_status_for_rejection(503, "forward"), "Error");
    }

    #[test]
    fn sentinel_token_matches_only_exact_literal() {
        assert!(is_sentinel_token("MAPLE_TEST"));
        assert!(!is_sentinel_token("maple_test"));
        assert!(!is_sentinel_token(" MAPLE_TEST"));
        assert!(!is_sentinel_token("MAPLE_TEST "));
        assert!(!is_sentinel_token("MAPLE_TEST_KEY"));
        assert!(!is_sentinel_token(""));
        assert!(!is_sentinel_token("maple_pk_123"));
    }

    #[test]
    fn extract_ingest_key_returns_sentinel_literal_unchanged() {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, "Bearer MAPLE_TEST".parse().unwrap());
        let token = extract_ingest_key(&headers).expect("token present");
        assert_eq!(token, SENTINEL_TOKEN);
        assert!(is_sentinel_token(&token));
    }

    #[test]
    fn enrichment_overwrites_tenant_fields() {
        let mut attributes = vec![
            KeyValue {
                key: "org_id".to_owned(),
                key_strindex: 0,
                value: Some(AnyValue {
                    value: Some(any_value::Value::StringValue("spoofed".to_owned())),
                }),
            },
            KeyValue {
                key: "maple_org_id".to_owned(),
                key_strindex: 0,
                value: Some(AnyValue {
                    value: Some(any_value::Value::StringValue("spoofed".to_owned())),
                }),
            },
        ];

        let resolved = ResolvedIngestKey {
            org_id: "org_real".to_owned(),
            key_type: IngestKeyType::Private,
            key_id: "abc".to_owned(),
            self_managed: false,
            clickhouse_ready: false,
            source: None,
            default_source: None,
        };

        enrich_resource_attributes(&mut attributes, &resolved, &[]);

        let mut values = std::collections::HashMap::new();
        for attribute in &attributes {
            if let Some(AnyValue {
                value: Some(any_value::Value::StringValue(value)),
            }) = &attribute.value
            {
                values.insert(attribute.key.clone(), value.clone());
            }
        }

        assert_eq!(values.get("maple_org_id"), Some(&"org_real".to_owned()));
        assert_eq!(
            values.get("maple_ingest_key_type"),
            Some(&"private".to_owned())
        );
        assert_eq!(
            values.get("maple_ingest_source"),
            Some(&INGEST_SOURCE.to_owned())
        );
        assert!(!values.contains_key("org_id"));
    }

    fn test_key() -> ResolvedIngestKey {
        ResolvedIngestKey {
            org_id: "org_real".to_owned(),
            key_type: IngestKeyType::Private,
            key_id: "abc".to_owned(),
            self_managed: false,
            clickhouse_ready: false,
            source: None,
            default_source: None,
        }
    }

    fn decode_json(signal: Signal, payload: &str) -> Result<DecodedPayload, ApiError> {
        decode_otlp_payload(signal, PayloadFormat::Json, payload.as_bytes()).map(|mut decoded| {
            enrich_decoded_payload(&mut decoded, &test_key(), &[]);
            decoded
        })
    }

    /// Spec-legal encodings the generated types refuse: nanosecond timestamps as
    /// JSON numbers, `{}` for a log with no body or an attribute with no value,
    /// and `null` for an absent id. Rejecting these 400'd effectively all of one
    /// org's logs.
    #[test]
    fn lenient_log_payload_is_accepted() {
        let decoded = decode_json(
            Signal::Logs,
            r#"{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"api"}}]},"scopeLogs":[{"scope":{"name":"app"},"logRecords":[{"timeUnixNano":1753660000000000000,"observedTimeUnixNano":1753660000000000000,"severityNumber":9,"severityText":"INFO","body":{},"attributes":[{"key":"empty","value":{}},{"key":"kept","value":{"stringValue":"v"}}],"traceId":null}]}]}]}"#,
        )
        .expect("payload accepted");

        let DecodedPayload::Logs(request) = decoded else {
            panic!("expected logs");
        };
        assert_eq!(count_log_items(&request), 1);
        let record = &request.resource_logs[0].scope_logs[0].log_records[0];
        assert_eq!(record.time_unix_nano, 1_753_660_000_000_000_000);
        assert_eq!(record.severity_number, 9);
        assert!(record.body.is_none());
        // The empty attribute survives as a key with no value; the real one is intact.
        assert_eq!(record.attributes.len(), 2);
        assert!(record.attributes[0].value.is_none());
        assert!(record.attributes[1].value.is_some());
    }

    /// Metrics fail differently and worse: `Metric.data` is a flattened oneof, so
    /// the same encoding deserializes to `None` — a 200 with the data points
    /// thrown away, billed and never stored.
    #[test]
    fn numeric_nanos_no_longer_silently_empty_a_metric() {
        let decoded = decode_json(
            Signal::Metrics,
            r#"{"resourceMetrics":[{"resource":{"attributes":[]},"scopeMetrics":[{"metrics":[{"name":"m","gauge":{"dataPoints":[{"timeUnixNano":1753660000000000000,"asDouble":1.5}]}}]}]}]}"#,
        )
        .expect("payload accepted");

        let DecodedPayload::Metrics(request) = decoded else {
            panic!("expected metrics");
        };
        let metric = &request.resource_metrics[0].scope_metrics[0].metrics[0];
        let Some(metric::Data::Gauge(gauge)) = &metric.data else {
            panic!("gauge data dropped");
        };
        assert_eq!(gauge.data_points.len(), 1);
    }

    /// `asInt` as a JSON number or a decimal string must both decode to a
    /// value. It used to be stringified for the derives, which want a number,
    /// so every integer gauge and sum point decoded to `None` and stored 0.
    #[test]
    fn integer_metric_points_keep_their_value() {
        use opentelemetry_proto::tonic::metrics::v1::number_data_point;

        let decoded = decode_json(
            Signal::Metrics,
            r#"{"resourceMetrics":[{"resource":{"attributes":[]},"scopeMetrics":[{"metrics":[{"name":"g","gauge":{"dataPoints":[{"timeUnixNano":"1753660000000000000","asInt":42},{"timeUnixNano":"1753660000000000000","asInt":"43"}]}},{"name":"s","sum":{"aggregationTemporality":2,"isMonotonic":true,"dataPoints":[{"timeUnixNano":"1753660000000000000","asInt":44},{"timeUnixNano":"1753660000000000000","asInt":"-45"}]}}]}]}]}"#,
        )
        .expect("payload accepted");

        let DecodedPayload::Metrics(request) = decoded else {
            panic!("expected metrics");
        };
        let metrics = &request.resource_metrics[0].scope_metrics[0].metrics;
        let Some(metric::Data::Gauge(gauge)) = &metrics[0].data else {
            panic!("gauge data dropped");
        };
        let Some(metric::Data::Sum(sum)) = &metrics[1].data else {
            panic!("sum data dropped");
        };
        let values = |points: &[opentelemetry_proto::tonic::metrics::v1::NumberDataPoint]| {
            points.iter().map(|p| p.value).collect::<Vec<_>>()
        };
        assert_eq!(
            values(&gauge.data_points),
            vec![
                Some(number_data_point::Value::AsInt(42)),
                Some(number_data_point::Value::AsInt(43)),
            ]
        );
        assert_eq!(
            values(&sum.data_points),
            vec![
                Some(number_data_point::Value::AsInt(44)),
                Some(number_data_point::Value::AsInt(-45)),
            ]
        );
    }

    #[test]
    fn spec_compliant_payloads_still_decode() {
        let decoded = decode_json(
            Signal::Traces,
            r#"{"resourceSpans":[{"resource":{"attributes":[]},"scopeSpans":[{"spans":[{"traceId":"5b8efff798038103d269b633813fc60c","spanId":"eee19b7ec3c1b174","name":"GET /","kind":2,"startTimeUnixNano":"1753660000000000000","endTimeUnixNano":"1753660000000000001","status":{"code":1}}]}]}]}"#,
        )
        .expect("payload accepted");

        let DecodedPayload::Traces(request) = decoded else {
            panic!("expected traces");
        };
        let span = &request.resource_spans[0].scope_spans[0].spans[0];
        assert_eq!(span.name, "GET /");
        assert_eq!(span.kind, 2);
        assert_eq!(span.end_time_unix_nano, 1_753_660_000_000_000_001);
    }

    /// Enrichment still has to reach a request whose resource we normalized away.
    #[test]
    fn enrichment_applies_to_a_payload_with_no_resource() {
        let decoded = decode_json(
            Signal::Logs,
            r#"{"resourceLogs":[{"resource":{},"scopeLogs":[{"logRecords":[{"timeUnixNano":"1"}]}]}]}"#,
        )
        .expect("payload accepted");

        let DecodedPayload::Logs(request) = decoded else {
            panic!("expected logs");
        };
        let attributes = &request.resource_logs[0]
            .resource
            .as_ref()
            .expect("resource re-inserted")
            .attributes;
        assert!(attributes.iter().any(|a| a.key == "maple_org_id"
            && matches!(
                &a.value,
                Some(AnyValue { value: Some(any_value::Value::StringValue(v)) }) if v == "org_real"
            )));
    }

    /// Decode-time enrichment stamps AI vendor/session attributes onto spans,
    /// so both the native rows and the forwarded OTLP payload carry them.
    #[test]
    fn enrichment_stamps_ai_vendor_attributes_on_spans() {
        let decoded = decode_json(
            Signal::Traces,
            r#"{"resourceSpans":[{"resource":{"attributes":[]},"scopeSpans":[{"scope":{"name":"@mastra/otel-exporter"},"spans":[{"traceId":"5b8efff798038103d269b633813fc60c","spanId":"eee19b7ec3c1b174","name":"agent.generate","startTimeUnixNano":"1753660000000000000","endTimeUnixNano":"1753660000000000001","attributes":[{"key":"gen_ai.conversation.id","value":{"stringValue":"conv-42"}},{"key":"maple_ai.vendor.id","value":{"stringValue":"spoofed"}}]}]}]}]}"#,
        )
        .expect("payload accepted");

        let DecodedPayload::Traces(request) = decoded else {
            panic!("expected traces");
        };
        let attributes = &request.resource_spans[0].scope_spans[0].spans[0].attributes;
        let value = |key: &str| {
            attributes
                .iter()
                .find(|a| a.key == key)
                .map(|a| match &a.value {
                    Some(AnyValue {
                        value: Some(any_value::Value::StringValue(v)),
                    }) => v.clone(),
                    other => panic!("expected string value for {key}, got {other:?}"),
                })
        };
        assert_eq!(value("maple_ai.vendor.id").as_deref(), Some("mastra"));
        assert_eq!(value("maple_ai.vendor.version").as_deref(), Some("0"));
        assert_eq!(value("maple_ai.session.id").as_deref(), Some("conv-42"));
        assert_eq!(
            attributes
                .iter()
                .filter(|a| a.key == "maple_ai.vendor.id")
                .count(),
            1,
            "the spoofed customer stamp must be stripped, not kept alongside ours"
        );
    }

    /// An export request with nothing to export is a no-op, not a rejection.
    #[test]
    fn empty_export_request_is_accepted() {
        let decoded = decode_json(Signal::Logs, r"{}").expect("payload accepted");
        assert_eq!(decoded.item_count(), 0);
    }

    /// Genuinely malformed input is still refused — and now says why, which is
    /// the whole point: the previous message named neither the field nor the
    /// offset, so a customer had no way to find the bug in their exporter.
    #[test]
    fn malformed_payload_is_rejected_with_the_parser_reason() {
        let Err(error) = decode_json(Signal::Logs, r#"{"resourceLogs":"nope"}"#) else {
            panic!("expected rejection");
        };
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert!(
            error
                .message
                .starts_with("Invalid OTLP logs JSON payload: "),
            "unexpected message: {}",
            error.message
        );
        assert!(
            error.message.contains("invalid type"),
            "reason not preserved: {}",
            error.message
        );
    }

    #[test]
    fn rejection_reason_is_bounded() {
        let error = invalid_payload("logs", "JSON", "x".repeat(10_000));
        assert!(error.message.len() < MAX_PAYLOAD_ERROR_DETAIL + 64);
        assert!(error.message.ends_with('…'));
    }

    #[test]
    fn cloudflare_validation_payload_is_detected() {
        let parsed = parse_cloudflare_payload(br#"{"content":"tests"}"#).unwrap();
        assert!(matches!(parsed, ParsedCloudflarePayload::Validation));
    }

    #[test]
    fn cloudflare_ndjson_payload_parses_multiple_records() {
        let parsed = parse_cloudflare_payload(
            br#"{"RayID":"a","EdgeResponseStatus":200}
{"RayID":"b","EdgeResponseStatus":503}"#,
        )
        .unwrap();

        match parsed {
            ParsedCloudflarePayload::Validation => panic!("expected records"),
            ParsedCloudflarePayload::Records(records) => {
                assert_eq!(records.len(), 2);
                assert_eq!(
                    records[0].get("RayID").and_then(JsonValue::as_str),
                    Some("a")
                );
                assert_eq!(
                    records[1].get("RayID").and_then(JsonValue::as_str),
                    Some("b")
                );
            }
        }
    }

    #[test]
    fn cloudflare_timestamps_support_rfc3339_unix_and_unix_nano() {
        let rfc3339 = JsonValue::String("2025-03-07T12:34:56Z".to_owned());
        let unix = JsonValue::Number(serde_json::Number::from(1_741_351_296u64));
        let unix_nano = JsonValue::Number(serde_json::Number::from(1_741_351_296_123_456_789u64));

        assert_eq!(
            parse_cloudflare_timestamp(&rfc3339),
            Some(1_741_350_896_000_000_000)
        );
        assert_eq!(
            parse_cloudflare_timestamp(&unix),
            Some(1_741_351_296_000_000_000)
        );
        assert_eq!(
            parse_cloudflare_timestamp(&unix_nano),
            Some(1_741_351_296_123_456_789)
        );
    }

    #[test]
    fn cloudflare_log_record_maps_body_severity_and_attributes() {
        let resolved = ResolvedCloudflareConnector {
            connector_id: "connector_1".to_owned(),
            org_id: "org_1".to_owned(),
            service_name: "cloudflare/example.com".to_owned(),
            zone_name: "example.com".to_owned(),
            dataset: "http_requests".to_owned(),
            secret_key_id: "secret".to_owned(),
            self_managed: false,
            clickhouse_ready: false,
            source: None,
            source_pause: PauseWindow::default(),
        };
        let record = serde_json::from_str::<JsonMap<String, JsonValue>>(
            r#"{
                "EdgeStartTimestamp": "2025-03-07T12:34:56Z",
                "ClientRequestMethod": "GET",
                "ClientRequestHost": "example.com",
                "ClientRequestURI": "/status",
                "EdgeResponseStatus": 503,
                "RayID": "abc123",
                "ClientCountry": "US",
                "ZoneName": "example.com"
            }"#,
        )
        .unwrap();

        let otlp = build_cloudflare_logs_request(&resolved, vec![record]);
        let resource_log = &otlp.resource_logs[0];
        let log_record = &resource_log.scope_logs[0].log_records[0];

        assert_eq!(log_record.severity_text, "ERROR");
        assert_eq!(log_record.severity_number, 17);
        assert_eq!(
            log_record.body.as_ref().and_then(|body| match &body.value {
                Some(any_value::Value::StringValue(value)) => Some(value.as_str()),
                _ => None,
            }),
            Some("GET example.com/status -> 503")
        );

        let mut resource_values = std::collections::HashMap::new();
        for attribute in &resource_log.resource.as_ref().unwrap().attributes {
            if let Some(AnyValue {
                value: Some(any_value::Value::StringValue(value)),
            }) = &attribute.value
            {
                resource_values.insert(attribute.key.as_str(), value.as_str());
            }
        }
        assert_eq!(
            resource_values.get("maple_ingest_source"),
            Some(&CLOUDFLARE_LOGPUSH_SOURCE)
        );
        assert_eq!(
            resource_values.get("service.name"),
            Some(&"cloudflare/example.com")
        );

        let mut log_values = std::collections::HashMap::new();
        for attribute in &log_record.attributes {
            if let Some(AnyValue {
                value: Some(any_value::Value::StringValue(value)),
            }) = &attribute.value
            {
                log_values.insert(attribute.key.as_str(), value.as_str());
            }
        }

        assert_eq!(log_values.get("RayID"), Some(&"abc123"));
        assert_eq!(log_values.get("ClientCountry"), Some(&"US"));
    }

    #[test]
    fn clickhouse_destination_uses_native_pipeline_even_in_forward_mode() {
        assert!(uses_native_pipeline_for(
            WriteMode::Forward,
            ExportDestination::ClickHouse
        ));
        assert!(!uses_forward_path_for(
            WriteMode::Forward,
            ExportDestination::ClickHouse
        ));
    }

    fn geo_headers(country: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("cf-ipcountry", country.parse().unwrap());
        headers
    }

    #[test]
    fn country_is_empty_unless_the_proxy_is_trusted() {
        // The gateway is reachable directly on its Railway origin, so an
        // untrusted deployment must ignore the header entirely rather than let
        // a client label its own traffic.
        assert_eq!(derive_country(&geo_headers("DE"), false), "");
        assert_eq!(derive_country(&HeaderMap::new(), true), "");
    }

    #[test]
    fn country_normalizes_and_rejects_non_countries() {
        assert_eq!(derive_country(&geo_headers("de"), true), "DE");
        assert_eq!(derive_country(&geo_headers(" us "), true), "US");
        // Cloudflare's unknown/Tor sentinels are not countries — keeping them
        // would put two junk buckets in every breakdown.
        assert_eq!(derive_country(&geo_headers("XX"), true), "");
        assert_eq!(derive_country(&geo_headers("T1"), true), "");
        // Anything off-shape is dropped, which is what bounds the LowCardinality
        // dictionary to ~250 values.
        assert_eq!(derive_country(&geo_headers("DE; DROP"), true), "");
        assert_eq!(derive_country(&geo_headers("DEU"), true), "");
        assert_eq!(derive_country(&geo_headers("1"), true), "");
    }

    #[test]
    fn tinybird_destination_keeps_forward_mode_on_forward_path() {
        assert!(!uses_native_pipeline_for(
            WriteMode::Forward,
            ExportDestination::Tinybird
        ));
        assert!(uses_forward_path_for(
            WriteMode::Forward,
            ExportDestination::Tinybird
        ));
    }

    #[test]
    fn clickhouse_destination_is_terminal_in_dual_mode() {
        assert!(uses_native_pipeline_for(
            WriteMode::Dual,
            ExportDestination::ClickHouse
        ));
        assert!(!uses_forward_path_for(
            WriteMode::Dual,
            ExportDestination::ClickHouse
        ));
    }

    /// In-memory KeyStore used to exercise the resolver's behavior (caching,
    /// key-type inference, ResolvedIngestKey construction) without a database.
    /// Keyed on the same `(hash, column)` shape the real key store sees.
    #[derive(Default)]
    struct FakeKeyStore {
        keys: std::sync::Mutex<std::collections::HashMap<(String, &'static str), KeyRow>>,
        sources: std::sync::Mutex<std::collections::HashMap<String, SourceRow>>,
        /// Key id of every `record_source_used` call.
        source_uses: std::sync::Mutex<Vec<String>>,
        /// (key id, reason) of every `record_source_rejected` call.
        source_rejections: std::sync::Mutex<Vec<(String, String)>>,
        /// `sources` rows: (org id, id, kind).
        source_rows: std::sync::Mutex<Vec<(String, String, &'static str)>>,
        /// Connector id to its `source_id`, joined as the connector queries join it.
        connector_sources: std::sync::Mutex<std::collections::HashMap<String, String>>,
        source_row_fetches: AtomicU64,
        /// Pause windows of `source_rows`, by source id; absent means not paused.
        source_pauses: std::sync::Mutex<std::collections::HashMap<String, PauseWindow>>,
        /// The source ids each `claimable_source_ids` call asked about.
        claim_lookups: std::sync::Mutex<Vec<Vec<String>>>,
        /// Fails the source claim lookups.
        source_errors: AtomicBool,
        connectors: std::sync::Mutex<std::collections::HashMap<(String, String), ConnectorRow>>,
        gcp_connectors:
            std::sync::Mutex<std::collections::HashMap<(String, String), GcpConnectorRow>>,
        connector_successes: AtomicU64,
        /// (table, error) of every `record_connector_failure` call.
        connector_failures: std::sync::Mutex<Vec<(&'static str, String)>>,
        /// (connector id, report) of every `record_gcp_setup_report` call.
        gcp_setup_reports: std::sync::Mutex<Vec<(String, gcp_logging::SetupReport)>>,
        aws_connections:
            std::sync::Mutex<std::collections::HashMap<(String, String), AwsConnectionRow>>,
        /// (connection id, error) of every `record_aws_stream_health` call.
        aws_stream_health: std::sync::Mutex<Vec<(String, Option<String>)>>,
        routings: std::sync::Mutex<std::collections::HashMap<String, OrgRouting>>,
        targets: std::sync::Mutex<std::collections::HashMap<String, ClickHouseTargetRow>>,
        ingest_key_fetches: AtomicU64,
        connector_fetches: AtomicU64,
        routing_fetches: AtomicU64,
        target_fetches: AtomicU64,
        routing_errors: AtomicBool,
        /// Stored ingest rules by org, as `fetch_ingest_rules` returns them.
        ingest_rules: std::sync::Mutex<std::collections::HashMap<String, IngestRuleRows>>,
        ingest_rule_fetches: AtomicU64,
        /// Fails `fetch_ingest_rules`.
        ingest_rule_errors: AtomicBool,
        /// Every row `record_ingest_rule_stats` was given.
        ingest_rule_stats: std::sync::Mutex<Vec<IngestRuleStatRow>>,
    }

    impl FakeKeyStore {
        fn insert_private(&self, raw_key: &str, row: KeyRow) {
            let hash = hash_ingest_key(raw_key, "test-hmac-key").unwrap();
            self.set_org_routing(
                &row.org_id,
                OrgRouting {
                    self_managed: row.self_managed,
                    clickhouse_ready: row.clickhouse_ready,
                },
            );
            self.keys
                .lock()
                .unwrap()
                .insert((hash, "private_key_hash"), row);
        }

        fn insert_source(&self, raw_key: &str, row: SourceRow) {
            let hash = hash_ingest_key(raw_key, "test-hmac-key").unwrap();
            self.set_org_routing(&row.key.org_id, OrgRouting::from_key_row(&row.key));
            self.sources.lock().unwrap().insert(hash, row);
        }

        fn insert_connector(&self, connector_id: &str, raw_secret: &str, row: ConnectorRow) {
            let hash = hash_ingest_key(raw_secret, "test-hmac-key").unwrap();
            self.set_org_routing(
                &row.org_id,
                OrgRouting {
                    self_managed: row.self_managed,
                    clickhouse_ready: row.clickhouse_ready,
                },
            );
            self.connectors
                .lock()
                .unwrap()
                .insert((connector_id.to_owned(), hash), row);
        }

        fn insert_gcp_connector(&self, connector_id: &str, raw_secret: &str, row: GcpConnectorRow) {
            let hash = hash_ingest_key(raw_secret, "test-hmac-key").unwrap();
            self.set_org_routing(
                &row.org_id,
                OrgRouting {
                    self_managed: row.self_managed,
                    clickhouse_ready: row.clickhouse_ready,
                },
            );
            self.gcp_connectors
                .lock()
                .unwrap()
                .insert((connector_id.to_owned(), hash), row);
        }

        fn insert_aws_connection(
            &self,
            connection_id: &str,
            raw_secret: &str,
            row: AwsConnectionRow,
        ) {
            let hash = hash_ingest_key(raw_secret, "test-hmac-key").unwrap();
            self.set_org_routing(
                &row.org_id,
                OrgRouting {
                    self_managed: row.self_managed,
                    clickhouse_ready: row.clickhouse_ready,
                },
            );
            self.aws_connections
                .lock()
                .unwrap()
                .insert((connection_id.to_owned(), hash), row);
        }

        fn set_org_routing(&self, org_id: &str, routing: OrgRouting) {
            self.routings
                .lock()
                .unwrap()
                .insert(org_id.to_owned(), routing);
        }

        fn insert_clickhouse_target(&self, org_id: &str, row: ClickHouseTargetRow) {
            self.targets.lock().unwrap().insert(org_id.to_owned(), row);
        }
    }

    #[async_trait::async_trait]
    impl KeyStore for FakeKeyStore {
        async fn fetch_ingest_key(
            &self,
            key_hash: &str,
            hash_column: &'static str,
        ) -> Result<Option<OrgKeyRow>, String> {
            self.ingest_key_fetches.fetch_add(1, Ordering::Relaxed);
            let key = self
                .keys
                .lock()
                .unwrap()
                .get(&(key_hash.to_owned(), hash_column))
                .cloned();
            Ok(key.map(|key| {
                let default_source_id = self
                    .source_rows
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|row| row.0 == key.org_id && row.2 == "default")
                    .map(|row| row.1.clone());
                OrgKeyRow {
                    key,
                    default_source_id,
                }
            }))
        }
        async fn fetch_source_by_token_hash(
            &self,
            key_hash: &str,
        ) -> Result<Option<SourceRow>, String> {
            self.ingest_key_fetches.fetch_add(1, Ordering::Relaxed);
            Ok(self.sources.lock().unwrap().get(key_hash).cloned())
        }
        async fn record_source_used(&self, key_id: &str, _now_ms: i64) -> Result<(), String> {
            self.source_uses.lock().unwrap().push(key_id.to_owned());
            Ok(())
        }
        async fn record_source_rejected(
            &self,
            key_id: &str,
            _now_ms: i64,
            reason: &str,
        ) -> Result<(), String> {
            self.source_rejections
                .lock()
                .unwrap()
                .push((key_id.to_owned(), reason.to_owned()));
            Ok(())
        }
        async fn claimable_source_ids(
            &self,
            org_id: &str,
            source_ids: &[String],
        ) -> Result<Vec<PullSourceRow>, String> {
            self.source_row_fetches.fetch_add(1, Ordering::Relaxed);
            self.claim_lookups.lock().unwrap().push(source_ids.to_vec());
            if self.source_errors.load(Ordering::Relaxed) {
                return Err("source lookup failed".to_owned());
            }
            Ok(self
                .source_rows
                .lock()
                .unwrap()
                .iter()
                .filter(|row| {
                    row.0 == org_id && row.2 == "integration" && source_ids.contains(&row.1)
                })
                .map(|row| self.pull_source_row(&row.1))
                .collect())
        }
        async fn fetch_connector(
            &self,
            connector_id: &str,
            secret_hash: &str,
        ) -> Result<Option<ConnectorRow>, String> {
            self.connector_fetches.fetch_add(1, Ordering::Relaxed);
            let row = self
                .connectors
                .lock()
                .unwrap()
                .get(&(connector_id.to_owned(), secret_hash.to_owned()))
                .cloned();
            Ok(row.map(|row| ConnectorRow {
                source: self.joined_source(connector_id, &row.org_id),
                ..row
            }))
        }
        async fn fetch_gcp_connector(
            &self,
            connector_id: &str,
            secret_hash: &str,
        ) -> Result<Option<GcpConnectorRow>, String> {
            let row = self
                .gcp_connectors
                .lock()
                .unwrap()
                .get(&(connector_id.to_owned(), secret_hash.to_owned()))
                .cloned();
            Ok(row.map(|row| self.with_joined_source(connector_id, row)))
        }
        async fn fetch_gcp_connector_by_id(
            &self,
            connector_id: &str,
        ) -> Result<Option<GcpConnectorRow>, String> {
            let row = self
                .gcp_connectors
                .lock()
                .unwrap()
                .iter()
                .find(|((id, _), _)| id == connector_id)
                .map(|(_, row)| row.clone());
            Ok(row.map(|row| self.with_joined_source(connector_id, row)))
        }
        async fn fetch_sampling_policy(
            &self,
            _org_id: &str,
        ) -> Result<Option<SamplingPolicyRow>, String> {
            Ok(None)
        }
        async fn fetch_attribute_mappings(
            &self,
            _org_id: &str,
        ) -> Result<Vec<AttributeMappingRow>, String> {
            Ok(Vec::new())
        }
        async fn fetch_ingest_rules(&self, org_id: &str) -> Result<IngestRuleRows, String> {
            self.ingest_rule_fetches.fetch_add(1, Ordering::Relaxed);
            if self.ingest_rule_errors.load(Ordering::Relaxed) {
                return Err("fake ingest rule lookup failure".to_owned());
            }
            Ok(self
                .ingest_rules
                .lock()
                .unwrap()
                .get(org_id)
                .cloned()
                .unwrap_or_default())
        }
        async fn record_ingest_rule_stats(
            &self,
            rows: &[IngestRuleStatRow],
        ) -> Result<(), String> {
            self.ingest_rule_stats.lock().unwrap().extend_from_slice(rows);
            Ok(())
        }
        async fn fetch_clickhouse_target(
            &self,
            org_id: &str,
        ) -> Result<Option<ClickHouseTargetRow>, String> {
            self.target_fetches.fetch_add(1, Ordering::Relaxed);
            Ok(self.targets.lock().unwrap().get(org_id).cloned())
        }
        async fn fetch_org_routing(&self, org_id: &str) -> Result<Option<OrgRouting>, String> {
            self.routing_fetches.fetch_add(1, Ordering::Relaxed);
            if self.routing_errors.load(Ordering::Relaxed) {
                return Err("simulated routing store outage".to_owned());
            }
            Ok(self.routings.lock().unwrap().get(org_id).cloned())
        }
        async fn record_connector_success(
            &self,
            _table: &'static str,
            _connector_id: &str,
            _now_ms: i64,
        ) -> Result<(), String> {
            self.connector_successes.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
        async fn record_connector_failure(
            &self,
            table: &'static str,
            _connector_id: &str,
            error: &str,
            _now_ms: i64,
        ) -> Result<(), String> {
            self.connector_failures
                .lock()
                .unwrap()
                .push((table, error.to_owned()));
            Ok(())
        }
        async fn record_gcp_setup_report(
            &self,
            connector_id: &str,
            report: gcp_logging::SetupReport,
            _now_ms: i64,
        ) -> Result<(), String> {
            self.gcp_setup_reports
                .lock()
                .unwrap()
                .push((connector_id.to_owned(), report));
            Ok(())
        }
        async fn fetch_aws_connection(
            &self,
            connection_id: &str,
            secret_hash: &str,
        ) -> Result<Option<AwsConnectionRow>, String> {
            self.connector_fetches.fetch_add(1, Ordering::Relaxed);
            let row = self
                .aws_connections
                .lock()
                .unwrap()
                .get(&(connection_id.to_owned(), secret_hash.to_owned()))
                .cloned();
            Ok(row.map(|row| AwsConnectionRow {
                source: self.joined_source(connection_id, &row.org_id),
                ..row
            }))
        }
        async fn record_aws_stream_health(
            &self,
            connection_id: &str,
            error: Option<&str>,
            _now_ms: i64,
        ) -> Result<(), String> {
            self.aws_stream_health
                .lock()
                .unwrap()
                .push((connection_id.to_owned(), error.map(str::to_owned)));
            Ok(())
        }
    }

    fn make_routing_resolver(store: Arc<FakeKeyStore>, ttl: Duration) -> Arc<OrgRoutingResolver> {
        let store: Arc<dyn KeyStore> = store;
        Arc::new(OrgRoutingResolver {
            store,
            cache: Cache::builder().time_to_live(ttl).max_capacity(16).build(),
            last_known: DashMap::new(),
        })
    }

    fn make_resolver(store: Arc<FakeKeyStore>) -> IngestKeyResolver {
        make_resolver_with_routing_ttl(store, Duration::from_mins(1))
    }

    fn make_resolver_with_routing_ttl(
        store: Arc<FakeKeyStore>,
        routing_ttl: Duration,
    ) -> IngestKeyResolver {
        let routing = make_routing_resolver(Arc::clone(&store), routing_ttl);
        let store: Arc<dyn KeyStore> = store;
        IngestKeyResolver {
            store,
            lookup_hmac_key: "test-hmac-key".to_owned(),
            cache: Cache::builder()
                .time_to_live(Duration::from_mins(1))
                .max_capacity(16)
                .build(),
            negative_cache: Cache::builder()
                .time_to_live(Duration::from_secs(30))
                .max_capacity(16)
                .build(),
            routing,
            recent_key_uses: recent_key_uses_cache(),
            recent_key_rejections: recent_key_rejections_cache(),
            source_claims: source_claims_cache(Duration::from_mins(1)),
            blocked_keys: Arc::default(),
        }
    }

    #[derive(Debug)]
    struct FakeClickHouseImport {
        query: String,
        database: String,
        user: String,
        content_encoding: String,
        body: String,
    }

    #[derive(Debug)]
    struct FakeForwardImport {
        content_type: String,
        content_encoding: String,
        body_len: usize,
    }

    async fn fake_clickhouse_import(
        State(tx): State<tokio::sync::mpsc::UnboundedSender<FakeClickHouseImport>>,
        Query(query): Query<std::collections::HashMap<String, String>>,
        headers: HeaderMap,
        body: Bytes,
    ) -> StatusCode {
        let decoded = String::from_utf8(
            gunzip_bounded(&body, usize::MAX).expect("fake ClickHouse should receive gzip NDJSON"),
        )
        .expect("fake ClickHouse should receive UTF-8 NDJSON");

        drop(
            tx.send(FakeClickHouseImport {
                query: query.get("query").cloned().unwrap_or_default(),
                database: query.get("database").cloned().unwrap_or_default(),
                user: headers
                    .get("x-clickhouse-user")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .to_owned(),
                content_encoding: headers
                    .get(CONTENT_ENCODING)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .to_owned(),
                body: decoded,
            }),
        );

        StatusCode::OK
    }

    async fn fake_forward_collector(
        State(tx): State<tokio::sync::mpsc::UnboundedSender<FakeForwardImport>>,
        headers: HeaderMap,
        body: Bytes,
    ) -> StatusCode {
        drop(
            tx.send(FakeForwardImport {
                content_type: headers
                    .get(CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .to_owned(),
                content_encoding: headers
                    .get(CONTENT_ENCODING)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .to_owned(),
                body_len: body.len(),
            }),
        );
        StatusCode::OK
    }

    fn unique_main_test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "maple-ingest-main-{name}-{}-{}",
            std::process::id(),
            current_time_millis()
        ))
    }

    fn test_tinybird_config(queue_dir: PathBuf) -> TinybirdConfig {
        TinybirdConfig {
            endpoint: String::new(),
            token: String::new(),
            queue_dir,
            queue_max_bytes: 1024 * 1024,
            org_queue_max_bytes: 1024 * 1024,
            queue_channel_capacity: 10,
            wal_shards: 1,
            wal_segment_max_bytes: maple_ingest::telemetry::WAL_SEGMENT_MAX_BYTES,
            wal_store_heartbeat_interval: maple_ingest::wal_store::DEFAULT_HEARTBEAT_INTERVAL,
            batch_max_rows: 100,
            batch_max_bytes: 1024 * 1024,
            queue_max_age: Duration::ZERO,
            batch_max_wait: Duration::from_millis(1),
            export_concurrency_per_shard: 1,
            export_max_attempts: 1,
            clickhouse_export_timeout: Duration::from_secs(5),
            clickhouse_breaker: ClickHouseBreakerConfig::default(),
            clickhouse_allow_private_endpoints: true,
            datasources: DatasourceNames::defaults(),
            datasource_session_replays: "session_replays".to_owned(),
            datasource_session_replay_events: "session_replay_events".to_owned(),
            datasource_session_events: "session_events".to_owned(),
            datasource_product_events: "product_events".to_owned(),
        }
    }

    fn test_log_request(message: &str) -> ExportLogsServiceRequest {
        ExportLogsServiceRequest {
            resource_logs: vec![ResourceLogs {
                resource: Some(Resource {
                    attributes: vec![KeyValue {
                        key: "service.name".to_owned(),
                        key_strindex: 0,
                        value: Some(AnyValue {
                            value: Some(any_value::Value::StringValue("routing-test".to_owned())),
                        }),
                    }],
                    dropped_attributes_count: 0,
                    entity_refs: Vec::new(),
                }),
                scope_logs: vec![ScopeLogs {
                    scope: Some(InstrumentationScope {
                        name: "routing-logger".to_owned(),
                        version: "1.0.0".to_owned(),
                        attributes: Vec::new(),
                        dropped_attributes_count: 0,
                    }),
                    log_records: vec![LogRecord {
                        time_unix_nano: 1_700_000_002_000_000_000,
                        observed_time_unix_nano: 1_700_000_002_000_000_000,
                        severity_number: 9,
                        severity_text: "INFO".to_owned(),
                        body: Some(AnyValue {
                            value: Some(any_value::Value::StringValue(message.to_owned())),
                        }),
                        ..Default::default()
                    }],
                    schema_url: String::new(),
                }],
                schema_url: String::new(),
            }],
        }
    }

    fn test_headers(raw_key: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            format!("Bearer {raw_key}")
                .parse()
                .expect("valid auth header"),
        );
        headers.insert(CONTENT_TYPE, "application/x-protobuf".parse().unwrap());
        headers
    }

    async fn test_app_state(
        store: Arc<FakeKeyStore>,
        queue_dir: PathBuf,
        forward_endpoint: String,
        routing_ttl: Duration,
    ) -> AppState {
        let tinybird = test_tinybird_config(queue_dir);
        let key_store: Arc<dyn KeyStore> = Arc::<FakeKeyStore>::clone(&store);
        let routing = make_routing_resolver(Arc::clone(&store), routing_ttl);
        let clickhouse_targets = Arc::new(ClickHouseTargetResolver::new(
            Arc::clone(&key_store),
            None,
            16,
        ));
        let http_client = Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let telemetry_pipeline = TelemetryPipeline::new_with_clickhouse_validation(
            tinybird.clone(),
            http_client.clone(),
            Some(clickhouse_targets),
            false,
        )
        .await
        .expect("test pipeline should start without Tinybird credentials");

        AppState {
            key_store_ready: Arc::new(AtomicBool::new(true)),
            config: AppConfig {
                port: 0,
                otlp_grpc_port: None,
                internal_org_id: "org_test_internal".to_owned(),
                forward_endpoint,
                forward_timeout: Duration::from_secs(5),
                self_trace_sample_ratio: 1.0,
                write_mode: WriteMode::Forward,
                tinybird,
                max_request_body_bytes: 1024 * 1024,
                max_decoded_body_bytes: 8 * 1024 * 1024,
                org_max_in_flight: 100,
                rate_limit_fleet_size: 1,
                gcp_org_max_in_flight: 100,
                request_timeout: Duration::from_secs(30),
                require_tls: false,
                key_store_backend: KeyStoreBackend::Static {
                    org_id: "org_test".to_owned(),
                },
                clickhouse_encryption_key: None,
                lookup_hmac_key: "test-hmac-key".to_owned(),
                autumn_secret_key: None,
                autumn_api_url: "https://api.useautumn.com".to_owned(),
                autumn_flush_interval_secs: 1,
                autumn_allow_ttl_secs: 60,
                autumn_deny_ttl_secs: 5,
                ingest_key_cache_ttl_secs: 60,
                org_routing_cache_ttl_secs: 5,
                ingest_rules_enabled: false,
                ingest_rules_cache_ttl_secs: 30,
                replay_max_session_bytes: 1024 * 1024 * 1024,
                replay_blob_store: None,
                trust_proxy_geo: false,
                shutdown_drain_secs: 1,
                wal_store: None,
                invalid_key_message: "Invalid ingest key",
                blocked_ingest_keys: Arc::default(),
            },
            #[expect(
                clippy::useless_conversion,
                reason = "identity in normal builds; under `--features hotpath` this wraps the \
                          client in the instrumented type"
            )]
            http_client: http_client.into(),
            telemetry_pipeline: Some(telemetry_pipeline),
            resolver: IngestKeyResolver {
                store: Arc::clone(&key_store),
                lookup_hmac_key: "test-hmac-key".to_owned(),
                cache: Cache::builder()
                    .time_to_live(Duration::from_mins(1))
                    .max_capacity(16)
                    .build(),
                negative_cache: Cache::builder()
                    .time_to_live(Duration::from_secs(30))
                    .max_capacity(16)
                    .build(),
                routing: Arc::clone(&routing),
                recent_key_uses: recent_key_uses_cache(),
                recent_key_rejections: recent_key_rejections_cache(),
                source_claims: source_claims_cache(Duration::from_mins(1)),
                blocked_keys: Arc::default(),
            },
            org_inflight_limiter: OrgInFlightLimiter::new(100),
            key_rate_limiter: SourceRateLimiter::new(1),
            gcp_inflight_limiter: OrgInFlightLimiter::for_route(100, "gcp_in_flight"),
            sampling_resolver: SamplingPolicyResolver {
                store: Arc::clone(&key_store),
                cache: Cache::builder()
                    .time_to_live(Duration::from_secs(30))
                    .max_capacity(16)
                    .build(),
            },
            attribute_mapping_resolver: AttributeMappingResolver {
                store: Arc::clone(&key_store),
                cache: Cache::builder()
                    .time_to_live(Duration::from_secs(30))
                    .max_capacity(16)
                    .build(),
            },
            ingest_rule_resolver: IngestRuleResolver::new(
                Arc::clone(&key_store),
                false,
                Duration::from_secs(30),
                16,
            ),
            ingest_rule_stats: Arc::new(IngestRuleStatsSink::default()),
            cloudflare_resolver: CloudflareConnectorResolver {
                store: Arc::clone(&key_store),
                lookup_hmac_key: "test-hmac-key".to_owned(),
                cache: Cache::builder()
                    .time_to_live(Duration::from_mins(1))
                    .max_capacity(16)
                    .build(),
                routing: Arc::clone(&routing),
            },
            gcp_resolver: GcpConnectorResolver::new(
                Arc::clone(&key_store),
                "test-hmac-key".to_owned(),
                Arc::clone(&routing),
                Duration::from_mins(1),
                GooglePushAuth::with_keys(gcp_push_test_keys()),
            ),
            aws_resolver: AwsConnectionResolver::new(
                key_store,
                "test-hmac-key".to_owned(),
                routing,
                Duration::from_mins(1),
            ),
            autumn_tracker: None,
            autumn_entitlements: None,
            usage_metrics: None,
            replay_session_budget: ReplaySessionBudget::new(1024 * 1024 * 1024),
            replay_blob_store: None,
        }
    }

    /// Point a state's replay payloads at a fake S3 endpoint. Mirrors what
    /// `INGEST_REPLAY_R2_*` does in `Config::from_env`.
    fn with_replay_blob_store(mut state: AppState, endpoint: String) -> AppState {
        let config = ReplayBlobStoreConfig {
            endpoint,
            bucket: "replays".to_owned(),
            access_key_id: "test-access-key".to_owned(),
            secret_access_key: "test-secret-key".to_owned(),
            region: "auto".to_owned(),
            timeout: Duration::from_secs(5),
        };
        state.replay_blob_store = Some(ReplayBlobStore::new(
            state.http_client.clone(),
            &config.endpoint,
            config.bucket.clone(),
            config.access_key_id.clone(),
            config.secret_access_key.clone(),
            config.region.clone(),
            config.timeout,
        ));
        state.config.replay_blob_store = Some(config);
        state
    }

    #[tokio::test]
    async fn replay_budget_truncates_session_at_its_ceiling() {
        let budget = ReplaySessionBudget::new(1_000);

        // Under the ceiling: the session keeps accepting chunks.
        assert_eq!(budget.add("org_a", "s1", 400).await, 400);
        assert!(!budget.is_exhausted("org_a", "s1").await);
        assert_eq!(budget.add("org_a", "s1", 400).await, 800);
        assert!(!budget.is_exhausted("org_a", "s1").await);

        // The chunk that crosses is still accepted, so the recording truncates on
        // a chunk boundary rather than mid-payload.
        assert_eq!(budget.add("org_a", "s1", 400).await, 1_200);
        assert!(budget.is_exhausted("org_a", "s1").await);
    }

    #[tokio::test]
    async fn replay_budget_scopes_totals_per_session_and_org() {
        let budget = ReplaySessionBudget::new(1_000);
        budget.add("org_a", "s1", 1_200).await;

        // A different session in the same org is unaffected...
        assert!(!budget.is_exhausted("org_a", "s2").await);
        // ...as is the same session id belonging to a different org, so one
        // tenant cannot exhaust another's budget by guessing session ids.
        assert!(!budget.is_exhausted("org_b", "s1").await);
        assert!(budget.is_exhausted("org_a", "s1").await);
    }

    #[tokio::test]
    async fn replay_budget_disabled_when_limit_is_zero() {
        let budget = ReplaySessionBudget::new(0);
        budget.add("org_a", "s1", u64::MAX / 2).await;
        assert!(!budget.is_exhausted("org_a", "s1").await);
    }

    /// What a fake R2 recorded for one PUT.
    #[derive(Debug)]
    struct CapturedPut {
        path: String,
        authorization: String,
        content_type: String,
        content_encoding: String,
        body: Vec<u8>,
    }

    async fn fake_r2_put(
        State(tx): State<tokio::sync::mpsc::UnboundedSender<CapturedPut>>,
        Path(path): Path<String>,
        headers: HeaderMap,
        body: Bytes,
    ) -> StatusCode {
        let header = |name: &str| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_owned()
        };
        drop(tx.send(CapturedPut {
            path,
            authorization: header("authorization"),
            content_type: header("content-type"),
            content_encoding: header("content-encoding"),
            body: body.to_vec(),
        }));
        StatusCode::OK
    }

    async fn always_500() -> StatusCode {
        StatusCode::INTERNAL_SERVER_ERROR
    }

    fn gzip_bytes(plain: &str) -> Bytes {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(plain.as_bytes()).unwrap();
        Bytes::from(encoder.finish().unwrap())
    }

    fn replay_blob_headers(raw_key: &str, session_id: &str, chunk_seq: u32) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            format!("Bearer {raw_key}").parse().unwrap(),
        );
        headers.insert("x-maple-session-id", session_id.parse().unwrap());
        headers.insert("x-maple-chunk-seq", chunk_seq.to_string().parse().unwrap());
        headers.insert("x-maple-event-count", "3".parse().unwrap());
        headers.insert("x-maple-duration-ms", "1200".parse().unwrap());
        headers
    }

    /// Total bytes the pipeline has committed to disk. The WAL is appended
    /// before a frame reaches the export channel, so this growing is the
    /// observable "a row was enqueued".
    fn queue_dir_bytes(dir: &std::path::Path) -> u64 {
        fn walk(dir: &std::path::Path) -> u64 {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return 0;
            };
            entries
                .flatten()
                .map(|entry| match entry.metadata() {
                    Ok(meta) if meta.is_dir() => walk(&entry.path()),
                    Ok(meta) => meta.len(),
                    Err(_) => 0,
                })
                .sum()
        }
        walk(dir)
    }

    async fn replay_blob_test_state(raw_key: &str, org_id: &str, queue_dir: PathBuf) -> AppState {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_private(
            raw_key,
            KeyRow {
                org_id: org_id.to_owned(),
                // Routes to ClickHouse. The fixture's `WriteMode::Forward` has no
                // Tinybird pipeline, so a Tinybird-destined chunk would 503 in
                // `native_rows_pipeline_for` before reaching the blob path.
                self_managed: true,
                clickhouse_ready: true,
            },
        );
        test_app_state(
            store,
            queue_dir,
            "http://127.0.0.1:1".to_owned(),
            Duration::from_secs(30),
        )
        .await
    }

    #[tokio::test]
    async fn replay_chunk_payload_goes_to_the_blob_store_verbatim() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/{*path}", axum::routing::put(fake_r2_put))
            .with_state(tx);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let queue_dir = unique_main_test_dir("replay-blob-put");
        let state = replay_blob_test_state(
            "maple_sk_test_replay_blob",
            "org_replay_blob",
            queue_dir.clone(),
        )
        .await;
        let state = with_replay_blob_store(state, format!("http://{addr}"));

        let events = r#"[{"type":2,"timestamp":1}]"#;
        let gzipped = gzip_bytes(events);
        handle_replay_blob_inner(
            &state,
            &replay_blob_headers("maple_sk_test_replay_blob", "sess_42", 7),
            gzipped.clone(),
        )
        .await
        .expect("blob upload should succeed");

        let captured = rx.recv().await.expect("the blob store should see a PUT");

        // Key scheme: bucket first, then the v1/{org}/{session}/{seq}.json.gz
        // that the API side reconstructs from the ClickHouse row.
        assert_eq!(
            captured.path,
            "replays/v1/org_replay_blob/sess_42/00000007.json.gz"
        );
        // Stored verbatim — not re-gzipped, not the decompressed text. A
        // recompression here would silently double ingest CPU and break the
        // Content-Encoding contract the reader depends on.
        assert_eq!(captured.body, gzipped.to_vec());
        assert_eq!(captured.content_type, "application/json");
        assert_eq!(captured.content_encoding, "gzip");
        assert!(
            captured
                .authorization
                .starts_with("AWS4-HMAC-SHA256 Credential=test-access-key/"),
            "expected a SigV4 authorization header, got {:?}",
            captured.authorization
        );
        assert!(captured.authorization.contains("/auto/s3/aws4_request"));

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn a_failed_blob_upload_rejects_the_chunk_and_enqueues_no_row() {
        // The orphan-prevention invariant. A row whose payload never landed is
        // an unplayable gap in a session that still lists as recorded; the SDK
        // does not retry, so the only safe failure is to drop the chunk whole.
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new().route("/{*path}", axum::routing::put(always_500));
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let queue_dir = unique_main_test_dir("replay-blob-fail");
        let state = replay_blob_test_state(
            "maple_sk_test_replay_fail",
            "org_replay_fail",
            queue_dir.clone(),
        )
        .await;
        let state = with_replay_blob_store(state, format!("http://{addr}"));

        let before = queue_dir_bytes(&queue_dir);
        let error = handle_replay_blob_inner(
            &state,
            &replay_blob_headers("maple_sk_test_replay_fail", "sess_fail", 1),
            gzip_bytes(r#"[{"type":2,"timestamp":1}]"#),
        )
        .await
        .expect_err("a blob store 500 must reject the chunk");

        assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            queue_dir_bytes(&queue_dir),
            before,
            "no index row may be committed when the payload was not stored"
        );

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    /// One request a fake Autumn saw: which endpoint, and the JSON body.
    #[derive(Debug)]
    struct AutumnCall {
        path: String,
        body: serde_json::Value,
    }

    impl AutumnCall {
        fn feature_id(&self) -> &str {
            self.body["feature_id"].as_str().unwrap_or_default()
        }
        fn tracked_value(&self) -> Option<f64> {
            self.body.get("value").and_then(serde_json::Value::as_f64)
        }
    }

    async fn fake_autumn(
        axum::extract::State(tx): axum::extract::State<
            tokio::sync::mpsc::UnboundedSender<AutumnCall>,
        >,
        Path(path): Path<String>,
        body: Bytes,
    ) -> axum::Json<serde_json::Value> {
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
        let _ = tx.send(AutumnCall { path, body });
        axum::Json(serde_json::json!({ "allowed": true }))
    }

    /// Spawn a fake Autumn that allows everything and records every call, and
    /// point `state` at it with billing enforcement enabled.
    async fn with_fake_autumn(
        mut state: AppState,
    ) -> (AppState, tokio::sync::mpsc::UnboundedReceiver<AutumnCall>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/v1/{*path}", post(fake_autumn))
            .with_state(tx);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let api_url = format!("http://{addr}");
        state.autumn_entitlements = Some(AutumnEntitlements::new(
            state.http_client.clone(),
            "am_sk_test".to_string(),
            &api_url,
            // A one-second allow TTL, so a test that wants a second gate can
            // have one without a long sleep; the decision cache itself is
            // tested in `autumn.rs`.
            1,
            1,
        ));
        state.autumn_tracker = Some(AutumnTracker::spawn("am_sk_test".to_string(), &api_url, 1));
        (state, rx)
    }

    /// Point `state` at a fake Autumn that denies `denied_org` every feature
    /// and allows every other org.
    async fn with_autumn_denying(mut state: AppState, denied_org: &'static str) -> AppState {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new().route(
            "/v1/{*path}",
            post(move |body: Bytes| async move {
                let body: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
                axum::Json(serde_json::json!({ "allowed": body["customer_id"] != denied_org }))
            }),
        );
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        state.autumn_entitlements = Some(AutumnEntitlements::new(
            state.http_client.clone(),
            "am_sk_test".to_owned(),
            &format!("http://{addr}"),
            60,
            60,
        ));
        state
    }

    /// A fake collector for `WriteMode::Forward` to deliver logs to.
    async fn spawn_forward_collector() -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<FakeForwardImport>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/v1/logs", post(fake_forward_collector))
            .with_state(tx);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}"), rx)
    }

    /// Everything the fake Autumn has seen. The entitlement gate resolves before
    /// the handler returns, but usage is tracked out of band by the flush loop,
    /// so this waits out one flush interval before draining.
    async fn drain_autumn_calls(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<AutumnCall>,
    ) -> Vec<AutumnCall> {
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        let mut calls = Vec::new();
        while let Ok(call) = rx.try_recv() {
            calls.push(call);
        }
        calls
    }

    fn checks(calls: &[AutumnCall]) -> Vec<&AutumnCall> {
        calls
            .iter()
            .filter(|c| c.path == "balances.check")
            .collect()
    }

    /// Usage as Autumn was told it: `(feature_id, value)` per track call.
    fn tracked(calls: &[AutumnCall]) -> Vec<(&str, f64)> {
        calls
            .iter()
            .filter(|c| c.path == "balances.track")
            .filter_map(|c| c.tracked_value().map(|v| (c.feature_id(), v)))
            .collect()
    }

    fn bearer_headers(raw_key: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            format!("Bearer {raw_key}").parse().unwrap(),
        );
        headers
    }

    #[tokio::test]
    async fn product_events_endpoint_meters_each_enqueued_row_as_product_events() {
        let queue_dir = unique_main_test_dir("product-events-meter");
        let state =
            replay_blob_test_state("maple_sk_test_pe_meter", "org_pe_meter", queue_dir.clone())
                .await;
        let (state, mut rx) = with_fake_autumn(state).await;

        // Three valid rows and one the sanitiser drops (reserved `$`-prefixed
        // name). The dropped row is neither stored nor billed.
        let body = concat!(
            r#"{"name":"plan_started"}"#,
            "\n",
            r#"{"name":"$not_allowed"}"#,
            "\n",
            r#"{"name":"checkout_viewed","source":"mobile"}"#,
            "\n",
            r#"{"name":"$screen","source":"mobile","page_path":"Home"}"#,
            "\n",
        );
        let accepted = handle_product_events_inner(
            &state,
            &bearer_headers("maple_sk_test_pe_meter"),
            Bytes::from_static(body.as_bytes()),
        )
        .await
        .expect("product events should be accepted");
        assert_eq!(accepted, 3);

        let calls = drain_autumn_calls(&mut rx).await;
        // Every check on this endpoint is against `product_events`, never
        // `browser_sessions`. The check cannot reject here (`MeterAnyway`): a
        // gate would 402 every org whose Autumn customer has no
        // `product_events` balance yet, which is every org until the plan item
        // is pushed and granted — Autumn answers that with a real
        // `allowed: false`, not an error, so the fail-open does not cover it.
        let checks = checks(&calls);
        assert!(!checks.is_empty(), "expected Autumn checks, saw {calls:?}");
        for check in &checks {
            assert_eq!(check.feature_id(), "product_events", "{check:?}");
        }
        // Usage is billed once, for the enqueued row count, through the tracker.
        assert_eq!(tracked(&calls), vec![("product_events", 3.0)], "{calls:?}");

        let _ = std::fs::remove_dir_all(&queue_dir);
    }

    #[tokio::test]
    async fn custom_session_events_are_metered_as_product_events_but_gated_on_browser_sessions() {
        let queue_dir = unique_main_test_dir("session-events-custom-meter");
        let state =
            replay_blob_test_state("maple_sk_test_se_meter", "org_se_meter", queue_dir.clone())
                .await;
        let (state, mut rx) = with_fake_autumn(state).await;

        // Two `track()` calls, one automatic click, one unknown type (dropped).
        let body = concat!(
            r#"{"type":"custom","message":"signup_completed"}"#,
            "\n",
            r#"{"type":"click","message":"button#buy"}"#,
            "\n",
            r#"{"type":"custom","message":"plan_selected","attributes":{"plan":"pro"}}"#,
            "\n",
            r#"{"type":"not-a-real-type"}"#,
            "\n",
        );
        let accepted = handle_session_events_inner(
            &state,
            &bearer_headers("maple_sk_test_se_meter"),
            Bytes::from_static(body.as_bytes()),
        )
        .await
        .expect("session events should be accepted");
        assert_eq!(
            accepted, 3,
            "custom + click rows are stored, unknown is dropped"
        );

        let calls = drain_autumn_calls(&mut rx).await;

        // The REJECTING gate stays on browser_sessions: an exhausted
        // product-events allowance must not 402 a whole transcript. The
        // product_events check beside it is `MeterAnyway` and cannot reject.
        let gated: Vec<&str> = checks(&calls).iter().map(|c| c.feature_id()).collect();
        assert!(
            gated.contains(&"browser_sessions"),
            "the transcript must be gated on browser_sessions, saw {calls:?}"
        );

        // Only the two custom rows are billed, and as product_events.
        assert_eq!(tracked(&calls), vec![("product_events", 2.0)], "{calls:?}");

        let _ = std::fs::remove_dir_all(&queue_dir);
    }

    #[tokio::test]
    async fn session_events_without_custom_rows_bill_nothing() {
        let queue_dir = unique_main_test_dir("session-events-no-custom");
        let state =
            replay_blob_test_state("maple_sk_test_se_auto", "org_se_auto", queue_dir.clone()).await;
        let (state, mut rx) = with_fake_autumn(state).await;

        let body = concat!(
            r#"{"type":"click","message":"a"}"#,
            "\n",
            r#"{"type":"navigation","message":"/pricing"}"#,
            "\n",
        );
        let accepted = handle_session_events_inner(
            &state,
            &bearer_headers("maple_sk_test_se_auto"),
            Bytes::from_static(body.as_bytes()),
        )
        .await
        .expect("session events should be accepted");
        assert_eq!(accepted, 2);

        let calls = drain_autumn_calls(&mut rx).await;
        // Automatic events ride on the session's browser_sessions unit: the
        // gate fires and nothing is billed.
        assert!(tracked(&calls).is_empty(), "{calls:?}");
        assert_eq!(calls.len(), 1, "{calls:?}");
        assert_eq!(calls[0].path, "balances.check");
        assert_eq!(calls[0].feature_id(), "browser_sessions");

        let _ = std::fs::remove_dir_all(&queue_dir);
    }
    #[tokio::test]
    async fn replay_chunks_stay_inline_when_no_blob_store_is_configured() {
        // The self-hosted / BYO-ClickHouse path, and the pre-cutover managed
        // path: unset credentials must behave exactly as before.
        let queue_dir = unique_main_test_dir("replay-blob-inline");
        let state = replay_blob_test_state(
            "maple_sk_test_replay_inline",
            "org_replay_inline",
            queue_dir.clone(),
        )
        .await;
        assert!(state.replay_blob_store.is_none());

        let before = queue_dir_bytes(&queue_dir);
        handle_replay_blob_inner(
            &state,
            &replay_blob_headers("maple_sk_test_replay_inline", "sess_inline", 0),
            gzip_bytes(r#"[{"type":2,"timestamp":1}]"#),
        )
        .await
        .expect("the inline path should accept the chunk");

        assert!(
            queue_dir_bytes(&queue_dir) > before,
            "the inline path must still enqueue a row carrying the payload"
        );

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn replay_blob_gzip_bomb_is_refused_before_upload_and_budget() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/{*path}", axum::routing::put(fake_r2_put))
            .with_state(tx);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let (raw_key, org_id) = ("maple_sk_test_replay_bomb", "org_replay_bomb");
        let queue_dir = unique_main_test_dir("replay-blob-bomb");
        let state = replay_blob_test_state(raw_key, org_id, queue_dir.clone()).await;
        let mut state = with_replay_blob_store(state, format!("http://{addr}"));
        state.config.max_decoded_body_bytes = 1024 * 1024;

        let bomb = gzip_bytes(&"a".repeat(4 * 1024 * 1024));
        assert!(bomb.len() < 64 * 1024, "fixture should compress well");
        let error =
            handle_replay_blob_inner(&state, &replay_blob_headers(raw_key, "sess_bomb", 0), bomb)
                .await
                .expect_err("a chunk inflating past the decoded limit must be refused");
        assert_eq!(error.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(rx.try_recv().is_err(), "a refused chunk must not be stored");
        assert_eq!(
            state
                .replay_session_budget
                .add(org_id, "sess_bomb", 0)
                .await,
            0,
            "a refused chunk must not be charged to the session"
        );

        handle_replay_blob_inner(
            &state,
            &replay_blob_headers(raw_key, "sess_bomb", 1),
            gzip_bytes(r#"[{"type":2,"timestamp":1}]"#),
        )
        .await
        .expect("a normal chunk is still accepted");
        assert!(rx.recv().await.is_some(), "the normal chunk is stored");

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn inline_replay_and_otlp_refuse_gzip_bombs() {
        let queue_dir = unique_main_test_dir("inline-bomb");
        let (raw_key, org_id) = ("maple_sk_test_inline_bomb", "org_inline_bomb");
        let mut state = replay_blob_test_state(raw_key, org_id, queue_dir.clone()).await;
        state.config.max_decoded_body_bytes = 1024 * 1024;
        let bomb = || gzip_bytes(&"a".repeat(4 * 1024 * 1024));

        let error = handle_replay_blob_inner(
            &state,
            &replay_blob_headers(raw_key, "sess_inline_bomb", 0),
            bomb(),
        )
        .await
        .expect_err("inline replay must refuse a gzip bomb");
        assert_eq!(error.status, StatusCode::PAYLOAD_TOO_LARGE);

        let mut headers = test_headers(raw_key);
        headers.insert(CONTENT_ENCODING, "gzip".parse().unwrap());
        let (error, error_kind) = handle_signal_inner(&state, &headers, bomb(), Signal::Logs)
            .await
            .expect_err("OTLP must refuse a gzip bomb");
        assert_eq!(error.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(error_kind, "payload_too_large");

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[test]
    fn decode_payload_gunzips_within_the_decoded_limit() {
        let payload = r#"{"resourceSpans":[]}"#;
        let decoded = decode_payload(&gzip_bytes(payload), Some("gzip"), payload.len())
            .expect("a body at exactly the limit decodes");
        assert_eq!(decoded, payload.as_bytes());

        let plain = Bytes::from_static(b"raw");
        assert_eq!(decode_payload(&plain, None, 1).unwrap(), b"raw");

        let error = decode_payload(&Bytes::from_static(b"not gzip"), Some("gzip"), 1024)
            .expect_err("malformed gzip is rejected");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn decode_payload_rejects_gzip_that_inflates_past_the_limit() {
        // 4 MiB of one byte compresses to a few KiB, far under the body limit.
        let inflated = "a".repeat(4 * 1024 * 1024);
        let body = gzip_bytes(&inflated);
        assert!(body.len() < 64 * 1024, "fixture should compress well");

        let error = decode_payload(&body, Some("gzip"), 1024 * 1024)
            .expect_err("decoded size over the limit must be refused");
        assert_eq!(error.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(error.error_kind(), "payload_too_large");

        let decoded = decode_payload(&body, Some("gzip"), inflated.len())
            .expect("the same body decodes once the limit allows it");
        assert_eq!(decoded.len(), inflated.len());
    }

    #[test]
    fn replay_text_gunzip_is_bounded_and_keeps_utf8_rejection() {
        let events = r#"[{"type":2,"timestamp":1}]"#;
        assert_eq!(
            gunzip_replay_text(&gzip_bytes(events), events.len()).unwrap(),
            events
        );
        assert!(matches!(
            gunzip_replay_text(&gzip_bytes(events), events.len() - 1),
            Err(GunzipError::TooLarge)
        ));

        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(&[0xff, 0xfe]).unwrap();
        let not_utf8 = encoder.finish().unwrap();
        match gunzip_replay_text(&not_utf8, 1024) {
            Err(GunzipError::Invalid(error)) => {
                assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
            }
            other => panic!("expected an invalid-data error, got {other:?}"),
        }
    }

    #[test]
    fn decompressed_len_matches_read_to_string_and_rejects_garbage() {
        // `byte_size` is a published API field and the input to the per-session
        // budget, both denominated in decompressed bytes — the streaming counter
        // must not quietly redefine it as compressed bytes.
        for payload in [
            "[]",
            r#"[{"type":2,"timestamp":1}]"#,
            &"x".repeat(256 * 1024),
        ] {
            let gzipped = gzip_bytes(payload);
            assert_eq!(
                decompressed_len(&gzipped).expect("valid gzip should decode"),
                payload.len() as u64,
                "byte count drifted for a {}-byte payload",
                payload.len()
            );
        }

        let error = decompressed_len(b"not gzip at all")
            .expect_err("malformed gzip must still be rejected");
        let rejection = replay_gunzip_rejection(&HeaderMap::new(), b"not gzip at all", &error);
        assert_eq!(rejection.status, StatusCode::BAD_REQUEST);
        assert!(
            rejection
                .message
                .starts_with("failed to gunzip replay chunk: "),
            "message must keep the stable fingerprint prefix, got {:?}",
            rejection.message
        );
        // Never a gzip stream: a caller-side rejection, no telemetry lost.
        assert_eq!(rejection.error_kind(), "malformed_body");
        assert_eq!(
            otel_status_for_rejection(rejection.status.as_u16(), rejection.error_kind()),
            "Ok"
        );

        // The crawler signatures seen in production: a valid zero-MTIME header
        // missing the `8b`, and a body that stops after the magic bytes.
        // Plus a right-magic header with an unknown compression method, and one
        // with a reserved flag bit set: neither is a stream deflate ever wrote.
        for body in [
            &b"\x1f\x08\x00\x00\x00\x00\x00\x00\x03\xec\xbd\x89\x28\x2b\x1c\x39\x00\x00\x00\x00"[..],
            &b"\x1f\x8b\x08"[..],
            &b"\x1f\x8b\x07\x00\x00\x00\x00\x00\x00\x03\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"[..],
            &b"\x1f\x8b\x08\x80\x00\x00\x00\x00\x00\x03\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"[..],
        ] {
            let error = decompressed_len(body).expect_err("crawler body must be rejected");
            let rejection = replay_gunzip_rejection(&HeaderMap::new(), body, &error);
            assert_eq!(rejection.error_kind(), "malformed_body", "{:?}", body);
        }

        // A real stream cut short is a recording chunk we lost: still an `Error`.
        use std::io::Write as _;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&vec![b'x'; 4096]).unwrap();
        let gzipped = encoder.finish().unwrap();
        let truncated = &gzipped[..gzipped.len() / 2];
        let error = decompressed_len(truncated).expect_err("truncated gzip must be rejected");
        let rejection = replay_gunzip_rejection(&HeaderMap::new(), truncated, &error);
        assert_eq!(rejection.error_kind(), "bad_request");
        assert_eq!(
            otel_status_for_rejection(rejection.status.as_u16(), rejection.error_kind()),
            "Error"
        );
    }

    #[tokio::test]
    async fn unresolvable_clickhouse_target_is_only_looked_up_once_per_ttl() {
        // The export retry loop calls this on every attempt of every batch, and a
        // `None` used to be the one outcome nothing cached — so an org with no
        // target row (or one stamped with a schema revision this binary predates)
        // drove `INGEST_EXPORT_MAX_ATTEMPTS` Postgres queries per batch, against
        // the same 8-connection pool the accept path resolves ingest keys
        // through.
        let store = Arc::new(FakeKeyStore::default());
        let resolver =
            ClickHouseTargetResolver::new(Arc::clone(&store) as Arc<dyn KeyStore>, None, 16);

        for _ in 0..20 {
            assert!(resolver
                .resolve_clickhouse_target("org_missing")
                .await
                .unwrap()
                .is_none());
        }
        assert_eq!(
            store.target_fetches.load(Ordering::Relaxed),
            1,
            "a missing target must be remembered, not re-queried on every attempt"
        );

        // A row stamped with a revision this binary refuses — here the legacy
        // content-hash shape, which parses to -1 — is equally unresolvable, and
        // equally pointless to re-query.
        store.insert_clickhouse_target(
            "org_legacy_revision",
            ClickHouseTargetRow {
                ch_url: "https://ch.example.com".to_owned(),
                ch_user: "ingest".to_owned(),
                ch_password_ciphertext: None,
                ch_password_iv: None,
                ch_password_tag: None,
                ch_database: "maple".to_owned(),
                schema_version: "2967fa9b".to_owned(),
            },
        );
        for _ in 0..20 {
            assert!(resolver
                .resolve_clickhouse_target("org_legacy_revision")
                .await
                .unwrap()
                .is_none());
        }
        assert_eq!(
            store.target_fetches.load(Ordering::Relaxed),
            2,
            "a refused schema revision must be remembered too"
        );
    }

    #[tokio::test]
    async fn request_timeout_sheds_a_stalled_request_as_a_retryable_503() {
        // The condition this exists for: a handler that neither fails nor
        // returns. Before the deadline the request simply sat there, so the
        // stall showed up as p95 in the tens of seconds with a per-route error
        // rate of zero — a hung request is not a failed one, and nothing on the
        // accept path was counting the difference.
        // A parameterised route, so the middleware's `MatchedPath` lookup is
        // exercised on the shape that would otherwise put one metric label on
        // every connector id.
        let app = Router::new()
            .route(
                "/v1/logpush/cloudflare/http_requests/{connector_id}",
                post(|| async {
                    std::future::pending::<()>().await;
                    StatusCode::OK
                }),
            )
            .layer(axum::middleware::from_fn_with_state(
                Duration::from_millis(50),
                request_timeout_middleware,
            ));

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let response = Client::new()
            .post(format!(
                "http://{addr}/v1/logpush/cloudflare/http_requests/conn_abc123"
            ))
            .body("x")
            .send()
            .await
            .expect("the gateway must answer rather than hang");

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        // Retry-After and a retryable tag are the difference between a client
        // that backs off and one that hammers a saturated gateway.
        assert_eq!(
            response
                .headers()
                .get(RETRY_AFTER)
                .and_then(|value| value.to_str().ok()),
            Some("5")
        );
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["error"]["_tag"], "@maple/ingest/RequestTimeout");
        assert_eq!(body["error"]["retryable"], true);
    }

    #[test]
    fn replay_gunzip_rejection_keeps_body_bytes_out_of_the_message() {
        // The message is the error fingerprint. Diagnostics (hex prefix,
        // content-type) go on the span so one cause stays one issue.
        let error = decompressed_len(b"[{\"type\":4}]").expect_err("json is not gzip");
        let mut headers = HeaderMap::new();
        headers.insert("content-type", "application/octet-stream".parse().unwrap());
        let rejection = replay_gunzip_rejection(&headers, b"[{\"type\":4}]", &error);
        assert!(!rejection.message.contains("5b7b"), "{}", rejection.message);
        assert!(
            !rejection.message.contains("octet-stream"),
            "{}",
            rejection.message
        );
        assert_eq!(hex_prefix(b"\x1f\x8b\x08\x00", 16), "1f8b0800");
        assert_eq!(hex_prefix(b"[{", 1), "5b");
        assert_eq!(truncate_chars("héllo", 2), "hé");
        assert_eq!(truncate_chars("ab", 5), "ab");
    }

    #[tokio::test]
    async fn resolve_ingest_key_returns_self_managed_false_when_no_settings_row() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_private(
            "maple_sk_test_shared",
            KeyRow {
                org_id: "org_shared".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );

        let resolved = make_resolver(store)
            .resolve_ingest_key("maple_sk_test_shared")
            .await
            .expect("resolve should succeed")
            .expect("key should be found");

        assert_eq!(resolved.org_id, "org_shared");
        assert!(!resolved.self_managed);
        assert!(!resolved.clickhouse_ready);
    }

    #[tokio::test]
    async fn resolve_ingest_key_returns_self_managed_true_when_active_settings_row() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_private(
            "maple_sk_test_byo",
            KeyRow {
                org_id: "org_byo".to_owned(),
                self_managed: true,
                clickhouse_ready: true,
            },
        );

        let resolved = make_resolver(store)
            .resolve_ingest_key("maple_sk_test_byo")
            .await
            .expect("resolve should succeed")
            .expect("key should be found");

        assert_eq!(resolved.org_id, "org_byo");
        assert!(resolved.self_managed);
        assert!(resolved.clickhouse_ready);
    }

    #[tokio::test]
    async fn resolve_ingest_key_keeps_stale_schema_on_managed_native_path() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_private(
            "maple_sk_test_stale_schema",
            KeyRow {
                org_id: "org_stale".to_owned(),
                self_managed: true,
                clickhouse_ready: false,
            },
        );

        let resolved = make_resolver(store)
            .resolve_ingest_key("maple_sk_test_stale_schema")
            .await
            .expect("resolve should succeed")
            .expect("key should be found");

        assert!(resolved.self_managed);
        assert!(!resolved.clickhouse_ready);
        assert_eq!(
            native_destination_for(&resolved),
            ExportDestination::Tinybird
        );
    }

    #[tokio::test]
    async fn resolve_ingest_key_refreshes_routing_before_auth_cache_expires() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_private(
            "maple_sk_test_becomes_ready",
            KeyRow {
                org_id: "org_transition".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );

        let resolver = make_resolver_with_routing_ttl(Arc::clone(&store), Duration::from_millis(5));
        let first = resolver
            .resolve_ingest_key("maple_sk_test_becomes_ready")
            .await
            .expect("resolve should succeed")
            .expect("key should be found");
        assert!(!first.clickhouse_ready);
        assert_eq!(store.ingest_key_fetches.load(Ordering::Relaxed), 1);

        store.set_org_routing(
            "org_transition",
            OrgRouting {
                self_managed: true,
                clickhouse_ready: true,
            },
        );
        tokio::time::sleep(Duration::from_millis(10)).await;

        let second = resolver
            .resolve_ingest_key("maple_sk_test_becomes_ready")
            .await
            .expect("resolve should succeed")
            .expect("key should be found");
        assert!(second.self_managed);
        assert!(second.clickhouse_ready);
        assert_eq!(
            native_destination_for(&second),
            ExportDestination::ClickHouse
        );
        assert_eq!(
            store.ingest_key_fetches.load(Ordering::Relaxed),
            1,
            "auth identity should stay cached while routing refreshes"
        );
        assert_eq!(store.routing_fetches.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn resolve_ingest_key_serves_last_known_routing_when_refresh_fails() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_private(
            "maple_sk_test_d1_blip",
            KeyRow {
                org_id: "org_d1_blip".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );

        let resolver = make_resolver_with_routing_ttl(Arc::clone(&store), Duration::from_millis(5));
        let first = resolver
            .resolve_ingest_key("maple_sk_test_d1_blip")
            .await
            .expect("initial resolve should succeed")
            .expect("key should be found");
        assert!(!first.clickhouse_ready);

        store.set_org_routing(
            "org_d1_blip",
            OrgRouting {
                self_managed: true,
                clickhouse_ready: true,
            },
        );
        tokio::time::sleep(Duration::from_millis(10)).await;

        let ready = resolver
            .resolve_ingest_key("maple_sk_test_d1_blip")
            .await
            .expect("routing refresh should succeed")
            .expect("key should be found");
        assert!(ready.clickhouse_ready);

        store.routing_errors.store(true, Ordering::Relaxed);
        tokio::time::sleep(Duration::from_millis(10)).await;

        let stale = resolver
            .resolve_ingest_key("maple_sk_test_d1_blip")
            .await
            .expect("warm key should not 503 when routing refresh fails")
            .expect("key should be found");
        assert!(
            stale.clickhouse_ready,
            "last-known ready routing should be served during a routing-store outage"
        );
        assert_eq!(
            store.ingest_key_fetches.load(Ordering::Relaxed),
            1,
            "auth identity should stay cached through the routing-store outage"
        );
        assert!(
            store.routing_fetches.load(Ordering::Relaxed) >= 2,
            "routing refresh should have been attempted before falling back to stale"
        );
    }

    #[tokio::test]
    async fn resolve_connector_refreshes_routing_before_auth_cache_expires() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_connector(
            "connector_ready_later",
            "secret-before-ready",
            ConnectorRow {
                org_id: "org_logpush_transition".to_owned(),
                service_name: "cloudflare/example.com".to_owned(),
                zone_name: "example.com".to_owned(),
                dataset: "http_requests".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
                source: None,
            },
        );
        let routing = make_routing_resolver(Arc::clone(&store), Duration::from_millis(5));
        let key_store: Arc<dyn KeyStore> = Arc::<FakeKeyStore>::clone(&store);
        let resolver = CloudflareConnectorResolver {
            store: key_store,
            lookup_hmac_key: "test-hmac-key".to_owned(),
            cache: Cache::builder()
                .time_to_live(Duration::from_mins(1))
                .max_capacity(16)
                .build(),
            routing,
        };

        let first = resolver
            .resolve_connector("connector_ready_later", "secret-before-ready")
            .await
            .expect("resolve should succeed")
            .expect("connector should be found");
        assert!(!first.clickhouse_ready);
        assert_eq!(store.connector_fetches.load(Ordering::Relaxed), 1);

        store.set_org_routing(
            "org_logpush_transition",
            OrgRouting {
                self_managed: true,
                clickhouse_ready: true,
            },
        );
        tokio::time::sleep(Duration::from_millis(10)).await;

        let second = resolver
            .resolve_connector("connector_ready_later", "secret-before-ready")
            .await
            .expect("resolve should succeed")
            .expect("connector should be found");
        assert!(second.self_managed);
        assert!(second.clickhouse_ready);
        assert_eq!(
            store.connector_fetches.load(Ordering::Relaxed),
            1,
            "connector identity should stay cached while routing refreshes"
        );
        assert_eq!(store.routing_fetches.load(Ordering::Relaxed), 1);
    }

    const GCP_LOG_ENTRY: &str = r#"{
        "logName": "projects/my-project/logs/run.googleapis.com%2Fstdout",
        "insertId": "insert-1",
        "timestamp": "2025-03-07T12:34:56.123456789Z",
        "severity": "WARNING",
        "textPayload": "cache miss",
        "resource": {
            "type": "cloud_run_revision",
            "labels": {
                "project_id": "my-project",
                "service_name": "checkout",
                "revision_name": "checkout-00042-abc",
                "location": "europe-west4"
            }
        }
    }"#;

    async fn spawn_fake_clickhouse() -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<FakeClickHouseImport>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .route("/", post(fake_clickhouse_import))
            .with_state(tx);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (url, rx)
    }

    /// One org with three connectors: `gcp_conn_1`, `gcp_conn_off` whose log
    /// forwarding is turned off, both set up by an earlier script that put the
    /// secret in the push URL, and `GCP_SIGNED_CONNECTOR`, set up with
    /// Terraform and never reported on, whose pushes Pub/Sub signs.
    async fn gcp_logpush_state(
        name: &str,
        clickhouse_url: &str,
    ) -> (Arc<AppState>, Arc<FakeKeyStore>, PathBuf) {
        let queue_dir = unique_main_test_dir(name);
        let store = Arc::new(FakeKeyStore::default());
        for (connector_id, secret, logs_enabled, applied_logs_enabled) in [
            ("gcp_conn_1", "gcp-secret", true, Some(true)),
            ("gcp_conn_off", "gcp-secret-off", false, Some(true)),
            (GCP_SIGNED_CONNECTOR, "gcp-secret-signed", true, None),
        ] {
            store.insert_gcp_connector(
                connector_id,
                secret,
                GcpConnectorRow {
                    org_id: "org_gcp".to_owned(),
                    project_id: "acme-host".to_owned(),
                    logs_enabled,
                    applied_logs_enabled,
                    self_managed: true,
                    clickhouse_ready: true,
                    source: None,
                },
            );
        }
        store.insert_clickhouse_target(
            "org_gcp",
            ClickHouseTargetRow {
                ch_url: clickhouse_url.to_owned(),
                ch_user: "ingest".to_owned(),
                ch_password_ciphertext: None,
                ch_password_iv: None,
                ch_password_tag: None,
                ch_database: "maple".to_owned(),
                schema_version: CLICKHOUSE_SCHEMA_VERSION.to_owned(),
            },
        );
        let state = test_app_state(
            Arc::clone(&store),
            queue_dir.clone(),
            "http://127.0.0.1:1".to_owned(),
            Duration::from_mins(1),
        )
        .await;
        (Arc::new(state), store, queue_dir)
    }

    async fn gcp_push(
        state: &Arc<AppState>,
        connector_id: &str,
        secret: Option<&str>,
        body: &'static str,
    ) -> Response {
        handle_gcp_logpush(
            State(Arc::clone(state)),
            Path(connector_id.to_owned()),
            Query(LogpushQuery {
                secret: secret.map(str::to_owned),
            }),
            HeaderMap::new(),
            Bytes::from_static(body.as_bytes()),
        )
        .await
    }

    const GCP_SIGNED_CONNECTOR: &str = "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9";
    const GCP_SIGNED_ACCOUNT: &str =
        "maple-push-0a1b2c3d4e5f4071829@acme-host.iam.gserviceaccount.com";
    const GCP_PUSH_TEST_KEY: &[u8] = include_bytes!("testdata/gcp-push-test-key.pk8");
    const GCP_PUSH_TEST_KEY_N: &str = include_str!("testdata/gcp-push-test-key.n");

    fn gcp_push_test_keys() -> maple_ingest::gcp_push_auth::Keys {
        maple_ingest::gcp_push_auth::Keys::from([(
            "key-1".to_owned(),
            maple_ingest::gcp_push_auth::RsaKey {
                n: URL_SAFE_NO_PAD.decode(GCP_PUSH_TEST_KEY_N.trim()).unwrap(),
                e: vec![1, 0, 1],
            },
        )])
    }

    /// An ID token as Pub/Sub signs it for a push subscription's account.
    fn gcp_push_token(email: &str, audience: &str) -> String {
        use ring::signature::{RsaKeyPair, RSA_PKCS1_SHA256};
        let now = current_time_millis() / 1000;
        let encode = |value: serde_json::Value| URL_SAFE_NO_PAD.encode(value.to_string());
        let signed = format!(
            "{}.{}",
            encode(serde_json::json!({ "alg": "RS256", "kid": "key-1", "typ": "JWT" })),
            encode(serde_json::json!({
                "iss": "https://accounts.google.com",
                "aud": audience,
                "iat": now,
                "exp": now + 3600,
                "email": email,
                "email_verified": true,
            })),
        );
        let pair = RsaKeyPair::from_pkcs8(GCP_PUSH_TEST_KEY).unwrap();
        let mut signature = vec![0; pair.public().modulus_len()];
        pair.sign(
            &RSA_PKCS1_SHA256,
            &ring::rand::SystemRandom::new(),
            signed.as_bytes(),
            &mut signature,
        )
        .unwrap();
        format!("{signed}.{}", URL_SAFE_NO_PAD.encode(signature))
    }

    async fn gcp_signed_push(
        state: &Arc<AppState>,
        connector_id: &str,
        token: &str,
        body: &'static str,
    ) -> Response {
        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        handle_gcp_logpush(
            State(Arc::clone(state)),
            Path(connector_id.to_owned()),
            Query(LogpushQuery { secret: None }),
            headers,
            Bytes::from_static(body.as_bytes()),
        )
        .await
    }

    #[tokio::test]
    async fn gcp_logpush_accepts_a_push_signed_as_the_connectors_push_account() {
        let (ch_url, mut ch_rx) = spawn_fake_clickhouse().await;
        let (state, store, queue_dir) = gcp_logpush_state("gcp-logpush-signed", &ch_url).await;
        let token = gcp_push_token(
            GCP_SIGNED_ACCOUNT,
            &format!("https://ingest.test/v1/logpush/gcp/{GCP_SIGNED_CONNECTOR}"),
        );

        for _ in 0..2 {
            let response =
                gcp_signed_push(&state, GCP_SIGNED_CONNECTOR, &token, GCP_LOG_ENTRY).await;
            assert_eq!(response.status(), StatusCode::OK);
            tokio::time::timeout(Duration::from_secs(2), ch_rx.recv())
                .await
                .expect("the entry is stored")
                .expect("fake ClickHouse is running");
        }
        // Nothing reported on it before: the first push proves log forwarding
        // is set up, and only the first records it.
        assert_eq!(
            *store.gcp_setup_reports.lock().unwrap(),
            [(
                GCP_SIGNED_CONNECTOR.to_owned(),
                gcp_logging::SetupReport {
                    logs: Some(true),
                    metrics: None
                }
            )]
        );

        drop(std::fs::remove_dir_all(queue_dir));
    }

    #[tokio::test]
    async fn gcp_logpush_refuses_a_token_for_another_account_or_connector() {
        let (state, store, queue_dir) =
            gcp_logpush_state("gcp-logpush-signed-refused", "http://127.0.0.1:1").await;
        let audience = format!("https://ingest.test/v1/logpush/gcp/{GCP_SIGNED_CONNECTOR}");

        for (case, connector_id, token) in [
            (
                "the same name in another project",
                GCP_SIGNED_CONNECTOR,
                gcp_push_token(
                    "maple-push-0a1b2c3d4e5f4071829@attacker.iam.gserviceaccount.com",
                    &audience,
                ),
            ),
            (
                "a token for another connector's endpoint",
                GCP_SIGNED_CONNECTOR,
                gcp_push_token(
                    GCP_SIGNED_ACCOUNT,
                    "https://ingest.test/v1/logpush/gcp/gcp_conn_1",
                ),
            ),
            (
                "another connector's endpoint with this token",
                "gcp_conn_1",
                gcp_push_token(GCP_SIGNED_ACCOUNT, &audience),
            ),
            (
                "not a token",
                GCP_SIGNED_CONNECTOR,
                "gcp-secret-signed".to_owned(),
            ),
        ] {
            let response = gcp_signed_push(&state, connector_id, &token, GCP_LOG_ENTRY).await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{case}");
        }
        assert!(store.gcp_setup_reports.lock().unwrap().is_empty());

        drop(std::fs::remove_dir_all(queue_dir));
    }

    const AWS_CONNECTION: &str = "6f1c2b9e-1d3a-4c5b-9e8f-0a1b2c3d4e5f";
    const AWS_STREAM_SECRET: &str = "aws-stream-secret";

    async fn aws_firehose_state(
        name: &str,
        clickhouse_url: &str,
        max_decoded_body_bytes: usize,
    ) -> (Arc<AppState>, Arc<FakeKeyStore>, PathBuf) {
        let queue_dir = unique_main_test_dir(name);
        let store = Arc::new(FakeKeyStore::default());
        store.insert_aws_connection(
            AWS_CONNECTION,
            AWS_STREAM_SECRET,
            AwsConnectionRow {
                org_id: "org_aws".to_owned(),
                self_managed: true,
                clickhouse_ready: true,
                source: None,
            },
        );
        store.insert_clickhouse_target(
            "org_aws",
            ClickHouseTargetRow {
                ch_url: clickhouse_url.to_owned(),
                ch_user: "ingest".to_owned(),
                ch_password_ciphertext: None,
                ch_password_iv: None,
                ch_password_tag: None,
                ch_database: "maple".to_owned(),
                schema_version: CLICKHOUSE_SCHEMA_VERSION.to_owned(),
            },
        );
        let mut state = test_app_state(
            Arc::clone(&store),
            queue_dir.clone(),
            "http://127.0.0.1:1".to_owned(),
            Duration::from_mins(1),
        )
        .await;
        state.config.max_decoded_body_bytes = max_decoded_body_bytes;
        (Arc::new(state), store, queue_dir)
    }

    /// One `AWS/ECS` `CPUUtilization` point as a CloudWatch metric stream writes it.
    fn cloudwatch_cpu_request() -> ExportMetricsServiceRequest {
        use opentelemetry_proto::tonic::common::v1::KeyValueList;
        use opentelemetry_proto::tonic::metrics::v1::{
            metric, summary_data_point::ValueAtQuantile, Metric, ResourceMetrics, ScopeMetrics,
            Summary, SummaryDataPoint,
        };
        let string = |key: &str, value: &str| KeyValue {
            key: key.to_owned(),
            value: Some(AnyValue {
                value: Some(any_value::Value::StringValue(value.to_owned())),
            }),
            ..Default::default()
        };
        let point = SummaryDataPoint {
            attributes: vec![
                string("Namespace", "AWS/ECS"),
                string("MetricName", "CPUUtilization"),
                KeyValue {
                    key: "Dimensions".to_owned(),
                    value: Some(AnyValue {
                        value: Some(any_value::Value::KvlistValue(KeyValueList {
                            values: vec![
                                string("ClusterName", "prod"),
                                string("ServiceName", "checkout"),
                            ],
                        })),
                    }),
                    ..Default::default()
                },
            ],
            start_time_unix_nano: 1_800_000_000_000_000_000,
            time_unix_nano: 1_800_000_060_000_000_000,
            count: 4,
            sum: 100.0,
            quantile_values: vec![
                ValueAtQuantile {
                    quantile: 0.0,
                    value: 10.0,
                },
                ValueAtQuantile {
                    quantile: 1.0,
                    value: 40.0,
                },
            ],
            flags: 0,
        };
        ExportMetricsServiceRequest {
            resource_metrics: vec![ResourceMetrics {
                resource: Some(Resource {
                    attributes: vec![
                        string("cloud.provider", "aws"),
                        string("cloud.account.id", "123456789012"),
                        string("cloud.region", "us-east-1"),
                    ],
                    ..Default::default()
                }),
                scope_metrics: vec![ScopeMetrics {
                    scope: None,
                    metrics: vec![Metric {
                        name: "amazonaws.com/AWS/ECS/CPUUtilization".to_owned(),
                        unit: "Percent".to_owned(),
                        data: Some(metric::Data::Summary(Summary {
                            data_points: vec![point],
                        })),
                        ..Default::default()
                    }],
                    schema_url: String::new(),
                }],
                schema_url: String::new(),
            }],
        }
    }

    /// A Firehose delivery whose one record holds two length-delimited requests.
    fn firehose_body(records: &[&str]) -> String {
        let records: Vec<JsonValue> = records
            .iter()
            .map(|data| serde_json::json!({ "data": data }))
            .collect();
        serde_json::json!({
            "requestId": "body-request-id",
            "timestamp": 1_800_000_000_000_i64,
            "records": records,
        })
        .to_string()
    }

    fn cloudwatch_record() -> String {
        let mut data = cloudwatch_cpu_request().encode_length_delimited_to_vec();
        data.extend(cloudwatch_cpu_request().encode_length_delimited_to_vec());
        STANDARD.encode(data)
    }

    async fn aws_deliver(
        state: &Arc<AppState>,
        connection_id: &str,
        secret: Option<&str>,
        body: Bytes,
        gzip: bool,
    ) -> (StatusCode, JsonValue) {
        let mut headers = HeaderMap::new();
        headers.insert(
            FIREHOSE_REQUEST_ID_HEADER,
            HeaderValue::from_static("header-request-id"),
        );
        if let Some(secret) = secret {
            headers.insert(
                FIREHOSE_ACCESS_KEY_HEADER,
                HeaderValue::from_str(secret).unwrap(),
            );
        }
        if gzip {
            headers.insert(CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        }
        let response = handle_aws_firehose(
            State(Arc::clone(state)),
            Path(connection_id.to_owned()),
            headers,
            body,
        )
        .await;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn aws_firehose_rejects_bad_credentials_without_a_lookup_for_malformed_ids() {
        let (state, store, queue_dir) =
            aws_firehose_state("aws-firehose-auth", "http://127.0.0.1:1", 8 * 1024 * 1024).await;
        let body = || Bytes::from(firehose_body(&[]));

        for (case, connection_id) in [
            ("uppercase uuid", "6F1C2B9E-1D3A-4C5B-9E8F-0A1B2C3D4E5F"),
            ("not a uuid", "aws_conn_1"),
            ("path-like", "../6f1c2b9e-1d3a-4c5b-9e8f-0a1b2c3d4e"),
        ] {
            let (status, response) = aws_deliver(
                &state,
                connection_id,
                Some(AWS_STREAM_SECRET),
                body(),
                false,
            )
            .await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{case}");
            assert_eq!(response["requestId"], "header-request-id", "{case}");
            assert!(response["errorMessage"].is_string(), "{case}");
        }
        assert_eq!(store.connector_fetches.load(Ordering::Relaxed), 0);

        for (case, secret) in [("missing key", None), ("wrong key", Some("wrong-secret"))] {
            let (status, _) = aws_deliver(&state, AWS_CONNECTION, secret, body(), false).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{case}");
        }
        let (status, _) = aws_deliver(
            &state,
            "00000000-0000-4000-8000-000000000000",
            Some(AWS_STREAM_SECRET),
            body(),
            false,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(store.aws_stream_health.lock().unwrap().is_empty());

        drop(std::fs::remove_dir_all(queue_dir));
    }

    #[tokio::test]
    async fn aws_firehose_stores_a_gzipped_metric_stream_and_acks_an_unreadable_record() {
        let (ch_url, mut ch_rx) = spawn_fake_clickhouse().await;
        let (state, store, queue_dir) =
            aws_firehose_state("aws-firehose-accept", &ch_url, 8 * 1024 * 1024).await;

        let body = gzip_bytes(&firehose_body(&[
            &cloudwatch_record(),
            &cloudwatch_record(),
        ]));
        let (status, response) =
            aws_deliver(&state, AWS_CONNECTION, Some(AWS_STREAM_SECRET), body, true).await;
        assert_eq!(status, StatusCode::OK, "{response}");
        assert_eq!(response["requestId"], "body-request-id");
        assert!(response["timestamp"].is_i64());
        assert!(response.get("errorMessage").is_none());

        let mut stored = Vec::new();
        while let Ok(Some(import)) =
            tokio::time::timeout(Duration::from_secs(2), ch_rx.recv()).await
        {
            stored.push(import);
            if stored.len() == 2 {
                break;
            }
        }
        let gauges = stored
            .iter()
            .find(|import| import.query.starts_with("INSERT INTO metrics_gauge"))
            .expect("the average, min and max gauges should be stored");
        assert!(
            gauges.body.contains("aws.ecs.cpu_utilization.max"),
            "{}",
            gauges.body
        );
        assert!(gauges.body.contains("checkout"), "{}", gauges.body);
        let sums = stored
            .iter()
            .find(|import| import.query.starts_with("INSERT INTO metrics_sum"))
            .expect("the sum and count should be stored");
        assert!(
            sums.body.contains("aws.ecs.cpu_utilization.count"),
            "{}",
            sums.body
        );
        assert_eq!(
            *store.aws_stream_health.lock().unwrap(),
            [(AWS_CONNECTION.to_owned(), None)]
        );

        // Bad base64 never decodes, so it is acked rather than retried by Firehose.
        // Sent twice: the `stream_last_error` write is throttled to one.
        for _ in 0..2 {
            let (status, _) = aws_deliver(
                &state,
                AWS_CONNECTION,
                Some(AWS_STREAM_SECRET),
                Bytes::from(firehose_body(&["!!not base64!!"])),
                false,
            )
            .await;
            assert_eq!(status, StatusCode::OK);
        }
        assert_eq!(
            *store.aws_stream_health.lock().unwrap(),
            [
                (AWS_CONNECTION.to_owned(), None),
                (
                    AWS_CONNECTION.to_owned(),
                    Some(aws_metric_stream::UNREADABLE_DELIVERY.to_owned())
                ),
            ]
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(50), ch_rx.recv())
                .await
                .is_err(),
            "an unreadable record must not be stored"
        );

        drop(std::fs::remove_dir_all(queue_dir));
    }

    #[tokio::test]
    async fn aws_firehose_refuses_a_delivery_that_decodes_past_the_limit() {
        let (state, store, queue_dir) =
            aws_firehose_state("aws-firehose-too-large", "http://127.0.0.1:1", 64).await;

        let (status, response) = aws_deliver(
            &state,
            AWS_CONNECTION,
            Some(AWS_STREAM_SECRET),
            Bytes::from(firehose_body(&[&cloudwatch_record()])),
            false,
        )
        .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(response["errorMessage"].is_string());
        assert_eq!(
            *store.aws_stream_health.lock().unwrap(),
            [(
                AWS_CONNECTION.to_owned(),
                Some(aws_metric_stream::DELIVERY_TOO_LARGE.to_owned())
            )]
        );

        drop(std::fs::remove_dir_all(queue_dir));
    }

    #[tokio::test]
    async fn gcp_logpush_rejects_bad_credentials() {
        let (state, _store, queue_dir) =
            gcp_logpush_state("gcp-logpush-auth", "http://127.0.0.1:1").await;

        for (case, connector_id, secret) in [
            ("missing secret", "gcp_conn_1", None),
            ("wrong secret", "gcp_conn_1", Some("wrong-secret")),
            ("unknown connector", "gcp_conn_unknown", Some("gcp-secret")),
            ("malformed id", "not/a connector id", Some("gcp-secret")),
        ] {
            let response = gcp_push(&state, connector_id, secret, GCP_LOG_ENTRY).await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{case}");
        }

        drop(std::fs::remove_dir_all(queue_dir));
    }

    #[tokio::test]
    async fn gcp_logpush_stores_a_log_entry_and_acks_a_poison_payload() {
        let (ch_url, mut ch_rx) = spawn_fake_clickhouse().await;
        let (state, store, queue_dir) = gcp_logpush_state("gcp-logpush-accept", &ch_url).await;

        let accepted = gcp_push(&state, "gcp_conn_1", Some("gcp-secret"), GCP_LOG_ENTRY).await;
        assert_eq!(accepted.status(), StatusCode::OK);
        let stored = tokio::time::timeout(Duration::from_secs(2), ch_rx.recv())
            .await
            .expect("the entry should reach the org's ClickHouse")
            .expect("ClickHouse channel should stay open");
        assert!(stored.query.starts_with("INSERT INTO logs"));
        assert!(stored.body.contains("cache miss"), "{}", stored.body);
        assert!(
            stored.body.contains(r#""service_name":"checkout""#),
            "{}",
            stored.body
        );
        assert_eq!(store.connector_successes.load(Ordering::Relaxed), 1);
        assert!(store.connector_failures.lock().unwrap().is_empty());

        // The wrapped Pub/Sub envelope can never parse, and Pub/Sub redelivers
        // anything but an ack, so it is acked. Sent twice: the connector's
        // `last_error` write is throttled to one.
        for _ in 0..2 {
            let poison = gcp_push(
                &state,
                "gcp_conn_1",
                Some("gcp-secret"),
                r#"{"message":{"data":"e30=","messageId":"1"},"subscription":"s"}"#,
            )
            .await;
            assert_eq!(poison.status(), StatusCode::OK);
        }
        assert_eq!(
            *store.connector_failures.lock().unwrap(),
            [(
                GCP_CONNECTORS_TABLE,
                gcp_logging::NOT_A_LOG_ENTRY.to_owned()
            )]
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(50), ch_rx.recv())
                .await
                .is_err(),
            "a poison payload must not be stored"
        );

        // The next accepted entry is recorded at once and clears the error,
        // although a success was already written within the interval.
        let again = gcp_push(&state, "gcp_conn_1", Some("gcp-secret"), GCP_LOG_ENTRY).await;
        assert_eq!(again.status(), StatusCode::OK);
        assert_eq!(store.connector_successes.load(Ordering::Relaxed), 2);

        drop(std::fs::remove_dir_all(queue_dir));
    }

    #[tokio::test]
    async fn gcp_logpush_acks_and_drops_while_log_forwarding_is_off() {
        let (ch_url, mut ch_rx) = spawn_fake_clickhouse().await;
        let (state, store, queue_dir) = gcp_logpush_state("gcp-logpush-off", &ch_url).await;

        // Acked: a non-2xx would have Pub/Sub redeliver the entry for the
        // subscription's whole retention.
        let dropped = gcp_push(
            &state,
            "gcp_conn_off",
            Some("gcp-secret-off"),
            GCP_LOG_ENTRY,
        )
        .await;
        assert_eq!(dropped.status(), StatusCode::OK);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), ch_rx.recv())
                .await
                .is_err(),
            "nothing may be stored while log forwarding is off"
        );
        assert_eq!(store.connector_successes.load(Ordering::Relaxed), 0);
        assert!(store.connector_failures.lock().unwrap().is_empty());

        drop(std::fs::remove_dir_all(queue_dir));
    }

    #[tokio::test]
    async fn gcp_logpush_records_a_setup_report_and_stores_nothing() {
        const LOGS_ON: &str = r#"{"logName":"projects/p/logs/maple-setup","timestamp":"2026-10-09T10:00:00Z","jsonPayload":{"logs":true}}"#;
        const LOGS_OFF: &str = r#"{"logName":"projects/p/logs/maple-setup","timestamp":"2026-10-09T10:00:00Z","jsonPayload":{"logs":false,"metrics":true}}"#;
        let (ch_url, mut ch_rx) = spawn_fake_clickhouse().await;
        let (state, store, queue_dir) = gcp_logpush_state("gcp-logpush-report", &ch_url).await;

        // Through the topic of a connector that forwards logs, and straight
        // from the script of one whose log forwarding is off.
        for (connector_id, secret, body) in [
            ("gcp_conn_1", "gcp-secret", LOGS_ON),
            ("gcp_conn_off", "gcp-secret-off", LOGS_OFF),
        ] {
            let response = gcp_push(&state, connector_id, Some(secret), body).await;
            assert_eq!(response.status(), StatusCode::OK, "{connector_id}");
        }
        // Another connector's secret reports for nobody.
        let forged = gcp_push(&state, "gcp_conn_off", Some("gcp-secret"), LOGS_ON).await;
        assert_eq!(forged.status(), StatusCode::UNAUTHORIZED);

        assert_eq!(
            *store.gcp_setup_reports.lock().unwrap(),
            [
                (
                    "gcp_conn_1".to_owned(),
                    gcp_logging::SetupReport {
                        logs: Some(true),
                        metrics: None
                    }
                ),
                (
                    "gcp_conn_off".to_owned(),
                    gcp_logging::SetupReport {
                        logs: Some(false),
                        metrics: Some(true)
                    }
                ),
            ]
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(50), ch_rx.recv())
                .await
                .is_err(),
            "a setup report must not be stored as a log"
        );
        assert_eq!(store.connector_successes.load(Ordering::Relaxed), 0);
        assert!(store.connector_failures.lock().unwrap().is_empty());

        drop(std::fs::remove_dir_all(queue_dir));
    }

    #[tokio::test]
    async fn gcp_logpush_refuses_pushes_over_the_org_gcp_in_flight_cap() {
        let (ch_url, _ch_rx) = spawn_fake_clickhouse().await;
        let (state, _store, queue_dir) = gcp_logpush_state("gcp-logpush-cap", &ch_url).await;

        // Every GCP slot of the org taken by pushes still in progress.
        let held: Vec<_> = (0..state.config.gcp_org_max_in_flight)
            .map(|_| state.gcp_inflight_limiter.try_acquire("org_gcp").unwrap())
            .collect();
        let refused = gcp_push(&state, "gcp_conn_1", Some("gcp-secret"), GCP_LOG_ENTRY).await;
        assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);
        // The org's other ingest keeps its own slots.
        assert!(state.org_inflight_limiter.try_acquire("org_gcp").is_some());

        drop(held);
        let accepted = gcp_push(&state, "gcp_conn_1", Some("gcp-secret"), GCP_LOG_ENTRY).await;
        assert_eq!(accepted.status(), StatusCode::OK);

        drop(std::fs::remove_dir_all(queue_dir));
    }

    #[tokio::test]
    async fn gcp_logpush_refuses_setup_reports_past_the_window_limit() {
        const REPORT: &str = r#"{"logName":"projects/p/logs/maple-setup","timestamp":"2026-10-09T10:00:00Z","jsonPayload":{"logs":true}}"#;
        let (state, store, queue_dir) =
            gcp_logpush_state("gcp-logpush-report-limit", "http://127.0.0.1:1").await;

        for _ in 0..GCP_SETUP_REPORTS_PER_WINDOW {
            let response = gcp_push(&state, "gcp_conn_1", Some("gcp-secret"), REPORT).await;
            assert_eq!(response.status(), StatusCode::OK);
        }
        let refused = gcp_push(&state, "gcp_conn_1", Some("gcp-secret"), REPORT).await;
        assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);
        // The limit is per connector.
        let other = gcp_push(&state, "gcp_conn_off", Some("gcp-secret-off"), REPORT).await;
        assert_eq!(other.status(), StatusCode::OK);

        assert_eq!(
            store.gcp_setup_reports.lock().unwrap().len(),
            GCP_SETUP_REPORTS_PER_WINDOW as usize + 1
        );

        drop(std::fs::remove_dir_all(queue_dir));
    }

    /// Regression for the gateway going silent in its own traces: a global
    /// `warn` filter (the #581 default) discards every `info_span!` before the
    /// OTel layer sees it. The span filter must admit info spans; the log
    /// filter is the one allowed to drop info events — and only as a
    /// per-layer filter, never registry-wide.
    #[test]
    fn span_filter_admits_info_spans_that_the_log_filter_would_drop() {
        use tracing::callsite::{DefaultCallsite, Identifier};
        use tracing::field::FieldSet;
        use tracing::metadata::Kind;
        use tracing::{Level, Metadata, Subscriber};

        static SPAN_CALLSITE: DefaultCallsite = DefaultCallsite::new(&SPAN_META);
        static SPAN_META: Metadata<'static> = Metadata::new(
            "filter_probe_span",
            "maple_ingest::probe",
            Level::INFO,
            None,
            None,
            None,
            FieldSet::new(&[], Identifier(&SPAN_CALLSITE)),
            Kind::SPAN,
        );
        static EVENT_CALLSITE: DefaultCallsite = DefaultCallsite::new(&EVENT_META);
        static EVENT_META: Metadata<'static> = Metadata::new(
            "filter_probe_event",
            "maple_ingest::probe",
            Level::INFO,
            None,
            None,
            None,
            FieldSet::new(&[], Identifier(&EVENT_CALLSITE)),
            Kind::EVENT,
        );

        let span_filter = tracing_subscriber::registry()
            .with(tracing_subscriber::EnvFilter::new(SPAN_FILTER_DIRECTIVES));
        assert!(
            span_filter.enabled(&SPAN_META),
            "the registry-wide filter must let info spans reach the OTel layer"
        );

        let log_filter = tracing_subscriber::registry()
            .with(tracing_subscriber::EnvFilter::new(LOG_FILTER_DIRECTIVES));
        assert!(
            !log_filter.enabled(&EVENT_META),
            "hot-path info logs stay off by default"
        );
        assert!(
            !log_filter.enabled(&SPAN_META),
            "the log filter drops info spans too, which is why it must stay per-layer"
        );
    }

    /// Records `(thread, span name, parent span name)` for every span opened
    /// while it is installed, so a test can assert the shape of the trace rather
    /// than just that individual spans exist.
    ///
    /// Installed as the *global* default rather than a thread-local one: callsite
    /// interest is cached process-wide, so with a thread-local subscriber a
    /// sibling test reaching a span macro first caches `Interest::never` and the
    /// span silently never gets created for us. `set_global_default` rebuilds
    /// that cache. The cost is that concurrently-running tests land in the same
    /// capture, which is why every record is tagged with its thread.
    /// One opened span: the thread that opened it, its name, and its parent's
    /// name (`None` for a root).
    type CapturedSpan = (std::thread::ThreadId, String, Option<String>);

    #[derive(Clone, Default)]
    struct SpanTreeCapture {
        spans: Arc<std::sync::Mutex<Vec<CapturedSpan>>>,
    }

    static SPAN_TREE_CAPTURE: std::sync::OnceLock<SpanTreeCapture> = std::sync::OnceLock::new();

    /// Install the capture globally, once per test process.
    fn install_span_capture() -> &'static SpanTreeCapture {
        SPAN_TREE_CAPTURE.get_or_init(|| {
            let capture = SpanTreeCapture::default();
            tracing::subscriber::set_global_default(
                tracing_subscriber::registry().with(capture.clone()),
            )
            .expect("no other test may install a global subscriber");
            capture
        })
    }

    impl SpanTreeCapture {
        /// Scoped to the calling thread. `#[tokio::test]` uses a current-thread
        /// runtime, so the handler and the export worker it spawns both run here,
        /// while other tests' spans are filtered out.
        #[expect(
            clippy::option_option,
            reason = "the two levels are distinct answers: the outer is whether the span was \
                      recorded at all, the inner is whether it had a parent"
        )]
        fn parent_of(&self, name: &str) -> Option<Option<String>> {
            let this_thread = std::thread::current().id();
            self.spans
                .lock()
                .unwrap()
                .iter()
                .find(|(thread, span, _)| *thread == this_thread && span == name)
                .map(|(_, _, parent)| parent.clone())
        }

        fn assert_child_of(&self, child: &str, parent: &str) {
            let observed = self
                .parent_of(child)
                .unwrap_or_else(|| panic!("span `{child}` was never created"));
            assert_eq!(
                observed.as_deref(),
                Some(parent),
                "span `{child}` should be a child of `{parent}`"
            );
        }
    }

    impl<S> tracing_subscriber::Layer<S> for SpanTreeCapture
    where
        S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
    {
        fn on_new_span(
            &self,
            _attrs: &tracing::span::Attributes<'_>,
            id: &tracing::Id,
            ctx: tracing_subscriber::layer::Context<'_, S>,
        ) {
            let Some(span) = ctx.span(id) else {
                return;
            };
            let parent = span.parent().map(|parent| parent.name().to_owned());
            self.spans.lock().unwrap().push((
                std::thread::current().id(),
                span.name().to_owned(),
                parent,
            ));
        }
    }

    /// The whole point of the child spans: a single slow request must show *which*
    /// stage was slow. Without this the trace collapses to one server span and the
    /// per-stage histograms are the only signal, which cannot attribute an
    /// individual request.
    /// `PipelineError::is_server_fault` decides the span status and
    /// `api_error_from_pipeline` decides the HTTP status. They encode the same
    /// judgement in two places, so a new variant that gets one right and the
    /// other wrong would mislabel error dashboards.
    #[test]
    fn pipeline_error_fault_split_matches_http_status() {
        for error in [
            PipelineError::Backpressure("lane full"),
            PipelineError::Throttled("org cap"),
            PipelineError::QueueUnavailable("wal io".to_owned()),
            PipelineError::Encode("bad row".to_owned()),
        ] {
            let status = api_error_from_pipeline(&error).status.as_u16();
            assert_eq!(
                error.is_server_fault(),
                status >= 500,
                "{} maps to HTTP {status} but reports is_server_fault()={}",
                error.kind(),
                error.is_server_fault()
            );
            assert_eq!(
                otel_status_for_rejection(status, "forward"),
                if error.is_server_fault() {
                    "Error"
                } else {
                    "Ok"
                },
                "span status for {} disagrees with the HTTP rule",
                error.kind()
            );
        }
    }

    /// `MAPLE_TEST` is a PUBLIC constant, so a sentinel export is
    /// attacker-authored: it must look successful and store nothing. The HTTP
    /// path discards in `handle_signal_inner`; this pins the gRPC twin, which
    /// used to run `process_decoded_payload` unconditionally.
    #[tokio::test]
    async fn sentinel_grpc_export_writes_nothing() {
        let (forward_tx, mut forward_rx) = tokio::sync::mpsc::unbounded_channel();
        let forward_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let forward_addr = forward_listener.local_addr().unwrap();
        let forward_app = Router::new()
            .route("/v1/logs", post(fake_forward_collector))
            .with_state(forward_tx);
        tokio::spawn(async move {
            axum::serve(forward_listener, forward_app).await.unwrap();
        });

        let queue_dir = unique_main_test_dir("grpc-sentinel");
        let store = Arc::new(FakeKeyStore::default());
        let raw_key = "maple_sk_test_grpc_sentinel";
        store.insert_private(
            raw_key,
            KeyRow {
                org_id: "org_grpc_sentinel".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        let state = test_app_state(
            Arc::clone(&store),
            queue_dir.clone(),
            format!("http://{forward_addr}"),
            Duration::from_millis(5),
        )
        .await;

        let sentinel = resolve_grpc_ingest_key(&state, &bearer_headers("MAPLE_TEST"))
            .await
            .expect("the sentinel token authenticates");
        assert_eq!(sentinel.org_id, SENTINEL_ORG_ID);

        let payload = test_log_request("sentinel over grpc");
        let decoded_bytes = payload.encoded_len();
        accept_grpc_decoded(
            &state,
            Signal::Logs,
            DecodedPayload::Logs(payload),
            &sentinel,
            KeyAdmission::Ingest,
            decoded_bytes,
            &ClaimOutcome::default(),
        )
        .await
        .expect("a sentinel export must look successful to the client");

        assert!(
            tokio::time::timeout(Duration::from_millis(100), forward_rx.recv())
                .await
                .is_err(),
            "the sentinel org must not write telemetry"
        );

        // The same harness with a real key, so the assertion above cannot pass
        // because nothing was ever wired up.
        let resolved = state
            .resolver
            .resolve_ingest_key(raw_key)
            .await
            .expect("resolution should not fail")
            .expect("the test key resolves");
        let real = test_log_request("real key over grpc");
        let real_bytes = real.encoded_len();
        accept_grpc_decoded(
            &state,
            Signal::Logs,
            DecodedPayload::Logs(real),
            &resolved,
            KeyAdmission::Ingest,
            real_bytes,
            &ClaimOutcome::default(),
        )
        .await
        .expect("a real export is accepted");
        let forwarded = tokio::time::timeout(Duration::from_secs(2), forward_rx.recv())
            .await
            .expect("a real key forwards")
            .expect("forward channel should stay open");
        assert!(forwarded.body_len > 0);

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    /// A body no decoder accepts, so a billing refusal for it means the
    /// entitlement gate answered before any decoder saw it.
    const UNDECODABLE_BODY: &[u8] = b"neither gzip nor protobuf nor json";

    #[tokio::test]
    async fn otlp_gate_precedes_decode_and_admits_an_allowed_org() {
        let (forward_url, mut forward_rx) = spawn_forward_collector().await;
        let queue_dir = unique_main_test_dir("otlp-gate");
        let store = Arc::new(FakeKeyStore::default());
        for (raw_key, org_id) in [
            ("maple_sk_test_otlp_denied", "org_otlp_denied"),
            ("maple_sk_test_otlp_allowed", "org_otlp_allowed"),
        ] {
            store.insert_private(
                raw_key,
                KeyRow {
                    org_id: org_id.to_owned(),
                    self_managed: false,
                    clickhouse_ready: false,
                },
            );
        }
        let state = with_autumn_denying(
            test_app_state(
                store,
                queue_dir.clone(),
                forward_url,
                Duration::from_millis(5),
            )
            .await,
            "org_otlp_denied",
        )
        .await;

        let mut headers = test_headers("maple_sk_test_otlp_denied");
        headers.insert(CONTENT_ENCODING, "gzip".parse().unwrap());
        let (error, error_kind) = handle_signal_inner(
            &state,
            &headers,
            Bytes::from_static(UNDECODABLE_BODY),
            Signal::Logs,
        )
        .await
        .expect_err("a denied org must be refused");
        assert_eq!(error.status, StatusCode::PAYMENT_REQUIRED);
        assert_eq!(error_kind, "billing_limit");

        // The same gate lets an allowed org through to the collector, and its
        // own undecodable body is still the decoder's to refuse.
        let (response, item_count, org_id, _) = handle_signal_inner(
            &state,
            &test_headers("maple_sk_test_otlp_allowed"),
            Bytes::from(test_log_request("allowed").encode_to_vec()),
            Signal::Logs,
        )
        .await
        .expect("an allowed org is accepted");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!((item_count, org_id.as_str()), (1, "org_otlp_allowed"));
        tokio::time::timeout(Duration::from_secs(2), forward_rx.recv())
            .await
            .expect("an allowed export is forwarded")
            .expect("forward channel should stay open");

        let mut headers = test_headers("maple_sk_test_otlp_allowed");
        headers.insert(CONTENT_ENCODING, "gzip".parse().unwrap());
        let (error, error_kind) = handle_signal_inner(
            &state,
            &headers,
            Bytes::from_static(UNDECODABLE_BODY),
            Signal::Logs,
        )
        .await
        .expect_err("an undecodable body is refused");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert_eq!(error_kind, "decode");

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn blocked_key_is_refused_in_every_header_spelling() {
        let (forward_url, _forward_rx) = spawn_forward_collector().await;
        let queue_dir = unique_main_test_dir("blocked-key");
        let store = Arc::new(FakeKeyStore::default());
        let (blocked, allowed) = ("maple_sk_test_blocked", "maple_sk_test_allowed");
        for raw_key in [blocked, allowed] {
            store.insert_private(
                raw_key,
                KeyRow {
                    org_id: "org_blocked_key".to_owned(),
                    self_managed: false,
                    clickhouse_ready: false,
                },
            );
        }
        let mut state = test_app_state(
            store,
            queue_dir.clone(),
            forward_url,
            Duration::from_millis(5),
        )
        .await;
        state.resolver.blocked_keys = Arc::new(parse_blocked_ingest_keys(Some(blocked)));

        let body = || Bytes::from(test_log_request("blocked").encode_to_vec());
        for (name, value) in [
            ("authorization", format!("Bearer {blocked}")),
            ("authorization", format!("bearer {blocked}")),
            ("authorization", format!("BEARER {blocked}")),
            ("authorization", format!("Bearer  {blocked}\t")),
            ("x-maple-ingest-key", format!(" {blocked} ")),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(name, value.parse().unwrap());
            headers.insert(CONTENT_TYPE, "application/x-protobuf".parse().unwrap());
            let (error, _) = handle_signal_inner(&state, &headers, body(), Signal::Logs)
                .await
                .expect_err("a blocked key must be refused");
            assert_eq!(error.status, StatusCode::UNAUTHORIZED, "{name}: {value:?}");
            let grpc = resolve_grpc_ingest_key(&state, &headers).await;
            assert!(
                matches!(&grpc, Err(status) if status.code() == tonic::Code::Unauthenticated),
                "gRPC must refuse a blocked key: {name}: {value:?}"
            );
        }

        let (response, ..) =
            handle_signal_inner(&state, &test_headers(allowed), body(), Signal::Logs)
                .await
                .expect("an unblocked key still ingests");
        assert_eq!(response.status(), StatusCode::OK);

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[test]
    fn blocked_keys_parse_like_the_edge_rule() {
        let keys = parse_blocked_ingest_keys(Some(" maple_sk_a, ,maple_pk_b,"));
        assert_eq!(keys.len(), 2);
        assert!(keys.contains("maple_sk_a") && keys.contains("maple_pk_b"));
        assert!(parse_blocked_ingest_keys(None).is_empty());
    }

    #[tokio::test]
    async fn logpush_gate_precedes_decode_and_admits_an_allowed_org() {
        let (forward_url, mut forward_rx) = spawn_forward_collector().await;
        let queue_dir = unique_main_test_dir("logpush-gate");
        let store = Arc::new(FakeKeyStore::default());
        for (connector_id, org_id) in [
            ("connector_denied", "org_logpush_denied"),
            ("connector_allowed", "org_logpush_allowed"),
        ] {
            store.insert_connector(
                connector_id,
                "connector-secret",
                ConnectorRow {
                    org_id: org_id.to_owned(),
                    service_name: "cloudflare/example.com".to_owned(),
                    zone_name: "example.com".to_owned(),
                    dataset: "http_requests".to_owned(),
                    self_managed: false,
                    clickhouse_ready: false,
                    source: None,
                },
            );
        }
        let state = with_autumn_denying(
            test_app_state(
                store,
                queue_dir.clone(),
                forward_url,
                Duration::from_millis(5),
            )
            .await,
            "org_logpush_denied",
        )
        .await;
        let push = |connector_id: &'static str, gzip: bool, body: &'static [u8]| {
            let state = &state;
            async move {
                let mut headers = HeaderMap::new();
                if gzip {
                    headers.insert(CONTENT_ENCODING, "gzip".parse().unwrap());
                }
                handle_cloudflare_logpush_inner(
                    state,
                    connector_id,
                    Some("connector-secret"),
                    &headers,
                    Bytes::from_static(body),
                )
                .await
            }
        };

        let (error, error_kind) = push("connector_denied", true, UNDECODABLE_BODY)
            .await
            .expect_err("a denied org must be refused");
        assert_eq!(error.status, StatusCode::PAYMENT_REQUIRED);
        assert_eq!(error_kind, "billing_limit");

        // An allowed org's validation ping and log batch both pass the gate.
        let (response, _, _, outcome) = push("connector_allowed", false, br#"{"content":"tests"}"#)
            .await
            .expect("a validation ping is accepted");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(outcome, LogpushOutcome::Validation);

        let (response, item_count, org_id, outcome) = push(
            "connector_allowed",
            false,
            b"{\"ClientRequestHost\":\"example.com\",\"EdgeResponseStatus\":200}\n\
              {\"ClientRequestHost\":\"example.com\",\"EdgeResponseStatus\":404}\n",
        )
        .await
        .expect("a log batch is accepted");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!((item_count, org_id.as_str()), (2, "org_logpush_allowed"));
        assert_eq!(outcome, LogpushOutcome::Accepted);
        tokio::time::timeout(Duration::from_secs(2), forward_rx.recv())
            .await
            .expect("an allowed batch is forwarded")
            .expect("forward channel should stay open");

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    fn grpc_export_request(raw_key: &str, body: Vec<u8>) -> Request {
        Request::builder()
            .method(Method::POST)
            .uri(format!("/{GRPC_LOGS_SERVICE}/Export"))
            .header(CONTENT_TYPE, "application/grpc")
            .header(AUTHORIZATION, format!("Bearer {raw_key}"))
            .body(axum::body::Body::from(body))
            .unwrap()
    }

    /// A gRPC frame: uncompressed flag, big-endian length, then the message.
    fn grpc_frame(message: &[u8]) -> Vec<u8> {
        let mut frame = vec![0u8];
        frame.extend_from_slice(&u32::try_from(message.len()).unwrap().to_be_bytes());
        frame.extend_from_slice(message);
        frame
    }

    /// `grpc-status` from the response headers; tonic puts it there only when
    /// the call failed.
    fn grpc_header_status(response: &Response) -> Option<&str> {
        response
            .headers()
            .get("grpc-status")
            .and_then(|value| value.to_str().ok())
    }

    /// `grpc_export_route` decides which requests are admitted, so it has to
    /// name exactly the paths tonic serves.
    #[test]
    fn grpc_export_route_matches_the_paths_tonic_serves() {
        use opentelemetry_proto::tonic::collector::logs::v1::logs_service_server::LogsServiceServer;
        use opentelemetry_proto::tonic::collector::metrics::v1::metrics_service_server::MetricsServiceServer;
        use opentelemetry_proto::tonic::collector::trace::v1::trace_service_server::TraceServiceServer;
        use tonic::server::NamedService;

        let signal_for = |service: &str| {
            grpc_export_route(&format!("/{service}/Export")).map(|(_, signal)| signal.path())
        };
        assert_eq!(
            signal_for(TraceServiceServer::<GrpcTraceService>::NAME),
            Some("traces")
        );
        assert_eq!(
            signal_for(LogsServiceServer::<GrpcLogsService>::NAME),
            Some("logs")
        );
        assert_eq!(
            signal_for(MetricsServiceServer::<GrpcMetricsService>::NAME),
            Some("metrics")
        );
        assert_eq!(signal_for("grpc.health.v1.Health"), None);
    }

    #[tokio::test]
    async fn grpc_admission_refuses_on_the_headers_alone() {
        use tonic::codegen::Service as _;

        let queue_dir = unique_main_test_dir("grpc-admission-refuse");
        let store = Arc::new(FakeKeyStore::default());
        let raw_key = "maple_sk_test_grpc_denied";
        store.insert_private(
            raw_key,
            KeyRow {
                org_id: "org_grpc_denied".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        let state = with_autumn_denying(
            test_app_state(
                store,
                queue_dir.clone(),
                "http://127.0.0.1:1".to_owned(),
                Duration::from_secs(30),
            )
            .await,
            "org_grpc_denied",
        )
        .await;
        let mut router = grpc_router(Arc::new(state));

        // Neither body is a gRPC frame: had tonic been handed either, it would
        // have answered with a decode failure instead.
        let denied = router
            .call(grpc_export_request(raw_key, UNDECODABLE_BODY.to_vec()))
            .await
            .unwrap();
        assert_eq!(
            grpc_header_status(&denied),
            Some("8"),
            "a denied org is RESOURCE_EXHAUSTED"
        );

        let unknown = router
            .call(grpc_export_request(
                "maple_sk_test_grpc_unknown",
                UNDECODABLE_BODY.to_vec(),
            ))
            .await
            .unwrap();
        assert_eq!(
            grpc_header_status(&unknown),
            Some("16"),
            "an unknown key is UNAUTHENTICATED"
        );

        // The sentinel token has no org to bill, so it is never gated.
        let sentinel = router
            .call(grpc_export_request(
                "MAPLE_TEST",
                grpc_frame(&test_log_request("sentinel").encode_to_vec()),
            ))
            .await
            .unwrap();
        assert_eq!(grpc_header_status(&sentinel), None);

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn grpc_export_is_accepted_through_admission() {
        use tonic::codegen::Service as _;

        let (forward_tx, mut forward_rx) = tokio::sync::mpsc::unbounded_channel();
        let forward_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let forward_addr = forward_listener.local_addr().unwrap();
        let forward_app = Router::new()
            .route("/v1/logs", post(fake_forward_collector))
            .with_state(forward_tx);
        tokio::spawn(async move {
            axum::serve(forward_listener, forward_app).await.unwrap();
        });

        let queue_dir = unique_main_test_dir("grpc-admission-accept");
        let store = Arc::new(FakeKeyStore::default());
        let raw_key = "maple_sk_test_grpc_admitted";
        store.insert_private(
            raw_key,
            KeyRow {
                org_id: "org_grpc_admitted".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        let (state, mut autumn_rx) = with_fake_autumn(
            test_app_state(
                store,
                queue_dir.clone(),
                format!("http://{forward_addr}"),
                Duration::from_millis(5),
            )
            .await,
        )
        .await;
        let mut router = grpc_router(Arc::new(state));

        let response = router
            .call(grpc_export_request(
                raw_key,
                grpc_frame(&test_log_request("through admission").encode_to_vec()),
            ))
            .await
            .unwrap();
        assert_eq!(grpc_header_status(&response), None, "the export succeeded");
        // Gated in admission, against the signal's own feature.
        let check = autumn_rx.try_recv().expect("admission asks Autumn");
        assert_eq!(
            (check.path.as_str(), check.feature_id()),
            ("balances.check", "logs")
        );
        let forwarded = tokio::time::timeout(Duration::from_secs(2), forward_rx.recv())
            .await
            .expect("an admitted export is forwarded")
            .expect("forward channel should stay open");
        assert!(forwarded.body_len > 0);

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn grpc_paused_sources_get_an_empty_ok_without_decoding() {
        use tonic::codegen::Service as _;

        let queue_dir = unique_main_test_dir("grpc-paused");
        let store = Arc::new(FakeKeyStore::default());
        let paused = "maple_src_grpc_paused_key_000000000000000000";
        let mut config = source_config(None, None, "[]");
        config.paused_at_ms = Some(current_time_millis() - 1_000);
        store.insert_source(paused, source_row("org_custom", config));
        let state = test_app_state(
            Arc::clone(&store),
            queue_dir.clone(),
            "http://127.0.0.1:1".to_owned(),
            Duration::from_secs(30),
        )
        .await;
        let mut router = grpc_router(Arc::new(state));

        // Undecodable and claiming gzip: decoding it would have failed the call.
        let mut request = grpc_export_request(paused, UNDECODABLE_BODY.to_vec());
        request
            .headers_mut()
            .insert("grpc-encoding", HeaderValue::from_static("gzip"));
        let response = router.call(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(grpc_header_status(&response), None, "the export succeeded");
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(
            body.as_ref(),
            EMPTY_GRPC_MESSAGE,
            "one empty export response"
        );
        assert!(store.source_uses.lock().unwrap().is_empty());

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    /// The router tests above call the services in-process. This one puts a
    /// real gRPC client on a real HTTP/2 connection, where a refusal is answered
    /// while the client is still sending its message.
    #[tokio::test]
    async fn grpc_client_sees_refusals_and_keeps_its_connection() {
        use opentelemetry_proto::tonic::collector::logs::v1::logs_service_client::LogsServiceClient;

        let (forward_url, mut forward_rx) = spawn_forward_collector().await;
        let queue_dir = unique_main_test_dir("grpc-wire");
        let store = Arc::new(FakeKeyStore::default());
        for (raw_key, org_id) in [
            ("maple_sk_test_wire_denied", "org_wire_denied"),
            ("maple_sk_test_wire_allowed", "org_wire_allowed"),
        ] {
            store.insert_private(
                raw_key,
                KeyRow {
                    org_id: org_id.to_owned(),
                    self_managed: false,
                    clickhouse_ready: false,
                },
            );
        }
        let state = with_autumn_denying(
            test_app_state(
                store,
                queue_dir.clone(),
                forward_url,
                Duration::from_millis(5),
            )
            .await,
            "org_wire_denied",
        )
        .await;

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(
            tonic::transport::Server::builder()
                .add_routes(grpc_router(Arc::new(state)).into())
                .serve_with_incoming(tonic::transport::server::TcpIncoming::from(listener)),
        );
        let mut client = LogsServiceClient::connect(format!("http://{addr}"))
            .await
            .unwrap();
        let export = |raw_key: &str, message: &str| {
            let mut request = tonic::Request::new(test_log_request(message));
            request.metadata_mut().insert(
                "authorization",
                format!("Bearer {raw_key}").parse().unwrap(),
            );
            request
        };

        // Far larger than the HTTP/2 flow-control window, so every refusal
        // lands mid-upload. Repeated to show the abandoned streams do not cost
        // the connection.
        let large = "x".repeat(1024 * 1024);
        for _ in 0..64 {
            let status = client
                .export(export("maple_sk_test_wire_denied", &large))
                .await
                .expect_err("a denied org must be refused");
            assert_eq!(status.code(), tonic::Code::ResourceExhausted);
        }
        let status = client
            .export(export("maple_sk_test_wire_unknown", &large))
            .await
            .expect_err("an unknown key must be refused");
        assert_eq!(status.code(), tonic::Code::Unauthenticated);

        client
            .export(export("maple_sk_test_wire_allowed", &large))
            .await
            .expect("an allowed export succeeds on the same connection");
        let forwarded = tokio::time::timeout(Duration::from_secs(2), forward_rx.recv())
            .await
            .expect("an allowed export is forwarded")
            .expect("forward channel should stay open");
        assert!(forwarded.body_len > large.len());

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn native_request_emits_a_span_per_pipeline_stage() {
        let (ch_tx, mut ch_rx) = tokio::sync::mpsc::unbounded_channel();
        let ch_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let ch_addr = ch_listener.local_addr().unwrap();
        let ch_app = Router::new()
            .route("/", post(fake_clickhouse_import))
            .with_state(ch_tx);
        tokio::spawn(async move {
            axum::serve(ch_listener, ch_app).await.unwrap();
        });

        let queue_dir = unique_main_test_dir("span-tree");
        let store = Arc::new(FakeKeyStore::default());
        let raw_key = "maple_sk_test_span_tree";
        store.insert_private(
            raw_key,
            KeyRow {
                org_id: "org_span_tree".to_owned(),
                self_managed: true,
                clickhouse_ready: true,
            },
        );
        store.insert_clickhouse_target(
            "org_span_tree",
            ClickHouseTargetRow {
                ch_url: format!("http://{ch_addr}"),
                ch_user: "ingest".to_owned(),
                ch_password_ciphertext: None,
                ch_password_iv: None,
                ch_password_tag: None,
                ch_database: "maple".to_owned(),
                schema_version: CLICKHOUSE_SCHEMA_VERSION.to_owned(),
            },
        );
        let state = test_app_state(
            Arc::clone(&store),
            queue_dir.clone(),
            "http://127.0.0.1:1".to_owned(),
            Duration::from_millis(5),
        )
        .await;

        let capture = install_span_capture();

        // Stands in for the `ingest` server span that handle_signal creates.
        let server_span = tracing::info_span!("ingest");
        let (response, item_count, _, _) = handle_signal_inner(
            &state,
            &test_headers(raw_key),
            Bytes::from(test_log_request("span tree").encode_to_vec()),
            Signal::Logs,
        )
        .instrument(server_span)
        .await
        .expect("request should be accepted through the native ClickHouse path");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(item_count, 1);

        capture.assert_child_of("ingest.authenticate", "ingest");
        capture.assert_child_of("ingest.decode", "ingest");
        capture.assert_child_of("ingest.parse", "ingest");
        capture.assert_child_of("ingest.accept", "ingest");
        capture.assert_child_of("ingest.encode_rows", "ingest.accept");
        capture.assert_child_of("ingest.wal_commit", "ingest.accept");

        // The export lane drains asynchronously, so its batch is deliberately a
        // root: one batch aggregates frames from many requests and cannot be
        // parented under any single one.
        tokio::time::timeout(Duration::from_secs(2), ch_rx.recv())
            .await
            .expect("ready org should write to ClickHouse")
            .expect("ClickHouse channel should stay open");
        assert_eq!(
            capture.parent_of("ingest.export_batch"),
            Some(None),
            "export batches must stay root spans and link back instead"
        );
    }

    #[tokio::test]
    #[expect(
        clippy::too_many_lines,
        reason = "an end-to-end scenario test; the setup is the test"
    )]
    async fn forward_mode_switches_ready_org_to_clickhouse_without_forwarding_again() {
        let (ch_tx, mut ch_rx) = tokio::sync::mpsc::unbounded_channel();
        let ch_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let ch_addr = ch_listener.local_addr().unwrap();
        let ch_app = Router::new()
            .route("/", post(fake_clickhouse_import))
            .with_state(ch_tx);
        tokio::spawn(async move {
            axum::serve(ch_listener, ch_app).await.unwrap();
        });

        let (forward_tx, mut forward_rx) = tokio::sync::mpsc::unbounded_channel();
        let forward_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let forward_addr = forward_listener.local_addr().unwrap();
        let forward_app = Router::new()
            .route("/v1/logs", post(fake_forward_collector))
            .with_state(forward_tx);
        tokio::spawn(async move {
            axum::serve(forward_listener, forward_app).await.unwrap();
        });

        let queue_dir = unique_main_test_dir("forward-ready-clickhouse");
        let store = Arc::new(FakeKeyStore::default());
        let raw_key = "maple_sk_test_forward_ready";
        store.insert_private(
            raw_key,
            KeyRow {
                org_id: "org_forward_ready".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        let state = test_app_state(
            Arc::clone(&store),
            queue_dir.clone(),
            format!("http://{forward_addr}"),
            Duration::from_millis(5),
        )
        .await;

        let first_payload = test_log_request("before setup").encode_to_vec();
        let (first_response, first_count, _, _) = handle_signal_inner(
            &state,
            &test_headers(raw_key),
            Bytes::from(first_payload),
            Signal::Logs,
        )
        .await
        .expect("non-ready request should be accepted through forward path");
        assert_eq!(first_response.status(), StatusCode::OK);
        assert_eq!(first_count, 1);
        let first_forward = tokio::time::timeout(Duration::from_secs(2), forward_rx.recv())
            .await
            .expect("non-ready org should forward")
            .expect("forward channel should stay open");
        assert_eq!(first_forward.content_type, "application/x-protobuf");
        assert_eq!(first_forward.content_encoding, "");
        assert!(first_forward.body_len > 0);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), ch_rx.recv())
                .await
                .is_err(),
            "non-ready org must not write to ClickHouse"
        );

        store.set_org_routing(
            "org_forward_ready",
            OrgRouting {
                self_managed: true,
                clickhouse_ready: true,
            },
        );
        store.insert_clickhouse_target(
            "org_forward_ready",
            ClickHouseTargetRow {
                ch_url: format!("http://{ch_addr}"),
                ch_user: "ingest".to_owned(),
                ch_password_ciphertext: None,
                ch_password_iv: None,
                ch_password_tag: None,
                ch_database: "maple".to_owned(),
                schema_version: CLICKHOUSE_SCHEMA_VERSION.to_owned(),
            },
        );
        tokio::time::sleep(Duration::from_millis(10)).await;

        let second_payload = test_log_request("after setup").encode_to_vec();
        let (second_response, second_count, _, _) = handle_signal_inner(
            &state,
            &test_headers(raw_key),
            Bytes::from(second_payload),
            Signal::Logs,
        )
        .await
        .expect("ready request should be accepted through ClickHouse path");
        assert_eq!(second_response.status(), StatusCode::OK);
        assert_eq!(second_count, 1);

        let clickhouse = tokio::time::timeout(Duration::from_secs(2), ch_rx.recv())
            .await
            .expect("ready org should write to ClickHouse")
            .expect("ClickHouse channel should stay open");
        assert!(clickhouse.query.starts_with("INSERT INTO logs"));
        assert!(clickhouse.query.contains(" FROM input('"));
        assert!(clickhouse.query.ends_with(" FORMAT JSONEachRow"));
        assert_eq!(clickhouse.database, "maple");
        assert_eq!(clickhouse.user, "ingest");
        assert_eq!(clickhouse.content_encoding, "gzip");
        assert!(clickhouse.body.contains("after setup"));
        assert!(
            !clickhouse.body.contains("before setup"),
            "the earlier Tinybird-routed request must not be replayed into ClickHouse"
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(100), forward_rx.recv())
                .await
                .is_err(),
            "ready org must not forward to the Tinybird collector path"
        );
        assert_eq!(
            store.ingest_key_fetches.load(Ordering::Relaxed),
            1,
            "same key should stay auth-cached across setup transition"
        );
        assert!(
            store.routing_fetches.load(Ordering::Relaxed) >= 1,
            "routing cache should refresh independently from auth cache"
        );

        drop(std::fs::remove_dir_all(queue_dir));
    }

    #[test]
    fn decrypt_aes256_gcm_matches_node_crypto_fixture() {
        // Generated with Node's createCipheriv("aes-256-gcm", Buffer.alloc(32, 5), iv).
        let key = parse_base64_aes256_gcm_key("BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=")
            .expect("base64 key parses");
        let plaintext = decrypt_aes256_gcm(
            "vDjK0A+Vv5bHlJ2a3A==",
            "AQIDBAUGBwgJCgsM",
            "b7D1umrvI8557NFvR9nJ/A==",
            &key,
        )
        .expect("fixture decrypts");
        assert_eq!(plaintext, "ch-secret-123");
    }

    #[test]
    fn schema_revision_accepts_newer_schemas_and_rejects_older_ones() {
        let needed = required_schema_revision();
        assert!(needed > 0, "generated SCHEMA_VERSION should be numeric");

        // Exactly current, and ahead of this binary: both writable. The second
        // is the rollout window — an org stamped at the new revision before the
        // matching binary ships keeps writing to its own ClickHouse instead of
        // silently falling back to Tinybird.
        assert!(schema_revision_is_compatible(&needed.to_string()));
        assert!(schema_revision_is_compatible(&(needed + 1).to_string()));

        // Behind this binary: the columns genuinely are not there yet.
        assert!(!schema_revision_is_compatible(&(needed - 1).to_string()));

        // Legacy content-hash revisions are not comparable — treated as older.
        assert!(!schema_revision_is_compatible("old-revision"));
        assert!(!schema_revision_is_compatible(""));
    }

    #[test]
    fn schema_revision_compares_numerically_not_lexicographically() {
        // Revisions are stored as text, where "12" sorts *before* "9". A string
        // comparison would call an org at revision 12 "behind" revision 9 and
        // strand every org the moment the count reached double digits.
        assert!(schema_revision_at_least("12", 9), "12 is ahead of 9");
        assert!(!schema_revision_at_least("9", 12), "9 is behind 12");
        assert!(schema_revision_at_least("100", 99), "100 is ahead of 99");
    }

    #[tokio::test]
    async fn clickhouse_target_resolver_requires_current_schema() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_clickhouse_target(
            "org_old",
            ClickHouseTargetRow {
                ch_url: "https://clickhouse.example".to_owned(),
                ch_user: "ingest".to_owned(),
                ch_password_ciphertext: None,
                ch_password_iv: None,
                ch_password_tag: None,
                ch_database: "maple".to_owned(),
                schema_version: "old-revision".to_owned(),
            },
        );

        let resolver = ClickHouseTargetResolver::new(store, None, 16);

        let target = resolver
            .resolve_clickhouse_target("org_old")
            .await
            .expect("target lookup should not fail");
        assert!(target.is_none());
    }

    #[tokio::test]
    async fn clickhouse_target_resolver_decrypts_current_schema_password() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_clickhouse_target(
            "org_ready",
            ClickHouseTargetRow {
                ch_url: "https://clickhouse.example/".to_owned(),
                ch_user: "ingest".to_owned(),
                ch_password_ciphertext: Some("vDjK0A+Vv5bHlJ2a3A==".to_owned()),
                ch_password_iv: Some("AQIDBAUGBwgJCgsM".to_owned()),
                ch_password_tag: Some("b7D1umrvI8557NFvR9nJ/A==".to_owned()),
                ch_database: "maple".to_owned(),
                schema_version: CLICKHOUSE_SCHEMA_VERSION.to_owned(),
            },
        );

        let resolver = ClickHouseTargetResolver::new(
            store,
            Some(
                parse_base64_aes256_gcm_key("BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=")
                    .unwrap(),
            ),
            16,
        );

        let target = resolver
            .resolve_clickhouse_target("org_ready")
            .await
            .expect("target lookup should not fail")
            .expect("target should resolve");
        assert_eq!(target.endpoint, "https://clickhouse.example");
        assert_eq!(target.user, "ingest");
        assert_eq!(target.password, "ch-secret-123");
        assert_eq!(target.database, "maple");
    }

    #[tokio::test]
    async fn clickhouse_target_resolver_rejects_password_over_http() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_clickhouse_target(
            "org_insecure",
            ClickHouseTargetRow {
                ch_url: "http://clickhouse.example/".to_owned(),
                ch_user: "ingest".to_owned(),
                ch_password_ciphertext: Some("vDjK0A+Vv5bHlJ2a3A==".to_owned()),
                ch_password_iv: Some("AQIDBAUGBwgJCgsM".to_owned()),
                ch_password_tag: Some("b7D1umrvI8557NFvR9nJ/A==".to_owned()),
                ch_database: "maple".to_owned(),
                schema_version: CLICKHOUSE_SCHEMA_VERSION.to_owned(),
            },
        );

        let resolver = ClickHouseTargetResolver::new(
            store,
            Some(
                parse_base64_aes256_gcm_key("BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=")
                    .unwrap(),
            ),
            16,
        );

        let error = resolver
            .resolve_clickhouse_target("org_insecure")
            .await
            .expect_err("password-authenticated http endpoint should be rejected");
        assert!(error.contains("https"));
    }

    #[tokio::test]
    async fn resolve_ingest_key_returns_none_when_hash_missing() {
        // Unknown key (e.g. before the API has written the row, or after a
        // reroll under a different HMAC) must produce Ok(None) so the caller
        // emits a 401 rather than crashing.
        let store = Arc::new(FakeKeyStore::default());
        let resolved = make_resolver(store)
            .resolve_ingest_key("maple_sk_unknown")
            .await
            .expect("resolve should succeed");
        assert!(resolved.is_none());
    }

    #[tokio::test]
    async fn resolve_ingest_key_negative_caches_unknown_keys() {
        // A repeated unknown key must be answered from the negative cache, not
        // by a store lookup per request — that's the unauthenticated
        // DB-amplification path.
        let store = Arc::new(FakeKeyStore::default());
        let resolver = make_resolver(Arc::clone(&store));
        for _ in 0..3 {
            let resolved = resolver
                .resolve_ingest_key("maple_sk_unknown")
                .await
                .expect("resolve should succeed");
            assert!(resolved.is_none());
        }
        assert_eq!(store.ingest_key_fetches.load(Ordering::Relaxed), 1);
    }

    /// The error of a result whose success type has no `Debug`.
    fn rejected<T, E>(result: Result<T, E>, context: &str) -> E {
        match result {
            Ok(_) => panic!("{context}"),
            Err(error) => error,
        }
    }

    const SOURCE_UUID: &str = "0f8e6c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
    const SOURCE_PUBLIC_ID: &str = "src_aXunrkWtzvXSkw9Z2smcft";

    fn source_row(org_id: &str, config: SourceConfigRow) -> SourceRow {
        SourceRow {
            key: KeyRow {
                org_id: org_id.to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
            config: Some(config),
        }
    }

    fn source_config(
        allowed_signals: Option<&str>,
        rate_limit_rps: Option<i32>,
        resource_attributes: &str,
    ) -> SourceConfigRow {
        SourceConfigRow {
            id: SOURCE_UUID.to_owned(),
            allowed_signals_json: allowed_signals.map(str::to_owned),
            rate_limit_rps,
            resource_attributes_json: resource_attributes.to_owned(),
            expires_at_ms: None,
            paused_at_ms: None,
            paused_until_ms: None,
        }
    }

    fn string_attributes(attributes: &[KeyValue]) -> std::collections::HashMap<String, String> {
        attributes
            .iter()
            .filter_map(|attribute| match &attribute.value {
                Some(AnyValue {
                    value: Some(any_value::Value::StringValue(value)),
                }) => Some((attribute.key.clone(), value.clone())),
                _ => None,
            })
            .collect()
    }

    fn string_attribute(key: &str, value: &str) -> KeyValue {
        KeyValue {
            key: key.to_owned(),
            key_strindex: 0,
            value: Some(AnyValue {
                value: Some(any_value::Value::StringValue(value.to_owned())),
            }),
        }
    }

    #[test]
    fn source_token_prefix_infers_the_source_type() {
        assert!(matches!(
            infer_ingest_key_type("maple_src_abcdefghijklmnopqrstuvwxyz012345"),
            Some(IngestKeyType::Source)
        ));
        assert_eq!(IngestKeyType::Source.as_str(), "source");
        assert!(infer_ingest_key_type("maple_xk_abc").is_none());
    }

    #[test]
    fn source_overrides_apply_before_the_maple_stamps() {
        let policy = SourcePolicy::from_row(&source_config(
            None,
            None,
            r#"[{"key":"service.name","value":"checkout","mode":"set"},
                {"key":"deployment.environment","value":"prod","mode":"default"},
                {"key":"team","value":"payments","mode":"default"},
                {"key":"maple_ingest_source","value":"spoofed","mode":"set"},
                {"key":"maple_org_id","value":"org_evil","mode":"set"}]"#,
        ));
        let resolved = ResolvedIngestKey {
            org_id: "org_real".to_owned(),
            key_type: IngestKeyType::Source,
            key_id: "abc".to_owned(),
            self_managed: false,
            clickhouse_ready: false,
            source: Some(Arc::new(policy)),
            default_source: None,
        };
        let mut attributes = vec![
            string_attribute("service.name", "from-sdk"),
            string_attribute("deployment.environment", "staging"),
            string_attribute("maple_source_id", "spoofed"),
        ];

        enrich_resource_attributes(&mut attributes, &resolved, &[]);
        let values = string_attributes(&attributes);

        assert_eq!(values["service.name"], "checkout");
        assert_eq!(values["deployment.environment"], "staging");
        assert_eq!(values["team"], "payments");
        assert_eq!(values["maple_org_id"], "org_real");
        assert_eq!(values["maple_ingest_key_type"], "source");
        assert_eq!(values["maple_ingest_source"], INGEST_SOURCE);
        assert_eq!(values["maple_source_id"], SOURCE_PUBLIC_ID);
        assert_eq!(
            attributes
                .iter()
                .filter(|attribute| attribute.key == "service.name")
                .count(),
            1
        );
    }

    #[test]
    fn default_keys_without_a_default_source_strip_the_source_stamp() {
        // A sender-supplied source id that is not verified must not survive a default key.
        let mut attributes = vec![
            string_attribute("service.name", "from-sdk"),
            string_attribute("maple_source_id", "src_spoofed"),
        ];
        enrich_resource_attributes(&mut attributes, &test_key(), &[]);
        let values = string_attributes(&attributes);
        assert_eq!(values["service.name"], "from-sdk");
        assert_eq!(values["maple_ingest_key_type"], "private");
        assert!(!values.contains_key("maple_source_id"));
    }

    const DEFAULT_SOURCE_UUID: &str = "5b1d3c7e-9a2f-4b6d-8e0c-1f2a3b4c5d6e";
    const INTEGRATION_SOURCE_UUID: &str = "7c2e4d8f-0b3a-4c7e-9f1d-2a3b4c5d6e7f";

    fn public_id(uuid: &str) -> String {
        sources::public_source_id(uuid).expect("a uuid")
    }

    fn default_key_with_source() -> ResolvedIngestKey {
        ResolvedIngestKey {
            default_source: SourceRef::from_id(DEFAULT_SOURCE_UUID.to_owned()),
            ..test_key()
        }
    }

    fn stamped_source_id(
        claim: Option<&str>,
        resolved: &ResolvedIngestKey,
        verified: &[String],
    ) -> Option<String> {
        let mut attributes = vec![string_attribute("service.name", "from-sdk")];
        if let Some(claim) = claim {
            attributes.push(string_attribute("maple_source_id", claim));
        }
        enrich_resource_attributes(&mut attributes, resolved, verified);
        assert_eq!(
            attributes
                .iter()
                .filter(|attribute| attribute.key == "maple_source_id")
                .count(),
            usize::from(string_attributes(&attributes).contains_key("maple_source_id")),
        );
        string_attributes(&attributes).remove("maple_source_id")
    }

    #[test]
    fn default_keys_stamp_the_default_source_unless_a_verified_claim_names_another() {
        let resolved = default_key_with_source();
        let default_id = public_id(DEFAULT_SOURCE_UUID);
        let integration_id = public_id(INTEGRATION_SOURCE_UUID);
        let verified = vec![integration_id.clone()];

        assert_eq!(
            stamped_source_id(None, &resolved, &verified),
            Some(default_id.clone())
        );
        // An integration poller's own source, verified as this org's, is kept.
        assert_eq!(
            stamped_source_id(Some(&integration_id), &resolved, &verified),
            Some(integration_id.clone())
        );
        // Unknown or foreign ids and undecodable values give way to the default.
        let foreign = public_id(SOURCE_UUID);
        assert_eq!(
            stamped_source_id(Some(&foreign), &resolved, &verified),
            Some(default_id.clone())
        );
        assert_eq!(
            stamped_source_id(Some("src_not-base58!"), &resolved, &verified),
            Some(default_id)
        );
        // With no default source an unverified claim is removed.
        assert_eq!(
            stamped_source_id(Some(&foreign), &test_key(), &verified),
            None
        );
        assert_eq!(
            stamped_source_id(Some(&integration_id), &test_key(), &verified),
            Some(integration_id)
        );
    }

    #[test]
    fn source_tokens_always_overwrite_the_sender_source_id() {
        let resolved = ResolvedIngestKey {
            key_type: IngestKeyType::Source,
            source: Some(Arc::new(SourcePolicy::from_row(&source_config(
                None, None, "[]",
            )))),
            ..test_key()
        };
        let claimed = public_id(INTEGRATION_SOURCE_UUID);
        // Even a claim some caller verified never wins over the token's own source.
        assert_eq!(
            stamped_source_id(Some(&claimed), &resolved, std::slice::from_ref(&claimed)),
            Some(SOURCE_PUBLIC_ID.to_owned())
        );
        assert!(!resolved.accepts_source_claims());
    }

    #[test]
    fn claims_are_collected_once_and_only_for_default_keys() {
        let claimed = public_id(INTEGRATION_SOURCE_UUID);
        let mut request = test_log_request("claims");
        request.resource_logs[0]
            .resource
            .as_mut()
            .expect("resource")
            .attributes
            .push(string_attribute("maple_source_id", &claimed));
        let duplicate = request.resource_logs[0].clone();
        request.resource_logs.push(duplicate);
        let decoded = DecodedPayload::Logs(request);

        assert_eq!(claimed_source_ids(&decoded, &test_key()), vec![claimed]);
        let token = ResolvedIngestKey {
            key_type: IngestKeyType::Source,
            ..test_key()
        };
        assert!(claimed_source_ids(&decoded, &token).is_empty());
    }

    #[tokio::test]
    async fn session_event_rows_follow_the_source_signals() {
        let queue_dir = unique_main_test_dir("session-events-source-signals");
        let store = Arc::new(FakeKeyStore::default());
        // Routed to ClickHouse: the forward-mode fixture has no Tinybird pipeline.
        let routed = |allowed: &str| SourceRow {
            key: KeyRow {
                org_id: "org_se_custom".to_owned(),
                self_managed: true,
                clickhouse_ready: true,
            },
            config: Some(source_config(Some(allowed), None, "[]")),
        };
        let sessions_only = "maple_src_session_events_sessions_only_000000";
        let events_only = "maple_src_session_events_events_only_0000000";
        let traces_only = "maple_src_session_events_traces_only_0000000";
        store.insert_source(sessions_only, routed(r#"["sessions"]"#));
        store.insert_source(events_only, routed(r#"["events"]"#));
        store.insert_source(traces_only, routed(r#"["traces"]"#));
        let state = test_app_state(
            store,
            queue_dir.clone(),
            "http://127.0.0.1:1".to_owned(),
            Duration::from_secs(30),
        )
        .await;

        let body = concat!(
            r#"{"type":"custom","message":"signup_completed"}"#,
            "\n",
            r#"{"type":"click","message":"button#buy"}"#,
            "\n",
            r#"{"type":"custom","message":"plan_selected"}"#,
            "\n",
        );
        let send = |key: &'static str| {
            let state = &state;
            async move {
                handle_session_events_inner(
                    state,
                    &bearer_headers(key),
                    Bytes::from_static(body.as_bytes()),
                )
                .await
            }
        };

        assert_eq!(
            send(sessions_only).await.expect("sessions key is admitted"),
            1
        );
        assert_eq!(send(events_only).await.expect("events key is admitted"), 2);
        let denied = send(traces_only)
            .await
            .expect_err("traces-only key is refused");
        assert_eq!(denied.status, StatusCode::FORBIDDEN);

        let _ = std::fs::remove_dir_all(&queue_dir);
    }

    #[tokio::test]
    async fn source_token_resolves_from_sources_with_policy() {
        let store = Arc::new(FakeKeyStore::default());
        let raw_key = "maple_src_resolves_from_custom_table_0000000";
        store.insert_source(
            raw_key,
            source_row(
                "org_custom",
                source_config(Some(r#"["logs"]"#), Some(10), "[]"),
            ),
        );
        let resolver = make_resolver(Arc::clone(&store));

        let resolved = resolver
            .resolve_ingest_key(raw_key)
            .await
            .expect("resolution should not fail")
            .expect("an enabled source resolves");
        assert_eq!(resolved.org_id, "org_custom");
        assert!(matches!(resolved.key_type, IngestKeyType::Source));
        let source = resolved.source.expect("source tokens carry their policy");
        assert_eq!(source.public_id, SOURCE_PUBLIC_ID);
        assert_eq!(source.rate_limit_rps, Some(10));
        assert!(source.allows(SourceSignal::Logs));
        assert!(!source.allows(SourceSignal::Traces));

        // A source token never falls through to the default key table.
        store.insert_private(
            "maple_src_only_in_default_table_000000000000",
            KeyRow {
                org_id: "org_wrong_table".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        assert!(resolver
            .resolve_ingest_key("maple_src_only_in_default_table_000000000000")
            .await
            .expect("resolution should not fail")
            .is_none());
    }

    #[tokio::test]
    async fn expired_sources_are_refused_and_paused_ones_dropped_with_success() {
        let queue_dir = unique_main_test_dir("source-401");
        let store = Arc::new(FakeKeyStore::default());
        let paused = "maple_src_paused_key_00000000000000000000000";
        let expired = "maple_src_expired_key_0000000000000000000000";
        let mut paused_config = source_config(None, None, "[]");
        paused_config.id = "1f8e6c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b".to_owned();
        paused_config.paused_at_ms = Some(current_time_millis() - 1_000);
        store.insert_source(paused, source_row("org_custom", paused_config));
        let mut expired_config = source_config(None, None, "[]");
        expired_config.expires_at_ms = Some(current_time_millis() - 1_000);
        store.insert_source(expired, source_row("org_custom", expired_config));
        let state = test_app_state(
            Arc::clone(&store),
            queue_dir.clone(),
            "http://127.0.0.1:1".to_owned(),
            Duration::from_secs(30),
        )
        .await;
        let body = Bytes::from(test_log_request("refused").encode_to_vec());

        let (response, decoded_bytes, org_id, items) =
            handle_signal_inner(&state, &test_headers(paused), body.clone(), Signal::Logs)
                .await
                .expect("a paused key is answered with success");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            (decoded_bytes, org_id.as_str(), items),
            (0, "org_custom", 0)
        );
        assert!(
            resolve_replay_key(&state, &bearer_headers(paused), &[SourceSignal::Events])
                .await
                .expect("the replay paths accept a paused key")
                .is_none(),
            "and drop what it sends"
        );
        assert!(
            store.source_uses.lock().unwrap().is_empty(),
            "dropped data does not count as use"
        );

        let (error, error_kind) =
            handle_signal_inner(&state, &test_headers(expired), body, Signal::Logs)
                .await
                .expect_err("an expired key is refused");
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);
        assert_eq!(error.message, "Ingest key expired");
        assert_eq!(error_kind, "auth");

        let replay = rejected(
            resolve_replay_key(&state, &bearer_headers(expired), &[SourceSignal::Events]).await,
            "the replay paths check expiry too",
        );
        assert_eq!(replay.status, StatusCode::UNAUTHORIZED);

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn accepted_source_data_records_its_use_once_per_interval() {
        let store = Arc::new(FakeKeyStore::default());
        let raw_key = "maple_src_records_use_000000000000000000000";
        store.insert_source(
            raw_key,
            source_row("org_custom", source_config(None, None, "[]")),
        );
        let resolver = make_resolver(Arc::clone(&store));
        let resolved = resolver
            .resolve_ingest_key(raw_key)
            .await
            .expect("resolution should not fail")
            .expect("the key resolves");

        for _ in 0..3 {
            resolver.note_source_use(&resolved, false);
        }
        // The writes run on spawned tasks; give them a moment to land.
        for _ in 0..50 {
            if !store.source_uses.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            *store.source_uses.lock().unwrap(),
            vec![SOURCE_UUID.to_owned()]
        );
    }

    #[tokio::test]
    async fn static_store_resolves_source_tokens_without_a_policy() {
        let store: Arc<dyn KeyStore> = Arc::new(StaticKeyStore {
            org_id: "org_static".to_owned(),
        });
        let resolver = IngestKeyResolver {
            store: Arc::clone(&store),
            lookup_hmac_key: "test-hmac-key".to_owned(),
            cache: Cache::builder().max_capacity(16).build(),
            negative_cache: Cache::builder().max_capacity(16).build(),
            routing: Arc::new(OrgRoutingResolver {
                store,
                cache: Cache::builder().max_capacity(16).build(),
                last_known: DashMap::new(),
            }),
            recent_key_uses: recent_key_uses_cache(),
            recent_key_rejections: recent_key_rejections_cache(),
            source_claims: source_claims_cache(Duration::from_mins(1)),
            blocked_keys: Arc::default(),
        };
        let resolved = resolver
            .resolve_ingest_key("maple_src_static_backend_key_0000000000000")
            .await
            .expect("resolution should not fail")
            .expect("the static store accepts any well-formed key");
        assert_eq!(resolved.org_id, "org_static");
        assert!(matches!(resolved.key_type, IngestKeyType::Source));
        assert!(resolved.source.is_none());
    }

    /// A forward collector that keeps each `/v1/logs` body.
    async fn spawn_capturing_logs_collector(
    ) -> (String, tokio::sync::mpsc::UnboundedReceiver<Bytes>) {
        async fn capture(
            State(tx): State<tokio::sync::mpsc::UnboundedSender<Bytes>>,
            body: Bytes,
        ) -> StatusCode {
            drop(tx.send(body));
            StatusCode::OK
        }
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/v1/logs", post(capture))
            .with_state(tx);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}"), rx)
    }

    /// A `/v1/logs` collector that refuses every batch with `status`.
    async fn spawn_refusing_logs_collector(status: StatusCode) -> String {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new().route("/v1/logs", post(move || async move { status }));
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{addr}")
    }

    /// Waits for the spawned `last_used_at` writes to settle, then reads them.
    async fn recorded_key_uses(store: &FakeKeyStore) -> Vec<String> {
        tokio::time::sleep(Duration::from_millis(100)).await;
        store.source_uses.lock().unwrap().clone()
    }

    /// Waits for the spawned `last_rejected_at` writes to settle, then reads them.
    async fn recorded_rejections(store: &FakeKeyStore) -> Vec<(String, String)> {
        tokio::time::sleep(Duration::from_millis(100)).await;
        store.source_rejections.lock().unwrap().clone()
    }

    #[tokio::test]
    async fn a_batch_the_collector_refuses_does_not_count_as_key_use() {
        let forward_url = spawn_refusing_logs_collector(StatusCode::BAD_REQUEST).await;
        let queue_dir = unique_main_test_dir("source-refused");
        let store = Arc::new(FakeKeyStore::default());
        let raw_key = "maple_src_refused_by_collector_000000000000";
        store.insert_source(
            raw_key,
            source_row("org_custom", source_config(None, None, "[]")),
        );
        let state = test_app_state(
            Arc::clone(&store),
            queue_dir.clone(),
            forward_url,
            Duration::from_secs(30),
        )
        .await;
        let body = Bytes::from(test_log_request("refused").encode_to_vec());

        let (response, ..) =
            handle_signal_inner(&state, &test_headers(raw_key), body, Signal::Logs)
                .await
                .expect("a collector 4xx is relayed, not raised");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(recorded_key_uses(&store).await.is_empty());

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn source_token_end_to_end_overrides_denies_and_rate_limits() {
        let (forward_url, mut forward_rx) = spawn_capturing_logs_collector().await;
        let queue_dir = unique_main_test_dir("source-e2e");
        let store = Arc::new(FakeKeyStore::default());
        let raw_key = "maple_src_end_to_end_key_00000000000000000000";
        store.insert_source(
            raw_key,
            source_row(
                "org_custom_e2e",
                source_config(
                    Some(r#"["logs"]"#),
                    Some(2),
                    r#"[{"key":"service.name","value":"checkout","mode":"set"}]"#,
                ),
            ),
        );
        let state = test_app_state(
            Arc::clone(&store),
            queue_dir.clone(),
            forward_url,
            Duration::from_secs(30),
        )
        .await;
        let body = Bytes::from(test_log_request("source").encode_to_vec());

        // Request 1: accepted, with the override in the forwarded payload.
        let (response, _, org_id, _) =
            handle_signal_inner(&state, &test_headers(raw_key), body.clone(), Signal::Logs)
                .await
                .expect("an allowed signal is accepted");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(org_id, "org_custom_e2e");
        let forwarded = tokio::time::timeout(Duration::from_secs(2), forward_rx.recv())
            .await
            .expect("the export is forwarded")
            .expect("forward channel should stay open");
        let forwarded = ExportLogsServiceRequest::decode(forwarded).expect("forwarded protobuf");
        let resource = forwarded.resource_logs[0]
            .resource
            .as_ref()
            .expect("resource");
        let values = string_attributes(&resource.attributes);
        assert_eq!(values["service.name"], "checkout");
        assert_eq!(values["maple_org_id"], "org_custom_e2e");
        assert_eq!(values["maple_ingest_key_type"], "source");
        assert_eq!(values["maple_source_id"], SOURCE_PUBLIC_ID);
        assert_eq!(
            recorded_key_uses(&store).await,
            vec![SOURCE_UUID.to_owned()]
        );

        // A signal outside the allow-list is 403 on every transport.
        let (error, error_kind) =
            handle_signal_inner(&state, &test_headers(raw_key), body.clone(), Signal::Traces)
                .await
                .expect_err("traces are not allowed");
        assert_eq!(error.status, StatusCode::FORBIDDEN);
        assert_eq!(
            error.message,
            "This ingest key is not allowed to send traces"
        );
        assert_eq!(error_kind, "forbidden");
        // The refusal is stamped on the source, so its health turns Failing.
        assert_eq!(
            recorded_rejections(&store).await,
            vec![(
                SOURCE_UUID.to_owned(),
                "Sent traces, which this source does not allow".to_owned()
            )]
        );
        let error = rejected(
            resolve_replay_key(&state, &bearer_headers(raw_key), &[SourceSignal::Events]).await,
            "product events are not allowed",
        );
        assert_eq!(error.status, StatusCode::FORBIDDEN);
        let status = rejected(
            admit_grpc_export(&state, &bearer_headers(raw_key), Signal::Metrics).await,
            "metrics over gRPC are not allowed",
        );
        assert_eq!(status.code(), tonic::Code::PermissionDenied);

        // Request 2 spends the last token of the 2 rps burst; request 3 is 429.
        handle_signal_inner(&state, &test_headers(raw_key), body.clone(), Signal::Logs)
            .await
            .expect("the second request fits the burst");
        let (error, error_kind) =
            handle_signal_inner(&state, &test_headers(raw_key), body, Signal::Logs)
                .await
                .expect_err("the third request is over the limit");
        assert_eq!(error.status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(error_kind, "throttle");
        let response = error.into_response();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            response
                .headers()
                .get(RETRY_AFTER)
                .and_then(|value| value.to_str().ok()),
            Some("1")
        );
        let status = rejected(
            admit_grpc_export(&state, &bearer_headers(raw_key), Signal::Logs).await,
            "gRPC shares the key's bucket",
        );
        assert_eq!(status.code(), tonic::Code::ResourceExhausted);
        // Later refusals inside the minute are not written again.
        assert_eq!(recorded_rejections(&store).await.len(), 1);

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    impl FakeKeyStore {
        /// A `sources` row of `kind`: "default", "token" or "integration".
        fn insert_source_row(&self, org_id: &str, id: &str, kind: &'static str) {
            self.source_rows
                .lock()
                .unwrap()
                .push((org_id.to_owned(), id.to_owned(), kind));
        }

        /// Sets a connector's `source_id`.
        fn link_connector_source(&self, connector_id: &str, source_id: &str) {
            self.connector_sources
                .lock()
                .unwrap()
                .insert(connector_id.to_owned(), source_id.to_owned());
        }

        /// The connector's source as the `LEFT JOIN sources` reads it: same org only.
        fn joined_source(&self, connector_id: &str, org_id: &str) -> Option<PullSourceRow> {
            let source_id = self
                .connector_sources
                .lock()
                .unwrap()
                .get(connector_id)
                .cloned()?;
            let exists = self
                .source_rows
                .lock()
                .unwrap()
                .iter()
                .any(|row| row.0 == org_id && row.1 == source_id);
            exists.then(|| self.pull_source_row(&source_id))
        }

        fn with_joined_source(&self, connector_id: &str, row: GcpConnectorRow) -> GcpConnectorRow {
            GcpConnectorRow {
                source: self.joined_source(connector_id, &row.org_id),
                ..row
            }
        }

        fn pause_source(&self, id: &str, paused_at_ms: i64, paused_until_ms: Option<i64>) {
            self.source_pauses.lock().unwrap().insert(
                id.to_owned(),
                PauseWindow {
                    paused_at_ms: Some(paused_at_ms),
                    paused_until_ms,
                },
            );
        }

        fn pull_source_row(&self, id: &str) -> PullSourceRow {
            let pauses = self.source_pauses.lock().unwrap();
            PullSourceRow {
                id: id.to_owned(),
                pause: pauses.get(id).copied().unwrap_or_default(),
            }
        }
    }

    #[tokio::test]
    async fn default_keys_resolve_the_org_default_source_with_the_key() {
        let store = Arc::new(FakeKeyStore::default());
        let org_key = KeyRow {
            org_id: "org_with_default".to_owned(),
            self_managed: false,
            clickhouse_ready: false,
        };
        store.insert_private("maple_sk_with_default", org_key.clone());
        store.insert_private(
            "maple_sk_without_default",
            KeyRow {
                org_id: "org_without_default".to_owned(),
                ..org_key
            },
        );
        store.insert_source_row("org_with_default", DEFAULT_SOURCE_UUID, "default");
        store.insert_source_row("org_with_default", INTEGRATION_SOURCE_UUID, "token");
        let resolver = make_resolver(Arc::clone(&store));

        for _ in 0..3 {
            let resolved = resolver
                .resolve_ingest_key("maple_sk_with_default")
                .await
                .unwrap()
                .expect("key resolves");
            assert_eq!(
                resolved.source_public_id(),
                Some(public_id(DEFAULT_SOURCE_UUID).as_str())
            );
            assert_eq!(resolved.source_row_id(), Some(DEFAULT_SOURCE_UUID));
        }
        // Read in the key's own query and cached with it: one lookup for three requests.
        assert_eq!(store.ingest_key_fetches.load(Ordering::Relaxed), 1);
        assert_eq!(store.source_row_fetches.load(Ordering::Relaxed), 0);

        let without = resolver
            .resolve_ingest_key("maple_sk_without_default")
            .await
            .unwrap()
            .expect("key resolves");
        assert_eq!(without.default_source, None);
        assert_eq!(without.source_public_id(), None);
    }

    #[tokio::test]
    async fn source_claims_verify_pull_sources_of_the_org_and_cache_both_answers() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_source_row("org_a", INTEGRATION_SOURCE_UUID, "integration");
        // A push (token) source of the org itself is not claimable.
        store.insert_source_row("org_a", SOURCE_UUID, "token");
        store.insert_source_row("org_b", DEFAULT_SOURCE_UUID, "integration");
        let resolver = make_resolver(Arc::clone(&store));
        let own = public_id(INTEGRATION_SOURCE_UUID);
        let claims = vec![
            own.clone(),
            public_id(SOURCE_UUID),
            public_id(DEFAULT_SOURCE_UUID),
            "src_garbage!".to_owned(),
            "not-a-source".to_owned(),
        ];

        for _ in 0..2 {
            assert_eq!(
                resolver
                    .verify_source_claims("org_a", claims.clone())
                    .await
                    .active,
                vec![own.clone()]
            );
        }
        // One query for the three decodable claims; the second pass is all cache.
        assert_eq!(store.source_row_fetches.load(Ordering::Relaxed), 1);
        assert_eq!(store.claim_lookups.lock().unwrap()[0].len(), 3);
        assert_eq!(
            resolver
                .verify_source_claims("org_b", vec![public_id(DEFAULT_SOURCE_UUID)])
                .await
                .active,
            vec![public_id(DEFAULT_SOURCE_UUID)]
        );
    }

    #[tokio::test]
    async fn source_claims_are_deduped_and_capped_in_one_lookup() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_source_row("org_a", INTEGRATION_SOURCE_UUID, "integration");
        let resolver = make_resolver(Arc::clone(&store));
        let own = public_id(INTEGRATION_SOURCE_UUID);
        let mut claims = vec![own.clone(), own.clone()];
        claims.extend((0..2_000).map(|_| public_id(&uuid::Uuid::new_v4().to_string())));

        assert_eq!(
            resolver
                .verify_source_claims("org_a", claims.clone())
                .await
                .active,
            vec![own.clone()]
        );
        let lookups = store.claim_lookups.lock().unwrap().clone();
        assert_eq!(lookups.len(), 1, "one query per request");
        assert_eq!(lookups[0].len(), MAX_SOURCE_CLAIMS);
        assert_eq!(lookups[0][0], INTEGRATION_SOURCE_UUID);

        // A real claim past the cap is never looked up, so it stays unverified.
        // Seven claims answered above plus one undecodable: none reach the store.
        let mut late = claims[2..1 + MAX_SOURCE_CLAIMS].to_vec();
        late.push("src_garbage!".to_owned());
        late.push(own);
        assert!(resolver
            .verify_source_claims("org_a", late)
            .await
            .active
            .is_empty());
        assert_eq!(store.claim_lookups.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_cached_claim_of_a_timed_pause_resumes_at_its_deadline() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_source_row("org_a", INTEGRATION_SOURCE_UUID, "integration");
        store.pause_source(
            INTEGRATION_SOURCE_UUID,
            1,
            Some(current_time_millis() + 150),
        );
        let resolver = make_resolver(Arc::clone(&store));
        let own = public_id(INTEGRATION_SOURCE_UUID);

        let verified = resolver
            .verify_source_claims("org_a", vec![own.clone()])
            .await;
        assert_eq!(verified.paused, vec![own.clone()]);
        assert!(verified.active.is_empty());
        tokio::time::sleep(Duration::from_millis(200)).await;
        let verified = resolver
            .verify_source_claims("org_a", vec![own.clone()])
            .await;
        assert_eq!(verified.active, vec![own]);
        assert!(verified.paused.is_empty());
        // Judged from the cached window: no second lookup.
        assert_eq!(store.source_row_fetches.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn source_claim_lookup_errors_leave_claims_unverified_and_uncached() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_source_row("org_a", INTEGRATION_SOURCE_UUID, "integration");
        let resolver = make_resolver(Arc::clone(&store));
        let own = public_id(INTEGRATION_SOURCE_UUID);

        store.source_errors.store(true, Ordering::Relaxed);
        assert!(resolver
            .verify_source_claims("org_a", vec![own.clone()])
            .await
            .active
            .is_empty());
        store.source_errors.store(false, Ordering::Relaxed);
        assert_eq!(
            resolver
                .verify_source_claims("org_a", vec![own.clone()])
                .await
                .active,
            vec![own]
        );
        assert_eq!(store.source_row_fetches.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn gcp_connectors_carry_their_integration_source_when_it_exists() {
        let (state, store, queue_dir) =
            gcp_logpush_state("gcp-integration-source", "http://127.0.0.1:1").await;
        store.insert_source_row("org_gcp", INTEGRATION_SOURCE_UUID, "integration");
        store.link_connector_source("gcp_conn_1", INTEGRATION_SOURCE_UUID);
        // A `source_id` naming another org's source joins nothing.
        store.insert_source_row("org_other", DEFAULT_SOURCE_UUID, "integration");
        store.link_connector_source("gcp_conn_off", DEFAULT_SOURCE_UUID);

        let with_source = state
            .gcp_resolver
            .resolve_connector("gcp_conn_1", "gcp-secret")
            .await
            .unwrap()
            .expect("connector resolves");
        assert_eq!(
            with_source.key.source_public_id(),
            Some(public_id(INTEGRATION_SOURCE_UUID).as_str())
        );
        assert!(!with_source.key.accepts_source_claims());
        let without = state
            .gcp_resolver
            .resolve_connector("gcp_conn_off", "gcp-secret-off")
            .await
            .unwrap()
            .expect("connector resolves");
        assert_eq!(without.key.source_public_id(), None);

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn default_source_use_is_held_longer_and_skipped_for_claimed_batches() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_private(
            "maple_sk_default_use",
            KeyRow {
                org_id: "org_default_use".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        store.insert_source_row("org_default_use", DEFAULT_SOURCE_UUID, "default");
        let resolver = make_resolver(Arc::clone(&store));
        let resolved = resolver
            .resolve_ingest_key("maple_sk_default_use")
            .await
            .unwrap()
            .expect("key resolves");

        // A poller's batch (it kept a verified claim) is not default-source use.
        resolver.note_source_use(&resolved, true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(store.source_uses.lock().unwrap().is_empty());

        resolver.note_source_use(&resolved, false);
        for _ in 0..50 {
            if !store.source_uses.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            *store.source_uses.lock().unwrap(),
            vec![DEFAULT_SOURCE_UUID.to_owned()]
        );
        assert_eq!(
            resolver.recent_key_uses.get(DEFAULT_SOURCE_UUID).await,
            Some(DEFAULT_SOURCE_USE_WRITE_INTERVAL),
            "the default source is rewritten at most every five minutes"
        );
    }

    #[tokio::test]
    async fn default_key_end_to_end_keeps_verified_claims_and_records_unclaimed_default_use() {
        let (forward_url, mut forward_rx) = spawn_capturing_logs_collector().await;
        let queue_dir = unique_main_test_dir("default-source-e2e");
        let store = Arc::new(FakeKeyStore::default());
        let raw_key = "maple_sk_default_source_e2e";
        store.insert_private(
            raw_key,
            KeyRow {
                org_id: "org_default_e2e".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        store.insert_source_row("org_default_e2e", DEFAULT_SOURCE_UUID, "default");
        store.insert_source_row("org_default_e2e", INTEGRATION_SOURCE_UUID, "integration");
        store.insert_source_row("org_someone_else", SOURCE_UUID, "token");
        let state = test_app_state(
            Arc::clone(&store),
            queue_dir.clone(),
            forward_url,
            Duration::from_secs(30),
        )
        .await;
        let mut request = test_log_request("claims");
        let template = request.resource_logs[0].clone();
        request.resource_logs.clear();
        let claims = [
            Some(public_id(INTEGRATION_SOURCE_UUID)),
            Some(public_id(SOURCE_UUID)),
            Some("src_garbage!".to_owned()),
            None,
        ];
        for claim in &claims {
            let mut resource_logs = template.clone();
            if let Some(claim) = claim {
                let resource = resource_logs.resource.as_mut().expect("resource");
                resource
                    .attributes
                    .push(string_attribute("maple_source_id", claim));
            }
            request.resource_logs.push(resource_logs);
        }

        let (response, ..) = handle_signal_inner(
            &state,
            &test_headers(raw_key),
            Bytes::from(request.encode_to_vec()),
            Signal::Logs,
        )
        .await
        .expect("default key traffic is accepted");
        assert_eq!(response.status(), StatusCode::OK);
        let forwarded = tokio::time::timeout(Duration::from_secs(2), forward_rx.recv())
            .await
            .expect("the export is forwarded")
            .expect("forward channel should stay open");
        let forwarded = ExportLogsServiceRequest::decode(forwarded).expect("forwarded protobuf");
        let stamped: Vec<String> = forwarded
            .resource_logs
            .iter()
            .map(|resource_logs| {
                let resource = resource_logs.resource.as_ref().expect("resource");
                string_attributes(&resource.attributes)["maple_source_id"].clone()
            })
            .collect();
        let default_id = public_id(DEFAULT_SOURCE_UUID);
        assert_eq!(
            stamped,
            vec![
                public_id(INTEGRATION_SOURCE_UUID),
                default_id.clone(),
                default_id.clone(),
                default_id,
            ]
        );
        // The batch kept a poller's claim: its source is used, the default source is not.
        assert_eq!(
            recorded_key_uses(&store).await,
            vec![INTEGRATION_SOURCE_UUID.to_owned()]
        );

        let (response, ..) = handle_signal_inner(
            &state,
            &test_headers(raw_key),
            Bytes::from(test_log_request("no claims").encode_to_vec()),
            Signal::Logs,
        )
        .await
        .expect("default key traffic is accepted");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            recorded_key_uses(&store).await,
            vec![
                INTEGRATION_SOURCE_UUID.to_owned(),
                DEFAULT_SOURCE_UUID.to_owned()
            ]
        );

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn paused_pull_source_claims_drop_only_their_resources() {
        let (forward_url, mut forward_rx) = spawn_capturing_logs_collector().await;
        let queue_dir = unique_main_test_dir("paused-pull-source");
        let store = Arc::new(FakeKeyStore::default());
        let raw_key = "maple_sk_paused_pull_source";
        store.insert_private(
            raw_key,
            KeyRow {
                org_id: "org_paused".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        store.insert_source_row("org_paused", DEFAULT_SOURCE_UUID, "default");
        store.insert_source_row("org_paused", INTEGRATION_SOURCE_UUID, "integration");
        store.insert_source_row("org_paused", SOURCE_UUID, "integration");
        // One paused until resumed; one whose timed pause already ended.
        store.pause_source(INTEGRATION_SOURCE_UUID, 1, None);
        store.pause_source(SOURCE_UUID, 1, Some(2));
        let state = test_app_state(
            Arc::clone(&store),
            queue_dir.clone(),
            forward_url,
            Duration::from_secs(30),
        )
        .await;
        let request_with = |claims: &[Option<String>]| {
            let mut request = test_log_request("paused");
            let template = request.resource_logs[0].clone();
            request.resource_logs = claims
                .iter()
                .map(|claim| {
                    let mut resource_logs = template.clone();
                    if let Some(claim) = claim {
                        let resource = resource_logs.resource.as_mut().expect("resource");
                        resource
                            .attributes
                            .push(string_attribute("maple_source_id", claim));
                    }
                    resource_logs
                })
                .collect();
            Bytes::from(request.encode_to_vec())
        };
        let paused = Some(public_id(INTEGRATION_SOURCE_UUID));

        let (response, ..) = handle_signal_inner(
            &state,
            &test_headers(raw_key),
            request_with(&[paused.clone(), Some(public_id(SOURCE_UUID)), None]),
            Signal::Logs,
        )
        .await
        .expect("default key traffic is accepted");
        assert_eq!(response.status(), StatusCode::OK);
        let forwarded = tokio::time::timeout(Duration::from_secs(2), forward_rx.recv())
            .await
            .expect("the kept resources are forwarded")
            .expect("forward channel should stay open");
        let forwarded = ExportLogsServiceRequest::decode(forwarded).expect("forwarded protobuf");
        let stamped: Vec<String> = forwarded
            .resource_logs
            .iter()
            .map(|resource_logs| {
                let resource = resource_logs.resource.as_ref().expect("resource");
                string_attributes(&resource.attributes)["maple_source_id"].clone()
            })
            .collect();
        assert_eq!(
            stamped,
            vec![public_id(SOURCE_UUID), public_id(DEFAULT_SOURCE_UUID)]
        );

        // Only paused resources: success to the sender, nothing forwarded.
        let (response, item_count, ..) = handle_signal_inner(
            &state,
            &test_headers(raw_key),
            request_with(&[paused.clone(), paused.clone()]),
            Signal::Logs,
        )
        .await
        .expect("a paused source's batch is acked");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(item_count, 0);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), forward_rx.recv())
                .await
                .is_err(),
            "a paused source's batch must not be forwarded"
        );
        // A poller's batch, even with unclaimed resources beside a paused claim, is not default use.
        // Only the unpaused claim whose data was kept counts as used.
        handle_signal_inner(
            &state,
            &test_headers(raw_key),
            request_with(&[paused, None]),
            Signal::Logs,
        )
        .await
        .expect("default key traffic is accepted");
        assert_eq!(
            recorded_key_uses(&store).await,
            vec![SOURCE_UUID.to_owned()]
        );

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn paused_drops_meter_only_the_rest_and_the_claim_cap_is_no_bypass() {
        let (forward_url, mut forward_rx) = spawn_capturing_logs_collector().await;
        let queue_dir = unique_main_test_dir("paused-pull-metering");
        let store = Arc::new(FakeKeyStore::default());
        let raw_key = "maple_sk_paused_pull_metering";
        let org = "org_paused_meter";
        let key = KeyRow {
            org_id: org.to_owned(),
            self_managed: false,
            clickhouse_ready: false,
        };
        store.insert_private(raw_key, key);
        store.insert_source_row(org, DEFAULT_SOURCE_UUID, "default");
        store.insert_source_row(org, INTEGRATION_SOURCE_UUID, "integration");
        store.pause_source(INTEGRATION_SOURCE_UUID, 1, None);
        let others: Vec<String> = (0..MAX_SOURCE_CLAIMS)
            .map(|_| uuid::Uuid::new_v4().to_string())
            .collect();
        for id in &others {
            store.insert_source_row(org, id, "integration");
        }
        let state = test_app_state(
            Arc::clone(&store),
            queue_dir.clone(),
            forward_url,
            Duration::from_secs(30),
        )
        .await;
        let paused = Some(public_id(INTEGRATION_SOURCE_UUID));
        let send = |claims: Vec<Option<String>>| {
            let mut request = test_log_request("metering");
            let template = request.resource_logs[0].clone();
            request.resource_logs = claims
                .iter()
                .map(|claim| {
                    let mut resource_logs = template.clone();
                    if let Some(claim) = claim {
                        let resource = resource_logs.resource.as_mut().expect("resource");
                        resource
                            .attributes
                            .push(string_attribute("maple_source_id", claim));
                    }
                    resource_logs
                })
                .collect();
            let body = request.encode_to_vec();
            let state = &state;
            async move {
                let len = body.len();
                let (.., metered) = handle_signal_inner(
                    state,
                    &test_headers(raw_key),
                    Bytes::from(body),
                    Signal::Logs,
                )
                .await
                .expect("default key traffic is accepted");
                (len, metered)
            }
        };
        async fn forwarded_resources(
            rx: &mut tokio::sync::mpsc::UnboundedReceiver<Bytes>,
        ) -> usize {
            let body = tokio::time::timeout(Duration::from_secs(2), rx.recv())
                .await
                .expect("forwarded")
                .expect("forward channel should stay open");
            ExportLogsServiceRequest::decode(body)
                .expect("protobuf")
                .resource_logs
                .len()
        }

        // Nothing dropped: metered exactly as received.
        let (len, metered) = send(vec![None]).await;
        assert_eq!(metered, len);
        assert_eq!(forwarded_resources(&mut forward_rx).await, 1);
        // Half dropped: only the retained share is metered.
        let (len, metered) = send(vec![paused.clone(), None]).await;
        assert!(metered > 0 && metered < len, "{metered} of {len}");
        assert_eq!(forwarded_resources(&mut forward_rx).await, 1);

        // The paused claim comes after the cap's worth of others: still dropped.
        let mut claims: Vec<Option<String>> = others.iter().map(|id| Some(public_id(id))).collect();
        claims.extend([paused, None]);
        let (len, metered) = send(claims).await;
        assert!(metered < len);
        assert_eq!(
            forwarded_resources(&mut forward_rx).await,
            MAX_SOURCE_CLAIMS + 1
        );

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn gcp_logpush_acks_and_drops_while_the_integration_source_is_paused() {
        let (ch_url, mut ch_rx) = spawn_fake_clickhouse().await;
        let (state, store, queue_dir) = gcp_logpush_state("gcp-logpush-paused", &ch_url).await;
        store.insert_source_row("org_gcp", INTEGRATION_SOURCE_UUID, "integration");
        store.link_connector_source("gcp_conn_1", INTEGRATION_SOURCE_UUID);
        store.pause_source(INTEGRATION_SOURCE_UUID, 1, None);

        let dropped = gcp_push(&state, "gcp_conn_1", Some("gcp-secret"), GCP_LOG_ENTRY).await;
        assert_eq!(dropped.status(), StatusCode::OK);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), ch_rx.recv())
                .await
                .is_err(),
            "nothing may be stored while the source is paused"
        );
        assert!(recorded_key_uses(&store).await.is_empty());

        drop(std::fs::remove_dir_all(queue_dir));
    }
    #[tokio::test]
    async fn source_claims_are_accepted_only_for_integration_sources() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_source_row("org_kinds", DEFAULT_SOURCE_UUID, "default");
        store.insert_source_row("org_kinds", SOURCE_UUID, "token");
        store.insert_source_row("org_kinds", INTEGRATION_SOURCE_UUID, "integration");
        let resolver = make_resolver(Arc::clone(&store));

        let verified = resolver
            .verify_source_claims(
                "org_kinds",
                vec![
                    public_id(DEFAULT_SOURCE_UUID),
                    public_id(SOURCE_UUID),
                    public_id(INTEGRATION_SOURCE_UUID),
                ],
            )
            .await;
        assert_eq!(verified.active, vec![public_id(INTEGRATION_SOURCE_UUID)]);
        assert!(verified.paused.is_empty());
    }

    #[tokio::test]
    async fn a_verified_claim_records_use_for_its_source_once_per_interval() {
        let (forward_url, _forward_rx) = spawn_capturing_logs_collector().await;
        let queue_dir = unique_main_test_dir("claimed-source-use");
        let store = Arc::new(FakeKeyStore::default());
        let raw_key = "maple_sk_claimed_source_use";
        store.insert_private(
            raw_key,
            KeyRow {
                org_id: "org_claimed_use".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        store.insert_source_row("org_claimed_use", DEFAULT_SOURCE_UUID, "default");
        store.insert_source_row("org_claimed_use", INTEGRATION_SOURCE_UUID, "integration");
        // A token source claimed with the default key is not verified, so not used.
        store.insert_source_row("org_claimed_use", SOURCE_UUID, "token");
        let state = test_app_state(
            Arc::clone(&store),
            queue_dir.clone(),
            forward_url,
            Duration::from_secs(30),
        )
        .await;
        let mut request = test_log_request("claimed use");
        let template = request.resource_logs[0].clone();
        request.resource_logs = [INTEGRATION_SOURCE_UUID, SOURCE_UUID]
            .iter()
            .map(|id| {
                let mut resource_logs = template.clone();
                let resource = resource_logs.resource.as_mut().expect("resource");
                resource
                    .attributes
                    .push(string_attribute("maple_source_id", &public_id(id)));
                resource_logs
            })
            .collect();
        let body = Bytes::from(request.encode_to_vec());

        for _ in 0..2 {
            let (response, ..) =
                handle_signal_inner(&state, &test_headers(raw_key), body.clone(), Signal::Logs)
                    .await
                    .expect("default key traffic is accepted");
            assert_eq!(response.status(), StatusCode::OK);
        }
        assert_eq!(
            recorded_key_uses(&store).await,
            vec![INTEGRATION_SOURCE_UUID.to_owned()]
        );
        assert_eq!(
            state
                .resolver
                .recent_key_uses
                .get(INTEGRATION_SOURCE_UUID)
                .await,
            Some(SOURCE_USE_WRITE_INTERVAL)
        );

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    /// Two Cloudflare Logpush connectors of one org: `cf_with_source`, linked to
    /// `INTEGRATION_SOURCE_UUID`, and `cf_without_source`, whose org has no OAuth link.
    async fn cloudflare_logpush_state(
        name: &str,
    ) -> (
        AppState,
        Arc<FakeKeyStore>,
        PathBuf,
        tokio::sync::mpsc::UnboundedReceiver<Bytes>,
    ) {
        let (forward_url, forward_rx) = spawn_capturing_logs_collector().await;
        let queue_dir = unique_main_test_dir(name);
        let store = Arc::new(FakeKeyStore::default());
        for connector_id in ["cf_with_source", "cf_without_source"] {
            store.insert_connector(
                connector_id,
                "connector-secret",
                ConnectorRow {
                    org_id: "org_cf_source".to_owned(),
                    service_name: "cloudflare/example.com".to_owned(),
                    zone_name: "example.com".to_owned(),
                    dataset: "http_requests".to_owned(),
                    self_managed: false,
                    clickhouse_ready: false,
                    source: None,
                },
            );
        }
        store.insert_source_row("org_cf_source", INTEGRATION_SOURCE_UUID, "integration");
        store.link_connector_source("cf_with_source", INTEGRATION_SOURCE_UUID);
        let state = test_app_state(
            Arc::clone(&store),
            queue_dir.clone(),
            forward_url,
            Duration::from_secs(30),
        )
        .await;
        (state, store, queue_dir, forward_rx)
    }

    const CLOUDFLARE_BATCH: &[u8] =
        b"{\"ClientRequestHost\":\"example.com\",\"EdgeResponseStatus\":200}\n";

    async fn cloudflare_push(
        state: &AppState,
        connector_id: &str,
    ) -> Result<(Response, usize, String, LogpushOutcome), (ApiError, &'static str)> {
        handle_cloudflare_logpush_inner(
            state,
            connector_id,
            Some("connector-secret"),
            &HeaderMap::new(),
            Bytes::from_static(CLOUDFLARE_BATCH),
        )
        .await
    }

    #[tokio::test]
    async fn cloudflare_logpush_stamps_and_uses_its_connector_source_only_when_it_has_one() {
        let (state, store, queue_dir, mut forward_rx) =
            cloudflare_logpush_state("cloudflare-logpush-source").await;

        let mut stamped = Vec::new();
        for connector_id in ["cf_with_source", "cf_without_source"] {
            let (response, item_count, _, outcome) = cloudflare_push(&state, connector_id)
                .await
                .expect("a log batch is accepted");
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!((item_count, outcome), (1, LogpushOutcome::Accepted));
            let forwarded = tokio::time::timeout(Duration::from_secs(2), forward_rx.recv())
                .await
                .expect("the batch is forwarded")
                .expect("forward channel should stay open");
            let forwarded =
                ExportLogsServiceRequest::decode(forwarded).expect("forwarded protobuf");
            let resource = forwarded.resource_logs[0]
                .resource
                .as_ref()
                .expect("resource");
            stamped.push(string_attributes(&resource.attributes).remove("maple_source_id"));
        }
        assert_eq!(
            stamped,
            vec![Some(public_id(INTEGRATION_SOURCE_UUID)), None]
        );
        assert_eq!(
            recorded_key_uses(&store).await,
            vec![INTEGRATION_SOURCE_UUID.to_owned()]
        );

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn cloudflare_logpush_acks_and_drops_while_its_source_is_paused() {
        let (state, store, queue_dir, mut forward_rx) =
            cloudflare_logpush_state("cloudflare-logpush-paused").await;
        store.pause_source(INTEGRATION_SOURCE_UUID, 1, None);

        let (response, item_count, org_id, outcome) = cloudflare_push(&state, "cf_with_source")
            .await
            .expect("a paused source's batch is acked");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            (item_count, org_id.as_str(), outcome),
            (0, "org_cf_source", LogpushOutcome::SourcePaused)
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(100), forward_rx.recv())
                .await
                .is_err(),
            "nothing may be stored while the source is paused"
        );
        assert!(recorded_key_uses(&store).await.is_empty());
        assert_eq!(store.connector_successes.load(Ordering::Relaxed), 0);

        // The org's other connector has no source, so it is not paused with it.
        let (_, item_count, _, outcome) = cloudflare_push(&state, "cf_without_source")
            .await
            .expect("a log batch is accepted");
        assert_eq!((item_count, outcome), (1, LogpushOutcome::Accepted));

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[test]
    fn fleet_size_defaults_to_one_and_refuses_zero() {
        assert_eq!(parse_fleet_size(None), Ok(1));
        assert_eq!(parse_fleet_size(Some("4".to_owned())), Ok(4));
        assert!(parse_fleet_size(Some("0".to_owned())).is_err());
        assert!(parse_fleet_size(Some("many".to_owned())).is_err());
    }

    // Ingest rules in the gateway (docs/ingest-rules.md).

    impl FakeKeyStore {
        /// Stores `rules` (spec JSON, in position order) as the org's enabled rules.
        fn set_ingest_rules(&self, org_id: &str, rules: &[serde_json::Value]) {
            let rows = IngestRuleRows {
                rules: rules
                    .iter()
                    .enumerate()
                    .map(|(index, rule)| (format!("rule_{index}"), rule.to_string()))
                    .collect(),
                hash_salt: "test-salt".to_owned(),
            };
            self.ingest_rules
                .lock()
                .unwrap()
                .insert(org_id.to_owned(), rows);
        }
    }

    /// Turns ingest rules on for `state`, reading them from `store`.
    fn with_ingest_rules(mut state: AppState, store: &Arc<FakeKeyStore>) -> AppState {
        state.ingest_rule_resolver = IngestRuleResolver::new(
            Arc::<FakeKeyStore>::clone(store),
            true,
            Duration::from_secs(30),
            16,
        );
        state
    }

    fn mask_emails_rule() -> serde_json::Value {
        serde_json::json!({
            "signals": ["logs"],
            "conditions": [],
            "action": { "_tag": "redact", "keys": [], "detectors": ["email"], "patterns": [],
                "scopes": ["attributes", "body"], "method": "mask" }
        })
    }

    fn drop_debug_logs_rule() -> serde_json::Value {
        serde_json::json!({
            "signals": ["logs"],
            "conditions": [{ "field": "severity", "op": "lt", "value": "info" }],
            "action": { "_tag": "drop", "keepPercent": 0 }
        })
    }

    /// A one-record log request at `severity_number`.
    fn log_request_at(message: &str, severity_number: i32) -> ExportLogsServiceRequest {
        let mut request = test_log_request(message);
        request.resource_logs[0].scope_logs[0].log_records[0].severity_number = severity_number;
        request
    }

    fn forwarded_bodies(request: &ExportLogsServiceRequest) -> Vec<String> {
        request
            .resource_logs
            .iter()
            .flat_map(|resource| &resource.scope_logs)
            .flat_map(|scope| &scope.log_records)
            .filter_map(|record| match record.body.as_ref()?.value.as_ref()? {
                any_value::Value::StringValue(text) => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    async fn next_forwarded_logs(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<Bytes>,
    ) -> ExportLogsServiceRequest {
        let body = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("forwarded")
            .expect("forward channel should stay open");
        ExportLogsServiceRequest::decode(body).expect("protobuf")
    }

    /// A forward-mode state for one private key whose org is `org`, plus its store.
    async fn rules_forward_state(
        name: &str,
        raw_key: &str,
        org: &str,
        forward_url: String,
    ) -> (AppState, Arc<FakeKeyStore>, PathBuf) {
        let queue_dir = unique_main_test_dir(name);
        let store = Arc::new(FakeKeyStore::default());
        store.insert_private(
            raw_key,
            KeyRow {
                org_id: org.to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        let state = test_app_state(
            Arc::clone(&store),
            queue_dir.clone(),
            forward_url,
            Duration::from_secs(30),
        )
        .await;
        (state, store, queue_dir)
    }

    #[tokio::test]
    async fn forwarded_logs_carry_redacted_values_only() {
        let (forward_url, mut forward_rx) = spawn_capturing_logs_collector().await;
        let raw_key = "maple_sk_rules_forward";
        let (state, store, queue_dir) =
            rules_forward_state("rules-forward", raw_key, "org_rules_forward", forward_url).await;
        store.set_ingest_rules("org_rules_forward", &[mask_emails_rule()]);
        let state = with_ingest_rules(state, &store);

        let body = log_request_at("login from jane@example.com", 9).encode_to_vec();
        let (response, ..) = handle_signal_inner(&state, &test_headers(raw_key), Bytes::from(body), Signal::Logs)
            .await
            .expect("accepted");
        assert_eq!(response.status(), StatusCode::OK);
        let forwarded = next_forwarded_logs(&mut forward_rx).await;
        assert_eq!(forwarded_bodies(&forwarded), ["login from [REDACTED:email]"]);

        // The counts reach the stats table on the next flush.
        state.ingest_rule_stats.flush(store.as_ref()).await;
        let rows = store.ingest_rule_stats.lock().unwrap().clone();
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!((rows[0].rule_id.as_str(), rows[0].signal), ("rule_0", "logs"));
        assert_eq!((rows[0].counts.matched, rows[0].counts.redacted_values), (1, 1));

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn a_dropped_debug_log_is_not_forwarded_and_meters_nothing() {
        let (forward_url, mut forward_rx) = spawn_capturing_logs_collector().await;
        let raw_key = "maple_sk_rules_drop";
        let (state, store, queue_dir) =
            rules_forward_state("rules-drop", raw_key, "org_rules_drop", forward_url).await;
        store.set_ingest_rules("org_rules_drop", &[drop_debug_logs_rule()]);
        let state = with_ingest_rules(state, &store);

        let body = log_request_at("noisy debug line", 5).encode_to_vec();
        let (response, item_count, _, metered) =
            handle_signal_inner(&state, &test_headers(raw_key), Bytes::from(body), Signal::Logs)
                .await
                .expect("a fully dropped batch is still acked");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!((item_count, metered), (0, 0));
        assert!(
            tokio::time::timeout(Duration::from_millis(100), forward_rx.recv())
                .await
                .is_err(),
            "a dropped log must not be forwarded"
        );

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn a_partial_drop_meters_only_what_is_kept() {
        let (forward_url, mut forward_rx) = spawn_capturing_logs_collector().await;
        let raw_key = "maple_sk_rules_partial";
        let (state, store, queue_dir) =
            rules_forward_state("rules-partial", raw_key, "org_rules_partial", forward_url).await;
        store.set_ingest_rules("org_rules_partial", &[drop_debug_logs_rule()]);
        let state = with_ingest_rules(state, &store);

        let mut request = log_request_at("kept info line", 9);
        let mut debug = request.resource_logs[0].scope_logs[0].log_records[0].clone();
        debug.severity_number = 5;
        debug.body = Some(AnyValue {
            value: Some(any_value::Value::StringValue("dropped debug line".to_owned())),
        });
        request.resource_logs[0].scope_logs[0].log_records.push(debug);
        let body = request.encode_to_vec();
        let received = body.len();
        let (_, item_count, _, metered) =
            handle_signal_inner(&state, &test_headers(raw_key), Bytes::from(body), Signal::Logs)
                .await
                .expect("accepted");
        assert_eq!(item_count, 1);
        assert!(metered > 0 && metered < received, "{metered} of {received}");
        let forwarded = next_forwarded_logs(&mut forward_rx).await;
        assert_eq!(forwarded_bodies(&forwarded), ["kept info line"]);

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn disabled_ingest_rules_never_query_the_store() {
        let (forward_url, mut forward_rx) = spawn_capturing_logs_collector().await;
        let raw_key = "maple_sk_rules_off";
        let (state, store, queue_dir) =
            rules_forward_state("rules-off", raw_key, "org_rules_off", forward_url).await;
        store.set_ingest_rules("org_rules_off", &[mask_emails_rule()]);
        // `test_app_state` builds its config with ingest rules turned off.

        let body = log_request_at("login from jane@example.com", 9).encode_to_vec();
        let (_, _, _, metered) =
            handle_signal_inner(&state, &test_headers(raw_key), Bytes::from(body.clone()), Signal::Logs)
                .await
                .expect("accepted");
        assert_eq!(metered, body.len());
        let forwarded = next_forwarded_logs(&mut forward_rx).await;
        assert_eq!(forwarded_bodies(&forwarded), ["login from jane@example.com"]);
        assert_eq!(store.ingest_rule_fetches.load(Ordering::Relaxed), 0);

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn a_failed_rule_lookup_keeps_serving_the_last_good_rules() {
        let store = Arc::new(FakeKeyStore::default());
        store.set_ingest_rules("org_rules_lkg", &[mask_emails_rule(), drop_debug_logs_rule()]);
        let resolver = IngestRuleResolver::new(
            Arc::<FakeKeyStore>::clone(&store),
            true,
            Duration::from_secs(30),
            16,
        );
        let loaded = |rules: Result<Arc<rules_gateway::OrgRules>, rules_gateway::RulesUnavailable>| {
            rules.expect("rules resolve").compiled.len()
        };
        // Concurrent misses share one fetch.
        let (a, b, c) = tokio::join!(
            resolver.resolve_rules("org_rules_lkg"),
            resolver.resolve_rules("org_rules_lkg"),
            resolver.resolve_rules("org_rules_lkg"),
        );
        assert_eq!((loaded(a), loaded(b), loaded(c)), (2, 2, 2));
        assert_eq!(store.ingest_rule_fetches.load(Ordering::Relaxed), 1);

        store.ingest_rule_errors.store(true, Ordering::Relaxed);
        resolver.expire("org_rules_lkg").await;
        assert_eq!(loaded(resolver.resolve_rules("org_rules_lkg").await), 2);
        assert_eq!(store.ingest_rule_fetches.load(Ordering::Relaxed), 2);
        // Within the backoff the store is not asked again.
        assert_eq!(loaded(resolver.resolve_rules("org_rules_lkg").await), 2);
        assert_eq!(store.ingest_rule_fetches.load(Ordering::Relaxed), 2);

        // An org never loaded has nothing safe to fall back on.
        assert!(resolver.resolve_rules("org_never_loaded").await.is_err());
    }

    #[tokio::test]
    async fn a_rule_lookup_with_nothing_to_fall_back_on_refuses_with_a_retryable_503() {
        let (forward_url, mut forward_rx) = spawn_capturing_logs_collector().await;
        let raw_key = "maple_sk_rules_closed";
        let (state, store, queue_dir) =
            rules_forward_state("rules-closed", raw_key, "org_rules_closed", forward_url).await;
        store.set_ingest_rules("org_rules_closed", &[mask_emails_rule()]);
        store.ingest_rule_errors.store(true, Ordering::Relaxed);
        let state = with_ingest_rules(state, &store);

        let body = log_request_at("login from jane@example.com", 9).encode_to_vec();
        let Err((error, _)) =
            handle_signal_inner(&state, &test_headers(raw_key), Bytes::from(body), Signal::Logs).await
        else {
            panic!("an unredactable payload must not be accepted");
        };
        assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            error.into_response().headers().get(RETRY_AFTER),
            Some(&HeaderValue::from_static("5"))
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(100), forward_rx.recv())
                .await
                .is_err(),
            "nothing may be forwarded unredacted"
        );

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn rule_stats_count_only_payloads_the_collector_took() {
        let forward_url = spawn_refusing_logs_collector(StatusCode::SERVICE_UNAVAILABLE).await;
        let raw_key = "maple_sk_rules_refused";
        let (state, store, queue_dir) =
            rules_forward_state("rules-refused", raw_key, "org_rules_refused", forward_url).await;
        store.set_ingest_rules("org_rules_refused", &[mask_emails_rule()]);
        let state = with_ingest_rules(state, &store);

        let body = log_request_at("login from jane@example.com", 9).encode_to_vec();
        let accepted =
            handle_signal_inner(&state, &test_headers(raw_key), Bytes::from(body), Signal::Logs).await;
        assert!(
            accepted.map_or(true, |(response, ..)| !response.status().is_success()),
            "the collector refused the batch"
        );
        state.ingest_rule_stats.flush(store.as_ref()).await;
        assert!(store.ingest_rule_stats.lock().unwrap().is_empty());

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    const GCP_EMAIL_LOG_ENTRY: &str = r#"{
        "logName": "projects/my-project/logs/run.googleapis.com%2Fstdout",
        "insertId": "insert-2",
        "timestamp": "2025-03-07T12:34:56.123456789Z",
        "severity": "WARNING",
        "textPayload": "password reset for jane@example.com",
        "resource": {
            "type": "cloud_run_revision",
            "labels": {
                "project_id": "my-project",
                "service_name": "checkout",
                "revision_name": "checkout-00042-abc",
                "location": "europe-west4"
            }
        }
    }"#;

    /// `gcp_logpush_state` with ingest rules on, before it is shared.
    async fn gcp_rules_state(
        name: &str,
        clickhouse_url: &str,
        rules: &[serde_json::Value],
    ) -> (AppState, Arc<FakeKeyStore>, PathBuf) {
        let (state, store, queue_dir) = gcp_logpush_state(name, clickhouse_url).await;
        let Ok(state) = Arc::try_unwrap(state) else {
            panic!("the GCP test state is not shared yet");
        };
        store.set_ingest_rules("org_gcp", rules);
        let state = with_ingest_rules(state, &store);
        (state, store, queue_dir)
    }

    #[tokio::test]
    async fn stored_rows_hold_the_redacted_value_never_the_raw_one() {
        let (ch_url, mut ch_rx) = spawn_fake_clickhouse().await;
        let (state, _store, queue_dir) =
            gcp_rules_state("rules-gcp-redact", &ch_url, &[mask_emails_rule()]).await;
        let state = Arc::new(state);

        let accepted = gcp_push(&state, "gcp_conn_1", Some("gcp-secret"), GCP_EMAIL_LOG_ENTRY).await;
        assert_eq!(accepted.status(), StatusCode::OK);
        let stored = tokio::time::timeout(Duration::from_secs(2), ch_rx.recv())
            .await
            .expect("the entry should reach the org's ClickHouse")
            .expect("ClickHouse channel should stay open");
        assert!(stored.query.starts_with("INSERT INTO logs"));
        assert!(stored.body.contains("password reset for [REDACTED:email]"), "{}", stored.body);
        assert!(!stored.body.contains("jane@example.com"), "{}", stored.body);

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn cloudflare_batches_meter_only_what_the_rules_leave() {
        let (state, store, queue_dir, mut forward_rx) =
            cloudflare_logpush_state("rules-cloudflare-meter").await;
        // Drops the INFO (200) record and keeps the WARN (404) one.
        store.set_ingest_rules(
            "org_cf_source",
            &[serde_json::json!({
                "signals": ["logs"],
                "conditions": [{ "field": "severity", "op": "lt", "value": "warn" }],
                "action": { "_tag": "drop", "keepPercent": 0 }
            })],
        );
        let state = with_ingest_rules(state, &store);
        let (state, mut autumn_rx) = with_fake_autumn(state).await;
        const BATCH: &[u8] = b"{\"ClientRequestHost\":\"example.com\",\"EdgeResponseStatus\":200}\n\
            {\"ClientRequestHost\":\"example.com\",\"EdgeResponseStatus\":404}\n";

        let (response, ..) = handle_cloudflare_logpush_inner(
            &state,
            "cf_without_source",
            Some("connector-secret"),
            &HeaderMap::new(),
            Bytes::from_static(BATCH),
        )
        .await
        .expect("accepted");
        assert_eq!(response.status(), StatusCode::OK);
        let forwarded = next_forwarded_logs(&mut forward_rx).await;
        assert_eq!(forwarded.resource_logs[0].scope_logs[0].log_records.len(), 1);
        let calls = drain_autumn_calls(&mut autumn_rx).await;
        let tracked = tracked(&calls);
        let unscaled = billable_gb(BATCH.len() as u64);
        assert_eq!(tracked.len(), 1, "{tracked:?}");
        assert_eq!(tracked[0].0, "logs");
        assert!(tracked[0].1 > 0.0 && tracked[0].1 < unscaled, "{} of {unscaled}", tracked[0].1);

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[test]
    fn retained_share_composes_and_never_exceeds_what_was_received() {
        let mut retained = Retained::default();
        assert_eq!(retained.metered_bytes(1_000), 1_000);
        // A paused-source drop keeps half, then the rules keep half of that.
        retained.retain(200, 100);
        retained.retain(80, 40);
        assert_eq!(retained.metered_bytes(1_000), 250);
        // Hashing that grows the payload bills no more than before it.
        retained.retain(40, 60);
        assert_eq!(retained.metered_bytes(1_000), 250);
        // Items are what the rules left, recounted, not the count before them.
        assert_eq!(retained.metered_items(3), 3);
        retained.kept_items = Some(1);
        assert_eq!(retained.metered_items(3), 1);
    }

    #[test]
    fn rule_stats_upsert_numbers_every_row_and_adds_on_conflict() {
        let sql = ingest_rule_stats_upsert_sql(2);
        assert!(sql.contains(
            "($1, $2, to_timestamp($3::bigint / 1000.0), $4, $5::bigint, $6::bigint, $7::bigint, $8::bigint), \
             ($9, $10, to_timestamp($11::bigint / 1000.0), $12, $13::bigint, $14::bigint, $15::bigint, $16::bigint)"
        ));
        assert!(sql.contains("dropped_bytes = org_ingest_rule_stats.dropped_bytes + EXCLUDED.dropped_bytes"));
    }
}
