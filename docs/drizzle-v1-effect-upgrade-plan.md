# Drizzle 1.0 + Effect driver upgrade plan

Written 2026-09-15 against `main` (`0bfb54137c`). Maple is on `drizzle-orm@0.45.2` /
`drizzle-kit@0.31.10` with the `postgres-js` driver on Workers and `pglite` in vitest, on
`effect@4.0.0-rc.112`.

## What is true today

| Fact                              | Value                                                                                                                                                                                                                                                                               | Consequence                                                                                                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Newest drizzle 1.0 build          | Tagged: `1.0.0-rc.4` (2026-06-27). Snapshot: `1.0.0-rc.5-5935859` (2026-09-09) off the `rc5` branch; `latest` is still `0.45.2`                                                                                                                                                     | No GA. Adopting means pinning an RC in prod. Only the rc.5 line runs on current effect (see below).                                                                                          |
| rc.4 effect peer range            | `effect >=4.0.0-beta.83`, same for `@effect/sql-pg` and `@effect/sql-pglite`                                                                                                                                                                                                        | Our rc.112 pin satisfies it. Also covers the blocked rc.115 branch.                                                                                                                          |
| `@effect/sql-pg@4.0.0-rc.112`     | node-postgres (`pg@^8.23`, `pg-pool`, `pg-types`, `pg-cursor`)                                                                                                                                                                                                                      | Driver swap from postgres.js. Cloudflare needs `pg >= 8.16.3` and `nodejs_compat`, and calls pg the recommended Hyperdrive driver.                                                           |
| `@effect/sql-pglite@4.0.0-rc.112` | needs `@electric-sql/pglite ^0.5.6`; accepts `liveClient`                                                                                                                                                                                                                           | We are on 0.5.4, bump. The test harness can keep its snapshot-restored instance and the Date-param proxy.                                                                                    |
| `PgClient.make`                   | runs `SELECT 1` eagerly inside `acquireRelease`, 5s default timeout, `pool.end()` capped at 1s                                                                                                                                                                                      | That probe is exactly the round trip Maple removed. Use `PgClient.fromPool({ acquire })` with our own lazily created `pg.Pool` instead.                                                      |
| `EffectLogger.logQuery`           | returns an `Effect`, service fixed at `PgDrizzle.make`                                                                                                                                                                                                                              | Per-call statement collection survives: the logger reads a `Context.Reference` set per `Database.execute` call, so one db instance per invocation replaces the per-call `wrapMaplePgClient`. |
| Effect query errors               | `EffectDrizzleQueryError { query, params, cause: Cause.fail(SqlError) }`; `SqlError.reason` is pre-classified (`ConnectionError` 08xx, `UniqueViolation` 23505, `ConstraintError` 23xxx, `DeadlockError` 40P01, `SerializationError`, `SqlSyntaxError` 42xxx, …) with `isRetryable` | `postgres-errors.ts` reads `reason._tag` instead of postgres.js codes. `error.type` values on spans change.                                                                                  |
| Migrations folder                 | v1 kit uses "v3" layout: one folder per migration with `migration.sql` + snapshot, no `_journal.json`; migrator throws if `meta/_journal.json` exists; migration table gains `name` and `applied_at` and is backfilled                                                              | `drizzle-kit up` rewrites `packages/db/drizzle/`; `readBundledMigrationsSql` and the docs must follow.                                                                                       |
| RQB / relations usage             | none                                                                                                                                                                                                                                                                                | RQB v2 rewrite does not apply to us.                                                                                                                                                         |
| v1 API breaks that hit us         | `getTableColumns` → `getColumns` (3 sites); `strict` removed from `drizzle.config`; `schemaFilter` now defaults to all schemas                                                                                                                                                      | Small.                                                                                                                                                                                       |
| Call-site surface                 | 73 files, ~289 `execute` calls, 33 `db.transaction(async tx => …)` sites in 15 files, 16 services on `makeDbExecute`, 13 Promise-land helpers typed on `MaplePgClient`/`DatabaseClient`, 5 raw `db.execute(sql…)` sites                                                             | Phase B is a mechanical but wide sweep.                                                                                                                                                      |
| Tests                             | 77 files on `createTestDb` (PGlite), 11 files faking `Database.execute` directly, 2 proxying `MapleDatabaseTransaction`                                                                                                                                                             | Harness change is central; the 13 direct fakes are hand edits.                                                                                                                               |

