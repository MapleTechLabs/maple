import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	AiOverviewBreakdownResponse,
	AiOverviewModelMixResponse,
	AiOverviewSummaryResponse,
	AiSessionTooLargeError,
	AI_SESSION_SPANS_MAX_SPANS,
	AI_SESSION_SUMMARY_MAX_TURNS,
	CurrentTenant,
	GetAiSessionSpansResponse,
	GetAiSessionSummaryResponse,
	ListAiSessionDetailsResponse,
	ListAiSessionsFacetsResponse,
	ListAiSessionsResponse,
	MapleInternalApi,
	MAX_AI_SESSION_SPANS_RESPONSE_BYTES,
	type AiOverviewBreakdownRow,
	type AiOverviewMeasures,
	type AiSessionTokenReporting,
	type AiSessionTokenTotals,
	type AiSessionTurnSummary,
} from "@maple/domain/http"
import { traceSessionTraceId } from "@maple/domain/gen-ai"
import { Effect } from "effect"
import { CH } from "@maple/query-engine"
import * as Integrations from "@maple/query-engine-integrations"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"

/**
 * The counted filters, as both the page and its details take them: they go
 * to both reads so a trace resolves to the same session in each.
 */
const countedFilters = (payload: {
	readonly vendorIds?: ReadonlyArray<string>
	readonly serviceNames?: ReadonlyArray<string>
	readonly deploymentEnvs?: ReadonlyArray<string>
	readonly models?: ReadonlyArray<string>
	readonly agentNames?: ReadonlyArray<string>
	readonly toolNames?: ReadonlyArray<string>
	readonly search?: string
}) => ({
	vendorIds: payload.vendorIds,
	serviceNames: payload.serviceNames,
	deploymentEnvs: payload.deploymentEnvs,
	models: payload.models,
	agentNames: payload.agentNames,
	toolNames: payload.toolNames,
	search: payload.search,
})

/**
 * How many of a page's details slices run at once. A page at production
 * density is one to three slices, all of them in flight; a page over a sparse
 * month is up to a slice a day, which this holds to a few warehouse queries
 * at a time rather than thirty.
 */
const DETAILS_SLICE_CONCURRENCY = 6

/**
 * Dashboard-only AI agent session reads.
 *
 * Serves the Agent Sessions page (behind the `agent_tracing` org rollout flag).
 * The flag hides the surface, not the data — scoping is `CurrentTenant`, like
 * every other warehouse read.
 */
