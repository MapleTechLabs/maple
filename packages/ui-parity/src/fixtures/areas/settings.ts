import { parseWarehouseDateTime } from "@maple/query-engine"
import { Effect, Predicate } from "effect"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import {
	ONBOARDING_CHECKLIST_STEP_IDS,
	ONBOARDING_OPTIONAL_STEP_IDS,
} from "@maple/domain/onboarding-checklist"
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

const iso = (request: EndpointRequest, agoMs: number) =>
	new Date(parseWarehouseDateTime(request.dataset.now) - agoMs).toISOString()
const list = (data: ReadonlyArray<unknown>) => ({ object: "list", data, has_more: false, next_cursor: null })

const DESTINATION_ID = fixtureUuid(1, 1)
const ISSUE_IDS = [fixtureUuid(4, 1), fixtureUuid(4, 2)] as const

interface AuditFields {
	readonly action: string
	readonly agoMs: number
	readonly actor?: "user" | "api_key" | "agent" | "system"
	readonly source?: "dashboard" | "api" | "mcp" | "system"
	readonly resource?: readonly [type: string, id: string | null]
	readonly changes?: {
		readonly fields: ReadonlyArray<string>
		readonly before: unknown
		readonly after: unknown
	}
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
		actor_id:
			actor === "user"
				? acmeAdmin.userId
				: actor === "api_key"
					? "key_ci_deploy"
					: actor === "agent"
						? "actor_claude_code"
						: null,
		actor_name:
			actor === "user"
				? acmeAdmin.name
				: actor === "api_key"
					? "CI deploy"
					: actor === "agent"
						? "Claude Code"
						: null,
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
	auditEntry(request, 8, {
		action: "dashboard.created",
		agoMs: 2 * HOUR,
		resource: ["dashboard", "dash_parity_2"],
	}),
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
	auditEntry(request, 4, {
		action: "scrape_target.created",
		agoMs: 4 * DAY,
		resource: ["scrape_target", null],
	}),
	auditEntry(request, 3, {
		action: "alert_destination.tested",
		agoMs: 5 * DAY,
		resource: ["alert_destination", null],
	}),
	auditEntry(request, 2, {
		action: "integration.connected",
		agoMs: 9 * DAY,
		actor: "system",
		resource: ["integration", null],
	}),
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
					(outcome === undefined || entry.outcome === outcome) &&
					(actorType === undefined || entry.actor_type === actorType),
			),
		),
	)
}

const SCHEMA_VERSION = "2026-09-30.1"
const TABLES = [
	"traces",
	"logs",
	"metrics_gauge",
	"metrics_sum",
	"metrics_histogram",
	"service_map_edges_hourly",
] as const
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
		index === 0
			? [
					{
						destinationId: DESTINATION_ID,
						destinationName: "On-call webhook",
						status: "delivered",
						error: null,
					},
				]
			: [],
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
	apiKey(1, {
		name: "Grafana read-only",
		kind: "standard",
		scopes: ["telemetry:read", "dashboards:read"],
		usedAgoMs: 3 * MINUTE,
		ageMs: 60 * DAY,
	}),
	apiKey(2, { name: "Claude Code", kind: "mcp", scopes: null, usedAgoMs: 2 * HOUR, ageMs: 21 * DAY }),
	apiKey(3, {
		name: "CI deploy",
		kind: "standard",
		scopes: ["alert_rules:write", "dashboards:write"],
		usedAgoMs: 5 * HOUR,
		ageMs: 5 * HOUR,
	}),
	apiKey(4, {
		name: "Old terraform",
		kind: "standard",
		scopes: null,
		usedAgoMs: null,
		ageMs: 120 * DAY,
		revoked: true,
	}),
]

// KEY AND CONNECTION WRITES (the Keys and MCP tabs click every one through)

const wireApiKey = (row: SyncedRow, overrides: Readonly<Record<string, unknown>> = {}) => ({
	...row,
	id: encodePublicId(PublicIdPrefixes.apiKey, String(row.id)),
	object: "api_key",
	...overrides,
})
const paramId = (params: unknown): string | undefined =>
	Predicate.hasProperty(params, "id") && typeof params.id === "string" ? params.id : undefined
const keyById = (params: unknown) => API_KEYS.find((row) => row.id === paramId(params)) ?? API_KEYS[0]

