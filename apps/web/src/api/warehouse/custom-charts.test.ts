import { describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { strict as assert } from "node:assert"
import { beforeEach, expect, vi } from "vitest"

const executeQueryEngineMock = vi.fn()
const listMetricsMock = vi.fn()

vi.mock("@/api/warehouse/effect-utils", () => ({
	WarehouseDateTimeString: Schema.String,
	decodeInput: (_schema: unknown, data: unknown) => Effect.succeed(data),
	invalidWarehouseInput: () => Effect.fail(new Error("invalid")),
	executeQueryEngine: (...args: unknown[]) => executeQueryEngineMock(...args),
}))

vi.mock("@/api/warehouse/metrics", () => ({
	listMetrics: (...args: unknown[]) => listMetricsMock(...args),
}))

import { fillServiceDetailPoints, getCustomChartServiceDetail } from "@/api/warehouse/custom-charts"
import { setActiveOrgId } from "@/lib/services/common/auth-headers"

describe("querySpanMetricsCalls", () => {
	beforeEach(() => {
		executeQueryEngineMock.mockReset()
		listMetricsMock.mockReset()
		listMetricsMock.mockReturnValue(
			Effect.succeed({
				data: [{ metricName: "span.metrics.calls", metricType: "sum" }],
			}),
		)
		executeQueryEngineMock.mockImplementation(() =>
			Effect.succeed({ result: { kind: "timeseries", data: [] } }),
		)
		setActiveOrgId(null)
	})

	it.effect("queries the monotonic SpanMetrics `calls` counter as a per-bucket increase, not raw sum", () =>
		Effect.gen(function* () {
			yield* getCustomChartServiceDetail({
				data: {
					serviceName: "monotonic-service",
					startTime: "2026-02-01 00:00:00",
					endTime: "2026-02-01 01:00:00",
				},
			})

			const spanMetricsCalls = executeQueryEngineMock.mock.calls.filter(
				(call) => call[0] === "queryEngine.spanMetricsCalls",
			)

			expect(spanMetricsCalls.length).toBeGreaterThan(0)
			for (const [, request] of spanMetricsCalls) {
				assert.strictEqual(request.query.metric, "increase")
			}
		}),
	)

	it.effect("skips SpanMetrics timeseries when the catalog has no calls metric", () =>
		Effect.gen(function* () {
			listMetricsMock.mockReturnValue(Effect.succeed({ data: [] }))

			yield* getCustomChartServiceDetail({
				data: {
					serviceName: "absent-service",
					startTime: "2026-02-01 00:00:00",
					endTime: "2026-02-01 01:00:00",
				},
			})

			const spanMetricsCalls = executeQueryEngineMock.mock.calls.filter(
				(call) => call[0] === "queryEngine.spanMetricsCalls",
			)

			assert.strictEqual(spanMetricsCalls.length, 0)
		}),
	)

	it.effect("prefers the canonical SpanMetrics metric name when both catalog entries exist", () =>
		Effect.gen(function* () {
			listMetricsMock.mockReturnValue(
				Effect.succeed({
					data: [
						{ metricName: "calls", metricType: "sum" },
						{ metricName: "span.metrics.calls", metricType: "sum" },
					],
				}),
			)

			yield* getCustomChartServiceDetail({
				data: {
					serviceName: "canonical-service",
					startTime: "2026-02-01 00:00:00",
					endTime: "2026-02-01 01:00:00",
				},
			})

			const spanMetricsCalls = executeQueryEngineMock.mock.calls.filter(
				(call) => call[0] === "queryEngine.spanMetricsCalls",
			)

			assert.strictEqual(spanMetricsCalls.length, 1)
			assert.strictEqual(
				spanMetricsCalls[0][1].query.filters.metricName,
				"span.metrics.calls",
			)
		}),
	)

	it.effect("uses legacy `calls` only when the canonical metric is absent", () =>
		Effect.gen(function* () {
			listMetricsMock.mockReturnValue(
				Effect.succeed({
					data: [{ metricName: "calls", metricType: "sum" }],
				}),
			)

			yield* getCustomChartServiceDetail({
				data: {
					serviceName: "legacy-service",
					startTime: "2026-02-01 00:00:00",
					endTime: "2026-02-01 01:00:00",
				},
			})

			const spanMetricsCalls = executeQueryEngineMock.mock.calls.filter(
				(call) => call[0] === "queryEngine.spanMetricsCalls",
			)

			assert.strictEqual(spanMetricsCalls.length, 1)
			assert.strictEqual(spanMetricsCalls[0][1].query.filters.metricName, "calls")
		}),
	)

	it.effect("does not reuse another org's cached SpanMetrics availability", () =>
		Effect.gen(function* () {
			// Org A: catalog has the calls metric → resolves and caches under A's key.
			setActiveOrgId("org-bleed-a")
			listMetricsMock.mockReturnValue(
				Effect.succeed({ data: [{ metricName: "span.metrics.calls", metricType: "sum" }] }),
			)
			yield* getCustomChartServiceDetail({
				data: {
					serviceName: "bleed-service",
					startTime: "2026-02-01 00:00:00",
					endTime: "2026-02-01 01:00:00",
				},
			})
			assert.strictEqual(
				executeQueryEngineMock.mock.calls.filter((c) => c[0] === "queryEngine.spanMetricsCalls")
					.length,
				1,
			)

			// Org B: same service, but its catalog has no calls metric. A shared cache
			// would reuse A's "span.metrics.calls" and run the query; org-keyed, B
			// re-resolves to null and skips the SpanMetrics query entirely.
			executeQueryEngineMock.mockClear()
			listMetricsMock.mockReturnValue(Effect.succeed({ data: [] }))
			setActiveOrgId("org-bleed-b")
			yield* getCustomChartServiceDetail({
				data: {
					serviceName: "bleed-service",
					startTime: "2026-02-01 00:00:00",
					endTime: "2026-02-01 01:00:00",
				},
			})

			const spanMetricsCalls = executeQueryEngineMock.mock.calls.filter(
				(c) => c[0] === "queryEngine.spanMetricsCalls",
			)
			assert.strictEqual(spanMetricsCalls.length, 0)
		}),
	)
})

describe("fillServiceDetailPoints", () => {
	it("builds a contiguous, evenly-spaced timeline and flags the in-progress tail", () => {
		const start = "2026-02-01 00:00:00"
		const end = "2026-02-01 01:00:00"
		const nowMs = Date.parse("2026-02-01T01:00:00Z")

		const result = fillServiceDetailPoints([], start, end, 120, nowMs)

		// Non-empty, evenly spaced 120s buckets (no empty/flat fallthrough).
		expect(result.length).toBeGreaterThan(1)
		const deltas = result.slice(1).map((p, i) => Date.parse(p.bucket) - Date.parse(result[i].bucket))
		expect([...new Set(deltas)]).toEqual([120_000])

		// The final bucket ends at ~now → still settling → flagged; an early bucket isn't.
		expect(result[result.length - 1].partial).toBe(true)
		expect(result[0].partial).toBe(false)
	})

	it("flags nothing partial for a historical window ending well before now", () => {
		const start = "2026-02-01 00:00:00"
		const end = "2026-02-01 01:00:00"
		const nowMs = Date.parse("2026-02-02T00:00:00Z") // a full day after the window

		const result = fillServiceDetailPoints([], start, end, 120, nowMs)

		expect(result.length).toBeGreaterThan(1)
		expect(result.every((p) => p.partial === false)).toBe(true)
	})
})