export const HttpAiSessionsInternalLive = HttpApiBuilder.group(
	MapleInternalApi,
	"aiSessionsInternal",
	(handlers) =>
		Effect.gen(function* () {
			const warehouse = yield* WarehouseQueryService

			/**
			 * The window a session read is bounded by, and how the session is keyed.
			 *
			 * A `trace:<TraceId>` id is Maple's own: the vendor exposed no session
			 * key, so the trace IS the session and the reads key on the trace id
			 * instead of the session attribute. The helper returns `undefined` for
			 * a vendor id AND for a prefixed one that is not 32 hex characters, so a
			 * forged value never reaches the trace-keyed param — it takes the
			 * session path, where nothing carries it and the caller gets the
			 * empty-session answer.
			 *
			 * Both halves of the hint or neither: a lone bound would silently pin
			 * the other end of the read to the param placeholder. Without a hint
			 * the bounds are resolved from the id first, because every read has to
			 * be partition-pruned on both levels rather than fan out unpruned — see
			 * `aiSessionSpansQuery`. One extra round trip, and only on the
			 * deep-link path; `window_source` is how often that runs gets watched.
			 */
			const resolveRead = Effect.fn("aiSessions.resolveRead")(function* (payload: {
				readonly sessionId: string
				readonly startTime?: string
				readonly endTime?: string
			}) {
				const tenant = yield* CurrentTenant.Context
				const hint =
					payload.startTime !== undefined && payload.endTime !== undefined
						? { startTime: payload.startTime, endTime: payload.endTime }
						: undefined
				const traceId = traceSessionTraceId(payload.sessionId)
				yield* Effect.annotateCurrentSpan({
					orgId: tenant.orgId,
					"maple.ai.session.id": payload.sessionId,
					"maple.ai.session.kind": traceId === undefined ? "vendor" : "trace",
					"maple.ai.window_source": hint === undefined ? "resolved" : "client",
				})
				const resolved =
					hint !== undefined
						? undefined
						: traceId === undefined
							? yield* warehouse.compiledQuery(
									tenant,
									CH.compile(Integrations.aiSessionWindowQuery(), {
										orgId: tenant.orgId,
										sessionId: payload.sessionId,
									}),
									{ profile: "list", context: "aiSessionWindow" },
								)
							: yield* warehouse.compiledQuery(
									tenant,
									CH.compile(Integrations.aiTraceWindowQuery(), {
										orgId: tenant.orgId,
										traceId,
									}),
									{ profile: "list", context: "aiTraceWindow" },
								)
				// `min`/`max` over no rows return the epoch rather than nothing, so
				// the count is what distinguishes an unknown session id.
				const bounds = resolved?.[0]
				const window =
					hint ??
					(bounds !== undefined && bounds.spanCount > 0
						? { startTime: bounds.startTime, endTime: bounds.endTime }
						: undefined)
				return { tenant, traceId, window }
			})

			return handlers
				.handle("list", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
						// One read, off `ai_trace_index` alone: the page is ranked over the
						// caller's whole window and every fact the row shows is measured
						// there, over the session's agent spans. The facts only the traces'
						// other spans can answer come from `details`, which the client
						// asks for once this has rendered — see `aiSessionPageQuery` for
						// what the fan-out cost on the critical path.
						const page = yield* warehouse.compiledQuery(
							tenant,
							CH.compile(
								Integrations.aiSessionPageQuery({
									...countedFilters(payload),
									limit: payload.limit,
									offset: payload.offset,
									hasErrors: payload.hasErrors,
									excludeTraceSessions: payload.excludeTraceSessions,
									durationMinMs: payload.durationMinMs,
									durationMaxMs: payload.durationMaxMs,
									costMin: payload.costMin,
									costMax: payload.costMax,
									tokensMin: payload.tokensMin,
									tokensMax: payload.tokensMax,
									llmCallsMin: payload.llmCallsMin,
									llmCallsMax: payload.llmCallsMax,
									toolCallsMin: payload.toolCallsMin,
									toolCallsMax: payload.toolCallsMax,
									sortBy: payload.sortBy,
									sortDir: payload.sortDir,
								}),
								{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
							),
							{ profile: "list", context: "aiSessionsPage" },
						)
						if (page.length === 0) {
							return new ListAiSessionsResponse({ data: [] })
						}
						yield* Effect.annotateCurrentSpan({ "maple.ai.page_size": page.length })
						// The page's order is the order shown. The row's bounds are the
						// agent spans' extent, which the details replace with the true one.
						return new ListAiSessionsResponse({
							data: page.map((row) => ({
								sessionId: row.sessionId,
								vendorId: row.vendorId,
								vendorVersion: row.vendorVersion,
								traceCount: row.traceCount,
								spanCount: row.spanCount,
								errorSpanCount: row.errorAgentSpans,
								toolErrorCount: row.toolErrors,
								turnErrorCount: row.turnErrors,
								serviceNames: row.serviceNames,
								models: row.models,
								agentNames: row.agentNames,
								firstAgentName: row.firstAgentName,
								llmCalls: row.llmCalls,
								toolCalls: row.toolCalls,
								totalTokens: row.totalTokens,
								inputTokens: row.inputTokens,
								cacheReadTokens: row.cacheReadTokens,
								cacheWriteTokens: row.cacheWriteTokens,
								outputTokens: row.outputTokens,
								reasoningTokens: row.reasoningTokens,
								cost: row.cost,
								startTime: row.agentStart,
								endTime: row.agentEnd,
								durationMs: row.agentDurationMs,
							})),
							ranked: page.length,
						})
					}),
				)
				.handle("details", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						// The fan-out over `trace_detail_spans`, bounded by the page's own
						// extent rather than the list's window — the client hands back the
						// bounds the page rows carried. Seconds on a cold partition, which
						// is why it is its own request rather than part of `list`, and one
						// read per partition the padded extent touches, side by side, so
						// a cold day costs the page that day alone and the profile's
						// ceiling bounds a day rather than the page.
						const slices = Integrations.aiSessionDetailsSlices(payload.startTime, payload.endTime)
						yield* Effect.annotateCurrentSpan({
							orgId: tenant.orgId,
							"maple.ai.page_size": payload.sessionIds.length,
							"maple.ai.details_slices": slices.length,
						})
						const query = Integrations.aiSessionDetailsQuery({
							...countedFilters(payload),
							sessionIds: payload.sessionIds,
						})
						const sliced = yield* Effect.all(
							slices.map((slice) =>
								warehouse.compiledQuery(
									tenant,
									CH.compile(query, {
										orgId: tenant.orgId,
										fanOutStart: payload.startTime,
										fanOutEnd: payload.endTime,
										...slice,
									}),
									{ profile: "list", context: "aiSessionsDetails" },
								),
							),
							{ concurrency: DETAILS_SLICE_CONCURRENCY },
						)
						const rows = Integrations.mergeAiSessionDetails(sliced)
						// A page session the fan-out did not return is simply absent: the
						// two MVs are written one after the other from the same insert, so
						// the newest session can be ranked a moment before it has span rows.
						// The count on the span is how often.
						yield* Effect.annotateCurrentSpan({ "maple.ai.detailed": rows.length })
						return new ListAiSessionDetailsResponse({ data: rows })
					}),
				)
				.handle("facets", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
						const compiled = CH.compileUnion(Integrations.aiSessionFacetsQuery(), {
							orgId: tenant.orgId,
							startTime: payload.startTime,
							endTime: payload.endTime,
						})
						const rows = yield* warehouse.compiledQuery(tenant, compiled, {
							profile: "list",
							context: "aiSessionsFacets",
						})
						// One UNION ALL result carrying every dimension, split by facetType.
						const pick = (facetType: Integrations.AiSessionFacetType) =>
							rows
								.filter((row) => row.facetType === facetType)
								.map((row) => ({ name: row.name, count: row.count }))
						return new ListAiSessionsFacetsResponse({
							vendors: pick("vendor"),
							services: pick("service"),
							environments: pick("environment"),
							models: pick("model"),
							agents: pick("agent"),
							tools: pick("tool"),
						})
					}),
				)
				.handle("spans", ({ payload }) =>
					Effect.gen(function* () {
						// Annotated before the read: a 413 never reaches the code below.
						const { tenant, traceId, window } = yield* resolveRead(payload)
						if (window === undefined) {
							return new GetAiSessionSpansResponse({ data: [] })
						}
						const limit = payload.limit ?? AI_SESSION_SPANS_MAX_SPANS
						// One row past the page: the extra row is what distinguishes a
						// session that exactly fills the page from one with a page after.
						const opts = {
							limit: limit + 1,
							scope: payload.scope,
							after: payload.after,
						}
						const rowSchema = { rowSchema: Integrations.aiSessionSpansRowSchema }
						const compiled =
							payload.traceIds !== undefined
								? CH.compile(
										Integrations.aiTraceSpansQuery({ ...opts, traceIds: payload.traceIds }),
										{ orgId: tenant.orgId, ...window },
										rowSchema,
									)
								: traceId === undefined
									? CH.compile(
											Integrations.aiSessionSpansQuery(opts),
											{ orgId: tenant.orgId, sessionId: payload.sessionId, ...window },
											rowSchema,
										)
									: CH.compile(
											Integrations.aiTraceSpansQuery(opts),
											{ orgId: tenant.orgId, traceId, ...window },
											rowSchema,
										)
						const rows = yield* warehouse
							.compiledQueryBounded(tenant, compiled, {
								profile: "list",
								context:
									payload.traceIds !== undefined
										? "aiTracesSpans"
										: traceId === undefined
											? "aiSessionSpans"
											: "aiTraceSpans",
								responseLimits: {
									maxRows: limit + 1,
									maxBytes: MAX_AI_SESSION_SPANS_RESPONSE_BYTES,
								},
							})
							.pipe(
								Effect.catchTag(
									"@maple/query-engine/execution/WarehouseResponseLimitError",
									() =>
										Effect.fail(
											new AiSessionTooLargeError({
												sessionId: payload.sessionId,
												message: "AI session spans exceeded the response byte limit.",
											}),
										),
								),
							)
						const page = rows.slice(0, limit)
						const last = page[page.length - 1]
						const nextCursor =
							rows.length > limit && last !== undefined
								? { timestamp: last.timestamp, spanId: last.spanId }
								: undefined
						yield* Effect.annotateCurrentSpan({
							"maple.ai.span_count": page.length,
							"maple.ai.scope": payload.scope ?? "all",
							"maple.ai.has_more": nextCursor !== undefined,
						})
						// Mapped server-side: the raw attribute map is the dominant weight
						// of this read and nothing downstream needs it.
						return new GetAiSessionSpansResponse({
							data: Integrations.mapAiSpans(page),
							...(nextCursor !== undefined && { nextCursor }),
						})
					}),
				)
				.handle("summary", ({ payload }) =>
					Effect.gen(function* () {
						const { tenant, traceId, window } = yield* resolveRead(payload)
						if (window === undefined) {
							return emptySummary()
						}
						// Two reads over the same spans, side by side: the turn rows are
						// capped, and a session grouping into more turns than the cap
						// must still report exact totals — those come from the ungrouped
						// read, which no cap touches.
						const params =
							traceId === undefined
								? { orgId: tenant.orgId, sessionId: payload.sessionId, ...window }
								: { orgId: tenant.orgId, traceId, ...window }
						const turnsQuery =
							traceId === undefined
								? Integrations.aiSessionSummaryQuery()
								: Integrations.aiTraceSummaryQuery()
						const totalsQuery =
							traceId === undefined ? Integrations.aiSessionTotalsQuery() : Integrations.aiTraceTotalsQuery()
						const kind = traceId === undefined ? "aiSession" : "aiTrace"
						const [rows, totals] = yield* Effect.all(
							[
								warehouse.compiledQuery(
									tenant,
									CH.compile(turnsQuery, params, { rowSchema: Integrations.aiSessionSummaryRowSchema }),
									{ context: `${kind}Summary` },
								),
								warehouse.compiledQuery(
									tenant,
									CH.compile(totalsQuery, params, { rowSchema: Integrations.aiSessionTotalsRowSchema }),
									{ context: `${kind}Totals` },
								),
							],
							{ concurrency: 2 },
						)
						const summary = foldSummary(totals[0], rows)
						yield* Effect.annotateCurrentSpan({
							"maple.ai.span_count": summary.spanCount,
							"maple.ai.turn_count": summary.turns.length,
						})
						return summary
					}),
				)
				.handle("overviewSummary", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({
							orgId: tenant.orgId,
							"maple.ai.overview.bucket_seconds": payload.bucketSeconds,
						})
						// The comparison window is the caller's, shifted back by its own
						// length: `previous` ends where `current` begins, so the two
						// never overlap and the delta is over equal spans.
						const params = {
							orgId: tenant.orgId,
							startTime: payload.startTime,
							endTime: payload.endTime,
							...previousWindow(payload.startTime, payload.endTime),
						}
						const selection = overviewSelection(payload)
						// Two reads and not one: the tiles' percentiles cannot be folded
						// from the chart's, so the window has to be grouped twice — and
						// side by side that costs one read's latency rather than two.
						const [totals, series] = yield* Effect.all(
							[
								warehouse.compiledQuery(
									tenant,
									CH.compileUnion(Integrations.aiOverviewTotalsQuery(selection), params),
									{ context: "aiOverviewTotals" },
								),
								warehouse.compiledQuery(
									tenant,
									CH.compileUnion(Integrations.aiOverviewSeriesQuery(selection), {
										...params,
										bucketSeconds: payload.bucketSeconds,
									}),
									{ context: "aiOverviewSeries" },
								),
							],
							{ concurrency: 2 },
						)
						const points = (period: Integrations.AiOverviewPeriod) =>
							series
								.filter((row) => row.period === period)
								.map((row) => ({ bucket: row.bucket, ...overviewMeasures(row) }))
						return new AiOverviewSummaryResponse({
							bucketSeconds: payload.bucketSeconds,
							// An aggregate over no rows still yields one row per branch, so
							// a missing period is a shape failure rather than an empty
							// window — the zeros are what a client renders as "no
							// comparison".
							current: overviewMeasures(totals.find((row) => row.period === "current")),
							previous: overviewMeasures(totals.find((row) => row.period === "previous")),
							series: points("current"),
							previousSeries: points("previous"),
						})
					}),
				)
				.handle("overviewBreakdown", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({
							orgId: tenant.orgId,
							"maple.ai.overview.dimension": payload.dimension,
						})
						const rows = yield* warehouse.compiledQuery(
							tenant,
							CH.compileUnion(
								Integrations.aiOverviewBreakdownQuery({
									...overviewSelection(payload),
									dimension: payload.dimension,
									limit: payload.limit,
								}),
								{
									orgId: tenant.orgId,
									startTime: payload.startTime,
									endTime: payload.endTime,
									...previousWindow(payload.startTime, payload.endTime),
								},
							),
							{ context: "aiOverviewBreakdown" },
						)
						const previous = new Map(
							rows.filter((row) => row.period === "previous").map((row) => [row.key, row]),
						)
						// The busiest first, and the ranking the query made is by sessions
						// alone — cost orders the keys it tied.
						const ranked = rows
							.filter((row) => row.period === "current")
							.sort((a, b) => b.sessions - a.sessions || b.cost - a.cost || a.key.localeCompare(b.key))
						const breakdown: ReadonlyArray<AiOverviewBreakdownRow> = ranked.map((row) => ({
							key: row.key,
							current: overviewMeasures(row),
							// Zeros for a key that did not appear before, which reads as
							// "new" rather than as a missing row.
							previous: overviewMeasures(previous.get(row.key)),
						}))
						return new AiOverviewBreakdownResponse({
							dimension: payload.dimension,
							rows: breakdown,
							totalKeys: rows.find((row) => row.period === "keys")?.keyCount ?? 0,
						})
					}),
				)
				.handle("overviewModelMix", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({
							orgId: tenant.orgId,
							"maple.ai.overview.bucket_seconds": payload.bucketSeconds,
						})
						// No comparison window: the chart plots the selected window's
						// bands and nothing behind them.
						const rows = yield* warehouse.compiledQuery(
							tenant,
							CH.compile(Integrations.aiOverviewModelMixQuery(overviewSelection(payload)), {
								orgId: tenant.orgId,
								startTime: payload.startTime,
								endTime: payload.endTime,
								bucketSeconds: payload.bucketSeconds,
							}),
							{ context: "aiOverviewModelMix" },
						)
						return new AiOverviewModelMixResponse({
							bucketSeconds: payload.bucketSeconds,
							rows: rows.map((row) => ({
								bucket: row.bucket,
								model: row.model,
								llmCallSpans: row.llmCallSpans,
							})),
						})
					}),
				)
		}),
)

