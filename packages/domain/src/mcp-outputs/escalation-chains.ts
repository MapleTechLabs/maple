/** Output schemas for the escalation chain MCP tools. */
import { Schema } from "effect"

const NullableString = Schema.NullOr(Schema.String)

export const EscalationTargetRow = Schema.Struct({
	/** A destination, a member paged directly, or whoever is on call on a schedule. */
	kind: Schema.Literals(["destination", "user", "schedule"]),
	id: Schema.String,
	/** The target's id in the REST API: `dest_…`, `onc_…`, or the user id as-is. */
	publicId: Schema.String,
	/** Null when the name could not be read or the target is gone. */
	name: NullableString,
	/** The destination's type; null for a user or schedule. */
	type: NullableString,
})

export const EscalationStepRow = Schema.Struct({
	targets: Schema.Array(EscalationTargetRow),
	waitMinutes: Schema.Number,
})

export const EscalationChainRow = Schema.Struct({
	id: Schema.String,
	/** The same chain's id in the REST API (`esc_…`). */
	publicId: Schema.String,
	name: Schema.String,
	description: NullableString,
	steps: Schema.Array(EscalationStepRow),
	repeatCount: Schema.Number,
	/** Rules with a tier that starts this chain. */
	ruleIds: Schema.Array(Schema.String),
	createdAt: Schema.String,
	updatedAt: Schema.String,
})

export const ListEscalationChainsOutput = Schema.Struct({
	chains: Schema.Array(EscalationChainRow),
	total: Schema.Number,
})

export const EscalationChainMutationOutput = Schema.Struct({ chain: EscalationChainRow })

export const DeleteEscalationChainOutput = Schema.Struct({ id: Schema.String, name: Schema.String })
