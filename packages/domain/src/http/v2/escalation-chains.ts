import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Array as Arr, Schema } from "effect"
import {
	AlertForbiddenError,
	AlertMemberDirectoryUnavailableError,
	AlertPersistenceError,
	AlertValidationError,
} from "../alerts"
import {
	EscalationChainDescription,
	EscalationChainInUseError,
	EscalationChainName,
	EscalationChainNotFoundError,
	EscalationRepeatCount,
	EscalationWaitMinutes,
	MAX_ESCALATION_REPEATS,
	MAX_ESCALATION_STEPS,
	MAX_ESCALATION_STEP_TARGETS,
	MAX_ESCALATION_WAIT_MINUTES,
} from "../escalation-chains"
import { AuthorizationV2 } from "./auth"
import { wireExample, ListOf, ListQuery, Timestamp } from "./envelopes"
import { V2ParameterInvalid } from "./errors"
import { publicErrors } from "./public-error"
import { UserId } from "../../primitives"
import {
	AlertDestinationPublicId,
	AlertRulePublicId,
	EscalationChainPublicId,
	OnCallSchedulePublicId,
} from "./resource-ids"

export { EscalationChainPublicId } from "./resource-ids"

const V2EscalationDestinationTarget = Schema.Struct({
	type: Schema.Literal("destination").annotate({ description: "Notify an alert destination." }),
	destination_id: AlertDestinationPublicId.annotate({
		description: "The alert destination (`dest_…`) this step notifies.",
	}),
}).annotate({ identifier: "EscalationDestinationTarget", title: "Destination target" })

const V2EscalationUserTarget = Schema.Struct({
	type: Schema.Literal("user").annotate({
		description: "Page a member by email and by direct message on each chat account they linked.",
	}),
	user_id: UserId.annotate({ description: "A Maple user id (`user_…`) of a member of your organization." }),
}).annotate({ identifier: "EscalationUserTarget", title: "User target" })

const V2EscalationScheduleTarget = Schema.Struct({
	type: Schema.Literal("schedule").annotate({
		description: "Page whoever is on call on the schedule when the step fires.",
	}),
	schedule_id: OnCallSchedulePublicId.annotate({
		description: "The on-call schedule (`onc_…`). A gap in the schedule pages nobody for this target.",
	}),
}).annotate({ identifier: "EscalationScheduleTarget", title: "Schedule target" })

export const V2EscalationTarget = Schema.Union([
	V2EscalationDestinationTarget,
	V2EscalationUserTarget,
	V2EscalationScheduleTarget,
]).annotate({
	identifier: "EscalationTarget",
	title: "Escalation target",
	description: "Who one escalation step notifies: a destination, a member, or an on-call schedule.",
})
export type V2EscalationTarget = Schema.Schema.Type<typeof V2EscalationTarget>

// Bounded arrays on the wire, not tuples: generated clients do not all read `prefixItems`.
// The refine narrows the decoded type to non-empty and goes first, so the checks carry the docs.
// Messages are wire terms: the v2 boundary prefixes them with the field path.
const V2EscalationTargets = Schema.Array(V2EscalationTarget)
	.pipe(Schema.refine(Arr.isReadonlyArrayNonEmpty, { message: "needs at least one target" }))
	.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(MAX_ESCALATION_STEP_TARGETS, {
			message: `allows at most ${MAX_ESCALATION_STEP_TARGETS} targets per step`,
		}),
	)

export const V2EscalationStep = Schema.Struct({
	targets: V2EscalationTargets.annotate({
		description: `Who this step notifies, all at once: 1 to ${MAX_ESCALATION_STEP_TARGETS} targets.`,
	}),
	wait_minutes: EscalationWaitMinutes.annotate({
		description: `Minutes to wait for an acknowledgement before the next step (1 to ${MAX_ESCALATION_WAIT_MINUTES}).`,
		examples: [10],
	}),
}).annotate({
	identifier: "EscalationStep",
	title: "Escalation step",
	description: "Notify every target, then wait `wait_minutes` for an acknowledgement before the next step.",
})
export type V2EscalationStep = Schema.Schema.Type<typeof V2EscalationStep>

