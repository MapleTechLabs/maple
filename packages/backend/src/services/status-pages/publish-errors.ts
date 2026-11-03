import { StatusPageId } from "@maple/domain/primitives"
import { Schema } from "effect"

/** The page was deleted (or never existed) by the time the publisher read it. */
export class StatusPageGoneError extends Schema.TaggedError<StatusPageGoneError>()(
	"@maple/backend/status-pages/StatusPageGoneError",
	{ message: Schema.String, pageId: StatusPageId },
) {}

/** A Postgres read or write on the publish path failed. */
export class StatusPagePublishDbError extends Schema.TaggedError<StatusPagePublishDbError>()(
	"@maple/backend/status-pages/StatusPagePublishDbError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.String) },
) {}
