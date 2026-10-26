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
import type { OtlpExportRequest } from "@maple/prometheus-otlp"
import { OtlpIngest } from "./OtlpIngest"
import { Scraper } from "./Scraper"
import { TargetFetcher } from "./TargetFetcher"
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

/** Three samples, two exported: the NaN is dropped by the converter. */
const OK_BODY = "a 1\nb 2\nc NaN\n"

const branch = (key: string, intervalSeconds = 10) =>
	mkTarget(TARGET_A, intervalSeconds, { subTargetKey: key, url: `https://${key}.example.com/metrics` })

const failure = (reason: ScrapeFailureReason, retryAfterMs: number | null = null): ScrapeError =>
	scrapeError({ message: `failed: ${reason}`, reason, retryAfterMs })

const testEnv: ScraperEnvConfig = {
	MAPLE_API_URL: "http://api.test",
	SD_INTERNAL_TOKEN: Redacted.make("token"),
	MAPLE_INGEST_URL: "http://ingest.test",
	SCRAPER_CONCURRENCY: 10,
	SCRAPER_RECONCILE_INTERVAL_SECONDS: 60,
	SCRAPER_OTLP_MAX_DATA_POINTS: 10_000,
	SCRAPER_OTLP_MAX_BODY_BYTES: 4 * 1024 * 1024,
	UPTIME_CONCURRENCY: 20,
	PORT: 0,
}

interface Harness {
	/** Returned by the stubbed target list; mutate to simulate API changes. */
	targets: Array<InternalScrapeTarget>
	/** Every target fetched, as it was at fetch time. */
	readonly scraped: Array<InternalScrapeTarget>
	/** Every export handed to ingest. */
	readonly sent: Array<{ ingestKey: string; request: OtlpExportRequest }>
	readonly reported: Array<ScrapeResultReport>
	scrapeImpl: (target: InternalScrapeTarget) => Effect.Effect<string, ScrapeError>
	sendImpl: () => Effect.Effect<void, ScrapeError>
	listImpl: () => Effect.Effect<ReadonlyArray<InternalScrapeTarget>, ApiRequestError>
}

const makeHarness = (targets: Array<InternalScrapeTarget>): Harness => {
	const harness: Harness = {
		targets,
		scraped: [],
		sent: [],
		reported: [],
		scrapeImpl: () => Effect.succeed(OK_BODY),
		sendImpl: () => Effect.void,
		listImpl: () => Effect.sync(() => [...harness.targets]),
	}
	return harness
}

const scrapesOf = (harness: Harness, id: string, subTargetKey: string | null = null) =>
	harness.scraped.filter((t) => t.id === id && t.subTargetKey === subTargetKey).length

