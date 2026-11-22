// A coding agent's onboarding run: the dashboard mints a handoff code, the agent signs the CLI in
// with it and reports each setup stage, and the connect step shows those stages live.
// Self-reported by the agent: progress only, never the basis of a reward or a permission.

import { Array as Arr, Schema } from "effect"
import { HttpTaggedError } from "./http/error-policy"

/** The stages in the order the setup guide walks them. */
export const ONBOARDING_AGENT_STAGES = [
	"connect_agent",
	"analyze_project",
	"instrument_app",
	"send_verification",
	"receive_verification",
	"prepare_production",
] as const
export const OnboardingAgentStage = Schema.Literals(ONBOARDING_AGENT_STAGES)
export type OnboardingAgentStage = (typeof ONBOARDING_AGENT_STAGES)[number]

/** What an agent may report for a stage. */
export const OnboardingAgentReportedStatus = Schema.Literals([
	"active",
	"waiting",
	"completed",
	"skipped",
	"failed",
])
export type OnboardingAgentReportedStatus = Schema.Schema.Type<typeof OnboardingAgentReportedStatus>

/** A stage's status as stored: `pending` until the agent first reports it. */
export const OnboardingAgentStageStatus = Schema.Literals([
	"pending",
	"active",
	"waiting",
	"completed",
	"skipped",
	"failed",
])
export type OnboardingAgentStageStatus = Schema.Schema.Type<typeof OnboardingAgentStageStatus>

export const OnboardingAgentRunStatus = Schema.Literals([
	"waiting_for_agent",
	"in_progress",
	"completed",
	"failed",
	"expired",
])
export type OnboardingAgentRunStatus = Schema.Schema.Type<typeof OnboardingAgentRunStatus>

/** How long the handoff code signs a CLI in. Matches the device login's code lifetime. */
export const ONBOARDING_HANDOFF_TTL_MS = 15 * 60 * 1000
/** How long a run takes reports. An agent setup that outlives a day starts a new run. */
export const ONBOARDING_AGENT_RUN_TTL_MS = 24 * 60 * 60 * 1000
export const ONBOARDING_AGENT_NOTE_MAX = 200
export const ONBOARDING_AGENT_SERVICES_MAX = 20

export const OnboardingAgentStageRecord = Schema.Struct({
	stage: OnboardingAgentStage,
	status: OnboardingAgentStageStatus,
	note: Schema.NullOr(Schema.String),
	updatedAt: Schema.NullOr(Schema.Number),
})
export type OnboardingAgentStageRecord = Schema.Schema.Type<typeof OnboardingAgentStageRecord>

export const emptyOnboardingAgentStages = (): ReadonlyArray<OnboardingAgentStageRecord> =>
	Arr.map(ONBOARDING_AGENT_STAGES, (stage) => ({ stage, status: "pending", note: null, updatedAt: null }))

export class OnboardingAgentRunNotFoundError extends HttpTaggedError<OnboardingAgentRunNotFoundError>()(
	"@maple/http/errors/OnboardingAgentRunNotFoundError",
	{ message: Schema.String },
	{
		status: 404,
		code: "onboarding_agent_run_not_found",
		title: "No onboarding run",
		message:
			"You have no agent onboarding run. Copy the agent prompt from Maple's connect step to start one.",
		retry: "never",
		recovery: "none",
		exposure: "public_message",
	},
) {}

/** The run finished, failed or expired: the agent stops reporting. */
export class OnboardingAgentRunClosedError extends HttpTaggedError<OnboardingAgentRunClosedError>()(
	"@maple/http/errors/OnboardingAgentRunClosedError",
	{ message: Schema.String, status: OnboardingAgentRunStatus },
	{
		status: 409,
		code: "onboarding_agent_run_closed",
		title: "Onboarding run is closed",
		message: "This onboarding run is finished. Stop sending progress updates.",
		retry: "never",
		recovery: "none",
		exposure: "public_message",
	},
) {}

export class OnboardingAgentRunRateLimitedError extends HttpTaggedError<OnboardingAgentRunRateLimitedError>()(
	"@maple/http/errors/OnboardingAgentRunRateLimitedError",
	{ message: Schema.String },
	{
		status: 429,
		code: "onboarding_agent_run_rate_limited",
		title: "Too many agent prompts",
		message: "Too many agent prompts were copied in a short time. Wait a minute and copy it again.",
		retry: "backoff",
		recovery: "retry",
		exposure: "public_message",
	},
) {}

export class OnboardingAgentRunUnavailableError extends HttpTaggedError<OnboardingAgentRunUnavailableError>()(
	"@maple/http/errors/OnboardingAgentRunUnavailableError",
	{ message: Schema.String, operation: Schema.String, cause: Schema.Defect() },
	{
		status: 503,
		code: "onboarding_agent_run_unavailable",
		title: "Onboarding runs are temporarily unavailable",
		message: "Onboarding runs are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}
