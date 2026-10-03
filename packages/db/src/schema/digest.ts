import type { OrgId } from "@maple/domain"
import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

export const digestSubscriptions = pgTable(
	"digest_subscriptions",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		userId: text("user_id").notNull(),
		email: text("email").notNull(),
		enabled: boolean("enabled").notNull().default(true),
		/**
		 * When the subscriber themselves turned the digest off. The Clerk
		 * reconciliation re-enables returning members, and this is what tells it
		 * apart from a member it disabled itself when they left the org.
		 */
		optedOutAt: timestamp("opted_out_at", { withTimezone: true, mode: "date" }),
		dayOfWeek: integer("day_of_week").notNull().default(1),
		timezone: text("timezone").notNull().default("UTC"),
		/**
		 * JSON-encoded string arrays scoping the digest to a slice of the org.
		 * Empty array = every namespace / environment, which is the default and
		 * what every pre-existing row carries. Same shape as
		 * `alert_rules.environments_json`.
		 */
		namespacesJson: text("namespaces_json").notNull().default("[]"),
		environmentsJson: text("environments_json").notNull().default("[]"),
		lastSentAt: timestamp("last_sent_at", { withTimezone: true, mode: "date" }),
		lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true, mode: "date" }),
		/**
		 * The weekly web analytics email: a second, independent opt-out on the same
		 * subscriber row. `enabled` is the ops digest's own switch, so the Clerk
		 * reconciliation recomputes this one from `web_analytics_opted_out_at` the
		 * same way. Sent on the same `day_of_week`, and only to orgs with browser data.
		 */
		webAnalyticsEnabled: boolean("web_analytics_enabled").notNull().default(true),
		webAnalyticsOptedOutAt: timestamp("web_analytics_opted_out_at", { withTimezone: true, mode: "date" }),
		webAnalyticsLastSentAt: timestamp("web_analytics_last_sent_at", { withTimezone: true, mode: "date" }),
		webAnalyticsLastAttemptedAt: timestamp("web_analytics_last_attempted_at", {
			withTimezone: true,
			mode: "date",
		}),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("digest_subscriptions_org_user_idx").on(table.orgId, table.userId),
		index("digest_subscriptions_org_enabled_idx").on(table.orgId, table.enabled),
	],
)

export type DigestSubscriptionRow = typeof digestSubscriptions.$inferSelect
