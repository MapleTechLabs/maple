import { Array as Arr, Schema } from "effect"
import {
	AlertDestinationId,
	AlertRuleId,
	EscalationChainId,
	IsoDateTimeString,
	OnCallScheduleId,
	UserId,
} from "../primitives"
import { HttpTaggedError } from "./error-policy"

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

/** Who a step notifies. */
export const EscalationTarget = Schema.Union([
	EscalationDestinationTarget,
	EscalationUserTarget,
	EscalationScheduleTarget,
]).annotate({ identifier: "@maple/EscalationTarget", title: "Escalation Target" })
export type EscalationTarget = Schema.Schema.Type<typeof EscalationTarget>

/** The destinations, users and schedules `steps` names, each once. */
export const escalationStepTargetIds = (
	steps: ReadonlyArray<{ readonly targets: ReadonlyArray<EscalationTarget> }>,
) => {
	const targets = Arr.flatMap(steps, (step) => step.targets)
	return {
		destinationIds: Arr.dedupe(
			Arr.flatMap(targets, (t) => (t.type === "destination" ? [t.destinationId] : [])),
		),
		userIds: Arr.dedupe(Arr.flatMap(targets, (t) => (t.type === "user" ? [t.userId] : []))),
		scheduleIds: Arr.dedupe(Arr.flatMap(targets, (t) => (t.type === "schedule" ? [t.scheduleId] : []))),
	}
}

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

/** Extra passes over the whole chain after the first; 0 runs it once. */
export const EscalationRepeatCount = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(0),
	Schema.isLessThanOrEqualTo(MAX_ESCALATION_REPEATS),
)

export const EscalationChainName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isTrimmed(),
	Schema.isMaxLength(120),
)
export const EscalationChainDescription = Schema.String.check(Schema.isMaxLength(500))

export class EscalationChainDocument extends Schema.Class<EscalationChainDocument>("EscalationChainDocument")(
	{
		id: EscalationChainId,
		name: Schema.String,
		description: Schema.NullOr(Schema.String),
		steps: EscalationSteps,
		repeatCount: Schema.Number,
		/** Rules with a tier that starts this chain. */
		ruleIds: Schema.Array(AlertRuleId),
		createdAt: IsoDateTimeString,
		updatedAt: IsoDateTimeString,
	},
) {}

export class EscalationChainsListResponse extends Schema.Class<EscalationChainsListResponse>(
	"EscalationChainsListResponse",
)({
	chains: Schema.Array(EscalationChainDocument),
}) {}

export class EscalationChainCreateRequest extends Schema.Class<EscalationChainCreateRequest>(
	"EscalationChainCreateRequest",
)({
	name: EscalationChainName,
	description: Schema.optionalKey(Schema.NullOr(EscalationChainDescription)),
	steps: EscalationSteps,
	repeatCount: Schema.optionalKey(EscalationRepeatCount),
}) {}

export class EscalationChainUpdateRequest extends Schema.Class<EscalationChainUpdateRequest>(
	"EscalationChainUpdateRequest",
)({
	name: Schema.optionalKey(EscalationChainName),
	description: Schema.optionalKey(Schema.NullOr(EscalationChainDescription)),
	steps: Schema.optionalKey(EscalationSteps),
	repeatCount: Schema.optionalKey(EscalationRepeatCount),
}) {}

/** How far an incident's escalation got. `active` waits on `nextStepAt`. */
export const AlertEscalationRunStatus = Schema.Literals([
	"active",
	"acknowledged",
	"resolved",
	"exhausted",
	"superseded",
]).annotate({ identifier: "@maple/AlertEscalationRunStatus", title: "Alert Escalation Run Status" })
export type AlertEscalationRunStatus = Schema.Schema.Type<typeof AlertEscalationRunStatus>

export class EscalationChainNotFoundError extends HttpTaggedError<EscalationChainNotFoundError>()(
	"@maple/http/errors/EscalationChainNotFoundError",
	{ message: Schema.String, chainId: EscalationChainId },
	{
		status: 404,
		code: "escalation_chain_not_found",
		title: "Escalation chain not found",
		message: "No such escalation chain.",
		param: "id",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

export class EscalationChainInUseError extends HttpTaggedError<EscalationChainInUseError>()(
	"@maple/http/errors/EscalationChainInUseError",
	{
		message: Schema.String,
		chainId: EscalationChainId,
		ruleIds: Schema.Array(AlertRuleId),
		ruleNames: Schema.Array(Schema.String),
	},
	{
		status: 409,
		code: "escalation_chain_in_use",
		title: "Escalation chain is in use",
		message: "The escalation chain is used by one or more alert rules.",
		retry: "never",
		recovery: "fix_request",
		exposure: "redacted",
	},
) {}
