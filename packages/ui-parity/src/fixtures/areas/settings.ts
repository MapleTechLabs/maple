import { parseWarehouseDateTime } from "@maple/query-engine"
import { Effect, Predicate } from "effect"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import { ONBOARDING_CHECKLIST_STEP_IDS, ONBOARDING_OPTIONAL_STEP_IDS } from "@maple/domain/onboarding-checklist"
import type { FixtureArea } from "../areas.ts"
import type { Dataset, EndpointHandler, EndpointRequest, SyncedRow } from "../dataset.ts"
import { defaultDataset } from "../datasets/default.ts"
import { acmeAdmin, DAY, FROZEN_NOW, fixtureUuid, HOUR, isoBefore, MINUTE } from "../identity.ts"
import { emptyTelemetry } from "../telemetry/rows.ts"
import { isAcme } from "./integrations.ts"
import { clerkBillingEndpoints } from "./settings-billing.ts"
import { setupAuditEndpoint } from "./settings-setup-audit.ts"

/**
 * Settings tabs: audit log, Data Platform (BYO ClickHouse), automation, AI provider and API keys
 * are Postgres-backed, so canned; the Setup Audit runs the API's real checks (settings-setup-audit.ts).
 * Acme gets populated answers, every other org the empty ones.
 */

const iso = (request: EndpointRequest, agoMs: number) => new Date(parseWarehouseDateTime(request.dataset.now) - agoMs).toISOString()
const list = (data: ReadonlyArray<unknown>) => ({ object: "list", data, has_more: false, next_cursor: null })

const DESTINATION_ID = fixtureUuid(1, 1)
const ISSUE_IDS = [fixtureUuid(4, 1), fixtureUuid(4, 2)] as const

interface AuditFields {
	readonly action: string
	readonly agoMs: number
	readonly actor?: "user" | "api_key" | "agent" | "system"
	readonly source?: "dashboard" | "api" | "mcp" | "system"
	readonly resource?: readonly [type: string, id: string | null]
	readonly changes?: { readonly fields: ReadonlyArray<string>; readonly before: unknown; readonly after: unknown }
	readonly denied?: string
}

const auditEntry = (request: EndpointRequest, index: number, fields: AuditFields) => {
	const actor = fields.actor ?? "user"
	const at = iso(request, fields.agoMs)
	return {
		id: encodePublicId(PublicIdPrefixes.auditLogEntry, fixtureUuid(0xd1, index)),
		object: "audit_log_entry",
		action: fields.action,
		outcome: fields.denied === undefined ? "allowed" : "denied",
		denial_reason: fields.denied ?? null,
		actor_type: actor,
		actor_id: actor === "user" ? acmeAdmin.userId : actor === "api_key" ? "key_ci_deploy" : actor === "agent" ? "actor_claude_code" : null,
		actor_name: actor === "user" ? acmeAdmin.name : actor === "api_key" ? "CI deploy" : actor === "agent" ? "Claude Code" : null,
		actor_avatar_url: null,
		affected_user: null,
		source: fields.source ?? (actor === "system" ? "system" : "dashboard"),
		resource_type: fields.resource?.[0] ?? null,
		resource_id: fields.resource?.[1] ?? null,
		changes: fields.changes ?? null,
		metadata: null,
		request_id: `req_parity_${index.toString(16).padStart(4, "0")}`,
		origin_ip: actor === "system" ? null : "203.0.113.24",
		origin_country: actor === "system" ? null : "GB",
		occurred_at: at,
		recorded_at: at,
	}
}

const rule = (index: number) => encodePublicId(PublicIdPrefixes.alertRule, fixtureUuid(2, index))

const auditEntries = (request: EndpointRequest) => [
	auditEntry(request, 9, {
		action: "alert_rule.updated",
		agoMs: 35 * MINUTE,
		resource: ["alert_rule", rule(2)],
		changes: { fields: ["threshold"], before: { threshold: 1200 }, after: { threshold: 800 } },
	}),
	auditEntry(request, 8, { action: "dashboard.created", agoMs: 2 * HOUR, resource: ["dashboard", "dash_parity_2"] }),
	auditEntry(request, 7, {
		action: "api_key.created",
		agoMs: 5 * HOUR,
		actor: "api_key",
		source: "api",
		resource: ["api_key", encodePublicId(PublicIdPrefixes.apiKey, fixtureUuid(0xd2, 3))],
	}),
	auditEntry(request, 6, {
		action: "alert_rule.deleted",
		agoMs: 9 * HOUR,
		actor: "agent",
		source: "mcp",
		resource: ["alert_rule", rule(9)],
		denied: "API key lacks the alert_rules:write scope",
	}),
	auditEntry(request, 5, {
		action: "alert_rule.updated",
		agoMs: 3 * DAY,
		resource: ["alert_rule", rule(4)],
		changes: { fields: ["enabled"], before: { enabled: true }, after: { enabled: false } },
	}),
	auditEntry(request, 4, { action: "scrape_target.created", agoMs: 4 * DAY, resource: ["scrape_target", null] }),
	auditEntry(request, 3, { action: "alert_destination.tested", agoMs: 5 * DAY, resource: ["alert_destination", null] }),
	auditEntry(request, 2, { action: "integration.connected", agoMs: 9 * DAY, actor: "system", resource: ["integration", null] }),
]

