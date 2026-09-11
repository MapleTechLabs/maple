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

// ---------------------------------------------------------------------------
// Agent Sessions › Tools
// ---------------------------------------------------------------------------
//
// The tool analytics page, backed by `ai-tools.ts` in the query-engine
// integrations layer. Same source as the sessions list — `ai_trace_index`,
// filtered to `IsToolCall = 1` — and the same session key, so a row here links
// straight to a session there.
//
// Four reads rather than one, because they answer four different `GROUP BY`s
// over the same population and the page asks for them at different times: the
// chart on every state change, the tiles beside it, the breakdown panels, and
// the session list only once a tool is picked. Percentiles are what stops the
// tiles being folded from the chart client-side — quantiles do not merge.

/** The page's selection. `tool`, `model`, `service` and `env` are exact
 *  matches on values the sessions page's facets produced; `search` and
 *  `failingOnly` are the toolbar's own two predicates. */
const aiToolsSelection = {
	/** `gen_ai.tool.name`. Absent means "every tool", which is what makes the
	 *  chart's series per-tool rather than per-model. */
	tool: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
	/**
	 * The model a tool call is ATTRIBUTED to — its parent model call's, else its
	 * trace's. Tool spans carry no model of their own; see the query module's
	 * header for how the two-step attribution works and what it misses.
	 */
	model: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
	service: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
	/** `deployment.environment(.name)` — the MV coalesces both spellings. */
	env: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
	/**
	 * Tool-name substring, case-insensitive. The one field here that is not an
	 * exact facet value, and it narrows the whole population rather than one
	 * table — so the tiles cannot describe calls the chart is not drawing.
	 */
	search: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
	/** Keep only calls whose span failed. */
	failingOnly: Schema.optional(Schema.Boolean),
}

/** The measures every tools read reports, so a tile, a chart point and a
 *  breakdown row are the same numbers under different groupings. */
const aiToolsMeasures = {
	calls: Schema.Number,
	/** Distinct sessions, keyed exactly as the sessions list keys them. */
	sessions: Schema.Number,
	/** Tool calls whose span failed (`IsError = 1`). */
	errors: Schema.Number,
	// Nanoseconds, like every other AI read — the client formats them. Zero is
	// a real duration here: several SDKs emit structured-output pseudo-tools
	// that complete instantly, and they are counted.
	p50: Schema.Number,
	p90: Schema.Number,
	p95: Schema.Number,
}

/**
 * Which dimension the chart's series are keyed by. Derived from the selection
 * unless the request names one: no tool selected compares tools, a tool without
 * a model compares the models it ran under, and both selected is a single
 * `tool` series. `none` is one series over the whole selection — every key
 * merged INSIDE the query, so its quantiles and its session count are measured
 * rather than averaged.
 */
export const AiToolsSeriesKind = Schema.Literals(["tool", "model", "none"])
export type AiToolsSeriesKind = Schema.Schema.Type<typeof AiToolsSeriesKind>

export class AiToolsSeriesRequest extends Schema.Class<AiToolsSeriesRequest>("AiToolsSeriesRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	/** Whole seconds, greater than zero — it reaches `toStartOfInterval` as an
	 *  `INTERVAL n SECOND` literal, so a fraction is a 400 and not a 500. */
	bucketSeconds: BucketSeconds,
	/**
	 * What the series split by. Absent lets the server derive it from the
	 * selection, which is what the overview wants; the tool detail page sends
	 * `none` because it draws one tool and merging a per-model split client-side
	 * would sum sessions across models and average their quantiles.
	 */
	split: Schema.optionalKey(AiToolsSeriesKind),
	...aiToolsSelection,
}) {}

/**
 * The key every series past the top few is folded into, so the chart's total
 * still equals the totals tile. A tool genuinely named `other` merges with it —
 * accepted, because the alternative is a synthesized key no legend can render.
 */
export const AI_TOOLS_OTHER_SERIES_KEY = "other"

