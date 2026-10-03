import { Effect, Schema } from "effect"
import { ServiceDeploymentsOutput } from "@maple/domain/mcp-outputs"
import { CH, parseWarehouseDateTime } from "@maple/query-engine"
import { WarehouseExecutor } from "@maple/query-engine/observability"
import type { McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { withTenantExecutor, CurrentMcpTenant } from "../lib/query-warehouse"
import { MCP_DISCOVERY_MAX_HOURS } from "../lib/time"
import { formatDurationFromMs, formatNumber, formatPercent, formatPointsDelta } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const TOOL = "service_deployments"
const WINDOW = P.timeWindow({ defaultHours: 7 * 24, maxHours: MCP_DISCOVERY_MAX_HOURS })

/** Windows up to this long read minutely buckets throughout, so `lastSeen` is minute-exact. */
const MINUTE_PRECISION_MAX_MS = 7 * 24 * 3_600_000
/** The minutely tier keeps 90 days; a window starting earlier needs the hourly tier. */
const MINUTELY_RETENTION_MS = 89 * 24 * 3_600_000

type Version = (typeof ServiceDeploymentsOutput.Type)["versions"][number]

const shortSha = (sha: string) => (sha.length > 12 ? sha.slice(0, 12) : sha)

const groupKey = (v: { readonly service: string; readonly environment: string }) =>
	`${v.service}\u0000${v.environment}`

/** Newest version against the one before it, per service and environment. */
const comparisons = (versions: ReadonlyArray<Version>) => {
	const groups = new Map<string, Array<Version>>()
	for (const v of versions) {
		const key = groupKey(v)
		groups.set(key, [...(groups.get(key) ?? []), v])
	}
	return [...groups.values()].flatMap((group) => {
		const [current, previous] = [...group].sort((a, b) => b.firstSeen.localeCompare(a.firstSeen))
		return current !== undefined && previous !== undefined ? [{ current, previous }] : []
	})
}

export function registerServiceDeploymentsTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Service Deployments",
		description:
			"Which versions (commit SHAs from the `vcs.ref.head.revision` resource attribute) each service ran in the window: first and last seen, traffic, error rate and p50/p95 per version, and which are still live. Verifies a rollout and compares a new version against the previous one in one call. Read from rollups, so 30-day windows are cheap. Keeps the 20 most recently serving versions per service and environment. Services that report no revision are not listed.",
		parameters: Schema.Struct({
			...WINDOW.fields,
			service: P.service(),
			environment: P.environment(),
			limit: P.limit({ default: 100, max: CH.RELEASES_LIST_CAP, noun: "service versions" }),
		}),
		aliases: P.SERVICE_ALIASES,
		output: ServiceDeploymentsOutput,
		hints: { readOnly: true },
		phrases: ["Checking deployed versions", "Comparing releases"],
		handler: Effect.fn("McpTool.serviceDeployments")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, TOOL)
			const tenant = yield* CurrentMcpTenant
			const startMs = parseWarehouseDateTime(st)
			const minutePrecision =
				parseWarehouseDateTime(et) - startMs <= MINUTE_PRECISION_MAX_MS &&
				startMs >= Date.now() - MINUTELY_RETENTION_MS
			const lastSeenPrecision: "minute" | "hour" = minutePrecision ? "minute" : "hour"
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				service: params.service ?? "all",
				minutePrecision,
			})

			const rows = yield* withTenantExecutor(
				Effect.gen(function* () {
					const executor = yield* WarehouseExecutor
					const compiled = CH.compile(
						CH.serviceDeploymentsQuery({
							serviceName: params.service,
							environments: params.environment === undefined ? undefined : [params.environment],
							minutePrecision,
							limit: params.limit,
						}),
						{ orgId: executor.orgId, startTime: st, endTime: et },
						{ rowSchema: CH.serviceDeploymentsRowSchema },
					)
					return yield* executor.compiledQuery(compiled, {
						profile: "aggregation",
						context: "serviceDeployments",
					})
				}),
			).pipe(Effect.catchTags(warehouseToMcpHandlers(TOOL)))
			yield* Effect.annotateCurrentSpan("result.rowCount", rows.length)

			const perGroup = new Map<string, number>()
			const newest = new Map<string, string>()
			for (const row of rows) {
				const key = groupKey({ service: row.serviceName, environment: row.environment })
				perGroup.set(key, (perGroup.get(key) ?? 0) + 1)
				const seen = newest.get(key)
				if (seen === undefined || row.lastSeen > seen) newest.set(key, row.lastSeen)
			}
			const versions = rows.map((row) => ({
				service: row.serviceName,
				environment: row.environment,
				commitSha: row.commitSha,
				firstSeen: row.firstSeen,
				lastSeen: row.lastSeen,
				spanCount: row.spanCount,
				errorCount: row.errorCount,
				errorRate: row.spanCount > 0 ? row.errorCount / row.spanCount : 0,
				p50Ms: row.p50LatencyMs,
				p95Ms: row.p95LatencyMs,
				live:
					newest.get(groupKey({ service: row.serviceName, environment: row.environment })) ===
					row.lastSeen,
			}))

			return {
				timeRange: { start: st, end: et },
				...(params.service === undefined ? undefined : { service: params.service }),
				...(params.environment === undefined ? undefined : { environment: params.environment }),
				lastSeenPrecision,
				truncated:
					rows.length >= params.limit ||
					[...perGroup.values()].some((n) => n >= CH.DEPLOYMENTS_PER_SERVICE_CAP),
				versions,
			}
		}),
		render: (output) => {
			const { versions } = output
			const pairs = comparisons(versions)
			const first = pairs[0]
			return {
				title: "Service Deployments",
				scope: [
					["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
					["Service", output.service],
					["Environment", output.environment],
					["Last seen precision", output.lastSeenPrecision],
				],
				...(versions.length === 0
					? {
							empty: {
								message: "No versioned traffic in this window.",
								hints: [
									"Versions come from the `vcs.ref.head.revision` resource attribute; a service that does not set it is not listed.",
									"Widen start_time/end_time, or check the service name with list_services.",
								],
							},
						}
					: undefined),
				blocks:
					versions.length === 0
						? []
						: [
								...(pairs.length === 0
									? []
									: [
											doc.heading("Newest vs previous version"),
											doc.table(
												[
													"Service",
													"Env",
													"New",
													"Previous",
													"Error rate",
													"Change",
													"P95",
													"Previous P95",
												],
												pairs.map(({ current, previous }) => [
													current.service,
													current.environment,
													shortSha(current.commitSha),
													shortSha(previous.commitSha),
													formatPercent(current.errorRate),
													formatPointsDelta(current.errorRate, previous.errorRate),
													formatDurationFromMs(current.p95Ms),
													formatDurationFromMs(previous.p95Ms),
												]),
											),
										]),
								doc.heading("All versions"),
								doc.table(
									[
										"Service",
										"Env",
										"Commit",
										"First seen",
										"Last seen",
										"Spans",
										"Error rate",
										"P95",
										"Live",
									],
									versions.map((v) => [
										v.service,
										v.environment,
										shortSha(v.commitSha),
										v.firstSeen,
										v.lastSeen,
										formatNumber(v.spanCount),
										formatPercent(v.errorRate),
										formatDurationFromMs(v.p95Ms),
										v.live ? "yes" : "",
									]),
								),
							],
				...(output.truncated
					? { truncation: { shown: versions.length, noun: "service versions" } }
					: undefined),
				next:
					first === undefined
						? versions
								.slice(0, 1)
								.map((v) =>
									doc.next("diagnose_service", { service: v.service }, "check its health"),
								)
						: [
								doc.next(
									"compare_periods",
									{ around_time: first.current.firstSeen, service: first.current.service },
									`before/after the ${shortSha(first.current.commitSha)} rollout`,
								),
								doc.next(
									"find_errors",
									{ service: first.current.service, start_time: first.current.firstSeen },
									"errors since the new version started",
								),
							],
			}
		},
	})
}