/**
 * The overview's selection, as both of its reads take it — the sessions list's
 * counted filters, so the two pages measure the same sessions.
 */
const overviewSelection = (payload: {
	readonly vendorIds?: ReadonlyArray<string>
	readonly serviceNames?: ReadonlyArray<string>
	readonly deploymentEnvs?: ReadonlyArray<string>
	readonly models?: ReadonlyArray<string>
	readonly agentNames?: ReadonlyArray<string>
	readonly toolNames?: ReadonlyArray<string>
	readonly hasErrors?: boolean
}) => ({
	vendorIds: payload.vendorIds,
	serviceNames: payload.serviceNames,
	deploymentEnvs: payload.deploymentEnvs,
	models: payload.models,
	agentNames: payload.agentNames,
	toolNames: payload.toolNames,
	hasErrors: payload.hasErrors,
})

/** `TinybirdDateTime` is UTC without a zone marker. */
const warehouseDateTimeMs = (value: string): number => Date.parse(`${value.replace(" ", "T")}Z`)

/** Back to warehouse shape, seconds precision — what the params take. */
const warehouseDateTime = (ms: number): string => new Date(ms).toISOString().replace("T", " ").slice(0, 19)

/**
 * The window of equal length ending where the caller's begins — the tiles'
 * comparison. Computed here rather than asked for, so the delta cannot be
 * quietly taken against a window of a different size.
 *
 * `prevEndTime` IS the caller's `startTime`: the read bounds the previous
 * branch half-open (`[prevStartTime, prevEndTime)`), so the boundary second
 * belongs to the current window alone and no session is measured in both.
 */
