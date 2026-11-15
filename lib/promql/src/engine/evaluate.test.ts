import { Result } from "effect"
import { describe, expect, it } from "vitest"
import { buildDataset, DATA_END_MS, DATA_START_MS } from "../../scripts/compliance/dataset"
import { QUERIES } from "../../scripts/compliance/queries"
import { memorySource, type QueryResult, runQuery, type SelectorRequest } from "./index"

const dataset = buildDataset()
const bucketed = memorySource(dataset)
const raw = (request: SelectorRequest) => bucketed({ ...request, widthMs: 0, needsValues: true })

const run = (
	query: string,
	params: { startMs: number; endMs: number; stepMs: number },
	source = bucketed,
) => {
	const result = runQuery(query, params, source)
	if (Result.isFailure(result)) throw new Error(`${query}: ${result.failure.message}`)
	return result.success
}

const flatten = (result: QueryResult): Array<[string, number, number]> => {
	switch (result.resultType) {
		case "scalar":
			return [["", result.result.t, result.result.v]]
		case "string":
			return []
		case "vector":
			return result.result.map((s) => [JSON.stringify(s.labels), s.t, s.value])
		case "matrix":
			return result.result.flatMap((s) =>
				s.points.map((p): [string, number, number] => [JSON.stringify(s.labels), p.t, p.v]),
			)
	}
}

/** The first point where two results differ, or undefined. */
const mismatch = (
	a: Array<[string, number, number]>,
	b: Array<[string, number, number]>,
): string | undefined => {
	if (a.length !== b.length) return `${a.length} points vs ${b.length}`
	for (const [i, [k, t, v]] of a.entries()) {
		const other = b[i]
		if (other === undefined || other[0] !== k || other[1] !== t) return `point ${i} is ${k}@${t}`
		const w = other[2]
		const equal =
			(Number.isNaN(v) && Number.isNaN(w)) ||
			v === w ||
			Math.abs(v - w) <= 1e-9 * Math.max(1, Math.abs(v), Math.abs(w))
		if (!equal) return `${k}@${t}: ${v} vs ${w}`
	}
	return undefined
}

describe("bucketed evaluation matches raw samples", () => {
	const range = { startMs: DATA_START_MS + 1800_000, endMs: DATA_END_MS - 600_000, stepMs: 60_000 }
	const instant = { startMs: DATA_START_MS + 3600_000, endMs: DATA_START_MS + 3600_000, stepMs: 0 }
	for (const query of QUERIES) {
		it(query, () => {
			expect(mismatch(flatten(run(query, range)), flatten(run(query, range, raw)))).toBeUndefined()
			expect(mismatch(flatten(run(query, instant)), flatten(run(query, instant, raw)))).toBeUndefined()
		})
	}
})

describe("evaluate", () => {
	const at = DATA_START_MS + 3600_000
	const instant = { startMs: at, endMs: at, stepMs: 0 }

	it("reads the latest sample within the lookback", () => {
		const result = run('http_requests_total{instance="c:9090"}', instant)
		expect(result.resultType).toBe("vector")
		expect(flatten(result)).toHaveLength(1)
	})

	it("drops a series whose last sample is older than five minutes", () => {
		// The b:9090 code=500 series has a gap from +30m to +45m.
		const inGap = DATA_START_MS + 2_400_000
		const result = run('http_requests_total{instance="b:9090", code="500"}', {
			startMs: inGap,
			endMs: inGap,
			stepMs: 0,
		})
		expect(flatten(result)).toHaveLength(0)
	})

	it("returns raw samples for a bare range selector", () => {
		const result = run('http_requests_total{instance="a:9090", code="200"}[1m]', instant)
		expect(result.resultType).toBe("matrix")
		// 15s scrape: (t-60s, t] holds four samples.
		expect(flatten(result)).toHaveLength(4)
	})

	it("rejects a range vector in a range query", () => {
		const result = runQuery("x[5m]", { startMs: 0, endMs: 60_000, stepMs: 15_000 }, bucketed)
		expect(Result.isFailure(result)).toBe(true)
	})

	it("enforces the point limit", () => {
		const result = runQuery(
			"http_requests_total",
			{ startMs: DATA_START_MS, endMs: DATA_END_MS, stepMs: 15_000 },
			bucketed,
			{
				maxSeries: 100,
				maxPoints: 1000,
			},
		)
		expect(Result.isFailure(result) && result.failure.message).toMatch(/too many samples/)
	})
})
