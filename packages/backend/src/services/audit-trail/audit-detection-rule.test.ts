import { describe, expect, it } from "vitest"
import { AlertDestinationId, AlertRuleId } from "@maple/primitives"
import { Option, Schema } from "effect"
import {
	auditCountReason,
	auditDetectionFromRow,
	auditDetectionRuleFields,
	type AuditDetectionRuleInput,
	type AuditDetectionRuleRow,
} from "./audit-detection-rule"

const asDestinationId = Schema.decodeSync(AlertDestinationId)
const RULE_ID = Schema.decodeSync(AlertRuleId)("3f0e1c52-6d0b-4d3e-9b1a-2f4c5d6e7a8b")
const PAGER = asDestinationId("0b7f4f0e-51a5-4c6e-8f0e-6a7d2c9b1e3f")

const input = (overrides: Partial<AuditDetectionRuleInput> = {}): AuditDetectionRuleInput => ({
	name: "Members added outside business hours",
	enabled: true,
	filters: { provider: "vercel", category: "membership" },
	windowMinutes: 10,
	threshold: 3,
	severity: "critical",
	destinationIds: [PAGER],
	...overrides,
})

/** The row a detection reads back from, as the database returns the columns `fields` wrote. */
const storedRow = (
	fields: ReturnType<typeof auditDetectionRuleFields>,
	overrides: Partial<AuditDetectionRuleRow> = {},
): AuditDetectionRuleRow => ({
	id: RULE_ID,
	name: fields.name,
	enabled: fields.enabled,
	auditFiltersJson: fields.auditFiltersJson,
	windowMinutes: fields.windowMinutes,
	threshold: fields.threshold,
	thresholdsJson: fields.thresholdsJson,
	createdAt: 1_700_000_000_000,
	updatedAt: 1_700_000_060_000,
	...overrides,
})

describe("auditDetectionRuleFields", () => {
	it("is a managed audit rule that fires at the event count, one tier to the detection's destinations", () => {
		const fields = auditDetectionRuleFields(input())

		expect(fields).toMatchObject({
			signalType: "audit",
			comparator: "gte",
			threshold: 3,
			severity: "critical",
			windowMinutes: 10,
			auditFiltersJson: { provider: "vercel", category: "membership" },
			destinationIdsJson: [PAGER],
			thresholdsJson: [{ severity: "critical", value: 3, destinationIds: [PAGER] }],
		})
	})

	// One event is enough to open and an empty window enough to resolve: nothing has to wait
	// for a second check, and a count of zero must never be skipped for too few samples.
	it("opens and resolves on a single check, with no minimum sample count", () => {
		const fields = auditDetectionRuleFields(input())

		expect(fields).toMatchObject({
			evaluationIntervalMinutes: 1,
			minimumSampleCount: 0,
			consecutiveBreachesRequired: 1,
			consecutiveHealthyRequired: 1,
			breachesOutOf: null,
		})
	})

	it("carries no query, service scope or grouping: the evaluator counts the audit trail", () => {
		const fields = auditDetectionRuleFields(input())

		expect(fields).toMatchObject({
			querySpecJson: null,
			rawQuerySql: null,
			queryBuilderDraftJson: null,
			serviceNamesJson: null,
			environmentsJson: null,
			groupBy: null,
		})
	})
})

describe("auditDetectionFromRow", () => {
	it("reads back the detection its rule fields were written from", () => {
		const detection = auditDetectionFromRow(storedRow(auditDetectionRuleFields(input())))

		expect(Option.getOrNull(detection)).toEqual({
			id: RULE_ID,
			name: "Members added outside business hours",
			enabled: true,
			filters: { provider: "vercel", category: "membership" },
			windowMinutes: 10,
			threshold: 3,
			severity: "critical",
			destinationIds: [PAGER],
			createdAt: 1_700_000_000_000,
			updatedAt: 1_700_000_060_000,
		})
	})

	it("reads a rule stored without a filters column as counting every event", () => {
		const row = storedRow(auditDetectionRuleFields(input()), { auditFiltersJson: null })

		expect(Option.getOrNull(auditDetectionFromRow(row))?.filters).toEqual({})
	})

	// Showing a guess would let the next save overwrite what is stored.
	it("does not read a rule whose filters or tier this build cannot decode", () => {
		const fields = auditDetectionRuleFields(input())

		expect(
			Option.isNone(
				auditDetectionFromRow(
					storedRow(fields, { auditFiltersJson: { provider: "a-new-platform" } }),
				),
			),
		).toBe(true)
		expect(Option.isNone(auditDetectionFromRow(storedRow(fields, { thresholdsJson: null })))).toBe(true)
	})
})

describe("auditCountReason", () => {
	it("says how many events arrived and over which window", () => {
		expect(auditCountReason(3, 10)).toBe("3 matching audit events in the last 10 minutes")
		expect(auditCountReason(1, 60)).toBe("1 matching audit event in the last 60 minutes")
		expect(auditCountReason(0, 5)).toBe("0 matching audit events in the last 5 minutes")
	})
})
