import {
	formatWarehouseDateTime,
	TinybirdDateTime,
	type QueryEngineExecuteRequest,
	type QueryEngineExecuteResponse,
	type FacetItem,
	type DurationStats,
	type AttributeValueItem,
} from "@maple/query-engine"
import { Clock, Effect, Schema } from "effect"
import { HttpClientError } from "effect/http"
import { PublicHttpErrorBodySchema, type AnyPublicHttpErrorBody } from "@maple/domain/http"
import { makeClientErrorBody, NetworkErrorBody } from "../lib/error-messages"
import { ApiReachability, MapleApiV2Http, MapleInternalHttp, WarehouseExecutor } from "./warehouse-services"

export * from "./warehouse-services"

export const WarehouseDateTimeString = TinybirdDateTime

/** An integration page's window; `resolveInfraWindow` fills a missing bound with the last 6 hours. */
export const InfraWindowInput = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
})

export const resolveInfraWindow = (input: { startTime?: string; endTime?: string }, nowMillis: number) => ({
	startTime: input.startTime ?? formatWarehouseDateTime(nowMillis - 6 * 60 * 60 * 1000),
	endTime: input.endTime ?? formatWarehouseDateTime(nowMillis),
})

/** A wire-row number; a missing column reads as 0. */
export const wireNumber = (value: unknown): number => Number(value ?? 0)

/** A wire-row number that may be null on purpose (a gap); missing reads as null too. */
export const wireNumberOrNull = (value: unknown): number | null =>
	value === null || value === undefined ? null : Number(value)

export class WarehouseDecodeError extends Schema.TaggedError<WarehouseDecodeError>()(
	"@maple/web/errors/WarehouseDecodeError",
	{
		operation: Schema.String,
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown),
	},
) {
	readonly error = makeClientErrorBody({
		_tag: this._tag,
		code: "warehouse_decode_failed",
		title: "Query data could not be read",
		message: "Maple could not read the query response.",
		retryable: false,
		recovery: "contact_support",
	})
}

export class WarehouseQueryError extends Schema.TaggedError<WarehouseQueryError>()(
	"@maple/web/errors/WarehouseQueryError",
	{
		operation: Schema.String,
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown),
	},
) {
	readonly error = makeClientErrorBody({
		_tag: this._tag,
		code: "warehouse_query_failed",
		title: "Warehouse query failed",
		message: "Maple could not complete the warehouse query.",
		retryable: true,
		recovery: "retry",
	})
}

export class WarehouseTransformError extends Schema.TaggedError<WarehouseTransformError>()(
	"@maple/web/errors/WarehouseTransformError",
	{
		operation: Schema.String,
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown),
	},
) {
	readonly error = makeClientErrorBody({
		_tag: this._tag,
		code: "warehouse_transform_failed",
		title: "Query data could not be displayed",
		message: "Maple could not prepare the query data.",
		retryable: false,
		recovery: "contact_support",
	})
}

export class WarehouseInvalidInputError extends Schema.TaggedError<WarehouseInvalidInputError>()(
	"@maple/web/errors/WarehouseInvalidInputError",
	{
		operation: Schema.String,
		message: Schema.String,
	},
) {
	readonly error = makeClientErrorBody({
		_tag: this._tag,
		code: "warehouse_input_invalid",
		title: "Invalid query",
		message: this.message,
		retryable: false,
		recovery: "fix_request",
	})
}

/**
 * The browser could not reach the API at all, and has not been able to for less
 * than `PEER_OUTAGE_GRACE_MS`.
 *
 * Its own tag rather than a flavour of `WarehouseQueryError` because it is not a
 * fault of Maple's: `otel-layer.ts` anticipates this tag, so the spans it fails
 * record `Ok` and no exception event is fingerprinted for a wifi blip. A failure
 * still arriving after the grace window is a real outage and stays a
 * `WarehouseQueryError`, which reports as before.
 *
 * It carries the same public body a bare transport failure already resolved to
 * through `displayError`, so the UI copy is unchanged — "Cannot reach Maple
 * API", retryable. That copy is the point: the path this replaces re-raised a
 * dropped connection as `WarehouseInvalidInputError`, telling the user their
 * query was invalid and to fix the request.
 */
export class WarehouseUnreachableError extends Schema.TaggedError<WarehouseUnreachableError>()(
	"@maple/web/errors/WarehouseUnreachableError",
	{
		operation: Schema.String,
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown),
	},
) {
	readonly error = NetworkErrorBody
}

export type WarehouseApiError =
	| WarehouseDecodeError
	| WarehouseQueryError
	| WarehouseTransformError
	| WarehouseInvalidInputError
	| WarehouseUnreachableError

