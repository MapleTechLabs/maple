import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { AiAgentSpanSchema, AiGenAiValuesSchema } from "../gen-ai"
import { TinybirdDateTime } from "../query-engine"
import { BucketSeconds } from "./query-engine"
import { SessionAuthorization } from "./current-tenant"
import { HttpTaggedError } from "./error-policy"
import { warehouseReadHttpErrors } from "./warehouse"

// AI agent session endpoint schemas
//
// Backed by the `maple_ai.*` span attributes the ingest gateway stamps at
// decode time; a session is resolved at trace granularity by
// `aiSessionPageQuery` (which ranks a page and measures it off the index) and
// `aiSessionDetailsQuery` (which adds what only the traces' other spans can
// answer) in the query-engine integrations layer. The Agent Sessions page is
// behind the `agent_tracing` org rollout flag and these shapes exist for it
// alone, so they live in the internal tier where they can follow the UI.

/** The measures the list can be ordered by; `startTime` is the default. */
export const AI_SESSION_SORT_KEYS = [
	"startTime",
	"durationMs",
	"cost",
	"totalTokens",
	"errorSpanCount",
	"llmCalls",
	"toolCalls",
] as const
export const AiSessionSortKey = Schema.Literals(AI_SESSION_SORT_KEYS)
export type AiSessionSortKey = Schema.Schema.Type<typeof AiSessionSortKey>

export const AiSessionSortDir = Schema.Literals(["asc", "desc"])
export type AiSessionSortDir = Schema.Schema.Type<typeof AiSessionSortDir>

/** A range bound. Every measure the list filters on is non-negative, so a
 *  negative bound is a malformed request rather than an empty page. */
const RangeBound = Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)))
const CountBound = Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)))

/**
 * The counted filters, shared by the list and its details. They land on the
 * `ai_trace_index` level of both reads, one per index column, each as its own
 * per-trace existence test: `serviceNames` means "some agent span of the trace
 * came from this service", not "the trace touched it", and a model and a tool
 * given together are matched by different spans of the trace — see
 * `aiSessionPageQuery`. Each selects exactly the population its facet counted,
 * and the details read repeats them so it resolves a trace as the page did.
 */
const aiSessionCountedFilters = {
	vendorIds: Schema.optional(Schema.Array(Schema.String)),
	serviceNames: Schema.optional(Schema.Array(Schema.String)),
	deploymentEnvs: Schema.optional(Schema.Array(Schema.String)),
	models: Schema.optional(Schema.Array(Schema.String)),
	agentNames: Schema.optional(Schema.Array(Schema.String)),
	toolNames: Schema.optional(Schema.Array(Schema.String)),
	/**
	 * A session id or trace id, or the leading characters of one, matched as a
	 * prefix. Bounded because it becomes a `LIKE` pattern against the index —
	 * no id in either column is anywhere near this long.
	 */
	search: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
}

export class ListAiSessionsRequest extends Schema.Class<ListAiSessionsRequest>("ListAiSessionsRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	limit: Schema.optional(
		Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
	),
	/**
	 * Rows to skip, for the list's infinite scroll. Offset-based like the replays
	 * list, and applied on the index-only page ranking (`aiSessionPageQuery`),
	 * which is cheap to re-run at the volumes an org's agent traffic reaches
	 * (~10k index rows a day).
	 */
	offset: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
	...aiSessionCountedFilters,
	// The session-level filters: applied to the ranked row over the measures
	// the index carries per agent span, so they have no facet count behind
	// them. `hasErrors` means a failed agent span; a session whose only error
	// is on a non-agent span shows the badge but is not matched.
	hasErrors: Schema.optional(Schema.Boolean),
	/** Drop the `trace:` sessions — traces whose vendor exposes no session key. */
	excludeTraceSessions: Schema.optional(Schema.Boolean),
	durationMinMs: RangeBound,
	durationMaxMs: RangeBound,
	costMin: RangeBound,
	costMax: RangeBound,
	tokensMin: CountBound,
	tokensMax: CountBound,
	llmCallsMin: CountBound,
	llmCallsMax: CountBound,
	toolCallsMin: CountBound,
	toolCallsMax: CountBound,
	sortBy: Schema.optional(AiSessionSortKey),
	sortDir: Schema.optional(AiSessionSortDir),
}) {}

/**
 * What only the traces' other spans can say about a session — read after the
 * list has rendered, by `POST /details`. Each field is the all-span figure for
 * the list item's field of the same name, which the index answered over the
 * agent spans alone. The list takes `spanCount`, `serviceNames` and the extent;
 * it keeps the index's `errorSpanCount` and `durationMs`, which are what the
 * page was sorted and filtered on.
 */
