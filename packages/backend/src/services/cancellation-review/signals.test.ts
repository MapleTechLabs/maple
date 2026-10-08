import { describe, expect, it } from "vitest"
import { CANCELLATION_FIXTURES } from "./fixtures"
import { deriveSignals, ruleReason } from "./signals"

const fixture = (id: string) => {
	const found = CANCELLATION_FIXTURES.find((candidate) => candidate.id === id)
	if (found === undefined) throw new Error(`no cancellation fixture named ${id}`)
	return found
}

describe("ruleReason", () => {
	it.each(CANCELLATION_FIXTURES.map((candidate) => [candidate.id, candidate] as const))(
		"reads %s as its expected reason",
		(_id, { snapshot, expected }) => {
			expect(ruleReason(snapshot)).toBe(expected)
		},
	)

	it("puts a bill jump ahead of the pipeline being switched off after it", () => {
		expect(ruleReason(fixture("bill-jump-then-off").snapshot)).toBe("cost")
	})

	it("reads a few last active days from a long-standing org as winding down, not a trial run", () => {
		const { snapshot } = fixture("pipeline-off")
		const volume = { logsGB: 1, tracesGB: 0, metricsGB: 0, browserSessions: 0, activeDays: 1 }
		const tail = { ...snapshot, ingest: { recent: volume, prior: volume, daysSinceLastData: 24 } }
		expect(ruleReason(tail)).toBe("stopped_sending")
	})

	it("reads an org that switched off months ago as stopped, not as never having started", () => {
		const { snapshot } = fixture("never-sent")
		const idle = { logsGB: 0, tracesGB: 0, metricsGB: 0, browserSessions: 0, activeDays: 0 }
		const longGone = {
			...snapshot,
			org: snapshot.org === null ? null : { ...snapshot.org, everReceivedData: true },
			ingest: { recent: idle, prior: idle, daysSinceLastData: 140 },
		}
		expect(ruleReason(longGone)).toBe("stopped_sending")
		expect(deriveSignals(longGone)[1]).toEqual({
			tone: "concern",
			text: "Stopped sending telemetry 140 days ago",
		})
	})

	it("does not call the first charge after a $0 invoice a bill jump", () => {
		const { snapshot } = fixture("healthy-team")
		const firstCharge = {
			...snapshot,
			billing: { lastInvoiceTotal: 39, previousInvoiceTotal: 0, overAllowance: [] },
		}
		expect(ruleReason(firstCharge)).toBe("unclear")
	})

	it("keeps payment failure for a plan that ended, not one the org scheduled to cancel", () => {
		const { snapshot } = fixture("past-due")
		expect(ruleReason(snapshot)).toBe("payment_failure")
		const chosen = { ...snapshot, plan: { ...snapshot.plan, phase: "scheduled" as const } }
		expect(ruleReason(chosen)).toBe("unclear")
	})

	it("does not read an ordinary dip as the org winding down", () => {
		expect(ruleReason(fixture("quieter-month").snapshot)).toBe("unclear")
	})

	it("reads visits that fell away from a real habit as nobody using it", () => {
		const { snapshot } = fixture("drifting-away")
		expect(ruleReason(snapshot)).toBe("not_engaged")
		expect(deriveSignals(snapshot)[1]).toEqual({
			tone: "concern",
			text: "Visits fell away: in the app on 1 day of the last 30, 14 the month before",
		})
		// A handful of visits either month is not a habit to fall away from.
		const occasional = {
			...snapshot,
			visits: {
				recent: { activeDays: 1, peakDailyUsers: 1 },
				prior: { activeDays: 4, peakDailyUsers: 1 },
				daysSinceLastVisit: 9,
			},
		}
		expect(ruleReason(occasional)).toBe("unclear")
	})
})

describe("deriveSignals", () => {
	it("says what a wound-down org looks like", () => {
		expect(deriveSignals(fixture("pipeline-off").snapshot)).toEqual([
			{ tone: "concern", text: "Stopped sending telemetry 24 days ago (42 GB the month before)" },
			{ tone: "concern", text: "Nobody opened the app in 20 days" },
			{ tone: "neutral", text: "9 dashboards, 14 alert rules, 2 integrations" },
		])
	})

	it("says what a healthy org looks like", () => {
		expect(deriveSignals(fixture("healthy-team").snapshot)).toEqual([
			{ tone: "healthy", text: "Still sending telemetry: 38 GB over 30 days of the last 30" },
			{
				tone: "healthy",
				text: "In the app on 22 days of the last 30 (24 the month before), up to 4 people a day",
			},
			{ tone: "neutral", text: "9 dashboards, 14 alert rules, 2 integrations" },
		])
	})

	it("stays silent about sections that could not be read", () => {
		const { snapshot } = fixture("healthy-team")
		const unread = { ...snapshot, ingest: null, visits: null, adoption: null, billing: null, org: null }
		expect(deriveSignals(unread)).toEqual([])
	})
})
