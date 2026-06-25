import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Layer, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { InternalScrapeTarget, type ScrapeResultReport } from "@maple/domain/http"
import { ApiClient, ApiRequestError, type ApiClientShape, type ScrapeProxyResponse } from "./ApiClient"
import { OtlpIngest, OtlpIngestError, type OtlpIngestShape } from "./OtlpIngest"
import { ScrapeScheduler } from "./ScrapeScheduler"
import { ScraperEnv, type ScraperEnvShape } from "./Env"
import type { OtlpExportRequest } from "./prometheus/otlp"

const decodeTarget = Schema.decodeUnknownSync(InternalScrapeTarget)

const mkTarget = (
	id: string,
	intervalSeconds: number,
	overrides: Partial<{
		name: string
		serviceName: string | null
		url: string
		labels: Record<string, string>
		ingestKey: string
		subTargetKey: string | null
	}> = {},
): InternalScrapeTarget =>
	decodeTarget({
		id,
		orgId: "org_test",
		name: overrides.name ?? `target-${id.slice(0, 4)}`,
		serviceName: overrides.serviceName ?? null,
		url: overrides.url ?? "https://example.com/metrics",
		subTargetKey: overrides.subTargetKey ?? null,
		scrapeIntervalSeconds: intervalSeconds,
		labels: overrides.labels ?? {},
		ingestKey: overrides.ingestKey ?? `maple_pk_${id.slice(0, 4)}`,
	})

const TARGET_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const TARGET_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

const GAUGE_BODY = "# TYPE up gauge\nup 1\n"

const testEnv: ScraperEnvShape = {
	MAPLE_API_URL: "http://api.test",
	SD_INTERNAL_TOKEN: Redacted.make("token"),
	MAPLE_INGEST_URL: "http://ingest.test",
	SCRAPER_CONCURRENCY: 10,
	SCRAPER_RECONCILE_INTERVAL_SECONDS: 60,
	PORT: 0,
}

interface Harness {
	/** Mutable target list returned by the stubbed listTargets. */
	targets: Array<InternalScrapeTarget>
	scrapeCalls: Array<string>
	/** `(targetId, subTargetKey)` pairs as seen by the scrape proxy stub. */
	subCalls: Array<{ targetId: string; subTargetKey: string | null }>
	ingestCalls: Array<{ ingestKey: string; request: OtlpExportRequest }>
	reportedResults: Array<ScrapeResultReport>
	/** Per-target scrape behaviour override. */
	scrapeImpl: (targetId: string) => Effect.Effect<ScrapeProxyResponse, ApiRequestError>
	ingestImpl: (ingestKey: string, request: OtlpExportRequest) => Effect.Effect<void, OtlpIngestError>
}

const makeHarness = (targets: Array<InternalScrapeTarget>): Harness => ({
	targets,
	scrapeCalls: [],
	subCalls: [],
	ingestCalls: [],
	reportedResults: [],
	scrapeImpl: () => Effect.succeed({ status: 200, body: GAUGE_BODY }),
	ingestImpl: () => Effect.void,
})

