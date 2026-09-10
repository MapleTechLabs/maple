// AI agent sessions — read side
//
// The ingest gateway stamps three attributes on AI-agent spans at decode time
// (`apps/ingest/src/ai_session.rs`): `maple_ai.vendor.id`,
// `maple_ai.vendor.version` and `maple_ai.session.id`. Only the last one is
// sparse — a vendor exposes a session key on the spans that own the turn
// (`ai.eve.turn`, `invoke_agent`), never on the sibling `chat`, `execute_tool`,
// `workflow.*` or HTTP-client spans it fans out to.
//
// So a session is resolved at TRACE granularity: a trace belongs to a session
// if ANY of its spans carries that session id, and then EVERY span of that
// trace is part of the session — including the completely non-AI ones. That is
// deliberate; the dashboard shows the full agent context, not just the spans
// the framework happened to label.
//
// A trace can carry no session id at all and still be an agent run: several
// vendors (haystack, litellm, llamaindex, semantic_kernel, effect_ai) expose no
// session key, and the `unknown:*` buckets never do. Those traces used to be
// invisible here. They are now sessions of one trace, keyed
// `trace:<TraceId>` (`MAPLE_AI_TRACE_SESSION_PREFIX`) — the same page, with the
// single trace as the whole context. That is why detection keys on the VENDOR
// stamp rather than the session one: the vendor id is on every span the gateway
// classified as GenAI, so it is the marker that finds both populations, and the
// session id becomes a grouping key rather than an admission test.
//
// The list is two reads against two different tables, and only the first is
// on the page's critical path:
//
//   page — `aiSessionPageQuery`, over `ai_trace_index`: the filtered
//     projection holding ONLY the vendor-stamped spans (~0.01% of rows),
//     pre-extracted to plain columns by `ai_trace_index_mv`. It is the one
//     level that sees the caller's whole window, and the one that can afford
//     to: ~10k narrow rows a day against 70M raw spans, ~300ms over a week of
//     production. It resolves every trace to its session key, ranks the
//     sessions by their first agent span, and yields one page of rows — every
//     fact the list row shows, measured over the session's agent spans. The
//     list renders from this read alone.
//   details — `aiSessionDetailsQuery`, over `trace_detail_spans`, restricted
//     to that page's traces by `TraceId IN (…)`. `TraceId` is a sort-key
//     prefix there (`(OrgId, TraceId, SpanId)`), so this is a seek — but a
//     seek on object storage that costs ~0.4s per partition the page spans
//     warm and seconds cold, measured in production on 2026-09-10, whatever
//     columns it reads (dropping the attribute map changed nothing). So it
//     answers only what the index cannot — the facts about the traces' OTHER
//     spans: their count, every service they touched, failures outside the
//     agent's own spans, and the true extent — and the client asks for it
//     after the page has rendered, replacing the index's agent-only figures
//     as it lands. The route runs it once per partition the page's padded
//     extent touches, side by side (`aiSessionDetailsSlices`), and folds the
//     rows back together (`mergeAiSessionDetails`): a cold day then costs its
//     own seconds rather than every other day's, and the 15s ceiling is per
//     day rather than per page. The same fan-out against raw `traces` times
//     out at 10s on a 7-day window in production: that table is sorted
//     `(OrgId, ServiceName, SpanName, Timestamp)` and `idx_trace_id` is only a
//     bloom skip index, which prunes far too little at this org's volume.
//
// Detection used to run the vendor predicate against raw `traces` behind the
// `mapKeys(SpanAttributes)` bloom skip index, and that shape cannot be saved:
// GenAI spans arrive continuously — about one per index granule at production
// volume — so the bloom prunes nothing and the scan reads the fat Map column
// for EVERY span in the window. Measured 2026-08-29 in production: ~3.6s for a
// one-hour window, dead at the 15s kill by a day. The index is the same
// predicate applied at insert time.
//
// The fan-out used to run over every qualifying trace in the window and page
// with LIMIT/OFFSET afterwards, and that shape cannot be saved either — by the
// index or by anything else. `trace_detail_spans` sits on object storage, and
// what a seek costs there is set by the partitions it touches, not by the rows
// it returns: measured 2026-09-02 in production, five trace ids across the 32
// retained partitions ran past 10s, while a page's worth of sessions inside
// one partition took 1.3–2.8s cold and ~300ms warm. The old shape read three
// partitions for a one-day window (5–15s, eight of 31 reads killed at the 15s
// ceiling over three days) and all of them for the 30-day window the page
// offers (killed, every time). Paging first is what bounds the fan-out to the
// hours a page spans; and even so bounded it stayed the list's whole cost
// (p50 2.5s, p90 8s over the week before 2026-09-10) while the page read
// beside it took ~300ms — which is why the list no longer waits for it.
//
// `IN` rather than a JOIN for the fan-out, the same reason
// `errorDetailTracesQuery` uses it — ClickHouse pushes the id set into the
// read, which a JOIN does not do. The JOIN the details read DOES carry is one
// level up, between two derived tables of at most a page of traces each, and
// it is there so the fan-out takes the session key the page resolved rather
// than deriving its own from the spans: two derivations over two windows can
// disagree, and a disagreement would file the facts under a row the page
// never showed.
//
// The index fills forward from its deploy: rows already in `traces` when the MV
// was created are not in it until a backfill runs, so the page (and the
// facets) can under-report windows that predate the deploy. The fan-out and the
// per-session reads still see every span of any trace the page finds.
//
// The window predicate on the fan-out is the PAGE's, not the caller's: the
// bounds of the page's agent spans as the page rows report them, padded by
// `FAN_OUT_PAD_SECONDS` so a trace's non-agent spans on either side are
// counted too. `trace_detail_spans` is `PARTITION BY toDate(Timestamp)`, so
// the predicate is the only thing that prunes partitions there, and the
// padded extent is cut at every midnight into one read per partition. At
// production volume a page of sessions ordered by start spans hours — one
// read, two around midnight — while an org with a few sessions a day has a
// first page that spans weeks, and its details are as many reads as days,
// each the cost of one partition rather than all of them in one query.
//
// A caller that has no window — a deep link carrying only a session id —
// resolves one with `aiSessionWindowQuery` first, rather than running the
// fan-out unpruned. That query still reads raw `traces`, and can: it prunes by
// the session id VALUE, which the `mapValues(SpanAttributes)` bloom index does
// serve (the id is rare), unlike the presence-of-key detection this file moved
// off `traces` — and the table's 30-day TTL bounds what is left.
//
// A `trace:` id needs neither the attribute detection nor the fan-out: it names
// the trace outright, so `aiTraceWindowQuery`/`aiTraceSpansQuery` are the same
// two reads with `TraceId = {traceId}` in place of the detection subquery —
// `idx_trace_id` on `traces` for the bounds, the `(OrgId, TraceId, SpanId)`
// sort key on `trace_detail_spans` for the spans.
//
// Tenant scoping: a subquery contributes nothing to the outer query's scope, so
// every level that reads a table repeats `OrgId = {orgId}` itself. The outermost
// level of `aiSessionDetailsQuery` reads a derived table rather than a table,
// and inherits `org` scope from it.

import { Schema } from "effect"
import * as CH from "@maple-dev/effect-clickhouse/expr"
import * as T from "@maple-dev/effect-clickhouse/types"
import { compile } from "@maple-dev/effect-clickhouse/sql"
import {
	compileFnCall,
	from,
	fromQuery,
	inSubquery,
	param,
	QueryBuilderDefect,
	unionAll,
	type CHUnionQuery,
	type ColumnAccessor,
	type CompiledQueryRowSchema,
} from "@maple-dev/effect-clickhouse"
import { AiTraceIndex, TraceDetailSpans, Traces } from "@maple/query-engine/ch/tables"
import { CHNumber } from "@maple/query-engine/ch/schema"
import {
	AI_SESSION_SPANS_MAX_SPANS,
	AI_SESSION_SUMMARY_MAX_TURNS,
	type AiSessionSortDir,
	type AiSessionSortKey,
	type AiSessionSpanScope,
} from "@maple/domain/http"
import {
	AI_AGENT_OPERATIONS,
	AI_INFERENCE_OPERATIONS,
	AI_PROMPT_VARIABLE_PREFIX,
	AI_RETRIEVAL_OPERATIONS,
	AI_TOOL_OPERATIONS,
	MAPLE_AI_SESSION_ID_ATTR,
	MAPLE_AI_TRACE_SESSION_PREFIX,
	MAPLE_AI_VENDOR_ID_ATTR,
	MAPLE_NATIVE_TURN_ID_ATTR,
	type AiGenAiField,
} from "@maple/domain/gen-ai"
import { aiFieldSourceKeys, aiSpanAttributeKeys } from "./ai-integrations"
import {
	childClaimsExpr,
	MAX_USAGE_REPORTERS_PER_TRACE,
	nettedReportersExpr,
	reportingSpanIdsExpr,
	sessionLlmCalls,
	sessionReportersExpr,
	sessionUsageSum,
	usageReportersExpr,
} from "./ai-span-columns"

const SESSION_ID_ATTR = MAPLE_AI_SESSION_ID_ATTR
const VENDOR_ID_ATTR = MAPLE_AI_VENDOR_ID_ATTR
const ERROR_TYPE_ATTR = "error.type"
const RESPONSE_STATUS_ATTR = "gen_ai.response.status"
/** `gen_ai.response.status` values that mean the generation failed — semconv's
 *  `failed` plus the pre-enum `error` dialect. Mirrors `spanFailed` in
 *  `apps/web/src/lib/agent-sessions/session-turns.ts`; the list badge and the
 *  detail's Failures panel must count the same spans. */
const FAILED_RESPONSE_STATUSES = ["failed", "error"]

