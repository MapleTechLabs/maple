// The shared operation surface the CLI commands call.
//
// This is also where local and remote diverge. Local mode runs the
// @maple/query-engine observability helpers through `WarehouseExecutor`;
// remote mode calls Maple's public v2 API (see `remote-ops.ts`). The branch
// lives here, at the operation level, rather than behind a shared executor:
// v2 is a resource API with no generic `query(pipeName, params)` to implement,
// so there is nothing for an executor-shaped seam to stand in for.
//
// Every operation returns the same type in both modes, so commands and
// renderers never learn which backend answered.

import { Clock, Effect, References, Schema } from "effect"
import { CH, type TracesMetric } from "@maple/query-engine"
import {
	type SqlQueryOptions,
	WarehouseExecutor,
	listServices as obsListServices,
	searchTraces as obsSearchTraces,
	inspectTrace as obsInspectTrace,
	findErrors as obsFindErrors,
	errorDetail as obsErrorDetail,
	diagnoseService as obsDiagnoseService,
	searchLogs as obsSearchLogs,
	mineLogPatterns as obsMineLogPatterns,
	exploreAttributeKeys as obsAttributeKeys,
	exploreAttributeValues as obsAttributeValues,
	serviceMap as obsServiceMap,
	findSlowTraces as obsFindSlowTraces,
	topOperations as obsTopOperations,
} from "@maple/query-engine/observability"
import { MetricType } from "@maple/domain"
import type { WarehouseQueryName } from "@maple/domain/warehouse-queries"
import type { ListMetricsOutput } from "@maple/domain/tinybird"
import { executeLocalQuery } from "@maple/query-engine/local"
import {
	fingerprintSql,
	mapWarehouseError,
	SQL_TRACE_MAX,
	truncateSql,
	warehouseFailureAttributes,
	warehouseHttpClient,
} from "@maple/query-engine/execution"
import { HttpClient } from "effect/unstable/http"
import { verboseLogging } from "../lib/debug"
import {
	CliNotFoundError,
	CliUsageError,
	LocalServerUnreachableError,
	ReadOnlyQueryError,
} from "../lib/errors"
import { isLocalUnreachable, isNotMapleServer, readOnlyRejection } from "../lib/failure"
import type { ErrorRow, MetricSeriesOutput, TopOperationRow } from "../lib/views"
import { LOCAL_ORG_ID, localDriverError } from "./executor"
import { Mode, type ModeError } from "./mode"
import * as Remote from "./remote-ops"
import {
	type MapleV2Client,
	type RemoteError,
	makeV2Client,
	toWarehouseError,
	unsupportedInRemote,
} from "./v2-client"
import { parseTimestampMs, type Range } from "./time"

type AttrSource = "traces" | "metrics" | "services"
type AttrScope = "span" | "resource"

const ATTRIBUTE_DISCOVERY_GAP =
	"v2 exposes no attribute-discovery surface; /v2/attribute_mappings is mapping configuration, not the keys and values observed in your telemetry."

type Backend =
	| { readonly _tag: "local"; readonly baseUrl: string }
	| { readonly _tag: "remote"; readonly client: MapleV2Client }

/** Resolve the backend once per operation: the local URL, or a v2 client for the workspace. */
const backend: Effect.Effect<Backend, ModeError, Mode | HttpClient.HttpClient> = Effect.gen(function* () {
	const mode = yield* Mode
	const resolved = yield* mode.resolve
	if (resolved._tag === "local") return { _tag: "local", baseUrl: resolved.baseUrl } satisfies Backend
	return { _tag: "remote", client: yield* makeV2Client(resolved.apiUrl, resolved.token) } satisfies Backend
})

/**
 * The warehouse layer logs every failed query at Error level, SQL included.
 * The CLI prints its own one-line error, so those logs only surface with
 * `--debug` or an explicit `--log-level`.
 */
const quietUnlessVerbose = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
	verboseLogging() ? effect : Effect.provideService(effect, References.MinimumLogLevel, "None")

