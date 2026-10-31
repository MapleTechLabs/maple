/** Output schema for the list_sources MCP tool. */
import { Schema } from "effect"
import { SOURCE_HEALTH_STATUSES } from "../source-health"
import { SourceKind, SourcePlatform, SourceSignal } from "../primitives"

export const SourceRow = Schema.Struct({
	/** `src_…`, the value of the `maple_source_id` resource attribute on its telemetry. */
	id: Schema.String,
	name: Schema.String,
	platform: SourcePlatform,
	/** default: the org's default keys; token: its own source token; integration: Maple collects from it. */
	kind: SourceKind,
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
