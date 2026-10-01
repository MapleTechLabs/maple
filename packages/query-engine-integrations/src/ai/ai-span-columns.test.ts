import { describe, expect, it } from "vitest"
import * as CH from "@maple-dev/effect-clickhouse/expr"
import * as T from "@maple-dev/effect-clickhouse/types"
import { compile } from "@maple-dev/effect-clickhouse/sql"
import {
	nettedReportersExpr,
	sessionLlmCalls,
	sessionReportersExpr,
	sessionUsageSum,
	traceUsageColumns,
} from "./ai-span-columns"

const sql = (expr: { toFragment(): Parameters<typeof compile>[0] }) => compile(expr.toFragment())

/** `body` with `name` bound to `value` once, as `bind` writes it. */
const bind = (name: string, value: string, body: string) => `arrayMap(${name} -> ${body}, [${value}])[1]`

/** A lookup, as `lookupExpr` writes it: table entries and needles sorted
 *  together, the table's value filled down each run of a key. */
const lookup = (table: string, needles: string, fallback: string) =>
	bind(
		"entries",
		`arrayConcat(arrayMap(t -> (t.1, 0, t.2), ${table}), arrayMap(k -> (k, 1, ${fallback}), ${needles}))`,
		bind(
			"sorted",
			"arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))",
			"tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1)",
		),
	)

/** A span id as the netting compares it: a 63-bit hash, 0 for none. */
const key = (column: string) => `if(${column} = '', 0, bitShiftRight(cityHash64(${column}), 1))`

