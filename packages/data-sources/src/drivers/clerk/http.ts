import { Effect, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"
import {
	DataSourceConnectionError,
	DataSourceQueryError,
	DataSourceRateLimitedError,
} from "@maple/domain/data-sources"

// Verified against Clerk's Backend API OpenAPI spec, version 2026-08-20:
// https://github.com/clerk/openapi-specs/blob/main/bapi/2026-08-20.yml (GET /users, /users/count, /organizations).
export const CLERK_API_URL = "https://api.clerk.com/v1"

const USER_FILTER_PARAMS = [
	"user_id",
	"email_address",
	"email_address_query",
	"username",
	"username_query",
	"external_id",
	"organization_id",
	"banned",
	"created_at_after",
	"created_at_before",
	"last_active_at_after",
	"last_active_at_before",
	"last_sign_in_at_after",
	"last_sign_in_at_before",
] as const
type UserFilterParam = (typeof USER_FILTER_PARAMS)[number]
type PageParam = "limit" | "offset" | "order_by"

/** The only calls the driver can make: read endpoints, each with its own parameter names. */
export interface ClerkEndpoints {
	readonly "/users": UserFilterParam | PageParam
	readonly "/users/count": UserFilterParam
	readonly "/organizations": "organization_id" | "include_members_count" | PageParam
}
export type ClerkPath = keyof ClerkEndpoints
export type ClerkParams<P extends ClerkPath> = ReadonlyArray<readonly [ClerkEndpoints[P], string]>

const ClerkErrorBody = Schema.Struct({
	errors: Schema.Array(
		Schema.Struct({ message: Schema.String, long_message: Schema.optionalKey(Schema.String) }),
	),
})

const clerkMessage = (response: HttpClientResponse.HttpClientResponse) =>
	response.json.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(ClerkErrorBody)),
		Effect.map((body) => body.errors[0]?.long_message ?? body.errors[0]?.message ?? ""),
		Effect.orElseSucceed(() => ""),
	)

const retryAfterOf = (response: HttpClientResponse.HttpClientResponse): number | undefined => {
	const seconds = Number(response.headers["retry-after"])
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

/** Maps a non-2xx answer to a typed error. Messages never carry the key or the request. */
const failFor = (
	path: ClerkPath,
	response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<never, DataSourceConnectionError | DataSourceQueryError | DataSourceRateLimitedError> =>
	Effect.flatMap(
		clerkMessage(response),
		(
			detail,
		): Effect.Effect<
			never,
			DataSourceConnectionError | DataSourceQueryError | DataSourceRateLimitedError
		> => {
			const suffix = detail === "" ? "" : `: ${detail}`
			if (response.status === 401 || response.status === 403) {
				return Effect.fail(
					new DataSourceConnectionError({
						message: `Clerk rejected the secret key (${response.status})${suffix}`,
						reason: "auth",
					}),
				)
			}
			if (response.status === 429) {
				const retryAfterSeconds = retryAfterOf(response)
				return Effect.fail(
					new DataSourceRateLimitedError(
						retryAfterSeconds === undefined
							? {
									message:
										"Clerk's rate limit for this instance is reached; Maple stops calling it",
								}
							: {
									message: `Clerk's rate limit for this instance is reached; Maple stops calling it for ${retryAfterSeconds} s`,
									retryAfterSeconds,
								},
					),
				)
			}
			return Effect.fail(
				new DataSourceQueryError({
					message:
						response.status >= 500
							? `Clerk failed on GET ${path} (${response.status})`
							: `Clerk refused GET ${path} (${response.status})${suffix}`,
				}),
			)
		},
	)

/** One authenticated GET on an allow-listed path, decoded with `schema`. */
export const clerkGet = <P extends ClerkPath, A>(
	secret: Redacted.Redacted,
	path: P,
	params: ClerkParams<P>,
	schema: Schema.Decoder<A>,
) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient
		const request = HttpClientRequest.get(`${CLERK_API_URL}${path}`, { urlParams: params }).pipe(
			HttpClientRequest.bearerToken(Redacted.value(secret)),
			HttpClientRequest.acceptJson,
		)
		const response = yield* client.execute(request).pipe(
			Effect.mapError(
				(error) =>
					new DataSourceConnectionError({
						message: `Could not reach Clerk (${error.reason._tag})`,
						reason: "network",
					}),
			),
		)
		if (response.status < 200 || response.status >= 300) return yield* failFor(path, response)
		return yield* response.json.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(schema)),
			Effect.mapError(
				() =>
					new DataSourceQueryError({
						message: `Clerk answered GET ${path} with an unexpected body`,
					}),
			),
		)
	}).pipe(
		Effect.withSpan("ClerkDriver.get", {
			attributes: { "maple.data_source.kind": "clerk", "url.path": path },
		}),
	)
