import * as PG from "@maple-dev/effect-orm/postgres"
import { CancellationReason, CancellationSnapshot } from "@maple/domain/http"
import { OrgId } from "@maple/domain/primitives"

/**
 * One review per cancelled subscription: the usage snapshot taken when Autumn
 * reported the cancellation, and the reason read from it.
 *
 * The row is written before anything is gathered, and the unique index is what
 * makes a redelivered webhook, or the `expired` that follows a scheduled
 * cancellation weeks later, a no-op instead of a second report. Until the report
 * is posted, `updatedAt` is the lease of whichever delivery is working on it.
 */
export const CancellationReviews = PG.table("cancellation_reviews", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		planId: PG.column(PG.text, { name: "plan_id" }),
		/** Epoch ms; 0 when Autumn sent none. With org and plan it names one subscription. */
		subscriptionStartedAt: PG.column(PG.int8, { name: "subscription_started_at" }),
		/** Epoch ms of the cancellation reviewed. A later one on the same subscription is reviewed again. */
		canceledAt: PG.column(PG.nullable(PG.int8), { name: "canceled_at" }),
		snapshotJson: PG.column(PG.nullable(PG.jsonb(CancellationSnapshot)), { name: "snapshot_json" }),
		ruleReason: PG.column(PG.nullable(PG.brand(PG.text, CancellationReason)), { name: "rule_reason" }),
		/** Null until the report reached Slack; a retry picks an unposted row back up. */
		postedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "posted_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("cancellation_reviews_subscription_idx", ["orgId", "planId", "subscriptionStartedAt"]),
	],
	tenantColumn: "orgId",
})

export type CancellationReviewRow = PG.SelectRowOf<typeof CancellationReviews>
