import { AlertDeliveryEventDocument, AlertIncidentDocument } from "@maple/domain/http"
import { V2AlertIncidentEvent } from "@maple/domain/http/v2"
import { Schema, Array as Arr } from "effect"
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
		acknowledgedAt: null,
		acknowledgedByUserId: null,
		acknowledgedByName: null,
		acknowledgedVia: null,
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

const decodeActivity = Schema.decodeUnknownSync(V2AlertIncidentEvent)

const makeActivity = (overrides: Record<string, unknown>): V2AlertIncidentEvent =>
	decodeActivity({
		id: "evt_tC4d9V79DCDzgbGKhAnff9",
		object: "alert_incident_event",
		incident_id: "inc_tC4d9V79DCDzgbGKhAnff9",
		type: "acknowledged",
		actor: { user_id: "user_dana", name: "Dana Kim" },
		source: "slack",
		created_at: "2026-10-15T14:20:00.000Z",
		...overrides,
	})

const build = (
	incident: AlertIncidentDocument,
	deliveries: ReadonlyArray<AlertDeliveryEventDocument> = [],
	activity: ReadonlyArray<V2AlertIncidentEvent> = [],
) =>
	buildIncidentTimeline({
		incident,
		deliveries,
		activity,
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
		expect(Arr.map(entries, (entry) => entry.title)).toEqual([
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

	it("names a PagerDuty acknowledgement as one, not as a notification", () => {
		const [, sent] = build(makeIncident(), [
			makeDelivery({
				eventType: "acknowledge",
				destinationName: "On-call",
				destinationType: "pagerduty",
			}),
		])
		expect(sent?.title).toBe("Sent acknowledgement to On-call")
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

	it("places acknowledgements in order and pauses the reminder note while acknowledged", () => {
		const entries = build(
			makeIncident({
				acknowledgedAt: "2026-10-15T14:26:00.000Z",
				acknowledgedByName: "Dana Kim",
				acknowledgedVia: "web",
			}),
			[makeDelivery()],
			[
				makeActivity({}),
				makeActivity({
					id: "evt_tC4d9V79DCDzgbGKhAnffA",
					type: "unacknowledged",
					actor: { user_id: null, name: "sam" },
					source: "slack",
					created_at: "2026-10-15T14:22:00.000Z",
				}),
				makeActivity({
					id: "evt_tC4d9V79DCDzgbGKhAnffB",
					actor: { user_id: "user_dana", name: null },
					source: "mcp",
					created_at: "2026-10-15T14:26:00.000Z",
				}),
			],
		)
		expect(Arr.map(entries, (entry) => entry.title)).toEqual([
			"Incident opened",
			"Notified #alerts",
			"Acknowledged by Dana Kim",
			"Unacknowledged by sam",
			"Acknowledged by an agent over MCP",
			"Still breaching",
		])
		expect(entries[2]?.detail).toBe("From Slack · reminders paused")
		expect(entries.at(-1)?.detail).toBe("Last value 8.4% · reminders paused while acknowledged")
	})

	it("explains an acknowledgement the escalation cleared", () => {
		const entries = build(
			makeIncident(),
			[],
			[
				makeActivity({
					type: "ack_cleared",
					actor: null,
					source: null,
					created_at: "2026-10-15T14:28:00.000Z",
				}),
			],
		)
		expect(entries[1]).toMatchObject({ title: "Acknowledgement cleared", tone: "warn" })
		expect(entries.at(-1)?.detail).toBe("Last value 8.4% · reminders every 30m while open")
	})

	it("leaves out an acknowledgement the dispatcher skipped", () => {
		const sent = makeDelivery({
			eventType: "acknowledge",
			destinationType: "pagerduty",
			responseCode: 202,
		})
		const skipped = makeDelivery({
			id: "00000000-0000-4000-8000-0000000000e9",
			eventType: "acknowledge",
			destinationType: "pagerduty",
			responseCode: null,
			providerMessage: "Skipped: the incident is no longer acknowledged",
		})
		expect(Arr.map(build(makeIncident(), [sent]), (entry) => entry.title)).toContain(
			"Sent acknowledgement to #alerts",
		)
		expect(Arr.map(build(makeIncident(), [skipped]), (entry) => entry.title)).not.toContain(
			"Sent acknowledgement to #alerts",
		)
	})

	it("keeps the state still in effect last when an ack came after it", () => {
		const entries = build(
			makeIncident({ holdReason: "no_data", heldSince: "2026-10-15T14:40:00.000Z" }),
			[],
			[makeActivity({ created_at: "2026-10-15T14:45:00.000Z" })],
		)
		expect(Arr.map(entries, (entry) => entry.title)).toEqual([
			"Incident opened",
			"Acknowledged by Dana Kim",
			"Waiting on data",
		])
	})
})