export const AiSessionDetailsItem = Schema.Struct({
	sessionId: Schema.String,
	/** All spans of all the session's traces, including non-AI infrastructure spans. */
	spanCount: Schema.Number,
	/** Failed spans of any kind, plus the attribute-declared failures on agent spans. */
	errorSpanCount: Schema.Number,
	/** Every service touched by the session's traces. */
	serviceNames: Schema.Array(Schema.String),
	/** The session's true extent, first span to last — warehouse datetime literals. */
	startTime: Schema.String,
	endTime: Schema.String,
	durationMs: Schema.Number,
})
export type AiSessionDetailsItem = Schema.Schema.Type<typeof AiSessionDetailsItem>

export const AiSessionListItem = Schema.Struct({
	/** The vendor's own session id, or `trace:<TraceId>` for an agent trace whose
	 *  vendor exposes no session key — see `MAPLE_AI_TRACE_SESSION_PREFIX`. */
	sessionId: Schema.String,
	/** Vendor of the earliest session-bearing span, e.g. `eve`, `vercel_ai_sdk`. */
	vendorId: Schema.String,
	vendorVersion: Schema.String,
	traceCount: Schema.Number,
	// Answered over the session's AGENT spans by the index the list renders
	// from; the details read (`AiSessionDetailsItem`) replaces each with the
	// figure over every span, once the client asks for it.
	/** The session's spans — the agent's own until the details land. */
	spanCount: Schema.Number,
	/** Failed agent spans — what `hasErrors` and the errors sort read. */
	errorSpanCount: Schema.Number,
	/** Failed tool calls, one per failure rather than per span that echoed it. */
	toolErrorCount: Schema.Number,
	/** Failed model calls and turn spans that failed on their own. */
	turnErrorCount: Schema.Number,
	/** Services the agent spans came from until the details land, then every service touched. */
	serviceNames: Schema.Array(Schema.String),
	/** Every model any agent span of the session ran on, dialects coalesced. */
	models: Schema.Array(Schema.String),
	/** Every agent named on any agent span of the session, in no order. */
	agentNames: Schema.Array(Schema.String),
	/** The agent on the session's earliest-starting named span — the name the
	 *  list row goes by, resolved the way the detail page's heading resolves it.
	 *  `''` when no span named an agent. */
	firstAgentName: Schema.String,
	llmCalls: Schema.Number,
	toolCalls: Schema.Number,
	/** Tokens across every bucket, deepest reporter counted, so the number
	 *  agrees with the detail page's header. */
	totalTokens: Schema.Number,
	/** The five disjoint buckets the detail page's Tokens rail draws, summed
	 *  the same way; the row draws their shares. */
	inputTokens: Schema.Number,
	cacheReadTokens: Schema.Number,
	cacheWriteTokens: Schema.Number,
	outputTokens: Schema.Number,
	reasoningTokens: Schema.Number,
	/** USD as the instrumentation priced it; 0 where nothing reported a cost. */
	cost: Schema.Number,
	/** The extent of the agent spans until the details land, then the true
	 *  extent — warehouse datetime literals, e.g. `2026-08-19 10:33:25.825000000`. */
	startTime: Schema.String,
	endTime: Schema.String,
	/** The agent spans' extent in ms — what the duration sort and range read. */
	durationMs: Schema.Number,
})

export class ListAiSessionsResponse extends Schema.Class<ListAiSessionsResponse>("ListAiSessionsResponse")({
	data: Schema.Array(AiSessionListItem),
	/**
	 * How many sessions the page ranked — what the client pages on: the next
	 * offset is the sum of `ranked`, and a page is the last one when `ranked`
	 * is under the limit. Equal to `data.length` now that every ranked session
	 * is a row; kept as the paging contract, and optional only for a client
	 * built before the field existed.
	 */
	ranked: Schema.optionalKey(Schema.Number),
}) {}

/** The most sessions one details read covers — a page, as the list sizes it. */
export const AI_SESSION_DETAILS_MAX_SESSIONS = 100

/** The widest extent one details read accepts — the list's whole retention,
 *  which a page ranked by cost over a sparse month can span. Past it the read
 *  is a scan of partitions no page can have come from. */
export const AI_SESSION_DETAILS_MAX_EXTENT_MS = 31 * 24 * 60 * 60_000

/** `TinybirdDateTime` is UTC without a zone marker. */
const tinybirdDateTimeMs = (value: string): number => Date.parse(`${value.replace(" ", "T")}Z`)

