import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { OrgId, UserId } from "@maple/domain/http"
import { MapleApiV2, encodePublicId } from "@maple/domain/http/v2"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import { ApiAuthorizationV2Live } from "@maple/backend/services/auth/ApiAuthorizationV2Live"
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
 * `/v2/integrations/aws` over an embedded PGlite with the real connection service: the wire shape a
 * script parses, the one-account rule, the admin gate and the setup a CloudShell paste runs. The
 * check against AWS itself is covered by `AwsConnectionService.test.ts`.
 */

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_aws_e2e")
const USER = Schema.decodeUnknownSync(UserId)("user_aws_e2e")
const OTHER_ORG = Schema.decodeUnknownSync(OrgId)("org_aws_e2e_other")
const BASE = "/v2/integrations/aws"

const testConfig = (awsAvailable: boolean) =>
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
			...(awsAvailable
				? {
						MAPLE_AWS_PRINCIPAL_ARN: "arn:aws:iam::999999999999:user/maple-integrations",
						MAPLE_AWS_ACCESS_KEY_ID: "AKIAMAPLETEST0000001",
						MAPLE_AWS_SECRET_ACCESS_KEY: "maple-test-secret",
					}
				: undefined),
		}),
	)

const makeHarness = (options: { readonly awsAvailable: boolean } = { awsAvailable: true }) => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig(options.awsAvailable)))
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
		Layer.provideMerge(ApiAuthorizationV2Live),
		Layer.provideMerge(AuditLogService.layerMemory),
		Layer.provideMerge(ApiV2RateLimiterAllowAllLayer),
		Layer.provideMerge(servicesLive),
	)
	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const runtime = ManagedRuntime.make(servicesLive)

	/** Root-role key (API keys resolve as `root` unless their metadata pins roles). */
	const adminKey = (scopes?: ReadonlyArray<string>, org: OrgId = ORG) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(org, USER, { name: "aws-admin", scopes })
			}),
		)

	const memberKey = () =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, {
					name: "aws-member",
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
		testDb,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

const CONNECTIONS = `${BASE}/connections`

describe("v2 aws integration over HTTP", () => {
	it("creates a connection, renders its setup for admins, lists it for any member, deletes it", async () => {
		const harness = makeHarness()
		const admin = await harness.adminKey()
		const member = await harness.memberKey()

		const created = await harness.request("POST", CONNECTIONS, admin.secret, {
			account_id: "123456789012",
		})
		expect(created.status).toBe(200)
		expect(created.body).toEqual({
			id: expect.stringMatching(/^awsc_/),
			object: "aws_connection",
			account_id: "123456789012",
			role_arn: expect.stringMatching(
				/^arn:aws:iam::123456789012:role\/MapleIntegration-[0-9a-f]{24}$/,
			),
			external_id: expect.stringMatching(/^[0-9a-f]{32}$/),
			modules: [],
			granted_modules: null,
			template_version: null,
			setup_outdated: false,
			verified_at: null,
			last_checked_at: null,
			last_check_error: null,
			created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
		})
		const id: string = created.body.id

		const duplicate = await harness.request("POST", CONNECTIONS, admin.secret, {
			account_id: "123456789012",
		})
		expect(duplicate.status).toBe(409)

		const setup = await harness.request("GET", `${CONNECTIONS}/${id}/setup`, admin.secret)
		expect(setup.status).toBe(200)
		expect(setup.body.object).toBe("aws_connection.setup")
		expect(setup.body.setup_script).toContain(`--stack-name ${setup.body.stack_name}`)
		expect(setup.body.setup_script).toContain('if [ "$account" != "123456789012" ]')
		// The template names the role the connection reports and requires its external id.
		const template = JSON.parse(setup.body.cloudformation_template)
		const role = template.Resources.MapleRole.Properties
		expect(created.body.role_arn.endsWith(`/${role.RoleName}`)).toBe(true)
		expect(role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals["sts:ExternalId"]).toBe(
			created.body.external_id,
		)
		expect(setup.body.terraform).toContain(`name                 = "${role.RoleName}"`)

		// Members read the status; only admins render setups or change anything.
		const status = await harness.request("GET", BASE, member.secret)
		expect(status.status).toBe(200)
		expect(status.body.available).toBe(true)
		expect(status.body.connections.map((connection: { id: string }) => connection.id)).toEqual([id])
		expect(status.body.modules.map((module: { module: string }) => module.module)).toEqual([
			"observability",
			"inventory",
			"security",
			"cost",
		])
		expect((await harness.request("GET", `${CONNECTIONS}/${id}/setup`, member.secret)).status).toBe(403)
		expect((await harness.request("DELETE", `${CONNECTIONS}/${id}`, member.secret)).status).toBe(403)

		const deleted = await harness.request("DELETE", `${CONNECTIONS}/${id}`, admin.secret)
		expect(deleted.status).toBe(200)
		expect(deleted.body).toMatchObject({ id, object: "aws_connection", deleted: true })
		expect(deleted.body.cleanup_script).toContain(
			`delete-stack --region us-east-1 --stack-name ${setup.body.stack_name}`,
		)
		expect((await harness.request("GET", BASE, admin.secret)).body.connections).toEqual([])
		await harness.dispose()
	})

	it("rejects a malformed account id and modules Maple does not read yet", async () => {
		const harness = makeHarness()
		const admin = await harness.adminKey()
		expect(
			(await harness.request("POST", CONNECTIONS, admin.secret, { account_id: "12345" })).status,
		).toBe(400)
		const planned = await harness.request("POST", CONNECTIONS, admin.secret, {
			account_id: "123456789012",
			modules: ["cost"],
		})
		expect(planned.status).toBe(400)
		await harness.dispose()
	})

	it("lets admins change a connection's modules, and 404s once it is gone", async () => {
		const harness = makeHarness()
		const admin = await harness.adminKey()
		const member = await harness.memberKey()
		const created = await harness.request("POST", CONNECTIONS, admin.secret, {
			account_id: "123456789012",
		})
		const path = `${CONNECTIONS}/${created.body.id}`

		expect((await harness.request("PATCH", path, member.secret, { modules: [] })).status).toBe(403)
		const unchanged = await harness.request("PATCH", path, admin.secret, {})
		expect(unchanged.status).toBe(200)
		expect(unchanged.body.modules).toEqual([])
		expect((await harness.request("PATCH", path, admin.secret, { modules: ["cost"] })).status).toBe(400)
		await harness.request("DELETE", path, admin.secret)
		const missing = await harness.request("PATCH", path, admin.secret, { modules: [] })
		expect(missing.status).toBe(404)
		await harness.dispose()
	})

	it("hides a connection from another org's admin, and keeps members from checking it", async () => {
		const harness = makeHarness()
		const admin = await harness.adminKey()
		const member = await harness.memberKey()
		const outsider = await harness.adminKey(undefined, OTHER_ORG)
		const created = await harness.request("POST", CONNECTIONS, admin.secret, {
			account_id: "123456789012",
		})
		const path = `${CONNECTIONS}/${created.body.id}`

		expect((await harness.request("POST", `${path}/check`, member.secret)).status).toBe(403)
		expect((await harness.request("GET", BASE, outsider.secret)).body.connections).toEqual([])
		expect((await harness.request("GET", `${path}/setup`, outsider.secret)).status).toBe(404)
		expect((await harness.request("POST", `${path}/check`, outsider.secret)).status).toBe(404)
		expect((await harness.request("PATCH", path, outsider.secret, { modules: [] })).status).toBe(404)
		expect((await harness.request("DELETE", path, outsider.secret)).status).toBe(404)
		// The connection is still there, unchanged, for its own org.
		const status = await harness.request("GET", BASE, admin.secret)
		expect(status.body.connections.map((connection: { id: string }) => connection.id)).toEqual([
			created.body.id,
		])
		await harness.dispose()
	})

	it("reports AWS unavailable on a deployment without Maple's AWS identity", async () => {
		const harness = makeHarness({ awsAvailable: false })
		const admin = await harness.adminKey()
		expect((await harness.request("GET", BASE, admin.secret)).body.available).toBe(false)
		const created = await harness.request("POST", CONNECTIONS, admin.secret, {
			account_id: "123456789012",
		})
		expect(created.status).toBe(409)
		expect(created.body.error.code).toBe("aws_integration_unavailable")
		await harness.dispose()
	})
})
