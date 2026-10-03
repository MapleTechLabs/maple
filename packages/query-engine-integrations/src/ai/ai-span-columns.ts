// The session's usage and model calls, counted by the detail page's rules.
//
// `ai_trace_index` carries every GenAI span's tokens and cost (migration
// 0026, `@maple/domain/tinybird/gen-ai-columns`) and, since 0029, the
// provider's response id. Three things would otherwise inflate a session:
//
// - A wrapper's roll-up: several frameworks stamp `gen_ai.usage.*` on the
//   model span AND sum it onto the agent span that wraps it.
//   `countableUsageSpans` in `@maple/agent-sessions`' `session-summary.ts`
//   charges each reporter to its nearest reporting ancestor and keeps only the
//   excess; {@link sessionUsageSum} is that rule in SQL, over the trace's
//   index rows ({@link traceUsageColumns}): Strands puts an event-loop span
//   between the agent and its calls, the Vercel AI SDK a step span. Since
//   migration 0035 the index reads usage the ingest gateway stamped on the
//   model call alone, so on rows materialized after it no wrapper reports and
//   the netting changes nothing; it serves the older rows until they age out.
// - A sub-step of a call: a gateway records its provider attempts as model
//   spans under the model span (OpenRouter's `provider attempt N`), and an SDK
//   wraps `doGenerate` in `generateText`. A model span that reports no usage
//   while an ancestor does or while its parent is a model span, or whose
//   reported usage its children already account for, is the same call seen
//   again, not another call — {@link sessionLlmCalls}.
// - A second observation: a gateway that forwards its own trace of the call
//   (OpenRouter Broadcast, Helicone, …) lands it in the same session as a
//   separate trace, so the parent/child netting cannot see it. The provider's
//   response id is the one fact both observations carry, so reporters sharing
//   one are the same call: its usage is the larger of the two claims (a
//   gateway prices a call the app's SDK could not), and it is one call.
//   Reporters without an id are counted as they are — the page does not
//   guess.

import type { Expr } from "@maple-dev/effect-clickhouse/expr"
import * as CH from "@maple-dev/effect-clickhouse/expr"
import * as T from "@maple-dev/effect-clickhouse/types"
import { compile } from "@maple-dev/effect-clickhouse/sql"
import { AI_SESSION_SPANS_MAX_SPANS } from "@maple/domain/http"

/**
 * Reporters collected per trace, and again per session once the traces are
 * put together. The detail page reads at most this many spans of a session
 * (`AI_SESSION_SPANS_MAX_SPANS`), so past it the two pages already disagree;
 * the cap bounds what the netting below sorts per session.
 */
export const MAX_USAGE_REPORTERS_PER_TRACE = AI_SESSION_SPANS_MAX_SPANS

/**
 * `body` with `name` standing for `value`, written once however often the
 * body reads it. An alias of the same level would do the same in the text and
 * not in the query: the warehouse expands an alias wherever it is named, and
 * four reads of a lookup that reads its table nine times was most of a list
 * read. The lambda runs over a single element, so what its body names is
 * copied once.
 */
const bind = (name: string, value: string, body: string): string =>
	`arrayMap(${name} -> ${body}, [${value}])[1]`

/**
 * A keyed lookup over arrays that no lambda captures.
 *
 * `arrayMap(r -> table[r.key], rows)` copies `table` once per row — a lambda
 * captures a column by replicating it per element — so a trace or a session
 * with n reporters and a table of m entries costs n·m in memory, and a few
 * hundred of each across a page was the list read's whole memory ceiling in
 * production. This is the same lookup as a merge: the table's entries and the
 * needles sorted together by key, the table's entry first in each run of a
 * key, and `arrayFill` carrying its value down the run. A run that holds no
 * table entry starts on a needle, which keeps the fallback.
 *
 * One expression that names `table` and `needles` once each, so lookups chain
 * without the query multiplying — see {@link bind}. The entries are `((key,
 * isNeedle, value), position)`; the result is the value per needle, in the
 * needles' order. `table` is an `Array(Tuple(key, value))`.
 */