export class ListAiSessionDetailsRequest extends Schema.Class<ListAiSessionDetailsRequest>(
	"ListAiSessionDetailsRequest",
)(
	Schema.Struct({
		/**
		 * The extent of the page's rows — the earliest `startTime` and the latest
		 * `endTime` among them, verbatim. Both reads behind this are bounded by it
		 * (the fan-out padded by an hour), so a page's own bounds are the only
		 * window that makes it a seek rather than a scan.
		 */
		startTime: TinybirdDateTime,
		endTime: TinybirdDateTime,
		/** The page's session ids, as the list returned them. */
		sessionIds: Schema.Array(Schema.String).check(
			Schema.isMinLength(1),
			Schema.isMaxLength(AI_SESSION_DETAILS_MAX_SESSIONS),
		),
		// The same counted filters the page was ranked under, or the two reads
		// resolve traces differently and a session's facts land under no row.
		...aiSessionCountedFilters,
	}).check(
		// The window reaches the fan-out's partition predicate as given, so an
		// inverted or retention-wide one is refused here rather than run.
		Schema.makeFilter(
			(request: { readonly startTime: string; readonly endTime: string }) => {
				const extentMs = tinybirdDateTimeMs(request.endTime) - tinybirdDateTimeMs(request.startTime)
				// The pattern admits `2026-13-45 99:99:99`, which parses to NaN and
				// would slip past both comparisons below.
				if (Number.isNaN(extentMs)) return "startTime and endTime must be valid datetimes"
				if (extentMs < 0) return "startTime must not be after endTime"
				if (extentMs > AI_SESSION_DETAILS_MAX_EXTENT_MS) return "the window is wider than any page's extent"
				return true
			},
			{ identifier: "DetailsWindowBounded" },
		),
	),
) {}

export class ListAiSessionDetailsResponse extends Schema.Class<ListAiSessionDetailsResponse>(
	"ListAiSessionDetailsResponse",
)({
	/**
	 * One item per session the fan-out found, in no particular order — merge by
	 * `sessionId`. A page session can be missing: `ai_trace_index` and
	 * `trace_detail_spans` are two materialized views written one after the
	 * other from the same insert, so the newest session can be ranked a moment
	 * before its spans are readable. Its row keeps the index's figures.
	 */
	data: Schema.Array(AiSessionDetailsItem),
}) {}

export class ListAiSessionsFacetsRequest extends Schema.Class<ListAiSessionsFacetsRequest>(
	"ListAiSessionsFacetsRequest",
)({
	// The window and nothing else: the facets are deliberately unfiltered, so
	// picking a vendor doesn't erase the other vendors from the sidebar.
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
}) {}

export const AiSessionFacetItem = Schema.Struct({
	name: Schema.String,
	count: Schema.Number,
})

export class ListAiSessionsFacetsResponse extends Schema.Class<ListAiSessionsFacetsResponse>(
	"ListAiSessionsFacetsResponse",
)({
	/** Distinct sessions per vendor id, matching what `vendorIds` selects. */
	vendors: Schema.Array(AiSessionFacetItem),
	/** Distinct sessions per service name, matching what `serviceNames` selects. */
	services: Schema.Array(AiSessionFacetItem),
	/** …per `deployment.environment(.name)`, matching `deploymentEnvs`. */
	environments: Schema.Array(AiSessionFacetItem),
	/** …per model, matching `models`. */
	models: Schema.Array(AiSessionFacetItem),
	/** …per agent name, matching `agentNames`. */
	agents: Schema.Array(AiSessionFacetItem),
	/** …per tool name, matching `toolNames`. */
	tools: Schema.Array(AiSessionFacetItem),
}) {}

/** Which of a session's spans a read returns. `ai` is the vendor-stamped
 *  spans alone — the transcript's whole input — and `app` is the complement,
 *  the service's own HTTP/DB work sharing the agent's traces. */
export const AiSessionSpanScope = Schema.Literals(["all", "ai", "app"])
export type AiSessionSpanScope = Schema.Schema.Type<typeof AiSessionSpanScope>

/**
 * Keyset position in a session's span order (`timestamp`, then `spanId`). Both
 * values are copied from the last span of the previous page: the timestamp is
 * the warehouse literal at nanosecond precision, which is what makes the pair
 * unique — agent spans routinely share a millisecond.
 */
export const AiSessionSpanCursor = Schema.Struct({
	timestamp: TinybirdDateTime,
	spanId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
})
export type AiSessionSpanCursor = Schema.Schema.Type<typeof AiSessionSpanCursor>

const TraceIdHex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/))

/** Traces one span read may be pinned to — a turn's worth, not a session's. */
export const AI_SESSION_SPANS_MAX_TRACE_IDS = 100

/**
 * Row ceiling for one page of a session's spans. The handler asks the query for
 * one row past it, so an exactly-full page is distinguishable from one with a
 * page after it.
 */
export const AI_SESSION_SPANS_MAX_SPANS = 2_000

