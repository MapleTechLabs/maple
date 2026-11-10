import { AlertDestinationId, AlertQueryTiming, EscalationChainId } from "@maple/domain/http"
import { anomalyRuleForm, defaultRuleForm } from "@maple/web-data/alerts/form-utils"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { fromFormState, type RuleForm } from "./form"
import { setBreachMode } from "./form-steps"
import {
	cardIssues,
	cardOfIssue,
	cardsOf,
	conditionSummary,
	isProblemIssue,
	issueFieldId,
	missingCards,
	nameSummary,
	notifySummary,
	type NameLookup,
	type NotifyNames,
	revealedInvalidFields,
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

const found = (name: string): NameLookup => ({ _tag: "Found", name })
const GONE_LOOKUP: NameLookup = { _tag: "Gone" }
const NAMES: NotifyNames = {
	destination: (id) =>
		id === ONCALL ? found("#oncall") : id === PAGER ? found("PagerDuty Checkout") : GONE_LOOKUP,
	chain: (id) => (id === CHAIN ? found("Checkout primary") : GONE_LOOKUP),
}
const LOADING: NotifyNames = { destination: () => ({ _tag: "Loading" }), chain: () => ({ _tag: "Loading" }) }

/** One check of the SQL takes 7.8s: too slow for 1-minute checks, fits 5-minute ones. */
const SLOW = Schema.decodeSync(AlertQueryTiming)({
	elapsedMs: 7_800,
	failure: null,
	probeLimitMs: 25_000,
	intervalMinutes: 1,
	limitMs: 5_000,
	fitsIntervalMinutes: [5, 10, 15, 30, 60],
})

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
			"Above 5%, in 3 checks in a row (5 min each), resolves after 2 healthy checks",
		)
	})

	it("adds the critical tier, in the same direction", () => {
		expect(
			conditionSummary(
				form({ comparator: "lt", threshold: "20", escalation: criticalTier({ threshold: "10" }) }),
			),
		).toBe(
			"Below 20%, critical below 10%, in 2 checks in a row (5 min each), resolves after 2 healthy checks",
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
			"Above 5%, in 3 of the last 5 checks (5 min each), resolves after 2 healthy checks, alerts on no data",
		)
	})

	it("says the recovery value when one is set", () => {
		expect(conditionSummary(form({ recoveryValue: "4", consecutiveHealthyRequired: "1" }))).toBe(
			"Above 5%, in 2 checks in a row (5 min each), recovers below 4%",
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
		expect(notifySummary(form({ destinationIds: [GONE] }), NAMES)).toBe("A removed destination")
	})

	it("never calls a destination removed while the lists are still loading", () => {
		expect(notifySummary(form({ destinationIds: [GONE], escalationChainId: CHAIN }), LOADING)).toBe(
			"A destination, then escalate to a chain",
		)
	})

	it("names a destination on both tiers once", () => {
		expect(notifySummary(form({ escalation: criticalTier({ destinationIds: [ONCALL] }) }), NAMES)).toBe(
			"#oncall",
		)
	})

	it("reads a rule routed only on its critical tier as the critical route", () => {
		const anomaly = fromFormState(
			anomalyRuleForm(form({ serviceNames: ["checkout"], destinationIds: [] })),
		)
		const criticalOnly = {
			...anomaly,
			escalation: { ...criticalTier(), ...anomaly.escalation, destinationIds: [PAGER] },
		}
		expect(notifySummary(criticalOnly, NAMES)).toBe("Critical: PagerDuty Checkout")
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

describe("field errors", () => {
	it("tells a problem to fix from a field left empty, so a card says only empty fields are missing", () => {
		expect(isProblemIssue("Threshold")).toBe(false)
		expect(isProblemIssue("Rule name")).toBe(false)
		expect(isProblemIssue("Critical threshold past warning")).toBe(true)
		expect(isProblemIssue("Critical recovery past warning")).toBe(true)
		expect(isProblemIssue("Check interval longer than the window")).toBe(true)
		expect(isProblemIssue("Query too slow for this check interval")).toBe(true)
	})

	it("points each issue at the control that fixes it", () => {
		expect(issueFieldId("Threshold")).toBe("rule-threshold")
		expect(issueFieldId("Critical threshold past warning")).toBe("rule-critical-threshold")
		expect(issueFieldId("Query too slow for this check interval")).toBe("rule-interval-trigger")
		expect(issueFieldId("Who gets notified")).toBe("rule-chain-warning-trigger")
		// A query that does not compile has no one field: its card's heading is the target.
		expect(issueFieldId("Query: pick a metric")).toBeNull()
		expect(cardOfIssue("Query: pick a metric")).toBe("watch")
	})

	it("shows no field error on a pristine form, one a left field has, and all after a save attempt", () => {
		const issues = ["Rule name", "Threshold", "Who gets notified"]
		expect(revealedInvalidFields(issues, [], false)).toEqual([])
		expect(revealedInvalidFields(issues, ["rule-threshold", "rule-window-minutes"], false)).toEqual([
			"rule-threshold",
		])
		expect(revealedInvalidFields(issues, [], true)).toEqual([
			"rule-name",
			"rule-threshold",
			"rule-chain-warning-trigger",
		])
	})
})

describe("setBreachMode", () => {
	it("starts the window two past the breaches to fire, keeps one already typed, and clears it in a row", () => {
		expect(setBreachMode(form({ consecutiveBreachesRequired: "3" }), "window").breachesOutOf).toBe("5")
		expect(setBreachMode(form({ consecutiveBreachesRequired: "" }), "window").breachesOutOf).toBe("5")
		expect(setBreachMode(form({ breachesOutOf: "8" }), "window").breachesOutOf).toBe("8")
		expect(setBreachMode(form({ breachesOutOf: "8" }), "row").breachesOutOf).toBe("")
	})
})

describe("card issues", () => {
	it("puts each missing field on the card that edits it", () => {
		expect(missingCards(form(), null)).toEqual([])
		expect(missingCards(form({ name: "" }), null)).toEqual(["name"])
		expect(missingCards(form({ threshold: "" }), null)).toEqual(["condition"])
		expect(missingCards(form({ destinationIds: [] }), null)).toEqual(["notify"])
		expect(
			cardIssues(form({ signalType: "raw_query", rawQuerySql: "SELECT 1 AS value" }), "watch", null),
		).toEqual(["$__orgFilter in SQL"])
		expect(cardIssues(form({ escalation: criticalTier() }), "notify", null)).toEqual([
			"Critical destinations",
		])
	})

	it("puts a query too slow for its interval on Alert when, as a save blocker", () => {
		const sql = form({ signalType: "raw_query" })
		expect(missingCards(sql, null)).toEqual([])
		expect(cardIssues(sql, "condition", SLOW)).toEqual(["Query too slow for this check interval"])
		expect(missingCards(sql, SLOW)).toEqual(["condition"])
	})

	it("drops the condition card for an anomaly rule, whose scope is required unless it is the default", () => {
		const unscoped = fromFormState(anomalyRuleForm(form()))
		expect(cardsOf(unscoped)).toEqual(["watch", "notify", "name"])
		expect(missingCards(unscoped, null)).toEqual(["watch"])
		expect(missingCards(unscoped, null, true)).toEqual([])
	})
})