/** A local failure that is really "no Maple server at this URL", named with the URL. */
const localServerFailure =
	(baseUrl: string) =>
	<E>(error: E): E | LocalServerUnreachableError =>
		isLocalUnreachable(error)
			? new LocalServerUnreachableError({
					url: baseUrl,
					message: `could not reach the Maple server at ${baseUrl}`,
					hint: "start it with `maple start`, or set MAPLE_LOCAL_URL to the address it printed",
				})
			: isNotMapleServer(error)
				? new LocalServerUnreachableError({
						url: baseUrl,
						message: `${baseUrl} answered, but it is not a Maple server`,
						hint: "set MAPLE_LOCAL_URL to the address `maple start` printed",
					})
				: error

/** Run `remote` against v2 when a workspace is configured, else `local`. */
const dispatch = <A, E, R, E2, R2>(
	local: Effect.Effect<A, E, R>,
	remote: (client: MapleV2Client) => Effect.Effect<A, E2, R2>,
	pipeName: string,
) =>
	Effect.flatMap(
		backend,
		(b): Effect.Effect<A, E | LocalServerUnreachableError | RemoteError, R | R2> =>
			b._tag === "local"
				? local.pipe(quietUnlessVerbose, Effect.mapError(localServerFailure(b.baseUrl)))
				: Effect.mapError(remote(b.client), toWarehouseError(pipeName)),
	)

/** Pipes whose compiled query filters on the `deployment_env` param. */
const ENV_FILTERED_PIPES: ReadonlySet<string> = new Set(["list_traces", "list_logs", "logs_count"])

/**
 * `searchTraces`, `searchLogs` and `mineLogPatterns` take no environment, but
 * the pipes under them filter on `deployment_env`; this adds it to their calls.
 */
const withEnvironment =
	(environment: string | undefined) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | WarehouseExecutor> =>
		environment === undefined
			? effect
			: Effect.flatMap(WarehouseExecutor, (executor) =>
					Effect.provideService(effect, WarehouseExecutor, {
						...executor,
						query: <T>(
							pipe: WarehouseQueryName,
							params: Record<string, unknown>,
							options?: SqlQueryOptions,
						) =>
							executor.query<T>(
								pipe,
								ENV_FILTERED_PIPES.has(pipe)
									? { ...params, deployment_env: environment }
									: params,
								options,
							),
					}),
				)

export const listServices = (p: { range: Range; environment?: string }) =>
	dispatch(
		obsListServices({ timeRange: p.range, environment: p.environment }),
		(client) => Remote.listServices(client, p),
		"service_overview",
	)

export const searchTraces = (p: {
	range: Range
	service?: string
	spanName?: string
	hasError?: boolean
	minDurationMs?: number
	maxDurationMs?: number
	httpMethod?: string
	traceId?: string
	rootOnly?: boolean
	environment?: string
	limit?: number
	offset?: number
}) =>
	dispatch(
		Effect.gen(function* () {
			// Span-level search runs on `span_search`, which has no environment filter.
			if (p.environment !== undefined && p.spanName !== undefined && p.rootOnly !== true) {
				return yield* new CliUsageError({
					message: "--env cannot be combined with --span-name yet",
					hint: "drop one of them; --env filters root spans, --span-name searches every span",
				})
			}
			return yield* obsSearchTraces({
				timeRange: p.range,
				service: p.service,
				spanName: p.spanName,
				spanNameMatchMode: p.spanName ? "contains" : undefined,
				hasError: p.hasError,
				minDurationMs: p.minDurationMs,
				maxDurationMs: p.maxDurationMs,
				httpMethod: p.httpMethod,
				traceId: p.traceId,
				rootOnly: p.rootOnly,
				limit: p.limit,
				offset: p.offset,
			}).pipe(withEnvironment(p.environment))
		}),
		(client) => Remote.searchTraces(client, p),
		"list_traces",
	)

