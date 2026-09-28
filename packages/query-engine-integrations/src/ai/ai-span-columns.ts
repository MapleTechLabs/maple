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
//   index rows ({@link usageLinksExpr}): Strands puts an event-loop span
//   between the agent and its calls, the Vercel AI SDK a step span.
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
 * flattened. The detail page reads at most this many spans of a session
 * (`AI_SESSION_SPANS_MAX_SPANS`), so past it the two pages already disagree;
 * the cap bounds the quadratic passes below at a few million comparisons per
 * session rather than unbounded.
 */
export const MAX_USAGE_REPORTERS_PER_TRACE = AI_SESSION_SPANS_MAX_SPANS

/**
 * One trace's reporters — `(SpanId, ParentSpanId, tokens, cost, responseId,
 * isLlmCall, input, cacheRead, cacheWrite, output, reasoning)` per index row
 * that reported usage or is a model call — for the session-level sums, which
 * need every trace's reporters in hand at once. A span whose usage parses to
 * zero throughout and is not a model call is not a reporter, the same as
 * `spanTokenBuckets` returning a total of 0: a wrapper stamping empty usage
 * must not be charged as a reporter whose children then owe it their tokens.
 * The five buckets (elements 7–11) are the disjoint split of `tokens` the
 * index carries since migration 0031; a row materialized before it carries
 * zeros there and a total in `tokens`, which is why the list falls back to
 * the total when the buckets sum to nothing.
 *
 * Raw SQL because the cap is a parameter of the aggregate
 * (`groupArrayIf(N)(…)`), a shape the builder's function-call helper does not
 * render.
 */
