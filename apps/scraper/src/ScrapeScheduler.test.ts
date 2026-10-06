import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Layer, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { InternalScrapeTarget, type ScrapeResultReport } from "@maple/domain/http"
import { ApiClient, ApiRequestError, type ApiClientApi } from "./ApiClient"
import { ScraperEnv, type ScraperEnvConfig } from "./Env"
import { DELIVERY_BLOCKED_BACKOFF, startJitterMs } from "./policy"
import { ResultReporter } from "./ResultReporter"
import { scrapeError, type ScrapeError, type ScrapeFailureReason } from "./ScrapeError"
import { ScrapeScheduler, StartJitter } from "./ScrapeScheduler"
import { Scraper, type ScrapeSuccess } from "./Scraper"
import { TargetRegistry } from "./TargetRegistry"

const decodeTarget = Schema.decodeUnknownSync(InternalScrapeTarget)

const TARGET_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const TARGET_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

const mkTarget = (
	id: string,
	intervalSeconds: number,
	overrides: Partial<{
		url: string
		scrapeUrl: string
		ingestKey: string
		subTargetKey: string | null
	}> = {},
): InternalScrapeTarget =>
	decodeTarget({
		id,
		orgId: "org_test",
		name: `target-${id.slice(0, 4)}`,
		serviceName: null,
		targetType: "prometheus",
		url: overrides.url ?? "https://example.com/metrics",
		scrapeUrl: overrides.scrapeUrl ?? overrides.url ?? "https://example.com/metrics",
		authHeaders: {},
		subTargetKey: overrides.subTargetKey ?? null,
		scrapeIntervalSeconds: intervalSeconds,
		labels: {},
		ingestKey: overrides.ingestKey ?? `maple_pk_${id.slice(0, 4)}`,
	})

const OK: ScrapeSuccess = { samplesScraped: 3, samplesExported: 2 }

const failure = (reason: ScrapeFailureReason, retryAfterMs: number | null = null): ScrapeError =>
	scrapeError({ message: `failed: ${reason}`, reason, retryAfterMs })

const testEnv: ScraperEnvConfig = {
	MAPLE_API_URL: "http://api.test",
	SD_INTERNAL_TOKEN: Redacted.make("token"),
	MAPLE_INGEST_URL: "http://ingest.test",
	SCRAPER_CONCURRENCY: 10,
	SCRAPER_RECONCILE_INTERVAL_SECONDS: 60,
	SCRAPER_OTLP_MAX_DATA_POINTS: 10_000,
	PORT: 0,
}

interface Harness {
	/** Returned by the stubbed target list; mutate to simulate API changes. */
	targets: Array<InternalScrapeTarget>
	/** Every target handed to the scraper, as it was at scrape time. */
	readonly scraped: Array<InternalScrapeTarget>
	readonly reported: Array<ScrapeResultReport>
	scrapeImpl: (target: InternalScrapeTarget) => Effect.Effect<ScrapeSuccess, ScrapeError>
	listImpl: () => Effect.Effect<ReadonlyArray<InternalScrapeTarget>, ApiRequestError>
}

const makeHarness = (targets: Array<InternalScrapeTarget>): Harness => {
	const harness: Harness = {
		targets,
		scraped: [],
		reported: [],
		scrapeImpl: () => Effect.succeed(OK),
		listImpl: () => Effect.sync(() => [...harness.targets]),
	}
	return harness
}

const scrapesOf = (harness: Harness, id: string, subTargetKey: string | null = null) =>
	harness.scraped.filter((t) => t.id === id && t.subTargetKey === subTargetKey).length

/** Real registry and reporter over a stubbed API and scraper. Jitter is zeroed unless asked for. */
const harnessLayer = (harness: Harness, options: { readonly realJitter?: boolean } = {}) => {
	const api: ApiClientApi = {
		listTargets: () => Effect.suspend(() => harness.listImpl()),
		reportResults: (results) => Effect.sync(() => void harness.reported.push(...results)),
	}
	const scraper = Layer.succeed(Scraper, {
		scrape: (target) =>
			Effect.suspend(() => {
				harness.scraped.push(target)
				return harness.scrapeImpl(target)
			}),
	})
	return ScrapeScheduler.layer.pipe(
		Layer.provide(Layer.mergeAll(TargetRegistry.layer, ResultReporter.layer, scraper)),
		Layer.provide(Layer.mergeAll(Layer.succeed(ApiClient, api), Layer.succeed(ScraperEnv, testEnv))),
		Layer.provide(options.realJitter ? Layer.empty : Layer.succeed(StartJitter, () => 0)),
	)
}

