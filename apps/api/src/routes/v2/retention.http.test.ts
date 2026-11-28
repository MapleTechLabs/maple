import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { OrgId, UserId } from "@maple/domain/http"
import { encodePublicId, MapleApiV2, PublicIdPrefixes } from "@maple/domain/http/v2"
import * as Policy from "@maple/domain/policy"
import {
	cleanupTestDbs,
	createTestDb,
	insertTestSource,
	testEdgeCache,
	TestReadHorizonMemoLive,
	type TestDb,
} from "@maple/backend/testing/test-pglite"
import { Env } from "@maple/backend/platform/Env"
import { ApiAuthorizationV2Live } from "@maple/backend/services/auth/ApiAuthorizationV2Live"
import { AuditLogService, makeMemoryAuditLog } from "@maple/backend/services/audit/AuditLogService"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { RetentionService } from "@maple/backend/services/retention/RetentionService"
import { OrgClickHouseSettingsService } from "@maple/backend/services/org/OrgClickHouseSettingsService"
import { V2TransportErrorBoundaryLive } from "./error-envelope"
import { ApiV2RateLimiterAllowAllLayer, Phase1ResourceStubsLayer } from "./v2-test-support"
import { HttpV2RetentionLive } from "./retention.http"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

/** The deployment's own ClickHouse, when it has one. */
const SELF_MANAGED_CLICKHOUSE = {
	CLICKHOUSE_URL: "https://clickhouse.internal:8443",
	CLICKHOUSE_PROVIDER: "clickhouse",
}

const testConfig = (selfManaged: boolean) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			...(selfManaged ? SELF_MANAGED_CLICKHOUSE : undefined),
			PORT: "3482",
			MCP_PORT: "3483",
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

const ORG = Schema.decodeSync(OrgId)("org_retention_e2e")
const USER = Schema.decodeSync(UserId)("user_retention_e2e")

/** Where the org stores telemetry, as the warehouse settings would answer. */
const warehouseOf = (ownWarehouse: boolean) =>
	Layer.mock(OrgClickHouseSettingsService)({
		resolveRuntimeConfig: () =>
			Effect.succeed(
				ownWarehouse
					? Option.some({
							backend: "clickhouse" as const,
							url: "https://ch.example",
							user: "u",
							password: "p",
							database: "d",
						})
					: Option.none(),
			),
	})

