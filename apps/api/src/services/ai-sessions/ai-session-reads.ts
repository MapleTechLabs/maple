import {
	AiSessionTooLargeError,
	AiToolErrorDetailResponse,
	AiToolErrorSamplesResponse,
	AiToolErrorsResponse,
	AiToolsBreakdownsResponse,
	AiToolsSeriesResponse,
	AiToolsTotalsResponse,
	AI_SESSION_SPANS_MAX_SPANS,
	AI_SESSION_SUMMARY_MAX_TURNS,
	GetAiSessionSpansResponse,
	GetAiSessionSummaryResponse,
	ListAiSessionDetailsResponse,
	ListAiSessionsDistributionsResponse,
	ListAiSessionsFacetsResponse,
	ListAiSessionsResponse,
	MAX_AI_SESSION_SPANS_RESPONSE_BYTES,
	type AiSessionTokenReporting,
	type AiSessionTokenTotals,
	type AiSessionTurnSummary,
	type AiToolErrorDetailRequest,
	type AiToolErrorSamplesRequest,
	type AiToolErrorsRequest,
	type AiToolsAggregate,
	type AiToolsBreakdownItem,
	type AiToolsBreakdownsRequest,
	type AiToolsPeriod,
	type AiToolsSeriesRequest,
	type AiToolsTotalsRequest,
	type GetAiSessionSpansRequest,
	type GetAiSessionSummaryRequest,
	type ListAiSessionDetailsRequest,
	type ListAiSessionsDistributionsRequest,
	type ListAiSessionsFacetsRequest,
	type ListAiSessionsRequest,
} from "@maple/domain/http"
import { traceSessionTraceId } from "@maple/domain/gen-ai"
import { Array as Arr, Effect } from "effect"
import { CH, formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import * as Integrations from "@maple/query-engine-integrations"
// The warehouse's own tenant type, which both callers satisfy: the HTTP
// group's `CurrentTenant.Context` and the MCP's `CurrentMcpTenant` (whose
// `TenantContext` in `@/services/auth/tenant-context` widens to this one).
import type { TenantContext } from "@/services/auth/AuthService"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"

/**
 * The AI agent session warehouse reads, one per request shape.
 *
 * They take the tenant rather than resolving it, so the dashboard's HTTP group
 * and the MCP tools run the same read against the same warehouse queries. Each
 * read opens its own span for that reason: both callers get the annotations,
 * and reads a caller runs side by side (or in a paging loop) no longer write
 * over one another on the caller's span.
 */

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
 * The bounds a session's spans lie in, resolved from the id alone.
 *
 * A `trace:<TraceId>` id is Maple's own: the vendor exposed no session key, so
 * the trace IS the session and the reads key on the trace id instead of the
 * session attribute. The helper returns `undefined` for a vendor id AND for a
 * prefixed one that is not 32 hex characters, so a forged value never reaches
 * the trace-keyed param — it takes the session path, where nothing carries it
 * and the caller gets the empty-session answer.
 *
 * Exported because a trace-pinned read (the MCP span inspector) needs the same
 * bounds: every read has to be partition-pruned on both levels rather than fan
 * out unpruned — see `aiSessionSpansQuery`.
 */
export const resolveAiSessionWindow = Effect.fn("aiSessions.resolveWindow")(function* (
	tenant: TenantContext,
	sessionId: string,
) {
	const warehouse = yield* WarehouseQueryService
	yield* Effect.annotateCurrentSpan({
		orgId: tenant.orgId,
		"maple.ai.session.id": sessionId,
		"maple.ai.window_source": "resolved",
	})
	const traceId = traceSessionTraceId(sessionId)
	const resolved =
		traceId === undefined
			? yield* warehouse.compiledQuery(
					tenant,
					CH.compile(Integrations.aiSessionWindowQuery(), {
						orgId: tenant.orgId,
						sessionId,
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
	const bounds = resolved[0]
	const window =
		bounds !== undefined && bounds.spanCount > 0
			? { startTime: bounds.startTime, endTime: bounds.endTime }
			: undefined
	return { traceId, window }
})

/**
 * The window a session read is bounded by, and how the session is keyed.
 *
 * Both halves of the hint or neither: a lone bound would silently pin the
 * other end of the read to the param placeholder. Without a hint the bounds
 * are resolved from the id first. One extra round trip, and only on the
 * deep-link path; `window_source` is how often that runs gets watched.
 */
const resolveRead = Effect.fn(function* (
	tenant: TenantContext,
	payload: {
		readonly sessionId: string
		readonly startTime?: string
		readonly endTime?: string
	},
) {
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
	if (hint !== undefined) return { traceId, window: hint }
	return yield* resolveAiSessionWindow(tenant, payload.sessionId)
})

export const listAiSessions = Effect.fn("aiSessions.list")(function* (
	tenant: TenantContext,
	payload: ListAiSessionsRequest,
) {
	const warehouse = yield* WarehouseQueryService
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
	// Rows returned, not rows asked for — annotated before the empty answer
	// leaves, so a window that ranks nothing is visible as such.
	yield* Effect.annotateCurrentSpan({ "maple.ai.page_size": page.length })
	if (page.length === 0) {
		return new ListAiSessionsResponse({ data: [] })
	}
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
})

export const readAiSessionDetails = Effect.fn("aiSessions.details")(function* (
	tenant: TenantContext,
	payload: ListAiSessionDetailsRequest,
) {
	const warehouse = yield* WarehouseQueryService
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
		"maple.ai.requested_sessions": payload.sessionIds.length,
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
})

export const readAiSessionFacets = Effect.fn("aiSessions.facets")(function* (
	tenant: TenantContext,
	payload: ListAiSessionsFacetsRequest,
) {
	const warehouse = yield* WarehouseQueryService
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
		rows.filter((row) => row.facetType === facetType).map((row) => ({ name: row.name, count: row.count }))
	return new ListAiSessionsFacetsResponse({
		vendors: pick("vendor"),
		services: pick("service"),
		environments: pick("environment"),
		models: pick("model"),
		agents: pick("agent"),
		tools: pick("tool"),
	})
})

export const readAiSessionDistributions = Effect.fn("aiSessions.distributions")(function* (
	tenant: TenantContext,
	payload: ListAiSessionsDistributionsRequest,
) {
	const warehouse = yield* WarehouseQueryService
	yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
	// Nets every session in the window — the cost of a cost-sorted
	// page — which is why it is its own request rather than a branch
	// of the facets, whose index scan the Tools pages also wait on.
	const rows = yield* warehouse.compiledQuery(
		tenant,
		CH.compile(Integrations.aiSessionDistributionsQuery(), {
			orgId: tenant.orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
		{ profile: "list", context: "aiSessionsDistributions" },
	)
	const distribution = (measure: Integrations.AiSessionDistributionMeasure) => {
		const row = rows.find((candidate) => candidate.measure === measure)
		if (row === undefined) return { buckets: [], p50: 0, p95: 0 }
		return {
			buckets: Object.entries(row.buckets)
				.map(([floor, count]) => ({ floor: Number(floor), count }))
				.sort((a, b) => a.floor - b.floor),
			p50: row.p50,
			p95: row.p95,
		}
	}
	return new ListAiSessionsDistributionsResponse({
		durationMs: distribution("durationMs"),
		cost: distribution("cost"),
		totalTokens: distribution("totalTokens"),
		llmCalls: distribution("llmCalls"),
		toolCalls: distribution("toolCalls"),
	})
})

export const readAiSessionSpans = Effect.fn("aiSessions.spans")(function* (
	tenant: TenantContext,
	payload: GetAiSessionSpansRequest,
) {
	const warehouse = yield* WarehouseQueryService
	// Annotated before the read: a 413 never reaches the code below.
	const { traceId, window } = yield* resolveRead(tenant, payload)
	if (window === undefined) {
		yield* Effect.annotateCurrentSpan("maple.ai.found", false)
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
	const context =
		payload.traceIds !== undefined
			? "aiTracesSpans"
			: traceId === undefined
				? "aiSessionSpans"
				: "aiTraceSpans"
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
			context,
			responseLimits: {
				maxRows: limit + 1,
				maxBytes: MAX_AI_SESSION_SPANS_RESPONSE_BYTES,
			},
		})
		.pipe(
			Effect.catchTag("@maple/query-engine/execution/WarehouseResponseLimitError", () =>
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
		// Which of the three reads ran: a trace-pinned read is keyed on the
		// traces it was handed, not on the session the scope describes.
		"maple.ai.read": context,
		"maple.ai.scope": payload.scope ?? "all",
		"maple.ai.has_more": nextCursor !== undefined,
	})
	// Mapped server-side: the raw attribute map is the dominant weight
	// of this read and nothing downstream needs it.
	return new GetAiSessionSpansResponse({
		data: Integrations.mapAiSpans(page),
		...(nextCursor !== undefined && { nextCursor }),
	})
})

export const readAiSessionSummary = Effect.fn("aiSessions.summary")(function* (
	tenant: TenantContext,
	payload: GetAiSessionSummaryRequest,
) {
	const warehouse = yield* WarehouseQueryService
	const { traceId, window } = yield* resolveRead(tenant, payload)
	if (window === undefined) {
		yield* Effect.annotateCurrentSpan("maple.ai.found", false)
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
		traceId === undefined ? Integrations.aiSessionSummaryQuery() : Integrations.aiTraceSummaryQuery()
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
})

export const readAiToolsSeries = Effect.fn("aiSessions.toolsSeries")(function* (
	tenant: TenantContext,
	payload: AiToolsSeriesRequest,
) {
	const warehouse = yield* WarehouseQueryService
	const selection = { ...toolsSelection(payload), split: payload.split }
	// The series key is the request's where it named one, else derived
	// from the selection — so the response can say what it is without
	// waiting for rows.
	const seriesKind = Integrations.aiToolsSeriesKind(selection)
	yield* Effect.annotateCurrentSpan({
		orgId: tenant.orgId,
		"maple.ai.tools.series_kind": seriesKind,
	})
	const rows = yield* warehouse.compiledQuery(
		tenant,
		CH.compile(Integrations.aiToolsSeriesQuery(selection), {
			orgId: tenant.orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
			bucketSeconds: payload.bucketSeconds,
		}),
		{ context: "aiToolsSeries" },
	)
	return new AiToolsSeriesResponse({ data: rows, seriesKind })
})

export const readAiToolsTotals = Effect.fn("aiSessions.toolsTotals")(function* (
	tenant: TenantContext,
	payload: AiToolsTotalsRequest,
) {
	const warehouse = yield* WarehouseQueryService
	yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
	// The comparison window is the caller's, shifted back by its own
	// length: `previous` ends where `current` begins, so the two
	// never overlap and the delta is over equal spans. Compiled in
	// whether or not the previous branch is asked for — a param the
	// statement does not mention costs nothing.
	const previous = previousWindow(payload.startTime, payload.endTime)
	const periods = payload.periods ?? Integrations.AI_TOOLS_TOTALS_PERIODS
	const [rows, descriptionRows] = yield* Effect.all(
		[
			warehouse.compiledQuery(
				tenant,
				CH.compileUnion(Integrations.aiToolsTotalsQuery(toolsSelection(payload), periods), {
					orgId: tenant.orgId,
					startTime: payload.startTime,
					endTime: payload.endTime,
					...previous,
				}),
				{ context: "aiToolsTotals" },
			),
			// The detail page's header names the tool, so only a selected
			// tool has a description to look up.
			payload.tool === undefined
				? Effect.succeed([])
				: warehouse.compiledQuery(
						tenant,
						CH.compile(
							Integrations.aiToolDescriptionQuery(),
							{
								orgId: tenant.orgId,
								startTime: payload.startTime,
								endTime: payload.endTime,
								toolName: payload.tool,
							},
							{ rowSchema: Integrations.aiToolDescriptionRowSchema },
						),
						{ profile: "list", context: "aiToolDescription" },
					),
		],
		{ concurrency: 2 },
	)
	const description = descriptionRows[0]?.description ?? ""
	// An aggregate over no rows still yields one row per branch, so a
	// missing period is a shape failure rather than an empty window.
	// The query already reports `''` for a period that matched
	// nothing, so these two carry that contract unchanged. A period
	// the caller did not ask for has no branch and no row, and is
	// absent from the response rather than zeroed.
	const current = rows.find((row) => row.period === "current")
	const allSessions = rows.find((row) => row.period === "window")?.sessions
	return new AiToolsTotalsResponse({
		current: aggregateOf(rows, "current"),
		...(periods.includes("previous") && { previous: aggregateOf(rows, "previous") }),
		...(allSessions !== undefined && { allSessions }),
		firstSeen: current?.firstSeen ?? "",
		lastSeen: current?.lastSeen ?? "",
		...(description !== "" && { description }),
	})
})

export const readAiToolsBreakdowns = Effect.fn("aiSessions.toolsBreakdowns")(function* (
	tenant: TenantContext,
	payload: AiToolsBreakdownsRequest,
) {
	const warehouse = yield* WarehouseQueryService
	yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
	const rows = yield* warehouse.compiledQuery(
		tenant,
		CH.compile(Integrations.aiToolsBreakdownsQuery(toolsSelection(payload)), {
			orgId: tenant.orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
		{ context: "aiToolsBreakdowns" },
	)
	return new AiToolsBreakdownsResponse({ tools: rows.map(breakdownItem) })
})

export const readAiToolErrors = Effect.fn("aiSessions.toolErrors")(function* (
	tenant: TenantContext,
	payload: AiToolErrorsRequest,
) {
	const warehouse = yield* WarehouseQueryService
	yield* Effect.annotateCurrentSpan({
		orgId: tenant.orgId,
		"maple.ai.tools.tool": payload.tool,
	})
	const rows = yield* warehouse.compiledQuery(
		tenant,
		CH.compile(
			Integrations.aiToolErrorsQuery({
				...toolsSelection(payload),
				limit: payload.limit,
			}),
			{
				orgId: tenant.orgId,
				startTime: payload.startTime,
				endTime: payload.endTime,
				bucketSeconds: payload.bucketSeconds,
			},
			{ rowSchema: Integrations.aiToolErrorsRowSchema },
		),
		{ context: "aiToolsErrors" },
	)
	return new AiToolErrorsResponse({
		data: rows.map((row) => ({
			...row,
			// A map on the wire, a series on the page: the ISO buckets
			// are fixed width, so they sort as the instants do.
			trend: Object.entries(row.trend)
				.map(([bucket, calls]) => ({ bucket, calls }))
				.sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0)),
		})),
	})
})

export const readAiToolErrorDetail = Effect.fn("aiSessions.toolErrorDetail")(function* (
	tenant: TenantContext,
	payload: AiToolErrorDetailRequest,
) {
	const warehouse = yield* WarehouseQueryService
	yield* Effect.annotateCurrentSpan({
		orgId: tenant.orgId,
		"maple.ai.tools.tool": payload.tool,
		"maple.ai.tools.fingerprint": payload.fingerprint,
	})
	const params = {
		orgId: tenant.orgId,
		startTime: payload.startTime,
		endTime: payload.endTime,
	}
	const selection = { ...toolsSelection(payload), fingerprint: payload.fingerprint }
	// The group's facts, side by side — every one of them the index.
	// The samples page separately (`toolErrorSamples`), so loading
	// more of them never re-reads these.
	const [sessions, variants, breakdown] = yield* Effect.all(
		[
			warehouse.compiledQuery(
				tenant,
				CH.compile(Integrations.aiToolErrorSessionsQuery(selection), params, {
					rowSchema: Integrations.aiToolErrorSessionsRowSchema,
				}),
				{ profile: "list", context: "aiToolsErrorSessions" },
			),
			warehouse.compiledQuery(
				tenant,
				CH.compile(Integrations.aiToolErrorVariantsQuery(selection), params, {
					rowSchema: Integrations.aiToolErrorVariantsRowSchema,
				}),
				{ profile: "list", context: "aiToolsErrorVariants" },
			),
			warehouse.compiledQuery(
				tenant,
				CH.compile(Integrations.aiToolErrorBreakdownQuery(selection), params, {
					rowSchema: Integrations.aiToolErrorBreakdownRowSchema,
				}),
				{ profile: "list", context: "aiToolsErrorBreakdown" },
			),
		],
		{ concurrency: 3 },
	)
	return new AiToolErrorDetailResponse({ sessions, variants, breakdown })
})

export const readAiToolErrorSamples = Effect.fn("aiSessions.toolErrorSamples")(function* (
	tenant: TenantContext,
	payload: AiToolErrorSamplesRequest,
) {
	const warehouse = yield* WarehouseQueryService
	yield* Effect.annotateCurrentSpan({
		orgId: tenant.orgId,
		"maple.ai.tools.tool": payload.tool,
		"maple.ai.tools.fingerprint": payload.fingerprint,
		"maple.ai.tools.paged": payload.before !== undefined,
	})
	if (payload.session !== undefined) {
		yield* Effect.annotateCurrentSpan({
			"maple.ai.tools.session": payload.session,
		})
	}
	const limit = payload.limit ?? Integrations.AI_TOOL_OCCURRENCES_LIMIT
	// One row past the page: the extra row is what tells a group that
	// exactly fills the page from one with a page after it.
	const ranked = yield* warehouse.compiledQuery(
		tenant,
		CH.compile(
			Integrations.aiToolErrorOccurrencesQuery({
				...toolsSelection(payload),
				fingerprint: payload.fingerprint,
				session: payload.session,
				variant: payload.variant,
				before: payload.before,
				limit: limit + 1,
			}),
			{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
			{ rowSchema: Integrations.aiToolErrorOccurrencesRowSchema },
		),
		{ profile: "list", context: "aiToolsErrorOccurrences" },
	)
	const occurrences = ranked.slice(0, limit)
	const last = occurrences[occurrences.length - 1]
	const nextCursor =
		ranked.length > limit && last !== undefined
			? { timestamp: last.timestamp, spanId: last.spanId }
			: undefined
	// The payloads are the only fact the modal shows that the index
	// does not carry, so they are read for exactly this page — bounded
	// by its `(TraceId, SpanId)` and by its own extent, which is the
	// partitions those calls landed in and no others. A page of
	// nothing reads no spans at all.
	const payloads = !Arr.isReadonlyArrayNonEmpty(occurrences)
		? []
		: yield* warehouse.compiledQuery(
				tenant,
				CH.compile(
					Integrations.aiToolErrorPayloadsQuery(occurrences),
					{
						orgId: tenant.orgId,
						...Integrations.aiToolErrorPayloadSlice(occurrences),
					},
					{ rowSchema: Integrations.aiToolErrorPayloadsRowSchema },
				),
				{ profile: "list", context: "aiToolsErrorPayloads" },
			)
	const payloadBySpan = new Map(payloads.map((row) => [`${row.traceId}:${row.spanId}`, row] as const))
	return new AiToolErrorSamplesResponse({
		...(nextCursor !== undefined && { nextCursor }),
		occurrences: occurrences.map((row) => {
			// A call whose span the payload read did not return — raw
			// retention is shorter than nothing here, but a span that
			// was never exported is real — still belongs on the list:
			// everything the row states about the failure came from the
			// index, and the block below it is empty.
			const payload = payloadBySpan.get(`${row.traceId}:${row.spanId}`)
			return {
				...row,
				statusCode: payload?.statusCode ?? "",
				arguments: payload?.arguments ?? "",
				argumentsBytes: payload?.argumentsBytes ?? 0,
				result: payload?.result ?? "",
				resultBytes: payload?.resultBytes ?? 0,
			}
		}),
	})
})

/**
 * The tools page's selection, as every one of its reads takes it.
 *
 * The page's `metric` and `percentile` are not here and are not in the request
 * either: every read returns calls, sessions, errors and all three percentiles,
 * so which one is drawn is a choice the client makes without a round trip.
 */
const toolsSelection = (payload: {
	readonly tool?: string
	readonly model?: string
	readonly service?: string
	readonly env?: string
	readonly search?: string
	readonly failingOnly?: boolean
}) => ({
	tool: payload.tool,
	model: payload.model,
	service: payload.service,
	env: payload.env,
	// The toolbar's two predicates. They go to every read, not just the
	// tables they visibly narrow: a search the tiles ignored would count calls
	// the chart below it was not drawing.
	search: payload.search,
	failingOnly: payload.failingOnly,
})

/**
 * The window of equal length ending where the caller's begins — the tiles'
 * comparison. Computed here rather than asked for, so the delta cannot be
 * quietly taken against a window of a different size.
 */
const previousWindow = (startTime: string, endTime: string) => {
	const start = parseWarehouseDateTime(startTime)
	const span = parseWarehouseDateTime(endTime) - start
	return {
		prevStartTime: formatWarehouseDateTime(start - span),
		prevEndTime: formatWarehouseDateTime(start),
	}
}

const NO_TOOLS_AGGREGATE: AiToolsAggregate = {
	calls: 0,
	sessions: 0,
	errors: 0,
	p50: 0,
	p90: 0,
	p95: 0,
}

/** One period's row of the totals union. Absent only if the branch returned
 *  nothing at all, which an aggregate over an empty window does not do. */
const aggregateOf = (
	rows: ReadonlyArray<Integrations.AiToolsTotalsOutput>,
	period: AiToolsPeriod,
): AiToolsAggregate => {
	const row = rows.find((candidate) => candidate.period === period)
	if (row === undefined) return NO_TOOLS_AGGREGATE
	return {
		calls: row.calls,
		sessions: row.sessions,
		errors: row.errors,
		p50: row.p50,
		p90: row.p90,
		p95: row.p95,
	}
}

const breakdownItem = (row: Integrations.AiToolsBreakdownsOutput): AiToolsBreakdownItem => ({
	key: row.key,
	calls: row.calls,
	sessions: row.sessions,
	errors: row.errors,
	p50: row.p50,
	p90: row.p90,
	p95: row.p95,
	lastSeen: row.lastSeen,
	firstSeen: row.firstSeen,
})

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
	const reporting: AiSessionTokenReporting = perCall
		? "per-call"
		: row.inputTokens + row.outputTokens + row.cacheReadTokens > 0
			? "roll-up"
			: "none"
	const tokens: AiSessionTokenTotals = perCall
		? { input: row.llmInputTokens, output: row.llmOutputTokens, cacheRead: row.llmCacheReadTokens }
		: { input: row.inputTokens, output: row.outputTokens, cacheRead: row.cacheReadTokens }
	// Cost follows the same rule, but only once something reported one: a
	// per-call session whose calls carry no price still has a session cost if
	// the wrapper stamped one.
	const cost = row.costReporters === 0 ? undefined : perCall && row.llmCost > 0 ? row.llmCost : row.cost
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
