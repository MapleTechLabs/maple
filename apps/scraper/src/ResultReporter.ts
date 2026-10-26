import { Array as Arr, Context, Duration, Effect, Layer, Metric, Queue, Ref, Schedule } from "effect"
import type { ScrapeResultReport } from "@maple/domain/http"
import { type UptimeCheckReport, UPTIME_CHECK_REPORT_BATCH_MAX } from "@maple/domain/uptime"
import { ApiClient, type ApiRequestError } from "./ApiClient"
import { bufferedResults, bufferedUptimeResults } from "./Metrics"

/** Bounds memory while the API is unreachable: the oldest results are dropped first. */
const MAX_BUFFERED_RESULTS = 10_000
/**
 * Max results per POST; one 10k-result body overwhelmed the API Worker (edge 503). Also the
 * API's cap on an uptime results POST, which refuses a larger batch with a 400.
 */
export const REPORT_BATCH_SIZE = UPTIME_CHECK_REPORT_BATCH_MAX
/** Pause after a partial batch, so steady state is one POST per interval. */
export const REPORT_INTERVAL = Duration.seconds(10)
const RETRY = Schedule.min([Schedule.exponential(Duration.seconds(1)), Schedule.spaced(Duration.seconds(30))])
const FINAL_FLUSH_TIMEOUT = Duration.seconds(5)

export interface BatchReporterApi<A> {
	readonly record: (report: A) => Effect.Effect<void>
	/** Results not yet acknowledged by the API: queued plus the batch in flight. */
	readonly pending: Effect.Effect<number>
	/**
	 * Deliver results to the API in order, retrying a failed batch until it lands.
	 * On interruption, one bounded best-effort flush of everything still held.
	 */
	readonly run: Effect.Effect<never>
}

export type ResultReporterApi = BatchReporterApi<ScrapeResultReport>

/** A bounded, ordered, batched delivery queue in front of one API report call. */
export const makeBatchReporter = <A>(options: {
	readonly deliver: (batch: ReadonlyArray<A>) => Effect.Effect<void, ApiRequestError>
	readonly gauge: Metric.Gauge<number>
	/** Plural noun for log lines, e.g. `scrape results`. */
	readonly noun: string
}): Effect.Effect<BatchReporterApi<A>> =>
	Effect.gen(function* () {
		const { deliver, gauge, noun } = options
		const queue = yield* Queue.sliding<A>(MAX_BUFFERED_RESULTS)

		// The batch under delivery has left the queue but is still undelivered.
		const inFlight = yield* Ref.make(0)
		const pending = Effect.map(Ref.get(inFlight), (held) => held + Queue.sizeUnsafe(queue))
		const publishGauge = Effect.flatMap(pending, (count) => Metric.update(gauge, count))

		const record = (report: A) => Queue.offer(queue, report).pipe(Effect.andThen(publishGauge))

		const finalFlush = (held: ReadonlyArray<A>) =>
			Effect.gen(function* () {
				const all = [...held, ...(yield* Queue.clear(queue))]
				yield* Effect.forEach(Arr.chunksOf(all, REPORT_BATCH_SIZE), deliver, { discard: true })
			}).pipe(
				Effect.timeout(FINAL_FLUSH_TIMEOUT),
				Effect.catch((error) =>
					Effect.logWarning(`Dropped unreported ${noun} on shutdown`).pipe(
						Effect.annotateLogs({ error: error.message }),
					),
				),
			)

		const deliverNext = Effect.gen(function* () {
			const batch = yield* Queue.takeBetween(queue, 1, REPORT_BATCH_SIZE)
			yield* Ref.set(inFlight, batch.length)
			yield* deliver(batch).pipe(
				Effect.tapError((error) =>
					Effect.logWarning(`Failed to report ${noun}, retrying`).pipe(
						Effect.annotateLogs({ error: error.message, batchSize: batch.length }),
					),
				),
				Effect.retry(RETRY),
				// RETRY never ends; this only types the channel if it ever gains a limit.
				Effect.catch((error) =>
					Effect.logWarning(`Dropped ${noun} after retries`).pipe(
						Effect.annotateLogs({ error: error.message, batchSize: batch.length }),
					),
				),
				Effect.onInterrupt(() => finalFlush(batch)),
				Effect.ensuring(Ref.set(inFlight, 0).pipe(Effect.andThen(publishGauge))),
			)
			if (batch.length < REPORT_BATCH_SIZE) yield* Effect.sleep(REPORT_INTERVAL)
		})

		const run = Effect.forever(deliverNext).pipe(Effect.onInterrupt(() => finalFlush([])))

		return { record, pending, run } satisfies BatchReporterApi<A>
	})

export class ResultReporter extends Context.Service<ResultReporter, ResultReporterApi>()(
	"@maple/scraper/ResultReporter",
	{
		make: Effect.gen(function* () {
			const api = yield* ApiClient
			return yield* makeBatchReporter<ScrapeResultReport>({
				deliver: api.reportResults,
				gauge: bufferedResults,
				noun: "scrape results",
			})
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}

/** Uptime check outcomes, delivered to `/api/internal/uptime-results` like scrape results. */
export class UptimeReporter extends Context.Service<UptimeReporter, BatchReporterApi<UptimeCheckReport>>()(
	"@maple/scraper/UptimeReporter",
	{
		make: Effect.gen(function* () {
			const api = yield* ApiClient
			return yield* makeBatchReporter<UptimeCheckReport>({
				deliver: api.reportUptimeResults,
				gauge: bufferedUptimeResults,
				noun: "uptime check results",
			})
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