const makeHarness = (ownWarehouse = false, selfManaged = false) => {
	const testDb = createTestDb(createdDbs)
	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		RetentionService.layer.pipe(
			Layer.provide(Layer.mergeAll(testEdgeCache(testDb), TestReadHorizonMemoLive)),
		),
	).pipe(
		Layer.provideMerge(
			Layer.mergeAll(Env.layer.pipe(Layer.provide(testConfig(selfManaged))), testDb.layer),
		),
	)

	// The audit actions the routes record, in order.
	const recorded: Array<string> = []
	const memoryAudit = makeMemoryAuditLog()
	const audit = Layer.succeed(AuditLogService, {
		...memoryAudit,
		record: (input) =>
			Effect.andThen(
				Effect.sync(() => recorded.push(input.action)),
				memoryAudit.record(input),
			),
	})
	const routes = HttpApiBuilder.layer(HttpApi.make("MapleApiV2").add(MapleApiV2.groups.retention)).pipe(
		Layer.provide(HttpV2RetentionLive.pipe(Layer.provide(warehouseOf(ownWarehouse)))),
		Layer.provide(V2TransportErrorBoundaryLive),
		Layer.provide(Phase1ResourceStubsLayer),
		Layer.provideMerge(ApiAuthorizationV2Live),
		Layer.provideMerge(audit),
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
				body: body !== undefined ? JSON.stringify(body) : undefined,
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null }
	}

	const key = (metadataJson?: Record<string, unknown>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				const created = yield* service.create(ORG, USER, { name: "retention-test", metadataJson })
				return created.secret
			}),
		)

	const auditActions = () => [...recorded]

	return {
		request,
		key,
		auditActions,
		source: (orgId: OrgId = ORG) => insertTestSource(testDb, { orgId, platform: "nodejs" }),
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

describe("v2 retention", () => {
	it("starts at the defaults, with every period offered", async () => {
		const harness = makeHarness()
		const token = await harness.key()
		const { status, body } = await harness.request("GET", "/v2/retention", token)
		expect(status).toBe(200)
		expect(body.periods).toEqual([3, 7, 14, 30, 60, 90, 180, 365, 730])
		expect(body.organization.set.logs).toBeNull()
		expect(body.organization.days).toEqual(body.defaults)
		expect(body.sources).toEqual([])
		await harness.dispose()
	})

	it("PATCH sets a period, keeps what it omits, and null goes back to the default", async () => {
		const harness = makeHarness()
		const token = await harness.key()
		await harness.request("PATCH", "/v2/retention", token, { logs: 90, traces: 7 })
		const kept = await harness.request("PATCH", "/v2/retention", token, { traces: null })
		expect(kept.status).toBe(200)
		expect(kept.body.organization.set).toMatchObject({ logs: 90, traces: null })
		expect(kept.body.organization.days).toMatchObject({ logs: 90, traces: 30 })
		expect(harness.auditActions()).toEqual(["retention.updated", "retention.updated"])
		await harness.dispose()
	})

	it("a source keeps longer than its organization, and reads reach it", async () => {
		const harness = makeHarness()
		const token = await harness.key()
		const sourceId = encodePublicId(PublicIdPrefixes.source, await harness.source())
		await harness.request("PATCH", "/v2/retention", token, { logs: 7 })
		const { status, body } = await harness.request("PATCH", `/v2/retention/sources/${sourceId}`, token, {
			logs: 180,
		})
		expect(status).toBe(200)
		expect(body.organization.days.logs).toBe(7)
		expect(body.read_horizon_days.logs).toBe(180)
		expect(body.sources).toEqual([
			expect.objectContaining({ source_id: sourceId, days: expect.objectContaining({ logs: 180 }) }),
		])
		await harness.dispose()
	})

	it("refuses a period that is not offered, and saves nothing", async () => {
		const harness = makeHarness()
		const token = await harness.key()
		const refused = await harness.request("PATCH", "/v2/retention", token, { logs: 45 })
		expect(refused.status).toBe(400)
		const replays = await harness.request("PATCH", "/v2/retention", token, { sessions: 90 })
		expect(replays.status).toBe(400)
		const after = await harness.request("GET", "/v2/retention", token)
		expect(after.body.organization.set.logs).toBeNull()
		expect(harness.auditActions()).toEqual([])
		await harness.dispose()
	})

	it("a member can read retention but not change it", async () => {
		const harness = makeHarness()
		const member = await harness.key({ source: "maple_cli", roles: ["org:member"], deviceName: "laptop" })
		expect((await harness.request("GET", "/v2/retention", member)).status).toBe(200)
		const refused = await harness.request("PATCH", "/v2/retention", member, { logs: 90 })
		expect(refused.status).toBe(403)
		await harness.dispose()
	})

	it("a role limited to namespaces reads retention, and one without a telemetry read does not", async () => {
		const harness = makeHarness()
		const keyWith = (permissions: Policy.Grants) =>
			harness.key({
				source: "maple_cli",
				roles: [Policy.CUSTOM_ROLE_CLERK_KEY],
				permissions: [...Policy.encodePermissions(permissions)],
				deviceName: "laptop",
			})
		const scoped = await keyWith([Policy.SCOPED_READ])
		expect((await harness.request("GET", "/v2/retention", scoped)).status).toBe(200)
		const billingOnly = await keyWith(["billing:manage"])
		expect((await harness.request("GET", "/v2/retention", billingOnly)).status).toBe(403)
		await harness.dispose()
	})

	it("a PATCH that changes nothing is not audited, and a period back at the default reads to the default", async () => {
		const harness = makeHarness()
		const token = await harness.key()
		await harness.request("PATCH", "/v2/retention", token, { logs: 90 })
		const same = await harness.request("PATCH", "/v2/retention", token, { logs: 90 })
		expect(same.status).toBe(200)
		expect(harness.auditActions()).toEqual(["retention.updated"])
		const back = await harness.request("PATCH", "/v2/retention", token, { logs: null })
		// Back at the default, reads of logs reach 30 days, not the 90 kept before.
		expect(back.body.read_horizon_days).toEqual(back.body.defaults)
		await harness.dispose()
	})

	it("a source of another organization is not found, and is left as it was", async () => {
		const harness = makeHarness()
		const token = await harness.key()
		const theirs = encodePublicId(
			PublicIdPrefixes.source,
			await harness.source(Schema.decodeSync(OrgId)("org_retention_e2e_other")),
		)
		const { status } = await harness.request("PATCH", `/v2/retention/sources/${theirs}`, token, {
			logs: 90,
		})
		expect(status).toBe(404)
		expect(harness.auditActions()).toEqual([])
		await harness.dispose()
	})

	it("an org on its own ClickHouse reads its storage and cannot set Maple's periods", async () => {
		const harness = makeHarness(true)
		const token = await harness.key()
		const read = await harness.request("GET", "/v2/retention", token)
		expect(read.body.storage).toBe("own_warehouse")
		const refused = await harness.request("PATCH", "/v2/retention", token, { logs: 90 })
		expect([refused.status, refused.body.error.code]).toEqual([409, "retention_own_warehouse"])
		expect(harness.auditActions()).toEqual([])
		await harness.dispose()
	})

	it("a deployment on its own ClickHouse cannot set Maple's periods either", async () => {
		const harness = makeHarness(false, true)
		const token = await harness.key()
		const read = await harness.request("GET", "/v2/retention", token)
		expect(read.body.storage).toBe("own_warehouse")
		expect((await harness.request("PATCH", "/v2/retention", token, { logs: 90 })).status).toBe(409)
		await harness.dispose()
	})
})
