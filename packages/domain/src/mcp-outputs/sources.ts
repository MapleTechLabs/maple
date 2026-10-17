/** Output schema for the list_sources MCP tool. */
import { Schema } from "effect"
import { SOURCE_HEALTH_STATUSES } from "../source-health"
import { SourcePlatform, SourceSignal } from "../primitives"

export const SourceRow = Schema.Struct({
	/** `src_…`, the value of the `maple_source_id` resource attribute on its telemetry. */
	id: Schema.String,
	name: Schema.String,
	platform: SourcePlatform,
	/** push: sends with its own token (or the default keys); pull: an integration Maple collects from. */
	delivery: Schema.Literals(["push", "pull"]),
	isDefault: Schema.Boolean,
	status: Schema.Literals(SOURCE_HEALTH_STATUSES),
	lastDataAt: Schema.NullOr(Schema.String),
	/** Why the source is not healthy; null when it is. */
	problem: Schema.NullOr(Schema.String),
	/** Signals a token source may send; null when every signal is allowed. */
	allowedSignals: Schema.NullOr(Schema.Array(SourceSignal)),
})

export const ListSourcesOutput = Schema.Struct({
	generatedAt: Schema.String,
	/** Worst health first. */
	sources: Schema.Array(SourceRow),
})
