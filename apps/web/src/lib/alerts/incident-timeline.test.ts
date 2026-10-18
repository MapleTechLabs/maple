import { AlertDeliveryEventDocument, AlertIncidentDocument } from "@maple/domain/http"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { buildIncidentTimeline } from "./incident-timeline"

const decodeIncident = Schema.decodeUnknownSync(AlertIncidentDocument)
const decodeDelivery = Schema.decodeUnknownSync(AlertDeliveryEventDocument)

const INCIDENT_ID = "00000000-0000-4000-8000-0000000000f1"
const RULE_ID = "00000000-0000-4000-8000-00000000000a"

function makeIncident(overrides: Record<string, unknown> = {}): AlertIncidentDocument {
	return decodeIncident({
		id: INCIDENT_ID,
		ruleId: RULE_ID,
		ruleName: "High error rate",
		groupKey: "checkout",
		signalType: "error_rate",
		severity: "critical",
		status: "open",
		comparator: "gt",
		threshold: 0.05,
		thresholdUpper: null,
		peakSeverity: null,
		firstTriggeredAt: "2026-10-15T14:14:00.000Z",
		lastTriggeredAt: "2026-10-15T14:30:00.000Z",
		resolvedAt: null,
		lastObservedValue: 0.084,
		lastSampleCount: 100,
		dedupeKey: "dedupe",
		lastDeliveredEventType: "trigger",
		lastNotifiedAt: "2026-10-15T14:14:05.000Z",
		holdReason: null,
		heldSince: null,
		errorIssueId: null,
		...overrides,
	})
}

function makeDelivery(overrides: Record<string, unknown> = {}): AlertDeliveryEventDocument {
	return decodeDelivery({
		id: "00000000-0000-4000-8000-0000000000e1",
		incidentId: INCIDENT_ID,
		ruleId: RULE_ID,
		destinationId: "00000000-0000-4000-8000-00000000dddd",
		destinationName: "#alerts",
		destinationType: "discord",
		deliveryKey: "key",
		eventType: "trigger",
		attemptNumber: 1,
		status: "success",
		scheduledAt: "2026-10-15T14:14:02.000Z",
		attemptedAt: "2026-10-15T14:14:03.000Z",
		providerMessage: null,
		providerReference: null,
		responseCode: 200,
		errorMessage: null,
		...overrides,
	})
}

const build = (incident: AlertIncidentDocument, deliveries: ReadonlyArray<AlertDeliveryEventDocument> = []) =>
	buildIncidentTimeline({
		incident,
		deliveries,
		investigation: null,
		renotifyIntervalMinutes: 30,
		destinationTypeLabel: (type) => type,
	})

describe("buildIncidentTimeline", () => {
	it("orders the open, deliveries and current state chronologically", () => {
		const entries = build(makeIncident(), [
			makeDelivery({
				id: "00000000-0000-4000-8000-0000000000e2",
				eventType: "renotify",
				scheduledAt: "2026-10-15T14:24:00.000Z",
				attemptedAt: "2026-10-15T14:24:01.000Z",
			}),
			makeDelivery(),
		])
		expect(entries.map((entry) => entry.title)).toEqual([
			"Incident opened",
			"Notified #alerts",
			"Reminded #alerts",
			"Still breaching",
		])
		expect(entries[0]?.detail).toBe("Error rate above 5.0% on checkout")
	})

	it("reports a failed delivery with its error", () => {
		const [, failed] = build(makeIncident(), [
			makeDelivery({ status: "failed", errorMessage: "webhook returned 500", responseCode: 500 }),
		])
		expect(failed?.title).toBe("Could not notify #alerts")
		expect(failed?.tone).toBe("crit")
		expect(failed?.detail).toBe("discord · webhook returned 500")
	})

	it("ends a held incident on the hold instead of a breach", () => {
		const entries = build(makeIncident({ holdReason: "no_data", heldSince: "2026-10-15T14:40:00.000Z" }))
		expect(entries.at(-1)?.title).toBe("Waiting on data")
		expect(entries.at(-1)?.pending).toBe(true)
	})

	it("ends a resolved incident with its duration", () => {
		const entries = build(
			makeIncident({
				status: "resolved",
				resolvedAt: "2026-10-15T14:52:00.000Z",
				lastDeliveredEventType: "resolve",
			}),
		)
		expect(entries.at(-1)).toMatchObject({ title: "Resolved", detail: "After 38m" })
	})
})
