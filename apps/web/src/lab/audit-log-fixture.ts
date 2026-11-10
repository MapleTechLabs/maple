import { encodePublicId, type PublicIdPrefix, PublicIdPrefixes, V2AuditLogEntry } from "@maple/domain/http/v2"
import { Array as Arr, Schema, String as Str } from "effect"

// Audit log entries for `/lab/audit-log`: a morning of changes, reads, tool calls and refusals
// across users, an API key, an agent and Maple itself.

export const AUDIT_NOW = Date.UTC(2026, 10, 9, 15, 30, 0)

export const AUDIT_MEMBERS = [
	{ value: "user_2fj3K9dLqWm8xYbT", label: "Ada Lovelace" },
	{ value: "user_7HqLm2NpRt4VwXyZ", label: "Grace Hopper" },
	{ value: "user_9KdTq3RsVw5XyZaB", label: "Linus Torvalds" },
] as const

const ADA = AUDIT_MEMBERS[0].value
const GRACE = AUDIT_MEMBERS[1].value
const LINUS = AUDIT_MEMBERS[2].value

const decode = Schema.decodeUnknownSync(V2AuditLogEntry)

const uuid = (n: number) => `3f1b7c02-9a44-4d1e-8b2f-${Str.padStart(12, "0")(String(n))}`

type Wire = Readonly<{
	n: number
	minutesAgo: number
	action: string
	actor: "ada" | "grace" | "linus" | "key" | "agent" | "system"
	source: "dashboard" | "api" | "mcp" | "chat_platform" | "system"
	resource?: { type: string; prefix?: PublicIdPrefix }
	denied?: string
	affected?: string
	changes?: {
		fields: ReadonlyArray<string>
		before: Record<string, unknown>
		after: Record<string, unknown>
	}
	metadata?: Record<string, unknown>
	ip?: string
	country?: string
}>

const ACTORS = {
	ada: { actor_type: "user", actor_id: ADA, actor_name: "Ada Lovelace" },
	grace: { actor_type: "user", actor_id: GRACE, actor_name: "Grace Hopper" },
	linus: { actor_type: "user", actor_id: LINUS, actor_name: null },
	key: { actor_type: "api_key", actor_id: "key_aXwpxqBkqtYwtBtmsGbR41", actor_name: "CI deploy key" },
	agent: { actor_type: "agent", actor_id: "actor_4CzLmR1pTxWvYbNhQd82Kf", actor_name: "Claude Code" },
	system: { actor_type: "system", actor_id: null, actor_name: null },
} as const

const entry = (wire: Wire): V2AuditLogEntry => {
	const occurred = new Date(AUDIT_NOW - wire.minutesAgo * 60_000).toISOString()
	return decode({
		id: encodePublicId(PublicIdPrefixes.auditLogEntry, uuid(wire.n)),
		object: "audit_log_entry",
		action: wire.action,
		outcome: wire.denied === undefined ? "allowed" : "denied",
		denial_reason: wire.denied ?? null,
		...ACTORS[wire.actor],
		actor_avatar_url: null,
		affected_user: wire.affected ?? null,
		source: wire.source,
		resource_type: wire.resource?.type ?? null,
		resource_id:
			wire.resource?.prefix === undefined
				? null
				: encodePublicId(wire.resource.prefix, uuid(wire.n + 100)),
		changes: wire.changes ?? null,
		metadata: wire.metadata ?? null,
		request_id: wire.source === "system" ? null : `8f2c1a9d4b7e${Str.padStart(4, "0")(String(wire.n))}`,
		origin_ip: wire.source === "system" ? null : (wire.ip ?? "203.0.113.7"),
		origin_country: wire.source === "system" ? null : (wire.country ?? "DE"),
		occurred_at: occurred,
		recorded_at: occurred,
	})
}

