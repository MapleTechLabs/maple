import { afterEach, describe, expect, it } from "vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import type { CatalogEntry, ClickHouseDataSourceConfig } from "@maple/domain/data-sources"
import {
	DataSourceConnectionError,
	DataSourceRateLimitedError,
	DataSourceValidationError,
} from "@maple/domain/data-sources"
import { OrgId, UserId } from "@maple/domain/http"
import { encodePublicId, MapleApiV2, PublicIdPrefixes } from "@maple/domain/http/v2"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { ApiAuthorizationV2Live } from "@maple/backend/services/auth/ApiAuthorizationV2Live"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { AuditLogService, makeMemoryAuditLog } from "@maple/backend/services/audit/AuditLogService"
import {
	DataSourceCallBudget,
	DataSourceDrivers,
} from "@maple/backend/services/data-sources/DataSourceDrivers"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import {
	DISABLED_ORGANIZATION_FEATURE_FLAGS,
	ENABLED_ORGANIZATION_FEATURE_FLAGS,
} from "@maple/domain/organization-feature-flags"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { SharedDashboardService } from "@maple/backend/services/dashboards/SharedDashboardService"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { V2TransportErrorBoundaryLive } from "./error-envelope"
import { ApiV2RateLimiterAllowAllLayer } from "./v2-test-support"
import { HttpV2DataSourcesLive } from "./data-sources.http"
import { ExternalDataSourceService } from "@maple/backend/services/data-sources/ExternalDataSourceService"

// `/v2/data_sources` over PGlite with the real service and a fake ClickHouse driver.

const ORG = Schema.decodeSync(OrgId)("org_data_sources")
const USER = Schema.decodeSync(UserId)("user_data_sources")

type Driver = Parameters<typeof DataSourceDrivers.fromList>[0][number]

/** What the fake source answers; tests flip these between requests. */
interface FakeSource {
	testFails: boolean
	/** The catalog read fails with this connection reason. */
	catalogFails: "config" | "refused" | "rate_limited" | null
	entries: ReadonlyArray<CatalogEntry>
}

const makeSource = (): FakeSource => ({
	testFails: false,
	catalogFails: null,
	entries: [
		{
			name: "shop.payments",
			kind: "table",
			timeField: "created_at",
			fields: [
				{ name: "created_at", type: "timestamp", nativeType: "DateTime64(3)" },
				{ name: "paid_at", type: "timestamp" },
				{ name: "status", type: "string", sampleValues: ["paid", "refunded", "failed"] },
				{ name: "email", type: "string", pii: true },
			],
		},
		{ name: "shop.orders", kind: "table", fields: [{ name: "id", type: "string" }] },
	],
})

const fakeClickHouse = (source: FakeSource): Driver => ({
	kind: "clickhouse",
	queryLanguage: "sql:clickhouse",
	validateConnection: (input, previous) =>
		input._tag !== "clickhouse"
			? Effect.fail(new DataSourceValidationError({ message: "Not a ClickHouse connection" }))
			: Effect.succeed({
					config: {
						_tag: "clickhouse",
						url: input.url,
						user: input.user,
						database: input.database,
					} satisfies ClickHouseDataSourceConfig,
					secret: input.password ?? (previous === null ? "" : null),
				}),
	test: () =>
		source.testFails
			? Effect.fail(new DataSourceConnectionError({ message: "connection refused", reason: "refused" }))
			: Effect.succeed({ warnings: ["This user can write"] }),
	catalog: () =>
		source.catalogFails === null
			? Effect.succeed({ entries: source.entries, examples: [], truncated: false })
			: source.catalogFails === "rate_limited"
				? Effect.fail(new DataSourceRateLimitedError({ message: "Slow down", retryAfterSeconds: 0 }))
				: Effect.fail(
						new DataSourceConnectionError({
							message: "bad stored url",
							reason: source.catalogFails,
						}),
					),
	prepare: () => Effect.die("queries are not exercised over HTTP"),
})

const testConfig = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		PORT: "3478",
		MCP_PORT: "3479",
		TINYBIRD_HOST: "https://api.tinybird.co",
		TINYBIRD_TOKEN: "test-token",
		MAPLE_AUTH_MODE: "self_hosted",
		MAPLE_ROOT_PASSWORD: "test-root-password",
		MAPLE_DEFAULT_ORG_ID: "default",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		MAPLE_INGEST_PUBLIC_URL: "https://ingest.test",
		INTERNAL_SERVICE_TOKEN: "test-internal-token",
	}),
)

