import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { compileRulePlan } from "./AlertRuleModel"

const builderRule = (groupBy: string[]) => ({
	signalType: "builder_query" as const,
	serviceName: null,
	environments: [],
	apdexThresholdMs: null,
	rawQuerySql: null,
	rawQueryReducer: null,
	comparator: "gt" as const,
	windowMinutes: 5,
	groupBy: null,
	alertOnNoData: false,
	queryBuilderDraft: {
		id: "q",
		name: "A",
		dataSource: "metrics" as const,
		aggregation: "avg",
		metricName: "kube_pod_restarts",
		metricType: "gauge" as const,
		whereClause: "",
		addOns: { groupBy: true, having: false, orderBy: false, limit: false, legend: false },
		groupBy,
	},
})

describe("compileRulePlan", () => {
	it.effect("a metrics builder alert groups by resource and datapoint keys together", () =>
		Effect.gen(function* () {
			const plan = yield* compileRulePlan(builderRule(["resource.k8s.namespace.name", "attr.job"]))
			expect(plan.query).toMatchObject({
				source: "metrics",
				groupBy: ["resource_attribute", "attribute"],
				filters: {
					groupByResourceAttributeKeys: ["k8s.namespace.name"],
					groupByAttributeKeys: ["job"],
				},
			})
		}),
	)
})
