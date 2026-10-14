import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { IsoDateTimeString, UserId } from "../primitives"
import { SessionAuthorization } from "./current-tenant"

export const OPENROUTER_KEY_MAX_LENGTH = 256

/**
 * The org's own OpenRouter key, as the settings page sees it. The key itself never comes back:
 * `keyHint` is its last four characters.
 */
export class OpenRouterKeyDocument extends Schema.Class<OpenRouterKeyDocument>("OpenRouterKeyDocument")({
	/** The org holds the add-on, so a saved key is used. */
	entitled: Schema.Boolean,
	configured: Schema.Boolean,
	keyHint: Schema.NullOr(Schema.String),
	updatedAt: Schema.NullOr(IsoDateTimeString),
	updatedBy: Schema.NullOr(UserId),
}) {}

export class OpenRouterKeyUpdateRequest extends Schema.Class<OpenRouterKeyUpdateRequest>(
	"OpenRouterKeyUpdateRequest",
)({
	// OpenRouter keys are about 75 characters; the cap keeps an oversized body from reaching OpenRouter.
	apiKey: Schema.String.check(Schema.isMaxLength(OPENROUTER_KEY_MAX_LENGTH)),
}) {}

export class OpenRouterKeyPersistenceError extends Schema.TaggedError<OpenRouterKeyPersistenceError>()(
	"@maple/http/openrouter-key/OpenRouterKeyPersistenceError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.String) },
	{ httpApiStatus: 503 },
) {}

export class OpenRouterKeyForbiddenError extends Schema.TaggedError<OpenRouterKeyForbiddenError>()(
	"@maple/http/openrouter-key/OpenRouterKeyForbiddenError",
	{ message: Schema.String },
	{ httpApiStatus: 403 },
) {}

/** The org does not hold the `openrouter_byok` add-on. */
export class OpenRouterKeyAddOnRequiredError extends Schema.TaggedError<OpenRouterKeyAddOnRequiredError>()(
	"@maple/http/openrouter-key/OpenRouterKeyAddOnRequiredError",
	{ message: Schema.String },
	{ httpApiStatus: 402 },
) {}

/** The key is malformed, or OpenRouter rejected it. */
export class OpenRouterKeyValidationError extends Schema.TaggedError<OpenRouterKeyValidationError>()(
	"@maple/http/openrouter-key/OpenRouterKeyValidationError",
	{ message: Schema.String },
	{ httpApiStatus: 400 },
) {}

export class OpenRouterKeyApiGroup extends HttpApiGroup.make("openRouterKey")
	.add(
		HttpApiEndpoint.get("get", "/", {
			success: OpenRouterKeyDocument,
			error: OpenRouterKeyPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.put("set", "/", {
			payload: OpenRouterKeyUpdateRequest,
			success: OpenRouterKeyDocument,
			error: [
				OpenRouterKeyPersistenceError,
				OpenRouterKeyForbiddenError,
				OpenRouterKeyAddOnRequiredError,
				OpenRouterKeyValidationError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("remove", "/", {
			success: OpenRouterKeyDocument,
			error: [OpenRouterKeyPersistenceError, OpenRouterKeyForbiddenError],
		}),
	)
	.prefix("/internal/openrouter-key")
	.middleware(SessionAuthorization) {}
