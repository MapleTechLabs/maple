/** One Linear GraphQL call. Linear reports most failures in an `errors` array, so the codes decide, not the status. */
import { IntegrationsRevokedError, IntegrationsUpstreamError } from "@maple/domain/http"
import { Effect, Option, Schema, Array as Arr } from "effect"
import type { HttpClient } from "effect/http"
import * as VendorHttp from "../vendor-http"

const LINEAR_API_BASE_URL = "https://api.linear.app"

const REQUEST_TIMEOUT = "8 seconds"

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
	Arr.join(
		Arr.map(errors, (error) => error.message),
		"; ",
	)

const envelopeErrors = (body: typeof GraphqlEnvelopeSchema.Type): ReadonlyArray<LinearGraphqlError> =>
	Arr.map(body.errors ?? [], (error) => ({
		message: error.extensions?.userPresentableMessage ?? error.message,
		code: error.extensions?.code ?? null,
	}))

const errorsOf = (text: string) =>
	Option.match(decodeEnvelope(text), { onNone: () => [], onSome: envelopeErrors })

const isRateLimited = (error: LinearGraphqlError) => error.code === "RATELIMITED"

/** Linear sends auth and rate-limit failures as GraphQL errors, often on a 400, so the codes decide. */
const classifyLinear = (refusal: VendorHttp.VendorRefusal): VendorHttp.VendorFailureKind | undefined => {
	const errors = errorsOf(refusal.body)
	if (Arr.some(errors, isAuthError)) return "unauthorized"
	if (Arr.some(errors, isRateLimited)) return "rate_limited"
	return undefined
}

const linearDetail = (body: string) => {
	const errors = errorsOf(body)
	return errors.length === 0 ? undefined : errorSummary(errors)
}

const revoked = () =>
	new IntegrationsRevokedError({ message: "Linear rejected the access token. Reconnect Linear." })
const rateLimited = () => new IntegrationsUpstreamError({ message: "Linear rate limit reached", status: 429 })

/** A query reads only, so a passing 5xx may send it again; a mutation is sent once. */
const isQueryDocument = (query: string) => /^\s*(query\b|\{)/.test(query)

/**
 * A refusal as the caller sees it: a rejected token fails `IntegrationsRevokedError`, and GraphQL
 * errors on a 4xx come back as a result, so a caller can treat "not found" as an answer.
 */
const fromRefusal = (
	error: VendorHttp.VendorHttpError,
): Effect.Effect<LinearGraphqlResult, IntegrationsRevokedError | IntegrationsUpstreamError> => {
	switch (error.kind) {
		case "unauthorized":
			return Effect.fail(revoked())
		case "rate_limited":
			return Effect.fail(rateLimited())
		case "timeout":
			return Effect.fail(new IntegrationsUpstreamError({ message: "Linear API request timed out" }))
		case "forbidden":
		case "not_found":
		case "upstream":
		case "invalid_response": {
			if (error.status === undefined)
				return Effect.fail(
					new IntegrationsUpstreamError({ message: `Linear API request failed: ${error.message}` }),
				)
			const envelope = decodeEnvelope(error.body ?? "")
			if (Option.isSome(envelope) && (envelope.value.errors ?? []).length > 0)
				return Effect.succeed({
					data: envelope.value.data ?? null,
					errors: envelopeErrors(envelope.value),
				})
			return Effect.fail(
				new IntegrationsUpstreamError({
					message: `Linear API returned ${error.status}${error.detail === undefined ? "" : `: ${error.detail}`}`,
					status: error.status,
				}),
			)
		}
	}
}

export const linearGraphql = Effect.fn("Linear.graphql")(function* (
	httpClient: HttpClient.HttpClient,
	accessToken: string,
	operationName: string,
	query: string,
	variables: Record<string, unknown> = {},
): Effect.fn.Return<LinearGraphqlResult, IntegrationsRevokedError | IntegrationsUpstreamError> {
	yield* Effect.annotateCurrentSpan("maple.linear.operation", operationName)
	const client = VendorHttp.make({
		httpClient,
		peerService: "linear",
		baseUrl: LINEAR_API_BASE_URL,
		auth: VendorHttp.bearer(accessToken),
		headers: { accept: "application/json" },
		classify: classifyLinear,
		detail: linearDetail,
		toError: (error: VendorHttp.VendorHttpError) => error,
		timeout: REQUEST_TIMEOUT,
	})
	const sent = client.text({
		method: "POST",
		path: "/graphql",
		body: { operationName, query, variables },
		operation: operationName,
		retry: isQueryDocument(query),
	})
	return yield* Effect.matchEffect(sent, {
		onFailure: fromRefusal,
		onSuccess: (
			text,
		): Effect.Effect<LinearGraphqlResult, IntegrationsRevokedError | IntegrationsUpstreamError> =>
			Option.match(decodeEnvelope(text), {
				onNone: () =>
					Effect.fail(
						new IntegrationsUpstreamError({ message: "Linear API returned an unreadable body" }),
					),
				onSome: (body) => {
					const errors = envelopeErrors(body)
					if (Arr.some(errors, isAuthError)) return Effect.fail(revoked())
					if (Arr.some(errors, isRateLimited)) return Effect.fail(rateLimited())
					return Effect.succeed({ data: body.data ?? null, errors })
				},
			}),
	})
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
