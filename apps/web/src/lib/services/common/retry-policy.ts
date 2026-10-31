import { Effect, Option, Schedule } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, type HttpClientResponse } from "effect/http"

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

export const isIdempotentRequest = (request: HttpClientRequest.HttpClientRequest): boolean =>
	IDEMPOTENT_METHODS.has(request.method.toUpperCase())

/** Retry transport failures only for idempotent requests, excluding client timeouts. */
export const isRetryableTransportError = (error: unknown): boolean => {
	if (!HttpClientError.isHttpClientError(error)) return false
	if (error.reason._tag !== "TransportError") return false
	const cause = error.reason.cause
	if (cause instanceof DOMException && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
		return false
	}
	return isIdempotentRequest(error.request)
}

const isV2Request = (request: HttpClientRequest.HttpClientRequest): boolean => {
	try {
		const pathname = new URL(request.url).pathname
		return pathname === "/v2" || pathname.startsWith("/v2/")
	} catch {
		return false
	}
}

// v2 retryability lives in the decoded public error body. This transport layer
// cannot consume that body without stealing it from HttpApi decoding, so it
// never infers v2 retry behavior from status. `/api` and `/internal` responses
// keep the status-based rule below.
export const isRetryableResponse = (response: HttpClientResponse.HttpClientResponse): boolean =>
	isIdempotentRequest(response.request) &&
	!isV2Request(response.request) &&
	(response.status === 500 || response.status === 502 || response.status === 503)

export const mapleRetrySchedule = Schedule.exponential("300 millis")

// Non-2xx responses are still successes here; retry them before HttpApi decoding.
export const withMapleRetryPolicy = <E, R>(
	client: HttpClient.HttpClient.With<E, R>,
): HttpClient.HttpClient.With<E, R> =>
	HttpClient.transform(client, (requestEffect, request) => {
		if (!isIdempotentRequest(request)) return requestEffect
		const retryResponses = Effect.repeat(requestEffect, {
			times: 3,
			schedule: Schedule.passthrough(mapleRetrySchedule),
			while: isRetryableResponse,
		})
		return Effect.retry(retryResponses, {
			times: 3,
			schedule: mapleRetrySchedule,
			while: isRetryableTransportError,
		})
	})

interface UnauthorizedResignOptions<E, R> {
	readonly shouldRetry: (request: HttpClientRequest.HttpClientRequest) => boolean
	/** Bypasses any token cache: a resend with the token that just got a 401 is pointless. */
	readonly freshToken: Effect.Effect<Option.Option<string>, E, R>
}

/**
 * Re-sends a 401 read, re-signed with a freshly fetched bearer each time. Wrap the signing
 * client: `HttpClient.transform` alone replays the already-signed request.
 */
export const withUnauthorizedResign = <E, R, E2, R2>(
	client: HttpClient.HttpClient.With<E, R>,
	options: UnauthorizedResignOptions<E2, R2>,
): HttpClient.HttpClient.With<E | E2, R | R2> =>
	HttpClient.transform(client, (requestEffect, request) => {
		if (!isIdempotentRequest(request) || !options.shouldRetry(request)) return requestEffect
		const resend = options.freshToken.pipe(
			Effect.map(
				Option.match({
					onNone: () => request,
					onSome: (token) => HttpClientRequest.bearerToken(request, token),
				}),
			),
			Effect.flatMap((signed) => client.postprocess(Effect.succeed(signed))),
		)
		return Effect.flatMap(requestEffect, (response) =>
			response.status === 401
				? Effect.repeat(resend, {
						times: 2,
						schedule: Schedule.passthrough(mapleRetrySchedule),
						while: (retried) => retried.status === 401,
					})
				: Effect.succeed(response),
		)
	})
