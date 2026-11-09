import { AlertDestinationId, EscalationChainId } from "@maple/domain/http"
import { anomalyRuleForm, defaultRuleForm } from "@maple/web-data/alerts/form-utils"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { fromFormState, type RuleForm } from "./form"
import {
	cardIssues,
	cardsOf,
	conditionSummary,
	missingCards,
	nameSummary,
	notifySummary,
	type NotifyNames,
	watchSummary,
} from "./summary"

const destinationId = Schema.decodeSync(AlertDestinationId)
const chainId = Schema.decodeSync(EscalationChainId)
const ONCALL = destinationId("0199a001-0000-7000-8000-000000000001")
const PAGER = destinationId("0199a001-0000-7000-8000-000000000002")
const GONE = destinationId("0199a001-0000-7000-8000-000000000009")
const CHAIN = chainId("0199a00e-0000-7000-8000-000000000001")

const form = (fields: Partial<RuleForm> = {}): RuleForm => ({
	...fromFormState(defaultRuleForm()),
	name: "Checkout errors",
	destinationIds: [ONCALL],
	...fields,
})

const NAMES: NotifyNames = {
	destination: (id) => (id === ONCALL ? "#oncall" : id === PAGER ? "PagerDuty Checkout" : null),
	chain: (id) => (id === CHAIN ? "Checkout primary" : null),
}

const criticalTier = (fields: Partial<NonNullable<RuleForm["escalation"]>> = {}) => ({
	threshold: "10",
	recoveryValue: "",
	destinationIds: [],
	escalationChainId: null,
	...fields,
})

describe("watchSummary", () => {
	it("names a built-in signal with its services and environments", () => {
		expect(watchSummary(form({ serviceNames: ["checkout-api"], environments: ["production"] }))).toBe(
			"Error rate on checkout-api in production",
		)
		expect(watchSummary(form({ signalType: "p95_latency", excludeServiceNames: ["batch"] }))).toBe(
			"P95 latency on all services except batch",
		)
	})

	it("shortens a long service list and says how the rule is split", () => {
		expect(watchSummary(form({ signalType: "throughput", serviceNames: ["a", "b", "c", "d"] }))).toBe(
			"Throughput on a, b and 2 more",
		)
		expect(watchSummary(form({ signalType: "apdex", groupBy: ["http.route"] }))).toBe(
			"Apdex on all services per http.route",
		)
	})

	it("reads a builder query as its aggregation, source and where clause", () => {
		const base = form({ signalType: "builder_query" })
		const draft = { ...base.queryBuilderDraft, whereClause: 'service.name = "checkout"' }
		expect(watchSummary({ ...base, queryBuilderDraft: draft })).toBe(
			'Error rate of traces, where service.name = "checkout", per service.name',
		)
	})

	it("reads a SQL rule by its reducer", () => {
		expect(watchSummary(form({ signalType: "raw_query", rawQueryReducer: "max" }))).toBe(
			"SQL query, maximum of value",
		)
	})

	it("reads an anomaly rule by its scope, and the default rule as the catch-all", () => {
		const anomaly = fromFormState(anomalyRuleForm(form({ serviceNames: ["checkout"] })))
		expect(watchSummary(anomaly)).toBe("Anomalies in checkout · all environments · all signals")
		expect(watchSummary(fromFormState(anomalyRuleForm(form())), true)).toBe(
			"Every anomaly no narrower rule handles",
		)
	})
})

