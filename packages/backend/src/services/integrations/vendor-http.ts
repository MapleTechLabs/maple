/**
 * One HTTP wrapper for every vendor API client: status classification, a timeout per attempt,
 * transient retries, `retry-after` on a 429, no redirects, paging, and a Client span that records
 * only the URL path. Each client maps {@link VendorHttpError} to its own errors through `toError`.
 */
import { Clock, Duration, Effect, Option, Redacted, Schedule, Schema, Stream, String as Str } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"
import { parseDeltaSeconds, parseRetryAfterSeconds, VENDOR_TRANSIENT_RETRY } from "./vendor-retry"

export const VendorFailureKind = Schema.Literals([
	"unauthorized",
	"forbidden",
	"not_found",
	"rate_limited",
	"upstream",
	"timeout",
	"invalid_response",
])
export type VendorFailureKind = typeof VendorFailureKind.Type

/** Error bodies kept on a failure, for the client's own message. */
const MAX_ERROR_BODY_CHARS = 2000

export class VendorHttpError extends Schema.TaggedError<VendorHttpError>()(
	"@maple/backend/integrations/VendorHttpError",
	{
		message: Schema.String,
		kind: VendorFailureKind,
		peerService: Schema.String,
		/** What the caller was doing, e.g. `listing projects`. */
		operation: Schema.optionalKey(Schema.String),
		status: Schema.optionalKey(Schema.Number),
		retryAfterSeconds: Schema.optionalKey(Schema.Number),
		/** The answer's body, cut to {@link MAX_ERROR_BODY_CHARS} characters. */
		body: Schema.optionalKey(Schema.String),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

/** A non-2xx answer as the classifier sees it. */
export interface VendorRefusal {
	readonly status: number
	readonly headers: Readonly<Record<string, string | undefined>>
	readonly body: string
}

export type VendorAuth = (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest

export const bearer =
	(token: string | Redacted.Redacted): VendorAuth =>
	(request) =>
		HttpClientRequest.bearerToken(request, Redacted.isRedacted(token) ? Redacted.value(token) : token)

export const noAuth: VendorAuth = (request) => request

export interface VendorHttpOptions<E> {
	readonly httpClient: HttpClient.HttpClient
	/** The `peer.service` registry name, e.g. `vercel`. */
	readonly peerService: string
	readonly baseUrl: string
	readonly auth: VendorAuth
	/** Sent with every request, e.g. `accept`. */
	readonly headers?: Readonly<Record<string, string>>
	/** Overrides the default kind of a non-2xx answer; `undefined` keeps the default. */
	readonly classify?: (refusal: VendorRefusal) => VendorFailureKind | undefined
	readonly toError: (error: VendorHttpError) => E
	/** Per attempt: the answer's headers and, for `json` and `text`, its whole body. */
	readonly timeout: Duration.Input
	/** Transient failures (5xx, transport, timeout); `false` turns retries off. */
	readonly retry?: Schedule.Schedule<unknown> | false
	/** The longest `retry-after` a request waits out before failing as `rate_limited`. */
	readonly maxRetryAfter?: Duration.Input
	/** A delta-seconds header read when `retry-after` is absent, e.g. `x-ratelimit-reset`. */
	readonly rateLimitResetHeader?: string
}

export interface VendorRequest {
	readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
	/** Appended to the base URL; encode path segments yourself. */
	readonly path: string
	readonly query?: Readonly<Record<string, string | undefined>>
	/** Sent as JSON. */
	readonly body?: unknown
	readonly headers?: Readonly<Record<string, string>>
	/** What the caller is doing, for the error message and the span. */
	readonly operation?: string
	/** Retry transient failures. Defaults to true for GET, PUT and DELETE. */
	readonly retry?: boolean
	/** Overrides the client's timeout for this request. */
	readonly timeout?: Duration.Input
}

export interface VendorPaging<S extends Schema.Top, C> {
	readonly request: (cursor: Option.Option<C>) => VendorRequest
	readonly schema: S
	readonly next: (page: S["Type"]) => Option.Option<C>
	readonly maxPages: number
}

export interface VendorHttpClient<E> {
	readonly json: <S extends Schema.Top>(
		schema: S,
		request: VendorRequest,
	) => Effect.Effect<S["Type"], E, S["DecodingServices"]>
	readonly text: (request: VendorRequest) => Effect.Effect<string, E>
	/** The 2xx answer's status and body bytes; a body that never comes is an empty stream. */
	readonly stream: (
		request: VendorRequest,
	) => Effect.Effect<{ readonly status: number; readonly body: Stream.Stream<Uint8Array, E> }, E>
	/** Pages until `next` is none or `maxPages`; `complete` is false when the cap cut it short. */
	readonly paginate: <S extends Schema.Top, C>(
		paging: VendorPaging<S, C>,
	) => Effect.Effect<
		{ readonly pages: ReadonlyArray<S["Type"]>; readonly complete: boolean },
		E,
		S["DecodingServices"]
	>
}

const IDEMPOTENT = new Set(["GET", "PUT", "DELETE"])
const DEFAULT_MAX_RETRY_AFTER = Duration.seconds(10)

const defaultKind = (status: number): VendorFailureKind =>
	status === 401
		? "unauthorized"
		: status === 403
			? "forbidden"
			: status === 404 || status === 410
				? "not_found"
				: status === 429
					? "rate_limited"
					: "upstream"

const isTransient = (error: VendorHttpError) =>
	error.kind === "timeout" ||
	(error.kind === "upstream" && (error.status === undefined || error.status >= 500))

const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

export const make = <E>(options: VendorHttpOptions<E>): VendorHttpClient<E> => {
	const { peerService } = options
	const schedule = options.retry ?? VENDOR_TRANSIENT_RETRY
	const maxRetryAfterSeconds = Duration.toSeconds(options.maxRetryAfter ?? DEFAULT_MAX_RETRY_AFTER)
	const fail = (
		kind: VendorFailureKind,
		message: string,
		request: VendorRequest,
		extra: Partial<Pick<VendorHttpError, "status" | "retryAfterSeconds" | "body" | "cause">> = {},
	) =>
		new VendorHttpError({
			message: `${peerService} ${message}${request.operation === undefined ? "" : ` while ${request.operation}`}`,
			kind,
			peerService,
			...(request.operation === undefined ? undefined : { operation: request.operation }),
			...extra,
		})

	const buildRequest = (request: VendorRequest) => {
		const base = HttpClientRequest.make(request.method ?? "GET")(`${options.baseUrl}${request.path}`)
		// `setUrlParams` skips undefined values.
		const withQuery =
			request.query === undefined ? base : HttpClientRequest.setUrlParams(base, request.query)
		const withHeaders = HttpClientRequest.setHeaders(withQuery, {
			...options.headers,
			...request.headers,
		})
		const withBody =
			request.body === undefined
				? withHeaders
				: HttpClientRequest.bodyJsonUnsafe(withHeaders, request.body)
		return options.auth(withBody)
	}

	const retryAfterOf = (headers: Readonly<Record<string, string | undefined>>, nowMs: number) =>
		Option.orElse(parseRetryAfterSeconds(headers["retry-after"], nowMs), () =>
			options.rateLimitResetHeader === undefined
				? Option.none()
				: parseDeltaSeconds(headers[options.rateLimitResetHeader]),
		)

	/** A non-2xx answer as a classified failure; its body is read for the client's message. */
	const refuse = (request: VendorRequest, response: HttpClientResponse.HttpClientResponse) =>
		Effect.gen(function* () {
			const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
			const refusal = { status: response.status, headers: response.headers, body }
			const kind = options.classify?.(refusal) ?? defaultKind(response.status)
			const nowMs = yield* Clock.currentTimeMillis
			const retryAfter = kind === "rate_limited" ? retryAfterOf(response.headers, nowMs) : Option.none()
			return yield* fail(kind, `answered ${response.status}`, request, {
				status: response.status,
				body: Str.slice(0, MAX_ERROR_BODY_CHARS)(body),
				...Option.match(retryAfter, {
					onNone: () => undefined,
					onSome: (seconds) => ({ retryAfterSeconds: seconds }),
				}),
			})
		})

	/** One attempt: send, refuse a non-2xx, then `read` the 2xx answer, all inside a Client span. */
	const attempt = <A, R>(
		request: VendorRequest,
		read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, VendorHttpError, R>,
	) => {
		const built = buildRequest(request)
		const url = new URL(built.url)
		return Effect.gen(function* () {
			const response = yield* options.httpClient.execute(built).pipe(
				// The span below replaces the client's own, which records the full URL and query.
				Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
				Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
				Effect.mapError((cause) => fail("upstream", "request failed", request, { cause })),
			)
			yield* Effect.annotateCurrentSpan("http.response.status_code", response.status)
			if (response.status < 200 || response.status >= 300) return yield* refuse(request, response)
			return yield* read(response)
		}).pipe(
			Effect.timeoutOrElse({
				duration: request.timeout ?? options.timeout,
				orElse: () => Effect.fail(fail("timeout", "timed out", request)),
			}),
			Effect.tapError((error) => Effect.annotateCurrentSpan("error.type", error.kind)),
			Effect.withSpan(`${built.method} ${peerService}`, {
				kind: "client",
				attributes: {
					"peer.service": peerService,
					"http.request.method": built.method,
					"server.address": url.hostname,
					"url.scheme": Str.slice(0, -1)(url.protocol),
					"url.path": url.pathname,
					...(request.operation === undefined
						? undefined
						: { "maple.vendor.operation": request.operation }),
				},
			}),
		)
	}

	/** Transient retries for idempotent requests, then one wait for a short `retry-after`. */
	const withRetries = <A, R>(request: VendorRequest, effect: Effect.Effect<A, VendorHttpError, R>) => {
		const retryable = request.retry ?? IDEMPOTENT.has(request.method ?? "GET")
		const retried =
			schedule === false || !retryable ? effect : Effect.retry(effect, { schedule, while: isTransient })
		// A 429 means the request was not processed, so even a POST may be sent again.
		return Effect.catchIf(
			retried,
			(error) =>
				error.kind === "rate_limited" &&
				error.retryAfterSeconds !== undefined &&
				error.retryAfterSeconds <= maxRetryAfterSeconds,
			(error) =>
				Effect.sleep(Duration.seconds(error.retryAfterSeconds ?? 0)).pipe(Effect.andThen(retried)),
		)
	}

	const send = <A, R>(
		request: VendorRequest,
		read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, VendorHttpError, R>,
	): Effect.Effect<A, E, R> =>
		withRetries(request, attempt(request, read)).pipe(Effect.mapError(options.toError))

	const readText = (request: VendorRequest) => (response: HttpClientResponse.HttpClientResponse) =>
		response.text.pipe(
			Effect.mapError((cause) => fail("upstream", "answer could not be read", request, { cause })),
		)

	const text = (request: VendorRequest) => send(request, readText(request))

	const decodeWith =
		<S extends Schema.Top>(schema: S, request: VendorRequest) =>
		(body: string) =>
			(body === "" ? Effect.succeed(null) : decodeJsonText(body)).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(schema)),
				Effect.mapError((cause) =>
					fail("invalid_response", "answered with an unexpected body", request, { cause }),
				),
			)

	// The read and decode run inside the attempt's span and timeout.
	const json = <S extends Schema.Top>(schema: S, request: VendorRequest) =>
		send(request, (response) =>
			readText(request)(response).pipe(Effect.flatMap(decodeWith(schema, request))),
		)

	const stream = (request: VendorRequest) =>
		send(request, (response) =>
			Effect.succeed({
				status: response.status,
				body: response.stream.pipe(
					Stream.catch((cause) =>
						// A vendor may answer with no body at all where the listing is empty.
						cause.reason._tag === "EmptyBodyError"
							? Stream.empty
							: Stream.fail(
									options.toError(fail("upstream", "answer broke off", request, { cause })),
								),
					),
				),
			}),
		)

	const paginate = <S extends Schema.Top, C>(paging: VendorPaging<S, C>) => {
		const page = (
			cursor: Option.Option<C>,
			pages: ReadonlyArray<S["Type"]>,
		): Effect.Effect<
			{ readonly pages: ReadonlyArray<S["Type"]>; readonly complete: boolean },
			E,
			S["DecodingServices"]
		> =>
			pages.length >= paging.maxPages
				? Effect.succeed({ pages, complete: false })
				: json(paging.schema, paging.request(cursor)).pipe(
						Effect.flatMap((body) => {
							const next = paging.next(body)
							const all = [...pages, body]
							return Option.isNone(next)
								? Effect.succeed({ pages: all, complete: true })
								: page(next, all)
						}),
					)
		return page(Option.none(), [])
	}

	return { json, text, stream, paginate }
}
