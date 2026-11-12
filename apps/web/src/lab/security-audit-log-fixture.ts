import type { AuditTrailEntry, AuditTrailListResponse } from "@maple/domain/http"
import { Array as Arr, String as Str } from "effect"

// Audit events for the Security hub's audit log lab: Maple's own changes and refusals over the
// last two days, newest first, the shapes the page has to draw.

const MINUTE = 60_000

type Seed = Readonly<{
	provider?: string
	account?: string
	minutesAgo: number
	action: string
	category: string
	outcome?: string
	outcomeReason?: string
	actor: AuditTrailEntry["actor"]
	target?: Partial<AuditTrailEntry["target"]>
	originIp?: string
	originCountry?: string
	raw?: Readonly<Record<string, unknown>>
}>

const ada: AuditTrailEntry["actor"] = {
	type: "user",
	id: "user_2fj3K9dLqWm8xYbT",
	name: "Ada Lovelace",
	email: "ada@acme.test",
}
const grace: AuditTrailEntry["actor"] = {
	type: "user",
	id: "user_9aB2cD4eF6gH8iJ0",
	name: "Grace Hopper",
	email: "grace@acme.test",
}
const deployKey: AuditTrailEntry["actor"] = {
	type: "service",
	id: "key_4CzLmR1pTxWvYbNhQd82Kf",
	name: "CI deploy key",
	email: null,
}
const system: AuditTrailEntry["actor"] = { type: "system", id: null, name: null, email: null }

const SEEDS: ReadonlyArray<Seed> = [
	{
		provider: "vercel",
		account: "team_acme",
		minutesAgo: 2,
		action: "project.env-var.created",
		category: "credential",
		actor: { type: "user", id: "usr_9f2c", name: "Grace Hopper", email: "grace@acme.test" },
		originIp: "203.0.113.90",
		raw: { id: "evt_1", action: "project.env-var.created", payload: { projectId: "prj_web" } },
	},
	{
		provider: "gcp",
		account: "acme-prod",
		minutesAgo: 11,
		action: "google.iam.admin.v1.CreateServiceAccountKey",
		category: "credential",
		outcome: "denied",
		outcomeReason: "Permission iam.serviceAccountKeys.create denied",
		actor: {
			type: "service",
			id: "ci@acme-prod.iam.gserviceaccount.com",
			name: null,
			email: "ci@acme-prod.iam.gserviceaccount.com",
		},
		target: { type: "service_account", name: "projects/-/serviceAccounts/deploy@acme-prod" },
		originIp: "198.51.100.24",
		raw: { insertId: "abc123", protoPayload: { serviceName: "iam.googleapis.com" } },
	},
	{
		minutesAgo: 4,
		action: "alert_rule.updated",
		category: "configuration",
		actor: ada,
		target: { type: "alert_rule", id: "alrt_YofPTrK9782DWwcnXhpcCw" },
		originIp: "203.0.113.7",
		originCountry: "DE",
		raw: {
			source: "dashboard",
			changes: { fields: ["threshold"], before: { threshold: 5 }, after: { threshold: 2 } },
			requestId: "8f2c1a9d4b7e3f60",
		},
	},
	{
		minutesAgo: 19,
		action: "api.request",
		category: "permission",
		outcome: "denied",
		actor: deployKey,
		target: { type: "api", name: "POST /v2/dashboards" },
		originIp: "198.51.100.24",
		originCountry: "US",
		outcomeReason: "The key lacks the dashboards:write scope.",
		raw: { source: "api" },
	},
	{
		minutesAgo: 47,
		action: "api_key.created",
		category: "credential",
		actor: grace,
		target: { type: "api_key", id: "key_7HnQ2wErTyUiOpAsDfGhJk" },
		originIp: "203.0.113.90",
		originCountry: "NL",
		raw: { source: "dashboard", metadata: { name: "Terraform", scopes: ["alerts:write"] } },
	},
	{
		minutesAgo: 130,
		action: "member.role_changed",
		category: "membership",
		actor: system,
		target: { type: "member", id: "user_9aB2cD4eF6gH8iJ0" },
		raw: { source: "system", affectedUserId: "user_9aB2cD4eF6gH8iJ0", metadata: { role: "admin" } },
	},
	{
		minutesAgo: 260,
		action: "dashboard_share.created",
		category: "permission",
		actor: ada,
		target: { type: "dashboard_share", id: "dash_3KpLmN5oQrStUvWxYz12Ab" },
		originIp: "203.0.113.7",
		originCountry: "DE",
		raw: { source: "dashboard" },
	},
	{
		minutesAgo: 24 * 60 + 12,
		action: "status_page.break_glass_rotated",
		category: "credential",
		actor: grace,
		target: { type: "status_page", id: "spg_5TgBnHy6UjMki8OlP0qWeR" },
		originIp: "203.0.113.90",
		originCountry: "NL",
		raw: { source: "dashboard" },
	},
	{
		minutesAgo: 24 * 60 + 95,
		action: "telemetry.sql_executed",
		category: "data_access",
		outcome: "denied",
		actor: { type: "service", id: "actor_8UjMki9OlP0qWeRtY1uI2o", name: "Triage agent", email: null },
		target: { type: "telemetry" },
		outcomeReason: "The query reads a table this agent may not.",
		raw: { source: "mcp" },
	},
	{
		minutesAgo: 24 * 60 + 300,
		action: "warehouse_settings.updated",
		category: "configuration",
		actor: ada,
		target: { type: "warehouse_settings" },
		originIp: "203.0.113.7",
		originCountry: "DE",
		raw: { source: "dashboard", changes: { fields: ["host"], before: {}, after: {} } },
	},
]

const eventOf = (seed: Seed, index: number, nowMs: number): AuditTrailEntry => {
	const occurredAt = nowMs - seed.minutesAgo * MINUTE
	return {
		id: Str.padStart(32, "0")(index.toString(16)),
		provider: seed.provider ?? "maple",
		account: seed.account ?? null,
		providerEventId: `alog_4CzLmR1pTxWvYbNhQd82K${index}`,
		occurredAt,
		ingestedAt: occurredAt + 900,
		actor: seed.actor,
		action: seed.action,
		category: seed.category,
		outcome: seed.outcome ?? "success",
		outcomeReason: seed.outcomeReason ?? null,
		target: { type: null, id: null, name: null, ...seed.target },
		originIp: seed.originIp ?? null,
		originCountry: seed.originCountry ?? null,
		userAgent: null,
		raw: seed.raw ?? null,
	}
}

/** One page of events ending at `nowMs`; `hasMore` leaves a cursor for the footer. */
export const auditEventsOf = (nowMs: number, hasMore = true): AuditTrailListResponse => {
	const events = Arr.map(SEEDS, (seed, index) => eventOf(seed, index, nowMs))
	const last = Arr.last(events)
	return {
		events,
		nextCursor: hasMore && last._tag === "Some" ? `${last.value.occurredAt}:${last.value.id}` : null,
	}
}

export const noAuditEvents: AuditTrailListResponse = { events: [], nextCursor: null }