const queryField = (query: unknown, key: string): string | undefined =>
	Predicate.hasProperty(query, key) && typeof query[key] === "string" ? query[key] : undefined

/** Honors the two filters the page sends (`outcome`, `actor_type`), as the API does. */
const auditLog: EndpointHandler = (request) => {
	const outcome = queryField(request.query, "outcome")
	const actorType = queryField(request.query, "actor_type")
	const entries = isAcme(request) ? auditEntries(request) : []
	return Effect.succeed(
		list(
			entries.filter(
				(entry) =>
					(outcome === undefined || entry.outcome === outcome) && (actorType === undefined || entry.actor_type === actorType),
			),
		),
	)
}

const SCHEMA_VERSION = "2026-09-30.1"
const TABLES = ["traces", "logs", "metrics_gauge", "metrics_sum", "metrics_histogram", "service_map_edges_hourly"] as const
const VIEWS = ["service_usage_mv", "traces_aggregates_hourly_mv", "logs_aggregates_hourly_mv"] as const

/** Acme writes to its own ClickHouse service, synced and on the current schema. */
const clickhouseSettings: EndpointHandler = (request) =>
	Effect.succeed({
		configured: isAcme(request),
		chUrl: isAcme(request) ? "https://ch.acme.test:8443" : null,
		chUser: isAcme(request) ? "maple_writer" : null,
		chDatabase: isAcme(request) ? "maple" : null,
		syncStatus: isAcme(request) ? "connected" : null,
		lastSyncAt: isAcme(request) ? iso(request, 4 * MINUTE) : null,
		lastSyncError: null,
		schemaVersion: isAcme(request) ? SCHEMA_VERSION : null,
	})

const schemaDiff: EndpointHandler = () =>
	Effect.succeed({
		expectedSchemaVersion: SCHEMA_VERSION,
		appliedSchemaVersion: SCHEMA_VERSION,
		entries: [
			...TABLES.map((name) => ({ status: "up_to_date", name, kind: "table" })),
			...VIEWS.map((name) => ({ status: "up_to_date", name, kind: "materialized_view" })),
		],
	})

const applySchemaStatus: EndpointHandler = (request) => {
	const done = isAcme(request)
	const finishedAt = parseWarehouseDateTime(request.dataset.now) - 6 * DAY
	return Effect.succeed({
		status: done ? "succeeded" : "idle",
		phase: null,
		currentMigration: null,
		stepsTotal: done ? 9 : null,
		stepsDone: done ? 9 : null,
		appliedVersions: done ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : [],
		skipped: [],
		errorMessage: null,
		startedAt: done ? finishedAt - 41_000 : null,
		finishedAt: done ? finishedAt : null,
	})
}

const escalationPolicy: EndpointHandler = (request) =>
	Effect.succeed(
		isAcme(request)
			? {
					enabled: true,
					rules: [
						{ severity: "critical", destinationIds: [DESTINATION_ID] },
						{ severity: "high", destinationIds: [DESTINATION_ID], minConfidence: "medium" },
					],
					updatedAt: iso(request, 6 * DAY),
					updatedBy: acmeAdmin.userId,
				}
			: { enabled: false, rules: [], updatedAt: null, updatedBy: null },
	)

/** One AI escalation that paged on-call, one manual one the confidence floor held back. */
const escalation = (request: EndpointRequest, index: 0 | 1) => ({
	id: fixtureUuid(0xd3, index + 1),
	issueId: ISSUE_IDS[index],
	investigationId: null,
	severity: index === 0 ? "critical" : "high",
	source: index === 0 ? "ai" : "manual",
	reason: index === 0 ? "severity_set" : "severity_escalated",
	status: index === 0 ? "sent" : "skipped",
	attempts: 1,
	skipReason: index === 0 ? null : "below_min_confidence",
	deliveries:
		index === 0 ? [{ destinationId: DESTINATION_ID, destinationName: "On-call webhook", status: "delivered", error: null }] : [],
	createdAt: iso(request, index === 0 ? 100 * MINUTE : 26 * HOUR),
	processedAt: iso(request, index === 0 ? 99 * MINUTE : 26 * HOUR),
})

const recentEscalations: EndpointHandler = (request) =>
	Effect.succeed({ attempts: isAcme(request) ? [escalation(request, 0), escalation(request, 1)] : [] })

const aiTriageSettings: EndpointHandler = (request) =>
	Effect.succeed({
		enabled: isAcme(request),
		maxRunsPerDay: 50,
		maxPassesPerDay: 300,
		usage: isAcme(request) ? { runs: 6, passes: 31 } : { runs: 0, passes: 0 },
		ordinaryPaused: false,
		priorityPaused: false,
		pausedDimension: null,
		resumesAt: null,
		updatedAt: isAcme(request) ? iso(request, 12 * DAY) : null,
		updatedBy: isAcme(request) ? acmeAdmin.userId : null,
	})

