// The warehouse reads behind `/agent-sessions/tools` and its detail page, and
// the only place in the web app that sees their wire shape.
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
	AiToolErrorDetailRequest,
	AiToolErrorsRequest,
	AiToolsBreakdownsRequest,
	AiToolsSeriesRequest,
	AiToolsTotalsRequest,
	AI_TOOL_ERRORS_MAX,
	type AiToolsAggregate,
	type AiToolsBreakdownItem,
	type AiToolErrorItem,
	type AiToolErrorOccurrence,
	type AiToolErrorSessionItem,
	type AiToolsSeriesResponse,
} from "@maple/domain/http"
import { toEpochMs } from "@maple/ui/lib/time-format"

import {
	OTHER_SERIES_KEY,
	breakdownKeyLabel,
	type ToolBreakdownRow,
	type ToolErrorOccurrenceRow,
	type ToolErrorRow,
	type ToolErrorSessionRow,
	type ToolSeriesPoint,
	type ToolTotals,
} from "@/lib/agent-sessions/tool-analytics"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"

import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "./effect-utils"

/**
 * The page's selection, as every endpoint takes it.
 *
 * `tool`, `model`, `service` and `env` are exact matches on facet values;
 * `search` is a tool-name substring and `failingOnly` keeps failed calls alone.
 *
 * Sent identically to all of them so the numbers can never disagree about what
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
	/** Absent lets the server derive the split from the selection. The detail
	 *  page sends `none` — see the domain request. */
	split: Schema.optional(Schema.Literals(["tool", "model", "none"])),
})
export type AiToolSeriesInput = Schema.Schema.Type<typeof AiToolSeriesInput>

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
	return key === AI_TOOLS_OTHER_SERIES_KEY ? OTHER_SERIES_KEY : breakdownKeyLabel(key)
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
	return rows.map((row) => ({
		key: row.key,
		...measuresOf(row),
		lastSeen: toEpochMs(row.lastSeen),
		firstSeen: toEpochMs(row.firstSeen),
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
					...(input.split !== undefined && { split: input.split }),
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
		// -100%: `toolDelta` refuses to divide by a previous window of zero.
		previous: measuresOf(result.previous),
		allSessions: result.allSessions,
		// `''` where nothing matched, which `toEpochMs` reads as NaN — the header
		// drops the clause rather than printing an Invalid Date.
		firstSeen: toEpochMs(result.firstSeen),
		lastSeen: toEpochMs(result.lastSeen),
	}
})

/**
 * The Tools table's rows.
 *
 * Scoped to the rest of the selection but not to the selected tool — the table
 * is how a reader picks a different one, so filtering by the current one would
 * strand them on the single row they already clicked.
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
	return { tools: mapToolBreakdown(result.tools) }
})

/* -------------------------------------------------------------------------------------------------
 * Tool detail — failures
 * -----------------------------------------------------------------------------------------------*/

/**
 * The bounds here MIRROR the domain request's, deliberately.
 *
 * `decodeInput` turns a violation into a `WarehouseDecodeError` the page can
 * render; the domain constructor below throws, which is a defect. A value that
 * only the constructor refuses would therefore crash the page rather than fail
 * the read.
 */
const AiToolErrorsInput = Schema.Struct({
	...AiToolsSelection.fields,
	/** Required here: these reads are one tool's. */
	tool: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
	limit: Schema.optional(
		Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: AI_TOOL_ERRORS_MAX })),
	),
})
export type AiToolErrorsInput = Schema.Schema.Type<typeof AiToolErrorsInput>

const AiToolErrorDetailInput = Schema.Struct({
	...AiToolErrorsInput.fields,
	/** `''` is the group of failures that named no type — the `unknown` row. */
	errorType: Schema.String.check(Schema.isMaxLength(200)),
	session: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400))),
})
export type AiToolErrorDetailInput = Schema.Schema.Type<typeof AiToolErrorDetailInput>

export function mapToolErrors(rows: ReadonlyArray<AiToolErrorItem>): ReadonlyArray<ToolErrorRow> {
	return rows.map((row) => ({
		errorType: row.errorType,
		message: row.message,
		calls: row.calls,
		sessions: row.sessions,
		firstSeen: toEpochMs(row.firstSeen),
		lastSeen: toEpochMs(row.lastSeen),
	}))
}

const mapErrorSessions = (
	rows: ReadonlyArray<AiToolErrorSessionItem>,
): ReadonlyArray<ToolErrorSessionRow> =>
	rows.map((row) => ({
		sessionId: row.sessionId,
		agentName: row.agentName,
		model: row.model,
		hits: row.hits,
		lastSeen: toEpochMs(row.lastSeen),
	}))

const mapOccurrences = (
	rows: ReadonlyArray<AiToolErrorOccurrence>,
): ReadonlyArray<ToolErrorOccurrenceRow> =>
	rows.map((row) => ({
		timestamp: toEpochMs(row.timestamp),
		traceId: row.traceId,
		spanId: row.spanId,
		sessionId: row.sessionId,
		agentName: row.agentName,
		model: row.model,
		errorType: row.errorType,
		message: row.message,
		durationNs: row.durationNs,
		statusCode: row.statusCode,
		arguments: row.arguments,
		argumentsBytes: row.argumentsBytes,
		result: row.result,
		resultBytes: row.resultBytes,
	}))

/** Every error type one tool failed with, worst first. */
export const getAiToolErrors = Effect.fn("AiSessionTools.errors")(function* ({
	data,
}: {
	data: AiToolErrorsInput
}) {
	const input = yield* decodeInput(AiToolErrorsInput, data, "aiToolsErrors")
	const result = yield* runWarehouseQuery("aiToolsErrors", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.aiSessionsInternal.toolErrors({
				payload: new AiToolErrorsRequest({
					startTime: input.startTime,
					endTime: input.endTime,
					...selectionFields(input),
					tool: input.tool,
					...(input.limit !== undefined && { limit: input.limit }),
				}),
			})
		}),
	)
	return { data: mapToolErrors(result.data) }
})

/** One error type: the sessions that hit it, and the calls themselves. */
export const getAiToolErrorDetail = Effect.fn("AiSessionTools.errorDetail")(function* ({
	data,
}: {
	data: AiToolErrorDetailInput
}) {
	const input = yield* decodeInput(AiToolErrorDetailInput, data, "aiToolsErrorDetail")
	const result = yield* runWarehouseQuery("aiToolsErrorDetail", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.aiSessionsInternal.toolErrorDetail({
				payload: new AiToolErrorDetailRequest({
					startTime: input.startTime,
					endTime: input.endTime,
					...selectionFields(input),
					tool: input.tool,
					errorType: input.errorType,
					...(input.session !== undefined && { session: input.session }),
					...(input.limit !== undefined && { limit: input.limit }),
				}),
			})
		}),
	)
	return {
		sessions: mapErrorSessions(result.sessions),
		occurrences: mapOccurrences(result.occurrences),
	}
})