/** How far back `maple trace <id>` looks when no window is given (after the default 24h misses). */
export const TRACE_LOOKBACK_DAYS = 30

export const inspectTrace = (p: { traceId: string; range?: Range }) =>
	dispatch(
		obsInspectTrace(p.traceId, {
			includeAttributes: true,
			...(p.range === undefined
				? { widenedLookbackHours: TRACE_LOOKBACK_DAYS * 24 }
				: { timeRange: { startTime: p.range.startTime, endTime: p.range.endTime } }),
		}),
		(client) => Remote.inspectTrace(client, p),
		"span_hierarchy",
	)

/**
 * `errors_by_type` groups by fingerprint and keeps only a service count, so two
 * fingerprints with the same label and message in different services read as
 * duplicates. One fingerprint-keyed lookup names a service for each row.
 */
const localFindErrors = (p: { range: Range; service?: string; environment?: string; limit?: number }) =>
	Effect.gen(function* () {
		const rows = yield* obsFindErrors({
			timeRange: p.range,
			service: p.service,
			environment: p.environment,
			limit: p.limit,
		})
		const serviceOf = new Map<string, string>()
		if (rows.length > 0) {
			const executor = yield* WarehouseExecutor
			const issues = yield* executor.compiledQuery(
				CH.compile(
					CH.errorIssuesQuery({
						fingerprintHashes: rows.map((r) => r.fingerprintHash),
						...(p.service ? { services: [p.service] } : undefined),
						...(p.environment ? { deploymentEnvs: [p.environment] } : undefined),
						limit: rows.length,
					}),
					{ orgId: LOCAL_ORG_ID, startTime: p.range.startTime, endTime: p.range.endTime },
				),
				{ profile: "list", context: "cli.errorServices" },
			)
			for (const issue of issues) serviceOf.set(issue.fingerprintHash, issue.serviceName)
		}
		return rows.map((r): ErrorRow => ({ ...r, serviceName: serviceOf.get(r.fingerprintHash) ?? "" }))
	})

export const findErrors = (p: { range: Range; service?: string; environment?: string; limit?: number }) =>
	dispatch(
		localFindErrors(p),
		() =>
			unsupportedInRemote(
				"errors_by_type",
				"/v2/error_issues lists one triage issue per fingerprint, so it cannot report how many services an error spans, and it only covers fingerprints a sweep has already turned into issues.",
			),
		"errors_by_type",
	)

export const errorDetail = (p: { fingerprintHash: string; range: Range; service?: string; limit?: number }) =>
	dispatch(
		obsErrorDetail({
			fingerprintHash: p.fingerprintHash,
			timeRange: p.range,
			service: p.service,
			includeTimeseries: true,
			limit: p.limit,
		}),
		(client) => Remote.errorDetail(client, p),
		"error_detail_traces",
	)

export const diagnoseService = (p: { serviceName: string; range: Range; environment?: string }) =>
	dispatch(
		obsDiagnoseService({ serviceName: p.serviceName, timeRange: p.range, environment: p.environment }),
		() =>
			unsupportedInRemote(
				"diagnose",
				"its error breakdown depends on exception-type aggregates that v2 does not expose, so a remote diagnosis would silently omit the errors section.",
			),
		"diagnose",
	)

export const searchLogs = (p: {
	range: Range
	service?: string
	severity?: string
	search?: string
	traceId?: string
	environment?: string
	limit?: number
	offset?: number
}) =>
	dispatch(
		obsSearchLogs({
			timeRange: p.range,
			service: p.service,
			severity: p.severity,
			search: p.search,
			traceId: p.traceId,
			limit: p.limit,
			offset: p.offset,
		}).pipe(withEnvironment(p.environment)),
		(client) => Remote.searchLogs(client, p),
		"list_logs",
	)

