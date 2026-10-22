import { CH } from "@maple/query-engine"
import type { TimeBounds } from "../../lib/time"
import { parseAttributes } from "@maple/ui/lib/span-tree"
import { type DateTime, Effect } from "effect"
import { localParams, queryRows } from "../../data/local-query"
import type { TraceFilters } from "./filters"
import type { TraceRow } from "./model"

// The traces list: keyset-paged on (root timestamp, TraceId).

export const PAGE_SIZE = 25

export interface TraceCursor {
	readonly timestamp: DateTime.Utc
	readonly traceId: string
}

const rootScopedPage = (
	filters: TraceFilters,
	bounds: TimeBounds,
	cursor: TraceCursor | undefined,
	apiBase: string,
) => {
	// HTTP method/status have no first-class list opts; the web app filters them as attributes too.
	const attributeFilters = [
		...(filters.method ? [{ key: "http.method", value: filters.method, mode: "equals" as const }] : []),
		...(filters.status
			? [{ key: "http.status_code", value: filters.status, mode: "equals" as const }]
			: []),
	]
	const compiled = CH.compile(
		CH.traceListQuery({
			limit: PAGE_SIZE,
			cursor,
			serviceName: filters.service,
			spanName: filters.span ?? filters.search,
			matchModes: !filters.span && filters.search ? { spanName: "contains" } : undefined,
			// `errorsOnly: false` means "only non-errored" in the engine; off means "no filter".
			errorsOnly: filters.errorsOnly || undefined,
			environments: filters.env ? [filters.env] : undefined,
			namespaces: filters.ns ? [filters.ns] : undefined,
			minDurationMs: filters.minDurationMs,
			maxDurationMs: filters.maxDurationMs,
			attributeFilters: attributeFilters.length > 0 ? attributeFilters : undefined,
		}),
		localParams(bounds),
	)
	return Effect.map(queryRows(compiled, apiBase), (rows) =>
		rows.map((row): TraceRow => ({
			traceId: row.traceId,
			startTime: row.startTime,
			durationMs: row.durationMicros / 1000,
			spanCount: row.spanCount,
			services: row.services,
			rootSpanName: row.rootSpanName,
			rootSpanKind: row.rootSpanKind,
			rootSpanAttributes: parseAttributes(row.rootSpanAttributes),
			hasError: row.hasError === 1,
		})),
	)
}

const httpAttributes = (row: CH.TraceSummaryOutput): Record<string, string> => {
	const attrs: Record<string, string> = {}
	if (row.httpMethod) attrs["http.method"] = row.httpMethod
	if (row.httpRoute) attrs["http.route"] = row.httpRoute
	if (row.httpStatusCode) attrs["http.status_code"] = row.httpStatusCode
	return attrs
}

/** Span mode: the summaries read the roots-only MV, so counts and services come from a follow-up. */
const spanScopedPage = (
	filters: TraceFilters,
	bounds: TimeBounds,
	cursor: TraceCursor | undefined,
	apiBase: string,
) =>
	Effect.gen(function* () {
		const params = localParams(bounds)
		const summaries = yield* queryRows(
			CH.compile(
				CH.traceSummariesQuery({
					limit: PAGE_SIZE,
					cursor,
					serviceName: filters.service,
					spanName: filters.span ?? filters.search,
					matchModes: !filters.span && filters.search ? { spanName: "contains" } : undefined,
					hasError: filters.errorsOnly || undefined,
					httpMethod: filters.method,
					httpStatusCode: filters.status,
					deploymentEnv: filters.env,
					namespace: filters.ns,
					minDurationMs: filters.minDurationMs,
					maxDurationMs: filters.maxDurationMs,
				}),
				params,
			),
			apiBase,
		)
		const traceIds = summaries.map((row) => row.traceId)
		const stats =
			traceIds.length === 0
				? []
				: yield* queryRows(
						CH.compile(CH.traceSpanStatsByTraceIdsQuery({ traceIds }), params),
						apiBase,
					)
		const statsByTrace = new Map(stats.map((row) => [row.traceId, row]))
		return summaries.map((row): TraceRow => ({
			traceId: row.traceId,
			startTime: row.startTime,
			durationMs: row.durationMs,
			spanCount: statsByTrace.get(row.traceId)?.spanCount ?? null,
			services: statsByTrace.get(row.traceId)?.services ?? [row.rootServiceName],
			rootSpanName: row.rootSpanName,
			rootSpanKind: row.rootSpanKind,
			rootSpanAttributes: httpAttributes(row),
			hasError: row.hasError > 0,
		}))
	})

/** One page of either scope. */
export const fetchTracePage = (
	filters: TraceFilters,
	bounds: TimeBounds,
	cursor: TraceCursor | undefined,
	apiBase: string,
) =>
	filters.scope === "spans"
		? spanScopedPage(filters, bounds, cursor, apiBase)
		: rootScopedPage(filters, bounds, cursor, apiBase)

/** `getNextPageParam`: only a full page asks for another. */
export const nextCursor = (page: ReadonlyArray<TraceRow>): TraceCursor | undefined => {
	const last = page.length === PAGE_SIZE ? page[page.length - 1] : undefined
	return last ? { timestamp: last.startTime, traceId: last.traceId } : undefined
}