export const AiToolsSeriesPoint = Schema.Struct({
	/** ISO-8601 with a literal `Z`, the shape every Maple timeseries emits. */
	bucket: Schema.String,
	/**
	 * The tool or model this point measures, per the response's `seriesKind`.
	 * `''` is a real key — a tool call whose model resolved to neither its
	 * parent nor its trace — and `other` is the fold of every key past the top
	 * few, which keeps the stacked total equal to the totals tile.
	 */
	seriesKey: Schema.String,
	...aiToolsMeasures,
})

export class AiToolsSeriesResponse extends Schema.Class<AiToolsSeriesResponse>("AiToolsSeriesResponse")({
	data: Schema.Array(AiToolsSeriesPoint),
	/** What `seriesKey` names — the legend's title, and how the client labels
	 *  a click on a series. */
	seriesKind: AiToolsSeriesKind,
}) {}

export const AiToolsAggregate = Schema.Struct(aiToolsMeasures)
export type AiToolsAggregate = Schema.Schema.Type<typeof AiToolsAggregate>

export class AiToolsTotalsRequest extends Schema.Class<AiToolsTotalsRequest>("AiToolsTotalsRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	...aiToolsSelection,
}) {}

export class AiToolsTotalsResponse extends Schema.Class<AiToolsTotalsResponse>("AiToolsTotalsResponse")({
	current: AiToolsAggregate,
	/**
	 * Every session of the window, before the selection and before the toolbar —
	 * the denominator the Sessions tile states its share against, and the count
	 * the tab strip shows. Unfiltered on purpose: a share against a denominator
	 * that moves with the filters is not a share.
	 */
	allSessions: Schema.Number,
	/** The first and last matched call, as warehouse datetime literals; `''`
	 *  where nothing matched. Bounded by the window, so "first seen" is
	 *  "first seen in this range". */
	firstSeen: Schema.String,
	lastSeen: Schema.String,
	/**
	 * The window of equal length immediately before the caller's, measured by
	 * the same query — the deltas the tiles show. Zeros where nothing ran then,
	 * which the client renders as "no comparison" rather than a -100%.
	 */
	previous: AiToolsAggregate,
}) {}

/** Rows the Tools breakdown returns, busiest first — the same cap the query
 *  applies and the footer states, so the page can say "the 50 busiest" rather
 *  than "all 50". */
export const AI_TOOLS_BREAKDOWN_MAX = 50

export const AiToolsBreakdownItem = Schema.Struct({
	/** The tool name or the model name, per which list this came from. */
	key: Schema.String,
	...aiToolsMeasures,
	/** The latest tool call under this key, as a warehouse datetime literal. */
	lastSeen: Schema.String,
	/** The earliest one, same shape — what the table's `new` badge reads. */
	firstSeen: Schema.String,
})
export type AiToolsBreakdownItem = Schema.Schema.Type<typeof AiToolsBreakdownItem>

export class AiToolsBreakdownsRequest extends Schema.Class<AiToolsBreakdownsRequest>(
	"AiToolsBreakdownsRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	...aiToolsSelection,
}) {}

export class AiToolsBreakdownsResponse extends Schema.Class<AiToolsBreakdownsResponse>(
	"AiToolsBreakdownsResponse",
)({
	/**
	 * Every tool, scoped to the rest of the selection but NOT to the selected
	 * tool — the table exists to pick a different tool, so filtering by the
	 * current one would return the single row already on screen.
	 */
	tools: Schema.Array(AiToolsBreakdownItem),
}) {}

/* -------------------------------------------------------------------------------------------------
 * Tool detail — the failures of one tool
 *
 * Two reads, and both are keyed by a REQUIRED `tool`: they are the tool detail
 * page's, and the whole-org version of either question is the overview's error
 * rate column. Everything else about the selection is the same bag the four
 * reads above take, so the page's toolbar narrows its failures exactly as it
 * narrows its charts.
 * -----------------------------------------------------------------------------------------------*/

/** The selection with the tool required — the tool detail page's own scope. */
const aiToolSelectionForTool = {
	...aiToolsSelection,
	tool: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
}

/** Error types one breakdown returns, and occurrences one modal opens with. */
export const AI_TOOL_ERRORS_MAX = 100