The 2026-08-22 assessment said revisit when "1.0 is stable AND `@effect/sql-pg` is on our
effect line". The second condition is met. The first is not, and nothing suggests when it will be.

## Recommendation

Split the work so the ORM major and the driver swap never land in the same deploy:

1. **Phase 0, spike (done, see results below).** rc.4's effect driver does not import on effect
   rc.112; the `rc5` branch fixed that in August and the `1.0.0-rc.5-5935859` snapshot runs the
   spike unpatched.
2. **Phase A, drizzle 1.0 on the existing drivers (done on `chore/drizzle-v1-rc4`).** Version bump,
   `drizzle-kit up`, the `getColumns` sites, the migration-folder readers. Behaviour-neutral for
   the Workers: still postgres.js, still Promise-land call sites.
3. **Phase B, the Effect driver (4 to 6 days).** Rebuild `DatabaseLive` and the connection
   scope over `PgClient` + `PgDrizzle`, then sweep the call sites to `yield*`. Needs drizzle
   `>= 1.0.0-rc.5`: either the tagged rc.5 once it is cut, or the `1.0.0-rc.5-5935859` snapshot
   now. Pinning a commit-suffixed snapshot in prod is the owner's call; the kit in that snapshot
   reads the converted folder unchanged, so bumping from rc.4 is a manifest change only.

Gate B on A having soaked in prod for at least a week, because A already moves the migration
table and the query compiler, and B moves the wire driver. If one of them regresses, we want to
know which.

## Phase 0: spike

Branch from `main` in a fresh worktree with a real `bun install` (a mirror is wrong for a
dependency bump). Everything below is a check, not a change to keep.

- [ ] `bun add drizzle-orm@1.0.0-rc.4 @effect/sql-pg@4.0.0-rc.112 @effect/sql-pglite@4.0.0-rc.112` in `packages/db`, bump `@electric-sql/pglite` to `^0.5.6` in the three packages that pin it. rc.4 is well past the `bunfig.toml` release-age quarantine.
- [ ] Typecheck a throwaway module that builds `PgDrizzle.make({ schema })` over `PgClient.fromPool` and runs one `yield* db.select().from(apiKeys)`. drizzle rc.4 was compiled in June against the beta.83 API; it uses `Context.Service`, `Effect.fn`, `Effect.catch`, `Effectable`, `Schema.TaggedErrorClass`, `Layer.effect`, all present in rc.112, but the `.d.ts` files are what have to agree.
- [ ] Confirm `fromPool` does not probe. In rc.112 the `SELECT 1` lives in `make`'s `acquire`, not in `fromPool`. Confirm `pool.end()` under `Effect.timeoutOption(1000)` is only in `make` as well, or we need our own release.
- [ ] Confirm the logger runs in the caller's fiber: set a `Context.Reference` before `yield* db.select()`, assert `logQuery` sees it. This is what keeps `db.query.text` per call.
- [ ] Bundle and cold start: build `apps/api` with `pg` in place of `postgres` and compare against `apps/api/scripts/bench-startup-cpu.ts`. `pg` pulls `pg-types`, `pg-cursor`, `pg-connection-string`. Confirm `nodejs_compat` is on the api Worker (it is on alerting, ai, landing; the api one is set through infra, verify).
- [ ] Dial latency: under `bun dev` against docker Postgres, compare `db.duration_ms` on a warm `Database.execute` between postgres.js and `pg.Pool`. Hyperdrive numbers can only come from prod (no other stage has a database; `deploy-stg` is disabled; PR previews bind no `MAPLE_DB`), so this is a sanity check, not the gate. The prod gate is the internal-org `Database.execute` span dashboard after Phase B ships.
- [ ] Wire-format parity, the risk PGlite cannot show: `timestamptz` in `mode: "date"`, `jsonb`, `bigint`/`count(*)::int`, `numeric`, `text[]`. Run the existing `db-execute` and one service test (`ApiKeysService`) against docker Postgres through both drivers and diff the decoded rows.
- [ ] `undefined` inside `eq`/`and`: check whether rc.4 throws at runtime. If it does, grep the 289 sites for optional operands. Typecheck will not catch it.
- [ ] `drizzle-kit up` on a copy of `packages/db/drizzle/`: confirm it handles the gap at `0028` (we go `0027` → `0029`), then `drizzle-kit generate` must produce an empty diff. Confirm `schemaFilter: ["public"]` reproduces today's behaviour on PlanetScale (v1 manages every schema by default; we have the `drizzle` migrations schema and Electric publication objects it must not touch).