const lookupExpr = (table: string, needles: string, fallback: string): string => {
	const entries = `arrayConcat(arrayMap(t -> (t.1, 0, t.2), ${table}), arrayMap(k -> (k, 1, ${fallback}), ${needles}))`
	const sorted = `arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))`
	const entry = (element: number) => `tupleElement(tupleElement(sorted, 1), ${element})`
	const filled = `arrayFill((v, first) -> first = 1, ${entry(3)}, arrayEnumerateUniq(${entry(1)}))`
	const found = `tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(${filled}, ${entry(2)}, tupleElement(sorted, 2)))), 1)`
	return bind("entries", entries, bind("sorted", sorted, found))
}

/** How many links a claim follows to the reporter it is charged to. */
const USAGE_LINK_HOPS = 4

/**
 * One trace's reporters, as the columns of the trace level — the last one,
 * `usageReporters`, is what the session level collects: `(span, parent,
 * tokens, cost, responseId, isLlmCall, input, cacheRead, cacheWrite, output,
 * reasoning)` per index row that reported usage or is a model call, plus the
 * nearest ancestor that reported tokens (12) and the nearest that reported a
 * cost (13). The four spans are keys rather than ids — a 63-bit hash of the
 * span id, 0 where there is none — because the netting only ever compares
 * them, and comparing integers is most of what its lookups cost.
 *
 * A span whose usage parses to zero throughout and is not a model call is not
 * a reporter, the same as `spanTokenBuckets` returning a total of 0: a wrapper
 * stamping empty usage must not be charged as a reporter whose children then
 * owe it their tokens. The five buckets (elements 7–11) are the disjoint split
 * of `tokens` the index carries since migration 0031; a row materialized
 * before it carries zeros there and a total in `tokens`, which is why the list
 * falls back to the total when the buckets sum to nothing.
 *
 * The ancestors are climbed off `usageLinks`, the trace's way up for each
 * measure: every index row's span id mapped to itself where it reported the
 * measure, else to its parent, the key doubled for tokens and doubled plus
 * one for cost so one table serves both. Following it from a reporter's parent
 * climbs past the spans that reported none of it (an event loop, a step, a
 * chain, a wrapper that priced but did not count) and stops at the nearest
 * ancestor that did — or at 0 above the root, or at a parent outside the
 * index, whose ancestry the index cannot see. Tokens and cost each climb
 * their own way, because the session page charges each measure to its own
 * nearest reporter. Each hop is one lookup ({@link lookupExpr}) of
 * every reporter's two needles, the tokens' first and the cost's after them.
 *
 * {@link USAGE_LINK_HOPS} hops, so a claim passes up to three spans that
 * reported nothing. The shapes seen climb past one (Strands' event loop, the
 * Vercel AI SDK's step, smolagents' `Step N`) and two (a Strands sub-agent: its tool span, then the
 * event loop). A deeper chain is charged to where the climb stopped, which no
 * reporter is, so its claim is counted in full.
 *
 * Raw SQL because the cap is a parameter of the aggregate
 * (`groupArrayIf(N)(…)`), a shape the builder's function-call helper does not
 * render.
 */
