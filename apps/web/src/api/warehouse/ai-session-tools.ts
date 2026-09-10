// The four warehouse reads behind `/agent-sessions/tools`, and the only place
// in the web app that sees their wire shape.
//
// One `map*` function per endpoint, deliberately: everything downstream speaks
// the view model in `lib/agent-sessions/tool-analytics.ts` (epoch-ms buckets,
// `ToolMeasures`), so a contract change lands in one function rather than in
// every table that reads a column.
//
// Two conversions happen here and nowhere else. Buckets arrive as ISO-8601 with
// a literal `Z` and `lastSeen` / `startedAt` as bare warehouse datetimes;
// `toEpochMs` reads both as UTC, where `new Date(value)` would read the bare
// form as local time. Durations stay in nanoseconds all the way to the
// formatters.

import { Effect, Schema } from "effect"
import {
	AI_TOOLS_OTHER_SERIES_KEY,
	AiToolsBreakdownsRequest,
	AiToolsSeriesRequest,
	AiToolsSessionsRequest,
	AiToolsTotalsRequest,
	type AiToolsAggregate,
	type AiToolsBreakdownItem,
	type AiToolsSeriesResponse,
	type AiToolsSessionItem,
} from "@maple/domain/http"
import { toEpochMs } from "@maple/ui/lib/time-format"

import {
	OTHER_SERIES_KEY,
	type ToolBreakdownRow,
	type ToolSeriesPoint,
	type ToolSessionRow,
	type ToolTotals,
} from "@/lib/agent-sessions/tool-analytics"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"

import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "./effect-utils"

/**
 * The page's selection, as all four endpoints take it.
 *
 * `tool`, `model`, `service` and `env` are exact matches on facet values;
 * `search` is a tool-name substring and `failingOnly` keeps failed calls alone.
 *
 * Sent identically to all four so the numbers can never disagree about what
 * they are counting: a totals read narrower than the series read would make the
 * tile and the chart tell different stories about one window.
 */
const AiToolsSelection = Schema.Struct({
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
	tool: Schema.optional(Schema.String),
	model: Schema.optional(Schema.String),
	service: Schema.optional(Schema.String),
	env: Schema.optional(Schema.String),
	/** Tool-name substring. Non-empty — the caller drops a blank box rather than
	 *  sending one, which the contract refuses. */
	search: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
	failingOnly: Schema.optional(Schema.Boolean),
})
export type AiToolsSelection = Schema.Schema.Type<typeof AiToolsSelection>

const AiToolSeriesInput = Schema.Struct({
	...AiToolsSelection.fields,
	bucketSeconds: Schema.Number,
})
export type AiToolSeriesInput = Schema.Schema.Type<typeof AiToolSeriesInput>

const AiToolSessionsInput = Schema.Struct({
	...AiToolsSelection.fields,
	limit: Schema.optional(Schema.Number),
})
export type AiToolSessionsInput = Schema.Schema.Type<typeof AiToolSessionsInput>

/** The selection minus the window, spread into a request payload. */
const selectionFields = (input: AiToolsSelection) => ({
	...(input.tool !== undefined && { tool: input.tool }),
	...(input.model !== undefined && { model: input.model }),
	...(input.service !== undefined && { service: input.service }),
	...(input.env !== undefined && { env: input.env }),
	...(input.search !== undefined && { search: input.search }),
	...(input.failingOnly !== undefined && { failingOnly: input.failingOnly }),
})

/* -------------------------------------------------------------------------------------------------
 * Mappers
 * -----------------------------------------------------------------------------------------------*/

const measuresOf = (row: AiToolsAggregate): ToolTotals => ({
	calls: row.calls,
	sessions: row.sessions,
	errors: row.errors,
	p50: row.p50,
	p90: row.p90,
	p95: row.p95,
})

/**
 * The API's two synthetic keys, in the words the page uses for them.
 *
 * `''` is a real key: a tool call whose model resolved to neither its parent
 * call's nor its trace's. `other` is the API's own folded tail, which becomes
 * the page's tail so the chart's second fold merges into it rather than
 * ranking it as a series of its own.
 */
const seriesKeyOf = (key: string): string => {
	if (key === "") return "Unattributed"
	return key === AI_TOOLS_OTHER_SERIES_KEY ? OTHER_SERIES_KEY : key
}