export class GetAiSessionSpansRequest extends Schema.Class<GetAiSessionSpansRequest>(
	"GetAiSessionSpansRequest",
)(
	Schema.Struct({
	/**
	 * The framework's own session id, verbatim — `maple_ai.session.id` — or the
	 * `trace:<TraceId>` id Maple synthesizes for a GenAI trace that carries none
	 * (`MAPLE_AI_TRACE_SESSION_PREFIX`). The handler routes on the prefix and
	 * validates the trace id behind it; a prefixed id that is not one reads as a
	 * session nothing carries, which answers empty like any unknown id.
	 */
	sessionId: Schema.String.check(Schema.isMinLength(1)),
	// Optional, and the two halves are read as a pair — supply both or neither.
	//
	// With a window the read is partition-pruned on both levels (detection and
	// fan-out), which is the fast path every link from the list page takes: the
	// row already knows the session's own bounds, so it hands them over.
	//
	// Without one the handler resolves the session's bounds from the id first and
	// then runs the same pruned read. That resolve step is viable rather than
	// reckless where the fan-out would not be: `traces` carries a
	// `bloom_filter(0.01)` skip index over `mapValues(SpanAttributes)` for the id
	// to prune with, and its TTL caps any scan at 30 days. It still costs an
	// extra round trip and still degrades as an org's volume grows, so this is
	// the exception path for hint-less deep links — a pasted id, an MCP answer —
	// and not the default. The client is expected to write the bounds it got back
	// into its URL, which makes the second load of any such link the direct one.
	startTime: Schema.optionalKey(TinybirdDateTime),
	endTime: Schema.optionalKey(TinybirdDateTime),
	/** Defaults to `all`. */
	scope: Schema.optionalKey(AiSessionSpanScope),
	/** Spans strictly after this position; absent for the first page. */
	after: Schema.optionalKey(AiSessionSpanCursor),
	/**
	 * Read these traces of the session instead of resolving the session's
	 * traces — the per-turn read the detail page makes for a turn's `app`
	 * spans, where the turn already knows which traces it spans. Requires the
	 * window, which is what bounds the read; the session id is then only the
	 * span the request is annotated with.
	 */
	traceIds: Schema.optionalKey(Schema.Array(TraceIdHex).check(Schema.isMaxLength(AI_SESSION_SPANS_MAX_TRACE_IDS))),
	/** Page size, at most `AI_SESSION_SPANS_MAX_SPANS` (the default). */
	limit: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: AI_SESSION_SPANS_MAX_SPANS })),
	),
	}).check(
		// The window is what bounds a trace-pinned read, and the session id
		// cannot stand in for it: resolving the SESSION's bounds for traces named
		// outright is a round trip that answers empty for a session nothing
		// carries. Checked here so the miss is a 400 rather than an empty page.
		Schema.makeFilter(
			(request: { readonly traceIds?: readonly string[]; readonly startTime?: string; readonly endTime?: string }) =>
				request.traceIds === undefined ||
				(request.startTime !== undefined && request.endTime !== undefined) ||
				"traceIds requires startTime and endTime",
			{ identifier: "TraceIdsNeedWindow" },
		),
	),
) {}

export class GetAiSessionSummaryRequest extends Schema.Class<GetAiSessionSummaryRequest>(
	"GetAiSessionSummaryRequest",
)({
	/** As on `GetAiSessionSpansRequest`, including the `trace:` form. */
	sessionId: Schema.String.check(Schema.isMinLength(1)),
	/** As on `GetAiSessionSpansRequest`: both or neither. */
	startTime: Schema.optionalKey(TinybirdDateTime),
	endTime: Schema.optionalKey(TinybirdDateTime),
}) {}

export const AiSessionTokenTotals = Schema.Struct({
	input: Schema.Number,
	output: Schema.Number,
	cacheRead: Schema.Number,
})
export type AiSessionTokenTotals = Schema.Schema.Type<typeof AiSessionTokenTotals>

/**
 * How a session's usage was reported, which decides which spans' figures the
 * totals sum. `per-call`: the model-call spans carry usage, and the totals are
 * theirs alone — an agent span that also carries a roll-up of its children is
 * not added on top. `roll-up`: no model-call span reported anything, so the
 * totals are what the wrapping spans reported. `none`: nothing did.
 */
export const AiSessionTokenReporting = Schema.Literals(["per-call", "roll-up", "none"])
export type AiSessionTokenReporting = Schema.Schema.Type<typeof AiSessionTokenReporting>

/**
 * One turn of a session as the warehouse groups it: by `gen_ai.conversation.id`
 * (and the vendor spellings of it), falling back to the trace.
 *
 * The grouping sees one span at a time. A span that carries the id is the
 * turn's; a child that does not — a model call under a turn span that alone
 * was stamped — lands in its trace's row instead. The page's own turn model
 * walks parents and so places those children; these rows therefore sum to the
 * session exactly, but their count and their per-turn split are only as good
 * as the emitter's stamping. Session totals in the response are exact.
 */
