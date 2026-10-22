import { AlertIncidentDocument, AlertRuleDocument } from "@maple/domain/http"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import { defaultRuleForm } from "./form-utils"
import {
	blindSpots,
	fireLanes,
	ruleBucket,
	ruleConditionSummary,
	ruleHeadroom,
	ruleRibbon,
} from "./overview-derive"
import { builtinToQueryDraft } from "./rule-modes"
import type { DerivedRuleStatus } from "./rule-status"

const decodeRule = Schema.decodeUnknownSync(AlertRuleDocument)
const decodeIncident = Schema.decodeUnknownSync(AlertIncidentDocument)

const NOW = Date.parse("2026-07-06T12:00:00.000Z")
const HOUR = 60 * 60 * 1000
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const RULE_ID = "00000000-0000-4000-8000-000000000000"

function makeRule(overrides: Record<string, unknown> = {}): AlertRuleDocument {
	return decodeRule({
		id: RULE_ID,
		name: "High error rate",
		notes: null,
		notificationTemplate: null,
		enabled: true,
		severity: "critical",
		serviceNames: [],
		excludeServiceNames: [],
		environments: [],
		tags: [],
		groupBy: null,
		signalType: "error_rate",
		comparator: "gt",
		threshold: 0.05,
		thresholdUpper: null,
		windowMinutes: 5,
		minimumSampleCount: 0,
		consecutiveBreachesRequired: 1,
		breachesOutOf: null,
		evaluationIntervalMinutes: null,
		thresholds: [
			{ severity: "critical", value: 0.05, upper: null, recoveryValue: null, destinationIds: [] },
		],
		consecutiveHealthyRequired: 1,
		renotifyIntervalMinutes: 30,
		apdexThresholdMs: null,
		queryBuilderDraft: null,
		rawQuerySql: null,
		rawQueryReducer: null,
		destinationIds: [],
		noDataBehavior: "skip",
		lastEvaluationError: null,
		lastEvaluationErrorKind: null,
		slowedIntervalMinutes: null,
		slowedAt: null,
		lastEvaluatedAt: iso(60_000),
		lastScheduledAt: iso(60_000),
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		createdBy: "user_test",
		updatedBy: "user_test",
		...overrides,
	})
}

function makeIncident(overrides: Record<string, unknown> = {}): AlertIncidentDocument {
	return decodeIncident({
		id: "00000000-0000-4000-8000-0000000000aa",
		ruleId: RULE_ID,
		ruleName: "High error rate",
		groupKey: null,
		signalType: "error_rate",
		severity: "critical",
		status: "resolved",
		comparator: "gt",
		threshold: 0.05,
		thresholdUpper: null,
		peakSeverity: null,
		firstTriggeredAt: iso(6 * HOUR),
		lastTriggeredAt: iso(5 * HOUR),
		resolvedAt: iso(4 * HOUR),
		lastObservedValue: 0.08,
		lastSampleCount: 100,
		dedupeKey: "k",
		lastDeliveredEventType: null,
		lastNotifiedAt: null,
		holdReason: null,
		heldSince: null,
		errorIssueId: null,
		...overrides,
	})
}

const derived = (overrides: Partial<DerivedRuleStatus> = {}): DerivedRuleStatus => ({
	status: "healthy",
	attention: { noDestinations: false, recentDeliveryFailure: false, slowedDown: false },
	reason: null,
	...overrides,
})

describe("ruleBucket", () => {
	it("puts an unrouted healthy rule in blind and a firing one in firing", () => {
		expect(
			ruleBucket(
				derived({
					attention: { noDestinations: true, recentDeliveryFailure: false, slowedDown: false },
				}),
			),
		).toBe("blind")
		expect(
			ruleBucket(
				derived({
					status: "firing",
					attention: { noDestinations: true, recentDeliveryFailure: false, slowedDown: false },
				}),
			),
		).toBe("firing")
	})
})

