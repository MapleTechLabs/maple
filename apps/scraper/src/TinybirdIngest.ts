import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ScraperEnv } from "./Env"

export class TinybirdIngestError extends Schema.TaggedErrorClass<TinybirdIngestError>()(
	"@maple/scraper/TinybirdIngestError",
	{
		message: Schema.String,
		status: Schema.NullOr(Schema.Number),
	},
) {}

export interface TinybirdIngestShape {
	/** Append rows to a datasource via the Events API (NDJSON, fire-and-forget). */
	readonly ingest: (datasource: string, rows: ReadonlyArray<Record<string, unknown>>) => Effect.Effect<void, TinybirdIngestError>
}

export class TinybirdIngest extends Context.Service<TinybirdIngest, TinybirdIngestShape>()(
	"@maple/scraper/TinybirdIngest",
	{
		make: Effect.gen(function* () {
			const env = yield* ScraperEnv
			const client = yield* HttpClient.HttpClient

			const ingest = Effect.fn("TinybirdIngest.ingest")(function* (
				datasource: string,
				rows: ReadonlyArray<Record<string, unknown>>,
			) {
				if (rows.length === 0) return
				const ndjson = rows.map((row) => JSON.stringify(row)).join("\n")
				const request = HttpClientRequest.post(
					`${env.TINYBIRD_HOST}/v0/events?name=${encodeURIComponent(datasource)}&wait=false`,
					{
						headers: {
							authorization: `Bearer ${Redacted.value(env.TINYBIRD_TOKEN)}`,
						},
					},
				).pipe(HttpClientRequest.bodyText(ndjson, "application/x-ndjson"))

				const response = yield* client.execute(request).pipe(
					Effect.mapError(
						(error) =>
							new TinybirdIngestError({
								message: `Tinybird unreachable: ${error.message}`,
								status: null,
							}),
					),
				)
				if (response.status < 200 || response.status >= 300) {
					const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
					return yield* Effect.fail(
						new TinybirdIngestError({
							message: `Tinybird ingest to ${datasource} returned HTTP ${response.status}: ${text.slice(0, 200)}`,
							status: response.status,
						}),
					)
				}
				yield* Effect.annotateCurrentSpan("rowCount", rows.length)
			})

			return { ingest } satisfies TinybirdIngestShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