/**
 * Sorts every span that does NOT carry a fact behind every one that does, so a
 * single `argMin`/`min` over it picks the earliest span carrying it without
 * needing an `argMinIf` the DSL does not have. Wrapped in `toDateTime` rather
 * than left a bare string, or `if()` would have to reconcile DateTime64(9) with
 * String. That wrapper is also why the sentinel is 2106 and not 3000: `DateTime`
 * tops out at 2106-02-07 and anything past it fails to parse.
 */
const SESSION_ORDER_SENTINEL = "2106-01-01 00:00:00"

/**
 * How far past the page's own agent-span bounds the `trace_detail_spans`
 * fan-out reads, in seconds — applied by `aiSessionDetailsSlices`, which cuts
 * the padded extent into the reads `aiSessionDetailsQuery` is run as.
 *
 * The pad exists because a trace's non-agent spans lie outside its agent
 * spans: measured over two days of production (4,920 agent traces,
 * 2026-09-02), the first span leads the first agent span by at most 0.1s and
 * the last span trails the last agent span by at most 10 minutes. An hour
 * contains both with room to spare and keeps the read inside one partition
 * (`PARTITION BY toDate(Timestamp)`) for every page but the ones nearest
 * midnight; a day would make it three partitions every time, which is what
 * the fan-out's cost is made of. A trace whose spans reach further than an
 * hour past its agent spans is clamped in the list row alone.
 */
const FAN_OUT_PAD_SECONDS = 3_600

/**
 * The pad on the bounds `aiSessionWindowQuery`/`aiTraceWindowQuery` report for
 * a deep link, in seconds. A whole partition rather than the list's hour: that
 * path resolves ONE session, so the extra partitions cost one read, and the
 * detail page shows the spans themselves — clamping there would cut a
 * transcript, where the list would only under-count a cell.
 */
const WINDOW_PAD_SECONDS = 86_400

/** ClickHouse returns `''` for a missing Map key, so presence needs both halves. */
const hasSessionId = (attrs: CH.Expr<Record<string, string>>, get: CH.Expr<string>) =>
	CH.mapContains(attrs, SESSION_ID_ATTR).and(get.neq(""))

/** Not in the builder's function set; same local helper `tracesDetailQuery` uses. */
const fromUnixTimestamp64Nano = (nanos: CH.Expr<number>): CH.Expr<string> =>
	compileFnCall<string>("fromUnixTimestamp64Nano", nanos)

/** Lexicographic ordering key — ClickHouse compares tuples element by element,
 *  which is how one `argMin` expresses "lowest rank, then earliest". Not in the
 *  builder's function set, and never selected: it only ever orders an argMin. */
const orderTuple = (...parts: ReadonlyArray<unknown>): CH.Expr<unknown> =>
	compileFnCall<unknown>("tuple", ...parts)

/**
 * The session id a trace is filed under: the vendor's own where it has one,
 * else `trace:<TraceId>` — a session of exactly this one trace.
 *
 * Reads the per-trace derived table rather than raw spans, because
 * sessionless-ness is a property of the TRACE and not of the span: most spans of
 * a session-bearing trace carry no session id themselves, and keying on that
 * would file each of them as its own sessionless trace.
 */
const sessionKey = (rawSessionId: CH.Expr<string>, traceId: CH.Expr<string>): CH.Expr<string> =>
	CH.if_(rawSessionId.eq(""), CH.concat(MAPLE_AI_TRACE_SESSION_PREFIX, traceId), rawSessionId)

/**
 * One trace's failed agent spans — `(SpanId, ParentSpanId, IsToolCall)` per
 * failed index row — for the tool/turn split one level up, which needs the
 * whole trace's failures in hand at once. Same shape and cap as
 * `usageReportersExpr`, for the same reason: a framework that fails the turn
 * span because the call beneath it failed reports one failure as two, and
 * only the deepest span carrying the failure counts — `failureEvents` in
 * `apps/web/src/lib/agent-sessions/session-summary.ts`, one level deep.
 */
const failedSpansExpr = ($: {
	readonly SpanId: CH.Expr<string>
	readonly ParentSpanId: CH.Expr<string>
	readonly IsToolCall: CH.Expr<number>
	readonly IsError: CH.Expr<number>
}): CH.Expr<unknown> =>
	CH.untypedExpr(
		`groupArrayIf(${MAX_USAGE_REPORTERS_PER_TRACE})(tuple(SpanId, ParentSpanId, IsToolCall), IsError = 1)`,
	)

/**
 * Failed spans of one kind, summed over the traces' `failedSpans`, with a
 * failed span whose own child also failed left out: the child is the failure,
 * the parent its echo. `tool` counts the failed tool calls; the rest — failed
 * model calls and turn spans that failed on their own — are the turn's.
 *
 * One level, and without the signal, where `shadowedAncestorIds` walks every
 * ancestor and shadows only a match: the index carries no error signal (its
 * `IsError` is a flag), and a framework that echoes a failure copies it onto
 * the span that WRAPS the call, not two levels up — the roll-ups seen in
 * production are all parent-and-child. The two counts can disagree for a
 * turn span that fails on its own while a tool beneath it also fails (the
 * detail counts both, this counts one), which reads as one turn failing
 * either way; the cost of an exact copy is an error column on the index.
 */
const deepestFailureCount = (failedSpans: string, kind: "tool" | "turn"): CH.Expr<number> =>
	CH.rawExpr(
		`sum(arrayCount(f -> f.3 ${kind === "tool" ? "=" : "!="} 1 AND NOT has(tupleElement(${failedSpans}, 2), f.1), ${failedSpans}))`,
		T.float64,
	)

/**
 * `mapFilter((k, v) -> <predicate>, map)` — the entries whose KEY passes.
 *
 * The predicate is built from the lambda's key parameter, so it can use every
 * condition the DSL has (`in_`, `like`, `or`, …); values are not inspected.
 * Lives here until `@maple-dev/effect-clickhouse` ships a `mapFilter`.
 */
const mapFilterKeys = (
	mapExpr: CH.Expr<Record<string, string>>,
	predicate: (key: CH.Expr<string>) => CH.Condition,
): CH.Expr<Record<string, string>> =>
	CH.rawExpr(
		`mapFilter((k, v) -> ${compile(predicate(CH.rawExpr("k", T.string)).toFragment())}, ${compile(mapExpr.toFragment())})`,
		T.map(T.string, T.string),
	)

/**
 * The filters the page and the list share; both apply them on `ai_trace_index`,
 * each as a per-trace existence test — see `indexTraces`. One per index
 * column, so each selects exactly the population `aiSessionFacetsQuery`
 * counted for it.
 */
export interface AiSessionFilterOpts {
	readonly vendorIds?: readonly string[]
	readonly serviceNames?: readonly string[]
	readonly deploymentEnvs?: readonly string[]
	readonly models?: readonly string[]
	readonly agentNames?: readonly string[]
	readonly toolNames?: readonly string[]
	/**
	 * A session id or trace id, or the leading characters of one — what a
	 * reader pastes from a ticket, a log line, or the list row itself. Matched
	 * as a prefix against both id columns of the index.
	 */
	readonly search?: string
}

export interface AiSessionPageOpts extends AiSessionFilterOpts {
	/** Sessions returned, most recently started first unless `sortBy` says otherwise. */
	readonly limit?: number
	/** Sessions skipped before `limit` applies — the list's next page. */
	readonly offset?: number
	// Session-level filters — `HAVING` on the ranked session row, over the
	// measures the index carries per span (migration 0026). A failure here is
	// a failed AGENT span; the row's `errorSpanCount` counts every span of the
	// trace, so a session whose only error is on an HTTP span is listed with a
	// badge and not matched by the filter. A duration here is the extent of
	// the agent spans, which the true extent trails by minutes at most (see
	// `FAN_OUT_PAD_SECONDS`).
	readonly hasErrors?: boolean
	/** Drop the `trace:` sessions — traces whose vendor exposes no session key. */
	readonly excludeTraceSessions?: boolean
	readonly durationMinMs?: number
	readonly durationMaxMs?: number
	readonly costMin?: number
	readonly costMax?: number
	readonly tokensMin?: number
	readonly tokensMax?: number
	readonly llmCallsMin?: number
	readonly llmCallsMax?: number
	readonly toolCallsMin?: number
	readonly toolCallsMax?: number
	readonly sortBy?: AiSessionSortKey
	readonly sortDir?: AiSessionSortDir
}

export interface AiSessionPageOutput {
	/** The vendor's own session id, or `trace:<TraceId>` for a trace that has
	 *  none — see `MAPLE_AI_TRACE_SESSION_PREFIX`. */
	readonly sessionId: string
	/** Vendor of the session's earliest session-bearing agent span, else its
	 *  earliest agent span — the framework that ran the turn, not the SDK it
	 *  called through. */
	readonly vendorId: string
	readonly vendorVersion: string
	/** Extent of the session's agent spans inside the window, first start to
	 *  last end — warehouse datetime literals, the shape
	 *  `aiSessionDetailsQuery`'s `fanOutStart` and `fanOutEnd` params take
	 *  back, and the row's own bounds until the details replace them. */
	readonly agentStart: string
	readonly agentEnd: string
	/** Traces of the session — every trace is an agent trace, so exact. */
	readonly traceCount: number
	/** The session's AGENT spans; the details read counts every span. */
	readonly spanCount: number
	/** Services the agent spans came from; the details read adds the rest. */
	readonly serviceNames: readonly string[]
	/** Every model any agent span of the session ran on, dialects coalesced. */
	readonly models: readonly string[]
	/** Every agent named on any agent span of the session, in no order. */
	readonly agentNames: readonly string[]
	/** The agent on the session's earliest-starting named span — what the list
	 *  row calls the session, and what the detail page's heading resolves to
	 *  from the spans themselves. `''` when no span named an agent. */
	readonly firstAgentName: string
	readonly llmCalls: number
	readonly toolCalls: number
	/** Failed agent spans — what `hasErrors` tests; not the row's all-span count. */
	readonly errorAgentSpans: number
	/** Failed tool calls, deepest failure counted — see `deepestFailureCount`. */
	readonly toolErrors: number
	/** Failed model calls and turn spans that failed on their own — the rest. */
	readonly turnErrors: number
	/** Tokens across every bucket, deepest reporter counted, one claim per response id — see `sessionUsageSum`. */
	readonly totalTokens: number
	// The five disjoint buckets `totalTokens` is the sum of, counted the same
	// way — zeros on a session whose rows predate migration 0031.
	readonly inputTokens: number
	readonly cacheReadTokens: number
	readonly cacheWriteTokens: number
	readonly outputTokens: number
	readonly reasoningTokens: number
	/** USD as the instrumentation priced it; 0 where nothing reported a cost. */
	readonly cost: number
	/** Extent of the agent spans, what the duration filter and sort read. */
	readonly agentDurationMs: number
}

