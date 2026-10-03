import { Effect, Schema } from "effect"
import { DbQueryVolumeOutput } from "@maple/domain/mcp-outputs"
import { CH } from "@maple/query-engine"
import { WarehouseExecutor } from "@maple/query-engine/observability"
import type { McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { withTenantExecutor, CurrentMcpTenant } from "../lib/query-warehouse"
import { MCP_DISCOVERY_MAX_HOURS } from "../lib/time"
import { formatDurationFromMs, formatNumber, formatPercent, truncate } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const TOOL = "db_query_volume"
const WINDOW = P.timeWindow({ defaultHours: 24, maxHours: MCP_DISCOVERY_MAX_HOURS })

export function registerDbQueryVolumeTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "DB Query Volume",
		description:
			"Database query shapes (normalized statements, literals as `?`) ranked by call volume, per calling service and database, with errors, avg/p95 latency and last seen. Read from the hourly query-shape rollup, so 30-day windows are cheap. Use it to find which service issues the most queries, N+1 patterns, or slow statements without run_sql.",
		parameters: Schema.Struct({
			...WINDOW.fields,
			service: P.service("Only queries issued by this service (exact `service.name`)"),
			db_system: P.optionalText("Only this database system, e.g. postgresql, redis, mysql"),
			environment: P.environment(),
			limit: P.limit({ default: 30, max: 500, noun: "query shapes" }),
		}),
		aliases: P.SERVICE_ALIASES,
		output: DbQueryVolumeOutput,
		hints: { readOnly: true },
		phrases: ["Ranking database queries"],
		handler: Effect.fn("McpTool.dbQueryVolume")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, TOOL)
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				service: params.service ?? "all",
				dbSystem: params.db_system ?? "all",
			})

			const rows = yield* withTenantExecutor(
				Effect.gen(function* () {
					const executor = yield* WarehouseExecutor
					const compiled = CH.compile(
						CH.dbQueryVolumeQuery({
							serviceName: params.service,
							dbSystem: params.db_system,
							deploymentEnv: params.environment,
							limit: params.limit,
						}),
						{ orgId: executor.orgId, startTime: st, endTime: et },
						{ rowSchema: CH.dbQueryVolumeRowSchema },
					)
					return yield* executor.compiledQuery(compiled, {
						profile: "aggregation",
						context: "dbQueryVolume",
					})
				}),
			).pipe(Effect.catchTags(warehouseToMcpHandlers(TOOL)))
			yield* Effect.annotateCurrentSpan("result.rowCount", rows.length)

			return {
				timeRange: { start: st, end: et },
				...(params.service === undefined ? undefined : { service: params.service }),
				...(params.db_system === undefined ? undefined : { dbSystem: params.db_system }),
				...(params.environment === undefined ? undefined : { environment: params.environment }),
				truncated: rows.length >= params.limit,
				queries: rows.map((row) => ({
					service: row.serviceName,
					dbSystem: row.dbSystem,
					dbNamespace: row.dbNamespace,
					query: row.queryLabel,
					calls: row.queryCount,
					estimatedCalls: row.estimatedQueryCount,
					errorCount: row.errorCount,
					avgMs: row.avgDurationMs,
					p95Ms: row.p95DurationMs,
					lastSeen: row.lastSeen,
				})),
			}
		}),
		render: (output) => {
			const { queries } = output
			const top = queries[0]
			return {
				title: "DB Query Volume",
				scope: [
					["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
					["Service", output.service],
					["DB system", output.dbSystem],
					["Environment", output.environment],
				],
				...(queries.length === 0
					? {
							empty: {
								message: "No database client spans in this window.",
								hints: [
									"Shapes come from Client spans carrying `db.system.name` (or `db.system`); check the instrumentation with audit_setup.",
									"Widen start_time/end_time, or drop the service/db_system filters.",
								],
							},
						}
					: undefined),
				blocks:
					queries.length === 0
						? []
						: [
								doc.table(
									[
										"Service",
										"DB",
										"Query",
										"Calls",
										"Error rate",
										"Avg",
										"P95",
										"Last seen",
									],
									queries.map((s) => [
										s.service,
										s.dbNamespace === "" ? s.dbSystem : `${s.dbSystem} ${s.dbNamespace}`,
										truncate(s.query, 90),
										formatNumber(s.calls),
										s.calls > 0 ? formatPercent(s.errorCount / s.calls) : "",
										formatDurationFromMs(s.avgMs),
										formatDurationFromMs(s.p95Ms),
										s.lastSeen,
									]),
								),
							],
				...(output.truncated
					? { truncation: { shown: queries.length, noun: "query shapes" } }
					: undefined),
				next:
					top === undefined
						? [doc.next("audit_setup", {}, "check database instrumentation")]
						: [
								doc.next(
									"diagnose_service",
									{ service: top.service },
									`health of ${top.service}`,
								),
							],
			}
		},
	})
}
