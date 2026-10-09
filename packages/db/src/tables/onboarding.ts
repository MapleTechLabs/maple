import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId } from "@maple/domain/primitives"

export const OrgOnboardingState = PG.table("org_onboarding_state", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		userId: PG.column(PG.nullable(PG.text), { name: "user_id" }),
		email: PG.nullable(PG.text),
		role: PG.nullable(PG.text),
		demoDataRequested: PG.column(PG.bool, { name: "demo_data_requested", default: false }),
		onboardingCompletedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "onboarding_completed_at" }),
		checklistDismissedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "checklist_dismissed_at" }),
		firstDataReceivedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "first_data_received_at" }),
		welcomeEmailSentAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "welcome_email_sent_at" }),
		connectNudgeEmailSentAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "connect_nudge_email_sent_at" }),
		stalledEmailSentAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "stalled_email_sent_at" }),
		activationEmailSentAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "activation_email_sent_at" }),
		/** When the onboarding-checklist credit was confirmed applied by billing. Set once, never cleared. */
		rewardClaimedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "reward_claimed_at" }),
		/** A claim in flight: taken before the billing call, cleared on outcome, and treated as stale after a lease. */
		rewardReservedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "reward_reserved_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["orgId"],
	tenantColumn: "orgId",
})

export type OrgOnboardingStateRow = PG.SelectRowOf<typeof OrgOnboardingState>
export type OrgOnboardingStateInsert = PG.InsertRowOf<typeof OrgOnboardingState>