export interface AiSessionDetailsOpts extends AiSessionFilterOpts {
	/**
	 * The page to detail, as `aiSessionPageQuery` ranked it — under the same
	 * filters, or the two reads resolve traces differently. Never empty: an
	 * empty page has nothing to detail, and an empty list here is a defect
	 * rather than an empty result.
	 */
	readonly sessionIds: readonly string[]
}

/** Which pair of params bounds an `ai_trace_index` read: the caller's window
 *  (`startTime`/`endTime`) or the page's (`fanOutStart`/`fanOutEnd`). */
type IndexBounds = "window" | "page"

/** What the index cannot answer about a session: the facts of its traces'
 *  other spans. Each replaces the page row's agent-only figure of the same name. */
export interface AiSessionDetailsOutput {
	/** The vendor's own session id, or `trace:<TraceId>` for a trace that has
	 *  none — see `MAPLE_AI_TRACE_SESSION_PREFIX`. */
	readonly sessionId: string
	/** All spans of all the session's traces, including non-AI infrastructure spans. */
	readonly spanCount: number
	/** Failed spans of any kind, plus the attribute-declared failures on agent spans. */
	readonly errorSpanCount: number
	/** Every service touched by the session's traces. */
	readonly serviceNames: readonly string[]
	/** ClickHouse datetime literal, e.g. `2026-08-19 10:33:25.825000000`. */
	readonly startTime: string
	readonly endTime: string
	readonly durationMs: number
}

/**
 * A pasted id, as a `LIKE` prefix pattern.
 *
 * Strips what the list row itself shows around a `trace:` id — the prefix and
 * the trailing ellipsis — so copying the visible text finds the row. Escapes the
 * three characters `LIKE` reads as syntax; the builder quotes the literal.
 */