describe("session usage SQL", () => {
	const trace = traceUsageColumns({
		SpanId: CH.dynamicColumn<string>("SpanId", T.string),
		ParentSpanId: CH.dynamicColumn<string>("ParentSpanId", T.string),
		Tokens: CH.dynamicColumn<number>("Tokens", T.float64),
		Cost: CH.dynamicColumn<number>("Cost", T.float64),
		ResponseId: CH.dynamicColumn<string>("ResponseId", T.string),
		IsLlmCall: CH.dynamicColumn<number>("IsLlmCall", T.uint8),
		InputTokens: CH.dynamicColumn<number>("InputTokens", T.float64),
		CacheReadTokens: CH.dynamicColumn<number>("CacheReadTokens", T.float64),
		CacheWriteTokens: CH.dynamicColumn<number>("CacheWriteTokens", T.float64),
		OutputTokens: CH.dynamicColumn<number>("OutputTokens", T.float64),
		ReasoningTokens: CH.dynamicColumn<number>("ReasoningTokens", T.float64),
	})

	it("collects a trace's reporters and model calls, capped", () => {
		// The five buckets ride along as elements 7–11; a span reports by its
		// total or cost, which the buckets sum to, so they add no predicate.
		expect(sql(trace.usageSpans)).toBe(
			`groupArrayIf(2000)(tuple(${key("SpanId")}, ${key("ParentSpanId")}, Tokens, Cost, ResponseId, IsLlmCall, InputTokens, CacheReadTokens, CacheWriteTokens, OutputTokens, ReasoningTokens), ((Tokens > 0 OR Cost > 0) OR IsLlmCall = 1))`,
		)
	})

	it("maps each of a trace's spans to itself when it reported the measure, else to its parent", () => {
		// Both measures in one table, the key's lowest bit telling them apart.
		expect(sql(trace.usageLinks)).toBe(
			`groupArrayArray(4000)([tuple(${key("SpanId")} * 2 + 0, if(Tokens > 0, ${key("SpanId")}, ${key("ParentSpanId")}) * 2 + 0), tuple(${key("SpanId")} * 2 + 1, if(Cost > 0, ${key("SpanId")}, ${key("ParentSpanId")}) * 2 + 1)])`,
		)
	})

	it("climbs four links from every reporter's parent, each hop one lookup", () => {
		const parents =
			"arrayConcat(arrayMap(r -> r.2 * 2, usageSpans), arrayMap(r -> r.2 * 2 + 1, usageSpans))"
		const hop = (needles: string) => lookup("usageLinks", needles, "toUInt64(0)")
		// Each reporter gains the nearest ancestor that reported tokens (12) and
		// the nearest that reported a cost (13).
		expect(sql(trace.usageReporters)).toBe(
			bind(
				"ancestors",
				hop(hop(hop(hop(parents)))),
				"arrayMap((r, t, c) -> tupleConcat(r, (intDiv(t, 2), intDiv(c, 2))), usageSpans, arraySlice(ancestors, 1, length(usageSpans)), arraySlice(ancestors, length(usageSpans) + 1))",
			),
		)
	})

	it("collects the session's reporters once, capped by the aggregate itself", () => {
		expect(sql(sessionReportersExpr("usageReporters"))).toBe("groupArrayArray(2000)(usageReporters)")
	})

	it("nets every claim in one pass: children off their parent, a call at its deepest account", () => {
		const text = sql(nettedReportersExpr("reporters"))
		// What the reporters charged to each one already claimed, and which spans
		// are reporters: one sumMap, each reporter entered under its token
		// ancestor with its tokens, its cost ancestor with its cost, and itself —
		// read back at the reporter's own id, its two ancestors and its parent.
		const charged = lookup(
			bind(
				"claims",
				"arrayReduce('sumMap', arrayMap(r -> [r.12, r.13, r.1], reporters), arrayMap(r -> [r.3, 0., 0.], reporters), arrayMap(r -> [0., r.4, 0.], reporters), arrayMap(r -> [r.7, 0., 0.], reporters), arrayMap(r -> [r.8, 0., 0.], reporters), arrayMap(r -> [r.9, 0., 0.], reporters), arrayMap(r -> [r.10, 0., 0.], reporters), arrayMap(r -> [r.11, 0., 0.], reporters), arrayMap(r -> [0., 0., 1.], reporters))",
				"arrayZip(claims.1, arrayZip(claims.2, claims.3, claims.4, claims.5, claims.6, claims.7, claims.8, claims.9))",
			),
			"arrayConcat(tupleElement(reporters, 1), tupleElement(reporters, 12), tupleElement(reporters, 13), tupleElement(reporters, 2))",
			"(0., 0., 0., 0., 0., 0., 0., 0.)",
		)
		expect(
			text.startsWith(
				"arrayMap(charged -> arrayMap((r, own, tokenAncestor, costAncestor, parent) -> tuple(r.5, ",
			),
		).toBe(true)
		expect(
			text.endsWith(
				`, reporters, arraySlice(charged, 0 * length(reporters) + 1, length(reporters)), arraySlice(charged, 1 * length(reporters) + 1, length(reporters)), arraySlice(charged, 2 * length(reporters) + 1, length(reporters)), arraySlice(charged, 3 * length(reporters) + 1, length(reporters))), [${charged}])[1]`,
			),
		).toBe(true)
		// A reporting call counts by its netted claim; a non-reporting one by
		// having no reporting ancestor and no model call for a parent.
		expect(text).toContain(
			"r.6 = 1 AND if((r.3 > 0 OR r.4 > 0), greatest(0., r.3 - own.1) > 0 OR greatest(0., r.4 - own.2) > 0, tokenAncestor.8 = 0 AND costAncestor.8 = 0 AND parent.8 = 0)",
		)
		// Tokens, cost and the five buckets, each less its children's, floored at
		// zero — and nothing at all for a reporter that is not a model call once
		// that measure was charged to it (tokens decide the buckets).
		for (const [element, charged, measure] of [
			[3, 1, 1],
			[4, 2, 2],
			[7, 3, 1],
			[8, 4, 1],
			[9, 5, 1],
			[10, 6, 1],
			[11, 7, 1],
		] as const) {
			expect(text).toContain(
				`if(r.6 = 0 AND own.${measure} > 0, 0., greatest(0., r.${element} - own.${charged}))`,
			)
		}
	})

	it.each([
		["tokens", 3],
		["cost", 4],
		["inputTokens", 5],
		["reasoningTokens", 9],
	] as const)(
		"sums the netted claims: every unkeyed one, and the largest per response id (%s)",
		(measure, element) => {
			expect(sql(sessionUsageSum("netted", measure))).toBe(
				`arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), ${element})) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.${element}), arrayFilter(n -> n.1 != '', netted)))))`,
			)
		},
	)

	it("counts the model calls the same way, off the netted flag", () => {
		expect(sql(sessionLlmCalls("netted"))).toBe(
			"toFloat64(arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 2)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, toFloat64(n.2)), arrayFilter(n -> n.1 != '', netted))))))",
		)
	})
})
