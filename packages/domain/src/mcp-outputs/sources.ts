/** Output schema for the list_ingest_sources MCP tool (formerly list_sources). */
import { Schema } from "effect"
import { SOURCE_HEALTH_STATUSES } from "../source-health"
import { SourceKind, SourcePlatform, SourceSignal } from "@maple/primitives"

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

/** A source as a change to it leaves it: what it may send, and whether it is paused. */
export const SourceConfigRow = Schema.Struct({
	/** `src_…`, the value of the `maple_source_id` resource attribute on its telemetry. */
	id: Schema.String,
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	platform: SourcePlatform,
	kind: SourceKind,
	/** active, paused or expired. */
	tokenStatus: Schema.String,
	pausedAt: Schema.NullOr(Schema.String),
	/** When a pause lifts on its own; null for a pause that lasts until resumed. */
	pausedUntil: Schema.NullOr(Schema.String),
	allowedSignals: Schema.NullOr(Schema.Array(SourceSignal)),
	/** Requests per second the gateway accepts from its token; null when unlimited. */
	rateLimitRps: Schema.NullOr(Schema.Number),
	health: Schema.Literals(SOURCE_HEALTH_STATUSES),
	lastDataAt: Schema.NullOr(Schema.String),
})

export const SourceMutationOutput = Schema.Struct({
	action: Schema.Literals(["paused", "resumed", "updated"]),
	source: SourceConfigRow,
})

export const DeleteSourceOutput = Schema.Struct({
	deleted: Schema.Boolean,
	id: Schema.String,
	name: Schema.String,
})