const V2EscalationSteps = Schema.Array(V2EscalationStep)
	.pipe(Schema.refine(Arr.isReadonlyArrayNonEmpty, { message: "needs at least one step" }))
	.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(MAX_ESCALATION_STEPS, { message: `allows at most ${MAX_ESCALATION_STEPS} steps` }),
	)
	.annotate({ description: `The steps in order, 1 to ${MAX_ESCALATION_STEPS}.` })

const RepeatCount = EscalationRepeatCount.annotate({
	description: `Extra passes over the whole chain after the first, 0 to ${MAX_ESCALATION_REPEATS}. \`0\` runs it once.`,
	examples: [1],
})

const escalationChainExample = {
	id: "esc_gQtGH2s65G6a7sJmuayXL6",
	object: "escalation_chain",
	name: "Checkout on-call",
	description: "Page the primary, then the secondary, then the team lead.",
	steps: [
		{
			targets: [{ type: "destination", destination_id: "dest_aMadCYFsFjn8nerC3aEWyG" }],
			wait_minutes: 10,
		},
		{
			targets: [{ type: "schedule", schedule_id: "onc_cTp8s4DaBKsNmcma6yJGSn" }],
			wait_minutes: 15,
		},
	],
	repeat_count: 1,
	rule_ids: ["alrt_pJsL1o13V4GRjetnBTaWLv"],
	created_at: "2026-07-15T09:00:00.000Z",
	updated_at: "2026-07-15T09:00:00.000Z",
} as const

export const V2EscalationChain = Schema.Struct({
	id: EscalationChainPublicId,
	object: Schema.Literal("escalation_chain").annotate({
		description: 'The object type, always `"escalation_chain"`.',
		examples: ["escalation_chain"],
	}),
	name: Schema.String.annotate({ description: "Display name.", examples: ["Checkout on-call"] }),
	description: Schema.NullOr(Schema.String).annotate({ description: "Free-form notes, or `null`." }),
	steps: V2EscalationSteps,
	repeat_count: RepeatCount,
	rule_ids: Schema.Array(AlertRulePublicId).annotate({
		description:
			"Alert rules (`alrt_…`) with a severity tier that starts this chain. A chain in use cannot be deleted.",
	}),
	created_at: Timestamp,
	updated_at: Timestamp,
}).annotate({
	identifier: "EscalationChain",
	title: "Escalation Chain",
	description:
		"An ordered paging policy. When an incident opens at a severity tier that names the chain, the tier's own destinations fire at once and the chain runs on top: each step notifies its targets, then waits for an acknowledgement before the next. Escalation stops when the incident is acknowledged or resolved.",
	examples: [wireExample(escalationChainExample)],
})
export type V2EscalationChain = Schema.Schema.Type<typeof V2EscalationChain>

export const V2EscalationChainCreateParams = Schema.Struct({
	name: EscalationChainName.annotate({ description: "Display name, 1 to 120 characters." }),
	description: Schema.optionalKey(
		Schema.NullOr(EscalationChainDescription).annotate({
			description: "Free-form notes, at most 500 characters.",
		}),
	),
	steps: V2EscalationSteps,
	repeat_count: Schema.optionalKey(RepeatCount),
}).annotate({
	identifier: "EscalationChainCreateParams",
	title: "Create escalation chain",
	description:
		"Every destination and schedule a step names must exist in your organization, and every user must be a member.",
	examples: [
		wireExample({
			name: escalationChainExample.name,
			steps: escalationChainExample.steps,
			repeat_count: 1,
		}),
	],
})
export type V2EscalationChainCreateParams = Schema.Schema.Type<typeof V2EscalationChainCreateParams>

