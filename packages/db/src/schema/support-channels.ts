import type { OrgId } from "@maple/domain"
import { pgTable, text, timestamp } from "drizzle-orm/pg-core"

/**
 * The org's shared Slack channel with the Maple team: one per org, created in Maple's own
 * workspace and shared into the customer's with Slack Connect invites.
 *
 * The row is written before the channel exists (`slackChannelId` null, `reservedAt` set) so two
 * members pressing the button together create one channel, not two.
 */
export const orgSupportChannels = pgTable("org_support_channels", {
	orgId: text("org_id").$type<OrgId>().notNull().primaryKey(),
	slackChannelId: text("slack_channel_id"),
	slackChannelName: text("slack_channel_name"),
	/** A creation in flight; cleared once the channel exists, and treated as stale after a lease. */
	reservedAt: timestamp("reserved_at", { withTimezone: true, mode: "date" }),
	createdByUserId: text("created_by_user_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
})

export type OrgSupportChannelRow = typeof orgSupportChannels.$inferSelect