const startScheduler = Effect.gen(function* () {
	const scheduler = yield* ScrapeScheduler
	yield* Effect.forkChild(scheduler.run)
	yield* TestClock.adjust(Duration.millis(0))
	return scheduler
})

describe("ScrapeScheduler", () => {
	describe("cadence", () => {
		it.effect("scrapes each target at its configured interval", () =>
			Effect.gen(function* () {
				const harness = makeHarness([mkTarget(TARGET_A, 5), mkTarget(TARGET_B, 300)])
				yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))
				yield* TestClock.adjust(Duration.seconds(59))

				// t=0,5,...,55 → 12; the 300s target only scraped once.
				assert.strictEqual(scrapesOf(harness, TARGET_A), 12)
				assert.strictEqual(scrapesOf(harness, TARGET_B), 1)
			}),
		)

		it.effect("holds start-to-start cadence even when scrapes are slow", () =>
			Effect.gen(function* () {
				const harness = makeHarness([mkTarget(TARGET_A, 10)])
				harness.scrapeImpl = () => Effect.as(Effect.sleep(Duration.seconds(2)), OK)
				yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))
				yield* TestClock.adjust(Duration.seconds(59))

				// t=0,10,...,50 → 6; sleeping after each 2s scrape would give 5.
				assert.strictEqual(scrapesOf(harness, TARGET_A), 6)
			}),
		)

		it.effect("spreads targets across their interval by default", () =>
			Effect.gen(function* () {
				const harness = makeHarness([mkTarget(TARGET_A, 60), mkTarget(TARGET_B, 60)])
				yield* startScheduler.pipe(Effect.provide(harnessLayer(harness, { realJitter: true })))
				const offsets = [TARGET_A, TARGET_B].map((id) => startJitterMs(`${id}:`, 60_000))
				assert.notStrictEqual(offsets[0], offsets[1])

				for (const [index, id] of [TARGET_A, TARGET_B].entries()) {
					assert.strictEqual(scrapesOf(harness, id), offsets[index] === 0 ? 1 : 0)
				}
				yield* TestClock.adjust(Duration.millis(60_000))
				assert.strictEqual(scrapesOf(harness, TARGET_A), 1)
				assert.strictEqual(scrapesOf(harness, TARGET_B), 1)
			}),
		)
	})

	describe("backoff", () => {
		for (const reason of ["rate_limited", "auth_failed", "target_error"] as const) {
			it.effect(`escalates exponentially on ${reason}`, () =>
				Effect.gen(function* () {
					const harness = makeHarness([mkTarget(TARGET_A, 10)])
					harness.scrapeImpl = () => Effect.fail(failure(reason))
					yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))
					yield* TestClock.adjust(Duration.seconds(60))

					// t=0, 10, 30 (next is t=70). A fixed interval would have fired 7 times.
					assert.strictEqual(scrapesOf(harness, TARGET_A), 3)
				}),
			)
		}

		it.effect("holds the configured cadence on scrape_failed", () =>
			Effect.gen(function* () {
				const harness = makeHarness([mkTarget(TARGET_A, 10)])
				harness.scrapeImpl = () => Effect.fail(failure("scrape_failed"))
				yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))
				yield* TestClock.adjust(Duration.seconds(60))
				assert.strictEqual(scrapesOf(harness, TARGET_A), 7)
			}),
		)

		it.effect("honors a longer Retry-After", () =>
			Effect.gen(function* () {
				const harness = makeHarness([mkTarget(TARGET_A, 10)])
				harness.scrapeImpl = () => Effect.fail(failure("rate_limited", 120_000))
				yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))
				yield* TestClock.adjust(Duration.seconds(60))
				assert.strictEqual(scrapesOf(harness, TARGET_A), 1)
			}),
		)

		it.effect("resets the ladder once the target recovers", () =>
			Effect.gen(function* () {
				const harness = makeHarness([mkTarget(TARGET_A, 10)])
				harness.scrapeImpl = () =>
					harness.scraped.length <= 2 ? Effect.fail(failure("rate_limited")) : Effect.succeed(OK)
				yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))
				yield* TestClock.adjust(Duration.seconds(60))

				// 429@0, 429@10, ok@30, 40, 50, 60.
				assert.strictEqual(scrapesOf(harness, TARGET_A), 6)
			}),
		)

		it.effect("parks a billing-blocked target for an hour, then resumes its cadence", () =>
			Effect.gen(function* () {
				const harness = makeHarness([mkTarget(TARGET_A, 10)])
				let blocked = true
				harness.scrapeImpl = () =>
					blocked ? Effect.fail(failure("delivery_blocked")) : Effect.succeed(OK)
				yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))

				yield* TestClock.adjust(Duration.minutes(59))
				assert.strictEqual(scrapesOf(harness, TARGET_A), 1)

				blocked = false
				yield* TestClock.adjust(Duration.minutes(1))
				assert.strictEqual(scrapesOf(harness, TARGET_A), 2)
				yield* TestClock.adjust(Duration.seconds(30))
				assert.strictEqual(scrapesOf(harness, TARGET_A), 5)
				assert.isAbove(Duration.toMillis(DELIVERY_BLOCKED_BACKOFF), 0)
			}),
		)

		it.effect("one failing target does not stop the others", () =>
			Effect.gen(function* () {
				const harness = makeHarness([mkTarget(TARGET_A, 10), mkTarget(TARGET_B, 10)])
				harness.scrapeImpl = (target) =>
					target.id === TARGET_A ? Effect.fail(failure("scrape_failed")) : Effect.succeed(OK)
				yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))
				yield* TestClock.adjust(Duration.seconds(30))

				assert.strictEqual(scrapesOf(harness, TARGET_A), 4)
				assert.strictEqual(scrapesOf(harness, TARGET_B), 4)
			}),
		)
	})

	describe("results", () => {
		it.effect("reports duration and sample counts, and only the error on failure", () =>
			Effect.gen(function* () {
				const harness = makeHarness([mkTarget(TARGET_A, 60), mkTarget(TARGET_B, 60)])
				harness.scrapeImpl = (target) =>
					Effect.sleep(Duration.seconds(2)).pipe(
						Effect.andThen(
							target.id === TARGET_A
								? Effect.succeed(OK)
								: Effect.fail(failure("target_error")),
						),
					)
				yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))
				// Both land within the first two report intervals.
				yield* TestClock.adjust(Duration.seconds(12))

				const ok = harness.reported.find((r) => r.targetId === TARGET_A)
				assert.strictEqual(ok?.error, null)
				assert.strictEqual(ok?.durationMs, 2000)
				assert.strictEqual(ok?.samplesScraped, 3)
				assert.strictEqual(ok?.samplesPostMetricRelabeling, 2)

				const failed = harness.reported.find((r) => r.targetId === TARGET_B)
				assert.strictEqual(failed?.error, "failed: target_error")
				assert.strictEqual(failed?.durationMs, 2000)
				assert.isUndefined(failed?.samplesScraped)
			}),
		)
	})

	describe("reconcile", () => {
		it.effect("starts new targets and stops removed ones", () =>
			Effect.gen(function* () {
				const harness = makeHarness([mkTarget(TARGET_A, 10)])
				yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))
				yield* TestClock.adjust(Duration.seconds(30))

				harness.targets = [mkTarget(TARGET_B, 10)]
				yield* TestClock.adjust(Duration.seconds(30))
				const aAfterSwap = scrapesOf(harness, TARGET_A)
				yield* TestClock.adjust(Duration.seconds(30))

				assert.strictEqual(scrapesOf(harness, TARGET_A), aAfterSwap)
				assert.isAtLeast(scrapesOf(harness, TARGET_B), 3)
			}),
		)

		it.effect("runs discovered sub-targets sharing one id as independent loops", () =>
			Effect.gen(function* () {
				const branch = (key: string) =>
					mkTarget(TARGET_A, 10, { subTargetKey: key, url: `https://${key}.example.com/metrics` })
				const harness = makeHarness([branch("branch-1"), branch("branch-2")])
				yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))
				yield* TestClock.adjust(Duration.seconds(30))
				assert.strictEqual(scrapesOf(harness, TARGET_A, "branch-1"), 4)
				assert.strictEqual(scrapesOf(harness, TARGET_A, "branch-2"), 4)
				assert.deepStrictEqual(
					new Set(harness.reported.map((r) => r.subTargetKey)),
					new Set(["branch-1", "branch-2"]),
				)

				harness.targets = [branch("branch-1")]
				yield* TestClock.adjust(Duration.seconds(30))
				const branch2AfterRemoval = scrapesOf(harness, TARGET_A, "branch-2")
				yield* TestClock.adjust(Duration.seconds(30))
				assert.strictEqual(scrapesOf(harness, TARGET_A, "branch-2"), branch2AfterRemoval)
				assert.strictEqual(scrapesOf(harness, TARGET_A, "branch-1"), 10)
			}),
		)

		// PlanetScale discovery once returned many rows collapsing to one key; a
		// loop per row leaked fibers and multiplied the scrape rate every reconcile.
		it.effect("collapses duplicate (id, subTargetKey) rows to a single loop", () =>
			Effect.gen(function* () {
				const dup = () => mkTarget(TARGET_A, 60, { subTargetKey: "metrics.psdb.cloud" })
				const harness = makeHarness([dup(), dup(), dup()])
				yield* startScheduler.pipe(Effect.provide(harnessLayer(harness, { realJitter: true })))

				const windowMs = 125_000
				const jitter = startJitterMs(`${TARGET_A}:metrics.psdb.cloud`, 60_000)
				yield* TestClock.adjust(Duration.millis(windowMs))
				assert.strictEqual(
					scrapesOf(harness, TARGET_A, "metrics.psdb.cloud"),
					Math.floor((windowMs - jitter) / 60_000) + 1,
				)
			}),
		)

		// Signed URLs, credentials and ingest keys rotate between refreshes; a loop
		// reads its config every scrape, so a change lands without a restart.
		it.effect("applies changed config on the next scrape without restarting the loop", () =>
			Effect.gen(function* () {
				const harness = makeHarness([
					mkTarget(TARGET_A, 10, { scrapeUrl: "https://example.com/metrics?sig=first" }),
				])
				yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))
				yield* TestClock.adjust(Duration.seconds(50))
				assert.strictEqual(scrapesOf(harness, TARGET_A), 6)

				harness.targets = [
					mkTarget(TARGET_A, 20, {
						scrapeUrl: "https://example.com/metrics?sig=second",
						ingestKey: "maple_pk_rotated",
					}),
				]
				// Reconcile at t=60 runs before that tick's scrape.
				yield* TestClock.adjust(Duration.seconds(10))
				const latest = harness.scraped.at(-1)
				assert.strictEqual(latest?.scrapeUrl, "https://example.com/metrics?sig=second")
				assert.strictEqual(latest?.ingestKey, "maple_pk_rotated")

				// Same fiber, new 20s interval: t=60, 80, 100.
				yield* TestClock.adjust(Duration.seconds(40))
				assert.strictEqual(scrapesOf(harness, TARGET_A), 9)
			}),
		)

		it.effect("keeps current loops running when a refresh fails", () =>
			Effect.gen(function* () {
				const harness = makeHarness([mkTarget(TARGET_A, 10)])
				let listCalls = 0
				harness.listImpl = () =>
					listCalls++ === 0
						? Effect.succeed([...harness.targets])
						: Effect.fail(new ApiRequestError({ message: "api down", status: null }))
				yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))
				yield* TestClock.adjust(Duration.seconds(130))

				assert.isAtLeast(listCalls, 3)
				assert.strictEqual(scrapesOf(harness, TARGET_A), 14)
			}),
		)
	})

	describe("stats", () => {
		it.effect("reports degraded once the target list has been stale for three intervals", () =>
			Effect.gen(function* () {
				const harness = makeHarness([mkTarget(TARGET_A, 60)])
				let apiUp = true
				harness.listImpl = () =>
					apiUp
						? Effect.succeed([...harness.targets])
						: Effect.fail(new ApiRequestError({ message: "api down", status: null }))
				const scheduler = yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))

				const ok = yield* scheduler.stats
				assert.strictEqual(ok.status, "ok")
				assert.strictEqual(ok.activeTargets, 1)

				apiUp = false
				yield* TestClock.adjust(Duration.seconds(180))
				assert.strictEqual((yield* scheduler.stats).status, "ok")
				yield* TestClock.adjust(Duration.seconds(1))
				assert.strictEqual((yield* scheduler.stats).status, "degraded")

				apiUp = true
				yield* TestClock.adjust(Duration.seconds(59))
				assert.strictEqual((yield* scheduler.stats).status, "ok")
			}),
		)
	})
})
