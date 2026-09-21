# Persistence Operations

Maple stores relational application state in PostgreSQL with a schema defined by Drizzle in
`packages/db/src/schema/`.

## Runtime modes

- **Production:** the PlanetScale Postgres `main` branch. Cloudflare Workers
  connect through the `MAPLE_DB` Hyperdrive binding; the application never opens the direct
  administrative connection.
- **Wrangler development:** Docker Postgres on port 5499 through Hyperdrive's
  `localConnectionString`.
- **Non-Worker local entrypoints and tests:** embedded PGlite. `MAPLE_DB_URL` is a PGlite data
  directory, or `memory://` for an ephemeral database. It is not a remote database URL.
- **PR previews:** no application database while preview deploys are disabled. Routes that
  need `Database` fail normally; DB-free routes such as health checks continue to work.

Application code keeps timestamps as epoch-millisecond numbers and converts at the Drizzle
boundary — use `msToDate` / `dateToMs` from `packages/backend/src/platform/time.ts` rather than bare
`new Date(ms)` / `.getTime()`, including inside Promise-land helpers.

## Connections on Workers

One connection pool per invocation — request, cron tick, or Workflow run — created lazily on the first
query and closed at the boundary. This is Cloudflare's documented Hyperdrive shape, and
`makePgConnectionScope` (`packages/backend/src/platform/pg-connection-scope.ts`) is the only implementation
of it: `withPgConnectionScope` installs a scope around each worker's request handler and cron tick, and
`executeOnFreshPgClient` is the same scope one call long for entry points that have none.

Workers tie TCP sockets to the invocation that opened them, so a connection may be reused freely
within one but must never outlive it. Two settings carry hard-won history:

The driver is node-postgres through `@effect/sql-pg`: one `pg.Pool` per invocation, built lazily
by `createMaplePgPool` (`packages/db/src/client.ts`) and handed to `PgClient.fromPool` rather than
`PgClient.make`, because `make` probes with `SELECT 1` at acquire. Two settings carry hard-won
history:

- **`max: 5`** — Cloudflare's documented value. `max` is a ceiling, not a reservation: the pool
  opens a second socket only when a second statement is genuinely in flight. It was 1 for one day
  on the theory that Postgres should hold at most one of the Worker's six outbound slots, which
  serialized every statement in a cron tick behind one connection (`SELECT actors` p50 928ms →
  5687ms at flat volume).
- **A bounded dial** (10s, `connectionTimeoutMillis` on each `Client`, never on the `Pool`) —
  unset, a stalled dial hangs for the whole invocation and lands with no `error.type` to classify.
  On the pool the same option also times out waiting for a free client, so a fan-out wider than
  `max` would fail against a healthy server. A dial that hits the bound carries no driver code and
  lands as `error.type = ConnectionError` (`postgres-errors.ts` classifies code-less acquire
  failures); a refused one carries the socket's own code (`ECONNREFUSED`). The bound is generous and single: a
  2s cap alone once took production 5xx from 0.06% to 5.01%, and the retry ladder that followed
  existed only to compensate for it.

## Local development

Start and migrate the Docker Postgres used by Wrangler:

```bash
bun db:up
bun db:migrate:local
```

Persistent PGlite is created automatically for non-Worker local entrypoints under
`apps/api/.data/pglite`. Set `MAPLE_DB_URL=memory://` when persistence is not wanted.

## Authoring migrations

Change the Drizzle schema, then generate the SQL and metadata together:

```bash
bun run --cwd packages/db db:generate
```

Review the generated folder in `packages/db/drizzle/`: one `<timestamp>_<name>/` per migration
holding `migration.sql` and the DDL `snapshot.json` (drizzle-kit v1 layout, no journal). The
migrator orders folders by name and applies every folder the database has not recorded. A
hand-authored migration (data backfill, publication change) still needs a folder with both
files: run `drizzle-kit generate --custom --name <name>` to scaffold it rather than creating the
folder by hand, so the snapshot chain stays intact.

Useful local commands:

```bash
bun run --cwd packages/db db:migrate
bun run --cwd packages/db db:push
bun run --cwd packages/db db:studio
```