export const AiSessionTurnSummary = Schema.Struct({
	turnKey: Schema.String,
	/** Empty when the turn is a trace with no conversation id. */
	conversationId: Schema.String,
	traceIds: Schema.Array(Schema.String),
	/** Warehouse datetime literals, like the list row's. */
	startTime: Schema.String,
	endTime: Schema.String,
	durationMs: Schema.Number,
	spanCount: Schema.Number,
	aiSpanCount: Schema.Number,
	llmCalls: Schema.Number,
	toolCalls: Schema.Number,
	errorSpanCount: Schema.Number,
	tokens: AiSessionTokenTotals,
	/** Absent when no span of the turn reported a cost. */
	cost: Schema.optionalKey(Schema.Number),
	models: Schema.Array(Schema.String),
	agentNames: Schema.Array(Schema.String),
})
export type AiSessionTurnSummary = Schema.Schema.Type<typeof AiSessionTurnSummary>

/** Turn rows one summary carries. A session grouping into more is summarised
 *  from its first rows alone and says so with `turnsTruncated`. */
export const AI_SESSION_SUMMARY_MAX_TURNS = 1_000

/**
 * The whole session's totals, computed in the warehouse — so they hold for a
 * session far larger than one spans response, which is the reason this exists.
 */
export class GetAiSessionSummaryResponse extends Schema.Class<GetAiSessionSummaryResponse>(
	"GetAiSessionSummaryResponse",
)({
	spanCount: Schema.Number,
	aiSpanCount: Schema.Number,
	traceCount: Schema.Number,
	/** Absent for an unknown session — one with no spans. */
	startTime: Schema.optionalKey(Schema.String),
	endTime: Schema.optionalKey(Schema.String),
	durationMs: Schema.Number,
	llmCalls: Schema.Number,
	toolCalls: Schema.Number,
	errorSpanCount: Schema.Number,
	tokens: AiSessionTokenTotals,
	tokenReporting: AiSessionTokenReporting,
	cost: Schema.optionalKey(Schema.Number),
	models: Schema.Array(Schema.String),
	agentNames: Schema.Array(Schema.String),
	turns: Schema.Array(AiSessionTurnSummary),
	turnsTruncated: Schema.Boolean,
}) {}

/**
 * Every `gen_ai.*` value the integration layer decoded off the span, one
 * optional key per catalog field. Generated from `AI_GENAI_FIELDS`, so the
 * wire shape and the decoder read the same list.
 */
export const AiSessionGenAiValues = AiGenAiValuesSchema
export type AiSessionGenAiValues = Schema.Schema.Type<typeof AiSessionGenAiValues>

/**
 * One span of a session, already normalized onto Maple's standard AI span
 * shape. The raw attribute maps the query reads are the bulk of that read and
 * are dropped server-side, so what lands here is the decoded view alone.
 */
export const AiSessionSpan = AiAgentSpanSchema
export type AiSessionSpan = Schema.Schema.Type<typeof AiSessionSpan>

export class GetAiSessionSpansResponse extends Schema.Class<GetAiSessionSpansResponse>(
	"GetAiSessionSpansResponse",
)({
	data: Schema.Array(AiSessionSpan),
	/**
	 * Where the next page starts; absent when this page ended the read. A page
	 * is the OLDEST spans not yet returned, so a client that stops paging holds
	 * the session's beginning and must say the end is missing rather than
	 * present what it has as a complete transcript.
	 */
	nextCursor: Schema.optionalKey(AiSessionSpanCursor),
}) {}

/**
 * Response ceiling for one session's spans, measured over the warehouse rows —
 * which still carry the raw attribute maps, in production ~17KB on a single
 * agent span.
 *
 * The byte counter accumulates over rows that are already parsed, so the
 * ceiling only trips once that much of the JS object graph is resident: it has
 * to sit far below the 128MB isolate heap, not near it. Replay events get 8MB
 * for opaque strings; 10MB here because these rows are attribute-map-heavy, and
 * `AI_SESSION_SPANS_MAX_SPANS` bounds the ordinary session well before this
 * does.
 *
 * For a pathologically attribute-heavy session the byte cap fires first and the
 * request 413s instead of truncating. That is the designed outcome — the
 * alternative is an OOM that takes the isolate with it.
 */
export const MAX_AI_SESSION_SPANS_RESPONSE_BYTES = 10_000_000

/**
 * One page of the session's spans exceeds `MAX_AI_SESSION_SPANS_RESPONSE_BYTES`.
 *
 * Distinct from the row cap, which ends the page and hands back a cursor: the
 * byte ceiling aborts the read before a response can be materialized, so there
 * is nothing to return. A smaller `limit` is the direct fix, and a narrower
 * window bounds both the session detection and the span fan-out — either
 * genuinely returns fewer bytes, which is what `recovery: "fix_request"`
 * points the caller at.
 */
