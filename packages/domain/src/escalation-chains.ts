// Stored shapes shared by the HTTP contract (`./http/escalation-chains.ts`) and the Postgres tables.

import { AlertDestinationId, OnCallScheduleId, UserId } from "@maple/primitives"
import { Schema } from "effect"

export const MAX_ESCALATION_STEPS = 10
export const MAX_ESCALATION_STEP_TARGETS = 10
export const MAX_ESCALATION_REPEATS = 5
/** A day: a longer wait is a schedule, not an escalation. */
export const MAX_ESCALATION_WAIT_MINUTES = 1440

export const EscalationDestinationTarget = Schema.Struct({
	type: Schema.Literal("destination"),
	destinationId: AlertDestinationId,
})
/** A member, paged by email and by direct message on every chat account they linked. */
export const EscalationUserTarget = Schema.Struct({
	type: Schema.Literal("user"),
	userId: UserId,
})
/** Whoever is on call on the schedule when the step fires; nobody when it has a gap. */
export const EscalationScheduleTarget = Schema.Struct({
	type: Schema.Literal("schedule"),
	scheduleId: OnCallScheduleId,
})

export const EscalationTarget = Schema.Union([
	EscalationDestinationTarget,
	EscalationUserTarget,
	EscalationScheduleTarget,
]).annotate({ identifier: "@maple/EscalationTarget", title: "Escalation Target" })
export type EscalationTarget = Schema.Schema.Type<typeof EscalationTarget>

export const EscalationWaitMinutes = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(1),
	Schema.isLessThanOrEqualTo(MAX_ESCALATION_WAIT_MINUTES),
)

/** Notify every target, then wait `waitMinutes` for an acknowledgement before the next step. */
export const EscalationStep = Schema.Struct({
	targets: Schema.NonEmptyArray(EscalationTarget).check(Schema.isMaxLength(MAX_ESCALATION_STEP_TARGETS)),
	waitMinutes: EscalationWaitMinutes,
}).annotate({ identifier: "@maple/EscalationStep", title: "Escalation Step" })
export type EscalationStep = Schema.Schema.Type<typeof EscalationStep>

export const EscalationSteps = Schema.NonEmptyArray(EscalationStep)
	.check(Schema.isMaxLength(MAX_ESCALATION_STEPS))
	.annotate({ identifier: "@maple/EscalationSteps", title: "Escalation Steps" })
export type EscalationSteps = Schema.Schema.Type<typeof EscalationSteps>

/** How far an incident's escalation got. `active` waits on `nextStepAt`. */
export const AlertEscalationRunStatus = Schema.Literals([
	"active",
	"acknowledged",
	"resolved",
	"exhausted",
	"superseded",
]).annotate({ identifier: "@maple/AlertEscalationRunStatus", title: "Alert Escalation Run Status" })
export type AlertEscalationRunStatus = Schema.Schema.Type<typeof AlertEscalationRunStatus>
