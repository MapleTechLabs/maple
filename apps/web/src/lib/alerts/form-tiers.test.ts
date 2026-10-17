import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { AlertDestinationId, AlertRuleDocument } from "@maple/domain/http"
import { describeRuleCondition } from "@/components/alerts/rule-condition-bar"
import { buildRuleCreateParamsV2, defaultRuleForm, deriveTierIssues, ruleToFormState } from "./form-utils"
import { diffRuleForms } from "./preview-insights"

const slack = AlertDestinationId.make("4f6c6b1e-7a11-4c2e-9f40-1c3b2d9a0001")
const pager = AlertDestinationId.make("4f6c6b1e-7a11-4c2e-9f40-1c3b2d9a0002")

const tieredRule = (): AlertRuleDocument =>
	Schema.decodeUnknownSync(AlertRuleDocument)({
		id: "6f1d1c9e-2b9a-4d1e-8c3f-5a7b9c0d0001",
		name: "Checkout errors",
		notes: null,
		notificationTemplate: null,
		enabled: true,
		severity: "critical",
		serviceNames: ["checkout"],
		excludeServiceNames: [],
		environments: [],
		tags: [],
		groupBy: null,
		signalType: "error_rate",
		comparator: "gt",
		threshold: 0.007,
		thresholdUpper: null,
		windowMinutes: 5,
		minimumSampleCount: 0,
		consecutiveBreachesRequired: 2,
		breachesOutOf: 4,
		thresholds: [
			{ severity: "warning", value: 0.007, upper: null, recoveryValue: 0.005, destinationIds: [slack] },
			{ severity: "critical", value: 0.03, upper: null, recoveryValue: null, destinationIds: [pager] },
		],
		consecutiveHealthyRequired: 2,
		renotifyIntervalMinutes: 30,
		apdexThresholdMs: null,
		queryBuilderDraft: null,
		rawQuerySql: null,
		rawQueryReducer: null,
		destinationIds: [slack, pager],
		noDataBehavior: "skip",
		lastEvaluationError: null,
		lastEvaluatedAt: null,
		lastScheduledAt: null,
		createdAt: "2026-10-01T00:00:00.000Z",
		updatedAt: "2026-10-01T00:00:00.000Z",
		createdBy: "user_tiers_test",
		updatedBy: "user_tiers_test",
	})

describe("severity tiers on the rule form", () => {
	it("saves a loaded tiered rule back with every tier, recovery value and breach window", () => {
		const params = buildRuleCreateParamsV2(ruleToFormState(tieredRule()))

		expect(params.thresholds).toEqual([
			{
				severity: "warning",
				value: 0.007,
				upper: null,
				recovery_value: 0.005,
				destination_ids: [slack],
			},
			{
				severity: "critical",
				value: 0.03,
				upper: null,
				recovery_value: null,
				destination_ids: [pager],
			},
		])
		expect(params.breaches_out_of).toBe(4)
		expect(params.consecutive_breaches_required).toBe(2)
		expect(params).toMatchObject({ severity: "critical", threshold: 0.007 })
	})

	it("reports no change for a tiered rule opened and saved untouched", () => {
		const form = ruleToFormState(tieredRule())

		expect(diffRuleForms(form, form)).toEqual([])
		expect(diffRuleForms(form, { ...form, breachesOutOf: "" })).toMatchObject([{ field: "Out of last" }])
	})

	it("describes both tiers and the breach window in one sentence", () => {
		expect(describeRuleCondition(ruleToFormState(tieredRule()))).toBe(
			"Warning when error rate is above 0.7%, critical above 3%, in 2 of the last 4 checks (5 min each)",
		)
	})

	it("drops the critical tier for comparators that only take one", () => {
		const form = { ...ruleToFormState(tieredRule()), comparator: "between" as const, thresholdUpper: "2" }
		const params = buildRuleCreateParamsV2(form)

		expect(params.thresholds).toHaveLength(1)
		expect(params.thresholds?.[0]).toMatchObject({
			severity: "warning",
			recovery_value: null,
			upper: 0.02,
		})
	})

	it("names each tier problem the server would reject", () => {
		const base = { ...defaultRuleForm(), name: "Errors", destinationIds: [slack] }
		const withCritical = (critical: string, recovery = "") => ({
			...base,
			escalation: { threshold: critical, recoveryValue: recovery, destinationIds: [pager] },
		})

		expect(deriveTierIssues(withCritical("10"))).toEqual([])
		expect(deriveTierIssues(withCritical(""))).toEqual(["Critical threshold"])
		expect(deriveTierIssues(withCritical("5"))).toEqual(["Critical threshold past warning"])
		expect(deriveTierIssues(withCritical("10", "4"))).toEqual(["Critical recovery past warning"])
		expect(deriveTierIssues(withCritical("10", "12"))).toEqual(["Critical recovery value"])
		expect(deriveTierIssues({ ...base, recoveryValue: "6" })).toEqual(["Recovery value"])
		expect(deriveTierIssues({ ...withCritical("10"), escalation: null })).toEqual([])
		expect(
			deriveTierIssues({
				...base,
				escalation: { threshold: "10", recoveryValue: "", destinationIds: [] },
			}),
		).toEqual(["Critical destinations"])
		expect(deriveTierIssues({ ...base, breachesOutOf: "1" })).toEqual(["Breach window"])
	})
})
