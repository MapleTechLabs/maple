import { Schema } from "effect"
import { HttpTaggedError } from "./error-policy"

// What every provider read with a pasted credential answers when one is saved or removed. The
// Cost page shows these to the person saving it, so each carries a public body.

/** The saved credential never comes back: only the account it reads. */
export class CostConnectionSaved extends Schema.Class<CostConnectionSaved>("CostConnectionSaved")({
	accountId: Schema.String,
	accountLabel: Schema.String,
}) {}

export class CostConnectionRemoved extends Schema.Class<CostConnectionRemoved>("CostConnectionRemoved")({
	removed: Schema.Boolean,
}) {}

/** The database or the provider could not be reached; its own text can carry internals, so it stays server-side. */
export class CostConnectionPersistenceError extends HttpTaggedError<CostConnectionPersistenceError>()(
	"@maple/http/cost-connections/CostConnectionPersistenceError",
	{ message: Schema.String },
	{
		status: 503,
		code: "cost_connection_unavailable",
		title: "Cost sources are temporarily unavailable",
		message: "The credential could not be checked or saved right now. Try again in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class CostConnectionForbiddenError extends HttpTaggedError<CostConnectionForbiddenError>()(
	"@maple/http/cost-connections/CostConnectionForbiddenError",
	{ message: Schema.String },
	{
		status: 403,
		code: "cost_connection_forbidden",
		title: "Permission required",
		retry: "never",
		recovery: "request_access",
		exposure: "public_message",
	},
) {}

/** The credential is malformed, or the provider refused it. The message says which, and what to use instead. */
export class CostConnectionValidationError extends HttpTaggedError<CostConnectionValidationError>()(
	"@maple/http/cost-connections/CostConnectionValidationError",
	{ message: Schema.String },
	{
		status: 400,
		code: "cost_connection_invalid",
		title: "Credential not accepted",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}
