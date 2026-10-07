import type { OrgId } from "@maple/domain"
import type { CancellationReason, CancellationSnapshot } from "@maple/domain/http"
import { bigint, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

/**
 * One review per cancelled subscription: the usage snapshot taken when Autumn
 * reported the cancellation, and the reason read from it.
 *
 * The row is written before anything is gathered, and the unique index is what
 * makes a redelivered webhook, or the `expired` that follows a scheduled
 * cancellation weeks later, a no-op instead of a second report. Until the report
 * is posted, `updatedAt` is the lease of whichever delivery is working on it.
 */
export const cancellationReviews = pgTable(
	"cancellation_reviews",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		planId: text("plan_id").notNull(),
		/** Epoch ms; 0 when Autumn sent none. With org and plan it names one subscription. */
		subscriptionStartedAt: bigint("subscription_started_at", { mode: "number" }).notNull(),
		/** Epoch ms of the cancellation reviewed. A later one on the same subscription is reviewed again. */
		canceledAt: bigint("canceled_at", { mode: "number" }),
		snapshotJson: jsonb("snapshot_json").$type<CancellationSnapshot>(),
		ruleReason: text("rule_reason").$type<CancellationReason>(),
		/** Null until the report reached Slack; a retry picks an unposted row back up. */
		postedAt: timestamp("posted_at", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("cancellation_reviews_subscription_idx").on(
			table.orgId,
			table.planId,
			table.subscriptionStartedAt,
		),
	],
)

export type CancellationReviewRow = typeof cancellationReviews.$inferSelect
