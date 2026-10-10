import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId, UserId } from "@maple/domain/primitives"
import { Schema } from "effect"

/**
 * Which alert events a device wants. Absent keys read as their default in
 * `packages/domain/src/http/mobile-devices.ts`: a device registered by an
 * older app build keeps getting the notifications the newer build added.
 */
export const MobileDevicePreferencesColumn = Schema.Struct({
	criticalIncidents: Schema.optionalKey(Schema.Boolean),
	warningIncidents: Schema.optionalKey(Schema.Boolean),
	resolvedIncidents: Schema.optionalKey(Schema.Boolean),
	newErrorIssues: Schema.optionalKey(Schema.Boolean),
	anomalies: Schema.optionalKey(Schema.Boolean),
})
export type MobileDevicePreferences = Schema.Schema.Type<typeof MobileDevicePreferencesColumn>

/**
 * A phone that wants push notifications for an organization.
 *
 * Push is **user-scoped**, not an alert destination: destinations are the
 * org's Slack channels and pagers, configured by admins and attached to
 * rules. A phone belongs to a person, follows them across orgs, and is
 * registered by the app itself. So it lives here rather than in
 * `alert_destinations`, and the fan-out reads this table directly instead of
 * going through a rule's `destination_ids`.
 *
 * One row per (org, platform, token): the same phone signed into two orgs is
 * two rows with independent preferences.
 */
export const MobileDevices = PG.table("mobile_devices", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		userId: PG.column(PG.brand(PG.text, UserId), { name: "user_id" }),
		platform: PG.text,
		/** The APNs device token, hex. */
		token: PG.text,
		/** `sandbox` (Xcode/TestFlight-development builds) or `production`. Decides the APNs host. */
		environment: PG.text,
		bundleId: PG.column(PG.text, { name: "bundle_id" }),
		appVersion: PG.column(PG.nullable(PG.text), { name: "app_version" }),
		/**
		 * The ActivityKit push-to-start token, hex. Present once the app has run
		 * on iOS 17.2+ with Live Activities enabled; it lets the server *create* a
		 * Live Activity on a locked phone that has never opened the app today.
		 * Distinct from `token`: a push here starts an activity, a push there
		 * shows a notification.
		 */
		liveActivityStartToken: PG.column(PG.nullable(PG.text), { name: "live_activity_start_token" }),
		deviceName: PG.column(PG.nullable(PG.text), { name: "device_name" }),
		preferences: PG.jsonb(MobileDevicePreferencesColumn),
		/** Set when APNs reports the token dead (410 / BadDeviceToken); the row is kept for the audit trail. */
		disabledAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "disabled_at" }),
		disabledReason: PG.column(PG.nullable(PG.text), { name: "disabled_reason" }),
		lastPushedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_pushed_at" }),
		lastSeenAt: PG.column(PG.timestamptzMillis, { name: "last_seen_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("mobile_devices_org_platform_token_unique", ["orgId", "platform", "token"]),
		PG.index("mobile_devices_org_idx", ["orgId"]),
		PG.index("mobile_devices_user_idx", ["userId"]),
	],
	tenantColumn: "orgId",
})

export type MobileDeviceRow = PG.SelectRowOf<typeof MobileDevices>
export type MobileDeviceInsert = PG.InsertRowOf<typeof MobileDevices>