export function traceUsageColumns($: {
	readonly SpanId: Expr<string>
	readonly ParentSpanId: Expr<string>
	readonly Tokens: Expr<number>
	readonly Cost: Expr<number>
	readonly ResponseId: Expr<string>
	readonly IsLlmCall: Expr<number>
	readonly InputTokens: Expr<number>
	readonly CacheReadTokens: Expr<number>
	readonly CacheWriteTokens: Expr<number>
	readonly OutputTokens: Expr<number>
	readonly ReasoningTokens: Expr<number>
}) {
	// A span id as the netting compares it: a 63-bit hash, so a lookup sorts
	// integers rather than strings and a key has a bit to spare for the
	// measure. Zero stands for no span.
	const spanKey = (spanId: Expr<string>) =>
		`if(${compile(spanId.toFragment())} = '', 0, bitShiftRight(cityHash64(${compile(spanId.toFragment())}), 1))`
	const reporter = CH.compileFnCall<unknown>(
		"tuple",
		CH.untypedExpr(spanKey($.SpanId)),
		CH.untypedExpr(spanKey($.ParentSpanId)),
		$.Tokens,
		$.Cost,
		$.ResponseId,
		$.IsLlmCall,
		$.InputTokens,
		$.CacheReadTokens,
		$.CacheWriteTokens,
		$.OutputTokens,
		$.ReasoningTokens,
	)
	const reports = $.Tokens.gt(0).or($.Cost.gt(0)).or($.IsLlmCall.eq(1))
	// A link's key is the span's key doubled, plus one for the cost's way up.
	const link = (measure: 0 | 1, reported: Expr<number>) =>
		`tuple(${spanKey($.SpanId)} * 2 + ${measure}, if(${compile(reported.gt(0).toFragment())}, ${spanKey($.SpanId)}, ${spanKey($.ParentSpanId)}) * 2 + ${measure})`
	// The first hop starts at the reporters' parents; each later one at where
	// the hop before it arrived.
	const parents = "arrayConcat(arrayMap(r -> r.2 * 2, usageSpans), arrayMap(r -> r.2 * 2 + 1, usageSpans))"
	const ancestors = Array.from({ length: USAGE_LINK_HOPS }).reduce<string>(
		(needles) => lookupExpr("usageLinks", needles, "toUInt64(0)"),
		parents,
	)
	return {
		usageSpans: CH.untypedExpr(
			`groupArrayIf(${MAX_USAGE_REPORTERS_PER_TRACE})(${compile(reporter.toFragment())}, ${compile(
				reports.toFragment(),
			)})`,
		),
		usageLinks: CH.untypedExpr(
			`groupArrayArray(${2 * MAX_USAGE_REPORTERS_PER_TRACE})([${link(0, $.Tokens)}, ${link(1, $.Cost)}])`,
		),
		// The measure's bit comes off again; a climb that left the index is 0.
		usageReporters: CH.untypedExpr(
			bind(
				"ancestors",
				ancestors,
				"arrayMap((r, t, c) -> tupleConcat(r, (intDiv(t, 2), intDiv(c, 2))), usageSpans, arraySlice(ancestors, 1, length(usageSpans)), arraySlice(ancestors, length(usageSpans) + 1))",
			),
		),
	}
}

/**
 * Every reporter of the session — the per-trace arrays, concatenated and
 * capped again — selected as a column of the session level, so the netting
 * one level up reads a name rather than repeating the aggregate. The cap is
 * the aggregate's own, so a session of many traces holds no more than it
 * returns.
 *
 * `reporters` is the column {@link traceUsageColumns} selected as
 * `usageReporters`, one level down.
 */
export function sessionReportersExpr(reporters: string): Expr<unknown> {
	return CH.untypedExpr(`groupArrayArray(${MAX_USAGE_REPORTERS_PER_TRACE})(${reporters})`)
}

/**
 * Each reporter's netted claims — `(responseId, counts, tokens, cost, input,
 * cacheRead, cacheWrite, output, reasoning)` per reporter of the session,
 * elements 1–9 — off the column {@link sessionReportersExpr} was selected as,
 * one level down.
 *
 * `claims` is what the session's reporters already claimed, per span charged,
 * and which spans are reporters: one `sumMap` in which each reporter enters
 * three times — its tokens under the ancestor it charges tokens to, its cost
 * under the one it charges cost to, and a mark under its own id. `charged`
 * reads it back for every reporter four times over — at its own id, at its
 * two ancestors and at its parent, in that order — as one lookup
 * ({@link lookupExpr}), so the lambda that nets takes what it needs as
 * arguments and captures nothing.
 *
 * A model call's claim is its own less what the reporters charged to it
 * already claimed, floored at zero (a clean roll-up nets to nothing, the
 * missing call's usage survives). Any other reporter — an agent, a workflow —
 * claims nothing of a measure once a reporter of that measure is charged to
 * it: agents living across turns report the conversation so far, so their
 * excess is earlier turns' calls again (`countableUsageSpans` in
 * `session-summary.ts`, the same rule). `counts`
 * is whether the reporter is a model call at its deepest account: a call that
 * reported usage counts by its netted claim, one that reported none counts
 * unless an ancestor reported or its parent is a model call — a failed call
 * still counts once, a gateway's provider attempt under its generation does
 * not, whether or not the generation reported.
 *
 * One lambda over the reporters, netting the seven measures at once. This
 * expression is analysed once per query, and the analysis of a lambda body
 * is what a page read paid for before it touched a row — seven copies of the
 * netting, three times each, were most of the read.
 */
