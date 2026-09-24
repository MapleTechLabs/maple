---
title: "CLI Reference"
description: "Every maple command, argument and flag, plus the local server's endpoints, environment variables and a troubleshooting guide."
group: "Local Mode"
order: 2
---

The `maple` binary is one CLI with two backends: the local server it starts itself (`maple start`) and a hosted Maple workspace (`maple auth login`). Every query command runs against whichever backend is [resolved](#auth-and-configuration) for that invocation. Output is JSON by default, clean enough to pipe into `jq` or an agent.

New here? Start with the [Maple Local](/docs/local-mode) walkthrough. This page is the complete surface.

## Command index

| Command | What it does |
| --- | --- |
| [`maple start`](#maple-start) · [`stop`](#maple-stop) · [`reset`](#maple-reset) | Run the local server, stop it, or clear its live data |
| [`maple checkpoint`](#maple-checkpoint) · [`restore`](#maple-restore) | Take a restore point of the local store, or roll back to one |
| [`maple archive …`](#maple-archive) | Export sealed days to Parquet and manage those archives |
| [`maple schema …`](#maple-schema) | Inspect and migrate the local store's schema |
| [`maple update`](#maple-update) | Upgrade a script-installed binary in place |
| [`maple services`](#maple-services) · [`diagnose`](#maple-diagnose-service-name) · [`service-map`](#maple-service-map) · [`top-ops`](#maple-top-ops-service-name) | Services, their health, dependencies and hottest operations |
| [`maple traces`](#maple-traces) · [`trace`](#maple-trace-trace-id) · [`slow-traces`](#maple-slow-traces) | Search spans, inspect one trace, find the slowest |
| [`maple errors`](#maple-errors) · [`error`](#maple-error-fingerprint-hash) | Error groups by fingerprint, and one group in detail |
| [`maple logs`](#maple-logs) · [`log-patterns`](#maple-log-patterns) | Search logs, or cluster them into templates |
| [`maple attributes keys`](#maple-attributes-keys) · [`values`](#maple-attributes-values-key) | Discover attribute keys and their values |
| [`maple metrics`](#maple-metrics) · [`query`](#maple-query-sql) | List metrics; run raw SQL (local only) |
| [`maple timeseries`](#maple-timeseries) · [`breakdown`](#maple-breakdown) · [`compare`](#maple-compare) | Bucketed metrics, top-N breakdowns, two windows side by side |
| [`maple auth …`](#maple-auth-login) · [`whoami`](#maple-whoami) · [`use`](#maple-use-localremoteauto) | Sign in to a workspace, see the resolved backend, pin one |

## Global flags

Accepted by every command, in any position (`maple --local traces` and `maple traces --local` both work):

| Flag | Description |
| --- | --- |
| `--local` | Force local mode (requires a running `maple start`) |
| `--remote` | Force remote mode (requires `maple auth login`) |
| `--debug` | Print the compiled SQL and per-query timing to stderr; stdout stays clean JSON |
| `--format <json\|table>` | Output format, default `json`. `table` renders a flat row set as an aligned table |

Most **query** commands also share a set of filter flags. Which ones apply is listed per command below; the shapes are always the same:

| Flag | Alias | Default | Description |
| --- | --- | --- | --- |
| `--since <range>` | | `6h` | Relative time range: `30m`, `1h`, `6h`, `24h`, `7d` |
| `--start <time>` | | | Absolute start, `YYYY-MM-DD HH:mm:ss` UTC (use with `--end`) |
| `--end <time>` | | | Absolute end, `YYYY-MM-DD HH:mm:ss` UTC |
| `--service <name>` | `-s` | | Filter by service name |
| `--env <name>` | `-e` | | Filter by deployment environment, e.g. `production` |
| `--limit <n>` | `-n` | `20` | Maximum number of results |
| `--offset <n>` | | `0` | Pagination offset |

## Server commands

Local mode only. `maple start` is the long-lived process that owns the embedded ClickHouse connection; every other command talks to it over HTTP.

### `maple start`

Start the local ingest and query server.

| Flag | Default | Description |
| --- | --- | --- |
| `--host <address>` | `127.0.0.1` | Bind address. Anything but loopback exposes every route without authentication |
| `--advertise-host <host>` | the bind address | Hostname printed for clients and used by the bundled UI |
| `--port <int>` | `4318` | Port for OTLP ingest, the query API and the bundled UI |
| `--data-dir <path>` | `~/.maple/data` | Embedded ClickHouse data directory |
| `--offline` | `false` | Serve the UI bundled in the binary instead of linking to `local.maple.dev` |
| `--background`, `-d` | `false` | Run detached, logging to `~/.maple/maple.log`; stop with `maple stop` |
| `--reset` | `false` | Wipe live data before starting, keeping checkpoints. For an incompatible upgrade |
| `--checkpoint-interval <dur>` | `30m` | How often to refresh the restore point while running (`45s`, `2h`, or `off`) |
| `--on-dirty-store <policy>` | `fail` | What to do when the store was not cleanly closed: `fail`, `wipe` or `restore-checkpoint` |
| `--chdb-config-file <path>` | generated | Your own ClickHouse config for the embedded engine. Must keep backups enabled for checkpoints to work |
| `--minimum-raw-telemetry-retention-days <n>` | | Persist a retention floor for the raw tables (at least 90 days). Survives reset and restore |

```bash
maple start                    # foreground, UI from local.maple.dev
maple start --offline          # foreground, bundled UI, no internet needed
maple start -d --port 4400     # detached on a custom port
maple start --host 0.0.0.0 --advertise-host maple.home.arpa --offline
```

The default recovery policy is `fail`, so an unclean shutdown never silently deletes telemetry. What each policy does, and how reset and restore protect the store, is on [Checkpoints & archives](/docs/local-mode/checkpoints-and-archives).

### `maple stop`

Stop a running server. Reads the PID file beside the data directory.

| Flag | Default | Description |
| --- | --- | --- |
| `--data-dir <path>` | `~/.maple/data` | Data directory of the server to stop |

### `maple reset`

Delete live data so the next `maple start` bootstraps fresh. Checkpoints under `<data-dir>/backups` are kept. Refuses to run while a server owns the store.

| Flag | Default | Description |
| --- | --- | --- |
| `--data-dir <path>` | `~/.maple/data` | Store whose live data to clear |
| `--yes`, `-y` | `false` | Skip the confirmation prompt |

### `maple checkpoint`

Create and validate a restorable checkpoint of the local store. Works out of the box against a running `maple start`.

| Flag | Default | Description |
| --- | --- | --- |
| `--host <address>` | `127.0.0.1` | Host of the running server |
| `--port <int>` | `4318` | Port of the running server |
| `--data-dir <path>` | `~/.maple/data` | The server's data directory |

If the server was started with a custom host, port or data directory, pass the same values here.

### `maple restore`

Restore the local store from the last promoted checkpoint. Refuses to run while a server owns the store. The existing store is moved aside, never deleted.

| Flag | Default | Description |
| --- | --- | --- |
| `--data-dir <path>` | `~/.maple/data` | Store to restore |
| `--checkpoint-id <uuid>` | selected current | Restore one specific checkpoint instead |
| `--yes`, `-y` | `false` | Skip the confirmation prompt |

```bash
maple restore --yes
maple restore --checkpoint-id 01234567-89ab-4cde-8fab-0123456789ab --yes
```

### `maple archive`

Local mode only. Export sealed UTC days of the six raw telemetry tables from a checkpoint into portable Parquet, and manage those exports. The subcommands, and the archive model behind them, are documented on [Checkpoints & archives](/docs/local-mode/checkpoints-and-archives#archives).

| Subcommand | What it does |
| --- | --- |
| `archive create <YYYY-MM-DD> <signal>` | Seal one day of one signal into a validated Parquet generation |
| `archive list` | List active generations, or print their shard paths for DuckDB |
| `archive verify` | Stream and SHA-256 verify the active shards |
| `archive expire <YYYY-MM-DD>` | Expire one complete archived day across all six signals |
| `archive retire-live <YYYY-MM-DD>` | Remove a fully archived and verified day from the live tables |
| `archive gc` | Reclaim superseded generations |
| `archive reconcile` | Finish an interrupted create or gc |
| `archive rebuild <signal>` | Rebuild a signal's catalog from its manifests |
| `archive calibrate` | Tune export settings against a pinned checkpoint |

### `maple schema`

Inspect and migrate the local store's schema. Needed only when a release note says a store needs migrating; a normal upgrade opens the store as is.

| Subcommand | What it does |
| --- | --- |
| `schema status` | Show the store's schema identity and migration journal state |
| `schema plan` | Show the deterministic migration plan for this store |
| `schema migrate [--dry-run] [--yes]` | Migrate a populated store into a staged current-schema store. Needs a stopped server; keeps the original as a rollback point |
| `schema abandon [--yes]` | Quarantine an unfinished staged target, preserving the active source |

All four take `--data-dir <path>` (default `~/.maple/data`).

### `maple update`

Update a script-installed binary to the latest release: download, verify the checksum, install in place.

| Flag | Description |
| --- | --- |
| `--check` | Only report whether a newer version is available |
| `--tag <vX.Y.Z>` | Install a specific release instead of the latest |

Homebrew installs refuse `maple update` so the package manager stays in charge; run `brew upgrade maple` instead.

## Services

### `maple services`

List active services with throughput, error rate and P95 latency. Flags: `--since` / `--start` / `--end`, `--env`.

### `maple diagnose <service-name>`

Deep-dive one service: health, top errors, recent traces and logs.

- **`<service-name>`**: the service to diagnose
- Flags: `--since` / `--start` / `--end`, `--env`

### `maple service-map`

Service dependency edges with call counts, errors and latency. Flags: `--since` / `--start` / `--end`, `--service`, `--env`.

### `maple top-ops <service-name>`

Top operations (span names) for a service, ranked by a metric.

- **`<service-name>`**: the service to inspect
- `--metric <count|avg_duration|p50_duration|p95_duration|p99_duration|error_rate|apdex>`: ranking metric, default `count`
- Flags: `--since` / `--start` / `--end`, `--limit`

## Traces

### `maple traces`

Search traces and spans.

| Flag | Description |
| --- | --- |
| `--span-name <substr>` | Filter by span name (substring, case-insensitive) |
| `--errors` | Only traces with errors |
| `--min-duration-ms <int>` | Minimum duration in milliseconds |
| `--max-duration-ms <int>` | Maximum duration in milliseconds |
| `--http-method <method>` | Filter by HTTP method (`GET`, `POST`, …) |

Plus `--since` / `--start` / `--end`, `--service`, `--limit`, `--offset`.

```bash
maple traces --service api --min-duration-ms 500 --errors --since 1h
```

### `maple trace <trace-id>`

Inspect one trace: the full span tree plus correlated logs.

- **`<trace-id>`**: the trace to inspect

### `maple slow-traces`

The slowest traces with duration stats. Flags: `--since` / `--start` / `--end`, `--service`, `--env`, `--limit`.

## Errors

### `maple errors`

Error groups by fingerprint, with count, affected services and last seen. Flags: `--since` / `--start` / `--end`, `--service`, `--env`, `--limit`.

### `maple error <fingerprint-hash>`

One error group in detail: sample traces and a timeseries.

- **`<fingerprint-hash>`**: the fingerprint from `maple errors`
- Flags: `--since` / `--start` / `--end`, `--service`, `--limit`

## Logs

### `maple logs`

Search logs.

| Flag | Alias | Description |
| --- | --- | --- |
| `--severity <level>` | | `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR` or `FATAL` |
| `--search <text>` | `-q` | Substring match on the body |
| `--trace-id <id>` | | Only logs from one trace |

Plus `--since` / `--start` / `--end`, `--service`, `--limit`, `--offset`.

### `maple log-patterns`

Cluster logs into templates to surface the noisiest patterns. Flags: `--since` / `--start` / `--end`, `--service`, `--severity`, `--search`/`-q`, `--limit`.

## Attributes

### `maple attributes keys`

Discover the attribute keys present in your data.

| Flag | Default | Description |
| --- | --- | --- |
| `--source <traces\|metrics\|services>` | `traces` | Where to look |
| `--scope <span\|resource>` | `span` | Span or resource attributes (traces only) |

Plus `--service`, `--since` / `--start` / `--end`, `--limit`.

### `maple attributes values <key>`

List the values seen for one attribute key.

- **`<key>`**: the attribute key
- Flags: same as `attributes keys`

## Metrics and raw SQL

### `maple metrics`

List available metrics. Flags: `--since` / `--start` / `--end`, `--service`, `--search`/`-q`, `--limit`.

### `maple query "<sql>"`

Run raw ClickHouse SQL against the local store, for anything the typed commands don't cover.

- **`<sql>`**: the query to run

```bash
maple query "SELECT ServiceName, count() FROM traces GROUP BY ServiceName ORDER BY 2 DESC"
```

> **Local only.** Raw SQL against the hosted warehouse would let one client read other organisations' data, so `maple query` returns a clear error in remote mode. Every other command works in both modes.

## Analytics

### `maple timeseries`

Time-bucketed trace metrics: count, latency quantiles, error rate and apdex per bucket.

| Flag | Default | Description |
| --- | --- | --- |
| `--group-by <none\|service\|span_name\|status_code\|http_method>` | `none` | Split the series by a dimension |
| `--span-name <substr>` | | Filter by span name |
| `--errors` | `false` | Only errored spans |
| `--bucket <seconds>` | `60` | Bucket size |

Plus `--since` / `--start` / `--end`, `--service`, `--env`.

### `maple breakdown`

Top-N breakdown of traces by a dimension.

| Flag | Default | Description |
| --- | --- | --- |
| `--group-by <service\|span_name\|status_code\|http_method>` | `span_name` | Dimension to group by |
| `--span-name <substr>` | | Filter by span name |
| `--errors` | `false` | Only errored spans |

Plus `--since` / `--start` / `--end`, `--service`, `--env`, `--limit`.

### `maple compare`

Compare service health between two windows, for regression detection. Give **either** `--around` **or** all four explicit bounds.

| Flag | Description |
| --- | --- |
| `--around <ts>` | Compare the 30 minutes before and after this UTC time (`YYYY-MM-DD HH:mm:ss`) |
| `--current-start <ts>` / `--current-end <ts>` | The "current" window |
| `--previous-start <ts>` / `--previous-end <ts>` | The baseline window |
| `--env <name>` | Filter by deployment environment |

## Auth and configuration

### `maple auth login`

Sign in to a hosted Maple workspace. Opens your browser to approve the CLI; the credential is stored in the macOS keychain where available, otherwise in `~/.maple/config.json` (mode `0600`). `maple login` is a shorthand for the same command.

| Flag | Description |
| --- | --- |
| `--api-url <url>` | Maple API base URL, default `https://api.maple.dev` |
| `--with-token` | Read an existing API token from stdin instead of opening a browser, so it stays out of shell history |

```bash
maple auth login
echo "$MAPLE_TOKEN" | maple auth login --with-token
```

### `maple auth status`

Show and validate the active login: API URL, user, workspace and where the credential is stored.

### `maple auth logout`

Revoke the credential with the API and remove it locally. `maple logout` is the shorthand. A token supplied through `MAPLE_API_TOKEN` cannot be removed this way; unset the variable instead.

### `maple whoami`

Show the resolved mode (local or remote) and the target it would talk to, plus any pinned default.

### `maple use <local|remote|auto>`

Pin the default backend so commands stop auto-detecting, or `auto` to clear the pin.

**Mode resolution**, per command, in priority order:

1. An explicit `--local` or `--remote` flag.
2. The default pinned with `maple use`.
3. Auto-detect: a stored credential implies remote; otherwise a quick `GET /health` probe of the local server implies local. If neither is available the CLI prints what to do next.

## Server endpoints

`maple start` binds `127.0.0.1` by default. `--host` or `MAPLE_LOCAL_BIND_HOST` may select another address, which exposes every route below without application authentication. With `--offline` the bundled UI is also served over `GET`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness probe, returns `OK`. Used by mode auto-detect |
| `POST` | `/v1/traces` | OTLP traces ingest, responds `{ "accepted": <rowCount> }` |
| `POST` | `/v1/logs` | OTLP logs ingest |
| `POST` | `/v1/metrics` | OTLP metrics ingest |
| `POST` | `/local/query` | Run SQL: `{ "sql": "..." }` in, a bare JSON array of rows out |
| `OPTIONS` | `*` | CORS and private-network preflight, for the configured hosted UI origin only |

OTLP bodies may be protobuf (the default) or JSON, optionally gzip-encoded. The `/local/query` handler owns the output format: it strips any trailing `FORMAT <ident>`, appends `FORMAT JSONEachRow`, and wraps the rows into a JSON array, so clients POST their compiled SQL verbatim.

## Environment variables

**Runtime** (CLI and server):

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAPLE_LOCAL_BIND_HOST` | `127.0.0.1` | Server bind host and the CLI's default local target; wildcards map to loopback |
| `MAPLE_LOCAL_ADVERTISE_HOST` | the bind host | Host printed for clients and used by the bundled UI |
| `MAPLE_LOCAL_URL` | bind host + `4318` | Explicit base URL for CLI queries and mode detection |
| `MAPLE_LOCAL_UI_URL` | `https://local.maple.dev` | The hosted UI origin `maple start` links to and allows through CORS |
| `MAPLE_LIBCHDB` | _(auto)_ | Explicit path to `libchdb`. Otherwise resolved beside the binary, then `~/.maple/bin/libchdb.{so,dylib}` |
| `MAPLE_API_URL` | `https://api.maple.dev` | Remote API base URL |
| `MAPLE_API_TOKEN` | | Remote bearer token; overrides the stored credential |
| `MAPLE_ORG_ID` | | Remote organisation override |
| `MAPLE_DEBUG` | | `1` enables `--debug` |
| `MAPLE_FORMAT` | `json` | `json` or `table`, same as `--format` |
| `MAPLE_NO_UPDATE_CHECK` | | `1` disables the startup update check (the Homebrew wrapper sets this) |

**Install script** (`scripts/install.sh`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAPLE_VERSION` | `latest` | Release tag to install |
| `MAPLE_INSTALL_DIR` | `~/.maple/bin` | Where the two-file bundle lands |
| `MAPLE_BIN_DIR` | _(auto)_ | Where `maple` is symlinked onto `PATH` |
| `MAPLE_SKIP_CHECKSUM` | `0` | `1` skips SHA-256 verification (air-gapped mirrors only) |

`~/.maple/config.json` stores `apiUrl`, `orgId`, `defaultMode` and, when the keychain is unavailable, the token. Environment variables take precedence over stored values.

## Troubleshooting

**`libchdb` not found.** The binary loads `libchdb` from beside its own path, then falls back to `~/.maple/bin`. Homebrew keeps `maple` and `libchdb` together; the install script keeps them in `~/.maple/bin`. If you moved files by hand, keep `libchdb.so` or `.dylib` beside `maple`, or set `MAPLE_LIBCHDB` to its full path. Running from source has no sibling library, so set `MAPLE_LIBCHDB` or drop one into `~/.maple/bin`.

**Homebrew installed, but `maple` still runs the old binary.** A script-installer symlink is earlier on `PATH`. Confirm with `command -v maple`, then remove the old symlink or run `curl -fsSL https://maple.dev/cli/uninstall | sh` before reinstalling with Homebrew.

**`maple is already running (PID …)`.** Another server owns this data directory. Stop it with `maple stop`, or start a second instance on its own port and store: `maple start --port 4400 --data-dir ~/.maple/data-2`.

**Incompatible store after an upgrade.** A new binary that refuses an older store (`the local store … is incompatible`) needs the live data cleared: `maple reset --yes`, or `maple start --reset` in one step. Both keep checkpoints. If the release notes call for a migration instead, use [`maple schema`](#maple-schema).

**Store was not cleanly closed.** The default `--on-dirty-store fail` stops rather than guess. Restart with `--on-dirty-store restore-checkpoint` to roll back to the last good checkpoint, or `wipe` to discard live data. Neither touches checkpoints.

**Browser asks to "access devices on your local network", or CORS errors.** The default dashboard at `local.maple.dev` is a public origin reaching your loopback server, which trips Chrome's private network gate. Run `maple start --offline` to serve the dashboard same-origin. For a wildcard LAN bind, also set `--advertise-host` to the hostname the browser will use; other hosts and origins are rejected.

**Authentication proxy blocks the bundled UI.** The UI works behind TLS with browser-managed authentication such as a session cookie or HTTP auth. It does not inject a bearer token or copy an entry-page query parameter into its `/local/query` and OTLP requests.

**No data appearing.** Confirm the exporter points at the advertised host and port and the server is up (`maple whoami`, or `curl <host>:4318/health`). Widen the time range; the default is `--since 6h`. A successful ingest responds `{ "accepted": <n> }`.

**`No Maple backend found`.** Neither backend could be resolved. Start local mode (`maple start`), sign in to a workspace (`maple auth login`), or force one with `--local` / `--remote`.