export function idSearchPattern(search: string): string {
	let needle = search.trim()
	if (needle.startsWith(MAPLE_AI_TRACE_SESSION_PREFIX)) {
		needle = needle.slice(MAPLE_AI_TRACE_SESSION_PREFIX.length)
	}
	needle = needle.replace(/…+$/, "")
	return `${needle.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

/** Distinct models/agents collected per trace for the list row. */
const MAX_NAMES_PER_TRACE = 20

/**
 * One row per agent trace in the window, off `ai_trace_index` alone: the
 * trace's session key, the bounds of its agent spans, and the per-trace
 * measures the page ranks on. The level both stages share, so a trace resolves
 * to the same session in the page and in the aggregation.
 *
 * The page reads it over the caller's window; the aggregation over the page's
 * own bounds, which is the same thing for every trace ON the page: a page
 * trace's index rows all lie between its session's `agentStart` and `agentEnd`,
 * and the page's bounds contain every session's. So the key and the filters
 * come out identical, from hours of the index rather than the caller's month.
 * A trace that is NOT on the page can key differently over the narrower read,
 * and is then discarded by the page's key list like any other — unless it
 * carries two session ids and only the lesser one falls inside the page's
 * bounds, which no vendor has been seen to produce.
 *
 * `rawSessionId` is `max` over the trace's index rows because the session id
 * sits on the turn-owning span alone (see the file header) and every other row
 * reads `''`, which `max` discards.
 *
 * A filter is a TRACE-level existence test — "some agent span of the trace
 * carries this value" — applied after the grouping, not a row predicate before
 * it. A row predicate would also narrow the rows `rawSessionId` is read from,
 * and a vendor filter would then file a trace under `trace:` whenever its
 * session-bearing span belongs to another vendor — an eve agent calling through
 * the Vercel AI SDK carries both. And the three GenAI identity columns are
 * mutually exclusive by construction — a chat span has a model and no tool, a
 * tool span the reverse, the session id sits on the turn-owning span alone —
 * so a row predicate ANDing `Model IN (…)` with `ToolName IN (…)` could only
 * match a row carrying both, and that pair of facets, each with a non-zero
 * count, would return an empty list. The population is the one the facets
 * count: `aiSessionFacetsQuery` also collects per trace and counts any-span.
 *
 * The measures are collected here per trace and summed per session one level
 * up. Usage travels as the trace's reporters rather than a sum, because a
 * wrapper's roll-up of its children cannot be undone one row at a time — see
 * `usageReportersExpr`.
 */
const indexTraces = (opts: AiSessionFilterOpts, bounds: IndexBounds) => {
	const values = (list: readonly string[] | undefined) => (list?.length ? list : undefined)
	const search = opts.search?.trim() || undefined
	const carries = (cond: CH.Condition) => CH.countIf(cond).gt(0)
	return from(AiTraceIndex)
		.select(($) => {
			// Ranks the trace's spans for the agent-name `argMin`: a span that
			// names an agent sorts at its own timestamp, one that does not sorts
			// at the sentinel and can never win — here, or one level up where the
			// same column orders the traces. A sentinel because the DSL has no
			// `argMinIf`.
			// A trace that names no agent at all ties every span at the sentinel,
			// and the tie is harmless because every candidate's name is `''`.
			const agentOrder = CH.if_(
				$.AgentName.neq(""),
				$.Timestamp,
				CH.toDateTime(CH.lit(SESSION_ORDER_SENTINEL)),
			)
			// Ranks the trace's spans for the vendor `argMin`s: session-bearing
			// first, then the rest, and inside each rank the earliest — the order
			// the fan-out once ranked the raw spans by, less the rank for an
			// unstamped span, which the index never holds. A single trace
			// legitimately carries several vendors (an eve agent calling through
			// the Vercel AI SDK), and the root-most session-bearing span is the one
			// that names the framework that ran the turn; `max(VendorId)` picked
			// the SDK alphabetically. A tuple, compared element by element, so
			// ties at one rank fall through to time rather than to whichever row
			// ClickHouse read first.
			const vendorOrder = orderTuple(CH.if_($.SessionId.neq(""), CH.lit(0), CH.lit(1)), $.Timestamp)
			return {
				traceId: $.TraceId,
				rawSessionId: CH.max_($.SessionId),
				vendorId: CH.argMin($.VendorId, vendorOrder),
				vendorVersion: CH.argMin($.VendorVersion, vendorOrder),
				// Carried so the session level can rank its traces the same way.
				vendorAt: CH.min_(vendorOrder),
				// Named apart from the page's `agentStart`/`agentEnd`: an outer alias
				// shadows the derived table's column of the same name, so `min(…)` of
				// it would resolve to the outer `toString(…)` String and fail — see
				// `traceStart` in `aiSessionDetailsQuery`.
				traceAgentStart: CH.min_($.Timestamp),
				traceAgentEnd: CH.max_($.Timestamp),
				// `Timestamp` is the span's START; the extent ends where the
				// last-starting agent span ended. Same idiom as `traceEndNanos`.
				traceAgentEndNanos: CH.max_(
					CH.toUnixTimestamp64Nano($.Timestamp).add(CH.toInt64($.Duration)),
				),
				agentSpanCount: CH.count(),
				// Bounded per trace: a row is a list cell, and a trace that somehow
				// names more models than that is not one the cell can show anyway.
				serviceNames: CH.groupUniqArrayIf(MAX_NAMES_PER_TRACE)($.ServiceName, $.ServiceName.neq("")),
				models: CH.groupUniqArrayIf(MAX_NAMES_PER_TRACE)($.Model, $.Model.neq("")),
				agentNames: CH.groupUniqArrayIf(MAX_NAMES_PER_TRACE)($.AgentName, $.AgentName.neq("")),
				// The name the session goes by, and when that name first appeared.
				// `agentNames` is a set — `groupUniqArrayIf`, then `groupUniqArrayArray`
				// across traces — so its first element is whatever the aggregate
				// happened to emit, while the detail page's heading is the agent on the
				// session's earliest-starting named span. Taking the heading from the
				// set left a multi-agent session titled one thing in the list and
				// another on its own page.
				firstAgentName: CH.argMin($.AgentName, agentOrder),
				firstAgentAt: CH.min_(agentOrder),
				toolCalls: CH.sum($.IsToolCall),
				errorAgentSpans: CH.sum($.IsError),
				failedSpans: failedSpansExpr($),
				// Usage AND model calls travel as reporters: both are counted one level
				// up, where every trace of the session is in hand — see `ai-span-columns`.
				usageReporters: usageReportersExpr($),
			}
		})
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTimeString(bounds === "window" ? "startTime" : "fanOutStart")),
			$.Timestamp.lte(param.dateTimeString(bounds === "window" ? "endTime" : "fanOutEnd")),
		])
		.groupBy("traceId")
		.having(($) => [
			CH.when(values(opts.vendorIds), (v) => carries(CH.inList($.VendorId, v))),
			CH.when(values(opts.serviceNames), (v) => carries(CH.inList($.ServiceName, v))),
			CH.when(values(opts.deploymentEnvs), (v) => carries(CH.inList($.DeploymentEnv, v))),
			CH.when(values(opts.models), (v) => carries(CH.inList($.Model, v))),
			CH.when(values(opts.agentNames), (v) => carries(CH.inList($.AgentName, v))),
			CH.when(values(opts.toolNames), (v) => carries(CH.inList($.ToolName, v))),
			CH.when(search, (needle) => {
				const pattern = idSearchPattern(needle)
				return carries($.SessionId.like(pattern).or($.TraceId.like(pattern)))
			}),
		])
}

/** The session-level columns of the page, carried through every level above
 *  the one that computes them — the row as the index answers it, less the
 *  usage the netting still has to sum. */
const SESSION_COLUMNS = [
	"sessionId",
	"vendorId",
	"vendorVersion",
	"agentStart",
	"agentEnd",
	"traceCount",
	"spanCount",
	"serviceNames",
	"models",
	"agentNames",
	"firstAgentName",
	"toolCalls",
	"errorAgentSpans",
	"toolErrors",
	"turnErrors",
	"agentDurationMs",
] as const
type SessionColumn = (typeof SESSION_COLUMNS)[number]

const carry = <Row extends Record<SessionColumn, unknown>>(row: Row): Pick<Row, SessionColumn> =>
	Object.fromEntries(SESSION_COLUMNS.map((column) => [column, row[column]])) as Pick<Row, SessionColumn>

/**
 * The page: which sessions the list shows, in what order, and everything a
 * row shows about them that the index can answer — the read the list renders
 * from, and the only one that sees the caller's whole window. See the file
 * header for why the fan-out cannot, and for what `aiSessionDetailsQuery`
 * adds afterwards.
 *
 * Detection admits any trace with a GenAI span, and the session id then groups
 * rather than admits: a trace that carries one is filed under it — with the
 * session's other traces — and a trace that carries none becomes a session of
 * its own, keyed `trace:<TraceId>`. Sessionless is the normal state for whole
 * vendors, not an edge case; see this file's header.
 *
 * Three levels above the trace. The session level groups the traces: every
 * measure the index carries per span, summed, and the session's usage
 * reporters collected for the two levels above it, which net them into
 * claims and sum the claims (`nettedReportersExpr`, `sessionUsageSum`). What
 * a level computes is what it costs — not per row but per query: the
 * warehouse analyses every lambda in a SELECT before it reads a row, and the
 * netting written out per measure at one level was most of a page read in
 * production (~300ms of a 450ms read over a week, the same on an empty
 * window). One netting pass, then eight small sums off its result, is half
 * of that.
 *
 * Ordered by the first AGENT span, not the first span of any kind: the index
 * carries only agent spans, and the two differ by under a second in practice
 * (see `FAN_OUT_PAD_SECONDS`). The row's `startTime` still reports the true
 * first span; the caller keeps the page in this order rather than re-sorting
 * by it, so what is shown is the order that was paged. A measure sort
 * (`sortBy`) orders by that measure first, with the first agent span and then
 * `sessionId` breaking ties, so a page boundary never splits two sessions that
 * share a start.
 *
 * Which level ranks follows the sort: the session level has every measure
 * but usage in hand, so it orders and cuts the page before the netting runs,
 * which then grades the page alone; a sort or a filter on cost, tokens or
 * model calls nets every session in the window and ranks on the level that
 * has the sums. The session-level filters are `HAVING` on the ranked row, or
 * `WHERE` on the summed one, and cost nothing beyond the index scan the page
 * already is. What they cannot do is count — a facet for "sessions over $1"
 * would be another pass over the same index per bucket, which the sidebar
 * does not ask for.
 *
 * The remaining gap is between traces, not inside one: a session whose OTHER
 * traces lie entirely outside the range is still found only by the traces that
 * touched it, which needs a session-keyed table to fix and not a wider window.
 */
export function aiSessionPageQuery(opts: AiSessionPageOpts = {}) {
	const limit = opts.limit ?? 50
	const offset = opts.offset ?? 0

	// The `HAVING` and `WHERE` levels see the aliases by name only.
	const column = {
		sessionId: CH.dynamicColumn<string>("sessionId", T.string),
		errorAgentSpans: CH.dynamicColumn<number>("errorAgentSpans", T.float64),
		agentDurationMs: CH.dynamicColumn<number>("agentDurationMs", T.float64),
		cost: CH.dynamicColumn<number>("cost", T.float64),
		totalTokens: CH.dynamicColumn<number>("totalTokens", T.float64),
		llmCalls: CH.dynamicColumn<number>("llmCalls", T.float64),
		toolCalls: CH.dynamicColumn<number>("toolCalls", T.float64),
	}
	const sortBy = opts.sortBy ?? "startTime"
	const sortDir = opts.sortDir ?? "desc"
	// The measure a sort key names on this level. `startTime` is the first
	// agent span, and `errorSpanCount` the failed agent spans — the row's own
	// numbers are the fan-out's, which the page cannot see.
	const sortColumn = {
		startTime: "agentStart",
		durationMs: "agentDurationMs",
		cost: "cost",
		totalTokens: "totalTokens",
		errorSpanCount: "errorAgentSpans",
		llmCalls: "llmCalls",
		toolCalls: "toolCalls",
	} as const satisfies Record<AiSessionSortKey, string>
	type UsageSort = "cost" | "totalTokens" | "llmCalls"
	type SessionSort = Exclude<(typeof sortColumn)[AiSessionSortKey], UsageSort> | "sessionId"
	const order: Array<[SessionSort | UsageSort, AiSessionSortDir]> =
		sortBy === "startTime"
			? [["agentStart", sortDir]]
			: [
					[sortColumn[sortBy], sortDir],
					["agentStart", "desc"],
				]
	order.push(["sessionId", "asc"])
	// Usage exists only once the reporters are netted, two levels up; the
	// session level orders on everything else.
	const sortsOnSession = (_specs: typeof order): _specs is Array<[SessionSort, AiSessionSortDir]> =>
		sortBy !== "cost" && sortBy !== "totalTokens" && sortBy !== "llmCalls"
	const filtersOnUsage = [
		opts.costMin,
		opts.costMax,
		opts.tokensMin,
		opts.tokensMax,
		opts.llmCallsMin,
		opts.llmCallsMax,
	].some((bound) => bound !== undefined)
	// Only a positive offset is emitted: `OFFSET 0` is a no-op that would still
	// change the compiled SQL of every first-page read.
	const paged = <Q extends { limit(n: number): Q; offset(n: number): Q }>(query: Q): Q =>
		offset > 0 ? query.limit(limit).offset(offset) : query.limit(limit)

	const sessions = fromQuery(indexTraces(opts, "window"), "index_traces")
		.select(($) => ({
			// The grouping key, and the only level that can compute it: the
			// derived table is one row per trace, so a trace with no session id
			// of its own becomes a session of one trace here rather than joining
			// every other sessionless trace under `''`.
			sessionId: sessionKey($.rawSessionId, $.traceId),
			// Across traces the same ordering resolves the session's vendor: its
			// earliest session-bearing span's, else its earliest agent span's.
			vendorId: CH.argMin($.vendorId, $.vendorAt),
			vendorVersion: CH.argMin($.vendorVersion, $.vendorAt),
			agentStart: CH.toString_(CH.min_($.traceAgentStart)),
			// The extent's END, not the last agent span's start: the row shows
			// this as the session's end until the details replace it.
			agentEnd: CH.toString_(fromUnixTimestamp64Nano(CH.max_($.traceAgentEndNanos))),
			// `count()`, not `uniq()`: the derived table already emits exactly one
			// row per trace, so this is exact and cheaper.
			traceCount: CH.count(),
			spanCount: CH.sum($.agentSpanCount),
			serviceNames: CH.groupUniqArrayArray($.serviceNames),
			models: CH.groupUniqArrayArray($.models),
			agentNames: CH.groupUniqArrayArray($.agentNames),
			// Across traces the same ordering resolves the session's own first
			// named agent: a trace that named none carries the sentinel and loses
			// to any trace that did.
			firstAgentName: CH.argMin($.firstAgentName, $.firstAgentAt),
			toolCalls: CH.sum($.toolCalls),
			errorAgentSpans: CH.sum($.errorAgentSpans),
			toolErrors: deepestFailureCount("failedSpans", "tool"),
			turnErrors: deepestFailureCount("failedSpans", "turn"),
			// Nanoseconds first, wrapped in `intDiv` — see `durationMs` in
			// `aiSessionDetailsQuery` for both.
			agentDurationMs: CH.intDiv(
				CH.max_($.traceAgentEndNanos).sub(CH.toUnixTimestamp64Nano(CH.min_($.traceAgentStart))),
				1_000_000,
			),
			// The usage, still as reporters: netted one level up, summed two —
			// with the two lookups the netting makes taken off the reporters here,
			// once per session, rather than once per reporter inside the netting.
			reporters: sessionReportersExpr("usageReporters"),
			childClaims: childClaimsExpr("reporters"),
			reportingIds: reportingSpanIdsExpr("reporters"),
		}))
		.groupBy("sessionId")
		.having(() => [
			CH.whenTrue(opts.hasErrors, () => column.errorAgentSpans.gt(0)),
			CH.whenTrue(opts.excludeTraceSessions, () =>
				CH.not(column.sessionId.like(`${MAPLE_AI_TRACE_SESSION_PREFIX}%`)),
			),
			CH.when(opts.durationMinMs, (v) => column.agentDurationMs.gte(v)),
			CH.when(opts.durationMaxMs, (v) => column.agentDurationMs.lte(v)),
			CH.when(opts.toolCallsMin, (v) => column.toolCalls.gte(v)),
			CH.when(opts.toolCallsMax, (v) => column.toolCalls.lte(v)),
		])
	// A String order, and a correct one: the literal is fixed-width
	// `YYYY-MM-DD hh:mm:ss.nnnnnnnnn`, so it sorts as the instant does.
	const ranked =
		sortsOnSession(order) && !filtersOnUsage ? paged(sessions.orderBy(...order)) : sessions

	const netted = fromQuery(ranked, "ranked_sessions").select(($) => ({
		...carry($),
		netted: nettedReportersExpr("reporters", "childClaims", "reportingIds"),
	}))

	const page = fromQuery(netted, "netted_sessions")
		.select(($) => ({
			...carry($),
			llmCalls: sessionLlmCalls("netted"),
			totalTokens: sessionUsageSum("netted", "tokens"),
			cost: sessionUsageSum("netted", "cost"),
			inputTokens: sessionUsageSum("netted", "inputTokens"),
			cacheReadTokens: sessionUsageSum("netted", "cacheReadTokens"),
			cacheWriteTokens: sessionUsageSum("netted", "cacheWriteTokens"),
			outputTokens: sessionUsageSum("netted", "outputTokens"),
			reasoningTokens: sessionUsageSum("netted", "reasoningTokens"),
		}))
		.where(() => [
			CH.when(opts.costMin, (v) => column.cost.gte(v)),
			CH.when(opts.costMax, (v) => column.cost.lte(v)),
			CH.when(opts.tokensMin, (v) => column.totalTokens.gte(v)),
			CH.when(opts.tokensMax, (v) => column.totalTokens.lte(v)),
			CH.when(opts.llmCallsMin, (v) => column.llmCalls.gte(v)),
			CH.when(opts.llmCallsMax, (v) => column.llmCalls.lte(v)),
		])
		// Re-ordered even when the session level already did: a level of its
		// own keeps no order, and the page's order is the page's.
		.orderBy(...order)
	return (sortsOnSession(order) && !filtersOnUsage ? page : paged(page)).format("JSON")
}

/**
 * One row per session of the page `aiSessionPageQuery` ranked, with the facts
 * the index cannot answer — those of the traces' spans that are not agent
 * spans. The client asks for it once the page has rendered, and each field
 * replaces the row's agent-only figure of the same name. Bounded by the page
 * alone: `fanOutStart`/`fanOutEnd` are the extent of the page's agent spans,
 * and the index reads run inside them — see `indexTraces` for why the index
 * level resolves a page trace exactly as the page did without the caller's
 * window. The fan-out runs inside `spansStart`/`spansEnd`: one slice of the
 * padded extent, as `aiSessionDetailsSlices` cuts it, so a read touches one
 * partition of `trace_detail_spans`; the caller runs the slices side by side
 * and folds the rows with `mergeAiSessionDetails`.
 *
 * The filters land on the index level, which means "the trace's agent spans
 * came from this service" rather than "the trace touched this service". A
 * trace spans services by definition, so the alternative — filtering the
 * fan-out — would silently drop spans and under-count `spanCount`. The agent
 * spans come from the agent's own service, which is the one a user filtering by
 * service means.
 *
 * Once a trace is on the page it is aggregated across the padded extent
 * rather than the caller's window, so `startTime`/`endTime`/`durationMs`/
 * `spanCount`/`errorSpanCount`/`serviceNames` describe the whole trace rather
 * than the slice of it that fell inside the range — a session that began an
 * hour before the range no longer reports the range edge as its start, and
 * the detail page can read the bounds this row carries as the session's own.
 * Whole, that is, once the slices are merged: a trace whose spans straddle
 * midnight is two rows until then.
 *
 * Ordered by `startTime` for a caller that reads it alone; the list's caller
 * merges by session id, and the page's order is the page's.
 */
export function aiSessionDetailsQuery(opts: AiSessionDetailsOpts) {
	// A defect, not a failure: `IN ()` is not SQL, and the caller already knows
	// its page is empty — see `AiSessionDetailsOpts`.
	if (opts.sessionIds.length === 0) {
		throw new QueryBuilderDefect({
			message: "aiSessionDetailsQuery needs the page's session ids; an empty page has nothing to detail",
		})
	}
	// The page's traces, keyed as the page keyed them — read twice below, once
	// as the id set the fan-out seeks by and once joined for the key, over the
	// page's bounds rather than the caller's window (see `indexTraces`).
	const onPage = ($: { rawSessionId: CH.Expr<string>; traceId: CH.Expr<string> }) =>
		CH.inList(sessionKey($.rawSessionId, $.traceId), opts.sessionIds)
	const pageTraceIds = fromQuery(indexTraces(opts, "page"), "agent_traces")
		.select(($) => ({ traceId: $.traceId }))
		.where(($) => [onPage($)])
	const pageTraces = fromQuery(indexTraces(opts, "page"), "agent_traces")
		.select(($) => ({ traceId: $.traceId, rawSessionId: $.rawSessionId }))
		.where(($) => [onPage($)])

	// Per trace: every span of a page trace, session-bearing or not, inside the
	// page's padded window.
	const perTrace = from(TraceDetailSpans)
		.select(($) => {
			return {
				traceId: $.TraceId,
				spanCount: CH.count(),
				// Span status, or an attribute-declared failure on a vendor-stamped
				// span: frameworks record failed model/tool calls as values on `Ok`
				// spans, and the badge must agree with the detail page's counting.
				errorSpanCount: CH.countIf(
					$.StatusCode.eq("Error").or(
						$.SpanAttributes.get(VENDOR_ID_ATTR)
							.neq("")
							.and(
								$.SpanAttributes.get(ERROR_TYPE_ATTR)
									.neq("")
									.or(
										CH.inList(
											$.SpanAttributes.get(RESPONSE_STATUS_ATTR),
											FAILED_RESPONSE_STATUSES,
										),
									),
							),
					),
				),
				serviceNames: CH.groupUniqArray($.ServiceName),
				// Named apart from the outer `startTime`/`endTime` on purpose: an
				// outer alias shadows the derived table's column of the same name,
				// so `min(startTime)` would resolve to the outer `toString(…)` String
				// and `toUnixTimestamp64Nano` reject it — verified against production,
				// it fails with ILLEGAL_TYPE_OF_ARGUMENT.
				traceStart: CH.min_($.Timestamp),
				// `Timestamp` is the span's START, so `max(Timestamp)` is when the
				// last span BEGAN — the trace end is that span's start plus its own
				// duration. Without the `+ Duration` a session whose trace is a
				// single long span reports a duration of 0, and every other session
				// under-reports by exactly the last-starting span's duration, which
				// is invisible because it always looks like plausible jitter. Same
				// idiom as `tracesDetailQuery`.
				traceEndNanos: CH.max_(CH.toUnixTimestamp64Nano($.Timestamp).add(CH.toInt64($.Duration))),
			}
		})
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTimeString("spansStart")),
			$.Timestamp.lte(param.dateTimeString("spansEnd")),
			inSubquery($.TraceId, pageTraceIds),
		])
		.groupBy("traceId")

	return fromQuery(perTrace, "session_traces")
		.innerJoinQuery(pageTraces, "index_traces", (t, i) => t.traceId.eq(i.traceId))
		.select(($) => ({
			// The key the page resolved, not one re-derived from the spans — see
			// the file header for why the two must not be allowed to differ.
			sessionId: sessionKey($.index_traces.rawSessionId, $.traceId),
			spanCount: CH.sum($.spanCount),
			errorSpanCount: CH.sum($.errorSpanCount),
			serviceNames: CH.groupUniqArrayArray($.serviceNames),
			startTime: CH.toString_(CH.min_($.traceStart)),
			endTime: CH.toString_(fromUnixTimestamp64Nano(CH.max_($.traceEndNanos))),
			// Nanoseconds first: `Timestamp` is DateTime64(9), and subtracting two
			// of them yields a Decimal whose scale the wire format then quotes.
			// Wrapped in `intDiv` because `Expr.sub`/`div` do not parenthesize.
			durationMs: CH.intDiv(
				CH.max_($.traceEndNanos).sub(CH.toUnixTimestamp64Nano(CH.min_($.traceStart))),
				1_000_000,
			),
		}))
		.groupBy("sessionId")
		.orderBy(["startTime", "desc"])
		.format("JSON")
}

/** One read of `aiSessionDetailsQuery`: the bounds of its `trace_detail_spans`
 *  seek, warehouse datetime literals — the `spansStart`/`spansEnd` params. */
export interface AiSessionDetailsSlice {
	readonly spansStart: string
	readonly spansEnd: string
}

const NANOS_PER_SECOND = 1_000_000_000n
const NANOS_PER_MS = 1_000_000n

/** `YYYY-MM-DD hh:mm:ss[.fffffffff]`, read as UTC, to nanoseconds since the epoch. */
const warehouseNanos = (literal: string): bigint => {
	const [datetime = "", fraction = ""] = literal.split(".")
	return (
		BigInt(Date.parse(`${datetime.replace(" ", "T")}Z`)) * NANOS_PER_MS +
		BigInt(fraction.padEnd(9, "0"))
	)
}

/** Nanoseconds since the epoch as the literal the warehouse renders — nine
 *  fractional digits, so a bound round-trips exactly. */
const warehouseDateTime = (nanos: bigint): string => {
	const seconds = new Date(Number(nanos / NANOS_PER_SECOND) * 1000).toISOString()
	return `${seconds.slice(0, 19).replace("T", " ")}.${(nanos % NANOS_PER_SECOND).toString().padStart(9, "0")}`
}

const nextUtcMidnight = (nanos: bigint): bigint => {
	const day = new Date(Number(nanos / NANOS_PER_SECOND) * 1000)
	return BigInt(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1)) * NANOS_PER_MS
}

/**
 * The reads one page's details are split into: the page's extent, padded by
 * `FAN_OUT_PAD_SECONDS`, cut at every midnight — one slice per partition of
 * `trace_detail_spans` (`PARTITION BY toDate(Timestamp)`), contiguous to the
 * nanosecond, for the caller to run side by side.
 *
 * A seek on that table costs by the partitions it touches, and a cold one
 * costs seconds: measured in production before this, a page spanning three
 * days ran 5s at the median and hit the profile's 15s ceiling at the 90th
 * percentile, whole. Sliced, each read pays for one day, the page for the
 * slowest of them, and a page over a sparse month is as many one-partition
 * reads as it has days rather than one read over all of them.
 *
 * Bounds are read and rendered as UTC, the zone the warehouse renders its
 * literals in; a warehouse in another zone would cut at its own midnight
 * plus the offset, which costs a slice two partitions and nothing else.
 */
export function aiSessionDetailsSlices(
	fanOutStart: string,
	fanOutEnd: string,
): ReadonlyArray<AiSessionDetailsSlice> {
	const pad = BigInt(FAN_OUT_PAD_SECONDS) * NANOS_PER_SECOND
	const end = warehouseNanos(fanOutEnd) + pad
	const slices: Array<AiSessionDetailsSlice> = []
	for (let at = warehouseNanos(fanOutStart) - pad; at <= end; ) {
		const midnight = nextUtcMidnight(at)
		slices.push({
			spansStart: warehouseDateTime(at),
			spansEnd: warehouseDateTime(midnight - 1n < end ? midnight - 1n : end),
		})
		at = midnight
	}
	return slices
}

/**
 * The slices' rows folded back into one per session — what one read over the
 * whole padded extent returns. A session whose spans straddle midnight is a
 * row in each slice: the counts add, the services union, the extent is the
 * outermost bounds, and the duration is those bounds' difference the way the
 * query takes it, whole milliseconds of the nanosecond difference. The
 * literals carry nine fractional digits, so the difference is exact.
 */
export function mergeAiSessionDetails(
	slices: ReadonlyArray<ReadonlyArray<AiSessionDetailsOutput>>,
): ReadonlyArray<AiSessionDetailsOutput> {
	const merged = new Map<string, AiSessionDetailsOutput>()
	for (const rows of slices) {
		for (const row of rows) {
			const prior = merged.get(row.sessionId)
			if (prior === undefined) {
				merged.set(row.sessionId, row)
				continue
			}
			const startTime = prior.startTime < row.startTime ? prior.startTime : row.startTime
			const endTime = prior.endTime > row.endTime ? prior.endTime : row.endTime
			merged.set(row.sessionId, {
				sessionId: row.sessionId,
				spanCount: prior.spanCount + row.spanCount,
				errorSpanCount: prior.errorSpanCount + row.errorSpanCount,
				serviceNames: [...new Set([...prior.serviceNames, ...row.serviceNames])],
				startTime,
				endTime,
				durationMs: Number((warehouseNanos(endTime) - warehouseNanos(startTime)) / NANOS_PER_MS),
			})
		}
	}
	return [...merged.values()]
}

// List facets (UNION ALL — one branch per index dimension)

export interface AiSessionFacetsOutput {
	readonly name: string
	readonly count: number
	readonly facetType: string
}

export type AiSessionFacetType = "vendor" | "service" | "environment" | "model" | "agent" | "tool"

/**
 * Distinct sessions per value of each index dimension, for the list's filter
 * sidebar: vendor, service, environment, model, agent and tool.
 *
 * This is the page's index scan (`indexTraces`) and nothing else — no
 * `trace_detail_spans` fan-out, which is the expensive half. It can be: every
 * one of the list's counted filters is applied at that level, so the population
 * a facet describes is exactly the population its filter selects. The
 * session-level filters (errors, the ranges) have no facet for the same reason
 * in reverse — their numbers exist only per ranked row.
 *
 * What it cannot do is count per span. A session id is a fact about the TRACE,
 * so a facet keyed on the span's own value would count every agent span of a
 * session-bearing trace that lacks the id — most of them — as a separate
 * sessionless trace, and roughly double every number in the sidebar. Hence the
 * per-trace level: one row per trace carrying its key, with the facet's values
 * collected alongside and unnested by `arrayJoin` at the counting level.
 *
 * The counts stay ANY-span counts, matching the filter: a session belongs to
 * every vendor and every service that ANY of its agent spans carries, so a
 * session whose spans came from two vendors is counted under both and the facet
 * counts sum to more than the number of sessions. Picking one value returns
 * exactly the count shown.
 *
 * `uniqExact` rather than `uniq`: session counts are small enough that the exact
 * aggregate costs nothing, and the number has to agree with the list beside it.
 */
export function aiSessionFacetsQuery(): CHUnionQuery<AiSessionFacetsOutput> {
	const facet = (
		facetType: AiSessionFacetType,
		name: ($: ColumnAccessor<typeof AiTraceIndex.columns>) => CH.Expr<string>,
	) => {
		const perTrace = from(AiTraceIndex)
			.select(($) => ({
				traceId: $.TraceId,
				// Over EVERY span of the trace, not only those carrying the value:
				// the session id sits on the turn-owning span and the model on the
				// chat span beneath it, so keying the trace off the value-bearing
				// rows alone would file it as a sessionless trace of its own — and
				// count a session once per trace that names the value. A blank
				// option filters nothing and is not offered, hence the `If`; a trace
				// naming nothing yields no row from the `arrayJoin` below.
				rawSessionId: CH.max_($.SessionId),
				names: CH.groupUniqArrayIf(MAX_NAMES_PER_TRACE)(name($), name($).neq("")),
			}))
			.where(($) => [
				// Every UNION ALL branch reads a table, so every branch carries the org
				// predicate itself — see this file's header.
				$.OrgId.eq(param.string("orgId")),
				$.Timestamp.gte(param.dateTimeString("startTime")),
				$.Timestamp.lte(param.dateTimeString("endTime")),
			])
			.groupBy("traceId")

		return fromQuery(perTrace, "facet_traces")
			.select(($) => ({
				name: CH.arrayJoin($.names),
				count: CH.uniqExact(sessionKey($.rawSessionId, $.traceId)),
				facetType: CH.lit(facetType),
			}))
			.groupBy("name")
			.orderBy(["count", "desc"])
			.limit(50)
	}

	return unionAll(
		facet("vendor", ($) => $.VendorId),
		facet("service", ($) => $.ServiceName),
		facet("environment", ($) => $.DeploymentEnv),
		facet("model", ($) => $.Model),
		facet("agent", ($) => $.AgentName),
		facet("tool", ($) => $.ToolName),
	).format("JSON")
}

// Session window resolution (id → bounds)

export interface AiSessionWindowOutput {
	/** Warehouse datetime literals, already padded — feed them straight back in. */
	readonly startTime: string
	readonly endTime: string
	/** Zero means no such session, which the bounds cannot say on their own. */
	readonly spanCount: number
}

/**
 * The bounds of one session, for a caller that holds its id and nothing else.
 *
 * This is `aiSessionSpansQuery`'s detection half with the trace ids replaced by
 * an aggregate, and it is the one read in this file that legitimately runs with
 * no time predicate: `traces` carries a `bloom_filter(0.01)` skip index over
 * `mapValues(SpanAttributes)` for the id to prune with, and the table's 30-day
 * TTL caps what is left. The fan-out has neither and must not be run that way.
 *
 * The bounds come back padded by `WINDOW_PAD_SECONDS`, because they are
 * measured over the session-BEARING spans while the read they bound returns
 * every span of those spans' traces — a trace whose first span is not the
 * session-bearing one starts earlier than any window this could report exactly.
 *
 * `min`/`max` over no rows return the epoch rather than nothing, so a caller
 * must read `spanCount` to tell an unknown session from a real one.
 */
export function aiSessionWindowQuery() {
	return from(Traces)
		.select(($) => ({
			startTime: CH.toString_(CH.intervalSub(CH.min_($.Timestamp), WINDOW_PAD_SECONDS)),
			endTime: CH.toString_(CH.intervalAdd(CH.max_($.Timestamp), WINDOW_PAD_SECONDS)),
			spanCount: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			// Same presence guard as `aiSessionSpansQuery`, for the same reason: a
			// missing Map key reads back as `''`, so equality alone would resolve a
			// blank id to the bounds of every span in the org that lacks the key.
			hasSessionId($.SpanAttributes, $.SpanAttributes.get(SESSION_ID_ATTR)),
			$.SpanAttributes.get(SESSION_ID_ATTR).eq(param.string("sessionId")),
		])
		.format("JSON")
}

/**
 * The same bounds for a `trace:` session — one whose id names a trace outright,
 * because the vendor exposed no session key (`MAPLE_AI_TRACE_SESSION_PREFIX`).
 *
 * No attribute predicate at all: the id IS the trace id, so `idx_trace_id` on
 * `traces` prunes what `mapValues(SpanAttributes)` prunes for a vendor session,
 * and no presence guard is needed because a trace id cannot be read off a
 * missing Map key. The caller extracts and validates the trace id before it
 * reaches this param — a forged one must never arrive here as a bare string.
 *
 * Padded and `spanCount`-terminated exactly like {@link aiSessionWindowQuery};
 * the two are interchangeable to a caller holding only an id.
 */
export function aiTraceWindowQuery() {
	return from(Traces)
		.select(($) => ({
			startTime: CH.toString_(CH.intervalSub(CH.min_($.Timestamp), WINDOW_PAD_SECONDS)),
			endTime: CH.toString_(CH.intervalAdd(CH.max_($.Timestamp), WINDOW_PAD_SECONDS)),
			spanCount: CH.count(),
		}))
		.where(($) => [$.OrgId.eq(param.string("orgId")), $.TraceId.eq(param.string("traceId"))])
		.format("JSON")
}

export interface AiSessionSpansOpts {
	readonly limit?: number
	/** `all` when absent. See `AiSessionSpanScope` in `@maple/domain/http`. */
	readonly scope?: AiSessionSpanScope
	/** Spans strictly after this `(timestamp, spanId)` position — the previous page's last row. */
	readonly after?: { readonly timestamp: string; readonly spanId: string }
}

export interface AiTraceSpansOpts extends AiSessionSpansOpts {
	/**
	 * Read these traces rather than the one `traceId` param names. For the
	 * per-turn read the detail page makes: the turn already knows its traces.
	 */
	readonly traceIds?: readonly string[]
}

export interface AiSessionSpansOutput {
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId: string
	readonly spanName: string
	readonly spanKind: string
	readonly serviceName: string
	readonly durationMs: number
	readonly statusCode: string
	readonly statusMessage: string
	readonly timestamp: string
	readonly spanAttributes: Record<string, string>
}

export const aiSessionSpansRowSchema: CompiledQueryRowSchema<AiSessionSpansOutput> = Schema.Struct({
	traceId: Schema.String,
	spanId: Schema.String,
	parentSpanId: Schema.String,
	spanName: Schema.String,
	spanKind: Schema.String,
	serviceName: Schema.String,
	durationMs: CHNumber,
	statusCode: Schema.String,
	statusMessage: Schema.String,
	timestamp: Schema.String,
	// A Map column selected directly arrives as a JSON object under FORMAT JSON,
	// so this is a plain Record. Not `Schema.fromJsonString(…)` — that is for the
	// observability path, which reads maps already serialized to a string.
	spanAttributes: Schema.Record(Schema.String, Schema.String),
})

/** Shared by both span reads, so a session keyed by id and one keyed by trace
 *  cannot drift apart in shape — {@link aiSessionSpansRowSchema} decodes both. */
const spanProjection = ($: ColumnAccessor<typeof TraceDetailSpans.columns>) => ({
	traceId: $.TraceId,
	spanId: $.SpanId,
	parentSpanId: $.ParentSpanId,
	spanName: $.SpanName,
	spanKind: $.SpanKind,
	serviceName: $.ServiceName,
	durationMs: $.Duration.div(1_000_000),
	statusCode: $.StatusCode,
	statusMessage: $.StatusMessage,
	timestamp: CH.toString_($.Timestamp),
	// The map cut down to what `mapAiSpan` reads. Measured on production's
	// largest sessions, the whole map is dominated by keys the mapper never
	// touches (`db.query.text` alone was half of one session's bytes), and
	// `ResourceAttributes` — which the mapper deliberately ignores, see
	// `mapAiSpan` — was another 60% on top. Neither is read any more.
	spanAttributes: mapFilterKeys($.SpanAttributes, (key) =>
		key.in_(...aiSpanAttributeKeys).or(key.like(`${AI_PROMPT_VARIABLE_PREFIX}%`)),
	),
})

/**
 * Every span of every trace belonging to one session, oldest first.
 *
 * `sessionId` is a compile param rather than an opts field, so one compiled SQL
 * string serves every session.
 *
 * The attribute map is projected down to the keys the integration layer reads
 * (`aiSpanAttributeKeys`); everything else on the span stays in the warehouse.
 * Even so, a content-heavy vendor puts whole prompts in `gen_ai.input.messages`,
 * so callers should still expect megabyte-scale payloads at the default limit.
 *
 * No scope columns: `trace_detail_spans` does not carry `ScopeName`/`ScopeVersion`,
 * and the read path does not need them. The ingest gateway already did the
 * scope-based vendor detection at write time and encoded its verdict in
 * `maple_ai.vendor.id`; re-deriving the dialect here would only second-guess it.
 *
 * The window bounds BOTH levels and is required, because the fan-out without one
 * reads every partition the table retains — see this file's header for what that
 * was measured to cost. A session whose traces straddle the window edge returns
 * only the spans inside it, so the bounds a caller passes have to contain the
 * whole session: the list row's `startTime`/`endTime` do by construction, and a
 * caller holding only a session id gets bounds that do from
 * `aiSessionWindowQuery`.
 *
 * Truncation drops the END of the session, because the rows come back oldest
 * first and an agent's answer is the last thing it writes. Ask for
 * `AI_SESSION_SPANS_MAX_SPANS + 1`, slice back to the cap and report the
 * overflow — the idiom `telemetry.http.ts` already uses — rather than showing a
 * truncated transcript as a completed one. Callers should also bound the
 * response by bytes (`compiledQueryBounded`, as the session-replay route does):
 * at the default cap this can return tens of megabytes, and Tinybird rejects the
 * server-side `max_result_bytes` settings that would otherwise cap it.
 */
export function aiSessionSpansQuery(opts: AiSessionSpansOpts = {}) {
	const limit = opts.limit ?? AI_SESSION_SPANS_MAX_SPANS
	const sessionTraceIds = sessionTraceIdsSubquery()

	return (
		from(TraceDetailSpans)
			.select(spanProjection)
			.where(($) => [
				$.OrgId.eq(param.string("orgId")),
				$.Timestamp.gte(param.dateTimeString("startTime")),
				$.Timestamp.lte(param.dateTimeString("endTime")),
				inSubquery($.TraceId, sessionTraceIds),
				scopePredicate($, opts.scope),
				opts.after === undefined ? undefined : afterCursor($, opts.after),
			])
			// `spanId` breaks ties: agent spans routinely share a millisecond, and
			// without it the LIMIT cuts an arbitrary subset, so two loads of the same
			// page can disagree and a parent can survive while its children are
			// dropped. The same pair is the keyset the next page resumes from.
			.orderBy(["timestamp", "asc"], ["spanId", "asc"])
			.limit(limit)
			.format("JSON")
	)
}

type SpanColumns = ColumnAccessor<typeof TraceDetailSpans.columns>

/** The traces carrying the session id, within the window — the detection half
 *  of every session-keyed read. */
const sessionTraceIdsSubquery = () =>
	from(Traces)
		.select(($) => ({ TraceId: $.TraceId }))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTimeString("startTime")),
			$.Timestamp.lte(param.dateTimeString("endTime")),
			// The presence guard is what stops an empty `sessionId` param from
			// matching every span that simply LACKS the key — ClickHouse reads a
			// missing Map key back as `''`, so equality alone would turn a blank
			// session id into a whole-org trace dump.
			hasSessionId($.SpanAttributes, $.SpanAttributes.get(SESSION_ID_ATTR)),
			$.SpanAttributes.get(SESSION_ID_ATTR).eq(param.string("sessionId")),
		])

/** The vendor stamp is on every span the gateway classified as GenAI and on no
 *  other, so it is what separates the agent's spans from the app's own. */
const scopePredicate = ($: SpanColumns, scope: AiSessionSpanScope | undefined) =>
	scope === "ai"
		? $.SpanAttributes.get(VENDOR_ID_ATTR).neq("")
		: scope === "app"
			? $.SpanAttributes.get(VENDOR_ID_ATTR).eq("")
			: undefined

/**
 * Strictly after the previous page's last row, in the order the pages are read.
 * The timestamp literal carries the row's own nanoseconds (`toString(Timestamp)`
 * is what the page returned), so the comparison is exact rather than a
 * millisecond bucket that would re-read or skip the boundary's neighbours.
 */
const afterCursor = ($: SpanColumns, after: { readonly timestamp: string; readonly spanId: string }) =>
	$.Timestamp.gt(after.timestamp).or($.Timestamp.eq(after.timestamp).and($.SpanId.gt(after.spanId)))

/**
 * Every span of ONE trace, oldest first — the spans of a `trace:` session.
 *
 * {@link aiSessionSpansQuery} without its detection half: the id already names
 * the trace, so there is nothing to resolve and `TraceId` is a sort-key prefix
 * of `trace_detail_spans`. Everything else is identical, deliberately — same
 * projection, same row schema, same tie-broken order, same truncation contract —
 * so the detail page reads one shape whichever kind of session it opened.
 *
 * The window is still required and still bounds the read: `TraceId` prunes the
 * sort key, the `Timestamp` predicate prunes partitions, and only both together
 * keep this off every partition the table retains.
 */
export function aiTraceSpansQuery(opts: AiTraceSpansOpts = {}) {
	const limit = opts.limit ?? AI_SESSION_SPANS_MAX_SPANS

	return from(TraceDetailSpans)
		.select(spanProjection)
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTimeString("startTime")),
			$.Timestamp.lte(param.dateTimeString("endTime")),
			opts.traceIds === undefined
				? $.TraceId.eq(param.string("traceId"))
				: CH.inList($.TraceId, opts.traceIds),
			scopePredicate($, opts.scope),
			opts.after === undefined ? undefined : afterCursor($, opts.after),
		])
		.orderBy(["timestamp", "asc"], ["spanId", "asc"])
		.limit(limit)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Session summary — the whole session's totals, computed where the spans are
// ---------------------------------------------------------------------------

/** The whole session, in one row — every field of a turn row that is not the turn's own key. */
export interface AiSessionTotalsOutput {
	readonly traceCount: number
	readonly startTime: string
	readonly endTime: string
	readonly durationMs: number
	readonly spanCount: number
	readonly aiSpanCount: number
	readonly llmCalls: number
	readonly toolCalls: number
	readonly errorSpanCount: number
	readonly inputTokens: number
	readonly outputTokens: number
	readonly cacheReadTokens: number
	readonly llmInputTokens: number
	readonly llmOutputTokens: number
	readonly llmCacheReadTokens: number
	readonly costReporters: number
	readonly cost: number
	readonly llmCost: number
	readonly models: readonly string[]
	readonly agentNames: readonly string[]
}

export interface AiSessionSummaryOutput {
	readonly turnKey: string
	readonly conversationId: string
	readonly traceIds: readonly string[]
	readonly startTime: string
	readonly endTime: string
	readonly durationMs: number
	readonly spanCount: number
	readonly aiSpanCount: number
	readonly llmCalls: number
	readonly toolCalls: number
	readonly errorSpanCount: number
	readonly inputTokens: number
	readonly outputTokens: number
	readonly cacheReadTokens: number
	readonly llmInputTokens: number
	readonly llmOutputTokens: number
	readonly llmCacheReadTokens: number
	readonly costReporters: number
	readonly cost: number
	readonly llmCost: number
	readonly models: readonly string[]
	readonly agentNames: readonly string[]
}

const summaryMeasures = {
	startTime: Schema.String,
	endTime: Schema.String,
	durationMs: CHNumber,
	spanCount: CHNumber,
	aiSpanCount: CHNumber,
	llmCalls: CHNumber,
	toolCalls: CHNumber,
	errorSpanCount: CHNumber,
	inputTokens: CHNumber,
	outputTokens: CHNumber,
	cacheReadTokens: CHNumber,
	llmInputTokens: CHNumber,
	llmOutputTokens: CHNumber,
	llmCacheReadTokens: CHNumber,
	costReporters: CHNumber,
	cost: CHNumber,
	llmCost: CHNumber,
	models: Schema.Array(Schema.String),
	agentNames: Schema.Array(Schema.String),
}

export const aiSessionSummaryRowSchema: CompiledQueryRowSchema<AiSessionSummaryOutput> = Schema.Struct({
	turnKey: Schema.String,
	conversationId: Schema.String,
	traceIds: Schema.Array(Schema.String),
	...summaryMeasures,
})

export const aiSessionTotalsRowSchema: CompiledQueryRowSchema<AiSessionTotalsOutput> = Schema.Struct({
	traceCount: CHNumber,
	...summaryMeasures,
})

/** Distinct values one turn row keeps of an open-ended dimension. */
const SUMMARY_ARRAY_CAP = 50

/**
 * The measures of a set of spans — one turn's, or the whole session's.
 *
 * The turn key is `gen_ai.conversation.id` under every spelling the mapper
 * reads — its source keys plus the two turn ids the vendor refine hooks lift
 * into it — falling back to the trace. That is the page's rule 1 and rule 3;
 * rule 2 (an agent root opening a turn) needs the parent chain and is not
 * attempted here. Nor is the chain walked for an untagged child of a tagged
 * span: it groups under its trace, so the rows partition the session exactly
 * while a turn row may hold fewer spans than the page's turn of the same id.
 *
 * Every attribute is read the way `mapAiSpan` reads it: the first non-empty
 * value across that field's source keys. An "llm call" and a "tool call" are
 * the page's `classifyAiSpan` reduced to what an aggregation can see —
 * operation name, model, tool name — without the span-name heuristics.
 *
 * Usage is summed twice: over every span, and over the model-call spans alone.
 * A framework that reports usage per call AND rolls it up onto the agent span
 * would double under a plain sum; the handler picks the model-call figures
 * when there are any (`per-call`) and the plain sum otherwise (`roll-up`),
 * which is the deepest-reporter rule the page applies, at turn granularity.
 *
 * Every Float64 aggregate is guarded with `ifNotFinite`: `toFloat64OrZero`
 * parses `nan` and `inf` successfully, one such attribute would poison the
 * whole sum, and `CHNumber` refuses to decode it.
 */
const summaryMeasures_ = ($: SpanColumns) => {
	// `coalesce(nullIf(a, ''), nullIf(b, ''), …, '')`: the first key with a value.
	const attr = (keys: readonly string[]) =>
		CH.coalesce(...keys.map((key) => CH.nullIf($.SpanAttributes.get(key), "")), CH.lit(""))
	const field = (name: AiGenAiField) => attr(aiFieldSourceKeys(name))
	const number = (name: AiGenAiField) => CH.toFloat64OrZero(field(name))

	const vendorId = $.SpanAttributes.get(VENDOR_ID_ATTR)
	const isAi = vendorId.neq("")
	const operation = field("operationName")
	// Response model first, request model second — `spanModel` on the page.
	const model = attr([...aiFieldSourceKeys("responseModel"), ...aiFieldSourceKeys("requestModel")])
	const toolName = field("toolName")
	const agentName = field("agentName")
	const isLlmCall = operation
		.in_(...AI_INFERENCE_OPERATIONS)
		.or(
			operation
				.notIn(...AI_RETRIEVAL_OPERATIONS, ...AI_TOOL_OPERATIONS, ...AI_AGENT_OPERATIONS)
				.and(model.neq(""))
				.and(toolName.eq("")),
		)
	const isToolCall = operation.in_(...AI_TOOL_OPERATIONS).or(operation.eq("").and(isAi).and(toolName.neq("")))
	// The list query's error rule, so the summary and the list badge agree.
	const failed = $.StatusCode.eq("Error").or(
		isAi.and(
			field("errorType")
				.neq("")
				.or(CH.inList($.SpanAttributes.get(RESPONSE_STATUS_ATTR), FAILED_RESPONSE_STATUSES)),
		),
	)
	const conversationId = attr([
		...aiFieldSourceKeys("conversationId"),
		// What `eveIntegration` and `mapleIntegration` lift into the field.
		"eve.turn.id",
		MAPLE_NATIVE_TURN_ID_ATTR,
	])
	const inputTokens = number("usageInputTokens")
	const outputTokens = number("usageOutputTokens")
	const cacheReadTokens = number("usageCacheReadInputTokens")
	const cost = number("usageCost")

	const finite = (expr: CH.Expr<number>) => CH.ifNotFinite(expr, 0)

	return {
		conversationId,
		startTime: CH.toString_(CH.min_($.Timestamp)),
		endTime: fromUnixTimestamp64Nano(
			CH.max_(CH.toUnixTimestamp64Nano($.Timestamp).add(CH.toInt64($.Duration))),
		),
		durationMs: CH.intDiv(
			CH.max_(CH.toUnixTimestamp64Nano($.Timestamp).add(CH.toInt64($.Duration))).sub(
				CH.toUnixTimestamp64Nano(CH.min_($.Timestamp)),
			),
			1_000_000,
		),
		spanCount: CH.count(),
		aiSpanCount: CH.countIf(isAi),
		llmCalls: CH.countIf(isLlmCall),
		toolCalls: CH.countIf(isToolCall),
		errorSpanCount: CH.countIf(failed),
		inputTokens: finite(CH.sum(inputTokens)),
		outputTokens: finite(CH.sum(outputTokens)),
		cacheReadTokens: finite(CH.sum(cacheReadTokens)),
		llmInputTokens: finite(CH.sumIf(inputTokens, isLlmCall)),
		llmOutputTokens: finite(CH.sumIf(outputTokens, isLlmCall)),
		llmCacheReadTokens: finite(CH.sumIf(cacheReadTokens, isLlmCall)),
		// Spans that reported a cost at all: zero means "not measured", which the
		// page distinguishes from "free".
		costReporters: CH.countIf(field("usageCost").neq("")),
		cost: finite(CH.sum(cost)),
		llmCost: finite(CH.sumIf(cost, isLlmCall)),
		models: CH.groupUniqArrayIf(SUMMARY_ARRAY_CAP)(model, isLlmCall.and(model.neq(""))),
		agentNames: CH.groupUniqArrayIf(SUMMARY_ARRAY_CAP)(agentName, agentName.neq("")),
	}
}

/** One row per turn: the measures under the turn key. */
const summaryProjection = ($: SpanColumns) => {
	const { conversationId, ...measures } = summaryMeasures_($)
	return {
		turnKey: CH.if_(conversationId.neq(""), conversationId, $.TraceId),
		// One id per group by construction: a conversation group carries its id
		// on every row, a trace group carries `''` on every row.
		conversationId: CH.max_(conversationId),
		traceIds: CH.groupUniqArray($.TraceId),
		...measures,
	}
}

/** One row for the whole session: the same measures, ungrouped. Read beside
 *  the turn rows, so a session grouping into more turns than one response
 *  carries still reports exact totals — the turn LIMIT cuts the list alone. */
const totalsProjection = ($: SpanColumns) => {
	const { conversationId: _, ...measures } = summaryMeasures_($)
	return { traceCount: CH.uniqExact($.TraceId), ...measures }
}

/**
 * The summary of a session keyed by its vendor id: {@link aiSessionSpansQuery}'s
 * detection half feeding {@link summaryProjection}. Same window contract as the
 * span read — required, bounding both levels.
 */
export function aiSessionSummaryQuery() {
	return from(TraceDetailSpans)
		.select(summaryProjection)
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTimeString("startTime")),
			$.Timestamp.lte(param.dateTimeString("endTime")),
			inSubquery($.TraceId, sessionTraceIdsSubquery()),
		])
		.groupBy("turnKey")
		.orderBy(["startTime", "asc"])
		.limit(AI_SESSION_SUMMARY_MAX_TURNS + 1)
		.format("JSON")
}

/** The summary of a `trace:` session — {@link aiTraceSpansQuery}'s shape. */
export function aiTraceSummaryQuery() {
	return from(TraceDetailSpans)
		.select(summaryProjection)
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTimeString("startTime")),
			$.Timestamp.lte(param.dateTimeString("endTime")),
			$.TraceId.eq(param.string("traceId")),
		])
		.groupBy("turnKey")
		.orderBy(["startTime", "asc"])
		.limit(AI_SESSION_SUMMARY_MAX_TURNS + 1)
		.format("JSON")
}

/** The whole session's measures in one row — {@link aiSessionSummaryQuery} ungrouped. */
export function aiSessionTotalsQuery() {
	return from(TraceDetailSpans)
		.select(totalsProjection)
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTimeString("startTime")),
			$.Timestamp.lte(param.dateTimeString("endTime")),
			inSubquery($.TraceId, sessionTraceIdsSubquery()),
		])
		.format("JSON")
}

/** The whole `trace:` session's measures in one row. */
export function aiTraceTotalsQuery() {
	return from(TraceDetailSpans)
		.select(totalsProjection)
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTimeString("startTime")),
			$.Timestamp.lte(param.dateTimeString("endTime")),
			$.TraceId.eq(param.string("traceId")),
		])
		.format("JSON")
}
