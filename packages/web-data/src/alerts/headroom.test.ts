import { AlertIncidentDocument, AlertRuleDocument } from "@maple/domain/http"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import type { AlertRuleStateRow } from "../collections/alerts"
import { quietForMs, ruleHeadroom } from "./headroom"

const decodeRule = Schema.decodeUnknownSync(AlertRuleDocument)
const decodeIncident = Schema.decodeUnknownSync(AlertIncidentDocument)

const RULE_A = "00000000-0000-4000-8000-00000000000a"
const RULE_B = "00000000-0000-4000-8000-00000000000b"
const NOW = Date.parse("2026-10-16T00:00:00.000Z")

function rule(id: string, overrides: Record<string, unknown> = {}): AlertRuleDocument {
	return decodeRule({
		id,
		name: `rule ${id.slice(-1)}`,
		notes: null,
		notificationTemplate: null,
		enabled: true,
		severity: "warning",
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
		noDataBehavior: "skip",
		consecutiveBreachesRequired: 2,
		breachesOutOf: null,
		evaluationIntervalMinutes: null,
		thresholds: [
			{ severity: "warning", value: 0.05, upper: null, recoveryValue: null, destinationIds: [] },
		],
		consecutiveHealthyRequired: 2,
		renotifyIntervalMinutes: 30,
		apdexThresholdMs: null,
		queryBuilderDraft: null,
		rawQuerySql: null,
		rawQueryReducer: null,
		destinationIds: [],
		lastEvaluationError: null,
		lastEvaluatedAt: "2026-10-15T23:59:00.000Z",
		lastScheduledAt: "2026-10-15T23:59:00.000Z",
		createdAt: "2026-10-15T00:00:00.000Z",
		updatedAt: "2026-10-15T00:00:00.000Z",
		createdBy: "user_1",
		updatedBy: "user_1",
		...overrides,
	})
}

function state(ruleId: string, groupKey: string, value: number | null): AlertRuleStateRow {
	return {
		org_id: "org_1",
		rule_id: ruleId,
		group_key: groupKey,
		consecutive_breaches: 0,
		consecutive_healthy: 3,
		last_status: "healthy",
		last_value: value,
		last_sample_count: 100,
		last_evaluated_at: "2026-10-15T23:59:00.000Z",
		last_error: null,
		updated_at: "2026-10-15T23:59:00.000Z",
	}
}

describe("ruleHeadroom", () => {
	it("keeps each rule's group nearest its threshold, nearest rule first", () => {
		const rows = ruleHeadroom(
			[rule(RULE_A), rule(RULE_B, { comparator: "lt", threshold: 10 })],
			new Map([
				[RULE_A, [state(RULE_A, "api", 0.01), state(RULE_A, "web", 0.04)]],
				[RULE_B, [state(RULE_B, "__total__", 40)]],
			]),
		)

		const rounded = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100)
		expect(rows.map((row) => [row.rule.id, row.groupKey, rounded(row.closeness)])).toEqual([
			[RULE_A, "web", 0.8],
			// A floor: 10 needed, 40 seen.
			[RULE_B, null, 0.25],
		])
	})

	it("leaves out disabled rules and rules with no value yet", () => {
		const rows = ruleHeadroom(
			[rule(RULE_A, { enabled: false }), rule(RULE_B)],
			new Map([
				[RULE_A, [state(RULE_A, "api", 0.04)]],
				[RULE_B, [state(RULE_B, "api", null)]],
			]),
		)
		expect(rows).toEqual([])
	})
})

describe("quietForMs", () => {
	const incident = (resolvedAt: string | null) =>
		decodeIncident({
			id: "00000000-0000-4000-8000-0000000000f1",
			ruleId: RULE_A,
			ruleName: "rule a",
			groupKey: null,
			signalType: "error_rate",
			severity: "warning",
			status: resolvedAt === null ? "open" : "resolved",
			comparator: "gt",
			threshold: 0.05,
			thresholdUpper: null,
			peakSeverity: null,
			firstTriggeredAt: "2026-10-15T20:00:00.000Z",
			lastTriggeredAt: "2026-10-15T20:10:00.000Z",
			resolvedAt,
			lastObservedValue: 0.08,
			lastSampleCount: 100,
			dedupeKey: "d",
			lastDeliveredEventType: null,
			lastNotifiedAt: null,
			holdReason: null,
			heldSince: null,
			errorIssueId: null,
		})

	it("counts from the latest resolve", () => {
		expect(quietForMs([incident("2026-10-15T22:00:00.000Z")], NOW)).toBe(2 * 3_600_000)
	})

	it("is null when nothing has resolved", () => {
		expect(quietForMs([], NOW)).toBeNull()
	})
})
