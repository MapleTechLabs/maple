# Local mode

Local mode runs Maple as a single self-contained binary: OTLP ingest, an
embedded ClickHouse (chDB) store, a query API, and a UI — no cloud, no Tinybird,
no auth. It's for poking at telemetry on your own machine and for the
distributable "try Maple locally" bundle.

Everything is single-tenant: every row is written under `org_id = "local"`, and
every compiled query filters on it.

## Install

```bash
curl -fsSL https://maple.dev/cli/install | sh
```

(`maple.dev/cli/install` is [scripts/install.sh](../scripts/install.sh) served by
`apps/landing` — the build copies it to `public/cli/install`. The raw GitHub URL
`https://raw.githubusercontent.com/Makisuo/maple/main/scripts/install.sh` works too.)

The installer detects your OS/arch,
downloads the matching bundle from the latest GitHub release, verifies its
checksum, installs the three files into `~/.maple/bin`, clears the macOS
Gatekeeper quarantine, and symlinks `maple` onto your PATH. Then:

```bash
maple start        # OTLP ingest + embedded ClickHouse + UI on :4318
maple services     # query the running server
maple traces
```

Env overrides: `MAPLE_VERSION` (pin a release tag), `MAPLE_INSTALL_DIR` (bundle
location, default `~/.maple/bin`), `MAPLE_BIN_DIR` (PATH symlink location).

## The three pieces

| Piece | Package | Role |
| --- | --- | --- |
| `maple` server binary | `apps/ingest` (`src/bin/local.rs`, `local` cargo feature) | Serves OTLP ingest, the embedded chDB, `POST /local/query`, and the bundled SPA — all on one port. |
| `maple-cli` query CLI | `apps/local-cli` (Effect + Bun) | Subcommands (`services`, `traces`, `errors`, `logs`, `query`, …) compile queries with `@maple/query-engine` and POST them to `/local/query`, printing JSON to stdout. **Embedded inside the `maple` binary** at build time; extracted to `~/.maple/` on first use. |
| local UI (SPA) | `apps/local-ui` (Vite + React) | Browser UI. Hooks compile queries with `CH.compile(...)` and POST to `/local/query`. Built to `dist/` and embedded into the server binary via `rust-embed`. |

The server binary on port **4318** is the hub. Both the CLI and the SPA are thin
clients of its `/local/query` endpoint, via the shared
[`executeLocalQuery`](../packages/query-engine/src/local.ts) helper in
`@maple/query-engine/local`.

## The `/local/query` contract

Clients POST `{ "sql": "..." }` and get back a bare JSON array of rows.

The **server owns the output FORMAT**. chDB runs SQL verbatim, and the handler
wraps line-delimited rows into a JSON array, so it always needs
`FORMAT JSONEachRow`. `CH.compile(...)` appends `FORMAT JSON`, so the handler
(`force_json_each_row` in `local.rs`) strips any trailing `FORMAT <ident>` the
client sent and re-appends `FORMAT JSONEachRow`. Clients therefore POST
`compiled.sql` verbatim — no client-side format rewriting.

## Dev workflow

Run the server and the SPA dev server in two terminals:

```bash
# Terminal 1 — the binary (OTLP ingest + query API + chDB) on :4318
bun --filter @maple/ingest local           # = cargo run --features local --bin maple -- start

# Terminal 2 — the Vite SPA dev server on :4319, proxying /local → :4318
bun --filter @maple/local-ui dev
```

Open <http://127.0.0.1:4319>. Vite proxies `/local/*` to the binary (override the
target with `MAPLE_LOCAL_URL`).

Query from the CLI against the same binary:

```bash
bun run apps/local-cli/src/bin.ts services
bun run apps/local-cli/src/bin.ts traces --service api --since 1h
bun run apps/local-cli/src/bin.ts query "SELECT count() FROM otel_traces"
```

The CLI targets `http://127.0.0.1:4318` by default; override with `MAPLE_LOCAL_URL`.

### Seeding data

Send OpenTelemetry to the binary's OTLP/HTTP endpoints
(`POST /v1/{traces,logs,metrics}`, proto or JSON). For OTLP/JSON, trace and span
IDs must be hex strings.

## Release bundle

`scripts/build-local-binary.sh` produces a relocatable **2-file bundle** (also built
per-platform by `.github/workflows/local-binary-release.yml`):

```
maple        # the server binary — SPA + query CLI both embedded inside
libchdb.so   # the chDB engine (~320 MB) — chdb-rust links it by bare name, so
             #   the script rewrites the load path to @rpath/$ORIGIN beside maple
```

The query CLI (`maple-cli`, compiled from `apps/local-cli` via `bun build --compile`)
is **embedded inside `maple`** at build time via `rust-embed`. On the first query
command, `maple` extracts it to `~/.maple/maple-cli-<hash>` and execs into it. The
hash acts as a version stamp — a new `maple` binary automatically re-extracts an
updated CLI, cleaning up the old version.

```bash
bun --filter @maple/ingest local:build      # local release build of just the binary
scripts/build-local-binary.sh               # full 2-file bundle
```
