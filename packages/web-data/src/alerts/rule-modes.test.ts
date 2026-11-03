import { describe, expect, it } from "vitest"

import { buildRuleCreateParamsV2, defaultRuleForm, type RuleFormState } from "./form-utils"
import { builtinToQueryDraft, queryDraftToBuiltin, switchSignalKind } from "./rule-modes"

const builtin = (overrides: Partial<RuleFormState> = {}): RuleFormState => ({
	...defaultRuleForm(),
	name: "Checkout errors",
	...overrides,
})

describe("switching query modes", () => {
	it("keeps a 5% error-rate threshold at 5% in the builder and saves the same ratio", () => {
		const form = builtin({ threshold: "5" })
		const moved = switchSignalKind(form, "builder_query").form

		expect(moved.threshold).toBe("5")
		expect(buildRuleCreateParamsV2(moved).threshold).toBe(buildRuleCreateParamsV2(form).threshold)
		expect(buildRuleCreateParamsV2(moved).threshold).toBe(0.05)
	})

	it("re-expresses a percent threshold as a ratio in SQL", () => {
		const moved = switchSignalKind(builtin({ threshold: "5" }), "raw_query").form
		expect(moved.threshold).toBe("0.05")
		expect(buildRuleCreateParamsV2(moved).threshold).toBe(0.05)
	})

	it("carries services, environments and exclusions into the builder's where clause", () => {
		const moved = switchSignalKind(
			builtin({
				signalType: "p95_latency",
				serviceNames: ["checkout", "payments"],
				environments: ["production"],
			}),
			"builder_query",
		).form

		expect(moved.signalType).toBe("builder_query")
		expect(moved.queryBuilderDraft.aggregation).toBe("p95_duration")
		expect(moved.queryBuilderDraft.whereClause).toBe(
			'root_only = true AND service.name = "checkout,payments" AND deployment.environment = "production"',
		)
		// Built-in evaluates several services one by one, so the builder splits by service.
		expect(moved.queryBuilderDraft.groupBy).toEqual(["service.name"])
	})

	it("round-trips built-in filters through the builder and back", () => {
		const form = builtin({
			signalType: "throughput",
			excludeServiceNames: ["batch"],
			environments: ["staging", "production"],
			groupBy: ["span.name"],
		})
		const back = switchSignalKind(switchSignalKind(form, "builder_query").form, "builtin")

		expect(back.notice).toBeNull()
		expect(back.form.signalType).toBe("throughput")
		expect(back.form.excludeServiceNames).toEqual(["batch"])
		expect(back.form.environments).toEqual(["staging", "production"])
		expect(back.form.groupBy).toEqual(["span.name"])
	})

	it("names what Built-in can't express when leaving the builder", () => {
		const form = builtin({
			signalType: "builder_query",
			queryBuilderDraft: {
				...builtinToQueryDraft(builtin()),
				whereClause: 'service.name = "api" AND http.route = "/v1/query"',
			},
		})
		const back = switchSignalKind(form, "builtin")

		expect(back.form.serviceNames).toEqual(["api"])
		expect(back.notice).toContain("http.route = /v1/query")
	})

	it("says so when a split can't survive a named service", () => {
		const draft = builtinToQueryDraft(builtin())
		const form = builtin({
			signalType: "builder_query",
			queryBuilderDraft: {
				...draft,
				whereClause: 'service.name = "api"',
				groupBy: ["http.route"],
				addOns: { ...draft.addOns, groupBy: true },
			},
		})
		const back = switchSignalKind(form, "builtin")

		expect(back.form.serviceNames).toEqual(["api"])
		expect(back.form.groupBy).toEqual([])
		expect(back.notice).toContain("split by http.route")
	})

	it("reports a non-trace data source as dropped", () => {
		const draft = builtinToQueryDraft(builtin())
		const result = queryDraftToBuiltin(
			builtin({ signalType: "builder_query", queryBuilderDraft: { ...draft, dataSource: "logs" } }),
		)
		expect(result.dropped).toContain("logs data source")
	})

	it("leaves the form alone when the mode doesn't change", () => {
		const form = builtin()
		expect(switchSignalKind(form, "builtin")).toEqual({ form, notice: null })
	})
})
