import { Array as Arr, Context, Duration, Effect, Layer, Metric, Queue, Ref, Result, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ScraperEnv } from "./Env"
import { bufferedUptimeSpans } from "./Metrics"
import { executeAttempt, isTransientStatus, TRANSIENT_RETRY } from "./retry"
import { encodeTraceExport, type UptimeCheckSpan } from "./UptimeSpans"

/** Oldest spans drop first while ingest is unreachable; a check result never waits on export. */
const MAX_BUFFERED_SPANS = 20_000
/** Spans drained per flush; a full drain flushes again at once instead of waiting. */
export const SPAN_FLUSH_BATCH = 2_000
/** Steady state: one POST per org per interval. */
export const SPAN_FLUSH_INTERVAL = Duration.seconds(5)
const REQUEST_TIMEOUT = Duration.seconds(30)
const FINAL_FLUSH_TIMEOUT = Duration.seconds(5)
const ORG_CONCURRENCY = 8

export class UptimeSpanExportError extends Schema.TaggedError<UptimeSpanExportError>()(
	"@maple/scraper/UptimeSpanExportError",
	{
		message: Schema.String,
		status: Schema.NullOr(Schema.Number),
	},
) {}

export interface UptimeSpanExporterApi {
	/** Buffer a check span. Never blocks and never fails. */
	readonly record: (check: UptimeCheckSpan) => Effect.Effect<void>
	readonly pending: Effect.Effect<number>
	/** Flush buffered spans as OTLP/JSON, one request per org (ingest key) per flush. */
	readonly run: Effect.Effect<never>
}

export class UptimeSpanExporter extends Context.Service<UptimeSpanExporter, UptimeSpanExporterApi>()(
	"@maple/scraper/UptimeSpanExporter",
	{
		make: Effect.gen(function* () {
			const env = yield* ScraperEnv
			const client = yield* HttpClient.HttpClient
			const queue = yield* Queue.sliding<UptimeCheckSpan>(MAX_BUFFERED_SPANS)

			// The batch being posted (or retried) has left the queue but is not delivered yet.
			const inFlight = yield* Ref.make(0)
			const pending = Effect.map(Ref.get(inFlight), (held) => held + Queue.sizeUnsafe(queue))
			const publishGauge = Effect.flatMap(pending, (count) => Metric.update(bufferedUptimeSpans, count))

			const record = (check: UptimeCheckSpan) =>
				Queue.offer(queue, check).pipe(Effect.andThen(publishGauge))

			const post = (ingestKey: string, checks: ReadonlyArray<UptimeCheckSpan>) =>
				Effect.gen(function* () {
					const request = HttpClientRequest.post(`${env.MAPLE_INGEST_URL}/v1/traces`, {
						headers: { authorization: `Bearer ${ingestKey}` },
					}).pipe(
						HttpClientRequest.bodyText(
							JSON.stringify(encodeTraceExport(checks)),
							"application/json",
						),
					)
					// Drained either way, so the connection goes back to the pool.
					const { status, text } = yield* executeAttempt(
						client,
						request,
						{ peerService: "ingest", timeout: REQUEST_TIMEOUT },
						(response) =>
							response.text.pipe(
								Effect.timeout(REQUEST_TIMEOUT),
								Effect.orElseSucceed(() => ""),
								Effect.map((text) => ({ status: response.status, text })),
							),
					).pipe(
						Effect.mapError(
							(error) =>
								new UptimeSpanExportError({
									message: `ingest gateway unreachable: ${error.message}`,
									status: null,
								}),
						),
					)
					if (status >= 200 && status < 300) return
					return yield* new UptimeSpanExportError({
						message: `ingest gateway returned HTTP ${status}: ${text.slice(0, 200)}`,
						status,
					})
				}).pipe(
					Effect.retry({
						schedule: TRANSIENT_RETRY,
						while: (error) => isTransientStatus(error.status),
					}),
					// Around the retry, so only a dropped batch errors it. A 402 (org over its limit) is
					// expected: it leaves the span as a value and is re-raised outside, so the span stays Ok.
					Effect.map((): Result.Result<void, UptimeSpanExportError> => Result.succeed(undefined)),
					Effect.catchIf(
						(error) => error.status === 402,
						(error) => Effect.succeed(Result.fail(error)),
					),
					Effect.withSpan("UptimeSpanExporter.post", {
						attributes: { "peer.service": "ingest", "maple.uptime.span_count": checks.length },
					}),
					Effect.flatMap(Effect.fromResult),
					// Spans are best effort: a 402 (org over its limit) or an outage drops them, logged.
					Effect.catch((error) =>
						Effect.logWarning("Dropped uptime check spans").pipe(
							Effect.annotateLogs({ error: error.message, spans: checks.length }),
						),
					),
				)

			const flush = (batch: ReadonlyArray<UptimeCheckSpan>) =>
				Effect.forEach(
					Object.entries(Arr.groupBy(batch, (check) => check.ingestKey)),
					([ingestKey, checks]) => post(ingestKey, checks),
					{ concurrency: ORG_CONCURRENCY, discard: true },
				).pipe(Effect.andThen(publishGauge))

			const flushNext = Effect.gen(function* () {
				const batch = yield* Queue.takeBetween(queue, 1, SPAN_FLUSH_BATCH)
				yield* Ref.set(inFlight, batch.length)
				yield* flush(batch).pipe(Effect.onInterrupt(() => finalFlush(batch)))
				yield* Ref.set(inFlight, 0)
				yield* publishGauge
				if (batch.length < SPAN_FLUSH_BATCH) yield* Effect.sleep(SPAN_FLUSH_INTERVAL)
			})

			const finalFlush = (held: ReadonlyArray<UptimeCheckSpan>) =>
				Effect.gen(function* () {
					yield* flush([...held, ...(yield* Queue.clear(queue))])
				}).pipe(Effect.timeout(FINAL_FLUSH_TIMEOUT), Effect.ignore)

			const run = Effect.forever(flushNext).pipe(Effect.onInterrupt(() => finalFlush([])))

			return { record, pending, run } satisfies UptimeSpanExporterApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
