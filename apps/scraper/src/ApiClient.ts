import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { InternalScrapeTargetList, type InternalScrapeTarget, type ScrapeResultReport } from "@maple/domain/http"
import { ScraperEnv } from "./Env"

export class ApiRequestError extends Schema.TaggedErrorClass<ApiRequestError>()("@maple/scraper/ApiRequestError", {
	message: Schema.String,
	status: Schema.NullOr(Schema.Number),
}) {}

export interface ScrapeProxyResponse {
	readonly status: number
	readonly body: string
}

export interface ApiClientShape {
	/** Enabled scrape targets from `/api/internal/scrape-targets`. */
	readonly listTargets: () => Effect.Effect<ReadonlyArray<InternalScrapeTarget>, ApiRequestError>
	/**
	 * Fetch a target's exposition text through the API-side proxy. The proxy
	 * decrypts credentials and applies SSRF protection; `status` is the
	 * upstream target's HTTP status.
	 */
	readonly scrapeTarget: (targetId: string) => Effect.Effect<ScrapeProxyResponse, ApiRequestError>
	/** Report scrape outcomes to `/api/internal/scrape-results`. */
	readonly reportResults: (results: ReadonlyArray<ScrapeResultReport>) => Effect.Effect<void, ApiRequestError>
}

const decodeTargets = Schema.decodeUnknownEffect(InternalScrapeTargetList)

export class ApiClient extends Context.Service<ApiClient, ApiClientShape>()("@maple/scraper/ApiClient", {
	make: Effect.gen(function* () {
		const env = yield* ScraperEnv
		const client = yield* HttpClient.HttpClient

		const authHeaders = {
			authorization: `Bearer ${Redacted.value(env.SD_INTERNAL_TOKEN)}`,
		}

		const transportError = (error: { readonly message: string }) =>
			new ApiRequestError({ message: `Maple API unreachable: ${error.message}`, status: null })

		const listTargets = Effect.fn("ApiClient.listTargets")(function* () {
			const request = HttpClientRequest.get(`${env.MAPLE_API_URL}/api/internal/scrape-targets`, {
				headers: authHeaders,
			})
			const response = yield* client.execute(request).pipe(Effect.mapError(transportError))
			const text = yield* response.text.pipe(Effect.mapError(transportError))
			if (response.status < 200 || response.status >= 300) {
				return yield* Effect.fail(
					new ApiRequestError({
						message: `scrape-targets returned HTTP ${response.status}: ${text.slice(0, 200)}`,
						status: response.status,
					}),
				)
			}
			return yield* Effect.try({
				try: () => JSON.parse(text) as unknown,
				catch: () => new ApiRequestError({ message: "scrape-targets returned invalid JSON", status: null }),
			}).pipe(
				Effect.flatMap((json) =>
					decodeTargets(json).pipe(
						Effect.mapError(
							(error) =>
								new ApiRequestError({
									message: `scrape-targets payload mismatch: ${error.message}`,
									status: null,
								}),
						),
					),
				),
			)
		})

		const scrapeTarget = Effect.fn("ApiClient.scrapeTarget")(function* (targetId: string) {
			const request = HttpClientRequest.get(
				`${env.MAPLE_API_URL}/api/internal/prometheus-scrape?targetId=${encodeURIComponent(targetId)}`,
				{ headers: authHeaders },
			)
			const response = yield* client.execute(request).pipe(Effect.mapError(transportError))
			const body = yield* response.text.pipe(Effect.mapError(transportError))
			return { status: response.status, body } satisfies ScrapeProxyResponse
		})

		const reportResults = Effect.fn("ApiClient.reportResults")(function* (
			results: ReadonlyArray<ScrapeResultReport>,
		) {
			if (results.length === 0) return
			const request = HttpClientRequest.post(`${env.MAPLE_API_URL}/api/internal/scrape-results`, {
				headers: authHeaders,
			}).pipe(HttpClientRequest.bodyText(JSON.stringify(results), "application/json"))
			const response = yield* client.execute(request).pipe(Effect.mapError(transportError))
			if (response.status < 200 || response.status >= 300) {
				return yield* Effect.fail(
					new ApiRequestError({
						message: `scrape-results returned HTTP ${response.status}`,
						status: response.status,
					}),
				)
			}
		})

		return { listTargets, scrapeTarget, reportResults } satisfies ApiClientShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