/** Backend failures are either a public body or an error carrying that same body. */
export type BackendError = AnyPublicHttpErrorBody | { readonly error: AnyPublicHttpErrorBody }

function toMessage(cause: unknown, fallback: string): string {
	return cause instanceof Error ? cause.message : fallback
}

const isPublicErrorBody = Schema.is(PublicHttpErrorBodySchema)

const isPublicErrorEnvelope = (cause: unknown): cause is { readonly error: AnyPublicHttpErrorBody } => {
	if (typeof cause !== "object" || cause === null || !("error" in cause)) return false
	return isPublicErrorBody((cause as { readonly error: unknown }).error)
}

export const isBackendError = (cause: unknown): cause is BackendError =>
	isPublicErrorBody(cause) || isPublicErrorEnvelope(cause)

export const isWarehouseApiError = (cause: unknown): cause is WarehouseApiError =>
	typeof cause === "object" &&
	cause !== null &&
	"_tag" in cause &&
	typeof cause._tag === "string" &&
	cause._tag.startsWith("@maple/web/errors/Warehouse")

/**
 * True when `cause` is a request that never got a response — the browser could
 * not reach the API — as opposed to one the API answered with a failure.
 *
 * Walks the cause chain because the transport failure is usually nested: the
 * batcher rejects its promise with an `HttpClientError`, which `Effect.tryPromise`
 * then wraps. Bounded at the same depth `displayError` uses.
 */
export const isTransportFailure = (cause: unknown): boolean => transportErrorOf(cause) !== undefined

/** True when the transport failure is the client's own request deadline, not a dropped connection. */
export const isRequestTimeout = (cause: unknown): boolean => {
	const reason = transportErrorOf(cause)
	return (
		reason !== undefined &&
		typeof DOMException !== "undefined" &&
		reason.cause instanceof DOMException &&
		reason.cause.name === "TimeoutError"
	)
}

const transportErrorOf = (cause: unknown, depth = 0): HttpClientError.TransportError | undefined => {
	if (HttpClientError.isHttpClientError(cause))
		return cause.reason._tag === "TransportError" ? cause.reason : undefined
	if (depth >= 4) return undefined
	const nested =
		typeof cause === "object" && cause !== null && "cause" in cause
			? (cause as { readonly cause: unknown }).cause
			: undefined
	return nested === undefined || nested === cause ? undefined : transportErrorOf(nested, depth + 1)
}

/**
 * A transport failure while the API is inside its grace window is the network
 * dropping, not the warehouse failing — see `peer-reachability.ts`. Once the run
 * outlasts the window it is a real outage and stays a `WarehouseQueryError`, so
 * an API that is genuinely down still reports. `blipping` is `ApiReachability`'s answer.
 */
export const isNetworkBlip = (cause: unknown, blipping: boolean): boolean =>
	isTransportFailure(cause) && blipping

const tagOf = (cause: unknown): string | undefined =>
	typeof cause === "object" && cause !== null && "_tag" in cause && typeof cause._tag === "string"
		? cause._tag
		: undefined

/**
 * What the API answered, on the adapter's span. A 500 arrives as the sanitized
 * `ApiUnexpectedError`, whose message says nothing; its tag and the public
 * body's code are the only facts this side has, and without them the web span
 * reads "An unexpected error occurred" for a warehouse timeout and a wiring bug
 * alike.
 */
const annotateUpstreamFailure = (cause: unknown) => {
	const body = isPublicErrorEnvelope(cause) ? cause.error : isPublicErrorBody(cause) ? cause : undefined
	const tag = body?._tag ?? tagOf(cause) ?? (cause instanceof Error ? cause.name : typeof cause)
	return Effect.annotateCurrentSpan({
		"error.type": tag,
		...(body === undefined ? undefined : { "maple.upstream.error_code": body.code }),
	})
}

/** Preserve known errors; introduce a local query error only for an unstructured failure. */
export const normalizeWarehouseError = (
	operation: string,
	cause: unknown,
	blipping = false,
): WarehouseApiError | BackendError => {
	if (isBackendError(cause) || isWarehouseApiError(cause)) return cause
	const message = toMessage(cause, `Warehouse query failed for ${operation}`)
	return isNetworkBlip(cause, blipping)
		? new WarehouseUnreachableError({ operation, message, cause })
		: new WarehouseQueryError({ operation, message, cause })
}

/** Whether `ApiReachability` says the API is inside a network blip right now. */
const isApiBlipping: Effect.Effect<boolean> = Effect.flatMap(ApiReachability, (reachability) =>
	Effect.map(Clock.currentTimeMillis, reachability.isBlipping),
)

