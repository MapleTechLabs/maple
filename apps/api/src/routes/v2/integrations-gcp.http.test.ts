import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { OrgId, UserId } from "@maple/domain/http"
import { MapleApiV2, encodePublicId } from "@maple/domain/http/v2"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { ApiAuthorizationV2Layer } from "@maple/backend/services/auth/ApiAuthorizationV2Layer"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { SharedDashboardService } from "@maple/backend/services/dashboards/SharedDashboardService"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { V2TransportErrorBoundaryLive } from "./error-envelope"
import {
	AlertsServiceStubLayer,
	AllV2GroupLayersLive,
	ApiV2RateLimiterAllowAllLayer,
	ConfigResourceServiceStubsLayer,
	PlanetScaleServiceStubsLayer,
	TelemetryServiceStubsLayer,
} from "./v2-test-support"

/**
 * `/v2/integrations/gcp` over an embedded PGlite with the real connector service: the wire shape
 * a script parses, the admin gate, and who can reach the push secret.
 */

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_gcp_e2e")
const USER = Schema.decodeUnknownSync(UserId)("user_gcp_e2e")
const BASE = "/v2/integrations/gcp"

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3478",
			MCP_PORT: "3479",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			MAPLE_INGEST_PUBLIC_URL: "https://ingest.test",
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
		Layer.provide(PlanetScaleServiceStubsLayer),
		Layer.provide(TelemetryServiceStubsLayer),
		Layer.provideMerge(ApiAuthorizationV2Layer),
		Layer.provideMerge(AuditLogService.layerMemory),
		Layer.provideMerge(ApiV2RateLimiterAllowAllLayer),
		Layer.provideMerge(servicesLive),
	)
	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const runtime = ManagedRuntime.make(servicesLive)

	/** Root-role key (API keys resolve as `root` unless their metadata pins roles). */
	const adminKey = (scopes?: ReadonlyArray<string>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, { name: "gcp-admin", scopes })
			}),
		)

	const memberKey = () =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, {
					name: "gcp-member",
					metadataJson: { source: "maple_cli", roles: ["org:member"], deviceName: "laptop" },
				})
			}),
		)

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

	return {
		request,
		adminKey,
		memberKey,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

describe("v2 gcp integration over HTTP", () => {
	it("creates a connector, lists it for any member, and deletes it with a cleanup script", async () => {
		const harness = makeHarness()
		const admin = await harness.adminKey()
		const member = await harness.memberKey()

		const created = await harness.request("POST", `${BASE}/connectors`, admin.secret, {
			project_id: "acme-prod",
		})
		expect(created.status).toBe(200)
		expect(created.body).toEqual({
			id: expect.stringMatching(/^gcpc_/),
			object: "gcp_connector",
			project_id: "acme-prod",
			created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
			last_log_received_at: null,
			last_log_error: null,
		})

		const status = await harness.request("GET", BASE, member.secret)
		expect(status.status).toBe(200)
		expect(status.body).toEqual({
			object: "gcp_integration",
			metrics_available: false,
			connectors: [created.body],
		})

		const path = `${BASE}/connectors/${created.body.id}`
		const deleted = await harness.request("DELETE", path, admin.secret)
		expect(deleted.status).toBe(200)
		expect(deleted.body).toEqual({
			id: created.body.id,
			object: "gcp_connector",
			deleted: true,
			cleanup_script: expect.stringContaining("gcloud logging sinks delete"),
		})

		const gone = await harness.request("POST", `${path}/setup_scripts`, admin.secret, {})
		expect(gone.status).toBe(404)
		expect(gone.body.error).toMatchObject({
			_tag: "@maple/http/errors/IntegrationsNotFoundError",
			code: "integration_not_found",
		})
		await harness.dispose()
	})

	it("renders the scripts for an admin, with the push secret only in the setup script", async () => {
		const harness = makeHarness()
		const admin = await harness.adminKey()
		const created = await harness.request("POST", `${BASE}/connectors`, admin.secret, {
			project_id: "acme-prod",
		})
		const path = `${BASE}/connectors/${created.body.id}/setup_scripts`

		const { status, body } = await harness.request("POST", path, admin.secret, {
			exclude_gke_container_logs: true,
		})
		expect(status).toBe(200)
		expect(Object.keys(body).sort()).toEqual(["cleanup_script", "object", "setup_script"])
		expect(body.object).toBe("gcp_connector.setup_scripts")
		expect(body.setup_script).toMatch(
			/PUSH_ENDPOINT='https:\/\/ingest\.test\/v1\/logpush\/gcp\/[0-9a-f-]{36}\?secret=maple_gcp_/,
		)
		expect(body.setup_script).toContain("PROJECT_ID='acme-prod'")
		expect(body.setup_script).toContain('NOT resource.type="k8s_container"')
		expect(body.cleanup_script).not.toContain("maple_gcp_")

		const defaults = await harness.request("POST", path, admin.secret, {})
		expect(defaults.body.setup_script).not.toContain("k8s_container")
		await harness.dispose()
	})

	it("keeps the push secret from non-admin members and from read-scoped keys", async () => {
		const harness = makeHarness()
		const admin = await harness.adminKey()
		const member = await harness.memberKey()
		const readOnly = await harness.adminKey(["integrations:read"])
		const created = await harness.request("POST", `${BASE}/connectors`, admin.secret, {
			project_id: "acme-prod",
		})
		const path = `${BASE}/connectors/${created.body.id}`

		for (const [method, target, body] of [
			["POST", `${BASE}/connectors`, { project_id: "other-project" }],
			["POST", `${path}/setup_scripts`, {}],
			["DELETE", path, undefined],
		] as const) {
			const asMember = await harness.request(method, target, member.secret, body)
			expect(asMember.status).toBe(403)
			expect(asMember.body.error).toMatchObject({
				type: "permission_error",
				code: "insufficient_permissions",
			})
			const asReadOnly = await harness.request(method, target, readOnly.secret, body)
			expect(asReadOnly.status).toBe(403)
			expect(asReadOnly.body.error.code).toBe("insufficient_scope")
		}

		const status = await harness.request("GET", BASE, readOnly.secret)
		expect(status.status).toBe(200)
		expect(status.body.connectors).toHaveLength(1)
		expect(JSON.stringify(status.body)).not.toContain("maple_gcp_")
		await harness.dispose()
	})

	it("answers a project that is already connected with a 409 naming the field", async () => {
		const harness = makeHarness()
		const admin = await harness.adminKey()
		await harness.request("POST", `${BASE}/connectors`, admin.secret, { project_id: "acme-prod" })

		const { status, body } = await harness.request("POST", `${BASE}/connectors`, admin.secret, {
			project_id: "acme-prod",
		})
		expect(status).toBe(409)
		expect(body.error).toMatchObject({
			_tag: "@maple/http/errors/GcpProjectAlreadyConnectedError",
			type: "conflict_error",
			code: "gcp_project_already_connected",
			param: "project_id",
		})
		await harness.dispose()
	})

	it("rejects anything that is not a Google Cloud project id or a gcpc_ id before the service", async () => {
		const harness = makeHarness()
		const admin = await harness.adminKey()

		for (const projectId of ["acme'; rm -rf /; '", "Acme-Prod", "short", "acme-prod-", "$(id)-project"]) {
			const { status, body } = await harness.request("POST", `${BASE}/connectors`, admin.secret, {
				project_id: projectId,
			})
			expect(status, projectId).toBe(400)
			expect(body.error.type).toBe("invalid_request_error")
		}

		const wrongPrefix = encodePublicId("scrp", "018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")
		const { status } = await harness.request("DELETE", `${BASE}/connectors/${wrongPrefix}`, admin.secret)
		expect(status).toBe(400)

		const empty = await harness.request("GET", BASE, admin.secret)
		expect(empty.body.connectors).toEqual([])
		await harness.dispose()
	})
})
