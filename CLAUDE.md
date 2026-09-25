# CLAUDE.md

Maple is an OpenTelemetry observability platform: TanStack Start (React 19, Vite) + Effect on the
backend, ClickHouse/Tinybird as the warehouse, PlanetScale Postgres for relational state.

## Workspace layout

- `apps/*`: deployables (web, api, ai, ingest, alerting, cli, landing, sandbox, ...).
- `packages/*`: shared code that knows Maple (`domain`, `query-engine`, `backend`, `ui`, `db`, ...).
- `lib/*`: zero Maple knowledge, could ship as a standalone OSS library. A `lib/` package that
  imports `@maple/domain` must move to `packages/`. New packages default to `packages/`.

`@maple-dev/effect-clickhouse` lives in the separate effect-clickhouse repo; change it there.

## Commands

```bash
bun dev                        # full alchemy dev stack at https://[<worktree>.]<app>.localhost
bun dev api web                # subset
bun --filter=@maple/web dev    # single app, raw port
bun run test                   # Vitest via turbo (NOT `bun test`)
bun typecheck
bun run tinybird:manifest      # after editing datasources.ts
bun run local-schema:bump <slug>   # local chDB schema bump for a datasources.ts change
bun db:up && bun db:migrate:local
bun run --cwd packages/db db:generate   # new Drizzle migration
bun run dev:signin             # one-shot signed-in Clerk link (dev user david+clerk_test@gmail.com)
```

Dev password fallback: `Maple-Dev-Kx92qZ!`. Toolchain is pinned in `mise.toml`; keep `bun` in sync
with `packageManager`.

## Backend architecture

- `apps/ai` runs the public MCP server, the chat agent, and investigations. `apps/api` forwards
  `/mcp`, `/api/chat/*`, `/internal/chat/*` to it over a service binding; OAuth stays in `apps/api`.
- An investigation is **one agent turn** ending in `submit_diagnosis`. Do not split it across
  planner/lanes/validator. Sub-agents are fine elsewhere (e.g. review fan-out) via `SubagentHost`.
- LLM code (Effect AI + `effect-agent`) is only in `apps/ai`; Maple-specific wiring lives in
  `apps/ai/src/platform/Llm.ts`.
- Shared services live in `packages/backend`, imported via `@maple/backend/*` subpaths.

### Service conventions

- Services acquire their dependencies in the constructor; public methods must not leak
  implementation services in their Effect requirements. Request-scoped context (transactions,
  tenant, actor) stays on the invocation, never captured at construction.
- Each service owns `static readonly layer = Layer.effect(this, this.make)` with internal deps via
  `Layer.provide`. `Env`, `Database`, caches, and bindings come from the app root.

## Warehouse queries

No Tinybird pipes/endpoints. All queries use the ClickHouse DSL in `@maple/query-engine` and run
through `WarehouseQueryService.compiledQuery()`. Never `fetch()` `/v0/sql`.

Add a query in `packages/query-engine/src/ch/queries/*.ts`, export from `src/ch/index.ts`:

```typescript
const rows = yield* warehouse.compiledQuery(tenant, CH.compile(CH.myQuery({ limit: 50 }), { orgId, startTime, endTime }), {
  profile: "list",
  context: "myQuery",
})
```

- Every query **must** filter `OrgId` (`$.OrgId.eq(param.string("orgId"))`); enforced at runtime.
- Pass the unrun `CH.compile` Effect; never `Effect.orDie` it at a call site.
- Identity UInt64s (hashes/ids) must be `toString()`-wrapped in the SELECT. `rowSchema`s use
  `CH.CHNumber`, never `Schema.Number`.
- Request fields that reach `param.*` or column comparisons are validated at the HTTP boundary
  (`TinybirdDateTime`, `BucketSeconds`, `WarehouseDateTime`) so bad input is a 400, not a 500.
- The query-engine root barrel stays driver-free (web/cli import it).
- `packages/domain/src/tinybird/endpoints.ts` is type-only.
- Read `docs/warehouse-rollups.md` before adding a materialized view. Query perf work uses
  `bun run bench:queries` (see `docs/query-benchmarking.md`); empty-table timings prove nothing.

## Application database (Postgres / Drizzle)

