import { describe, expect, it } from "vitest"
import { ruleReadFamilies } from "./alert-rule-read-families"

const draft = (dataSource: "traces" | "logs" | "metrics" | "product_events") => ({
	id: "q",
	name: "A",
	dataSource,
	aggregation: "count",
})

describe("ruleReadFamilies", () => {
	it.each(["error_rate", "p95_latency", "p99_latency", "apdex", "throughput"] as const)(
		"%s reads traces",
		(signalType) => {
			expect(ruleReadFamilies({ signalType })).toEqual(["traces"])
		},
	)

	it.each(["traces", "logs", "metrics"] as const)("a %s builder draft reads only its source", (source) => {
		expect(ruleReadFamilies({ signalType: "builder_query", queryBuilderDraft: draft(source) })).toEqual([
			source,
		])
	})

	it("a builder draft on a source that is not a family needs all three", () => {
		expect(
			ruleReadFamilies({ signalType: "builder_query", queryBuilderDraft: draft("product_events") }),
		).toEqual(["traces", "logs", "metrics"])
	})

	it("a builder rule with no draft needs all three", () => {
		expect(ruleReadFamilies({ signalType: "builder_query", queryBuilderDraft: null })).toEqual([
			"traces",
			"logs",
			"metrics",
		])
	})

	it("raw SQL needs all three", () => {
		expect(ruleReadFamilies({ signalType: "raw_query" })).toEqual(["traces", "logs", "metrics"])
	})

	it.each(["anomaly", "uptime", "slo_burn_rate", "audit"] as const)(
		"%s runs no query of its own and needs none",
		(signalType) => {
			expect(ruleReadFamilies({ signalType })).toEqual([])
		},
	)
})
