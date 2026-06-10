import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Layer, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import {
	InternalScrapeTarget,
	type ScrapeResultReport,
} from "@maple/domain/http"
import { ApiClient, ApiRequestError, type ApiClientShape, type ScrapeProxyResponse } from "./ApiClient"
import { ScrapeScheduler } from "./ScrapeScheduler"
import { ScraperEnv, type ScraperEnvShape } from "./Env"
import { TinybirdIngest, TinybirdIngestError, type TinybirdIngestShape } from "./TinybirdIngest"

const decodeTarget = Schema.decodeUnknownSync(InternalScrapeTarget)

const mkTarget = (
	id: string,
	intervalSeconds: number,
	overrides: Partial<{ name: string; serviceName: string | null; url: string; labels: Record<string, string> }> = {},
): InternalScrapeTarget =>
	decodeTarget({
		id,
		orgId: "org_test",
		name: overrides.name ?? `target-${id.slice(0, 4)}`,
		serviceName: overrides.serviceName ?? null,
		url: overrides.url ?? "https://example.com/metrics",
		scrapeIntervalSeconds: intervalSeconds,
		labels: overrides.labels ?? {},
	})

const TARGET_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const TARGET_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

const GAUGE_BODY = "# TYPE up gauge\nup 1\n"

const testEnv: ScraperEnvShape = {
	MAPLE_API_URL: "http://api.test",
	SD_INTERNAL_TOKEN: Redacted.make("token"),
	TINYBIRD_HOST: "http://tb.test",
	TINYBIRD_TOKEN: Redacted.make("tb-token"),
	SCRAPER_CONCURRENCY: 10,
	SCRAPER_RECONCILE_INTERVAL_SECONDS: 60,
	PORT: 0,
}

interface Harness {
	/** Mutable target list returned by the stubbed listTargets. */
	targets: Array<InternalScrapeTarget>
	scrapeCalls: Array<string>
	ingestCalls: Array<{ datasource: string; rows: ReadonlyArray<Record<string, unknown>> }>
	reportedResults: Array<ScrapeResultReport>
	/** Per-target scrape behaviour override. */
	scrapeImpl: (targetId: string) => Effect.Effect<ScrapeProxyResponse, ApiRequestError>
	ingestImpl: (datasource: string, rows: ReadonlyArray<Record<string, unknown>>) => Effect.Effect<void, TinybirdIngestError>
}

const makeHarness = (targets: Array<InternalScrapeTarget>): Harness => {
	const harness: Harness = {
		targets,
		scrapeCalls: [],
		ingestCalls: [],
		reportedResults: [],
		scrapeImpl: () => Effect.succeed({ status: 200, body: GAUGE_BODY }),
		ingestImpl: () => Effect.void,
	}
	return harness
}

const harnessLayer = (harness: Harness, env: ScraperEnvShape = testEnv) => {
	const api: ApiClientShape = {
		listTargets: () => Effect.sync(() => [...harness.targets]),
		scrapeTarget: (targetId) =>
			Effect.suspend(() => {
				harness.scrapeCalls.push(targetId)
				return harness.scrapeImpl(targetId)
			}),
		reportResults: (results) =>
			Effect.sync(() => {
				harness.reportedResults.push(...results)
			}),
	}
	const tinybird: TinybirdIngestShape = {
		ingest: (datasource, rows) =>
			Effect.suspend(() => {
				if (rows.length > 0) harness.ingestCalls.push({ datasource, rows })
				return harness.ingestImpl(datasource, rows)
			}),
	}
	return ScrapeScheduler.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(ApiClient, api),
				Layer.succeed(TinybirdIngest, tinybird),
				Layer.succeed(ScraperEnv, env),
			),
		),
	)
}

const startScheduler = Effect.gen(function* () {
	const scheduler = yield* ScrapeScheduler
	yield* Effect.forkChild(scheduler.run)
	// Let the initial reconcile + first scrapes run.
	yield* TestClock.adjust(Duration.millis(0))
})