describe("conditionSummary", () => {
	it("says the threshold with its unit and how many checks fire it", () => {
		expect(conditionSummary(form({ consecutiveBreachesRequired: "3" }))).toBe(
			"Above 5%, over 5 min, 3 checks in a row, resolves after 2 healthy checks",
		)
	})

	it("adds the critical tier, in the same direction", () => {
		expect(
			conditionSummary(
				form({ comparator: "lt", threshold: "20", escalation: criticalTier({ threshold: "10" }) }),
			),
		).toBe(
			"Below 20%, critical below 10%, over 5 min, 2 checks in a row, resolves after 2 healthy checks",
		)
	})

	it("reads a range on a latency signal, and a single critical tier", () => {
		expect(
			conditionSummary(
				form({
					signalType: "p95_latency",
					comparator: "between",
					threshold: "200",
					thresholdUpper: "800",
					severity: "critical",
					consecutiveBreachesRequired: "1",
					consecutiveHealthyRequired: "1",
				}),
			),
		).toBe("Between 200 ms and 800 ms (critical), over 5 min")
	})

	it("reads a breach window and alerting on no data", () => {
		expect(
			conditionSummary(
				form({ consecutiveBreachesRequired: "3", breachesOutOf: "5", alertOnNoData: true }),
			),
		).toBe(
			"Above 5%, over 5 min, 3 of the last 5 checks, resolves after 2 healthy checks, no data counts",
		)
	})

	it("marks a blank threshold", () => {
		expect(conditionSummary(form({ threshold: "" }))).toMatch(/^Above \?%/)
	})
})

describe("notifySummary", () => {
	it("lists the destinations, and the chain after them", () => {
		expect(notifySummary(form(), NAMES)).toBe("#oncall")
		expect(
			notifySummary(form({ destinationIds: [ONCALL, PAGER], escalationChainId: CHAIN }), NAMES),
		).toBe("#oncall and PagerDuty Checkout, then escalate to Checkout primary")
	})

	it("says where the critical tier goes", () => {
		expect(notifySummary(form({ escalation: criticalTier({ escalationChainId: CHAIN }) }), NAMES)).toBe(
			"#oncall, critical escalates to Checkout primary",
		)
		expect(notifySummary(form({ escalation: criticalTier({ destinationIds: [PAGER] }) }), NAMES)).toBe(
			"#oncall, critical also PagerDuty Checkout",
		)
	})

	it("reads a rule routed only by a chain, or by nobody", () => {
		expect(notifySummary(form({ destinationIds: [], escalationChainId: CHAIN }), NAMES)).toBe(
			"Escalate to Checkout primary",
		)
		expect(notifySummary(form({ destinationIds: [] }), NAMES)).toBe("No one is notified")
	})

	it("names a destination the org no longer has instead of dropping it", () => {
		expect(notifySummary(form({ destinationIds: [GONE] }), NAMES)).toBe("a removed destination")
	})

	it("names a destination on both tiers once", () => {
		expect(notifySummary(form({ escalation: criticalTier({ destinationIds: [ONCALL] }) }), NAMES)).toBe(
			"#oncall",
		)
	})

	it("reads both tiers of an anomaly rule", () => {
		const anomaly = fromFormState(anomalyRuleForm(form({ serviceNames: ["checkout"] })))
		const routed = {
			...anomaly,
			escalation: { ...criticalTier(), ...anomaly.escalation, destinationIds: [PAGER] },
		}
		expect(notifySummary(routed, NAMES)).toBe("#oncall, critical also PagerDuty Checkout")
	})
})

describe("nameSummary", () => {
	it("is the name, then its tags", () => {
		expect(nameSummary(form({ tags: ["checkout", "tier-1"] }))).toBe(
			"Checkout errors · checkout and tier-1",
		)
		expect(nameSummary(form({ name: "  " }))).toBe("Unnamed rule")
	})
})

describe("card issues", () => {
	it("puts each missing field on the card that edits it", () => {
		expect(missingCards(form())).toEqual([])
		expect(missingCards(form({ name: "" }))).toEqual(["name"])
		expect(missingCards(form({ threshold: "" }))).toEqual(["condition"])
		expect(missingCards(form({ destinationIds: [] }))).toEqual(["notify"])
		expect(
			cardIssues(form({ signalType: "raw_query", rawQuerySql: "SELECT 1 AS value" }), "watch"),
		).toEqual(["$__orgFilter in SQL"])
		expect(cardIssues(form({ escalation: criticalTier() }), "notify")).toEqual(["Critical destinations"])
	})

	it("drops the condition card for an anomaly rule, whose scope is required unless it is the default", () => {
		const unscoped = fromFormState(anomalyRuleForm(form()))
		expect(cardsOf(unscoped)).toEqual(["watch", "notify", "name"])
		expect(missingCards(unscoped)).toEqual(["watch"])
		expect(missingCards(unscoped, true)).toEqual([])
	})
})