/** Echoes the payload into a new key with a fixed secret, as `createApiKey` would. */
const createApiKey: EndpointHandler = ({ payload }) => {
	const field = (key: string) => (Predicate.hasProperty(payload, key) ? payload[key] : undefined)
	const kind = field("kind") === "mcp" ? "mcp" : "standard"
	const row = apiKey(9, {
		name: typeof field("name") === "string" ? String(field("name")) : "New key",
		kind,
		scopes: Array.isArray(field("scopes")) ? field("scopes") : null,
		usedAgoMs: null,
		ageMs: 0,
	})
	return Effect.succeed({ ...wireApiKey(row), secret: `maple_${kind === "mcp" ? "mcp" : "ak"}_parity_secret_0009` })
}

const revokeApiKey: EndpointHandler = ({ params }) =>
	Effect.succeed(wireApiKey(keyById(params), { revoked: true, revoked_at: isoBefore(0) }))

const rollApiKey: EndpointHandler = ({ params }) =>
	Effect.succeed({ ...wireApiKey(keyById(params)), secret: "maple_ak_parity_rolled_0001" })

const rolledIngestKeys: EndpointHandler = ({ dataset }) =>
	Effect.succeed({
		object: "ingest_keys",
		public_key: `maple_pk_parity_${dataset.name}_rolled`,
		private_key: `maple_sk_parity_${dataset.name}_rolled`,
		public_rotated_at: isoBefore(0),
		private_rotated_at: isoBefore(0),
	})

const mcpConnection = {
	id: encodePublicId(PublicIdPrefixes.mcpConnection, fixtureUuid(0xd4, 1)),
	object: "mcp_connection",
	client_name: "Claude Code",
	user_id: acmeAdmin.userId,
	user_email: acmeAdmin.email,
	scopes: ["mcp:tools"],
	connected_at: isoBefore(18 * DAY),
	last_refreshed_at: isoBefore(40 * MINUTE),
	expires_at: isoBefore(-72 * DAY),
}

/** Acme with one OAuth client connected, so the MCP tab's revoke can be clicked through. */
const settingsMcpClients: Dataset = {
	...defaultDataset,
	name: "settings-mcp-clients",
	endpoints: {
		...defaultDataset.endpoints,
		"mcpConnections.list": () => Effect.succeed(list([mcpConnection])),
		"mcpConnections.revoke": () => Effect.succeed(mcpConnection),
	},
	telemetry: emptyTelemetry,
}

// INGESTION RULES (attribute mappings and recommendations, with every write)

const mapping = (index: number, fields: Readonly<Record<string, unknown>>) => ({
	id: encodePublicId(PublicIdPrefixes.attributeMapping, fixtureUuid(0xd5, index)),
	object: "attribute_mapping",
	source_context: "span",
	operation: "copy",
	enabled: true,
	created_at: isoBefore(20 * DAY),
	updated_at: isoBefore(3 * DAY),
	...fields,
})

const MAPPINGS = [
	mapping(1, { name: "HTTP status code", source_key: "http.status_code", target_key: "http.response.status_code" }),
	mapping(2, {
		name: "Team label",
		source_context: "resource",
		source_key: "labels.team",
		target_key: "team",
		operation: "move",
		enabled: false,
	}),
]

const recommendation = (index: number, fields: Readonly<Record<string, unknown>>) => ({
	id: encodePublicId(PublicIdPrefixes.recommendation, fixtureUuid(0xd6, index)),
	object: "recommendation",
	number: index,
	canonical_key: null,
	status: "open",
	usage_count: 1200 * index,
	opened_at: isoBefore(6 * DAY),
	updated_at: isoBefore(DAY),
	resolved_at: null,
	...fields,
})

const RECOMMENDATIONS = [
	recommendation(1, {
		recommendation_key: "rename:http.method",
		kind: "rename",
		source_key: "http.method",
		canonical_key: "http.request.method",
	}),
	recommendation(2, { recommendation_key: "naming:userId", kind: "naming", source_key: "userId" }),
	recommendation(3, {
		recommendation_key: "double-emission:db.statement",
		kind: "double-emission",
		source_key: "db.statement",
		canonical_key: "db.query.text",
		status: "dismissed",
	}),
]

const echoMapping: EndpointHandler = ({ payload }) =>
	Effect.succeed(mapping(9, Predicate.isObject(payload) ? { ...payload } : {}))
