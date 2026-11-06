import { Schema } from "effect"
import { HttpApiMiddleware } from "effect/http-api"

/**
 * Uniform request-decode failure for the unversioned `/api` and `/internal` HttpApis.
 *
 * They keep a top-level tagged-error wire format, but malformed params, query
 * strings, headers, and payloads must still return a useful JSON body instead of
 * Effect's default empty 400 response. The `v1` in the tags predates the v1
 * retirement; it stays because error fingerprints key on it.
 */
export class ApiRequestValidationError extends Schema.TaggedError<ApiRequestValidationError>()(
	"@maple/http/v1/V1RequestValidationError",
	{
		message: Schema.String,
		param: Schema.optionalKey(Schema.String),
		details: Schema.Array(Schema.String),
	},
	{ httpApiStatus: 400 },
) {}

/** Sanitized response for an unexpected defect in an unversioned HttpApi handler. */
export class ApiUnexpectedError extends Schema.TaggedError<ApiUnexpectedError>()(
	"@maple/http/v1/V1UnexpectedError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 500 },
) {}

/** Rewrites request/response schema failures for every unversioned HttpApi endpoint. */
export class ApiSchemaErrors extends HttpApiMiddleware.Service<ApiSchemaErrors>()("ApiSchemaErrors", {
	error: [ApiRequestValidationError, ApiUnexpectedError],
}) {}

/** Converts unexpected handler defects into a logged, sanitized response. */
export class ApiUnexpectedErrors extends HttpApiMiddleware.Service<ApiUnexpectedErrors>()(
	"ApiUnexpectedErrors",
	{ error: ApiUnexpectedError },
) {}