`db:push` is a development utility only. Committed environments use migrations.

## Deployment and tests

The prd deploy applies migrations: `alchemy.run.ts` declares the PlanetScale `main` branch as
`Planetscale.PostgresBranch` with `migrations` pointed at `packages/db/drizzle`, and the api, ai and
alerting Workers carry its name in their env so they upload after it. Bookkeeping is alchemy's
`__alchemy_migrations`; `drizzle.__drizzle_migrations` was copied in once and is frozen, so never run
`drizzle-kit migrate` against prd. The deploy migrates as a temporary role, not `postgres`, so the
branch's default privileges do not cover the tables it creates: a migration that creates one grants
it `TO PUBLIC` itself. The deploy reads `PLANETSCALE_API_TOKEN_ID` / `PLANETSCALE_API_TOKEN` /
`PLANETSCALE_ORGANIZATION` from Infisical prod; `bun dev` leaves the PlanetScale provider out.

The first v1 migrate on a database migrated by drizzle 0.x upgrades `drizzle.__drizzle_migrations`
in place (adds `name` and `applied_at`), matching every existing row to a local folder by
`created_at` truncated to the second, then by hash, and **refusing the whole run if any row matches
nothing**. A row like that is a migration that was applied and later renumbered or re-timestamped,
or one applied from a branch that never merged. Check before migrating. The report prints a
DELETE for a superseded row and an UPDATE for a renumbered row whose SQL is byte-identical; a row
whose SQL changed after it ran gets a `git diff` instead, because relabelling it would record
statements this database never saw as applied.

The report also lists every local migration no row matches, because the v1 migrator applies all
of them where the 0.x migrator only applied those newer than the newest recorded timestamp. A
migration whose DDL reached the schema without a row (a `db:push`, a run that died after its
transaction committed) used to be skipped silently and now fails on the objects that already
exist. Compare each pending folder's first statement with the schema; record the ones already
applied with the INSERT the report prints rather than replaying them:

```bash
bun run --cwd packages/db db:migrate:preflight              # DATABASE_URL, defaults to the docker Postgres
bun run --cwd packages/db ps:migrations-preflight main      # a PlanetScale branch, read-only
```

PGlite applies the same bundled migrations while its layer is built. The test harness caches a
fresh migrated PGlite snapshot and restores it per test, so integration tests exercise the
PostgreSQL schema without a shared server.

## Tinybird Materialized Views and TTL Coupling

Raw `traces` and `logs` are retained for 30 days. Projection targets that preserve one row per
span or log use the same 30-day ceiling; aggregate targets intentionally retain rollups for 90 or
365 days. The TTL belongs to the target datasource in
`packages/domain/src/tinybird/datasources.ts`, not to the materialized-view definition.

Two operational consequences:

1. **Backfill ceiling.** When deploying a new MV with `POPULATE`, you can only backfill data the source table still has — anything aged past the source TTL is lost. Plan deploys before any TTL reduction.

2. **TTL changes require a target audit.** Keep row-level projections in lockstep with their raw
   source. Preserve the independently documented retention of hourly and error rollups unless the
   product retention policy changes too.

### Cardinality pre-flight for `traces_aggregates_hourly_mv`

Before deploying, confirm `SpanName` cardinality fits the MV sort key. Run against production:

```sql
SELECT
  OrgId,
  toStartOfHour(Timestamp) AS hour,
  uniq(SpanName) AS span_name_cardinality
FROM traces
WHERE Timestamp > now() - INTERVAL 7 DAY
GROUP BY OrgId, hour
ORDER BY span_name_cardinality DESC
LIMIT 50
```

Decision rule:

- p99 < 1K distinct → keep `SpanName` in MV dimensions (current setup)
- p99 1K–10K → keep but only route to MV when query has a `SpanName` filter
- p99 > 10K → drop `SpanName` from MV dimensions; group-by-span-name queries fall back to raw `traces`

High cardinality is usually a tenant emitting per-request data in span names (anti-pattern, but seen). Address at the source if found.
