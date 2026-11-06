import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { AlertRuleId } from "../primitives"
import {
	AlertSilenceMatchers,
	alertSilenceGroupBy,
	alertSilenceMatches,
	alertSilenceStatusAt,
	type AlertSilenceTarget,
} from "./alert-silences"

const ruleId = Schema.decodeSync(AlertRuleId)("11111111-1111-4111-8111-111111111111")
const otherRuleId = Schema.decodeSync(AlertRuleId)("22222222-2222-4222-8222-222222222222")

const rule = (overrides: Partial<AlertSilenceTarget> = {}): AlertSilenceTarget => ({
	ruleId,
	tags: [],
	serviceNames: [],
	environments: [],
	groupBy: null,
	groupKey: "__total__",
	...overrides,
})

describe("alertSilenceMatches", () => {
	const checkout = { services: ["checkout"] }

	it.each([
		["a rule scoped to the silenced service", checkout, rule({ serviceNames: ["checkout"] }), true],
		["a rule on another service", checkout, rule({ serviceNames: ["payments"] }), false],
		["a rule over every service", checkout, rule(), false],
		[
			"a rule on the silenced service and another one",
			checkout,
			rule({ serviceNames: ["checkout", "payments"] }),
			false,
		],
		[
			"a multi-service rule's incident keyed by the silenced service",
			checkout,
			rule({ serviceNames: ["checkout", "payments"], groupKey: "checkout" }),
			true,
		],
		[
			"the silenced group of a rule grouped by service",
			checkout,
			rule({ groupBy: ["service.name"], groupKey: "checkout" }),
			true,
		],
		[
			"another group of a rule grouped by service",
			checkout,
			rule({ groupBy: ["service.name"], groupKey: "payments" }),
			false,
		],
		[
			"the staging group of a rule grouped by environment",
			{ environments: ["staging"] },
			rule({ groupBy: ["deployment.environment"], groupKey: "staging" }),
			true,
		],
		[
			"a rule over every environment",
			{ environments: ["staging"] },
			rule({ serviceNames: ["checkout"] }),
			false,
		],
		["a rule by id", { ruleIds: [ruleId] }, rule(), true],
		["another rule id", { ruleIds: [otherRuleId] }, rule(), false],
		["a rule with one silenced tag", { tags: ["db", "infra"] }, rule({ tags: ["db"] }), true],
		["a rule without the tag", { tags: ["db"] }, rule({ tags: ["web"] }), false],
		[
			"a tagged production rule against tag AND environment",
			{ tags: ["db"], environments: ["production"] },
			rule({ tags: ["db"], environments: ["production"] }),
			true,
		],
		[
			"a tagged staging rule against tag AND environment",
			{ tags: ["db"], environments: ["production"] },
			rule({ tags: ["db"], environments: ["staging"] }),
			false,
		],
	] as const)("%s → %s", (_label, matchers, target, expected) => {
		expect(alertSilenceMatches(matchers, target)).toBe(expected)
	})
})

describe("alertSilenceMatches with incident labels", () => {
	// The default anomaly rule: no scope, grouped by the anomaly incident id.
	const anomaly = (labels: AlertSilenceTarget["labels"]) =>
		rule({ groupKey: "6f1c2d3e-4b5a-4c6d-8e7f-001122334455", labels })
	const checkoutProduction = { service: "checkout", environment: "production" }

	it.each([
		["the labelled service", { services: ["checkout"] }, true],
		["the labelled environment", { environments: ["production"] }, true],
		[
			"the labelled service AND environment",
			{ services: ["checkout"], environments: ["production"] },
			true,
		],
		["another service", { services: ["payments"] }, false],
		["the service in another environment", { services: ["checkout"], environments: ["staging"] }, false],
	] as const)("an anomaly labelled checkout/production against %s → %s", (_label, matchers, expected) => {
		expect(alertSilenceMatches(matchers, anomaly(checkoutProduction))).toBe(expected)
	})

	it("keeps the scope and group key results when the incident has no labels", () => {
		expect(alertSilenceMatches({ services: ["checkout"] }, anomaly(null))).toBe(false)
		expect(alertSilenceMatches({ services: ["checkout"] }, anomaly(undefined))).toBe(false)
		expect(
			alertSilenceMatches(
				{ services: ["checkout"] },
				rule({ serviceNames: ["checkout"], labels: null }),
			),
		).toBe(true)
	})

	it("lets a label win over the rule's scope", () => {
		const scoped = rule({ serviceNames: ["payments"], labels: { service: "checkout" } })
		expect(alertSilenceMatches({ services: ["checkout"] }, scoped)).toBe(true)
		expect(alertSilenceMatches({ services: ["payments"] }, scoped)).toBe(false)
	})
})

describe("AlertSilenceMatchers", () => {
	it("rejects a silence that matches nothing in particular", () => {
		expect(Schema.decodeOption(AlertSilenceMatchers)({})._tag).toBe("None")
		expect(Schema.decodeOption(AlertSilenceMatchers)({ services: [] })._tag).toBe("None")
		expect(Schema.decodeOption(AlertSilenceMatchers)({ services: ["checkout"] })._tag).toBe("Some")
	})
})

describe("alertSilenceStatusAt", () => {
	it.each([
		[999, "scheduled"],
		[1_000, "active"],
		[1_999, "active"],
		[2_000, "ended"],
	] as const)("at %s → %s", (now, status) => {
		expect(alertSilenceStatusAt({ startsAtMs: 1_000, endsAtMs: 2_000 }, now)).toBe(status)
	})
})

describe("alertSilenceGroupBy", () => {
	it("reads a builder query's draft grouping, in canonical spelling", () => {
		const draft = (groupBy: ReadonlyArray<string>, on = true) => ({ addOns: { groupBy: on }, groupBy })
		expect(
			alertSilenceGroupBy({
				groupBy: null,
				signalType: "builder_query",
				queryBuilderDraft: draft(["service_name"]),
			}),
		).toEqual(["service.name"])
		expect(
			alertSilenceGroupBy({
				groupBy: null,
				signalType: "builder_query",
				queryBuilderDraft: draft(["service.name"], false),
			}),
		).toBeNull()
		expect(
			alertSilenceGroupBy({
				groupBy: ["deployment.environment"],
				signalType: "error_rate",
				queryBuilderDraft: null,
			}),
		).toEqual(["deployment.environment"])
	})

	it("lets a service silence reach the service group of a builder query", () => {
		const groupBy = alertSilenceGroupBy({
			groupBy: null,
			signalType: "builder_query",
			queryBuilderDraft: { addOns: { groupBy: true }, groupBy: ["service_name"] },
		})
		expect(alertSilenceMatches({ services: ["checkout"] }, rule({ groupBy, groupKey: "checkout" }))).toBe(
			true,
		)
		expect(alertSilenceMatches({ services: ["checkout"] }, rule({ groupBy, groupKey: "payments" }))).toBe(
			false,
		)
	})
})
