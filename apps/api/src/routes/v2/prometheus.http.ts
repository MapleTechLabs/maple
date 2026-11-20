// The Prometheus HTTP API over Maple metrics. Handlers answer with raw responses so the body is
// Prometheus' own JSON, errors included; only authentication keeps the v2 envelope.

import { HttpApiBuilder } from "effect/http-api"
import { HttpServerResponse } from "effect/http"
import { Clock, Effect, Record as Rec, Result, Schema } from "effect"
import { parse, print, type QueryResult } from "@maple/promql"
import { CurrentTenant, WarehouseQuotaExceededError } from "@maple/domain/http"
import { MAX_PROMQL_QUERY_LENGTH } from "@maple/primitives"
import { MAX_QUERY_RANGE_SECONDS } from "@maple/query-engine"
import { MapleApiV2, type PrometheusParams } from "@maple/domain/http/v2"
import { recordRenderedFailure } from "@maple/backend/http/rendered-failure"
import { PromqlBadQueryError, PromqlQueryService } from "@maple/backend/services/promql/PromqlQueryService"
import {
	checkResultSize,
	encodeQueryResult,
	limitQueryResult,
	errorBody,
	errorStatus,
	type PrometheusErrorType,
	MAX_DATE_MS,
	parseStep,
	parseTime,
	parseTimeout,
	successBody,
} from "./prometheus-wire"

type Params = typeof PrometheusParams.Type

/** The version Grafana reads to enable Prometheus 3 features. */
export const PROMETHEUS_COMPAT_VERSION = "3.5.0"

const HOUR_MS = 3_600_000

/** Discovery reads at most this far back; a wider dashboard range is narrowed, never refused. */
const MAX_DISCOVERY_MS = MAX_QUERY_RANGE_SECONDS * 1000

/** The `timeout` parameter ran out before the query answered. Prometheus' `timeout`. */
class PrometheusTimeoutError extends Schema.TaggedError<PrometheusTimeoutError>()(
	"@maple/api/prometheus/PrometheusTimeoutError",
	{ message: Schema.String },
) {}

const isQuotaExceeded = Schema.is(WarehouseQuotaExceededError)

const BUILD_INFO = {
	version: PROMETHEUS_COMPAT_VERSION,
	revision: "",
	branch: "",
	buildUser: "",
	buildDate: "",
	goVersion: "",
	vendor: "Maple",
}

const seriesCount = (result: QueryResult): number =>
	result.resultType === "matrix" || result.resultType === "vector" ? result.result.length : 1

/** Prometheus merges URL and form parameters; the body wins, and `match[]` lists add up. */
const merged = (query: Params, payload: Params): Params => ({
	...query,
	...payload,
	"match[]": [...(query["match[]"] ?? []), ...(payload["match[]"] ?? [])],
})

const errorResponse = (type: PrometheusErrorType, message: string) =>
	Effect.as(
		Effect.annotateCurrentSpan({ "maple.promql.error_type": type }),
		HttpServerResponse.jsonUnsafe(errorBody(type, message), { status: errorStatus(type) }),
	)

/** A 503 answer whose diagnosis goes to the span, the error log and error tracking, as every API failure. */
const recorded503 = <E extends { readonly _tag: string; readonly message: string }>(
	error: E,
	summary: string,
	type: PrometheusErrorType,
	message: string,
) =>
	Effect.andThen(
		recordRenderedFailure({
			group: "prometheus",
			operation: "read",
			errorType: error._tag,
			summary,
			message: error.message,
			status: 503,
			cause: error,
		}),
		errorResponse(type, message),
	)

/** A query error as Prometheus' error envelope; warehouse failures never leak their diagnostics. */
const toErrorResponse = <E extends { readonly _tag: string; readonly message: string }>(error: E) => {
	switch (error._tag) {
		case "@maple/backend/promql/PromqlBadQueryError":
			return errorResponse("bad_data", error.message)
		case "@maple/backend/promql/PromqlExecutionError":
			return errorResponse("execution", error.message)
		case "@maple/api/prometheus/PrometheusTimeoutError":
			return recorded503(
				error,
				"Prometheus API query hit its timeout parameter",
				"timeout",
				error.message,
			)
		default:
			// A query over one of the store's budgets is the query's fault: say how to shrink it.
			if (isQuotaExceeded(error)) {
				switch (error.setting) {
					case "max_execution_time":
						return recorded503(
							error,
							"Prometheus API query over the metric store's time budget",
							"timeout",
							"query timed out in the metric store; narrow the selector, shorten the range or use a larger step",
						)
					case "max_memory_usage":
						return errorResponse(
							"execution",
							"query needs more memory than the metric store allows; narrow the selector, aggregate with sum by (...) or use a larger step",
						)
					case "max_threads":
						return errorResponse(
							"execution",
							"query scans more than the metric store allows at once; narrow the selector or shorten the range",
						)
				}
			}
			// The client sees a generic 503; the span and log carry the diagnosis.
			return recorded503(
				error,
				"Prometheus API warehouse read failed",
				"unavailable",
				"the metric store is unavailable, try again",
			)
	}
}