const previousWindow = (startTime: string, endTime: string) => {
	const start = warehouseDateTimeMs(startTime)
	const span = warehouseDateTimeMs(endTime) - start
	return {
		prevStartTime: warehouseDateTime(start - span),
		prevEndTime: warehouseDateTime(start),
	}
}

const NO_OVERVIEW_MEASURES: AiOverviewMeasures = {
	sessions: 0,
	erroredSessions: 0,
	llmCalls: 0,
	llmCallSpans: 0,
	erroredLlmCalls: 0,
	toolCalls: 0,
	erroredToolCalls: 0,
	cost: 0,
	pricedLlmCalls: 0,
	tokens: 0,
	inputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	outputTokens: 0,
	reasoningTokens: 0,
	sessionDurationP50Ns: 0,
	sessionDurationP95Ns: 0,
	llmDurationP50Ns: 0,
	llmDurationP95Ns: 0,
}

/** One row's measures, or zeros for a period or a key that has no row. */
const overviewMeasures = (
	row: Integrations.AiOverviewMeasuresOutput | undefined,
): AiOverviewMeasures => {
	if (row === undefined) return NO_OVERVIEW_MEASURES
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
		sessionDurationP50Ns: row.sessionDurationP50Ns,
		sessionDurationP95Ns: row.sessionDurationP95Ns,
		llmDurationP50Ns: row.llmDurationP50Ns,
		llmDurationP95Ns: row.llmDurationP95Ns,
	}
}