Write the numbers into this file under a "Spike results" heading. Cost and dial latency decide
whether Phase B happens at all.

## Phase A: drizzle 1.0 on the current drivers

Goal: `drizzle-orm@1.0.0-rc.4` + `drizzle-kit@1.0.0-rc.4`, still `postgres-js` on Workers and
`pglite` in tests, no call-site changes beyond renames.

1. Bump `drizzle-orm` in `apps/api`, `apps/ai`, `packages/backend`, `packages/db`, and
   `drizzle-kit` in `packages/db`. Bump `@electric-sql/pglite` to `^0.5.6` in the same sweep.
2. `getTableColumns` → `getColumns` in `ApiKeysService.ts` (2) and
   `OrganizationService.org-scoped-tables.test.ts` (1).
3. `packages/db/drizzle.config.ts`: drop `strict: true`, add `schemaFilter: ["public"]`.
4. Migration folder: run `drizzle-kit up` in `packages/db`, commit the rewritten tree. Then:
    - `packages/db/src/migrate.ts`: `readBundledMigrationsSql` walks `drizzle/*/migration.sql` in
      folder order instead of `drizzle/*.sql`. `runMigrations` keeps using the driver migrator.
    - `packages/backend/test/pglite-snapshot.ts` needs no change; its key is derived from the SQL.
      The snapshot cache directory will simply get a new entry.
    - `docs/persistence.md` "Authoring migrations": journal sentence goes, folder-per-migration
      comes in. The memory note about hand-authored journal entries is obsolete after this.
    - `.github/workflows/ingest-rust-tests.yml` path filters still match `packages/db/drizzle/**`.
    - `packages/db/scripts/planetscale-apply-schema.ts` shells to `drizzle-kit migrate`; the v1
      migrator backfills `name`/`applied_at` on the existing `drizzle.__drizzle_migrations` rows.
      Prod migrations are manual (`bun run migrate:prod`), so this backfill is a deliberate step
      in the deploy notes, run once against direct 5432 before the Worker deploy.
5. Verify, in this order: `bun typecheck`; `bun run --cwd packages/db test`;
   `bun run --cwd packages/backend test src/platform` (the migrator and snapshot path);
   `bun run --cwd packages/backend test src/services/org` (the `getColumns` sites);
   `bun db:up && bun db:migrate:local` against a fresh docker volume, then again to prove it is a
   no-op; `drizzle-kit generate` produces nothing.
6. Deploy notes: apply the backfilling migrate to prod first, then deploy. Rollback is a revert of
   the Worker deploy; the two new columns on the migration table are harmless to 0.45's migrator.

Do not touch `Database.execute`, `pg-connection-scope.ts`, or any service in this phase.

## Phase B: the Effect driver

Goal: `Database.execute` takes an Effect, queries are `yield*`ed, the typed error channel reaches
the service boundary, and one connection per invocation is still the rule.

### B1. Platform layer (`packages/backend/src/platform`, `packages/db/src`)

- `packages/db/src/client.ts`: replace `createMaplePgSocket` + `wrapMaplePgClient` with
  `makeMaplePgPool(connectionString, { maxConnections: 5, connectTimeoutSeconds: 10 })` returning
  a lazily created `pg.Pool` plus `end`, and `makeMapleEffectDb(client: PgClient)` that runs
  `PgDrizzle.make({ schema })` with `EffectCache` default and our `EffectLogger`. Keep `postgres` as
  a devDependency of `packages/db` for the six scripts that use it directly.
- `DatabaseLive.ts`:
    - `DatabaseApi.execute: <A, E>(fn: (db: MapleEffectDb) => Effect<A, E>) => Effect<A, E | DatabaseError>`.
      `DatabaseError` stays the single boundary type; `toDatabaseError` now unwraps
      `EffectDrizzleQueryError` → `SqlError.reason` → the pg error, and carries `reason._tag` so
      `postgres-errors.ts` classifies on the tag and falls back to the pg `code` in
      `reason.cause`.
    - `executeWithSpan` keeps the span shape (`db.system.name`, `peer.service`, `db.query.text`,
      `db.duration_ms`, `error.type`, `db.response.status_code`). Statement collection moves to a
      `CurrentStatementCollector` `Context.Reference` that the `EffectLogger` reads; `execute`
      provides a fresh collector per call. Decide during B1 whether the `@effect/sql`
      per-statement spans stay (they nest under ours and roughly double self-observability
      span volume) or are suppressed with `Effect.withTracerEnabled(false)` inside the body.
    - Drop the `tryPromise` boundary. The contention retry in `db-execute.ts` uses
      `reason.isRetryable` (`DeadlockError`, `SerializationError`) and keeps the SQLSTATE
      regex as a fallback.