export const mineLogPatterns = (p: {
	range: Range
	service?: string
	severity?: string
	search?: string
	environment?: string
	limit?: number
}) =>
	dispatch(
		obsMineLogPatterns({
			timeRange: p.range,
			service: p.service,
			severity: p.severity,
			search: p.search,
			limit: p.limit,
		}).pipe(withEnvironment(p.environment)),
		(client) => Remote.mineLogPatterns(client, p),
		"list_logs",
	)

export const findSlowTraces = (p: { range: Range; service?: string; environment?: string; limit?: number }) =>
	dispatch(
		obsFindSlowTraces({
			timeRange: p.range,
			service: p.service,
			environment: p.environment,
			limit: p.limit,
		}),
		() =>
			unsupportedInRemote(
				"slow_traces",
				"/v2/traces/search can filter by minimum duration but cannot order by it, so the slowest traces cannot be selected.",
			),
		"slow_traces",
	)

export const serviceMap = (p: { range: Range; service?: string; environment?: string }) =>
	dispatch(
		obsServiceMap({ timeRange: p.range, service: p.service, environment: p.environment }),
		(client) => Remote.serviceMap(client, p),
		"service_dependencies",
	)

export const attributeKeys = (p: {
	source: AttrSource
	scope?: AttrScope
	service?: string
	range: Range
	limit?: number
}) =>
	dispatch(
		obsAttributeKeys({
			source: p.source,
			scope: p.scope,
			service: p.service,
			timeRange: p.range,
			limit: p.limit,
		}),
		() => unsupportedInRemote("attribute_keys", ATTRIBUTE_DISCOVERY_GAP),
		"attribute_keys",
	)

export const attributeValues = (p: {
	key: string
	source: AttrSource
	scope?: AttrScope
	service?: string
	range: Range
	limit?: number
}) =>
	dispatch(
		obsAttributeValues({
			source: p.source,
			scope: p.scope,
			key: p.key,
			service: p.service,
			timeRange: p.range,
			limit: p.limit,
		}),
		() => unsupportedInRemote("attribute_values", ATTRIBUTE_DISCOVERY_GAP),
		"attribute_values",
	)

const metricUnit = (metric: TracesMetric): TopOperationRow["unit"] =>
	metric === "count" ? "count" : metric === "error_rate" ? "ratio" : metric === "apdex" ? "score" : "ms"

export const topOperations = (p: {
	serviceName: string
	metric: TracesMetric
	range: Range
	limit?: number
}) =>
	dispatch(
		Effect.map(
			obsTopOperations({
				serviceName: p.serviceName,
				metric: p.metric,
				timeRange: p.range,
				limit: p.limit,
			}),
			(rows) =>
				rows.map((r): TopOperationRow => ({ ...r, metric: p.metric, unit: metricUnit(p.metric) })),
		),
		() =>
			unsupportedInRemote(
				"top_operations",
				"it reports call count, latency and error rate per operation together, and /v2/traces/breakdown returns one aggregation per request without a combined ranking.",
			),
		"top_operations",
	)

const asBoolean = (value: unknown): boolean =>
	value === true || value === 1 || value === "1" || value === "true"

export const listMetrics = (p: { range: Range; service?: string; search?: string; limit?: number }) =>
	dispatch(
		Effect.gen(function* () {
			const executor = yield* WarehouseExecutor
			const result = yield* executor.query<ListMetricsOutput>("list_metrics", {
				start_time: p.range.startTime,
				end_time: p.range.endTime,
				...(p.service ? { service: p.service } : undefined),
				...(p.search ? { search: p.search } : undefined),
				limit: p.limit ?? 100,
			})
			// chDB returns the flag as 0/1; remote mode already returns a boolean.
			return result.data.map(
				(m): ListMetricsOutput => ({ ...m, isMonotonic: asBoolean(m.isMonotonic) }),
			)
		}),
		(client) => Remote.listMetrics(client, p),
		"list_metrics",
	)

