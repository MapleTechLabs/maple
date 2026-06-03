import { describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { strict as assert } from "node:assert"
import { beforeEach, vi } from "vitest"

const executeQueryEngineMock = vi.fn()
const listMetricsMock = vi.fn()
const runWarehouseQueryMock = vi.fn()

vi.mock("@/api/warehouse/effect-utils", () => ({
	WarehouseDateTimeString: Schema.String,
	decodeInput: (_schema: unknown, data: unknown) => Effect.succeed(data),
	invalidWarehouseInput: () => Effect.fail(new Error("invalid")),
	extractFacets: () => [],
	executeQueryEngine: (...args: unknown[]) => executeQueryEngineMock(...args),
	runWarehouseQuery: (_operation: string, execute: () => unknown) =>
		runWarehouseQueryMock(_operation, execute),
}))

vi.mock("@/api/warehouse/metrics", () => ({
	listMetrics: (...args: unknown[]) => listMetricsMock(...args),
}))

import { getServiceOverview } from "@/api/warehouse/services"
import { setActiveOrgId } from "@/lib/services/common/auth-headers"

// One hour window → durationSeconds = 3600.
const START = "2026-02-01 00:00:00"
const END = "2026-02-01 01:00:00"

// Raw service-overview row: 100 traced/entry spans, no per-span sampling weight
// (estimatedSpanCount == spanCount), so sum(SampleRate) alone yields no estimate.
const overviewRow = {
	serviceName: "frontend",
	environment: "production",
	commitSha: "abc1234",
	throughput: 100,
	errorCount: 0,
	spanCount: 100,
	p50LatencyMs: 1,
	p95LatencyMs: 2,
	p99LatencyMs: 3,
	estimatedSpanCount: 100,
}

describe("getServiceOverview throughput resolution", () => {
	beforeEach(() => {
		executeQueryEngineMock.mockReset()
		listMetricsMock.mockReset()
		runWarehouseQueryMock.mockReset()
		runWarehouseQueryMock.mockReturnValue(Effect.succeed({ data: [overviewRow] }))
	})

	it.effect(
		"extrapolates list throughput from the SpanMetrics `calls` counter when it exceeds the traced count",
		() =>
			Effect.gen(function* () {
				// Distinct org → fresh SpanMetrics-availability cache entry.
				setActiveOrgId("overview-metrics-present")
				listMetricsMock.mockReturnValue(
					Effect.succeed({ data: [{ metricName: "span.metrics.calls", metricType: "sum" }] }),
				)
				// SpanMetrics connector saw 1000 calls (pre-sampling) for `frontend`.
				executeQueryEngineMock.mockImplementation(() =>
					Effect.succeed({
						result: {
							kind: "timeseries",
							data: [{ bucket: START, series: { frontend: 1000 } }],
						},
					}),
				)

				const { data } = yield* getServiceOverview({
					data: { startTime: START, endTime: END },
				})

				assert.strictEqual(data.length, 1)
				const svc = data[0]
				assert.strictEqual(svc.hasSampling, true)
				// throughput = metrics calls / durationSeconds = 1000 / 3600
				assert.ok(Math.abs(svc.throughput - 1000 / 3600) < 1e-9, `throughput=${svc.throughput}`)
				// traced = raw spans / durationSeconds = 100 / 3600
				assert.ok(
					Math.abs(svc.tracedThroughput - 100 / 3600) < 1e-9,
					`traced=${svc.tracedThroughput}`,
				)
				// weight = metrics / raw = 10x
				assert.ok(Math.abs(svc.samplingWeight - 10) < 1e-9, `weight=${svc.samplingWeight}`)
			}),
	)

	it.effect("falls back to the traced count when no SpanMetrics `calls` data exists", () =>
		Effect.gen(function* () {
			// Distinct org → availability resolves to null (no calls metric in catalog).
			setActiveOrgId("overview-no-metrics")
			listMetricsMock.mockReturnValue(Effect.succeed({ data: [] }))
			executeQueryEngineMock.mockImplementation(() =>
				Effect.succeed({ result: { kind: "timeseries", data: [] } }),
			)

			const { data } = yield* getServiceOverview({
				data: { startTime: START, endTime: END },
			})

			assert.strictEqual(data.length, 1)
			const svc = data[0]
			assert.strictEqual(svc.hasSampling, false)
			assert.ok(Math.abs(svc.throughput - 100 / 3600) < 1e-9, `throughput=${svc.throughput}`)
			assert.ok(Math.abs(svc.samplingWeight - 1) < 1e-9, `weight=${svc.samplingWeight}`)

			// SpanMetrics timeseries must be skipped entirely when the catalog has no
			// calls metric (no wasted query).
			const spanMetricsCalls = executeQueryEngineMock.mock.calls.filter(
				(call) => call[0] === "queryEngine.spanMetricsCalls",
			)
			assert.strictEqual(spanMetricsCalls.length, 0)
		}),
	)
})