/** Real registry, scraper and reporter over a stubbed API, fetcher and ingest. Jitter is zeroed unless asked for. */
const harnessLayer = (harness: Harness, options: { readonly realJitter?: boolean } = {}) => {
	const api: ApiClientApi = {
		listTargets: () => Effect.suspend(() => harness.listImpl()),
		reportResults: (results) => Effect.sync(() => void harness.reported.push(...results)),
		listUptimeTargets: () => Effect.succeed([]),
		reportUptimeResults: () => Effect.void,
	}
	const fetcher = Layer.succeed(TargetFetcher, {
		fetch: (target) =>
			Effect.suspend(() => {
				harness.scraped.push(target)
				return harness.scrapeImpl(target)
			}),
	})
	const ingest = Layer.succeed(OtlpIngest, {
		send: (ingestKey, request) =>
			Effect.suspend(() => {
				harness.sent.push({ ingestKey, request })
				return harness.sendImpl()
			}),
	})
	return ScrapeScheduler.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				TargetRegistry.layer,
				ResultReporter.layer,
				Scraper.layer.pipe(Layer.provide(Layer.mergeAll(fetcher, ingest))),
			),
		),
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
				harness.scrapeImpl = () => Effect.as(Effect.sleep(Duration.seconds(2)), OK_BODY)
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
				const offsets = [TARGET_A, TARGET_B].map((id) => startJitterMs(id, 60_000))
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
					harness.scraped.length <= 2
						? Effect.fail(failure("rate_limited"))
						: Effect.succeed(OK_BODY)
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
				harness.sendImpl = () => (blocked ? Effect.fail(failure("delivery_blocked")) : Effect.void)
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

		it.effect("skips a backing-off sub-target until its Retry-After ends, the rest hold cadence", () =>
			Effect.gen(function* () {
				const harness = makeHarness([branch("ok"), branch("limited")])
				harness.scrapeImpl = (target) =>
					target.subTargetKey === "limited" && scrapesOf(harness, TARGET_A, "limited") === 1
						? Effect.fail(failure("rate_limited", 25_000))
						: Effect.succeed(OK_BODY)
				yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))
				yield* TestClock.adjust(Duration.seconds(60))

				// ok: t=0..60 every 10s. limited: 429@0, sits out 10 and 20, back at 30.
				assert.strictEqual(scrapesOf(harness, TARGET_A, "ok"), 7)
				assert.strictEqual(scrapesOf(harness, TARGET_A, "limited"), 5)
				assert.lengthOf(harness.sent, 7)
			}),
		)

		it.effect("wakes a parent whose only sub-target backs off when its Retry-After ends", () =>
			Effect.gen(function* () {
				const harness = makeHarness([branch("only")])
				harness.scrapeImpl = () =>
					harness.scraped.length === 1
						? Effect.fail(failure("rate_limited", 25_000))
						: Effect.succeed(OK_BODY)
				yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))
				yield* TestClock.adjust(Duration.seconds(24))
				assert.strictEqual(scrapesOf(harness, TARGET_A, "only"), 1)
				yield* TestClock.adjust(Duration.seconds(1))
				assert.strictEqual(scrapesOf(harness, TARGET_A, "only"), 2)
			}),
		)

		it.effect("scrapes a branch discovered while every other branch backs off within one interval", () =>
			Effect.gen(function* () {
				const harness = makeHarness([branch("down")])
				harness.scrapeImpl = (target) =>
					target.subTargetKey === "down"
						? Effect.fail(failure("rate_limited", 300_000))
						: Effect.succeed(OK_BODY)
				yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))
				harness.targets = [branch("down"), branch("new")]
				// Reconcile at t=60 picks it up; the loop wakes on its next 10s tick.
				yield* TestClock.adjust(Duration.seconds(70))
				assert.isAtLeast(scrapesOf(harness, TARGET_A, "new"), 1)
				assert.strictEqual(scrapesOf(harness, TARGET_A, "down"), 1)
			}),
		)

		it.effect("parks every sub-target of a parent when ingest blocks its key", () =>
			Effect.gen(function* () {
				const harness = makeHarness([branch("a"), branch("b")])
				harness.sendImpl = () => Effect.fail(failure("delivery_blocked"))
				yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))
				yield* TestClock.adjust(Duration.minutes(59))
				assert.strictEqual(scrapesOf(harness, TARGET_A, "a"), 1)
				assert.strictEqual(scrapesOf(harness, TARGET_A, "b"), 1)
				assert.lengthOf(harness.sent, 1)
			}),
		)

		it.effect("one failing target does not stop the others", () =>
			Effect.gen(function* () {
				const harness = makeHarness([mkTarget(TARGET_A, 10), mkTarget(TARGET_B, 10)])
				harness.scrapeImpl = (target) =>
					target.id === TARGET_A ? Effect.fail(failure("scrape_failed")) : Effect.succeed(OK_BODY)
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
								? Effect.succeed(OK_BODY)
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
				assert.strictEqual(failed?.error, 'target "target-bbbb" (example.com) failed: target_error')
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

		it.effect("runs discovered sub-targets sharing one id as one loop with one export per cycle", () =>
			Effect.gen(function* () {
				const harness = makeHarness([branch("branch-1"), branch("branch-2")])
				yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))
				yield* TestClock.adjust(Duration.seconds(30))
				assert.strictEqual(scrapesOf(harness, TARGET_A, "branch-1"), 4)
				assert.strictEqual(scrapesOf(harness, TARGET_A, "branch-2"), 4)
				// t=0,10,20,30: one send per cycle, carrying both branches.
				assert.lengthOf(harness.sent, 4)
				for (const { request } of harness.sent) assert.lengthOf(request.resourceMetrics, 2)
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

		it.effect("reports each sub-target on its own: its fetch error, or the shared send error", () =>
			Effect.gen(function* () {
				const harness = makeHarness([branch("ok"), branch("down")])
				harness.scrapeImpl = (target) =>
					target.subTargetKey === "down"
						? Effect.fail(scrapeError({ message: "fetch broke", reason: "scrape_failed" }))
						: Effect.succeed(OK_BODY)
				yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))
				yield* TestClock.adjust(Duration.seconds(5))
				const first = new Map(harness.reported.map((r) => [r.subTargetKey, r]))
				assert.strictEqual(first.get("ok")?.error, null)
				assert.strictEqual(first.get("ok")?.samplesScraped, 3)
				assert.strictEqual(
					first.get("down")?.error,
					'target "target-aaaa" (down.example.com) fetch broke',
				)

				harness.sendImpl = () => Effect.fail(failure("scrape_failed"))
				yield* TestClock.adjust(Duration.seconds(10))
				const second = harness.reported.filter((r) => r.scrapedAt === 10_000)
				assert.deepStrictEqual(
					second.map((r) => [r.subTargetKey, r.error]),
					[
						["ok", 'target "target-aaaa" (ok.example.com) failed: scrape_failed'],
						["down", 'target "target-aaaa" (down.example.com) fetch broke'],
					],
				)
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
				const jitter = startJitterMs(TARGET_A, 60_000)
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
