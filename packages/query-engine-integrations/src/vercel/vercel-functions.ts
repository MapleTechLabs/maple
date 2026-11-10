// Vercel Functions (/infra/vercel): invocations, cold starts and outbound calls
//
// Read from the trace drain's runtime spans. Per invocation Vercel emits one
// `Invoke Function` server span, parented by the edge request span of the same
// trace; a cold start adds `Start VM`, `Spawn Node.js` and `Init User Code`
// (one each) under it, and every outbound call is a client span. Ingest stamps
// `maple_vercel.platform_service` on the runtime's resources and renames the
// invocation and client spans to the project's own service, so runtime spans
// are selected by that marker, never by ServiceName.

import * as CH from "@maple-dev/effect-orm/expr"
import * as T from "@maple-dev/effect-orm/clickhouse"
import { defineFn, from, fromQuery, param, type ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import { Traces, orgIdParam } from "@maple/query-engine/ch/tables"
import { finiteOrZero, isoBucket } from "@maple/query-engine/ch/format"
import { VERCEL_EDGE_SERVICE, isEdgeRequest, type VercelProjectScope } from "./vercel-infra"

type TraceColumns = ColumnAccessor<typeof Traces.columns>

const PLATFORM_SERVICE_KEY = "maple_vercel.platform_service"
const RUNTIME_SERVICE = "vercel.serverless-runtime"

const INVOKE_FUNCTION = "Invoke Function"
/** The first phase of a cold start; one per cold start, so it counts them. */
const START_VM = "Start VM"
const COLD_START_PHASES = [START_VM, "Spawn Node.js", "Init User Code"]

const toInt32OrZero = defineFn<[CH.Expr<string>], number>("toInt32OrZero", T.int32)

const tracesWindow = ($: TraceColumns) => [
	$.OrgId.eq(orgIdParam),
	$.Timestamp.gte(param.dateTime("startTime")),
	$.Timestamp.lte(param.dateTime("endTime")),
]

const isRuntime = ($: TraceColumns) =>
	// The key test lets the `mapKeys(ResourceAttributes)` bloom index skip granules.
	CH.mapContains($.ResourceAttributes, PLATFORM_SERVICE_KEY).and(
		$.ResourceAttributes.get(PLATFORM_SERVICE_KEY).eq(RUNTIME_SERVICE),
	)

const projectId = ($: TraceColumns) => $.ResourceAttributes.get("vercel.projectId")

/** Invocations and cold starts per project over the window. */
export function vercelProjectFunctionsSQL() {
	return from(Traces)
		.select(($) => ({
			projectId: projectId($),
			/** The project's own service: ingest renames the invocation span to it. */
			serviceName: CH.anyIf($.ServiceName, $.SpanName.eq(INVOKE_FUNCTION)),
			invocations: CH.countIf($.SpanName.eq(INVOKE_FUNCTION)),
			coldStarts: CH.countIf($.SpanName.eq(START_VM)),
			lastSeen: CH.max_($.Timestamp),
		}))
		.where(($) => [
			...tracesWindow($),
			isRuntime($),
			$.SpanKind.eq("Server"),
			$.SpanName.in_(INVOKE_FUNCTION, START_VM),
			projectId($).neq(""),
		])
		.groupBy("projectId")
		.limit(1000)
		.format("JSON")
}

/** Invocations, cold starts and invocation latency per bucket, for every project or one. */
export function vercelFunctionTimeseriesSQL(scope: VercelProjectScope = {}) {
	return from(Traces)
		.select(($) => ({
			bucket: isoBucket($.Timestamp),
			invocations: CH.countIf($.SpanName.eq(INVOKE_FUNCTION)),
			coldStarts: CH.countIf($.SpanName.eq(START_VM)),
			// NULL outside invocations, so the quantiles read invocation spans only; 0 in a bucket without one.
			invokeP50Ms: finiteOrZero(
				CH.quantile(0.5)(CH.nullIf(CH.if_($.SpanName.eq(INVOKE_FUNCTION), $.Duration, CH.lit(0)), 0)).div(1_000_000),
			),
			invokeP95Ms: finiteOrZero(
				CH.quantile(0.95)(CH.nullIf(CH.if_($.SpanName.eq(INVOKE_FUNCTION), $.Duration, CH.lit(0)), 0)).div(1_000_000),
			),
		}))
		.where(($) => [
			...tracesWindow($),
			isRuntime($),
			$.SpanKind.eq("Server"),
			$.SpanName.in_(INVOKE_FUNCTION, START_VM),
			scope.projectId === undefined ? projectId($).neq("") : projectId($).eq(scope.projectId),
		])
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.limit(2000)
		.format("JSON")
}

/**
 * One project's functions by route: invocations, cold starts, invocation p95 and
 * cold-start init time.
 *
 * Spans are joined to their route per trace, not per invocation: the route sits
 * on the edge request span and the invocation is its child. That holds while a
 * request trace has one invocation, as on real traffic (769 invocations over 768
 * traces); a trace with several counts them all but keeps its longest invocation
 * and sums their init time.
 */
export function vercelFunctionRoutesSQL() {
	const perTrace = from(Traces)
		.select(($) => ({
			traceId: $.TraceId,
			route: CH.anyIf($.SpanAttributes.get("http.route"), $.ServiceName.eq(VERCEL_EDGE_SERVICE)),
			traceInvocations: CH.countIf($.SpanName.eq(INVOKE_FUNCTION)),
			traceColdStarts: CH.countIf($.SpanName.eq(START_VM)),
			invokeMs: CH.maxIf($.Duration, $.SpanName.eq(INVOKE_FUNCTION)).div(1_000_000),
			// NULL without a cold start, so the init quantiles skip warm traces.
			initMs: CH.nullIf(CH.sumIf($.Duration, $.SpanName.in_(...COLD_START_PHASES)), 0).div(1_000_000),
		}))
		.where(($) => [
			...tracesWindow($),
			CH.mapContains($.ResourceAttributes, "vercel.projectId"),
			projectId($).eq(param.string("projectId")),
			CH.or(
				isEdgeRequest($),
				isRuntime($).and($.SpanKind.eq("Server")).and($.SpanName.in_(INVOKE_FUNCTION, ...COLD_START_PHASES)),
			),
		])
		.groupBy("traceId")

	return fromQuery(perTrace, "t")
		.select(($) => ({
			route: $.route,
			invocations: CH.sum($.traceInvocations),
			coldStarts: CH.sum($.traceColdStarts),
			p95DurationMs: finiteOrZero(CH.quantile(0.95)($.invokeMs)),
			initP50Ms: CH.quantile(0.5)($.initMs),
			initP95Ms: CH.quantile(0.95)($.initMs),
		}))
		.where(($) => [$.traceInvocations.gt(0)])
		.groupBy("route")
		.orderBy(["invocations", "desc"])
		.limit(50)
		.format("JSON")
}

/**
 * The hosts one project's functions call, with failures and latency.
 *
 * Raw traces on purpose: `service_external_edges_hourly` has no project id and
 * counts only `StatusCode = 'Error'`, while Vercel leaves its runtime client spans
 * Unset even when the call fails. A failure here is an error status, a 5xx, or
 * no response at all (`http.status_code = -1`).
 */
export function vercelProjectDependenciesSQL() {
	return from(Traces)
		.select(($) => {
			const status = toInt32OrZero($.SpanAttributes.get("http.status_code"))
			return {
				host: CH.if_(
					$.SpanAttributes.get("server.address").neq(""),
					$.SpanAttributes.get("server.address"),
					$.SpanAttributes.get("http.host"),
				),
				calls: CH.count(),
				errors: CH.countIf(CH.or($.StatusCode.eq("Error"), status.gte(500), status.lt(0))),
				p50DurationMs: finiteOrZero(CH.quantile(0.5)($.Duration).div(1_000_000)),
				p95DurationMs: finiteOrZero(CH.quantile(0.95)($.Duration).div(1_000_000)),
			}
		})
		.where(($) => [
			...tracesWindow($),
			isRuntime($),
			$.SpanKind.eq("Client"),
			projectId($).eq(param.string("projectId")),
			CH.or($.SpanAttributes.get("server.address").neq(""), $.SpanAttributes.get("http.host").neq("")),
		])
		.groupBy("host")
		.orderBy(["calls", "desc"])
		.limit(50)
		.format("JSON")
}
