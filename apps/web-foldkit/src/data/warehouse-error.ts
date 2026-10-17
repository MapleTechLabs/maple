import { PublicHttpErrorBodySchema } from "@maple/domain/http"
import { Predicate, Schema } from "effect"
import { HttpClientError } from "effect/http"

/**
 * Why a warehouse request failed, as the Model keeps it: plain data, small enough to ride in a
 * Message. `Rejected` carries the API's public error body code (per-item or whole-request).
 */
export const WarehouseFailure = Schema.Struct({
	reason: Schema.Literals(["Rejected", "Unreachable", "Failed"]),
	message: Schema.String,
	code: Schema.optionalKey(Schema.String),
	retryable: Schema.Boolean,
})
export type WarehouseFailure = typeof WarehouseFailure.Type

export class WarehouseQueryError extends Schema.TaggedError<WarehouseQueryError>()(
	"@maple/web-foldkit/WarehouseQueryError",
	{
		operation: Schema.String,
		failure: WarehouseFailure,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

const isPublicBody = Schema.is(PublicHttpErrorBodySchema)

/** A public body, as a batch's per-item outcome or an endpoint error carries it. */
export const rejectedFailure = (body: typeof PublicHttpErrorBodySchema.Type): WarehouseFailure => ({
	reason: "Rejected",
	message: body.message,
	code: body.code,
	retryable: body.retryable,
})

/**
 * A whole-request failure: a transport error is `Unreachable`, an endpoint error carries its public
 * body (the `.error` every Maple HTTP error exposes), anything else is `Failed`.
 */
export const failedWith = (operation: string, cause: unknown): WarehouseQueryError => {
	if (HttpClientError.isHttpClientError(cause)) {
		const unreachable = cause.reason._tag === "TransportError"
		return new WarehouseQueryError({
			operation,
			failure: {
				reason: unreachable ? "Unreachable" : "Failed",
				message: unreachable ? "Cannot reach Maple API" : cause.message,
				retryable: true,
			},
			cause,
		})
	}
	if (Predicate.hasProperty(cause, "error") && isPublicBody(cause.error)) {
		return new WarehouseQueryError({ operation, failure: rejectedFailure(cause.error), cause })
	}
	return new WarehouseQueryError({
		operation,
		failure: { reason: "Failed", message: `Warehouse query failed for ${operation}`, retryable: true },
		cause,
	})
}
