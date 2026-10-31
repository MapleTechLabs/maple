import { AlertIncidentDocument, AlertRulePreviewResponse } from "@maple/domain/http"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import { defaultRuleForm } from "./form-utils"
import {
	countSkippedWindows,
	diffRuleForms,
	focusPreviewOnClosestGroups,
	incidentsClearedByDraft,
} from "./preview-insights"

const decodePreview = Schema.decodeUnknownSync(AlertRulePreviewResponse)
const decodeIncident = Schema.decodeUnknownSync(AlertIncidentDocument)

const T0 = Date.parse("2026-10-15T12:00:00.000Z")
const MIN = 60_000
const at = (minutes: number) => new Date(T0 + minutes * MIN).toISOString()

type PointSpec = { value: number | null; status?: string; skipReason?: string }

function preview(
	series: Record<string, PointSpec[]>,
	wouldFire: Array<{ groupKey: string; start: number; end: number }> = [],
): AlertRulePreviewResponse {
	return decodePreview({
		bucketSeconds: 300,
		windowMinutes: 5,
		threshold: 0.05,
		thresholdUpper: null,
		thresholds: [
			{ severity: "warning", value: 0.05, upper: null, recoveryValue: null, destinationIds: [] },
		],
		comparator: "gt",
		truncatedToStart: null,
		series: Object.entries(series).map(([groupKey, points]) => ({
			groupKey,
			points: points.map((point, i) => ({
				bucket: at(i * 5),
				value: point.value,
				sampleCount: 100,
				status: point.status ?? "healthy",
				...(point.skipReason ? { skipReason: point.skipReason } : undefined),
			})),
		})),
		wouldFire: wouldFire.map((span) => ({
			groupKey: span.groupKey,
			start: at(span.start),
			end: at(span.end),
			severity: "warning",
		})),
	})
}

function incident(groupKey: string | null, status = "open"): AlertIncidentDocument {
	return decodeIncident({
		id: "00000000-0000-4000-8000-0000000000f1",
		ruleId: "00000000-0000-4000-8000-00000000000a",
		ruleName: "Checkout errors",
		groupKey,
		signalType: "error_rate",
		severity: "critical",
		status,
		comparator: "gt",
		threshold: 0.05,
		thresholdUpper: null,
		peakSeverity: null,
		firstTriggeredAt: at(0),
		lastTriggeredAt: at(10),
		resolvedAt: null,
		lastObservedValue: 0.08,
		lastSampleCount: 100,
		dedupeKey: "dedupe",
		lastDeliveredEventType: "trigger",
		lastNotifiedAt: at(0),
		holdReason: null,
		heldSince: null,
		errorIssueId: null,
	})
}

describe("focusPreviewOnClosestGroups", () => {
	it("keeps the groups that breach or come closest to the threshold, and counts the rest", () => {
		const response = preview(
			{
				quiet: [{ value: 0.001 }, { value: 0.002 }],
				close: [{ value: 0.049 }, { value: 0.01 }],
				breaching: [{ value: 0.09, status: "breached" }, { value: 0.01 }],
				far: [{ value: 0.0 }, { value: 0.0 }],
			},
			[{ groupKey: "breaching", start: 0, end: 5 }],
		)
		const focused = focusPreviewOnClosestGroups(response, 2)

		expect(focused.shownGroups).toEqual(["breaching", "close"])
		expect(focused.hiddenGroupCount).toBe(2)
		// The verdict reads would-fire spans from every group, shown or not.
		expect(focused.preview?.wouldFire).toHaveLength(1)
	})

	it("leaves a preview within the limit untouched", () => {
		const response = preview({ a: [{ value: 1 }] })
		expect(focusPreviewOnClosestGroups(response, 3)).toEqual({
			preview: response,
			shownGroups: [],
			hiddenGroupCount: 0,
		})
	})
})

describe("countSkippedWindows", () => {
	it("counts skipped windows by reason across groups", () => {
		const response = preview({
			a: [
				{ value: 0.01, status: "skipped", skipReason: "below_min_samples" },
				{ value: null, status: "skipped", skipReason: "no_data" },
			],
			b: [{ value: 0.02 }, { value: 0.01, status: "skipped", skipReason: "below_min_samples" }],
		})
		expect(countSkippedWindows(response)).toEqual({
			total: 4,
			skipped: 3,
			byReason: { below_min_samples: 2, no_data: 1, no_value: 0 },
		})
	})
})

describe("incidentsClearedByDraft", () => {
	const draft = preview(
		{
			checkout: [
				{ value: 0.09, status: "breached" },
				{ value: 0.09, status: "breached" },
			],
			payments: [{ value: 0.09, status: "breached" }, { value: 0.01 }],
		},
		[
			// Still open at the last window (closes at its end).
			{ groupKey: "checkout", start: 0, end: 10 },
			// Resolved before the window ended.
			{ groupKey: "payments", start: 0, end: 5 },
		],
	)

	it("lists open incidents whose group the draft no longer holds open", () => {
		const cleared = incidentsClearedByDraft([incident("checkout"), incident("payments")], draft)
		expect(cleared.map((i) => i.groupKey)).toEqual(["payments"])
	})

	it("ignores resolved incidents and says nothing before the draft replay loads", () => {
		expect(incidentsClearedByDraft([incident("payments", "resolved")], draft)).toEqual([])
		expect(incidentsClearedByDraft([incident("payments")], null)).toEqual([])
	})
})

describe("diffRuleForms", () => {
	it("lists only the fields that change what gets saved, in display units", () => {
		const saved = { ...defaultRuleForm(), name: "Checkout errors", threshold: "1.5" }
		const draft = { ...saved, threshold: "2", windowMinutes: "15" }

		expect(diffRuleForms(saved, draft)).toEqual([
			{ field: "Threshold", before: "1.5%", after: "2.0%" },
			{ field: "Window", before: "5m", after: "15m" },
		])
	})

	it("counts a new check interval as a change", () => {
		const saved = { ...defaultRuleForm(), name: "Checkout errors", windowMinutes: "30" }
		expect(diffRuleForms(saved, { ...saved, evaluationIntervalMinutes: "10" })).toEqual([
			{ field: "Check every", before: "Auto", after: "10m" },
		])
	})

	it("finds nothing when the draft equals the saved rule", () => {
		const saved = { ...defaultRuleForm(), name: "Checkout errors" }
		expect(diffRuleForms(saved, { ...saved })).toEqual([])
	})
})
