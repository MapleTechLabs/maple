import * as Clerk from "@distilled.cloud/clerk"
import { TelemetryHooks } from "@distilled.cloud/core/telemetry-hooks"
import { Duration, Effect, Layer, Option, Predicate, type Redacted, Schema } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"

export class ClerkRequestError extends Schema.TaggedError<ClerkRequestError>()(
	"@maple/auth/ClerkRequestError",
	{
		message: Schema.String,
		/** Clerk's HTTP status when it answered with an error, e.g. 404 for a deleted organization. */
		status: Schema.NullOr(Schema.Number),
		cause: Schema.Defect(),
	},
) {}

/** What every `@distilled.cloud/clerk` operation needs to run. */
export type ClerkApiServices = Clerk.Credentials | HttpClient.HttpClient

/** The deployment's Clerk Backend API. */
export interface ClerkApi {
	/** Runs one `@distilled.cloud/clerk` operation: one attempt, bounded, failing as {@link ClerkRequestError}. */
	readonly run: <A, E>(
		operation: Effect.Effect<A, E, ClerkApiServices>,
	) => Effect.Effect<A, ClerkRequestError>
}

/** Ceiling on one Clerk call. */
export const CLERK_REQUEST_TIMEOUT = Duration.seconds(10)

/** The status behind each `@distilled.cloud` status error; its unknown error carries its own. */
const STATUS_BY_TAG: ReadonlyMap<string, number> = new Map([
	["BadRequest", 400],
	["Unauthorized", 401],
	["Forbidden", 403],
	["NotFound", 404],
	["Conflict", 409],
	["UnprocessableEntity", 422],
	["Locked", 423],
	["TooManyRequests", 429],
	["InternalServerError", 500],
	["BadGateway", 502],
	["ServiceUnavailable", 503],
	["GatewayTimeout", 504],
])

const responseStatus = (cause: unknown): number | null => {
	if (Predicate.hasProperty(cause, "status") && Predicate.isNumber(cause.status)) return cause.status
	if (!Predicate.hasProperty(cause, "_tag") || !Predicate.isString(cause._tag)) return null
	return STATUS_BY_TAG.get(cause._tag) ?? null
}

const toRequestError = (cause: unknown): ClerkRequestError =>
	// A parse error quotes the body, which can hold a SCIM key: none of it is kept.
	Predicate.isTagged(cause, "ClerkParseError")
		? new ClerkRequestError({
				message: "Clerk answered in an unexpected shape",
				status: null,
				cause: null,
			})
		: new ClerkRequestError({
				message:
					Predicate.hasProperty(cause, "message") &&
					Predicate.isString(cause.message) &&
					cause.message !== ""
						? cause.message
						: "Clerk request failed",
				status: responseStatus(cause),
				cause,
			})

/**
 * One attempt per call. The SDK's default retries a lost response too, and Clerk's creates take no
 * idempotency key, so a replay could make a second organization or rotate a SCIM key twice.
 */
const noRetry = Layer.succeed(Clerk.Retry.Retry, { while: () => false })

/** Tags the SDK's own client span, so a Clerk call carries `peer.service` like every other dependency. */
const peerService = TelemetryHooks.layer({ onStart: (span) => span.attribute("peer.service", "clerk") })

/** A Clerk Backend API from a secret key; tests pass their own HTTP layer. */
export const makeClerkApi = (
	secretKey: Redacted.Redacted,
	http: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer,
): ClerkApi => {
	const services = Layer.mergeAll(Clerk.fromApiKey({ apiKey: secretKey }), http, noRetry, peerService)
	return {
		run: (operation) =>
			operation.pipe(
				// Credentials, the fetch client and a retry policy, built without a scope: safe per call.
				// oxlint-disable-next-line effecttsgo/strict-effect-provide
				Effect.provide(services),
				Effect.mapError(toRequestError),
				Effect.timeoutOrElse({
					duration: CLERK_REQUEST_TIMEOUT,
					orElse: () =>
						Effect.fail(
							new ClerkRequestError({
								message: `Clerk request timed out after ${Duration.format(CLERK_REQUEST_TIMEOUT)}`,
								status: null,
								cause: null,
							}),
						),
				}),
			),
	}
}

const clerkApis = new WeakMap<object, ClerkApi>()

/** The deployment's Clerk Backend API, built once per env; `undefined` without a secret key. */
export const clerkApiFor = (env: {
	readonly CLERK_SECRET_KEY: Option.Option<Redacted.Redacted>
}): ClerkApi | undefined => {
	if (Option.isNone(env.CLERK_SECRET_KEY)) return undefined
	const cached = clerkApis.get(env)
	if (cached !== undefined) return cached
	const api = makeClerkApi(env.CLERK_SECRET_KEY.value)
	clerkApis.set(env, api)
	return api
}
