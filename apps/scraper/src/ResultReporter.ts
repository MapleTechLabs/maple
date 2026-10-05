import { Array as Arr, Context, Duration, Effect, Layer, Metric, Queue, Ref, Schedule } from "effect"
import type { ScrapeResultReport } from "@maple/domain/http"
import { ApiClient } from "./ApiClient"
import { bufferedResults } from "./Metrics"

/** Bounds memory while the API is unreachable: the oldest results are dropped first. */
const MAX_BUFFERED_RESULTS = 10_000
/** Max results per POST; one 10k-result body overwhelmed the API Worker (edge 503). */
export const REPORT_BATCH_SIZE = 1_000
/** Pause after a partial batch, so steady state is one POST per interval. */
export const REPORT_INTERVAL = Duration.seconds(10)
const RETRY = Schedule.min([Schedule.exponential(Duration.seconds(1)), Schedule.spaced(Duration.seconds(30))])
const FINAL_FLUSH_TIMEOUT = Duration.seconds(5)

export interface ResultReporterApi {
	readonly record: (report: ScrapeResultReport) => Effect.Effect<void>
	/** Results not yet acknowledged by the API: queued plus the batch in flight. */
	readonly pending: Effect.Effect<number>
	/**
	 * Deliver results to the API in order, retrying a failed batch until it lands.
	 * On interruption, one bounded best-effort flush of everything still held.
	 */
	readonly run: Effect.Effect<never>
}

export class ResultReporter extends Context.Service<ResultReporter, ResultReporterApi>()(
	"@maple/scraper/ResultReporter",
	{
		make: Effect.gen(function* () {
			const api = yield* ApiClient
			const queue = yield* Queue.sliding<ScrapeResultReport>(MAX_BUFFERED_RESULTS)

			// The batch under delivery has left the queue but is still undelivered.
			const inFlight = yield* Ref.make(0)
			const pending = Effect.map(Ref.get(inFlight), (held) => held + Queue.sizeUnsafe(queue))
			const publishGauge = Effect.flatMap(pending, (count) => Metric.update(bufferedResults, count))

			const record = (report: ScrapeResultReport) =>
				Queue.offer(queue, report).pipe(Effect.andThen(publishGauge))

			const finalFlush = (held: ReadonlyArray<ScrapeResultReport>) =>
				Effect.gen(function* () {
					const all = [...held, ...(yield* Queue.clear(queue))]
					yield* Effect.forEach(Arr.chunksOf(all, REPORT_BATCH_SIZE), api.reportResults, {
						discard: true,
					})
				}).pipe(
					Effect.timeout(FINAL_FLUSH_TIMEOUT),
					Effect.catch((error) =>
						Effect.logWarning("Dropped unreported scrape results on shutdown").pipe(
							Effect.annotateLogs({ error: error.message }),
						),
					),
				)

			const deliverNext = Effect.gen(function* () {
				const batch = yield* Queue.takeBetween(queue, 1, REPORT_BATCH_SIZE)
				yield* Ref.set(inFlight, batch.length)
				yield* api.reportResults(batch).pipe(
					Effect.tapError((error) =>
						Effect.logWarning("Failed to report scrape results, retrying").pipe(
							Effect.annotateLogs({ error: error.message, batchSize: batch.length }),
						),
					),
					Effect.retry(RETRY),
					// RETRY never ends; this only types the channel if it ever gains a limit.
					Effect.catch((error) =>
						Effect.logWarning("Dropped scrape results after retries").pipe(
							Effect.annotateLogs({ error: error.message, batchSize: batch.length }),
						),
					),
					Effect.onInterrupt(() => finalFlush(batch)),
					Effect.ensuring(Ref.set(inFlight, 0).pipe(Effect.andThen(publishGauge))),
				)
				if (batch.length < REPORT_BATCH_SIZE) yield* Effect.sleep(REPORT_INTERVAL)
			})

			const run = Effect.forever(deliverNext).pipe(Effect.onInterrupt(() => finalFlush([])))

			return { record, pending, run } satisfies ResultReporterApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