/**
 * Raw SQL escape hatch against the local chDB store, local mode only.
 * Arbitrary user SQL carries no OrgId guarantee, so it deliberately bypasses
 * the warehouse executor (whose `sqlQuery` enforces the OrgId scoping guard)
 * and posts straight to the single-tenant `/local/query` endpoint.
 */
const executeRawLocalQuery = Effect.fn("WarehouseExecutor.rawQuery", { kind: "client" })(function* (
	sql: string,
	baseUrl: string,
) {
	const startedAtMs = yield* Clock.currentTimeMillis
	yield* Effect.annotateCurrentSpan({
		clientSource: "managed",
		"db.client": "clickhouse",
		"db.system.name": "clickhouse",
		"peer.service": "chdb",
		"warehouse.backend": "chdb",
		"warehouse.route": "raw",
		"warehouse.config_source": "managed",
		"db.query.text": truncateSql(sql, SQL_TRACE_MAX),
		"db.query.length": sql.length,
		"db.query.truncated": sql.length > SQL_TRACE_MAX,
		"db.query.fingerprint": fingerprintSql(sql),
		"query.pipe": "rawSqlQuery",
		"query.context": "cli.rawQuery",
	})
	// This span is the database span; the request underneath adds no `http.client` span.
	const http = warehouseHttpClient(yield* HttpClient.HttpClient)
	const rows = yield* executeLocalQuery(sql, baseUrl).pipe(
		Effect.provideService(HttpClient.HttpClient, http),
		Effect.mapError((error) => mapWarehouseError("rawQuery", localDriverError(error))),
		Effect.tapError((error) =>
			Clock.currentTimeMillis.pipe(
				Effect.flatMap((completedAtMs) =>
					Effect.annotateCurrentSpan({
						"db.duration_ms": completedAtMs - startedAtMs,
						...warehouseFailureAttributes(error),
					}),
				),
			),
		),
	)
	yield* Effect.annotateCurrentSpan("result.rowCount", rows.length)
	yield* Effect.annotateCurrentSpan("db.response.returned_rows", rows.length)
	yield* Effect.annotateCurrentSpan("db.duration_ms", (yield* Clock.currentTimeMillis) - startedAtMs)
	return rows
})

export const rawQuery = (sql: string) =>
	Effect.gen(function* () {
		const mode = yield* Mode
		const resolved = yield* mode.resolve
		if (resolved._tag !== "local") {
			return yield* new CliUsageError({
				message: "maple query runs raw SQL against a local store only",
				hint: "start one with `maple start`, then pass --local",
			})
		}
		return yield* executeRawLocalQuery(sql, resolved.baseUrl).pipe(
			quietUnlessVerbose,
			Effect.mapError((error) => {
				// The server refuses writes, multi-statement batches and table functions.
				const reason = readOnlyRejection(error)
				return reason === undefined
					? localServerFailure(resolved.baseUrl)(error)
					: new ReadOnlyQueryError({ reason, message: `maple query is read-only: ${reason}` })
			}),
		)
	})

// Custom traces analytics share the `group_by_*` presence-flag convention the
// pipe dispatcher expects (see `pipeParamsToTraces*Opts`).
const groupByParam = (groupBy?: string): Record<string, string> => {
	switch (groupBy) {
		case "service":
			return { group_by_service: "1" }
		case "span_name":
			return { group_by_span_name: "1" }
		case "status_code":
			return { group_by_status_code: "1" }
		case "http_method":
			return { group_by_http_method: "1" }
		default:
			return {}
	}
}

export const tracesTimeseries = (p: {
	range: Range
	service?: string
	spanName?: string
	groupBy?: string
	errorsOnly?: boolean
	environment?: string
	bucketSeconds?: number
}) =>
	dispatch(
		localTracesTimeseries(p),
		(client) => Remote.tracesTimeseries(client, p),
		"custom_traces_timeseries",
	)

