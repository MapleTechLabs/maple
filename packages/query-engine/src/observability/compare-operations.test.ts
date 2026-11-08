import { describe, expect, it } from "vitest"
import { Array as Arr, Record as Rec } from "effect"
import { diffOperations, type OperationWindowRow } from "./compare-operations"

const op = (spanName: string, spanCount: number, errorCount = 0, p95DurationMs = 40): OperationWindowRow => ({
	spanName,
	spanCount,
	estimatedSpanCount: spanCount,
	errorCount,
	estimatedErrorCount: errorCount,
	p95DurationMs,
})

const baseline = [op("GET /cart", 5000, 5), op("POST /checkout", 1000, 2, 120), op("SELECT carts", 8000)]
const flagsOf = (ops: ReturnType<typeof diffOperations>["operations"]) =>
	Rec.fromEntries(Arr.map(ops, (o) => [o.operation, o.flags]))

describe("diffOperations", () => {
	it("flags nothing when every operation keeps its share, error rate and p95", () => {
		const tripled = Arr.map(baseline, (r) =>
			op(r.spanName, r.spanCount * 3, r.errorCount * 3, r.p95DurationMs),
		)
		const diff = diffOperations(baseline, tripled)
		expect(diff.operations).toEqual([])
		expect(diff.unchanged).toBe(3)
	})

	it("flags a failing new operation, a slower one and a gone one, worst first", () => {
		const after = [
			op("GET /cart", 5000, 5),
			op("POST /checkout", 1000, 2, 400),
			op("SELECT carts", 8000),
			op("POST /payments/retry", 300, 120),
		]
		const before = [...baseline, op("GET /legacy-cart", 400)]
		const diff = diffOperations(before, after)
		expect(flagsOf(diff.operations)).toEqual({
			"POST /payments/retry": ["new", "errors_up"],
			"POST /checkout": ["slower"],
			"GET /legacy-cart": ["gone"],
		})
		expect(Arr.map(diff.operations, (o) => o.operation)).toEqual([
			"POST /payments/retry",
			"POST /checkout",
			"GET /legacy-cart",
		])
		const retry = diff.operations[0]
		expect(retry?.after.errorRate).toBe(0.4)
		expect(retry?.before.spans).toBe(0)
	})

	it("flags an error rate that rose on an existing operation", () => {
		const after = [
			op("GET /cart", 5000, 250),
			op("POST /checkout", 1000, 2, 120),
			op("SELECT carts", 8000),
		]
		expect(flagsOf(diffOperations(baseline, after).operations)).toEqual({ "GET /cart": ["errors_up"] })
	})

	it("ignores an error wobble too small to be more than noise", () => {
		const after = [op("GET /cart", 5000, 9), op("POST /checkout", 1000, 2, 120), op("SELECT carts", 8000)]
		expect(diffOperations(baseline, after).operations).toEqual([])
	})

	it("does not call an operation new or gone when the other window was cut at the cap", () => {
		const before = [op("a", 100), op("b", 100)]
		const after = [op("a", 100), op("b", 100), op("c", 100)]
		const capped = diffOperations(before, after, { perWindowCap: 2 })
		expect(capped.operations).toEqual([])
		expect(flagsOf(diffOperations(before, after).operations)).toEqual({ c: ["new"] })
	})

	it("ignores latency moves on operations with too few spans to trust a p95", () => {
		const before = [...baseline, op("GET /rare", 10, 0, 10)]
		const after = [...baseline, op("GET /rare", 10, 0, 900)]
		expect(diffOperations(before, after).operations).toEqual([])
	})

	it("reads a sampler change as no change: ratios and rates use weighted counts", () => {
		// After the deploy GET /cart keeps only 1 in 10 spans, each weighted 10; errors are all kept.
		const resampled = [
			{ ...op("GET /cart", 500, 5), estimatedSpanCount: 5000, estimatedErrorCount: 5 },
			op("POST /checkout", 1000, 2, 120),
			op("SELECT carts", 8000),
		]
		const diff = diffOperations(baseline, resampled)
		expect(Arr.flatMap(diff.operations, (o) => o.flags)).not.toContain("volume_down")
		expect(Arr.flatMap(diff.operations, (o) => o.flags)).not.toContain("errors_up")
	})

	it("does not call a failing operation's errors new when the baseline was cut at the cap", () => {
		const before = [op("a", 100), op("b", 100)]
		const after = [op("a", 100), op("b", 100), op("c", 100, 50)]
		expect(diffOperations(before, after, { perWindowCap: 2 }).operations).toEqual([])
	})

	it("compares nothing when either window has no spans", () => {
		expect(diffOperations([], baseline).operations).toEqual([])
	})
})
