import { afterEach, describe, expect, it } from "@effect/vitest"
import { Array as Arr, ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { OrgId, UserId } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { ApiAuthorizationV2Live } from "@maple/backend/services/auth/ApiAuthorizationV2Live"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { AuditLogService, makeMemoryAuditLog } from "@maple/backend/services/audit/AuditLogService"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { SharedDashboardService } from "@maple/backend/services/dashboards/SharedDashboardService"
import { MAPLE_TEST_OIDC_KEY } from "@maple/backend/services/integrations/aws/fake-aws"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { DISABLED_ORGANIZATION_FEATURE_FLAGS } from "@maple/domain/organization-feature-flags"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { V2TransportErrorBoundaryLive } from "./error-envelope"
import { ApiV2RateLimiterAllowAllLayer } from "./v2-test-support"
import { AwsConnectionService } from "@maple/backend/services/integrations/AwsConnectionService"
import { AwsIngestService } from "@maple/backend/services/integrations/AwsIngestService"
import { HttpV2AwsIntegrationsLive } from "./integrations-aws.http"

/**
 * `/v2/integrations/aws` over an embedded PGlite with the real connection service: the wire shape a
 * script parses, the one-account rule, the admin gate and the setup a CloudShell paste runs. The
 * check against AWS itself is covered by `AwsConnectionService.test.ts`.
 */

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeSync(OrgId)("org_aws_e2e")
const USER = Schema.decodeSync(UserId)("user_aws_e2e")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_aws_e2e_other")
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
			MAPLE_API_BASE_URL: "https://api.maple.test",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
			...(awsAvailable ? { MAPLE_AWS_OIDC_SIGNING_KEY: MAPLE_TEST_OIDC_KEY.privateKey } : undefined),
		}),
	)

/** What the warehouse holds for `/ingest`: each row as ClickHouse sends it, and the SQL it was asked. */
const makeWarehouse = (rows: ReadonlyArray<unknown>) => {
	const asked: Array<string> = []
	const service = makeWarehouseServiceStub({
		compiledQuery: (_tenant, compiled) => {
			asked.push(compiledQueryOf(compiled).sql)
			return compiledQueryOf(compiled).decodeRows(rows).pipe(Effect.orDie)
		},
	})
	return { asked, layer: Layer.succeed(WarehouseQueryService, service) }
}

