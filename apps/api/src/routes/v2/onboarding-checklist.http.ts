import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant } from "@maple/domain/http"
import { isoTimestampOrNull, MapleApiV2, V2InsufficientPermissions } from "@maple/domain/http/v2"
import type { V2OnboardingChecklist, V2OnboardingChecklistStep } from "@maple/domain/http/v2"
import {
	ONBOARDING_REWARD_AMOUNT_USD,
	type OnboardingChecklistStepId,
} from "@maple/domain/onboarding-checklist"
import { Effect } from "effect"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { requireAdmin } from "@maple/backend/services/auth/auth"
import {
	OnboardingChecklistService,
	type OnboardingChecklistReport,
} from "@maple/backend/services/org/OnboardingChecklistService"

/** Copy and destination per step. The web renders these verbatim so the list reads the same everywhere. */
const STEP_PRESENTATION = {
	send_telemetry: { title: "Send your first telemetry", href: "/settings?tab=ingestion" },
	connect_github: { title: "Connect GitHub", href: "/integrations?integration=github" },
	create_alert_rule: { title: "Create an alert with a destination", href: "/alerts" },
	invite_teammate: { title: "Invite a teammate", href: "/settings?tab=members" },
	connect_mcp_agent: { title: "Connect an MCP agent", href: "/settings?tab=mcp" },
} satisfies Record<OnboardingChecklistStepId, Pick<V2OnboardingChecklistStep, "title" | "href">>

export const toV2OnboardingChecklist = (report: OnboardingChecklistReport): V2OnboardingChecklist => ({
	object: "onboarding_checklist",
	status: report.status,
	reward_amount_usd: ONBOARDING_REWARD_AMOUNT_USD,
	deadline_at: isoTimestampOrNull(report.deadlineAtMs),
	claimed_at: isoTimestampOrNull(report.claimedAtMs),
	completed_count: report.completedCount,
	total_count: report.totalCount,
	steps: report.steps.map((step) => ({
		object: "onboarding_checklist_step",
		id: step.id,
		completed: step.completed,
		optional: step.optional,
		...STEP_PRESENTATION[step.id],
	})),
})

export const HttpV2OnboardingChecklistLive = HttpApiBuilder.group(
	MapleApiV2,
	"onboardingChecklist",
	(handlers) =>
		Effect.gen(function* () {
			const service = yield* OnboardingChecklistService

			return handlers
				.handle("retrieve", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						return toV2OnboardingChecklist(yield* service.read(tenant))
					}),
				)
				.handle("claim", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles, () =>
							V2InsufficientPermissions.make("Only org admins can claim the onboarding reward"),
						)
						const { report, newlyClaimed } = yield* service.claim(tenant)
						// A repeat of an idempotent claim is not a second credit; audit the redemption once.
						if (newlyClaimed) {
							yield* recordHttpAudit("onboarding_reward.claimed", {
								metadata: { amount_usd: ONBOARDING_REWARD_AMOUNT_USD },
							})
						}
						return toV2OnboardingChecklist(report)
					}),
				)
		}),
)
