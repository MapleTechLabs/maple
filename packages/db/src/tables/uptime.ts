import * as PG from "@maple-dev/effect-orm/postgres"
import {
	AlertRuleId,
	OrgId,
	UptimeMonitorId,
	UptimeMonitorKind,
	UptimeMonitorStatus,
	UserId,
} from "@maple/domain/primitives"
import { UptimeCheckDetail, UptimeMonitorConfig, UptimeRecentCheck } from "@maple/domain/uptime"
import { Schema } from "effect"

/**
 * A monitor: what to check and how often. `alert_rule_id` is the hidden `uptime` alert
 * rule that turns a down state into an incident (one per monitor, created with it).
 */
export const UptimeMonitors = PG.table("uptime_monitors", {
	columns: {
		id: PG.brand(PG.text, UptimeMonitorId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		name: PG.text,
		kind: PG.brand(PG.text, UptimeMonitorKind),
		configJson: PG.column(PG.jsonb(UptimeMonitorConfig), { name: "config_json" }),
		/** Probe cadence; ignored for heartbeats, whose schedule lives in the config. */
		intervalSeconds: PG.column(PG.int4, { name: "interval_seconds", default: 60 }),
		failuresToDown: PG.column(PG.int4, { name: "failures_to_down", default: 2 }),
		/** Links failures to a service: its health, its traces, its deploys. */
		serviceName: PG.column(PG.nullable(PG.text), { name: "service_name" }),
		alertRuleId: PG.column(PG.nullable(PG.brand(PG.text, AlertRuleId)), { name: "alert_rule_id" }),
		/** Heartbeats only: the secret path segment of `/hb/<token>`. Shown in the UI, so stored as-is. */
		heartbeatToken: PG.column(PG.nullable(PG.text), { name: "heartbeat_token" }),
		enabled: PG.column(PG.bool, { default: true }),
		createdBy: PG.column(PG.brand(PG.text, UserId), { name: "created_by" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.index("uptime_monitors_org_idx", ["orgId"]),
		PG.index("uptime_monitors_enabled_kind_idx", ["enabled", "kind"]),
		PG.uniqueIndex("uptime_monitors_heartbeat_token_unq", ["heartbeatToken"]),
	],
	tenantColumn: "orgId",
})

export type UptimeMonitorRow = PG.SelectRowOf<typeof UptimeMonitors>
export type UptimeMonitorInsert = PG.InsertRowOf<typeof UptimeMonitors>

/**
 * The monitor's live state, written only when a check changes something worth showing
 * (status, counters, the recent ring), never one row per check: history lives in the
 * check spans in the warehouse.
 */
export const UptimeMonitorStates = PG.table("uptime_monitor_states", {
	columns: {
		monitorId: PG.column(PG.brand(PG.text, UptimeMonitorId), { name: "monitor_id" }),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		status: PG.column(PG.brand(PG.text, UptimeMonitorStatus), { default: "pending" }),
		consecutiveFailures: PG.column(PG.int4, { name: "consecutive_failures", default: 0 }),
		consecutiveSuccesses: PG.column(PG.int4, { name: "consecutive_successes", default: 0 }),
		statusChangedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "status_changed_at" }),
		lastCheckJson: PG.column(PG.nullable(PG.jsonb(UptimeCheckDetail)), { name: "last_check_json" }),
		recentJson: PG.column(PG.jsonb(Schema.Array(UptimeRecentCheck)), { name: "recent_json" }),
		/** Heartbeats: the last ping (success or `/fail`). */
		lastPingAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_ping_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["monitorId"],
	indexes: [PG.index("uptime_monitor_states_org_idx", ["orgId"])],
	foreignKeys: [
		PG.foreignKey({
			columns: ["monitorId"],
			references: UptimeMonitors,
			foreignColumns: ["id"],
			onDelete: "cascade",
		}),
	],
	tenantColumn: "orgId",
})

export type UptimeMonitorStateRow = PG.SelectRowOf<typeof UptimeMonitorStates>
export type UptimeMonitorStateInsert = PG.InsertRowOf<typeof UptimeMonitorStates>
