import { Schema } from "effect"

/**
 * One failed AWS call, folded to what the connection check does about it. `assume_denied`: the role
 * or the account's OIDC provider for Maple is missing, or the role does not trust this connection's
 * token. `read_denied`: Maple assumed the role but it cannot read itself (an edited or partial
 * setup). `maple_identity`: AWS could not verify Maple's token, a deployment problem rather than
 * the customer's.
 */
export class AwsApiError extends Schema.TaggedError<AwsApiError>()(
	"@maple/backend/integrations/AwsApiError",
	{
		message: Schema.String,
		kind: Schema.Literals(["assume_denied", "read_denied", "maple_identity", "throttled", "upstream"]),
		/** The AWS error code, when AWS sent one. */
		code: Schema.optionalKey(Schema.String),
	},
) {}

/** Maple's OIDC signing key cannot be read or used. */
export class AwsOidcKeyError extends Schema.TaggedError<AwsOidcKeyError>()(
	"@maple/backend/integrations/AwsOidcKeyError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}
