// Traces with no root span
//
// `trace_list_mv` holds parentless spans, so a trace whose root never reached
// Maple (a proxy injected `traceparent` without exporting its span, or the root
// was dropped) has no row there. `trace_list_entry_spans` holds every
// Server/Consumer span that has a parent. Whether that parent is stored is
// unknowable at insert, so the read decides: an entry span stands in for its
// trace when no root span of the trace started in the range read or the hour
// before it.
//
// Ruling a trace out means reading root TraceIds, which no rollup can do, so
// every reader here is bounded: the trace list checks only the traces of the
// page being cut (`rootedTraceIdsQuery`), the trace search only the traces its
// filters matched, and the window aggregates stop at a row budget and say so
// (`rootlessOmittedQuery`).

import type { DateTime } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import * as T from "@maple-dev/effect-orm/clickhouse"
import {
	from,
	fromQuery,
	notInSubquery,
	subqueryCond,
	type ColumnAccessor,
} from "@maple-dev/effect-orm/clickhouse"
import { TraceListEntrySpans, TraceListMv, orgIdParam, utcSecondsParam } from "../tables"

/** Rows of each table one window aggregate (a facet branch, the stats, slow traces) may read. */
export const ROOTLESS_ROOT_BUDGET = 250_000
export const ROOTLESS_ENTRY_BUDGET = 1_000_000
/**
 * Root spans one trace-list page may read to rule its candidates out: about
 * half a second of `trace_list_mv` (measured at 0.3 s for 1.8 million).
 */
export const ROOTLESS_PAGE_ROOT_BUDGET = 3_000_000

/**
 * A root span is exported when its trace ends, after its children. Until then
 * every trace looks rootless, so an entry span stands in only once it is this
 * old; a rootless trace is listed that much later than a rooted one.
 */
const SETTLE_SECONDS = 30

export const settledEntrySpan = (timestamp: CH.Expr<DateTime.Utc>) =>
	timestamp.lte(CH.rawExpr(`now() - INTERVAL ${SETTLE_SECONDS} SECOND`, T.dateTime))

/** Root spans from an hour before `startTime`: a root starts before its entry spans. */
export const rootsInWindow = ($: ColumnAccessor<typeof TraceListMv.columns>) => [
	$.OrgId.eq(orgIdParam),
	// The hour the trace list already allows a trace to span (`traceListQuery`'s stage-2 pad).
	$.Timestamp.gte(
		CH.compileTypedFnCall(
			"subtractHours",
			T.dateTime.schema,
			CH.toDateTime(utcSecondsParam("startTime")),
			CH.lit(1),
		),
	),
	$.Timestamp.lte(utcSecondsParam("endTime")),
]

/** Entry spans in the `startTime` / `endTime` window. */
export const entriesInWindow = ($: ColumnAccessor<typeof TraceListEntrySpans.columns>) => [
	$.OrgId.eq(orgIdParam),
	$.Timestamp.gte(utcSecondsParam("startTime")),
	$.Timestamp.lte(utcSecondsParam("endTime")),
]

const rootProbe = (budget: number) =>
	from(TraceListMv)
		.select(() => ({ one: CH.lit(1) }))
		.where(rootsInWindow)
		.limit(budget + 1)

const entryProbe = from(TraceListEntrySpans)
	.select(() => ({ one: CH.lit(1) }))
	.where(entriesInWindow)
	.limit(ROOTLESS_ENTRY_BUDGET + 1)

// Scalar subqueries: folded to constants before any table is read, so a window
// past the budget costs these two bounded counts and nothing else.
const rootsWithin = (budget: number) =>
	subqueryCond(rootProbe(budget), (sql) => `(SELECT count() FROM (${sql})) <= ${budget}`)
const entriesWithinBudget = subqueryCond(
	entryProbe,
	(sql) => `(SELECT count() FROM (${sql})) <= ${ROOTLESS_ENTRY_BUDGET}`,
)

// Hashed: the set holds 8 bytes per root, not a 32-character id.
const rootTraceIds = from(TraceListMv)
	.select(($) => ({ id: CH.cityHash64($.TraceId) }))
	.where(($) => [...rootsInWindow($), rootsWithin(ROOTLESS_ROOT_BUDGET), entriesWithinBudget])

/**
 * Keeps the settled entry spans of traces that have no root span, for a read
 * over the whole `startTime` / `endTime` window; false throughout once either
 * table holds more rows than its budget. The caller filters `OrgId` and the
 * window on its own table.
 */
export const rootlessTraceConditions = (traceId: CH.Expr<string>, timestamp: CH.Expr<DateTime.Utc>) => [
	settledEntrySpan(timestamp),
	rootsWithin(ROOTLESS_ROOT_BUDGET),
	entriesWithinBudget,
	notInSubquery(CH.cityHash64(traceId), rootTraceIds),
]

/**
 * One row when the window holds entry spans but `rootlessTraceConditions` gave
 * up on it: the aggregates then cover rooted traces only, and say so.
 */
export function rootlessOmittedQuery() {
	return from(TraceListEntrySpans)
		.select(() => ({ omitted: CH.lit(1) }))
		.where(($) => [
			...entriesInWindow($),
			settledEntrySpan($.Timestamp),
			CH.not(CH.and(rootsWithin(ROOTLESS_ROOT_BUDGET), entriesWithinBudget)),
		])
		.limit(1)
		.format("JSON")
}

/**
 * Which of a list page's candidate traces have a root span. `startTime` /
 * `endTime` are the candidates' own bounds, not the caller's window, so the
 * read is as wide as the page and no wider; none when that range holds more
 * than `ROOTLESS_PAGE_ROOT_BUDGET` roots (`rootSpansInRangeQuery` tells).
 */
export function rootedTraceIdsQuery(traceIds: ReadonlyArray<string>) {
	return from(TraceListMv)
		.select(($) => ({ traceId: $.TraceId }))
		.where(($) => [
			...rootsInWindow($),
			rootsWithin(ROOTLESS_PAGE_ROOT_BUDGET),
			$.TraceId.in_(...traceIds),
		])
		.format("JSON")
}

/** Root spans in that range, counted up to one past `ROOTLESS_PAGE_ROOT_BUDGET`. */
export function rootSpansInRangeQuery() {
	return fromQuery(rootProbe(ROOTLESS_PAGE_ROOT_BUDGET), "probe")
		.select(() => ({ roots: CH.count() }))
		.format("JSON")
}