const openRouterKey: EndpointHandler = (request) =>
	Effect.succeed({
		entitled: true,
		configured: isAcme(request),
		keyHint: isAcme(request) ? "x7Qa" : null,
		updatedAt: isAcme(request) ? iso(request, 18 * DAY) : null,
		updatedBy: isAcme(request) ? acmeAdmin.userId : null,
	})

const STEP_TITLES = {
	send_telemetry: "Send your first telemetry",
	connect_github: "Connect GitHub",
	create_alert_rule: "Create an alert rule",
	connect_mcp_agent: "Connect an AI agent over MCP",
	invite_teammate: "Invite a teammate",
	join_slack_channel: "Join a shared Slack channel",
} as const satisfies Record<(typeof ONBOARDING_CHECKLIST_STEP_IDS)[number], string>

/** An established org redeemed its onboarding credit long ago. */
const onboardingChecklist: EndpointHandler = (request) => {
	const required = ONBOARDING_CHECKLIST_STEP_IDS.filter((id) => !ONBOARDING_OPTIONAL_STEP_IDS.has(id))
	return Effect.succeed({
		object: "onboarding_checklist",
		status: "claimed",
		reward_amount_usd: 30,
		deadline_at: iso(request, 60 * DAY),
		claimed_at: iso(request, 80 * DAY),
		completed_count: required.length,
		total_count: required.length,
		steps: ONBOARDING_CHECKLIST_STEP_IDS.map((id) => ({
			object: "onboarding_checklist_step",
			id,
			title: STEP_TITLES[id],
			completed: true,
			href: "/",
			optional: ONBOARDING_OPTIONAL_STEP_IDS.has(id),
		})),
	})
}

interface ApiKeyFields {
	readonly name: string
	readonly kind: "standard" | "mcp"
	readonly scopes: ReadonlyArray<string> | null
	readonly usedAgoMs: number | null
	readonly ageMs: number
	readonly revoked?: boolean
}

const apiKey = (index: number, fields: ApiKeyFields): SyncedRow => ({
	id: fixtureUuid(0xd2, index),
	org_id: acmeAdmin.orgId,
	name: fields.name,
	description: null,
	key_prefix: `maple_${fields.kind === "mcp" ? "mcp" : "ak"}_${index.toString(16).padStart(4, "0")}`,
	revoked: fields.revoked ?? false,
	revoked_at: fields.revoked ? isoBefore(2 * DAY) : null,
	last_used_at: fields.usedAgoMs === null ? null : isoBefore(fields.usedAgoMs),
	expires_at: null,
	scopes: fields.scopes,
	kind: fields.kind,
	created_at: isoBefore(fields.ageMs),
	created_by: acmeAdmin.userId,
	created_by_email: acmeAdmin.email,
})

const API_KEYS: ReadonlyArray<SyncedRow> = [
	apiKey(1, { name: "Grafana read-only", kind: "standard", scopes: ["telemetry:read", "dashboards:read"], usedAgoMs: 3 * MINUTE, ageMs: 60 * DAY }),
	apiKey(2, { name: "Claude Code", kind: "mcp", scopes: null, usedAgoMs: 2 * HOUR, ageMs: 21 * DAY }),
	apiKey(3, { name: "CI deploy", kind: "standard", scopes: ["alert_rules:write", "dashboards:write"], usedAgoMs: 5 * HOUR, ageMs: 5 * HOUR }),
	apiKey(4, { name: "Old terraform", kind: "standard", scopes: null, usedAgoMs: null, ageMs: 120 * DAY, revoked: true }),
]

/** Acme in Clerk mode: the Clerk-only settings tabs and /account. Shares Acme's warehouse org. */
const settingsClerk: Dataset = {
	name: "settings-clerk",
	now: FROZEN_NOW,
	identity: acmeAdmin,
	auth: "clerk",
	endpoints: { ...defaultDataset.endpoints, "onboardingChecklist.retrieve": onboardingChecklist },
	synced: { ...defaultDataset.synced, api_keys: API_KEYS },
	telemetry: emptyTelemetry,
}

export const fixtureArea: FixtureArea = {
	area: "settings",
	endpoints: (warehouse) => ({
		"auditLog.list": auditLog,
		"orgClickHouseSettings.get": clickhouseSettings,
		"orgClickHouseSettings.schemaDiff": schemaDiff,
		"orgClickHouseSettings.applySchemaStatus": applySchemaStatus,
		"errors.getEscalationPolicy": escalationPolicy,
		"errors.listRecentEscalations": recentEscalations,
		"aiTriage.getSettings": aiTriageSettings,
		"openRouterKey.get": openRouterKey,
		"instrumentationAudit.retrieve": setupAuditEndpoint(warehouse),
		...clerkBillingEndpoints(warehouse),
	}),
	defaultSynced: { api_keys: API_KEYS },
	datasets: [settingsClerk],
}
