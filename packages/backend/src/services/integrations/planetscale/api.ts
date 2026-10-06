/**
 * PlanetScale management API through `@distilled.cloud/planetscale`. SDK failures fold into
 * the integration taxonomy: a 401 is {@link PlanetScaleTokenRejectedError} (the caller decides
 * whether to refresh or stamp the grant revoked), a 403 is {@link PlanetScaleForbiddenError}, and
 * everything else is an upstream failure carrying its HTTP status.
 *
 * The SDK validates responses leniently by default: a 2xx body comes back as read, typed as the
 * full output shape. Callers decode the fields they consume with {@link decodeConsumed}.
 */
import * as PlanetScale from "@distilled.cloud/planetscale"
import { IntegrationsUpstreamError } from "@maple/domain/http"
import { Duration, Effect, Layer, Schedule, Schema, Stream } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"

/** Per HTTP request, body included, so a paginated listing gets the budget once per page. */
const REQUEST_TIMEOUT = Duration.seconds(15)
const REQUEST_RETRY_BASE_DELAY = Duration.millis(500)
const TIMED_OUT = "PlanetScale request timed out"
/** Tagged onto timeouts so pollers can tell "PlanetScale is slow" from a rejection. */
export const PLANETSCALE_TIMEOUT_STATUS = 504

/** PlanetScale answered 401 for this access token. Never leaves the PlanetScale services. */
export class PlanetScaleTokenRejectedError extends Schema.TaggedError<PlanetScaleTokenRejectedError>()(
	"@maple/api/integrations/PlanetScaleTokenRejectedError",
	{ message: Schema.String },
) {}

const isRequestTimeout = (error: unknown) =>
	HttpClientError.isHttpClientError(error) &&
	error.reason._tag === "TransportError" &&
	error.reason.description === TIMED_OUT

/**
 * Bound each request (headers and body) by {@link REQUEST_TIMEOUT}, retrying a timed-out one
 * `timeoutRetries` times. The body is buffered here because the SDK reads it after the response
 * effect this wraps has already succeeded.
 */
const withRequestTimeout = (httpClient: HttpClient.HttpClient, timeoutRetries: number) =>
	HttpClient.transform(httpClient, (response, request) =>
		response.pipe(
			Effect.flatMap((res) =>
				Effect.map(res.arrayBuffer, (body) =>
					HttpClientResponse.fromWeb(
						request,
						new Response(body.byteLength === 0 ? null : body, {
							status: res.status,
							headers: new Headers(Object.entries(res.headers)),
						}),
					),
				),
			),
			Effect.timeoutOrElse({
				duration: REQUEST_TIMEOUT,
				orElse: () =>
					Effect.fail(
						new HttpClientError.HttpClientError({
							reason: new HttpClientError.TransportError({ request, description: TIMED_OUT }),
						}),
					),
			}),
			Effect.retry({
				while: isRequestTimeout,
				times: timeoutRetries,
				schedule: Schedule.exponential(REQUEST_RETRY_BASE_DELAY).pipe(Schedule.jittered),
			}),
		),
	)

/**
 * PlanetScale answered 403: the grant works but lacks access to this resource (a missing scope,
 * an org it was not granted). Callers decide whether that means reconnect or a soft empty state.
 */
export class PlanetScaleForbiddenError extends Schema.TaggedError<PlanetScaleForbiddenError>()(
	"@maple/api/integrations/PlanetScaleForbiddenError",
	{ message: Schema.String },
) {}

export const isPlanetScaleTokenRejected = (error: unknown): error is PlanetScaleTokenRejectedError =>
	error instanceof PlanetScaleTokenRejectedError

/**
 * Any failure an SDK operation declares. Each operation's error union holds its own generated
 * per-status classes, which share `_tag`s with the core HTTP errors; all of them are `Error`s.
 */
export type SdkError = { readonly _tag: string; readonly message: string }

export type PlanetScaleApiError =
	| PlanetScaleTokenRejectedError
	| PlanetScaleForbiddenError
	| IntegrationsUpstreamError

const STATUS_BY_TAG: Record<string, number> = Object.fromEntries(
	Object.entries(PlanetScale.HTTP_STATUS_MAP).map(([status, error]) => [error.name, Number(status)]),
)