/** Success as `{status:"success",data}`; query errors as Prometheus' error envelope. */
const respond = <A, E extends { readonly _tag: string; readonly message: string }, R>(
	effect: Effect.Effect<A, E, R>,
) =>
	effect.pipe(
		Effect.map((data) => HttpServerResponse.jsonUnsafe(successBody(data))),
		Effect.catch(toErrorResponse),
	)

/** An answer with Prometheus' `warnings` beside `data`: nearest names, truncation. */
const respondWithWarnings = <A, E extends { readonly _tag: string; readonly message: string }, R>(
	effect: Effect.Effect<{ readonly data: A; readonly warnings: ReadonlyArray<string> }, E, R>,
) =>
	effect.pipe(
		Effect.map(({ data, warnings }) => HttpServerResponse.jsonUnsafe(successBody(data, warnings))),
		Effect.catch(toErrorResponse),
	)

const parseLimit = (text: string | undefined) => {
	if (text === undefined || text === "") return Effect.undefined
	const limit = Number(text)
	return Number.isInteger(limit) && limit >= 0
		? Effect.succeed(limit === 0 ? undefined : limit)
		: Effect.fail(
				new PromqlBadQueryError({ message: `invalid parameter "limit": cannot parse "${text}"` }),
			)
}

/** The `query` parameter, capped at the length the other PromQL routes take. */
const parseQuery = (text: string | undefined) =>
	text !== undefined && text.length > MAX_PROMQL_QUERY_LENGTH
		? Effect.fail(
				new PromqlBadQueryError({
					message: `invalid parameter "query": longer than ${MAX_PROMQL_QUERY_LENGTH} characters`,
				}),
			)
		: Effect.succeed(text ?? "")

/** Caps a query at the `timeout` parameter when one is given; Prometheus answers `timeout`. */
const withTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>, text: string | undefined) =>
	Effect.gen(function* () {
		if (text === undefined) return yield* effect
		const ms = yield* parseTimeout(text)
		return yield* Effect.timeoutOrElse(effect, {
			duration: ms,
			orElse: () =>
				Effect.fail(
					new PrometheusTimeoutError({
						message: `query timed out after ${text}; narrow the selector or use a larger step`,
					}),
				),
		})
	})

/** Prometheus reads an empty optional time parameter as absent. */
const present = (text: string | undefined): string | undefined => (text === "" ? undefined : text)

/** `[start, end]` of a discovery call; missing bounds mean the last `defaultMs` up to now. */
const discoveryWindow = (params: Params, defaultMs: number) =>
	Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis
		const end = present(params.end)
		const start = present(params.start)
		const endMs = end === undefined ? now : yield* parseTime("end", end)
		const startMs =
			start === undefined ? Math.max(endMs - defaultMs, -MAX_DATE_MS) : yield* parseTime("start", start)
		// Template-variable queries carry the dashboard range; read its most recent part.
		return { startMs: Math.max(startMs, endMs - MAX_DISCOVERY_MS), endMs }
	})

