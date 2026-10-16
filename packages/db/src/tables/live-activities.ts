import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId } from "@maple/domain/primitives"

/**
 * A Live Activity running on someone's Lock Screen for one alert incident.
 *
 * The server starts these with the device's push-to-start token (on
 * `mobile_devices`), but every subsequent update has to go to a token that only
 * exists once the activity is running and that ActivityKit hands to the *app*,
 * so the app POSTs it back and it is stored here. One row per (device,
 * incident): the same incident on two phones is two activities with two tokens.
 *
 * Rows are kept after the activity ends so a late renotify does not resurrect a
 * dismissed activity, and so "why did my phone not show it" is answerable.
 */
export const LiveActivities = PG.table("live_activities", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		/** `mobile_devices.id`. Not a FK: the device row can be deleted on sign-out. */
		deviceId: PG.column(PG.text, { name: "device_id" }),
		/** Internal alert-incident id, the same one `alert_incidents.id` carries. */
		incidentId: PG.column(PG.text, { name: "incident_id" }),
		/** ActivityKit's own id for the activity, for logs and for the app's own bookkeeping. */
		activityId: PG.column(PG.text, { name: "activity_id" }),
		/** The per-activity APNs update token, hex. Rotates; the app re-POSTs it. */
		pushToken: PG.column(PG.text, { name: "push_token" }),
		/** Set when the activity was ended (by a resolve, by the user, or by APNs rejecting the token). */
		endedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "ended_at" }),
		endedReason: PG.column(PG.nullable(PG.text), { name: "ended_reason" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("live_activities_device_incident_unique", ["deviceId", "incidentId"]),
		PG.index("live_activities_incident_idx", ["orgId", "incidentId"]),
	],
	tenantColumn: "orgId",
})

export type LiveActivityRow = PG.SelectRowOf<typeof LiveActivities>
export type LiveActivityInsert = PG.InsertRowOf<typeof LiveActivities>
