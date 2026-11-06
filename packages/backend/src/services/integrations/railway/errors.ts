import { Schema } from "effect"

export class RailwayApiError extends Schema.TaggedError<RailwayApiError>()(
	"@maple/backend/integrations/RailwayApiError",
	{
		message: Schema.String,
		kind: Schema.Literals(["unauthorized", "rate_limited", "upstream"]),
		retryAfterSeconds: Schema.optionalKey(Schema.Number),
	},
) {}
