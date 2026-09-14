import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { BillingNotConfiguredError, BillingUpstreamError } from "../billing"
import {
	ONBOARDING_CHECKLIST_STEP_IDS,
	OnboardingChecklistUnavailableError,
	OnboardingRewardNotClaimableError,
} from "../../onboarding-checklist"
import { AuthorizationV2 } from "./auth"
import { wireExample, Timestamp } from "./envelopes"
import { V2InsufficientPermissions } from "./errors"
import { publicError, publicErrors } from "./public-error"

export const V2OnboardingChecklistStepId = Schema.Literals(ONBOARDING_CHECKLIST_STEP_IDS)
export type V2OnboardingChecklistStepId = Schema.Schema.Type<typeof V2OnboardingChecklistStepId>

export const V2OnboardingChecklistStep = Schema.Struct({
	object: Schema.Literal("onboarding_checklist_step").annotate({
		description: 'The object type — always `"onboarding_checklist_step"`.',
		examples: ["onboarding_checklist_step"],
	}),
	id: V2OnboardingChecklistStepId.annotate({
		description: "Stable step identifier.",
		examples: ["connect_github"],
	}),
	title: Schema.String.annotate({
		description: "What the step asks the user to do.",
		examples: ["Connect GitHub"],
	}),
	completed: Schema.Boolean.annotate({
		description:
			"Whether Maple can see the step done. Verified from the org's actual state (telemetry received, an active installation, an existing rule) — never self-reported.",
		examples: [true],
	}),
	href: Schema.String.annotate({
		description: "App-relative path of the page where the step is done.",
		examples: ["/integrations?integration=github"],
	}),
	optional: Schema.Boolean.annotate({
		description:
			"Optional steps are shown but never required for the reward, and are excluded from `completed_count` and `total_count`.",
		examples: [false],
	}),
}).annotate({
	identifier: "OnboardingChecklistStep",
	title: "Onboarding checklist step",
	description: "One activation step of the onboarding reward checklist.",
})
export type V2OnboardingChecklistStep = Schema.Schema.Type<typeof V2OnboardingChecklistStep>

export const V2OnboardingChecklistStatus = Schema.Literals(["in_progress", "claimable", "claimed", "expired"])
export type V2OnboardingChecklistStatus = Schema.Schema.Type<typeof V2OnboardingChecklistStatus>

export const V2OnboardingChecklist = Schema.Struct({
	object: Schema.Literal("onboarding_checklist").annotate({
		description: 'The object type — always `"onboarding_checklist"`.',
		examples: ["onboarding_checklist"],
	}),
	status: V2OnboardingChecklistStatus.annotate({
		description:
			"`in_progress` while steps remain and the window is open, `claimable` once every step is done inside the window, `claimed` after the credit was redeemed, `expired` when the window closed first (or the org's age is unknown).",
		examples: ["in_progress"],
	}),
	reward_amount_usd: Schema.Number.annotate({
		description: "The credit, in US dollars, applied to the org's balance on claim.",
		examples: [30],
	}),
	deadline_at: Schema.NullOr(Timestamp).annotate({
		description:
			"When the window closes — org creation plus the reward window. `null` only when the org's creation time is unknown, in which case `status` is `expired`.",
	}),
	claimed_at: Schema.NullOr(Timestamp).annotate({
		description: "When the credit was redeemed, or `null`.",
	}),
	completed_count: Schema.Number.annotate({
		description: "Required steps done so far.",
		examples: [2],
	}),
	total_count: Schema.Number.annotate({ description: "Required steps in total.", examples: [4] }),
	steps: Schema.Array(V2OnboardingChecklistStep).annotate({
		description: "Every step, in display order, always the full set.",
	}),
}).annotate({
	identifier: "OnboardingChecklist",
	title: "Onboarding checklist",
	description:
		"The org's progress through the onboarding reward checklist: five activation steps that earn a credit when finished within a window of the org's creation.",
	examples: [
		wireExample({
			object: "onboarding_checklist",
			status: "in_progress",
			reward_amount_usd: 30,
			deadline_at: "2026-07-28T12:00:00.000Z",
			claimed_at: null,
			completed_count: 2,
			total_count: 4,
			steps: [
				{
					object: "onboarding_checklist_step",
					id: "send_telemetry",
					title: "Send your first telemetry",
					completed: true,
					href: "/settings?tab=ingestion",
					optional: false,
				},
				{
					object: "onboarding_checklist_step",
					id: "connect_github",
					title: "Connect GitHub",
					completed: true,
					href: "/integrations?integration=github",
					optional: false,
				},
				{
					object: "onboarding_checklist_step",
					id: "create_alert_rule",
					title: "Create an alert with a destination",
					completed: false,
					href: "/alerts",
					optional: false,
				},
				{
					object: "onboarding_checklist_step",
					id: "connect_mcp_agent",
					title: "Connect an MCP agent",
					completed: false,
					href: "/settings?tab=mcp",
					optional: false,
				},
				{
					object: "onboarding_checklist_step",
					id: "invite_teammate",
					title: "Invite a teammate",
					completed: false,
					href: "/settings?tab=members",
					optional: true,
				},
			],
		}),
	],
})
export type V2OnboardingChecklist = Schema.Schema.Type<typeof V2OnboardingChecklist>

const checklistUnavailable = publicError(OnboardingChecklistUnavailableError)

export class V2OnboardingChecklistApiGroup extends HttpApiGroup.make("onboardingChecklist")
	.add(
		HttpApiEndpoint.get("retrieve", "/", {
			success: V2OnboardingChecklist,
			error: checklistUnavailable,
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getOnboardingChecklist",
				summary: "Retrieve the onboarding checklist",
				description:
					"Reports the org's progress through the onboarding reward checklist. Each step is verified from the org's state on every call; nothing here is self-reported. " +
					"An org past its reward window answers `expired` without evaluating the steps. Requires the `onboarding:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("claim", "/claim", {
			success: V2OnboardingChecklist,
			error: [
				V2InsufficientPermissions.schema,
				...publicErrors(
					OnboardingRewardNotClaimableError,
					OnboardingChecklistUnavailableError,
					BillingNotConfiguredError,
					BillingUpstreamError,
				),
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "claimOnboardingReward",
				summary: "Claim the onboarding reward",
				description:
					"Re-verifies every step and the window, then applies the credit to the org's billing balance. Idempotent: a second call after a successful claim returns the claimed checklist without applying the credit again. " +
					"Answers `409 onboarding_reward_not_claimable` while steps remain or once the window has closed. Requires an org-admin role and the `onboarding:write` scope.",
			}),
		),
	)
	.prefix("/v2/onboarding/checklist")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Onboarding Checklist",
			description:
				"Activation steps a new org completes to earn a credit, and the claim that applies it.",
		}),
	) {}
