import { Schema } from "effect"
import { HttpTaggedError } from "./error-policy"

// Retention policies (`../retention.ts`): how long an organization and each of its sources keep a signal.

export class RetentionPersistenceError extends HttpTaggedError<RetentionPersistenceError>()(
	"@maple/http/retention/RetentionPersistenceError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.String) },
	{
		status: 503,
		code: "retention_unavailable",
		title: "Retention settings are temporarily unavailable",
		message: "Retention settings could not be read or changed right now. Try again in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

/** A period outside what can be stored: not a whole number of days, or out of bounds. */
export class RetentionInvalidError extends HttpTaggedError<RetentionInvalidError>()(
	"@maple/http/retention/RetentionInvalidError",
	{ message: Schema.String },
	{
		status: 400,
		code: "retention_invalid",
		title: "Invalid retention period",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}
