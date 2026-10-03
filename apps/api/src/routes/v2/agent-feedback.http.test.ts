import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { OrgId, UserId } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { Env } from "@maple/backend/platform/Env"
import { ApiAuthorizationV2Layer } from "@maple/backend/services/auth/ApiAuthorizationV2Layer"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { SharedDashboardService } from "@maple/backend/services/dashboards/SharedDashboardService"
import { V2TransportErrorBoundaryLive } from "./error-envelope"
import {
	AlertsServiceStubLayer,
	AllV2GroupLayersLive,
	ApiV2RateLimiterAllowAllLayer,
	ConfigResourceServiceStubsLayer,
	Phase1ResourceStubsLayer,
	PlanetScaleServiceStubsLayer,
	TelemetryServiceStubsLayer,
} from "./v2-test-support"

/** `/v2/agent_feedback` over an embedded PGlite: create stores what the agent said, list reads it back. */

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_feedback_e2e")
const USER = Schema.decodeUnknownSync(UserId)("user_feedback_e2e")

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3488",
			MCP_PORT: "3489",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

const makeHarness = () => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))
	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		DashboardPersistenceService.layer,
		SharedDashboardService.layer,
	).pipe(Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)))

	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(AllV2GroupLayersLive),
		Layer.provide(V2TransportErrorBoundaryLive),
		Layer.provide(AlertsServiceStubLayer),
		Layer.provide(ConfigResourceServiceStubsLayer),
		Layer.provide(Phase1ResourceStubsLayer),
		Layer.provide(PlanetScaleServiceStubsLayer),
		Layer.provide(TelemetryServiceStubsLayer),
		Layer.provideMerge(ApiAuthorizationV2Layer),
		Layer.provideMerge(AuditLogService.layerMemory),
		Layer.provideMerge(ApiV2RateLimiterAllowAllLayer),
		Layer.provideMerge(servicesLive),
	)
	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const runtime = ManagedRuntime.make(servicesLive)

	const request = async (method: string, path: string, token: string, body?: unknown) => {
		const response = await handler(
			new Request(`http://maple.test${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					...(body !== undefined ? { "content-type": "application/json" } : undefined),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) }
	}

	const bootstrapKey = (scopes?: ReadonlyArray<string>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, { name: "feedback-test", scopes })
			}),
		)

	return {
		request,
		bootstrapKey,
		runtime,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

describe("v2 agent feedback", () => {
	it("creates feedback with kind, agent and reason, then lists it", async () => {
		const harness = makeHarness()
		try {
			const key = await harness.bootstrapKey()

			const created = await harness.request("POST", "/v2/agent_feedback", key.secret, {
				kind: "bug",
				impact: "blocking",
				summary: "search_traces ignores the environment filter",
				reason: "Needed production-only traces to answer the user.",
				related_to: "search_traces",
				agent: { type: "coding_agent", name: "claude-code", model: "claude-opus-5-5" },
			})
			expect(created.status).toBe(200)
			expect(created.body).toMatchObject({
				object: "agent_feedback",
				kind: "bug",
				impact: "blocking",
				details: null,
				related_to: "search_traces",
				agent: { type: "coding_agent", name: "claude-code", model: "claude-opus-5-5", version: null },
				source: "api",
			})
			expect(created.body.id).toMatch(/^afb_/)

			const listed = await harness.request("GET", "/v2/agent_feedback", key.secret)
			expect(listed.status).toBe(200)
			expect(listed.body.data.map((row: { id: string }) => row.id)).toEqual([created.body.id])
			expect(listed.body.has_more).toBe(false)
		} finally {
			await harness.dispose()
		}
	})

	it("rejects an unknown kind and a blank reason as invalid requests", async () => {
		const harness = makeHarness()
		try {
			const key = await harness.bootstrapKey()
			const base = { summary: "x", reason: "y", agent: { type: "other" } }

			const badKind = await harness.request("POST", "/v2/agent_feedback", key.secret, {
				...base,
				kind: "rant",
			})
			expect(badKind.status).toBe(400)

			const blank = await harness.request("POST", "/v2/agent_feedback", key.secret, {
				...base,
				kind: "other",
				reason: "   ",
			})
			expect(blank.status).toBe(400)
		} finally {
			await harness.dispose()
		}
	})

	it("sends and lists feedback with a key that has no agent_feedback scope", async () => {
		const harness = makeHarness()
		try {
			const key = await harness.bootstrapKey(["traces:read"])
			const created = await harness.request("POST", "/v2/agent_feedback", key.secret, {
				kind: "praise",
				summary: "Nice",
				reason: "It worked",
				agent: { type: "chat_assistant" },
			})
			expect(created.status).toBe(200)
			expect(created.body.kind).toBe("praise")

			const listed = await harness.request("GET", "/v2/agent_feedback", key.secret)
			expect(listed.status).toBe(200)
			expect(listed.body.data.map((row: { id: string }) => row.id)).toEqual([created.body.id])
		} finally {
			await harness.dispose()
		}
	})
})