export function usageReportersExpr($: {
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
}): Expr<unknown> {
	const reporter = CH.compileFnCall<unknown>(
		"tuple",
		$.SpanId,
		$.ParentSpanId,
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
	return CH.untypedExpr(
		`groupArrayIf(${MAX_USAGE_REPORTERS_PER_TRACE})(${compile(reporter.toFragment())}, ${compile(
			reports.toFragment(),
		)})`,
	)
}

/**
 * One trace's way up for one measure: each index row's span id mapped to
 * itself where it reported the measure (`reported > 0`), else to its parent.
 * Following it from a reporter's parent climbs past the spans that reported
 * none of it (an event loop, a step, a chain, a wrapper that priced but did
 * not count) and stops at the nearest ancestor that did — or at `''` above
 * the root, or at a parent outside the index, whose ancestry the index cannot
 * see. Tokens and cost each get their own, because the session page charges
 * each measure to its own nearest reporter.
 *
 * Raw SQL for the same reason as {@link usageReportersExpr}.
 */
export function usageLinksExpr(
	$: { readonly SpanId: Expr<string>; readonly ParentSpanId: Expr<string> },
	reported: Expr<number>,
): Expr<unknown> {
	const link = CH.compileFnCall<unknown>(
		"tuple",
		$.SpanId,
		CH.if_(reported.gt(0), $.SpanId, $.ParentSpanId),
	)
	return CH.untypedExpr(
		`CAST(groupArray(${MAX_USAGE_REPORTERS_PER_TRACE})(${compile(link.toFragment())}), 'Map(String, String)')`,
	)
}

/**
 * How many links a claim follows to the reporter it is charged to — past up
 * to three spans that reported nothing. The shapes seen climb past one
 * (Strands' event loop, the Vercel AI SDK's step, smolagents' `Step N`) and
 * two (a Strands sub-agent: its tool span, then the event loop). A deeper
 * chain is charged to where the climb stopped, which no reporter is, so its
 * claim is counted in full. Each link is a lookup in a map the lambda
 * captures per reporter, which is what the list read pays for this.
 */
const USAGE_LINK_HOPS = 4

/**
 * Every reporter of the session — the per-trace arrays, flattened and capped
 * again — selected as a column of the session level, so the netting one level
 * up reads a name rather than repeating the aggregate. Each reporter gains
 * two elements on the way, off its own trace's links ({@link usageLinksExpr}):
 * the nearest ancestor that reported tokens (12) and the nearest that
 * reported a cost (13), `''` where there is none.
 *
 * `reporters`, `tokenLinks` and `costLinks` are the columns
 * {@link usageReportersExpr} and {@link usageLinksExpr} were selected as, one
 * level down: a lambda reading a column of its own level would evaluate that
 * aggregate once per reporter.
 */
export function sessionReportersExpr(
	reporters: string,
	tokenLinks: string,
	costLinks: string,
): Expr<unknown> {
	const climb = (links: string) =>
		Array.from({ length: USAGE_LINK_HOPS }).reduce<string>((spanId) => `${links}[${spanId}]`, "r.2")
	return CH.untypedExpr(
		`arraySlice(arrayFlatten(groupArray(arrayMap(r -> tupleConcat(r, tuple(${climb(tokenLinks)}, ${climb(costLinks)})), ${reporters}))), 1, ${MAX_USAGE_REPORTERS_PER_TRACE})`,
	)
}

/**
 * What the reporters' children already claimed, per reporter charged — `(span
 * id, tokens, cost, input, cacheRead, cacheWrite, output, reasoning)` as eight
 * parallel arrays, elements 1–8, one entry per span that some reporter is
 * charged to — off the column {@link sessionReportersExpr} was selected
 * as. Each reporter enters twice: its tokens under the ancestor it charges
 * tokens to, its cost under the one it charges cost to, the other measure
 * zero. One `sumMap` over the reporters rather than a search of them per
 * reporter: a lambda captures a column by copying it once per element, so a
 * per-reporter search of the reporters costs the square of their count in
 * memory — measured in production, past the read's ceiling on a cost sort —
 * while this costs the reporters once and the netting a lookup by position.
 */
export function childClaimsExpr(reporters: string): Expr<unknown> {
	const tokens = (element: number) => `arrayMap(c -> [c.${element}, 0.], ${reporters})`
	return CH.untypedExpr(
		`arrayReduce('sumMap', arrayMap(c -> [c.12, c.13], ${reporters}), ${tokens(3)}, arrayMap(c -> [0., c.4], ${reporters}), ${[7, 8, 9, 10, 11].map(tokens).join(", ")})`,
	)
}

/** The span ids of the reporters — the spans that reported usage and the
 *  model calls — which a model call that reported none is counted against.
 *  Same column as above. */
export function reporterSpanIdsExpr(reporters: string): Expr<unknown> {
	return CH.untypedExpr(`tupleElement(${reporters}, 1)`)
}

/**
 * Each reporter's netted claims — `(responseId, counts, tokens, cost, input,
 * cacheRead, cacheWrite, output, reasoning)` per reporter of the session,
 * elements 1–9 — off the three columns the session level selects:
 * {@link sessionReportersExpr}, {@link childClaimsExpr} and
 * {@link reporterSpanIdsExpr}. Columns, not aliases of the same level: an
 * alias expands inside the lambda and is evaluated there, once per reporter.
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
export function nettedReportersExpr(
	reporters: string,
	childClaims: string,
	reporterIds: string,
): Expr<unknown> {
	// Where the claims charged to the reporter sit in the parallel arrays: zero,
	// and so a zero claim, for a reporter nothing is charged to.
	const position = `indexOf(tupleElement(${childClaims}, 1), r.1)`
	const charged = (childElement: number) =>
		`arrayElement(tupleElement(${childClaims}, ${childElement}), ${position})`
	const excess = (element: number, childElement: number) =>
		`greatest(0., r.${element} - ${charged(childElement)})`
	// The tokens charged (child element 2) decide for every token bucket, the
	// cost charged (3) for the cost.
	const claims = [
		[3, 2, 2],
		[4, 3, 3],
		[7, 4, 2],
		[8, 5, 2],
		[9, 6, 2],
		[10, 7, 2],
		[11, 8, 2],
	] as const
	const claim = (element: number, childElement: number, measure: number) =>
		`if(r.6 = 0 AND ${charged(measure)} > 0, 0., ${excess(element, childElement)})`
	const counts = `r.6 = 1 AND if((r.3 > 0 OR r.4 > 0), ${excess(3, 2)} > 0 OR ${excess(4, 3)} > 0, NOT has(${reporterIds}, r.12) AND NOT has(${reporterIds}, r.13) AND NOT has(${reporterIds}, r.2))`
	return CH.untypedExpr(
		`arrayMap(r -> tuple(r.5, ${counts}, ${claims.map(([element, childElement, measure]) => claim(element, childElement, measure)).join(", ")}), ${reporters})`,
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
