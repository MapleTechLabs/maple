// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
// BOUNDARY: Test doubles preserve opaque values so the consuming boundary can be exercised.
import { describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { MapleInternalApi } from "@maple/domain/http"
import { UptimeMonitorId } from "@maple/domain"
import { strict as assert } from "node:assert"
import { beforeEach, vi } from "vitest"
import { MapleInternalHttp, WarehouseExecutor } from "./warehouse-services"

const executeQueryEngineMock = vi.fn()

vi.mock("./effect-utils", () => ({
	WarehouseDateTimeString: Schema.String,
	decodeInput: (_schema: unknown, data: unknown) => Effect.succeed(data),
	invalidWarehouseInput: () => Effect.fail("invalid"),
	extractFacets: () => [],
	executeQueryEngine: (...args: unknown[]) => executeQueryEngineMock(...args),
	runWarehouseQuery: (_operation: string, execute: () => unknown) => execute(),
}))

import { getUptimeCheckStats, UPTIME_CHECK_LIST_LIMIT } from "./uptime"

const MONITOR = Schema.decodeSync(UptimeMonitorId)("0199a009-0000-7000-8000-000000000001")

// The window starts mid-bucket, so the chart drops the 00:00 bucket; the totals must not.
const START = "2026-02-01 00:07:00"
const END = "2026-02-01 01:00:00"

const bucket = (time: string, count: number, errorRate: number) => ({
	bucket: time,
	series: { count, error_rate: errorRate, p50_duration: 100, p95_duration: 200, p99_duration: 300 },
})

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"

const check = (at: string, durationMs: number, ok: boolean, phases: Record<string, number> | null) => ({
	at,
	traceId: TRACE,
	durationMs,
	ok,
	statusCode: ok ? 200 : null,
	phases,
})

/** The internal API, answering `/uptime-checks` and `/uptime-phase-timings` by path; anything else fails. */
const withApi = (answers: Readonly<Record<string, () => Response>>) => {
	const fetch: typeof globalThis.fetch = async (input) => {
		const path = new URL(String(input), "http://api.test").pathname
		const answer = Object.entries(answers).find(([suffix]) => path.endsWith(suffix))?.[1]
		return answer === undefined ? Promise.reject(new Error(`unmocked ${path}`)) : answer()
	}
	return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(
			Effect.provide(
				Layer.mergeAll(
					Layer.mock(WarehouseExecutor, {}),
					Layer.effect(
						MapleInternalHttp,
						HttpApiClient.make(MapleInternalApi, { baseUrl: "http://api.test" }),
					).pipe(
						Layer.provide(FetchHttpClient.layer),
						Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
					),
				),
			),
		)
}

const json = (body: unknown) => () => Response.json(body)
const NO_CHECKS = { "/uptime-checks": json({ checks: [] }) }

const breakdown = (value: number) =>
	Effect.succeed({ result: { kind: "breakdown", data: [{ name: "maple-uptime", value }] } })

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
	})

	it.effect("counts every check in the window, failures included, even in the partial first bucket", () =>
		Effect.gen(function* () {
			answer([bucket("2026-02-01 00:00:00", 4, 0.25), bucket("2026-02-01 00:15:00", 6, 0)])
			const stats = yield* getUptimeCheckStats({ monitorId: MONITOR, startTime: START, endTime: END })
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
		}).pipe(withApi(NO_CHECKS)),
	)

	it.effect("reports no percentiles for a window without checks", () =>
		Effect.gen(function* () {
			answer([])
			const stats = yield* getUptimeCheckStats({ monitorId: MONITOR, startTime: START, endTime: END })
			assert.deepStrictEqual(
				[stats.checks, stats.p50Ms, stats.p95Ms, stats.p99Ms],
				[0, null, null, null],
			)
		}).pipe(withApi(NO_CHECKS)),
	)

	it.effect("a failed phase read flags the breakdown and keeps the rest of the stats", () =>
		Effect.gen(function* () {
			answer([bucket("2026-02-01 00:15:00", 4, 0)])
			// The stub answers the check list only, so the phase read fails.
			const stats = yield* getUptimeCheckStats({
				monitorId: MONITOR,
				startTime: START,
				endTime: END,
				withPhases: true,
			})
			assert.deepStrictEqual(
				{ checks: stats.checks, phases: stats.phases, phasesFailed: stats.phasesFailed },
				{ checks: 4, phases: [], phasesFailed: true },
			)
		}).pipe(withApi(NO_CHECKS)),
	)

	it.effect("lists the checks oldest first with their outcome and phases", () =>
		Effect.gen(function* () {
			answer([bucket("2026-02-01 00:15:00", 2, 0.5)])
			const phases = { dnsMs: 1, connectMs: 9, tlsMs: 16, ttfbMs: 40, transferMs: 0 }
			const stats = yield* getUptimeCheckStats({
				monitorId: MONITOR,
				startTime: START,
				endTime: END,
			}).pipe(
				withApi({
					"/uptime-checks": json({
						checks: [
							check("2026-02-01T00:20:00.000Z", 66, true, phases),
							check("2026-02-01T00:19:00.000Z", 10_000, false, null),
						],
					}),
				}),
			)
			assert.deepStrictEqual(
				stats.samples.map((sample) => [sample.at, sample.ok, sample.statusCode, sample.phases]),
				[
					["2026-02-01T00:19:00.000Z", false, null, null],
					["2026-02-01T00:20:00.000Z", true, 200, phases],
				],
			)
			assert.deepStrictEqual([stats.samplesTruncated, stats.samplesFailed], [false, false])
		}),
	)

	it.effect("says when the window held more checks than the list keeps", () =>
		Effect.gen(function* () {
			answer([])
			const full = Array.from({ length: UPTIME_CHECK_LIST_LIMIT }, () =>
				check("2026-02-01T00:20:00.000Z", 66, true, null),
			)
			const stats = yield* getUptimeCheckStats({
				monitorId: MONITOR,
				startTime: START,
				endTime: END,
			}).pipe(withApi({ "/uptime-checks": json({ checks: full }) }))
			assert.strictEqual(stats.samplesTruncated, true)
		}),
	)

	it.effect("a failed check list flags the chart and keeps the rest of the stats", () =>
		Effect.gen(function* () {
			answer([bucket("2026-02-01 00:15:00", 4, 0)])
			const stats = yield* getUptimeCheckStats({
				monitorId: MONITOR,
				startTime: START,
				endTime: END,
			}).pipe(withApi({ "/uptime-checks": () => new Response("down", { status: 503 }) }))
			assert.deepStrictEqual(
				{ checks: stats.checks, samples: stats.samples, samplesFailed: stats.samplesFailed },
				{ checks: 4, samples: [], samplesFailed: true },
			)
		}),
	)
})
