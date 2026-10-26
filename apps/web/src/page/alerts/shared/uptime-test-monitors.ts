import { UptimeMonitorId } from "@maple/domain"
import { AlertDestinationId, AlertRuleId } from "@maple/domain/http"
import { V2UptimeMonitor } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { DESTINATION_ID, NOW, ruleId } from "./test-rows"
import type { UptimeMonitor } from "./uptime-derive"

// Uptime monitors as `uptimeMonitors.list` decodes them, for the scene tests.

export const monitorId = (n: number) =>
	Schema.decodeSync(UptimeMonitorId)(`0199a009-0000-7000-8000-00000000000${n}`)
/** The backing alert rule of the default monitor; incidents carry it as `rule_id`. */
export const MONITOR_RULE = Schema.decodeSync(AlertRuleId)(ruleId(7))
export const DESTINATION = Schema.decodeSync(AlertDestinationId)(DESTINATION_ID)

const iso = (msBefore: number) => new Date(NOW - msBefore).toISOString()
const SECOND = 1000

type Recent = UptimeMonitor["state"]["recent"]

/** `count` checks 30 s apart, oldest first, failing where `isFailed(index)`. */
export const recentChecks = (count: number, isFailed: (index: number) => boolean = () => false): Recent =>
	Array.from({ length: count }, (_, index) => ({
		at: iso((count - index) * 30 * SECOND),
		ok: !isFailed(index),
		duration_ms: isFailed(index) ? 1512 : 100 + index,
	}))

const BASE: UptimeMonitor = {
	id: monitorId(1),
	object: "uptime_monitor",
	name: "checkout-api",
	kind: "http",
	config: {
		type: "http",
		url: "https://api.acme.dev/checkout/health",
		method: "GET",
		headers: {},
		assertions: [{ type: "status", op: "is", value: "2xx" }],
		timeout_ms: 10000,
	},
	interval_seconds: Schema.decodeSync(V2UptimeMonitor.fields.interval_seconds)(30),
	failures_to_down: 2,
	service_name: "checkout-api",
	destination_ids: [DESTINATION],
	enabled: true,
	heartbeat_url: null,
	alert_rule_id: MONITOR_RULE,
	state: {
		status: "up",
		consecutive_failures: 0,
		status_changed_at: iso(3600 * SECOND),
		last_check: {
			at: iso(30 * SECOND),
			ok: true,
			status_code: 200,
			duration_ms: 98,
			error: null,
			trace_id: "0d5f00000000000000000000000e8a3",
		},
		recent: recentChecks(40),
		last_ping_at: null,
	},
	created_at: iso(7 * 24 * 3600 * SECOND),
	updated_at: iso(3600 * SECOND),
}

export const httpMonitor = (fields: Partial<UptimeMonitor> = {}): UptimeMonitor => ({ ...BASE, ...fields })

/** Down for 6 minutes, returning 503 on the last four checks. */
export const downMonitor = (fields: Partial<UptimeMonitor> = {}): UptimeMonitor =>
	httpMonitor({
		id: monitorId(2),
		name: "payments-api",
		state: {
			status: "down",
			consecutive_failures: 4,
			status_changed_at: iso(6 * 60 * SECOND),
			last_check: {
				at: iso(30 * SECOND),
				ok: false,
				status_code: 503,
				duration_ms: 1512,
				error: "Service Unavailable",
				trace_id: "7f3c000000000000000000000000a91e",
			},
			recent: recentChecks(40, (index) => index >= 36),
			last_ping_at: null,
		},
		...fields,
	})

export const pausedMonitor = (): UptimeMonitor =>
	httpMonitor({
		id: monitorId(3),
		name: "legacy-api",
		enabled: false,
		state: { ...BASE.state, status: "paused", recent: [] },
	})

export const heartbeatMonitor = (): UptimeMonitor =>
	httpMonitor({
		id: monitorId(4),
		name: "nightly-billing-export",
		kind: "heartbeat",
		service_name: null,
		config: { type: "heartbeat", schedule: { type: "interval", seconds: 86400 }, grace_seconds: 1800 },
		heartbeat_url: "https://ingest.maple.dev/uptime/hb/abc123",
		state: { ...BASE.state, last_ping_at: iso(3 * 3600 * SECOND) },
	})