- `pg-connection-scope.ts`: same three-state machine. `Open` now holds a `Scope` that owns the
  pool via `PgClient.fromPool`, the `PgClient`, and the one `MapleEffectDb` built over it. `run`
  provides the collector and calls `fn(db)`. `close` closes the `Scope`, which ends the pool. The
  `SCOPE_CLOSED` refusal, `db.connect.reused`, `trackOutboundSlot`, and
  `executeOnFreshPgClient` keep their semantics. `pgConnectionScopeFrom(db)` takes a
  `MapleEffectDb`. The Pool.use evaluation from 2026-09-08 still stands: this is a memoized handle
  with a terminal state, not a lease.
- `postgres-errors.ts`: node-postgres does not emit `CONNECT_TIMEOUT`; a stalled dial arrives as
  `ConnectionError` with message "Connection timed out" or the socket's `ECONN*` code. Map
  `error.type` from `reason._tag` (`ConnectionError`, `AuthenticationError`, …) with the pg code
  appended where present. Internal dashboards and alert rules that key on
  `error.type = CONNECT_TIMEOUT` change in the same PR.
- `DatabasePgliteLive.ts` / `test-pglite.ts`: `PgliteClient.make({ liveClient: withDateParamGuard(pglite) })`
  then `PgDrizzle.make` from `drizzle-orm/effect-pglite`. The Date-param guard exists because
  postgres.js rejects `Date` params; `pg` serializes them. After B ships the guard no longer
  models the deployed driver and should be removed, with `msToSqlTimestamp` kept as the
  convention.
- `migrate.ts`: stay on the Promise migrator from `drizzle-orm/pglite/migrator` for the snapshot
  builder; there is no reason to make `globalSetup` Effect-shaped.

Land B1 with the old `execute` signature still exported as `executePromise` for one commit so
the sweep in B2 can be split across PRs by service directory without a flag day.

### B2. Call-site sweep (mechanical, delegate)

Per service directory, one PR each, roughly in this order so the widest error-mapping cases go
first: `platform` and `org` (ApiKeys, Organization), `auth` (three transaction-heavy services,
`mcp-oauth-family.ts` helpers typed on `MapleDatabaseTransaction`), `alerts`, `errors`
(`error-tick-persistence.ts`, `apply-diagnosis.ts`, `issue-severity.ts`'s `TriageSeverityDb`
union), `integrations`, `dashboards`, then `apps/ai` and `apps/alerting`.

Rules for the sweep:

- `dbExecute((db) => db.select()…)` → `dbExecute((db) => db.select()…)` unchanged where the
  callback was a single awaited query; the query builder is already an Effect.
- `dbExecute((db) => db.transaction(async (tx) => { … }))` → `db.transaction((tx) => Effect.gen(function* () { … }))`.
  `await tx.x` → `yield* tx.x`. A thrown `Error` used to roll back; now fail with a
  `Schema.TaggedError` and let the channel carry it. `SqlError` joins the transaction's error
  channel and `toDatabaseError` absorbs it at the boundary.
- Promise-land helpers typed `(db: MaplePgClient | MapleDatabaseTransaction)` become
  `Effect.fn` functions over `MapleEffectDb | MapleEffectTx`.
- Raw `db.execute(sql…)` returns `readonly Row[]`; none of the five sites read `.count`.
- `msToDate` / `dateToMs` at the drizzle boundary are unchanged.
- Tests that fake `Database.execute` (11 files) switch to `execute: (fn) => fn(fakeDb)` where
  `fakeDb` is a PGlite-backed effect db from `createTestDb`; the two `failInsertOf` proxies over
  `MapleDatabaseTransaction` are rewritten against `MapleEffectTx`.

Verification per PR: `bun typecheck`, the directory's own `bun run --cwd packages/backend test src/services/<dir>`, and `bun run lint` (the effect-boundaries gate should now see
no `tryPromise` in these services).

### B3. Rollout

- Deploy B1 + the first sweep PR together; the rest can follow daily.
- Watch, in Maple's own org: `Database.execute` p50/p95 by `db.connect.reused`, `error.type`
  distribution, `/health` unaffected, `POST /mcp` `touchLastUsed` not regressing to
  `SCOPE_CLOSED` (the fork-request-scoped regression test covers the mechanism, prod covers
  the timing).
