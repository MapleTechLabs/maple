import { assert, describe, it } from "@effect/vitest"
import { Clock, Duration, Effect, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { UptimeCheckReport, type UptimeProbeTarget } from "@maple/domain/uptime"
import { ApiClient, ApiRequestError } from "./ApiClient"
import { ScraperEnv, type ScraperEnvConfig } from "./Env"
import { REPORT_INTERVAL, UptimeReporter } from "./ResultReporter"
import { StartJitter } from "./ScrapeScheduler"
import { httpConfig, MONITOR_A, MONITOR_B, mkUptimeTarget } from "./testing/uptime"
import { UptimeProber } from "./UptimeProber"
import { UptimeRegistry } from "./UptimeRegistry"
import { UptimeScheduler } from "./UptimeScheduler"
import { UptimeSpanExporter } from "./UptimeSpanExporter"

const testEnv: ScraperEnvConfig = {
	MAPLE_API_URL: "http://api.test",
	SD_INTERNAL_TOKEN: Redacted.make("token"),
	MAPLE_INGEST_URL: "http://ingest.test",
	SCRAPER_CONCURRENCY: 10,
	SCRAPER_RECONCILE_INTERVAL_SECONDS: 60,
	SCRAPER_OTLP_MAX_DATA_POINTS: 10_000,
	UPTIME_CONCURRENCY: 20,
	PORT: 0,
}

interface Harness {
	/** Returned by the stubbed monitor list; replace to simulate API changes. */
	targets: ReadonlyArray<UptimeProbeTarget>
	listFails: boolean
	/** Every target handed to the prober, as it was at check time, with the check time. */
	readonly checked: Array<{ readonly at: number; readonly target: UptimeProbeTarget }>
	readonly reported: Array<ReadonlyArray<UptimeCheckReport>>
}

const makeHarness = (targets: ReadonlyArray<UptimeProbeTarget>): Harness => ({
	targets,
	listFails: false,
	checked: [],
	reported: [],
})

/** Real registry, reporter and scheduler over a stubbed API and a prober where every check fails. */
const harnessLayer = (harness: Harness) =>
	UptimeScheduler.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				UptimeRegistry.layer,
				UptimeReporter.layer,
				Layer.succeed(UptimeProber, {
					check: (target) =>
						Effect.gen(function* () {
							const at = yield* Clock.currentTimeMillis
							harness.checked.push({ at, target })
							// A slow, failing check: cadence must hold anyway.
							yield* Effect.sleep(Duration.seconds(4))
							return new UptimeCheckReport({
								monitorId: target.id,
								checkedAt: at,
								ok: false,
								durationMs: 4000,
								statusCode: 503,
								error: "Status 503, expected 2xx",
								traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
							})
						}),
				}),
				Layer.succeed(UptimeSpanExporter, {
					record: () => Effect.void,
					pending: Effect.succeed(0),
					run: Effect.never,
				}),
			),
		),
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(ApiClient, {
					listTargets: () => Effect.succeed([]),
					reportResults: () => Effect.void,
					listUptimeTargets: () =>
						Effect.suspend(() =>
							harness.listFails
								? Effect.fail(new ApiRequestError({ message: "api down", status: 503 }))
								: Effect.succeed(harness.targets),
						),
					reportUptimeResults: (results) => Effect.sync(() => void harness.reported.push(results)),
				}),
				Layer.succeed(ScraperEnv, testEnv),
			),
		),
		Layer.provide(Layer.succeed(StartJitter, () => 0)),
	)

const startScheduler = Effect.gen(function* () {
	const scheduler = yield* UptimeScheduler
	yield* Effect.forkChild(scheduler.run)
	yield* TestClock.adjust(Duration.millis(0))
	return scheduler
})

const checksOf = (harness: Harness, id: string) =>
	harness.checked.filter((entry) => entry.target.id === id).map((entry) => entry.at / 1000)

