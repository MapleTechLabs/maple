import { Effect, Schema } from "effect"
import { RouteUsageOutput, RouteUsageSort } from "@maple/domain/mcp-outputs"
import { CH } from "@maple/query-engine"
import { WarehouseExecutor } from "@maple/query-engine/observability"
import type { McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { withTenantExecutor, CurrentMcpTenant } from "../lib/query-warehouse"
import { formatDurationFromMs, formatNumber, formatPercent, truncate } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const TOOL = "route_usage"
/** The hourly operations rollup keeps a year; 90 days covers "is this route still used?". */
const WINDOW = P.timeWindow({ defaultHours: 7 * 24, maxHours: 90 * 24 })

const ORDER = {
	count: "count",
	least_recent: "lastSeenAsc",
	most_recent: "lastSeenDesc",
} satisfies Record<typeof RouteUsageSort.Type, CH.RouteUsageOrder>

export function registerRouteUsageTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Route Usage",
		description:
			'HTTP endpoints (`METHOD /route`, from `http.route`, falling back to `url.path`) per service with request count, error rate, p95 and first/last seen, over up to 90 days from the operations rollup. Answers "is this route still called, and by how much?" in one call. `sort=least_recent` lists the stalest routes first. Last seen is hour-grained for hours wholly inside the window. Outbound HTTP calls named like an endpoint can appear under the calling service.',
		parameters: Schema.Struct({
			...WINDOW.fields,
			service: P.service(),
			environment: P.environment(),
			search: P.optionalText("Case-insensitive substring of the method or route, e.g. `/v1/users`"),
			sort: P.optionalOneOf(RouteUsageSort.literals, "Order of the rows (default count)"),
			limit: P.limit({ default: 50, max: 500, noun: "routes" }),
		}),
		aliases: P.SERVICE_ALIASES,
		output: RouteUsageOutput,
		hints: { readOnly: true },
		phrases: ["Checking route usage", "Finding unused routes"],
		handler: Effect.fn("McpTool.routeUsage")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, TOOL)
			const sort = params.sort ?? "count"
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, service: params.service ?? "all", sort })

			const rows = yield* withTenantExecutor(
				Effect.gen(function* () {
					const executor = yield* WarehouseExecutor
					const compiled = CH.compile(
						CH.routeUsageQuery({
							serviceName: params.service,
							environments: params.environment === undefined ? undefined : [params.environment],
							search: params.search,
							orderBy: ORDER[sort],
							limit: params.limit,
						}),
						{ orgId: executor.orgId, startTime: st, endTime: et },
						{ rowSchema: CH.routeUsageRowSchema },
					)
					return yield* executor.compiledQuery(compiled, {
						profile: "aggregation",
						context: "routeUsage",
					})
				}),
			).pipe(Effect.catchTags(warehouseToMcpHandlers(TOOL)))
			yield* Effect.annotateCurrentSpan("result.rowCount", rows.length)

			return {
				timeRange: { start: st, end: et },
				...(params.service === undefined ? undefined : { service: params.service }),
				...(params.environment === undefined ? undefined : { environment: params.environment }),
				...(params.search === undefined ? undefined : { search: params.search }),
				sort,
				truncated: rows.length >= params.limit,
				routes: rows.map((row) => {
					const { method, route } = CH.splitEndpointName(row.spanName)
					return {
						service: row.serviceName,
						method,
						route,
						spanCount: row.spanCount,
						errorCount: row.errorCount,
						errorRate: row.spanCount > 0 ? row.errorCount / row.spanCount : 0,
						p95Ms: row.p95DurationMs,
						firstSeen: row.firstSeen,
						lastSeen: row.lastSeen,
					}
				}),
			}
		}),
		render: (output) => {
			const { routes } = output
			const top = routes[0]
			return {
				title: "Route Usage",
				scope: [
					["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
					["Service", output.service],
					["Environment", output.environment],
					["Search", output.search],
					["Sort", output.sort],
				],
				...(routes.length === 0
					? {
							empty: {
								message: "No HTTP endpoints matched in this window.",
								hints: [
									"With a specific `search`, an empty result means no matching route was called in this window.",
									"Endpoints come from server spans named `METHOD /route`; check the service with get_service_top_operations.",
								],
							},
						}
					: undefined),
				blocks:
					routes.length === 0
						? []
						: [
								doc.table(
									[
										"Service",
										"Method",
										"Route",
										"Requests",
										"Error rate",
										"P95",
										"First seen",
										"Last seen",
									],
									routes.map((r) => [
										r.service,
										r.method,
										truncate(r.route, 80),
										formatNumber(r.spanCount),
										formatPercent(r.errorRate),
										formatDurationFromMs(r.p95Ms),
										r.firstSeen,
										r.lastSeen,
									]),
								),
							],
				...(output.truncated ? { truncation: { shown: routes.length, noun: "routes" } } : undefined),
				next:
					top === undefined
						? output.service === undefined
							? [doc.next("list_services", {}, "check which services report")]
							: [
									doc.next(
										"get_service_top_operations",
										{ service: output.service },
										"see all its operations",
									),
								]
						: [
								doc.next(
									"search_traces",
									{ service: top.service, span_name: top.route },
									`traces for ${top.method} ${truncate(top.route, 40)}`,
								),
							],
			}
		},
	})
}
