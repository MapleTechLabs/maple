// The three warehouse reads behind `/agent-sessions/overview`, and the only
// place in the web app that sees their wire shape.
//
// Two conversions happen here and nowhere else. Buckets arrive as ISO-8601 with
// a literal `Z`; `toEpochMs` reads them as UTC, where `new Date(value)` would
// read a bare warehouse datetime as local time. Durations arrive in
// nanoseconds and leave in milliseconds, because every formatter downstream
// takes milliseconds.
//
// The page's filters are single-valued — one model, one agent, one tool — and
// the contract takes arrays. The widening happens in `selectionFields`, so a
// dimension that later becomes multi-valued changes one function.

import { Effect, Schema } from "effect"
import {
	AI_OVERVIEW_BREAKDOWN_MAX,
	AiOverviewBreakdownRequest,
	AiOverviewDimension,
	AiOverviewModelMixRequest,
	AiOverviewSummaryRequest,
	type AiOverviewBreakdownRow,
	type AiOverviewMeasures,
	type AiOverviewModelMixPoint,
	type AiOverviewSeriesPoint,
} from "@maple/domain/http"
import { toEpochMs } from "@maple/ui/lib/time-format"

import type {
	OverviewBreakdownEntry,
	OverviewMeasurePoint,
	OverviewMeasures,
	OverviewModelMixRow,
} from "@/lib/agent-sessions/overview-analytics"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"

import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "./effect-utils"

/**
 * The page's selection, as all three reads take it.
 *
 * Sent identically to every one of them so the numbers can never disagree about
 * what they are counting: a summary narrower than the breakdown would make the
 * tiles and the table tell different stories about one window.
 */
const AiOverviewSelection = Schema.Struct({
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
	/** The SDK or gateway — `vendorIds` on the wire. */
	framework: Schema.optional(Schema.String),
	model: Schema.optional(Schema.String),
	agent: Schema.optional(Schema.String),
	service: Schema.optional(Schema.String),
	environment: Schema.optional(Schema.String),
	tool: Schema.optional(Schema.String),
	hasErrors: Schema.optional(Schema.Boolean),
})
export type AiOverviewSelection = Schema.Schema.Type<typeof AiOverviewSelection>

const AiOverviewBucketedInput = Schema.Struct({
	...AiOverviewSelection.fields,
	bucketSeconds: Schema.Number,
})
export type AiOverviewBucketedInput = Schema.Schema.Type<typeof AiOverviewBucketedInput>

/**
 * The bounds here MIRROR the domain request's: `decodeInput` turns a violation
 * into a `WarehouseDecodeError` the page can render, where the domain
 * constructor throws — a defect that would crash the page rather than fail one
 * read.
 */
const AiOverviewBreakdownInput = Schema.Struct({
	...AiOverviewSelection.fields,
	dimension: AiOverviewDimension,
	limit: Schema.optional(
		Schema.Number.check(
			Schema.isInt(),
			Schema.isBetween({ minimum: 1, maximum: AI_OVERVIEW_BREAKDOWN_MAX }),
		),
	),
})
export type AiOverviewBreakdownInput = Schema.Schema.Type<typeof AiOverviewBreakdownInput>

/** The selection minus the window, spread into a request payload. */
const selectionFields = (input: AiOverviewSelection) => ({
	...(input.framework !== undefined && { vendorIds: [input.framework] }),
	...(input.service !== undefined && { serviceNames: [input.service] }),
	...(input.environment !== undefined && { deploymentEnvs: [input.environment] }),
	...(input.model !== undefined && { models: [input.model] }),
	...(input.agent !== undefined && { agentNames: [input.agent] }),
	...(input.tool !== undefined && { toolNames: [input.tool] }),
	...(input.hasErrors !== undefined && { hasErrors: input.hasErrors }),
})

/* -------------------------------------------------------------------------------------------------
 * Mappers
 * -----------------------------------------------------------------------------------------------*/

const NS_PER_MS = 1_000_000

export function mapOverviewMeasures(row: AiOverviewMeasures): OverviewMeasures {
	return {
		sessions: row.sessions,
		erroredSessions: row.erroredSessions,
		llmCalls: row.llmCalls,
		llmCallSpans: row.llmCallSpans,
		erroredLlmCalls: row.erroredLlmCalls,
		toolCalls: row.toolCalls,
		erroredToolCalls: row.erroredToolCalls,
		cost: row.cost,
		pricedLlmCalls: row.pricedLlmCalls,
		tokens: row.tokens,
		inputTokens: row.inputTokens,
		cacheReadTokens: row.cacheReadTokens,
		cacheWriteTokens: row.cacheWriteTokens,
		outputTokens: row.outputTokens,
		reasoningTokens: row.reasoningTokens,
		sessionDurationP50Ms: row.sessionDurationP50Ns / NS_PER_MS,
		sessionDurationP95Ms: row.sessionDurationP95Ns / NS_PER_MS,
		llmDurationP50Ms: row.llmDurationP50Ns / NS_PER_MS,
		llmDurationP95Ms: row.llmDurationP95Ns / NS_PER_MS,
	}
}