export const HttpV2PrometheusLive = HttpApiBuilder.group(MapleApiV2, "prometheus", (handlers) =>
	Effect.gen(function* () {
		const promql = yield* PromqlQueryService

		const instantQuery = Effect.fn("PrometheusApi.query")(function* (params: Params) {
			const tenant = yield* CurrentTenant.Context
			const now = yield* Clock.currentTimeMillis
			const query = yield* parseQuery(params.query)
			const time = present(params.time)
			const timeMs = time === undefined ? now : yield* parseTime("time", time)
			const limit = yield* parseLimit(params.limit)
			const answer = yield* withTimeout(
				promql.query(tenant, { query, startMs: timeMs, endMs: timeMs, stepMs: 0, instant: true }),
				present(params.timeout),
			)
			yield* Effect.annotateCurrentSpan({
				"maple.promql.result_type": answer.resultType,
				"maple.promql.result_series": seriesCount(answer),
			})
			const { result, warnings } = limitQueryResult(answer, limit)
			const sized = yield* checkResultSize(result)
			return { data: encodeQueryResult(sized), warnings: [...answer.warnings, ...warnings] }
		})

		const rangeQuery = Effect.fn("PrometheusApi.queryRange")(function* (params: Params) {
			const tenant = yield* CurrentTenant.Context
			const query = yield* parseQuery(params.query)
			const startMs = yield* parseTime("start", params.start ?? "")
			const endMs = yield* parseTime("end", params.end ?? "")
			const stepMs = yield* parseStep(params.step ?? "")
			const limit = yield* parseLimit(params.limit)
			// Range mode even when start equals end: Prometheus answers a one-point matrix.
			const answer = yield* withTimeout(
				promql.query(tenant, { query, startMs, endMs, stepMs, instant: false }),
				present(params.timeout),
			)
			yield* Effect.annotateCurrentSpan({
				"maple.promql.result_type": answer.resultType,
				"maple.promql.result_series": seriesCount(answer),
			})
			const { result, warnings } = limitQueryResult(answer, limit)
			const sized = yield* checkResultSize(result)
			return { data: encodeQueryResult(sized), warnings: [...answer.warnings, ...warnings] }
		})

		const discovery = (params: Params) =>
			Effect.gen(function* () {
				const window = yield* discoveryWindow(params, HOUR_MS)
				const limit = yield* parseLimit(params.limit)
				return { ...window, matches: params["match[]"] ?? [], limit }
			})

		const series = Effect.fn("PrometheusApi.series")(function* (params: Params) {
			const tenant = yield* CurrentTenant.Context
			const input = yield* discovery(params)
			return yield* promql.series(tenant, input)
		})

		const labels = Effect.fn("PrometheusApi.labels")(function* (params: Params) {
			const tenant = yield* CurrentTenant.Context
			const input = yield* discovery(params)
			return yield* promql.labelNames(tenant, input)
		})

		const labelValues = Effect.fn("PrometheusApi.labelValues")(function* (name: string, params: Params) {
			const tenant = yield* CurrentTenant.Context
			const input = yield* discovery(params)
			return yield* promql.labelValues(tenant, { ...input, name })
		})

		const metadata = Effect.fn("PrometheusApi.metadata")(function* (params: Params) {
			const tenant = yield* CurrentTenant.Context
			const window = yield* discoveryWindow(params, 24 * HOUR_MS)
			const limit = yield* parseLimit(params.limit)
			const found = yield* promql.metadata(tenant, { ...window, metric: params.metric, limit })
			return Rec.fromEntries([...found])
		})

		const formatQuery = Effect.fn("PrometheusApi.formatQuery")(function* (params: Params) {
			const query = yield* parseQuery(params.query)
			const parsed = parse(query)
			return Result.isSuccess(parsed)
				? print(parsed.success)
				: yield* new PromqlBadQueryError({
						message: parsed.failure.message,
						position: parsed.failure.position,
					})
		})

		return handlers
			.handle("query", ({ query }) => respondWithWarnings(instantQuery(query)))
			.handle("queryPost", ({ query, payload }) =>
				respondWithWarnings(instantQuery(merged(query, payload))),
			)
			.handle("queryRange", ({ query }) => respondWithWarnings(rangeQuery(query)))
			.handle("queryRangePost", ({ query, payload }) =>
				respondWithWarnings(rangeQuery(merged(query, payload))),
			)
			.handle("series", ({ query }) => respondWithWarnings(series(query)))
			.handle("seriesPost", ({ query, payload }) => respondWithWarnings(series(merged(query, payload))))
			.handle("labels", ({ query }) => respondWithWarnings(labels(query)))
			.handle("labelsPost", ({ query, payload }) => respondWithWarnings(labels(merged(query, payload))))
			.handle("labelValues", ({ params, query }) =>
				respondWithWarnings(labelValues(params.name, query)),
			)
			.handle("metadata", ({ query }) => respond(metadata(query)))
			.handle("buildInfo", () => respond(Effect.succeed(BUILD_INFO)))
			.handle("exemplars", () => respond(Effect.succeed([])))
			.handle("exemplarsPost", () => respond(Effect.succeed([])))
			.handle("formatQuery", ({ query }) => respond(formatQuery(query)))
			.handle("formatQueryPost", ({ query, payload }) => respond(formatQuery(merged(query, payload))))
			.handle("rules", () => respond(Effect.succeed({ groups: [] })))
			.handle("alerts", () => respond(Effect.succeed({ alerts: [] })))
			.handle("config", () => respond(Effect.succeed({ yaml: "" })))
			.handle("flags", () => respond(Effect.succeed({})))
	}),
)
