import { promisify } from "node:util"
import { gzip } from "node:zlib"
import { Context, Duration, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { countDataPoints, encodeExportRequestChunks, type OtlpExportRequest } from "@maple/prometheus-otlp"
import { ScraperEnv } from "./Env"
import { scrapeError, withScrapeSpan, type ScrapeError } from "./ScrapeError"
import { isTransientStatus, TRANSIENT_RETRY } from "./retry"

export interface OtlpIngestApi {
	/**
	 * Send an OTLP/JSON metrics export through the Maple ingest gateway with the
	 * target org's public ingest key, so it is billed and warehouse-routed like
	 * customer traffic. Exports over `SCRAPER_OTLP_MAX_DATA_POINTS` points or
	 * `SCRAPER_OTLP_MAX_BODY_BYTES` go out in gzipped chunks; delivery stops at the
	 * first rejected chunk, earlier ones stay delivered.
	 * A 402 (billing limit) fails as `delivery_blocked`.
	 */
	readonly send: (ingestKey: string, request: OtlpExportRequest) => Effect.Effect<void, ScrapeError>
}

// `FetchHttpClient` sets no timeout, and a scrape holds a concurrency permit
// through delivery: a gateway that never answers would otherwise pin permits.
const REQUEST_TIMEOUT = Duration.seconds(30)

const gzipAsync = promisify(gzip)

// Off the event loop (libuv pool), so compressing a large cycle never stalls other loops.
const compress = (body: Uint8Array) =>
	Effect.tryPromise({
		try: () => gzipAsync(body),
		catch: (cause) => scrapeError({ message: `gzip failed: ${String(cause)}`, reason: "scrape_failed" }),
	})

export class OtlpIngest extends Context.Service<OtlpIngest, OtlpIngestApi>()("@maple/scraper/OtlpIngest", {
	make: Effect.gen(function* () {
		const env = yield* ScraperEnv
		const client = yield* HttpClient.HttpClient

		const sendChunk = (ingestKey: string, body: Uint8Array, index: number, count: number) =>
			Effect.gen(function* () {
				const compressed = yield* compress(body)
				yield* Effect.annotateCurrentSpan({
					"maple.otlp.body_bytes": body.byteLength,
					"maple.otlp.compressed_bytes": compressed.byteLength,
				})
				const request = HttpClientRequest.post(`${env.MAPLE_INGEST_URL}/v1/metrics`, {
					headers: { authorization: `Bearer ${ingestKey}`, "content-encoding": "gzip" },
				}).pipe(HttpClientRequest.bodyUint8Array(compressed, "application/json"))

				const attempt = Effect.gen(function* () {
					const response = yield* client.execute(request).pipe(
						Effect.annotateSpans("peer.service", "ingest"),
						Effect.timeout(REQUEST_TIMEOUT),
						Effect.mapError((error) =>
							scrapeError({
								message: `ingest gateway unreachable: ${error.message}`,
								reason: "scrape_failed",
							}),
						),
					)
					if (response.status >= 200 && response.status < 300) return
					// Bounded too: a stalled body after the status line would outlive the timeout.
					const text = yield* response.text.pipe(
						Effect.timeout(REQUEST_TIMEOUT),
						Effect.orElseSucceed(() => ""),
					)
					return yield* Effect.fail(
						scrapeError({
							message:
								response.status === 402
									? `ingest gateway rejected metrics: billing limit reached (HTTP 402): ${text.slice(0, 200)}`
									: `ingest gateway returned HTTP ${response.status}: ${text.slice(0, 200)}`,
							reason: response.status === 402 ? "delivery_blocked" : "scrape_failed",
							statusCode: response.status,
						}),
					)
				})
				// Inside the chunk span, so only an exhausted retry errors it.
				yield* attempt.pipe(
					Effect.retry({
						schedule: TRANSIENT_RETRY,
						while: (error) => isTransientStatus(error.statusCode),
					}),
				)
			}).pipe(
				withScrapeSpan("OtlpIngest.send_chunk", {
					attributes: { "maple.otlp.chunk_index": index, "maple.otlp.chunk_count": count },
				}),
			)

		const send = (ingestKey: string, request: OtlpExportRequest) =>
			Effect.gen(function* () {
				const bodies = encodeExportRequestChunks(request, {
					maxDataPoints: env.SCRAPER_OTLP_MAX_DATA_POINTS,
					maxBytes: env.SCRAPER_OTLP_MAX_BODY_BYTES,
				})
				yield* Effect.annotateCurrentSpan({
					"maple.otlp.data_points": countDataPoints(request),
					"maple.otlp.resource_count": request.resourceMetrics.length,
					"maple.otlp.chunk_count": bodies.length,
				})
				// Sequential, stopping at the first rejected chunk.
				yield* Effect.forEach(
					bodies,
					(body, index) =>
						sendChunk(ingestKey, body, index, bodies.length).pipe(
							Effect.tapError(() =>
								Effect.annotateCurrentSpan("maple.otlp.chunks_delivered", index),
							),
						),
					{ discard: true },
				)
				yield* Effect.annotateCurrentSpan("maple.otlp.chunks_delivered", bodies.length)
			}).pipe(withScrapeSpan("OtlpIngest.send"))

		return { send } satisfies OtlpIngestApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