const makeHarness = (
	options: {
		readonly awsAvailable: boolean
		readonly warehouseRows?: ReadonlyArray<unknown>
		/** Every rollout on, so `security` can be asked for. Off by default. */
		readonly rolledOut?: boolean
	} = {
		awsAvailable: true,
	},
) => {
	const testDb = createTestDb(createdDbs)
	const warehouse = makeWarehouse(options.warehouseRows ?? [])
	const auditLog = makeMemoryAuditLog()
	const envLive = Env.layer.pipe(Layer.provide(testConfig(options.awsAvailable)))
	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		DashboardPersistenceService.layer,
		SharedDashboardService.layer,
	).pipe(Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)))

	const routes = HttpApiBuilder.layer(
		HttpApi.make("MapleApiV2").add(MapleApiV2.groups.awsIntegration),
	).pipe(
		Layer.provide(
			HttpV2AwsIntegrationsLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						// Outside every rollout: `security` is then planned.
						Layer.effect(AwsConnectionService, AwsConnectionService.make).pipe(
							Layer.provide([
								FetchHttpClient.layer,
								options.rolledOut === true
									? OrganizationFeatureFlagsService.allEnabled
									: OrganizationFeatureFlagsService.fixed(
											DISABLED_ORGANIZATION_FEATURE_FLAGS,
										),
							]),
						),
						Layer.effect(AwsIngestService, AwsIngestService.make),
					),
				),
			),
		),
		Layer.provide(warehouse.layer),
		Layer.provide(V2TransportErrorBoundaryLive),
		Layer.provideMerge(ApiAuthorizationV2Live),
		Layer.provideMerge(Layer.succeed(AuditLogService, auditLog)),
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

	/** The org's audit entries for one action, as the ids of the resources they name. */
	const audited = (action: string) =>
		Effect.runPromise(auditLog.list(ORG, { action, limit: 50, offset: 0 })).then((entries) =>
			Arr.map(entries, (entry) => ({
				resourceId: entry.resourceId,
				metadata: entry.metadata,
				outcome: entry.outcome,
				apiKeyId: entry.apiKeyId,
			})),
		)

	return {
		request,
		audited,
		warehouseSql: warehouse.asked,
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
			oidc_issuer: "https://api.maple.test/oidc/aws",
			oidc_subject: expect.stringMatching(/^aws-connection:[0-9a-f-]{36}$/),
			modules: [],
			granted_modules: null,
			template_version: null,
			setup_outdated: false,
			verified_at: null,
			last_checked_at: null,
			last_check_error: null,
			metric_stream: null,
			metric_stream_changed_at: null,
			metrics_last_received_at: null,
			metrics_last_error: null,
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
		// The template names the role the connection reports, and trusts only its subject's tokens.
		const template = JSON.parse(setup.body.cloudformation_template)
		const role = template.Resources.MapleRole.Properties
		expect(created.body.role_arn.endsWith(`/${role.RoleName}`)).toBe(true)
		expect(role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals).toEqual({
			"api.maple.test/oidc/aws:aud": "sts.amazonaws.com",
			"api.maple.test/oidc/aws:sub": created.body.oidc_subject,
		})
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
			"audit",
		])
		expect((await harness.request("GET", `${CONNECTIONS}/${id}/setup`, member.secret)).status).toBe(403)
		expect((await harness.request("DELETE", `${CONNECTIONS}/${id}`, member.secret)).status).toBe(403)
		// A setup holds the stream's access key, so a key that only reads integrations cannot render one.
		const reader = await harness.adminKey(["integrations:read"])
		const refused = await harness.request("GET", `${CONNECTIONS}/${id}/setup`, reader.secret)
		expect([refused.status, refused.body.error.code]).toEqual([403, "insufficient_scope"])
		expect(refused.body.error.message).toContain('"integrations:write"')
		// Each refusal is recorded against the key that tried: the scope refusal at the gate, and the
		// member's two inside the handler, which name the permission it lacked.
		const denied = await harness.audited("api.request")
		expect(Arr.map(denied, (entry) => [entry.outcome, entry.apiKeyId, entry.metadata])).toEqual(
			expect.arrayContaining([
				["denied", reader.id, { method: "GET", path: `${CONNECTIONS}/${id}/setup` }],
				[
					"denied",
					member.id,
					{ method: "GET", path: `${CONNECTIONS}/${id}/setup`, permission: "integrations:manage" },
				],
				[
					"denied",
					member.id,
					{ method: "DELETE", path: `${CONNECTIONS}/${id}`, permission: "integrations:manage" },
				],
			]),
		)
		expect(denied).toHaveLength(3)
		const writer = await harness.adminKey(["integrations:write"])
		expect((await harness.request("GET", `${CONNECTIONS}/${id}/setup`, writer.secret)).status).toBe(200)

		const deleted = await harness.request("DELETE", `${CONNECTIONS}/${id}`, admin.secret)
		expect(deleted.status).toBe(200)
		expect(deleted.body).toMatchObject({ id, object: "aws_connection", deleted: true })
		expect(deleted.body.cleanup_script).toContain(
			`delete-stack --region us-east-1 --stack-name ${setup.body.stack_name}`,
		)
		expect((await harness.request("GET", BASE, admin.secret)).body.connections).toEqual([])
		await harness.dispose()
	})

	it("rotates the events key for admins with the write scope, and records who read or rotated it", async () => {
		const harness = makeHarness({ awsAvailable: true, rolledOut: true })
		const admin = await harness.adminKey()
		const member = await harness.memberKey()
		const reader = await harness.adminKey(["integrations:read"])
		const created = await harness.request("POST", CONNECTIONS, admin.secret, {
			account_id: "123456789012",
			modules: ["security"],
		})
		const path = `${CONNECTIONS}/${created.body.id}`
		const eventsKey = async () => {
			const setup = await harness.request("GET", `${path}/setup`, admin.secret)
			return /"EventsKey=(maple_awsev_[\w-]+)"/u.exec(setup.body.setup_script)?.[1]
		}

		const before = await eventsKey()
		expect(before).toBeDefined()
		expect((await harness.request("POST", `${path}/events_key/rotate`, member.secret)).status).toBe(403)
		const unscoped = await harness.request("POST", `${path}/events_key/rotate`, reader.secret)
		expect(unscoped.status).toBe(403)
		expect(await eventsKey()).toBe(before)

		const rotated = await harness.request("POST", `${path}/events_key/rotate`, admin.secret)
		expect(rotated.status).toBe(200)
		expect(rotated.body).toMatchObject({ id: created.body.id, object: "aws_connection" })
		const after = await eventsKey()
		expect(after).toBeDefined()
		expect(after).not.toBe(before)
		// The answer names the connection and nothing of the key.
		expect(JSON.stringify(rotated.body)).not.toContain("maple_awsev_")

		// Three setups handed a key out and one rotation replaced it; no entry holds a key.
		const reads = await harness.audited("aws_connection.events_key_read")
		const rotations = await harness.audited("aws_connection.events_key_rotated")
		expect(Arr.map(reads, (entry) => entry.resourceId)).toEqual([
			created.body.id,
			created.body.id,
			created.body.id,
		])
		expect(Arr.map(rotations, (entry) => entry.resourceId)).toEqual([created.body.id])
		expect(JSON.stringify([reads, rotations])).not.toContain("maple_awsev_")

		const gone = `${CONNECTIONS}/awsc_YofPTrK9782DWwcnXhpcCw/events_key/rotate`
		expect((await harness.request("POST", gone, admin.secret)).status).toBe(404)
		await harness.dispose()
	})

	it("records a key read only for a setup that carries one", async () => {
		const harness = makeHarness()
		const admin = await harness.adminKey()
		const created = await harness.request("POST", CONNECTIONS, admin.secret, {
			account_id: "123456789012",
			modules: ["cost"],
		})
		const setup = await harness.request("GET", `${CONNECTIONS}/${created.body.id}/setup`, admin.secret)
		expect(setup.status).toBe(200)
		expect(JSON.stringify(setup.body)).not.toMatch(/maple_aws(ev)?_/u)
		expect(await harness.audited("aws_connection.events_key_read")).toEqual([])
		expect(await harness.audited("aws_connection.stream_key_read")).toEqual([])
		await harness.dispose()
	})

	it("records one entry per key for a setup that carries both, without either key", async () => {
		const harness = makeHarness({ awsAvailable: true, rolledOut: true })
		const admin = await harness.adminKey()
		const created = await harness.request("POST", CONNECTIONS, admin.secret, {
			account_id: "123456789012",
			modules: ["security"],
			metric_stream: { regions: ["us-east-1"], namespaces: ["AWS/ECS"] },
		})
		expect(created.status).toBe(200)
		const setup = await harness.request("GET", `${CONNECTIONS}/${created.body.id}/setup`, admin.secret)
		expect(setup.status).toBe(200)
		const rendered = JSON.stringify(setup.body)
		expect(rendered).toMatch(/maple_aws_[\w-]+/u)
		expect(rendered).toMatch(/maple_awsev_[\w-]+/u)

		const reads = [
			...(await harness.audited("aws_connection.stream_key_read")),
			...(await harness.audited("aws_connection.events_key_read")),
		]
		expect(Arr.map(reads, (entry) => entry.resourceId)).toEqual([created.body.id, created.body.id])
		expect(JSON.stringify(reads)).not.toMatch(/maple_aws(ev)?_/u)
		await harness.dispose()
	})

	it("records a setup read that carries the stream access key, without the key", async () => {
		const harness = makeHarness()
		const admin = await harness.adminKey()
		const member = await harness.memberKey()
		const created = await harness.request("POST", CONNECTIONS, admin.secret, {
			account_id: "123456789012",
			metric_stream: { regions: ["us-east-1"], namespaces: ["AWS/ECS"] },
		})
		expect(created.status).toBe(200)
		const path = `${CONNECTIONS}/${created.body.id}/setup`
		const setup = await harness.request("GET", path, admin.secret)
		expect(setup.status).toBe(200)
		expect(JSON.stringify(setup.body)).toMatch(/maple_aws_[\w-]+/u)
		// A refused read hands nothing out, so it leaves no entry.
		expect((await harness.request("GET", path, member.secret)).status).toBe(403)

		const reads = await harness.audited("aws_connection.stream_key_read")
		expect(Arr.map(reads, (entry) => entry.resourceId)).toEqual([created.body.id])
		expect(JSON.stringify(reads)).not.toContain("maple_aws_")
		expect(await harness.audited("aws_connection.events_key_read")).toEqual([])
		await harness.dispose()
	})

	it("offers and accepts the cost and audit modules for every org", async () => {
		const harness = makeHarness()
		const admin = await harness.adminKey()
		const availability = (body: { modules: ReadonlyArray<{ module: string; available: boolean }> }) =>
			Arr.map(
				Arr.filter(body.modules, (module) => module.available),
				(module) => module.module,
			)

		expect(availability((await harness.request("GET", BASE, admin.secret)).body)).toEqual([
			"cost",
			"audit",
		])
		// Each module, on its own account, survives create, clear and restore, and its role policy
		// carries the reads it makes.
		const lifecycles = [
			{ module: "cost", account: "123456789012", reads: ["ce:GetCostAndUsage"] },
			{
				module: "audit",
				account: "210987654321",
				reads: ["cloudtrail:LookupEvents", "account:ListRegions"],
			},
		]
		for (const { module, account, reads } of lifecycles) {
			const created = await harness.request("POST", CONNECTIONS, admin.secret, {
				account_id: account,
				modules: [module],
			})
			expect(created.status).toBe(200)
			expect(created.body.modules).toEqual([module])
			const setup = await harness.request(
				"GET",
				`${CONNECTIONS}/${created.body.id}/setup`,
				admin.secret,
			)
			for (const read of reads) expect(setup.body.cloudformation_template).toContain(read)

			const path = `${CONNECTIONS}/${created.body.id}`
			const cleared = await harness.request("PATCH", path, admin.secret, { modules: [] })
			expect(cleared.body.modules).toEqual([])
			const restored = await harness.request("PATCH", path, admin.secret, { modules: [module] })
			expect(restored.status).toBe(200)
			expect(restored.body.modules).toEqual([module])
		}
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
			modules: ["inventory"],
		})
		expect(planned.status).toBe(400)
		const elsewhere = await harness.request("POST", CONNECTIONS, admin.secret, {
			account_id: "123456789012",
			metric_stream: { regions: ["mars-north-1a"], namespaces: ["AWS/ECS"] },
		})
		expect(elsewhere.status).toBe(400)
		const nothing = await harness.request("POST", CONNECTIONS, admin.secret, {
			account_id: "123456789012",
			metric_stream: { regions: ["us-east-1"], namespaces: [] },
		})
		expect(nothing.status).toBe(400)
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
		expect((await harness.request("PATCH", path, admin.secret, { modules: ["inventory"] })).status).toBe(
			400,
		)
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

	it("shows any member what a connection's stream stored, and only for its own org", async () => {
		const harness = makeHarness({
			awsAvailable: true,
			warehouseRows: [
				{
					namespace: "AWS/ECS",
					region: "us-east-1",
					metrics: "12",
					dataPoints: "3600",
					resources: "4",
					sampleResources: ["api", "checkout", "web", "worker"],
					lastPointAt: "2026-10-23 09:58:00.000000000",
				},
				{
					namespace: "AWS/SQS",
					region: "",
					metrics: "3",
					dataPoints: "180",
					resources: "1",
					sampleResources: ["orders"],
					lastPointAt: "2026-10-23 09:59:00.000000000",
				},
			],
		})
		const admin = await harness.adminKey()
		const member = await harness.memberKey()
		const outsider = await harness.adminKey(undefined, OTHER_ORG)
		const created = await harness.request("POST", CONNECTIONS, admin.secret, {
			account_id: "123456789012",
		})
		const path = `${CONNECTIONS}/${created.body.id}/ingest`

		const ingest = await harness.request("GET", path, member.secret)
		expect(ingest.status).toBe(200)
		expect(ingest.body).toEqual({
			object: "aws_connection.ingest",
			window_start: expect.stringMatching(/Z$/),
			window_end: expect.stringMatching(/Z$/),
			data_points: 3780,
			last_point_at: "2026-10-23T09:59:00.000Z",
			groups: [
				{
					namespace: "AWS/ECS",
					region: "us-east-1",
					metrics: 12,
					data_points: 3600,
					resources: 4,
					sample_resources: ["api", "checkout", "web", "worker"],
					last_point_at: "2026-10-23T09:58:00.000Z",
				},
				{
					namespace: "AWS/SQS",
					region: null,
					metrics: 3,
					data_points: 180,
					resources: 1,
					sample_resources: ["orders"],
					last_point_at: "2026-10-23T09:59:00.000Z",
				},
			],
		})
		const [sql] = harness.warehouseSql
		expect(sql).toContain("OrgId = 'org_aws_e2e'")
		expect(sql).toMatch(/\['maple_aws_connection_id'\] = '[0-9a-f-]{36}'/)

		// Another org's admin learns nothing, not even that it exists, and the warehouse is not asked.
		expect((await harness.request("GET", path, outsider.secret)).status).toBe(404)
		expect(harness.warehouseSql).toHaveLength(1)
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