export class AiSessionTooLargeError extends HttpTaggedError<AiSessionTooLargeError>()(
	"@maple/http/ai-sessions/AiSessionTooLargeError",
	{
		sessionId: Schema.String,
		message: Schema.String,
	},
	{
		status: 413,
		code: "ai_session_too_large",
		title: "Session is too large to load",
		message:
			"This page of the session's spans is too large to return in one response. Ask for fewer spans per page, or narrow the time range.",
		retry: "never",
		recovery: "fix_request",
		exposure: "redacted",
	},
) {}

// Agent Sessions › Overview
// ---------------------------------------------------------------------------
//
// The overview page: what the org's agents cost, how much they ran, and how
// often they failed, over the selected window and the one before it. Backed by
// `ai-overview.ts` in the query-engine integrations layer, off the same
// `ai_trace_index` rows and the same session key as the sessions list — so
// every number here reconciles with the list's rows for the same window.
//
// Two reads rather than one per question: the summary's tiles and its chart
// are the same measures under two groupings, and the breakdown is a third.
// Percentiles are what stops the tiles being folded from the chart
// client-side — quantiles do not merge.

/** Values one dimension filter accepts. A selection is built from the
 *  sessions page's facets, which return at most 50 values per dimension. */
const AI_OVERVIEW_FILTER_VALUES_MAX = 50

const OverviewFilterValues = Schema.optionalKey(
	Schema.Array(Schema.String.check(Schema.isMaxLength(200))).check(
		Schema.isMaxLength(AI_OVERVIEW_FILTER_VALUES_MAX),
	),
)

/**
 * The page's selection, as both reads take it — the sessions list's counted
 * filters, by the same names and with the same meaning.
 *
 * Every one of them selects SESSIONS: a session qualifies when any of its
 * spans carries the value, because a span carries either a model, an agent
 * name or a tool name and never all three. Values come from the sessions
 * page's facets, so a value that is not a facet value selects nothing by
 * design.
 */
const aiOverviewSelection = {
	vendorIds: OverviewFilterValues,
	serviceNames: OverviewFilterValues,
	deploymentEnvs: OverviewFilterValues,
	models: OverviewFilterValues,
	agentNames: OverviewFilterValues,
	toolNames: OverviewFilterValues,
	/** Sessions with at least one failed agent span — what the list's own
	 *  `hasErrors` selects, so the two pages agree about which sessions failed. */
	hasErrors: Schema.optionalKey(Schema.Boolean),
}

/**
 * The measures every overview read reports, so a tile, a point on the chart
 * and a breakdown row are the same numbers under different groupings.
 *
 * Usage is NETTED per session the way the sessions list nets it — a wrapper
 * that rolls up its children's tokens, a gateway's second trace of the same
 * call and a provider retry under the call each count once. Durations are
 * NANOSECONDS, like every other AI read.
 */
const aiOverviewMeasures = {
	sessions: Schema.Number,
	/** Sessions with at least one failed agent span. */
	erroredSessions: Schema.Number,
	/** Model calls, netted — the list row's `llmCalls`. The VOLUME: a wrapper's
	 *  roll-up, a gateway's mirror and a provider retry of one call are one
	 *  call. */
	llmCalls: Schema.Number,
	/** Model-call SPANS, counted raw — the denominator of the LLM error rate,
	 *  which is `erroredLlmCalls / llmCallSpans` and never `/ llmCalls`. The two
	 *  populations differ by every mirror and wrapper the netting collapses, so
	 *  a mirrored call that failed twice reads as a rate above 100% against the
	 *  netted volume. */
	llmCallSpans: Schema.Number,
	/** Model-call spans that failed. Not netted: the index carries no error
	 *  flag into the netting, so a framework that echoes a failure onto the
	 *  span wrapping the call reports it twice — the same span population as
	 *  `llmCallSpans`, which is why those two divide. */
	erroredLlmCalls: Schema.Number,
	toolCalls: Schema.Number,
	erroredToolCalls: Schema.Number,
	/** USD as the instrumentation priced it; 0 where nothing reported a cost. */
	cost: Schema.Number,
	/** Netted model calls that carried a price — the coverage behind `cost`,
	 *  which is 0 for "nobody priced it" and not for "free". */
	pricedLlmCalls: Schema.Number,
	/** Every token, netted. The five buckets below are its disjoint split —
	 *  except on rows materialized before the bucket columns existed, which
	 *  carry a total and five zeros; a client whose buckets sum to nothing
	 *  against a non-zero total shows the total. */
	tokens: Schema.Number,
	inputTokens: Schema.Number,
	cacheReadTokens: Schema.Number,
	cacheWriteTokens: Schema.Number,
	outputTokens: Schema.Number,
	reasoningTokens: Schema.Number,
	/** Quantiles of the session's extent, first agent span to last. */
	sessionDurationP50Ns: Schema.Number,
	sessionDurationP95Ns: Schema.Number,
	/** Quantiles of one model call's duration, over the calls of the sessions
	 *  this row measures. */
	llmDurationP50Ns: Schema.Number,
	llmDurationP95Ns: Schema.Number,
}