export function mapToolSeries(response: AiToolsSeriesResponse): ReadonlyArray<ToolSeriesPoint> {
	return response.data.map((row) => ({
		bucket: toEpochMs(row.bucket),
		seriesKey: seriesKeyOf(row.seriesKey),
		...measuresOf(row),
	}))
}

export function mapToolBreakdown(
	rows: ReadonlyArray<AiToolsBreakdownItem>,
): ReadonlyArray<ToolBreakdownRow> {
	return rows.map((row) => ({ key: row.key, ...measuresOf(row), lastSeen: toEpochMs(row.lastSeen) }))
}

export function mapToolSessions(
	rows: ReadonlyArray<AiToolsSessionItem>,
): ReadonlyArray<ToolSessionRow> {
	return rows.map((row) => ({
		sessionId: row.sessionId,
		agentName: row.agentName,
		model: row.model,
		serviceName: row.serviceName,
		calls: row.calls,
		errors: row.errors,
		avgDurationNs: row.avgDurationNs,
		maxDurationNs: row.maxDurationNs,
		startedAt: toEpochMs(row.startedAt),
	}))
}

/* -------------------------------------------------------------------------------------------------
 * The reads
 * -----------------------------------------------------------------------------------------------*/

/**
 * The chart's series. What they are keyed by is the server's decision, derived
 * from the selection — the response says which in `seriesKind`, and the client
 * carries that through rather than re-deriving it.
 */
export const getAiToolSeries = Effect.fn("AiSessionTools.series")(function* ({
	data,
}: {
	data: AiToolSeriesInput
}) {
	const input = yield* decodeInput(AiToolSeriesInput, data, "aiToolSeries")
	const result = yield* runWarehouseQuery("aiToolSeries", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.aiSessionsInternal.toolsSeries({
				payload: new AiToolsSeriesRequest({
					startTime: input.startTime,
					endTime: input.endTime,
					bucketSeconds: input.bucketSeconds,
					...selectionFields(input),
				}),
			})
		}),
	)
	return { data: mapToolSeries(result), seriesKind: result.seriesKind }
})

/** Both windows in one read — the current one and the equal-length one before it. */
export const getAiToolTotals = Effect.fn("AiSessionTools.totals")(function* ({
	data,
}: {
	data: AiToolsSelection
}) {
	const input = yield* decodeInput(AiToolsSelection, data, "aiToolTotals")
	const result = yield* runWarehouseQuery("aiToolTotals", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.aiSessionsInternal.toolsTotals({
				payload: new AiToolsTotalsRequest({
					startTime: input.startTime,
					endTime: input.endTime,
					...selectionFields(input),
				}),
			})
		}),
	)
	return {
		current: measuresOf(result.current),
		// Nothing ran in the comparison window reads as "no comparison", not as
		// -100%: `metricDelta` refuses to divide by a previous window of zero.
		previous: measuresOf(result.previous),
	}
})

/**
 * Both breakdown panels in one read.
 *
 * One endpoint rather than two because the scoping is asymmetric and the server
 * owns it: `tools` is scoped to the selected model but not to the selected
 * tool, and `models` the reverse, so neither panel can strand the reader on a
 * table holding only the row they already picked.
 */
export const getAiToolBreakdowns = Effect.fn("AiSessionTools.breakdowns")(function* ({
	data,
}: {
	data: AiToolsSelection
}) {
	const input = yield* decodeInput(AiToolsSelection, data, "aiToolBreakdowns")
	const result = yield* runWarehouseQuery("aiToolBreakdowns", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.aiSessionsInternal.toolsBreakdowns({
				payload: new AiToolsBreakdownsRequest({
					startTime: input.startTime,
					endTime: input.endTime,
					...selectionFields(input),
				}),
			})
		}),
	)
	return { tools: mapToolBreakdown(result.tools), models: mapToolBreakdown(result.models) }
})

/** The busiest sessions matching the selection. Ordered by calls, not paged. */
export const getAiToolSessions = Effect.fn("AiSessionTools.sessions")(function* ({
	data,
}: {
	data: AiToolSessionsInput
}) {
	const input = yield* decodeInput(AiToolSessionsInput, data, "aiToolSessions")
	const result = yield* runWarehouseQuery("aiToolSessions", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.aiSessionsInternal.toolsSessions({
				payload: new AiToolsSessionsRequest({
					startTime: input.startTime,
					endTime: input.endTime,
					...selectionFields(input),
					...(input.limit !== undefined && { limit: input.limit }),
				}),
			})
		}),
	)
	return { data: mapToolSessions(result.data) }
})
