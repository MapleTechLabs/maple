/**
 * PlanetScale management API through `@distilled.cloud/planetscale`. SDK failures fold into
 * the integration taxonomy: a 401 is {@link PlanetScaleTokenRejectedError} (the caller decides
 * whether to refresh or stamp the grant revoked), a 403 is a revoked authorization for that
 * resource, and everything else is an upstream failure carrying its HTTP status.
 *
 * The SDK validates responses leniently by default: a 2xx body comes back as read, typed as the
 * full output shape. Callers decode the fields they consume with {@link decodeConsumed}.
 */
import * as PlanetScale from "@distilled.cloud/planetscale"
import { IntegrationsRevokedError, IntegrationsUpstreamError } from "@maple/domain/http"
import { Duration, Effect, Layer, Schema, Stream } from "effect"
import { HttpClient } from "effect/http"

const REQUEST_TIMEOUT = Duration.seconds(15)
/** Tagged onto timeouts so pollers can tell "PlanetScale is slow" from a rejection. */
export const PLANETSCALE_TIMEOUT_STATUS = 504

/** PlanetScale answered 401 for this access token. Never leaves the PlanetScale services. */
export class PlanetScaleTokenRejectedError extends Schema.TaggedError<PlanetScaleTokenRejectedError>()(
	"@maple/api/integrations/PlanetScaleTokenRejectedError",
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
	| IntegrationsRevokedError
	| IntegrationsUpstreamError

const STATUS_BY_TAG: Record<string, number> = Object.fromEntries(
	Object.entries(PlanetScale.HTTP_STATUS_MAP).map(([status, error]) => [error.name, Number(status)]),
)

const toApiError =
	(operation: string) =>
	(error: SdkError): PlanetScaleApiError => {
		if (error._tag === "Unauthorized") {
			return new PlanetScaleTokenRejectedError({
				message: `PlanetScale rejected the authorization (HTTP 401) for ${operation} — reconnect the integration`,
			})
		}
		if (error._tag === "Forbidden") {
			return new IntegrationsRevokedError({
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

/** Run one SDK call (or a pipeline of them) with the given OAuth token over `httpClient`. */
export const runPlanetScale = <A, E extends SdkError>(
	httpClient: HttpClient.HttpClient,
	target: PlanetScaleApiTarget,
	operation: string,
	effect: Effect.Effect<A, E, PlanetScale.PlanetScaleOpContext>,
): Effect.Effect<A, PlanetScaleApiError> =>
	effect.pipe(
		Effect.mapError(toApiError(operation)),
		Effect.timeoutOrElse({
			duration: REQUEST_TIMEOUT,
			orElse: () =>
				Effect.fail(
					new IntegrationsUpstreamError({
						message: `PlanetScale API request timed out: ${operation}`,
						status: PLANETSCALE_TIMEOUT_STATUS,
					}),
				),
		}),
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
				Layer.succeed(HttpClient.HttpClient, httpClient),
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