const toApiError =
	(operation: string) =>
	(error: SdkError): PlanetScaleApiError => {
		if (isRequestTimeout(error)) {
			return new IntegrationsUpstreamError({
				message: `PlanetScale API request timed out: ${operation}`,
				status: PLANETSCALE_TIMEOUT_STATUS,
			})
		}
		if (error._tag === "Unauthorized") {
			return new PlanetScaleTokenRejectedError({
				message: `PlanetScale rejected the authorization (HTTP 401) for ${operation} — reconnect the integration`,
			})
		}
		if (error._tag === "Forbidden") {
			return new PlanetScaleForbiddenError({
				message: `PlanetScale rejected the authorization (HTTP 403) for ${operation} — reconnect the integration`,
			})
		}
		const status = STATUS_BY_TAG[error._tag]
		const detail = error.message === "" ? "" : `: ${error.message}`
		return new IntegrationsUpstreamError({
			message: `PlanetScale API ${operation} failed (${error._tag})${detail}`.slice(0, 500),
			...(status === undefined ? undefined : { status }),
			cause: error,
		})
	}

export interface PlanetScaleApiTarget {
	/** `MAPLE_PLANETSCALE_API_BASE_URL`, without the `/v1` prefix. */
	readonly apiBaseUrl: string
	readonly accessToken: string
}

/**
 * Run one SDK call (or a pipeline of them, e.g. a paginated listing) with the given OAuth token
 * over `httpClient`. Timeouts apply per request; `timeoutRetries` re-sends only the request that
 * timed out, never the pages before it.
 */
export const runPlanetScale = <A, E extends SdkError>(
	httpClient: HttpClient.HttpClient,
	target: PlanetScaleApiTarget,
	operation: string,
	effect: Effect.Effect<A, E, PlanetScale.PlanetScaleOpContext>,
	options: { readonly timeoutRetries?: number } = {},
): Effect.Effect<A, PlanetScaleApiError> =>
	effect.pipe(
		Effect.mapError(toApiError(operation)),
		// The token is per org, so this cannot be hoisted into the static service graph.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(
			Layer.mergeAll(
				PlanetScale.fromOAuth({
					accessToken: target.accessToken,
					// Operations take the organization in their input; this field is unused.
					organization: "",
					apiBaseUrl: `${target.apiBaseUrl.replace(/\/$/, "")}/v1`,
				}),
				Layer.succeed(
					HttpClient.HttpClient,
					withRequestTimeout(httpClient, options.timeoutRetries ?? 0),
				),
				// The SDK's default policy retries 5xx and 429 until our timeout fires; callers own
				// retries (pollers re-run every tick), so an HTTP error surfaces at once.
				Layer.succeed(PlanetScale.Retry.Retry, { while: () => false }),
			),
		),
		Effect.annotateSpans("peer.service", "planetscale"),
	)

interface PageNumberPaginated<I, Item, E> {
	readonly pages: (
		input: I,
	) => Stream.Stream<
		{ readonly data: ReadonlyArray<Item>; readonly next_page: number | null },
		E,
		PlanetScale.PlanetScaleOpContext
	>
}

/**
 * Every page of a list operation, bounded by `maxPages`. `complete` is false when the bound
 * was hit with pages left: the listing was truncated, so callers must not reconcile deletions
 * or advance watermarks past it.
 */
export const collectPages = <I, Item, E>(
	operation: PageNumberPaginated<I, Item, E>,
	input: I & { readonly per_page?: number },
	maxPages: number,
) =>
	operation.pages(input).pipe(
		Stream.take(maxPages),
		Stream.runCollect,
		Effect.map((pages) => {
			const last = pages.at(-1)
			return {
				items: pages.flatMap((page) => page.data),
				// Lenient bodies may omit `next_page`; the SDK stops paging on it either way.
				complete: last === undefined || last.next_page == null,
			}
		}),
	)

/** Decode the fields a caller reads from a lenient SDK response, as an upstream failure. */
export const decodeConsumed =
	<S extends Schema.Decoder<unknown>>(schema: S, what: string) =>
	(value: unknown): Effect.Effect<S["Type"], IntegrationsUpstreamError> =>
		Schema.decodeUnknownEffect(schema)(value).pipe(
			Effect.mapError(
				(cause) =>
					new IntegrationsUpstreamError({
						message: `PlanetScale API returned an unexpected payload for ${what}`,
						cause,
					}),
			),
		)
