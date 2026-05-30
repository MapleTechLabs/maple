// Local mode pins a single synthetic tenant. The Rust ingest binary writes
// every decoded span/log/metric under this `OrgId`, and every `CH.compile(...)`
// call must pass the same constant so the WHERE `OrgId = 'local'` filter matches.
export const LOCAL_ORG_ID = "local"

// OTLP/HTTP ingest endpoint exposed by the local Maple binary. Mirrors the
// `MAPLE_LOCAL_URL` default the dev proxy points at (see vite.config.ts). Point
// any OpenTelemetry SDK (or @maple-dev/browser) here to stream into local mode.
export const LOCAL_OTLP_ENDPOINT = "http://127.0.0.1:4318"
