import * as Policy from "@maple/domain/policy"
import { describe, expect, it } from "@effect/vitest"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { MapleInternalApi } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import type { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { OrgId, UserId } from "@maple/primitives"
import { Effect, Result, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { CurrentAuditActor } from "@maple/backend/services/auth/audit-actor"
import type { ChatTurnOrigin } from "@maple/domain/chat-session"
import { ActorId } from "@maple/primitives"
import { makeMemoryAuditLog } from "./AuditLogService"
import { auditAttribution, recordMcpToolAudit, recordRawSqlAudit, withAuditedRead } from "./audit-access"
import { AuditLogService } from "./AuditLogService"

const ORG = Schema.decodeSync(OrgId)("org_audit_access_test")
const USER = Schema.decodeSync(UserId)("user_audit_access_test")
/** The sentinel an investigation's own pass runs under, and the connector placeholder. */
const SERVICE_USER = Schema.decodeSync(UserId)("internal-service")
const CONNECTOR_PLACEHOLDER_USER = Schema.decodeSync(UserId)("chat-connector")
const CONNECTOR_ACTOR = Schema.decodeSync(ActorId)("00000000-0000-4000-8000-00000000c0de")

const CONNECTOR_ORIGIN: ChatTurnOrigin = {
	kind: "connector",
	connectorId: "testchat",
	workspaceId: "w1",
	externalUserId: "u-1",
	displayName: "Ada",
}

/** The `{ group, endpoint }` a security middleware receives for one endpoint. */
const endpointOf = (
	api: { readonly groups: Record<string, HttpApiGroup.Top> },
	group: string,
	name: string,
) => {
	const found = api.groups[group]
	if (found === undefined) throw new Error(`no group ${group}`)
	const endpoint = found.endpoints[name] as HttpApiEndpoint.Top | undefined
	if (endpoint === undefined) throw new Error(`no endpoint ${group}.${name}`)
	return { group: found, endpoint }
}

const request = (method: string, url: string, body?: string) =>
	HttpServerRequest.fromWeb(
		new Request(`https://api.test${url}`, {
			method,
			headers: { "cf-ray": "ray-1", "cf-connecting-ip": "203.0.113.7" },
			...(body !== undefined ? { body } : undefined),
		}),
	)

class HandlerFailure extends Schema.TaggedError<HandlerFailure>()("HandlerFailure", {
	message: Schema.String,
}) {}

const subject = {
	orgId: ORG,
	actor: { type: "user" as const, userId: USER },
	source: "dashboard" as const,
}

describe("withAuditedRead", () => {
	it.effect("records a telemetry read for an endpoint whose GROUP carries the annotation", () =>
		Effect.gen(function* () {
			const audit = makeMemoryAuditLog()
			const req = request("POST", "/internal/query-engine/execute-batch?x=1", '{"requests":[]}')
			const options = endpointOf(MapleInternalApi, "queryEngine", "executeBatch")
			// The handler reads the body first, exactly as a real one would.
			const handler = req.text.pipe(Effect.map(() => HttpServerResponse.empty({ status: 200 })))
			yield* withAuditedRead(audit, req, options, subject)(handler)

			const entries = yield* audit.list(ORG, { limit: 10, offset: 0 })
			expect(entries).toHaveLength(1)
			const entry = entries[0]
			expect(entry.action).toBe("telemetry.read")
			expect(entry.userId).toBe(USER)
			expect(entry.requestId).toBe("ray-1")
			expect(entry.metadata).toMatchObject({
				endpoint: "queryEngine.executeBatch",
				method: "POST",
				status: 200,
				body: '{"requests":[]}',
			})
		}),
	)

	it.effect("records session replay reads on the v2 group and nothing for unannotated endpoints", () =>
		Effect.gen(function* () {
			const audit = makeMemoryAuditLog()
			const ok = Effect.succeed(HttpServerResponse.empty({ status: 200 }))
			yield* withAuditedRead(
				audit,
				request("GET", "/v2/session_replays/s1"),
				endpointOf(MapleApiV2, "sessionReplays", "retrieve"),
				subject,
			)(ok)
			yield* withAuditedRead(
				audit,
				request("GET", "/v2/api_keys"),
				endpointOf(MapleApiV2, "apiKeys", "list"),
				subject,
			)(ok)

			const entries = yield* audit.list(ORG, { limit: 10, offset: 0 })
			expect(Arr.map(entries, (entry) => entry.action)).toEqual(["session_replay.read"])
		}),
	)

	it.effect("records reads of AI sessions, MCP servers, services, the service map and anomaly series", () =>
		Effect.gen(function* () {
			const audit = makeMemoryAuditLog()
			const ok = Effect.succeed(HttpServerResponse.empty({ status: 200 }))
			const reads = [
				[
					"POST",
					"/internal/ai-sessions/details",
					endpointOf(MapleInternalApi, "aiSessionsInternal", "details"),
				],
				[
					"POST",
					"/internal/mcp-servers/session",
					endpointOf(MapleInternalApi, "mcpInternal", "session"),
				],
				["GET", "/v2/services", endpointOf(MapleApiV2, "services", "list")],
				["GET", "/v2/service_map", endpointOf(MapleApiV2, "serviceMap", "retrieve")],
				[
					"GET",
					"/v2/anomalies/incidents/a1/timeseries",
					endpointOf(MapleApiV2, "anomalies", "getIncidentTimeseries"),
				],
				// Incident records and settings are not telemetry.
				["GET", "/v2/anomalies/incidents", endpointOf(MapleApiV2, "anomalies", "listIncidents")],
			] as const
			yield* Effect.forEach(reads, ([method, url, options]) =>
				withAuditedRead(audit, request(method, url), options, subject)(ok),
			)

			const entries = yield* audit.list(ORG, { limit: 10, offset: 0 })
			expect(Arr.map(entries, (entry) => entry.metadata?.endpoint).sort()).toEqual([
				"aiSessionsInternal.details",
				"anomalies.getIncidentTimeseries",
				"mcpInternal.session",
				"serviceMap.retrieve",
				"services.list",
			])
		}),
	)

	it.effect("still records an attempted read when the handler fails", () =>
		Effect.gen(function* () {
			const audit = makeMemoryAuditLog()
			const failing = Effect.fail(new HandlerFailure({ message: "boom" }))
			const outcome = yield* withAuditedRead(
				audit,
				request("GET", "/v2/traces/t1"),
				endpointOf(MapleApiV2, "traces", "retrieve"),
				subject,
			)(failing).pipe(Effect.result)
			expect(Result.isFailure(outcome)).toBe(true)
			const entries = yield* audit.list(ORG, { limit: 10, offset: 0 })
			expect(entries).toHaveLength(1)
			expect(entries[0].metadata).toMatchObject({ status: 0, endpoint: "traces.retrieve" })
		}),
	)
})

describe("auditAttribution", () => {
	it("attributes an agent tenant to the agent acting for the user", () => {
		const actorId = Schema.decodeSync(Schema.String)("actor_1")
		const attribution = auditAttribution(
			{
				orgId: ORG,
				userId: USER,
				actorId: actorId as never,
				mcpClientName: "claude-code",
				// An app turn keeps the pinned agent: only the two agent origins redirect.
				turnOrigin: { kind: "app" },
			},
			{ type: "api_key", source: "mcp" },
		)
		expect(attribution).toEqual({
			actor: { type: "agent", actorId, userId: USER, label: "claude-code" },
			source: "mcp",
		})
	})

	it("freezes the API key's name onto the entry", () => {
		const apiKeyId = Schema.decodeSync(Schema.String)("key_1")
		expect(
			auditAttribution(
				{ orgId: ORG, userId: USER },
				{ type: "api_key", apiKeyId: apiKeyId as never, label: "Deploy bot", source: "api" },
			),
		).toEqual({
			actor: { type: "api_key", userId: USER, apiKeyId, label: "Deploy bot" },
			source: "api",
		})
	})

	it("leaves a dashboard session unlabelled — its name is resolved when the log is read", () => {
		expect(auditAttribution({ orgId: ORG, userId: USER }, { type: "user", source: "dashboard" })).toEqual(
			{
				actor: { type: "user", userId: USER },
				source: "dashboard",
			},
		)
	})

	it("keeps a system token as system regardless of the tenant", () => {
		expect(auditAttribution({ orgId: ORG, userId: USER }, { type: "system", source: "system" })).toEqual({
			actor: { type: "system" },
			source: "system",
		})
	})

	it("files an unattended investigation pass as Maple itself, not as its service user", () => {
		// The tenant's user id is the internal-service sentinel: no user row stands
		// behind it, and the pass came from no dashboard.
		expect(
			auditAttribution(
				{ orgId: ORG, userId: SERVICE_USER, turnOrigin: { kind: "autonomous" } },
				undefined,
			),
		).toEqual({ actor: { type: "system" }, source: "system" })
	})

	it("files a connector turn as the connector's agent, with no user behind it", () => {
		expect(
			auditAttribution(
				{
					orgId: ORG,
					userId: CONNECTOR_PLACEHOLDER_USER,
					actorId: CONNECTOR_ACTOR,
					turnOrigin: CONNECTOR_ORIGIN,
				},
				undefined,
			),
		).toEqual({
			actor: { type: "agent", actorId: CONNECTOR_ACTOR, label: "chat-connector-testchat" },
			source: "chat_platform",
		})
	})

	it("names the connector even when its actor row could not be resolved", () => {
		// What an outage writes: no `actorId` to filter on, but the label and the
		// entry's metadata still say which connector answered.
		expect(
			auditAttribution(
				{ orgId: ORG, userId: CONNECTOR_PLACEHOLDER_USER, turnOrigin: CONNECTOR_ORIGIN },
				undefined,
			),
		).toEqual({
			actor: { type: "agent", label: "chat-connector-testchat" },
			source: "chat_platform",
		})
	})

	it("names the PERSON when a connector approval ran as the user they linked to", () => {
		// The connector's agent answers for a turn nobody can be named for. An approval on a
		// connector that CAN name them runs as their Maple user, so the entry has to say so — the
		// change was made by a person exercising their own roles, not by Maple acting for an org.
		expect(
			auditAttribution({ orgId: ORG, userId: USER, turnOrigin: CONNECTOR_ORIGIN }, undefined),
		).toEqual({ actor: { type: "user", userId: USER }, source: "dashboard" })
	})

	it("leaves an app turn exactly as an unattributed dashboard session", () => {
		expect(
			auditAttribution({ orgId: ORG, userId: USER, turnOrigin: { kind: "app" } }, undefined),
		).toEqual({ actor: { type: "user", userId: USER }, source: "dashboard" })
	})
})

describe("recordMcpToolAudit", () => {
	const toolCall = {
		name: "search_traces",
		input: { service: "api" },
		surface: "bot" as const,
		isError: false,
	}

	it.effect("records a connector turn's tool call against the external identity that asked", () =>
		Effect.gen(function* () {
			const audit = yield* AuditLogService
			yield* recordMcpToolAudit({
				...toolCall,
				tenant: {
					orgId: ORG,
					userId: CONNECTOR_PLACEHOLDER_USER,
					roles: [],
					permissions: Policy.grantsOf([]),
					authMode: "self_hosted",
					actorId: CONNECTOR_ACTOR,
					// The display name is the platform's, so its length is not Maple's to trust.
					turnOrigin: { ...CONNECTOR_ORIGIN, displayName: Str.padEnd(500, "!")("Ada") },
				},
			})

			const [entry] = yield* audit.list(ORG, { limit: 10, offset: 0 })
			expect(entry?.actorType).toBe("agent")
			expect(entry?.actorId).toBe(CONNECTOR_ACTOR)
			// The placeholder the tenant carries is not a user, so no user is named.
			expect(entry?.userId).toBeNull()
			expect(entry?.source).toBe("chat_platform")
			expect(entry?.metadata).toMatchObject({
				tool: "search_traces",
				surface: "bot",
				connector: "testchat",
				workspace_id: "w1",
				external_user_id: "u-1",
			})
			expect(entry?.metadata?.["display_name"]).toBe(
				`${Str.slice(0, 200)(Str.padEnd(500, "!")("Ada"))}…`,
			)
		}).pipe(Effect.provide(AuditLogService.layerMemory)),
	)

	it.effect("names a family's action, so a create reads apart from an update", () =>
		Effect.gen(function* () {
			const audit = yield* AuditLogService
			yield* recordMcpToolAudit({
				...toolCall,
				name: "manage_slo",
				action: "create",
				tenant: {
					orgId: ORG,
					userId: CONNECTOR_PLACEHOLDER_USER,
					roles: [],
					authMode: "self_hosted",
				},
			})
			const [entry] = yield* audit.list(ORG, { limit: 10, offset: 0 })
			expect(entry?.metadata).toMatchObject({ tool: "manage_slo", tool_action: "create" })
		}).pipe(Effect.provide(AuditLogService.layerMemory)),
	)

	it.effect("stores a tool call's URL parameters without their userinfo and query", () =>
		Effect.gen(function* () {
			const audit = yield* AuditLogService
			yield* recordMcpToolAudit({
				...toolCall,
				name: "create_scrape_target",
				input: {
					name: "payments",
					url: "https://scraper:p4ss@metrics.example.com/metrics?token=s3cr3t-token",
					steps: [{ url: "https://api.example.com/login?api_key=k3y-123" }],
					service: "api",
				},
				tenant: { orgId: ORG, userId: USER, roles: [], authMode: "self_hosted" },
			})

			const [entry] = yield* audit.list(ORG, { limit: 10, offset: 0 })
			expect(JSON.parse(String(entry?.metadata?.["params"]))).toEqual({
				name: "payments",
				url: "https://metrics.example.com/metrics",
				steps: [{ url: "https://api.example.com/login" }],
				service: "api",
			})
		}).pipe(Effect.provide(AuditLogService.layerMemory)),
	)

	it.effect("keeps free text that starts with a URL whole, and cuts only a parameter that is a URL", () =>
		Effect.gen(function* () {
			const audit = yield* AuditLogService
			const body =
				"https://docs.example.com/runbook?step=2\n\nRestart the worker, then check the queue."
			yield* recordMcpToolAudit({
				...toolCall,
				name: "create_note",
				input: { body, link: "https://docs.example.com/runbook?step=2" },
				tenant: { orgId: ORG, userId: USER, roles: [], authMode: "self_hosted" },
			})

			const [entry] = yield* audit.list(ORG, { limit: 10, offset: 0 })
			expect(JSON.parse(String(entry?.metadata?.["params"]))).toEqual({
				body,
				link: "https://docs.example.com/runbook",
			})
		}).pipe(Effect.provide(AuditLogService.layerMemory)),
	)

	it.effect("still records a call whose parameters are nested deeper than any stack walks", () =>
		Effect.gen(function* () {
			const audit = yield* AuditLogService
			const nest = (depth: number, leaf: unknown) =>
				Arr.reduce(
					Arr.makeBy(depth, () => null),
					leaf,
					(inner) => ({ next: [inner] }),
				)
			yield* recordMcpToolAudit({
				...toolCall,
				input: {
					service: "api",
					shallow: nest(5, "https://metrics.example.com/metrics?token=s3cr3t-token"),
					deep: nest(100_000, "https://metrics.example.com/metrics?token=d33p-token"),
				},
				tenant: { orgId: ORG, userId: USER, roles: [], authMode: "self_hosted" },
			})

			const entries = yield* audit.list(ORG, { limit: 10, offset: 0 })
			expect(entries).toHaveLength(1)
			const params = String(entries[0]?.metadata?.["params"])
			expect(params).toContain('"service":"api"')
			expect(params).toContain("https://metrics.example.com/metrics")
			expect(params).toContain("<nested too deep>")
			expect(params).not.toContain("token")
		}).pipe(Effect.provide(AuditLogService.layerMemory)),
	)

	it.effect("records an autonomous pass's tool call as system, with no origin metadata", () =>
		Effect.gen(function* () {
			const audit = yield* AuditLogService
			yield* recordMcpToolAudit({
				...toolCall,
				name: "sandbox_grep",
				title: "Search Repository Checkout",
				surface: "chat",
				tenant: {
					orgId: ORG,
					userId: SERVICE_USER,
					roles: [],
					permissions: Policy.grantsOf([]),
					authMode: "self_hosted",
					turnOrigin: { kind: "autonomous" },
					chatMode: "pr-review",
				},
			})

			const [entry] = yield* audit.list(ORG, { limit: 10, offset: 0 })
			expect(entry?.actorType).toBe("system")
			// The pass is named, not a bare "System".
			expect(entry?.actorLabel).toBe("Maple code review")
			expect(entry?.userId).toBeNull()
			expect(entry?.source).toBe("system")
			expect(entry?.metadata).not.toHaveProperty("connector")
			// Names the agent and the tool in words a customer can read.
			expect(entry?.metadata).toMatchObject({
				tool: "sandbox_grep",
				tool_title: "Search Repository Checkout",
				agent: "pr-review",
			})
		}).pipe(Effect.provide(AuditLogService.layerMemory)),
	)
})

describe("recordRawSqlAudit", () => {
	it.effect("records a refused statement as denied and an executed one with its row count", () =>
		Effect.gen(function* () {
			const audit = yield* AuditLogService
			const base = {
				tenant: { orgId: ORG, userId: USER },
				sql: "SELECT 1",
				context: "mcp.run_sql",
				startTime: "2026-08-29 09:00:00",
				endTime: "2026-08-29 10:00:00",
			}
			yield* recordRawSqlAudit({
				...base,
				result: { _tag: "rejected", reason: "missing $__orgFilter" },
			})
			yield* TestClock.adjust("1 second")
			yield* recordRawSqlAudit({ ...base, result: { _tag: "rows", rowCount: 3 } })

			const entries = yield* audit.list(ORG, { limit: 10, offset: 0 })
			expect(Arr.map(entries, (entry) => [entry.action, entry.outcome])).toEqual([
				["telemetry.sql_executed", "allowed"],
				["telemetry.sql_executed", "denied"],
			])
			expect(entries[1].denialReason).toBe("missing $__orgFilter")
			expect(entries[0].metadata).toMatchObject({
				sql: "SELECT 1",
				row_count: 3,
				context: "mcp.run_sql",
			})
			expect(entries[0].source).toBe("mcp")
		}).pipe(
			Effect.provideService(CurrentAuditActor, { type: "api_key", source: "mcp" }),
			Effect.provide(AuditLogService.layerMemory),
		),
	)

	// The statement that read customer data is the entry an auditor opens first, so
	// it answers "on whose behalf" the same way the tool entry does.
	it.effect("attributes a statement to the turn that ran it", () =>
		Effect.gen(function* () {
			const audit = yield* AuditLogService
			const base = {
				sql: "SELECT 1",
				context: "mcp.run_sql",
				startTime: "2026-08-29 09:00:00",
				endTime: "2026-08-29 10:00:00",
				result: { _tag: "rows", rowCount: 1 } as const,
			}
			yield* recordRawSqlAudit({
				...base,
				tenant: {
					orgId: ORG,
					userId: CONNECTOR_PLACEHOLDER_USER,
					actorId: CONNECTOR_ACTOR,
					turnOrigin: CONNECTOR_ORIGIN,
				},
			})
			yield* TestClock.adjust("1 second")
			yield* recordRawSqlAudit({
				...base,
				tenant: { orgId: ORG, userId: SERVICE_USER, turnOrigin: { kind: "autonomous" } },
			})

			const entries = yield* audit.list(ORG, { limit: 10, offset: 0 })
			const [autonomous, connector] = entries
			expect(autonomous?.actorType).toBe("system")
			expect(autonomous?.source).toBe("system")
			expect(connector?.actorId).toBe(CONNECTOR_ACTOR)
			expect(connector?.source).toBe("chat_platform")
			expect(connector?.metadata).toMatchObject({ connector: "testchat", display_name: "Ada" })
		}).pipe(Effect.provide(AuditLogService.layerMemory)),
	)
})
