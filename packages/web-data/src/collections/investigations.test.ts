import { describe, expect, it } from "vitest"

import { rowsToInvestigation, type InvestigationRow } from "./investigations"

const row = (overrides: Partial<InvestigationRow> = {}): InvestigationRow => ({
	id: "88888888-8888-4888-8888-888888888888",
	org_id: "org_1",
	status: "diagnosed",
	seeded_by: "system",
	subject_json: {
		type: "incident",
		incidentKind: "error",
		incidentId: "018f2b3c-4d5e-6f70-8192-a3b4c5d6e7f8",
		issueId: "77777777-7777-4777-8777-777777777777",
	},
	snapshot_json: {
		title: "Checkout timeouts after deploy 8f21c",
		scope: "checkout-api",
		status: "open",
		severity: "critical",
		facts: [],
		references: [],
		incidentStartedAt: "2026-08-01T14:02:00.000Z",
		incidentEndedAt: null,
	},
	progress_json: null,
	report_json: {
		headline: "Pool exhaustion in checkout-api",
		summary: "checkout-api saturated its connection pool",
		suspectedCause: "Pool exhaustion in checkout-api",
		severityAssessment: "critical",
		affectedScope: "Checkout & payment capture",
		evidence: [],
		suggestedActions: ["Roll back deploy 8f21c"],
		confidence: "high",
	},
	severity: "critical",
	confidence: "high",
	model: "claude-opus-5",
	input_tokens: 12000,
	output_tokens: 800,
	error: null,
	created_by: null,
	created_at: "2026-08-01T14:02:00.000Z",
	started_at: "2026-08-01T14:02:00.000Z",
	diagnosed_at: "2026-08-01T14:02:38.000Z",
	updated_at: "2026-08-01T14:02:38.000Z",
	...overrides,
})

describe("rowsToInvestigation", () => {
	it("rebuilds the object the page renders", () => {
		const investigation = rowsToInvestigation(row())
		expect(investigation).not.toBeNull()
		expect(investigation).toMatchObject({
			object: "investigation",
			status: "diagnosed",
			subject: { type: "incident", incident_kind: "error" },
			report: { suspectedCause: "Pool exhaustion in checkout-api" },
		})
	})

	/**
	 * The partial's payload has to survive the decode, and asserting the decode
	 * merely *succeeded* would not prove it: `rowsToInvestigation` runs
	 * `Schema.decodeUnknownOption`, which silently DROPS keys the schema does not
	 * declare. A `V2AiTriageResult` missing `ruledOut` / `unchecked` would pass a
	 * not-null check while shipping an inconclusive investigation with its entire
	 * result removed — so these assert the fields are present on the output.
	 */
	it("carries an inconclusive run's ruled-out and unchecked lists through the decode", () => {
		const investigation = rowsToInvestigation(
			row({
				status: "inconclusive",
				severity: null,
				confidence: "low",
				error: null,
				report_json: {
					summary: "Nothing held up.",
					suspectedCause: "Possibly the payments-api pool, unconfirmed",
					severityAssessment: "low",
					affectedScope: "checkout-api",
					evidence: [],
					suggestedActions: [],
					confidence: "low",
					ruledOut: ["Deploy: service.version unchanged across 41k spans"],
					unchecked: ["Pool depth: payments-api emits no connection metrics"],
				},
			}),
		)
		expect(investigation?.status).toBe("inconclusive")
		expect(investigation?.report?.ruledOut).toEqual([
			"Deploy: service.version unchanged across 41k spans",
		])
		expect(investigation?.report?.unchecked).toEqual([
			"Pool depth: payments-api emits no connection metrics",
		])
	})

	/**
	 * `snapshot_json` is nullable in the table but non-nullable on the resource,
	 * and the page reads straight through it. Passing the null along was the bug a
	 * cast hid; the server has had `fallbackSnapshot` for this all along.
	 */
	it("substitutes a snapshot for an investigation opened without one", () => {
		const investigation = rowsToInvestigation(row({ snapshot_json: null }))
		expect(investigation?.snapshot).toMatchObject({
			title: "Error incident",
			facts: [{ label: "Incident", value: "018f2b3c-4d5e-6f70-8192-a3b4c5d6e7f8" }],
		})
	})

	it("carries a freeform subject through", () => {
		const investigation = rowsToInvestigation(
			row({
				subject_json: {
					type: "freeform",
					title: "why is checkout slow",
					prompt: "…",
					contextRefs: [],
				},
				snapshot_json: null,
			}),
		)
		expect(investigation?.subject).toMatchObject({ type: "freeform", title: "why is checkout slow" })
		expect(investigation?.snapshot.title).toBe("why is checkout slow")
	})

	/**
	 * A row we cannot read is reported, not guessed at. The server raises
	 * `InvestigationSubjectDecodeError` at the same point; here the page shows its
	 * retry rather than a chain built on an id nothing can open.
	 */
	it("returns null rather than a half-built object when the subject will not decode", () => {
		expect(
			rowsToInvestigation(row({ subject_json: { type: "incident", incidentKind: "error" } })),
		).toBeNull()
		expect(rowsToInvestigation(row({ status: "not-a-status" }))).toBeNull()
	})
})
