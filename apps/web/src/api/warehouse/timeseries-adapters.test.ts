import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { beforeEach, expect, vi } from "vitest"

const executeQueryEngineMock = vi.fn()
const runWarehouseQueryMock = vi.fn()

vi.mock("@/api/warehouse/effect-utils", () => ({
	WarehouseDateTimeString: Schema.String,
	WarehouseQueryError: class extends Error {
		_tag = "WarehouseQueryError"
	},
	decodeInput: (_schema: unknown, data: unknown) => Effect.succeed(data),
	invalidWarehouseInput: () => Effect.fail(new Error("invalid")),
	executeQueryEngine: (...args: unknown[]) => executeQueryEngineMock(...args),
	runWarehouseQuery: (...args: unknown[]) => runWarehouseQueryMock(...args),
}))

import {
	getCustomChartServiceDetail,
	getCustomChartServiceSparklines,
	getOverviewTimeSeries,
} from "@/api/warehouse/custom-charts"
import { getServiceApdexTimeSeries } from "@/api/warehouse/services"

function tsResponse(data: Array<{ bucket: string; series: Record<string, number> }>) {
	return Effect.succeed({ result: { kind: "timeseries", source: "traces", data } })
}

const emptyTs = () => tsResponse([])

describe("timeseries adapters", () => {
	beforeEach(() => {
		executeQueryEngineMock.mockReset()
		runWarehouseQueryMock.mockReset()
	})

	it.effect("fills overview/detail buckets without flattening existing points", () =>
		Effect.gen(function* () {
			const bucket = "2026-01-01T00:00:00.000Z"

			executeQueryEngineMock.mockImplementation((operation: string) => {
				if (operation.includes("spanMetricsCalls")) return emptyTs()
				if (operation.includes("allMetrics")) {
					return tsResponse([
						{
							bucket,
							series: {
								count: 10,
								error_rate: 2,
								p50_duration: 11,
								p95_duration: 20,
								p99_duration: 30,
							},
						},
					])
				}
				return emptyTs()
			})

			const overview = yield* getOverviewTimeSeries({
				data: {
					startTime: "2026-01-01 00:00:00",
					endTime: "2026-01-01 00:25:00",
				},
			})
			const detail = yield* getCustomChartServiceDetail({
				data: {
					serviceName: "checkout",
					startTime: "2026-01-01 00:00:00",
					endTime: "2026-01-01 00:25:00",
				},
			})

			assert.strictEqual(overview.data.length, 6)
			assert.strictEqual(detail.data.length, 6)
			expect(overview.data[0]).toMatchObject({
				bucket: "2026-01-01T00:00:00.000Z",
				throughput: 10,
				errorRate: 2,
			})
			expect(overview.data[1]).toMatchObject({
				bucket: "2026-01-01T00:05:00.000Z",
				throughput: 0,
				errorRate: 0,
			})
			expect(detail.data[0]).toMatchObject({
				bucket: "2026-01-01T00:00:00.000Z",
				throughput: 10,
				p95LatencyMs: 20,
			})
		}),
	)

	it.effect("fills service sparklines per service across the selected timeline", () =>
		Effect.gen(function* () {
			executeQueryEngineMock.mockImplementation((operation: string) => {
				if (operation.includes("spanMetricsCalls")) return emptyTs()
				if (operation.includes("count")) {
					return tsResponse([
						{ bucket: "2026-01-01T00:00:00.000Z", series: { checkout: 3 } },
						{ bucket: "2026-01-01T00:10:00.000Z", series: { checkout: 5 } },
					])
				}
				if (operation.includes("error")) {
					return tsResponse([
						{ bucket: "2026-01-01T00:00:00.000Z", series: { checkout: 1 } },
						{ bucket: "2026-01-01T00:10:00.000Z", series: { checkout: 0 } },
					])
				}
				return emptyTs()
			})

			const response = yield* getCustomChartServiceSparklines({
				data: {
					startTime: "2026-01-01 00:00:00",
					endTime: "2026-01-01 00:10:00",
				},
			})

			assert.strictEqual(response.data.checkout.length, 3)
			expect(response.data.checkout[0]).toMatchObject({
				bucket: "2026-01-01T00:00:00.000Z",
				throughput: 3,
				errorRate: 1,
			})
			expect(response.data.checkout[1]).toMatchObject({
				bucket: "2026-01-01T00:05:00.000Z",
				throughput: 0,
				errorRate: 0,
			})
			expect(response.data.checkout[2]).toMatchObject({
				bucket: "2026-01-01T00:10:00.000Z",
				throughput: 5,
				errorRate: 0,
			})
		}),
	)

	it.effect("fills service apdex buckets while preserving real values", () =>
		Effect.gen(function* () {
			runWarehouseQueryMock.mockReturnValue(
				Effect.succeed({
					data: [
						{
							bucket: "2026-01-01 00:00:00",
							apdexScore: 0.91,
							totalCount: 100,
						},
					],
				}),
			)

			const response = yield* getServiceApdexTimeSeries({
				data: {
					serviceName: "checkout",
					startTime: "2026-01-01 00:00:00",
					endTime: "2026-01-01 00:25:00",
				},
			})

			assert.strictEqual(response.data.length, 6)
			expect(response.data[0]).toMatchObject({
				bucket: "2026-01-01T00:00:00.000Z",
				apdexScore: 0.91,
				totalCount: 100,
			})
			expect(response.data[5]).toMatchObject({
				bucket: "2026-01-01T00:25:00.000Z",
				apdexScore: 0,
				totalCount: 0,
			})
		}),
	)
})
