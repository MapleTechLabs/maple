import { HttpClient, HttpClientError } from "effect/http"
import { Clock, Duration, Effect } from "effect"
import { noteReachable, noteUnreachable, originOf } from "@maple/web-data/lib/peer-reachability"

const CLIENT_TIMEOUT = Duration.seconds(45)

const isTransportError = (error: unknown): boolean =>
	HttpClientError.isHttpClientError(error) && error.reason._tag === "TransportError"

/**
 * The client-wide request deadline. Timing out the fiber interrupts it, which
 * aborts the in-flight fetch.
 *
 * It also keeps the origin's reachability clock (`peer-reachability.ts`): a
 * request that got no response (the deadline included) starts or extends the
 * run of failures, and any response at all, a 500 included, ends it.
 */
export const withRequestTimeout = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
	HttpClient.transform(client, (effect, request) => {
		const origin = originOf(request.url)
		return effect.pipe(
			Effect.timeoutOrElse({
				duration: CLIENT_TIMEOUT,
				orElse: () => {
					const description = `No response within ${Duration.toMillis(CLIENT_TIMEOUT)}ms`
					// A `TimeoutError` cause marks it non-retryable (`isRetryableTransportError`).
					return Effect.fail(
						new HttpClientError.HttpClientError({
							reason: new HttpClientError.TransportError({
								request,
								description,
								cause: new DOMException(description, "TimeoutError"),
							}),
						}),
					)
				},
			}),
			Effect.tap(() => Effect.sync(() => noteReachable(origin))),
			Effect.tapError((error) =>
				isTransportError(error)
					? Effect.map(Clock.currentTimeMillis, (now) => noteUnreachable(origin, now))
					: Effect.void,
			),
		)
	})
