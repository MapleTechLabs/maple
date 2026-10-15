import { describe, expect, it } from "vitest"

import { computeServiceShares, type SpectrumSpan } from "../service-spectrum-bar"

const T0 = "2026-07-17T00:00:00.000Z"

function span(
	serviceName: string,
	offsetMs: number,
	durationMs: number,
	children: Array<SpectrumSpan> = [],
): SpectrumSpan {
	return {
		serviceName,
		startTime: new Date(Date.parse(T0) + offsetMs).toISOString(),
		durationMs,
		children,
	}
}

describe("computeServiceShares", () => {
	it("credits a child's time to the child's service, not the waiting parent's", () => {
		const shares = computeServiceShares([span("api", 0, 100, [span("ai", 5, 90)])])
		expect(shares.map((s) => [s.serviceName, s.durationMs])).toEqual([
			["ai", 90],
			["api", 10],
		])
		expect(shares[0].percent).toBeCloseTo(90)
	})

	it("does not double-count a child nested inside its parent in the same service", () => {
		const shares = computeServiceShares([span("api", 0, 100, [span("api", 20, 30)])])
		expect(shares).toHaveLength(1)
		expect(shares[0]).toMatchObject({ serviceName: "api", durationMs: 100, percent: 100 })
	})

	it("splits time evenly between parallel children so shares sum to wall-clock time", () => {
		const shares = computeServiceShares([span("api", 0, 100, [span("db", 0, 80), span("cache", 0, 80)])])
		const byService = Object.fromEntries(shares.map((s) => [s.serviceName, s.durationMs]))
		expect(byService).toEqual({ db: 40, cache: 40, api: 20 })
		expect(shares.reduce((sum, s) => sum + s.durationMs, 0)).toBe(100)
	})

	it("counts a child that outlives its parent for the child's own service", () => {
		const shares = computeServiceShares([span("api", 0, 50, [span("worker", 40, 60)])])
		const byService = Object.fromEntries(shares.map((s) => [s.serviceName, s.durationMs]))
		expect(byService.worker).toBeCloseTo(60)
		expect(byService.api).toBeCloseTo(40)
	})

	it("skips missing-span placeholders but keeps their children", () => {
		const placeholder: SpectrumSpan = { ...span("unknown", 0, 0, [span("api", 0, 30)]), isMissing: true }
		const shares = computeServiceShares([placeholder])
		expect(shares.map((s) => s.serviceName)).toEqual(["api"])
	})

	it("guards a zero-duration trace with equal shares", () => {
		const shares = computeServiceShares([span("a", 0, 0), span("b", 0, 0)])
		expect(shares).toHaveLength(2)
		expect(shares[0].percent).toBeCloseTo(50)
		expect(shares[1].percent).toBeCloseTo(50)
	})

	it("returns empty for no spans", () => {
		expect(computeServiceShares([])).toEqual([])
	})

	it("leaves an unparseable span's subtree to the parent instead of splitting with it", () => {
		const broken: SpectrumSpan = {
			serviceName: "bad",
			startTime: "nope",
			durationMs: 50,
			children: [span("db", 10, 50)],
		}
		const shares = computeServiceShares([span("api", 0, 100, [broken])])
		expect(shares.map((s) => [s.serviceName, s.durationMs])).toEqual([["api", 100]])
	})

	it("ignores spans with unparseable start times", () => {
		const shares = computeServiceShares([
			span("api", 0, 100),
			{ serviceName: "bad", startTime: "nope", durationMs: 50, children: [] },
		])
		expect(shares).toHaveLength(1)
		expect(shares[0].serviceName).toBe("api")
	})
})
