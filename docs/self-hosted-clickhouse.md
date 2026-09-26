# Self-hosted Maple on plain ClickHouse

Self-managed Maple can run on a vanilla ClickHouse instance, with no Tinybird Cloud and no Tinybird-Local. The query engine (`@maple/query-engine`) emits standard ClickHouse SQL, and the schema is generated from the same TypeScript source the Tinybird path uses.

## Scope

This doc covers two pieces:

1. **Schema setup:** generating and applying the ClickHouse DDL on a vanilla server.
2. **Runtime configuration:** pointing the Maple API at ClickHouse instead of Tinybird.

Ingest is still bring-your-own. See [Ingest options](#ingest-options) below.

## Required ClickHouse version

Tested on ClickHouse 24.8+. Earlier versions may work but aren't validated. The local dev stack and CI's ClickHouse e2e jobs run 26.2.

## How runtime config works

Self-managed Maple is a **per-org BYO** feature. Each org configures its own ClickHouse under Settings → "Bring your own ClickHouse". The credentials live in the `org_clickhouse_settings` Postgres table (`packages/db/src/schema/org-clickhouse-settings.ts`), with the password encrypted at rest with `MAPLE_INGEST_KEY_ENCRYPTION_KEY`. There is no sync workflow: the schema lives in the org's ClickHouse instance and is applied from the settings page or the CLI below.

Orgs without a BYO row use the deployment's managed warehouse. API query routing needs no new env vars for BYO ClickHouse. Postgres-backed direct ingest does need `MAPLE_INGEST_KEY_ENCRYPTION_KEY` so the ingest gateway can decrypt stored ClickHouse passwords.

The managed warehouse is Tinybird (`TINYBIRD_HOST` / `TINYBIRD_TOKEN`) unless env-level `CLICKHOUSE_URL` is set. `CLICKHOUSE_PROVIDER` defaults to `tinybird`, so a set `CLICKHOUSE_URL` is treated as Tinybird's ClickHouse-compatible gateway: raw SQL substitutes a per-org JWT and removes Tinybird-restricted query settings. For a vanilla/self-managed server, set `CLICKHOUSE_PROVIDER=clickhouse`; Maple then keeps `CLICKHOUSE_PASSWORD` for raw SQL. Tinybird raw SQL also requires explicit `TINYBIRD_SIGNING_KEY` and `TINYBIRD_WORKSPACE_ID` values. Maple never derives either from the API token. Set `TINYBIRD_RAW_SQL_JWT_RPS_LIMIT` to a positive integer to add an optional Tinybird-enforced request ceiling; Maple gives each org an independent bucket.

Env-level vanilla ClickHouse raw SQL is enabled only when `MAPLE_AUTH_MODE=self_hosted` (the default), where the deployment is single-org. Hosted multi-org deployments fail closed unless they use Tinybird's scoped JWT path or per-org BYO credentials.

For user-authored SQL, configure the runtime ClickHouse account as SELECT-only on the Maple database. Apply schema migrations with a separate administrative account, and enforce server-side limits such as maximum execution time, memory, rows, and bytes read. Maple's client-side caps are a final response boundary. They do not replace a least-privilege role and server-side resource controls. See [ClickHouse's guidance for agent-authored queries](https://clickhouse.com/blog/how-to-set-up-clickhouse-for-agentic-analytics) for the corresponding database-side setup.

### Routing precedence

For any given query the API resolves the upstream in this order:

1. **Per-org BYO row:** if `org_clickhouse_settings` has an active row for the requesting org, the row's credentials drive the connection.
2. **Managed warehouse:** otherwise, `CLICKHOUSE_URL` if set, else `TINYBIRD_HOST` + `TINYBIRD_TOKEN`.

### Configuring BYO ClickHouse via the UI

Settings → "Bring your own ClickHouse" exposes:

- **ClickHouse URL:** the HTTP interface (e.g. `https://your-clickhouse.example.com:8123`).
- **User:** defaults to `default`. Applying the schema from the UI needs DDL privileges (CREATE TABLE / CREATE MATERIALIZED VIEW).
- **Database:** defaults to `default`.
- **Password:** optional; encrypted at rest. Leave it blank to keep the stored password when re-saving. Changing the URL, user or database requires re-entering it.

On save, the API validates the connection with `SELECT 1` and persists the row. Save runs no DDL. The Schema card then shows a diff against the bundled schema, and **Apply schema** runs the migrations.

## Applying the schema

There are two ways to apply the schema. Both run the **same migrations** from `@maple/domain/clickhouse` and use the **same** [`qualifyStatementForDatabase`](../packages/domain/src/clickhouse/qualify.ts) helper, so they're interchangeable.

### Via the Maple UI (default)

Settings → "Bring your own ClickHouse" → Schema → **Apply schema**. The API starts a background workflow (`apps/api/src/workflows/ClickHouseSchemaApplyWorkflow.ts`), because backfill migrations can outlast one request. The page polls its progress. The workflow:

1. Creates `_maple_schema_migrations` (the bookkeeping table) if missing.
2. Applies any unapplied migrations in version order.
3. Records each applied migration's `(version, applied_at, description)`.
4. Stamps `schema_version` in `org_clickhouse_settings` (see readiness below).

If the connection fails or the user lacks DDL privileges, the apply fails and the settings row shows the error.

Re-applying is safe. Already-applied migrations are skipped, and every statement uses `IF NOT EXISTS` as a second line of defense. Future schema upgrades land the same way: pull a new Maple API release, then apply again to pick up new migrations.

### Via the standalone CLI

For airgapped clusters, CI checks, or when your ClickHouse credentials shouldn't pass through Maple's API:

```bash
bunx @maple/clickhouse-cli@latest apply \
  --url=https://your-ch.example.com \
  --user=maple --password=$CH_PASSWORD \
  --database=default

# What's applied + what's pending
bunx @maple/clickhouse-cli@latest status

# Print DDL that would run, no execution
bunx @maple/clickhouse-cli@latest dry-run
```

Connection flags fall back to the `MAPLE_CH_URL`, `MAPLE_CH_USER`, `MAPLE_CH_PASSWORD` and `MAPLE_CH_DATABASE` env vars, which is handy in CI. See [`packages/clickhouse-cli/README.md`](../packages/clickhouse-cli/README.md).

To inspect applied migrations directly on your ClickHouse server:

```sql
SELECT version, applied_at, description FROM _maple_schema_migrations ORDER BY version;
```

## What gets created

On a clean install, migration 0001 creates **40 tables** (datasources) and **42 materialized views**.
Migration 0001 re-exports the _generated_ snapshot (`packages/domain/src/generated/clickhouse-schema.ts`), so these counts track
`datasources.ts` / `materializations.ts`. Regenerate with `bun run clickhouse:schema`
and `bun run tinybird:manifest` after editing either, or CI's drift gate fails.

- **Tables with no MV feeding them** (13): `alert_checks`, `audit_log`, `logs`,
  `metrics_exponential_histogram`, `metrics_gauge`, `metrics_histogram`, `metrics_sum`,
  `service_address_resolutions_hourly`, `service_map_edges_hourly_ingest` (a `Null`-engine
  bridge), `session_events`, `session_replay_events`, `session_replays`, `traces`
- **MV-populated tables** (27): `ai_trace_index`, `attribute_keys_hourly`,
  `attribute_values_hourly`, `error_events`, `error_events_by_time`,
  `error_fingerprints_minutely`, `identity_links`, `logs_aggregates_hourly`, `metric_catalog`,
  `product_events` (also written directly by `POST /v1/events`),
  `service_external_edges_hourly`, `service_map_children`, `service_map_db_edges_hourly`,
  `service_map_db_query_shapes_hourly`, `service_map_edges_hourly`, `service_map_spans`,
  `service_operations_hourly`, `service_operations_minutely`, `service_overview_hourly`,
  `service_overview_minutely`, `service_overview_spans`, `service_platforms_hourly`,
  `service_usage`, `span_metrics_calls_hourly`, `trace_detail_spans`, `trace_list_mv`,
  `traces_aggregates_hourly`
- **Materialized views** (42): fan out from the source tables to populate the
  MV-populated tables. Several targets are fed by more than one MV: `service_usage` by
  six, `attribute_values_hourly` / `attribute_keys_hourly` / `metric_catalog` by four each,
  and `product_events` by two.

See [`warehouse-rollups.md`](warehouse-rollups.md) for when a materialized view is the
right answer and which tier a query should read.

Every stored table is partitioned by date and carries a TTL, tiered by how raw the data is:

| Retention     | Tables                                                                                                                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **30 days**   | `traces`, `trace_detail_spans`, `logs`, `service_map_spans`, `service_map_children`, `service_overview_spans`, `trace_list_mv`, `ai_trace_index`, `session_events`, `session_replay_events`, `session_replays` |
| **90 days**   | `error_events`, `error_events_by_time`, `error_fingerprints_minutely`, `metrics_*`, `attribute_*_hourly`, `metric_catalog`, `*_minutely` rollups, `span_metrics_calls_hourly`                                |
| **365 days**  | the other hourly rollups (`*_hourly`), `service_usage`, `alert_checks`, `product_events`, `identity_links`                                                                                                 |
| **2190 days** | `audit_log`                                                                                                                                                                                               |

Adjust by writing a follow-up migration if your retention requirements differ.

> **Changing a TTL requires an `ALTER`, not just a datasource edit.** Migration 0001 re-exports the generated snapshot, and every statement in it is `CREATE TABLE IF NOT EXISTS`. On a cluster whose tables already exist, re-running it is a no-op and the old TTL survives. Editing `datasources.ts` alone therefore changes **new installs only**. Ship a paired `ALTER TABLE … MODIFY TTL` delta (see `0009_one_year_service_history.ts`) or existing clusters silently keep the previous retention. This exact gap let a production cluster accumulate 3× its intended trace volume until the disk filled.
>
> When lowering a TTL, set `ttl_only_drop_parts = 1` **first**. These tables partition on the same expression their TTL keys off, so expired parts are always wholly expired. The setting turns eviction into a whole-partition drop instead of a multi-TiB part rewrite.

## Ingest options

The maintained standalone path is **Option A: Maple's prebuilt OTel Collector image** (`mapleexporter` baked in). Hosted and self-hosted Maple deployments can also use the Rust ingest gateway's direct ClickHouse path once an org is marked ready. Three escape hatches stay supported for advanced setups.

### Maple ingest gateway direct ClickHouse path

The Rust ingest gateway routes an org's accepted native-ingest frames directly to that org's ClickHouse HTTP endpoint when its `org_clickhouse_settings` row has `sync_status = 'connected'` and a `schema_version` equal to the bundled `clickHouseSchemaVersion`. That value is the latest **ingest-required** ClickHouse migration version, emitted into the gateway as `SCHEMA_VERSION` by `scripts/generate-clickhouse-insert-mappings.ts`. Non-ready orgs continue using the managed Tinybird path. Performance-only migrations set `requiredForIngest: false`, so an index rollout cannot un-ready an otherwise compatible org. Readiness also does **not** use the Tinybird-coupled `clickHouseProjectRevision`, so Tinybird-only changes cannot alter BYO-ClickHouse routing.

Postgres-backed ingest deployments must set `MAPLE_INGEST_KEY_ENCRYPTION_KEY` before rolling out this mode. The gateway exits at startup without it, because ClickHouse passwords are encrypted at rest with the same AES-256-GCM key format as private ingest keys.

Operational caveats:

- **Readiness keys on the latest ingest-required migration, which only the API marks.** The `schema_version` stored in Postgres is set to `clickHouseSchemaVersion` **only** by the API's apply workflow (or by the `schemaDiff` self-heal, below). A credential re-save _preserves_ the prior value. The standalone `clickhouse-cli` writes `_maple_schema_migrations` **on your ClickHouse server but never touches Maple's application database**. So an org whose schema was applied entirely via the CLI stays `schema_version`-stale, and the gateway keeps routing to Tinybird even though the cluster is fully migrated. Symptom: the dashboard (which reads ClickHouse whenever a settings row exists) shows collector-written data, but data sent through the public ingestor is invisible because it landed in Tinybird.
- **Self-heal:** calling `schemaDiff` (opening the settings page, or `GET /api/org-clickhouse-settings/schema-diff`) re-stamps `schema_version` to `clickHouseSchemaVersion` whenever the live schema is fully in sync (every diff entry `up_to_date`). This is the supported way to mark a CLI-applied org ready without forcing an Apply that has nothing to migrate. The read path also annotates a `clickhouse.schemaDrift` span attribute (`OrgClickHouseSettingsService.resolveRuntimeConfig`). Alert on it to catch stale orgs.
- ClickHouse-routed frames never fall back to Tinybird. After the configured export retry budget is exhausted, the batch is dropped, the WAL cursor advances, and `ingest_clickhouse_export_dropped_total` records the datasource and final drop reason. Alert on any non-zero increase in that counter.
- Password-authenticated ClickHouse endpoints must use `https://`. The gateway drops passworded `http://` targets before attaching `X-ClickHouse-Key`.
- Direct ClickHouse routing writes WAL v3 frames. Do not roll back to a pre-direct-ClickHouse ingest binary while v3 frames may remain in the queue. Drain the WAL first, or accept that clearing the queue directory is a data-loss recovery step.

### Option A: Maple OTel Collector (recommended)

A custom build of `otelcol-contrib` with the `mapleexporter` baked in. The exporter writes JSON-each-row directly into Maple's `traces` / `logs` / `metrics_*` tables, with no shim.

- **Image:** `ghcr.io/mapletechlabs/maple/otel-collector-maple` (multi-arch: amd64 + arm64). Pin a tag (e.g. `0.2.0`); see [the package page](https://github.com/orgs/MapleTechLabs/packages/container/package/maple%2Fotel-collector-maple) for available versions.
- **Source:** [`packages/otel-collector-maple-exporter/`](../packages/otel-collector-maple-exporter/). Builder config in [`deploy/k8s-infra/builder-config.yaml`](../deploy/k8s-infra/builder-config.yaml), Dockerfile in [`deploy/k8s-infra/Dockerfile.otel-collector-maple`](../deploy/k8s-infra/Dockerfile.otel-collector-maple).

#### Step 1: apply the schema

Use the standalone CLI. It needs no Maple API, and your ClickHouse credentials never leave the machine running it:

```bash
bunx @maple/clickhouse-cli@latest apply \
  --url=https://your-ch.example.com \
  --user=maple --password=$CH_PASSWORD \
  --database=default
```

Or save credentials in the Maple UI under Settings → "Bring your own ClickHouse" and click **Apply schema**; the API runs the same migrations on your behalf.

#### Step 2: deploy the collector

**Kubernetes:** install the [`maple-otel`](../deploy/maple-otel/) Helm chart:

```bash
helm install maple-otel oci://ghcr.io/mapletechlabs/charts/maple-otel \
  --namespace maple --create-namespace \
  --set maple.orgId=org_xxx \
  --set maple.clickhouse.endpoint=https://your-ch.example.com \
  --set maple.clickhouse.password.value=$CH_PASSWORD
```

Apps then point `OTEL_EXPORTER_OTLP_ENDPOINT` at `http://maple-otel.maple.svc.cluster.local:4318`.

**Anywhere else (Docker / VM / ECS / Nomad / …):** download a pre-rendered config from Maple:

1. `GET /api/org-clickhouse-settings/collector-config` (there is no download button in the settings UI).
2. Drop the YAML next to a copy of the image and run:

    ```bash
    docker run \
      -e MAPLE_CLICKHOUSE_PASSWORD=$CH_PASSWORD \
      -v ./collector.yaml:/etc/otel/config.yaml \
      -p 4317:4317 -p 4318:4318 \
      ghcr.io/mapletechlabs/maple/otel-collector-maple:0.2.0
    ```

The rendered YAML carries your `org_id`, ClickHouse URL/user/database, and the standard memory_limiter → k8sattributes → batch → maple pipeline. The password is referenced via `${env:MAPLE_CLICKHOUSE_PASSWORD}`, so the file is safe to share.

#### Org id resolution

The `mapleexporter` stamps `OrgId` from its own `org_id` config on every record, so the typical single-tenant deploy needs no upstream `resource/maple_org` processor. For multi-tenant fan-out (one collector serving several Maple orgs), set `org_id_from_resource_attribute: maple_org_id` on the exporter and stamp the right id per record upstream. See [`packages/otel-collector-maple-exporter/README.md`](../packages/otel-collector-maple-exporter/README.md).

### Option B: Tinybird exporter + a shim service

The original "drop-in for Tinybird Cloud users" path. Run otelcol-contrib's `tinybird` exporter and point it at a small shim that:

- Accepts `POST /v0/events?name=<datasource>` with NDJSON bodies.
- Applies the JSONPath mappings from `packages/domain/src/tinybird/datasources.ts` to project each row into the right column shape.
- Issues `INSERT INTO <datasource> FORMAT JSONEachRow` against ClickHouse.

The shim is not in this repo; operators write or fork their own. The JSONPath spec required to drive it is exposed via `emitJsonPathSpec()` in `@maple/domain/clickhouse`.

### Option C: Tinybird-Local

[tinybird-local](https://github.com/tinybirdco/tinybird-local) is a single-binary, Tinybird-API-compatible local server backed by ClickHouse. The Tinybird exporter works against it unchanged. It is heavier than Option A, but useful when you want Tinybird's UI side by side.

### Option D: Direct INSERTs from your application

If you have a small, well-defined ingest path (e.g. you control the SDK that emits to Maple), you can `INSERT INTO traces FORMAT JSONEachRow` directly. The JSONPath spec defines the row shape. Each row should look like the Tinybird exporter's output; see the `$.…` paths in `datasources.ts`.

### Comparing the options

|                                        | Option A (Maple OTel Collector)         | Option B (shim)   | Option C (Tinybird-Local) | Option D (direct INSERTs) |
| -------------------------------------- | --------------------------------------- | ----------------- | ------------------------- | ------------------------- |
| Setup steps                            | 2 (schema + collector)                  | Many (write shim) | 2                         | Application-specific      |
| Pre-built image                        | ✅                                      | none              | ✅ (Tinybird's)           | none                      |
| Multi-tenant fan-out                   | ✅ via `org_id_from_resource_attribute` | manual            | manual                    | application               |
| k8s pod metadata enrichment            | ✅ baked into the image                 | manual            | manual                    | manual                    |
| Standard OTel collector pipeline shape | ✅                                      | partial           | partial                   | n/a                       |

## Schema source of truth

Schema lives in `packages/domain/src/tinybird/datasources.ts` and `materializations.ts`. These TypeScript files are consumed by **two** emitters:

- The Tinybird manifest emitter produces `.datasource` / `.pipe` files for Tinybird Cloud.
- The ClickHouse DDL emitter (`packages/domain/src/clickhouse/ddl-emitter.ts`) produces `CREATE TABLE` / `CREATE MATERIALIZED VIEW` statements.

To regenerate the ClickHouse schema after a TS change:

```bash
bun run clickhouse:schema
```

CI checks that it stays in sync via `bun run clickhouse:schema:check`.

## Extending the schema

To add a new column, table, or materialized view:

1. Edit `packages/domain/src/tinybird/datasources.ts` or `materializations.ts`.
2. Run `bun run clickhouse:schema` to regenerate the snapshot.
3. Create a new file `packages/domain/src/clickhouse/migrations/00NN_<descriptive_name>.ts`, using the next free version number:

    ```typescript
    export const migration_0002_add_foo_column = {
    	version: 2,
    	description: "Add Foo column to traces",
    	statements: [
    		"ALTER TABLE traces ADD COLUMN IF NOT EXISTS Foo String DEFAULT ''",
    		// For columns with non-trivial DEFAULT expressions that need backfilling:
    		"ALTER TABLE traces MATERIALIZE COLUMN Foo",
    	],
    } as const
    ```

    Set `requiredForIngest: false` on a performance-only migration (an index, a projection) so it does not un-ready BYO orgs for ingest.

4. Append it to the `migrations` array in `packages/domain/src/clickhouse/migrations/index.ts`.

The next Apply (UI or `clickhouse-cli apply`) picks it up and runs only the new migration.

### Replacing Tinybird's `forwardQuery`

A handful of datasources use Tinybird's `forwardQuery` block to backfill computed columns when the schema evolves (e.g. `traces.SampleRate`, `traces.IsEntryPoint`). For self-hosted ClickHouse, the equivalent pattern is paired statements:

```sql
ALTER TABLE traces ADD COLUMN IF NOT EXISTS NewCol Type DEFAULT <expr>;
ALTER TABLE traces MATERIALIZE COLUMN NewCol;
```

`MATERIALIZE COLUMN` runs as a background mutation and populates existing rows using the `DEFAULT` expression. For per-row, idempotent expressions (the only kind currently in use) this is functionally equivalent to Tinybird's `forwardQuery`.

## Migrating from Tinybird-Local

A clean break is recommended. Raw telemetry keeps 30 or 90 days, so most operators can:

1. Stop the ingest path.
2. Bring up the new vanilla-ClickHouse stack and apply the schema.
3. Resume ingest. Old raw data ages out within 90 days; the 365-day rollups start empty.

If you need historical data preserved, Tinybird-Local exposes its underlying ClickHouse on port 7181, so a one-shot `INSERT INTO new.<table> SELECT * FROM tinybird_local.<table>` over `remote()` is feasible. This isn't shipped as tooling.

## Troubleshooting

- **"ClickHouse rejected credentials"**: the user/password combo doesn't authenticate. Maple maps ClickHouse 401/403 responses to this error.
- **"ClickHouse rejected statement"** (during apply): the configured user authenticates but lacks DDL privileges, or a migration hit a version-specific syntax issue. Check `system.query_log` on your ClickHouse server for the failing statement.
- **"Could not reach ClickHouse"**: the API can't make an HTTP request to the URL. This is network, DNS or firewall; verify the API can reach the URL.
- **Migration appears to hang on `MATERIALIZE COLUMN`**: this is a background mutation. Watch `system.mutations` to see progress.
- **`clickhouse:schema:check` fails in CI but the diff looks empty**: someone changed `datasources.ts` without running `bun run clickhouse:schema`. Run it locally and commit the regenerated file.