const harnessLayer = (harness: Harness, env: ScraperEnvShape = testEnv) => {
	const api: ApiClientShape = {
		listTargets: () => Effect.sync(() => [...harness.targets]),
		scrapeTarget: (targetId, subTargetKey) =>
			Effect.suspend(() => {
				harness.scrapeCalls.push(targetId)
				harness.subCalls.push({ targetId, subTargetKey: subTargetKey ?? null })
				return harness.scrapeImpl(targetId)
			}),
		reportResults: (results) =>
			Effect.sync(() => {
				harness.reportedResults.push(...results)
			}),
	}
	const otlp: OtlpIngestShape = {
		send: (ingestKey, request) =>
			Effect.suspend(() => {
				harness.ingestCalls.push({ ingestKey, request })
				return harness.ingestImpl(ingestKey, request)
			}),
	}
	return ScrapeScheduler.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(ApiClient, api),
				Layer.succeed(OtlpIngest, otlp),
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
			assert.strictEqual(aCalls, 12)
			// 300s interval: only the initial scrape.
			assert.strictEqual(bCalls, 1)
		}),
	)

	it.effect("sends one OTLP export per scrape with the target org's ingest key", () =>
		Effect.gen(function* () {
			const harness = makeHarness([mkTarget(TARGET_A, 60, { ingestKey: "maple_pk_org_a" })])
			yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))

			// One scrape happened; flush loop fires at t=10s.
			yield* TestClock.adjust(Duration.seconds(10))

			assert.lengthOf(harness.ingestCalls, 1)
			assert.strictEqual(harness.ingestCalls[0]?.ingestKey, "maple_pk_org_a")

			const resource = harness.ingestCalls[0]!.request.resourceMetrics[0]!
			const resourceAttrs = Object.fromEntries(
				resource.resource.attributes.map((attr) => [attr.key, attr.value.stringValue]),
			)
			// Org attribution comes from the ingest key at the gateway — the
			// scraper must not claim it client-side.
			assert.notProperty(resourceAttrs, "maple_org_id")
			assert.strictEqual(resourceAttrs.maple_scrape_target_id, TARGET_A)
			assert.strictEqual(resource.scopeMetrics[0]!.metrics[0]!.name, "up")

			assert.lengthOf(harness.reportedResults, 1)
			assert.strictEqual(harness.reportedResults[0]?.targetId, TARGET_A)
			assert.isNull(harness.reportedResults[0]?.error)
		}),
	)

	it.effect("skips the export entirely when a scrape yields no data points", () =>
		Effect.gen(function* () {
			const harness = makeHarness([mkTarget(TARGET_A, 60)])
			harness.scrapeImpl = () => Effect.succeed({ status: 200, body: "# only comments\n" })
			yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))

			yield* TestClock.adjust(Duration.seconds(10))

			assert.deepStrictEqual(harness.ingestCalls, [])
			// The scrape itself succeeded.
			assert.isNull(harness.reportedResults[0]?.error)
		}),
	)

	it.effect("records a failure and ingests nothing when the target returns a non-2xx", () =>
		Effect.gen(function* () {
			const harness = makeHarness([mkTarget(TARGET_A, 60)])
			harness.scrapeImpl = () => Effect.succeed({ status: 503, body: "unavailable" })
			yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))

			yield* TestClock.adjust(Duration.seconds(10))

			assert.deepStrictEqual(harness.ingestCalls, [])
			assert.lengthOf(harness.reportedResults, 1)
			assert.include(harness.reportedResults[0]?.error ?? "", "HTTP 503")
		}),
	)

	it.effect("reports check metadata (duration + sample counts) with each result", () =>
		Effect.gen(function* () {
			const harness = makeHarness([mkTarget(TARGET_A, 60)])
			// Scrape takes 2s of (test) wall-clock before responding.
			harness.scrapeImpl = () =>
				Effect.sleep(Duration.seconds(2)).pipe(
					Effect.as<ScrapeProxyResponse>({ status: 200, body: GAUGE_BODY }),
				)
			yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))

			yield* TestClock.adjust(Duration.seconds(10))

			assert.lengthOf(harness.reportedResults, 1)
			const report = harness.reportedResults[0]!
			assert.isNull(report.error)
			assert.strictEqual(report.durationMs, 2000)
			// GAUGE_BODY exposes a single `up 1` sample → one gauge data point.
			assert.strictEqual(report.samplesScraped, 1)
			assert.strictEqual(report.samplesPostMetricRelabeling, 1)
		}),
	)

	it.effect("reports duration but no sample counts for failed scrapes", () =>
		Effect.gen(function* () {
			const harness = makeHarness([mkTarget(TARGET_A, 60)])
			harness.scrapeImpl = () => Effect.succeed({ status: 503, body: "unavailable" })
			yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))

			yield* TestClock.adjust(Duration.seconds(10))

			assert.lengthOf(harness.reportedResults, 1)
			const report = harness.reportedResults[0]!
			assert.include(report.error ?? "", "HTTP 503")
			assert.strictEqual(report.durationMs, 0)
			assert.strictEqual(report.samplesScraped, undefined)
			assert.strictEqual(report.samplesPostMetricRelabeling, undefined)
		}),
	)

	it.effect("treats a gateway rejection (e.g. billing 402) as a scrape failure", () =>
		Effect.gen(function* () {
			const harness = makeHarness([mkTarget(TARGET_A, 60)])
			harness.ingestImpl = () =>
				Effect.fail(
					new OtlpIngestError({
						message: "ingest gateway rejected metrics: billing limit reached (HTTP 402)",
						status: 402,
					}),
				)
			yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))

			yield* TestClock.adjust(Duration.seconds(10))

			assert.lengthOf(harness.reportedResults, 1)
			assert.include(harness.reportedResults[0]?.error ?? "", "billing limit")
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
			assert.isAtLeast(aCalls, 3)
			// …and the healthy target keeps scraping and ingesting.
			assert.isAtLeast(bCalls, 3)
			assert.isAtLeast(harness.ingestCalls.length, 3)

			const aResults = harness.reportedResults.filter((r) => r.targetId === TARGET_A)
			assert.isAbove(aResults.length, 0)
			assert.include(aResults[0]?.error ?? "", "boom")
		}),
	)

	it.effect("runs discovered sub-targets sharing one id as independent loops", () =>
		Effect.gen(function* () {
			const harness = makeHarness([
				mkTarget(TARGET_A, 10, { subTargetKey: "branch-1", url: "https://b1.example.com/metrics" }),
				mkTarget(TARGET_A, 10, { subTargetKey: "branch-2", url: "https://b2.example.com/metrics" }),
			])
			yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))

			yield* TestClock.adjust(Duration.seconds(30))

			const branch1 = harness.subCalls.filter((c) => c.subTargetKey === "branch-1").length
			const branch2 = harness.subCalls.filter((c) => c.subTargetKey === "branch-2").length
			assert.isAtLeast(branch1, 3)
			assert.isAtLeast(branch2, 3)

			// Result reports carry the sub-target key for branch-level attribution.
			const reportedKeys = new Set(harness.reportedResults.map((r) => r.subTargetKey))
			assert.isTrue(reportedKeys.has("branch-1"))
			assert.isTrue(reportedKeys.has("branch-2"))

			// Discovery drops branch-2 → only its loop is interrupted.
			harness.targets = [
				mkTarget(TARGET_A, 10, { subTargetKey: "branch-1", url: "https://b1.example.com/metrics" }),
			]
			yield* TestClock.adjust(Duration.seconds(60))
			const branch2AfterRemoval = harness.subCalls.filter((c) => c.subTargetKey === "branch-2").length
			yield* TestClock.adjust(Duration.seconds(30))

			assert.strictEqual(
				harness.subCalls.filter((c) => c.subTargetKey === "branch-2").length,
				branch2AfterRemoval,
			)
			assert.isAbove(
				harness.subCalls.filter((c) => c.subTargetKey === "branch-1").length,
				branch1,
			)
		}),
	)

	it.effect("reconcile starts new targets, stops removed ones, and restarts changed ones", () =>
		Effect.gen(function* () {
			const harness = makeHarness([mkTarget(TARGET_A, 10)])
			yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))

			yield* TestClock.adjust(Duration.seconds(30))
			const aCallsBefore = harness.scrapeCalls.filter((id) => id === TARGET_A).length
			assert.isAtLeast(aCallsBefore, 3)

			// Swap A out for B before the next reconcile (every 60s).
			harness.targets = [mkTarget(TARGET_B, 10)]
			yield* TestClock.adjust(Duration.seconds(60))

			const aCallsAfterSwap = harness.scrapeCalls.filter((id) => id === TARGET_A).length
			yield* TestClock.adjust(Duration.seconds(30))

			assert.strictEqual(harness.scrapeCalls.filter((id) => id === TARGET_A).length, aCallsAfterSwap)
			assert.isAtLeast(harness.scrapeCalls.filter((id) => id === TARGET_B).length, 3)

			// A rotated ingest key → fingerprint change → loop restarted with the new key.
			harness.targets = [mkTarget(TARGET_B, 10, { ingestKey: "maple_pk_rotated" })]
			yield* TestClock.adjust(Duration.seconds(60))
			yield* TestClock.adjust(Duration.seconds(10))
			assert.strictEqual(harness.ingestCalls.at(-1)?.ingestKey, "maple_pk_rotated")
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
						Layer.succeed(OtlpIngest, { send: () => Effect.void }),
						Layer.succeed(ScraperEnv, testEnv),
					),
				),
			)
			yield* startScheduler.pipe(Effect.provide(layer))

			yield* TestClock.adjust(Duration.seconds(10))
			const before = harness.scrapeCalls.length
			assert.isAtLeast(before, 2)

			// Two failed reconciles later, the existing loop is still scraping.
			yield* TestClock.adjust(Duration.seconds(120))
			assert.isAtLeast(listCalls, 3)
			assert.isAbove(harness.scrapeCalls.length, before)
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
						Layer.succeed(OtlpIngest, { send: () => Effect.void }),
						Layer.succeed(ScraperEnv, testEnv),
					),
				),
			)
			yield* startScheduler.pipe(Effect.provide(layer))

			// First flush at t=10s fails; the result must be retried later.
			yield* TestClock.adjust(Duration.seconds(15))
			assert.deepStrictEqual(harness.reportedResults, [])

			failReports = false
			yield* TestClock.adjust(Duration.seconds(10))
			assert.lengthOf(harness.reportedResults, 1)
			assert.strictEqual(harness.reportedResults[0]?.targetId, TARGET_A)
		}),
	)
})
