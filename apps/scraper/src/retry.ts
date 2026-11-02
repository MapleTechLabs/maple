import { type Cause, type Duration, Effect, Schedule } from "effect"
import {
	HttpClient,
	type HttpClientError,
	HttpClientRequest,
	type HttpClientResponse,
	HttpTraceContext,
} from "effect/http"

/**
 * Two retries with jittered exponential backoff (about 0.5s, then 1s) for Maple's own outbound
 * calls, so a dropped connection or a deploy's brief 5xx is not reported as a failure.
 */
export const TRANSIENT_RETRY = Schedule.max([
	Schedule.jittered(Schedule.exponential("500 millis")),
	Schedule.recurs(2),
])

/** No status is a transport failure or timeout; 429 and 5xx are the server asking to try again. */
export const isTransientStatus = (status: number | null): boolean =>
	status === null || status === 429 || status >= 500

const disableHttpClientSpan = () => true

type AttemptError = HttpClientError.HttpClientError | Cause.TimeoutError

/**
 * One attempt of a retried call, under a client span that a failure annotates but does not error.
 * Replaces HttpClient's own span, which errors on every failed attempt and so opened an issue for
 * failures the retry recovered from; the caller's span around the retry errors if it gives up.
 * `read` consumes the response inside the span, so a failed body read is recorded on it too.
 */
export const executeAttempt = <A>(
	client: HttpClient.HttpClient,
	request: HttpClientRequest.HttpClientRequest,
	options: { readonly peerService: string; readonly timeout: Duration.Input },
	read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, AttemptError>,
): Effect.Effect<A, AttemptError> => {
	const url = URL.parse(request.url)
	return Effect.useSpan(
		request.method,
		{
			kind: "client",
			attributes: {
				"http.request.method": request.method,
				"peer.service": options.peerService,
				...(url !== null
					? {
							"url.full": `${url.origin}${url.pathname}`,
							"url.path": url.pathname,
							"url.scheme": url.protocol.slice(0, -1),
							"server.address": url.hostname,
						}
					: undefined),
			},
		},
		(span) =>
			client.execute(HttpClientRequest.setHeaders(request, HttpTraceContext.toHeaders(span))).pipe(
				Effect.timeout(options.timeout),
				Effect.tap((response) =>
					Effect.sync(() => span.attribute("http.response.status_code", response.status)),
				),
				Effect.flatMap(read),
				Effect.tapError((error) =>
					Effect.sync(() => {
						span.attribute(
							"error.type",
							error._tag === "HttpClientError" ? error.reason._tag : error._tag,
						)
						span.attribute("maple.attempt.error", error.message)
					}),
				),
				Effect.provideService(HttpClient.TracerDisabledWhen, disableHttpClientSpan),
				Effect.withParentSpan(span),
				// The failure leaves the span as a value, so the span closes Ok.
				Effect.exit,
			),
	).pipe(Effect.flatten)
}