const NO_TOKENS: AiSessionTokenTotals = { input: 0, output: 0, cacheRead: 0 }

const emptySummary = () =>
	new GetAiSessionSummaryResponse({
		spanCount: 0,
		aiSpanCount: 0,
		traceCount: 0,
		durationMs: 0,
		llmCalls: 0,
		toolCalls: 0,
		errorSpanCount: 0,
		tokens: NO_TOKENS,
		tokenReporting: "none",
		models: [],
		agentNames: [],
		turns: [],
		turnsTruncated: false,
	})

/**
 * A set of spans' usage under the deepest-reporter rule: the model-call spans'
 * figures when any model call reported, the plain sum otherwise. See
 * `summaryMeasures` in the query module for why it returns both. Applied to
 * the session's own row for the totals, and to each turn row for the turn —
 * never to the turn rows summed, since a turn span's roll-up and its model
 * calls can land in different rows.
 */
const usageOf = (row: Integrations.AiSessionTotalsOutput | Integrations.AiSessionSummaryOutput) => {
	const perCall = row.llmInputTokens + row.llmOutputTokens + row.llmCacheReadTokens > 0
	const reporting: AiSessionTokenReporting =
		perCall ? "per-call" : row.inputTokens + row.outputTokens + row.cacheReadTokens > 0 ? "roll-up" : "none"
	const tokens: AiSessionTokenTotals = perCall
		? { input: row.llmInputTokens, output: row.llmOutputTokens, cacheRead: row.llmCacheReadTokens }
		: { input: row.inputTokens, output: row.outputTokens, cacheRead: row.cacheReadTokens }
	// Cost follows the same rule, but only once something reported one: a
	// per-call session whose calls carry no price still has a session cost if
	// the wrapper stamped one.
	const cost =
		row.costReporters === 0 ? undefined : perCall && row.llmCost > 0 ? row.llmCost : row.cost
	return { reporting, tokens, cost }
}

