import { describe, expect, it } from "vitest"
import * as CH from "@maple-dev/effect-clickhouse/expr"
import * as T from "@maple-dev/effect-clickhouse/types"
import { compile } from "@maple-dev/effect-clickhouse/sql"
import {
	childClaimsExpr,
	nettedReportersExpr,
	reporterSpanIdsExpr,
	sessionLlmCalls,
	sessionReportersExpr,
	sessionUsageSum,
	usageLinksExpr,
	usageReportersExpr,
} from "./ai-span-columns"

const sql = (expr: { toFragment(): Parameters<typeof compile>[0] }) => compile(expr.toFragment())

describe("session usage SQL", () => {
	it("collects a trace's reporters and model calls, capped", () => {
		const reporters = usageReportersExpr({
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
		// The five buckets ride along as elements 7–11; a span reports by its
		// total or cost, which the buckets sum to, so they add no predicate.
		expect(sql(reporters)).toBe(
			"groupArrayIf(2000)(tuple(SpanId, ParentSpanId, Tokens, Cost, ResponseId, IsLlmCall, InputTokens, CacheReadTokens, CacheWriteTokens, OutputTokens, ReasoningTokens), ((Tokens > 0 OR Cost > 0) OR IsLlmCall = 1))",
		)
	})

	it("maps each of a trace's spans to itself when it reported the measure, else to its parent", () => {
		const links = usageLinksExpr(
			{
				SpanId: CH.dynamicColumn<string>("SpanId", T.string),
				ParentSpanId: CH.dynamicColumn<string>("ParentSpanId", T.string),
			},
			CH.dynamicColumn<number>("Cost", T.float64),
		)
		expect(sql(links)).toBe(
			"CAST(groupArray(2000)(tuple(SpanId, if(Cost > 0, SpanId, ParentSpanId))), 'Map(String, String)')",
		)
	})

	it("collects the session's reporters once, and the two lookups the netting makes off them", () => {
		// Each reporter carries the nearest ancestor that reported tokens (12) and
		// the nearest that reported a cost (13), climbed off its trace's links.
		const climb = (links: string) => `${`${links}[`.repeat(4)}r.2${"]".repeat(4)}`
		expect(sql(sessionReportersExpr("usageReporters", "tokenLinks", "costLinks"))).toBe(
			`arraySlice(arrayFlatten(groupArray(arrayMap(r -> tupleConcat(r, tuple(${climb("tokenLinks")}, ${climb("costLinks")})), usageReporters))), 1, 2000)`,
		)
		// What the reporters charged to each one already claimed: one sumMap
		// over the reporters, each entered under its token ancestor with its
		// tokens and under its cost ancestor with its cost.
		expect(sql(childClaimsExpr("reporters"))).toBe(
			"arrayReduce('sumMap', arrayMap(c -> [c.12, c.13], reporters), arrayMap(c -> [c.3, 0.], reporters), arrayMap(c -> [0., c.4], reporters), arrayMap(c -> [c.7, 0.], reporters), arrayMap(c -> [c.8, 0.], reporters), arrayMap(c -> [c.9, 0.], reporters), arrayMap(c -> [c.10, 0.], reporters), arrayMap(c -> [c.11, 0.], reporters))",
		)
		expect(sql(reporterSpanIdsExpr("reporters"))).toBe("tupleElement(reporters, 1)")
	})

	it("nets every claim in one pass: children off their parent, a call at its deepest account", () => {
		const text = sql(nettedReportersExpr("reporters", "childClaims", "reporterIds"))
		const charged = (element: number) =>
			`arrayElement(tupleElement(childClaims, ${element}), indexOf(tupleElement(childClaims, 1), r.1))`

		expect(text).toMatch(/^arrayMap\(r -> tuple\(r\.5, /)
		expect(text).toMatch(/, reporters\)$/)
		// A reporting call counts by its netted claim; a non-reporting one by
		// having no reporting ancestor and no model call for a parent.
		expect(text).toContain(
			`r.6 = 1 AND if((r.3 > 0 OR r.4 > 0), greatest(0., r.3 - ${charged(2)}) > 0 OR greatest(0., r.4 - ${charged(3)}) > 0, NOT has(reporterIds, r.12) AND NOT has(reporterIds, r.13) AND NOT has(reporterIds, r.2))`,
		)
		// Tokens, cost and the five buckets, each less its children's, floored at
		// zero — and nothing at all for a reporter that is not a model call once
		// that measure was charged to it (tokens decide the buckets).
		for (const [element, child, measure] of [
			[3, 2, 2],
			[4, 3, 3],
			[7, 4, 2],
			[8, 5, 2],
			[9, 6, 2],
			[10, 7, 2],
			[11, 8, 2],
		] as const) {
			expect(text).toContain(
				`if(r.6 = 0 AND ${charged(measure)} > 0, 0., greatest(0., r.${element} - ${charged(child)}))`,
			)
		}
		// One lambda over the reporters, and none inside it searching them again.
		expect(text.split("->").length - 1).toBe(1)
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
