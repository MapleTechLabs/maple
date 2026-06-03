import { createClient as createClickHouseClient } from "@clickhouse/client-web"
import { Tinybird } from "@tinybirdco/sdk"
import { Clock, Context, Effect, Layer, Option, Redacted } from "effect"
import type { WarehouseQueryRequest } from "@maple/domain/http"
import {
	makeWarehouseExecutor,
	toWarehouseQueryError,
	type ResolvedWarehouseConfig,
	type SqlQueryOptions,
	type WarehouseExecutorDeps,
	type WarehouseQueryServiceShape,
	type WarehouseSqlClient,
	type WarehouseSqlError,
} from "@maple/query-engine/execution"
import { WarehouseExecutor } from "@maple/query-engine/observability"
import { Env } from "./Env"
import type { TenantContext } from "../services/AuthService"
import { OrgClickHouseSettingsService } from "../services/OrgClickHouseSettingsService"

// ---------------------------------------------------------------------------
// WarehouseQueryService — the API's managed-warehouse executor.
//
// The execution logic (SQL run, retry, error mapping, client cache, OrgId
// scoping, span instrumentation) lives in `@maple/query-engine/execution`. This
// file is the host-app wiring: it constructs the actual ClickHouse / Tinybird
// drivers (the ONLY place `@clickhouse/client-web` + `@tinybirdco/sdk` are
// used) and resolves the per-org upstream config from the DB + env, injecting
// both into `makeWarehouseExecutor`.
// ---------------------------------------------------------------------------

// Re-export the executor types so existing import sites stay stable.
export type { WarehouseQueryServiceShape, SqlQueryOptions, WarehouseSqlError }

type ClickHouseConfig = Extract<ResolvedWarehouseConfig, { _tag: "clickhouse" }>
type TinybirdConfig = Extract<ResolvedWarehouseConfig, { _tag: "tinybird" }>

const createClickHouseSqlClient = (config: ClickHouseConfig): WarehouseSqlClient => {
	const client = createClickHouseClient({
		url: config.url,
		username: config.username,
		password: config.password,
		database: config.database,
	})
	return {
		sql: async (sql: string) => {
			const resultSet = await client.query({
				query: sql,
				format: "JSONEachRow",
			})
			const data = await resultSet.json<Record<string, unknown>>()
			return { data }
		},
		insert: async (datasource, rows) => {
			await client.insert({ table: datasource, values: rows, format: "JSONEachRow" })
		},
	}
}

const createTinybirdSdkSqlClient = (config: TinybirdConfig): WarehouseSqlClient => {
	const client = new Tinybird({
		baseUrl: config.host,
		token: config.token,
		datasources: {},
		pipes: {},
		devMode: false,
	})
	return {
		sql: async (sql: string) => client.sql(sql),
		insert: async (datasource, rows) => {
			if (rows.length === 0) return
			const ndjson = rows.map((row) => JSON.stringify(row)).join("\n")
			const url = `${config.host.replace(/\/$/, "")}/v0/events?name=${encodeURIComponent(datasource)}&wait=false`
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-ndjson",
					Authorization: `Bearer ${config.token}`,
				},
				body: ndjson,
			})
			if (!response.ok) {
				const body = await response.text().catch(() => "")
				throw new Error(`HTTP ${response.status} ${response.statusText}: ${body.slice(0, 500)}`)
			}
		},
	}
}

const createClient = (config: ResolvedWarehouseConfig): WarehouseSqlClient =>
	config._tag === "clickhouse" ? createClickHouseSqlClient(config) : createTinybirdSdkSqlClient(config)

let sqlClientFactory: typeof createClient = createClient

export class WarehouseQueryService extends Context.Service<
	WarehouseQueryService,
	WarehouseQueryServiceShape
>()("@maple/api/lib/WarehouseQueryService", {
	make: Effect.gen(function* () {
		const env = yield* Env
		const orgClickHouseSettings = yield* OrgClickHouseSettingsService

		/**
		 * Resolve the upstream config for this tenant's queries.
		 *
		 * Resolution order:
		 *   1. Per-org BYO ClickHouse row (`org_clickhouse_settings`)
		 *   2. Env-level managed ClickHouse (`CLICKHOUSE_URL` set)
		 *   3. Env-level managed Tinybird (`TINYBIRD_HOST` + `TINYBIRD_TOKEN`)
		 */
		const resolveConfig: WarehouseExecutorDeps["resolveConfig"] = Effect.fn(
			"WarehouseQueryService.resolveSqlConfig",
		)(function* (tenant, label) {
			const override = yield* orgClickHouseSettings
				.resolveRuntimeConfig(tenant.orgId)
				.pipe(Effect.mapError((error) => toWarehouseQueryError(label, error)))

			if (Option.isSome(override)) {
				yield* Effect.annotateCurrentSpan("clientSource", "org_override")
				yield* Effect.annotateCurrentSpan("db.client", "clickhouse")
				return {
					config: {
						_tag: "clickhouse" as const,
						url: override.value.url,
						username: override.value.user,
						password: override.value.password,
						database: override.value.database,
					},
					source: "org_override" as const,
				}
			}

			yield* Effect.annotateCurrentSpan("clientSource", "managed")
			if (Option.isSome(env.CLICKHOUSE_URL)) {
				yield* Effect.annotateCurrentSpan("db.client", "clickhouse")
				return {
					config: {
						_tag: "clickhouse" as const,
						url: env.CLICKHOUSE_URL.value,
						username: env.CLICKHOUSE_USER,
						password: Option.match(env.CLICKHOUSE_PASSWORD, {
							onNone: () => Redacted.value(env.TINYBIRD_TOKEN),
							onSome: Redacted.value,
						}),
						database: env.CLICKHOUSE_DATABASE,
					},
					source: "managed" as const,
				}
			}

			yield* Effect.annotateCurrentSpan("db.client", "tinybird-sdk")
			return {
				config: {
					_tag: "tinybird" as const,
					host: env.TINYBIRD_HOST,
					token: Redacted.value(env.TINYBIRD_TOKEN),
				},
				source: "managed" as const,
			}
		})

		return makeWarehouseExecutor({
			createClient: (config) => sqlClientFactory(config),
			resolveConfig,
		})
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)

	static readonly query = (
		tenant: TenantContext,
		payload: WarehouseQueryRequest,
		options?: SqlQueryOptions,
	) => this.use((service) => service.query(tenant, payload, options))

	static readonly ingest = <T>(tenant: TenantContext, datasource: string, rows: ReadonlyArray<T>) =>
		this.use((service) => service.ingest(tenant, datasource, rows))
}

/**
 * Layer that provides the package-level `WarehouseExecutor` for a tenant,
 * backed by `WarehouseQueryService`. The executor name is a public contract
 * from `@maple/query-engine`; only the wiring lives here.
 */
export const makeWarehouseExecutorFromTenant = (tenant: TenantContext) =>
	Layer.effect(
		WarehouseExecutor,
		Effect.map(WarehouseQueryService, (warehouse) => warehouse.asExecutor(tenant)),
	)

export const __testables = {
	setClientFactory: (factory: typeof createClient) => {
		sqlClientFactory = factory
	},
	reset: () => {
		sqlClientFactory = createClient
	},
}
