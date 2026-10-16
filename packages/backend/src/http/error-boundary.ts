import { Effect, Layer } from "effect"
import { HttpApiMiddleware } from "effect/http-api"
import {
	ApiRequestValidationError,
	ApiSchemaErrors,
	ApiUnexpectedError,
	ApiUnexpectedErrors,
} from "@maple/domain/http"
import { failureStackOf, failureTypeOf, recordRenderedFailure } from "@maple/backend/http/rendered-failure"
import { describeSchemaIssue, summarizeSchemaError } from "@maple/backend/http/schema-error-detail"
import { observeServerError } from "@maple/backend/http/server-error-observability"

const sanitized = () => new ApiUnexpectedError({ message: "An unexpected error occurred on our end." })

const ApiSchemaErrorTransformLive = HttpApiMiddleware.layerSchemaErrorTransform(
	ApiSchemaErrors,
	(schemaError, { endpoint, group }) =>
		Effect.suspend((): Effect.Effect<never, ApiRequestValidationError | ApiUnexpectedError> => {
			const details = describeSchemaIssue(schemaError.cause.issue)
			if (schemaError.kind === "Body" || schemaError.kind === "ResponseHeaders") {
				return recordRenderedFailure({
					group: group.identifier,
					operation: endpoint.identifier,
					errorType: `@maple/api/routes/v1/V1ResponseSchemaError/${schemaError.kind}`,
					summary: "Response failed its declared HTTP schema",
					message: details.map(({ line }) => line).join("; "),
					status: 500,
					detail: details.map(({ line }) => line),
					cause: schemaError.cause,
				}).pipe(Effect.andThen(Effect.fail(sanitized())))
			}
			const first = details[0]
			return Effect.fail(
				new ApiRequestValidationError({
					message: summarizeSchemaError(schemaError.kind, details),
					...(!(first === undefined || first.path === "") ? { param: first.path } : undefined),
					details: details.map(({ line }) => line),
				}),
			)
		}),
)

const ApiUnexpectedErrorsLive = Layer.succeed(
	ApiUnexpectedErrors,
	ApiUnexpectedErrors.of((httpEffect, { endpoint, group }) =>
		httpEffect.pipe(
			Effect.tapError(observeServerError(endpoint, group)),
			Effect.catchDefect((cause) =>
				recordRenderedFailure({
					group: group.identifier,
					operation: endpoint.identifier,
					errorType: failureTypeOf(cause),
					summary: "Unexpected route execution defect",
					message: cause instanceof Error ? cause.message : String(cause),
					status: 500,
					stack: failureStackOf(cause),
					cause,
				}).pipe(Effect.andThen(Effect.fail(sanitized()))),
			),
		),
	),
)

/** Error boundary for the unversioned and internal HttpApis: useful 400s and sanitized, logged defects. */
export const ApiErrorBoundaryLive = Layer.merge(ApiSchemaErrorTransformLive, ApiUnexpectedErrorsLive)
