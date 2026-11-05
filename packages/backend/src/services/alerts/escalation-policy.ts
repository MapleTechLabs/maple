import type {
	AlertDestinationId,
	EscalationConfidence,
	IssueEscalationPolicyRule,
	IssueSeverity,
} from "@maple/domain/http"
import { Array as Arr, Option } from "effect"

export type EscalationSkipReason =
	| "policy_disabled"
	| "no_destinations_for_severity"
	| "below_min_confidence"
	| "no_enabled_destinations"

export type EscalationPolicyDecision =
	| {
			readonly outcome: "route"
			readonly destinationIds: ReadonlyArray<AlertDestinationId>
			readonly skipReason: null
	  }
	| {
			readonly outcome: "skip"
			readonly destinationIds: readonly []
			readonly skipReason: EscalationSkipReason
	  }

export interface EvaluateEscalationPolicyInput {
	readonly enabled: boolean
	readonly rules: ReadonlyArray<IssueEscalationPolicyRule>
	readonly severity: IssueSeverity
	readonly source: "ai" | "manual"
	readonly confidence?: EscalationConfidence
	/**
	 * When provided, routes are intersected with currently enabled
	 * destinations. Omitting it evaluates only policy shape.
	 */
	readonly enabledDestinationIds?: ReadonlySet<AlertDestinationId>
}

const CONFIDENCE_RANK: Record<EscalationConfidence, number> = {
	low: 1,
	medium: 2,
	high: 3,
} satisfies Record<EscalationConfidence, number>

/** Pure policy evaluation shared by delivery, previews, and the simulator. */
export const evaluateEscalationPolicy = (input: EvaluateEscalationPolicyInput): EscalationPolicyDecision => {
	if (!input.enabled) {
		return { outcome: "skip", destinationIds: [], skipReason: "policy_disabled" }
	}

	const found = Arr.findFirst(input.rules, (candidate) => candidate.severity === input.severity)
	if (Option.isNone(found) || found.value.destinationIds.length === 0) {
		return {
			outcome: "skip",
			destinationIds: [],
			skipReason: "no_destinations_for_severity",
		}
	}

	const rule = found.value
	if (
		input.source === "ai" &&
		rule.minConfidence !== undefined &&
		(input.confidence === undefined ||
			CONFIDENCE_RANK[input.confidence] < CONFIDENCE_RANK[rule.minConfidence])
	) {
		return { outcome: "skip", destinationIds: [], skipReason: "below_min_confidence" }
	}

	const destinationIds =
		input.enabledDestinationIds === undefined
			? rule.destinationIds
			: Arr.filter(rule.destinationIds, (id) => input.enabledDestinationIds?.has(id) === true)
	if (destinationIds.length === 0) {
		return { outcome: "skip", destinationIds: [], skipReason: "no_enabled_destinations" }
	}

	return { outcome: "route", destinationIds, skipReason: null }
}
