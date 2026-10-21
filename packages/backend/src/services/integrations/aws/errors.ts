import { Schema } from "effect"

/**
 * One failed AWS call, folded to what the connection check does about it. `assume_denied`: the role
 * does not exist or does not trust Maple with this external id. `read_denied`: Maple assumed the
 * role but it cannot read itself (an edited or partial setup). `maple_credentials`: AWS rejected
 * Maple's own key, a deployment problem rather than the customer's.
 */
export class AwsApiError extends Schema.TaggedError<AwsApiError>()(
	"@maple/backend/integrations/AwsApiError",
	{
		message: Schema.String,
		kind: Schema.Literals(["assume_denied", "read_denied", "maple_credentials", "throttled", "upstream"]),
		/** The AWS error code, when AWS sent one. */
		code: Schema.optionalKey(Schema.String),
	},
) {}
