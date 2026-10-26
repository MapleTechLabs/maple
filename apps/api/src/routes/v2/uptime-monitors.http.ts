import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant } from "@maple/domain/http"
import {
	isoTimestamp,
	isoTimestampOrNull,
	MapleApiV2,
	paginateArray,
	uptimeConfigFromWire,
	uptimeConfigToWire,
	V2InsufficientPermissions,
} from "@maple/domain/http/v2"
import type { V2UptimeMonitor } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { UPTIME_REDACTED_HEADER_VALUE } from "@maple/domain/uptime"
import { auditDiff } from "@/routes/v2/audit-changes"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { isAdmin, requireAdmin } from "@maple/backend/services/auth/auth"
import {
	type UptimeMonitorRecord,
	UptimeMonitorsService,
} from "@maple/backend/services/uptime/UptimeMonitorsService"

// Writes are admin-gated: a monitor makes Maple's infrastructure request an operator-chosen
// host on a schedule, and `test` does so on demand. Reads stay on `uptime_monitors:read`.
const adminOnly = (action: string) => () =>
	V2InsufficientPermissions.make(`Only org admins can ${action} uptime monitors`)

const toV2UptimeMonitor = (monitor: UptimeMonitorRecord): V2UptimeMonitor => ({
	id: monitor.id,
	object: "uptime_monitor",
	name: monitor.name,
	kind: monitor.kind,
	config: uptimeConfigToWire(monitor.config),
	interval_seconds: monitor.intervalSeconds,
	failures_to_down: monitor.failuresToDown,
	service_name: monitor.serviceName,
	enabled: monitor.enabled,
	destination_ids: monitor.destinationIds,
	heartbeat_url: monitor.heartbeatUrl,
	alert_rule_id: monitor.alertRuleId,
	state: {
		status: monitor.state.status,
		consecutive_failures: monitor.state.consecutiveFailures,
		status_changed_at: isoTimestampOrNull(monitor.state.statusChangedAt),
		last_check:
			monitor.state.lastCheck === null
				? null
				: {
						at: isoTimestamp(monitor.state.lastCheck.at),
						ok: monitor.state.lastCheck.ok,
						status_code: monitor.state.lastCheck.statusCode,
						duration_ms: monitor.state.lastCheck.durationMs,
						error: monitor.state.lastCheck.error,
						trace_id: monitor.state.lastCheck.traceId,
					},
		recent: monitor.state.recent.map((check) => ({
			at: isoTimestamp(check.at),
			ok: check.ok,
			duration_ms: check.durationMs,
		})),
		last_ping_at: isoTimestampOrNull(monitor.state.lastPingAt),
	},
	created_at: isoTimestamp(monitor.createdAt),
	updated_at: isoTimestamp(monitor.updatedAt),
})

/** Header values and the heartbeat URL are credentials: callers who cannot write see neither. */
const forReader = (monitor: V2UptimeMonitor, canWrite: boolean): V2UptimeMonitor => {
	if (canWrite) return monitor
	const readable = { ...monitor, heartbeat_url: null }
	if (readable.config.type !== "http" || readable.config.headers === undefined) return readable
	const headers = Object.fromEntries(
		Object.keys(readable.config.headers).map((name) => [name, UPTIME_REDACTED_HEADER_VALUE]),
	)
	return { ...readable, config: { ...readable.config, headers } }
}

const monitorAuditDiff = auditDiff({
	fields: [
		"name",
		"config",
		"interval_seconds",
		"failures_to_down",
		"service_name",
		"enabled",
		"destination_ids",
	],
	// Request headers in an HTTP config may carry credentials.
	summarize: { config: "<updated>" },
})

export const HttpV2UptimeMonitorsLive = HttpApiBuilder.group(MapleApiV2, "uptimeMonitors", (handlers) =>
	Effect.gen(function* () {
		const service = yield* UptimeMonitorsService

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const monitors = yield* service.list(tenant.orgId)
					const canWrite = isAdmin(tenant.roles)
					const page = yield* paginateArray(
						monitors.map((monitor) => forReader(toV2UptimeMonitor(monitor), canWrite)),
						query,
					)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const monitor = yield* service.get(tenant.orgId, params.id)
					return forReader(toV2UptimeMonitor(monitor), isAdmin(tenant.roles))
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, adminOnly("create"))
					const created = yield* service.create(tenant.orgId, {
						name: payload.name,
						kind: payload.kind,
						config: uptimeConfigFromWire(payload.config),
						...(payload.interval_seconds === undefined
							? undefined
							: { intervalSeconds: payload.interval_seconds }),
						...(payload.failures_to_down === undefined
							? undefined
							: { failuresToDown: payload.failures_to_down }),
						...(payload.service_name === undefined
							? undefined
							: { serviceName: payload.service_name }),
						...(payload.enabled === undefined ? undefined : { enabled: payload.enabled }),
						...(payload.destination_ids === undefined
							? undefined
							: { destinationIds: payload.destination_ids }),
						createdBy: tenant.userId,
					})
					yield* recordHttpAudit("uptime_monitor.created", {
						resourceId: created.id,
						metadata: { name: created.name, kind: created.kind },
					})
					return toV2UptimeMonitor(created)
				}),
			)
			.handle("test", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, adminOnly("test"))
					const result = yield* service.testHttp(uptimeConfigFromWire(payload.config))
					return {
						object: "uptime_monitor.test_result" as const,
						ok: result.ok,
						status_code: result.statusCode,
						duration_ms: result.durationMs,
						failed_assertion: result.failedAssertion,
						error: result.error,
						headers: result.headers,
						body_prefix: result.bodyPrefix,
						body_truncated: result.bodyTruncated,
					}
				}),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, adminOnly("update"))
					const current = yield* service.get(tenant.orgId, params.id)
					const updated = yield* service.update(tenant.orgId, params.id, {
						...(payload.name === undefined ? undefined : { name: payload.name }),
						...(payload.config === undefined
							? undefined
							: { config: uptimeConfigFromWire(payload.config) }),
						...(payload.interval_seconds === undefined
							? undefined
							: { intervalSeconds: payload.interval_seconds }),
						...(payload.failures_to_down === undefined
							? undefined
							: { failuresToDown: payload.failures_to_down }),
						...(payload.service_name === undefined
							? undefined
							: { serviceName: payload.service_name }),
						...(payload.enabled === undefined ? undefined : { enabled: payload.enabled }),
						...(payload.destination_ids === undefined
							? undefined
							: { destinationIds: payload.destination_ids }),
						updatedBy: tenant.userId,
					})
					yield* recordHttpAudit("uptime_monitor.updated", {
						resourceId: updated.id,
						changes: monitorAuditDiff(
							payload,
							toV2UptimeMonitor(current),
							toV2UptimeMonitor(updated),
						),
						metadata: { name: updated.name },
					})
					return toV2UptimeMonitor(updated)
				}),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, adminOnly("delete"))
					const deleted = yield* service.delete(tenant.orgId, params.id)
					yield* recordHttpAudit("uptime_monitor.deleted", { resourceId: deleted })
					return { id: deleted, object: "uptime_monitor" as const, deleted: true as const }
				}),
			)
	}),
)