export const AUDIT_ENTRIES: ReadonlyArray<V2AuditLogEntry> = Arr.map(
	[
		{
			n: 1,
			minutesAgo: 3,
			action: "telemetry.sql_executed",
			actor: "agent",
			source: "mcp",
			denied: "Only SELECT statements may run",
			metadata: {
				sql: "DELETE FROM traces WHERE ServiceName = 'checkout'",
				context: "mcp.run_sql",
				start_time: "2026-11-09 14:00:00",
				end_time: "2026-11-09 15:00:00",
			},
			ip: "198.51.100.23",
			country: "US",
		},
		{
			n: 2,
			minutesAgo: 6,
			action: "mcp_tool.called",
			actor: "agent",
			source: "mcp",
			metadata: {
				tool: "search_traces",
				surface: "mcp",
				is_error: false,
				params: '{"service":"checkout","status":"Error","limit":20}',
			},
			ip: "198.51.100.23",
			country: "US",
		},
		{
			n: 3,
			minutesAgo: 9,
			action: "dashboard.updated",
			actor: "ada",
			source: "dashboard",
			resource: { type: "dashboard", prefix: PublicIdPrefixes.dashboard },
			changes: {
				fields: ["name", "tags"],
				before: { name: "Checkout", tags: ["prod"] },
				after: { name: "Checkout overview", tags: ["prod", "payments"] },
			},
		},
		{
			n: 4,
			minutesAgo: 14,
			action: "telemetry.read",
			actor: "ada",
			source: "dashboard",
			metadata: {
				endpoint: "queryEngine.execute",
				method: "POST",
				path: "/api/query-engine/execute",
				status: 200,
			},
		},
		{
			n: 5,
			minutesAgo: 31,
			action: "api_key.created",
			actor: "grace",
			source: "dashboard",
			resource: { type: "api_key", prefix: PublicIdPrefixes.apiKey },
			metadata: { name: "CI deploy key", scopes: ["telemetry:write", "dashboards:read"] },
			ip: "192.0.2.44",
			country: "GB",
		},
		{
			n: 6,
			minutesAgo: 47,
			action: "api.request",
			actor: "key",
			source: "api",
			denied: "Missing scope: alerts:write",
			metadata: { method: "POST", path: "/v2/alert_rules" },
			ip: "203.0.113.90",
			country: "NL",
		},
		{
			n: 7,
			minutesAgo: 62,
			action: "member.role_changed",
			actor: "grace",
			source: "dashboard",
			resource: { type: "member" },
			affected: LINUS,
			changes: { fields: ["role"], before: { role: "org:member" }, after: { role: "org:admin" } },
			ip: "192.0.2.44",
			country: "GB",
		},
		{
			n: 8,
			minutesAgo: 95,
			action: "alert_rule.created",
			actor: "linus",
			source: "dashboard",
			resource: { type: "alert_rule", prefix: PublicIdPrefixes.alertRule },
			ip: "198.51.100.7",
			country: "FI",
		},
		{
			n: 9,
			minutesAgo: 140,
			action: "session_replay.read",
			actor: "grace",
			source: "dashboard",
			metadata: {
				endpoint: "sessionReplays.retrieve",
				method: "GET",
				path: "/v2/session_replays/rep_1",
				status: 200,
			},
			ip: "192.0.2.44",
			country: "GB",
		},
		{
			n: 10,
			minutesAgo: 60 * 20,
			action: "error_issue.regression",
			actor: "system",
			source: "system",
			resource: { type: "error_issue", prefix: PublicIdPrefixes.errorIssue },
		},
		{
			n: 11,
			minutesAgo: 60 * 22,
			action: "dashboard_share.created",
			actor: "linus",
			source: "dashboard",
			resource: { type: "dashboard_share", prefix: PublicIdPrefixes.dashboardShare },
			ip: "198.51.100.7",
			country: "FI",
		},
		{
			n: 12,
			minutesAgo: 60 * 26,
			action: "source.rolled",
			actor: "ada",
			source: "dashboard",
			resource: { type: "source", prefix: PublicIdPrefixes.source },
			metadata: { platform: "opentelemetry" },
		},
		{
			n: 13,
			minutesAgo: 60 * 50,
			action: "ingest_key.rolled",
			actor: "ada",
			source: "dashboard",
			metadata: { key: "private" },
		},
		{
			n: 14,
			minutesAgo: 60 * 75,
			action: "mcp_tool.called",
			actor: "agent",
			source: "chat_platform",
			metadata: {
				tool: "list_errors",
				surface: "chat",
				is_error: true,
				params: '{"service":"payments"}',
				connector: "slack",
				workspace_id: "T024BE7LD",
				external_user_id: "U012AB3CD",
				display_name: "Grace Hopper",
			},
			ip: "198.51.100.200",
			country: "US",
		},
	] satisfies ReadonlyArray<Wire>,
	entry,
)
