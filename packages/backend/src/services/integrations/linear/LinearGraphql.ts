/**
 * One Linear GraphQL call. Linear answers most failures as HTTP 200/400 with an
 * `errors` array, so the status alone cannot tell a dead grant from a bad query:
 * the error's `extensions.code` (or `type`) decides.
 */
import { IntegrationsRevokedError, IntegrationsUpstreamError } from "@maple/domain/http"
import { Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql"

const REQUEST_TIMEOUT = "20 seconds"

const GraphqlErrorSchema = Schema.Struct({
	message: Schema.String,
	extensions: Schema.optionalKey(
		Schema.Struct({
			code: Schema.optionalKey(Schema.String),
			type: Schema.optionalKey(Schema.String),
			userPresentableMessage: Schema.optionalKey(Schema.String),
		}),
	),
})

const GraphqlEnvelopeSchema = Schema.Struct({
	data: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
	errors: Schema.optionalKey(Schema.Array(GraphqlErrorSchema)),
})

const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(GraphqlEnvelopeSchema))

export interface LinearGraphqlError {
	readonly message: string
	/** `extensions.code` when Linear sent one, e.g. `ENTITY_NOT_FOUND`. */
	readonly code: string | null
}

export interface LinearGraphqlResult {
	readonly data: unknown
	readonly errors: ReadonlyArray<LinearGraphqlError>
}

const isAuthError = (error: LinearGraphqlError) =>
	error.code === "AUTHENTICATION_ERROR" || /authenticat/i.test(error.message)

/**
 * True when Linear says the entity does not exist (deleted, or never created). Linear answers an
 * unknown id with code `INPUT_ERROR` and "Could not find referenced Issue.", so the message decides.
 */
export const isNotFound = (error: LinearGraphqlError) =>
	error.code === "ENTITY_NOT_FOUND" || /entity not found|could not find referenced/i.test(error.message)

const errorSummary = (errors: ReadonlyArray<LinearGraphqlError>) =>
	errors.map((error) => error.message).join("; ")

/**
 * POST a query. A rejected token fails `IntegrationsRevokedError` (the caller's
 * refresh-and-retry keys on it); any other non-2xx without GraphQL errors fails
 * `IntegrationsUpstreamError`. GraphQL errors on a readable body are returned,
 * not failed, so a caller can treat "not found" as an answer.
 */
export const linearGraphql = Effect.fn("Linear.graphql")(function* (
	httpClient: HttpClient.HttpClient,
	accessToken: string,
	operationName: string,
	query: string,
	variables: Record<string, unknown> = {},
) {
	yield* Effect.annotateCurrentSpan({
		"peer.service": "linear",
		"server.address": "api.linear.app",
		"maple.linear.operation": operationName,
	})
	const request = HttpClientRequest.post(LINEAR_GRAPHQL_URL, {
		headers: {
			authorization: `Bearer ${accessToken}`,
			"content-type": "application/json",
			accept: "application/json",
		},
	}).pipe(HttpClientRequest.bodyJsonUnsafe({ operationName, query, variables }))

	const { status, text } = yield* Effect.gen(function* () {
		const response = yield* httpClient.execute(request)
		return { status: response.status, text: yield* response.text }
	}).pipe(
		Effect.timeoutOrElse({
			duration: REQUEST_TIMEOUT,
			orElse: () =>
				Effect.fail(new IntegrationsUpstreamError({ message: "Linear API request timed out" })),
		}),
		Effect.catchTag("HttpClientError", (error) =>
			Effect.fail(
				new IntegrationsUpstreamError({
					message: `Linear API request failed: ${error.message}`,
				}),
			),
		),
	)
	yield* Effect.annotateCurrentSpan("http.response.status_code", status)

	const envelope = decodeEnvelope(text)
	const errors: ReadonlyArray<LinearGraphqlError> = Option.match(envelope, {
		onNone: () => [],
		onSome: (body) =>
			(body.errors ?? []).map((error) => ({
				message: error.extensions?.userPresentableMessage ?? error.message,
				code: error.extensions?.code ?? null,
			})),
	})

	if (status === 401 || errors.some(isAuthError)) {
		return yield* Effect.fail(
			new IntegrationsRevokedError({ message: "Linear rejected the access token — reconnect Linear" }),
		)
	}
	if (status === 429 || errors.some((error) => error.code === "RATELIMITED")) {
		return yield* Effect.fail(
			new IntegrationsUpstreamError({ message: "Linear rate limit reached", status: 429 }),
		)
	}
	if (Option.isNone(envelope) || (status >= 300 && errors.length === 0)) {
		return yield* Effect.fail(
			new IntegrationsUpstreamError({ message: `Linear API returned ${status}`, status }),
		)
	}
	return { data: envelope.value.data ?? null, errors } satisfies LinearGraphqlResult
})

/** Decode `data` with `schema`, failing on any GraphQL error. */
export const linearData =
	<S extends Schema.Top>(schema: S, operationName: string) =>
	(
		result: LinearGraphqlResult,
	): Effect.Effect<S["Type"], IntegrationsUpstreamError, S["DecodingServices"]> =>
		result.errors.length > 0
			? Effect.fail(
					new IntegrationsUpstreamError({
						message: `Linear ${operationName} failed: ${errorSummary(result.errors)}`,
					}),
				)
			: Schema.decodeUnknownEffect(schema)(result.data).pipe(
					Effect.mapError(
						() =>
							new IntegrationsUpstreamError({
								message: `Linear ${operationName} returned an unexpected payload`,
							}),
					),
				)