export const AiOverviewMeasures = Schema.Struct(aiOverviewMeasures)
export type AiOverviewMeasures = Schema.Schema.Type<typeof AiOverviewMeasures>

export const AiOverviewSeriesPoint = Schema.Struct({
	/** ISO-8601 with a literal `Z`, the shape every Maple timeseries emits. */
	bucket: Schema.String,
	...aiOverviewMeasures,
})
export type AiOverviewSeriesPoint = Schema.Schema.Type<typeof AiOverviewSeriesPoint>

/** The selection every bucketed overview read takes: the window, the width its
 *  buckets are cut at, and the filters. */
const aiOverviewBucketedSelection = {
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	/** Whole seconds, greater than zero — it reaches `toStartOfInterval` as an
	 *  `INTERVAL n SECOND` literal, so a fraction is a 400 and not a 500. */
	bucketSeconds: BucketSeconds,
	...aiOverviewSelection,
}

export class AiOverviewSummaryRequest extends Schema.Class<AiOverviewSummaryRequest>(
	"AiOverviewSummaryRequest",
)(aiOverviewBucketedSelection) {}

export class AiOverviewSummaryResponse extends Schema.Class<AiOverviewSummaryResponse>(
	"AiOverviewSummaryResponse",
)({
	/** Echoed back, so a client rendering an axis reads the width the buckets
	 *  were actually cut at rather than re-deriving it. */
	bucketSeconds: Schema.Number,
	/** The whole selected window. */
	current: AiOverviewMeasures,
	/**
	 * The window of equal length immediately before the caller's, measured by
	 * the same read — the deltas the tiles show. Zeros where nothing ran then,
	 * which the client renders as "no comparison" rather than a -100%.
	 */
	previous: AiOverviewMeasures,
	/**
	 * One point per bucket that had a session, oldest first. A session — and
	 * its netted usage, its calls and its failures — belongs to the bucket its
	 * FIRST span started in, so the points sum to `current` rather than
	 * counting a long session in every bucket it touched. Quantiles are the
	 * exception and cannot be summed at all, which is why `current` comes from
	 * its own un-bucketed read and not from these.
	 */
	series: Schema.Array(AiOverviewSeriesPoint),
	/** The same, over the previous window and at the same bucket width. */
	previousSeries: Schema.Array(AiOverviewSeriesPoint),
}) {}

/** Which dimension the breakdown groups by. Each is a column of
 *  `ai_trace_index`; there is no provider column — a model maps to its
 *  provider client-side. */
export const AiOverviewDimension = Schema.Literals([
	"model",
	"agent",
	"service",
	"environment",
	"vendor",
	"tool",
])
export type AiOverviewDimension = Schema.Schema.Type<typeof AiOverviewDimension>

/** Rows one breakdown returns, and the default. The page shows a table, not a
 *  catalogue: `totalKeys` is what lets it say "+ N more" off the same read. */
export const AI_OVERVIEW_BREAKDOWN_MAX = 12

/**
 * One key of a breakdown, measured over both windows.
 *
 * A row carries the whole measure set, but which of them MEAN anything depends
 * on the dimension, because `model` and `tool` restrict the population to the
 * spans that can carry the key — model calls and tool calls respectively:
 *
 * - `model`: `toolCalls` and `erroredToolCalls` are structurally 0 (a model
 *   call is not a tool call), and the usage, call and model-latency measures
 *   are the row's subject.
 * - `tool`: `llmCalls`, `llmCallSpans`, `erroredLlmCalls` and
 *   `llmDurationP*Ns` are structurally 0 (a tool call is not a model call),
 *   and `cost`, `tokens` and `pricedLlmCalls` are 0 for every tool span that
 *   reports no usage, which is all of them in practice. `toolCalls` and
 *   `erroredToolCalls` are the row's subject.
 * - `agent`, `service`, `environment`, `vendor`: every agent span carries the
 *   key, so every measure is meaningful.
 *
 * `sessions`, `erroredSessions` and `sessionDurationP*Ns` are always over THIS
 * key's spans: a session appears under every key it used, its failures are the
 * ones its spans under this key carried, and its extent runs from the first of
 * those spans to the last rather than across the whole session. A client
 * renders the columns the dimension supports rather than a column of zeros.
 */
