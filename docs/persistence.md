# Persistence Operations

Maple stores dashboard persistence data in SQLite/libSQL and uses Drizzle migrations.

## Modes

- Local default: `MAPLE_DB_URL` unset, DB file at `apps/api/.data/maple.db`
- Turso/libSQL remote: set `MAPLE_DB_URL` and `MAPLE_DB_AUTH_TOKEN`

## Migration Commands

Run from repo root:

```bash
bun run db:migrate
```

Generate new migration from schema changes:

```bash
bun run db:generate
```

Apply schema directly without migration files (development utility):

```bash
bun run db:push
```

Open Drizzle Studio:

```bash
bun run db:studio
```

## API Runtime Behavior

`@maple/api` applies migrations on startup from its database layer (`runMigrations()` in
`packages/db/src/migrate.ts` for the libSQL path; data migrations re-run on each Cloudflare
D1 worker boot from `apps/api/src/services/DatabaseD1Live.ts`). There is no separate
`db:migrate` step before `dev`/`start`.

## Two Migration Runners (read before authoring a migration)

DDL migrations in `packages/db/drizzle/` are applied by **two different runners that decide
what to run differently** — they must be kept in agreement:

- **libSQL** (local dev, Turso, self-host) — `drizzle-orm/libsql/migrator` reads
  `meta/_journal.json`, runs each entry whose `when` timestamp is greater than the newest
  `created_at` already in `__drizzle_migrations`. **A `.sql` file that is not in the journal
  is never applied here.**
- **Cloudflare D1** (prod/staging) — alchemy's `migrationsDir` enumerates `**/*.sql` by
  **directory listing** (sorted by numeric prefix), tracks applied files by **filename** in
  `drizzle_migrations`, and ignores `_journal.json` entirely. It is **not** idempotent — a
  duplicate `CREATE TABLE` will fail.

Consequence: a `.sql` file present on disk but missing from `_journal.json` ships to D1/prod
but silently never reaches libSQL/self-host. This exact drift happened with
`0011_org_ingest_sampling_policies.sql`.

**To author a DDL migration:** add the `.sql` file under `packages/db/drizzle/` (drizzle
backtick DDL style) **and** append a `meta/_journal.json` entry whose `idx` is sequential and
whose `tag` matches the filename. Keep `idx`, the tag number, and the filename aligned. Then
update the head snapshot (below) so `db:generate` stays clean.

## Snapshot State (`meta/*_snapshot.json`)

Snapshots feed `drizzle-kit generate` **only** (they have zero runtime effect; neither runner
reads them). The head snapshot — `meta/{lastIdx}_snapshot.json` — must equal the live
`schema/`, otherwise `generate` emits a bogus catch-up migration. The chain was re-baselined
at `0014_snapshot.json` (== `schema/`); intermediate `0011–0013` snapshots are intentionally
absent (`generate` only diffs against the head). After any schema change, run `db:generate`
and confirm it reports "No schema changes" before/after as expected.

> Caveat: some historical schema state was reached via boot-time data-migration DDL (the
> `alert_rules` reshape in `0013-alert-query-signal-types`), which `drizzle-kit` cannot see.
> The head snapshot, not the `.sql` history, is the source of truth for `generate`.

## Data Migrations (JSON-column rewrites)

**Schema changes — including plain column adds/drops — are DDL and belong in a Drizzle
migration `.sql` file under `packages/db/drizzle/` plus a matching `_journal.json` entry.**
They are applied by `migrate()` on the libSQL path and by D1's `migrationsDir` on deploy.
Do **not** express a DDL change as a boot-time data-migration script — that splits the work
across two runners (`runMigrations()` and `DatabaseD1Live.ts`) that have to be kept in sync
by hand, which has caused a column to ship to one path but not the other.

The data-migration path below is reserved strictly for transforms a DDL migration _cannot_
express — e.g. structurally rewriting a stored JSON blob (`dashboards.payloadJson`,
`dashboardVersions.snapshotJson`). Those run as TypeScript scripts in
`packages/db/src/migrations/`.

- Each script is **idempotent** and guarded by the `_maple_data_migrations` bookkeeping
  table (`id`, `applied_at`) — it short-circuits if its id is already recorded.
- The libSQL path runs them inside `runMigrations()` (`packages/db/src/migrate.ts`), after
  the DDL `migrate()`.
- The Cloudflare D1 worker never calls `runMigrations()`, so each data migration is also
  invoked once on worker boot from `DatabaseD1Live.ts`; the guard table makes every later
  boot a single `SELECT`. **Anything added here must be added to both runners.**

See `packages/db/src/migrations/0012-dashboard-widget-reshape.ts` for the reference shape.

## Self-Host Note

For file-based mode, mount/persist `apps/api/.data` in your runtime environment.

## Tinybird Materialized Views and TTL Coupling

Materialized view TTLs in `packages/domain/src/tinybird/materializations.ts` and their target datasources in `packages/domain/src/tinybird/datasources.ts` must match the source table TTL. Today all sources (`traces`, `logs`) and their MV targets are 90 days.

Two operational consequences:

1. **Backfill ceiling.** When deploying a new MV with `POPULATE`, you can only backfill data the source table still has — anything aged past the source TTL is lost. Plan deploys before any TTL reduction.

2. **TTL changes ship in lockstep.** If raw-table TTL changes (e.g., dropping `traces` to 30 days for cost), every MV target reading from it needs the same change in the same Tinybird deploy. A mismatched TTL leaves orphaned aggregate rows that never roll off.

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