const localTracesTimeseries = (p: {
	range: Range
	service?: string
	spanName?: string
	groupBy?: string
	errorsOnly?: boolean
	environment?: string
	bucketSeconds?: number
}) =>
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const result = yield* executor.query("custom_traces_timeseries", {
			start_time: p.range.startTime,
			end_time: p.range.endTime,
			...(p.bucketSeconds ? { bucket_seconds: p.bucketSeconds } : undefined),
			...(p.service ? { service_name: p.service } : undefined),
			...(p.spanName ? { span_name: p.spanName } : undefined),
			...(p.errorsOnly ? { errors_only: "1" } : undefined),
			...(p.environment ? { environments: p.environment } : undefined),
			...groupByParam(p.groupBy),
		})
		return result.data
	})

export const tracesBreakdown = (p: {
	range: Range
	service?: string
	spanName?: string
	groupBy?: string
	limit?: number
	errorsOnly?: boolean
	environment?: string
}) =>
	dispatch(
		localTracesBreakdown(p),
		(client) => Remote.tracesBreakdown(client, p),
		"custom_traces_breakdown",
	)

const localTracesBreakdown = (p: {
	range: Range
	service?: string
	spanName?: string
	groupBy?: string
	limit?: number
	errorsOnly?: boolean
	environment?: string
}) =>
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const result = yield* executor.query("custom_traces_breakdown", {
			start_time: p.range.startTime,
			end_time: p.range.endTime,
			limit: p.limit ?? 10,
			...(p.service ? { service_name: p.service } : undefined),
			...(p.spanName ? { span_name: p.spanName } : undefined),
			...(p.errorsOnly ? { errors_only: "1" } : undefined),
			...(p.environment ? { environments: p.environment } : undefined),
			...groupByParam(p.groupBy ?? "service"),
		})
		return result.data
	})

export const compareServiceOverview = (p: { current: Range; previous: Range; environment?: string }) =>
	dispatch(
		localCompareServiceOverview(p),
		() =>
			unsupportedInRemote(
				"service_overview_compare",
				"v2 has no window-comparison endpoint, and diffing two /v2/services calls client-side would lose the server-side weighting the comparison depends on.",
			),
		"service_overview_compare",
	)

const localCompareServiceOverview = (p: { current: Range; previous: Range; environment?: string }) =>
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const result = yield* executor.query("service_overview_compare", {
			current_start_time: p.current.startTime,
			current_end_time: p.current.endTime,
			previous_start_time: p.previous.startTime,
			previous_end_time: p.previous.endTime,
			...(p.environment ? { environments: p.environment } : undefined),
		})
		return result.data
	})

/** Service names with trace telemetry in the window, busiest first. */
export const knownServices = (range: Range) =>
	Effect.map(listServices({ range }), (services) =>
		[...services].sort((a, b) => b.throughput - a.throughput).map((s) => s.name),
	)

const NICE_BUCKETS = [60, 300, 600, 900, 1800, 3600, 7200, 21_600, 43_200, 86_400]

/** A bucket size giving roughly `points` buckets over the window, rounded to a readable step. */
export const bucketSecondsFor = (range: Range, points = 60): number => {
	const startMs = parseTimestampMs(range.startTime) ?? 0
	const endMs = parseTimestampMs(range.endTime) ?? startMs
	const target = (endMs - startMs) / 1000 / points
	return NICE_BUCKETS.find((b) => b >= target) ?? 86_400
}

export interface MetricSeriesInput {
	readonly name: string
	readonly range: Range
	readonly bucketSeconds: number
	readonly service?: string
	readonly environment?: string
}

/** A found metric's series, or the catalog names that matched the search when it was not found. */
export type MetricSeriesResult =
	| { readonly _tag: "found"; readonly output: MetricSeriesOutput }
	| { readonly _tag: "missing"; readonly similar: ReadonlyArray<string> }

const isMetricType = Schema.is(MetricType)

const unplottable = (name: string, metricType: string) =>
	new CliUsageError({ message: `metric ${name} is a ${metricType}, which has no value timeseries` })