describe("ruleHeadroom", () => {
	it("reports a breach and no headroom above a > threshold", () => {
		const meter = ruleHeadroom(makeRule(), 0.08)
		expect(meter.breached).toBe(true)
		expect(meter.headroom).toBeLessThan(0)
		expect(meter.fill).toBeGreaterThan(meter.ticks[0] ?? 1)
	})

	it("measures headroom from below for a < threshold", () => {
		const meter = ruleHeadroom(
			makeRule({ comparator: "lt", signalType: "throughput", threshold: 100 }),
			150,
		)
		expect(meter.breached).toBe(false)
		expect(meter.headroom).toBeCloseTo(0.5)
	})
})

describe("fireLanes", () => {
	it("clips bars to the window and skips incidents outside it", () => {
		const lanes = fireLanes(
			[
				makeIncident(),
				makeIncident({
					id: "00000000-0000-4000-8000-0000000000bb",
					firstTriggeredAt: iso(48 * HOUR),
					resolvedAt: iso(47 * HOUR),
				}),
			],
			{ min: NOW - 24 * HOUR, max: NOW },
		)
		expect(lanes).toHaveLength(1)
		expect(lanes[0]?.bars).toHaveLength(1)
		expect(lanes[0]?.bars[0]?.start).toBeCloseTo(18 / 24)
		expect(lanes[0]?.bars[0]?.end).toBeCloseTo(20 / 24)
	})
})

describe("ruleRibbon", () => {
	it("marks only the cells an incident overlaps", () => {
		const cells = ruleRibbon(
			[makeIncident({ severity: "warning" })],
			{ min: NOW - 24 * HOUR, max: NOW },
			4,
		)
		expect(cells).toEqual(["quiet", "quiet", "quiet", "warning"])
	})
})

describe("blindSpots", () => {
	it("lists errors before unrouted rules and skips disabled ones", () => {
		const erroring = makeRule({ id: "00000000-0000-4000-8000-000000000001" })
		const unrouted = makeRule({ id: "00000000-0000-4000-8000-000000000002" })
		const disabled = makeRule({ id: "00000000-0000-4000-8000-000000000003", enabled: false })
		const spots = blindSpots(
			[unrouted, erroring, disabled],
			new Map([
				[erroring.id, derived({ status: "error", reason: "boom" })],
				[
					unrouted.id,
					derived({
						attention: { noDestinations: true, recentDeliveryFailure: false, slowedDown: false },
					}),
				],
				[disabled.id, derived({ status: "disabled" })],
			]),
		)
		expect(spots.map((s) => [s.rule.id, s.kind])).toEqual([
			[erroring.id, "error"],
			[unrouted.id, "unrouted"],
		])
	})
	it("lists a rule slowed down by its timeouts, ahead of unrouted ones", () => {
		const slowed = makeRule({
			id: "00000000-0000-4000-8000-000000000004",
			slowedIntervalMinutes: 5,
			slowedAt: iso(HOUR),
		})
		const unrouted = makeRule({ id: "00000000-0000-4000-8000-000000000002" })
		const spots = blindSpots(
			[unrouted, slowed],
			new Map([
				[
					slowed.id,
					derived({
						attention: { noDestinations: false, recentDeliveryFailure: false, slowedDown: true },
					}),
				],
				[
					unrouted.id,
					derived({
						attention: { noDestinations: true, recentDeliveryFailure: false, slowedDown: false },
					}),
				],
			]),
		)
		expect(spots.map((s) => [s.rule.id, s.kind, s.detail])).toEqual([
			[slowed.id, "slowed", "Checked every 5 min because its query kept hitting its limit"],
			[unrouted.id, "unrouted", "No destinations, so nobody is notified"],
		])
	})
})

describe("ruleConditionSummary", () => {
	it("prints a builder error-rate threshold as a percent and names the aggregation", () => {
		const rule = makeRule({
			signalType: "builder_query",
			threshold: 0.05,
			queryBuilderDraft: builtinToQueryDraft(defaultRuleForm()),
		})
		expect(ruleConditionSummary(rule)).toBe("error rate > 5.0% · 5m")
	})
})
