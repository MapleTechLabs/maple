// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
// BOUNDARY: Test doubles preserve opaque values so the consuming boundary can be exercised.
import { describe, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { TracesListQuery } from "@maple/domain/query-engine"
import { strict as assert } from "node:assert"
import { beforeEach, vi } from "vitest"
import { mockedWarehouse } from "./testing"

const executeQueryEngineMock = vi.fn()
const listTracesMock = vi.fn()

vi.mock("./effect-utils", () => ({
	WarehouseDateTimeString: Schema.String,
	decodeInput: (_schema: unknown, data: unknown) => Effect.succeed(data),
	invalidWarehouseInput: () => Effect.fail("invalid"),
	extractFacets: () => [],
	executeQueryEngine: (...args: unknown[]) => executeQueryEngineMock(...args),
	runWarehouseQuery: (_operation: string, execute: () => unknown) => execute(),
}))

vi.mock("./traces", () => ({
	listTraces: (...args: unknown[]) => listTracesMock(...args),
}))

import { getUptimeCheckStats } from "./uptime"

const decodeListQuery = Schema.decodeUnknownOption(TracesListQuery)

// The window starts mid-bucket, so the chart drops the 00:00 bucket; the totals must not.
const START = "2026-02-01 00:07:00"
const END = "2026-02-01 01:00:00"

const bucket = (time: string, count: number, errorRate: number) => ({
	bucket: time,
	series: { count, error_rate: errorRate, p50_duration: 100, p95_duration: 200, p99_duration: 300 },
})

const breakdown = (value: number) =>
	Effect.succeed({ result: { kind: "breakdown", data: [{ name: "maple-uptime", value }] } })

const traceRow = (startTime: string, durationMs: number, hasError: boolean, statusCode: number | null) => ({
	traceId: `${startTime}-trace`,
	startTime,
	durationMs,
	hasError,
	rootSpan: { http: statusCode === null ? null : { statusCode } },
})

const page = (rows: ReadonlyArray<unknown>, scannedCount: number) =>
	Effect.succeed({ data: rows, meta: { limit: 1000, offset: 0, scannedCount, hiddenCount: 0 } })

const answer = (series: ReadonlyArray<unknown>) =>
	executeQueryEngineMock.mockImplementation((operation: string) => {
		if (operation.endsWith(".series"))
			return Effect.succeed({ result: { kind: "timeseries", data: series } })
		if (operation.endsWith(".p50_duration")) return breakdown(110)
		if (operation.endsWith(".p95_duration")) return breakdown(240)
		return breakdown(900)
	})

describe("getUptimeCheckStats", () => {
	beforeEach(() => {
		executeQueryEngineMock.mockReset()
		listTracesMock.mockReset()
	})

	it.effect("counts every check in the window, failures included, even in the partial first bucket", () =>
		Effect.gen(function* () {
			answer([bucket("2026-02-01 00:00:00", 4, 0.25), bucket("2026-02-01 00:15:00", 6, 0)])
			listTracesMock.mockReturnValue(page([], 0))
			const stats = yield* getUptimeCheckStats({ monitorId: "mon_1", startTime: START, endTime: END })
			assert.deepStrictEqual(
				{
					checks: stats.checks,
					failures: stats.failures,
					p50: stats.p50Ms,
					p95: stats.p95Ms,
					p99: stats.p99Ms,
				},
				{ checks: 10, failures: 1, p50: 110, p95: 240, p99: 900 },
			)
		}).pipe(mockedWarehouse),
	)

	it.effect("reports no percentiles for a window without checks", () =>
		Effect.gen(function* () {
			answer([])
			listTracesMock.mockReturnValue(page([], 0))
			const stats = yield* getUptimeCheckStats({ monitorId: "mon_1", startTime: START, endTime: END })
			assert.deepStrictEqual(
				[stats.checks, stats.p50Ms, stats.p95Ms, stats.p99Ms],
				[0, null, null, null],
			)
		}).pipe(mockedWarehouse),
	)

	it.effect("asks the traces list only for pages it accepts", () =>
		Effect.gen(function* () {
			answer([])
			const asked: Array<{ limit: number; offset: number }> = []
			listTracesMock.mockImplementation(({ data }: { data: { limit: number; offset: number } }) => {
				asked.push({ limit: data.limit, offset: data.offset })
				return page([], 0)
			})
			yield* getUptimeCheckStats({ monitorId: "mon_1", startTime: START, endTime: END })
			const accepted = asked.map(({ limit, offset }) =>
				Option.isSome(decodeListQuery({ kind: "list", source: "traces", limit, offset })),
			)
			assert.ok(asked.length > 0)
			assert.deepStrictEqual(
				accepted,
				asked.map(() => true),
			)
		}).pipe(mockedWarehouse),
	)

	it.effect("lists the checks oldest first with their status, and says when the list is cut short", () =>
		Effect.gen(function* () {
			answer([bucket("2026-02-01 00:15:00", 2, 0.5)])
			listTracesMock.mockImplementation(({ data }: { data: { offset: number } }) =>
				data.offset === 0
					? page(
							[
								traceRow("2026-02-01 00:20:00", 120, false, 200),
								traceRow("2026-02-01 00:19:00", 10_000, true, null),
							],
							1000,
						)
					: page([], 1000),
			)
			const stats = yield* getUptimeCheckStats({ monitorId: "mon_1", startTime: START, endTime: END })
			assert.deepStrictEqual(
				stats.samples.map((sample) => [sample.at, sample.ok, sample.statusCode, sample.durationMs]),
				[
					["2026-02-01T00:19:00.000Z", false, null, 10_000],
					["2026-02-01T00:20:00.000Z", true, 200, 120],
				],
			)
			assert.strictEqual(stats.samplesTruncated, true)
		}).pipe(mockedWarehouse),
	)
})
