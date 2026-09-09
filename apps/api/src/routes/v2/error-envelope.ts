import { Effect, Layer } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { HttpEffect, HttpServerResponse } from "effect/unstable/http"
import {
	V2InvalidRequest,
	V2ResponseSchemaFailure,
	V2SchemaErrors,
	V2UnexpectedFailure,
	V2UnexpectedErrors,
} from "@maple/domain/http/v2"
import { failureStackOf, failureTypeOf, recordRenderedFailure } from "@/routes/rendered-failure"
import { describeSchemaIssue } from "@/routes/schema-error-detail"
import { observeServerError } from "@/routes/server-error-observability"

type V2SchemaBoundaryError =
	| ReturnType<typeof V2InvalidRequest.make>
	| ReturnType<typeof V2ResponseSchemaFailure.make>

/**
 * Request-decode failures (params/query/payload) under /v2 are rewritten into
 * the v2 error envelope — `{ "error": { "type": "invalid_request_error",
 * "code": "parameter_invalid", "message": … } }` — instead of the runtime's
 * default empty 400 (see docs/api-v2.md#errors).
 *
 * `param` carries the full JSON path (`widgets[3].display.fill_nulls`), not
 * just its first segment, and the message names the enclosing widget when the
 * path points inside a `widgets[]` array — the envelope holds one error, so a
 * document with several bad fields reports the first and counts the rest.
 */
const V2SchemaErrorTransformLive = HttpApiMiddleware.layerSchemaErrorTransform(
	V2SchemaErrors,
	(schemaError, { endpoint, group }) =>
		Effect.suspend((): Effect.Effect<never, V2SchemaBoundaryError> => {
			const details = describeSchemaIssue(schemaError.cause.issue)
			if (schemaError.kind === "Body" || schemaError.kind === "ResponseHeaders") {
				return recordRenderedFailure({
					group: group.identifier,
					operation: endpoint.identifier,
					errorType: `@maple/api/routes/v2/V2ResponseSchemaError/${schemaError.kind}`,
					summary: "V2 response failed its declared HTTP schema",
					message: details.map(({ line }) => line).join("; "),
					status: 500,
					detail: details.map(({ line }) => line),
					cause: schemaError.cause,
				}).pipe(Effect.andThen(Effect.fail(V2ResponseSchemaFailure.make())))
			}
			const first = details[0]
			if (first === undefined) {
				return Effect.fail(
					V2InvalidRequest.make(`Invalid request ${schemaError.kind.toLowerCase()}.`),
				)
			}
			const remaining = details.length - 1
			const suffix =
				remaining === 0
					? ""
					: ` (and ${remaining} other invalid ${remaining === 1 ? "field" : "fields"})`
			return Effect.fail(
				V2InvalidRequest.make(`${first.line}${suffix}`, {
					...(!(first.path === "") ? { param: first.path } : undefined),
				}),
			)
		}),
)

const retryAfterHeader = (failure: unknown): string | undefined => {
	if (typeof failure !== "object" || failure === null || !("error" in failure)) return undefined
	const error = (failure as { readonly error: unknown }).error
	if (typeof error !== "object" || error === null) return undefined
	if ("retry_after_seconds" in error && typeof error.retry_after_seconds === "number") {
		return String(Math.max(1, Math.ceil(error.retry_after_seconds)))
	}
	if ("retry_at" in error && typeof error.retry_at === "string") {
		const retryAt = new Date(error.retry_at)
		if (Number.isFinite(retryAt.getTime())) return retryAt.toUTCString()
	}
	return undefined
}

const appendRetryAfter = (failure: unknown) => {
	const value = retryAfterHeader(failure)
	if (value === undefined) return Effect.void
	return HttpEffect.appendPreResponseHandler((_request, response) =>
		Effect.succeed(HttpServerResponse.setHeader(response, "Retry-After", value)),
	)
}

export const V2UnexpectedErrorsLive = Layer.succeed(
	V2UnexpectedErrors,
	V2UnexpectedErrors.of((httpEffect, { endpoint, group }) =>
		httpEffect.pipe(
			Effect.tapError(appendRetryAfter),
			Effect.tapError(observeServerError(endpoint, group)),
			Effect.catchDefect((cause) =>
				recordRenderedFailure({
					group: group.identifier,
					operation: endpoint.identifier,
					errorType: failureTypeOf(cause),
					summary: "Unexpected v2 route execution defect",
					message: cause instanceof Error ? cause.message : String(cause),
					status: 500,
					stack: failureStackOf(cause),
					cause,
				}).pipe(Effect.andThen(Effect.fail(V2UnexpectedFailure.make()))),
			),
		),
	),
)

/**
 * Transport-only failures and response headers, provided once for the API.
 * Expected domain errors never pass through this layer; their classes expose
 * their safe public body and endpoint schemas serialize them directly.
 */
export const V2TransportErrorBoundaryLive = Layer.merge(V2SchemaErrorTransformLive, V2UnexpectedErrorsLive)
