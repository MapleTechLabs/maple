// What the CI queries read is proven against ClickHouse in
// packages/backend/src/services/warehouse/ci-runs.clickhouse.e2e.test.ts.
import { describe, expect, it } from "vitest"
import { DateTime } from "effect"
import { ciRedStreak, ciRunsSpanMs } from "./ci-runs"

describe("ciRunsSpanMs", () => {
	it("covers every run from the first start to a second past the last end", () => {
		const at = (iso: string) => DateTime.makeUnsafe(iso)
		const span = ciRunsSpanMs([
			{ startedAt: at("2026-10-05T12:00:00Z"), durationMs: 600_000 },
			{ startedAt: at("2026-10-05T11:00:00Z"), durationMs: 60_000 },
		])
		expect(span?.startMs).toBe(Date.parse("2026-10-05T11:00:00Z"))
		expect(span?.endMs).toBe(Date.parse("2026-10-05T12:10:01Z"))
	})

	it("is absent for no runs", () => {
		expect(ciRunsSpanMs([])).toBeUndefined()
	})
})

describe("ciRedStreak", () => {
	const run = (result: string, revision: string) => ({ result, revision })

	it("is absent when the latest judged run passed", () => {
		expect(
			ciRedStreak([run("cancellation", "c"), run("success", "b"), run("failure", "a")]),
		).toBeUndefined()
	})

	it("counts failures back to the last green run, skipping runs without a verdict", () => {
		const streak = ciRedStreak([
			run("failure", "d"),
			run("cancellation", "c"),
			run("timeout", "b"),
			run("success", "a"),
		])
		expect(streak?.failedRuns).toBe(2)
		expect(streak?.firstFailed.revision).toBe("b")
		expect(streak?.lastGreen?.revision).toBe("a")
	})

	it("has no last green run when nothing passed", () => {
		const streak = ciRedStreak([run("failure", "b"), run("error", "a")])
		expect(streak?.failedRuns).toBe(2)
		expect(streak?.lastGreen).toBeUndefined()
	})
})
