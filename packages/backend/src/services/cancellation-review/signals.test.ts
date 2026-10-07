import { describe, expect, it } from "vitest"
import { CANCELLATION_FIXTURES } from "./fixtures"
import { deriveSignals, ruleReason } from "./signals"

const fixture = (id: string) => {
	const found = CANCELLATION_FIXTURES.find((candidate) => candidate.id === id)
	if (found === undefined) throw new Error(`no cancellation fixture named ${id}`)
	return found
}

describe("ruleReason", () => {
	it.each(CANCELLATION_FIXTURES.filter((candidate) => !candidate.judgement).map((c) => [c.id, c] as const))(
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

	it("does not read an ordinary dip as the org winding down", () => {
		expect(ruleReason(fixture("quieter-month").snapshot)).toBe("unclear")
	})

	it("leaves visits that are fading, but not yet gone, to the model", () => {
		// The known limit of fixed thresholds: nine days since the last visit is
		// under the cut-off, so the rules answer `unclear` where a reader would not.
		const { snapshot, expected } = fixture("drifting-away")
		expect(expected).toBe("not_engaged")
		expect(ruleReason(snapshot)).toBe("unclear")
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
