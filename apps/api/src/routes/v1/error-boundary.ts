import { Effect, Layer } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import {
	V1RequestValidationError,
	V1SchemaErrors,
	V1UnexpectedError,
	V1UnexpectedErrors,
} from "@maple/domain/http"
import { failureStackOf, failureTypeOf, recordRenderedFailure } from "@/routes/rendered-failure"
import { describeSchemaIssue, summarizeSchemaError } from "@/routes/schema-error-detail"
import { observeServerError } from "@/routes/server-error-observability"

const sanitized = () => new V1UnexpectedError({ message: "An unexpected error occurred on our end." })

const V1SchemaErrorTransformLive = HttpApiMiddleware.layerSchemaErrorTransform(
	V1SchemaErrors,
	(schemaError, { endpoint, group }) =>
		Effect.suspend((): Effect.Effect<never, V1RequestValidationError | V1UnexpectedError> => {
			const details = describeSchemaIssue(schemaError.cause.issue)
			if (schemaError.kind === "Body" || schemaError.kind === "ResponseHeaders") {
				return recordRenderedFailure({
					group: group.identifier,
					operation: endpoint.identifier,
					errorType: `@maple/api/routes/v1/V1ResponseSchemaError/${schemaError.kind}`,
					summary: "V1 response failed its declared HTTP schema",
					message: details.map(({ line }) => line).join("; "),
					status: 500,
					detail: details.map(({ line }) => line),
					cause: schemaError.cause,
				}).pipe(Effect.andThen(Effect.fail(sanitized())))
			}
			const first = details[0]
			return Effect.fail(
				new V1RequestValidationError({
					message: summarizeSchemaError(schemaError.kind, details),
					...(!(first === undefined || first.path === "") ? { param: first.path } : undefined),
					details: details.map(({ line }) => line),
				}),
			)
		}),
)

const V1UnexpectedErrorsLive = Layer.succeed(
	V1UnexpectedErrors,
	V1UnexpectedErrors.of((httpEffect, { endpoint, group }) =>
		httpEffect.pipe(
			Effect.tapError(observeServerError(endpoint, group)),
			Effect.catchDefect((cause) =>
				recordRenderedFailure({
					group: group.identifier,
					operation: endpoint.identifier,
					errorType: failureTypeOf(cause),
					summary: "Unexpected v1 route execution defect",
					message: cause instanceof Error ? cause.message : String(cause),
					status: 500,
					stack: failureStackOf(cause),
					cause,
				}).pipe(Effect.andThen(Effect.fail(sanitized()))),
			),
		),
	),
)

/** API-wide legacy error boundary: useful 400s and sanitized, logged defects. */
export const V1ErrorBoundaryLive = Layer.merge(V1SchemaErrorTransformLive, V1UnexpectedErrorsLive)