export function mapOverviewSeries(
	rows: ReadonlyArray<AiOverviewSeriesPoint>,
): ReadonlyArray<OverviewMeasurePoint> {
	return rows.map((row) => ({ bucket: toEpochMs(row.bucket), ...mapOverviewMeasures(row) }))
}

export function mapOverviewBreakdown(
	rows: ReadonlyArray<AiOverviewBreakdownRow>,
): ReadonlyArray<OverviewBreakdownEntry> {
	return rows.map((row) => ({
		key: row.key,
		current: mapOverviewMeasures(row.current),
		previous: mapOverviewMeasures(row.previous),
	}))
}

export function mapOverviewModelMix(
	rows: ReadonlyArray<AiOverviewModelMixPoint>,
): ReadonlyArray<OverviewModelMixRow> {
	return rows.map((row) => ({
		bucket: toEpochMs(row.bucket),
		model: row.model,
		llmCallSpans: row.llmCallSpans,
	}))
}

/* -------------------------------------------------------------------------------------------------
 * The reads
 * -----------------------------------------------------------------------------------------------*/

/** The window and the one before it, whole and bucketed — the tiles and the grid. */
export const getAiOverviewSummary = Effect.fn("AiAgentOverview.summary")(function* ({
	data,
}: {
	data: AiOverviewBucketedInput
}) {
	const input = yield* decodeInput(AiOverviewBucketedInput, data, "aiOverviewSummary")
	const result = yield* runWarehouseQuery("aiOverviewSummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.aiSessionsInternal.overviewSummary({
				payload: new AiOverviewSummaryRequest({
					startTime: input.startTime,
					endTime: input.endTime,
					bucketSeconds: input.bucketSeconds,
					...selectionFields(input),
				}),
			})
		}),
	)
	return {
		bucketSeconds: result.bucketSeconds,
		current: mapOverviewMeasures(result.current),
		// Zeros where nothing ran then, which the tiles render as "no comparison"
		// rather than as a -100%.
		previous: mapOverviewMeasures(result.previous),
		series: mapOverviewSeries(result.series),
		previousSeries: mapOverviewSeries(result.previousSeries),
	}
})

/** One dimension's busiest keys, each over both windows. */
export const getAiOverviewBreakdown = Effect.fn("AiAgentOverview.breakdown")(function* ({
	data,
}: {
	data: AiOverviewBreakdownInput
}) {
	const input = yield* decodeInput(AiOverviewBreakdownInput, data, "aiOverviewBreakdown")
	const result = yield* runWarehouseQuery("aiOverviewBreakdown", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.aiSessionsInternal.overviewBreakdown({
				payload: new AiOverviewBreakdownRequest({
					startTime: input.startTime,
					endTime: input.endTime,
					dimension: input.dimension,
					...(input.limit !== undefined && { limit: input.limit }),
					...selectionFields(input),
				}),
			})
		}),
	)
	return {
		dimension: result.dimension,
		entries: mapOverviewBreakdown(result.rows),
		totalKeys: result.totalKeys,
	}
})

/** Model-call spans per bucket per model — the 100% stack. Current window only. */
export const getAiOverviewModelMix = Effect.fn("AiAgentOverview.modelMix")(function* ({
	data,
}: {
	data: AiOverviewBucketedInput
}) {
	const input = yield* decodeInput(AiOverviewBucketedInput, data, "aiOverviewModelMix")
	const result = yield* runWarehouseQuery("aiOverviewModelMix", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.aiSessionsInternal.overviewModelMix({
				payload: new AiOverviewModelMixRequest({
					startTime: input.startTime,
					endTime: input.endTime,
					bucketSeconds: input.bucketSeconds,
					...selectionFields(input),
				}),
			})
		}),
	)
	return { bucketSeconds: result.bucketSeconds, rows: mapOverviewModelMix(result.rows) }
})

export type AiOverviewSummaryData = Effect.Success<ReturnType<typeof getAiOverviewSummary>>
export type AiOverviewBreakdownData = Effect.Success<ReturnType<typeof getAiOverviewBreakdown>>
export type AiOverviewModelMixData = Effect.Success<ReturnType<typeof getAiOverviewModelMix>>