export const V2EscalationChainUpdateParams = Schema.Struct({
	name: Schema.optionalKey(EscalationChainName),
	description: Schema.optionalKey(Schema.NullOr(EscalationChainDescription)),
	steps: Schema.optionalKey(
		V2EscalationSteps.annotate({
			description: "Replaces every step. Running escalations keep their own copy.",
		}),
	),
	repeat_count: Schema.optionalKey(RepeatCount),
}).annotate({
	identifier: "EscalationChainUpdateParams",
	title: "Update escalation chain",
	description:
		"Omitted fields are unchanged. An escalation already running finishes on the chain it started with.",
	examples: [wireExample({ repeat_count: 2 })],
})
export type V2EscalationChainUpdateParams = Schema.Schema.Type<typeof V2EscalationChainUpdateParams>

export const V2EscalationChainDeleteResponse = Schema.Struct({
	id: EscalationChainPublicId,
	object: Schema.Literal("escalation_chain").annotate({
		description: 'The object type, always `"escalation_chain"`.',
	}),
	deleted: Schema.Literal(true).annotate({ description: "Always `true`: the chain no longer exists." }),
}).annotate({
	identifier: "EscalationChainDeleteResponse",
	title: "Escalation chain delete response",
	description: "Confirmation that an escalation chain was deleted.",
	examples: [wireExample({ id: escalationChainExample.id, object: "escalation_chain", deleted: true })],
})
export type V2EscalationChainDeleteResponse = Schema.Schema.Type<typeof V2EscalationChainDeleteResponse>

const EscalationChainList = ListOf(V2EscalationChain).annotate({
	identifier: "EscalationChainList",
	title: "Escalation chain list",
	description: "A cursor-paginated page of escalation chains, by name.",
})

const [alertForbidden, alertValidation, alertPersistence, chainNotFound, chainInUse, directoryUnavailable] =
	publicErrors(
		AlertForbiddenError,
		AlertValidationError,
		AlertPersistenceError,
		EscalationChainNotFoundError,
		EscalationChainInUseError,
		AlertMemberDirectoryUnavailableError,
	)

export class V2EscalationChainsApiGroup extends HttpApiGroup.make("escalationChains")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: ListQuery,
			success: EscalationChainList,
			error: [V2ParameterInvalid.schema, alertPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listEscalationChains",
				summary: "List escalation chains",
				description:
					"Returns your organization's escalation chains by name, each with the rules that use it. Requires the `alerts:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: { id: EscalationChainPublicId },
			success: V2EscalationChain,
			error: [chainNotFound, alertPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getEscalationChain",
				summary: "Retrieve an escalation chain",
				description:
					"Returns a single escalation chain by its `esc_…` ID. Requires the `alerts:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: V2EscalationChainCreateParams,
			success: V2EscalationChain,
			error: [alertForbidden, alertValidation, alertPersistence, directoryUnavailable],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createEscalationChain",
				summary: "Create an escalation chain",
				description:
					"Creates a chain. Attach it to an alert rule through a severity tier's `escalation_chain_id`. Fails with an `invalid_request_error` when a step names an unknown destination or schedule, or a user who is not a member. Requires a role that can manage alerts and the `alerts:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.patch("update", "/:id", {
			params: { id: EscalationChainPublicId },
			payload: V2EscalationChainUpdateParams,
			success: V2EscalationChain,
			error: [alertForbidden, alertValidation, alertPersistence, chainNotFound, directoryUnavailable],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateEscalationChain",
				summary: "Update an escalation chain",
				description:
					"Changes the name, description, steps or repeat count. New incidents use the new steps. Requires the `alerts:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/:id", {
			params: { id: EscalationChainPublicId },
			success: V2EscalationChainDeleteResponse,
			error: [alertForbidden, alertPersistence, chainNotFound, chainInUse],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "deleteEscalationChain",
				summary: "Delete an escalation chain",
				description:
					"Deletes a chain. Fails with a `conflict_error` while any alert rule tier still names it; detach it from those rules first. Requires the `alerts:write` scope.",
			}),
		),
	)
	.prefix("/v2/alerts/escalation_chains")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Escalation Chains",
			description:
				"Step-by-step paging for alert incidents: notify the first responder, wait for an acknowledgement, then widen the circle. A rule's severity tier names the chain it starts.",
		}),
	) {}