export const AiOverviewBreakdownRow = Schema.Struct({
	/**
	 * The dimension's value. `''` is a real key, not a gap — a span that
	 * carries no value for this dimension — and the page renders it as
	 * unattributed rather than hiding it.
	 */
	key: Schema.String,
	current: AiOverviewMeasures,
	/** The same key over the previous window; zeros where it did not appear. */
	previous: AiOverviewMeasures,
})
export type AiOverviewBreakdownRow = Schema.Schema.Type<typeof AiOverviewBreakdownRow>

export class AiOverviewBreakdownRequest extends Schema.Class<AiOverviewBreakdownRequest>(
	"AiOverviewBreakdownRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	dimension: AiOverviewDimension,
	limit: Schema.optionalKey(
		Schema.Number.check(
			Schema.isInt(),
			Schema.isBetween({ minimum: 1, maximum: AI_OVERVIEW_BREAKDOWN_MAX }),
		),
	),
	...aiOverviewSelection,
}) {}

export class AiOverviewBreakdownResponse extends Schema.Class<AiOverviewBreakdownResponse>(
	"AiOverviewBreakdownResponse",
)({
	dimension: AiOverviewDimension,
	/**
	 * The busiest keys by session count, most sessions first.
	 *
	 * Rows OVERLAP and need not sum to the totals: a session that used two
	 * models is a session under each of them. What does not overlap is the
	 * usage — a model call's tokens are netted under the model that reported
	 * them, so the cost column splits rather than repeats.
	 */
	rows: Schema.Array(AiOverviewBreakdownRow),
	/** Distinct keys in the current window, so the table can say how many it
	 *  is not showing. */
	totalKeys: Schema.Number,
}) {}

/** One bucket's share of one model. */
export const AiOverviewModelMixPoint = Schema.Struct({
	/** ISO-8601 with a literal `Z`, the shape every Maple timeseries emits. */
	bucket: Schema.String,
	/** The model the spans named. Never `''` — a call that named no model has no
	 *  share of a model mix, and the read leaves it out. */
	model: Schema.String,
	/** Model-call SPANS, counted raw. See {@link AiOverviewModelMixResponse}. */
	llmCallSpans: Schema.Number,
})
export type AiOverviewModelMixPoint = Schema.Schema.Type<typeof AiOverviewModelMixPoint>

export class AiOverviewModelMixRequest extends Schema.Class<AiOverviewModelMixRequest>(
	"AiOverviewModelMixRequest",
)(aiOverviewBucketedSelection) {}

export class AiOverviewModelMixResponse extends Schema.Class<AiOverviewModelMixResponse>(
	"AiOverviewModelMixResponse",
)({
	/** Echoed back, so a client rendering an axis reads the width the buckets
	 *  were actually cut at rather than re-deriving it. */
	bucketSeconds: Schema.Number,
	/**
	 * One row per (bucket, model) the window saw, oldest bucket first and the
	 * busiest model of a bucket first.
	 *
	 * The share of model SPANS — the raw population the summary reports as
	 * `llmCallSpans`, so a gateway's mirror of a call is counted under the model
	 * it names, twice. Netting would charge a mirrored call to one model alone
	 * and leave the bands disagreeing with the error rate above them. A band's
	 * share is its count over its bucket's, and the client folds the minor
	 * models into an "other" band rather than plotting a line per model.
	 */
	rows: Schema.Array(AiOverviewModelMixPoint),
}) {}

export class AiSessionsInternalApiGroup extends HttpApiGroup.make("aiSessionsInternal")
	.add(
		HttpApiEndpoint.post("list", "/list", {
			payload: ListAiSessionsRequest,
			success: ListAiSessionsResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("details", "/details", {
			payload: ListAiSessionDetailsRequest,
			success: ListAiSessionDetailsResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("facets", "/facets", {
			payload: ListAiSessionsFacetsRequest,
			success: ListAiSessionsFacetsResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("spans", "/spans", {
			payload: GetAiSessionSpansRequest,
			success: GetAiSessionSpansResponse,
			error: [...warehouseReadHttpErrors, AiSessionTooLargeError],
		}),
	)
	.add(
		HttpApiEndpoint.post("summary", "/summary", {
			payload: GetAiSessionSummaryRequest,
			success: GetAiSessionSummaryResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("overviewSummary", "/overview/summary", {
			payload: AiOverviewSummaryRequest,
			success: AiOverviewSummaryResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("overviewBreakdown", "/overview/breakdown", {
			payload: AiOverviewBreakdownRequest,
			success: AiOverviewBreakdownResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("overviewModelMix", "/overview/model-mix", {
			payload: AiOverviewModelMixRequest,
			success: AiOverviewModelMixResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.prefix("/internal/ai-sessions")
	.middleware(SessionAuthorization) {}
