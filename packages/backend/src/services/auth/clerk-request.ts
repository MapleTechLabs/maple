import { Duration, Effect, Schema } from "effect"

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

const responseStatus = (cause: unknown): number | null =>
	typeof cause === "object" && cause !== null && "status" in cause && typeof cause.status === "number"
		? cause.status
		: null

/** Ceiling on one Clerk call; the SDK takes no signal, so a stall would otherwise hang the request. */
export const CLERK_REQUEST_TIMEOUT = Duration.seconds(10)

type ClerkSpanAttributes = Readonly<Record<string, string | number | boolean>>

/**
 * Lift a Clerk SDK request into Effect with the Client-kind span attributes
 * required for Maple's service map. Callers map the internal request error to
 * their own service contract at the boundary.
 */
export const clerkRequest = <A>(
	spanName: string,
	attributes: ClerkSpanAttributes,
	request: () => Promise<A>,
): Effect.Effect<A, ClerkRequestError> =>
	Effect.tryPromise({
		try: request,
		catch: (cause) =>
			new ClerkRequestError({
				operation: spanName,
				message: cause instanceof Error ? cause.message : "Clerk request failed",
				status: responseStatus(cause),
				cause,
			}),
	}).pipe(
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
