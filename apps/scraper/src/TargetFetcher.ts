import { Context, Effect, Layer, Option } from "effect"
import { FetchHttpClient } from "effect/http"
import type { InternalScrapeTarget } from "@maple/domain/http"
import { safeFetch, UrlValidationError } from "@maple/safe-fetch"
import { classifyTargetStatus } from "./policy"
import { scrapeError, type ScrapeError } from "./ScrapeError"

interface TargetResponse {
	readonly status: number
	readonly body: string
	/** Upstream `Retry-After` in seconds (delta-seconds form), or `null` when absent. */
	readonly retryAfterSeconds: number | null
}

export interface TargetFetcherApi {
	/**
	 * GET a target's exposition text from `target.scrapeUrl` with `target.authHeaders`.
	 * Failure messages are fragments; the scraper prefixes the target's identity.
	 */
	readonly fetch: (target: InternalScrapeTarget) => Effect.Effect<string, ScrapeError>
}

/**
 * Per-request ceiling. The scrape interval bounds it so one scrape can never
 * overlap the next; the 60s cap keeps a slow upstream (PlanetScale metrics
 * under load) from parking a permit for a whole 300s interval.
 */
export const scrapeTimeoutMs = (scrapeIntervalSeconds: number): number =>
	Math.min(60_000, Math.max(1_000, (scrapeIntervalSeconds - 1) * 1000))

/** Parse a `Retry-After` header value, honoring only the delta-seconds form. */
export const parseRetryAfterSeconds = (value: string | null): number | null => {
	if (value === null) return null
	const seconds = Number(value.trim())
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

const DEFAULT_HEADERS = {
	accept: "application/openmetrics-text;version=1.0.0,text/plain;version=0.0.4;q=0.5,*/*;q=0.1",
	"user-agent": "maple-prometheus-scraper",
} as const

export class TargetFetcher extends Context.Service<TargetFetcher, TargetFetcherApi>()(
	"@maple/scraper/TargetFetcher",
	{
		make: Effect.gen(function* () {
			// `server.address` + `url.path`, never `url.full`: PlanetScale authenticates
			// its metrics data plane with `?sig=&exp=` query params, i.e. credentials.
			// `pathname` drops the query, so the signed URL cannot leak into telemetry.
			//
			// `peer.service` is deliberately low-cardinality (two values, not one per
			// target) — a per-target name would fragment the service map into a node
			// per scrape target.
			const fetchTarget = Effect.fn("scraper.fetch_target", { kind: "client" })(function* (
				target: InternalScrapeTarget,
			) {
				const fetchFn = yield* FetchHttpClient.Fetch
				const parsed = Option.liftThrowable(() => new URL(target.scrapeUrl))()
				// Annotated before the fetch so a failed or timed-out scrape still
				// draws its service-map edge.
				yield* Effect.annotateCurrentSpan({
					"peer.service":
						target.targetType === "planetscale" ? "planetscale-metrics" : "scrape-target",
					"http.request.method": "GET",
					"maple.scrape.target_type": target.targetType,
					...(Option.isSome(parsed)
						? { "server.address": parsed.value.host, "url.path": parsed.value.pathname }
						: undefined),
				})

				// `safeFetch` supplies the SSRF protection + per-hop redirect re-validation
				// the Effect HttpClient transport lacks. The interruption-aware signal from
				// `Effect.tryPromise` plus `Effect.timeout` aborts the in-flight request
				// when the ceiling passes.
				const result = yield* Effect.tryPromise({
					try: async (signal) => {
						const response = await safeFetch(target.scrapeUrl, {
							method: "GET",
							headers: { ...DEFAULT_HEADERS, ...target.authHeaders },
							signal,
							fetchFn,
						})
						return {
							status: response.status,
							body: await response.text(),
							retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("retry-after")),
						} satisfies TargetResponse
					},
					// A URL failing SSRF validation is a config fault no cadence clears; an
					// unreachable or stalled target backs off like an upstream 5xx.
					catch: (cause) =>
						cause instanceof UrlValidationError
							? scrapeError({
									message: `url rejected: ${cause.message}`,
									reason: "scrape_failed",
								})
							: scrapeError({
									message: `request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
									reason: "target_error",
								}),
				}).pipe(
					Effect.timeout(scrapeTimeoutMs(target.scrapeIntervalSeconds)),
					Effect.catchTag("TimeoutError", () =>
						Effect.fail(scrapeError({ message: "request timed out", reason: "target_error" })),
					),
				)

				yield* Effect.annotateCurrentSpan({
					"http.response.status_code": result.status,
					// Decoded character count, not wire bytes — hence the vendor
					// namespace rather than `http.response.body.size`.
					"maple.scrape.response_chars": result.body.length,
				})
				return result
			})

			// Classified outside the client span: a target's 4xx/5xx answer leaves
			// `scraper.fetch_target` Ok, the scrape span carries the failure.
			const fetch = (target: InternalScrapeTarget) =>
				fetchTarget(target).pipe(
					Effect.flatMap((response) =>
						response.status >= 200 && response.status < 300
							? Effect.succeed(response.body)
							: Effect.fail(
									scrapeError({
										message: `returned HTTP ${response.status}`,
										reason: classifyTargetStatus(response.status),
										statusCode: response.status,
										retryAfterMs:
											response.retryAfterSeconds === null
												? null
												: response.retryAfterSeconds * 1000,
									}),
								),
					),
				)

			return { fetch } satisfies TargetFetcherApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
