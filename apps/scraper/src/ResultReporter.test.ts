import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer, Metric, Schema } from "effect"
import { TestClock } from "effect/testing"
import { ScrapeResultReport, ScrapeTargetId } from "@maple/domain/http"
import { ApiClient, ApiRequestError } from "./ApiClient"
import { bufferedResults } from "./Metrics"
import { REPORT_BATCH_SIZE, REPORT_INTERVAL, ResultReporter } from "./ResultReporter"

const targetId = Schema.decodeSync(ScrapeTargetId)("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
const report = (scrapedAt: number) => new ScrapeResultReport({ targetId, scrapedAt, error: null })

interface Harness {
	readonly delivered: Array<ReadonlyArray<ScrapeResultReport>>
	reportImpl: () => Effect.Effect<void, ApiRequestError>
}

const makeHarness = (): Harness => ({ delivered: [], reportImpl: () => Effect.void })

const reporterLayer = (harness: Harness) =>
	ResultReporter.layer.pipe(
		Layer.provide(
			Layer.succeed(ApiClient, {
				listTargets: () => Effect.succeed([]),
				reportResults: (results) =>
					Effect.suspend(() => harness.reportImpl()).pipe(
						Effect.tap(() => Effect.sync(() => harness.delivered.push(results))),
					),
			}),
		),
	)

const scrapedAts = (harness: Harness) => harness.delivered.flat().map((r) => r.scrapedAt)

describe("ResultReporter", () => {
	it.effect("delivers in order, in batches of at most REPORT_BATCH_SIZE, one POST per interval", () =>
		Effect.gen(function* () {
			const harness = makeHarness()
			yield* Effect.gen(function* () {
				const reporter = yield* ResultReporter
				const total = REPORT_BATCH_SIZE * 2 + 5
				yield* Effect.forEach(
					Array.from({ length: total }, (_, i) => report(i)),
					reporter.record,
					{
						discard: true,
					},
				)
				yield* Effect.forkChild(reporter.run)
				// Three back-to-back POSTs outrun a single scheduler turn.
				yield* Effect.repeat(Effect.yieldNow, { times: 10 })

				// Full batches go out back to back; the partial one ends the burst.
				assert.deepStrictEqual(
					harness.delivered.map((batch) => batch.length),
					[REPORT_BATCH_SIZE, REPORT_BATCH_SIZE, 5],
				)
				assert.deepStrictEqual(
					scrapedAts(harness),
					Array.from({ length: total }, (_, i) => i),
				)

				// Results recorded after a partial batch wait for the next interval.
				yield* reporter.record(report(total))
				yield* TestClock.adjust(Duration.millis(Duration.toMillis(REPORT_INTERVAL) - 1))
				assert.lengthOf(harness.delivered, 3)
				yield* TestClock.adjust(Duration.millis(1))
				assert.lengthOf(harness.delivered, 4)
				assert.strictEqual(yield* reporter.pending, 0)
			}).pipe(Effect.provide(reporterLayer(harness)))
		}),
	)

	it.effect("retries a failed batch until the API recovers, without reordering", () =>
		Effect.gen(function* () {
			const harness = makeHarness()
			let apiUp = false
			harness.reportImpl = () =>
				apiUp ? Effect.void : Effect.fail(new ApiRequestError({ message: "api down", status: 503 }))
			yield* Effect.gen(function* () {
				const reporter = yield* ResultReporter
				yield* reporter.record(report(1))
				yield* Effect.forkChild(reporter.run)
				yield* TestClock.adjust(Duration.seconds(10))
				yield* reporter.record(report(2))
				assert.lengthOf(harness.delivered, 0)

				apiUp = true
				// Retry delay is capped at 30s.
				yield* TestClock.adjust(Duration.seconds(30))
				yield* TestClock.adjust(REPORT_INTERVAL)
				assert.deepStrictEqual(scrapedAts(harness), [1, 2])
			}).pipe(Effect.provide(reporterLayer(harness)))
		}),
	)

	it.effect("counts a batch stuck in delivery as pending", () =>
		Effect.gen(function* () {
			const harness = makeHarness()
			let calls = 0
			// Only the first POST stalls, so the shutdown flush at teardown completes.
			harness.reportImpl = () => (calls++ === 0 ? Effect.never : Effect.void)
			yield* Effect.gen(function* () {
				const reporter = yield* ResultReporter
				yield* reporter.record(report(1))
				yield* Effect.forkChild(reporter.run)
				yield* TestClock.adjust(Duration.millis(0))
				yield* reporter.record(report(2))

				assert.strictEqual(yield* reporter.pending, 2)
				assert.strictEqual((yield* Metric.value(bufferedResults)).value, 2)
			}).pipe(Effect.provide(reporterLayer(harness)))
		}),
	)

	it.effect("flushes the in-flight batch and the queue once on shutdown", () =>
		Effect.gen(function* () {
			const harness = makeHarness()
			let calls = 0
			// The first POST hangs; the shutdown flush goes through.
			harness.reportImpl = () => (calls++ === 0 ? Effect.never : Effect.void)
			yield* Effect.gen(function* () {
				const reporter = yield* ResultReporter
				yield* reporter.record(report(1))
				const fiber = yield* Effect.forkChild(reporter.run)
				yield* TestClock.adjust(Duration.millis(0))
				yield* reporter.record(report(2))

				yield* Fiber.interrupt(fiber)
				assert.deepStrictEqual(scrapedAts(harness), [1, 2])
				assert.strictEqual(yield* reporter.pending, 0)
			}).pipe(Effect.provide(reporterLayer(harness)))
		}),
	)
})
