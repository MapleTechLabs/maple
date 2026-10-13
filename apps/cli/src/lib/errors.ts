// User-facing failures the query commands raise themselves. Each carries a
// one-line `message` plus an optional `hint`; bin.ts prints them as
// `error: <message>` and `hint: <hint>` on stderr and exits 1.

import { Schema } from "effect"

/** A flag or argument combination the command cannot run with. */
export class CliUsageError extends Schema.TaggedError<CliUsageError>()("@maple/cli/UsageError", {
	message: Schema.String,
	hint: Schema.optionalKey(Schema.String),
}) {}

/** The thing asked for (a trace, a service, a metric) has no data in the window. */
export class CliNotFoundError extends Schema.TaggedError<CliNotFoundError>()("@maple/cli/NotFoundError", {
	message: Schema.String,
	hint: Schema.optionalKey(Schema.String),
}) {}

/** The local server could not be reached, or what answered is not a Maple server. */
export class LocalServerUnreachableError extends Schema.TaggedError<LocalServerUnreachableError>()(
	"@maple/cli/LocalServerUnreachableError",
	{
		url: Schema.String,
		message: Schema.String,
		hint: Schema.optionalKey(Schema.String),
	},
) {}

/** `/local/query` refused a write, a multi-statement batch, or a table function. */
export class ReadOnlyQueryError extends Schema.TaggedError<ReadOnlyQueryError>()(
	"@maple/cli/ReadOnlyQueryError",
	{
		reason: Schema.String,
		message: Schema.String,
	},
) {}