Schema in `packages/db/src/schema/`, reached via Hyperdrive binding `MAPLE_DB`. Drizzle runs on
Effect (`drizzle-orm/effect-postgres`): queries are `yield*`ed, `db.transaction` takes an Effect.

- Use `msToDate` / `dateToMs` (`packages/backend/src/platform/time.ts`) at the drizzle boundary.
- Use `.returning()` + length, never driver write-result shapes. `count(*)` needs `::int`. Wrap raw
  `db.execute(sql...)` in `rawRows`.
- One pool per invocation via `withPgConnectionScope`; connections never outlive the invocation.
  Fork DB work off a request only with `forkRequestScoped`.
- Tests use `createTestDb()` (PGlite, `packages/backend/src/platform/test-pglite.ts`).
- **Migrations apply in the prd alchemy deploy.** Never run `drizzle-kit migrate` against prd.
- PR previews (only with the `preview` label) have no database; DB-backed routes 500 there.

## Conventions

- **Schemas:** Effect Schema, not Zod. `Schema.optionalKey()` for JSON HTTP/domain schemas,
  `Schema.optional()` only where `undefined` is a real value (search params, MCP tool params).
- **Errors:** expected failures use `Schema.TaggedError` with a namespaced tag, `message`, and
  schema-backed context (`Schema.Defect()` for unknown causes). Keep them in the typed channel;
  remap with `catchTag`/`catchTags`. No plain `Error`, throws, or `Data.TaggedError`. Branded IDs in
  error context; undecodable input goes in a `raw*` string, never cast to a brand.
- **Types:** `Record<string, any>` is a lint error (repo is at zero). Use `Record<string, unknown>`.
- **Library source:** read `node_modules/effect/src/`, `node_modules/@effect/*/src/`, and
  `node_modules/alchemy/src/` for APIs at the installed version.
- **Span status codes:** Title case: `"Ok"`, `"Error"`, `"Unset"`. Only 5xx is `Error` for server
  spans. Custom attributes use `maple.*`.
- **Self-tracing:** the API traces itself through ingest; keep `withTracerDisabledWhen()` and avoid
  spans on hot paths like token validation.
- **UI:** shadcn/Base UI + Tailwind 4, Recharts, Nucleo icons. Port icons into
  `apps/web/src/components/icons/` from the local Nucleo DB:
  ```bash
  sqlite3 "~/Library/Application Support/Nucleo/icons/data.sqlite3" \
    "SELECT id, name, set_id FROM icons WHERE klass='outline' AND grid=24 AND name LIKE '%search%';"
  ```
- `@/` resolves to each app's source. `src/routeTree.gen.ts` is generated.

## MCP tools

Every tool is `server.define({ parameters, output, hints, handler, render })`
(`apps/ai/src/mcp/tools/types.ts`); the registry owns decode, aliases, errors, output encoding and
rendering. `registry.contract.test.ts` enforces it across the catalog.

- Parameters come from `apps/ai/src/mcp/lib/params.ts` (`P.timeWindow`, `P.service`, `P.limit`,
  `P.oneOf`...): one spelling per concept, retired names only as `aliases`.
- Output is an Effect Schema in `packages/domain/src/mcp-outputs/` (`outputSchema` /
  `structuredContent`, and the chat UI's payload). The model reads `render(output)`, a `ToolDoc`
  whose `next` calls the registry validates.
- Failures are typed (`McpInvalidInputError`, `McpNotReadyError`, `McpUnavailableError`,
  `McpQueryBudgetError`, `McpQueryError`); no `isError` literals in tools.

## Repository sandbox

Internal-only agent tools (`sandbox_*`, `apps/ai/src/mcp/tools/sandbox.ts`) run commands against a
git clone in Cloudflare's Sandbox container (`apps/sandbox`, prd only). Invariants:

- Refs are validated (`unsafeRef`) and encoded before the GitHub call.
- The clone credential never appears in command arguments.
- Commands run unprivileged, read-only, no egress; refuse to run if the network namespace fails.

Test with `bun run --cwd apps/sandbox verify:image` (needs Docker); it catches what unit tests can't.

## Docs

Read the relevant doc before touching an area: `error-issue-lifecycle.md` (anything in
`packages/backend/src/services/errors/`), `warehouse-rollups.md`, `service-map-architecture.md`,
`ingest-wal-durability.md`, `local-mode.md`, `infra.md`, `api-v2.md`, `otel-spec/`.
