import type { AnyPublicHttpErrorBody } from "@maple/domain/http"
import {
	type BackendError,
	isTransportFailure,
	isWarehouseApiError,
	type WarehouseApiError,
} from "@maple/web-data/warehouse/effect-utils"
import { Schema } from "effect"

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

const rejected = (body: AnyPublicHttpErrorBody): WarehouseFailure => ({
	reason: "Rejected",
	message: body.message,
	code: body.code,
	retryable: body.retryable,
})

/**
 * A `@maple/web-data` query failure as Message data: a request that never reached the API is
 * `Unreachable`, an error the API answered carries its public body, anything local is `Failed`.
 */
export const toWarehouseFailure = (error: WarehouseApiError | BackendError): WarehouseFailure => {
	if (!isWarehouseApiError(error)) return rejected("error" in error ? error.error : error)
	if (error._tag === "@maple/web/errors/WarehouseUnreachableError" || isTransportFailure(error.cause)) {
		return { reason: "Unreachable", message: "Cannot reach Maple API", retryable: true }
	}
	return { reason: "Failed", message: error.message, retryable: error.error.retryable }
}
