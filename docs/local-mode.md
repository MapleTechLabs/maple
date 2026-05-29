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

The installer detects your OS/arch, downloads the matching bundle from the latest
GitHub release, verifies its checksum, installs the two files into `~/.maple/bin`,
clears the macOS Gatekeeper quarantine, and symlinks `maple` onto your PATH. Then:

```bash
maple start        # OTLP ingest + embedded ClickHouse + UI on :4318
maple services     # query the running server
maple traces
```

Env overrides: `MAPLE_VERSION` (pin a release tag), `MAPLE_INSTALL_DIR` (bundle
location, default `~/.maple/bin`), `MAPLE_BIN_DIR` (PATH symlink location).

## Architecture: one Bun binary + libchdb

There is a single binary, `maple`, compiled from **`apps/cli`** (package
`@maple/cli`, Effect + Bun) with `bun build --compile`. It is both the CLI and
the server, and it talks to the embedded ClickHouse engine **directly via
`bun:ffi`** — no subprocess, no second language at the front:

| Concern | Where | How |
| --- | --- | --- |
| CLI commands | `apps/cli/src/commands` | `maple services`, `traces`, `errors`, … run against **either** the local server **or** a remote workspace — every command bottoms out at the shared `WarehouseExecutor`, and only the executor layer swaps per [mode](#local-vs-remote-mode). |
| `maple start` server | `apps/cli/src/server/serve.ts` | A `Bun.serve` hosting OTLP/HTTP ingest (`POST /v1/{traces,logs,metrics}`), the query API (`POST /local/query`), and the bundled SPA — all on one port. |
| Embedded ClickHouse | `apps/cli/src/server/chdb.ts` | `dlopen`s `libchdb` via `bun:ffi` (the `chdb_*` accessor C API) and holds a single connection for the process. |
| OTLP → rows | `apps/cli/src/server/otlp/` | Decodes OTLP protobuf/JSON (protobufjs) and encodes each signal to per-table NDJSON, matching the generated `local-inserts.json` schema exactly. Ported from the production Rust encoders so row shapes can't diverge. |
| Bundled UI (SPA) | `apps/local-ui` (Vite + React) | Hooks compile queries with `CH.compile(...)` and POST to `/local/query`. Built to `dist/` and inlined into the `maple` binary at build time (see [release bundle](#release-bundle)). |

chDB allows exactly one connection per process and isn't safe to call
concurrently — so the long-lived `maple start` process owns the connection, and
short-lived query commands (`maple traces`, …) reach it over HTTP via
[`executeLocalQuery`](../packages/query-engine/src/local.ts). `bun:ffi` calls are
synchronous and serialize naturally on the single JS thread, which preserves
chDB's single-writer requirement.

## The `/local/query` contract

Clients POST `{ "sql": "..." }` and get back a bare JSON array of rows.

The **server owns the output FORMAT**. chDB runs SQL verbatim, and the handler
wraps line-delimited rows into a JSON array, so it always needs
`FORMAT JSONEachRow`. `CH.compile(...)` appends `FORMAT JSON`, so the handler
(`forceJsonEachRow` in `apps/cli/src/server/serve.ts`) strips any trailing
`FORMAT <ident>` the client sent and re-appends `FORMAT JSONEachRow`. Clients
therefore POST `compiled.sql` verbatim — no client-side format rewriting.

## Dev workflow

No Rust toolchain needed. Run the server and the SPA dev server in two terminals:

```bash
# Terminal 1 — the server (OTLP ingest + query API + chDB) on :4318.
# Needs libchdb: set MAPLE_LIBCHDB, or keep libchdb.so in ~/.maple/bin.
bun run apps/cli/src/bin.ts start

# Terminal 2 — the Vite SPA dev server on :4319, proxying /local → :4318
bun --filter @maple/local-ui dev
```

Open <http://127.0.0.1:4319>. Vite proxies `/local/*` to the server (override the
target with `MAPLE_LOCAL_URL`).

Query from the CLI against the same server:

```bash
bun run apps/cli/src/bin.ts services
bun run apps/cli/src/bin.ts traces --service api --since 1h
bun run apps/cli/src/bin.ts query "SELECT count() FROM traces"
```

In local mode the CLI targets `http://127.0.0.1:4318` by default; override with `MAPLE_LOCAL_URL`.

> **libchdb in dev.** `chdb.ts` resolves `libchdb` from, in order: `MAPLE_LIBCHDB`,
> a sibling of the executable, then `~/.maple/bin/libchdb.{so,dylib}`. Running from
> source uses the Bun executable's directory (no sibling libchdb), so either set
> `MAPLE_LIBCHDB` or drop a `libchdb.so` in `~/.maple/bin`.

## Local vs remote mode

The same CLI talks to a local server or a remote Maple workspace. The mode is
resolved per invocation:

1. `--remote` / `--local` flags (highest priority; usable as `maple <command> --local`).
2. `defaultMode` in `~/.maple/config.json`.
3. **Auto-detect**: a configured token ⇒ remote; otherwise a quick probe of
   `GET <local-url>/health` ⇒ local. If neither is available the CLI prints an
   actionable error.

Remote credentials live in `~/.maple/config.json` (mode `0600`), managed by:

```bash
maple login --api-url https://api.maple.dev   # paste the token when prompted (or --token / stdin)
maple whoami                                   # show the resolved mode + target
maple logout                                   # forget the stored token
```

Env overrides: `MAPLE_API_URL`, `MAPLE_API_TOKEN`, `MAPLE_LOCAL_URL`.

**How queries route.** Local mode compiles the pipe → SQL client-side and POSTs
it to `/local/query`. Remote mode POSTs `{ pipe, params }` to the API's
`POST /api/tinybird/query`, where the server compiles it with the
authenticated tenant's org id (the client never sends `org_id`). Both paths use
the same `@maple/query-engine` dispatcher, so results are identical.

**`maple query "<sql>"` is local-only.** A generic raw-SQL passthrough against
the multi-tenant cloud warehouse would let a client read other orgs' data, so
in remote mode it returns a clear error. Every other command works in both modes.

### Seeding data

Send OpenTelemetry to the server's OTLP/HTTP endpoints
(`POST /v1/{traces,logs,metrics}`, protobuf or JSON, optionally gzip-encoded).
Most OTLP exporters default to protobuf and work out of the box. For OTLP/JSON,
trace and span IDs follow the OTLP/JSON convention (hex strings).

## Release bundle

`scripts/build-local-binary.sh` produces a relocatable **2-file bundle** (also built
per-platform by `.github/workflows/local-binary-release.yml`):

```
maple        # single Bun-compiled binary: CLI + ingest/query server + embedded SPA
libchdb.so   # the chDB engine (~320 MB), downloaded from chdb-io/chdb-core releases
```

The build (1) builds the SPA, (2) inlines `apps/local-ui/dist` into
`apps/cli/src/server/ui-embed.gen.ts` so `bun build --compile` bakes it into the
binary, (3) compiles `apps/cli`, and (4) downloads the matching `libchdb` beside
the binary. At runtime `maple` `dlopen`s the sibling `libchdb` (resolved relative
to its own path), so keep both files in the same directory — no `LD_LIBRARY_PATH`
or rpath tricks.

```bash
scripts/build-local-binary.sh               # full 2-file bundle into ./dist
```
