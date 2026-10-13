import { Context, Duration, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { countDataPoints, splitExportRequest, type OtlpExportRequest } from "@maple/prometheus-otlp"
import { ScraperEnv } from "./Env"
import { scrapeError, withScrapeSpan, type ScrapeError } from "./ScrapeError"

export interface OtlpIngestApi {
	/**
	 * Send an OTLP/JSON metrics export through the Maple ingest gateway with the
	 * target org's public ingest key, so it is billed and warehouse-routed like
	 * customer traffic. Exports over `SCRAPER_OTLP_MAX_DATA_POINTS` go out in
	 * chunks; delivery stops at the first rejected chunk, earlier ones stay delivered.
	 * A 402 (billing limit) fails as `delivery_blocked`.
	 */
	readonly send: (ingestKey: string, request: OtlpExportRequest) => Effect.Effect<void, ScrapeError>
}

// `FetchHttpClient` sets no timeout, and a scrape holds a concurrency permit
// through delivery: a gateway that never answers would otherwise pin permits.
const REQUEST_TIMEOUT = Duration.seconds(30)

export class OtlpIngest extends Context.Service<OtlpIngest, OtlpIngestApi>()("@maple/scraper/OtlpIngest", {
	make: Effect.gen(function* () {
		const env = yield* ScraperEnv
		const client = yield* HttpClient.HttpClient

		const sendChunk = (ingestKey: string, chunk: OtlpExportRequest, index: number, count: number) =>
			Effect.gen(function* () {
				const request = HttpClientRequest.post(`${env.MAPLE_INGEST_URL}/v1/metrics`, {
					headers: { authorization: `Bearer ${ingestKey}` },
				}).pipe(HttpClientRequest.bodyText(JSON.stringify(chunk), "application/json"))

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
			}).pipe(
				withScrapeSpan("OtlpIngest.send_chunk", {
					attributes: { "maple.otlp.chunk_index": index, "maple.otlp.chunk_count": count },
				}),
			)

		const send = (ingestKey: string, request: OtlpExportRequest) =>
			Effect.gen(function* () {
				const chunks = splitExportRequest(request, env.SCRAPER_OTLP_MAX_DATA_POINTS)
				yield* Effect.annotateCurrentSpan({
					"maple.otlp.data_points": countDataPoints(request),
					"maple.otlp.chunk_count": chunks.length,
				})
				// Sequential, stopping at the first rejected chunk.
				yield* Effect.forEach(
					chunks,
					(chunk, index) =>
						sendChunk(ingestKey, chunk, index, chunks.length).pipe(
							Effect.tapError(() =>
								Effect.annotateCurrentSpan("maple.otlp.chunks_delivered", index),
							),
						),
					{ discard: true },
				)
				yield* Effect.annotateCurrentSpan("maple.otlp.chunks_delivered", chunks.length)
			}).pipe(withScrapeSpan("OtlpIngest.send"))

		return { send } satisfies OtlpIngestApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
