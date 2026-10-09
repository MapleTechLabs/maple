import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId } from "@maple/domain/primitives"

export const DigestSubscriptions = PG.table("digest_subscriptions", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		userId: PG.column(PG.text, { name: "user_id" }),
		email: PG.text,
		enabled: PG.column(PG.bool, { default: true }),
		/**
		 * When the subscriber themselves turned the digest off. The Clerk
		 * reconciliation re-enables returning members, and this is what tells it
		 * apart from a member it disabled itself when they left the org.
		 */
		optedOutAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "opted_out_at" }),
		dayOfWeek: PG.column(PG.int4, { name: "day_of_week", default: 1 }),
		timezone: PG.column(PG.text, { default: "UTC" }),
		/**
		 * JSON-encoded string arrays scoping the digest to a slice of the org.
		 * Empty array = every namespace / environment, which is the default and
		 * what every pre-existing row carries. Same shape as
		 * `alert_rules.environments_json`.
		 */
		namespacesJson: PG.column(PG.text, { name: "namespaces_json", default: "[]" }),
		environmentsJson: PG.column(PG.text, { name: "environments_json", default: "[]" }),
		lastSentAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_sent_at" }),
		lastAttemptedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_attempted_at" }),
		/**
		 * The weekly web analytics email: a second, independent opt-out on the same
		 * subscriber row. `enabled` is the ops digest's own switch, so the Clerk
		 * reconciliation recomputes this one from `web_analytics_opted_out_at` the
		 * same way. Sent on the same `day_of_week`, and only to orgs with browser data.
		 */
		webAnalyticsEnabled: PG.column(PG.bool, { name: "web_analytics_enabled", default: true }),
		webAnalyticsOptedOutAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "web_analytics_opted_out_at" }),
		webAnalyticsLastSentAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "web_analytics_last_sent_at" }),
		webAnalyticsLastAttemptedAt: PG.column(PG.nullable(PG.timestamptzMillis), {
			name: "web_analytics_last_attempted_at",
		}),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("digest_subscriptions_org_user_idx", ["orgId", "userId"]),
		PG.index("digest_subscriptions_org_enabled_idx", ["orgId", "enabled"]),
	],
	tenantColumn: "orgId",
})

export type DigestSubscriptionRow = PG.SelectRowOf<typeof DigestSubscriptions>