const firstMapping: EndpointHandler = () => Effect.succeed(MAPPINGS[0])
const firstRecommendation =
	(status: string): EndpointHandler =>
	() =>
		Effect.succeed({ ...RECOMMENDATIONS[0], status })

/** Acme with ingest rules to manage: two mappings, two open recommendations and a dismissed one. */
const settingsIngestionRules: Dataset = {
	...defaultDataset,
	name: "settings-ingestion-rules",
	endpoints: {
		...defaultDataset.endpoints,
		"attributeMappings.list": () => Effect.succeed(list(MAPPINGS)),
		"instrumentationRecommendations.list": () => Effect.succeed(list(RECOMMENDATIONS)),
	},
	telemetry: emptyTelemetry,
}

/** Acme's cluster behind Maple's schema: a missing view and a drifted table, so Apply has work. */
const settingsDataPlatformDrift: Dataset = {
	...defaultDataset,
	name: "settings-data-platform-drift",
	endpoints: {
		...defaultDataset.endpoints,
		"orgClickHouseSettings.schemaDiff": () =>
			Effect.succeed({
				expectedSchemaVersion: SCHEMA_VERSION,
				appliedSchemaVersion: "2026-09-01.1",
				entries: [
					{ status: "missing", name: "service_usage_mv", kind: "materialized_view" },
					{
						status: "drifted",
						name: "logs",
						kind: "table",
						columnDrifts: [
							{ kind: "missing", column: "ScopeVersion", expectedType: "LowCardinality(String)" },
							{ kind: "type_mismatch", column: "Body", expectedType: "String", actualType: "Nullable(String)" },
						],
					},
					...TABLES.filter((name) => name !== "logs").map((name) => ({ status: "up_to_date", name, kind: "table" })),
				],
			}),
	},
	telemetry: emptyTelemetry,
}

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
		"apiKeys.create": createApiKey,
		"apiKeys.revoke": revokeApiKey,
		"apiKeys.roll": rollApiKey,
		"ingestKeys.rollPublic": rolledIngestKeys,
		"ingestKeys.rollPrivate": rolledIngestKeys,
		"orgClickHouseSettings.upsert": (request) =>
			Effect.map(clickhouseSettings(request), (current) => ({
				...current,
				configured: true,
				chUrl: Predicate.hasProperty(request.payload, "url") ? request.payload.url : current.chUrl,
				chUser: Predicate.hasProperty(request.payload, "user") ? request.payload.user : current.chUser,
				chDatabase: Predicate.hasProperty(request.payload, "database") ? request.payload.database : current.chDatabase,
			})),
		"orgClickHouseSettings.delete": () => Effect.succeed({ configured: false }),
		"orgClickHouseSettings.applySchema": () => Effect.succeed({ status: "started" }),
		"errors.upsertEscalationPolicy": (request) =>
			Effect.map(escalationPolicy(request), (current) => ({
				...current,
				...(Predicate.isObject(request.payload) ? request.payload : {}),
			})),
		"errors.evaluateEscalationPolicy": () =>
			Effect.succeed({ outcome: "route", destinationIds: [DESTINATION_ID], skipReason: null }),
		"aiTriage.updateSettings": (request) =>
			Effect.map(aiTriageSettings(request), (current) => ({
				...current,
				...(Predicate.isObject(request.payload) ? request.payload : {}),
			})),
		"openRouterKey.set": (request) =>
			Effect.map(openRouterKey(request), (current) => ({ ...current, configured: true, keyHint: "9Zq1" })),
		"openRouterKey.remove": (request) =>
			Effect.map(openRouterKey(request), (current) => ({ ...current, configured: false, keyHint: null })),
		"attributeMappings.create": echoMapping,
		"attributeMappings.update": firstMapping,
		"attributeMappings.delete": () =>
			Effect.succeed({ id: MAPPINGS[0]?.id, object: "attribute_mapping", deleted: true }),
		"instrumentationRecommendations.dismiss": firstRecommendation("dismissed"),
		"instrumentationRecommendations.reopen": firstRecommendation("open"),
		...clerkBillingEndpoints(warehouse),
	}),
	defaultSynced: { api_keys: API_KEYS },
	datasets: [settingsClerk, settingsMcpClients, settingsIngestionRules, settingsDataPlatformDrift],
}