export const AiToolErrorItem = Schema.Struct({
	/** `error.type` as the span reported it. `''` is a real group: a call that
	 *  failed without naming a type, which the page labels `unknown`. */
	errorType: Schema.String,
	/** The most recent status message under this type, truncated by the read. */
	message: Schema.String,
	/** Failed calls with this type. */
	calls: Schema.Number,
	sessions: Schema.Number,
	firstSeen: Schema.String,
	lastSeen: Schema.String,
})
export type AiToolErrorItem = Schema.Schema.Type<typeof AiToolErrorItem>

export class AiToolErrorsRequest extends Schema.Class<AiToolErrorsRequest>("AiToolErrorsRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	...aiToolSelectionForTool,
	limit: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: AI_TOOL_ERRORS_MAX })),
	),
}) {}

export class AiToolErrorsResponse extends Schema.Class<AiToolErrorsResponse>("AiToolErrorsResponse")({
	data: Schema.Array(AiToolErrorItem),
}) {}

/** One session that hit an error type, for the modal's left pane. */
export const AiToolErrorSessionItem = Schema.Struct({
	sessionId: Schema.String,
	agentName: Schema.String,
	model: Schema.String,
	/** Occurrences of this error type in this session. */
	hits: Schema.Number,
	lastSeen: Schema.String,
})
export type AiToolErrorSessionItem = Schema.Schema.Type<typeof AiToolErrorSessionItem>

/** One failed call, with what it was called with and what came back. */
export const AiToolErrorOccurrence = Schema.Struct({
	timestamp: Schema.String,
	traceId: Schema.String,
	spanId: Schema.String,
	sessionId: Schema.String,
	agentName: Schema.String,
	model: Schema.String,
	errorType: Schema.String,
	message: Schema.String,
	/** Nanoseconds, like every other AI duration. */
	durationNs: Schema.Number,
	statusCode: Schema.String,
	/** Truncated by the read; `*Bytes` is the payload's true size, which is what
	 *  the modal prints beside the block. */
	arguments: Schema.String,
	argumentsBytes: Schema.Number,
	result: Schema.String,
	resultBytes: Schema.Number,
})
export type AiToolErrorOccurrence = Schema.Schema.Type<typeof AiToolErrorOccurrence>

export class AiToolErrorDetailRequest extends Schema.Class<AiToolErrorDetailRequest>(
	"AiToolErrorDetailRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	...aiToolSelectionForTool,
	/** The error type the modal is open on. Present-but-empty selects the calls
	 *  that named no type, which is the `unknown` row. */
	errorType: Schema.String.check(Schema.isMaxLength(200)),
	/** Narrow the occurrences to one session — the left pane's selection. */
	session: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400))),
	limit: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: AI_TOOL_ERRORS_MAX })),
	),
}) {}

export class AiToolErrorDetailResponse extends Schema.Class<AiToolErrorDetailResponse>(
	"AiToolErrorDetailResponse",
)({
	/** Every session that hit this error type, busiest first — NOT narrowed by
	 *  `session`, which is what makes the pane a way out of the one selected. */
	sessions: Schema.Array(AiToolErrorSessionItem),
	occurrences: Schema.Array(AiToolErrorOccurrence),
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
		HttpApiEndpoint.post("toolsSeries", "/tools/series", {
			payload: AiToolsSeriesRequest,
			success: AiToolsSeriesResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("toolsTotals", "/tools/totals", {
			payload: AiToolsTotalsRequest,
			success: AiToolsTotalsResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("toolsBreakdowns", "/tools/breakdowns", {
			payload: AiToolsBreakdownsRequest,
			success: AiToolsBreakdownsResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("toolErrors", "/tools/errors", {
			payload: AiToolErrorsRequest,
			success: AiToolErrorsResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("toolErrorDetail", "/tools/error-detail", {
			payload: AiToolErrorDetailRequest,
			success: AiToolErrorDetailResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.prefix("/internal/ai-sessions")
	.middleware(SessionAuthorization) {}
