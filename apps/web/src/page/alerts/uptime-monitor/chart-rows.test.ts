import { describe, expect, test } from "vitest"
import type { CheckPoint, CheckStats, PhasePoint } from "./model"
import { chartRows, phaseSeries } from "./view-panels"

const MINUTE = 60_000
const START = Date.UTC(2026, 9, 27, 12, 0)

/** One-minute buckets, a check count each. */
const stats = (counts: ReadonlyArray<number>): CheckStats => ({
	window: "1h",
	points: counts.map((totalCount, index): CheckPoint => ({
		bucket: new Date(START + index * MINUTE).toISOString(),
		errorRate: 0,
		p50LatencyMs: 100,
		p95LatencyMs: 100,
		p99LatencyMs: 100,
		totalCount,
		partial: false,
	})),
	samples: [],
	samplesTruncated: false,
	samplesFailed: false,
	windowStartMs: START,
	windowEndMs: START + counts.length * MINUTE,
	checks: counts.reduce((sum, count) => sum + count, 0),
	failures: 0,
	p50Ms: null,
	p95Ms: null,
	p99Ms: null,
	phases: [],
	phasesFailed: false,
})

const lineSegments = (counts: ReadonlyArray<number>, intervalMs: number) =>
	chartRows(stats(counts), intervalMs).map((row) => (row.p50LatencyMs === null ? "gap" : "check"))

describe("response time rows", () => {
	test("an empty bucket between checks a minute apart stays joined", () => {
		expect(lineSegments([1, 0, 1, 1], MINUTE)).toEqual(["check", "check", "check"])
	})

	test("checks that stop for longer than two intervals break the line", () => {
		expect(lineSegments([1, 0, 0, 0, 1], MINUTE)).toEqual(["check", "gap", "check"])
	})

	test("a monitor checking every 5 minutes on 1-minute buckets is one joined line", () => {
		expect(lineSegments([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 5 * MINUTE)).toEqual([
			"check",
			"check",
			"check",
		])
	})

	test("the line starts at the first check and ends at the last, with no gap at either end", () => {
		expect(lineSegments([0, 0, 0, 0, 1, 1, 0, 0, 0, 0], MINUTE)).toEqual(["check", "check"])
	})
})

const phase = (minute: number, timedChecks: number): PhasePoint => ({
	bucket: new Date(START + minute * MINUTE).toISOString(),
	timedChecks,
	dnsMs: timedChecks === 0 ? 0 : 5,
	connectMs: timedChecks === 0 ? 0 : 5,
	tlsMs: timedChecks === 0 ? 0 : 5,
	ttfbMs: timedChecks === 0 ? 0 : 100,
	transferMs: 0,
})

describe("phase breakdown series", () => {
	test("a bucket whose checks got no timed response breaks the bands instead of dipping to 0", () => {
		const series = phaseSeries(
			{ ...stats([1, 1, 1]), phases: [phase(0, 1), phase(1, 0), phase(2, 1)] },
			MINUTE,
		)
		expect(series.breaks).toEqual([phase(1, 0).bucket])
		expect(new Set(series.rows.map((row) => row.bucket))).toEqual(
			new Set([phase(0, 1).bucket, phase(2, 1).bucket]),
		)
	})

	test("the bands also break where the checks stopped", () => {
		const series = phaseSeries({ ...stats([1, 0, 0, 0, 1]), phases: [phase(0, 1), phase(4, 1)] }, MINUTE)
		expect(series.breaks).toEqual([phase(1, 0).bucket])
	})
})