export function nettedReportersExpr(reporters: string): Expr<unknown> {
	const entry = (values: string) => `arrayMap(r -> [${values}], ${reporters})`
	const tokens = (element: number) => entry(`r.${element}, 0., 0.`)
	// Elements 1–8 of a looked-up value: tokens, cost, the five buckets, and
	// whether the span is a reporter.
	const claims = `arrayReduce('sumMap', ${entry("r.12, r.13, r.1")}, ${tokens(3)}, ${entry("0., r.4, 0.")}, ${[7, 8, 9, 10, 11].map(tokens).join(", ")}, ${entry("0., 0., 1.")})`
	const values = Array.from({ length: 8 }, (_, index) => `claims.${index + 2}`)
	const table = bind("claims", claims, `arrayZip(claims.1, arrayZip(${values.join(", ")}))`)
	const needles = `arrayConcat(${[1, 12, 13, 2].map((element) => `tupleElement(${reporters}, ${element})`).join(", ")})`
	const nothing = `(${values.map(() => "0.").join(", ")})`
	const part = (index: number) =>
		`arraySlice(charged, ${index} * length(${reporters}) + 1, length(${reporters}))`

	const excess = (element: number, chargedElement: number) =>
		`greatest(0., r.${element} - own.${chargedElement})`
	// The tokens charged (element 1) decide for every token bucket, the cost
	// charged (2) for the cost.
	const measures = [
		[3, 1, 1],
		[4, 2, 2],
		[7, 3, 1],
		[8, 4, 1],
		[9, 5, 1],
		[10, 6, 1],
		[11, 7, 1],
	] as const
	const claim = (element: number, chargedElement: number, measure: number) =>
		`if(r.6 = 0 AND own.${measure} > 0, 0., ${excess(element, chargedElement)})`
	const counts = `r.6 = 1 AND if((r.3 > 0 OR r.4 > 0), ${excess(3, 1)} > 0 OR ${excess(4, 2)} > 0, tokenAncestor.8 = 0 AND costAncestor.8 = 0 AND parent.8 = 0)`
	return CH.untypedExpr(
		bind(
			"charged",
			lookupExpr(table, needles, nothing),
			`arrayMap((r, own, tokenAncestor, costAncestor, parent) -> tuple(r.5, ${counts}, ${measures.map(([element, chargedElement, measure]) => claim(element, chargedElement, measure)).join(", ")}), ${reporters}, ${[0, 1, 2, 3].map(part).join(", ")})`,
		),
	)
}

/** A usage measure of the session, by its position in the netted tuple. */
export type SessionUsageMeasure =
	| "tokens"
	| "cost"
	| "inputTokens"
	| "cacheReadTokens"
	| "cacheWriteTokens"
	| "outputTokens"
	| "reasoningTokens"

const NETTED_ELEMENT = {
	tokens: 3,
	cost: 4,
	inputTokens: 5,
	cacheReadTokens: 6,
	cacheWriteTokens: 7,
	outputTokens: 8,
	reasoningTokens: 9,
} as const satisfies Record<SessionUsageMeasure, number>

/**
 * The claims of one element of the netted tuple, summed over the session:
 * every reporter without a response id as it is, and of the reporters sharing
 * one the largest claim (a gateway prices a call the app's SDK could not) —
 * `maxMap` keyed by the id, then summed.
 *
 * `netted` is the column {@link nettedReportersExpr} was selected as.
 */
const nettedSum = (netted: string, element: number, claim: string): string =>
	`arraySum(tupleElement(arrayFilter(n -> n.1 = '', ${netted}), ${element})) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, ${claim}), arrayFilter(n -> n.1 != '', ${netted})))))`

/** The session's tokens, cost or one token bucket — see {@link nettedSum}. */
export function sessionUsageSum(netted: string, measure: SessionUsageMeasure): Expr<number> {
	const element = NETTED_ELEMENT[measure]
	return CH.rawExpr(nettedSum(netted, element, `n.${element}`), T.float64)
}

/** The session's model calls: the reporters that count, once per response id. */
export function sessionLlmCalls(netted: string): Expr<number> {
	return CH.rawExpr(`toFloat64(${nettedSum(netted, 2, "toFloat64(n.2)")})`, T.float64)
}