const makeHarness = (
	createdDbs: Array<TestDb>,
	source: FakeSource,
	flags = ENABLED_ORGANIZATION_FEATURE_FLAGS,
) => {
	const testDb = createTestDb(createdDbs)
	const audit = makeMemoryAuditLog()
	const auditLive = Layer.succeed(AuditLogService, audit)
	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		DashboardPersistenceService.layer,
		SharedDashboardService.layer,
	).pipe(Layer.provideMerge(Layer.mergeAll(Env.layer.pipe(Layer.provide(testConfig)), testDb.layer)))

	// Only ClickHouse is served, so Clerk sources take the path a driver-less deploy has.
	const routes = HttpApiBuilder.layer(HttpApi.make("MapleApiV2").add(MapleApiV2.groups.dataSources)).pipe(
		Layer.provide(
			HttpV2DataSourcesLive.pipe(
				Layer.provide(
					ExternalDataSourceService.layer.pipe(
						Layer.provide(
							Layer.merge(
								DataSourceDrivers.fromList([fakeClickHouse(source)]),
								DataSourceCallBudget.unlimited,
							),
						),
					),
				),
				Layer.provide(OrganizationFeatureFlagsService.fixed(flags)),
			),
		),
		Layer.provide(V2TransportErrorBoundaryLive),
		Layer.provideMerge(ApiAuthorizationV2Live),
		Layer.provideMerge(auditLive),
		Layer.provideMerge(ApiV2RateLimiterAllowAllLayer),
		Layer.provideMerge(servicesLive),
	)
	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const runtime = ManagedRuntime.make(servicesLive)

	const key = (roles?: ReadonlyArray<string>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				const created = yield* service.create(ORG, USER, {
					name: roles === undefined ? "admin" : "member",
					...(roles === undefined
						? undefined
						: { metadataJson: { source: "maple_cli", roles, deviceName: "laptop" } }),
				})
				return created.secret
			}),
		)

	const request = async (method: string, path: string, token: string, body?: unknown) => {
		const response = await handler(
			new Request(`http://maple.test${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					...(body === undefined ? undefined : { "content-type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, text, body: text.length === 0 ? null : JSON.parse(text) }
	}

	return {
		request,
		adminKey: () => key(),
		memberKey: () => key(["org:member"]),
		auditEntries: (action: string) =>
			Effect.runPromise(audit.list(ORG, { action, limit: 100, offset: 0 })),
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const BASE = "/v2/data_sources"
const PASSWORD = "ch-password-very-secret-9f2c"
const ROTATED = "ch-password-rotated-77ab"

const shopProd = {
	name: "shop-prod",
	description: "Production storefront database: orders and payments",
	environment: "production",
	tags: ["shop"],
	connection: {
		type: "clickhouse",
		url: "https://ch.example.com:8443",
		user: "reader",
		database: "shop",
		password: PASSWORD,
	},
}

describe("v2 data sources over HTTP", () => {
	it("refuses every call from an org outside the dataSources rollout", async () => {
		const harness = makeHarness(createdDbs, makeSource(), DISABLED_ORGANIZATION_FEATURE_FLAGS)
		const admin = await harness.adminKey()
		const one = `${BASE}/${encodePublicId(PublicIdPrefixes.dataSource, "018f2b3c-4d5e-6f70-8192-a3b4c5d6e7f8")}`
		for (const [method, path, body] of [
			["GET", BASE, undefined],
			["POST", BASE, shopProd],
			["GET", one, undefined],
			["PATCH", one, { name: "renamed" }],
			["DELETE", one, undefined],
			["POST", `${one}/test`, undefined],
			["POST", `${one}/catalog/refresh`, undefined],
			["GET", `${one}/catalog`, undefined],
			["PATCH", `${one}/catalog/entries/shop.payments`, { note: "x" }],
		] as const) {
			const response = await harness.request(method, path, admin, body)
			expect(response.status).toBe(403)
			expect(response.body.error.code).toBe("data_sources_disabled")
		}
		await harness.dispose()
	})

	it("lets members read and only admins connect, and never returns the secret", async () => {
		const harness = makeHarness(createdDbs, makeSource())
		const [admin, member] = [await harness.adminKey(), await harness.memberKey()]

		expect((await harness.request("GET", BASE, member)).body).toMatchObject({ object: "list", data: [] })

		const denied = await harness.request("POST", BASE, member, shopProd)
		expect(denied.status).toBe(403)
		expect(denied.body.error.code).toBe("insufficient_permissions")

		const created = await harness.request("POST", BASE, admin, shopProd)
		expect(created.status).toBe(200)
		expect(created.body).toMatchObject({
			id: expect.stringMatching(/^dsrc_/),
			object: "data_source",
			name: "shop-prod",
			kind: "clickhouse",
			environment: "production",
			agent_access: true,
			agent_pii: false,
			connection: {
				type: "clickhouse",
				url: "https://ch.example.com:8443",
				user: "reader",
				database: "shop",
			},
			secret_hint: "9f2c",
			status: "ok",
			catalog_entry_count: 2,
			catalog_error: null,
			warnings: ["This user can write"],
		})

		const path = `${BASE}/${created.body.id}`
		const reads = [
			created,
			await harness.request("GET", BASE, member),
			await harness.request("GET", path, member),
			await harness.request("GET", `${path}/catalog`, member),
			await harness.request("PATCH", path, admin, { description: "Orders, payments, refunds" }),
		]
		for (const response of reads) expect(response.text).not.toContain(PASSWORD)
		// Only a changed connection is tested again, so only it carries the test's warnings.
		expect(reads[4]?.body.warnings).toEqual([])
		const reconnected = await harness.request("PATCH", path, admin, {
			connection: { ...shopProd.connection, password: "n3w" },
		})
		expect(reconnected.body.warnings).toEqual(["This user can write"])

		for (const [method, suffix, body] of [
			["PATCH", "", { description: "x" }],
			["DELETE", "", undefined],
			["POST", "/test", undefined],
			["POST", "/catalog/refresh", undefined],
			["PATCH", "/catalog/entries/shop.orders", { exposed: false }],
		] as const) {
			expect((await harness.request(method, `${path}${suffix}`, member, body)).status).toBe(403)
		}
		await harness.dispose()
	})

	it("names the bad field and shows the source's own error", async () => {
		const source = makeSource()
		const harness = makeHarness(createdDbs, source)
		const admin = await harness.adminKey()

		const noDescription = await harness.request("POST", BASE, admin, { ...shopProd, description: "" })
		expect(noDescription.status).toBe(400)
		expect(noDescription.body.error.param).toContain("description")

		const badSlug = await harness.request("POST", BASE, admin, { ...shopProd, name: "Shop Prod" })
		expect(badSlug.status).toBe(400)
		expect(badSlug.body.error.param).toContain("name")

		source.testFails = true
		const refused = await harness.request("POST", BASE, admin, shopProd)
		expect(refused.status).toBe(400)
		expect(refused.body.error).toMatchObject({
			param: "connection",
			message: "Could not connect: connection refused",
		})
		expect((await harness.request("GET", BASE, admin)).body.data).toEqual([])

		const noDriver = await harness.request("POST", BASE, admin, {
			...shopProd,
			name: "clerk-prod",
			connection: { type: "clerk", secret_key: "sk_live_abc" },
		})
		expect(noDriver.status).toBe(400)
		expect(noDriver.body.error.message).toBe("This deployment cannot query clerk sources")

		source.testFails = false
		await harness.request("POST", BASE, admin, shopProd)
		const duplicate = await harness.request("POST", BASE, admin, shopProd)
		expect(duplicate.body.error).toMatchObject({ code: "data_source_invalid", param: "name" })

		// A wrong stored config is a request to fix, not a source that did not answer.
		const stored = (await harness.request("GET", BASE, admin)).body.data[0]
		source.catalogFails = "config"
		const misconfigured = await harness.request("POST", `${BASE}/${stored.id}/catalog/refresh`, admin)
		expect(misconfigured.status).toBe(400)
		expect(misconfigured.body.error).toMatchObject({
			code: "data_source_invalid",
			param: "connection",
			recovery: "fix_request",
		})
		source.catalogFails = "refused"
		const refusedRefresh = await harness.request("POST", `${BASE}/${stored.id}/catalog/refresh`, admin)
		expect(refusedRefresh.status).toBe(422)
		expect(refusedRefresh.body.error).toMatchObject({
			code: "data_source_unreachable",
			recovery: "reconnect",
		})
		// `Retry-After: 0` from the source still answers a 429 with a wait of at least a second.
		source.catalogFails = "rate_limited"
		const limited = await harness.request("POST", `${BASE}/${stored.id}/catalog/refresh`, admin)
		expect(limited.status).toBe(429)
		expect(limited.body.error).toMatchObject({ retry_after_seconds: 1 })
		await harness.dispose()
	})

	it("tests, records secret rotation without the value, and deletes", async () => {
		const source = makeSource()
		const harness = makeHarness(createdDbs, source)
		const admin = await harness.adminKey()
		const path = `${BASE}/${(await harness.request("POST", BASE, admin, shopProd)).body.id}`

		const ok = await harness.request("POST", `${path}/test`, admin)
		expect(ok.body).toMatchObject({
			object: "data_source_test",
			ok: true,
			warnings: ["This user can write"],
			error: null,
		})
		source.testFails = true
		const failed = await harness.request("POST", `${path}/test`, admin)
		expect(failed.body).toMatchObject({ ok: false, error: "connection refused" })
		expect((await harness.request("GET", path, admin)).body).toMatchObject({
			status: "error",
			last_error: "connection refused",
		})

		source.testFails = false
		const connection = { ...shopProd.connection, password: ROTATED }
		const rotated = await harness.request("PATCH", path, admin, { connection })
		expect(rotated.body.secret_hint).toBe("77ab")
		const [entry] = await harness.auditEntries("data_source.updated")
		expect(entry?.metadata).toMatchObject({ secret_changed: true })
		expect(JSON.stringify(entry)).not.toContain(ROTATED)

		expect((await harness.request("DELETE", path, admin)).body).toMatchObject({
			object: "data_source",
			deleted: true,
		})
		expect((await harness.request("GET", path, admin)).status).toBe(404)
		expect(await harness.auditEntries("data_source.deleted")).toHaveLength(1)
		await harness.dispose()
	})

	it("keeps catalog curation across a refresh", async () => {
		const source = makeSource()
		const harness = makeHarness(createdDbs, source)
		const admin = await harness.adminKey()
		const path = `${BASE}/${(await harness.request("POST", BASE, admin, shopProd)).body.id}`

		const curated = await harness.request("PATCH", `${path}/catalog/entries/shop.payments`, admin, {
			exposed: false,
			note: "Amounts in cents",
			time_field: "paid_at",
			field_notes: { email: "Customer email" },
		})
		expect(curated.status).toBe(200)
		expect(curated.body).toMatchObject({
			name: "shop.payments",
			exposed: false,
			note: "Amounts in cents",
			time_field: "paid_at",
		})

		await harness.request("POST", `${path}/catalog/refresh`, admin)
		const catalog = await harness.request("GET", `${path}/catalog`, admin)
		const payments = catalog.body.entries.find(
			(entry: { name: string }) => entry.name === "shop.payments",
		)
		expect(payments).toMatchObject({ exposed: false, note: "Amounts in cents", time_field: "paid_at" })
		expect(payments.fields).toContainEqual({
			name: "email",
			type: "string",
			native_type: null,
			note: "Customer email",
			pii: true,
			sample_values: [],
		})
		expect(payments.fields).toContainEqual(
			expect.objectContaining({ name: "status", sample_values: ["paid", "refunded", "failed"] }),
		)

		// "" clears to none, hiding what the source reported; null goes back to it.
		const cleared = await harness.request("PATCH", `${path}/catalog/entries/shop.payments`, admin, {
			note: "",
			time_field: "",
		})
		expect(cleared.body).toMatchObject({
			note: null,
			time_field: null,
			detected_time_field: "created_at",
		})
		const restored = await harness.request("PATCH", `${path}/catalog/entries/shop.payments`, admin, {
			time_field: null,
		})
		expect(restored.body).toMatchObject({ time_field: "created_at", detected_time_field: "created_at" })

		const missing = await harness.request("PATCH", `${path}/catalog/entries/shop.refunds`, admin, {
			exposed: false,
		})
		expect(missing.status).toBe(404)
		const badTimeField = await harness.request("PATCH", `${path}/catalog/entries/shop.orders`, admin, {
			time_field: "nope",
		})
		expect(badTimeField.body.error).toMatchObject({ code: "data_source_invalid", param: "time_field" })
		await harness.dispose()
	})
})
