// The Prometheus HTTP API over Maple metrics. Handlers answer with raw responses so the body is
// Prometheus' own JSON, errors included; only authentication keeps the v2 envelope.

import { HttpApiBuilder } from "effect/http-api"
import { HttpServerResponse } from "effect/http"
import { Clock, Effect, Array as Arr, Record as Rec } from "effect"
import type { QueryResult } from "@maple/promql"
import { CurrentTenant } from "@maple/domain/http"
import { MapleApiV2, type PrometheusParams } from "@maple/domain/http/v2"
import { PromqlBadQueryError, PromqlQueryService } from "@maple/backend/services/promql/PromqlQueryService"
import {
	encodeQueryResult,
	limitQueryResult,
	errorBody,
	errorStatus,
	type PrometheusErrorType,
	MAX_DATE_MS,
	parseStep,
	parseTime,
	successBody,
} from "./prometheus-wire"

type Params = typeof PrometheusParams.Type

/** The version Grafana reads to enable Prometheus 3 features. */
export const PROMETHEUS_COMPAT_VERSION = "3.5.0"

const HOUR_MS = 3_600_000

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

const limited = (values: ReadonlyArray<string>, limit: number | undefined) =>
	limit === undefined ? values : Arr.take(values, limit)

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

/** A query error as Prometheus' error envelope; warehouse failures never leak their diagnostics. */
const toErrorResponse = <E extends { readonly _tag: string; readonly message: string }>(error: E) => {
	switch (error._tag) {
		case "@maple/backend/promql/PromqlBadQueryError":
			return errorResponse("bad_data", error.message)
		case "@maple/backend/promql/PromqlExecutionError":
			return errorResponse("execution", error.message)
		default:
			return Effect.andThen(
				Effect.logWarning("Prometheus API warehouse read failed", error),
				errorResponse("unavailable", "the metric store is unavailable, try again"),
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

/** A query answer with Prometheus' `warnings` beside `data`. */
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

/** `[start, end]` of a discovery call; missing bounds mean the last `defaultMs` up to now. */
const discoveryWindow = (params: Params, defaultMs: number) =>
	Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis
		const endMs = params.end === undefined ? now : yield* parseTime("end", params.end)
		const startMs =
			params.start === undefined
				? Math.max(endMs - defaultMs, -MAX_DATE_MS)
				: yield* parseTime("start", params.start)
		return { startMs, endMs }
	})

export const HttpV2PrometheusLive = HttpApiBuilder.group(MapleApiV2, "prometheus", (handlers) =>
	Effect.gen(function* () {
		const promql = yield* PromqlQueryService

		const instantQuery = Effect.fn("PrometheusApi.query")(function* (params: Params) {
			const tenant = yield* CurrentTenant.Context
			const now = yield* Clock.currentTimeMillis
			const timeMs = params.time === undefined ? now : yield* parseTime("time", params.time)
			const limit = yield* parseLimit(params.limit)
			const answer = yield* promql.query(tenant, {
				query: params.query ?? "",
				startMs: timeMs,
				endMs: timeMs,
				stepMs: 0,
				instant: true,
			})
			yield* Effect.annotateCurrentSpan({
				"maple.promql.result_type": answer.resultType,
				"maple.promql.result_series": seriesCount(answer),
			})
			const { result, warnings } = limitQueryResult(answer, limit)
			return { data: encodeQueryResult(result), warnings }
		})

		const rangeQuery = Effect.fn("PrometheusApi.queryRange")(function* (params: Params) {
			const tenant = yield* CurrentTenant.Context
			const startMs = yield* parseTime("start", params.start ?? "")
			const endMs = yield* parseTime("end", params.end ?? "")
			const stepMs = yield* parseStep(params.step ?? "")
			const limit = yield* parseLimit(params.limit)
			// Range mode even when start equals end: Prometheus answers a one-point matrix.
			const answer = yield* promql.query(tenant, {
				query: params.query ?? "",
				startMs,
				endMs,
				stepMs,
				instant: false,
			})
			yield* Effect.annotateCurrentSpan({
				"maple.promql.result_type": answer.resultType,
				"maple.promql.result_series": seriesCount(answer),
			})
			const { result, warnings } = limitQueryResult(answer, limit)
			return { data: encodeQueryResult(result), warnings }
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
			const names = yield* promql.labelNames(tenant, input)
			return limited(names, input.limit)
		})

		const labelValues = Effect.fn("PrometheusApi.labelValues")(function* (name: string, params: Params) {
			const tenant = yield* CurrentTenant.Context
			const input = yield* discovery(params)
			const values = yield* promql.labelValues(tenant, { ...input, name })
			return limited(values, input.limit)
		})

		const metadata = Effect.fn("PrometheusApi.metadata")(function* (params: Params) {
			const tenant = yield* CurrentTenant.Context
			const window = yield* discoveryWindow(params, 24 * HOUR_MS)
			const limit = yield* parseLimit(params.limit)
			const found = yield* promql.metadata(tenant, { ...window, metric: params.metric, limit })
			return Rec.fromEntries([...found])
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
			.handle("series", ({ query }) => respond(series(query)))
			.handle("seriesPost", ({ query, payload }) => respond(series(merged(query, payload))))
			.handle("labels", ({ query }) => respond(labels(query)))
			.handle("labelsPost", ({ query, payload }) => respond(labels(merged(query, payload))))
			.handle("labelValues", ({ params, query }) => respond(labelValues(params.name, query)))
			.handle("metadata", ({ query }) => respond(metadata(query)))
			.handle("buildInfo", () => respond(Effect.succeed(BUILD_INFO)))
			.handle("exemplars", () => respond(Effect.succeed([])))
			.handle("exemplarsPost", () => respond(Effect.succeed([])))
	}),
)