- Rollback is a revert of the Worker deploy. The migration table is untouched by B.

## Phase 0 results (2026-09-15)

Run in the same worktree on top of Phase A, with `@effect/sql-pg@4.0.0-rc.112` and
`@effect/sql-pglite@4.0.0-rc.112` added temporarily. The spike file is not kept; what it showed:

- **rc.4's effect layer does not import on effect rc.112.** `effect-core/errors.js` and
  `cache/core/cache-effect.js` call `Schema.TaggedErrorClass()`, which is the beta.83 name;
  rc.112 and rc.115 export `Schema.TaggedError`. Upstream fixed this on the `rc5` branch
  (PR #6108, merged 2026-08-12, effect peer now `>=4.0.0-beta.105`), and the npm snapshot
  `1.0.0-rc.5-5935859` (2026-09-09) carries it. On rc.4 the results below were obtained with that
  one symbol renamed in the installed copy; on the rc.5 snapshot the same spike passed unpatched,
  `tsc` was clean in db, backend, api and ai, `drizzle-kit check` and `generate` were no-ops on the
  converted folder, and the db (43) and backend platform + org (171) tests passed.
- **Typechecks against rc.112** for `drizzle-orm/effect-pglite`, `drizzle-orm/effect-postgres`,
  `PgClient.fromPool` + `PgClient.layerFrom`, `PgliteClient.layer({ liveClient })`, and a
  `Layer.succeed(EffectLogger, …)` logger. The `.d.ts` surface is fine; only the runtime rename bit.
- **Per-call statement collector works as a `Context.Reference`.** A logger whose `logQuery`
  reads the reference saw the `select … from "api_keys"` and the `pg_advisory_xact_lock` statement
  inside a `db.transaction`, with the reference provided around the caller's program. One db per
  invocation with a per-call collector is viable; no per-call drizzle wrapper needed.
- **Transactions**: `db.transaction((tx) => Effect.gen(...))` with `yield* tx.execute(sql…)`
  works; the error channel is `E | SqlError`.
- **Errors** arrive as `EffectDrizzleQueryError { query, params, cause: Cause<SqlError> }`;
  `Cause.findErrorOption(cause)` yields the `SqlError`, whose `reason` was `SqlSyntaxError` with the
  pg error (code `42P01`) as `reason.cause`. That is enough for `postgres-errors.ts` to classify
  on the tag and fall back to SQLSTATE.
- **Raw `execute` returns the driver's result object, not rows.** Both effect sessions map
  `mode === "raw"` to the statement's `.raw`, so `db.execute(sql…)` yields PGlite's
  `{ rows, fields, affectedRows }` (and node-postgres's `QueryResult` under `sql-pg`) while the
  type claims `readonly Row[]`. The five raw sites need a `.rows` normaliser in Phase B, and the
  declared type cannot be trusted for them.
- `PgliteClient.layer` and `PgClient` need `Reactivity.layer` and a `Scope`; the platform layer
  provides both inside the invocation scope.
- Not measured: Workers bundle delta and Hyperdrive dial latency for `pg`. Those stay on the
  checklist for when Phase B is unblocked.

## Phase A results (2026-09-15, branch `chore/drizzle-v1-rc4`)

Landed on the branch; nothing deployed. What the conversion actually took:

- `drizzle-kit up` is strict: it converts journal entries in order and throws
  `MigrationSnapshotNotFoundCliError` at the first entry without a `meta/<prefix>_snapshot.json`,
  having already deleted the `.sql` files it converted. Four hand-authored migrations had no
  snapshot (`0029`, `0036`, `0038`, `0045`). The fix was to restore the folder, synthesise the four
  snapshots from their exact neighbours (0029 is data-only so equals 0027; 0036 is 0035 minus
  `org_spend_limits`; 0039 is data-only so its snapshot is the state after 0038; 0045 is 0046 minus
  `live_activities` and `mobile_devices.live_activity_start_token`), re-link `prevId` through them,
  and rerun `up`. Every `migration.sql` is byte-identical to the old file, so the migrator's
  hash-based backfill of `drizzle.__drizzle_migrations` will match production rows.
- The `up` conversion serialises partial-index `WHERE` clauses table-qualified
  (`"alert_incidents"."status" = 'open'`) while a fresh schema read does not (`"status" = 'open'`),
  so the first `generate` after `up` emitted a migration dropping and recreating all 8 partial
  indexes with identical definitions. Fixed by replacing the head folder's `ddl` with the freshly
  generated one and deleting the spurious folder; `generate` is now a no-op and `check` passes.
  Intermediate snapshots keep the qualified form, which only `up` ever read.
- `0010_huge_dexter_bennett` and `0011_electric_publication_wave1` share a second, so their v3
  folders share a timestamp prefix and sort in the opposite order. They are independent
  (a column on `cloudflare_analytics_state` versus a publication change), so nothing was renamed.
- `drizzle()` in v1 has no `(client, config)` overload and no `schema` option (that only fed the
  removed RQB v1); the three constructors are now `drizzle({ client, logger })`.
- `getTableColumns` still exists in rc.4 as a deprecated alias, so the rename is cosmetic.
- Verified: `tsc` clean in `packages/db`, `packages/backend`, `apps/api`, `apps/ai`; `bun run lint`
  clean; `bun install --frozen-lockfile` clean under bun 1.4.0; vitest green for `packages/db`
  (43), backend `src/platform` (83, includes the v1 migrator building the PGlite snapshot),
  `src/services/org` (88), `src/services/errors/issue-severity` (11, raw-client `runMigrations`),
  `src/services/alerts` + `src/services/auth` (448). Not run: the full `apps/api` and
  `packages/backend` suites (late-night rule); run them before merging.

## Phase B progress (2026-09-15, same branch)

Owner decision: continue on the `1.0.0-rc.5-5935859` snapshot and start Phase B without the
one-week soak. B1 is committed (`feat(db): Effect-native drizzle over @effect/sql-pg, platform
layer`); the service sweep runs per directory on top of it.

What B1 settled that the plan above left open:

- `Effect.provide(layer)` scopes the layer to the effect it wraps, so building the `PgClient`
  that way ended the pool the moment `PgDrizzle.make` returned. The client is built with
  `Layer.build` into the invocation's Scope (`packages/db/src/client.ts`), and the PGlite twin does
  the same for symmetry.
- `Layer.merge(logger, PgDrizzle.DefaultServices)` let drizzle's no-op logger shadow Maple's, so
  no statement was captured. `mapleDrizzleServices` merges the logger with `EffectCache.Default`
  only.
- `@effect/sql`'s per-statement spans are suppressed inside `executeWithSpan` with
  `Effect.withTracerEnabled(false)`; one span per logical call, as before.
- `ExecuteError<E>` is spelled `DatabaseError | Exclude<E, Extract<E, MapleDbError>>` because
  that is what `Effect.catchIf` with a refinement produces for a generic `E`; the type arguments
  are pinned in `absorbDriverErrors` because inference otherwise leaks `E` into the success
  channel.
- `PgConnectionScopeApi.close` is an `Effect`, not a Promise; the scope serialises its first open
  against a concurrent close with a one-permit semaphore.
- A refused dial through the whole stack lands as `error.type = ECONNREFUSED`,
  `db.connect.failed = true`, message `connect ECONNREFUSED 127.0.0.1:1 [while: select 1]`
  (verified with a probe, not a unit test). A dial that hits `connectionTimeoutMillis` carries no
  code and lands as `error.type = ConnectionError`; dashboards keyed on `CONNECT_TIMEOUT` need
  both.
- `rawRows` (`packages/backend/src/platform/raw-rows.ts`) normalises raw `db.execute` results.

## What to carry over from the previous assessment

- Do not `Effect.orDie` at call sites; `DatabaseError` remains the one boundary and
  `makeDbExecute` the one place that retries, logs and remaps.
- One connection per invocation, created lazily, closed at the boundary, never reused across
  invocations. The `pg.Pool` per invocation with `max: 5` is the same ceiling postgres.js had;
  keep the head-of-line note from `pg-connection-scope.ts` next to it.
- `forkRequestScoped` must still start immediately; nothing here changes middleware order.

## Open questions for the owner

- The pin is the commit-suffixed snapshot `1.0.0-rc.5-5935859`, chosen because the tagged rc.4
  cannot be imported on current effect. Move to the tagged rc.5 (or GA) when drizzle cuts it; the
  kit reads the converted folder unchanged, so that is a manifest bump.
- Does the extra Workers bundle (`pg` + `pg-types` + `pg-cursor`) fit the api cold-start budget?
  Not measured before merge; no non-prod stage has a database, so the first deploy is the number.