/** `normalizeWarehouseError` against the live `ApiReachability`, as a failure. */
const failNormalized =
	(operation: string) =>
	(cause: unknown): Effect.Effect<never, WarehouseApiError | BackendError> =>
		Effect.flatMap(isApiBlipping, (blipping) =>
			Effect.fail(normalizeWarehouseError(operation, cause, blipping)),
		)

export function decodeInput<S extends Schema.Top & { readonly DecodingServices: never }>(
	schema: S,
	input: unknown,
	operation: string,
): Effect.Effect<S["Type"], WarehouseDecodeError> {
	return Schema.decodeUnknownEffect(schema)(input).pipe(
		Effect.mapError(
			(cause) =>
				new WarehouseDecodeError({
					operation,
					message: toMessage(cause, `Invalid input for ${operation}`),
					cause,
				}),
		),
	)
}

/** Runs a warehouse adapter against the `/internal` client with span and error normalization. */
export function runWarehouseQuery<A, E>(
	operation: string,
	execute: () => Effect.Effect<A, E, MapleInternalHttp>,
): Effect.Effect<A, WarehouseApiError | BackendError, MapleInternalHttp> {
	return Effect.suspend(execute).pipe(
		Effect.tapError(annotateUpstreamFailure),
		Effect.withSpan(operation),
		Effect.catch(failNormalized(operation)),
	)
}

/**
 * `runWarehouseQuery` against the v2 client.
 *
 * Same span + error normalization, different client layer and a wider input
 * error type: each v2 endpoint exposes its own literal `_tag` envelope union.
 * Those envelopes pass through unchanged so the UI retains the server's exact
 * semantic tag, status, code, and remediation copy.
 */
export function runWarehouseQueryV2<A, E>(
	operation: string,
	execute: () => Effect.Effect<A, E, MapleApiV2Http>,
): Effect.Effect<A, WarehouseApiError | BackendError, MapleApiV2Http> {
	return Effect.suspend(execute).pipe(
		Effect.tapError(annotateUpstreamFailure),
		Effect.withSpan(operation),
		Effect.catch(failNormalized(operation)),
	)
}

/**
 * Raise a query-set failure whose per-query causes the runner has already
 * flattened to strings.
 *
 * `runQuerySetWindow` catches each executor failure into `result.error` text and
 * re-raises the batch as `QuerySetNoDataError`, so the type is gone by the time
 * an adapter sees it and only the live reachability clock still knows whether
 * the API answered. While it says the API is unreachable this is that, not a bad
 * query — which is what the user was previously told to fix.
 */
export function querySetFailure(
	operation: string,
	message: string,
): Effect.Effect<never, WarehouseInvalidInputError | WarehouseUnreachableError> {
	return Effect.flatMap(
		isApiBlipping,
		(blipping): Effect.Effect<never, WarehouseInvalidInputError | WarehouseUnreachableError> =>
			blipping
				? Effect.fail(new WarehouseUnreachableError({ operation, message }))
				: invalidWarehouseInput(operation, message),
	)
}

export function invalidWarehouseInput(
	operation: string,
	message: string,
): Effect.Effect<never, WarehouseInvalidInputError> {
	return Effect.fail(
		new WarehouseInvalidInputError({
			operation,
			message,
		}),
	)
}

// The app's executor owns the one shared batch window; this fiber only awaits its item.
const executeQueryEngineEffect = Effect.fn("QueryEngine.execute")(function* (
	payload: QueryEngineExecuteRequest,
) {
	const executor = yield* WarehouseExecutor
	return yield* executor.enqueue(payload).pipe(Effect.catch(failNormalized("QueryEngine.executeBatch")))
})

// Typed result extractors for QueryEngineResult union

export function extractFacets(response: QueryEngineExecuteResponse): ReadonlyArray<FacetItem> {
	const r = response.result
	if (r.kind === "facets") return r.data
	return []
}

export function extractStats(response: QueryEngineExecuteResponse): DurationStats {
	const r = response.result
	if (r.kind === "stats") return r.data
	return { minDurationMs: 0, maxDurationMs: 0, p50DurationMs: 0, p95DurationMs: 0 }
}

export function extractAttributeValues(
	response: QueryEngineExecuteResponse,
): ReadonlyArray<AttributeValueItem> {
	const r = response.result
	if (r.kind === "attributeValues") return r.data
	return []
}

export function extractCount(response: QueryEngineExecuteResponse): number {
	const r = response.result
	if (r.kind === "count") return r.data.total
	return 0
}

export function executeQueryEngine(
	operation: string,
	payload: QueryEngineExecuteRequest,
): Effect.Effect<QueryEngineExecuteResponse, WarehouseApiError | BackendError, WarehouseExecutor> {
	return Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan("query.operation", operation)
		return yield* executeQueryEngineEffect(payload)
	}).pipe(Effect.withSpan(operation), Effect.catch(failNormalized(operation)))
}