describe("ScrapeScheduler", () => {
	it.effect("scrapes each target at its configured interval", () =>
		Effect.gen(function* () {
			const harness = makeHarness([mkTarget(TARGET_A, 5), mkTarget(TARGET_B, 300)])
			yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))

			yield* TestClock.adjust(Duration.seconds(59))

			const aCalls = harness.scrapeCalls.filter((id) => id === TARGET_A).length
			const bCalls = harness.scrapeCalls.filter((id) => id === TARGET_B).length
			// 5s interval: scrape at t=0,5,...,55 → 12 within the first minute.
			expect(aCalls).toBe(12)
			// 300s interval: only the initial scrape.
			expect(bCalls).toBe(1)
		}),
	)

	it.effect("ingests converted rows and reports success results", () =>
		Effect.gen(function* () {
			const harness = makeHarness([mkTarget(TARGET_A, 60)])
			yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))

			// One scrape happened; flush loop fires at t=10s.
			yield* TestClock.adjust(Duration.seconds(10))

			expect(harness.ingestCalls).toHaveLength(1)
			expect(harness.ingestCalls[0]?.datasource).toBe("metrics_gauge")
			const row = harness.ingestCalls[0]?.rows[0] as { resource_attributes: Record<string, string> }
			expect(row.resource_attributes.maple_org_id).toBe("org_test")

			expect(harness.reportedResults).toHaveLength(1)
			expect(harness.reportedResults[0]?.targetId).toBe(TARGET_A)
			expect(harness.reportedResults[0]?.error).toBeNull()
		}),
	)

	it.effect("records a failure and ingests nothing when the target returns a non-2xx", () =>
		Effect.gen(function* () {
			const harness = makeHarness([mkTarget(TARGET_A, 60)])
			harness.scrapeImpl = () => Effect.succeed({ status: 503, body: "unavailable" })
			yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))

			yield* TestClock.adjust(Duration.seconds(10))

			expect(harness.ingestCalls).toEqual([])
			expect(harness.reportedResults).toHaveLength(1)
			expect(harness.reportedResults[0]?.error).toContain("HTTP 503")
		}),
	)

	it.effect("treats a Tinybird ingest failure as a scrape failure", () =>
		Effect.gen(function* () {
			const harness = makeHarness([mkTarget(TARGET_A, 60)])
			harness.ingestImpl = () =>
				Effect.fail(new TinybirdIngestError({ message: "Tinybird ingest returned HTTP 500", status: 500 }))
			yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))

			yield* TestClock.adjust(Duration.seconds(10))

			expect(harness.reportedResults).toHaveLength(1)
			expect(harness.reportedResults[0]?.error).toContain("Tinybird ingest")
		}),
	)

	it.effect("one failing target does not stop the others", () =>
		Effect.gen(function* () {
			const harness = makeHarness([mkTarget(TARGET_A, 10), mkTarget(TARGET_B, 10)])
			harness.scrapeImpl = (targetId) =>
				targetId === TARGET_A
					? Effect.fail(new ApiRequestError({ message: "boom", status: null }))
					: Effect.succeed({ status: 200, body: GAUGE_BODY })
			yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))

			yield* TestClock.adjust(Duration.seconds(30))

			const aCalls = harness.scrapeCalls.filter((id) => id === TARGET_A).length
			const bCalls = harness.scrapeCalls.filter((id) => id === TARGET_B).length
			// The failing target keeps being retried on its interval…
			expect(aCalls).toBeGreaterThanOrEqual(3)
			// …and the healthy target keeps scraping and ingesting.
			expect(bCalls).toBeGreaterThanOrEqual(3)
			expect(harness.ingestCalls.length).toBeGreaterThanOrEqual(3)

			const aResults = harness.reportedResults.filter((r) => r.targetId === TARGET_A)
			expect(aResults.length).toBeGreaterThan(0)
			expect(aResults[0]?.error).toContain("boom")
		}),
	)

	it.effect("reconcile starts new targets, stops removed ones, and restarts changed ones", () =>
		Effect.gen(function* () {
			const harness = makeHarness([mkTarget(TARGET_A, 10)])
			yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))

			yield* TestClock.adjust(Duration.seconds(30))
			const aCallsBefore = harness.scrapeCalls.filter((id) => id === TARGET_A).length
			expect(aCallsBefore).toBeGreaterThanOrEqual(3)

			// Swap A out for B before the next reconcile (every 60s).
			harness.targets = [mkTarget(TARGET_B, 10)]
			yield* TestClock.adjust(Duration.seconds(60))

			const aCallsAfterSwap = harness.scrapeCalls.filter((id) => id === TARGET_A).length
			yield* TestClock.adjust(Duration.seconds(30))

			expect(harness.scrapeCalls.filter((id) => id === TARGET_A).length).toBe(aCallsAfterSwap)
			expect(harness.scrapeCalls.filter((id) => id === TARGET_B).length).toBeGreaterThanOrEqual(3)

			// Change B's URL → fingerprint change → loop restarted with new config.
			harness.targets = [mkTarget(TARGET_B, 10, { url: "https://other.example.com/metrics" })]
			const bCallsBeforeRestart = harness.scrapeCalls.filter((id) => id === TARGET_B).length
			yield* TestClock.adjust(Duration.seconds(60))
			expect(harness.scrapeCalls.filter((id) => id === TARGET_B).length).toBeGreaterThan(bCallsBeforeRestart)
		}),
	)

	it.effect("a failed target-list refresh keeps current loops running", () =>
		Effect.gen(function* () {
			const harness = makeHarness([mkTarget(TARGET_A, 10)])
			let listCalls = 0
			const api: ApiClientShape = {
				// First call returns the target; every later refresh fails.
				listTargets: () =>
					Effect.suspend(() => {
						listCalls++
						return listCalls === 1
							? Effect.succeed([...harness.targets])
							: Effect.fail(new ApiRequestError({ message: "api down", status: null }))
					}),
				scrapeTarget: (targetId) =>
					Effect.suspend(() => {
						harness.scrapeCalls.push(targetId)
						return harness.scrapeImpl(targetId)
					}),
				reportResults: () => Effect.void,
			}
			const layer = ScrapeScheduler.layer.pipe(
				Layer.provide(
					Layer.mergeAll(
						Layer.succeed(ApiClient, api),
						Layer.succeed(TinybirdIngest, { ingest: () => Effect.void }),
						Layer.succeed(ScraperEnv, testEnv),
					),
				),
			)
			yield* startScheduler.pipe(Effect.provide(layer))

			yield* TestClock.adjust(Duration.seconds(10))
			const before = harness.scrapeCalls.length
			expect(before).toBeGreaterThanOrEqual(2)

			// Two failed reconciles later, the existing loop is still scraping.
			yield* TestClock.adjust(Duration.seconds(120))
			expect(listCalls).toBeGreaterThanOrEqual(3)
			expect(harness.scrapeCalls.length).toBeGreaterThan(before)
		}),
	)

	it.effect("buffers results and retries reporting when the API is unreachable", () =>
		Effect.gen(function* () {
			const harness = makeHarness([mkTarget(TARGET_A, 60)])
			let failReports = true
			const api: ApiClientShape = {
				listTargets: () => Effect.sync(() => [...harness.targets]),
				scrapeTarget: (targetId) =>
					Effect.suspend(() => {
						harness.scrapeCalls.push(targetId)
						return harness.scrapeImpl(targetId)
					}),
				reportResults: (results) =>
					Effect.suspend(() => {
						if (failReports) {
							return Effect.fail(new ApiRequestError({ message: "api down", status: null }))
						}
						harness.reportedResults.push(...results)
						return Effect.void
					}),
			}
			const layer = ScrapeScheduler.layer.pipe(
				Layer.provide(
					Layer.mergeAll(
						Layer.succeed(ApiClient, api),
						Layer.succeed(TinybirdIngest, { ingest: () => Effect.void }),
						Layer.succeed(ScraperEnv, testEnv),
					),
				),
			)
			yield* startScheduler.pipe(Effect.provide(layer))

			// First flush at t=10s fails; the result must be retried later.
			yield* TestClock.adjust(Duration.seconds(15))
			expect(harness.reportedResults).toEqual([])

			failReports = false
			yield* TestClock.adjust(Duration.seconds(10))
			expect(harness.reportedResults).toHaveLength(1)
			expect(harness.reportedResults[0]?.targetId).toBe(TARGET_A)
		}),
	)
})
