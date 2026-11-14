import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { IsoDateTimeString, UserId } from "@maple/primitives"
import { SessionAuthorization } from "./current-tenant"
import { HttpTaggedError } from "./error-policy"

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

// The settings and Cost pages show these to the person saving a key, so each carries a public
// body: a plain tagged error reaches the browser as "An unexpected error occurred".

/** The database or OpenRouter could not be reached; its own text can carry internals, so it stays server-side. */
export class OpenRouterKeyPersistenceError extends HttpTaggedError<OpenRouterKeyPersistenceError>()(
	"@maple/http/openrouter-key/OpenRouterKeyPersistenceError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.String) },
	{
		status: 503,
		code: "openrouter_key_unavailable",
		title: "OpenRouter keys are temporarily unavailable",
		message: "The key could not be checked or saved right now. Try again in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class OpenRouterKeyForbiddenError extends HttpTaggedError<OpenRouterKeyForbiddenError>()(
	"@maple/http/openrouter-key/OpenRouterKeyForbiddenError",
	{ message: Schema.String },
	{
		status: 403,
		code: "openrouter_key_forbidden",
		title: "Permission required",
		retry: "never",
		recovery: "request_access",
		exposure: "public_message",
	},
) {}

/** The org does not hold the `openrouter_byok` add-on. */
export class OpenRouterKeyAddOnRequiredError extends HttpTaggedError<OpenRouterKeyAddOnRequiredError>()(
	"@maple/http/openrouter-key/OpenRouterKeyAddOnRequiredError",
	{ message: Schema.String },
	{
		status: 402,
		code: "openrouter_key_add_on_required",
		title: "Add-on required",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/** The key is malformed, or OpenRouter rejected it. The message says which, and what to use instead. */
export class OpenRouterKeyValidationError extends HttpTaggedError<OpenRouterKeyValidationError>()(
	"@maple/http/openrouter-key/OpenRouterKeyValidationError",
	{ message: Schema.String },
	{
		status: 400,
		code: "openrouter_key_invalid",
		title: "OpenRouter key not accepted",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
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
