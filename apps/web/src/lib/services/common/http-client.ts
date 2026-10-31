import { HttpClient, HttpClientError } from "effect/http"
import { Clock, Duration, Effect } from "effect"
import { noteUnreachable, originOf } from "@maple/web-data/lib/peer-reachability"

const CLIENT_TIMEOUT = Duration.seconds(45)

/**
 * The client-wide request deadline. Timing out the fiber interrupts it, which
 * aborts the in-flight fetch, and the origin is marked unreachable here.
 */
export const withRequestTimeout = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
	HttpClient.transform(client, (effect, request) =>
		effect.pipe(
			Effect.timeoutOrElse({
				duration: CLIENT_TIMEOUT,
				orElse: () =>
					Effect.gen(function* () {
						noteUnreachable(originOf(request.url), yield* Clock.currentTimeMillis)
						const description = `No response within ${Duration.toMillis(CLIENT_TIMEOUT)}ms`
						// A `TimeoutError` cause marks it non-retryable (`isRetryableTransportError`).
						return yield* new HttpClientError.HttpClientError({
							reason: new HttpClientError.TransportError({
								request,
								description,
								cause: new DOMException(description, "TimeoutError"),
							}),
						})
					}),
			}),
		),
	)
