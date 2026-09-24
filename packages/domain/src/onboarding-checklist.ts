// The onboarding reward checklist: five activation steps a new org can finish within a window
// of its creation to earn a credit. Pure and dependency-free, same shape as `./setup-audit` —
// one IO pass in the API populates `OnboardingChecklistInputs`, and everything here is a
// function over it, so the status rules are testable without a database.
//
// Steps are verified from what the org actually did (telemetry arrived, an installation is
// active, a rule exists), never from a self-reported flag: the reward has a price.

import { Schema } from "effect"
import { HttpTaggedError } from "./http/error-policy"

/** How long after org creation the reward stays claimable. */
export const ONBOARDING_REWARD_WINDOW_MS = 24 * 60 * 60 * 1000
export const ONBOARDING_REWARD_AMOUNT_USD = 30
/** Id of the Autumn reward the API applies to the org's subscription; defined in `apps/api/autumn.config.ts`. */
export const ONBOARDING_REWARD_ID = "onboarding_checklist"

export const ONBOARDING_CHECKLIST_STEP_IDS = [
	"send_telemetry",
	"connect_github",
	"create_alert_rule",
	"connect_mcp_agent",
	"invite_teammate",
] as const
export type OnboardingChecklistStepId = (typeof ONBOARDING_CHECKLIST_STEP_IDS)[number]

/** Shown and tracked, but never required for the reward; excluded from the counts. */
export const ONBOARDING_OPTIONAL_STEP_IDS: ReadonlySet<OnboardingChecklistStepId> = new Set([
	"invite_teammate",
])

export type OnboardingChecklistStatus = "in_progress" | "claimable" | "claimed" | "expired"

export interface OnboardingChecklistInputs {
	/** Org creation time; `null` when the identity provider cannot say (self-hosted). */
	readonly orgCreatedAtMs: number | null
	readonly rewardClaimedAtMs: number | null
	/** Any of traces, logs or metrics is present. */
	readonly telemetryPresent: boolean
	readonly githubConnected: boolean
	readonly alertRuleCount: number
	readonly alertDestinationCount: number
	readonly memberCount: number
	readonly mcpKeyUsed: boolean
}

export interface OnboardingChecklistStep {
	readonly id: OnboardingChecklistStepId
	readonly completed: boolean
	readonly optional: boolean
}

export interface OnboardingChecklistEvaluation {
	readonly status: OnboardingChecklistStatus
	/** `null` only when the org's age is unknown, in which case `status` is `expired`. */
	readonly deadlineAtMs: number | null
	readonly claimedAtMs: number | null
	readonly steps: ReadonlyArray<OnboardingChecklistStep>
	/** Required steps only — optional ones neither count nor block. */
	readonly completedCount: number
	readonly totalCount: number
}

/** Inputs that mark every step undone — what an expired or claimed org is evaluated with. */
export const emptyOnboardingChecklistInputs = (
	base: Pick<OnboardingChecklistInputs, "orgCreatedAtMs" | "rewardClaimedAtMs">,
): OnboardingChecklistInputs => ({
	...base,
	telemetryPresent: false,
	githubConnected: false,
	alertRuleCount: 0,
	alertDestinationCount: 0,
	memberCount: 0,
	mcpKeyUsed: false,
})

const stepCompleted = (id: OnboardingChecklistStepId, inputs: OnboardingChecklistInputs): boolean => {
	switch (id) {
		case "send_telemetry":
			return inputs.telemetryPresent
		case "connect_github":
			return inputs.githubConnected
		case "create_alert_rule":
			return inputs.alertRuleCount > 0 && inputs.alertDestinationCount > 0
		case "invite_teammate":
			return inputs.memberCount > 1
		case "connect_mcp_agent":
			return inputs.mcpKeyUsed
	}
}

/** Whether the reward window is still open at `nowMs`. The deadline itself is inside. */
export const onboardingRewardWindowOpen = (orgCreatedAtMs: number | null, nowMs: number): boolean =>
	orgCreatedAtMs !== null && nowMs <= orgCreatedAtMs + ONBOARDING_REWARD_WINDOW_MS

export const evaluateOnboardingChecklist = (
	inputs: OnboardingChecklistInputs,
	nowMs: number,
): OnboardingChecklistEvaluation => {
	const steps = ONBOARDING_CHECKLIST_STEP_IDS.map((id) => ({
		id,
		completed: stepCompleted(id, inputs),
		optional: ONBOARDING_OPTIONAL_STEP_IDS.has(id),
	}))
	const required = steps.filter((step) => !step.optional)
	const completedCount = required.filter((step) => step.completed).length
	const totalCount = required.length
	const deadlineAtMs =
		inputs.orgCreatedAtMs === null ? null : inputs.orgCreatedAtMs + ONBOARDING_REWARD_WINDOW_MS

	// Precedence: a claim is final whatever the clock says; an org past its window (or of unknown
	// age) is out whatever it did; only then does completeness matter.
	const status: OnboardingChecklistStatus =
		inputs.rewardClaimedAtMs !== null
			? "claimed"
			: !onboardingRewardWindowOpen(inputs.orgCreatedAtMs, nowMs)
				? "expired"
				: completedCount === totalCount
					? "claimable"
					: "in_progress"

	return {
		status,
		deadlineAtMs,
		claimedAtMs: inputs.rewardClaimedAtMs,
		steps,
		completedCount,
		totalCount,
	}
}

export class OnboardingChecklistUnavailableError extends HttpTaggedError<OnboardingChecklistUnavailableError>()(
	"@maple/http/errors/OnboardingChecklistUnavailableError",
	{
		message: Schema.String,
		operation: Schema.String,
		cause: Schema.Defect(),
	},
	{
		status: 503,
		code: "onboarding_checklist_unavailable",
		title: "Onboarding checklist is temporarily unavailable",
		message: "The onboarding checklist is temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export const OnboardingRewardNotClaimableReason = Schema.Literals([
	"incomplete",
	"expired",
	"in_progress",
	"no_subscription",
])
export type OnboardingRewardNotClaimableReason = Schema.Schema.Type<typeof OnboardingRewardNotClaimableReason>

export class OnboardingRewardNotClaimableError extends HttpTaggedError<OnboardingRewardNotClaimableError>()(
	"@maple/http/errors/OnboardingRewardNotClaimableError",
	{
		message: Schema.String,
		reason: OnboardingRewardNotClaimableReason,
	},
	{
		status: 409,
		code: "onboarding_reward_not_claimable",
		title: "Reward cannot be claimed",
		message: "The onboarding reward cannot be claimed right now.",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}