describe("UptimeScheduler", () => {
	it.effect("a failing monitor keeps its start-to-start cadence, with no backoff", () =>
		Effect.gen(function* () {
			const harness = makeHarness([mkUptimeTarget({ intervalSeconds: 30 })])
			yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))
			yield* TestClock.adjust(Duration.seconds(150))
			assert.deepStrictEqual(checksOf(harness, MONITOR_A), [0, 30, 60, 90, 120, 150])
		}),
	)

	it.effect("holds its cadence over hundreds of checks and still stops once removed", () =>
		Effect.gen(function* () {
			const harness = makeHarness([mkUptimeTarget({ intervalSeconds: 30 })])
			yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))
			yield* TestClock.adjust(Duration.seconds(15_000))
			const checks = checksOf(harness, MONITOR_A)
			assert.strictEqual(checks.length, 501)
			assert.isTrue(checks.every((at, index) => at === index * 30))

			// The t=15060 reconcile drops it; no check runs after that.
			harness.targets = []
			yield* TestClock.adjust(Duration.seconds(300))
			const after = checksOf(harness, MONITOR_A)
			assert.isAtMost(after.length, 503)
			assert.isTrue(after.every((at) => at <= 15_060))
		}),
	)

	it.effect("applies interval and config edits on the next check, without a restart", () =>
		Effect.gen(function* () {
			const harness = makeHarness([mkUptimeTarget({ intervalSeconds: 30 })])
			yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))
			yield* TestClock.adjust(Duration.seconds(31))
			harness.targets = [
				mkUptimeTarget({
					intervalSeconds: 120,
					config: httpConfig({ url: "https://api.example.com/v2/health" }),
				}),
			]
			// Reconcile at t=60 picks up the edit; the t=60 check is the first to use it.
			yield* TestClock.adjust(Duration.seconds(29 + 150))
			assert.deepStrictEqual(checksOf(harness, MONITOR_A), [0, 30, 60, 180])
			const last = harness.checked.at(-1)?.target.config
			assert.strictEqual(last?._tag === "http" ? last.url : null, "https://api.example.com/v2/health")
		}),
	)

	it.effect("starts added monitors and stops removed ones at the next reconcile", () =>
		Effect.gen(function* () {
			const harness = makeHarness([mkUptimeTarget({ intervalSeconds: 30 })])
			const scheduler = yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))
			harness.targets = [mkUptimeTarget({ id: MONITOR_B, intervalSeconds: 30 })]
			yield* TestClock.adjust(Duration.seconds(119))
			// A ran at 0 and 30; its t=60 run saw it gone. B started at the t=60 reconcile.
			assert.deepStrictEqual(checksOf(harness, MONITOR_A), [0, 30])
			assert.deepStrictEqual(checksOf(harness, MONITOR_B), [60, 90])
			assert.strictEqual((yield* scheduler.stats).activeMonitors, 1)
		}),
	)

	it.effect("keeps running loops when the monitor list cannot be fetched", () =>
		Effect.gen(function* () {
			const harness = makeHarness([mkUptimeTarget({ intervalSeconds: 30 })])
			const scheduler = yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))
			harness.listFails = true
			yield* TestClock.adjust(Duration.seconds(119))
			assert.deepStrictEqual(checksOf(harness, MONITOR_A), [0, 30, 60, 90])
			assert.strictEqual((yield* scheduler.stats).status, "ok")
			yield* TestClock.adjust(Duration.seconds(120))
			assert.strictEqual((yield* scheduler.stats).status, "degraded")
		}),
	)

	it.effect("reports checks to the API in batches", () =>
		Effect.gen(function* () {
			const harness = makeHarness([
				mkUptimeTarget({ intervalSeconds: 30 }),
				mkUptimeTarget({ id: MONITOR_B, intervalSeconds: 30 }),
			])
			yield* startScheduler.pipe(Effect.provide(harnessLayer(harness)))
			yield* TestClock.adjust(Duration.seconds(4))
			// Both t=0 checks finished at t=4 and went out together after the reporter's pause.
			yield* TestClock.adjust(REPORT_INTERVAL)
			const delivered = harness.reported.flat()
			assert.sameMembers(
				delivered.map((report) => report.monitorId),
				[MONITOR_A, MONITOR_B],
			)
			assert.isAtMost(harness.reported.length, 2)
			assert.isTrue(delivered.every((report) => report.error === "Status 503, expected 2xx"))
		}),
	)
})
