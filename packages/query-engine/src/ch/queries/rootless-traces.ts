// Traces with no root span
//
// `trace_list_mv` holds parentless spans, so a trace whose root never reached
// Maple (a proxy injected `traceparent` without exporting its span, or the root
// was dropped) has no row there. `trace_list_entry_spans` holds every
// Server/Consumer span that has a parent. Whether that parent is stored is
// unknowable at insert, so the read decides: an entry span stands in for its
// trace when no root span of the trace started in the window or the hour before.

import * as CH from "@maple-dev/effect-orm/expr"
import * as T from "@maple-dev/effect-orm/clickhouse"
import { from, notInSubquery, subqueryCond, type ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import { TraceListMv, orgIdParam, utcSecondsParam } from "../tables"

/**
 * Ruling a trace out reads one `trace_list_mv` TraceId per root span in the
 * window. Past this many the fallback is off and only rooted traces are read,
 * as before: it serves windows whose traces mostly lack roots, not a per-trace
 * scan of a busy organization's roots.
 */
export const ROOTLESS_ROOT_BUDGET = 250_000

const rootsInWindow = ($: ColumnAccessor<typeof TraceListMv.columns>) => [
	$.OrgId.eq(orgIdParam),
	// A root starts before its entry spans, within the hour the trace list
	// already allows a trace to span (`traceListQuery`'s stage-2 pad).
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

// Folded to a constant before any table is read, so an over-budget window costs
// this probe (at most BUDGET + 1 index rows) and nothing else.
const withinBudget = subqueryCond(
	from(TraceListMv)
		.select(() => ({ one: CH.lit(1) }))
		.where(rootsInWindow)
		.limit(ROOTLESS_ROOT_BUDGET + 1),
	(sql) => `(SELECT count() FROM (${sql})) <= ${ROOTLESS_ROOT_BUDGET}`,
)

// Hashed: the set holds 8 bytes per root, not a 32-character id.
const rootTraceIds = from(TraceListMv)
	.select(($) => ({ id: CH.cityHash64($.TraceId) }))
	.where(($) => [...rootsInWindow($), withinBudget])

/**
 * Keeps the entry spans of traces that have no root span. Needs the
 * `startTime` / `endTime` params; the caller filters `OrgId` and the window on
 * its own table.
 */
export const rootlessTraceConditions = (traceId: CH.Expr<string>) => [
	withinBudget,
	notInSubquery(CH.cityHash64(traceId), rootTraceIds),
]
