/**
 * A `@distilled.cloud/*` SDK operation under the same rules as {@link VendorHttp.make}: a timeout
 * per attempt, transient retries for idempotent calls, one wait for a short `retry-after`, no
 * redirects, and every failure as a {@link VendorHttpError} that the client maps to its own error.
 * The SDK's own retries are off: the client passes a no-retry policy in `sdk`. The SDK does not
 * check the bodies it returns, so each call decodes the fields Maple reads with its own schema.
 */
import {
	Duration,
	Effect,
	Layer,
	Option,
	Ref,
	type Schedule,
	Schema,
	type Tracer,
	String as Str,
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import * as VendorHttp from "./vendor-http"
import { VENDOR_TRANSIENT_RETRY } from "./vendor-retry"

/** Any failure an SDK operation declares: its own errors, the core HTTP errors and transport errors. */
export interface SdkFailure {
	readonly _tag: string
}

export interface VendorSdkOptions<E, R> {
	readonly httpClient: HttpClient.HttpClient
	/** The `peer.service` registry name, e.g. `vercel`. */
	readonly peerService: string
	/** The SDK's credentials and a retry policy that never retries, provided per call. */
	readonly sdk: Layer.Layer<R>
	/** The status each of the SDK's status errors stands for, e.g. `{ NotFound: 404 }`. */
	readonly statusByTag: Readonly<Record<string, number>>
	readonly toError: (error: VendorHttp.VendorHttpError) => E
	/** Per attempt, the answer's body included. */
	readonly timeout: Duration.Input
	/** Transient failures (5xx, transport, timeout); `false` turns retries off. */
	readonly retry?: Schedule.Schedule<unknown> | false
	readonly maxRetryAfter?: Duration.Input
	/** Also retry an answer that does not decode, for a vendor whose bodies are sometimes cut short. */
	readonly retryInvalidResponse?: boolean
	/** The vendor's words for a refusal, read from the SDK's error; defaults to {@link messageOf}. */
	readonly detail?: (error: SdkFailure, status: number) => string | undefined
	/** A header holding the seconds to wait on a 429 without `retry-after`, e.g. `x-ratelimit-reset`. */
	readonly rateLimitResetHeader?: string
}

export interface VendorSdkCall {
	readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
	/** What the caller is doing, for the error message. */
	readonly operation?: string
	/** Retry transient failures. Defaults to true for GET, PUT and DELETE. */
	readonly retry?: boolean
}

export interface VendorSdkPaging<S extends Schema.Top, C, R> {
	readonly page: (cursor: Option.Option<C>) => Effect.Effect<unknown, SdkFailure, R | HttpClient.HttpClient>
	readonly schema: S
	readonly next: (page: S["Type"]) => Option.Option<C>
	readonly maxPages: number
	readonly operation?: string
}

/** The SDK reads a 3xx body as an answer; a redirect fails here instead, with its status. */
const refuseRedirects = HttpClient.filterStatus((status) => status < 300 || status >= 400)

/**
 * Records the host and path the SDK sent to on the attempt's span, never the query. The span is
 * passed in: inside the SDK call the current span is the SDK's own, which is off.
 */
const recordTarget = (span: Option.Option<Tracer.Span>) =>
	HttpClient.tapRequest((request) =>
		Effect.sync(() => {
			if (Option.isNone(span) || !URL.canParse(request.url)) return
			const url = new URL(request.url)
			span.value.attribute("server.address", url.hostname)
			span.value.attribute("url.scheme", Str.slice(0, -1)(url.protocol))
			span.value.attribute("url.path", url.pathname)
		}),
	)

/** One attempt's answer as it came over the wire; the SDK keeps neither. */
interface Answered {
	readonly status: number | undefined
	readonly empty: boolean
}

/**
 * Records the status the vendor sent (the SDK's error classes share some: 408 and 504 are one) and
 * whether a 2xx body was empty or `null`. The SDK hands those back as `{}`, which a listing schema
 * with optional fields would read as an empty page; here they reach the schema as `null`.
 */
const recordAnswer = (answered: Ref.Ref<Answered>) =>
	HttpClient.transformResponse(
		Effect.flatMap((response: HttpClientResponse.HttpClientResponse) => {
			const { status } = response
			if (status < 200 || status >= 300)
				return Effect.as(Ref.set(answered, { status, empty: false }), response)
			return Effect.flatMap(response.text, (text) => {
				const trimmed = Str.trim(text)
				return Effect.as(
					Ref.set(answered, { status, empty: trimmed === "" || trimmed === "null" }),
					HttpClientResponse.fromWeb(
						response.request,
						new Response(text === "" ? null : text, { status, headers: response.headers }),
					),
				)
			})
		}),
	)

/**
 * The SDK reads the wait of a 429 from `retry-after` only. A vendor that sends it in another header
 * gets it copied into `retry-after`, so the wait still reaches the caller.
 */
const retryAfterFrom = (header: string) =>
	HttpClient.transformResponse(
		Effect.flatMap((response: HttpClientResponse.HttpClientResponse) => {
			const reset = response.headers[header]
			if (
				response.status !== 429 ||
				response.headers["retry-after"] !== undefined ||
				reset === undefined
			) {
				return Effect.succeed(response)
			}
			return Effect.map(response.arrayBuffer, (body) =>
				HttpClientResponse.fromWeb(
					response.request,
					new Response(body.byteLength === 0 ? null : body, {
						status: response.status,
						headers: { ...response.headers, "retry-after": reset },
					}),
				),
			)
		}),
	)

const DEFAULT_MAX_RETRY_AFTER = Duration.seconds(10)

const retryAfterSecondsOf = (error: SdkFailure): number | undefined =>
	"retryAfter" in error && Duration.isDuration(error.retryAfter)
		? Math.ceil(Duration.toSeconds(error.retryAfter))
		: undefined

/** The SDK fills `HTTP <status>` in where the body had no message: that is no vendor message. */
const STATUS_PLACEHOLDER = /^HTTP \d{3}$/

/** The error's message, unless it is empty or only the status the SDK fills in for a body without one. */
export const messageOf = (error: SdkFailure, status: number): string | undefined =>
	"message" in error &&
	typeof error.message === "string" &&
	error.message !== "" &&
	error.message !== String(status) &&
	!STATUS_PLACEHOLDER.test(error.message)
		? error.message
		: undefined

export const make = <E, R>(options: VendorSdkOptions<E, R>) => {
	const { peerService } = options
	const refusing = refuseRedirects(options.httpClient)
	const httpClient =
		options.rateLimitResetHeader === undefined
			? refusing
			: retryAfterFrom(options.rateLimitResetHeader)(refusing)
	const retryPolicy: VendorHttp.VendorRetryPolicy = {
		schedule: options.retry ?? VENDOR_TRANSIENT_RETRY,
		maxRetryAfterSeconds: Duration.toSeconds(options.maxRetryAfter ?? DEFAULT_MAX_RETRY_AFTER),
		...(options.retryInvalidResponse === undefined
			? undefined
			: { retryInvalidResponse: options.retryInvalidResponse }),
	}

	const fail = (
		kind: VendorHttp.VendorFailureKind,
		message: string,
		call: VendorSdkCall,
		extra: Partial<
			Pick<VendorHttp.VendorHttpError, "status" | "retryAfterSeconds" | "detail" | "location" | "cause">
		> = {},
	) =>
		new VendorHttp.VendorHttpError({
			message: `${peerService} ${message}${call.operation === undefined ? "" : ` while ${call.operation}`}`,
			kind,
			peerService,
			...(call.operation === undefined ? undefined : { operation: call.operation }),
			...extra,
		})

	/** An SDK failure as the kit classifies an HTTP one. */
	const classify = (
		error: SdkFailure,
		call: VendorSdkCall,
		answeredStatus: number | undefined,
	): VendorHttp.VendorHttpError => {
		if (HttpClientError.isHttpClientError(error)) {
			const reason = error.reason
			if (reason._tag !== "StatusCodeError")
				return fail("upstream", "request failed", call, { cause: error })
			const location = reason.response.headers["location"]
			return fail("upstream", `answered ${reason.response.status}`, call, {
				status: reason.response.status,
				...(location === undefined ? undefined : { location }),
			})
		}
		if (Str.endsWith("ParseError")(error._tag)) {
			return fail("invalid_response", "answered with an unexpected body", call, { cause: error })
		}
		const declared = "status" in error && typeof error.status === "number" ? error.status : undefined
		// What came over the wire first: the SDK's error classes stand for more than one status.
		const status = answeredStatus ?? declared ?? options.statusByTag[error._tag]
		if (status === undefined) return fail("upstream", "request failed", call, { cause: error })
		const detail = (options.detail ?? messageOf)(error, status)
		const retryAfterSeconds = retryAfterSecondsOf(error)
		return fail(VendorHttp.defaultKind(status), `answered ${status}`, call, {
			status,
			...(detail === undefined ? undefined : { detail }),
			...(retryAfterSeconds === undefined ? undefined : { retryAfterSeconds }),
			cause: error,
		})
	}

	/**
	 * One attempt: the operation over the client, its body decoded by `schema`, within the timeout, in
	 * one Client span. The SDK's own span is off (see {@link VendorHttp.vendorSdkRequestSpan}); this
	 * one records the host and path the SDK sent to, never the query.
	 */
	const attempt = <S extends Schema.Top>(
		schema: S,
		operation: Effect.Effect<unknown, SdkFailure, R | HttpClient.HttpClient>,
		call: VendorSdkCall,
	) =>
		Effect.flatMap(Effect.option(Effect.currentSpan), (span) =>
			attemptIn(span, schema, operation, call),
		).pipe(
			Effect.tapError((error) =>
				Effect.annotateCurrentSpan({
					"error.type": error.kind,
					...(error.status === undefined
						? undefined
						: { "http.response.status_code": error.status }),
				}),
			),
			VendorHttp.vendorSdkRequestSpan(
				"VendorSdk.request",
				peerService,
				(error: VendorHttp.VendorHttpError) =>
					error.kind === "invalid_response" ? undefined : error.kind,
			),
			Effect.annotateSpans({
				"http.request.method": call.method ?? "GET",
				...(call.operation === undefined ? undefined : { "maple.vendor.operation": call.operation }),
			}),
		)

	const attemptIn = <S extends Schema.Top>(
		span: Option.Option<Tracer.Span>,
		schema: S,
		operation: Effect.Effect<unknown, SdkFailure, R | HttpClient.HttpClient>,
		call: VendorSdkCall,
	) =>
		Effect.flatMap(Ref.make<Answered>({ status: undefined, empty: false }), (answered) =>
			operation.pipe(
				Effect.catch((error) =>
					Effect.flatMap(Ref.get(answered), (answer) =>
						Effect.fail(classify(error, call, answer.status)),
					),
				),
				Effect.flatMap((body) =>
					Effect.flatMap(Ref.get(answered), (answer) =>
						Schema.decodeEffect(schema)(answer.empty ? null : (body ?? null)).pipe(
							Effect.mapError((cause) =>
								fail("invalid_response", "answered with an unexpected body", call, { cause }),
							),
						),
					),
				),
				Effect.timeoutOrElse({
					duration: options.timeout,
					orElse: () => Effect.fail(fail("timeout", "timed out", call)),
				}),
				// The credentials are per connection, so this cannot be hoisted into the static service graph.
				Effect.provide([
					options.sdk,
					Layer.succeed(
						HttpClient.HttpClient,
						recordTarget(span)(recordAnswer(answered)(httpClient)),
					),
				]),
				// A redirect is not the vendor answering: the token is never followed to another host.
				Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
			),
		)

	const call = <S extends Schema.Top>(
		schema: S,
		operation: Effect.Effect<unknown, SdkFailure, R | HttpClient.HttpClient>,
		request: VendorSdkCall = {},
	): Effect.Effect<S["Type"], E, S["DecodingServices"]> =>
		VendorHttp.retryVendorCall(
			retryPolicy,
			request.retry ?? VendorHttp.isIdempotent(request.method),
			attempt(schema, operation, request),
		).pipe(Effect.mapError(options.toError))

	/** Pages until `next` is none or `maxPages`; `complete` is false when the cap cut it short. */
	const paginate = <S extends Schema.Top, C>(paging: VendorSdkPaging<S, C, R>) => {
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
				: call(
						paging.schema,
						paging.page(cursor),
						paging.operation === undefined ? {} : { operation: paging.operation },
					).pipe(
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

	return { call, paginate }
}