/** The session's row and its turn rows, as the response shape. */
const foldSummary = (
	totals: Integrations.AiSessionTotalsOutput | undefined,
	rows: readonly Integrations.AiSessionSummaryOutput[],
) => {
	// An aggregate over no rows still yields one row, with a zero count.
	if (totals === undefined || totals.spanCount === 0) return emptySummary()
	const turnsTruncated = rows.length > AI_SESSION_SUMMARY_MAX_TURNS
	const kept = rows.slice(0, AI_SESSION_SUMMARY_MAX_TURNS)
	const usage = usageOf(totals)

	const turns: AiSessionTurnSummary[] = kept.map((row) => {
		const usage = usageOf(row)
		return {
			turnKey: row.turnKey,
			conversationId: row.conversationId,
			traceIds: row.traceIds,
			startTime: row.startTime,
			endTime: row.endTime,
			durationMs: row.durationMs,
			spanCount: row.spanCount,
			aiSpanCount: row.aiSpanCount,
			llmCalls: row.llmCalls,
			toolCalls: row.toolCalls,
			errorSpanCount: row.errorSpanCount,
			tokens: usage.tokens,
			...(usage.cost !== undefined && { cost: usage.cost }),
			models: row.models,
			agentNames: row.agentNames,
		}
	})
	return new GetAiSessionSummaryResponse({
		spanCount: totals.spanCount,
		aiSpanCount: totals.aiSpanCount,
		traceCount: totals.traceCount,
		startTime: totals.startTime,
		endTime: totals.endTime,
		durationMs: totals.durationMs,
		llmCalls: totals.llmCalls,
		toolCalls: totals.toolCalls,
		errorSpanCount: totals.errorSpanCount,
		tokens: usage.tokens,
		tokenReporting: usage.reporting,
		...(usage.cost !== undefined && { cost: usage.cost }),
		models: totals.models,
		agentNames: totals.agentNames,
		turns,
		turnsTruncated,
	})
}
