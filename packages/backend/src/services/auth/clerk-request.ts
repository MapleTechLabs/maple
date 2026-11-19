import type { ClerkApi, ClerkApiServices } from "@maple/auth"
import { Duration, Effect, Predicate, Schema } from "effect"

export class ClerkRequestError extends Schema.TaggedError<ClerkRequestError>()(
	"@maple/backend/services/auth/ClerkRequestError",
	{
		operation: Schema.String,
		message: Schema.String,
		/** Clerk's HTTP status when it answered with an error, e.g. 404 for a deleted organization. */
		status: Schema.NullOr(Schema.Number),
		cause: Schema.Defect(),
	},
) {}

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

const responseMessage = (cause: unknown): string =>
	Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message) && cause.message !== ""
		? cause.message
		: "Clerk request failed"

/** Ceiling on one Clerk call, retries included. */
export const CLERK_REQUEST_TIMEOUT = Duration.seconds(10)

type ClerkSpanAttributes = Readonly<Record<string, string | number | boolean>>

/**
 * Run a `@distilled.cloud/clerk` operation against `api`, with the Client-kind span
 * attributes Maple's service map needs. Every failure becomes a {@link ClerkRequestError}
 * carrying Clerk's status; callers map it to their own service contract at the boundary.
 */
export const clerkRequest = <A, E>(
	api: ClerkApi,
	spanName: string,
	attributes: ClerkSpanAttributes,
	request: Effect.Effect<A, E, ClerkApiServices>,
): Effect.Effect<A, ClerkRequestError> =>
	request.pipe(
		// The api is credentials and the fetch client, built without a scope: safe per call.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(api),
		Effect.mapError((cause) =>
			// A parse error quotes the body, which can hold a SCIM key: none of it is kept.
			Predicate.isTagged(cause, "ClerkParseError")
				? new ClerkRequestError({
						operation: spanName,
						message: "Clerk answered in an unexpected shape",
						status: null,
						cause: null,
					})
				: new ClerkRequestError({
						operation: spanName,
						message: responseMessage(cause),
						status: responseStatus(cause),
						cause,
					}),
		),
		Effect.timeoutOrElse({
			duration: CLERK_REQUEST_TIMEOUT,
			orElse: () =>
				Effect.fail(
					new ClerkRequestError({
						operation: spanName,
						message: `Clerk request timed out after ${Duration.format(CLERK_REQUEST_TIMEOUT)}`,
						status: null,
						cause: null,
					}),
				),
		}),
		Effect.withSpan(spanName, {
			kind: "client",
			attributes: { "peer.service": "clerk", ...attributes },
		}),
	)
