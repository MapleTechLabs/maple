# Persistence Operations

Maple stores relational application state in PostgreSQL with a schema defined by Drizzle in
`packages/db/src/schema/`.

## Runtime modes

- **Production:** the PlanetScale Postgres `main` branch. Cloudflare Workers
  connect through the `MAPLE_DB` Hyperdrive binding. The application never opens the direct
  administrative connection.
- **Wrangler development:** Docker Postgres on port 5499 through Hyperdrive's
  `localConnectionString`.
- **Non-Worker local entrypoints and tests:** embedded PGlite. `MAPLE_DB_URL` is a PGlite data
  directory, or `memory://` for an ephemeral database. It is not a remote database URL.
- **PR previews:** no application database while preview deploys are disabled. Routes that
  need `Database` fail normally; DB-free routes such as health checks continue to work.

Application code keeps timestamps as epoch-millisecond numbers and converts at the Drizzle
boundary. Use `msToDate` / `dateToMs` from `packages/backend/src/platform/time.ts` instead of bare
`new Date(ms)` / `.getTime()`, including inside Promise-land helpers.

## Connections on Workers

One connection pool per invocation (request, cron tick, or Workflow run), created lazily on the
first query and closed at the boundary. This is Cloudflare's documented Hyperdrive shape.
`makePgConnectionScope` (`packages/backend/src/platform/pg-connection-scope.ts`) is the only
implementation of it. `withPgConnectionScope` installs a scope around each worker's request
handler and cron tick. `executeOnFreshPgClient` is the same scope, one call long, for entry points
that have none.

Workers tie TCP sockets to the invocation that opened them, so a connection may be reused freely
within one but must never outlive it.

The driver is `@effect/sql-pg`'s own pooled client: `makeMaplePgClient` (`packages/db/src/client.ts`)
calls `PgClient.make` with no probe, so building it opens no socket. Two settings carry hard-won
history:

- **`MAX_CONNECTIONS = 5`**, Cloudflare's documented value. It is a ceiling, not a reservation:
  the pool opens a second socket only when a second statement is in flight. It was 1 for one day,
  on the theory that Postgres should hold at most one of the Worker's six outbound slots. That
  serialized every statement in a cron tick behind one connection (`SELECT actors` p50 928ms to
  5687ms at flat volume).
- **A bounded dial** (`CONNECT_TIMEOUT_SECONDS = 10`, passed as the driver's `connectTimeout`).
  Unset, a stalled dial hangs for the whole invocation and lands with no `error.type` to classify.
  The driver applies it to one connection's connect, TLS and auth, never to the wait for a free
  connection, so a fan-out wider than the pool queues instead of failing. A dial that hits the
  bound carries no driver code and lands as `error.type = ConnectionError`
  (`postgres-errors.ts` classifies code-less acquire failures). A refused one carries the
  socket's own code (`ECONNREFUSED`). The bound is generous and single: a 2s cap once took
  production 5xx from 0.06% to 5.01%, and the retry ladder that followed existed only to
  compensate for it.

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
files. Scaffold it with `drizzle-kit generate --custom --name <name>` instead of creating the
folder by hand, so the snapshot chain stays intact.

Useful local commands:

```bash
bun run --cwd packages/db db:migrate
bun run --cwd packages/db db:push
bun run --cwd packages/db db:studio
```

`db:push` is a development utility only. Committed environments use migrations.

## Deployment and tests

The prd deploy applies migrations. `declareMapleDb` in `alchemy.run.ts` declares the instance's
PlanetScale `main` branch (database `maple` on `prd`, `maple-eu` on `prd-eu`) as
`Planetscale.PostgresBranch` with `migrations` pointed at `packages/db/drizzle`. The api, ai and
alerting Workers carry its name in their env so they upload after it. Bookkeeping is alchemy's
`__alchemy_migrations`; `drizzle.__drizzle_migrations` was copied in once and is frozen, so never run
`drizzle-kit migrate` against prd. The deploy migrates as a temporary role that is dropped with
`postgres` as its successor, so the tables it creates end up owned by `postgres` with no other grants.
Every runtime role must therefore inherit `postgres` (`USAGE`, not mere membership, which only
grants `SET ROLE`). Inheritance is fixed when PlanetScale creates the role and `GRANT postgres` is
refused, so a role without it is replaced: mint the new one with `--inherited-roles postgres`, rotate
the consumer's URL, then delete the old role. This must list no runtime credential (a personal dev
credential may appear):

```sql
SELECT rolname FROM pg_roles WHERE rolname LIKE 'pscale\_api\_%' AND NOT pg_has_role(rolname, 'postgres', 'usage')
```

The ingest gateway's credential is declared rather than minted: `Planetscale.PostgresRole` in
`alchemy.run.ts` inherits `postgres`, its pooled 6432 URL is the fleet's `maple-pg-url` secret, and
its id sits in the task env so a replaced role rolls the fleet onto the new secret before alchemy
deletes the old role. `MAPLE_INGEST_PG_URL` in Infisical remains only for stages that deploy a fleet
without a database branch (PR previews).

Electric's is declared too, on both instances: `Planetscale.PostgresRole("electric-db-role", {
withReplication: true })`, whose direct 5432 URL is the task's `DATABASE_URL` (`docs/electric-sync.md`).
`withReplication` rides Maple's alchemy patch until
[alchemy-run/alchemy#1777](https://github.com/alchemy-run/alchemy/pull/1777) ships. Alchemy renders
every role URL with `sslmode=verify-full`, which neither ECS client accepts, so `pgUrlRequireSsl` in
`@maple/infra/aws` rewrites it for both.

The EU instance's Worker credentials are declared the same way: `declareMapleDb` in `alchemy.run.ts`
mints one role per consumer on `maple-eu` and a Hyperdrive config on each role's direct origin, and
the Workers bind them from their props. No dashboard config and no hand-minted role exist there
(`resolveDatabaseMode` is `"declared"`); the US prd keeps its dashboard-managed configs, bound by id.

The deploy reads `PLANETSCALE_API_TOKEN_ID` / `PLANETSCALE_API_TOKEN` /
`PLANETSCALE_ORGANIZATION` from the instance's Infisical environment. `bun dev` leaves the
PlanetScale provider out.

PGlite applies the same bundled migrations while its layer is built. The test harness caches a
fresh migrated PGlite snapshot and restores it per test, so integration tests exercise the
PostgreSQL schema without a shared server.

## Tinybird Materialized Views and TTL Coupling

Raw `traces` and `logs` are retained for 30 days. Projection targets that preserve one row per
span or log use the same 30-day ceiling. Aggregate targets retain rollups for 90 or 365 days on
purpose. The TTL belongs to the target datasource in
`packages/domain/src/tinybird/datasources.ts`, not to the materialized-view definition.

Two operational consequences:

1. **Backfill ceiling.** A new MV deployed with `POPULATE` can only backfill data the source
   table still has. Anything aged past the source TTL is lost. Plan deploys before any TTL
   reduction.

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

- p99 < 1K distinct: keep `SpanName` in MV dimensions (current setup).
- p99 1K to 10K: keep it, but route to the MV only when the query has a `SpanName` filter.
- p99 > 10K: drop `SpanName` from MV dimensions. Group-by-span-name queries fall back to raw
  `traces`.

High cardinality usually means a tenant is putting per-request data in span names. It is an
anti-pattern, but it happens. Fix it at the source.
