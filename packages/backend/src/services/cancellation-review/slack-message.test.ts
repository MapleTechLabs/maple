import { CancellationAssessment } from "@maple/domain/http"
import { describe, expect, it } from "vitest"
import { CANCELLATION_FIXTURES } from "./fixtures"
import { deriveSignals, ruleReason } from "./signals"
import { buildCancellationMessage, type CancellationReport } from "./slack-message"

const report = (id: string, overrides: Partial<CancellationReport> = {}): CancellationReport => {
	const fixture = CANCELLATION_FIXTURES.find((candidate) => candidate.id === id)
	if (fixture === undefined) throw new Error(`no cancellation fixture named ${id}`)
	return {
		subject: {
			orgId: "org_42",
			orgName: "Acme <Labs> & Co",
			contactEmail: "dev@example.com",
			expiresAt: Date.parse("2026-10-19T00:00:00Z"),
		},
		snapshot: fixture.snapshot,
		ruleReason: ruleReason(fixture.snapshot),
		signals: deriveSignals(fixture.snapshot),
		assessment: null,
		...overrides,
	}
}

const text = (message: ReturnType<typeof buildCancellationMessage>) => JSON.stringify(message.blocks)

describe("buildCancellationMessage", () => {
	it("leads with the org, the plan's remaining access and the rule's reason", () => {
		const message = buildCancellationMessage(report("pipeline-off"))
		expect(message.text).toBe("Plan cancelled: Acme <Labs> & Co (Stopped sending telemetry)")
		expect(message.blocks[0]).toEqual({
			type: "header",
			text: { type: "plain_text", text: "Plan cancelled: Acme <Labs> & Co", emoji: true },
		})
		expect(message.blocks[1]).toEqual({
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: "`startup`  ·  access until Oct 19 (12d left)  ·  subscribed 240d  ·  org `org_42`",
				},
			],
		})
		expect(text(message)).toContain(":red_circle:  Stopped sending telemetry 24 days ago")
		expect(text(message)).toContain("No model read")
	})

	it("shows the model's read beside the rule's and flags a disagreement", () => {
		const message = buildCancellationMessage(
			report("drifting-away", {
				assessment: new CancellationAssessment({
					reason: "not_engaged",
					reasonConfidence: 0.81,
					winBack: 0.34,
					model: "@cf/cloudflare/clef",
				}),
			}),
		)
		expect(text(message)).toContain("*Likely reason*\\nNot visible in usage")
		expect(text(message)).toContain("*Model read*\\nNobody was using it (81%) :warning: differs")
		expect(text(message)).toContain("*Win-back odds*\\n34%")
		expect(text(message)).toContain("Model: @cf/cloudflare/clef")
	})

	it("names the sections it could not read instead of showing zeros", () => {
		const base = report("healthy-team")
		const message = buildCancellationMessage({
			...base,
			snapshot: { ...base.snapshot, visits: null, billing: null },
		})
		expect(text(message)).toContain("Could not read: app visits, billing")
		expect(text(message)).not.toContain("Days in the app")
	})

	it("says the plan ended for an immediate cancellation", () => {
		const message = buildCancellationMessage(report("past-due"))
		expect(message.text).toBe("Plan ended: Acme <Labs> & Co (Payment failed)")
		expect(text(message)).toContain("access ended")
	})
})