const localMetricSeries = (p: MetricSeriesInput) =>
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const window = { orgId: LOCAL_ORG_ID, startTime: p.range.startTime, endTime: p.range.endTime }
		const catalog = yield* executor.compiledQuery(
			CH.compile(
				CH.listMetricsQuery({
					search: p.name,
					...(p.service ? { serviceName: p.service } : undefined),
					limit: 50,
				}),
				window,
			),
			{ profile: "list", context: "cli.metricEntry" },
		)
		const entry = catalog.find((m) => m.metricName === p.name)
		if (entry === undefined) {
			return {
				_tag: "missing",
				similar: [...new Set(catalog.map((m) => m.metricName))],
			} satisfies MetricSeriesResult
		}
		const metricType = entry.metricType
		if (!isMetricType(metricType)) return yield* unplottable(p.name, metricType)
		const isMonotonic = asBoolean(entry.isMonotonic)
		// Monotonic counters read as a per-second rate; everything else as the bucket average.
		const rate = metricType === "sum" && isMonotonic
		const series = {
			groupBy: ["service"],
			seriesLimit: 20,
			...(p.service ? { serviceName: p.service } : undefined),
			...(p.environment ? { environments: [p.environment] } : undefined),
		}
		const params = { ...window, bucketSeconds: p.bucketSeconds, metricName: p.name }
		const options = { profile: "aggregation", context: "cli.metricSeries" } as const
		const points = rate
			? (yield* executor.compiledQuery(
					CH.compile(
						CH.metricsTimeseriesRateQuery({
							metricName: p.name,
							bucketSeconds: p.bucketSeconds,
							...series,
						}),
						params,
					),
					options,
				)).map((r) => ({ bucket: r.bucket, service: r.groupName, value: r.rateValue }))
			: (yield* executor.compiledQuery(
					CH.compile(CH.metricsTimeseriesQuery({ metricType, ...series }), params),
					options,
				)).map((r) => ({ bucket: r.bucket, service: r.groupName, value: r.avgValue }))
		return {
			_tag: "found",
			output: {
				metricName: p.name,
				metricType,
				unit: entry.metricUnit,
				isMonotonic,
				aggregation: rate ? "rate" : "avg",
				bucketSeconds: p.bucketSeconds,
				points,
			},
		} satisfies MetricSeriesResult
	})

const remoteMetricSeries = (client: MapleV2Client, p: MetricSeriesInput) =>
	Effect.gen(function* () {
		if (p.environment) {
			return yield* unsupportedInRemote(
				"metrics_timeseries",
				"/v2/metrics/timeseries has no deployment-environment filter.",
			)
		}
		const list = yield* Remote.listMetrics(client, {
			range: p.range,
			search: p.name,
			service: p.service,
			limit: 100,
		})
		const entry = list.find((m) => m.metricName === p.name)
		if (entry === undefined) {
			return {
				_tag: "missing",
				similar: [...new Set(list.map((m) => m.metricName))],
			} satisfies MetricSeriesResult
		}
		const metricType = entry.metricType
		if (!isMetricType(metricType)) return yield* unplottable(p.name, metricType)
		const isMonotonic = asBoolean(entry.isMonotonic)
		const rate = metricType === "sum" && isMonotonic
		const points = yield* Remote.metricTimeseries(client, {
			range: p.range,
			name: p.name,
			metricType,
			aggregation: rate ? "rate" : "avg",
			bucketSeconds: p.bucketSeconds,
			service: p.service,
		})
		return {
			_tag: "found",
			output: {
				metricName: p.name,
				metricType,
				unit: entry.metricUnit,
				isMonotonic,
				aggregation: rate ? "rate" : "avg",
				bucketSeconds: p.bucketSeconds,
				points,
			},
		} satisfies MetricSeriesResult
	})

export const metricSeries = (p: MetricSeriesInput) =>
	dispatch(localMetricSeries(p), (client) => remoteMetricSeries(client, p), "metrics_timeseries")
