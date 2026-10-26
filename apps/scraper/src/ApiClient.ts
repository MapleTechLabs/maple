import { Context, Duration, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import {
	InternalScrapeTargetList,
	type InternalScrapeTarget,
	type ScrapeResultReport,
} from "@maple/domain/http"
import {
	UptimeCheckReportList,
	UptimeProbeTargetList,
	type UptimeCheckReport,
	type UptimeProbeTarget,
} from "@maple/domain/uptime"
import { ScraperEnv } from "./Env"
import { isTransientStatus, TRANSIENT_RETRY } from "./retry"

export class ApiRequestError extends Schema.TaggedError<ApiRequestError>()("@maple/scraper/ApiRequestError", {
	message: Schema.String,
	status: Schema.NullOr(Schema.Number),
}) {}

export interface ApiClientApi {
	/**
	 * Enabled scrape targets from `/api/internal/scrape-targets`, each carrying
	 * the URL to fetch and its decrypted auth headers (see {@link InternalScrapeTarget}).
	 */
	readonly listTargets: () => Effect.Effect<ReadonlyArray<InternalScrapeTarget>, ApiRequestError>
	/** Report scrape outcomes to `/api/internal/scrape-results`. */
	readonly reportResults: (
		results: ReadonlyArray<ScrapeResultReport>,
	) => Effect.Effect<void, ApiRequestError>
	/** Enabled HTTP, TCP and DNS uptime monitors from `/api/internal/uptime-targets`. */
	readonly listUptimeTargets: () => Effect.Effect<ReadonlyArray<UptimeProbeTarget>, ApiRequestError>
	/** Report uptime check outcomes to `/api/internal/uptime-results`. */
	readonly reportUptimeResults: (
		results: ReadonlyArray<UptimeCheckReport>,
	) => Effect.Effect<void, ApiRequestError>
}

const encodeUptimeReports = Schema.encodeSync(UptimeCheckReportList)
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

/** Not idempotent: a timeout may follow a batch that landed, so only an explicit refusal retries. */
const isRefusal = (status: number | null): boolean => status === 429 || status === 503

export class ApiClient extends Context.Service<ApiClient, ApiClientApi>()("@maple/scraper/ApiClient", {
	make: Effect.gen(function* () {
		const env = yield* ScraperEnv
		const client = yield* HttpClient.HttpClient

		const authHeaders = {
			authorization: `Bearer ${Redacted.value(env.SD_INTERNAL_TOKEN)}`,
		}

		// Bound every API round-trip. `FetchHttpClient` sets no timeout, so a
		// stalled Worker (e.g. an oversized scrape-results POST) would otherwise
		// hang for minutes; cap it so a flush fails fast and re-buffers instead.
		const REQUEST_TIMEOUT = Duration.seconds(30)

		const transportError = (error: { readonly message: string }) =>
			new ApiRequestError({ message: `Maple API unreachable: ${error.message}`, status: null })

		// One round-trip to the body text, retried while `retryable` says the failure is transient.
		const roundTrip = (
			request: HttpClientRequest.HttpClientRequest,
			label: string,
			retryable: (status: number | null) => boolean,
		) =>
			Effect.gen(function* () {
				const response = yield* client
					.execute(request)
					.pipe(
						Effect.annotateSpans("peer.service", "maple-api"),
						Effect.timeout(REQUEST_TIMEOUT),
						Effect.mapError(transportError),
					)
				const text = yield* response.text.pipe(
					Effect.timeout(REQUEST_TIMEOUT),
					Effect.mapError(transportError),
				)
				if (response.status < 200 || response.status >= 300) {
					return yield* new ApiRequestError({
						message: `${label} returned HTTP ${response.status}: ${text.slice(0, 200)}`,
						status: response.status,
					})
				}
				return text
			}).pipe(Effect.retry({ schedule: TRANSIENT_RETRY, while: (error) => retryable(error.status) }))

		// GET a list endpoint and decode it, retried on any transient failure.
		const getList = <A>(label: string, schema: Schema.Decoder<A>) =>
			Effect.gen(function* () {
				const decode = Schema.decodeUnknownEffect(schema)
				const request = HttpClientRequest.get(`${env.MAPLE_API_URL}/api/internal/${label}`, {
					headers: authHeaders,
				})
				const text = yield* roundTrip(request, label, isTransientStatus)
				const json = yield* decodeJson(text).pipe(
					Effect.mapError(
						() =>
							new ApiRequestError({ message: `${label} returned invalid JSON`, status: null }),
					),
				)
				return yield* decode(json).pipe(
					Effect.mapError(
						(error) =>
							new ApiRequestError({
								message: `${label} payload mismatch: ${error.message}`,
								status: null,
							}),
					),
				)
			})

		const postJson = (label: string, body: string) =>
			roundTrip(
				HttpClientRequest.post(`${env.MAPLE_API_URL}/api/internal/${label}`, {
					headers: authHeaders,
				}).pipe(HttpClientRequest.bodyText(body, "application/json")),
				label,
				isRefusal,
			)

		const listTargets = Effect.fn("ApiClient.listTargets")(function* () {
			return yield* getList("scrape-targets", InternalScrapeTargetList)
		})

		const listUptimeTargets = Effect.fn("ApiClient.listUptimeTargets")(function* () {
			return yield* getList("uptime-targets", UptimeProbeTargetList)
		})

		const reportUptimeResults = Effect.fn("ApiClient.reportUptimeResults")(function* (
			results: ReadonlyArray<UptimeCheckReport>,
		) {
			if (results.length === 0) return
			yield* postJson("uptime-results", JSON.stringify(encodeUptimeReports(results)))
		})

		const reportResults = Effect.fn("ApiClient.reportResults")(function* (
			results: ReadonlyArray<ScrapeResultReport>,
		) {
			if (results.length === 0) return
			yield* postJson("scrape-results", JSON.stringify(results))
		})

		return { listTargets, reportResults, listUptimeTargets, reportUptimeResults } satisfies ApiClientApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
