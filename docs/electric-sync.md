# ElectricSQL sync (TanStack DB)

Maple syncs a small set of **relational control-plane tables** to the web app in
real time using [ElectricSQL](https://electric.ax) shapes fronted by
[TanStack DB](https://tanstack.com/db) collections. Warehouse data (traces, logs,
metrics via `@maple/query-engine`) is **not** synced. It stays on the effect-atom +
`WarehouseQueryService` path.

Electric sync is the primary read path for the dashboards and alerts verticals.
Only `/dashboards` has a fallback: it degrades to a plain-HTTP snapshot with
writes disabled (`SyncDegradedBanner`). The alerts lists have none. With the
sync worker or its upstream unreachable they show `SyncUnavailable` and a retry.
An Electric outage is therefore visible, and a deploy of the singleton service is
a short one.

The reusable machinery lives in two workspace libraries:

- `@maple/effect-db/electric` (`lib/effect-db`): `createEffectCollection` wraps
  `@tanstack/electric-db-collection` with Effect Schema rows, Effect write
  handlers run on a `ManagedRuntime`, exponential backoff, and typed
  `awaitTxIdEffect`. The backoff `onError` also dispatches window events:
  `collection:auth-error` (401), `collection:schema-error` (post-deploy schema
  drift) and `collection:sync-failed` (retries exhausted).
- `@maple/unitflow/db` (`lib/unitflow`): collection subscriptions feed
  model-scoped Stores used by the dashboards and alerts lists. Mutations use the
  typed API write paths; alert toggles run through `Mutation.make`.

## How it fits together

```
Browser (apps/web)
  TanStack DB collections, one set per active org
    read:  ShapeStream → GET {VITE_ELECTRIC_SYNC_URL}/api/sync/shape?shape=<name>&offset=…&handle=…
           (mapleSyncFetch in lib/collections/shape-fetch.ts injects the Clerk / self-hosted bearer)
    write: typed HTTP endpoints on apps/api (dashboards use public `/v2`; Electric is read-path only)

apps/electric-sync Worker: /api/sync/shape  (src/routes/shape.http.ts, a raw HttpRouter)
  a standalone, DB-free worker (deploys independently of apps/api)
  auth: Clerk/self-hosted tenant resolution ONLY (makeResolveTenant from @maple/auth,
        wrapped in src/auth/TenantResolver.ts); no API-key path, since it has no database
  whitelist: src/shapes/registry.ts; request validation: src/shapes/request.ts
  pins (src/electric/ElectricClient.ts): table + `"org_id" = $1` (+ per-shape extra WHERE
        or `$2` scope), params[1]=orgId, secret
  forwards ONLY offset/handle/live/cursor from the client
  streams Electric's response back (buffers the long-poll body)

Electric (apps/electric on ECS Fargate in prod / docker `electric` locally)
  ← logical replication ← PlanetScale Postgres (direct 5432, publication electric_publication_default)

writes: endpoint captures the Postgres txid on the mutating statement
  (`pg_current_xact_id()::xid::text`, packages/backend/src/platform/electric-txid.ts) and returns it;
  the collection's write handler passes it to awaitTxId, which drops optimistic
  state once that transaction arrives on the shape stream.
```

### Shapes (server-pinned whitelist, `apps/electric-sync/src/shapes/registry.ts`)

| shape                | table              | pinned columns / extra WHERE (besides org scope)                |
| -------------------- | ------------------ | --------------------------------------------------------------- |
| `dashboards`         | dashboards         | none                                                            |
| `alert_rules`        | alert_rules        | none                                                            |
| `alert_rule_states`  | alert_rule_states  | none                                                            |
| `alert_incidents`    | alert_incidents    | none                                                            |
| `alert_destinations` | alert_destinations | columns: drops the encrypted `secret_*`                         |
| `api_keys`           | api_keys           | columns: drops `key_hash` / `metadata_json`                     |
| `investigation_v2`   | investigations     | scoped to one `id` (client supplies the value as `$2`); columns |

Shape `where`/columns are **immutable**. Changing a pinned predicate forces a
full re-sync for every client. If you must change one, version the shape name
(as `investigation_v2` did when it gained `progress_json`) so old clients keep
working during a deploy overlap.

The whitelist and `electric_publication_default` must stay in step **both ways**.
A shape over an unpublished table never receives changes (Electric runs with
`ELECTRIC_MANUAL_TABLE_PUBLISHING=true` and will not publish one itself). A
published table with no shape is pure replication cost. `error_issues`, `actors`,
`error_incidents` and `scrape_target_checks` were published for verticals that
have since moved back to the typed `/v2` endpoints, and were pruned from both by
`0022_electric_publication_prune`.

## Local development

1. `bun db:up` starts the docker Postgres (with `wal_level=logical`) and the
   `electric` service (port 3473). See `docker-compose.development.yml`.
   If your Postgres volume predates the `wal_level` change, recreate it:
   `docker compose -f docker-compose.development.yml up -d --force-recreate postgres electric`.
2. `bun db:migrate:local` applies migrations, including `0009_electric_publication`.
3. `.env.local`: `ELECTRIC_URL=http://localhost:3473` (already in `.env.example`), read by
   the `apps/electric-sync` worker. Under `bun dev` the web app finds that worker at
   `https://electric-sync.localhost` on its own. `VITE_ELECTRIC_SYNC_URL` only matters when
   running the web app on a raw port without the portless proxy.
4. Run the app (`bun dev`). The `electric-sync` worker comes up in the `alchemy dev`
   stack with everything else (`bun dev api electric-sync web` for just the pieces that
   matter here). The synced lists (dashboards, alerts, API keys, investigation detail)
   read from the sync path, so steps 1-3 are required for them to load.

Smoke-test the proxy directly (through the standalone worker; needs a bearer):
`curl -g 'https://electric-sync.localhost/api/sync/shape?shape=dashboards&offset=-1' -H "authorization: Bearer <token>"`,
or hit Electric with no proxy: `curl -g 'http://localhost:3473/v1/shape?table=dashboards&offset=-1'`.

### Troubleshooting

**`Electric sync is not configured` (HTTP 503).** The worker's 503 body when it has
no upstream `ELECTRIC_URL`. Two causes:

1. `ELECTRIC_URL` isn't set in `.env.local`. Set `ELECTRIC_URL=http://localhost:3473`,
   then **restart** `bun dev`. `--env-file` is read once when `alchemy dev` starts, so
   a hot source reload won't pick it up.
2. The docker `electric` service isn't running on `:3473`. `bun db:up` starts it;
   confirm with `docker compose ps` (expect `maple-electric-1`).

**Shapes 404 / `Database table public.<t> is missing from the publication`** (or
`does not have its replica identity set to FULL`). The early publication migrations
(`0009`, `0011`, `0014`, `0037`) wrap their DDL in `DO $$ … EXCEPTION WHEN OTHERS THEN
RAISE NOTICE … END $$`. On real Postgres a failure inside one is swallowed, and drizzle
or alchemy still records it as applied. The case that actually happened: on the fresh
EU database the publication existed, empty, before the first migration ran. `0009`'s
`CREATE PUBLICATION` raised `duplicate_object`, and that handler rolls back the entire
block, `REPLICA IDENTITY FULL` included. The later migrations then `ADD`ed their own
tables, so only `dashboards`, `alert_rules`, `alert_rule_states` and `alert_incidents`
were missing.

`electric_publication_reconcile` closes this for every new database. It runs after all
of them, unguarded, and converges the publication on `SYNCED_TABLES`: it creates the
publication if absent, sets FULL, adds what is missing, and drops and resets anything
extra. It is a no-op on a database that is already correct. A database that ran it and
then drifted by hand needs the check below.

```bash
docker exec maple-postgres-1 psql -U maple -d maple -c "
  WITH synced(name) AS (VALUES ('dashboards'),('alert_rules'),('alert_rule_states'),
    ('alert_incidents'),('alert_destinations'),('api_keys'),('investigations'))
  SELECT coalesce(s.name, p.tablename) AS table, c.relreplident, p.tablename IS NOT NULL AS published,
         s.name IS NOT NULL AS expected
  FROM synced s
  FULL JOIN (SELECT tablename FROM pg_publication_tables
             WHERE pubname = 'electric_publication_default') p ON p.tablename = s.name
  LEFT JOIN pg_class c ON c.oid = to_regclass('public.' || quote_ident(coalesce(s.name, p.tablename)));"
```

Every row should show `f`, `published = t` and `expected = t`. A missing synced table shows
`published = f`; an extra member shows `expected = f`.
To self-heal, apply the current membership (`SYNCED_TABLES` in
`packages/db/src/migrations.test.ts`). Every statement is idempotent:

```bash
docker exec -i maple-postgres-1 psql -U maple -d maple <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'electric_publication_default') THEN
    CREATE PUBLICATION electric_publication_default;
  END IF;
END $$;
ALTER TABLE "dashboards"         REPLICA IDENTITY FULL;
ALTER TABLE "alert_rules"        REPLICA IDENTITY FULL;
ALTER TABLE "alert_rule_states"  REPLICA IDENTITY FULL;
ALTER TABLE "alert_incidents"    REPLICA IDENTITY FULL;
ALTER TABLE "alert_destinations" REPLICA IDENTITY FULL;
ALTER TABLE "api_keys"           REPLICA IDENTITY FULL;
ALTER TABLE "investigations"     REPLICA IDENTITY FULL;
ALTER PUBLICATION electric_publication_default SET TABLE
  "dashboards","alert_rules","alert_rule_states","alert_incidents",
  "alert_destinations","api_keys","investigations";
SQL
```

On PlanetScale run the same SQL through `pscale shell <database> main` (as done for
`maple-eu` on 2026-09-23). `SET TABLE` replaces the membership in one statement. A table
it removes keeps FULL until you reset it with `REPLICA IDENTITY DEFAULT`.

**Nothing syncs but no error.** Check that `VITE_ELECTRIC_SYNC_URL` points at the
running `electric-sync` worker and that the docker `electric` service is up. It's
a build-time constant, so a Vite restart is needed after changing it.

## Production (PlanetScale + self-hosted Electric on ECS)

Electric Cloud is gone. `apps/electric` runs the upstream `electricsql/electric`
image on ECS Fargate at `electric.maple.dev` (`electric.eu.maple.dev` for EU), with
its own cluster, ALB, security groups and certificate **inside the ingest fleet's
VPC**. The shared VPC is forced, not an economy. Two `AWS.EC2.Network`s in one
alchemy stack fight over the internet gateway: under `--adopt` the second one's
create resolves to the first's IGW and tries to detach it, which AWS refuses on a
VPC whose tasks hold public IPs (`DependencyViolation: … has some mapped public
address(es)`). Both services want the same network anyway: public subnets, public
IPs, no NAT. The root `alchemy.run.ts` therefore creates Electric only on stages
that also deploy ingest.
Nothing was migrated to get there. Postgres is the source of truth and Electric
is a cache over its logical replication stream.

**What guards it.** The service is public, because its only caller is a Worker at
the Cloudflare edge with no private route into a VPC. `ELECTRIC_SECRET` is the
control. Electric requires it on every shape request, and the sync worker
appends it as `?secret=`, as it did for Cloud's source secret. One secret covers
both ends of the hop. The task security group admits `ELECTRIC_PORT` only from
the ALB's group, so a task's public IP is not a way around TLS.

**It is a singleton.** Two Electrics cannot share a replication slot, so the
service runs `desiredCount: 1` with `minimumHealthyPercent: 0`: stop the old
task, then start the new one. Every deploy therefore has a ~60s window with no
sync. `/dashboards` degrades to its HTTP snapshot (`SyncDegradedBanner`), while
the alerts lists have no fallback and sit in their retry state. This is why the
image tag is pinned in `apps/electric/Dockerfile` rather than tracking `:latest`
as local docker does.

### Standing it up

1. **PlanetScale cluster params:** `wal_level=logical`, `max_replication_slots>=10`,
   `max_wal_senders>=10`, `max_slot_wal_keep_size>=4096`, `sync_replication_slots=on`,
   `hot_standby_feedback=on`. Already set for Cloud; unchanged.
2. **The role is declared:** `Planetscale.PostgresRole("electric-db-role", { withReplication: true,
inheritedRoles: ["postgres"] })` in `alchemy.run.ts`. The `REPLICATION` _attribute_ is never
   inherited through role membership. Electric's database validation rejects a role without it
   with a message that does not say so, and PlanetScale issues it only alongside `postgres`.
   Its DIRECT 5432 URL is the task's `DATABASE_URL`. Logical replication cannot run through
   PSBouncer or Hyperdrive, and the URL is rewritten to `sslmode=require` (`pgUrlRequireSsl`)
   because Electric refuses `verify-full`.
3. **Env:** `ELECTRIC_SECRET`. Both secrets (`DATABASE_URL`, `ELECTRIC_SECRET`) reach the task
   through Secrets Manager, never the task definition's plaintext `env`. The role id sits in
   `env` (`MAPLE_PG_ROLE_ID`) so a replaced role restarts the singleton on the new secret before
   alchemy deletes the old one.
4. **Migrate,** then `alchemy deploy`. No new migration is needed: the service
   reads the publication the migrations maintain, and `electric_publication_reconcile`
   makes a fresh database's membership exact even if the publication already exists.
5. **DNS.** The stack publishes the ACM validation CNAME into the `maple.dev`
   zone and waits for the certificate to reach `ISSUED` before attaching the 443
   listener (`@maple/infra/acm`), so the first deploy needs no second pass. The
   one manual record is a **proxied CNAME for `electric.maple.dev` at the ALB**.
   The deploy output carries the hostname.
6. **Verify** before pointing anything at it:
   `curl https://electric.maple.dev/v1/health`, then a shape through the proxy:
   `curl -g 'https://sync.maple.dev/api/sync/shape?shape=dashboards&offset=-1' -H "authorization: Bearer <token>"`.
7. **Cut over:** set `ELECTRIC_URL=https://electric.maple.dev` and clear
   `ELECTRIC_SOURCE_ID`, then redeploy the sync worker. This is done. While Cloud
   still existed, reverting was the same env change backwards; with Cloud gone there
   is nothing to revert to.

### The publication

`ELECTRIC_MANUAL_TABLE_PUBLISHING=true`, and `ELECTRIC_REPLICATION_STREAM_ID` is
left at Electric's `default`. Electric therefore reads `electric_publication_default`,
the migration-owned publication, and opens `electric_slot_default` for itself.

Electric Cloud never used that pair. It created its own generated
`cloud_electric_pub_*` / `cloud_electric_slot_*`. That is why the self-hosted
service could run beside Cloud on the same database with no collision during the
cutover.

## PR previews (no Electric source; dormant since 2026-08, now also Cloud-less)

**PR previews no longer have an Electric source.** They stopped provisioning a
PlanetScale branch (see `resolveDatabaseMode` in
`packages/infra/src/cloudflare/stage.ts`), and with no Postgres to replicate from
there is nothing for Electric to point at. `apps/electric-sync/src/worker.ts`
therefore withholds `ELECTRIC_URL`/`ELECTRIC_SOURCE_ID`/`ELECTRIC_SECRET` on the
`pr` stage. This is deliberate: a preview can never inherit the shared `dev`
credentials and proxy its shapes at another stage's data. The sync worker deploys
unconfigured and returns 503, so `/dashboards` falls back to its HTTP snapshot and
the alerts lists show `SyncUnavailable`.

Every path of `scripts/electric-pr-branch.ts` is now dead, not just `up`. The
workflows still call `down` (on PR close) and `sweep` (from
`cleanup-preview-orphans.yml`), but Electric Cloud is gone, so there are no
environments left to reap. What follows is kept as the record of what previews used
to do. Restoring live sync in a preview means pointing it at a self-hosted Electric,
not at Cloud.

The former lifecycle: an ephemeral Electric Cloud **environment** `pr-<n>` + a
Postgres **source** per PR, mirroring the PlanetScale/Tinybird branch lifecycle.
`scripts/electric-pr-branch.ts` (`up`/`down <pr-number>`, driven from
`.github/workflows/deploy-pr-preview.yml`) used `@electric-sql/cli`
(`ELECTRIC_API_TOKEN` auth). On open/synchronize it reused (or created under
`ELECTRIC_PROJECT_ID`) the `pr-<n>` environment, reset its services, and created a
fresh `postgres` source pointed at the PR branch's `MAPLE_PG_ELECTRIC_URL`. That URL
was direct 5432 through a dedicated `--with-replication` role: Electric requires
the REPLICATION role _attribute_, which is never inherited, and the main CI role
stays non-replication because PlanetScale replication roles aren't grantable, which
would break the in-place reset's role assumption. The script polled the source until
active and exported `ELECTRIC_URL`/`ELECTRIC_SOURCE_ID`/`ELECTRIC_SECRET` to
`$GITHUB_ENV`, where alchemy bound them to the electric-sync worker. On close it
deleted the environment (cascading the source). Steps were gated on
`ELECTRIC_API_TOKEN`, so previews stayed green (and the worker 503'd) until the token
landed in Infisical.

- The web build always reads through the sync path. Provisioning a source is what
  would make live sync work in previews again.
- **Publication:** the migrate step ran `0009` (creates
  `electric_publication_default`) before the source was created. The script passed
  `--manual-table-publishing` by default (prod parity: Electric reads that
  migration-owned publication, its default name, instead of owning the tables).
  `ELECTRIC_MANUAL_TABLE_PUBLISHING=false` let Electric auto-manage publishing
  instead; `ELECTRIC_SERVICE_EXTRA_ARGS` was the flag escape hatch.
  The script pins `@electric-sql/cli@0.0.10` (interface verified: `--json` is a
  global flag, `environments create` returns `environmentId`, the postgres service
  id is the shape-API `source_id`). Re-verify before bumping the pin.
- **Caps:** each source counted against the Electric plan's max-databases limit and
  held a PlanetScale replication slot, so teardown on close was mandatory.

## Adding a synced table later

1. New Drizzle migration (`db:generate --custom`) that adds the table with
   `ALTER TABLE "<t>" REPLICA IDENTITY FULL` and `ALTER PUBLICATION
electric_publication_default ADD TABLE "<t>"`, each behind a catalog check
   (`pg_class.relreplident`, `pg_publication_tables`) as in
   `electric_publication_reconcile`. **No `EXCEPTION` handler.** PGlite (0.5+) runs
   `CREATE/ALTER PUBLICATION` and `pg_publication_tables`, so the guard the early
   migrations carry protects nothing, and it is exactly what hid the EU failure.
2. Add the shape to the whitelist in `apps/electric-sync/src/shapes/registry.ts`.
3. Add a collection under `apps/web/src/lib/collections/` via
   `createEffectCollection`. Model it on `dashboards.ts` for a write vertical or
   `alerts.ts` for a read-only one: an identity `Schema.Struct` row schema that
   mirrors the table columns, plus a `timestamptz` parser normalizing to ISO.
   Register it in `org-collections.ts` (constructor + `cleanup()`), and point the
   consumer read at the collection.
4. Update `SYNCED_TABLES` in `packages/db/src/migrations.test.ts`.

### `REPLICA IDENTITY FULL` is not optional, and it is the main egress cost

Electric **refuses to serve a shape** over a table whose replica identity is not
`FULL`, answering every request for it with:

```
{"message":"Database table \"public.<t>\" does not have its replica identity set to FULL"}
```

This was checked empirically against `electricsql/electric:latest`, and it is
unconditional. It holds with and without a `where`, with and without a `columns`
projection, and with `(org_id, id)` present via `REPLICA IDENTITY USING INDEX`.

So `0009`'s stated rationale is wrong in its details (`DEFAULT` keys deletes on the
primary key perfectly well, composite or not) but binding in its conclusion. Its other
claim has _not_ held up: "these are low-write control-plane tables, so the extra WAL
volume is negligible." `FULL` writes the entire old row into the WAL on top of the new
one. Electric consumes the slot over a direct connection, so every one of those bytes
is billed PlanetScale egress.

Because the per-write multiplier is not negotiable, **the only lever on a synced table
is its write rate.** Before adding a hot writer to one, gate it:

- the alerting scheduler's per-minute claim lock lives in the _unpublished_
  `alert_rule_claims` table (`0027`), not in `alert_rules`;
- `alert_rules.last_scheduled_at` is refreshed on a 5-minute heartbeat, SQL-gated so
  the off-beat ticks are zero-row updates that write no WAL tuple at all;
- `api_keys.last_used_at` is gated the same way in `ApiKeysService`, so an
  authenticated request no longer writes on the hot path;
- `alert_rule_states` has had `STATE_HEARTBEAT_MS` for the same reason.

Do not try to reclaim this by relaxing the replica identity. Electric will reject the
shape and the synced lists will fail to load outright.

## Removing a synced table

Reverse order, and do all of it. A half-removal is what left four dead tables on
the slot. Drop the consumer + collection, drop the shape from the whitelist, then
write a migration that drops the table from the publication **and** resets
`REPLICA IDENTITY DEFAULT` (FULL costs full-old-row WAL on every UPDATE/DELETE
whether or not the table is published). Move the table from `SYNCED_TABLES` to
`UNSYNCED_TABLES` in `migrations.test.ts`. See `0022_electric_publication_prune`.

## Status / remaining work

**Done and verified**

- Infra: docker `electric` + `wal_level=logical`; `0009_electric_publication`
  (applies via both `drizzle-kit migrate` and the PGlite test path; see
  `packages/db/src/migrations.test.ts`), with later publication migrations for
  wave-1 control-plane tables, `api_keys` and `investigations`.
- Shape proxy with org-scoping + client-param pinning, extracted into the
  standalone `apps/electric-sync` worker. The security-critical pinning is
  unit-tested in `src/shapes/registry.test.ts`, `src/shapes/request.test.ts` and
  `src/routes/shape.http.test.ts`.
- txid capture: dashboards (all writes), alert rules (create/update/delete), alert
  destinations, API keys, and error issues `heartbeat`/`assign`/`setSeverity`.
- **`@maple/effect-db`** package (typecheck-clean) + **dashboards** collection
  refactored onto `createEffectCollection` + the `useDashboardStore` collection
  path, with writes migrated to `/v2/dashboards` and reconciled by returned txid;
  proven against a live Electric 1.6.2 instance locally.
- **Alerts read consumers (Phase 6):** `collections/alerts.ts` (read-only
  collections; client-side live-query join `alert_rules ⟕ alert_rule_states`).
  The `useAlertRulesList` / `useAlertIncidentsList` / `useAlertDestinationsList`
  hooks read from the collections. Writes stay on the typed endpoints, and the shape
  stream delivers results. The row→document mappers mirror the server's
  `rowToRuleDocument`/`rowToDestinationDocument` and are unit-tested
  (`collections/alerts.test.ts`). The parallel **errors** vertical
  (`collections/errors.ts`, `error_issues ⟕ actors ⟕ open_error_incidents`) was
  built and then reverted to the typed `/v2` reads; its tables were pruned from
  the publication by `0022`.
- **API keys:** `collections/api-keys.ts` behind a column-restricted shape.
- **Investigations:** `collections/investigations.ts` behind the id-scoped
  `investigation_v2` shape.
- **Self-heal:** a `collection:schema-error` listener in `org-collections.ts`
  recreates the org's collections (generation bump), so a post-deploy shape-schema
  drift re-fetches instead of getting stuck.

**Remaining (follow-ups)**

- **Live smoke of alerts:** the mappers/joins/timestamps typecheck and unit-test
  green, but the end-to-end sync for this vertical still needs the docker-Electric
  smoke: verify each list streams in scoped to the org and updates live after a
  write. Dashboards already passed the same validation.
- **Row-volume check** before enabling any further list sync: confirm the per-org
  row counts are bounded. If not, add an archival tick or keep terminal-state tabs
  on paged effect-atom reads.
