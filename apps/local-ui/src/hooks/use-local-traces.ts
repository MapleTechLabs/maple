import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { parseAttributes } from "@maple/ui/lib/span-tree"
import { boundsKey, executeLocalCompiledQuery, localParams, noCursor } from "@/lib/query"
import type { TimeBounds } from "../lib/time"

const PAGE_SIZE = 25

export interface TraceFilters {
	/** Root mode: the trace's entry service. Span mode: any span's service. */
	service?: string
	/** Toolbar search: substring match on the root span name (root mode) or any span name (span mode). */
	search?: string
	/**
	 * Exact span name. Root mode: the root span (sidebar facet; wins over
	 * `search`). Span mode: any span (an operation drill-down).
	 */
	span?: string
	/** Only errored traces (root mode: root span errored; span mode: a matching span errored). */
	errorsOnly?: boolean
	method?: string
	status?: string
	env?: string
	ns?: string
	minDurationMs?: number
	maxDurationMs?: number
	/**
	 * `spans` lists traces containing any span that fits the filters. Drill-downs
	 * from a service need it: most services never own a trace's root span.
	 */
	scope?: "root" | "spans"
}

/** One trace in the list, whichever query produced it. */
export interface TraceRow {
	readonly traceId: string
	/** Root span timestamp: the keyset cursor field, paired with `traceId`. */
	readonly startTime: string
	readonly durationMs: number
	/** Null only when a span-mode trace's spans could not be counted. */
	readonly spanCount: number | null
	readonly services: readonly string[]
	readonly rootSpanName: string
	readonly rootSpanKind: string
	readonly rootSpanAttributes: Record<string, string>
	readonly hasError: boolean
}

interface TraceCursor {
	timestamp: string
	traceId: string
}

function httpAttributes(row: CH.TraceSummaryOutput): Record<string, string> {
	const attrs: Record<string, string> = {}
	if (row.httpMethod) attrs["http.method"] = row.httpMethod
	if (row.httpRoute) attrs["http.route"] = row.httpRoute
	if (row.httpStatusCode) attrs["http.status_code"] = row.httpStatusCode
	return attrs
}

async function rootScopedPage(
	filters: TraceFilters,
	bounds: TimeBounds,
	cursor: TraceCursor | undefined,
	signal: AbortSignal,
): Promise<ReadonlyArray<TraceRow>> {
	// HTTP method/status have no first-class list opts; the web app filters them
	// as span attribute filters too (old-semconv keys, matching prod).
	const attributeFilters = [
		...(filters.method ? [{ key: "http.method", value: filters.method, mode: "equals" as const }] : []),
		...(filters.status
			? [{ key: "http.status_code", value: filters.status, mode: "equals" as const }]
			: []),
	]
	const rows = await executeLocalCompiledQuery(
		CH.compile(
			CH.traceListQuery({
				limit: PAGE_SIZE,
				cursor,
				serviceName: filters.service,
				spanName: filters.span ?? filters.search,
				matchModes: !filters.span && filters.search ? { spanName: "contains" } : undefined,
				// `errorsOnly: false` means "only non-errored" in the engine; the
				// checkbox being off must mean "no filter".
				errorsOnly: filters.errorsOnly || undefined,
				environments: filters.env ? [filters.env] : undefined,
				namespaces: filters.ns ? [filters.ns] : undefined,
				minDurationMs: filters.minDurationMs,
				maxDurationMs: filters.maxDurationMs,
				attributeFilters: attributeFilters.length > 0 ? attributeFilters : undefined,
			}),
			localParams(bounds),
		),
		signal,
	)
	return rows.map((row) => ({
		traceId: row.traceId,
		startTime: row.startTime,
		durationMs: row.durationMicros / 1000,
		spanCount: row.spanCount,
		services: row.services,
		rootSpanName: row.rootSpanName,
		rootSpanKind: row.rootSpanKind,
		rootSpanAttributes: parseAttributes(row.rootSpanAttributes),
		hasError: row.hasError === 1,
	}))
}

const spanCountOf = (stats: { readonly spanCount: number } | undefined): number | null =>
	stats === undefined ? null : Number(stats.spanCount)

async function spanScopedPage(
	filters: TraceFilters,
	bounds: TimeBounds,
	cursor: TraceCursor | undefined,
	signal: AbortSignal,
): Promise<ReadonlyArray<TraceRow>> {
	const params = localParams(bounds)
	const summaries = await executeLocalCompiledQuery(
		CH.compile(
			CH.traceSummariesQuery({
				limit: PAGE_SIZE,
				cursor,
				serviceName: filters.service,
				// Same precedence as root mode: an exact drill-down span wins over the search.
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
		signal,
	)
	// The summaries read the roots-only MV, so span counts and services come from one page-sized follow-up.
	const traceIds = summaries.map((row) => row.traceId)
	const stats =
		traceIds.length === 0
			? []
			: await executeLocalCompiledQuery(
					CH.compile(CH.traceSpanStatsByTraceIdsQuery({ traceIds }), params),
					signal,
				)
	const statsByTrace = new Map(stats.map((row) => [row.traceId, row]))
	return summaries.map((row) => ({
		traceId: row.traceId,
		startTime: row.startTime,
		durationMs: Number(row.durationMs),
		spanCount: spanCountOf(statsByTrace.get(row.traceId)),
		services: statsByTrace.get(row.traceId)?.services ?? [row.rootServiceName],
		rootSpanName: row.rootSpanName,
		rootSpanKind: row.rootSpanKind,
		rootSpanAttributes: httpAttributes(row),
		hasError: Number(row.hasError) > 0,
	}))
}

/** Infinite list of traces, newest first, keyset-paged on (root timestamp, TraceId). */
export function useLocalTraces(filters: TraceFilters, bounds: TimeBounds) {
	return useInfiniteQuery({
		queryKey: ["local", "traces", filters, boundsKey(bounds)],
		initialPageParam: noCursor<TraceCursor>(),
		placeholderData: keepPreviousData,
		queryFn: ({ pageParam, signal }) =>
			filters.scope === "spans"
				? spanScopedPage(filters, bounds, pageParam, signal)
				: rootScopedPage(filters, bounds, pageParam, signal),
		getNextPageParam: (lastPage): TraceCursor | undefined => {
			const last = lastPage.length === PAGE_SIZE ? lastPage[lastPage.length - 1] : undefined
			return last ? { timestamp: last.startTime, traceId: last.traceId } : undefined
		},
	})
}
