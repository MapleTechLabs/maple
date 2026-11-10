import { Array as Arr, Schema } from "effect"
import { AlertIncidentId, AlertRuleId, EscalationChainId, IsoDateTimeString } from "../primitives"
import { HttpTaggedError } from "./error-policy"

import {
	AlertEscalationRunStatus,
	EscalationSteps,
	EscalationTarget,
	MAX_ESCALATION_REPEATS,
} from "../escalation-chains"
export {
	AlertEscalationRunStatus,
	EscalationDestinationTarget,
	EscalationScheduleTarget,
	EscalationStep,
	EscalationSteps,
	EscalationTarget,
	EscalationUserTarget,
	EscalationWaitMinutes,
	MAX_ESCALATION_REPEATS,
	MAX_ESCALATION_STEPS,
	MAX_ESCALATION_STEP_TARGETS,
	MAX_ESCALATION_WAIT_MINUTES,
} from "../escalation-chains"

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

/** An incident's latest escalation run, as the incident reads show it. Steps and passes count from 0. */
export class AlertIncidentEscalationDocument extends Schema.Class<AlertIncidentEscalationDocument>(
	"AlertIncidentEscalationDocument",
)({
	incidentId: AlertIncidentId,
	chainId: EscalationChainId,
	chainName: Schema.String,
	status: AlertEscalationRunStatus,
	stepIndex: Schema.Number,
	passIndex: Schema.Number,
	stepCount: Schema.Number,
	repeatCount: Schema.Number,
	stepsSent: Schema.Number,
	/** When the next step pages; `null` once the run is no longer `active`. */
	nextStepAt: Schema.NullOr(IsoDateTimeString),
}) {}

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
