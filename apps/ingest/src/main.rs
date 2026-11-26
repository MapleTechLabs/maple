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

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use autumn::{AutumnEntitlements, AutumnTracker, BillingOrgLookup, BillingOrgResolver};
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
use hmac::{Hmac, Mac};
use maple_ingest::ai_session;
use maple_ingest::audit_trail;
use maple_ingest::aws::CredentialsProvider as AwsCredentialsProvider;
use maple_ingest::aws_metric_stream;
use maple_ingest::clickhouse_insert_mappings::SCHEMA_VERSION as CLICKHOUSE_SCHEMA_VERSION;
use maple_ingest::cookieless;
use maple_ingest::decode_budget::{self, DecodeMemory, DecodeReservation, OtlpSignal};
use maple_ingest::decompress::{
    gunzip_bounded, gunzip_declared, gunzip_len_bounded, snappy_declared_len, unsnap_declared,
    GunzipError, SnappyError,
};
use maple_ingest::gcp_logging;
use maple_ingest::gcp_push_auth::{GooglePushAuth, PushAuthError};
use maple_ingest::host_identity;
use maple_ingest::ingest_rules::{self, IngestSignal, RuleStats};
use maple_ingest::metrics;
use maple_ingest::otel::{
    accept_internal_span, auth_internal_span, build_resource, decode_internal_span,
    entitlement_internal_span, forward_client_span, grpc_server_span, parse_internal_span,
    record_stage_error, rejection_loses_data, resolve_config_internal_span, ResourceConfig,
};
use maple_ingest::otlp_json;
use maple_ingest::profiles;
use maple_ingest::prometheus_remote_write;
use maple_ingest::r2::{replay_object_key, ReplayBlobStore};
use maple_ingest::retention::{self, RetentionOverrides, RetentionSignal, RetentionStamps};
use maple_ingest::row_budget::{self, ForwardBody, RowEstimate, ROW_PIECE_BYTES};
use maple_ingest::session_analytics::{
    derive_referrer_host, is_billable_session_start, row_session_id, sanitize_product_event,
    sanitize_session_event,
    sanitize_session_meta,
    BillableSessionStarts,
};
use maple_ingest::telemetry::{
    AcceptStats, AttributeMappingRule, ClickHouseBreakerConfig, ClickHouseTarget,
    ClickHouseTargetProvider, DatasourceNames, EventsStamps, ExportDestination, HttpClient,
    MappingOperation, MappingSourceContext, PipelineError, PlannedFailure, RowBatchesError,
    RowSource, SamplingPolicy, SourceStamps, TelemetryPipeline, TelemetrySignal, TinybirdConfig,
};
use maple_ingest::usage_metrics::{billable_gb, usage_cardinality_view, UsageMetrics};
use maple_ingest::vercel_ai_gateway_drain;
use maple_ingest::vercel_event_drains::{self, EventDrain};
use maple_ingest::vercel_logs;
use maple_ingest::vercel_traces;
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
use opentelemetry_proto::tonic::collector::profiles::v1development::{
    ExportProfilesPartialSuccess, ExportProfilesServiceRequest, ExportProfilesServiceResponse,
};
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
/// (`packages/backend/src/platform/credential-tokens.ts`); changing it on one side without the
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
    /// Ceiling on what decoding one OTLP payload may allocate, estimated before
    /// decoding (`decode_budget`); past it the request is a 413.
    max_decode_heap_bytes: u64,
    /// `INGEST_MAX_ROW_EXPANSION`: how many times its metered bytes a request's rows
    /// may come to; past it the request is a 413. 0 turns the ceiling off.
    max_row_expansion: u64,
    /// Row bytes a request's rows are built and written in at a time (`ROW_PIECE_BYTES`).
    row_piece_bytes: u64,
    /// Process-wide memory for request bodies being decoded, shared by every
    /// request; past it a request is shed with a retryable 503.
    decode_memory_bytes: u64,
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
    clickhouse_secret_keyring: Option<SecretKeyring>,
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
    /// `INGEST_AUDIT_TRAIL_ENABLED` (default off): keep provider audit events in
    /// the audit trail instead of as logs. See `stores_audit_trail`.
    audit_trail_enabled: bool,
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

/// Decode memory one request holds at every ceiling at once: its body, the
/// inflated body and its decode heap, a KiB per part for rounding, and room for
/// a piece of its rows twice over.
fn largest_decode_request_bytes(
    max_request_body_bytes: usize,
    max_decoded_body_bytes: usize,
    max_decode_heap_bytes: u64,
) -> u64 {
    (max_request_body_bytes as u64)
        .saturating_add(max_decoded_body_bytes as u64)
        .saturating_add(max_decode_heap_bytes)
        .saturating_add(3 * 1024)
        .saturating_add(2 * ROW_PIECE_BYTES)
}

/// The default `INGEST_MAX_ROW_EXPANSION`.
const DEFAULT_MAX_ROW_EXPANSION: u64 = 512;

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

/// Whether a request left rows behind: the collector took it, or the native
/// pipeline had already accepted it before the forward (dual mode).
fn batch_was_stored(
    forwarded_ok: bool,
    write_mode: WriteMode,
    destination: ExportDestination,
) -> bool {
    forwarded_ok || uses_native_pipeline_for(write_mode, destination)
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
    /// Whether provider audit events go to the audit trail. Off, or on a gateway
    /// that only forwards and so has no such table, they stay logs.
    fn stores_audit_trail(&self) -> bool {
        self.audit_trail_enabled && self.write_mode.uses_tinybird()
    }

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
            datasource_profiles: std::env::var("INGEST_TINYBIRD_DATASOURCE_PROFILES")
                .unwrap_or_else(|_| profiles::DATASOURCE.to_owned()),
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
        // Real protobuf telemetry is estimated at 5-13x its size: this admits the largest
        // batches seen in prd (~50 MB) while one request stays well inside the task.
        let max_decode_heap_bytes = parse_u64(
            "INGEST_MAX_DECODE_HEAP_BYTES",
            std::env::var("INGEST_MAX_DECODE_HEAP_BYTES").ok(),
            768 * 1024 * 1024,
        )?;
        // A row repeats its resource, scope and metric strings, so a request can store
        // far more than it is metered on. Real telemetry stores 3 to 13 times its
        // decoded size, and up to 200 times with a JVM command line on every row.
        let max_row_expansion = parse_u64(
            "INGEST_MAX_ROW_EXPANSION",
            std::env::var("INGEST_MAX_ROW_EXPANSION").ok(),
            DEFAULT_MAX_ROW_EXPANSION,
        )?;
        // Raised to at least one request at every ceiling, so one always gets through.
        let largest_request = largest_decode_request_bytes(
            max_request_body_bytes,
            max_decoded_body_bytes,
            max_decode_heap_bytes,
        );
        let decode_memory_bytes = parse_u64(
            "INGEST_DECODE_MEMORY_BYTES",
            std::env::var("INGEST_DECODE_MEMORY_BYTES").ok(),
            1024 * 1024 * 1024,
        )?
        .max(largest_request);
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
        let clickhouse_secret_keyring = match &key_store_backend {
            // The Postgres key store decrypts BYO-ClickHouse credentials from
            // org_clickhouse_settings, so it needs the encryption keys.
            KeyStoreBackend::Postgres { .. } => Some(SecretKeyring::from_env_values(
                std::env::var(CH_PASSWORD_SLOT_KEYS_ENV).ok().as_deref(),
                std::env::var("MAPLE_INGEST_KEY_ENCRYPTION_KEY").ok().as_deref(),
                std::env::var("MAPLE_INGEST_KEY_DECRYPTION_KEYS").ok().as_deref(),
            )?),
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
        // Off by default. Turn it on once the table exists and every running task
        // is a build that reads the audit trail's WAL frames: an older build that
        // recovers one drops the rest of that segment.
        let audit_trail_enabled = parse_bool(
            "INGEST_AUDIT_TRAIL_ENABLED",
            std::env::var("INGEST_AUDIT_TRAIL_ENABLED").ok(),
            false,
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
            max_decode_heap_bytes,
            max_row_expansion,
            row_piece_bytes: ROW_PIECE_BYTES,
            decode_memory_bytes,
            org_max_in_flight,
            rate_limit_fleet_size,
            gcp_org_max_in_flight,
            request_timeout,
            require_tls,
            key_store_backend,
            clickhouse_secret_keyring,
            lookup_hmac_key,
            autumn_secret_key,
            autumn_api_url,
            autumn_flush_interval_secs,
            autumn_allow_ttl_secs,
            autumn_deny_ttl_secs,
            ingest_key_cache_ttl_secs,
            org_routing_cache_ttl_secs,
            ingest_rules_enabled,
            audit_trail_enabled,
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

    /// An insert over an expired, not yet evicted entry is an update. moka's default keeps the
    /// old remaining time, which is none once expired, so the entry would never expire again.
    fn expire_after_update(
        &self,
        _key: &String,
        interval: &Duration,
        _updated_at: Instant,
        _duration_until_expiry: Option<Duration>,
    ) -> Option<Duration> {
        Some(*interval)
    }
}

/// A cached answer for one `maple_source_id` claim. The pause window is kept
/// rather than a verdict, so a timed pause ends at its deadline while cached.
/// The source's own retention overrides ride along, to stamp the rows it is named on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SourceClaim {
    Unclaimable,
    Claimable(PauseWindow, RetentionOverrides),
}

/// A source a default-key request named and the org owns: its `maple_source_id` as
/// stamped on the resource, and its own retention overrides.
type NamedSource = (String, RetentionOverrides);

/// Verified claims split by whether their source is paused right now.
#[derive(Debug, Default, PartialEq, Eq)]
struct VerifiedClaims {
    active: Vec<String>,
    /// Each `active` claim with its source's own retention overrides, set or not: a
    /// source that sets none inherits from the org, never from the default source.
    retention: Vec<NamedSource>,
    paused: Vec<String>,
    /// The store could not be asked: a claim in neither list may still be the org's.
    unresolved: bool,
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

/// Each org's Vercel project names by project id, for `vercel_traces::restate`.
struct VercelProjectNameResolver {
    store: Arc<dyn KeyStore>,
    cache: Cache<String, Arc<HashMap<String, String>>>,
}

/// Short enough that a project the API's hourly poller discovers is named soon after.
const VERCEL_PROJECT_NAMES_TTL: Duration = Duration::from_mins(5);

struct ClickHouseTargetResolver {
    store: Arc<dyn KeyStore>,
    keyring: Option<SecretKeyring>,
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
    fn new(store: Arc<dyn KeyStore>, keyring: Option<SecretKeyring>, capacity: u64) -> Self {
        Self {
            store,
            keyring,
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

    /// `(project_id, name)` of the org's Vercel projects.
    async fn fetch_vercel_project_names(
        &self,
        _org_id: &str,
    ) -> Result<Vec<(String, String)>, String> {
        Ok(Vec::new())
    }

    /// The org's enabled ingest rules in `position` order, and its hash salt.
    async fn fetch_ingest_rules(&self, org_id: &str) -> Result<IngestRuleRows, String>;

    /// Adds per-rule counts into `org_ingest_rule_stats`, one statement for all `rows`.
    async fn record_ingest_rule_stats(&self, rows: &[IngestRuleStatRow]) -> Result<(), String>;

    async fn fetch_clickhouse_target(
        &self,
        org_id: &str,
    ) -> Result<Option<ClickHouseTargetRow>, String>;

    async fn fetch_org_routing(&self, org_id: &str) -> Result<Option<OrgRouting>, String>;

    /// The org that pays for `org_id` (`org_billing_links`); `None` bills as itself.
    async fn fetch_billing_org_id(&self, org_id: &str) -> Result<Option<String>, String>;

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

    /// The cookieless salt for `day`, stored as `candidate` unless another task stored one
    /// first. `None`: the store keeps no shared salts, so the process uses its own.
    async fn cookieless_salt(
        &self,
        _day: &str,
        _candidate: &str,
    ) -> Result<Option<String>, String> {
        Ok(None)
    }

    /// Deletes salts for days before `keep_from_day` and visit claims idle for a day.
    async fn prune_cookieless(&self, _keep_from_day: &str) -> Result<(), String> {
        Ok(())
    }

    /// Extends an open cookieless visit from a heartbeat. False: no shared visits here.
    async fn touch_cookieless_visit(
        &self,
        _org_id: &str,
        _visitor_id: &str,
        _idle_ms: i64,
    ) -> Result<bool, String> {
        Ok(false)
    }

    /// Whether a cookieless session start opens a new visit, extending the visit either way.
    /// `None`: the store keeps no shared visits, so the process keeps its own.
    async fn claim_cookieless_visit(
        &self,
        _org_id: &str,
        _visitor_id: &str,
        _idle_ms: i64,
    ) -> Result<Option<bool>, String> {
        Ok(None)
    }
}

#[derive(Clone, Debug)]
struct KeyRow {
    org_id: String,
    self_managed: bool,
    clickhouse_ready: bool,
}

/// The retention overrides read with a key or a connector: its org's
/// (`org_retention_policies`) and its source's own (`sources.retention_days`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct RetentionRow {
    org: RetentionOverrides,
    source: RetentionOverrides,
}

impl RetentionRow {
    /// What the source's rows are stamped with, per signal.
    fn stamps(&self) -> RetentionStamps {
        RetentionStamps::resolve(&self.org, &self.source)
    }
}

#[derive(Clone, Debug)]
struct OrgKeyRow {
    key: KeyRow,
    /// `sources.id` of the org's default source; `None` if it has none.
    default_source_id: Option<String>,
    /// The org's overrides and its default source's.
    retention: RetentionRow,
}

/// An integration ("pull") source, its pause window and its retention overrides.
#[derive(Clone, Debug, PartialEq, Eq)]
struct PullSourceRow {
    /// The `sources.id` uuid.
    id: String,
    pause: PauseWindow,
    retention: RetentionOverrides,
}

impl PullSourceRow {
    /// What a connector's rows are stamped with: its source's overrides, else the
    /// org's. A connector with no source keeps what the org keeps.
    fn retention(row: Option<&Self>, org: RetentionOverrides) -> RetentionRow {
        RetentionRow {
            org,
            source: row.map(|row| row.retention).unwrap_or_default(),
        }
    }

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
    /// The org's overrides and the token source's own.
    retention: RetentionRow,
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
    org_retention: RetentionOverrides,
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
    org_retention: RetentionOverrides,
}

#[derive(Clone, Debug)]
struct AwsConnectionRow {
    org_id: String,
    self_managed: bool,
    clickhouse_ready: bool,
    /// The connection's `sources` row, joined through `source_id`.
    source: Option<PullSourceRow>,
    org_retention: RetentionOverrides,
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
    /// Read with the key and cached with it, like the source.
    retention: RetentionRow,
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
            org_retention: self.retention.org,
            retention: self.retention.stamps(),
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
    retention: RetentionRow,
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
            retention: self.retention,
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
    retention: RetentionRow,
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
                org_retention: self.retention.org,
                retention: self.retention.stamps(),
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
    retention: RetentionRow,
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
                org_retention: self.retention.org,
                retention: self.retention.stamps(),
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

/// The Autumn feature profiles bill as, in GB of decoded OTLP profiles like the byte signals.
const PROFILES_FEATURE_ID: &str = "profiles";

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

/// The `browser_sessions` gate every browser-session route shares: events,
/// replay metadata and replay chunks. A denied org gets nothing from any of them,
/// so a refused session never leaves a stored transcript or recording behind.
async fn browser_sessions_rejection(state: &AppState, org_id: &str) -> Option<ApiError> {
    if org_id == SENTINEL_ORG_ID {
        return None;
    }
    entitlement_rejection(state, org_id, BROWSER_SESSIONS_FEATURE_ID).await
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
    /// Memory every request's body is decoded inside; see `decode_otlp_body`.
    decode_memory: DecodeMemory,
    key_rate_limiter: SourceRateLimiter,
    /// GCP pushes only, taken before `org_inflight_limiter`.
    gcp_inflight_limiter: OrgInFlightLimiter,
    sampling_resolver: SamplingPolicyResolver,
    attribute_mapping_resolver: AttributeMappingResolver,
    vercel_project_name_resolver: VercelProjectNameResolver,
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
    cookieless: CookielessVisitors,
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
    /// The org's retention overrides, for a source a request names on a resource.
    org_retention: RetentionOverrides,
    /// What rows of this key's own source are stamped with, per signal.
    retention: RetentionStamps,
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
    retention: RetentionRow,
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
    /// The org's ingest rules need more scanning than one entry may use; redelivery would too.
    RulesScanBudget,
    /// An audit log entry, stored in the audit trail instead of the logs.
    AuditEvent,
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

    fn otlp_signal(self) -> OtlpSignal {
        match self {
            Self::Traces => OtlpSignal::Traces,
            Self::Logs => OtlpSignal::Logs,
            Self::Metrics => OtlpSignal::Metrics,
        }
    }
}

/// What a request body holds: an OTLP export, or a sender's own format that is
/// mapped onto OTLP.
#[derive(Clone, Copy)]
enum Ingress {
    Otlp(Signal),
    VercelLogDrain,
    VercelAiGatewayDrain,
    VercelEventDrain(EventDrain),
    /// Prometheus remote write 1.0, mapped to OTLP metrics.
    PrometheusRemoteWrite,
}

impl Ingress {
    fn signal(self) -> Signal {
        match self {
            Self::Otlp(signal) => signal,
            Self::PrometheusRemoteWrite => Signal::Metrics,
            Self::VercelLogDrain | Self::VercelEventDrain(_) => Signal::Logs,
            Self::VercelAiGatewayDrain => Signal::Traces,
        }
    }

    fn route(self) -> String {
        match self {
            Self::Otlp(signal) => format!("/v1/{}", signal.path()),
            Self::VercelLogDrain => "/v1/logpush/vercel".to_owned(),
            Self::VercelAiGatewayDrain => "/v1/vercel/ai-gateway".to_owned(),
            Self::VercelEventDrain(drain) => drain.route().to_owned(),
            Self::PrometheusRemoteWrite => prometheus_remote_write::ROUTE.to_owned(),
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

    /// The retention policy the payload's rows are kept under.
    const fn retention_signal(&self) -> RetentionSignal {
        match self {
            Self::Traces(_) => RetentionSignal::Traces,
            Self::Logs(_) => RetentionSignal::Logs,
            Self::Metrics(_) => RetentionSignal::Metrics,
        }
    }

    /// Orders the resources by the period their rows are stored for, each period's
    /// in the order they came, so one period's rows are planned as one run.
    fn group_by_stamp(&mut self, stamps: SourceStamps<'_>) {
        match self {
            Self::Traces(request) => request
                .resource_spans
                .sort_by_key(|resource| stamps.of(resource.resource.as_ref())),
            Self::Logs(request) => request
                .resource_logs
                .sort_by_key(|resource| stamps.of(resource.resource.as_ref())),
            Self::Metrics(request) => request
                .resource_metrics
                .sort_by_key(|resource| stamps.of(resource.resource.as_ref())),
        }
    }

    fn item_count(&self) -> usize {
        match self {
            Self::Traces(request) => count_trace_items(request),
            Self::Logs(request) => count_log_items(request),
            Self::Metrics(request) => count_metric_items(request),
        }
    }

    /// The rows this payload would be stored as, unsampled: what a collector it is
    /// forwarded to writes.
    fn rows(&self, org_id: &str) -> RowEstimate {
        match self {
            Self::Traces(request) => {
                row_budget::trace_rows(org_id, request, &SamplingPolicy::default(), &[])
            }
            Self::Logs(request) => row_budget::log_rows(request),
            Self::Metrics(request) => row_budget::metric_rows(request),
        }
    }

    /// The body this payload is forwarded as, costed so it is reserved before it is built.
    fn forward_body(
        &self,
        payload_format: PayloadFormat,
        gzip: bool,
    ) -> Result<ForwardBody, ApiError> {
        let json = matches!(payload_format, PayloadFormat::Json);
        match self {
            Self::Traces(request) => ForwardBody::of(request, json, gzip),
            Self::Logs(request) => ForwardBody::of(request, json, gzip),
            Self::Metrics(request) => ForwardBody::of(request, json, gzip),
        }
        .map_err(|_| self.serialize_failed())
    }

    fn encode(&self, body: &ForwardBody) -> Result<Vec<u8>, ApiError> {
        match self {
            Self::Traces(request) => body.build(request),
            Self::Logs(request) => body.build(request),
            Self::Metrics(request) => body.build(request),
        }
        .map_err(|_| self.serialize_failed())
    }

    fn serialize_failed(&self) -> ApiError {
        ApiError::service_unavailable(format!(
            "Failed to serialize {} payload",
            self.signal().path()
        ))
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

/// A request whose rows come to far more than it is metered on, because each
/// repeats a long resource, scope or metric string.
static INGEST_ROW_EXPANSION: FailureKind = FailureKind {
    tag: "@maple/ingest/RowExpansion",
    code: "ingest_row_expansion",
    title: "Batch repeats its shared attributes too many times",
    recovery: "fix_request",
    retryable: false,
    error_kind: "row_expansion",
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

/// The org's own rules need more scanning than one payload may use. Not the sender's fault and
/// its data is lost, so the span is `Error`; smaller batches fit.
static INGEST_RULES_SCAN_BUDGET: FailureKind = FailureKind {
    tag: "@maple/ingest/IngestRulesScanBudget",
    code: "ingest_rules_scan_budget",
    title: "Ingest rules scan budget exceeded",
    recovery: "fix_request",
    retryable: false,
    error_kind: "rules_scan_budget",
    retry_after_seconds: None,
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

/// A batch whose rows are more than the org's queue (or its WAL lane or channel)
/// could ever hold at once, refused before any of it is written.
static INGEST_ROWS_EXCEED_QUEUE: FailureKind = FailureKind {
    tag: "@maple/ingest/RowsExceedQueue",
    code: "ingest_rows_exceed_queue",
    title: "Batch is larger than the ingest queue can hold",
    recovery: "fix_request",
    retryable: false,
    error_kind: "rows_exceed_queue",
    retry_after_seconds: None,
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
        PipelineError::TooLarge(detail) => ApiError::tagged(
            StatusCode::PAYLOAD_TOO_LARGE,
            &INGEST_ROWS_EXCEED_QUEUE,
            "This batch's stored rows are larger than the ingest queue can hold at once. No data was written; send it in smaller batches.",
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
/// resolveDeploymentEnvironment(stage); DEPLOYMENT_ENV is a manual override of last resort.
fn resolve_deployment_env() -> String {
    std::env::var("MAPLE_ENVIRONMENT")
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
    host_attributes: &[opentelemetry::KeyValue],
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
        host_attributes: host_attributes.to_vec(),
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
    host_attributes: &[opentelemetry::KeyValue],
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
        host_attributes: host_attributes.to_vec(),
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
    host_attributes: &[opentelemetry::KeyValue],
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
        host_attributes: host_attributes.to_vec(),
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
    let host_attributes = host_identity::detect(&config.tinybird.queue_dir).await;
    let telemetry_providers = init_tracing(
        &config.forward_endpoint,
        config.port,
        &service_instance_id,
        &config.internal_org_id,
        &host_attributes,
        config.self_trace_sample_ratio,
    );
    let meter_provider = init_metrics(
        &config.forward_endpoint,
        config.port,
        &service_instance_id,
        &config.internal_org_id,
        &host_attributes,
    );
    let usage_metrics = init_usage_metrics(
        &config.forward_endpoint,
        config.port,
        &service_instance_id,
        &config.internal_org_id,
        &host_attributes,
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
                config.clickhouse_secret_keyring.clone(),
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

    // Every Autumn call bills the org's billing parent when it has one.
    let billing_orgs = BillingOrgResolver::new(
        Arc::new(KeyStoreBillingLookup(Arc::clone(&store))),
        BILLING_ORG_CACHE_TTL,
    );

    let autumn_tracker = config.autumn_secret_key.as_ref().map(|key| {
        AutumnTracker::spawn(
            key.clone(),
            &config.autumn_api_url,
            config.autumn_flush_interval_secs,
            billing_orgs.clone(),
        )
    });

    let shutdown_tracker = autumn_tracker.clone();

    // A configured Autumn account is the billing authority. Native balance
    // checks and customer controls must not be bypassable by a second flag.
    let autumn_entitlements = config.autumn_secret_key.as_ref().map(|key| {
        AutumnEntitlements::new(
            http_client.clone(),
            key.clone(),
            &config.autumn_api_url,
            config.autumn_allow_ttl_secs,
            config.autumn_deny_ttl_secs,
            billing_orgs.clone(),
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
        decode_memory: DecodeMemory::new(config.decode_memory_bytes),
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
        vercel_project_name_resolver: VercelProjectNameResolver {
            store: Arc::clone(&store),
            cache: Cache::builder()
                .time_to_live(VERCEL_PROJECT_NAMES_TTL)
                .max_capacity(10_000)
                .build(),
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
        cookieless: CookielessVisitors::new(Arc::clone(&store)),
    });
    state.cookieless.spawn_pruner();

    let cors = cors_layer();

    let grpc_state = Arc::clone(&state);
    let request_timeout = config.request_timeout;
    let app = ingest_routes()
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

    let grpc_server = config
        .otlp_grpc_port
        .map(|grpc_port| tokio::spawn(run_grpc_server(grpc_state, grpc_port)));

    let serve_result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await;
    // Its exports must land in the WAL before the drain below reads it. It stops only
    // on the shutdown signal, which a failed `axum::serve` never saw, so abort it then.
    if let Some(grpc_server) = grpc_server {
        if serve_result.is_err() {
            grpc_server.abort();
        } else {
            drop(grpc_server.await);
        }
    }

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
        // difference between "replays if this task's storage survives" (the
        // instance store under `/mnt/wal` is wiped when the host is stopped or
        // replaced) and "replays".
        let shipped = pipeline.flush_wal_to_object_store().await;
        if shipped > 0 {
            info!(
                shipped_bytes = shipped,
                "Shipped the undrained WAL tail to the object store"
            );
        }
    }

    // Before telemetry shuts down, so a "dropped at shutdown" line still ships.
    if let Some(tracker) = &shutdown_tracker {
        tracker.shutdown(AUTUMN_SHUTDOWN_DEADLINE).await;
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

/// The three OTLP services behind `grpc_admission`, which decodes every export
/// itself and hands tonic one empty message, so tonic never parses client bytes.
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

/// Admits an OTLP/gRPC export on its headers alone, so a refused one is never read,
/// then decodes it under the HTTP path's limits (`decode_grpc_export`). The export
/// reaches the service through the request extensions; tonic gets an empty message.
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
    let request_timeout = state.config.request_timeout;
    let path = request.uri().path().to_owned();
    let admitted = async move {
        let admitted = admit_grpc_export(&state, request.headers(), signal).await;
        match admitted {
            Ok((resolved, admission)) => {
                // Held until tonic has answered: the org's in-flight slot, taken before
                // the body is read as on the HTTP path, and the export's decode memory.
                let mut in_flight = None;
                // Paused, or the public placeholder token whose upload is never
                // kept: nothing is read or decoded and the client still gets an OK reply.
                if admission != KeyAdmission::Drop && resolved.org_id != SENTINEL_ORG_ID {
                    let Some(org_permit) = state.org_inflight_limiter.try_acquire(&resolved.org_id)
                    else {
                        return tonic::Status::resource_exhausted("Per-org ingest limit exceeded")
                            .into_http();
                    };
                    match decode_grpc_export(&state, &mut request, signal).await {
                        Ok((export, memory)) => {
                            request.extensions_mut().insert(GrpcExportSlot::new(export));
                            in_flight = Some((org_permit, memory));
                        }
                        Err(status) => return status.into_http(),
                    }
                }
                *request.body_mut() = axum::body::Body::from(EMPTY_GRPC_MESSAGE);
                request.headers_mut().remove("grpc-encoding");
                request
                    .headers_mut()
                    .remove(axum::http::header::CONTENT_LENGTH);
                request.extensions_mut().insert(resolved);
                request.extensions_mut().insert(admission);
                let response = next.run(request).await;
                drop(in_flight);
                response
            }
            Err(status) => status.into_http(),
        }
    };
    // The HTTP path's deadline, enforced here so the span records it. `Unavailable`
    // is that path's retryable 503. Zero disables it there too.
    let response = if request_timeout.is_zero() {
        admitted.instrument(span).await
    } else if let Ok(response) = tokio::time::timeout(request_timeout, admitted)
        .instrument(span)
        .await
    {
        response
    } else {
        metrics::request_timed_out(&path);
        warn!(
            path,
            timeout_secs = request_timeout.as_secs(),
            "Abandoning gRPC export that exceeded the gateway timeout"
        );
        tonic::Status::unavailable("Ingest gateway timed out while accepting this request")
            .into_http()
    };
    record_grpc_outcome(&span_handle, &response);
    response
}

/// An export `grpc_admission` decoded, with its size as received and the decode
/// memory it holds.
struct GrpcExport {
    decoded: DecodedPayload,
    received: Received,
}

/// Carries a `GrpcExport` through the request extensions, which must be `Clone`,
/// to the one service call that takes it.
#[derive(Clone)]
struct GrpcExportSlot(Arc<std::sync::Mutex<Option<GrpcExport>>>);

impl GrpcExportSlot {
    fn new(export: GrpcExport) -> Self {
        Self(Arc::new(std::sync::Mutex::new(Some(export))))
    }

    fn take(&self) -> Option<GrpcExport> {
        self.0.lock().ok()?.take()
    }
}

/// Reads an export's one gRPC message and decodes it as the HTTP path does
/// (`decode_otlp_body`), returning the decode memory it holds.
async fn decode_grpc_export(
    state: &AppState,
    request: &mut Request,
    signal: Signal,
) -> Result<(GrpcExport, DecodeReservation), tonic::Status> {
    limit_grpc_body(request, state.config.max_request_body_bytes)?;
    let frame = axum::body::to_bytes(std::mem::take(request.body_mut()), usize::MAX)
        .await
        .map_err(|error| tonic::Status::from_error(error.into_inner()))?;
    let truncated = || tonic::Status::internal("Unexpected end of the gRPC message");
    let Some(&[compressed, a, b, c, d]) = frame.first_chunk::<5>() else {
        return Err(truncated());
    };
    let message = frame.slice(5..);
    if usize::try_from(u32::from_be_bytes([a, b, c, d])).ok() != Some(message.len()) {
        return Err(truncated());
    }
    let gzip = match compressed {
        0 => false,
        1 => {
            match request
                .headers()
                .get("grpc-encoding")
                .and_then(|value| value.to_str().ok())
            {
                Some("gzip") => {}
                // A compressed message must name its encoding (gRPC spec: INTERNAL).
                None | Some("identity") => {
                    return Err(tonic::Status::internal(
                        "Compressed message without a grpc-encoding",
                    ))
                }
                Some(other) => {
                    let mut status = tonic::Status::unimplemented(format!(
                        "Message compression `{other}` is not supported; use gzip"
                    ));
                    status.metadata_mut().insert(
                        "grpc-accept-encoding",
                        tonic::metadata::MetadataValue::from_static("gzip"),
                    );
                    return Err(status);
                }
            }
            true
        }
        _ => return Err(tonic::Status::internal("Invalid gRPC compression flag")),
    };
    let DecodedBody {
        payload,
        decoded_bytes,
        memory,
        prometheus: _,
    } = decode_otlp_body(
        state,
        message,
        if gzip {
            BodyEncoding::Gzip
        } else {
            BodyEncoding::Identity
        },
        Ingress::Otlp(signal),
        PayloadFormat::Protobuf,
    )
        .await
        .map_err(|DecodeRefusal { error, .. }| match error.status {
            StatusCode::PAYLOAD_TOO_LARGE => tonic::Status::resource_exhausted(error.message),
            status if status.is_server_error() => tonic::Status::unavailable(error.message),
            _ => tonic::Status::invalid_argument(error.message),
        })?;
    Ok((
        GrpcExport {
            decoded: payload,
            received: Received {
                bytes: decoded_bytes,
                decode_heap: memory.held_bytes(),
            },
        },
        memory,
    ))
}

/// The HTTP path's raw body cap, and one message per export (`SingleGrpcFrame`).
/// Both refusals are client errors OTLP exporters do not retry; tonic finds the
/// `Status` in the body error.
fn limit_grpc_body(request: &mut Request, max_bytes: usize) -> Result<(), tonic::Status> {
    use http_body_util::BodyExt as _;

    let too_large = move || {
        tonic::Status::resource_exhausted(format!("Request body exceeds {max_bytes} bytes"))
    };
    let declared = request
        .headers()
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());
    if declared.is_some_and(|len| len > max_bytes) {
        return Err(too_large());
    }
    let body = std::mem::take(request.body_mut());
    let mut frame = SingleGrpcFrame::default();
    let limited = http_body_util::Limited::new(body, max_bytes).map_err(move |error| {
        if error.is::<http_body_util::LengthLimitError>() {
            axum::BoxError::from(too_large())
        } else {
            error
        }
    });
    let guarded = futures_util::StreamExt::map(limited.into_data_stream(), move |chunk| {
        let chunk = chunk?;
        frame.check(&chunk)?;
        Ok::<_, axum::BoxError>(chunk)
    });
    *request.body_mut() = axum::body::Body::from_stream(guarded);
    Ok(())
}

/// Tracks the gRPC framing of a unary export body. tonic's unary path decodes every
/// frame, each up to the decoded limit, but an export is one message: a byte past
/// the first frame is refused before tonic reads it.
#[derive(Default)]
struct SingleGrpcFrame {
    header: [u8; 5],
    header_len: usize,
    body_left: usize,
    complete: bool,
}

impl SingleGrpcFrame {
    fn check(&mut self, mut chunk: &[u8]) -> Result<(), tonic::Status> {
        while !chunk.is_empty() {
            if self.complete {
                return Err(tonic::Status::invalid_argument(
                    "An OTLP export carries exactly one gRPC message",
                ));
            }
            if self.header_len < self.header.len() {
                let take = (self.header.len() - self.header_len).min(chunk.len());
                self.header[self.header_len..self.header_len + take]
                    .copy_from_slice(&chunk[..take]);
                self.header_len += take;
                chunk = &chunk[take..];
                if self.header_len == self.header.len() {
                    let [_, a, b, c, d] = self.header;
                    self.body_left =
                        usize::try_from(u32::from_be_bytes([a, b, c, d])).unwrap_or(usize::MAX);
                    self.complete = self.body_left == 0;
                }
            } else {
                let take = self.body_left.min(chunk.len());
                self.body_left -= take;
                chunk = &chunk[take..];
                self.complete = self.body_left == 0;
            }
        }
        Ok(())
    }
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
        request: tonic::Request<ExportTraceServiceRequest>,
    ) -> Result<
        tonic::Response<
            opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceResponse,
        >,
        tonic::Status,
    > {
        serve_grpc_export(&self.state, Signal::Traces, request, DecodedPayload::Traces).await?;
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
        request: tonic::Request<ExportLogsServiceRequest>,
    ) -> Result<
        tonic::Response<opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceResponse>,
        tonic::Status,
    > {
        serve_grpc_export(&self.state, Signal::Logs, request, DecodedPayload::Logs).await?;
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
        request: tonic::Request<ExportMetricsServiceRequest>,
    ) -> Result<
        tonic::Response<
            opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceResponse,
        >,
        tonic::Status,
    > {
        serve_grpc_export(&self.state, Signal::Metrics, request, DecodedPayload::Metrics).await?;
        Ok(tonic::Response::new(
            opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceResponse {
                partial_success: None,
            },
        ))
    }
}

/// Accepts an export `grpc_admission` admitted and, unless it was dropped there,
/// decoded. A dropped export reaches tonic as one empty message.
async fn serve_grpc_export<T>(
    state: &AppState,
    signal: Signal,
    mut request: tonic::Request<T>,
    empty: fn(T) -> DecodedPayload,
) -> Result<(), tonic::Status> {
    let (resolved, admission) = grpc_admitted_key(&mut request)?;
    let export = request
        .extensions_mut()
        .remove::<GrpcExportSlot>()
        .and_then(|slot| slot.take());
    let (mut decoded, received) = match export {
        Some(export) => (export.decoded, export.received),
        None => (empty(request.into_inner()), Received::unbudgeted(0)),
    };
    let (admission, claims) = admit_grpc_claims(state, admission, &mut decoded, &resolved).await;
    accept_grpc_decoded(
        state, signal, decoded, &resolved, admission, received, &claims,
    )
    .await
}

/// Verifies a gRPC export's source claims; a batch of only paused pull sources
/// becomes a `Drop`, so the client still gets an OK reply.
async fn admit_grpc_claims(
    state: &AppState,
    admission: KeyAdmission,
    decoded: &mut DecodedPayload,
    resolved: &ResolvedIngestKey,
) -> (KeyAdmission, ClaimOutcome) {
    // A paused source's or the sentinel's export reaches here empty (see `grpc_admission`).
    if admission != KeyAdmission::Ingest || resolved.org_id == SENTINEL_ORG_ID {
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
/// `received` is the export's size as received; only the share the claims and
/// ingest rules leave is metered.
async fn accept_grpc_decoded(
    state: &AppState,
    signal: Signal,
    mut decoded: DecodedPayload,
    resolved: &ResolvedIngestKey,
    admission: KeyAdmission,
    received: Received,
    claims: &ClaimOutcome,
) -> Result<(), tonic::Status> {
    // The sentinel token is a PUBLIC constant, so anything it carries is never
    // stored. `grpc_admission` already swapped its upload for an empty message;
    // this answers it like `handle_signal_inner`'s HTTP short-circuit.
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

    // The org's in-flight slot is held by `grpc_admission`.
    let item_count = decoded.item_count();
    let mut retained = claims.retained;

    let result = process_decoded_payload(
        state,
        signal,
        PayloadFormat::Protobuf,
        None,
        &mut decoded,
        resolved,
        &claims.named_sources,
        &mut retained,
        received,
    )
    .await;

    match result {
        // A collector refusal that left nothing stored is neither key use nor billed.
        Ok(response)
            if !batch_was_stored(
                response.status().is_success(),
                state.config.write_mode,
                native_destination_for(resolved),
            ) =>
        {
            Ok(())
        }
        Ok(_) => {
            state.resolver.note_source_use(resolved, claims.kept_claim);
            state
                .resolver
                .note_claimed_source_use(&claims.claimed_sources);
            let decoded_bytes = retained.metered_bytes(received.bytes);
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
        // OTLP exporters retry neither `INTERNAL` nor `INVALID_ARGUMENT`; resending would be refused
        // again. A scan-budget refusal drops a healthy sender's data, so it must read as an error.
        Err(error) if error.error_kind() == INGEST_RULES_SCAN_BUDGET.error_kind => {
            Err(tonic::Status::internal(error.message))
        }
        Err(error) => match error.status {
            StatusCode::TOO_MANY_REQUESTS => Err(tonic::Status::resource_exhausted(error.message)),
            StatusCode::PAYLOAD_TOO_LARGE => Err(tonic::Status::invalid_argument(error.message)),
            _ => Err(tonic::Status::unavailable(error.message)),
        },
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
            org_retention: RetentionOverrides::default(),
            retention: RetentionStamps::default(),
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

/// Every HTTP route the gateway serves, before its layers and state.
fn ingest_routes() -> Router<Arc<AppState>> {
    with_profiles_routes(Router::new())
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/v1/traces", post(handle_traces))
        .route("/v1/logs", post(handle_logs))
        .route("/v1/metrics", post(handle_metrics))
        .route(
            prometheus_remote_write::ROUTE,
            post(handle_prometheus_write),
        )
        .route("/v1/sessionReplays/meta", post(handle_replay_meta))
        .route("/v1/sessionReplays/blob", post(handle_replay_blob))
        .route("/v1/sessionEvents", post(handle_session_events))
        .route("/v1/events", post(handle_product_events))
        .route(
            "/v1/logpush/cloudflare/http_requests/{connector_id}",
            post(handle_cloudflare_logpush_http_requests),
        )
        .route("/v1/logpush/gcp/{connector_id}", post(handle_gcp_logpush))
        .route("/v1/logpush/vercel", post(handle_vercel_logpush))
        .route("/v1/vercel/ai-gateway", post(handle_vercel_ai_gateway))
        .route("/v1/vercel/{drain}", post(handle_vercel_event_drain))
        .route(
            "/v1/firehose/aws/{connection_id}",
            post(handle_aws_firehose),
        )
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
    handle_signal(state, headers, body, Ingress::Otlp(Signal::Traces)).await
}

async fn handle_logs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    handle_signal(state, headers, body, Ingress::Otlp(Signal::Logs)).await
}

async fn handle_metrics(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    handle_signal(state, headers, body, Ingress::Otlp(Signal::Metrics)).await
}

/// Prometheus remote write, authenticated by the org's ingest key like OTLP,
/// which Prometheus sends as a bearer token or as the basic-auth password.
async fn handle_prometheus_write(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    handle_signal(state, headers, body, Ingress::PrometheusRemoteWrite).await
}

/// A Vercel log drain, authenticated by the org's ingest key like OTLP.
async fn handle_vercel_logpush(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    handle_signal(state, headers, body, Ingress::VercelLogDrain).await
}

/// A Vercel AI Gateway drain, authenticated by the org's ingest key like OTLP.
async fn handle_vercel_ai_gateway(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    handle_signal(state, headers, body, Ingress::VercelAiGatewayDrain).await
}

/// A Vercel Speed Insights, Web Analytics or Audit Log drain, authenticated by
/// the org's ingest key like OTLP.
async fn handle_vercel_event_drain(
    State(state): State<Arc<AppState>>,
    Path(drain): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(drain) = EventDrain::from_path(&drain) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if drain == EventDrain::AuditLog && state.config.stores_audit_trail() {
        return handle_vercel_audit_trail(state, headers, body).await;
    }
    handle_signal(state, headers, body, Ingress::VercelEventDrain(drain)).await
}

/// Vercel's Audit Log drain as rows of `audit_trail_events`.
async fn handle_vercel_audit_trail(
    state: Arc<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    metrics::request_started();
    let _guard = InFlightGuard;
    let span = tracing::info_span!(
        "ingest_vercel_audit_trail",
        otel.name = "POST /v1/vercel/audit-log",
        otel.kind = "server",
        otel.status_code = tracing::field::Empty,
        otel.status_description = tracing::field::Empty,
        "maple.ingest.reject_reason" = tracing::field::Empty,
        "http.request.method" = "POST",
        "http.route" = "/v1/vercel/audit-log",
        "http.request.body.size" = body.len(),
        "http.response.status_code" = tracing::field::Empty,
        "error.type" = tracing::field::Empty,
        "maple.signal" = "audit_trail",
        "maple.org_id" = tracing::field::Empty,
        "maple.audit_trail.events" = tracing::field::Empty,
        "maple.audit_trail.skipped" = tracing::field::Empty,
    );
    let span_handle = span.clone();
    let start = Instant::now();
    let result = handle_vercel_audit_trail_inner(&state, &headers, &body)
        .instrument(span)
        .await;
    let duration = start.elapsed().as_secs_f64();
    let signal = TelemetrySignal::AuditTrail.as_str();
    match result {
        Ok(count) => {
            span_handle.record("http.response.status_code", 200u16);
            span_handle.record("otel.status_code", "Ok");
            metrics::request_completed(signal, "ok", "none", duration);
            (StatusCode::OK, axum::Json(AcceptedBody { accepted: count })).into_response()
        }
        Err(error) => {
            let status = error.status.as_u16();
            span_handle.record("http.response.status_code", status);
            span_handle.record("error.type", error.error_kind());
            // A drain Vercel keeps retrying has to move an error rate, like any other ingest route.
            metrics::request_completed(signal, "error", error.error_kind(), duration);
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

/// Audit deliveries one org may make each second, across the fleet. Well above
/// what the people of a team or a cloud organization do; past it the sender is
/// told to retry, so a burst is delayed and not lost.
const AUDIT_TRAIL_VERCEL_ORG_RPS: u32 = 10;
const AUDIT_TRAIL_GCP_ORG_RPS: u32 = 100;

/// The most a Vercel audit delivery may be once inflated. A batch of audit
/// events is kilobytes; the telemetry ceiling is for bodies that are metered.
const AUDIT_TRAIL_MAX_DECODED_BYTES: usize = 4 * 1024 * 1024;

/// The most events one Vercel audit delivery may carry. Every event becomes a
/// row of fixed columns however short it is, so the byte ceiling alone does not
/// bound what a delivery stores or holds in memory.
const AUDIT_TRAIL_MAX_EVENTS: usize = 10_000;

/// Refuses an org's audit delivery past `rps`. The rows are not metered, so
/// this is what bounds how many a sender can store.
async fn audit_trail_rate_gate(
    state: &AppState,
    org_id: &str,
    provider: &'static str,
    rps: u32,
) -> Result<(), ApiError> {
    let key = format!("audit_trail:{provider}:{org_id}");
    if state.key_rate_limiter.try_acquire(&key, rps).await {
        return Ok(());
    }
    metrics::org_throttled(org_id, "audit_trail_rate");
    warn!(org_id, provider, "Audit event rate limit exceeded");
    Err(ApiError::too_many_requests(
        "Audit event rate limit exceeded",
    ))
}

async fn handle_vercel_audit_trail_inner(
    state: &AppState,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<usize, ApiError> {
    let Some(resolved_key) = resolve_replay_key(state, headers, &[SourceSignal::Logs]).await?
    else {
        return Ok(0);
    };
    let org_id = resolved_key.org_id.clone();
    Span::current().record("maple.org_id", org_id.as_str());

    // The drain Maple creates sends the org's private key and names the Vercel
    // connection's source. Anything else posting here could write the org an
    // audit event of its own invention: a source token, the public key (it
    // ships in browser bundles), or a private key naming no integration source.
    let unknown_sender = || {
        ApiError::unauthorized(
            "Audit events are accepted only from the drain Maple creates on the Vercel team",
        )
    };
    if !matches!(resolved_key.key_type, IngestKeyType::Private)
        || !resolved_key.accepts_source_claims()
    {
        return Err(unknown_sender());
    }
    let claim = headers
        .get(SOURCE_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|claim| !claim.is_empty() && claim.len() <= MAX_PUBLIC_ID_LEN)
        .ok_or_else(unknown_sender)?;
    let verified = state
        .resolver
        .verify_source_claims(&org_id, vec![claim.to_owned()])
        .await;
    // Paused, the delivery is acked and dropped like the source's logs are.
    if verified.paused.iter().any(|paused| paused == claim) {
        metrics::source_paused_drop(&org_id, TelemetrySignal::AuditTrail.as_str());
        Span::current().record("maple.ingest.reject_reason", "source_paused");
        return Ok(0);
    }
    if !verified.active.iter().any(|active| active == claim) {
        // The store being down says nothing about the sender: Vercel retries a 503.
        if verified.unresolved {
            return Err(ApiError::service_unavailable(
                "Ingest authentication unavailable",
            ));
        }
        return Err(unknown_sender());
    }

    audit_trail_rate_gate(state, &org_id, "vercel", AUDIT_TRAIL_VERCEL_ORG_RPS).await?;
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
        ExportDestination::Tinybird,
        "Audit event storage is not configured",
    )?;

    let gzip = match headers
        .get(CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_ascii_lowercase())
        .as_deref()
    {
        None | Some("" | "identity") => false,
        Some("gzip") => true,
        Some(_) => {
            return Err(ApiError::unsupported_media_type(
                "Unsupported content-encoding",
            ))
        }
    };
    let (rows, skipped) =
        decode_vercel_audit_drain(state, body.clone(), gzip, org_id.clone()).await?;
    Span::current().record("maple.audit_trail.events", rows.len());
    Span::current().record("maple.audit_trail.skipped", skipped);
    if skipped > 0 {
        warn!(org_id = %org_id, skipped, "Vercel audit drain events without an action were skipped");
    }
    let count = store_audit_trail_rows(pipeline, &org_id, rows).await?;
    // The delivery is the integration's, not the key's default source: its health reads this.
    let claimed: Vec<String> = sources::source_uuid_from_public_id(claim)
        .into_iter()
        .collect();
    state.resolver.note_claimed_source_use(&claimed);
    Ok(count)
}

/// A Vercel audit delivery as rows, and how many of its events were skipped.
/// Inflated and parsed on the blocking pool inside the process-wide decode
/// memory budget, like an OTLP body: a small gzip can inflate into a body that
/// parses into gigabytes.
async fn decode_vercel_audit_drain(
    state: &AppState,
    body: Bytes,
    gzip: bool,
    org_id: String,
) -> Result<(Vec<Vec<u8>>, usize), ApiError> {
    let mut reservation = state.decode_memory.reservation();
    let heap_budget = state.config.max_decode_heap_bytes;
    let max_decoded = state
        .config
        .max_decoded_body_bytes
        .min(AUDIT_TRAIL_MAX_DECODED_BYTES);
    tokio::task::spawn_blocking(move || {
        let busy = || {
            ApiError::tagged(
                StatusCode::SERVICE_UNAVAILABLE,
                &INGEST_DECODE_BUSY,
                "Ingest gateway is busy decoding other requests; retry shortly",
            )
        };
        let too_large = || ApiError::payload_too_large("Audit delivery too large");
        if body.len() > max_decoded {
            return Err(too_large());
        }
        if !reservation.try_add(body.len() as u64) {
            return Err(busy());
        }
        let payload = if gzip {
            let invalid = || ApiError::bad_request("Invalid gzip body");
            let declared = decode_budget::gzip_declared_len(&body).ok_or_else(invalid)?;
            let declared = usize::try_from(declared).unwrap_or(usize::MAX);
            if declared > max_decoded {
                return Err(too_large());
            }
            if !reservation.try_add(declared as u64) {
                return Err(busy());
            }
            let inflated = gunzip_declared(&body, declared).map_err(|error| match error {
                GunzipError::Invalid(_) => invalid(),
                GunzipError::TooLarge => too_large(),
            })?;
            drop(body);
            Bytes::from(inflated)
        } else {
            body
        };
        let estimate = decode_budget::json_cost(&payload, heap_budget)
            .map_err(|decode_budget::OverBudget| over_decode_budget(heap_budget))?;
        if !reservation.try_add(estimate) {
            return Err(busy());
        }
        let parsed = vercel_logs::parse(&payload).map_err(|e| {
            ApiError::bad_request(format!("Invalid Vercel Audit Log drain payload: {e}"))
        })?;
        if parsed.entries.len() > AUDIT_TRAIL_MAX_EVENTS {
            return Err(too_large());
        }
        let now_ms = audit_trail::now_ms();
        let rows: Vec<Vec<u8>> = parsed
            .entries
            .iter()
            .filter_map(|event| audit_trail::vercel_event(event, now_ms))
            .map(|event| event.to_row(&org_id, now_ms))
            .collect();
        let skipped = parsed.entries.len() - rows.len() + parsed.malformed_lines;
        Ok((rows, skipped))
    })
    .await
    .unwrap_or_else(|join_error| {
        error!(error = %join_error, "Audit delivery decode task failed");
        Err(ApiError::service_unavailable(
            "Ingest gateway failed to decode the request",
        ))
    })
}

/// Audit rows to the managed warehouse: the table is pinned there, whatever
/// warehouse the org reads its telemetry from. Not metered: an audit event is
/// evidence, not usage.
async fn store_audit_trail_rows(
    pipeline: &TelemetryPipeline,
    org_id: &str,
    rows: Vec<Vec<u8>>,
) -> Result<usize, ApiError> {
    if rows.is_empty() {
        return Ok(0);
    }
    let count = rows.len();
    pipeline
        .accept_rows_to(
            org_id,
            audit_trail::DATASOURCE.to_owned(),
            rows,
            TelemetrySignal::AuditTrail,
            ExportDestination::Tinybird,
            // Not a table a retention policy reaches: its rows carry no stamp.
            None,
        )
        .await
        .map_err(|e| {
            warn!(org_id = %org_id, error = %e, "audit trail enqueue rejected");
            api_error_from_pipeline(&e)
        })?;
    Ok(count)
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

/// Browsers call ingest cross-origin: every header a browser SDK or a page's own
/// instrumentation sends must be allowed here, or the preflight fails the request.
fn cors_layer() -> CorsLayer {
    CorsLayer::new()
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
            // W3C trace context and baggage: a page whose fetch instrumentation propagates to every
            // URL sends these to ingest too, and a preflight without them fails the upload.
            HeaderName::from_static("traceparent"),
            HeaderName::from_static("tracestate"),
            HeaderName::from_static("baggage"),
        ])
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

/// Cookieless visitor ids (`maple_ingest::cookieless`): the day's salt, shared through the
/// key store, and the visit claims that bill one browser session per cookieless visit.
struct CookielessVisitors {
    store: Arc<dyn KeyStore>,
    /// Behind an async lock so a new day's salt is read once per task, not once per request.
    salt: tokio::sync::Mutex<CookielessSaltCache>,
    local_visits: std::sync::Mutex<cookieless::LocalVisits>,
    touch_throttle: std::sync::Mutex<cookieless::TouchThrottle>,
}

#[derive(Default)]
struct CookielessSaltCache {
    day: String,
    salt: Option<Arc<[u8]>>,
    /// After a failed read, no retry before this, so an outage costs one query per window.
    retry_at_ms: i64,
}

const COOKIELESS_SALT_RETRY_MS: i64 = 30_000;
/// A slow Postgres sends rows unidentified and unbilled rather than stalling the request.
const COOKIELESS_STORE_TIMEOUT: Duration = Duration::from_millis(500);
/// How often each task deletes stale salts and visit claims, so deletion never waits on traffic.
const COOKIELESS_PRUNE_INTERVAL: Duration = Duration::from_hours(1);
const DAY_MS: i64 = 86_400_000;

/// What a row's `visitor_id` turned out to be.
#[derive(Debug, PartialEq, Eq)]
enum CookielessRow {
    NotCookieless,
    /// Cookieless, but no trusted client IP or no salt: sent with no visitor id.
    Unidentified,
    Visitor(String),
}

impl CookielessVisitors {
    fn new(store: Arc<dyn KeyStore>) -> Self {
        Self {
            store,
            salt: tokio::sync::Mutex::new(CookielessSaltCache::default()),
            local_visits: std::sync::Mutex::new(cookieless::LocalVisits::default()),
            touch_throttle: std::sync::Mutex::new(cookieless::TouchThrottle::default()),
        }
    }

    async fn salt(&self, now_ms: i64) -> Option<Arc<[u8]>> {
        let day = cookieless::utc_day(now_ms);
        let mut cache = self.salt.lock().await;
        if cache.day == day && (cache.salt.is_some() || now_ms < cache.retry_at_ms) {
            return cache.salt.clone();
        }
        // Recorded before awaiting, so a request cancelled mid-fetch still leaves the backoff.
        *cache = CookielessSaltCache {
            day: day.clone(),
            salt: None,
            retry_at_ms: now_ms + COOKIELESS_SALT_RETRY_MS,
        };
        let mut candidate = [0u8; 32];
        let minted =
            ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut candidate);
        let stored = match minted {
            Ok(()) => tokio::time::timeout(
                COOKIELESS_STORE_TIMEOUT,
                self.store
                    .cookieless_salt(&day, &STANDARD.encode(candidate)),
            )
            .await
            .unwrap_or_else(|_| Err("cookieless salt read timed out".to_owned())),
            Err(_) => Err("no system randomness for a cookieless salt".to_owned()),
        };
        let salt = match stored {
            Ok(Some(encoded)) => STANDARD
                .decode(encoded)
                .map_err(|error| format!("stored cookieless salt is not base64: {error}")),
            Ok(None) => Ok(candidate.to_vec()),
            Err(error) => Err(error),
        };
        match salt {
            Ok(bytes) => {
                let salt: Arc<[u8]> = bytes.into();
                *cache = CookielessSaltCache {
                    day,
                    salt: Some(Arc::clone(&salt)),
                    retry_at_ms: 0,
                };
                Some(salt)
            }
            Err(error) => {
                warn!(error = %error, "cookieless salt unavailable");
                metrics::cookieless_failed("salt");
                None
            }
        }
    }

    /// Deletes salts older than yesterday and day-old visit claims, every hour for the process.
    fn spawn_pruner(&self) {
        let store = Arc::clone(&self.store);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(COOKIELESS_PRUNE_INTERVAL);
            loop {
                interval.tick().await;
                let keep_from_day = cookieless::utc_day(current_time_millis() - DAY_MS);
                if let Err(error) = store.prune_cookieless(&keep_from_day).await {
                    warn!(error = %error, "cookieless prune failed");
                }
            }
        });
    }

    /// The visitor id for a request's cookieless rows. Needs the client IP from the trusted
    /// proxy (the same trust `derive_country` needs), or from a first-party proxy's
    /// forwarding headers (`cookieless::CLIENT_IP_HEADERS`); the IP is hashed, never kept.
    async fn visitor_id(
        &self,
        headers: &HeaderMap,
        trust_proxy: bool,
        org_id: &str,
    ) -> Option<String> {
        if !trust_proxy {
            return None;
        }
        let ip = cookieless::client_ip(|name| replay_header(headers, name))?;
        let user_agent = headers
            .get("user-agent")
            .map(|value| String::from_utf8_lossy(value.as_bytes()).trim().to_owned())
            .unwrap_or_default();
        let salt = self.salt(current_time_millis()).await?;
        Some(cookieless::visitor_id(&salt, org_id, &ip, &user_agent))
    }

    /// Extends the visitor's open visit from a heartbeat, at most once per interval per task.
    /// Heartbeats stop 30 idle minutes after the last input, which bounds how far this
    /// stretches a visit, and only ever toward billing less.
    async fn touch_visit(&self, org_id: &str, visitor_id: &str) {
        let now_ms = current_time_millis();
        let due = self
            .touch_throttle
            .lock()
            .is_ok_and(|mut throttle| throttle.due(org_id, visitor_id, now_ms));
        if !due {
            return;
        }
        let touched = tokio::time::timeout(
            COOKIELESS_STORE_TIMEOUT,
            self.store
                .touch_cookieless_visit(org_id, visitor_id, cookieless::VISIT_WINDOW_MS),
        )
        .await
        .unwrap_or_else(|_| Err("cookieless visit touch timed out".to_owned()));
        match touched {
            Ok(true) => {}
            Ok(false) => {
                if let Ok(mut visits) = self.local_visits.lock() {
                    visits.touch(org_id, visitor_id, now_ms);
                }
            }
            Err(error) => {
                warn!(error = %error, "cookieless visit touch failed");
                metrics::cookieless_failed("touch");
            }
        }
    }

    /// Whether a cookieless session start bills: only a visit's first does. A failed claim
    /// does not bill, so a customer never pays for the gateway's own outage.
    async fn claim_visit(&self, org_id: &str, visitor_id: &str) -> bool {
        let claim = tokio::time::timeout(
            COOKIELESS_STORE_TIMEOUT,
            self.store
                .claim_cookieless_visit(org_id, visitor_id, cookieless::VISIT_WINDOW_MS),
        )
        .await
        .unwrap_or_else(|_| Err("cookieless visit claim timed out".to_owned()));
        match claim {
            Ok(Some(new_visit)) => new_visit,
            Ok(None) => self
                .local_visits
                .lock()
                .is_ok_and(|mut visits| visits.claim(org_id, visitor_id, current_time_millis())),
            Err(error) => {
                warn!(error = %error, "cookieless visit claim failed; not billed");
                metrics::cookieless_failed("claim");
                false
            }
        }
    }
}

/// One request's cookieless rows: the visitor id is derived at most once and shared by every row.
struct CookielessRequest<'a> {
    visitors: &'a CookielessVisitors,
    headers: &'a HeaderMap,
    trust_proxy: bool,
    org_id: &'a str,
    resolved: bool,
    visitor: Option<String>,
}

impl<'a> CookielessRequest<'a> {
    fn new(state: &'a AppState, headers: &'a HeaderMap, org_id: &'a str) -> Self {
        Self {
            visitors: &state.cookieless,
            headers,
            trust_proxy: state.config.trust_proxy_geo,
            org_id,
            resolved: false,
            visitor: None,
        }
    }

    /// Swap a cookieless row's sentinel for the visitor id; other rows are left alone.
    async fn apply(
        &mut self,
        obj: &mut serde_json::Map<String, serde_json::Value>,
    ) -> CookielessRow {
        if !cookieless::is_cookieless(obj) {
            return CookielessRow::NotCookieless;
        }
        if !self.resolved {
            self.visitor = self
                .visitors
                .visitor_id(self.headers, self.trust_proxy, self.org_id)
                .await;
            self.resolved = true;
            Span::current().record(
                "maple.visitor.cookieless_identified",
                self.visitor.is_some(),
            );
        }
        cookieless::apply(obj, self.visitor.as_deref());
        self.visitor
            .clone()
            .map_or(CookielessRow::Unidentified, CookielessRow::Visitor)
    }
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

/// Sets a client-built row's `retention_days` to the period resolved for its source,
/// over whatever the sender put under that name: like `org_id`, it is the gateway's.
fn stamp_retention(row: &mut JsonMap<String, JsonValue>, retention_days: u16) {
    row.insert("retention_days".to_owned(), JsonValue::from(retention_days));
}

/// Sets a session event's `events_retention_days`, the period the `product_events` row a
/// view derives from it is kept for. The gateway's too: a sender's value is overwritten.
fn stamp_events_retention(row: &mut JsonMap<String, JsonValue>, events_retention_days: u16) {
    row.insert(
        "events_retention_days".to_owned(),
        JsonValue::from(events_retention_days),
    );
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
        "maple.visitor.cookieless_identified" = tracing::field::Empty,
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

    // Gated on every request, not only on a billable session start: a denied org
    // must not keep storing the continuation rows and chunks of its sessions.
    if let Some(error) = browser_sessions_rejection(state, &org_id).await {
        return Err(error);
    }

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
    // `BillableSessionStarts` for the rule and its per-request bound.
    let country = derive_country(headers, state.config.trust_proxy_geo);
    let retention_days = resolved_key.retention.get(RetentionSignal::Sessions);
    let mut rows: Vec<Vec<u8>> = Vec::new();
    let mut session_starts = BillableSessionStarts::default();
    let mut cookieless = CookielessRequest::new(state, headers, &org_id);
    let mut cookieless_start: Option<(String, String)> = None;
    // A heartbeat from an open page: it keeps the visitor's visit from going idle.
    let mut cookieless_active: Option<String> = None;
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
        // The mode marker is the gateway's to set, never the client's.
        cookieless::clear_metadata_mark(obj);
        let visitor = cookieless.apply(obj).await;
        if matches!(visitor, CookielessRow::Visitor(_)) {
            cookieless::mark_metadata_row(obj);
        }
        // Cookieless starts bill through one visit claim after the loop: every
        // row here shares the visitor, and the browser keeps no visit marker.
        let is_start = is_billable_session_start(obj);
        if session_starts.note(obj) && visitor != CookielessRow::NotCookieless {
            session_starts.retract(obj);
        }
        if let CookielessRow::Visitor(id) = visitor {
            if is_start {
                cookieless_start.get_or_insert((id, row_session_id(obj).to_owned()));
            } else {
                cookieless_active.get_or_insert(id);
            }
        }
        stamp_retention(obj, retention_days);
        rows.push(
            serde_json::to_vec(&value).map_err(|e| {
                ApiError::bad_request(format!("failed to re-serialize metadata: {e}"))
            })?,
        );
    }

    if rows.is_empty() {
        return Ok(0);
    }
    // Claimed once the whole body parsed. A later enqueue failure leaves the visit
    // claimed and unbilled: the gateway errs toward under-billing.
    // No claim when this request could not bill it (slots full, or the session id already
    // counted): a claimed visit it did not bill would go unbilled on the next request too.
    if let Some((visitor_id, session_id)) = cookieless_start {
        if session_starts.can_add(&session_id)
            && state.cookieless.claim_visit(&org_id, &visitor_id).await
        {
            session_starts.note_session(session_id);
        }
    } else if let Some(visitor_id) = cookieless_active {
        state.cookieless.touch_visit(&org_id, &visitor_id).await;
    }
    let count = rows.len();
    #[expect(
        clippy::cast_precision_loss,
        reason = "a request bills at most a handful of session starts"
    )]
    let billable_sessions = session_starts.count() as f64;
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
                    Some(retention_days),
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
        "maple.visitor.cookieless_identified" = tracing::field::Empty,
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
    // Every row of this table is kept as a session row, `custom` ones included; the
    // `product_events` row a `custom` one becomes keeps the events period.
    let retention_days = resolved_key.retention.get(RetentionSignal::Sessions);
    let events_retention_days = resolved_key.retention.get(RetentionSignal::Events);
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
    if let Some(error) = browser_sessions_rejection(state, &org_id).await {
        return Err(error);
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
    let mut cookieless = CookielessRequest::new(state, headers, &org_id);
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
        cookieless.apply(obj).await;
        if is_custom {
            custom_events += 1;
        }
        obj.insert(
            "org_id".to_owned(),
            serde_json::Value::String(org_id.clone()),
        );
        stamp_retention(obj, retention_days);
        stamp_events_retention(obj, events_retention_days);
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
                    Some(retention_days),
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
        "maple.visitor.cookieless_identified" = tracing::field::Empty,
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
    let retention_days = resolved_key.retention.get(RetentionSignal::Events);
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
    // Each line adds its index in nanoseconds, so two property writes in one
    // batch (`set` plan free, then pro) keep their order: the newest wins.
    let received_at = chrono::Utc::now();
    let mut rows: Vec<Vec<u8>> = Vec::new();
    let mut dropped: u64 = 0;
    let mut line_index: i64 = 0;
    for line in body.split(|&b| b == b'\n') {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let line_received_at = received_at + chrono::TimeDelta::nanoseconds(line_index);
        line_index += 1;
        let mut value: serde_json::Value = serde_json::from_slice(line)
            .map_err(|e| ApiError::bad_request(format!("invalid product event JSON: {e}")))?;
        let obj = value
            .as_object_mut()
            .ok_or_else(|| ApiError::bad_request("product event must be a JSON object"))?;
        if !sanitize_product_event(obj, line_received_at) {
            dropped += 1;
            continue;
        }
        // Server and mobile senders only: their IP is a backend's, never a visitor's.
        if cookieless::is_cookieless(obj) {
            cookieless::apply(obj, None);
        }
        // org_id comes from the authenticated key, never the body — the
        // sanitizer already discarded whatever the client sent under that name.
        obj.insert(
            "org_id".to_string(),
            serde_json::Value::String(org_id.clone()),
        );
        stamp_retention(obj, retention_days);
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
                    Some(retention_days),
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

/// The OTLP profiles export: under `/v1development/` while the signal is in
/// development, and under `/v1/` where the spec moves it at release candidate.
const PROFILES_ROUTES: [&str; 2] = ["/v1development/profiles", "/v1/profiles"];

fn with_profiles_routes(router: Router<Arc<AppState>>) -> Router<Arc<AppState>> {
    PROFILES_ROUTES.into_iter().fold(router, |router, path| {
        router.route(path, post(handle_profiles))
    })
}

async fn handle_profiles(
    State(state): State<Arc<AppState>>,
    matched_path: MatchedPath,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let start = Instant::now();
    metrics::request_started();
    let _guard = InFlightGuard;
    let route = matched_path.as_str();
    let otel_name = format!("POST {route}");
    let span = tracing::info_span!(
        "ingest_profiles",
        otel.name = %otel_name,
        otel.kind = "server",
        otel.status_code = tracing::field::Empty,
        otel.status_description = tracing::field::Empty,
        "maple.ingest.reject_reason" = tracing::field::Empty,
        "http.request.method" = "POST",
        "http.route" = %route,
        "http.request.body.size" = body.len(),
        "http.response.status_code" = tracing::field::Empty,
        "error.type" = tracing::field::Empty,
        "maple.signal" = "profiles",
        "maple.org_id" = tracing::field::Empty,
        "maple.ingest.clickhouse_ready" = tracing::field::Empty,
        "maple.ingest.destination" = tracing::field::Empty,
        "maple.ingest.payload_format" = tracing::field::Empty,
        "maple.ingest.content_encoding" = tracing::field::Empty,
        "maple.ingest.decoded_bytes" = tracing::field::Empty,
        "maple.ingest.item_count" = tracing::field::Empty,
        "maple.ingest.native_rows" = tracing::field::Empty,
        "maple.ingest.rules.count" = tracing::field::Empty,
        "maple.ingest.rules.redacted_values" = tracing::field::Empty,
        "maple.ingest.rules.parse_failed" = tracing::field::Empty,
        "maple.profiles.dropped" = tracing::field::Empty,
        "maple.sdk" = tracing::field::Empty,
        "user_agent.original" = tracing::field::Empty,
    );
    record_client_identity(&span, &headers);
    let span_handle = span.clone();
    let result = handle_profiles_inner(&state, &headers, body)
        .instrument(span)
        .await;
    let duration = start.elapsed().as_secs_f64();
    let signal = TelemetrySignal::Profiles.as_str();
    match result {
        Ok(accepted) => {
            span_handle.record("http.response.status_code", 200u16);
            span_handle.record("otel.status_code", "Ok");
            metrics::request_completed(signal, "ok", "none", duration);
            profiles_export_response(&headers, accepted)
        }
        Err(error) => {
            let status = error.status.as_u16();
            span_handle.record("http.response.status_code", status);
            span_handle.record("error.type", error.error_kind());
            metrics::request_completed(signal, "error", error.error_kind(), duration);
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

/// What an accepted export stored, and what it left out: rows past the row
/// ceiling, and the profiles they belonged to, which OTLP counts.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct ProfilesAccepted {
    stored_rows: usize,
    dropped_rows: usize,
    rejected_profiles: usize,
}

/// The `ExportProfilesServiceResponse`, in the encoding the request used: empty for
/// a full success, a partial success when rows were left out.
fn profiles_export_response(headers: &HeaderMap, accepted: ProfilesAccepted) -> Response {
    let json = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("json"));
    let partial_success = (accepted.rejected_profiles > 0).then(|| ExportProfilesPartialSuccess {
        rejected_profiles: i64::try_from(accepted.rejected_profiles).unwrap_or(i64::MAX),
        error_message: format!(
            "{} profile rows were larger than one export batch and were not stored",
            accepted.dropped_rows
        ),
    });
    if json {
        let body = partial_success.map_or_else(
            || "{}".to_owned(),
            |partial| {
                serde_json::json!({
                    "partialSuccess": {
                        "rejectedProfiles": partial.rejected_profiles,
                        "errorMessage": partial.error_message,
                    }
                })
                .to_string()
            },
        );
        (StatusCode::OK, [(CONTENT_TYPE, "application/json")], body).into_response()
    } else {
        let body = ExportProfilesServiceResponse { partial_success }.encode_to_vec();
        (
            StatusCode::OK,
            [(CONTENT_TYPE, "application/x-protobuf")],
            body,
        )
            .into_response()
    }
}

/// What the gateway stamps on a profile's resource: the same attributes
/// `enrich_resource_attributes` gives a log's, less a sender's own source claim.
/// The source's resource overrides, applied to the export before the org's rules run, and
/// the gateway's own stamps, applied by the flatten after them.
fn profile_resource_stamps(
    resolved_key: &ResolvedIngestKey,
) -> (profiles::ResourceOverrides, profiles::ResourceStamps) {
    let mut overrides = profiles::ResourceOverrides::default();
    let mut stamps = profiles::ResourceStamps {
        reserved: &["org_id", "maple_org_id", SOURCE_ID_ATTRIBUTE],
        ..Default::default()
    };
    let attributes = resolved_key
        .source
        .iter()
        .flat_map(|source| &source.resource_attributes)
        .filter(|attribute| !sources::is_protected_attribute(&attribute.key));
    for attribute in attributes {
        let pair = (attribute.key.clone(), attribute.value.clone());
        match attribute.mode {
            OverrideMode::Set => overrides.set.push(pair),
            OverrideMode::Default => overrides.defaults.push(pair),
        }
    }
    // Last, so the maple_* stamps win over any override.
    let mut stamp = |key: &str, value: &str| stamps.set.push((key.to_owned(), value.to_owned()));
    stamp("maple_org_id", &resolved_key.org_id);
    stamp("maple_ingest_key_type", resolved_key.key_type.as_str());
    stamp("maple_ingest_source", INGEST_SOURCE);
    if let Some(source_id) = resolved_key.source_public_id() {
        stamp(SOURCE_ID_ATTRIBUTE, source_id);
    }
    stamps.retention_days = Some(resolved_key.retention.get(RetentionSignal::Profiles));
    (overrides, stamps)
}

/// `POST /v1development/profiles`, and `/v1/profiles` where the spec moves it: an
/// OTLP profiles export, flattened to rows of `profiles` by `maple_ingest::profiles`.
/// Gated on the org's `profiles` plan feature and billed per GB decoded, like the byte signals.
async fn handle_profiles_inner(
    state: &AppState,
    headers: &HeaderMap,
    body: Bytes,
) -> Result<ProfilesAccepted, ApiError> {
    let Some(resolved_key) = resolve_replay_key(state, headers, &[SourceSignal::Profiles]).await?
    else {
        return Ok(ProfilesAccepted::default());
    };
    let org_id = resolved_key.org_id.clone();
    Span::current().record("maple.org_id", org_id.as_str());
    Span::current().record(
        "maple.ingest.clickhouse_ready",
        resolved_key.clickhouse_ready,
    );
    // Pinned to managed storage, like the audit trail: an org's own ClickHouse is
    // not required to have the table, so its rows are never sent there.
    let destination = ExportDestination::Tinybird;
    Span::current().record("maple.ingest.destination", destination.as_str());

    // A sender on another wire layout would decode into the wrong fields.
    let version = headers
        .get(profiles::VERSION_HEADER)
        .map(|value| value.to_str().unwrap_or_default());
    if !profiles::is_supported_version(version) {
        return Err(ApiError::bad_request(
            "Unsupported OTLP profiles development version; this gateway reads version 1",
        ));
    }

    let _org_inflight_permit =
        state
            .org_inflight_limiter
            .try_acquire(&org_id)
            .ok_or_else(|| {
                warn!(org_id = %org_id, "Per-org in-flight ingest limit exceeded");
                ApiError::too_many_requests("Per-org ingest limit exceeded")
            })?;
    if body.len() > state.config.max_request_body_bytes {
        return Err(ApiError::payload_too_large("Request body too large"));
    }
    let pipeline =
        native_rows_pipeline_for(state, destination, "Profile storage is not configured")?;
    // Before the body is read: an org without the feature, or past its cap, gets a 402.
    if org_id != SENTINEL_ORG_ID {
        if let Some(error) = entitlement_rejection(state, &org_id, PROFILES_FEATURE_ID).await {
            return Err(error);
        }
    }

    let (payload_format, gzip) = profiles_body_encoding(headers)?;
    let rules = profile_redaction_rules(state, &org_id).await?;
    Span::current().record("maple.ingest.payload_format", payload_format.label());
    Span::current().record(
        "maple.ingest.content_encoding",
        if gzip { "gzip" } else { "identity" },
    );

    let FlattenedProfiles {
        rows,
        profile_count,
        dropped_rows,
        rejected_profiles,
        decoded_bytes,
        memory: _decode_memory,
    } = decode_profiles(
        state,
        body,
        gzip,
        payload_format,
        profile_resource_stamps(&resolved_key),
        rules,
    )
    .await
    .inspect_err(|error| {
        warn!(
            org_id = %org_id,
            format = payload_format.label(),
            reason = %error.message,
            "Profiles export refused while decoding"
        );
        // A body that does not decode, or would store too much, is an export the org lost.
        let signal = TelemetrySignal::Profiles.as_str();
        if error.status == StatusCode::BAD_REQUEST {
            metrics::org_data_loss(&org_id, signal, "decode");
        } else if [INGEST_ROW_EXPANSION.error_kind, INGEST_RULES_SCAN_BUDGET.error_kind]
            .contains(&error.error_kind())
        {
            metrics::org_data_loss(&org_id, signal, error.error_kind());
        }
    })?;
    let count = rows.len();
    Span::current().record("maple.ingest.decoded_bytes", decoded_bytes);
    Span::current().record("maple.ingest.item_count", profile_count);
    Span::current().record("maple.ingest.native_rows", count);
    if dropped_rows > 0 {
        Span::current().record("maple.profiles.dropped", dropped_rows);
        warn!(
            org_id = %org_id,
            dropped = dropped_rows,
            "dropped profile rows larger than one export batch"
        );
    }
    let accepted = ProfilesAccepted {
        stored_rows: count,
        dropped_rows,
        rejected_profiles,
    };
    if rows.is_empty() {
        return Ok(accepted);
    }

    let retention_days = resolved_key.retention.get(RetentionSignal::Profiles);
    commit_profile_rows(state, pipeline, &org_id, rows, (destination, retention_days)).await?;
    // Recorded once the rows are durable, as the byte signals are. An export refused part way
    // (only a WAL write failing, since the whole export is reserved first) bills nothing: its
    // resend bills the whole export, so billing the stored part too would count it twice.
    if let Some(usage) = &state.usage_metrics {
        let signal = TelemetrySignal::Profiles.as_str();
        usage.record(&org_id, signal, decoded_bytes as u64, count as u64);
    }
    if org_id != SENTINEL_ORG_ID && decoded_bytes > 0 {
        if let Some(tracker) = &state.autumn_tracker {
            tracker.track(&org_id, PROFILES_FEATURE_ID, billable_gb(decoded_bytes as u64));
        }
    }
    state.resolver.note_source_use(&resolved_key, false);
    Ok(accepted)
}

/// Commits `rows` as one frame per export batch, not per request: the rows repeat
/// every stack in full, so an export is many times its wire size. The whole export
/// is reserved before its first frame, so a full queue refuses it with nothing stored.
async fn commit_profile_rows(
    state: &AppState,
    pipeline: &TelemetryPipeline,
    org_id: &str,
    rows: Vec<Vec<u8>>,
    (destination, retention_days): (ExportDestination, u16),
) -> Result<(), ApiError> {
    let signal = TelemetrySignal::Profiles;
    let count = rows.len();
    let batches = chunk_rows(rows, state.config.tinybird.batch_max_bytes);
    let datasource = &state.config.tinybird.datasource_profiles;
    let committed = pipeline
        .accept_row_batches_to(
            org_id,
            datasource,
            batches,
            signal,
            destination,
            Some(retention_days),
        )
        .await;
    let stored = committed
        .as_ref()
        .map_or_else(|refused| refused.committed_rows, |_| count);
    metrics::native_rows(signal.as_str(), stored as u64);
    committed.map(drop).map_err(|refused| {
        warn!(
            org_id = %org_id,
            error = %refused.error,
            committed_rows = refused.committed_rows,
            "profiles enqueue rejected"
        );
        profiles_commit_error(&refused, count)
    })
}

/// How a profiles export's body is encoded, and whether it is gzipped. Protobuf
/// unless the content type says JSON, as on the other OTLP routes.
fn profiles_body_encoding(headers: &HeaderMap) -> Result<(PayloadFormat, bool), ApiError> {
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/x-protobuf")
        .to_ascii_lowercase();
    let payload_format = detect_payload_format(&content_type)?;
    let gzip = match headers
        .get(CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_ascii_lowercase())
        .as_deref()
    {
        None | Some("" | "identity") => false,
        Some("gzip") => true,
        Some(_) => {
            return Err(ApiError::unsupported_media_type(
                "Unsupported content-encoding",
            ))
        }
    };
    Ok((payload_format, gzip))
}

/// A refused commit as the sender is told of it. The pipeline's own text says
/// nothing was written, which is only so when the first frame was the one refused.
fn profiles_commit_error(refused: &RowBatchesError, rows: usize) -> ApiError {
    let error = api_error_from_pipeline(&refused.error);
    if refused.committed_rows == 0 {
        return error;
    }
    ApiError {
        message: format!(
            "Maple stored {} of this export's {rows} profile rows before its ingest queue \
             refused the rest. Resending the export stores those rows a second time.",
            refused.committed_rows
        ),
        ..error
    }
}

/// The most one profile row may serialize to: an export batch less its newline,
/// so every frame `chunk_rows` makes fits a batch. Never past `MAX_ROW_BYTES`.
fn profile_row_max_bytes(batch_max_bytes: usize) -> usize {
    profiles::MAX_ROW_BYTES
        .min(batch_max_bytes)
        .saturating_sub(1)
}

/// `rows` in runs of at most `max_bytes`, in order. A longer row would be a run of
/// its own, but `profile_row_max_bytes` drops those before they get here.
fn chunk_rows(rows: Vec<Vec<u8>>, max_bytes: usize) -> Vec<Vec<Vec<u8>>> {
    let mut chunks: Vec<Vec<Vec<u8>>> = Vec::new();
    let mut chunk_bytes = 0_usize;
    for row in rows {
        let row_bytes = row.len() + 1;
        match chunks.last_mut() {
            Some(chunk) if chunk_bytes + row_bytes <= max_bytes => {
                chunk_bytes += row_bytes;
                chunk.push(row);
            }
            _ => {
                chunk_bytes = row_bytes;
                chunks.push(vec![row]);
            }
        }
    }
    chunks
}

/// A profiles export as rows, and the decode memory they hold until dropped.
struct FlattenedProfiles {
    rows: Vec<Vec<u8>>,
    profile_count: usize,
    /// Rows left out for being larger than one export batch.
    dropped_rows: usize,
    /// Profiles that lost a row that way.
    rejected_profiles: usize,
    decoded_bytes: usize,
    memory: DecodeReservation,
}

/// Inflates, decodes and flattens a profiles export on the blocking pool, inside
/// the decode memory budget like an OTLP body. The flatten reserves too: its rows
/// repeat per sample what the export's dictionary holds once. The decoded export
/// and its rows share one decode heap ceiling, so a request under every ceiling
/// always fits an idle gateway: a 503 here is contention, never the request's size.
async fn decode_profiles(
    state: &AppState,
    body: Bytes,
    gzip: bool,
    payload_format: PayloadFormat,
    (overrides, stamps): (profiles::ResourceOverrides, profiles::ResourceStamps),
    rules: Option<Arc<rules_gateway::OrgRules>>,
) -> Result<FlattenedProfiles, ApiError> {
    let span = Span::current();
    let mut reservation = state.decode_memory.reservation();
    let (max_decoded, heap_budget) = (
        state.config.max_decoded_body_bytes,
        state.config.max_decode_heap_bytes,
    );
    let max_row_bytes = profile_row_max_bytes(state.config.tinybird.batch_max_bytes);
    let max_row_expansion = state.config.max_row_expansion;
    tokio::task::spawn_blocking(move || {
        let busy = profiles_decode_busy;
        if !reservation.try_add(body.len() as u64) {
            return Err(busy());
        }
        let payload = if gzip {
            let invalid = || ApiError::bad_request("Invalid gzip body");
            let declared = decode_budget::gzip_declared_len(&body).ok_or_else(invalid)?;
            let declared = usize::try_from(declared).unwrap_or(usize::MAX);
            if declared > max_decoded {
                return Err(too_large_decoded());
            }
            if !reservation.try_add(declared as u64) {
                return Err(busy());
            }
            let inflated = gunzip_declared(&body, declared).map_err(|error| match error {
                GunzipError::Invalid(_) => invalid(),
                GunzipError::TooLarge => too_large_decoded(),
            })?;
            drop(body);
            Bytes::from(inflated)
        } else {
            body
        };
        let estimate = match payload_format {
            PayloadFormat::Protobuf => {
                decode_budget::protobuf_cost(OtlpSignal::Profiles, &payload, heap_budget)
            }
            PayloadFormat::Json => decode_budget::json_cost(&payload, heap_budget),
        }
        .map_err(|decode_budget::OverBudget| over_decode_budget(heap_budget))?;
        if !reservation.try_add(estimate) {
            return Err(busy());
        }
        let mut request = match payload_format {
            PayloadFormat::Protobuf => ExportProfilesServiceRequest::decode(payload.as_ref())
                .map_err(|e| invalid_payload("profiles", "protobuf", e))?,
            PayloadFormat::Json => profiles::decode_json(&payload)
                .map_err(|e| invalid_payload("profiles", "JSON", e))?,
        };
        // What the source's overrides add and the rules inline from the string table: under the
        // decode heap ceiling with the decoded export, and held with it until the rows are built.
        let mut grown = ExportGrowth::new(estimate, heap_budget);
        if !profiles::apply_resource_overrides(&mut request, &overrides, |bytes| {
            grown.charge(bytes, &mut reservation)
        }) {
            return Err(grown.refusal());
        }
        if let Some(rules) = &rules {
            redact_profile_export(&span, rules, &mut request, |bytes| {
                grown.charge(bytes, &mut reservation)
            })
            .map_err(|error| match error {
                ingest_rules::ProfileRedactError::OverMemoryBudget => grown.refusal(),
                ingest_rules::ProfileRedactError::ScanBudgetExceeded => ApiError::tagged(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    &INGEST_RULES_SCAN_BUDGET,
                    "This export needs more ingest rule scanning than one request may use; send smaller exports",
                ),
            })?;
        }
        // Only the decoded form is left; the buffers went with the payload.
        let decoded_bytes = payload.len();
        drop(payload);
        let decoded_heap = estimate.saturating_add(grown.bytes);
        reservation.shrink_to(decoded_heap);
        let limits = ProfileLimits {
            decoded_heap,
            heap_ceiling: heap_budget,
            max_row_bytes,
            row_expansion: max_row_expansion,
            max_stored_bytes: (max_row_expansion > 0)
                .then(|| (decoded_bytes as u64).saturating_mul(max_row_expansion)),
        };
        let flattened =
            flatten_profiles(&request, &stamps, limits, payload_format, &mut reservation)?;
        drop(request);
        // The rows, and the copy of them the WAL frame is built from.
        let row_bytes: usize = flattened.rows.iter().map(Vec::len).sum();
        if limits
            .max_stored_bytes
            .is_some_and(|allowed| row_bytes as u64 > allowed)
        {
            return Err(profiles_row_expansion(max_row_expansion));
        }
        reservation.shrink_to(2 * row_bytes as u64);
        Ok(FlattenedProfiles {
            rows: flattened.rows,
            profile_count: flattened.profile_count,
            dropped_rows: flattened.dropped_rows,
            rejected_profiles: flattened.rejected_profiles,
            decoded_bytes,
            memory: reservation,
        })
    })
    .await
    .unwrap_or_else(|join_error| {
        error!(error = %join_error, "Profiles decode task failed");
        Err(ApiError::service_unavailable(
            "Ingest gateway failed to decode the request",
        ))
    })
}

/// The org's ingest rules when one of them redacts: a profile gets every redact rule (see
/// `ingest_rules::redact_profiles`). A lookup with nothing to fall back on refuses the export
/// rather than storing it unredacted, as on the OTLP paths.
async fn profile_redaction_rules(
    state: &AppState,
    org_id: &str,
) -> Result<Option<Arc<rules_gateway::OrgRules>>, ApiError> {
    let resolver = &state.ingest_rule_resolver;
    if !resolver.enabled() || org_id == SENTINEL_ORG_ID {
        return Ok(None);
    }
    let rules = resolver.resolve_rules(org_id).await.map_err(|unavailable| {
        let message = match unavailable {
            rules_gateway::RulesUnavailable::Store => "Ingest rules could not be loaded; retry shortly",
            rules_gateway::RulesUnavailable::RegexBudget => {
                "This organization's ingest rule regexes are too large to compile together; simplify or remove some"
            }
        };
        ApiError::tagged(StatusCode::SERVICE_UNAVAILABLE, &INGEST_RULES_UNAVAILABLE, message)
    })?;
    Ok(rules.compiled.redacts().then_some(rules))
}

/// Redacts a decoded export with the org's rules, before anything of it is flattened or stored.
/// `charge` is asked for each copy of string-table text the pass makes.
fn redact_profile_export(
    span: &Span,
    rules: &rules_gateway::OrgRules,
    request: &mut ExportProfilesServiceRequest,
    charge: impl FnMut(u64) -> bool,
) -> Result<(), ingest_rules::ProfileRedactError> {
    let mut stats = RuleStats::default();
    ingest_rules::redact_profiles(&rules.compiled, request, &mut stats, charge)?;
    span.record("maple.ingest.rules.count", rules.compiled.len());
    span.record("maple.ingest.rules.redacted_values", stats.total.redacted_values);
    span.record("maple.ingest.rules.parse_failed", stats.total.parse_failed);
    Ok(())
}

fn profiles_decode_busy() -> ApiError {
    ApiError::tagged(
        StatusCode::SERVICE_UNAVAILABLE,
        &INGEST_DECODE_BUSY,
        "Ingest gateway is busy decoding other requests; retry shortly",
    )
}

/// Memory a decoded export grows by before it is flattened: the source's overrides and the text
/// the org's rules inline. Counted exactly against the decode heap ceiling, and reserved from the
/// process-wide budget in steps, so many small copies are not each rounded up to a KiB there.
struct ExportGrowth {
    estimate: u64,
    heap_ceiling: u64,
    bytes: u64,
    reserved: u64,
    over_ceiling: bool,
}

impl ExportGrowth {
    const STEP: u64 = 64 * 1024;

    const fn new(estimate: u64, heap_ceiling: u64) -> Self {
        Self {
            estimate,
            heap_ceiling,
            bytes: 0,
            reserved: 0,
            over_ceiling: false,
        }
    }

    fn charge(&mut self, bytes: u64, reservation: &mut DecodeReservation) -> bool {
        self.bytes = self.bytes.saturating_add(bytes);
        self.over_ceiling = self.estimate.saturating_add(self.bytes) > self.heap_ceiling;
        if self.over_ceiling {
            return false;
        }
        if self.bytes > self.reserved {
            let ask = (self.bytes - self.reserved).max(Self::STEP);
            if !reservation.try_add(ask) {
                return false;
            }
            self.reserved = self.reserved.saturating_add(ask);
        }
        true
    }

    /// Past the ceiling no retry fits: 413. Refused by the process-wide budget: the retryable 503.
    fn refusal(&self) -> ApiError {
        if self.over_ceiling {
            over_decode_budget(self.heap_ceiling)
        } else {
            profiles_decode_busy()
        }
    }
}

/// Refuses an export whose rows would store more than `INGEST_MAX_ROW_EXPANSION`
/// times its decoded size: each row repeats a whole stack, so a few KiB of
/// dictionary could otherwise store hundreds of MiB.
fn profiles_row_expansion(ceiling: u64) -> ApiError {
    ApiError::tagged(
        StatusCode::PAYLOAD_TOO_LARGE,
        &INGEST_ROW_EXPANSION,
        format!(
            "This export would be stored as more than {ceiling} times its size, because every \
             row repeats its whole stack; send fewer distinct stacks, links or attributes per \
             export"
        ),
    )
}

/// What bounds one export's flatten: the decode heap its decoded form was
/// estimated to take, the ceiling that and its rows share, the row ceiling, and
/// the most its rows may store (`None` when `INGEST_MAX_ROW_EXPANSION` is 0).
#[derive(Clone, Copy)]
struct ProfileLimits {
    decoded_heap: u64,
    heap_ceiling: u64,
    max_row_bytes: usize,
    row_expansion: u64,
    max_stored_bytes: Option<u64>,
}

/// The least a profiles flatten may charge before the stored-bytes ceiling stops it
/// early, so a tiny export is not refused for the meter's step size.
const PROFILES_MIN_CHARGE_BYTES: u64 = 1024 * 1024;

/// Flattens a decoded export, reserving its rows' memory first against the request's
/// own ceiling and then the process-wide budget. Past the ceiling is a 413, since
/// no retry fits it; refused by the process-wide budget is the retryable 503.
fn flatten_profiles(
    request: &ExportProfilesServiceRequest,
    stamps: &profiles::ResourceStamps,
    limits: ProfileLimits,
    payload_format: PayloadFormat,
    reservation: &mut DecodeReservation,
) -> Result<profiles::Flattened, ApiError> {
    // In whole KiB, as the reservation counts them.
    let kib = |bytes: u64| bytes.div_ceil(1024).saturating_mul(1024);
    let mut heap_bytes = kib(limits.decoded_heap);
    let mut over_ceiling = false;
    // The flatten charges each row twice (the row and its frame copy) plus what builds
    // it, in steps, so it stops once well past the stored-bytes ceiling; the exact
    // check after it decides.
    let charge_limit = limits
        .max_stored_bytes
        .map(|stored| stored.saturating_mul(4).max(PROFILES_MIN_CHARGE_BYTES));
    let mut charged = 0u64;
    let mut over_expansion = false;
    let mut reserve = |bytes: u64| {
        charged = charged.saturating_add(bytes);
        over_expansion = charge_limit.is_some_and(|limit| charged > limit);
        heap_bytes = heap_bytes.saturating_add(kib(bytes));
        over_ceiling = heap_bytes > limits.heap_ceiling;
        !over_expansion && !over_ceiling && reservation.try_add(bytes)
    };
    let now_nano = current_time_unix_nano();
    profiles::flatten(
        request,
        stamps,
        now_nano,
        &mut profiles::random_profile_id,
        limits.max_row_bytes,
        &mut reserve,
    )
    .map_err(|error| match error {
        profiles::FlattenError::OverBudget if over_expansion => {
            profiles_row_expansion(limits.row_expansion)
        }
        profiles::FlattenError::OverBudget if over_ceiling => {
            over_decode_budget(limits.heap_ceiling)
        }
        profiles::FlattenError::OverBudget => profiles_decode_busy(),
        profiles::FlattenError::InvalidId { .. } => {
            invalid_payload("profiles", payload_format.label(), error)
        }
        profiles::FlattenError::Encode(detail) => ApiError::tagged(
            StatusCode::SERVICE_UNAVAILABLE,
            &INGEST_ENCODE_FAILED,
            "Maple could not encode these profiles for storage.",
        )
        .with_detail(detail),
    })
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
    let retention_days = resolved_key.retention.get(RetentionSignal::Sessions);
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

    // Gated on every request, not only on a billable session start: a denied org
    // must not keep storing the continuation rows and chunks of its sessions.
    if let Some(error) = browser_sessions_rejection(state, &org_id).await {
        return Err(error);
    }

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
    // Inflating is CPU work bounded only by that ceiling, so it runs on the
    // blocking pool: on a one-core host the async workers are a single thread.
    // It reserves what it inflates from the shared decode memory, like an OTLP
    // body, so a burst of chunks is shed and not inflated all at once.
    let stored_as_blob = state.replay_blob_store.is_some();
    let compressed = body.clone();
    let mut reservation = state.decode_memory.reservation();
    let decoded = tokio::task::spawn_blocking(move || {
        // The size the chunk declares is what gets reserved, so it is also where
        // the inflate stops: a trailer that understates the stream buys nothing.
        let declared = decode_budget::gzip_declared_len(&compressed)
            .map_or(0, |declared| usize::try_from(declared).unwrap_or(usize::MAX))
            .min(max_decoded);
        if !reservation.try_add((compressed.len() + declared) as u64) {
            return Err(None);
        }
        if stored_as_blob {
            // Nothing of a blob chunk outlives the count.
            gunzip_len_bounded(&compressed, declared)
                .map(|byte_size| (None, byte_size, None))
                .map_err(Some)
        } else {
            gunzip_replay_text(&compressed, declared)
                .map(|events_json| {
                    let byte_size = events_json.len() as u64;
                    reservation.shrink_to(byte_size);
                    (Some(events_json), byte_size, Some(reservation))
                })
                .map_err(Some)
        }
    })
    .await
    .map_err(|join_error| {
        error!(error = %join_error, "Replay chunk decode task failed");
        ApiError::service_unavailable("Ingest gateway failed to decode the request")
    })?;
    // An inline chunk's text stays reserved until this handler has stored it.
    let (events_json, byte_size, _inline_text_reservation) =
        decoded.map_err(|rejection| match rejection {
            Some(error) => gunzip_rejection(error),
            None => ApiError::tagged(
                StatusCode::SERVICE_UNAVAILABLE,
                &INGEST_DECODE_BUSY,
                "Ingest gateway is busy decoding other requests; retry shortly",
            ),
        })?;

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
            let key = replay_object_key(retention_days, &org_id, &session_id, chunk_seq);
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
            // The index row carries the chunk's metadata; the payload lives in R2
            // under a key derived from (RetentionDays, OrgId, SessionId, ChunkSeq). An empty
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
        "retention_days": retention_days,
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
            Some(retention_days),
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
    ingress: Ingress,
) -> Response {
    let start = Instant::now();
    let body_bytes = body.len();
    let signal = ingress.signal();

    metrics::request_started();
    let _guard = InFlightGuard;

    let route = ingress.route();
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
        "maple.ingest.rules.parse_failed" = tracing::field::Empty,
        "maple.ingest.payload_format" = tracing::field::Empty,
        "maple.ingest.content_encoding" = tracing::field::Empty,
        "maple.ingest.decoded_bytes" = tracing::field::Empty,
        "maple.ingest.item_count" = tracing::field::Empty,
        "maple.sdk" = tracing::field::Empty,
        "user_agent.original" = tracing::field::Empty,
    );
    record_client_identity(&span, &headers);
    let span_handle = span.clone();

    let result = handle_signal_inner(&state, &headers, body, ingress)
        .instrument(span)
        .await;
    let duration = start.elapsed();

    match result {
        Ok((response, item_count, org_id, decoded_bytes)) => {
            let status_code = response.status().as_u16();
            span_handle.record("http.response.status_code", status_code);
            span_handle.record("otel.status_code", "Ok");
            metrics::request_completed(signal.path(), "ok", "none", duration.as_secs_f64());
            if matches!(ingress, Ingress::PrometheusRemoteWrite) {
                metrics::prometheus_request("ok", "none");
            }
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
            if matches!(ingress, Ingress::PrometheusRemoteWrite) {
                metrics::prometheus_request("error", error_kind);
            }
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
        "maple.ingest.rules.parse_failed" = tracing::field::Empty,
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
    ingress: Ingress,
) -> Result<(Response, usize, String, usize), (ApiError, &'static str)> {
    let signal = ingress.signal();
    let ingest_key = match ingress {
        Ingress::PrometheusRemoteWrite => extract_prometheus_ingest_key(headers),
        _ => extract_ingest_key(headers),
    }
    .ok_or_else(|| {
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

    // A drain's JSON is mapped to OTLP and sent on as protobuf, whatever
    // content type it was labelled with.
    let payload_format = match ingress {
        Ingress::Otlp(_) => detect_payload_format(&content_type).map_err(|e| {
            warn!(content_type = %content_type, "Unsupported content type");
            (e, "unsupported_media")
        })?,
        Ingress::VercelLogDrain | Ingress::VercelAiGatewayDrain | Ingress::VercelEventDrain(_) => {
            PayloadFormat::Protobuf
        }
        Ingress::PrometheusRemoteWrite => {
            if prometheus_remote_write::is_v2_content_type(&content_type) {
                warn!(content_type = %content_type, "Prometheus remote write 2.0 refused");
                return Err((
                    ApiError::unsupported_media_type(
                        "Prometheus remote write 2.0 is not supported yet; send version 1.0 \
                         (prometheus.WriteRequest)",
                    ),
                    "unsupported_media",
                ));
            }
            PayloadFormat::Protobuf
        }
    };
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

    // A remote write body is always a snappy block, named in the header or not.
    let encoding = match (ingress, content_encoding.as_deref()) {
        (Ingress::PrometheusRemoteWrite, None | Some("snappy")) => BodyEncoding::Snappy,
        (Ingress::PrometheusRemoteWrite, Some(_)) => {
            metrics::org_data_loss(&resolved_key.org_id, signal.path(), "decode");
            return Err((
                ApiError::unsupported_media_type(
                    "Unsupported content-encoding (Prometheus remote write is snappy)",
                ),
                "decode",
            ));
        }
        (_, None) => BodyEncoding::Identity,
        (_, Some("gzip")) => BodyEncoding::Gzip,
        (_, Some(_)) => {
            metrics::org_data_loss(&resolved_key.org_id, signal.path(), "decode");
            return Err((
                ApiError::unsupported_media_type("Unsupported content-encoding"),
                "decode",
            ));
        }
    };
    let body_bytes = body.len();
    let DecodedBody {
        payload: mut decoded,
        decoded_bytes,
        memory: decode_memory,
        prometheus,
    } = decode_otlp_body(state, body, encoding, ingress, payload_format)
        .await
        .map_err(|DecodeRefusal { error, stage }| {
            warn!(
                format = payload_format.label(),
                signal = signal.path(),
                org_id = resolved_key.org_id.as_str(),
                key_type = resolved_key.key_type.as_str(),
                body_bytes,
                stage,
                reason = %error.message,
                "OTLP payload refused while decoding"
            );
            if matches!(stage, "decode" | "enrich") {
                metrics::org_data_loss(&resolved_key.org_id, signal.path(), stage);
            }
            (error, stage)
        })?;

    Span::current().record("maple.ingest.decoded_bytes", decoded_bytes);
    debug!(decoded_bytes, "Payload decoded");
    metrics::decoded_body_bytes(signal.path(), decoded_bytes as u64);

    apply_header_source_claim(&mut decoded, headers, &resolved_key);
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
    match ingress {
        Ingress::VercelLogDrain => stamp_drain_source(&mut decoded, vercel_logs::INGEST_SOURCE),
        Ingress::VercelAiGatewayDrain => {
            stamp_drain_source(&mut decoded, vercel_ai_gateway_drain::INGEST_SOURCE);
        }
        Ingress::VercelEventDrain(drain) => stamp_drain_source(&mut decoded, drain.ingest_source()),
        Ingress::PrometheusRemoteWrite => {
            stamp_drain_source(&mut decoded, prometheus_remote_write::INGEST_SOURCE);
        }
        Ingress::Otlp(_) => {
            if let DecodedPayload::Traces(request) = &mut decoded {
                if vercel_traces::has_runtime_resources(request) {
                    let names = state
                        .vercel_project_name_resolver
                        .resolve(&resolved_key.org_id)
                        .await;
                    vercel_traces::restate(request, &names);
                }
            }
        }
    }
    let kept_claim = claims.kept_claim;
    let item_count = decoded.item_count();

    Span::current().record("maple.ingest.item_count", item_count);
    debug!(item_count, "Payload enriched");
    metrics::items_accepted(signal.path(), item_count as u64);

    if let Some(stats) = prometheus {
        metrics::prometheus_samples(stats.samples_accepted, &stats.dropped());
        debug!(?stats, "Prometheus remote write mapped to OTLP metrics");
        if item_count == 0 {
            // Metadata only, or every sample dropped: success, nothing written or billed.
            return Ok((
                StatusCode::OK.into_response(),
                0,
                resolved_key.org_id.clone(),
                0,
            ));
        }
    }
    // The collector is sent OTLP: gzip stays, a remote write's snappy does not.
    let forward_encoding = content_encoding
        .as_deref()
        .filter(|_| !matches!(ingress, Ingress::PrometheusRemoteWrite));

    let response_result = process_decoded_payload(
        state,
        signal,
        payload_format,
        forward_encoding,
        &mut decoded,
        &resolved_key,
        &claims.named_sources,
        &mut claims.retained,
        Received {
            bytes: decoded_bytes,
            decode_heap: decode_memory.held_bytes(),
        },
    )
    .await;
    // Only the share left after paused-source drops and ingest rules is metered.
    let decoded_bytes = claims.metered_bytes(decoded_bytes);
    let item_count = claims.retained.metered_items(item_count);

    // A refusal before anything was written keeps its own kind, unlike a forward failure.
    let response = response_result.map_err(|error| {
        let kind = process_error_kind(&error);
        (error, kind)
    })?;
    // A collector refusal that left nothing stored is not key use, and 0 bytes to meter.
    let stored = batch_was_stored(
        response.status().is_success(),
        state.config.write_mode,
        native_destination_for(&resolved_key),
    );
    if stored {
        state.resolver.note_source_use(&resolved_key, kept_claim);
        state
            .resolver
            .note_claimed_source_use(&claims.claimed_sources);
    }

    Ok((
        response,
        item_count,
        resolved_key.org_id.clone(),
        if stored { decoded_bytes } else { 0 },
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
                org_retention: resolved.retention.org,
                retention: resolved.retention.stamps(),
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
                &[],
                &mut retained,
                Received::unbudgeted(decoded_payload.len()),
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
        "maple.ingest.rules.parse_failed" = tracing::field::Empty,
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
                GcpPushOutcome::AuditEvent => {
                    span_handle.record("otel.status_code", "Ok");
                    span_handle.record("maple.ingest.item_count", 1);
                    span_handle.record("maple.signal", TelemetrySignal::AuditTrail.as_str());
                    metrics::request_completed(
                        TelemetrySignal::AuditTrail.as_str(),
                        "ok",
                        "none",
                        duration,
                    );
                    metrics::gcp_entry();
                }
                GcpPushOutcome::RulesScanBudget => {
                    // Acked, but the entry is gone: an `Error`, like a decode failure.
                    let kind = INGEST_RULES_SCAN_BUDGET.error_kind;
                    span_handle.record("error.type", kind);
                    record_rejection_reason(&span_handle, 200, kind, "Ingest rules scan budget exceeded");
                    metrics::request_completed("logs", "error", kind, duration);
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

    // An Admin Activity or Policy Denied entry is an audit event, not a log:
    // it goes to the audit trail, unmetered, ahead of the plan check on logs
    // and of the org's ingest rules, which are about what it keeps of its logs.
    if state.config.stores_audit_trail() {
        let now_ms = audit_trail::now_ms();
        if let Some(event) = audit_trail::gcp_entry(&entry, now_ms) {
            // Refused, Pub/Sub redelivers with backoff: delayed, not lost.
            audit_trail_rate_gate(state, org_id, "gcp", AUDIT_TRAIL_GCP_ORG_RPS)
                .await
                .map_err(|error| (error, "throttle"))?;
            let pipeline = native_rows_pipeline_for(
                state,
                ExportDestination::Tinybird,
                "Audit event storage is not configured",
            )
            .map_err(|error| (error, "forward"))?;
            if let Err(error) =
                store_audit_trail_rows(pipeline, org_id, vec![event.to_row(org_id, now_ms)]).await
            {
                state
                    .gcp_resolver
                    .record_health(connector_id, Some(gcp_logging::ENTRY_NOT_STORED))
                    .await;
                return Err((error, "forward"));
            }
            state.gcp_resolver.record_health(connector_id, None).await;
            state.resolver.note_source_use(&resolved.key, false);
            return Ok((StatusCode::OK.into_response(), GcpPushOutcome::AuditEvent));
        }
    }

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
        &[],
        &mut retained,
        Received::unbudgeted(body.len()),
    )
    .await
    {
        Ok(response) => response,
        // The same entry and rules are refused on every redelivery: ack it instead.
        Err(error) if error.error_kind() == INGEST_RULES_SCAN_BUDGET.error_kind => {
            state
                .gcp_resolver
                .record_health(connector_id, Some(gcp_logging::RULES_SCAN_BUDGET))
                .await;
            return Ok((StatusCode::OK.into_response(), GcpPushOutcome::RulesScanBudget));
        }
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
        "maple.ingest.rules.parse_failed" = tracing::field::Empty,
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
            &[],
            &mut retained,
            Received::unbudgeted(received_bytes),
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

/// Longer than any key Maple issues. A longer value is not a key, and is
/// refused here so it is never hashed, looked up or held in the unknown-key cache.
const MAX_INGEST_KEY_LEN: usize = 256;

fn extract_ingest_key(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    {
        if value.len() > 7 && value[..7].eq_ignore_ascii_case("Bearer ") {
            let token = value[7..].trim();
            if !token.is_empty() {
                return (token.len() <= MAX_INGEST_KEY_LEN).then(|| token.to_owned());
            }
        }
    }

    headers
        .get("x-maple-ingest-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= MAX_INGEST_KEY_LEN)
        .map(str::to_owned)
}

/// A basic-auth header this long is not a username and an ingest key.
const MAX_BASIC_AUTH_LEN: usize = 1024;

/// The ingest key of a Prometheus remote write: a bearer token or the
/// `x-maple-ingest-key` header like OTLP, or the basic-auth password, for a
/// `remote_write` configured with `basic_auth`. The username is ignored.
fn extract_prometheus_ingest_key(headers: &HeaderMap) -> Option<String> {
    if let Some(key) = extract_ingest_key(headers) {
        return Some(key);
    }
    let value = headers.get(AUTHORIZATION)?.to_str().ok()?;
    if value.len() > MAX_BASIC_AUTH_LEN || !value.get(..6)?.eq_ignore_ascii_case("Basic ") {
        return None;
    }
    let decoded = STANDARD.decode(value[6..].trim()).ok()?;
    let (_username, password) = std::str::from_utf8(&decoded).ok()?.split_once(':')?;
    let password = password.trim();
    (!password.is_empty() && password.len() <= MAX_INGEST_KEY_LEN).then(|| password.to_owned())
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

/// What decoding `payload` would allocate, refused past `heap_budget` before any
/// of it is allocated.
fn otlp_decode_cost(
    signal: Signal,
    payload_format: PayloadFormat,
    payload: &[u8],
    heap_budget: u64,
) -> Result<u64, ApiError> {
    match payload_format {
        PayloadFormat::Protobuf => {
            decode_budget::protobuf_cost(signal.otlp_signal(), payload, heap_budget)
        }
        PayloadFormat::Json => decode_budget::json_cost(payload, heap_budget),
    }
    .map_err(|decode_budget::OverBudget| over_decode_budget(heap_budget))
}

fn over_decode_budget(heap_budget: u64) -> ApiError {
    ApiError::payload_too_large(format!(
        "Request decodes past the {} MiB the gateway allows one request; send smaller batches",
        heap_budget / (1024 * 1024)
    ))
}

/// Why `decode_otlp_body` refused a body, and the stage that refused it, named as
/// the ingest spans' `error.type`.
struct DecodeRefusal {
    error: ApiError,
    stage: &'static str,
}

/// An OTLP body inflated and decoded, and the decode memory it holds until dropped.
struct DecodedBody {
    payload: DecodedPayload,
    decoded_bytes: usize,
    memory: DecodeReservation,
    /// What a Prometheus remote write body held, for that ingress only.
    prometheus: Option<prometheus_remote_write::Stats>,
}

/// How a request body is compressed.
#[derive(Clone, Copy, PartialEq, Eq)]
enum BodyEncoding {
    Identity,
    Gzip,
    /// A snappy block, as Prometheus remote write sends.
    Snappy,
}

impl BodyEncoding {
    fn label(self) -> &'static str {
        match self {
            Self::Identity => "identity",
            Self::Gzip => "gzip",
            Self::Snappy => "snappy",
        }
    }
}

static INGEST_DECODE_BUSY: FailureKind = FailureKind {
    tag: "@maple/ingest/DecodeBusy",
    code: "ingest_decode_busy",
    title: "Ingest gateway busy",
    recovery: "retry",
    retryable: true,
    error_kind: "decode_busy",
    retry_after_seconds: Some(1),
};

/// Inflates and decodes an OTLP body on the blocking pool, inside the process-wide
/// decode memory budget: the inflated size and the decode estimate are reserved
/// before they are allocated, and a request that does not fit is shed with a 503.
async fn decode_otlp_body(
    state: &AppState,
    body: Bytes,
    encoding: BodyEncoding,
    ingress: Ingress,
    payload_format: PayloadFormat,
) -> Result<DecodedBody, DecodeRefusal> {
    let signal = ingress.signal();
    let mut reservation = state.decode_memory.reservation();
    let (max_decoded, heap_budget) = (
        state.config.max_decoded_body_bytes,
        state.config.max_decode_heap_bytes,
    );
    let parent = Span::current();
    tokio::task::spawn_blocking(move || {
        let refuse = |span: &Span, error: ApiError, stage: &'static str| {
            record_stage_error(span, stage, &error.message, error.status.is_server_error());
            DecodeRefusal { error, stage }
        };
        let busy = || {
            ApiError::tagged(
                StatusCode::SERVICE_UNAVAILABLE,
                &INGEST_DECODE_BUSY,
                "Ingest gateway is busy decoding other requests; retry shortly",
            )
        };
        let decode_span = parent.in_scope(|| decode_internal_span(encoding.label(), body.len()));
        let payload = {
            let _guard = decode_span.enter();
            // The body is already buffered; counting it sheds the rest of a burst.
            if !reservation.try_add(body.len() as u64) {
                return Err(refuse(&decode_span, busy(), "decode_busy"));
            }
            let payload = if encoding == BodyEncoding::Identity {
                body
            } else {
                let invalid =
                    || ApiError::bad_request(format!("Invalid {} body", encoding.label()));
                // The size the body declares, checked and reserved before it is inflated.
                let declared = if encoding == BodyEncoding::Gzip {
                    decode_budget::gzip_declared_len(&body)
                } else {
                    snappy_declared_len(&body)
                }
                .ok_or_else(|| refuse(&decode_span, invalid(), "decode"))?;
                let declared = usize::try_from(declared).unwrap_or(usize::MAX);
                if declared > max_decoded {
                    return Err(refuse(&decode_span, too_large_decoded(), "payload_too_large"));
                }
                if !reservation.try_add(declared as u64) {
                    return Err(refuse(&decode_span, busy(), "decode_busy"));
                }
                let inflated = if encoding == BodyEncoding::Gzip {
                    gunzip_declared(&body, declared).map_err(|error| match error {
                        GunzipError::Invalid(_) => refuse(&decode_span, invalid(), "decode"),
                        GunzipError::TooLarge => {
                            refuse(&decode_span, too_large_decoded(), "payload_too_large")
                        }
                    })
                } else {
                    unsnap_declared(&body, declared).map_err(|error| match error {
                        SnappyError::Invalid => refuse(&decode_span, invalid(), "decode"),
                        SnappyError::TooLarge => {
                            refuse(&decode_span, too_large_decoded(), "payload_too_large")
                        }
                    })
                }?;
                drop(body);
                Bytes::from(inflated)
            };
            decode_span.record("maple.ingest.decoded_bytes", payload.len());
            payload
        };
        let parse_span =
            parent.in_scope(|| parse_internal_span(payload_format.label(), signal.path()));
        let _guard = parse_span.enter();
        let mut retained = None;
        // A drain's body is JSON whatever `payload_format` it is forwarded as.
        let estimate = match ingress {
            Ingress::Otlp(_) => otlp_decode_cost(signal, payload_format, &payload, heap_budget),
            Ingress::VercelLogDrain
            | Ingress::VercelAiGatewayDrain
            | Ingress::VercelEventDrain(_) => decode_budget::json_cost(&payload, heap_budget)
                .map_err(|decode_budget::OverBudget| over_decode_budget(heap_budget)),
            Ingress::PrometheusRemoteWrite => {
                prometheus_remote_write::decode_cost(&payload, heap_budget)
                    .map(|cost| {
                        // Less than the peak: the decoded request is gone once mapped.
                        retained = Some(cost.retained);
                        cost.peak
                    })
                    .map_err(|decode_budget::OverBudget| over_decode_budget(heap_budget))
            }
        }
        .map_err(|error| refuse(&parse_span, error, "payload_too_large"))?;
        parse_span.record("maple.ingest.decode_heap_estimate", estimate);
        if !reservation.try_add(estimate) {
            return Err(refuse(&parse_span, busy(), "decode_busy"));
        }
        let mut prometheus = None;
        let decoded = match ingress {
            Ingress::Otlp(_) => decode_otlp_payload(signal, payload_format, &payload),
            Ingress::VercelLogDrain => decode_vercel_logs(&payload),
            Ingress::VercelAiGatewayDrain => decode_vercel_ai_gateway(&payload),
            Ingress::VercelEventDrain(drain) => decode_vercel_event_drain(drain, &payload),
            Ingress::PrometheusRemoteWrite => {
                decode_prometheus_remote_write(&payload).map(|(decoded, stats)| {
                    prometheus = Some(stats);
                    decoded
                })
            }
        }
        .map_err(|error| refuse(&parse_span, error, "enrich"))?;
        parse_span.record("maple.ingest.item_count", decoded.item_count());
        // A remote write is metered as the OTLP it becomes. On the wire a series carries
        // its labels once and every stored point carries them, so the wire size would
        // let a series with many samples store far more than it is billed for.
        let decoded_bytes = match (&decoded, ingress) {
            (DecodedPayload::Metrics(request), Ingress::PrometheusRemoteWrite) => {
                request.encoded_len()
            }
            _ => payload.len(),
        };
        // Everything after decoding is sized for a body of at most `max_decoded` bytes,
        // so a write may not fan out into more OTLP than an OTLP request may carry.
        if matches!(ingress, Ingress::PrometheusRemoteWrite) && decoded_bytes > max_decoded {
            return Err(refuse(&parse_span, too_large_mapped(), "payload_too_large"));
        }
        // Only the decoded form outlives this closure; the buffers go with it.
        drop(payload);
        reservation.shrink_to(retained.unwrap_or(estimate));
        Ok(DecodedBody {
            payload: decoded,
            decoded_bytes,
            memory: reservation,
            prometheus,
        })
    })
    .await
    .unwrap_or_else(|join_error| {
        error!(error = %join_error, "OTLP decode task failed");
        Err(DecodeRefusal {
            error: ApiError::service_unavailable("Ingest gateway failed to decode the request"),
            stage: "decode_panic",
        })
    })
}

fn too_large_decoded() -> ApiError {
    ApiError::payload_too_large("Decompressed request body too large")
}

fn too_large_mapped() -> ApiError {
    ApiError::payload_too_large(
        "This remote write holds more metric data than one request may carry; send fewer \
         samples per request",
    )
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

fn decode_prometheus_remote_write(
    payload: &[u8],
) -> Result<(DecodedPayload, prometheus_remote_write::Stats), ApiError> {
    let (request, stats) = prometheus_remote_write::decode(payload).map_err(|_| {
        ApiError::bad_request(
            "Invalid Prometheus remote write payload (expected a prometheus.WriteRequest)",
        )
    })?;
    Ok((DecodedPayload::Metrics(request), stats))
}

fn decode_vercel_logs(payload: &[u8]) -> Result<DecodedPayload, ApiError> {
    let parsed = vercel_logs::parse(payload)
        .map_err(|e| ApiError::bad_request(format!("Invalid Vercel log drain payload: {e}")))?;
    if parsed.malformed_lines > 0 {
        warn!(
            malformed_lines = parsed.malformed_lines,
            "Vercel log drain delivery had lines that are not JSON; skipped them"
        );
    }
    Ok(DecodedPayload::Logs(vercel_logs::build_logs_request(
        &parsed.entries,
        current_time_unix_nano(),
    )))
}

fn decode_vercel_ai_gateway(payload: &[u8]) -> Result<DecodedPayload, ApiError> {
    let parsed = vercel_logs::parse(payload).map_err(|e| {
        ApiError::bad_request(format!("Invalid Vercel AI Gateway drain payload: {e}"))
    })?;
    if parsed.malformed_lines > 0 {
        warn!(
            malformed_lines = parsed.malformed_lines,
            "Vercel AI Gateway drain delivery had lines that are not JSON; skipped them"
        );
    }
    Ok(DecodedPayload::Traces(
        vercel_ai_gateway_drain::build_traces_request(&parsed.entries),
    ))
}

fn decode_vercel_event_drain(
    drain: EventDrain,
    payload: &[u8],
) -> Result<DecodedPayload, ApiError> {
    let label = drain.label();
    let parsed = vercel_logs::parse(payload)
        .map_err(|e| ApiError::bad_request(format!("Invalid Vercel {label} drain payload: {e}")))?;
    if parsed.malformed_lines > 0 {
        warn!(
            malformed_lines = parsed.malformed_lines,
            drain = label,
            "Vercel drain delivery had lines that are not JSON; skipped them"
        );
    }
    Ok(DecodedPayload::Logs(
        vercel_event_drains::build_logs_request(drain, &parsed.entries, current_time_unix_nano()),
    ))
}

/// The drain's source replaces the OTLP gateway's that enrichment stamps.
fn stamp_drain_source(decoded: &mut DecodedPayload, source: &str) {
    let resources: Vec<&mut Option<Resource>> = match decoded {
        DecodedPayload::Logs(request) => request
            .resource_logs
            .iter_mut()
            .map(|resource_log| &mut resource_log.resource)
            .collect(),
        DecodedPayload::Traces(request) => request
            .resource_spans
            .iter_mut()
            .map(|resource_span| &mut resource_span.resource)
            .collect(),
        DecodedPayload::Metrics(request) => request
            .resource_metrics
            .iter_mut()
            .map(|resource_metric| &mut resource_metric.resource)
            .collect(),
    };
    for resource in resources.into_iter().flatten() {
        upsert_string_attribute(&mut resource.attributes, "maple_ingest_source", source);
    }
}

/// Names the sender's source for senders that cannot set resource attributes (Vercel drains).
const SOURCE_ID_HEADER: &str = "x-maple-source-id";

/// Copies the `x-maple-source-id` header onto every resource without a `maple_source_id`
/// of its own, so it is verified and stamped exactly like an attribute claim.
fn apply_header_source_claim(
    decoded: &mut DecodedPayload,
    headers: &HeaderMap,
    resolved_key: &ResolvedIngestKey,
) {
    if !resolved_key.accepts_source_claims() {
        return;
    }
    let Some(claim) = headers
        .get(SOURCE_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|claim| !claim.is_empty() && claim.len() <= MAX_PUBLIC_ID_LEN)
    else {
        return;
    };
    let resources: Vec<&mut Resource> = match decoded {
        DecodedPayload::Traces(request) => request
            .resource_spans
            .iter_mut()
            .map(|r| r.resource.get_or_insert_with(Resource::default))
            .collect(),
        DecodedPayload::Logs(request) => request
            .resource_logs
            .iter_mut()
            .map(|r| r.resource.get_or_insert_with(Resource::default))
            .collect(),
        DecodedPayload::Metrics(request) => request
            .resource_metrics
            .iter_mut()
            .map(|r| r.resource.get_or_insert_with(Resource::default))
            .collect(),
    };
    for resource in resources {
        if source_id_claim(&resource.attributes).is_none() {
            upsert_string_attribute(&mut resource.attributes, SOURCE_ID_ATTRIBUTE, claim);
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
    /// Each verified, unpaused claim with its source's own retention overrides: its
    /// rows are stamped with that source's periods, not the default source's.
    named_sources: Vec<NamedSource>,
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
        named_sources: verified.retention,
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
    let rules = resolver.resolve_rules(org_id).await.map_err(|unavailable| {
        let message = match unavailable {
            rules_gateway::RulesUnavailable::Store => "Ingest rules could not be loaded; retry shortly",
            rules_gateway::RulesUnavailable::RegexBudget => {
                "This organization's ingest rule regexes are too large to compile together; simplify or remove some"
            }
        };
        ApiError::tagged(StatusCode::SERVICE_UNAVAILABLE, &INGEST_RULES_UNAVAILABLE, message)
    })?;
    let signal = decoded.signal();
    if !rules.compiled.covers(signal.ingest_signal()) {
        return Ok(None);
    }
    let mut stats = RuleStats::default();
    match decoded {
        DecodedPayload::Traces(request) => ingest_rules::apply_traces(&rules.compiled, request, &mut stats),
        DecodedPayload::Logs(request) => ingest_rules::apply_logs(&rules.compiled, request, &mut stats),
        DecodedPayload::Metrics(request) => ingest_rules::apply_metrics(&rules.compiled, request, &mut stats),
    }
    .map_err(|ingest_rules::ScanBudgetExceeded| {
        warn!(org_id, signal = signal.path(), "Payload exceeds the ingest rule scan budget; refused");
        // Counted per refusal; a transport that retries a 413 counts each attempt.
        metrics::org_data_loss(org_id, signal.path(), INGEST_RULES_SCAN_BUDGET.error_kind);
        ApiError::tagged(
            StatusCode::PAYLOAD_TOO_LARGE,
            &INGEST_RULES_SCAN_BUDGET,
            "This payload needs more ingest rule scanning than one request may use; send smaller batches",
        )
    })?;
    let span = Span::current();
    span.record("maple.ingest.rules.count", rules.compiled.len());
    span.record("maple.ingest.rules.dropped_items", stats.total.dropped);
    span.record("maple.ingest.rules.redacted_values", stats.total.redacted_values);
    span.record("maple.ingest.rules.parse_failed", stats.total.parse_failed);
    if stats.total.dropped > 0 || stats.total.redacted_values > 0 {
        // One walk, only when something changed. Redaction's size change is not tracked, so
        // `before` is after plus the dropped bytes: drops are discounted, redaction never bills more.
        // Parsing's net size change is taken back out, so parsing never moves the bill.
        let encoded = i64::try_from(decoded.encoded_len()).unwrap_or(i64::MAX);
        let after = usize::try_from(encoded.saturating_sub(stats.parse_size_change)).unwrap_or(0);
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

/// What a request cost before its rows are built: the bytes it is metered on and
/// the decode memory it still holds.
#[derive(Clone, Copy)]
struct Received {
    bytes: usize,
    decode_heap: u64,
}

impl Received {
    /// A connector's batch, built by the gateway outside the decode budget.
    const fn unbudgeted(bytes: usize) -> Self {
        Self {
            bytes,
            decode_heap: 0,
        }
    }
}

/// What the stage after decoding is admitted on.
#[derive(Clone, Copy)]
struct RowStage {
    /// The bytes the request is billed for, after drops.
    metered_bytes: usize,
    decode_heap: u64,
    /// Whether the rows are built here; a forward-only request only encodes a body.
    native: bool,
    /// What building the body forwarded to a collector allocates.
    forward_bytes: u64,
    /// What the attributes parse rules wrote hold; they were allocated after the decode
    /// reservation, so they are reserved here with the rows.
    parse_heap: u64,
}

/// Admits the stage after decoding, before any of it runs: refuses a request whose
/// rows come to far more than it is metered on, then reserves the largest piece its
/// rows are built in (`piece_heap`, held while every piece is written in turn) and
/// its forward body. Nothing is written yet, so a refusal leaves nothing.
fn admit_rows(
    state: &AppState,
    signal: Signal,
    org_id: &str,
    rows: &RowEstimate,
    piece_heap: u64,
    stage: RowStage,
    memory: &mut DecodeReservation,
) -> Result<(), ApiError> {
    let refuse = |error: ApiError| {
        warn!(
            signal = signal.path(),
            org_id,
            rows = rows.rows,
            row_bytes = rows.row_bytes(),
            metered_bytes = stage.metered_bytes,
            reason = %error.message,
            "Payload refused before its rows were built"
        );
        record_stage_error(
            &Span::current(),
            error.error_kind(),
            &error.message,
            error.status.is_server_error(),
        );
        error
    };
    let ceiling = state.config.max_row_expansion;
    let allowed = (stage.metered_bytes as u64).saturating_mul(ceiling);
    if ceiling > 0 && rows.row_bytes() > allowed {
        // Counted per refusal, as a scan-budget refusal is: the batch is not stored.
        metrics::org_data_loss(org_id, signal.path(), INGEST_ROW_EXPANSION.error_kind);
        return Err(refuse(ApiError::tagged(
            StatusCode::PAYLOAD_TOO_LARGE,
            &INGEST_ROW_EXPANSION,
            format!(
                "This batch would be stored as more than {ceiling} times its size, because every \
                 row repeats its resource, scope and metric attributes; shorten them or send \
                 fewer items per resource"
            ),
        )));
    }
    let rows_heap = if stage.native { piece_heap } else { 0 };
    let room = state
        .decode_memory
        .total_bytes()
        .saturating_sub(stage.decode_heap);
    // Only a single row larger than the whole budget gets here: pieces are small.
    if rows_heap > room {
        metrics::org_data_loss(org_id, signal.path(), INGEST_PAYLOAD_TOO_LARGE.error_kind);
        return Err(refuse(ApiError::payload_too_large(format!(
            "One item needs {} MiB to store, more than the gateway allows one request; send \
             smaller items",
            rows_heap / (1024 * 1024)
        ))));
    }
    // The forward body is reserved whole. Within the decode limits it always fits an
    // otherwise idle budget, so this refusal is for a gateway configured too small.
    let needed = rows_heap
        .saturating_add(stage.forward_bytes)
        .saturating_add(stage.parse_heap);
    if needed > room {
        metrics::org_data_loss(org_id, signal.path(), INGEST_PAYLOAD_TOO_LARGE.error_kind);
        return Err(refuse(ApiError::payload_too_large(format!(
            "This batch needs {} MiB to forward and store, more than the gateway allows one \
             request; send smaller batches",
            needed / (1024 * 1024)
        ))));
    }
    if !memory.try_add(needed) {
        return Err(refuse(ApiError::tagged(
            StatusCode::SERVICE_UNAVAILABLE,
            &INGEST_DECODE_BUSY,
            "Ingest gateway is busy storing other requests; retry shortly",
        )));
    }
    Ok(())
}

/// The `error.type` of a `process_decoded_payload` refusal: its own kind where the
/// refusal has one, `forward` for the rest.
fn process_error_kind(error: &ApiError) -> &'static str {
    let kind = error.error_kind();
    let own = [
        &INGEST_RULES_SCAN_BUDGET,
        &INGEST_ROW_EXPANSION,
        &INGEST_PAYLOAD_TOO_LARGE,
        &INGEST_DECODE_BUSY,
        &INGEST_ROWS_EXCEED_QUEUE,
    ];
    if own.iter().any(|failure| failure.error_kind == kind) {
        kind
    } else {
        "forward"
    }
}

#[hotpath::measure]
#[expect(
    clippy::too_many_arguments,
    reason = "one request's signal, wire format, payload, key, named sources and what it is \
              metered on; a struct would only be built and taken apart again at each of five \
              call sites"
)]
async fn process_decoded_payload(
    state: &AppState,
    signal: Signal,
    payload_format: PayloadFormat,
    content_encoding: Option<&str>,
    decoded: &mut DecodedPayload,
    resolved_key: &ResolvedIngestKey,
    named_sources: &[NamedSource],
    retained: &mut Retained,
    received: Received,
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

    let native = uses_native_pipeline_for(state.config.write_mode, destination);
    let forward = uses_forward_path_for(state.config.write_mode, destination);
    let forward_gzip = match content_encoding {
        Some("gzip") => true,
        Some(_) if forward => {
            return Err(ApiError::unsupported_media_type(
                "Unsupported content-encoding",
            ));
        }
        _ => false,
    };
    let forward_body = if forward {
        Some(decoded.forward_body(payload_format, forward_gzip)?)
    } else {
        None
    };
    let stage = RowStage {
        metered_bytes: retained.metered_bytes(received.bytes),
        decode_heap: received.decode_heap,
        parse_heap: applied.as_ref().map_or(0, |applied| applied.stats.parse_heap_added),
        native,
        forward_bytes: forward_body.map_or(0, |body| body.heap_bytes()),
    };
    // Held until the rows are in the WAL and the forward body is sent.
    let mut memory = state.decode_memory.reservation();

    if native {
        let named = named_source_stamps(resolved_key, named_sources, decoded.retention_signal());
        let stamps = SourceStamps::new(
            resolved_key.retention.get(decoded.retention_signal()),
            &named,
        );
        // A frame holds one period, so resources of one period are stored together:
        // a request naming several sources is then at most a frame per period more.
        if !stamps.is_uniform() {
            decoded.group_by_stamp(stamps);
        }
        // Only trace rows carry the events period.
        let events = match &*decoded {
            DecodedPayload::Traces(_) => events_stamps(resolved_key, named_sources),
            DecodedPayload::Logs(_) | DecodedPayload::Metrics(_) => EventsStamps::default(),
        };
        accept_native_decoded_payload(
            state,
            signal,
            decoded,
            NativeTarget {
                org_id: &resolved_key.org_id,
                destination,
                stamps,
                events: &events,
            },
            stage,
            &mut memory,
        )
        .instrument(accept_internal_span(signal.path(), destination.as_str()))
        .await?;
        if destination == ExportDestination::ClickHouse {
            record_rule_stats(state, signal, applied.as_ref());
            return Ok(StatusCode::OK.into_response());
        }
    } else if forward {
        // The collector builds the same rows, so the same ceiling applies.
        let rows = decoded.rows(&resolved_key.org_id);
        admit_rows(
            state,
            signal,
            &resolved_key.org_id,
            &rows,
            0,
            stage,
            &mut memory,
        )?;
    }

    if let Some(forward_body) = forward_body {
        let outbound_body = decoded.encode(&forward_body)?;
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

/// What each resource a request names is stamped with for `signal`: that source's
/// own override, else the org's, as for any source.
fn named_source_stamps(
    resolved_key: &ResolvedIngestKey,
    named_sources: &[NamedSource],
    signal: RetentionSignal,
) -> Vec<(String, u16)> {
    named_sources
        .iter()
        .map(|(source_id, overrides)| {
            let stamp = retention::stamp_days(&resolved_key.org_retention, overrides, signal);
            (source_id.clone(), stamp)
        })
        .collect()
}

/// The events period each resource of a request carries as `events_retention_days`, so
/// the `product_events` rows views derive from its spans keep its source's period.
fn events_stamps(resolved_key: &ResolvedIngestKey, named_sources: &[NamedSource]) -> EventsStamps {
    EventsStamps::new(
        resolved_key.retention.get(RetentionSignal::Events),
        named_source_stamps(resolved_key, named_sources, RetentionSignal::Events),
    )
}

/// Where a request's rows are written and what they are stamped with.
#[derive(Clone, Copy)]
struct NativeTarget<'a> {
    org_id: &'a str,
    destination: ExportDestination,
    stamps: SourceStamps<'a>,
    /// Read by trace rows only.
    events: &'a EventsStamps,
}

#[hotpath::measure]
async fn accept_native_decoded_payload(
    state: &AppState,
    signal: Signal,
    decoded: &DecodedPayload,
    target: NativeTarget<'_>,
    stage: RowStage,
    memory: &mut DecodeReservation,
) -> Result<(), ApiError> {
    let native_start = Instant::now();
    let org_id = target.org_id;
    let stats = match decoded {
        DecodedPayload::Traces(request) => {
            // Both lookups are 30s-TTL cached; the span exists so a TTL miss that
            // stalls on PSBouncer is attributable instead of vanishing into
            // native_accept_duration.
            let config_span = resolve_config_internal_span();
            let config_span_handle = config_span.clone();
            let (policy, attribute_mappings) = async {
                let policy = state.sampling_resolver.resolve_policy(org_id).await;
                let attribute_mappings = state
                    .attribute_mapping_resolver
                    .resolve_mappings(org_id)
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
            let source = RowSource::Traces {
                request,
                policy: &policy,
                mappings: attribute_mappings.as_slice(),
            };
            accept_row_source(state, signal, source, target, stage, memory).await?
        }
        DecodedPayload::Logs(request) => {
            let source = RowSource::Logs(request);
            accept_row_source(state, signal, source, target, stage, memory).await?
        }
        DecodedPayload::Metrics(request) => {
            let source = RowSource::Metrics(request);
            accept_row_source(state, signal, source, target, stage, memory).await?
        }
    };
    metrics::native_accept_duration(signal.path(), native_start.elapsed().as_secs_f64());
    metrics::native_rows(signal.path(), stats.rows as u64);
    if stats.dropped > 0 {
        metrics::native_sampled_dropped(signal.path(), stats.dropped as u64);
    }
    Span::current().record("maple.ingest.native_rows", stats.rows as u64);
    Span::current().record("maple.ingest.sampled_dropped", stats.dropped as u64);
    Ok(())
}

/// Plans a request's rows in pieces, admits it on its largest piece, then builds and
/// commits the pieces in order from one up-front queue reservation. Only a WAL write
/// or sync failure, or a dropped request, can stop it after a piece is written.
async fn accept_row_source(
    state: &AppState,
    signal: Signal,
    source: RowSource<'_>,
    target: NativeTarget<'_>,
    stage: RowStage,
    memory: &mut DecodeReservation,
) -> Result<AcceptStats, ApiError> {
    let NativeTarget {
        org_id,
        destination,
        stamps,
        events,
    } = target;
    let pipeline = state
        .telemetry_pipeline
        .as_ref()
        .ok_or_else(|| ApiError::service_unavailable("Telemetry pipeline is not configured"))?;
    let plan = source
        .plan_stamped(org_id, state.config.row_piece_bytes, stamps)
        .with_events(events.clone());
    Span::current().record("maple.ingest.row_pieces", plan.pieces.len());
    admit_rows(
        state,
        signal,
        org_id,
        &plan.total,
        plan.largest_piece_heap(),
        stage,
        memory,
    )?;
    pipeline
        .accept_planned(org_id, source, destination, &plan)
        .await
        .map_err(|failure| {
            let PlannedFailure {
                error,
                pieces_written,
                ..
            } = &failure;
            let stored_any = failure.stored_any();
            let mut api_error = api_error_from_pipeline(error);
            error!(
                error = %failure,
                signal = signal.path(),
                org_id,
                "Native telemetry pipeline rejected payload"
            );
            if stored_any {
                api_error.message =
                    partial_write_message(error, *pieces_written, plan.pieces.len());
            }
            match error {
                // Resending fails the same way: the batch is lost, or the unwritten part of it.
                PipelineError::Encode(_) if stored_any => {
                    metrics::org_data_loss(org_id, signal.path(), "encode_partial");
                }
                PipelineError::Encode(_) | PipelineError::TooLarge(_) => {
                    metrics::org_data_loss(org_id, signal.path(), error.kind());
                }
                _ => {}
            }
            record_stage_error(
                &Span::current(),
                error.kind(),
                &error.to_string(),
                error.is_server_fault(),
            );
            api_error
        })
}

/// The answer to a request that failed after some of its pieces were durable: those
/// are exported, so it must not say nothing was written.
fn partial_write_message(error: &PipelineError, written: usize, pieces: usize) -> String {
    let stored = if written == 0 {
        format!("Part of the first of the {pieces} pieces this batch was stored in was written and will be exported.")
    } else {
        format!("At least {written} of the {pieces} pieces this batch was stored in were written and will be exported.")
    };
    if matches!(error, PipelineError::Encode(_)) {
        format!("Maple could not encode the rest of this batch for storage. {stored} Resending fails the same way; contact support with this request's trace id.")
    } else {
        format!("Maple could not durably queue the rest of this batch. {stored} Resend it after the suggested delay; the written part is stored again.")
    }
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
        let mut keep = |claim: String, pause: PauseWindow, retention: RetentionOverrides| {
            if pause.is_paused(now_ms) {
                verified.paused.push(claim);
            } else {
                verified.retention.push((claim.clone(), retention));
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
                Some(SourceClaim::Claimable(pause, retention)) => {
                    keep(cache_key.1, pause, retention);
                }
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
                verified.unresolved = true;
                return verified;
            }
        };
        for (claim, uuid) in unknown {
            let answer = found
                .iter()
                .find(|row| row.id == uuid)
                .map_or(SourceClaim::Unclaimable, |row| {
                    SourceClaim::Claimable(row.pause, row.retention)
                });
            if let SourceClaim::Claimable(pause, retention) = answer {
                keep(claim.clone(), pause, retention);
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
            if let Some(SourceClaim::Claimable(pause, _)) =
                self.source_claims.get(&cache_key).await
            {
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
                    .map(|row| (row.key, None, row.default_source_id, row.retention))
            }
            IngestKeyType::Source => self
                .store
                .fetch_source_by_token_hash(&key_hash)
                .await?
                .map(|row| (row.key, row.config, None, row.retention)),
            IngestKeyType::Connector => return Ok(None),
        };
        let Some((row, source_config_row, default_source_id, retention)) = found else {
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
            retention,
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
        let retention = PullSourceRow::retention(row.source.as_ref(), row.org_retention);
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
            retention,
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
        let retention = PullSourceRow::retention(row.source.as_ref(), row.org_retention);
        let (source, source_pause) = PullSourceRow::stamped(row.source);
        let identity = GcpConnectorIdentity {
            org_id: row.org_id,
            secret_key_id: cache_key.1.chars().take(16).collect(),
            logs_enabled: row.logs_enabled,
            confirms_log_forwarding: false,
            source,
            source_pause,
            retention,
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

        let retention = PullSourceRow::retention(row.source.as_ref(), row.org_retention);
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
            retention,
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
        let retention = PullSourceRow::retention(row.source.as_ref(), row.org_retention);
        let (source, source_pause) = PullSourceRow::stamped(row.source);
        let identity = AwsConnectionIdentity {
            org_id: row.org_id,
            secret_key_id: cache_key.1.chars().take(16).collect(),
            source,
            source_pause,
            retention,
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

/// Mapping rules an org's spans get, and the bytes of their keys in all. Each rule can
/// copy a value into every span, so the count bounds how much a span grows.
const MAX_ATTRIBUTE_MAPPINGS: usize = 64;
const MAX_ATTRIBUTE_MAPPING_BYTES: usize = 16 * 1024;

/// The rules in order, up to the first that would pass either cap.
fn cap_attribute_mappings(
    org_id: &str,
    rules: impl Iterator<Item = AttributeMappingRule>,
) -> Vec<AttributeMappingRule> {
    let mut kept = Vec::new();
    let mut bytes = 0usize;
    for rule in rules {
        let size = rule.source_key.len() + rule.target_key.len();
        if kept.len() == MAX_ATTRIBUTE_MAPPINGS || bytes + size > MAX_ATTRIBUTE_MAPPING_BYTES {
            warn!(
                org_id,
                kept = kept.len(),
                "Attribute mappings past the gateway's cap are not applied"
            );
            break;
        }
        bytes += size;
        kept.push(rule);
    }
    kept
}

impl AttributeMappingResolver {
    #[hotpath::measure]
    async fn resolve_mappings(&self, org_id: &str) -> Arc<Vec<AttributeMappingRule>> {
        if let Some(rules) = self.cache.get(org_id).await {
            return rules;
        }

        let rules = match self.store.fetch_attribute_mappings(org_id).await {
            Ok(rows) => Arc::new(cap_attribute_mappings(
                org_id,
                rows.into_iter().filter_map(parse_attribute_mapping_row),
            )),
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

impl VercelProjectNameResolver {
    /// A failed lookup is not cached, and names nothing: the spans keep Vercel's service.
    async fn resolve(&self, org_id: &str) -> Arc<HashMap<String, String>> {
        if let Some(names) = self.cache.get(org_id).await {
            return names;
        }
        match self.store.fetch_vercel_project_names(org_id).await {
            Ok(rows) => {
                let names = Arc::new(rows.into_iter().collect::<HashMap<_, _>>());
                self.cache
                    .insert(org_id.to_owned(), Arc::clone(&names))
                    .await;
                names
            }
            Err(error) => {
                warn!(
                    org_id,
                    error = %error,
                    "Vercel project name lookup failed; keeping Vercel's runtime service name"
                );
                Arc::default()
            }
        }
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
/// The org's retention policy rides the same query; an org that set none has no row.
const CONNECTOR_SOURCE_JOIN: &str =
    "LEFT JOIN sources src ON src.id = c.source_id AND src.org_id = c.org_id \
     LEFT JOIN org_retention_policies rp ON rp.org_id = c.org_id";
const CONNECTOR_SOURCE_COLUMNS: &str = "src.id AS source_id, \
    (EXTRACT(EPOCH FROM src.paused_at) * 1000)::bigint AS source_paused_at_ms, \
    (EXTRACT(EPOCH FROM src.paused_until) * 1000)::bigint AS source_paused_until_ms, \
    src.retention_days::text AS source_retention_days, \
    rp.retention_days::text AS org_retention_days";

fn connector_source(row: &tokio_postgres::Row) -> Option<PullSourceRow> {
    let id: Option<String> = row.get("source_id");
    id.map(|id| PullSourceRow {
        id,
        pause: PauseWindow {
            paused_at_ms: row.get("source_paused_at_ms"),
            paused_until_ms: row.get("source_paused_until_ms"),
        },
        retention: retention_column(row, "source_retention_days"),
    })
}

/// A `retention_days` jsonb column selected as text. A null (no joined row) or a
/// value that does not read sets nothing: a bad policy never fails a lookup.
fn retention_column(row: &tokio_postgres::Row, column: &str) -> RetentionOverrides {
    let stored: Option<String> = row.try_get(column).unwrap_or_else(|error| {
        warn!(column, %error, "Unreadable retention policy column; using no overrides");
        None
    });
    RetentionOverrides::parse(stored.as_deref())
}

/// The org's (`rp`) and the source's own overrides, read with a key.
fn retention_row(row: &tokio_postgres::Row) -> RetentionRow {
    RetentionRow {
        org: retention_column(row, "org_retention_days"),
        source: retention_column(row, "source_retention_days"),
    }
}

/// A `PullSourceRow`'s columns over `sources`.
const PULL_SOURCE_COLUMNS: &str = "id, \
    (EXTRACT(EPOCH FROM paused_at) * 1000)::bigint AS paused_at_ms, \
    (EXTRACT(EPOCH FROM paused_until) * 1000)::bigint AS paused_until_ms, \
    retention_days::text AS source_retention_days";

fn pull_source_row(row: &tokio_postgres::Row) -> Result<PullSourceRow, String> {
    let decode_error =
        |error: tokio_postgres::Error| format!("postgres pull source row decode failed: {error}");
    Ok(PullSourceRow {
        id: row.try_get("id").map_err(decode_error)?,
        pause: PauseWindow {
            paused_at_ms: row.try_get("paused_at_ms").map_err(decode_error)?,
            paused_until_ms: row.try_get("paused_until_ms").map_err(decode_error)?,
        },
        retention: retention_column(row, "source_retention_days"),
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
        org_retention: retention_column(row, "org_retention_days"),
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
                let keyring = self.keyring.as_ref().ok_or_else(|| {
                    "MAPLE_INGEST_CH_PASSWORD_SLOT_KEYS or MAPLE_INGEST_KEY_ENCRYPTION_KEY is required to decrypt ClickHouse credentials".to_owned()
                })?;
                keyring.open_clickhouse_password(org_id, &row.ch_url, ciphertext, iv, tag)?
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
/// 6432, no Hyperdrive — the ECS fleet dials PlanetScale). Uses `$N` placeholders,
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

/// One multi-row upsert adding counts into `org_ingest_rule_stats`; 9 parameters per row.
/// Rows must have distinct keys, or Postgres refuses to update a row twice.
fn ingest_rule_stats_upsert_sql(rows: usize) -> String {
    let mut sql = String::from(
        "INSERT INTO org_ingest_rule_stats \
         (org_id, rule_id, bucket, signal, matched, dropped, dropped_bytes, redacted_values, parse_failed) VALUES ",
    );
    for row in 0..rows {
        let p = row * 9;
        if row > 0 {
            sql.push_str(", ");
        }
        sql.push_str(&format!(
            "(${}, ${}, to_timestamp(${}::bigint / 1000.0), ${}, ${}::bigint, ${}::bigint, ${}::bigint, ${}::bigint, ${}::bigint)",
            p + 1,
            p + 2,
            p + 3,
            p + 4,
            p + 5,
            p + 6,
            p + 7,
            p + 8,
            p + 9
        ));
    }
    sql.push_str(
        " ON CONFLICT (org_id, rule_id, bucket, signal) DO UPDATE SET \
         matched = org_ingest_rule_stats.matched + EXCLUDED.matched, \
         dropped = org_ingest_rule_stats.dropped + EXCLUDED.dropped, \
         dropped_bytes = org_ingest_rule_stats.dropped_bytes + EXCLUDED.dropped_bytes, \
         redacted_values = org_ingest_rule_stats.redacted_values + EXCLUDED.redacted_values, \
         parse_failed = org_ingest_rule_stats.parse_failed + EXCLUDED.parse_failed",
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
                // Exercises the routing and retention joins used by production lookups,
                // so a gateway ahead of their migration or grant never goes ready.
                "SELECT k.org_id, \
                        COALESCE(s.sync_status = 'connected', false) AS self_managed, \
                        ds.retention_days::text AS source_retention_days, \
                        rp.retention_days::text AS org_retention_days \
                 FROM org_ingest_keys k \
                 LEFT JOIN org_clickhouse_settings s ON s.org_id = k.org_id \
                 LEFT JOIN sources ds ON ds.org_id = k.org_id AND ds.kind = 'default' \
                 LEFT JOIN org_retention_policies rp ON rp.org_id = k.org_id \
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
                    ds.id AS default_source_id, \
                    ds.retention_days::text AS source_retention_days, \
                    rp.retention_days::text AS org_retention_days \
             FROM org_ingest_keys k \
             LEFT JOIN org_clickhouse_settings s ON s.org_id = k.org_id \
             LEFT JOIN sources ds ON ds.org_id = k.org_id AND ds.kind = 'default' \
             LEFT JOIN org_retention_policies rp ON rp.org_id = k.org_id \
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
            retention: retention_row(&row),
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
                    COALESCE(s.sync_status = 'connected' AND {SCHEMA_REVISION_COMPATIBLE_SQL}, false) AS clickhouse_ready, \
                    k.retention_days::text AS source_retention_days, \
                    rp.retention_days::text AS org_retention_days \
             FROM sources k \
             LEFT JOIN org_clickhouse_settings s ON s.org_id = k.org_id \
             LEFT JOIN org_retention_policies rp ON rp.org_id = k.org_id \
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
            retention: retention_row(&row),
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
            org_retention: retention_column(&row, "org_retention_days"),
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
                 FROM org_ingest_attribute_mappings WHERE org_id = $1 AND enabled = true \
                 ORDER BY created_at, id",
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

    async fn fetch_vercel_project_names(
        &self,
        org_id: &str,
    ) -> Result<Vec<(String, String)>, String> {
        let client = self.client().await?;
        let rows = client
            .query(
                "SELECT project_id, name FROM vercel_projects WHERE org_id = $1",
                &[&org_id],
            )
            .instrument(postgres_client_span(
                "fetch_vercel_project_names",
                "SELECT",
                "vercel_projects",
                &self.target,
            ))
            .await
            .map_err(|error| format!("postgres fetch_vercel_project_names failed: {error}"))?;
        Ok(rows
            .into_iter()
            .map(|row| (row.get("project_id"), row.get("name")))
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
        let numbers: Vec<[i64; 6]> = rows
            .iter()
            .map(|row| {
                let count = |value: u64| i64::try_from(value).unwrap_or(i64::MAX);
                [
                    row.bucket_ms,
                    count(row.counts.matched),
                    count(row.counts.dropped),
                    count(row.counts.dropped_bytes),
                    count(row.counts.redacted_values),
                    count(row.counts.parse_failed),
                ]
            })
            .collect();
        let mut params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
            Vec::with_capacity(rows.len() * 9);
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

    async fn fetch_billing_org_id(&self, org_id: &str) -> Result<Option<String>, String> {
        let client = self.client().await?;
        let row = client
            .query_opt(
                "SELECT billing_org_id FROM org_billing_links WHERE org_id = $1",
                &[&org_id],
            )
            .instrument(postgres_client_span(
                "fetch_billing_org_id",
                "SELECT",
                "org_billing_links",
                &self.target,
            ))
            .await
            .map_err(|error| format!("postgres fetch_billing_org_id failed: {error}"))?;
        Ok(row.map(|row| row.get("billing_org_id")))
    }

    async fn cookieless_salt(&self, day: &str, candidate: &str) -> Result<Option<String>, String> {
        let client = self.client().await?;
        let row = client
            .query_opt(
                "WITH inserted AS ( \
                     INSERT INTO cookieless_salts (day, salt) VALUES ($1, $2) \
                     ON CONFLICT (day) DO NOTHING RETURNING salt \
                 ) \
                 SELECT salt FROM inserted \
                 UNION ALL SELECT salt FROM cookieless_salts WHERE day = $1 \
                 LIMIT 1",
                &[&day, &candidate],
            )
            .instrument(postgres_client_span(
                "cookieless_salt",
                "INSERT",
                "cookieless_salts",
                &self.target,
            ))
            .await
            .map_err(|error| format!("postgres cookieless_salt failed: {error}"))?;
        if let Some(row) = row {
            return Ok(Some(row.get("salt")));
        }
        // A concurrent first writer committed after this statement's snapshot: read it now.
        let row = client
            .query_opt(
                "SELECT salt FROM cookieless_salts WHERE day = $1",
                &[&day],
            )
            .instrument(postgres_client_span(
                "cookieless_salt",
                "SELECT",
                "cookieless_salts",
                &self.target,
            ))
            .await
            .map_err(|error| format!("postgres cookieless_salt failed: {error}"))?;
        row.map(|row| Some(row.get("salt")))
            .ok_or_else(|| format!("no cookieless salt stored for {day}"))
    }

    async fn prune_cookieless(&self, keep_from_day: &str) -> Result<(), String> {
        let client = self.client().await?;
        client
            .execute(
                "DELETE FROM cookieless_salts WHERE day < $1",
                &[&keep_from_day],
            )
            .instrument(postgres_client_span(
                "prune_cookieless_salts",
                "DELETE",
                "cookieless_salts",
                &self.target,
            ))
            .await
            .map_err(|error| format!("postgres prune cookieless_salts failed: {error}"))?;
        client
            .execute(
                "DELETE FROM cookieless_visits WHERE last_seen_at < now() - interval '1 day'",
                &[],
            )
            .instrument(postgres_client_span(
                "prune_cookieless_visits",
                "DELETE",
                "cookieless_visits",
                &self.target,
            ))
            .await
            .map(|_| ())
            .map_err(|error| format!("postgres prune cookieless_visits failed: {error}"))
    }

    async fn touch_cookieless_visit(
        &self,
        org_id: &str,
        visitor_id: &str,
        idle_ms: i64,
    ) -> Result<bool, String> {
        let client = self.client().await?;
        // A heartbeat only extends a visit still open: a delayed one never reopens it.
        client
            .execute(
                "UPDATE cookieless_visits SET last_seen_at = now() \
                 WHERE org_id = $1 AND visitor_id = $2 \
                 AND last_seen_at >= now() - $3::bigint * interval '1 millisecond'",
                &[&org_id, &visitor_id, &idle_ms],
            )
            .instrument(postgres_client_span(
                "touch_cookieless_visit",
                "UPDATE",
                "cookieless_visits",
                &self.target,
            ))
            .await
            .map(|_| true)
            .map_err(|error| format!("postgres touch_cookieless_visit failed: {error}"))
    }

    async fn claim_cookieless_visit(
        &self,
        org_id: &str,
        visitor_id: &str,
        idle_ms: i64,
    ) -> Result<Option<bool>, String> {
        let client = self.client().await?;
        // Each claim offers a fresh token; it is stored only when the claim opens a visit.
        let token = uuid::Uuid::new_v4().to_string();
        let row = client
            .query_one(
                "INSERT INTO cookieless_visits AS v (org_id, visitor_id, visit_token, last_seen_at) \
                 VALUES ($1, $2, $3, now()) \
                 ON CONFLICT (org_id, visitor_id) DO UPDATE SET \
                     visit_token = CASE \
                         WHEN v.last_seen_at < now() - $4::bigint * interval '1 millisecond' \
                         THEN EXCLUDED.visit_token ELSE v.visit_token END, \
                     last_seen_at = now() \
                 RETURNING visit_token = $3 AS new_visit",
                &[&org_id, &visitor_id, &token, &idle_ms],
            )
            .instrument(postgres_client_span(
                "claim_cookieless_visit",
                "INSERT",
                "cookieless_visits",
                &self.target,
            ))
            .await
            .map_err(|error| format!("postgres claim_cookieless_visit failed: {error}"))?;
        Ok(Some(row.get("new_visit")))
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
            org_retention: retention_column(row, "org_retention_days"),
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

/// How long a resolved billing org is reused before `org_billing_links` is re-read.
const BILLING_ORG_CACHE_TTL: Duration = Duration::from_secs(60);
/// Long enough for one flush pass of lookups and sends; the task's stop timeout is longer.
const AUTUMN_SHUTDOWN_DEADLINE: Duration = Duration::from_secs(10);

/// Feeds the Autumn billing resolver from the key store.
struct KeyStoreBillingLookup(Arc<dyn KeyStore>);

#[async_trait::async_trait]
impl BillingOrgLookup for KeyStoreBillingLookup {
    async fn fetch_billing_org_id(&self, org_id: &str) -> Result<Option<String>, String> {
        self.0.fetch_billing_org_id(org_id).await
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
            retention: RetentionRow::default(),
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
            retention: RetentionRow::default(),
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

    async fn fetch_billing_org_id(&self, _org_id: &str) -> Result<Option<String>, String> {
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

/// HKDF-SHA256 (RFC 5869) with an empty salt, first output block only.
/// Mirrors `hkdfSha256` in `packages/backend/src/platform/SecretBox.ts`.
fn hkdf_sha256_block(input_key: &[u8], info: &[u8]) -> Result<[u8; 32], String> {
    let hmac_error = |error| format!("Invalid HKDF key: {error}");
    let mut extract = <HmacSha256 as Mac>::new_from_slice(&[0_u8; 32]).map_err(hmac_error)?;
    extract.update(input_key);
    let pseudo_random_key = extract.finalize().into_bytes();
    let mut expand = <HmacSha256 as Mac>::new_from_slice(&pseudo_random_key).map_err(hmac_error)?;
    expand.update(info);
    expand.update(&[1]);
    Ok(expand.finalize().into_bytes().into())
}

/// Length-prefixed parts, the same bytes as `secretAad` in `SecretBox.ts`.
fn secret_aad(parts: &[&str]) -> Vec<u8> {
    let mut aad = Vec::new();
    for part in parts {
        aad.extend_from_slice(format!("{}:{part},", part.len()).as_bytes());
    }
    aad
}

/// The slot name of the BYO ClickHouse password: its subkey label and first AAD part.
const CLICKHOUSE_PASSWORD_SLOT: &str = "org_clickhouse_settings.ch_password";
/// The ClickHouse password slot's subkeys, `<keyId>:<base64 subkey>` comma-separated, primary
/// first. Derived at deploy (`packages/infra/src/secret-slot-keys.ts`) so the task holds no master key.
const CH_PASSWORD_SLOT_KEYS_ENV: &str = "MAPLE_INGEST_CH_PASSWORD_SLOT_KEYS";
/// Separates row from destination in the v3 AAD, as `DESTINATION_AAD_MARKER` in `SecretBox.ts`.
const DESTINATION_AAD_MARKER: &str = "destination";

#[derive(Clone)]
struct SecretKey {
    /// Fingerprint the v2 envelope names its sealing key by.
    id: String,
    clickhouse_password_subkey: [u8; 32],
}

/// The keys stored secrets may be sealed under: the primary first, then the
/// decrypt-only ones kept across a rotation (docs/secret-encryption.md).
#[derive(Clone)]
struct SecretKeyring {
    keys: Vec<SecretKey>,
}

impl SecretKeyring {
    /// Slot keys when the deploy set them; else the master keys (self-hosted, local dev,
    /// and a task definition from before slot keys). Neither set refuses to start.
    fn from_env_values(
        slot_keys: Option<&str>,
        primary: Option<&str>,
        decrypt_only: Option<&str>,
    ) -> Result<Self, String> {
        if let Some(slot_keys) = slot_keys.filter(|raw| !raw.trim().is_empty()) {
            return Self::parse_slot_keys(slot_keys);
        }
        let primary = primary.ok_or_else(|| {
            format!("{CH_PASSWORD_SLOT_KEYS_ENV} or MAPLE_INGEST_KEY_ENCRYPTION_KEY is required")
        })?;
        Self::parse(primary, decrypt_only)
    }

    /// Parses `MAPLE_INGEST_CH_PASSWORD_SLOT_KEYS`. These keys open the ClickHouse password slot
    /// only: no other slot's subkey can be derived from them.
    fn parse_slot_keys(raw: &str) -> Result<Self, String> {
        let malformed = || {
            format!(
                "{CH_PASSWORD_SLOT_KEYS_ENV} must be comma-separated <keyId>:<base64 32-byte key> entries"
            )
        };
        let mut keys: Vec<SecretKey> = Vec::new();
        for entry in raw.split(',') {
            let entry = entry.trim();
            if entry.is_empty() {
                continue;
            }
            let (id, subkey) = entry.split_once(':').ok_or_else(malformed)?;
            let id_is_valid = URL_SAFE_NO_PAD
                .decode(id)
                .is_ok_and(|decoded| decoded.len() == 6);
            if !id_is_valid {
                return Err(malformed());
            }
            let subkey: [u8; 32] = STANDARD
                .decode(subkey)
                .ok()
                .and_then(|decoded| decoded.try_into().ok())
                .ok_or_else(malformed)?;
            if keys.iter().all(|known| known.id != id) {
                keys.push(SecretKey {
                    id: id.to_owned(),
                    clickhouse_password_subkey: subkey,
                });
            }
        }
        if keys.is_empty() {
            return Err(malformed());
        }
        Ok(Self { keys })
    }

    fn parse(primary: &str, decrypt_only: Option<&str>) -> Result<Self, String> {
        let mut keys = vec![SecretKey::new(parse_base64_aes256_gcm_key(primary)?)?];
        for raw in decrypt_only.unwrap_or_default().split(',') {
            if raw.trim().is_empty() {
                continue;
            }
            let master: [u8; 32] = STANDARD
                .decode(raw.trim())
                .ok()
                .and_then(|decoded| decoded.try_into().ok())
                .ok_or_else(|| {
                    "MAPLE_INGEST_KEY_DECRYPTION_KEYS must be comma-separated base64 keys of exactly 32 bytes"
                        .to_owned()
                })?;
            let key = SecretKey::new(master)?;
            if keys.iter().all(|known| known.id != key.id) {
                keys.push(key);
            }
        }
        Ok(Self { keys })
    }

    /// Opens `org_clickhouse_settings.ch_password_*` for `org_id`. Only `v3.<keyId>.<base64>`,
    /// bound to the org and to `ch_url` exactly as stored, is accepted: a row pointed at
    /// another host does not open.
    fn open_clickhouse_password(
        &self,
        org_id: &str,
        ch_url: &str,
        ciphertext: &str,
        iv: &str,
        tag: &str,
    ) -> Result<String, String> {
        let parts: Vec<&str> = ciphertext.split('.').collect();
        let ["v3", key_id, sealed] = parts.as_slice() else {
            return Err("Stored value is not bound to its destination".to_owned());
        };
        let aad = secret_aad(&[CLICKHOUSE_PASSWORD_SLOT, org_id, DESTINATION_AAD_MARKER, ch_url]);
        let key = self
            .keys
            .iter()
            .find(|key| key.id == *key_id)
            .ok_or_else(|| "Sealed with a key this deployment does not hold".to_owned())?;
        decrypt_aes256_gcm(
            sealed,
            iv,
            tag,
            &key.clickhouse_password_subkey,
            &aad,
        )
    }
}

impl SecretKey {
    fn new(master: [u8; 32]) -> Result<Self, String> {
        let id_block = hkdf_sha256_block(&master, b"maple/secret-box/v2/key-id")?;
        let info = format!("maple/secret-box/v2/slot/{CLICKHOUSE_PASSWORD_SLOT}");
        Ok(Self {
            id: URL_SAFE_NO_PAD.encode(&id_block[..6]),
            clickhouse_password_subkey: hkdf_sha256_block(&master, info.as_bytes())?,
        })
    }
}

fn decrypt_aes256_gcm(
    ciphertext: &str,
    iv: &str,
    tag: &str,
    key: &[u8; 32],
    aad: &[u8],
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
        .decrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: sealed.as_ref(),
                aad,
            },
        )
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
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;
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

    /// A source's use is recorded again after every interval, not once per process: the
    /// second record lands on an expired entry, which moka treats as an update.
    #[tokio::test]
    async fn source_use_is_recorded_again_after_each_interval() {
        let recent = recent_key_uses_cache();
        let interval = Duration::from_millis(40);
        let mut recorded = 0;
        for _ in 0..4 {
            if !recent.contains_key("source") {
                if recent
                    .entry("source".to_owned())
                    .or_insert(interval)
                    .await
                    .is_fresh()
                {
                    recorded += 1;
                }
            }
            tokio::time::sleep(interval * 2).await;
        }
        assert_eq!(recorded, 4);
    }

    #[tokio::test]
    async fn cors_preflight_allows_trace_context_and_sdk_headers() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/v1/traces", post(|| async { StatusCode::OK }))
            .layer(cors_layer());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let requested = "baggage,content-type,traceparent,tracestate,x-maple-ingest-key,x-maple-sdk";
        let response = reqwest::Client::new()
            .request(reqwest::Method::OPTIONS, format!("http://{addr}/v1/traces"))
            .header("origin", "https://app.example.com")
            .header("access-control-request-method", "POST")
            .header("access-control-request-headers", requested)
            .send()
            .await
            .unwrap();

        assert!(response.status().is_success());
        let allowed = response
            .headers()
            .get("access-control-allow-headers")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        for header in requested.split(',') {
            assert!(
                allowed.split(',').any(|entry| entry.trim() == header),
                "preflight must allow {header}, allowed: {allowed}"
            );
        }
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
    fn extract_ingest_key_ignores_a_value_longer_than_any_key() {
        let oversized = format!("maple_pk_{}", "a".repeat(MAX_INGEST_KEY_LEN));
        let mut bearer = HeaderMap::new();
        bearer.insert(AUTHORIZATION, format!("Bearer {oversized}").parse().unwrap());
        assert_eq!(extract_ingest_key(&bearer), None);
        let mut named = HeaderMap::new();
        named.insert("x-maple-ingest-key", oversized.parse().unwrap());
        assert_eq!(extract_ingest_key(&named), None);

        let longest = "k".repeat(MAX_INGEST_KEY_LEN);
        let mut accepted = HeaderMap::new();
        accepted.insert("x-maple-ingest-key", longest.parse().unwrap());
        assert_eq!(extract_ingest_key(&accepted), Some(longest));
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
            org_retention: RetentionOverrides::default(),
            retention: RetentionStamps::default(),
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
            org_retention: RetentionOverrides::default(),
            retention: RetentionStamps::default(),
        }
    }

    #[test]
    fn vercel_ai_gateway_requests_reach_agent_sessions_as_gateway_calls() {
        let mut decoded = decode_vercel_ai_gateway(
            br#"[{"eventType":"request","generationId":"gen_1","gatewayTimestamp":1794307651806,"requestDurationMs":1315,"responseStatusCode":200,"provider":"openai","model":"openai/gpt-4o-mini","modelType":"language","inputTokens":107,"outputTokens":33,"cost":"0.00022785","costCurrency":"USD"}]"#,
        )
        .expect("a drain delivery decodes");
        enrich_decoded_payload(&mut decoded, &test_key(), &[]);
        stamp_drain_source(&mut decoded, vercel_ai_gateway_drain::INGEST_SOURCE);
        let DecodedPayload::Traces(request) = decoded else {
            panic!("an AI Gateway delivery decodes to traces");
        };
        let resource_spans = &request.resource_spans[0];
        let string_value = |attributes: &[KeyValue], key: &str| {
            attributes
                .iter()
                .find(|attribute| attribute.key == key)
                .and_then(|attribute| match attribute.value.clone()?.value? {
                    any_value::Value::StringValue(value) => Some(value),
                    _ => None,
                })
        };
        let resource = &resource_spans.resource.as_ref().unwrap().attributes;
        assert_eq!(
            string_value(resource, "maple_ingest_source").as_deref(),
            Some(vercel_ai_gateway_drain::INGEST_SOURCE)
        );
        let span = &resource_spans.scope_spans[0].spans[0];
        assert_eq!(
            string_value(&span.attributes, ai_session::VENDOR_ID_ATTR).as_deref(),
            Some("vercel_ai_gateway")
        );
        assert_eq!(
            string_value(&span.attributes, "gen_ai.usage.cost").as_deref(),
            Some("0.00022785")
        );
    }

    #[test]
    fn vercel_logs_keep_the_drain_source_through_enrichment() {
        let mut decoded = decode_vercel_logs(br#"{"projectId":"prj_1"}"#)
            .expect("a drain delivery decodes");
        // The handler's order: enrichment, then the drain's own source.
        enrich_decoded_payload(&mut decoded, &test_key(), &[]);
        stamp_drain_source(&mut decoded, vercel_logs::INGEST_SOURCE);
        let DecodedPayload::Logs(request) = decoded else {
            panic!("a drain delivery decodes to logs");
        };
        let attributes = &request.resource_logs[0]
            .resource
            .as_ref()
            .unwrap()
            .attributes;
        let value = |key: &str| {
            attributes
                .iter()
                .find(|attribute| attribute.key == key)
                .and_then(|attribute| attribute.value.clone()?.value)
        };
        assert_eq!(
            value("maple_ingest_source"),
            Some(any_value::Value::StringValue(
                vercel_logs::INGEST_SOURCE.to_owned()
            ))
        );
        assert_eq!(
            value("maple_org_id"),
            Some(any_value::Value::StringValue("org_real".to_owned()))
        );
    }

    #[test]
    fn vercel_event_drains_reach_logs_under_their_own_source() {
        let mut decoded = decode_vercel_event_drain(
            EventDrain::AuditLog,
            br#"[{"schema":"vercel.audit_log.v1","id":"evt_1","teamId":"team_1","action":"drain-created","timestamp":1694723400000,"actor":{"type":"user","id":"usr_1","name":"Test User"}}]"#,
        )
        .expect("a drain delivery decodes");
        enrich_decoded_payload(&mut decoded, &test_key(), &[]);
        stamp_drain_source(&mut decoded, EventDrain::AuditLog.ingest_source());
        let DecodedPayload::Logs(request) = decoded else {
            panic!("an Audit Log delivery decodes to logs");
        };
        let resource_logs = &request.resource_logs[0];
        let attributes = &resource_logs.resource.as_ref().unwrap().attributes;
        let value = |key: &str| {
            attributes
                .iter()
                .find(|attribute| attribute.key == key)
                .and_then(|attribute| attribute.value.clone()?.value)
        };
        let string = |value: &str| Some(any_value::Value::StringValue(value.to_owned()));
        assert_eq!(
            value("maple_ingest_source"),
            string("vercel_audit_log_drain")
        );
        assert_eq!(value("service.name"), string("vercel-audit-log"));
        assert_eq!(value("maple_org_id"), string("org_real"));
        assert_eq!(
            resource_logs.scope_logs[0].log_records[0]
                .body
                .clone()
                .unwrap()
                .value,
            string("drain-created by Test User")
        );
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
            retention: RetentionRow::default(),
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
        // The gateway is reachable directly on its load balancer origin, so an
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

    #[test]
    fn a_refused_relay_still_counts_when_the_native_pipeline_took_the_batch() {
        let refused = false;
        assert!(!batch_was_stored(
            refused,
            WriteMode::Forward,
            ExportDestination::Tinybird
        ));
        assert!(batch_was_stored(
            refused,
            WriteMode::Dual,
            ExportDestination::Tinybird
        ));
        assert!(batch_was_stored(
            true,
            WriteMode::Forward,
            ExportDestination::Tinybird
        ));
    }

    /// In-memory KeyStore used to exercise the resolver's behavior (caching,
    /// key-type inference, ResolvedIngestKey construction) without a database.
    /// Keyed on the same `(hash, column)` shape the real key store sees.
    #[derive(Default)]
    struct FakeKeyStore {
        /// Visitor id of every `touch_cookieless_visit` call.
        cookieless_touches: std::sync::Mutex<Vec<String>>,
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
        /// `org_retention_policies.retention_days` by org id, as the jsonb reads as text.
        org_retention: std::sync::Mutex<HashMap<String, String>>,
        /// `sources.retention_days` by source id, as the jsonb reads as text.
        source_retention: std::sync::Mutex<HashMap<String, String>>,
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
        /// `org_billing_links`: sub-org to the org that pays for it.
        billing_links: std::sync::Mutex<std::collections::HashMap<String, String>>,
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
        async fn touch_cookieless_visit(
            &self,
            _org_id: &str,
            visitor_id: &str,
            _idle_ms: i64,
        ) -> Result<bool, String> {
            self.cookieless_touches
                .lock()
                .unwrap()
                .push(visitor_id.to_owned());
            Ok(false)
        }

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
                    retention: self.retention_row(&key.org_id, default_source_id.as_deref()),
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
            let row = self.sources.lock().unwrap().get(key_hash).cloned();
            Ok(row.map(|row| {
                let source_id = row.config.as_ref().map(|config| config.id.as_str());
                SourceRow {
                    retention: self.retention_row(&row.key.org_id, source_id),
                    ..row
                }
            }))
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
                org_retention: self.org_retention(&row.org_id),
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
        async fn fetch_billing_org_id(&self, org_id: &str) -> Result<Option<String>, String> {
            Ok(self.billing_links.lock().unwrap().get(org_id).cloned())
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
                org_retention: self.org_retention(&row.org_id),
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
            export_max_attempts: 1,
            clickhouse_export_timeout: Duration::from_secs(5),
            clickhouse_breaker: ClickHouseBreakerConfig::default(),
            clickhouse_allow_private_endpoints: true,
            datasources: DatasourceNames::defaults(),
            datasource_session_replays: "session_replays".to_owned(),
            datasource_session_replay_events: "session_replay_events".to_owned(),
            datasource_session_events: "session_events".to_owned(),
            datasource_product_events: "product_events".to_owned(),
            datasource_profiles: "profiles".to_owned(),
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
                max_decode_heap_bytes: 64 * 1024 * 1024,
                max_row_expansion: DEFAULT_MAX_ROW_EXPANSION,
                row_piece_bytes: ROW_PIECE_BYTES,
                decode_memory_bytes: 128 * 1024 * 1024,
                org_max_in_flight: 100,
                rate_limit_fleet_size: 1,
                gcp_org_max_in_flight: 100,
                request_timeout: Duration::from_secs(30),
                require_tls: false,
                key_store_backend: KeyStoreBackend::Static {
                    org_id: "org_test".to_owned(),
                },
                clickhouse_secret_keyring: None,
                lookup_hmac_key: "test-hmac-key".to_owned(),
                autumn_secret_key: None,
                autumn_api_url: "https://api.useautumn.com".to_owned(),
                autumn_flush_interval_secs: 1,
                autumn_allow_ttl_secs: 60,
                autumn_deny_ttl_secs: 5,
                ingest_key_cache_ttl_secs: 60,
                org_routing_cache_ttl_secs: 5,
                ingest_rules_enabled: false,
                audit_trail_enabled: false,
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
            decode_memory: DecodeMemory::new(128 * 1024 * 1024),
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
            vercel_project_name_resolver: VercelProjectNameResolver {
                store: Arc::clone(&key_store),
                cache: Cache::builder()
                    .time_to_live(VERCEL_PROJECT_NAMES_TTL)
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
            cookieless: CookielessVisitors::new(store),
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

    fn gzip_bytes(plain: impl AsRef<[u8]>) -> Bytes {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(plain.as_ref()).unwrap();
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

        // Key scheme: bucket first, then the r{days}/v1/{org}/{session}/{seq}.json.gz
        // the API side reconstructs from the ClickHouse row; no policy stamps 30 days.
        assert_eq!(
            captured.path,
            "replays/r30/v1/org_replay_blob/sess_42/00000007.json.gz"
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
            "am_sk_test".to_owned(),
            &api_url,
            // A one-second allow TTL, so a test that wants a second gate can
            // have one without a long sleep; the decision cache itself is
            // tested in `autumn.rs`.
            1,
            1,
            BillingOrgResolver::unlinked(),
        ));
        state.autumn_tracker = Some(AutumnTracker::spawn(
            "am_sk_test".to_owned(),
            &api_url,
            1,
            BillingOrgResolver::unlinked(),
        ));
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
            BillingOrgResolver::unlinked(),
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

    const VERCEL_AUDIT_DELIVERY: &str = concat!(
        r#"{"id":"evt_1","teamId":"team_1","action":"project.created","timestamp":1700000000000,"actor":{"type":"user","id":"usr_1"}}"#,
        "\n",
        r#"{"id":"evt_2","teamId":"team_1","timestamp":1700000000000}"#,
        "\n",
    );

    /// The Vercel connection's source in the fixtures, as its uuid and as the
    /// public id a drain names in `x-maple-source-id`.
    const AUDIT_SOURCE_UUID: &str = "0f8e6c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
    const AUDIT_SOURCE_ID: &str = "src_aXunrkWtzvXSkw9Z2smcft";

    /// What the fake Tinybird is sent: `(datasource, NDJSON rows)`.
    type TinybirdImports = tokio::sync::mpsc::UnboundedReceiver<(String, String)>;

    async fn fake_tinybird_import(
        State(tx): State<tokio::sync::mpsc::UnboundedSender<(String, String)>>,
        Query(query): Query<HashMap<String, String>>,
        body: Bytes,
    ) -> StatusCode {
        let rows = gunzip_bounded(&body, usize::MAX).unwrap_or_else(|_| body.to_vec());
        drop(tx.send((
            query.get("name").cloned().unwrap_or_default(),
            String::from_utf8(rows).expect("Tinybird should receive UTF-8 NDJSON"),
        )));
        StatusCode::OK
    }

    /// Turns the audit trail on, as the hosted gateway has it, with a pipeline
    /// that writes to a fake Tinybird the test can read.
    async fn store_audit_trail(
        state: &mut AppState,
        queue_dir: &std::path::Path,
    ) -> TinybirdImports {
        let imports =
            store_in_fake_tinybird(state, test_tinybird_config(queue_dir.join("audit-trail")))
                .await;
        state.config.audit_trail_enabled = true;
        imports
    }

    /// Makes `state` a gateway that writes to managed storage: a pipeline on
    /// `config` whose Tinybird is a fake the test can read.
    async fn store_in_fake_tinybird(
        state: &mut AppState,
        config: TinybirdConfig,
    ) -> TinybirdImports {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .route("/v0/events", post(fake_tinybird_import))
            .with_state(tx);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let pipeline = TelemetryPipeline::new(
            TinybirdConfig {
                endpoint,
                token: "token".to_owned(),
                ..config
            },
            Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
        )
        .await
        .expect("the fake Tinybird pipeline should start");
        state.config.write_mode = WriteMode::Tinybird;
        state.telemetry_pipeline = Some(pipeline);
        rx
    }

    /// An org with a private key and a Vercel connection whose source is
    /// `AUDIT_SOURCE_ID`, on a gateway that stores the audit trail.
    async fn audit_trail_test_state(
        raw_key: &str,
        org_id: &str,
        queue_dir: PathBuf,
    ) -> (AppState, Arc<FakeKeyStore>, TinybirdImports) {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_private(
            raw_key,
            KeyRow {
                org_id: org_id.to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        store.insert_source_row(org_id, AUDIT_SOURCE_UUID, "integration");
        let mut state = test_app_state(
            Arc::clone(&store),
            queue_dir.clone(),
            "http://127.0.0.1:1".to_owned(),
            Duration::from_secs(30),
        )
        .await;
        let imports = store_audit_trail(&mut state, &queue_dir).await;
        (state, store, imports)
    }

    /// The headers of the drain Maple creates: the key and the connection's source.
    fn vercel_drain_headers(raw_key: &str, source_id: &str) -> HeaderMap {
        let mut headers = bearer_headers(raw_key);
        headers.insert(SOURCE_ID_HEADER, source_id.parse().unwrap());
        headers
    }

    async fn vercel_audit_delivery(
        state: &AppState,
        headers: &HeaderMap,
    ) -> Result<usize, ApiError> {
        handle_vercel_audit_trail_inner(
            state,
            headers,
            &Bytes::from_static(VERCEL_AUDIT_DELIVERY.as_bytes()),
        )
        .await
    }

    async fn nothing_reaches_the_audit_trail(imports: &mut TinybirdImports) -> bool {
        tokio::time::timeout(Duration::from_millis(200), imports.recv())
            .await
            .is_err()
    }

    /// A real export of the Maple SDK's Node profiler: 498 samples, each of them a
    /// row, since every one is on a span or a stack of its own.
    const PROFILES_SDK_EXPORT: &[u8] = include_bytes!("testdata/profiles-sdk-node.json");
    const PROFILES_SDK_ROWS: usize = 498;

    /// A gateway that takes profiles and writes them to a fake Tinybird with room
    /// for an export's rows.
    async fn profiles_test_state(
        store: Arc<FakeKeyStore>,
        queue_dir: PathBuf,
    ) -> (AppState, TinybirdImports) {
        profiles_test_state_with_org_queue(store, queue_dir, 64 * 1024 * 1024).await
    }

    /// `profiles_test_state` whose pipeline holds `org_queue_max_bytes` per org.
    async fn profiles_test_state_with_org_queue(
        store: Arc<FakeKeyStore>,
        queue_dir: PathBuf,
        org_queue_max_bytes: u64,
    ) -> (AppState, TinybirdImports) {
        let mut state = test_app_state(
            store,
            queue_dir.clone(),
            "http://127.0.0.1:1".to_owned(),
            Duration::from_secs(30),
        )
        .await;
        let config = TinybirdConfig {
            queue_max_bytes: 64 * 1024 * 1024,
            org_queue_max_bytes,
            ..test_tinybird_config(queue_dir.join("profiles"))
        };
        let imports = store_in_fake_tinybird(&mut state, config).await;
        (state, imports)
    }

    fn private_key_store(raw_key: &str, org_id: &str, clickhouse_ready: bool) -> Arc<FakeKeyStore> {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_private(
            raw_key,
            KeyRow {
                org_id: org_id.to_owned(),
                self_managed: clickhouse_ready,
                clickhouse_ready,
            },
        );
        store
    }

    fn profiles_headers(raw_key: &str, content_type: &'static str) -> HeaderMap {
        let mut headers = bearer_headers(raw_key);
        headers.insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
        headers
    }

    async fn send_sdk_profiles(state: &AppState, raw_key: &str) -> Result<usize, ApiError> {
        handle_profiles_inner(
            state,
            &profiles_headers(raw_key, "application/json"),
            Bytes::from_static(PROFILES_SDK_EXPORT),
        )
        .await
        .map(|accepted| accepted.stored_rows)
    }

    /// The next `count` rows the fake Tinybird is sent, which must be profiles.
    async fn imported_profile_rows(
        imports: &mut TinybirdImports,
        count: usize,
    ) -> Vec<serde_json::Value> {
        let mut rows = Vec::new();
        while rows.len() < count {
            let (datasource, body) = tokio::time::timeout(Duration::from_secs(5), imports.recv())
                .await
                .expect("the rows should reach Tinybird")
                .expect("the Tinybird channel should stay open");
            assert_eq!(datasource, "profiles");
            rows.extend(
                body.lines()
                    .filter(|line| !line.is_empty())
                    .map(|line| serde_json::from_str(line).expect("each line is a row")),
            );
        }
        rows
    }

    async fn no_profiles_are_stored(imports: &mut TinybirdImports) -> bool {
        tokio::time::timeout(Duration::from_millis(200), imports.recv())
            .await
            .is_err()
    }

    #[tokio::test]
    async fn a_profiles_export_reaches_the_profiles_datasource_on_either_route() {
        let queue_dir = unique_main_test_dir("profiles-export");
        let key = "maple_sk_test_profiles";
        let store = private_key_store(key, "org_profiles", false);
        let (state, mut imports) = profiles_test_state(store, queue_dir.clone()).await;
        let base = serve_profiles_routes(Arc::new(state)).await;
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();

        // OTLP/JSON, as the Maple SDK sends it, on the development path.
        let response = client
            .post(format!("{base}/v1development/profiles"))
            .bearer_auth(key)
            .header(CONTENT_TYPE, "application/json")
            .header(profiles::VERSION_HEADER, "1")
            .body(PROFILES_SDK_EXPORT)
            .send()
            .await
            .expect("the gateway answers");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.text().await.unwrap(), "{}");
        let rows = imported_profile_rows(&mut imports, PROFILES_SDK_ROWS).await;
        assert_eq!(rows.len(), PROFILES_SDK_ROWS);

        // The keys are the ones the insert mapping selects, on every row, plus the
        // gateway's `retention_days`: only the managed table has that column, and an
        // org's own ClickHouse skips the key (`input_format_skip_unknown_fields`).
        let mapping = maple_ingest::clickhouse_insert_mappings::mapping_for("profiles")
            .expect("the profiles mapping");
        let mut selects: Vec<&str> = mapping
            .selects
            .iter()
            .copied()
            .filter(|select| *select != maple_ingest::clickhouse_insert_mappings::ORG_PLACEHOLDER)
            .chain(["retention_days"])
            .collect();
        selects.sort_unstable();
        for row in &rows {
            let mut keys: Vec<&str> = row
                .as_object()
                .expect("a row is an object")
                .keys()
                .map(String::as_str)
                .collect();
            keys.sort_unstable();
            assert_eq!(keys, selects);
            // The managed table reads its `OrgId` from here.
            assert_eq!(row["resource_attributes"]["maple_org_id"], "org_profiles");
            assert_eq!(row["service_name"], "checkout-api");
            assert_eq!(row["sample_type"], "cpu");
        }
        let total: i64 = rows.iter().filter_map(|row| row["value"].as_i64()).sum();
        assert_eq!(total, 1_105_584_000);
        let first = &rows[0];
        assert_eq!(first["timestamp"], "2026-11-15 12:30:07.512875000");
        assert_eq!(
            first["resource_attributes"]["maple_ingest_key_type"],
            "private"
        );
        assert_eq!(first["frames"].as_array().map(Vec::len), Some(16));

        // The same export as gzipped protobuf, on the path the spec moves to.
        let request = profiles::decode_json(PROFILES_SDK_EXPORT).expect("the export decodes");
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&request.encode_to_vec()).unwrap();
        let response = client
            .post(format!("{base}/v1/profiles"))
            .bearer_auth(key)
            .header(CONTENT_TYPE, "application/x-protobuf")
            .header(CONTENT_ENCODING, "gzip")
            .body(encoder.finish().unwrap())
            .send()
            .await
            .expect("the gateway answers");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.bytes().await.unwrap().len(), 0);
        assert_eq!(
            imported_profile_rows(&mut imports, PROFILES_SDK_ROWS).await,
            rows
        );
        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn a_profiles_export_in_another_development_version_is_refused() {
        let queue_dir = unique_main_test_dir("profiles-version");
        let key = "maple_sk_test_profiles_version";
        let store = private_key_store(key, "org_profiles_version", false);
        let (state, mut imports) = profiles_test_state(store, queue_dir.clone()).await;
        let send = |version: &'static str| {
            let state = &state;
            async move {
                let mut headers = profiles_headers(key, "application/json");
                headers.insert(profiles::VERSION_HEADER, HeaderValue::from_static(version));
                handle_profiles_inner(state, &headers, Bytes::from_static(PROFILES_SDK_EXPORT))
                    .await
                    .map(|accepted| accepted.stored_rows)
            }
        };

        let refused = send("2")
            .await
            .expect_err("version 2 is another wire layout");
        assert_eq!(refused.status, StatusCode::BAD_REQUEST);
        assert!(no_profiles_are_stored(&mut imports).await);

        assert_eq!(
            send("1").await.expect("version 1 is read"),
            PROFILES_SDK_ROWS
        );
        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn a_source_token_sends_profiles_only_when_its_signals_allow_them() {
        let queue_dir = unique_main_test_dir("profiles-source-signals");
        let store = Arc::new(FakeKeyStore::default());
        let token = |allowed: Option<&str>, attributes: &str| {
            source_row(
                "org_profiles_token",
                source_config(allowed, None, attributes),
            )
        };
        let traces_only = "maple_src_profiles_traces_and_logs_only_00000";
        let profiles_only = "maple_src_profiles_profiles_only_00000000000";
        let unscoped = "maple_src_profiles_every_signal_000000000000";
        store.insert_source(traces_only, token(Some(r#"["traces","logs"]"#), "[]"));
        store.insert_source(
            profiles_only,
            token(
                Some(r#"["profiles"]"#),
                r#"[{"key":"service.name","value":"billing","mode":"set"},
                    {"key":"service.version","value":"0.0.0","mode":"default"}]"#,
            ),
        );
        store.insert_source(unscoped, token(None, "[]"));
        let (state, mut imports) = profiles_test_state(store, queue_dir.clone()).await;

        let denied = send_sdk_profiles(&state, traces_only)
            .await
            .expect_err("a token for other signals is refused");
        assert_eq!(denied.status, StatusCode::FORBIDDEN);
        assert!(no_profiles_are_stored(&mut imports).await);

        assert_eq!(
            send_sdk_profiles(&state, profiles_only)
                .await
                .expect("a profiles token is admitted"),
            PROFILES_SDK_ROWS
        );
        let rows = imported_profile_rows(&mut imports, PROFILES_SDK_ROWS).await;
        let attributes = &rows[0]["resource_attributes"];
        assert_eq!(attributes["maple_org_id"], "org_profiles_token");
        assert_eq!(attributes["maple_ingest_key_type"], "source");
        assert_eq!(
            attributes[SOURCE_ID_ATTRIBUTE],
            sources::public_source_id(SOURCE_UUID).expect("a source id")
        );
        // The token's overrides apply before the row's columns are read.
        assert_eq!(rows[0]["service_name"], "billing");
        assert_eq!(rows[0]["service_version"], "1.4.0");

        assert_eq!(
            send_sdk_profiles(&state, unscoped)
                .await
                .expect("an unscoped token sends every signal"),
            PROFILES_SDK_ROWS
        );
        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn a_malformed_profiles_body_is_the_senders_error() {
        let queue_dir = unique_main_test_dir("profiles-malformed");
        let key = "maple_sk_test_profiles_malformed";
        let store = private_key_store(key, "org_profiles_malformed", false);
        let (state, mut imports) = profiles_test_state(store, queue_dir.clone()).await;
        // A sample on a link whose trace id is three bytes long.
        let short_id = br#"{"resourceProfiles":[{"scopeProfiles":[{"profiles":[{"samples":[{"stackIndex":1,"linkIndex":1,"values":["1"]}]}]}]}],"dictionary":{"stringTable":["","main"],"functionTable":[{},{"nameStrindex":1}],"locationTable":[{},{"lines":[{"functionIndex":1}]}],"stackTable":[{},{"locationIndices":[1]}],"linkTable":[{},{"traceId":"abcd"}]}}"#;
        let cases: [(
            &'static str,
            Option<&'static str>,
            &'static [u8],
            StatusCode,
        ); 8] = [
            (
                "application/x-protobuf",
                None,
                &[0x0f],
                StatusCode::BAD_REQUEST,
            ),
            (
                "application/x-protobuf",
                None,
                PROFILES_SDK_EXPORT,
                StatusCode::BAD_REQUEST,
            ),
            (
                "application/json",
                None,
                br#"{"resourceProfiles":"#,
                StatusCode::BAD_REQUEST,
            ),
            (
                "application/json",
                None,
                br#"{"dictionary":{"stringTable":"nope"}}"#,
                StatusCode::BAD_REQUEST,
            ),
            ("application/json", None, short_id, StatusCode::BAD_REQUEST),
            (
                "application/json",
                Some("gzip"),
                b"not gzip",
                StatusCode::BAD_REQUEST,
            ),
            (
                "application/json",
                Some("br"),
                b"{}",
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ),
            (
                "text/plain",
                None,
                b"{}",
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ),
        ];
        for (content_type, encoding, body, status) in cases {
            let mut headers = profiles_headers(key, content_type);
            if let Some(encoding) = encoding {
                headers.insert(CONTENT_ENCODING, HeaderValue::from_static(encoding));
            }
            let refused = handle_profiles_inner(&state, &headers, Bytes::from_static(body))
                .await
                .expect_err("a malformed body is refused");
            assert_eq!(refused.status, status, "{content_type} {encoding:?}");
        }
        assert!(no_profiles_are_stored(&mut imports).await);

        // An export with nothing in it is accepted and stores nothing.
        let empty = handle_profiles_inner(
            &state,
            &profiles_headers(key, "application/json"),
            Bytes::from_static(b"{}"),
        )
        .await;
        assert_eq!(
            empty.expect("an empty export is not an error"),
            ProfilesAccepted::default()
        );
        drop(std::fs::remove_dir_all(&queue_dir));
    }

    // The `profiles` table is not required on an org's own ClickHouse, so its rows
    // go to managed storage whatever warehouse the org's other telemetry is in.
    #[tokio::test]
    async fn profiles_of_an_org_on_its_own_clickhouse_go_to_managed_storage() {
        let queue_dir = unique_main_test_dir("profiles-own-clickhouse");
        let key = "maple_sk_test_profiles_byo";
        let store = private_key_store(key, "org_profiles_byo", true);
        let (state, mut imports) = profiles_test_state(store, queue_dir.clone()).await;

        assert_eq!(
            send_sdk_profiles(&state, key)
                .await
                .expect("the export is accepted"),
            PROFILES_SDK_ROWS
        );
        let rows = imported_profile_rows(&mut imports, PROFILES_SDK_ROWS).await;
        assert_eq!(
            rows[0]["resource_attributes"]["maple_org_id"],
            "org_profiles_byo"
        );
        drop(std::fs::remove_dir_all(&queue_dir));
    }

    // A gateway that only forwards, or only writes to an org's own ClickHouse, has
    // nowhere to put profiles.
    #[tokio::test]
    async fn a_gateway_without_managed_storage_refuses_profiles() {
        let queue_dir = unique_main_test_dir("profiles-no-managed-storage");
        let key = "maple_sk_test_profiles_forward";
        let state = test_app_state(
            private_key_store(key, "org_profiles_forward", true),
            queue_dir.clone(),
            "http://127.0.0.1:1".to_owned(),
            Duration::from_secs(30),
        )
        .await;

        let refused = send_sdk_profiles(&state, key)
            .await
            .expect_err("there is no managed storage to write to");
        assert_eq!(refused.status, StatusCode::SERVICE_UNAVAILABLE);
        drop(std::fs::remove_dir_all(&queue_dir));
    }

    /// Both routes of a gateway on `state`, and the base URL they are served on.
    async fn serve_profiles_routes(state: Arc<AppState>) -> String {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = with_profiles_routes(Router::new()).with_state(state);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        base
    }

    // Profiles are a plan feature: checked before the body is read, billed in GB once stored.
    #[tokio::test]
    async fn profiles_are_gated_and_billed_on_the_profiles_feature() {
        let queue_dir = unique_main_test_dir("profiles-billing");
        let key = "maple_sk_test_profiles_billing";
        let store = private_key_store(key, "org_profiles_billing", false);
        let (state, mut imports) = profiles_test_state(store, queue_dir.clone()).await;
        let (state, mut rx) = with_fake_autumn(state).await;

        assert_eq!(
            send_sdk_profiles(&state, key).await.expect("an allowed org stores profiles"),
            PROFILES_SDK_ROWS
        );
        assert_eq!(
            imported_profile_rows(&mut imports, PROFILES_SDK_ROWS).await.len(),
            PROFILES_SDK_ROWS
        );
        let calls = drain_autumn_calls(&mut rx).await;
        assert!(checks(&calls)
            .iter()
            .any(|call| call.feature_id() == PROFILES_FEATURE_ID));
        let billed = tracked(&calls);
        assert_eq!(billed.len(), 1, "{billed:?}");
        assert_eq!(billed[0].0, PROFILES_FEATURE_ID);
        let expected = billable_gb(PROFILES_SDK_EXPORT.len() as u64);
        assert!((billed[0].1 - expected).abs() < 1e-12, "{billed:?}");

        // An org Autumn denies is refused before anything is decoded or stored.
        let denied_dir = unique_main_test_dir("profiles-billing-denied");
        let store = private_key_store(key, "org_profiles_denied", false);
        let (state, mut imports) = profiles_test_state(store, denied_dir.clone()).await;
        let state = with_autumn_denying(state, "org_profiles_denied").await;
        let refused = send_sdk_profiles(&state, key)
            .await
            .expect_err("a denied org is refused");
        assert_eq!(refused.status, StatusCode::PAYMENT_REQUIRED);
        assert_eq!(state.decode_memory.reserved_bytes(), 0);
        assert!(no_profiles_are_stored(&mut imports).await);
        drop(std::fs::remove_dir_all(&queue_dir));
        drop(std::fs::remove_dir_all(&denied_dir));
    }

    // A refused commit bills nothing, whatever it stored before the refusal: the resend bills the
    // whole export, once. Any commit error returns before usage is recorded.
    #[tokio::test]
    async fn a_refused_profiles_commit_bills_nothing_and_its_resend_bills_once() {
        let key = "maple_sk_test_profiles_refused_billing";
        let refused_dir = unique_main_test_dir("profiles-refused-billing");
        let store = private_key_store(key, "org_profiles_refused_billing", false);
        // The org's queue cannot hold the export, so the commit is refused.
        let (state, mut imports) =
            profiles_test_state_with_org_queue(store, refused_dir.clone(), 100 * 1024).await;
        let (state, mut rx) = with_fake_autumn(state).await;
        let refused = send_sdk_profiles(&state, key)
            .await
            .expect_err("the export is past the org's queue");
        assert_eq!(refused.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(no_profiles_are_stored(&mut imports).await);
        assert!(tracked(&drain_autumn_calls(&mut rx).await).is_empty());

        // The resend to a gateway with room is stored and billed whole, once.
        let resent_dir = unique_main_test_dir("profiles-resent-billing");
        let store = private_key_store(key, "org_profiles_refused_billing", false);
        let (state, mut imports) = profiles_test_state(store, resent_dir.clone()).await;
        let (state, mut rx) = with_fake_autumn(state).await;
        assert_eq!(
            send_sdk_profiles(&state, key).await.expect("the resend is stored"),
            PROFILES_SDK_ROWS
        );
        assert_eq!(
            imported_profile_rows(&mut imports, PROFILES_SDK_ROWS).await.len(),
            PROFILES_SDK_ROWS
        );
        let calls = drain_autumn_calls(&mut rx).await;
        let billed = tracked(&calls);
        assert_eq!(billed.len(), 1, "{billed:?}");
        let expected = billable_gb(PROFILES_SDK_EXPORT.len() as u64);
        assert!((billed[0].1 - expected).abs() < 1e-12, "{billed:?}");
        drop(std::fs::remove_dir_all(&refused_dir));
        drop(std::fs::remove_dir_all(&resent_dir));
    }

    // The spec's development path and the path it moves to both take an export.
    #[tokio::test]
    async fn both_profiles_routes_take_an_export() {
        let queue_dir = unique_main_test_dir("profiles-routes");
        let key = "maple_sk_test_profiles_routes";
        let store = private_key_store(key, "org_profiles_routes", false);
        let (state, mut imports) = profiles_test_state(store, queue_dir.clone()).await;
        let base = serve_profiles_routes(Arc::new(state)).await;
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        for route in PROFILES_ROUTES {
            let response = client
                .post(format!("{base}{route}"))
                .bearer_auth(key)
                .header(CONTENT_TYPE, "application/json")
                .body(PROFILES_SDK_EXPORT)
                .send()
                .await
                .expect("the gateway answers");
            assert_eq!(response.status(), StatusCode::OK, "{route}");
            let rows = imported_profile_rows(&mut imports, PROFILES_SDK_ROWS).await;
            assert_eq!(rows.len(), PROFILES_SDK_ROWS);
        }
        drop(std::fs::remove_dir_all(&queue_dir));
    }

    /// A protobuf export of `samples` samples on one short stack, each on a link of
    /// its own and so a row of its own: small on the wire, many times that as rows.
    fn profiles_export_of_many_rows(samples: i32) -> ExportProfilesServiceRequest {
        let mut request = profiles::decode_json(
            br#"{"resourceProfiles":[{"scopeProfiles":[{"profiles":[{}]}]}],"dictionary":{"stringTable":["","main"],"functionTable":[{},{"nameStrindex":1}],"locationTable":[{},{"lines":[{"functionIndex":1}]}],"stackTable":[{},{"locationIndices":[1]}]}}"#,
        )
        .expect("the export decodes");
        let sample = |link_index| opentelemetry_proto::tonic::profiles::v1development::Sample {
            stack_index: 1,
            link_index,
            values: vec![1],
            ..Default::default()
        };
        request.resource_profiles[0].scope_profiles[0].profiles[0].samples =
            (0..samples).map(sample).collect();
        request
    }

    // The decoded export and its rows share the one decode heap ceiling, so the
    // process-wide memory, sized for one request at every ceiling, always holds them.
    #[tokio::test]
    async fn a_profiles_export_that_can_never_fit_is_too_large_and_only_contention_is_busy() {
        let queue_dir = unique_main_test_dir("profiles-never-fits");
        let key = "maple_sk_test_profiles_never_fits";
        let store = private_key_store(key, "org_profiles_never_fits", false);
        let (mut state, mut imports) = profiles_test_state(store, queue_dir.clone()).await;
        // Large enough that its decode outgrows the row-piece room the sizing adds.
        let body = Bytes::from(profiles_export_of_many_rows(80_000).encode_to_vec());
        let estimate = decode_budget::protobuf_cost(OtlpSignal::Profiles, &body, u64::MAX)
            .expect("an unbounded estimate");
        // Under every ceiling: the body, and a decode that takes half the heap.
        assert!(body.len() <= state.config.max_request_body_bytes);
        state.config.max_decoded_body_bytes = state.config.max_request_body_bytes;
        state.config.max_decode_heap_bytes = 2 * estimate;
        // Process-wide memory as the config sizes it, with nothing to spare. The body,
        // the decode and a heap ceiling of rows on top of them would not fit in it.
        state.decode_memory = DecodeMemory::new(largest_decode_request_bytes(
            state.config.max_request_body_bytes,
            state.config.max_decoded_body_bytes,
            state.config.max_decode_heap_bytes,
        ));
        let rows_on_top = body.len() as u64 + estimate + state.config.max_decode_heap_bytes;
        assert!(rows_on_top > state.decode_memory.total_bytes());
        let headers = profiles_headers(key, "application/x-protobuf");

        // An idle gateway, twice: the answer never depends on what a retry finds.
        for _ in 0..2 {
            let refused = handle_profiles_inner(&state, &headers, body.clone())
                .await
                .expect_err("the rows do not fit one request's decode heap");
            assert_eq!(refused.status, StatusCode::PAYLOAD_TOO_LARGE);
            assert!(!refused.kind.retryable);
            assert_eq!(state.decode_memory.reserved_bytes(), 0);
        }
        assert!(no_profiles_are_stored(&mut imports).await);

        // The same gateway with its decode memory held by other requests is busy.
        let mut others = state.decode_memory.reservation();
        assert!(others.try_add(state.decode_memory.total_bytes() - 1024));
        let busy = send_sdk_profiles(&state, key)
            .await
            .expect_err("there is no decode memory left");
        assert_eq!(busy.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(busy.error_kind(), "decode_busy");
        assert!(busy.kind.retryable);
        drop(others);
        assert_eq!(
            send_sdk_profiles(&state, key)
                .await
                .expect("an export that fits is accepted once memory is free"),
            PROFILES_SDK_ROWS
        );
        drop(std::fs::remove_dir_all(&queue_dir));
    }

    /// An export of `small` one-frame rows, one row of a stack at the depth cap whose
    /// frames are `name_len` characters each, then five more one-frame rows.
    fn profiles_export_with_one_large_row(small: usize, name_len: usize) -> Bytes {
        fn sample(stack: usize, link: usize) -> serde_json::Value {
            serde_json::json!({ "stackIndex": stack, "linkIndex": link, "values": ["1"] })
        }
        let mut samples: Vec<serde_json::Value> = (0..small).map(|link| sample(1, link)).collect();
        samples.push(sample(2, 0));
        samples.extend((small..small + 5).map(|link| sample(1, link)));
        let request = serde_json::json!({
            "resourceProfiles": [{ "scopeProfiles": [{ "profiles": [{ "samples": samples }] }] }],
            "dictionary": {
                "stringTable": ["", "main", "x".repeat(name_len)],
                "functionTable": [{}, { "nameStrindex": 1 }, { "nameStrindex": 2 }],
                "locationTable": [
                    {},
                    { "lines": [{ "functionIndex": 1 }] },
                    { "lines": [{ "functionIndex": 2 }] },
                ],
                "stackTable": [
                    {},
                    { "locationIndices": [1] },
                    { "locationIndices": vec![2; profiles::MAX_STACK_DEPTH] },
                ],
            },
        });
        Bytes::from(serde_json::to_vec(&request).expect("the export encodes"))
    }

    // A profile carries the same resource as the org's traces and logs, so every redact rule
    // runs on it, whatever signals it names and ignoring conditions written for spans.
    #[tokio::test]
    async fn a_profiles_export_is_redacted_by_every_redact_rule() {
        let queue_dir = unique_main_test_dir("profiles-redacted");
        let key = "maple_sk_test_profiles_redacted";
        let org = "org_profiles_redacted";
        let store = private_key_store(key, org, false);
        store.set_ingest_rules(
            org,
            &[
                serde_json::json!({
                    "signals": ["logs"],
                    "conditions": [],
                    "action": { "_tag": "redact", "keys": [], "detectors": ["email"], "patterns": [],
                        "scopes": ["attributes", "resource"], "method": "mask" }
                }),
                serde_json::json!({
                    "signals": ["traces"],
                    "conditions": [{ "field": "name", "op": "eq", "value": "GET /never" }],
                    "action": { "_tag": "redact", "keys": ["deploy.secret"], "detectors": [],
                        "patterns": [], "scopes": ["resource"], "method": "remove" }
                }),
            ],
        );
        let (state, mut imports) = profiles_test_state(Arc::clone(&store), queue_dir.clone()).await;
        let state = with_ingest_rules(state, &store);
        let request = serde_json::json!({
            "resourceProfiles": [{
                "resource": { "attributes": [
                    { "key": "service.name", "value": { "stringValue": "checkout" } },
                    { "key": "owner", "value": { "stringValue": "jane@example.com" } },
                    { "key": "deploy.secret", "value": { "stringValue": "s3cr3t" } },
                ] },
                "scopeProfiles": [{ "profiles": [{ "samples": [
                    { "stackIndex": 1, "attributeIndices": [1, 2], "values": ["1"] },
                ] }] }],
            }],
            "dictionary": {
                "stringTable": ["", "main", "customer", "contact", "eve@example.com"],
                "functionTable": [{}, { "nameStrindex": 1 }],
                "locationTable": [{}, { "lines": [{ "functionIndex": 1 }] }],
                "stackTable": [{}, { "locationIndices": [1] }],
                "attributeTable": [
                    {},
                    { "keyStrindex": 2, "value": { "stringValue": "bob@example.com" } },
                    // A value held in the string table is scanned like an inline one.
                    { "keyStrindex": 3, "value": { "stringValueStrindex": 4 } },
                ],
            },
        });
        let body = Bytes::from(serde_json::to_vec(&request).expect("the export encodes"));

        let headers = profiles_headers(key, "application/json");
        let accepted = handle_profiles_inner(&state, &headers, body)
            .await
            .expect("the export is accepted");
        assert_eq!(accepted.stored_rows, 1);
        let rows = imported_profile_rows(&mut imports, 1).await;
        let resource = &rows[0]["resource_attributes"];
        assert_eq!(resource["service.name"], "checkout");
        assert_eq!(resource["owner"], "[REDACTED:email]");
        assert!(resource.get("deploy.secret").is_none(), "{resource}");
        assert_eq!(rows[0]["sample_attributes"]["customer"], "[REDACTED:email]");
        assert_eq!(rows[0]["sample_attributes"]["contact"], "[REDACTED:email]");
        drop(std::fs::remove_dir_all(&queue_dir));
    }

    // Many tiny inlined copies are reserved from the process-wide budget in steps, not each
    // rounded up to a KiB: 40,000 one-byte copies would otherwise ask for about 39 MiB.
    #[tokio::test]
    async fn many_tiny_inlined_copies_fit_the_decode_memory_they_use() {
        const ENTRIES: usize = 20_000;
        let queue_dir = unique_main_test_dir("profiles-redact-tiny");
        let key = "maple_sk_test_profiles_redact_tiny";
        let org = "org_profiles_redact_tiny";
        let store = private_key_store(key, org, false);
        store.set_ingest_rules(org, &[mask_emails_rule()]);
        let (state, mut imports) = profiles_test_state(Arc::clone(&store), queue_dir.clone()).await;
        let mut state = with_ingest_rules(state, &store);
        let mut table = vec![serde_json::json!({})];
        table.extend(
            (0..ENTRIES).map(|_| serde_json::json!({ "keyStrindex": 2, "value": { "stringValueStrindex": 3 } })),
        );
        let request = serde_json::json!({
            "resourceProfiles": [{ "scopeProfiles": [{ "profiles": [{ "samples": [
                { "stackIndex": 1, "attributeIndices": [1], "values": ["1"] },
            ] }] }] }],
            "dictionary": {
                "stringTable": ["", "main", "k", "v"],
                "functionTable": [{}, { "nameStrindex": 1 }],
                "locationTable": [{}, { "lines": [{ "functionIndex": 1 }] }],
                "stackTable": [{}, { "locationIndices": [1] }],
                "attributeTable": table,
            },
        });
        let body = Bytes::from(serde_json::to_vec(&request).expect("the export encodes"));
        let estimate = decode_budget::json_cost(&body, u64::MAX).expect("an unbounded estimate");
        // The export, its decode and 16 MiB to spare: room for the copies, not for a KiB each.
        state.decode_memory = DecodeMemory::new(body.len() as u64 + estimate + 16 * 1024 * 1024);
        let headers = profiles_headers(key, "application/json");

        let accepted = handle_profiles_inner(&state, &headers, body)
            .await
            .expect("an idle gateway holds the copies");
        assert_eq!(accepted.stored_rows, 1);
        assert_eq!(imported_profile_rows(&mut imports, 1).await.len(), 1);
        assert_eq!(state.decode_memory.reserved_bytes(), 0);
        drop(std::fs::remove_dir_all(&queue_dir));
    }

    // A source's overrides land on the resource before the org's rules run, as on traces and
    // logs, so a rule redacts an override's value too. A key at string-table index 0 reads as
    // empty in redaction and in the stored row alike, whatever the sender put there.
    #[tokio::test]
    async fn profiles_are_redacted_after_the_source_overrides_land() {
        let queue_dir = unique_main_test_dir("profiles-overrides-redacted");
        let org = "org_profiles_overrides_redacted";
        let token = "maple_src_profiles_overrides_redacted_000000";
        let store = Arc::new(FakeKeyStore::default());
        store.insert_source(
            token,
            source_row(
                org,
                source_config(
                    None,
                    None,
                    r#"[{"key":"team.secret","value":"s3cr3t","mode":"set"},
                        {"key":"owner","value":"ops@example.com","mode":"set"},
                        {"key":"region.secret","value":"eu","mode":"default"}]"#,
                ),
            ),
        );
        store.set_ingest_rules(
            org,
            &[
                serde_json::json!({
                    "signals": ["traces"], "conditions": [],
                    "action": { "_tag": "redact", "keys": ["*.secret", "password"], "detectors": [],
                        "patterns": [], "scopes": ["resource"], "method": "remove" }
                }),
                serde_json::json!({
                    "signals": ["logs"], "conditions": [],
                    "action": { "_tag": "redact", "keys": [], "detectors": ["email"], "patterns": [],
                        "scopes": ["resource"], "method": "mask" }
                }),
            ],
        );
        let (state, mut imports) = profiles_test_state(Arc::clone(&store), queue_dir.clone()).await;
        let state = with_ingest_rules(state, &store);
        let request = serde_json::json!({
            "resourceProfiles": [{
                "resource": { "attributes": [
                    { "key": "service.name", "value": { "stringValue": "checkout" } },
                    { "keyStrindex": 0, "value": { "stringValue": "hunter2" } },
                ] },
                "scopeProfiles": [{ "profiles": [{ "samples": [
                    { "stackIndex": 1, "values": ["1"] },
                ] }] }],
            }],
            "dictionary": {
                "stringTable": ["password", "main"],
                "functionTable": [{}, { "nameStrindex": 1 }],
                "locationTable": [{}, { "lines": [{ "functionIndex": 1 }] }],
                "stackTable": [{}, { "locationIndices": [1] }],
            },
        });
        let body = Bytes::from(serde_json::to_vec(&request).expect("the export encodes"));
        let headers = profiles_headers(token, "application/json");

        let accepted = handle_profiles_inner(&state, &headers, body)
            .await
            .expect("the export is accepted");
        assert_eq!(accepted.stored_rows, 1);
        let rows = imported_profile_rows(&mut imports, 1).await;
        let resource = rows[0]["resource_attributes"]
            .as_object()
            .expect("resource attributes are a map");
        assert_eq!(resource["service.name"], "checkout");
        // A `set` override a remove rule names is gone, a `default` one too.
        assert!(!resource.contains_key("team.secret"), "{resource:?}");
        assert!(!resource.contains_key("region.secret"), "{resource:?}");
        // A `set` override a mask rule matches is masked.
        assert_eq!(resource["owner"], "[REDACTED:email]");
        // Index 0 is the empty key, never the sender's "password".
        assert!(!resource.contains_key("password"), "{resource:?}");
        assert!(resource.values().all(|value| value != "hunter2"), "{resource:?}");
        drop(std::fs::remove_dir_all(&queue_dir));
    }

    // Inlining one shared string into every entry that names it is the sender's bytes many
    // times over, so the copies are charged to the decode heap before they are made.
    #[tokio::test]
    async fn redacting_a_profiles_export_charges_the_text_it_inlines() {
        const ENTRIES: usize = 10_000;
        let queue_dir = unique_main_test_dir("profiles-redact-inline");
        let key = "maple_sk_test_profiles_redact_inline";
        let org = "org_profiles_redact_inline";
        let store = private_key_store(key, org, false);
        store.set_ingest_rules(org, &[mask_emails_rule()]);
        let (state, mut imports) = profiles_test_state(Arc::clone(&store), queue_dir.clone()).await;
        let mut state = with_ingest_rules(state, &store);
        state.config.max_decode_heap_bytes = 64 * 1024 * 1024;
        let mut table = vec![serde_json::json!({})];
        table.extend(
            (0..ENTRIES).map(|_| serde_json::json!({ "keyStrindex": 2, "value": { "stringValueStrindex": 3 } })),
        );
        let request = serde_json::json!({
            "resourceProfiles": [{ "scopeProfiles": [{ "profiles": [{ "samples": [
                { "stackIndex": 1, "attributeIndices": [1], "values": ["1"] },
            ] }] }] }],
            "dictionary": {
                "stringTable": ["", "main", "k", "x".repeat(64 * 1024)],
                "functionTable": [{}, { "nameStrindex": 1 }],
                "locationTable": [{}, { "lines": [{ "functionIndex": 1 }] }],
                "stackTable": [{}, { "locationIndices": [1] }],
                "attributeTable": table,
            },
        });
        let body = Bytes::from(serde_json::to_vec(&request).expect("the export encodes"));
        assert!(body.len() <= state.config.max_request_body_bytes);
        let headers = profiles_headers(key, "application/json");

        let refused = handle_profiles_inner(&state, &headers, body)
            .await
            .expect_err("the inlined copies are past the decode heap ceiling");
        assert_eq!(refused.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(!refused.kind.retryable);
        assert_eq!(state.decode_memory.reserved_bytes(), 0);
        assert!(no_profiles_are_stored(&mut imports).await);
        drop(std::fs::remove_dir_all(&queue_dir));
    }

    // A profiles export is reserved whole before its first frame, as a planned OTLP
    // request is: one past the org's queue stores nothing, so a resend never doubles rows.
    #[tokio::test]
    async fn a_profiles_export_past_the_org_queue_is_refused_before_any_frame() {
        const SMALL_ROWS: usize = 100;
        let queue_dir = unique_main_test_dir("profiles-whole-commit");
        let key = "maple_sk_test_profiles_whole";
        let store = private_key_store(key, "org_profiles_whole", false);
        // The org's queue holds half an export batch: the small rows' frame alone
        // would fit, the export with its large row never does.
        let (mut state, mut imports) =
            profiles_test_state_with_org_queue(store, queue_dir.clone(), 100 * 1024).await;
        state.config.tinybird.batch_max_bytes = 200 * 1024;
        let headers = profiles_headers(key, "application/json");

        let refused = handle_profiles_inner(
            &state,
            &headers,
            profiles_export_with_one_large_row(SMALL_ROWS, 700),
        )
        .await
        .expect_err("the export is past the org's queue");
        assert_eq!(refused.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(refused.error_kind(), INGEST_ROWS_EXCEED_QUEUE.error_kind);
        assert!(
            refused.message.contains("No data was written"),
            "{}",
            refused.message
        );
        assert!(no_profiles_are_stored(&mut imports).await);

        // Nothing stays reserved: an export that fits is stored whole afterwards.
        let accepted = handle_profiles_inner(
            &state,
            &headers,
            profiles_export_with_one_large_row(SMALL_ROWS, 1),
        )
        .await
        .expect("an export under the org's queue is accepted");
        assert_eq!(accepted.stored_rows, SMALL_ROWS + 6);
        assert_eq!(
            imported_profile_rows(&mut imports, SMALL_ROWS + 6).await.len(),
            SMALL_ROWS + 6
        );
        drop(std::fs::remove_dir_all(&queue_dir));
    }

    // Each row repeats a whole stack, so stored bytes are held to
    // `INGEST_MAX_ROW_EXPANSION` times the decoded export, like the OTLP signals.
    // The SDK's JSON export stores about 8 to 10 times its size.
    #[tokio::test]
    async fn a_profiles_export_past_the_row_expansion_ceiling_is_refused() {
        let queue_dir = unique_main_test_dir("profiles-row-expansion");
        let key = "maple_sk_test_profiles_expansion";
        let store = private_key_store(key, "org_profiles_expansion", false);
        let (mut state, mut imports) = profiles_test_state(store, queue_dir.clone()).await;

        state.config.max_row_expansion = 4;
        let refused = send_sdk_profiles(&state, key)
            .await
            .expect_err("the rows store more than 4 times the export");
        assert_eq!(refused.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(refused.error_kind(), INGEST_ROW_EXPANSION.error_kind);
        assert!(!refused.kind.retryable);
        assert_eq!(state.decode_memory.reserved_bytes(), 0);
        assert!(no_profiles_are_stored(&mut imports).await);

        // Under the ceiling, and with it off, the same export is stored.
        for ceiling in [16, 0] {
            state.config.max_row_expansion = ceiling;
            assert_eq!(
                send_sdk_profiles(&state, key)
                    .await
                    .expect("the export fits"),
                PROFILES_SDK_ROWS
            );
            assert_eq!(
                imported_profile_rows(&mut imports, PROFILES_SDK_ROWS)
                    .await
                    .len(),
                PROFILES_SDK_ROWS
            );
        }
        drop(std::fs::remove_dir_all(&queue_dir));
    }

    // The sender learns what was left out, in the encoding it sent.
    #[tokio::test]
    async fn an_export_that_lost_rows_answers_with_a_partial_success() {
        let accepted = ProfilesAccepted {
            stored_rows: 8,
            dropped_rows: 3,
            rejected_profiles: 2,
        };
        let body = |content_type: &'static str, accepted| async move {
            let mut headers = HeaderMap::new();
            headers.insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
            let response = profiles_export_response(&headers, accepted);
            axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap()
        };

        let json: serde_json::Value =
            serde_json::from_slice(&body("application/json", accepted).await).unwrap();
        assert_eq!(json["partialSuccess"]["rejectedProfiles"], 2);
        assert!(json["partialSuccess"]["errorMessage"]
            .as_str()
            .unwrap()
            .starts_with("3 profile rows"));

        let protobuf =
            ExportProfilesServiceResponse::decode(body("application/x-protobuf", accepted).await)
                .unwrap();
        assert_eq!(protobuf.partial_success.unwrap().rejected_profiles, 2);

        // A full success stays the empty response.
        let full = ProfilesAccepted {
            stored_rows: 8,
            ..Default::default()
        };
        assert_eq!(&body("application/json", full).await[..], b"{}");
        assert!(body("application/x-protobuf", full).await.is_empty());
    }

    // A row larger than one export batch is left out and the rest of the export stored.
    #[tokio::test]
    async fn a_profile_row_larger_than_an_export_batch_is_dropped_not_committed() {
        let queue_dir = unique_main_test_dir("profiles-row-ceiling");
        let key = "maple_sk_test_profiles_row_ceiling";
        let store = private_key_store(key, "org_profiles_row_ceiling", false);
        let (mut state, mut imports) = profiles_test_state(store, queue_dir.clone()).await;
        state.config.tinybird.batch_max_bytes = 64 * 1024;

        let stored = handle_profiles_inner(
            &state,
            &profiles_headers(key, "application/json"),
            profiles_export_with_one_large_row(3, 700),
        )
        .await
        .expect("the rows that fit are accepted");
        assert_eq!(
            stored,
            ProfilesAccepted {
                stored_rows: 8,
                dropped_rows: 1,
                rejected_profiles: 1,
            }
        );
        let rows = imported_profile_rows(&mut imports, 8).await;
        assert_eq!(rows.len(), 8);
        for row in &rows {
            assert_eq!(row["frames"], serde_json::json!(["main"]));
        }
        assert!(no_profiles_are_stored(&mut imports).await);
        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[test]
    fn a_profile_row_never_outgrows_an_export_batch() {
        assert_eq!(
            profile_row_max_bytes(4 * 1024 * 1024),
            profiles::MAX_ROW_BYTES - 1
        );
        assert_eq!(
            profile_row_max_bytes(64 * 1024 * 1024),
            profiles::MAX_ROW_BYTES - 1
        );
        assert_eq!(profile_row_max_bytes(1024), 1023);
    }

    #[test]
    fn profile_rows_are_committed_in_runs_no_longer_than_an_export_batch() {
        let row = |len: usize| vec![b'x'; len];
        let lens = |chunks: Vec<Vec<Vec<u8>>>| -> Vec<Vec<usize>> {
            chunks
                .into_iter()
                .map(|chunk| chunk.iter().map(Vec::len).collect())
                .collect()
        };
        // Each row counts its newline: 4 + 5 fits in 10, a third row does not.
        assert_eq!(
            lens(chunk_rows(
                vec![row(3), row(4), row(3), row(20), row(1)],
                10
            )),
            vec![vec![3, 4], vec![3], vec![20], vec![1]]
        );
        assert_eq!(lens(chunk_rows(Vec::new(), 10)), Vec::<Vec<usize>>::new());
    }

    #[tokio::test]
    async fn vercel_audit_drain_stores_each_event_that_names_an_action() {
        let queue_dir = unique_main_test_dir("vercel-audit-trail");
        let (state, _store, mut imports) =
            audit_trail_test_state("maple_sk_test_audit", "org_audit", queue_dir.clone()).await;

        let accepted = vercel_audit_delivery(
            &state,
            &vercel_drain_headers("maple_sk_test_audit", AUDIT_SOURCE_ID),
        )
        .await
        .expect("the drain's delivery should be accepted");

        // The second event names no action: there is nothing to say happened.
        assert_eq!(accepted, 1);
        let (datasource, rows) = tokio::time::timeout(Duration::from_secs(2), imports.recv())
            .await
            .expect("the event should reach Tinybird")
            .expect("the Tinybird channel should stay open");
        assert_eq!(datasource, "audit_trail_events");
        let row: serde_json::Value = serde_json::from_str(rows.trim()).expect("one NDJSON row");
        assert_eq!(
            (
                row["OrgId"].as_str(),
                row["ProviderEventId"].as_str(),
                row["Action"].as_str()
            ),
            (Some("org_audit"), Some("evt_1"), Some("project.created"))
        );
        drop(std::fs::remove_dir_all(&queue_dir));
    }

    // The integration's health reads its own source's last use; the key's default
    // source has nothing to say about whether the audit drain delivers.
    #[tokio::test]
    async fn vercel_audit_drain_records_use_of_the_integrations_source() {
        let queue_dir = unique_main_test_dir("vercel-audit-trail-source-use");
        let (state, store, _imports) =
            audit_trail_test_state("maple_sk_test_use", "org_use", queue_dir.clone()).await;

        vercel_audit_delivery(
            &state,
            &vercel_drain_headers("maple_sk_test_use", AUDIT_SOURCE_ID),
        )
        .await
        .expect("the drain's delivery should be accepted");

        for _ in 0..50 {
            if !store.source_uses.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            *store.source_uses.lock().unwrap(),
            vec![AUDIT_SOURCE_UUID.to_owned()]
        );
        drop(std::fs::remove_dir_all(&queue_dir));
    }

    // The drain Maple creates sends the private key and names the connection's
    // source. Any other sender could write the org an audit event it made up.
    #[tokio::test]
    async fn vercel_audit_drain_refuses_a_sender_that_is_not_the_orgs_drain() {
        let queue_dir = unique_main_test_dir("vercel-audit-trail-senders");
        let (state, store, mut imports) =
            audit_trail_test_state("maple_sk_test_senders", "org_senders", queue_dir.clone()).await;
        // The public key ships in browser bundles.
        let public_hash = hash_ingest_key("maple_pk_test_senders", "test-hmac-key").unwrap();
        store.keys.lock().unwrap().insert(
            (public_hash, "public_key_hash"),
            KeyRow {
                org_id: "org_senders".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        // A log shipper's token: allowed to send logs, and nothing else.
        let token = "maple_src_audit_senders_0000000000000000000000";
        store.insert_source(
            token,
            source_row(
                "org_senders",
                source_config(Some(r#"["logs"]"#), None, "[]"),
            ),
        );
        // Another org's integration source, named by this org's key.
        let foreign = "5b8f2c1e-7a55-4c0e-9a3b-0d2c7e5b9a11";
        store.insert_source_row("org_other", foreign, "integration");
        let foreign_id = sources::public_source_id(foreign).expect("a uuid has a public id");

        for (sender, headers) in [
            (
                "the public key",
                vercel_drain_headers("maple_pk_test_senders", AUDIT_SOURCE_ID),
            ),
            (
                "a source token",
                vercel_drain_headers(token, AUDIT_SOURCE_ID),
            ),
            (
                "the private key naming no source",
                bearer_headers("maple_sk_test_senders"),
            ),
            (
                "the private key naming another org's source",
                vercel_drain_headers("maple_sk_test_senders", &foreign_id),
            ),
        ] {
            let refused = vercel_audit_delivery(&state, &headers)
                .await
                .expect_err(sender);
            assert_eq!(refused.status, StatusCode::UNAUTHORIZED, "{sender}");
        }
        assert!(nothing_reaches_the_audit_trail(&mut imports).await);
        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn vercel_audit_drain_acks_and_drops_while_the_integration_is_paused() {
        let queue_dir = unique_main_test_dir("vercel-audit-trail-paused");
        let (state, store, mut imports) =
            audit_trail_test_state("maple_sk_test_paused", "org_paused", queue_dir.clone()).await;
        store.pause_source(AUDIT_SOURCE_UUID, current_time_millis() - 1000, None);

        let accepted = vercel_audit_delivery(
            &state,
            &vercel_drain_headers("maple_sk_test_paused", AUDIT_SOURCE_ID),
        )
        .await
        .expect("a paused source's delivery is acked");

        assert_eq!(accepted, 0);
        assert!(nothing_reaches_the_audit_trail(&mut imports).await);
        drop(std::fs::remove_dir_all(&queue_dir));
    }

    // A store that cannot be asked has not said the sender is unknown: the drain
    // must read as retryable, not as misconfigured.
    #[tokio::test]
    async fn vercel_audit_drain_asks_for_a_retry_while_its_source_cannot_be_checked() {
        let queue_dir = unique_main_test_dir("vercel-audit-trail-store-down");
        let (state, store, mut imports) =
            audit_trail_test_state("maple_sk_test_down", "org_down", queue_dir.clone()).await;
        let headers = vercel_drain_headers("maple_sk_test_down", AUDIT_SOURCE_ID);
        store.source_errors.store(true, Ordering::Relaxed);

        let refused = vercel_audit_delivery(&state, &headers)
            .await
            .expect_err("an unchecked source must not be stored");
        assert_eq!(refused.status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(nothing_reaches_the_audit_trail(&mut imports).await);

        // The store back, the same delivery is taken.
        store.source_errors.store(false, Ordering::Relaxed);
        assert_eq!(vercel_audit_delivery(&state, &headers).await.ok(), Some(1));
        drop(std::fs::remove_dir_all(&queue_dir));
    }

    // A few hundred bytes of gzip can inflate into a body that parses into
    // gigabytes; an audit delivery has no reason to be large.
    #[tokio::test]
    async fn vercel_audit_drain_refuses_a_delivery_that_inflates_past_its_limit() {
        let queue_dir = unique_main_test_dir("vercel-audit-trail-bomb");
        let (state, _store, mut imports) =
            audit_trail_test_state("maple_sk_test_bomb", "org_bomb", queue_dir.clone()).await;
        let mut headers = vercel_drain_headers("maple_sk_test_bomb", AUDIT_SOURCE_ID);
        headers.insert(CONTENT_ENCODING, "gzip".parse().unwrap());
        let body = gzip_bytes("[],".repeat(AUDIT_TRAIL_MAX_DECODED_BYTES / 2));

        let refused = handle_vercel_audit_trail_inner(&state, &headers, &body)
            .await
            .expect_err("a delivery past the limit must be refused");

        assert_eq!(refused.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(nothing_reaches_the_audit_trail(&mut imports).await);
        drop(std::fs::remove_dir_all(&queue_dir));
    }

    // Every event is a stored row whatever its size, so a small body of many
    // events is refused on its count.
    #[tokio::test]
    async fn vercel_audit_drain_refuses_a_delivery_of_more_events_than_any_drain_sends() {
        let queue_dir = unique_main_test_dir("vercel-audit-trail-count");
        let (state, _store, mut imports) =
            audit_trail_test_state("maple_sk_test_count", "org_count", queue_dir.clone()).await;
        let headers = vercel_drain_headers("maple_sk_test_count", AUDIT_SOURCE_ID);
        let body = Bytes::from("{\"action\":\"a\"}\n".repeat(AUDIT_TRAIL_MAX_EVENTS + 1));
        assert!(body.len() < AUDIT_TRAIL_MAX_DECODED_BYTES);

        let refused = handle_vercel_audit_trail_inner(&state, &headers, &body)
            .await
            .expect_err("a delivery past the event limit must be refused");

        assert_eq!(refused.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(nothing_reaches_the_audit_trail(&mut imports).await);
        drop(std::fs::remove_dir_all(&queue_dir));
    }

    // Audit rows are not metered, so the rate is what bounds a sender.
    #[tokio::test]
    async fn an_orgs_audit_deliveries_are_refused_past_their_rate() {
        let queue_dir = unique_main_test_dir("audit-trail-rate");
        let (state, _store, _imports) =
            audit_trail_test_state("maple_sk_test_rate", "org_rate", queue_dir.clone()).await;

        assert!(audit_trail_rate_gate(&state, "org_rate", "gcp", 1)
            .await
            .is_ok());
        let refused = audit_trail_rate_gate(&state, "org_rate", "gcp", 1)
            .await
            .expect_err("a second delivery inside the second is past a rate of one");
        assert_eq!(refused.status, StatusCode::TOO_MANY_REQUESTS);
        // Another org, and the same org's other provider, have their own allowance.
        assert!(audit_trail_rate_gate(&state, "org_other", "gcp", 1)
            .await
            .is_ok());
        assert!(audit_trail_rate_gate(&state, "org_rate", "vercel", 1)
            .await
            .is_ok());
        drop(std::fs::remove_dir_all(&queue_dir));
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
    async fn session_metadata_bills_a_repeated_session_start_once() {
        let queue_dir = unique_main_test_dir("replay-meta-billing");
        let state = replay_blob_test_state(
            "maple_sk_test_meta_bill",
            "org_meta_bill",
            queue_dir.clone(),
        )
        .await;
        let (state, mut rx) = with_fake_autumn(state).await;

        let body = r#"{"session_id":"sess_1","version":1,"billable_start":1}"#.to_owned() + "\n";
        let accepted = handle_replay_meta_inner(
            &state,
            &bearer_headers("maple_sk_test_meta_bill"),
            Bytes::from(body.repeat(1000)),
        )
        .await
        .expect("session metadata should be accepted");
        assert_eq!(accepted, 1000, "every row is still stored");

        let calls = drain_autumn_calls(&mut rx).await;
        assert_eq!(
            tracked(&calls),
            vec![("browser_sessions", 1.0)],
            "{calls:?}"
        );

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    fn cookieless_headers(key: &str, ip: &str, user_agent: &str) -> HeaderMap {
        let mut headers = bearer_headers(key);
        headers.insert("cf-connecting-ip", ip.parse().unwrap());
        headers.insert("user-agent", user_agent.parse().unwrap());
        headers
    }

    async fn cookieless_visitor(state: &AppState, headers: &HeaderMap, org_id: &str) -> String {
        let mut row = serde_json::json!({ "visitor_id": "cookieless", "visitor_is_new": 1 });
        let obj = row.as_object_mut().unwrap();
        CookielessRequest::new(state, headers, org_id).apply(obj).await;
        let visitor = obj["visitor_id"].as_str().unwrap().to_owned();
        // Unknown history only for an identified row; an unidentified one is not new.
        let expected_is_new = if visitor.is_empty() { 0 } else { 2 };
        assert_eq!(obj["visitor_is_new"], expected_is_new);
        visitor
    }

    #[tokio::test]
    async fn cookieless_rows_get_a_visitor_id_per_client_only_behind_the_trusted_proxy() {
        let queue_dir = unique_main_test_dir("cookieless-visitor-id");
        let mut state =
            replay_blob_test_state("maple_sk_test_cl_id", "org_cl_id", queue_dir.clone()).await;
        let alice = cookieless_headers("maple_sk_test_cl_id", "203.0.113.7", "Firefox");
        let bob = cookieless_headers("maple_sk_test_cl_id", "198.51.100.2", "Firefox");

        assert_eq!(
            cookieless_visitor(&state, &alice, "org_cl_id").await,
            "",
            "an untrusted client IP identifies no one"
        );

        state.config.trust_proxy_geo = true;
        let first = cookieless_visitor(&state, &alice, "org_cl_id").await;
        assert!(uuid::Uuid::parse_str(&first).is_ok(), "{first}");
        assert_eq!(first, cookieless_visitor(&state, &alice, "org_cl_id").await);
        assert_ne!(first, cookieless_visitor(&state, &bob, "org_cl_id").await);
        assert_ne!(first, cookieless_visitor(&state, &alice, "org_other").await);

        // Behind a first-party proxy every request comes from the proxy's IP; the
        // forwarded visitor address tells them apart, and matches a direct request.
        let mut via_proxy = cookieless_headers("maple_sk_test_cl_id", "192.0.2.50", "Firefox");
        via_proxy.insert("x-forwarded-for", "203.0.113.7, 192.0.2.50".parse().unwrap());
        assert_eq!(first, cookieless_visitor(&state, &via_proxy, "org_cl_id").await);

        let mut stored = serde_json::json!({ "visitor_id": "kept-visitor" });
        let row = stored.as_object_mut().unwrap();
        let outcome = CookielessRequest::new(&state, &alice, "org_cl_id")
            .apply(row)
            .await;
        assert_eq!(outcome, CookielessRow::NotCookieless);
        assert_eq!(row["visitor_id"], "kept-visitor");

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn a_cookieless_heartbeat_extends_the_visit_and_a_start_does_not() {
        let queue_dir = unique_main_test_dir("cookieless-touch");
        let store = Arc::new(FakeKeyStore::default());
        store.insert_private(
            "maple_sk_test_cl_touch",
            KeyRow {
                org_id: "org_cl_touch".to_owned(),
                self_managed: true,
                clickhouse_ready: true,
            },
        );
        let mut state = test_app_state(
            Arc::clone(&store),
            queue_dir.clone(),
            "http://127.0.0.1:1".to_owned(),
            Duration::from_secs(30),
        )
        .await;
        state.config.trust_proxy_geo = true;
        let alice = cookieless_headers("maple_sk_test_cl_touch", "203.0.113.7", "Firefox");
        let row = |version: u32, billable: u8| {
            Bytes::from(format!(
                r#"{{"session_id":"sess_t","version":{version},"billable_start":{billable},"visitor_id":"cookieless"}}"#
            ))
        };

        handle_replay_meta_inner(&state, &alice, row(1, 1)).await.unwrap();
        assert!(store.cookieless_touches.lock().unwrap().is_empty(), "a start claims, not touches");

        handle_replay_meta_inner(&state, &alice, row(2, 0)).await.unwrap();
        // Throttled: a second heartbeat inside the interval writes nothing.
        handle_replay_meta_inner(&state, &alice, row(3, 0)).await.unwrap();
        let visitor = cookieless_visitor(&state, &alice, "org_cl_touch").await;
        assert_eq!(*store.cookieless_touches.lock().unwrap(), vec![visitor]);

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn cookieless_session_starts_bill_once_per_visit() {
        let queue_dir = unique_main_test_dir("cookieless-billing");
        let mut state =
            replay_blob_test_state("maple_sk_test_cl_bill", "org_cl_bill", queue_dir.clone()).await;
        state.config.trust_proxy_geo = true;
        let (state, mut rx) = with_fake_autumn(state).await;
        let start = |session: &str| {
            Bytes::from(format!(
                r#"{{"session_id":"{session}","version":1,"billable_start":1,"visitor_id":"cookieless"}}"#
            ))
        };

        // Three page loads by one visitor (each a new in-memory session), then another visitor.
        let alice = cookieless_headers("maple_sk_test_cl_bill", "203.0.113.7", "Firefox");
        for session in ["sess_a1", "sess_a2", "sess_a3"] {
            handle_replay_meta_inner(&state, &alice, start(session))
                .await
                .expect("session metadata should be accepted");
        }
        let bob = cookieless_headers("maple_sk_test_cl_bill", "198.51.100.2", "Firefox");
        handle_replay_meta_inner(&state, &bob, start("sess_b1"))
            .await
            .expect("session metadata should be accepted");
        // One body with many starts from a new visitor: one claim, one bill.
        let dave = cookieless_headers("maple_sk_test_cl_bill", "192.0.2.44", "Safari");
        let many: Vec<String> = (0..50)
            .map(|n| {
                format!(
                    r#"{{"session_id":"sess_d{n}","version":1,"billable_start":1,"visitor_id":"cookieless"}}"#
                )
            })
            .collect();
        handle_replay_meta_inner(&state, &dave, Bytes::from(many.join("\n")))
            .await
            .expect("session metadata should be accepted");
        // A body whose billing slots are full claims no visit, so Frank's next start still bills.
        let frank = cookieless_headers("maple_sk_test_cl_bill", "192.0.2.66", "Opera");
        let full: Vec<String> = (0..4)
            .map(|n| {
                format!(
                    r#"{{"session_id":"sess_p{n}","version":1,"billable_start":1,"visitor_id":"00000000-0000-4000-8000-00000000000{n}"}}"#
                )
            })
            .chain(std::iter::once(
                r#"{"session_id":"sess_f1","version":1,"billable_start":1,"visitor_id":"cookieless"}"#
                    .to_owned(),
            ))
            .collect();
        handle_replay_meta_inner(&state, &frank, Bytes::from(full.join("\n")))
            .await
            .expect("session metadata should be accepted");
        handle_replay_meta_inner(&state, &frank, start("sess_f2"))
            .await
            .expect("session metadata should be accepted");
        // A cookieless start reusing a counted session id claims nothing, so Gina's next start bills.
        let gina = cookieless_headers("maple_sk_test_cl_bill", "192.0.2.77", "Vivaldi");
        let shared = concat!(
            r#"{"session_id":"sess_g1","version":1,"billable_start":1,"visitor_id":"00000000-0000-4000-8000-0000000000aa"}"#,
            "\n",
            r#"{"session_id":"sess_g1","version":1,"billable_start":1,"visitor_id":"cookieless"}"#,
        );
        handle_replay_meta_inner(&state, &gina, Bytes::from_static(shared.as_bytes()))
            .await
            .expect("session metadata should be accepted");
        handle_replay_meta_inner(&state, &gina, start("sess_g2"))
            .await
            .expect("session metadata should be accepted");
        // No trusted client IP: no visitor to claim a visit for, so not billed.
        handle_replay_meta_inner(&state, &bearer_headers("maple_sk_test_cl_bill"), start("sess_c1"))
            .await
            .expect("session metadata should be accepted");

        let calls = drain_autumn_calls(&mut rx).await;
        let billed: f64 = tracked(&calls)
            .iter()
            .filter(|(feature, _)| *feature == "browser_sessions")
            .map(|(_, count)| count)
            .sum();
        // Alice, Bob and Dave once each, the four persistent starts, Frank's later start,
        // Gina's shared-id request once and her later start.
        assert!((billed - 10.0).abs() < f64::EPSILON, "{calls:?}");

        drop(std::fs::remove_dir_all(&queue_dir));
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

        // A trailer that understates the stream does not get more inflated than it reserved.
        let mut understated = gzip_bytes(&"a".repeat(64 * 1024)).to_vec();
        let trailer = understated.len() - 4;
        understated[trailer..].copy_from_slice(&8_u32.to_le_bytes());
        let error = handle_replay_blob_inner(
            &state,
            &replay_blob_headers(raw_key, "sess_bomb", 3),
            Bytes::from(understated),
        )
        .await
        .expect_err("a chunk inflating past its declared size must be refused");
        assert_eq!(error.status, StatusCode::PAYLOAD_TOO_LARGE);

        // A chunk the shared decode memory cannot hold right now is shed, not inflated.
        let mut others = state.decode_memory.reservation();
        assert!(others.try_add(state.decode_memory.total_bytes()));
        let shed = handle_replay_blob_inner(
            &state,
            &replay_blob_headers(raw_key, "sess_bomb", 2),
            gzip_bytes(r#"[{"type":2,"timestamp":2}]"#),
        )
        .await
        .expect_err("a chunk must be shed while decode memory is full");
        assert_eq!(shed.status, StatusCode::SERVICE_UNAVAILABLE);
        drop(others);
        assert_eq!(state.decode_memory.reserved_bytes(), 0);
        assert!(rx.recv().await.is_some(), "the normal chunk is stored");

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn replay_routes_refuse_a_denied_org_before_storing_anything() {
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

        let queue_dir = unique_main_test_dir("replay-denied");
        let store = Arc::new(FakeKeyStore::default());
        let (denied, allowed) = (
            "maple_sk_test_replay_denied",
            "maple_sk_test_replay_allowed",
        );
        for (raw_key, org_id) in [
            (denied, "org_replay_denied"),
            (allowed, "org_replay_allowed"),
        ] {
            store.insert_private(
                raw_key,
                KeyRow {
                    org_id: org_id.to_owned(),
                    self_managed: true,
                    clickhouse_ready: true,
                },
            );
        }
        let state = test_app_state(
            store,
            queue_dir.clone(),
            "http://127.0.0.1:1".to_owned(),
            Duration::from_secs(30),
        )
        .await;
        let state = with_autumn_denying(state, "org_replay_denied").await;
        let state = with_replay_blob_store(state, format!("http://{addr}"));
        let chunk = || gzip_bytes(r#"[{"type":2,"timestamp":1}]"#);

        let before = queue_dir_bytes(&queue_dir);
        let error = handle_replay_blob_inner(
            &state,
            &replay_blob_headers(denied, "sess_denied", 3),
            chunk(),
        )
        .await
        .expect_err("a denied org's replay chunk must be refused");
        assert_eq!(error.status, StatusCode::PAYMENT_REQUIRED);

        // A continuation row (no billable session start) is refused too.
        let error = handle_replay_meta_inner(
            &state,
            &bearer_headers(denied),
            Bytes::from_static(br#"{"session_id":"sess_denied","version":2,"billable_start":0}"#),
        )
        .await
        .expect_err("a denied org's session metadata must be refused");
        assert_eq!(error.status, StatusCode::PAYMENT_REQUIRED);

        assert!(rx.try_recv().is_err(), "nothing may reach the blob store");
        assert_eq!(
            queue_dir_bytes(&queue_dir),
            before,
            "nothing may be enqueued"
        );

        handle_replay_blob_inner(
            &state,
            &replay_blob_headers(allowed, "sess_ok", 0),
            chunk(),
        )
        .await
        .expect("an allowed org's chunk is accepted");
        assert!(rx.recv().await.is_some(), "the allowed chunk is stored");

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
        let (error, error_kind) = handle_signal_inner(&state, &headers, bomb(), Ingress::Otlp(Signal::Logs))
            .await
            .expect_err("OTLP must refuse a gzip bomb");
        assert_eq!(error.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(error_kind, "payload_too_large");

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    /// A logs export of one record carrying `attributes` empty attributes: two
    /// bytes each on the wire, a whole `KeyValue` each once decoded.
    fn many_empty_attributes(attributes: usize) -> ExportLogsServiceRequest {
        let mut request = test_log_request("many attributes");
        request.resource_logs[0].scope_logs[0].log_records[0].attributes =
            vec![KeyValue::default(); attributes];
        request
    }

    #[tokio::test]
    async fn otlp_refuses_a_payload_that_decodes_past_the_memory_budget() {
        let (forward_url, mut forward_rx) = spawn_forward_collector().await;
        let queue_dir = unique_main_test_dir("otlp-decode-budget");
        let store = Arc::new(FakeKeyStore::default());
        let raw_key = "maple_sk_test_decode_budget";
        store.insert_private(
            raw_key,
            KeyRow {
                org_id: "org_decode_budget".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        let mut state = test_app_state(
            store,
            queue_dir.clone(),
            forward_url,
            Duration::from_millis(5),
        )
        .await;
        state.config.max_decode_heap_bytes = 4 * 1024 * 1024;

        let protobuf = many_empty_attributes(50_000).encode_to_vec();
        assert!(protobuf.len() < 128 * 1024, "fixture stays small on the wire");
        let json = format!("{{\"resourceLogs\":[{}{{}}]}}", "{},".repeat(30_000));
        let mut json_headers = test_headers(raw_key);
        json_headers.insert(CONTENT_TYPE, "application/json".parse().unwrap());
        let mut gzip_headers = test_headers(raw_key);
        gzip_headers.insert(CONTENT_ENCODING, "gzip".parse().unwrap());
        for (case, headers, body) in [
            ("protobuf", test_headers(raw_key), Bytes::from(protobuf.clone())),
            ("gzip protobuf", gzip_headers, gzip_bytes(&protobuf)),
            ("json", json_headers, Bytes::from(json)),
        ] {
            let (error, error_kind) = handle_signal_inner(&state, &headers, body, Ingress::Otlp(Signal::Logs))
                .await
                .expect_err(case);
            assert_eq!(error.status, StatusCode::PAYLOAD_TOO_LARGE, "{case}");
            assert_eq!(error_kind, "payload_too_large", "{case}");
        }
        assert!(forward_rx.try_recv().is_err(), "nothing refused is forwarded");

        // A real batch under the same budget is still accepted.
        let (response, item_count, _, _) = handle_signal_inner(
            &state,
            &test_headers(raw_key),
            Bytes::from(many_empty_attributes(100).encode_to_vec()),
            Ingress::Otlp(Signal::Logs),
        )
        .await
        .expect("a batch within the budget is accepted");
        assert_eq!((response.status(), item_count), (StatusCode::OK, 1));

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn otlp_sheds_a_body_the_shared_decode_memory_cannot_hold() {
        let (forward_url, _forward_rx) = spawn_forward_collector().await;
        let queue_dir = unique_main_test_dir("otlp-decode-memory");
        let store = Arc::new(FakeKeyStore::default());
        let raw_key = "maple_sk_test_decode_memory";
        store.insert_private(
            raw_key,
            KeyRow {
                org_id: "org_decode_memory".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        let state = test_app_state(
            store,
            queue_dir.clone(),
            forward_url,
            Duration::from_millis(5),
        )
        .await;
        let batch = || Bytes::from(test_log_request("shared memory").encode_to_vec());

        // Other requests hold all but a sliver of the shared memory.
        let memory = state.decode_memory.clone();
        let mut others = memory.reservation();
        assert!(others.try_add(memory.total_bytes()));
        let (error, error_kind) =
            handle_signal_inner(&state, &test_headers(raw_key), batch(), Ingress::Otlp(Signal::Logs))
                .await
                .expect_err("no memory is free");
        assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error_kind, "decode_busy");
        let response = error.into_response();
        assert_eq!(response.headers()[RETRY_AFTER], "1", "the client retries");

        drop(others);
        let (response, item_count, _, _) =
            handle_signal_inner(&state, &test_headers(raw_key), batch(), Ingress::Otlp(Signal::Logs))
                .await
                .expect("accepted once memory frees up");
        assert_eq!((response.status(), item_count), (StatusCode::OK, 1));
        assert_eq!(memory.reserved_bytes(), 0, "a finished request returns its memory");

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn otlp_gzip_is_inflated_only_up_to_the_size_it_declares() {
        let queue_dir = unique_main_test_dir("otlp-gzip-declared");
        let (raw_key, org_id) = ("maple_sk_test_gzip_declared", "org_gzip_declared");
        let state = replay_blob_test_state(raw_key, org_id, queue_dir.clone()).await;
        let mut headers = test_headers(raw_key);
        headers.insert(CONTENT_ENCODING, "gzip".parse().unwrap());
        let gzip = gzip_bytes(test_log_request("declared").encode_to_vec());

        // A trailer declaring more than the decoded ceiling is refused unread.
        let mut overdeclared = gzip.to_vec();
        let at = overdeclared.len() - 4;
        overdeclared[at..].copy_from_slice(&u32::MAX.to_le_bytes());
        // One declaring less than it inflates to is cut off at what it declared.
        let mut underdeclared = gzip.to_vec();
        underdeclared[at..].copy_from_slice(&1_u32.to_le_bytes());
        for (case, body) in [("over", overdeclared), ("under", underdeclared)] {
            let (error, error_kind) =
                handle_signal_inner(&state, &headers, Bytes::from(body), Ingress::Otlp(Signal::Logs))
                    .await
                    .expect_err(case);
            assert_eq!(error.status, StatusCode::PAYLOAD_TOO_LARGE, "{case}");
            assert_eq!(error_kind, "payload_too_large", "{case}");
        }
        // A second member used to be dropped silently; now the request is refused.
        let mut two_members = gzip.to_vec();
        two_members.extend_from_slice(&gzip);
        let (error, error_kind) =
            handle_signal_inner(&state, &headers, Bytes::from(two_members), Ingress::Otlp(Signal::Logs))
                .await
                .expect_err("two members");
        assert_eq!((error.status, error_kind), (StatusCode::BAD_REQUEST, "decode"));
        assert_eq!(state.decode_memory.reserved_bytes(), 0);

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    /// A gateway that stores natively, with a pipeline that exports to a fake
    /// Tinybird the test can read and queues large enough for a refused shape.
    async fn native_test_state(
        raw_key: &str,
        org_id: &str,
        queue_dir: &std::path::Path,
    ) -> (AppState, TinybirdImports) {
        native_test_state_capped(raw_key, org_id, queue_dir, 1024 * 1024 * 1024).await
    }

    /// `native_test_state` with each org's queue capped at `org_queue_max_bytes`.
    async fn native_test_state_capped(
        raw_key: &str,
        org_id: &str,
        queue_dir: &std::path::Path,
        org_queue_max_bytes: u64,
    ) -> (AppState, TinybirdImports) {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_private(
            raw_key,
            KeyRow {
                org_id: org_id.to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        let mut state = test_app_state(
            store,
            queue_dir.to_path_buf(),
            "http://127.0.0.1:1".to_owned(),
            Duration::from_secs(30),
        )
        .await;
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .route("/v0/events", post(fake_tinybird_import))
            .with_state(tx);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let pipeline = TelemetryPipeline::new(
            TinybirdConfig {
                endpoint,
                token: "token".to_owned(),
                queue_max_bytes: 1024 * 1024 * 1024,
                org_queue_max_bytes,
                // A request reserves a slot per frame up front, as many as its pieces.
                queue_channel_capacity: 1_000,
                batch_max_rows: 100_000,
                ..test_tinybird_config(queue_dir.join("native"))
            },
            Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
        )
        .await
        .expect("the native pipeline should start");
        state.config.write_mode = WriteMode::Tinybird;
        state.telemetry_pipeline = Some(pipeline);
        (state, rx)
    }

    /// The rows the fake Tinybird has been sent, per datasource, once `rows` arrived.
    async fn exported_rows(
        imports: &mut TinybirdImports,
        rows: usize,
    ) -> Vec<(String, serde_json::Value)> {
        let mut exported = Vec::new();
        while exported.len() < rows {
            let (datasource, ndjson) = tokio::time::timeout(Duration::from_secs(5), imports.recv())
                .await
                .expect("rows are exported")
                .expect("the fake Tinybird is running");
            for line in ndjson.lines().filter(|line| !line.is_empty()) {
                exported.push((datasource.clone(), serde_json::from_str(line).unwrap()));
            }
        }
        exported
    }

    async fn nothing_is_exported(imports: &mut TinybirdImports) -> bool {
        tokio::time::timeout(Duration::from_millis(200), imports.recv())
            .await
            .is_err()
    }

    const SHARED_STRING: usize = 64 * 1024;

    /// `points` empty data points under one metric with a long description: a few
    /// hundred bytes compressed, and the description again on every row.
    fn repeated_description(points: usize) -> ExportMetricsServiceRequest {
        use opentelemetry_proto::tonic::metrics::v1::{
            Gauge, Metric, NumberDataPoint, ResourceMetrics, ScopeMetrics,
        };
        ExportMetricsServiceRequest {
            resource_metrics: vec![ResourceMetrics {
                scope_metrics: vec![ScopeMetrics {
                    metrics: vec![Metric {
                        name: "m".to_owned(),
                        description: "d".repeat(SHARED_STRING),
                        data: Some(metric::Data::Gauge(Gauge {
                            data_points: vec![NumberDataPoint::default(); points],
                        })),
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            }],
        }
    }

    /// `spans` empty spans under a resource with one long attribute.
    fn repeated_resource_attribute(spans: usize) -> ExportTraceServiceRequest {
        use opentelemetry_proto::tonic::trace::v1::{ResourceSpans, ScopeSpans, Span as OtlpSpan};
        ExportTraceServiceRequest {
            resource_spans: vec![ResourceSpans {
                resource: Some(Resource {
                    attributes: vec![KeyValue {
                        key: "process.command_line".to_owned(),
                        key_strindex: 0,
                        value: Some(AnyValue {
                            value: Some(any_value::Value::StringValue("c".repeat(SHARED_STRING))),
                        }),
                    }],
                    dropped_attributes_count: 0,
                    entity_refs: Vec::new(),
                }),
                scope_spans: vec![ScopeSpans {
                    spans: vec![OtlpSpan::default(); spans],
                    ..Default::default()
                }],
                ..Default::default()
            }],
        }
    }

    /// `records` empty log records under a scope with a long name.
    fn repeated_scope_name(records: usize) -> ExportLogsServiceRequest {
        let mut request = test_log_request("");
        let scope_logs = &mut request.resource_logs[0].scope_logs[0];
        scope_logs.scope = Some(InstrumentationScope {
            name: "s".repeat(SHARED_STRING),
            ..Default::default()
        });
        scope_logs.log_records = vec![LogRecord::default(); records];
        request
    }

    /// Sends `points` empty data points under a long description, as protobuf.
    async fn send_repeated_description(
        state: &AppState,
        raw_key: &str,
        points: usize,
    ) -> Result<(Response, usize, String, usize), (ApiError, &'static str)> {
        handle_signal_inner(
            state,
            &test_headers(raw_key),
            Bytes::from(repeated_description(points).encode_to_vec()),
            Ingress::Otlp(Signal::Metrics),
        )
        .await
    }

    /// Each signal's request that repeats one shared string on thousands of rows.
    fn repeating_requests() -> [(Signal, Vec<u8>); 3] {
        [
            (Signal::Metrics, repeated_description(8_000).encode_to_vec()),
            (
                Signal::Traces,
                repeated_resource_attribute(8_000).encode_to_vec(),
            ),
            (Signal::Logs, repeated_scope_name(8_000).encode_to_vec()),
        ]
    }

    fn gzip_headers(raw_key: &str) -> HeaderMap {
        let mut headers = test_headers(raw_key);
        headers.insert(CONTENT_ENCODING, "gzip".parse().unwrap());
        headers
    }

    #[tokio::test]
    async fn a_request_that_repeats_a_shared_string_is_refused_before_anything_is_stored() {
        let queue_dir = unique_main_test_dir("row-expansion");
        let raw_key = "maple_sk_test_row_expansion";
        let (state, mut imports) =
            native_test_state(raw_key, "org_row_expansion", &queue_dir).await;
        let pipeline = state.telemetry_pipeline.clone().unwrap();
        let counted = metrics::data_loss_count("row_expansion");

        for (signal, protobuf) in repeating_requests() {
            let body = gzip_bytes(&protobuf);
            assert!(body.len() < 2 * 1024, "{}: tiny on the wire", signal.path());
            let (error, error_kind) =
                handle_signal_inner(&state, &gzip_headers(raw_key), body, Ingress::Otlp(signal))
                    .await
                    .expect_err(signal.path());
            // The same refusal whichever signal carries the repeated string.
            assert_eq!(
                error.status,
                StatusCode::PAYLOAD_TOO_LARGE,
                "{}",
                signal.path()
            );
            assert_eq!(
                error.kind.tag,
                "@maple/ingest/RowExpansion",
                "{}",
                signal.path()
            );
            assert_eq!(error_kind, "row_expansion", "{}", signal.path());
            assert_eq!(
                pipeline.wal_backlog_bytes(),
                0,
                "{}: no row committed",
                signal.path()
            );
            assert_eq!(state.decode_memory.reserved_bytes(), 0, "{}", signal.path());
        }
        assert!(
            metrics::data_loss_count("row_expansion") >= counted + 3,
            "each refusal is counted as lost data"
        );
        assert!(nothing_is_exported(&mut imports).await);

        // Over gRPC the refusal is one an exporter does not retry.
        let status = accept_grpc_decoded(
            &state,
            Signal::Metrics,
            DecodedPayload::Metrics(repeated_description(8_000)),
            &state
                .resolver
                .resolve_ingest_key(raw_key)
                .await
                .unwrap()
                .unwrap(),
            KeyAdmission::Ingest,
            Received::unbudgeted(repeated_description(8_000).encoded_len()),
            &ClaimOutcome::default(),
        )
        .await
        .expect_err("refused over gRPC too");
        assert_eq!(status.code(), tonic::Code::InvalidArgument);
        assert_eq!(pipeline.wal_backlog_bytes(), 0);

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn a_request_that_repeats_a_shared_string_is_not_forwarded() {
        let (forward_url, mut forward_rx) = spawn_forward_collector().await;
        let queue_dir = unique_main_test_dir("row-expansion-forward");
        let store = Arc::new(FakeKeyStore::default());
        let raw_key = "maple_sk_test_row_expansion_forward";
        store.insert_private(
            raw_key,
            KeyRow {
                org_id: "org_row_expansion_forward".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        let state = test_app_state(
            store,
            queue_dir.clone(),
            forward_url,
            Duration::from_millis(5),
        )
        .await;

        let (error, error_kind) = handle_signal_inner(
            &state,
            &test_headers(raw_key),
            Bytes::from(repeated_scope_name(8_000).encode_to_vec()),
            Ingress::Otlp(Signal::Logs),
        )
        .await
        .expect_err("the collector would store the same rows");
        assert_eq!(
            (error.status, error_kind),
            (StatusCode::PAYLOAD_TOO_LARGE, "row_expansion")
        );
        assert!(
            forward_rx.try_recv().is_err(),
            "nothing refused is forwarded"
        );
        assert_eq!(state.decode_memory.reserved_bytes(), 0);

        // The same records without the long scope name are forwarded as ever.
        let mut ordinary = repeated_scope_name(8_000);
        ordinary.resource_logs[0].scope_logs[0].scope = None;
        let body = ordinary.encode_to_vec();
        let (response, item_count, _, metered) = handle_signal_inner(
            &state,
            &test_headers(raw_key),
            Bytes::from(body.clone()),
            Ingress::Otlp(Signal::Logs),
        )
        .await
        .expect("an ordinary batch is forwarded");
        assert_eq!(
            (response.status(), item_count, metered),
            (StatusCode::OK, 8_000, body.len())
        );
        assert!(
            forward_rx.try_recv().is_ok(),
            "the batch reached the collector"
        );

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    /// The rules an org's spans get are its first, in a stable order, up to both caps.
    #[test]
    fn attribute_mappings_past_the_caps_are_not_applied() {
        let rule = |index: usize, key_len: usize| AttributeMappingRule {
            source_context: MappingSourceContext::Span,
            source_key: format!("s{index}"),
            target_key: format!("t{index}").repeat(key_len),
            operation: MappingOperation::Copy,
        };
        let kept = cap_attribute_mappings("org", (0..100).map(|index| rule(index, 1)));
        assert_eq!(kept.len(), MAX_ATTRIBUTE_MAPPINGS);
        assert_eq!(kept[0].source_key, "s0");
        assert_eq!(kept[MAX_ATTRIBUTE_MAPPINGS - 1].source_key, "s63");

        // Four rules of 6 KiB keys pass the byte cap at the third.
        let kept = cap_attribute_mappings("org", (0..4).map(|index| rule(index, 3 * 1024)));
        assert_eq!(kept.len(), 2);
    }

    #[tokio::test]
    async fn the_row_expansion_ceiling_is_a_setting() {
        let queue_dir = unique_main_test_dir("row-expansion-setting");
        let raw_key = "maple_sk_test_row_expansion_setting";
        let (mut state, mut imports) =
            native_test_state(raw_key, "org_row_expansion_setting", &queue_dir).await;
        // 500 rows of a 64 KiB description: about 480 times the request's size.
        let body_len = repeated_description(500).encoded_len();

        state.config.max_row_expansion = 400;
        let (error, error_kind) = send_repeated_description(&state, raw_key, 500)
            .await
            .expect_err("past the ceiling");
        assert_eq!(
            (error.status, error_kind),
            (StatusCode::PAYLOAD_TOO_LARGE, "row_expansion")
        );
        assert!(nothing_is_exported(&mut imports).await);

        // Under the default ceiling, and with the ceiling off, it is stored whole.
        for ceiling in [DEFAULT_MAX_ROW_EXPANSION, 0] {
            state.config.max_row_expansion = ceiling;
            let (response, item_count, _, metered) =
                send_repeated_description(&state, raw_key, 500)
                    .await
                    .expect("within the ceiling");
            assert_eq!(
                (response.status(), item_count, metered),
                (StatusCode::OK, 1, body_len),
                "ceiling {ceiling}"
            );
            assert_eq!(exported_rows(&mut imports, 500).await.len(), 500);
        }

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn rows_larger_than_the_shared_memory_are_stored_a_piece_at_a_time() {
        let queue_dir = unique_main_test_dir("row-memory");
        let raw_key = "maple_sk_test_row_memory";
        let (mut state, mut imports) =
            native_test_state(raw_key, "org_row_memory", &queue_dir).await;
        let pipeline = state.telemetry_pipeline.clone().unwrap();
        // Only the memory bounds what these store.
        state.config.max_row_expansion = 0;
        let memory = state.decode_memory.clone();
        let send = |points: usize| send_repeated_description(&state, raw_key, points);

        // While other requests hold all but less than a piece, it is shed before any
        // row is written, with a retryable 503.
        let mut others = memory.reservation();
        assert!(others.try_add(memory.total_bytes() - 4 * 1024 * 1024));
        let (error, error_kind) = send(1_000).await.expect_err("no room for a piece");
        assert_eq!(
            (error.status, error_kind),
            (StatusCode::SERVICE_UNAVAILABLE, "decode_busy")
        );
        assert!(error.message.contains("storing"), "shed at the row stage");
        assert_eq!(error.into_response().headers()[RETRY_AFTER], "1");
        assert_eq!(pipeline.wal_backlog_bytes(), 0, "nothing was committed");
        assert!(nothing_is_exported(&mut imports).await);
        drop(others);

        // 2,200 rows of 64 KiB are more than the 128 MiB this gateway has in all, and
        // are stored whole: a piece of them is reserved and written at a time.
        let points = 2_200;
        let rows_bytes = (points * SHARED_STRING) as u64;
        assert!(rows_bytes > memory.total_bytes());
        let body_len = repeated_description(points).encoded_len();
        let (response, item_count, _, metered) = send(points).await.expect("stored in pieces");
        assert_eq!(
            (response.status(), item_count, metered),
            (StatusCode::OK, 1, body_len)
        );
        assert_eq!(memory.reserved_bytes(), 0, "a finished request returns its memory");
        let rows = exported_rows(&mut imports, points).await;
        assert_eq!(rows.len(), points, "every row once");
        assert!(rows.iter().all(|(datasource, row)| {
            datasource == "metrics_gauge"
                && row["metric_description"].as_str().map(str::len) == Some(SHARED_STRING)
        }));

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    /// A batch shaped like a JVM service's, whose rows come to more than the gateway's
    /// whole shared memory, is accepted: only a piece of its rows is held at a time.
    #[tokio::test]
    async fn an_ordinary_batch_whose_rows_outgrow_the_shared_memory_is_accepted() {
        let queue_dir = unique_main_test_dir("row-outgrow");
        let raw_key = "maple_sk_test_row_outgrow";
        let (mut state, mut imports) =
            native_test_state(raw_key, "org_row_outgrow", &queue_dir).await;
        state.decode_memory = DecodeMemory::new(40 * 1024 * 1024);
        let mut batch = test_log_request("GET /api/orders 200");
        let resource = batch.resource_logs[0].resource.as_mut().unwrap();
        resource.attributes.push(KeyValue {
            key: "process.command_line".to_owned(),
            key_strindex: 0,
            value: Some(AnyValue {
                value: Some(any_value::Value::StringValue(
                    "/usr/lib/jvm/bin/java -Xmx2g -javaagent:/otel.jar ".repeat(40),
                )),
            }),
        });
        let records = &mut batch.resource_logs[0].scope_logs[0].log_records;
        *records = vec![records[0].clone(); 20_000];
        let rows = RowSource::Logs(&batch).plan("org", ROW_PIECE_BYTES).total;
        assert!(rows.row_bytes() > state.decode_memory.total_bytes(), "{rows:?}");
        let body = gzip_bytes(batch.encode_to_vec());

        let (response, item_count, _, _) =
            handle_signal_inner(&state, &gzip_headers(raw_key), body, Ingress::Otlp(Signal::Logs))
                .await
                .expect("an ordinary batch is never refused for its size");
        assert_eq!((response.status(), item_count), (StatusCode::OK, 20_000));
        assert_eq!(exported_rows(&mut imports, 20_000).await.len(), 20_000);
        assert_eq!(state.decode_memory.reserved_bytes(), 0);

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    /// An ordinary batch spread across many pieces reaches the warehouse whole and once,
    /// each row as it is when the batch is built in one piece.
    #[tokio::test]
    async fn a_batch_built_in_many_pieces_is_stored_whole() {
        let queue_dir = unique_main_test_dir("row-pieces");
        let raw_key = "maple_sk_test_row_pieces";
        let (mut state, mut imports) =
            native_test_state(raw_key, "org_row_pieces", &queue_dir).await;
        let request = test_log_request("piece");
        let mut batch = request.clone();
        let records = &mut batch.resource_logs[0].scope_logs[0].log_records;
        let record = records[0].clone();
        *records = (0..3_000)
            .map(|index| LogRecord {
                time_unix_nano: 1_700_000_000_000_000_000 + index,
                ..record.clone()
            })
            .collect();
        let whole: Vec<serde_json::Value> = maple_ingest::telemetry::encode_log_rows(&batch)
            .unwrap()
            .iter()
            .flat_map(|payload| payload.split(|byte| *byte == b'\n'))
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect();

        state.config.row_piece_bytes = 16 * 1024;
        let plan = RowSource::Logs(&batch).plan("org_row_pieces", state.config.row_piece_bytes);
        assert!(plan.pieces.len() > 20, "{} pieces", plan.pieces.len());
        let (response, item_count, _, _) = handle_signal_inner(
            &state,
            &test_headers(raw_key),
            Bytes::from(batch.encode_to_vec()),
            Ingress::Otlp(Signal::Logs),
        )
        .await
        .expect("accepted");
        assert_eq!((response.status(), item_count), (StatusCode::OK, 3_000));
        let mut rows: Vec<serde_json::Value> = exported_rows(&mut imports, 3_000)
            .await
            .into_iter()
            .map(|(_, row)| row)
            .collect();
        let key = |row: &serde_json::Value| row["timestamp"].as_str().unwrap_or("").to_owned();
        rows.sort_by_key(key);
        let mut expected = whole;
        expected.sort_by_key(key);
        assert_eq!(rows.len(), 3_000);
        // The enrichment the gateway adds is the same on every row of both.
        for (row, expected) in rows.iter().zip(&expected) {
            assert_eq!(row["timestamp"], expected["timestamp"]);
            assert_eq!(row["body"], expected["body"]);
        }
        assert!(nothing_is_exported(&mut imports).await, "no row twice");
        assert_eq!(state.decode_memory.reserved_bytes(), 0);

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    /// A batch whose rows the org's queue could never hold at once is refused before
    /// its first piece, instead of storing pieces until the cap and failing.
    #[tokio::test]
    async fn rows_larger_than_the_org_queue_are_refused_before_any_piece_is_written() {
        let queue_dir = unique_main_test_dir("rows-exceed-queue");
        let raw_key = "maple_sk_test_rows_exceed_queue";
        let mib = 1024 * 1024;
        let (mut state, mut imports) =
            native_test_state_capped(raw_key, "org_rows_exceed_queue", &queue_dir, 16 * mib).await;
        // Expansion is not what this refuses.
        state.config.max_row_expansion = 0;
        let pipeline = state.telemetry_pipeline.clone().unwrap();
        let request = repeated_description(400);
        let plan = RowSource::Metrics(&request).plan("org_rows_exceed_queue", ROW_PIECE_BYTES);
        assert!(plan.pieces.len() > 2, "stored in several pieces");
        assert!(plan.total.row_bytes() > 16 * mib);
        assert!(
            plan.largest_piece_heap() < 16 * mib,
            "any one piece fits the queue"
        );
        let counted = metrics::data_loss_count("rows_exceed_queue");

        let (error, error_kind) = send_repeated_description(&state, raw_key, 400)
            .await
            .expect_err("larger than the org queue");
        assert_eq!(error.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(error.kind.tag, "@maple/ingest/RowsExceedQueue");
        assert!(!error.kind.retryable);
        assert_eq!(error_kind, "rows_exceed_queue");
        assert_eq!(pipeline.wal_backlog_bytes(), 0, "no piece written");
        assert_eq!(state.decode_memory.reserved_bytes(), 0);
        assert_eq!(metrics::data_loss_count("rows_exceed_queue"), counted + 1);
        assert!(nothing_is_exported(&mut imports).await);

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn the_row_stage_is_admitted_on_what_it_stores_and_allocates() {
        let queue_dir = unique_main_test_dir("row-admission");
        let (state, _imports) = native_test_state(
            "maple_sk_test_row_admission",
            "org_row_admission",
            &queue_dir,
        )
        .await;
        let mib = 1024 * 1024;
        let rows = RowEstimate {
            rows: 100,
            payload_bytes: [8 * mib, 0, 0, 0],
            work_bytes: mib,
        };
        let stage = RowStage {
            metered_bytes: 1024 * 1024,
            decode_heap: 4 * mib,
            native: true,
            forward_bytes: 2 * mib,
            parse_heap: 0,
        };
        let admit = |stage: RowStage, memory: &mut DecodeReservation| {
            admit_rows(
                &state,
                Signal::Logs,
                "org_row_admission",
                &rows,
                rows.heap_bytes(),
                stage,
                memory,
            )
        };

        // The rows and the forward body are both reserved, before either exists.
        let mut memory = state.decode_memory.reservation();
        admit(stage, &mut memory).expect("eight times its size, well inside the memory");
        assert_eq!(memory.held_bytes(), rows.heap_bytes() + 2 * mib);
        // A forward-only request builds no rows here, only the body.
        let mut forward_only = state.decode_memory.reservation();
        let forwarded = RowStage {
            native: false,
            ..stage
        };
        admit(forwarded, &mut forward_only).expect("forward only");
        assert_eq!(forward_only.held_bytes(), 2 * mib);
        drop((memory, forward_only));

        // Past the ceiling on what it is metered for, in either mode.
        for native in [true, false] {
            let expanded = RowStage {
                metered_bytes: 8 * 1024,
                native,
                ..stage
            };
            let error = admit(expanded, &mut state.decode_memory.reservation())
                .expect_err("1024 times its metered size");
            assert_eq!(error.kind.tag, "@maple/ingest/RowExpansion");
        }

        // With the decode memory the request still holds it could never fit, so
        // retrying is pointless; without it, it is only waiting on other requests.
        let total = state.decode_memory.total_bytes();
        let holding = RowStage {
            decode_heap: total - 8 * mib,
            ..stage
        };
        let error = admit(holding, &mut state.decode_memory.reservation())
            .expect_err("more than the gateway has, with what it already holds");
        assert_eq!(error.status, StatusCode::PAYLOAD_TOO_LARGE);
        // The forward body is reserved at its real size: one that could never fit is a
        // 413, and one that fits only an idle gateway waits as rows do.
        let mut forward_only = state.decode_memory.reservation();
        let whole_budget = RowStage {
            native: false,
            forward_bytes: 2 * total,
            ..stage
        };
        let error = admit(whole_budget, &mut forward_only).expect_err("larger than the budget");
        assert_eq!(error.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(
            forward_only.held_bytes(),
            0,
            "nothing reserved for a refusal"
        );
        let most_of_it = RowStage {
            native: false,
            forward_bytes: total - 8 * mib,
            ..stage
        };
        admit(most_of_it, &mut forward_only).expect("fits an idle gateway");
        assert_eq!(forward_only.held_bytes(), total - 8 * mib, "reserved whole");
        let error = admit(most_of_it, &mut state.decode_memory.reservation())
            .expect_err("the first one holds the memory");
        assert_eq!(error.kind.tag, "@maple/ingest/DecodeBusy");
        assert!(error.kind.retryable);
        drop(forward_only);
        let mut others = state.decode_memory.reservation();
        assert!(others.try_add(total - 8 * mib));
        let error = admit(stage, &mut state.decode_memory.reservation())
            .expect_err("other requests hold the memory");
        assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(error.kind.retryable);
        drop(others);

        // What parse rules wrote is reserved with the rows: it fits an idle gateway, and waits
        // when other requests leave room for the rows but not for it.
        let parsed = RowStage { parse_heap: mib, ..stage };
        let mut memory = state.decode_memory.reservation();
        admit(parsed, &mut memory).expect("fits an idle gateway");
        assert_eq!(memory.held_bytes(), rows.heap_bytes() + 2 * mib + mib);
        drop(memory);
        let mut others = state.decode_memory.reservation();
        assert!(others.try_add(total - rows.heap_bytes() - 2 * mib - mib / 2));
        admit(stage, &mut state.decode_memory.reservation()).expect("the rows alone still fit");
        let error = admit(parsed, &mut state.decode_memory.reservation())
            .expect_err("no room left for the parsed attributes");
        assert_eq!(error.kind.tag, "@maple/ingest/DecodeBusy");
        assert!(error.kind.retryable);
        drop(others);

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn ordinary_batches_are_stored_and_metered_on_their_decoded_size() {
        use opentelemetry_proto::tonic::metrics::v1::{
            Gauge, Metric, NumberDataPoint, ResourceMetrics, ScopeMetrics,
        };
        use opentelemetry_proto::tonic::trace::v1::{ResourceSpans, ScopeSpans, Span as OtlpSpan};
        let queue_dir = unique_main_test_dir("row-ordinary");
        let raw_key = "maple_sk_test_row_ordinary";
        let (state, mut imports) = native_test_state(raw_key, "org_row_ordinary", &queue_dir).await;
        let resource = || test_log_request("").resource_logs[0].resource.clone();
        let logs = {
            let mut request = test_log_request("checkout priced a cart");
            let records = &mut request.resource_logs[0].scope_logs[0].log_records;
            *records = vec![records[0].clone(); 40];
            request
        };
        let traces = ExportTraceServiceRequest {
            resource_spans: vec![ResourceSpans {
                resource: resource(),
                scope_spans: vec![ScopeSpans {
                    spans: (1..=40)
                        .map(|index| OtlpSpan {
                            trace_id: vec![index; 16],
                            span_id: vec![index; 8],
                            name: "GET /carts".to_owned(),
                            start_time_unix_nano: 1_700_000_000_000_000_000,
                            end_time_unix_nano: 1_700_000_000_040_000_000,
                            ..Default::default()
                        })
                        .collect(),
                    ..Default::default()
                }],
                ..Default::default()
            }],
        };
        let metrics = ExportMetricsServiceRequest {
            resource_metrics: vec![ResourceMetrics {
                resource: resource(),
                scope_metrics: vec![ScopeMetrics {
                    metrics: vec![Metric {
                        name: "process.cpu.time".to_owned(),
                        description: "CPU seconds used by the process.".to_owned(),
                        unit: "s".to_owned(),
                        data: Some(metric::Data::Gauge(Gauge {
                            data_points: vec![
                                NumberDataPoint {
                                    time_unix_nano: 1_700_000_000_000_000_000,
                                    ..Default::default()
                                };
                                40
                            ],
                        })),
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            }],
        };

        // Items are records and spans, and for metrics the metrics themselves.
        for (signal, protobuf, datasource, items) in [
            (Signal::Logs, logs.encode_to_vec(), "logs", 40),
            (Signal::Traces, traces.encode_to_vec(), "traces", 40),
            (Signal::Metrics, metrics.encode_to_vec(), "metrics_gauge", 1),
        ] {
            let path = signal.path();
            let (response, item_count, _, metered) = handle_signal_inner(
                &state,
                &test_headers(raw_key),
                Bytes::from(protobuf.clone()),
                Ingress::Otlp(signal),
            )
            .await
            .expect(path);
            // Metered on the bytes it decoded to, whatever its rows come to.
            assert_eq!(
                (response.status(), item_count, metered),
                (StatusCode::OK, items, protobuf.len()),
                "{}",
                signal.path()
            );
            let rows = exported_rows(&mut imports, 40).await;
            assert_eq!(rows.len(), 40, "{}", signal.path());
            assert!(
                rows.iter().all(|(name, row)| {
                    name == datasource && row["service_name"] == "routing-test"
                }),
                "{}: each row carries its resource",
                signal.path()
            );
            assert_eq!(state.decode_memory.reserved_bytes(), 0, "{}", signal.path());
        }

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
                org_retention: RetentionOverrides::default(),
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
                    org_retention: RetentionOverrides::default(),
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
                org_retention: RetentionOverrides::default(),
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

    const GCP_AUDIT_ENTRY: &str = r#"{"logName":"projects/acme-prod/logs/cloudaudit.googleapis.com%2Factivity","insertId":"abc123","timestamp":"2026-10-09T10:00:00Z","resource":{"type":"service_account","labels":{"project_id":"acme-prod"}},"protoPayload":{"serviceName":"iam.googleapis.com","methodName":"google.iam.admin.v1.CreateServiceAccountKey","authenticationInfo":{"principalEmail":"ada@acme.test"}}}"#;

    // An Admin Activity entry names a person and what they changed. It goes to
    // the audit trail, which only admins read, and never to the org's logs.
    #[tokio::test]
    async fn gcp_logpush_stores_an_audit_entry_in_the_audit_trail_and_not_as_a_log() {
        let (ch_url, mut ch_rx) = spawn_fake_clickhouse().await;
        let (mut state, store, queue_dir) = gcp_logpush_state("gcp-logpush-audit", &ch_url).await;
        let mut imports = store_audit_trail(
            Arc::get_mut(&mut state).expect("the state is not shared yet"),
            &queue_dir,
        )
        .await;

        let accepted = gcp_push(&state, "gcp_conn_1", Some("gcp-secret"), GCP_AUDIT_ENTRY).await;

        assert_eq!(accepted.status(), StatusCode::OK);
        assert_eq!(store.connector_successes.load(Ordering::Relaxed), 1);
        let (datasource, rows) = tokio::time::timeout(Duration::from_secs(2), imports.recv())
            .await
            .expect("the entry should reach Tinybird")
            .expect("the Tinybird channel should stay open");
        assert_eq!(datasource, "audit_trail_events");
        let row: serde_json::Value = serde_json::from_str(rows.trim()).expect("one NDJSON row");
        assert_eq!(
            (
                row["OrgId"].as_str(),
                row["ProviderEventId"].as_str(),
                row["ActorEmail"].as_str()
            ),
            (Some("org_gcp"), Some("abc123"), Some("ada@acme.test"))
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(200), ch_rx.recv())
                .await
                .is_err(),
            "an audit entry must not be written to the org's logs"
        );
        drop(std::fs::remove_dir_all(queue_dir));
    }

    // A gateway that only forwards has no audit trail table, and one where the
    // trail is not turned on does not write to it: there the entry stays a log.
    #[tokio::test]
    async fn gcp_logpush_keeps_an_audit_entry_as_a_log_where_the_gateway_only_forwards() {
        let (ch_url, mut ch_rx) = spawn_fake_clickhouse().await;
        let (state, _store, queue_dir) = gcp_logpush_state("gcp-logpush-audit-fwd", &ch_url).await;

        let accepted = gcp_push(&state, "gcp_conn_1", Some("gcp-secret"), GCP_AUDIT_ENTRY).await;

        assert_eq!(accepted.status(), StatusCode::OK);
        let stored = tokio::time::timeout(Duration::from_secs(2), ch_rx.recv())
            .await
            .expect("the entry should reach the org's ClickHouse")
            .expect("ClickHouse channel should stay open");
        assert!(stored.query.starts_with("INSERT INTO logs"));
        drop(std::fs::remove_dir_all(queue_dir));
    }

    #[tokio::test]
    async fn gcp_logpush_acks_an_entry_past_the_rule_scan_budget() {
        let (ch_url, mut ch_rx) = spawn_fake_clickhouse().await;
        let (mut state, store, queue_dir) = gcp_logpush_state("gcp-logpush-scan", &ch_url).await;
        store.set_ingest_rules("org_gcp", &[mask_emails_rule()]);
        Arc::get_mut(&mut state).expect("the state is not shared yet").ingest_rule_resolver =
            IngestRuleResolver::new(Arc::<FakeKeyStore>::clone(&store), true, Duration::from_secs(30), 16)
                .with_scan_budget(1);

        // Redelivery would be refused the same way, so it is acked, and nothing is stored.
        let refused = gcp_push(&state, "gcp_conn_1", Some("gcp-secret"), GCP_LOG_ENTRY).await;
        assert_eq!(refused.status(), StatusCode::OK);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), ch_rx.recv())
                .await
                .is_err(),
            "an unscanned entry must not be stored"
        );
        assert_eq!(
            *store.connector_failures.lock().unwrap(),
            [(GCP_CONNECTORS_TABLE, gcp_logging::RULES_SCAN_BUDGET.to_owned())]
        );

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
        /// runtime, so the handler and the export worker it spawns both run here
        /// (and children inherit it), while other tests' spans are filtered out.
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
            // A child keeps its parent's thread, so a test's tree stays together
            // across work moved to the blocking pool.
            let parent = span.parent();
            let thread = parent
                .as_ref()
                .and_then(|parent| parent.extensions().get::<std::thread::ThreadId>().copied())
                .unwrap_or_else(|| std::thread::current().id());
            span.extensions_mut().insert(thread);
            let parent = parent.map(|parent| parent.name().to_owned());
            self.spans
                .lock()
                .unwrap()
                .push((thread, span.name().to_owned(), parent));
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
            Received::unbudgeted(decoded_bytes),
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
            Received::unbudgeted(real_bytes),
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
            Ingress::Otlp(Signal::Logs),
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
            Ingress::Otlp(Signal::Logs),
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
            Ingress::Otlp(Signal::Logs),
        )
        .await
        .expect_err("an undecodable body is refused");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert_eq!(error_kind, "decode");

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn vercel_log_drain_maps_each_delivery_format_onto_otlp_logs() {
        let (forward_url, mut forward_rx) = spawn_forward_collector().await;
        let queue_dir = unique_main_test_dir("vercel-log-drain");
        let store = Arc::new(FakeKeyStore::default());
        store.insert_private(
            "maple_sk_test_vercel",
            KeyRow {
                org_id: "org_vercel".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        let state = test_app_state(
            store,
            queue_dir.clone(),
            forward_url,
            Duration::from_secs(5),
        )
        .await;
        let headers = |encoding: Option<&str>| {
            let mut headers = test_headers("maple_sk_test_vercel");
            headers.insert(CONTENT_TYPE, "application/x-ndjson".parse().unwrap());
            if let Some(encoding) = encoding {
                headers.insert(CONTENT_ENCODING, encoding.parse().unwrap());
            }
            headers
        };
        let log = r#"{"id":"1","projectId":"prj_1","deploymentId":"dpl_1","source":"lambda","level":"info","message":"hi","timestamp":1573817187330}"#;
        let ndjson = format!("{log}\n{log}\n");
        let gzipped_array = gzip_bytes(format!("[{log}]")).to_vec();

        // The drain's test delivery is an empty batch.
        for (body, encoding, rows) in [
            (ndjson.into_bytes(), None, 2),
            (gzipped_array, Some("gzip"), 1),
            (b"[]".to_vec(), None, 0),
        ] {
            let (response, item_count, org_id, _) = handle_signal_inner(
                &state,
                &headers(encoding),
                Bytes::from(body),
                Ingress::VercelLogDrain,
            )
            .await
            .expect("a drain delivery is accepted");
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!((item_count, org_id.as_str()), (rows, "org_vercel"));
            let forwarded = tokio::time::timeout(Duration::from_secs(2), forward_rx.recv())
                .await
                .expect("the delivery is forwarded")
                .expect("forward channel should stay open");
            assert_eq!(forwarded.content_type, "application/x-protobuf");
        }

        let (error, error_kind) = handle_signal_inner(
            &state,
            &headers(None),
            Bytes::from_static(b"{\"projectId\":"),
            Ingress::VercelLogDrain,
        )
        .await
        .expect_err("malformed JSON is refused");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert_eq!(error_kind, "enrich");

        let (error, _) = handle_signal_inner(
            &state,
            &HeaderMap::new(),
            Bytes::from_static(b"[]"),
            Ingress::VercelLogDrain,
        )
        .await
        .expect_err("a delivery without the ingest key is refused");
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);

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
            let (error, _) = handle_signal_inner(&state, &headers, body(), Ingress::Otlp(Signal::Logs))
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
            handle_signal_inner(&state, &test_headers(allowed), body(), Ingress::Otlp(Signal::Logs))
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
                    org_retention: RetentionOverrides::default(),
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

        // The sentinel token has no org to bill, so it is never gated, and its
        // upload is never kept, so it is never decoded either: undecodable bytes
        // that claim gzip still get one empty OK reply.
        let mut sentinel_request = grpc_export_request("MAPLE_TEST", UNDECODABLE_BODY.to_vec());
        sentinel_request
            .headers_mut()
            .insert("grpc-encoding", HeaderValue::from_static("gzip"));
        let sentinel = router.call(sentinel_request).await.unwrap();
        assert_eq!(grpc_header_status(&sentinel), None);
        let body = axum::body::to_bytes(sentinel.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(
            body.as_ref(),
            EMPTY_GRPC_MESSAGE,
            "one empty export response"
        );

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    /// A gzip-compressed gRPC frame, as the OTel Collector sends by default.
    fn gzip_grpc_frame(message: &[u8]) -> Vec<u8> {
        use flate2::write::GzEncoder;
        use std::io::Write as _;

        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(message).unwrap();
        let compressed = encoder.finish().unwrap();
        let mut frame = vec![1u8];
        frame.extend_from_slice(&u32::try_from(compressed.len()).unwrap().to_be_bytes());
        frame.extend_from_slice(&compressed);
        frame
    }

    #[tokio::test]
    async fn grpc_export_takes_gzip_within_the_http_body_limits() {
        use tonic::codegen::Service as _;

        let (forward_url, _forward_rx) = spawn_forward_collector().await;
        let queue_dir = unique_main_test_dir("grpc-gzip-limit");
        let store = Arc::new(FakeKeyStore::default());
        let raw_key = "maple_sk_test_grpc_gzip";
        store.insert_private(
            raw_key,
            KeyRow {
                org_id: "org_grpc_gzip".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        let state = test_app_state(
            store,
            queue_dir.clone(),
            forward_url,
            Duration::from_millis(5),
        )
        .await;
        let (raw_limit, decoded_limit) = (
            state.config.max_request_body_bytes,
            state.config.max_decoded_body_bytes,
        );
        let mut router = grpc_router(Arc::new(state));
        let message = |len: usize| test_log_request(&"x".repeat(len)).encode_to_vec();
        let gzip_request_as = |raw_key: &str, message: &[u8]| {
            let mut request = grpc_export_request(raw_key, gzip_grpc_frame(message));
            request
                .headers_mut()
                .insert("grpc-encoding", HeaderValue::from_static("gzip"));
            request
        };
        let gzip_request = |message: &[u8]| gzip_request_as(raw_key, message);

        // The sentinel's upload is swapped out before tonic reads it, so even one
        // that would inflate past the decoded ceiling is never inflated.
        let sentinel = router
            .call(gzip_request_as("MAPLE_TEST", &message(decoded_limit)))
            .await
            .unwrap();
        assert_eq!(
            grpc_header_status(&sentinel),
            None,
            "a sentinel export is answered without being inflated"
        );

        // Past tonic's 4 MiB default, inside the decoded ceiling, compressed under the raw one.
        let accepted = router
            .call(gzip_request(&message(5 * 1024 * 1024)))
            .await
            .unwrap();
        assert_eq!(
            grpc_header_status(&accepted),
            None,
            "a gzip export is accepted"
        );

        let inflated = router
            .call(gzip_request(&message(decoded_limit)))
            .await
            .unwrap();
        assert_eq!(
            grpc_header_status(&inflated),
            Some("8"),
            "gzip that inflates past the decoded limit is RESOURCE_EXHAUSTED"
        );

        // A compressed message must say how; one in an encoding we do not take is
        // UNIMPLEMENTED, as tonic answered.
        for (encoding, code) in [(None, "13"), (Some("zstd"), "12")] {
            let mut request = grpc_export_request(raw_key, gzip_grpc_frame(&message(16)));
            if let Some(encoding) = encoding {
                request
                    .headers_mut()
                    .insert("grpc-encoding", HeaderValue::from_static(encoding));
            }
            let response = router.call(request).await.unwrap();
            assert_eq!(grpc_header_status(&response), Some(code), "{encoding:?}");
        }

        // Each extra frame would be decompressed up to the decoded limit.
        let mut two_frames = gzip_grpc_frame(&message(16));
        two_frames.extend(gzip_grpc_frame(&message(16)));
        let extra_frame = {
            let mut request = grpc_export_request(raw_key, two_frames);
            request
                .headers_mut()
                .insert("grpc-encoding", HeaderValue::from_static("gzip"));
            router.call(request).await.unwrap()
        };
        assert_eq!(
            grpc_header_status(&extra_frame),
            Some("3"),
            "a second message in one export is INVALID_ARGUMENT"
        );

        let oversized = grpc_frame(&message(2 * raw_limit));
        let streamed = router
            .call(grpc_export_request(raw_key, oversized.clone()))
            .await
            .unwrap();
        assert_eq!(
            grpc_header_status(&streamed),
            Some("8"),
            "a body past the raw limit is RESOURCE_EXHAUSTED"
        );
        let declared = {
            let mut request = grpc_export_request(raw_key, oversized.clone());
            request
                .headers_mut()
                .insert(axum::http::header::CONTENT_LENGTH, oversized.len().into());
            router.call(request).await.unwrap()
        };
        assert_eq!(
            grpc_header_status(&declared),
            Some("8"),
            "a declared length past the raw limit is refused before the body is read"
        );

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn grpc_export_past_the_memory_budget_is_resource_exhausted() {
        use tonic::codegen::Service as _;

        let (forward_url, mut forward_rx) = spawn_forward_collector().await;
        let queue_dir = unique_main_test_dir("grpc-decode-budget");
        let store = Arc::new(FakeKeyStore::default());
        let raw_key = "maple_sk_test_grpc_decode_budget";
        store.insert_private(
            raw_key,
            KeyRow {
                org_id: "org_grpc_decode_budget".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        let mut state = test_app_state(
            store,
            queue_dir.clone(),
            forward_url,
            Duration::from_millis(5),
        )
        .await;
        state.config.max_decode_heap_bytes = 4 * 1024 * 1024;
        let mut router = grpc_router(Arc::new(state));

        let message = many_empty_attributes(50_000).encode_to_vec();
        let plain = router
            .call(grpc_export_request(raw_key, grpc_frame(&message)))
            .await
            .unwrap();
        assert_eq!(grpc_header_status(&plain), Some("8"), "RESOURCE_EXHAUSTED");
        let mut gzip = grpc_export_request(raw_key, gzip_grpc_frame(&message));
        gzip.headers_mut()
            .insert("grpc-encoding", HeaderValue::from_static("gzip"));
        let gzip = router.call(gzip).await.unwrap();
        assert_eq!(grpc_header_status(&gzip), Some("8"), "RESOURCE_EXHAUSTED");
        assert!(forward_rx.try_recv().is_err(), "nothing refused is forwarded");

        let within = router
            .call(grpc_export_request(
                raw_key,
                grpc_frame(&many_empty_attributes(100).encode_to_vec()),
            ))
            .await
            .unwrap();
        assert_eq!(grpc_header_status(&within), None, "a batch within the budget is accepted");

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn grpc_admission_holds_the_org_slot_and_decode_memory_before_reading() {
        use tonic::codegen::Service as _;

        let (forward_url, _forward_rx) = spawn_forward_collector().await;
        let queue_dir = unique_main_test_dir("grpc-org-slot");
        let store = Arc::new(FakeKeyStore::default());
        let raw_key = "maple_sk_test_grpc_org_slot";
        store.insert_private(
            raw_key,
            KeyRow {
                org_id: "org_grpc_org_slot".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        let mut state = test_app_state(
            store,
            queue_dir.clone(),
            forward_url,
            Duration::from_millis(5),
        )
        .await;
        state.org_inflight_limiter = OrgInFlightLimiter::new(1);
        let state = Arc::new(state);
        let mut router = grpc_router(Arc::clone(&state));
        let undecodable_gzip = || {
            let mut request = grpc_export_request(raw_key, UNDECODABLE_BODY.to_vec());
            request
                .headers_mut()
                .insert("grpc-encoding", HeaderValue::from_static("gzip"));
            request
        };

        // The org's one slot is taken: refused before its bytes are read, so not a
        // decode error.
        let slot = state
            .org_inflight_limiter
            .try_acquire("org_grpc_org_slot")
            .unwrap();
        let refused = router.call(undecodable_gzip()).await.unwrap();
        assert_eq!(grpc_header_status(&refused), Some("8"), "RESOURCE_EXHAUSTED");
        drop(slot);

        // No decode memory is free: UNAVAILABLE, which exporters retry.
        let mut others = state.decode_memory.reservation();
        assert!(others.try_add(state.decode_memory.total_bytes()));
        let busy = router
            .call(grpc_export_request(
                raw_key,
                grpc_frame(&test_log_request("busy").encode_to_vec()),
            ))
            .await
            .unwrap();
        assert_eq!(grpc_header_status(&busy), Some("14"), "UNAVAILABLE");
        drop(others);

        let accepted = router
            .call(grpc_export_request(
                raw_key,
                grpc_frame(&test_log_request("accepted").encode_to_vec()),
            ))
            .await
            .unwrap();
        assert_eq!(grpc_header_status(&accepted), None);
        assert_eq!(state.decode_memory.reserved_bytes(), 0);
        assert!(
            state.org_inflight_limiter.try_acquire("org_grpc_org_slot").is_some(),
            "the slot is returned after the reply"
        );

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn grpc_export_past_the_deadline_is_unavailable() {
        use tonic::codegen::Service as _;

        let queue_dir = unique_main_test_dir("grpc-deadline");
        let store = Arc::new(FakeKeyStore::default());
        let raw_key = "maple_sk_test_grpc_deadline";
        store.insert_private(
            raw_key,
            KeyRow {
                org_id: "org_grpc_deadline".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        let mut state = test_app_state(
            store,
            queue_dir.clone(),
            "http://127.0.0.1:1".to_owned(),
            Duration::from_secs(30),
        )
        .await;
        state.config.request_timeout = Duration::from_millis(50);
        let mut router = grpc_router(Arc::new(state));

        // A client that sends half a frame and then stalls.
        let frame = grpc_frame(&test_log_request("stalled").encode_to_vec());
        let half = Bytes::copy_from_slice(&frame[..frame.len() / 2]);
        let stalled = futures_util::StreamExt::chain(
            futures_util::stream::once(async move { Ok::<_, std::io::Error>(half) }),
            futures_util::stream::pending(),
        );
        let mut request = grpc_export_request(raw_key, Vec::new());
        *request.body_mut() = axum::body::Body::from_stream(stalled);

        let response = tokio::time::timeout(Duration::from_secs(5), router.call(request))
            .await
            .expect("the gateway answers at its own deadline")
            .unwrap();
        assert_eq!(
            grpc_header_status(&response),
            Some("14"),
            "a stalled export is UNAVAILABLE, which exporters retry"
        );

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
        // Room for the 1 MiB exports below; the test config's raw limit is 1 MiB.
        let mut state = state;
        state.config.max_request_body_bytes = 4 * 1024 * 1024;

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

        // gzip is the OTel Collector's default exporter compression.
        let mut gzip_client = client.send_compressed(tonic::codec::CompressionEncoding::Gzip);
        gzip_client
            .export(export("maple_sk_test_wire_allowed", &large))
            .await
            .expect("a gzip export succeeds");
        tokio::time::timeout(Duration::from_secs(2), forward_rx.recv())
            .await
            .expect("a gzip export is forwarded")
            .expect("forward channel should stay open");

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
            Ingress::Otlp(Signal::Logs),
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
            Ingress::Otlp(Signal::Logs),
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
            Ingress::Otlp(Signal::Logs),
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
            &[],
        )
        .expect("fixture decrypts");
        assert_eq!(plaintext, "ch-secret-123");
    }

    const FIXTURE_KEY: &str = "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=";
    const OTHER_KEY: &str = "BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY=";
    // A v3 envelope sealed by SecretBox.ts for org "org_fixture" and `ch_url` = CH_URL under
    // FIXTURE_KEY. The same triple is opened in packages/backend/src/platform/secret-slots.test.ts.
    const CH_URL: &str = "https://ch.example.com:8443";
    const V3_CIPHERTEXT: &str = "v3.IGjfnBNl.xeDTFXH6xa2O+HjUIA==";
    const V3_IV: &str = "AAECAwQFBgcICQoL";
    const V3_TAG: &str = "kDzWdYJ8UBBoQYMWpL9KSg==";
    // The same password in the v2 envelope, bound to the org only.
    const V2_CIPHERTEXT: &str = "v2.IGjfnBNl.1HbzraIYWPNUxiGCnA==";
    const V2_IV: &str = "3gBID0+h49Y9q+SD";
    const V2_TAG: &str = "s2cyY7uChmyKqIcJzE8m7Q==";

    #[test]
    fn secret_keyring_opens_a_v3_password_only_at_the_url_it_was_sealed_for() {
        let keyring = SecretKeyring::parse(FIXTURE_KEY, None).expect("keyring parses");
        let opened =
            keyring.open_clickhouse_password("org_fixture", CH_URL, V3_CIPHERTEXT, V3_IV, V3_TAG);
        assert_eq!(opened, Ok("ch-secret-123".to_owned()));
        let moved = keyring.open_clickhouse_password(
            "org_fixture",
            "https://attacker.example:8443",
            V3_CIPHERTEXT,
            V3_IV,
            V3_TAG,
        );
        assert_eq!(moved, Err("Decryption failed".to_owned()));
    }

    #[test]
    fn secret_keyring_refuses_a_v3_password_moved_to_another_org() {
        let keyring = SecretKeyring::parse(FIXTURE_KEY, None).expect("keyring parses");
        let moved =
            keyring.open_clickhouse_password("org_other", CH_URL, V3_CIPHERTEXT, V3_IV, V3_TAG);
        assert_eq!(moved, Err("Decryption failed".to_owned()));
    }

    #[test]
    fn secret_keyring_opens_with_a_decrypt_only_key_after_rotation() {
        let rotated = SecretKeyring::parse(OTHER_KEY, Some(&format!(" {FIXTURE_KEY} ,")))
            .expect("keyring parses");
        let v3 =
            rotated.open_clickhouse_password("org_fixture", CH_URL, V3_CIPHERTEXT, V3_IV, V3_TAG);
        assert_eq!(v3, Ok("ch-secret-123".to_owned()));
    }

    #[test]
    fn secret_keyring_refuses_a_password_not_bound_to_its_url() {
        let keyring = SecretKeyring::parse(FIXTURE_KEY, None).expect("keyring parses");
        let v2 =
            keyring.open_clickhouse_password("org_fixture", CH_URL, V2_CIPHERTEXT, V2_IV, V2_TAG);
        let old = keyring.open_clickhouse_password(
            "org_fixture",
            CH_URL,
            "vDjK0A+Vv5bHlJ2a3A==",
            "AQIDBAUGBwgJCgsM",
            "b7D1umrvI8557NFvR9nJ/A==",
        );
        let unbound = Err("Stored value is not bound to its destination".to_owned());
        assert_eq!(v2, unbound);
        assert_eq!(old, unbound);
    }

    #[test]
    fn secret_keyring_names_a_missing_key_and_rejects_a_malformed_one() {
        let other = SecretKeyring::parse(OTHER_KEY, None).expect("keyring parses");
        let missing =
            other.open_clickhouse_password("org_fixture", CH_URL, V3_CIPHERTEXT, V3_IV, V3_TAG);
        assert_eq!(
            missing,
            Err("Sealed with a key this deployment does not hold".to_owned())
        );
        assert!(SecretKeyring::parse(FIXTURE_KEY, Some("not-a-key")).is_err());
    }

    // FIXTURE_KEY's slot keys, as `clickHousePasswordSlotKeys` in packages/infra derives them.
    // Pinned the same in packages/backend/src/platform/secret-slot-keys-parity.test.ts.
    const FIXTURE_SLOT_KEYS: &str = "IGjfnBNl:DxboU6BYcIHPRlnXrZyrpik+g9IlCixfjGcrpISh4AU=";

    fn slot_keys_of(master: &str) -> String {
        let key = SecretKey::new(parse_base64_aes256_gcm_key(master).expect("fixture key"))
            .expect("fixture derives");
        format!("{}:{}", key.id, STANDARD.encode(key.clickhouse_password_subkey))
    }

    #[test]
    fn secret_keyring_slot_keys_match_the_pinned_derivation() {
        assert_eq!(slot_keys_of(FIXTURE_KEY), FIXTURE_SLOT_KEYS);
    }

    #[test]
    fn secret_keyring_slot_keys_open_v3_and_refuse_an_unbound_v2() {
        let keyring = SecretKeyring::parse_slot_keys(FIXTURE_SLOT_KEYS).expect("slot keys parse");
        // Slot keys refuse an unbound v2 value exactly as the master key does (#2804).
        let v2 = keyring.open_clickhouse_password("org_fixture", CH_URL, V2_CIPHERTEXT, V2_IV, V2_TAG);
        assert_eq!(
            v2,
            Err("Stored value is not bound to its destination".to_owned())
        );
        let v3 = keyring.open_clickhouse_password("org_fixture", CH_URL, V3_CIPHERTEXT, V3_IV, V3_TAG);
        assert_eq!(v3, Ok("ch-secret-123".to_owned()));
        let moved = keyring.open_clickhouse_password(
            "org_fixture",
            "https://attacker.example:8443",
            V3_CIPHERTEXT,
            V3_IV,
            V3_TAG,
        );
        assert_eq!(moved, Err("Decryption failed".to_owned()));
        let other_org =
            keyring.open_clickhouse_password("org_other", CH_URL, V3_CIPHERTEXT, V3_IV, V3_TAG);
        assert_eq!(other_org, Err("Decryption failed".to_owned()));
    }

    #[test]
    fn secret_keyring_slot_keys_open_with_a_decrypt_only_entry_after_rotation() {
        let rotated = format!(" {} , {FIXTURE_SLOT_KEYS} ,", slot_keys_of(OTHER_KEY));
        let keyring = SecretKeyring::parse_slot_keys(&rotated).expect("slot keys parse");
        let v3 = keyring.open_clickhouse_password("org_fixture", CH_URL, V3_CIPHERTEXT, V3_IV, V3_TAG);
        assert_eq!(v3, Ok("ch-secret-123".to_owned()));
    }

    #[test]
    fn secret_keyring_slot_keys_refuse_a_wrong_key_id_or_subkey() {
        let wrong_id = SecretKeyring::parse_slot_keys(&FIXTURE_SLOT_KEYS.replace("IGjfnBNl", "AAAAAAAA"))
            .expect("slot keys parse");
        assert_eq!(
            wrong_id.open_clickhouse_password("org_fixture", CH_URL, V3_CIPHERTEXT, V3_IV, V3_TAG),
            Err("Sealed with a key this deployment does not hold".to_owned())
        );
        // The fixture's keyId with another master's subkey: a mislabelled key does not open.
        let other_subkey = slot_keys_of(OTHER_KEY);
        let (_, subkey) = other_subkey.split_once(':').expect("id:subkey");
        let mislabelled =
            SecretKeyring::parse_slot_keys(&format!("IGjfnBNl:{subkey}")).expect("slot keys parse");
        assert_eq!(
            mislabelled.open_clickhouse_password("org_fixture", CH_URL, V3_CIPHERTEXT, V3_IV, V3_TAG),
            Err("Decryption failed".to_owned())
        );
    }

    #[test]
    fn secret_keyring_slot_keys_reject_malformed_values() {
        for raw in [
            "",
            " , ",
            "IGjfnBNl",
            "IGjfnBNl:not-base64!",
            "IGjfnBNl:AAAA",
            "short:DxboU6BYcIHPRlnXrZyrpik+g9IlCixfjGcrpISh4AU=",
            "IGjfnBNl:DxboU6BYcIHPRlnXrZyrpik+g9IlCixfjGcrpISh4AU=,garbage",
            FIXTURE_KEY,
        ] {
            let parsed = SecretKeyring::parse_slot_keys(raw);
            assert!(parsed.is_err(), "{raw:?} should not parse");
        }
    }

    #[test]
    fn secret_keyring_prefers_slot_keys_and_falls_back_to_master_keys() {
        // Slot keys win: an unusable master beside them is never read.
        let from_slot_keys =
            SecretKeyring::from_env_values(Some(FIXTURE_SLOT_KEYS), Some("not-a-key"), None)
                .expect("slot keys used");
        assert!(from_slot_keys
            .open_clickhouse_password("org_fixture", CH_URL, V3_CIPHERTEXT, V3_IV, V3_TAG)
            .is_ok());
        // Blank slot keys fall back to the master key, as on a self-hosted deploy.
        let from_master = SecretKeyring::from_env_values(Some("  "), Some(FIXTURE_KEY), None)
            .expect("master key used");
        assert!(from_master
            .open_clickhouse_password("org_fixture", CH_URL, V3_CIPHERTEXT, V3_IV, V3_TAG)
            .is_ok());
        assert!(SecretKeyring::from_env_values(None, None, None).is_err());
        assert!(SecretKeyring::from_env_values(Some("IGjfnBNl:bad"), Some(FIXTURE_KEY), None).is_err());
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
            "org_fixture",
            ClickHouseTargetRow {
                ch_url: format!("{CH_URL}/"),
                ch_user: "ingest".to_owned(),
                // The fixture password in v3 for this exact `ch_url`, trailing slash included.
                ch_password_ciphertext: Some(V3_CIPHERTEXT.to_owned()),
                ch_password_iv: Some(V3_IV.to_owned()),
                ch_password_tag: Some("jkCOg5e0Y+nPj6FCPR0IPA==".to_owned()),
                ch_database: "maple".to_owned(),
                schema_version: CLICKHOUSE_SCHEMA_VERSION.to_owned(),
            },
        );

        let resolver = ClickHouseTargetResolver::new(
            store,
            Some(
                SecretKeyring::parse("BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=", None).unwrap(),
            ),
            16,
        );

        let target = resolver
            .resolve_clickhouse_target("org_fixture")
            .await
            .expect("target lookup should not fail")
            .expect("target should resolve");
        assert_eq!(target.endpoint, CH_URL);
        assert_eq!(target.user, "ingest");
        assert_eq!(target.password, "ch-secret-123");
        assert_eq!(target.database, "maple");
    }

    #[tokio::test]
    async fn clickhouse_target_resolver_rejects_password_over_http() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_clickhouse_target(
            "org_fixture",
            ClickHouseTargetRow {
                ch_url: "http://clickhouse.example/".to_owned(),
                ch_user: "ingest".to_owned(),
                // The fixture password sealed in v3 for this exact `ch_url`.
                ch_password_ciphertext: Some(V3_CIPHERTEXT.to_owned()),
                ch_password_iv: Some(V3_IV.to_owned()),
                ch_password_tag: Some("5P0wvEF8hm5nYU3du07Jtg==".to_owned()),
                ch_database: "maple".to_owned(),
                schema_version: CLICKHOUSE_SCHEMA_VERSION.to_owned(),
            },
        );

        let resolver = ClickHouseTargetResolver::new(
            store,
            Some(
                SecretKeyring::parse("BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=", None).unwrap(),
            ),
            16,
        );

        let error = resolver
            .resolve_clickhouse_target("org_fixture")
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
            retention: RetentionRow::default(),
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
            org_retention: RetentionOverrides::default(),
            retention: RetentionStamps::default(),
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
            retention: RetentionRow::default(),
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
            handle_signal_inner(&state, &test_headers(paused), body.clone(), Ingress::Otlp(Signal::Logs))
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
            handle_signal_inner(&state, &test_headers(expired), body, Ingress::Otlp(Signal::Logs))
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

        let (response, _items, _org_id, metered_bytes) = handle_signal_inner(
            &state,
            &test_headers(raw_key),
            body,
            Ingress::Otlp(Signal::Logs),
        )
                .await
                .expect("a collector 4xx is relayed, not raised");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(metered_bytes, 0, "a refused batch is not billed");
        assert!(recorded_key_uses(&store).await.is_empty());

        // Over gRPC the refusal is answered OK, and is not key use either.
        let resolved = state
            .resolver
            .resolve_ingest_key(raw_key)
            .await
            .expect("resolution should not fail")
            .expect("the test key resolves");
        let payload = test_log_request("refused over grpc");
        let decoded_bytes = payload.encoded_len();
        accept_grpc_decoded(
            &state,
            Signal::Logs,
            DecodedPayload::Logs(payload),
            &resolved,
            KeyAdmission::Ingest,
            Received::unbudgeted(decoded_bytes),
            &ClaimOutcome::default(),
        )
        .await
        .expect("a collector refusal over gRPC is answered OK");
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
            handle_signal_inner(&state, &test_headers(raw_key), body.clone(), Ingress::Otlp(Signal::Logs))
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
            handle_signal_inner(&state, &test_headers(raw_key), body.clone(), Ingress::Otlp(Signal::Traces))
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
        handle_signal_inner(&state, &test_headers(raw_key), body.clone(), Ingress::Otlp(Signal::Logs))
            .await
            .expect("the second request fits the burst");
        let (error, error_kind) =
            handle_signal_inner(&state, &test_headers(raw_key), body, Ingress::Otlp(Signal::Logs))
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
                org_retention: self.org_retention(&row.org_id),
                ..row
            }
        }

        /// Stores an org's `org_retention_policies.retention_days`.
        fn set_org_retention(&self, org_id: &str, retention_days: &str) {
            self.org_retention
                .lock()
                .unwrap()
                .insert(org_id.to_owned(), retention_days.to_owned());
        }

        /// Stores a source's `sources.retention_days`.
        fn set_source_retention(&self, source_id: &str, retention_days: &str) {
            self.source_retention
                .lock()
                .unwrap()
                .insert(source_id.to_owned(), retention_days.to_owned());
        }

        /// The org's policy as the `LEFT JOIN org_retention_policies` reads it.
        fn org_retention(&self, org_id: &str) -> RetentionOverrides {
            let stored = self.org_retention.lock().unwrap().get(org_id).cloned();
            RetentionOverrides::parse(stored.as_deref())
        }

        /// A source's own overrides, as its `retention_days` column reads.
        fn source_retention(&self, source_id: &str) -> RetentionOverrides {
            let stored = self.source_retention.lock().unwrap().get(source_id).cloned();
            RetentionOverrides::parse(stored.as_deref())
        }

        fn retention_row(&self, org_id: &str, source_id: Option<&str>) -> RetentionRow {
            RetentionRow {
                org: self.org_retention(org_id),
                source: source_id
                    .map(|id| self.source_retention(id))
                    .unwrap_or_default(),
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
                retention: self.source_retention(id),
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
            Ingress::Otlp(Signal::Logs),
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
            Ingress::Otlp(Signal::Logs),
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

    fn header_claimed_logs(header: Option<&str>, own_claim: Option<&str>) -> DecodedPayload {
        let mut request = test_log_request("header claim");
        let mut claimed = request.resource_logs[0].clone();
        if let Some(own_claim) = own_claim {
            claimed
                .resource
                .as_mut()
                .expect("resource")
                .attributes
                .push(string_attribute("maple_source_id", own_claim));
        }
        request.resource_logs.push(claimed);
        request.resource_logs.push(ResourceLogs::default());
        let mut decoded = DecodedPayload::Logs(request);
        let mut headers = HeaderMap::new();
        if let Some(header) = header {
            headers.insert(SOURCE_ID_HEADER, header.parse().expect("header value"));
        }
        apply_header_source_claim(&mut decoded, &headers, &test_key());
        decoded
    }

    fn resource_claims(decoded: &DecodedPayload) -> Vec<Option<String>> {
        let DecodedPayload::Logs(request) = decoded else {
            panic!("logs");
        };
        request
            .resource_logs
            .iter()
            .map(|r| {
                r.resource
                    .as_ref()
                    .and_then(|resource| source_id_claim(&resource.attributes))
                    .map(str::to_owned)
            })
            .collect()
    }

    #[test]
    fn the_source_header_claims_every_resource_without_its_own() {
        let header = public_id(INTEGRATION_SOURCE_UUID);
        let own = public_id(SOURCE_UUID);
        assert_eq!(
            resource_claims(&header_claimed_logs(Some(&header), Some(&own))),
            vec![Some(header.clone()), Some(own), Some(header)]
        );
        assert_eq!(
            resource_claims(&header_claimed_logs(Some("  "), None)),
            vec![None, None, None]
        );
        let oversized = "s".repeat(MAX_PUBLIC_ID_LEN + 1);
        assert_eq!(
            resource_claims(&header_claimed_logs(Some(&oversized), None)),
            vec![None, None, None]
        );
    }

    #[test]
    fn the_source_header_is_ignored_for_source_tokens() {
        let mut decoded = DecodedPayload::Logs(test_log_request("token"));
        let mut headers = HeaderMap::new();
        headers.insert(
            SOURCE_ID_HEADER,
            public_id(INTEGRATION_SOURCE_UUID)
                .parse()
                .expect("header value"),
        );
        let token = ResolvedIngestKey {
            key_type: IngestKeyType::Source,
            ..test_key()
        };
        apply_header_source_claim(&mut decoded, &headers, &token);
        assert_eq!(resource_claims(&decoded), vec![None]);
    }

    #[tokio::test]
    async fn header_claims_are_verified_like_attribute_claims() {
        let (forward_url, mut forward_rx) = spawn_capturing_logs_collector().await;
        let queue_dir = unique_main_test_dir("header-source-claim");
        let store = Arc::new(FakeKeyStore::default());
        let raw_key = "maple_sk_header_source_claim";
        store.insert_private(
            raw_key,
            KeyRow {
                org_id: "org_header_claim".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        store.insert_source_row("org_header_claim", DEFAULT_SOURCE_UUID, "default");
        store.insert_source_row("org_header_claim", INTEGRATION_SOURCE_UUID, "integration");
        store.insert_source_row("org_someone_else", SOURCE_UUID, "token");
        let state = test_app_state(
            Arc::clone(&store),
            queue_dir.clone(),
            forward_url,
            Duration::from_secs(30),
        )
        .await;

        let mut stamped = Vec::new();
        for header in [public_id(INTEGRATION_SOURCE_UUID), public_id(SOURCE_UUID)] {
            let mut headers = test_headers(raw_key);
            headers.insert(SOURCE_ID_HEADER, header.parse().expect("header value"));
            let (response, ..) = handle_signal_inner(
                &state,
                &headers,
                Bytes::from(test_log_request("header claim").encode_to_vec()),
                Ingress::Otlp(Signal::Logs),
            )
            .await
            .expect("default key traffic is accepted");
            assert_eq!(response.status(), StatusCode::OK);
            let forwarded = tokio::time::timeout(Duration::from_secs(2), forward_rx.recv())
                .await
                .expect("the export is forwarded")
                .expect("forward channel should stay open");
            let forwarded =
                ExportLogsServiceRequest::decode(forwarded).expect("forwarded protobuf");
            let resource = forwarded.resource_logs[0]
                .resource
                .as_ref()
                .expect("resource");
            stamped.push(string_attributes(&resource.attributes)["maple_source_id"].clone());
        }
        // The org's own source is kept; another org's id gives way to the default source.
        assert_eq!(
            stamped,
            vec![
                public_id(INTEGRATION_SOURCE_UUID),
                public_id(DEFAULT_SOURCE_UUID)
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
            Ingress::Otlp(Signal::Logs),
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
            Ingress::Otlp(Signal::Logs),
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
            Ingress::Otlp(Signal::Logs),
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
                    Ingress::Otlp(Signal::Logs),
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
                handle_signal_inner(&state, &test_headers(raw_key), body.clone(), Ingress::Otlp(Signal::Logs))
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
                    org_retention: RetentionOverrides::default(),
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
        let (response, ..) = handle_signal_inner(&state, &test_headers(raw_key), Bytes::from(body), Ingress::Otlp(Signal::Logs))
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
            handle_signal_inner(&state, &test_headers(raw_key), Bytes::from(body), Ingress::Otlp(Signal::Logs))
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
            handle_signal_inner(&state, &test_headers(raw_key), Bytes::from(body), Ingress::Otlp(Signal::Logs))
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
            handle_signal_inner(&state, &test_headers(raw_key), Bytes::from(body.clone()), Ingress::Otlp(Signal::Logs))
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
            handle_signal_inner(&state, &test_headers(raw_key), Bytes::from(body), Ingress::Otlp(Signal::Logs)).await
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

    /// Sends one email-bearing log as `raw_key` and returns the refusal and the kind its span
    /// records; nothing may be forwarded.
    async fn refused_unforwarded(
        state: &AppState,
        raw_key: &str,
        forward_rx: &mut tokio::sync::mpsc::UnboundedReceiver<Bytes>,
    ) -> (ApiError, &'static str) {
        let body = log_request_at("login from jane@example.com", 9).encode_to_vec();
        let Err((error, kind)) =
            handle_signal_inner(state, &test_headers(raw_key), Bytes::from(body), Ingress::Otlp(Signal::Logs)).await
        else {
            panic!("the payload must be refused");
        };
        assert!(
            tokio::time::timeout(Duration::from_millis(100), forward_rx.recv())
                .await
                .is_err(),
            "nothing may be forwarded unredacted"
        );
        (error, kind)
    }

    #[tokio::test]
    async fn rules_past_the_org_regex_budget_refuse_that_org_only() {
        let (forward_url, mut forward_rx) = spawn_capturing_logs_collector().await;
        let raw_key = "maple_sk_rules_heavy";
        let (state, store, queue_dir) =
            rules_forward_state("rules-heavy", raw_key, "org_rules_heavy", forward_url).await;
        // Each `\w{17}` compiles to just under 1 MiB; 24 of them pass the org budget.
        let heavy = serde_json::json!({
            "signals": ["logs"],
            "conditions": [],
            "action": { "_tag": "redact", "keys": [], "detectors": [], "patterns": [r"\w{17}"],
                "scopes": ["attributes"], "method": "mask" }
        });
        let mut rules = vec![mask_emails_rule()];
        rules.extend(std::iter::repeat_n(heavy, 24));
        store.set_ingest_rules("org_rules_heavy", &rules);
        let other_key = "maple_sk_rules_light";
        store.insert_private(
            other_key,
            KeyRow {
                org_id: "org_rules_light".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        store.set_ingest_rules("org_rules_light", &[mask_emails_rule()]);
        let state = with_ingest_rules(state, &store);

        for _ in 0..2 {
            let (error, _) = refused_unforwarded(&state, raw_key, &mut forward_rx).await;
            assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
        }
        assert_eq!(
            store.ingest_rule_fetches.load(Ordering::Relaxed),
            1,
            "the refusal is cached, not recompiled per request"
        );

        let body = log_request_at("login from jane@example.com", 9).encode_to_vec();
        handle_signal_inner(&state, &test_headers(other_key), Bytes::from(body), Ingress::Otlp(Signal::Logs))
            .await
            .expect("another org's rules still apply");
        let forwarded = next_forwarded_logs(&mut forward_rx).await;
        assert_eq!(forwarded_bodies(&forwarded), ["login from [REDACTED:email]"]);

        drop(std::fs::remove_dir_all(&queue_dir));
    }

    #[tokio::test]
    async fn a_payload_past_the_rule_scan_budget_is_refused_with_413() {
        let (forward_url, mut forward_rx) = spawn_capturing_logs_collector().await;
        let raw_key = "maple_sk_rules_scan";
        let (mut state, store, queue_dir) =
            rules_forward_state("rules-scan", raw_key, "org_rules_scan", forward_url).await;
        store.set_ingest_rules("org_rules_scan", &[mask_emails_rule()]);
        // The 27-byte body is scanned again after a mask: 54 bytes.
        state.ingest_rule_resolver =
            IngestRuleResolver::new(Arc::<FakeKeyStore>::clone(&store), true, Duration::from_secs(30), 16)
                .with_scan_budget(40);

        let (error, kind) = refused_unforwarded(&state, raw_key, &mut forward_rx).await;
        assert_eq!(error.status, StatusCode::PAYLOAD_TOO_LARGE);
        // `kind` is what the HTTP server span records.
        assert_eq!(
            otel_status_for_rejection(error.status.as_u16(), kind),
            "Error",
            "the sender's data is lost, so the span must count as an error"
        );

        // Over gRPC the refusal is a code exporters do not retry.
        let resolved = state
            .resolver
            .resolve_ingest_key(raw_key)
            .await
            .expect("resolution should not fail")
            .expect("the test key resolves");
        let payload = log_request_at("login from jane@example.com", 9);
        let decoded_bytes = payload.encoded_len();
        let status = accept_grpc_decoded(
            &state,
            Signal::Logs,
            DecodedPayload::Logs(payload),
            &resolved,
            KeyAdmission::Ingest,
            Received::unbudgeted(decoded_bytes),
            &ClaimOutcome::default(),
        )
        .await
        .expect_err("past the scan budget");
        assert_eq!(status.code(), tonic::Code::Internal);
        assert_eq!(grpc_otel_status_for_rejection(status.code()), "Error");

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
            handle_signal_inner(&state, &test_headers(raw_key), Bytes::from(body), Ingress::Otlp(Signal::Logs)).await;
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
            "($1, $2, to_timestamp($3::bigint / 1000.0), $4, $5::bigint, $6::bigint, $7::bigint, $8::bigint, $9::bigint), \
             ($10, $11, to_timestamp($12::bigint / 1000.0), $13, $14::bigint, $15::bigint, $16::bigint, $17::bigint, $18::bigint)"
        ));
        assert!(sql.contains("dropped_bytes = org_ingest_rule_stats.dropped_bytes + EXCLUDED.dropped_bytes"));
        assert!(sql.contains("parse_failed = org_ingest_rule_stats.parse_failed + EXCLUDED.parse_failed"));
    }

    /// Prometheus remote write, posted over HTTP to the gateway's own routes.
    mod prometheus_write {
        use super::*;
        use maple_ingest::prometheus_remote_write::{
            Label, MetricMetadata, MetricType, Sample, TimeSeries, WriteRequest, STALE_NAN_BITS,
        };

        const T0: i64 = 1_700_000_000_000;

        fn series(labels: &[(&str, &str)], samples: &[(f64, i64)]) -> TimeSeries {
            TimeSeries {
                labels: labels
                    .iter()
                    .map(|(name, value)| Label {
                        name: (*name).to_owned(),
                        value: (*value).to_owned(),
                    })
                    .collect(),
                samples: samples
                    .iter()
                    .map(|&(value, timestamp)| Sample { value, timestamp })
                    .collect(),
                exemplars: Vec::new(),
                histograms: Vec::new(),
            }
        }

        fn snappy(plain: &[u8]) -> Vec<u8> {
            snap::raw::Encoder::new().compress_vec(plain).unwrap()
        }

        /// One scrape of an `api` target as Prometheus would write it: a counter, a
        /// gauge, two buckets of a classic histogram, and what Maple does not store.
        fn scrape() -> WriteRequest {
            let target = [("instance", "10.0.0.1:9090"), ("job", "api")];
            let with = |name: &'static str, extra: &[(&'static str, &'static str)]| {
                let mut labels = vec![("__name__", name)];
                labels.extend_from_slice(extra);
                labels.extend_from_slice(&target);
                labels
            };
            WriteRequest {
                timeseries: vec![
                    series(
                        &with("http_requests_total", &[("code", "200")]),
                        &[(1027.0, T0)],
                    ),
                    series(&with("process_resident_memory_bytes", &[]), &[(5.5e7, T0)]),
                    series(
                        &with("rpc_duration_seconds_bucket", &[("le", "0.5")]),
                        &[(12.0, T0)],
                    ),
                    series(
                        &with("rpc_duration_seconds_bucket", &[("le", "+Inf")]),
                        &[(20.0, T0)],
                    ),
                    series(&with("up", &[]), &[(f64::from_bits(STALE_NAN_BITS), T0)]),
                    series(&target, &[(1.0, T0)]),
                ],
                metadata: vec![MetricMetadata {
                    kind: MetricType::Gauge.into(),
                    metric_family_name: "process_resident_memory_bytes".to_owned(),
                    help: "Resident memory size in bytes.".to_owned(),
                    unit: "bytes".to_owned(),
                }],
            }
        }

        /// A gateway with one private key, forwarding to `forward_endpoint`.
        async fn gateway_state(
            raw_key: &str,
            org_id: &str,
            queue_dir: &std::path::Path,
            forward_endpoint: String,
        ) -> AppState {
            let store = Arc::new(FakeKeyStore::default());
            store.insert_private(
                raw_key,
                KeyRow {
                    org_id: org_id.to_owned(),
                    self_managed: false,
                    clickhouse_ready: false,
                },
            );
            test_app_state(
                store,
                queue_dir.to_path_buf(),
                forward_endpoint,
                Duration::from_secs(30),
            )
            .await
        }

        /// Serves the gateway's routes on a local port; returns the remote write URL.
        async fn serve(state: AppState) -> String {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            let url = format!(
                "http://{}{}",
                listener.local_addr().unwrap(),
                prometheus_remote_write::ROUTE
            );
            let app = ingest_routes().with_state(Arc::new(state));
            tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            url
        }

        /// A request with the headers Prometheus sets on a 1.0 remote write.
        fn remote_write(url: &str, body: Vec<u8>) -> reqwest::RequestBuilder {
            Client::new()
                .post(url)
                .header(CONTENT_ENCODING, "snappy")
                .header(CONTENT_TYPE, "application/x-protobuf")
                .header("X-Prometheus-Remote-Write-Version", "0.1.0")
                .header("User-Agent", "Prometheus/3.5.0")
                .body(body)
        }

        /// The response's status and the `code` of its error envelope.
        async fn outcome(request: reqwest::RequestBuilder) -> (StatusCode, String) {
            let response = request.send().await.expect("the gateway answers");
            let status = response.status();
            let body: serde_json::Value = response.json().await.unwrap_or_default();
            (
                status,
                body["error"]["code"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
            )
        }

        /// A collector for `WriteMode::Forward` that keeps what it is sent at `/v1/metrics`.
        async fn spawn_metrics_collector() -> (
            String,
            tokio::sync::mpsc::UnboundedReceiver<(HeaderMap, Bytes)>,
        ) {
            async fn capture(
                State(tx): State<tokio::sync::mpsc::UnboundedSender<(HeaderMap, Bytes)>>,
                headers: HeaderMap,
                body: Bytes,
            ) -> StatusCode {
                drop(tx.send((headers, body)));
                StatusCode::OK
            }
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            let addr = listener.local_addr().unwrap();
            let app = Router::new()
                .route("/v1/metrics", post(capture))
                .with_state(tx);
            tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            (format!("http://{addr}"), rx)
        }

        /// Rows the fake Tinybird received, by datasource, until `expected` rows arrived.
        async fn imported_rows(
            imports: &mut TinybirdImports,
            expected: usize,
        ) -> HashMap<String, Vec<serde_json::Value>> {
            let mut rows: HashMap<String, Vec<serde_json::Value>> = HashMap::new();
            while rows.values().map(Vec::len).sum::<usize>() < expected {
                let (datasource, ndjson) =
                    tokio::time::timeout(Duration::from_secs(5), imports.recv())
                        .await
                        .expect("the rows are exported")
                        .expect("the import channel stays open");
                rows.entry(datasource).or_default().extend(
                    ndjson
                        .lines()
                        .map(|line| serde_json::from_str(line).expect("a row is JSON")),
                );
            }
            rows
        }

        #[tokio::test]
        async fn a_remote_write_is_stored_as_otlp_metric_rows() {
            let queue_dir = unique_main_test_dir("prometheus-native");
            let raw_key = "maple_sk_test_prometheus_native";
            let mut state = gateway_state(
                raw_key,
                "org_prometheus",
                &queue_dir,
                "http://127.0.0.1:1".to_owned(),
            )
            .await;
            let mut imports = store_in_fake_tinybird(&mut state, test_tinybird_config(queue_dir.join("native"))).await;
            let (state, mut autumn) = with_fake_autumn(state).await;
            let url = serve(state).await;

            let plain = scrape().encode_to_vec();
            let response = remote_write(&url, snappy(&plain))
                .bearer_auth(raw_key)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);

            let rows = imported_rows(&mut imports, 4).await;
            // (name, value, is_monotonic, aggregation_temporality), then the `le` attribute.
            let sums: Vec<_> = rows["metrics_sum"]
                .iter()
                .map(|row| {
                    (
                        row["metric_name"].as_str().unwrap(),
                        row["value"].as_f64().unwrap(),
                        row["is_monotonic"].as_bool().unwrap(),
                        row["aggregation_temporality"].as_i64().unwrap(),
                        row["metric_attributes"]["le"].as_str(),
                    )
                })
                .collect();
            assert_eq!(
                sums,
                vec![
                    ("http_requests_total", 1027.0, true, 2, None),
                    ("rpc_duration_seconds_bucket", 12.0, true, 2, Some("0.5")),
                    ("rpc_duration_seconds_bucket", 20.0, true, 2, Some("+Inf")),
                ]
            );
            let counter = &rows["metrics_sum"][0];
            assert_eq!(
                counter["metric_attributes"],
                serde_json::json!({ "code": "200", "instance": "10.0.0.1:9090", "job": "api" })
            );
            assert_eq!(
                counter["resource_attributes"],
                serde_json::json!({
                    "maple_ingest_key_type": "private",
                    "maple_ingest_source": "prometheus-remote-write",
                    "maple_org_id": "org_prometheus",
                    "service.instance.id": "10.0.0.1:9090",
                    "service.name": "api",
                })
            );
            assert_eq!(counter["service_name"], "api");
            assert_eq!(counter["scope_name"], "maple-prometheus-remote-write");
            assert_eq!(counter["timestamp"], "2023-11-14 22:13:20.000000000");
            assert_eq!(
                counter["start_timestamp"], "1970-01-01 00:00:00.000000000",
                "remote write does not say when a series started"
            );
            assert_eq!(counter["flags"], 0);

            // The stale `up` sample and the series without a name left no row.
            assert_eq!(rows["metrics_gauge"].len(), 1);
            let gauge = &rows["metrics_gauge"][0];
            assert_eq!(gauge["metric_name"], "process_resident_memory_bytes");
            assert_eq!(gauge["value"], 5.5e7);
            assert_eq!(gauge["metric_unit"], "bytes");
            assert_eq!(
                gauge["metric_description"],
                "Resident memory size in bytes."
            );
            assert_eq!(rows.len(), 2, "only sums and gauges: {:?}", rows.keys());

            // Metered once, as metrics, on the size of the OTLP request it was mapped to.
            let (mapped, _) = prometheus_remote_write::decode(&plain).unwrap();
            let calls = drain_autumn_calls(&mut autumn).await;
            assert_eq!(
                tracked(&calls),
                vec![("metrics", billable_gb(mapped.encoded_len() as u64))],
                "{calls:?}"
            );
            drop(std::fs::remove_dir_all(&queue_dir));
        }

        #[tokio::test]
        async fn many_samples_of_one_series_are_metered_for_what_they_store() {
            let queue_dir = unique_main_test_dir("prometheus-metered");
            let raw_key = "maple_sk_test_prometheus_metered";
            let mut state = gateway_state(
                raw_key,
                "org_prometheus_metered",
                &queue_dir,
                "http://127.0.0.1:1".to_owned(),
            )
            .await;
            let mut imports = store_in_fake_tinybird(&mut state, test_tinybird_config(queue_dir.join("native"))).await;
            let (state, mut autumn) = with_fake_autumn(state).await;
            let url = serve(state).await;

            // One series with wide labels and 200 samples: the labels cross the wire once
            // and are stored 200 times.
            let wide = "x".repeat(200);
            let names: Vec<String> = (0..8).map(|i| format!("label_{i}")).collect();
            let mut pairs: Vec<(&str, &str)> = vec![("__name__", "queue_depth"), ("job", "api")];
            pairs.extend(names.iter().map(|name| (name.as_str(), wide.as_str())));
            let samples: Vec<(f64, i64)> = (0..200_i32)
                .map(|i| (f64::from(i), T0 + i64::from(i) * 1000))
                .collect();
            let plain = WriteRequest {
                timeseries: vec![series(&pairs, &samples)],
                metadata: Vec::new(),
            }
            .encode_to_vec();

            let response = remote_write(&url, snappy(&plain))
                .bearer_auth(raw_key)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let rows = imported_rows(&mut imports, 200).await;
            assert_eq!(rows["metrics_gauge"].len(), 200);

            let calls = drain_autumn_calls(&mut autumn).await;
            let billed = tracked(&calls);
            assert_eq!(billed.len(), 1, "{calls:?}");
            // The wire form is about 5 kB; what is stored, and billed, is over fifty times that.
            assert!(
                billed[0].1 > billable_gb(50 * plain.len() as u64),
                "billed {:?} for {} wire bytes",
                billed[0].1,
                plain.len()
            );
            drop(std::fs::remove_dir_all(&queue_dir));
        }

        #[tokio::test]
        async fn a_remote_write_is_forwarded_to_the_collector_as_otlp() {
            let (forward_url, mut forwarded) = spawn_metrics_collector().await;
            let queue_dir = unique_main_test_dir("prometheus-forward");
            let raw_key = "maple_sk_test_prometheus_forward";
            let state =
                gateway_state(raw_key, "org_prometheus_forward", &queue_dir, forward_url).await;
            let url = serve(state).await;

            let response = remote_write(&url, snappy(&scrape().encode_to_vec()))
                .basic_auth("maple", Some(raw_key))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);

            let (headers, body) = tokio::time::timeout(Duration::from_secs(2), forwarded.recv())
                .await
                .expect("the batch is forwarded")
                .expect("the collector channel stays open");
            assert_eq!(headers[CONTENT_TYPE], "application/x-protobuf");
            assert!(
                !headers.contains_key(CONTENT_ENCODING),
                "the collector is sent OTLP, not the sender's snappy"
            );
            let request = ExportMetricsServiceRequest::decode(body).expect("OTLP metrics");
            assert_eq!(request.resource_metrics.len(), 1);
            let resource = string_attributes(
                &request.resource_metrics[0]
                    .resource
                    .as_ref()
                    .unwrap()
                    .attributes,
            );
            assert_eq!(resource["service.name"], "api");
            assert_eq!(resource["service.instance.id"], "10.0.0.1:9090");
            assert_eq!(resource["maple_org_id"], "org_prometheus_forward");
            assert_eq!(resource["maple_ingest_source"], "prometheus-remote-write");
            let metrics: Vec<_> = request.resource_metrics[0].scope_metrics[0]
                .metrics
                .iter()
                .map(|metric| {
                    let kind = match &metric.data {
                        Some(metric::Data::Sum(sum)) if sum.is_monotonic => "monotonic_sum",
                        Some(metric::Data::Gauge(_)) => "gauge",
                        other => panic!("{} became {other:?}", metric.name),
                    };
                    (metric.name.as_str(), kind)
                })
                .collect();
            assert_eq!(
                metrics,
                vec![
                    ("http_requests_total", "monotonic_sum"),
                    ("process_resident_memory_bytes", "gauge"),
                    ("rpc_duration_seconds_bucket", "monotonic_sum"),
                ]
            );
            drop(std::fs::remove_dir_all(&queue_dir));
        }

        #[tokio::test]
        async fn the_ingest_key_is_read_from_every_place_prometheus_can_put_it() {
            let (forward_url, mut forwarded) = spawn_metrics_collector().await;
            let queue_dir = unique_main_test_dir("prometheus-auth");
            let raw_key = "maple_sk_test_prometheus_auth";
            let state =
                gateway_state(raw_key, "org_prometheus_auth", &queue_dir, forward_url).await;
            let url = serve(state).await;
            let body = || snappy(&scrape().encode_to_vec());
            let basic = |credentials: &str| format!("Basic {}", STANDARD.encode(credentials));

            // `authorization.credentials`, `basic_auth.password` under any username, and
            // the header OTLP senders use.
            let accepted = [
                remote_write(&url, body()).bearer_auth(raw_key),
                remote_write(&url, body()).basic_auth("maple", Some(raw_key)),
                remote_write(&url, body()).basic_auth("", Some(raw_key)),
                remote_write(&url, body()).header(
                    AUTHORIZATION,
                    format!("basic {}", STANDARD.encode(format!("x:{raw_key}"))),
                ),
                remote_write(&url, body()).header("x-maple-ingest-key", raw_key),
            ];
            for request in accepted {
                assert_eq!(outcome(request).await, (StatusCode::OK, String::new()));
                tokio::time::timeout(Duration::from_secs(2), forwarded.recv())
                    .await
                    .expect("an authenticated write is forwarded")
                    .expect("the collector channel stays open");
            }

            let refused = [
                ("no credential", remote_write(&url, body())),
                (
                    "an unknown bearer token",
                    remote_write(&url, body()).bearer_auth("maple_sk_test_unknown"),
                ),
                (
                    "an unknown password",
                    remote_write(&url, body()).basic_auth("maple", Some("maple_sk_test_unknown")),
                ),
                (
                    "the key as the username",
                    remote_write(&url, body()).basic_auth(raw_key, None::<&str>),
                ),
                (
                    "an empty password",
                    remote_write(&url, body()).basic_auth(raw_key, Some("")),
                ),
                (
                    "basic auth that is not base64",
                    remote_write(&url, body()).header(AUTHORIZATION, "Basic not base64!"),
                ),
                (
                    "basic auth without a colon",
                    remote_write(&url, body()).header(AUTHORIZATION, basic(raw_key)),
                ),
                (
                    "another scheme",
                    remote_write(&url, body()).header(AUTHORIZATION, format!("Digest {raw_key}")),
                ),
            ];
            for (case, request) in refused {
                assert_eq!(
                    outcome(request).await,
                    (StatusCode::UNAUTHORIZED, "ingest_unauthorized".to_owned()),
                    "{case}"
                );
            }
            assert!(
                forwarded.try_recv().is_err(),
                "an unauthenticated write stores nothing"
            );

            // The public test token looks accepted and stores nothing, as on OTLP.
            assert_eq!(
                outcome(remote_write(&url, body()).bearer_auth(SENTINEL_TOKEN)).await,
                (StatusCode::OK, String::new())
            );
            assert!(forwarded.try_recv().is_err());
            drop(std::fs::remove_dir_all(&queue_dir));
        }

        #[tokio::test]
        async fn a_source_token_is_held_to_its_signals_and_rate_like_otlp_metrics() {
            let (forward_url, _forwarded) = spawn_metrics_collector().await;
            let queue_dir = unique_main_test_dir("prometheus-source");
            let store = Arc::new(FakeKeyStore::default());
            let logs_only = "maple_src_prometheus_logs_only_00000000000000";
            let limited = "maple_src_prometheus_one_per_second_000000000";
            store.insert_source(
                logs_only,
                source_row(
                    "org_prometheus_source",
                    source_config(Some(r#"["logs"]"#), None, "[]"),
                ),
            );
            store.insert_source(
                limited,
                source_row(
                    "org_prometheus_source",
                    source_config(Some(r#"["metrics"]"#), Some(1), "[]"),
                ),
            );
            let state = test_app_state(
                store,
                queue_dir.clone(),
                forward_url,
                Duration::from_secs(30),
            )
            .await;
            let url = serve(state).await;
            let body = || snappy(&scrape().encode_to_vec());

            assert_eq!(
                outcome(remote_write(&url, body()).bearer_auth(logs_only)).await,
                (
                    StatusCode::FORBIDDEN,
                    "ingest_signal_not_allowed".to_owned()
                )
            );

            assert_eq!(
                outcome(remote_write(&url, body()).bearer_auth(limited)).await,
                (StatusCode::OK, String::new())
            );
            // Prometheus retries a 429 after the delay the gateway names.
            let throttled = remote_write(&url, body())
                .bearer_auth(limited)
                .send()
                .await
                .unwrap();
            assert_eq!(throttled.status(), StatusCode::TOO_MANY_REQUESTS);
            assert_eq!(throttled.headers()[RETRY_AFTER], "1");
            drop(std::fs::remove_dir_all(&queue_dir));
        }

        #[tokio::test]
        async fn a_body_that_is_not_a_snappy_write_request_is_a_400() {
            let (forward_url, mut forwarded) = spawn_metrics_collector().await;
            let queue_dir = unique_main_test_dir("prometheus-malformed");
            let raw_key = "maple_sk_test_prometheus_malformed";
            let state =
                gateway_state(raw_key, "org_prometheus_malformed", &queue_dir, forward_url).await;
            let url = serve(state).await;

            let plain = scrape().encode_to_vec();
            let valid = snappy(&plain);
            let mut framed = Vec::new();
            {
                let mut encoder = snap::write::FrameEncoder::new(&mut framed);
                encoder.write_all(&plain).unwrap();
                encoder.flush().unwrap();
            }
            let cases = [
                ("an empty body", Vec::new()),
                ("the protobuf uncompressed", plain.clone()),
                (
                    "a truncated snappy block",
                    valid[..valid.len() / 2].to_vec(),
                ),
                ("the snappy framed format", framed),
                ("a gzip body", gzip_bytes(&plain).to_vec()),
                ("snappy of something else", snappy(b"{\"timeseries\":[]}")),
                (
                    "snappy of a truncated request",
                    snappy(&plain[..plain.len() - 3]),
                ),
            ];
            for (case, body) in cases {
                assert_eq!(
                    outcome(remote_write(&url, body).bearer_auth(raw_key)).await,
                    (StatusCode::BAD_REQUEST, "ingest_bad_request".to_owned()),
                    "{case}"
                );
            }
            assert!(
                forwarded.try_recv().is_err(),
                "a refused body stores nothing"
            );

            // Without the header the body is still read as snappy.
            let unlabelled = Client::new().post(&url).bearer_auth(raw_key).body(valid);
            assert_eq!(outcome(unlabelled).await, (StatusCode::OK, String::new()));
            drop(std::fs::remove_dir_all(&queue_dir));
        }

        #[tokio::test]
        async fn version_2_and_other_encodings_are_a_415() {
            let (forward_url, mut forwarded) = spawn_metrics_collector().await;
            let queue_dir = unique_main_test_dir("prometheus-unsupported");
            let raw_key = "maple_sk_test_prometheus_unsupported";
            let state = gateway_state(
                raw_key,
                "org_prometheus_unsupported",
                &queue_dir,
                forward_url,
            )
            .await;
            let url = serve(state).await;
            let plain = scrape().encode_to_vec();

            // Each sets its own `Content-Type`: `header` would add a second one.
            let typed = |content_type: &'static str| {
                Client::new()
                    .post(&url)
                    .bearer_auth(raw_key)
                    .header(CONTENT_ENCODING, "snappy")
                    .header(CONTENT_TYPE, content_type)
                    .body(snappy(&plain))
            };
            let v2 = typed("application/x-protobuf;proto=io.prometheus.write.v2.Request")
                .header("X-Prometheus-Remote-Write-Version", "2.0.0")
                .send()
                .await
                .unwrap();
            assert_eq!(v2.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
            let body: serde_json::Value = v2.json().await.unwrap();
            assert_eq!(
                body["error"]["message"],
                "Prometheus remote write 2.0 is not supported yet; send version 1.0 \
                 (prometheus.WriteRequest)"
            );

            // The parameter may be a quoted string.
            let quoted = typed("application/x-protobuf; proto=\"io.prometheus.write.v2.Request\"");
            assert_eq!(
                outcome(quoted).await,
                (
                    StatusCode::UNSUPPORTED_MEDIA_TYPE,
                    "ingest_unsupported_media_type".to_owned()
                )
            );

            // The version 1.0 content type, spelled out, is accepted.
            let v1 = typed("application/x-protobuf;proto=prometheus.WriteRequest");
            assert_eq!(outcome(v1).await, (StatusCode::OK, String::new()));
            assert!(forwarded.recv().await.is_some());

            for encoding in ["gzip", "zstd"] {
                let request = Client::new()
                    .post(&url)
                    .bearer_auth(raw_key)
                    .header(CONTENT_ENCODING, encoding)
                    .body(gzip_bytes(&plain));
                assert_eq!(
                    outcome(request).await,
                    (
                        StatusCode::UNSUPPORTED_MEDIA_TYPE,
                        "ingest_unsupported_media_type".to_owned()
                    ),
                    "{encoding}"
                );
            }
            assert!(forwarded.try_recv().is_err());
            drop(std::fs::remove_dir_all(&queue_dir));
        }

        #[tokio::test]
        async fn a_write_that_inflates_or_decodes_past_the_limits_is_a_413() {
            let (forward_url, mut forwarded) = spawn_metrics_collector().await;
            let queue_dir = unique_main_test_dir("prometheus-too-large");
            let raw_key = "maple_sk_test_prometheus_too_large";
            let mut state =
                gateway_state(raw_key, "org_prometheus_too_large", &queue_dir, forward_url).await;
            state.config.max_decoded_body_bytes = 64 * 1024;
            state.config.max_decode_heap_bytes = 4 * 1024 * 1024;
            let memory = state.decode_memory.clone();
            let url = serve(state).await;
            let too_large = (
                StatusCode::PAYLOAD_TOO_LARGE,
                "ingest_payload_too_large".to_owned(),
            );

            // Five bytes that declare 4 GiB: refused on the header, nothing inflated.
            let bomb = vec![0xff, 0xff, 0xff, 0xff, 0x0f];
            assert_eq!(
                outcome(remote_write(&url, bomb).bearer_auth(raw_key)).await,
                too_large
            );
            // A real block one byte past the ceiling.
            let over = snappy(&vec![0_u8; 64 * 1024 + 1]);
            assert!(over.len() < 8 * 1024, "{} compressed bytes", over.len());
            assert_eq!(
                outcome(remote_write(&url, over).bearer_auth(raw_key)).await,
                too_large
            );

            // Under the byte ceiling, but one series with 2,000 samples is 2,000 copies
            // of its labels: over the heap one request may decode into.
            let samples: Vec<_> = (0..2_000).map(|i| (1.0, T0 + i)).collect();
            let labels: Vec<(String, String)> = (0..40)
                .map(|i| (format!("label_{i}"), "v".repeat(32)))
                .collect();
            let mut all = vec![("__name__", "wide_total")];
            all.extend(
                labels
                    .iter()
                    .map(|(name, value)| (name.as_str(), value.as_str())),
            );
            let wide = WriteRequest {
                timeseries: vec![series(&all, &samples)],
                metadata: Vec::new(),
            }
            .encode_to_vec();
            assert!(wide.len() < 64 * 1024, "{} decoded bytes", wide.len());
            let refused = remote_write(&url, snappy(&wide))
                .bearer_auth(raw_key)
                .send()
                .await
                .unwrap();
            assert_eq!(refused.status(), StatusCode::PAYLOAD_TOO_LARGE);
            let body: serde_json::Value = refused.json().await.unwrap();
            assert_eq!(
                body["error"]["message"],
                "Request decodes past the 4 MiB the gateway allows one request; send smaller batches"
            );

            // Inside both of those, but 300 samples of one series with 1 kB of labels map
            // to more OTLP than the 64 kB an OTLP request may carry here.
            let samples: Vec<_> = (0..300).map(|i| (1.0, T0 + i)).collect();
            let value = "v".repeat(1024);
            let fan_out = WriteRequest {
                timeseries: vec![series(
                    &[("__name__", "fan_out"), ("payload", value.as_str())],
                    &samples,
                )],
                metadata: Vec::new(),
            }
            .encode_to_vec();
            assert!(fan_out.len() < 8 * 1024, "{} decoded bytes", fan_out.len());
            let refused = remote_write(&url, snappy(&fan_out))
                .bearer_auth(raw_key)
                .send()
                .await
                .unwrap();
            assert_eq!(refused.status(), StatusCode::PAYLOAD_TOO_LARGE);
            let body: serde_json::Value = refused.json().await.unwrap();
            assert_eq!(
                body["error"]["message"],
                "This remote write holds more metric data than one request may carry; send fewer \
                 samples per request"
            );

            assert!(
                forwarded.try_recv().is_err(),
                "a refused body stores nothing"
            );
            assert_eq!(memory.reserved_bytes(), 0, "every reservation was returned");
            drop(std::fs::remove_dir_all(&queue_dir));
        }

        #[tokio::test]
        async fn an_org_over_its_plan_limit_is_refused_before_the_body_is_read() {
            let (forward_url, mut forwarded) = spawn_metrics_collector().await;
            let queue_dir = unique_main_test_dir("prometheus-billing");
            let raw_key = "maple_sk_test_prometheus_denied";
            let state = with_autumn_denying(
                gateway_state(raw_key, "org_prometheus_denied", &queue_dir, forward_url).await,
                "org_prometheus_denied",
            )
            .await;
            let url = serve(state).await;

            // Not a snappy body: the plan limit answers first, as on OTLP metrics.
            let request = remote_write(&url, b"not snappy".to_vec()).bearer_auth(raw_key);
            assert_eq!(
                outcome(request).await,
                (
                    StatusCode::PAYMENT_REQUIRED,
                    "ingest_plan_limit_reached".to_owned()
                )
            );
            assert!(forwarded.try_recv().is_err());
            drop(std::fs::remove_dir_all(&queue_dir));
        }

        #[tokio::test]
        async fn a_write_with_nothing_to_store_is_accepted_and_not_metered() {
            let (forward_url, mut forwarded) = spawn_metrics_collector().await;
            let queue_dir = unique_main_test_dir("prometheus-empty");
            let raw_key = "maple_sk_test_prometheus_empty";
            let state =
                gateway_state(raw_key, "org_prometheus_empty", &queue_dir, forward_url).await;
            let (state, mut autumn) = with_fake_autumn(state).await;
            let url = serve(state).await;

            // Prometheus sends metadata on its own, in requests without series.
            let metadata_only = WriteRequest {
                timeseries: Vec::new(),
                metadata: scrape().metadata,
            };
            let only_stale = WriteRequest {
                timeseries: vec![series(
                    &[("__name__", "up"), ("job", "api")],
                    &[(f64::from_bits(STALE_NAN_BITS), T0)],
                )],
                metadata: Vec::new(),
            };
            for request in [WriteRequest::default(), metadata_only, only_stale] {
                let body = snappy(&request.encode_to_vec());
                assert_eq!(
                    outcome(remote_write(&url, body).bearer_auth(raw_key)).await,
                    (StatusCode::OK, String::new())
                );
            }
            assert!(forwarded.try_recv().is_err(), "nothing is forwarded");
            let calls = drain_autumn_calls(&mut autumn).await;
            assert!(tracked(&calls).is_empty(), "nothing is metered: {calls:?}");
            drop(std::fs::remove_dir_all(&queue_dir));
        }
    }
    /// The retention policy read with a key, and the stamp it puts on every row.
    mod retention_stamps {
        use super::*;
        use std::collections::{BTreeMap, BTreeSet};

        const ORG: &str = "org_retention";
        const KEY: &str = "maple_sk_test_retention";
        /// An integration source of the org that sets no period of its own.
        const INHERITING_SOURCE_UUID: &str = "9d4f6a1b-2c3e-4d5f-8a7b-6c5d4e3f2a1b";

        /// An org with a private key, a default source and an integration source.
        fn org_store() -> Arc<FakeKeyStore> {
            let store = private_key_store(KEY, ORG, false);
            store.insert_source_row(ORG, DEFAULT_SOURCE_UUID, "default");
            store.insert_source_row(ORG, INTEGRATION_SOURCE_UUID, "integration");
            store
        }

        /// A gateway on `store` that writes every table to a fake Tinybird.
        async fn storing_state(
            store: &Arc<FakeKeyStore>,
            name: &str,
        ) -> (AppState, TinybirdImports, PathBuf) {
            let queue_dir = unique_main_test_dir(name);
            let (state, imports) = profiles_test_state(Arc::clone(store), queue_dir.clone()).await;
            (state, imports, queue_dir)
        }

        /// One `/v0/events` body: its datasource and rows.
        type Body = (String, Vec<serde_json::Value>);

        /// The bodies the fake Tinybird is sent until they hold `row_count` rows.
        async fn exported(imports: &mut TinybirdImports, row_count: usize) -> Vec<Body> {
            let mut bodies: Vec<Body> = Vec::new();
            while bodies.iter().map(|body| body.1.len()).sum::<usize>() < row_count {
                let (datasource, ndjson) =
                    tokio::time::timeout(Duration::from_secs(5), imports.recv())
                        .await
                        .expect("the rows should reach Tinybird")
                        .expect("the Tinybird channel should stay open");
                let rows = ndjson
                    .lines()
                    .filter(|line| !line.is_empty())
                    .map(|line| serde_json::from_str(line).expect("each line is a row"))
                    .collect();
                bodies.push((datasource, rows));
            }
            bodies
        }

        /// The distinct `retention_days` of each datasource's rows.
        fn stamps_by_datasource(bodies: &[Body]) -> BTreeMap<String, Vec<Option<u64>>> {
            let mut stamps: BTreeMap<String, BTreeSet<Option<u64>>> = BTreeMap::new();
            for (datasource, rows) in bodies {
                let seen = stamps.entry(datasource.clone()).or_default();
                seen.extend(rows.iter().map(|row| row["retention_days"].as_u64()));
            }
            stamps
                .into_iter()
                .map(|(datasource, seen)| (datasource, seen.into_iter().collect()))
                .collect()
        }

        fn periods(stamps: &RetentionStamps) -> [u16; 6] {
            RetentionSignal::ALL.map(|signal| stamps.get(signal))
        }

        async fn resolved(store: &Arc<FakeKeyStore>, raw_key: &str) -> ResolvedIngestKey {
            make_resolver(Arc::clone(store))
                .resolve_ingest_key(raw_key)
                .await
                .expect("the lookup succeeds")
                .expect("the key resolves")
        }

        #[tokio::test]
        async fn a_default_key_keeps_its_default_sources_period_else_its_orgs() {
            let store = org_store();
            store.set_org_retention(ORG, r#"{"traces": 45, "logs": 60, "events": 400}"#);
            store.set_source_retention(DEFAULT_SOURCE_UUID, r#"{"logs": 7}"#);
            // Another source's override is not this key's.
            store.set_source_retention(INTEGRATION_SOURCE_UUID, r#"{"traces": 3}"#);

            let key = resolved(&store, KEY).await;
            // traces, logs, metrics, sessions, events, profiles
            assert_eq!(periods(&key.retention), [60, 7, 90, 30, 730, 14]);

            // Read with the key and cached with it: a second request asks nothing more.
            let resolver = make_resolver(Arc::clone(&store));
            let first = resolver.resolve_ingest_key(KEY).await.unwrap().unwrap();
            let fetches = store.ingest_key_fetches.load(Ordering::Relaxed);
            let second = resolver.resolve_ingest_key(KEY).await.unwrap().unwrap();
            assert_eq!(periods(&second.retention), periods(&first.retention));
            assert_eq!(store.ingest_key_fetches.load(Ordering::Relaxed), fetches);
        }

        #[tokio::test]
        async fn an_org_that_set_nothing_keeps_every_signal_at_its_default() {
            let key = resolved(&org_store(), KEY).await;
            assert_eq!(periods(&key.retention), [30, 30, 90, 30, 365, 14]);
        }

        #[tokio::test]
        async fn a_source_token_keeps_its_own_period_over_its_orgs() {
            let store = org_store();
            let token = "maple_src_test_retention";
            store.insert_source(
                token,
                source_row(ORG, source_config(None, None, "[]")),
            );
            store.set_org_retention(ORG, r#"{"traces": 180, "metrics": 30}"#);
            store.set_source_retention(SOURCE_UUID, r#"{"traces": 14, "profiles": 60}"#);

            let key = resolved(&store, token).await;
            assert_eq!(periods(&key.retention), [14, 30, 30, 30, 365, 60]);
        }

        #[tokio::test]
        async fn a_stored_policy_that_does_not_read_never_fails_the_key() {
            let store = org_store();
            store.set_org_retention(ORG, r#"{"traces": 0, "logs": 9000, "metrics": "30"}"#);
            store.set_source_retention(DEFAULT_SOURCE_UUID, "not json");

            let key = resolved(&store, KEY).await;
            assert_eq!(periods(&key.retention), [30, 30, 90, 30, 365, 14]);
        }

        #[tokio::test]
        async fn the_static_key_store_keeps_every_signal_at_its_default() {
            let store = StaticKeyStore {
                org_id: "org_local".to_owned(),
            };
            let key = store
                .fetch_ingest_key("any", "private_key_hash")
                .await
                .unwrap()
                .expect("every key resolves");
            assert_eq!(periods(&key.retention.stamps()), [30, 30, 90, 30, 365, 14]);
            let token = store
                .fetch_source_by_token_hash("any")
                .await
                .unwrap()
                .expect("every token resolves");
            assert_eq!(periods(&token.retention.stamps()), [30, 30, 90, 30, 365, 14]);
        }

        #[tokio::test]
        async fn a_verified_claim_carries_its_sources_own_period_while_cached() {
            let store = org_store();
            store.insert_source_row(ORG, SOURCE_UUID, "integration");
            store.set_source_retention(INTEGRATION_SOURCE_UUID, r#"{"logs": 7}"#);
            let resolver = make_resolver(Arc::clone(&store));
            let short = public_id(INTEGRATION_SOURCE_UUID);
            let claims = vec![short.clone(), public_id(SOURCE_UUID)];
            let overrides = RetentionOverrides::default().with(RetentionSignal::Logs, 7);

            for _ in 0..2 {
                let verified = resolver.verify_source_claims(ORG, claims.clone()).await;
                assert_eq!(verified.active, claims);
                // A source that sets nothing is still named: it inherits from the org.
                assert_eq!(
                    verified.retention,
                    vec![
                        (short.clone(), overrides),
                        (public_id(SOURCE_UUID), RetentionOverrides::default()),
                    ]
                );
            }
            assert_eq!(store.claim_lookups.lock().unwrap().len(), 1);
        }

        #[test]
        fn a_named_source_inherits_from_the_org_signal_by_signal() {
            let key = ResolvedIngestKey {
                org_retention: RetentionOverrides::default()
                    .with(RetentionSignal::Traces, 45)
                    .with(RetentionSignal::Metrics, 14),
                ..test_key()
            };
            let named = [(
                "src_named".to_owned(),
                RetentionOverrides::default().with(RetentionSignal::Traces, 3),
            )];
            let stamp = |signal| named_source_stamps(&key, &named, signal);
            assert_eq!(stamp(RetentionSignal::Traces), vec![("src_named".to_owned(), 3)]);
            assert_eq!(stamp(RetentionSignal::Metrics), vec![("src_named".to_owned(), 14)]);
            assert_eq!(stamp(RetentionSignal::Logs), vec![("src_named".to_owned(), 30)]);
        }

        #[test]
        fn trace_rows_take_each_named_sources_events_period_else_the_keys() {
            let key = test_key();
            let named = [
                (
                    "src_short".to_owned(),
                    RetentionOverrides::default().with(RetentionSignal::Events, 30),
                ),
                ("src_plain".to_owned(), RetentionOverrides::default()),
            ];
            // A source that sets nothing keeps the events default, as the key's own rows do.
            assert_eq!(
                events_stamps(&key, &named),
                EventsStamps::new(
                    365,
                    vec![("src_short".to_owned(), 30), ("src_plain".to_owned(), 365)]
                )
            );
        }

        #[tokio::test]
        async fn a_connector_keeps_its_sources_period_else_its_orgs() {
            let store = Arc::new(FakeKeyStore::default());
            let connector = |org_id: &str| ConnectorRow {
                org_id: org_id.to_owned(),
                service_name: "cloudflare/example.com".to_owned(),
                zone_name: "example.com".to_owned(),
                dataset: "http_requests".to_owned(),
                self_managed: false,
                clickhouse_ready: false,
                source: None,
                org_retention: RetentionOverrides::default(),
            };
            store.insert_connector("cf_with_source", "cf-secret", connector(ORG));
            store.insert_connector("cf_without_source", "cf-secret", connector(ORG));
            store.insert_source_row(ORG, INTEGRATION_SOURCE_UUID, "integration");
            store.link_connector_source("cf_with_source", INTEGRATION_SOURCE_UUID);
            store.insert_gcp_connector(
                "gcp_conn",
                "gcp-secret",
                GcpConnectorRow {
                    org_id: ORG.to_owned(),
                    project_id: "maple-test".to_owned(),
                    logs_enabled: true,
                    applied_logs_enabled: Some(true),
                    self_managed: false,
                    clickhouse_ready: false,
                    source: None,
                    org_retention: RetentionOverrides::default(),
                },
            );
            store.link_connector_source("gcp_conn", INTEGRATION_SOURCE_UUID);
            store.insert_aws_connection(
                AWS_CONNECTION,
                AWS_STREAM_SECRET,
                AwsConnectionRow {
                    org_id: ORG.to_owned(),
                    self_managed: false,
                    clickhouse_ready: false,
                    source: None,
                    org_retention: RetentionOverrides::default(),
                },
            );
            store.link_connector_source(AWS_CONNECTION, INTEGRATION_SOURCE_UUID);
            store.set_org_retention(ORG, r#"{"logs": 60, "metrics": 30}"#);
            store.set_source_retention(INTEGRATION_SOURCE_UUID, r#"{"logs": 14, "metrics": 400}"#);
            let queue_dir = unique_main_test_dir("connector-retention");
            let state = test_app_state(
                Arc::clone(&store),
                queue_dir.clone(),
                "http://127.0.0.1:1".to_owned(),
                Duration::from_secs(30),
            )
            .await;

            let logpush = |connector_id: &'static str| async {
                let resolved = state
                    .cloudflare_resolver
                    .resolve_connector(connector_id, "cf-secret")
                    .await
                    .unwrap()
                    .expect("the connector resolves");
                resolved.retention.stamps().get(RetentionSignal::Logs)
            };
            assert_eq!(logpush("cf_with_source").await, 14);
            assert_eq!(logpush("cf_without_source").await, 60);

            let gcp = state
                .gcp_resolver
                .resolve_connector("gcp_conn", "gcp-secret")
                .await
                .unwrap()
                .expect("the connector resolves");
            assert_eq!(gcp.key.retention.get(RetentionSignal::Logs), 14);
            let aws = state
                .aws_resolver
                .resolve_connection(AWS_CONNECTION, AWS_STREAM_SECRET)
                .await
                .unwrap()
                .expect("the connection resolves");
            assert_eq!(aws.key.retention.get(RetentionSignal::Metrics), 730);
            drop(std::fs::remove_dir_all(&queue_dir));
        }

        #[tokio::test]
        async fn every_gateway_written_table_is_stamped_whatever_the_sender_sent() {
            let store = org_store();
            store.set_org_retention(ORG, r#"{"sessions": 45, "events": 100, "profiles": 3}"#);
            store.set_source_retention(DEFAULT_SOURCE_UUID, r#"{"sessions": 7}"#);
            let (state, mut imports, queue_dir) = storing_state(&store, "stamped-tables").await;
            let headers = bearer_headers(KEY);

            // Each body tries to set the period itself.
            let meta = r#"{"session_id":"sess_1","version":1,"retention_days":800}"#;
            handle_replay_meta_inner(&state, &headers, Bytes::from_static(meta.as_bytes()))
                .await
                .expect("session metadata is accepted");
            let events = concat!(
                r#"{"type":"click","message":"a","retention_days":800,"events_retention_days":800}"#,
                "\n",
                r#"{"type":"custom","message":"signup","retention_days":"800","events_retention_days":"800"}"#,
            );
            handle_session_events_inner(&state, &headers, Bytes::from_static(events.as_bytes()))
                .await
                .expect("session events are accepted");
            let product = r#"{"name":"plan_started","retention_days":800}"#;
            handle_product_events_inner(&state, &headers, Bytes::from_static(product.as_bytes()))
                .await
                .expect("product events are accepted");
            handle_replay_blob_inner(
                &state,
                &replay_blob_headers(KEY, "sess_1", 0),
                gzip_bytes(r#"[{"type":2,"timestamp":1,"retention_days":800}]"#),
            )
            .await
            .expect("a replay chunk is accepted");
            let profiles = send_sdk_profiles(&state, KEY).await.expect("profiles are accepted");
            assert_eq!(profiles, PROFILES_SDK_ROWS);

            let bodies = exported(&mut imports, 5 + PROFILES_SDK_ROWS).await;
            let stamped = |datasource: &str, stamp: u64| (datasource.to_owned(), vec![Some(stamp)]);
            assert_eq!(
                stamps_by_datasource(&bodies),
                BTreeMap::from([
                    stamped("product_events", 180),
                    stamped("profiles", 3),
                    stamped("session_events", 7),
                    stamped("session_replay_events", 7),
                    stamped("session_replays", 7),
                ])
            );
            // A session event also carries the events period its `product_events` row keeps.
            let session_events = bodies
                .iter()
                .filter(|(datasource, _)| datasource == "session_events")
                .flat_map(|(_, rows)| rows);
            let events_periods: Vec<Option<u64>> = session_events
                .map(|row| row["events_retention_days"].as_u64())
                .collect();
            assert_eq!(events_periods, vec![Some(180), Some(180)]);
            drop(std::fs::remove_dir_all(&queue_dir));
        }

        #[tokio::test]
        async fn a_request_naming_an_integration_source_is_stored_under_that_sources_period() {
            let store = org_store();
            store.insert_source_row(ORG, INHERITING_SOURCE_UUID, "integration");
            store.insert_source_row("org_other", SOURCE_UUID, "integration");
            store.set_org_retention(ORG, r#"{"logs": 90}"#);
            store.set_source_retention(DEFAULT_SOURCE_UUID, r#"{"logs": 14}"#);
            store.set_source_retention(INTEGRATION_SOURCE_UUID, r#"{"logs": 7}"#);
            // Another org's source, and its policy, are not this org's to name.
            store.set_source_retention(SOURCE_UUID, r#"{"logs": 3}"#);
            let (state, mut imports, queue_dir) = storing_state(&store, "named-source").await;

            let integration = public_id(INTEGRATION_SOURCE_UUID);
            let inheriting = public_id(INHERITING_SOURCE_UUID);
            let default_source = public_id(DEFAULT_SOURCE_UUID);
            let resources = [
                ("a", Some(integration.clone())),
                ("b", None),
                ("c", Some(integration.clone())),
                ("d", Some(public_id(SOURCE_UUID))),
                ("e", Some(inheriting.clone())),
            ];
            let request = ExportLogsServiceRequest {
                resource_logs: resources
                    .iter()
                    .map(|(message, claim)| {
                        let mut resource_logs = test_log_request(message).resource_logs.remove(0);
                        // A sender's own attribute of that name decides nothing.
                        let mut attributes = vec![string_attribute("retention_days", "800")];
                        if let Some(claim) = claim {
                            attributes.push(string_attribute("maple_source_id", claim));
                        }
                        let resource = resource_logs.resource.as_mut().expect("a resource");
                        resource.attributes.extend(attributes);
                        resource_logs
                    })
                    .collect(),
            };
            let (response, ..) = handle_signal_inner(
                &state,
                &test_headers(KEY),
                Bytes::from(request.encode_to_vec()),
                Ingress::Otlp(Signal::Logs),
            )
            .await
            .expect("default key traffic is accepted");
            assert_eq!(response.status(), StatusCode::OK);

            // One body per period, each holding the rows of the sources that keep it.
            let mut bodies: Vec<Vec<(u64, String, String)>> = exported(&mut imports, 5)
                .await
                .into_iter()
                .map(|(datasource, rows)| {
                    assert_eq!(datasource, "logs");
                    let mut rows: Vec<_> = rows
                        .iter()
                        .map(|row| {
                            let text = |value: &serde_json::Value| {
                                value.as_str().unwrap_or_default().to_owned()
                            };
                            (
                                row["retention_days"].as_u64().expect("a stamp"),
                                text(&row["resource_attributes"]["maple_source_id"]),
                                text(&row["body"]),
                            )
                        })
                        .collect();
                    rows.sort();
                    rows
                })
                .collect();
            bodies.sort();
            let row = |stamp: u64, source: &String, body: &str| {
                (stamp, source.clone(), body.to_owned())
            };
            assert_eq!(
                bodies,
                vec![
                    vec![row(7, &integration, "a"), row(7, &integration, "c")],
                    // The key's own source, which also takes the claim that was not the org's.
                    vec![row(14, &default_source, "b"), row(14, &default_source, "d")],
                    // A source that sets nothing keeps the org's period, not the default source's.
                    vec![row(90, &inheriting, "e")],
                ]
            );
            drop(std::fs::remove_dir_all(&queue_dir));
        }
    }
}
