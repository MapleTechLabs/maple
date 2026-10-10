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
 * a script parses, the scope and capability rules, the admin gate, and who can reach the push
 * secret.
 */

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_gcp_e2e")
const USER = Schema.decodeUnknownSync(UserId)("user_gcp_e2e")
const BASE = "/v2/integrations/gcp"

const testConfig = (metricsAvailable: boolean) =>
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
			...(metricsAvailable
				? { MAPLE_GCP_SERVICE_ACCOUNT_EMAIL: "collector@maple-prod.iam.gserviceaccount.com" }
				: undefined),
		}),
	)

const makeHarness = (options: { readonly metricsAvailable: boolean } = { metricsAvailable: true }) => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig(options.metricsAvailable)))
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

const CONNECTORS = `${BASE}/connectors`
const organizationConnector = {
	scope_type: "organization",
	scope_id: "123456789012",
	project_id: "acme-host",
	metrics_enabled: true,
}
const projectConnector = { scope_type: "project", scope_id: "acme-prod" }

describe("v2 gcp integration over HTTP", () => {
	it("creates connectors per scope, lists them for any member, deletes with a cleanup script", async () => {
		const harness = makeHarness()
		const admin = await harness.adminKey()
		const member = await harness.memberKey()

		const organization = await harness.request("POST", CONNECTORS, admin.secret, organizationConnector)
		expect(organization.status).toBe(200)
		expect(organization.body).toEqual({
			id: expect.stringMatching(/^gcpc_/),
			object: "gcp_connector",
			scope_type: "organization",
			scope_id: "123456789012",
			project_id: "acme-host",
			logs_enabled: true,
			metrics_enabled: true,
			created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
			last_log_received_at: null,
			last_log_error: null,
			applied_logs_enabled: null,
			applied_metrics_enabled: null,
			setup_reported_at: null,
		})

		// A project is its own host project, and forwards logs only unless asked otherwise.
		const project = await harness.request("POST", CONNECTORS, admin.secret, projectConnector)
		expect(project.body).toMatchObject({
			scope_type: "project",
			scope_id: "acme-prod",
			project_id: "acme-prod",
			logs_enabled: true,
			metrics_enabled: false,
		})

		const status = await harness.request("GET", BASE, member.secret)
		expect(status.status).toBe(200)
		expect(status.body).toMatchObject({ object: "gcp_integration", metrics_available: true })
		expect(status.body.connectors).toEqual(expect.arrayContaining([organization.body, project.body]))
		expect(status.body.connectors).toHaveLength(2)

		const path = `${CONNECTORS}/${organization.body.id}`
		const deleted = await harness.request("DELETE", path, admin.secret)
		expect(deleted.status).toBe(200)
		expect(deleted.body).toEqual({
			id: organization.body.id,
			object: "gcp_connector",
			deleted: true,
			cleanup_script: expect.stringContaining(
				'gcloud logging sinks delete "$SINK" --organization="$SCOPE_ID"',
			),
		})
		// The connector is gone: its cleanup script has nothing to report to.
		expect(deleted.body.cleanup_script).not.toContain("maple_gcp_")

		const gone = await harness.request("POST", `${path}/setup_scripts`, admin.secret, {})
		expect(gone.status).toBe(404)
		expect(gone.body.error).toMatchObject({
			_tag: "@maple/http/errors/IntegrationsNotFoundError",
			code: "integration_not_found",
		})
		await harness.dispose()
	})

	it("renders scripts that follow the connector's scope and switches", async () => {
		const harness = makeHarness()
		const admin = await harness.adminKey()
		const created = await harness.request("POST", CONNECTORS, admin.secret, {
			...organizationConnector,
			scope_type: "folder",
		})
		const path = `${CONNECTORS}/${created.body.id}`

		const both = await harness.request("POST", `${path}/setup_scripts`, admin.secret, {
			log_filter: "include_gke_container_logs",
		})
		expect(both.status).toBe(200)
		expect(Object.keys(both.body).sort()).toEqual(["cleanup_script", "object", "setup_script"])
		expect(both.body.object).toBe("gcp_connector.setup_scripts")
		expect(both.body.setup_script).toMatch(
			/PUSH_ENDPOINT='https:\/\/ingest\.test\/v1\/logpush\/gcp\/[0-9a-f-]{36}\?secret=maple_gcp_/,
		)
		expect(both.body.setup_script).toContain("PROJECT_ID='acme-host'")
		expect(both.body.setup_script).toContain("SCOPE_ID='123456789012'")
		expect(both.body.setup_script).toContain('--folder="$SCOPE_ID" --include-children')
		expect(both.body.setup_script).toContain(
			`LOG_FILTER_MODE='set'\nLOG_FILTER='NOT log_id("cloudaudit.googleapis.com/data_access") AND NOT httpRequest.userAgent:"GoogleHC" AND NOT protoPayload.methodName="io.k8s.coordination.v1.leases.update" AND NOT logName:"serialconsole.googleapis.com"'`,
		)
		expect(both.body.setup_script).toContain(
			'gcloud resource-manager folders add-iam-policy-binding "$SCOPE_ID"',
		)
		// What is copied is the script as a here-document for a bash process of its own.
		expect(both.body.setup_script).toMatch(/^ \{ .*\nbash \/dev\/fd\/3 3<<'MAPLE_SETUP_SCRIPT'\n/)
		expect(both.body.cleanup_script).toMatch(/\nMAPLE_CLEANUP_SCRIPT\n\}\n$/)
		// The cleanup script tells Maple that it ran, with the connector's secret.
		expect(both.body.cleanup_script).toContain("?secret=maple_gcp_")

		// Without an option an existing sink keeps its filter and a new one gets the default, which
		// leaves out GKE container logs; with logs off there is none to carry.
		const kept = await harness.request("POST", `${path}/setup_scripts`, admin.secret, {})
		expect(kept.body.setup_script).toContain("LOG_FILTER_MODE='keep'")
		expect(kept.body.setup_script).toContain(` AND NOT resource.type="k8s_container"'\n`)
		const unknown = await harness.request("POST", `${path}/setup_scripts`, admin.secret, {
			log_filter: "everything",
		})
		expect(unknown.status).toBe(400)

		const patched = await harness.request("PATCH", path, admin.secret, { logs_enabled: false })
		expect(patched.status).toBe(200)
		expect(patched.body).toEqual({ ...created.body, logs_enabled: false })

		const metricsOnly = await harness.request("POST", `${path}/setup_scripts`, admin.secret, {})
		expect(metricsOnly.body.setup_script).not.toContain("LOG_FILTER")
		expect(metricsOnly.body.setup_script).toContain("gcloud logging sinks delete")
		await harness.dispose()
	})

	it("keeps one capability on, and refuses metrics on a deployment without a Google identity", async () => {
		const harness = makeHarness({ metricsAvailable: false })
		const admin = await harness.adminKey()

		const unavailable = await harness.request("POST", CONNECTORS, admin.secret, organizationConnector)
		expect(unavailable.status).toBe(409)
		expect(unavailable.body.error).toMatchObject({
			_tag: "@maple/http/errors/GcpMetricsUnavailableError",
			code: "gcp_metrics_unavailable",
			param: "metrics_enabled",
		})

		const nothing = await harness.request("POST", CONNECTORS, admin.secret, {
			...projectConnector,
			logs_enabled: false,
		})
		expect(nothing.status).toBe(400)
		expect(nothing.body.error.code).toBe("integration_request_invalid")

		const created = await harness.request("POST", CONNECTORS, admin.secret, projectConnector)
		const path = `${CONNECTORS}/${created.body.id}`
		expect((await harness.request("GET", BASE, admin.secret)).body.metrics_available).toBe(false)

		const turnOn = await harness.request("PATCH", path, admin.secret, { metrics_enabled: true })
		expect(turnOn.status).toBe(409)
		expect(turnOn.body.error.code).toBe("gcp_metrics_unavailable")
		const turnOff = await harness.request("PATCH", path, admin.secret, { logs_enabled: false })
		expect(turnOff.status).toBe(400)
		expect(turnOff.body.error.code).toBe("integration_request_invalid")
		await harness.dispose()
	})

	it("keeps the push secret from non-admin members and from read-scoped keys", async () => {
		const harness = makeHarness()
		const admin = await harness.adminKey()
		const member = await harness.memberKey()
		const readOnly = await harness.adminKey(["integrations:read"])
		const created = await harness.request("POST", CONNECTORS, admin.secret, projectConnector)
		const path = `${CONNECTORS}/${created.body.id}`

		for (const [method, target, body] of [
			["POST", CONNECTORS, { scope_type: "project", scope_id: "other-project" }],
			["PATCH", path, { metrics_enabled: true }],
			["POST", `${path}/setup_scripts`, {}],
			["DELETE", path, undefined],
		] as const) {
			const asMember = await harness.request(method, target, member.secret, body)
			expect(asMember.status, `${method} as member`).toBe(403)
			expect(asMember.body.error).toMatchObject({
				type: "permission_error",
				code: "insufficient_permissions",
			})
			const asReadOnly = await harness.request(method, target, readOnly.secret, body)
			expect(asReadOnly.status, `${method} with a read-only key`).toBe(403)
			expect(asReadOnly.body.error.code).toBe("insufficient_scope")
		}

		const status = await harness.request("GET", BASE, readOnly.secret)
		expect(status.status).toBe(200)
		expect(status.body.connectors).toEqual([created.body])
		expect(JSON.stringify(status.body)).not.toContain("maple_gcp_")
		await harness.dispose()
	})

	it("answers a scope that is already connected with a 409 naming the field", async () => {
		const harness = makeHarness()
		const admin = await harness.adminKey()
		await harness.request("POST", CONNECTORS, admin.secret, organizationConnector)

		const { status, body } = await harness.request("POST", CONNECTORS, admin.secret, {
			...organizationConnector,
			project_id: "another-host",
		})
		expect(status).toBe(409)
		expect(body.error).toMatchObject({
			_tag: "@maple/http/errors/GcpScopeAlreadyConnectedError",
			type: "conflict_error",
			code: "gcp_scope_already_connected",
			param: "scope_id",
		})
		await harness.dispose()
	})

	it("answers malformed scopes and connector ids with 400, an unknown connector with 404", async () => {
		const harness = makeHarness()
		const admin = await harness.adminKey()

		for (const body of [
			{ scope_type: "project", scope_id: "acme'; echo pwned; '" },
			{ scope_type: "project", scope_id: "Acme-Prod" },
			{ scope_type: "project", scope_id: "$(id)-project" },
			// A project hosts itself.
			{ scope_type: "project", scope_id: "acme-prod", project_id: "acme-host" },
			// Folders and organizations are numbers and need a host project.
			{ scope_type: "organization", scope_id: "acme.example", project_id: "acme-host" },
			{ scope_type: "folder", scope_id: "123456789012" },
			{ scope_type: "folder", scope_id: "123456789012", project_id: "123456789012" },
			{ scope_type: "billing_account", scope_id: "123456789012", project_id: "acme-host" },
			{ scope_id: "acme-prod" },
		]) {
			const response = await harness.request("POST", CONNECTORS, admin.secret, body)
			expect(response.status, JSON.stringify(body)).toBe(400)
			expect(response.body.error.type).toBe("invalid_request_error")
		}
		// The accepted spelling of the rejected project case above.
		const selfHosted = await harness.request("POST", CONNECTORS, admin.secret, {
			...projectConnector,
			project_id: "acme-prod",
		})
		expect(selfHosted.status).toBe(200)

		const wrongPrefix = encodePublicId("scrp", "018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")
		const malformed = await harness.request("DELETE", `${CONNECTORS}/${wrongPrefix}`, admin.secret)
		expect(malformed.status).toBe(400)

		const unknown = `${CONNECTORS}/${encodePublicId("gcpc", "018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")}`
		expect((await harness.request("DELETE", unknown, admin.secret)).status).toBe(404)
		const patch = await harness.request("PATCH", unknown, admin.secret, { logs_enabled: true })
		expect(patch.status).toBe(404)
		await harness.dispose()
	})
})
