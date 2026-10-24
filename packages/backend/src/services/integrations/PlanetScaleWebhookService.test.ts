import { afterEach, assert, describe, it } from "@effect/vitest"
import { SupabaseOAuthService } from "@maple/backend/services/auth/SupabaseOAuthService"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { OrgId, UserId } from "@maple/domain/http"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import { PlanetScaleOAuthService } from "@maple/backend/services/auth/PlanetScaleOAuthService"
import { PlanetScaleConnectionService } from "./PlanetScaleConnectionService"
import { PlanetScaleDiscoveryService } from "./PlanetScaleDiscoveryService"
import { PlanetScaleService } from "./PlanetScaleService"
import { PlanetScaleWebhookService } from "./PlanetScaleWebhookService"
import { ScrapeTargetsService } from "./ScrapeTargetsService"

const trackedDbs: TestDb[] = []
const originalFetch = globalThis.fetch
// `FetchHttpClient` keeps the first `fetch` it sees, so every test goes through one dispatcher.
let currentFetch: typeof fetch = originalFetch
const dispatchFetch = ((input: string | URL | Request, init?: RequestInit) =>
	currentFetch(input, init)) as typeof fetch

afterEach(async () => {
	globalThis.fetch = originalFetch
	await cleanupTestDbs(trackedDbs)
})

const API_BASE = "https://api.maple.test"
const WEBHOOK_PREFIX = `${API_BASE}/api/integrations/planetscale/webhook/`

const makeConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			MAPLE_API_BASE_URL: API_BASE,
			PLANETSCALE_OAUTH_CLIENT_ID: "ps-client-id",
			PLANETSCALE_OAUTH_CLIENT_SECRET: "ps-client-secret",
		}),
	)

const makeLayer = (testDb: TestDb) => {
	const oauthLive = PlanetScaleOAuthService.layer
	const discoveryLive = Layer.effect(PlanetScaleDiscoveryService, PlanetScaleDiscoveryService.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(oauthLive),
	)
	const webhooksLive = Layer.effect(PlanetScaleWebhookService, PlanetScaleWebhookService.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(oauthLive),
	)
	const scrapeTargetsLive = Layer.effect(ScrapeTargetsService, ScrapeTargetsService.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(Layer.mergeAll(discoveryLive, oauthLive, SupabaseOAuthService.layer)),
	)
	return Layer.mergeAll(
		Layer.effect(PlanetScaleService, PlanetScaleService.make).pipe(
			Layer.provide(FetchHttpClient.layer),
			Layer.provide(Layer.mergeAll(webhooksLive, oauthLive)),
		),
		Layer.effect(PlanetScaleConnectionService, PlanetScaleConnectionService.make).pipe(
			Layer.provide(FetchHttpClient.layer),
			Layer.provide(Layer.mergeAll(scrapeTargetsLive, discoveryLive, webhooksLive, oauthLive)),
		),
		webhooksLive,
		oauthLive,
	).pipe(Layer.provide(testDb.layer), Layer.provide(Env.layer), Layer.provide(makeConfig()))
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

interface FakeWebhook {
	id: string
	url: string
	secret: string
	enabled: boolean
	events: ReadonlyArray<string>
}

/**
 * PlanetScale's management API with a working webhook store: listings, create, update and
 * delete behave like the real endpoints, so the tests read the end state, not the calls.
 */
const fakePlanetScale = (options: {
	readonly scope: string
	readonly databases: ReadonlyArray<{ readonly name: string; readonly kind?: string }>
	readonly webhooks?: ReadonlyArray<readonly [string, Array<FakeWebhook>]>
	/** Databases whose webhook creation PlanetScale refuses (it caps a database at 5). */
	readonly refuseCreate?: ReadonlyArray<string>
}) => {
	const webhooks = new Map(options.webhooks)
	let nextId = 1
	globalThis.fetch = dispatchFetch
	currentFetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init)
		const url = new URL(request.url)
		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
		if (url.pathname.endsWith("/oauth/token")) {
			return json({
				access_token: "ps-access-token",
				refresh_token: "ps-refresh-token",
				token_type: "Bearer",
				expires_in: 3600,
				scope: options.scope,
			})
		}
		if (url.pathname === "/v1/user") return json({ id: "psuser_1" })
		if (url.pathname === "/v1/organizations") {
			return json({
				data: [
					{ id: "psorg_1", name: "acme" },
					{ id: "psorg_2", name: "labs" },
				],
			})
		}
		const hook = url.pathname.match(/\/databases\/([^/]+)\/webhooks(?:\/([^/]+))?$/)
		if (hook) {
			const database = decodeURIComponent(hook[1]!)
			const list = webhooks.get(database) ?? []
			webhooks.set(database, list)
			const id = hook[2]
			if (request.method === "GET") return json({ data: list, next_page: null })
			if (request.method === "POST") {
				if (options.refuseCreate?.includes(database)) {
					return json({ code: "unprocessable", message: "Webhook limit reached" }, 422)
				}
				const body = (await request.json()) as { url: string; enabled: boolean; events: string[] }
				const created = {
					id: `wh_${nextId++}`,
					url: body.url,
					secret: `secret-${database}`,
					enabled: body.enabled,
					events: body.events,
				}
				list.push(created)
				return json(created, 201)
			}
			const index = list.findIndex((existing) => existing.id === id)
			if (request.method === "DELETE") {
				list.splice(index, 1)
				return new Response(null, { status: 204 })
			}
			if (request.method === "PATCH") {
				const body = (await request.json()) as Partial<FakeWebhook>
				list[index] = { ...list[index]!, ...body }
				return json(list[index])
			}
		}
		if (/\/databases\/[^/]+\/(branches|deploy-requests)/.test(url.pathname)) return json({ data: [] })
		if (url.pathname.endsWith("/databases")) {
			return json({
				data: options.databases.map((database, index) => ({ id: `db_${index}`, ...database })),
			})
		}
		return json([])
	}) as typeof fetch
	return webhooks
}

/** Store a Maple org's OAuth grant, bind it to "acme" and load the inventory. */
const connect = (orgId: string) =>
	Effect.gen(function* () {
		const oauth = yield* PlanetScaleOAuthService
		const { state } = yield* oauth.startConnect(asOrgId(orgId), asUserId("user_1"), {
			callbackUrl: `${API_BASE}/api/integrations/planetscale/callback`,
		})
		yield* oauth.completeConnect("auth-code", state, {
			orgId: asOrgId(orgId),
			userId: asUserId("user_1"),
		})
		yield* (yield* PlanetScaleConnectionService).finalizeOrgSelection(asOrgId(orgId), {
			organization: "acme",
		})
		yield* (yield* PlanetScaleService).pollAllOrgs()
		return yield* (yield* PlanetScaleConnectionService).loadConnection(asOrgId(orgId))
	})

const connectAndPoll = connect("org_1")

const webhooksStatus = Effect.gen(function* () {
	const status = yield* (yield* PlanetScaleConnectionService).getStatus(asOrgId("org_1"))
	return status.webhooks
})

describe("PlanetScaleWebhookService", () => {
	it.effect("registers Maple's webhook on every database and verifies with its own secret", () => {
		const testDb = createTestDb(trackedDbs)
		const store = fakePlanetScale({
			scope: "read_databases write_databases",
			databases: [{ name: "shop" }, { name: "ledger", kind: "postgresql" }],
		})
		return Effect.gen(function* () {
			const connection = (yield* connectAndPoll)!
			const url = `${WEBHOOK_PREFIX}${connection.id}`

			assert.deepStrictEqual(
				store.get("shop")?.map((hook) => [hook.url, hook.enabled]),
				[[url, true]],
			)
			assert.include(store.get("shop")?.[0]?.events ?? [], "deploy_request.schema_applied")
			// Postgres has no deploy requests or keyspaces to subscribe to.
			assert.deepStrictEqual(
				store
					.get("ledger")?.[0]
					?.events.filter(
						(event) => event.startsWith("deploy_request.") || event === "keyspace.storage",
					),
				[],
			)
			assert.include(store.get("ledger")?.[0]?.events ?? [], "branch.out_of_memory")

			const webhooks = yield* PlanetScaleWebhookService
			assert.strictEqual(yield* webhooks.secretFor(asOrgId("org_1"), "shop"), "secret-shop")
			assert.strictEqual(yield* webhooks.secretFor(asOrgId("org_1"), "ledger"), "secret-ledger")
			assert.strictEqual(yield* webhooks.secretFor(asOrgId("org_1"), "unknown"), null)

			const status = yield* webhooksStatus
			assert.deepStrictEqual(
				{ ...status },
				{ state: "active", registeredDatabases: 2, databases: 2, lastError: null },
			)

			// A second pass changes nothing: the webhook is adopted, not duplicated.
			yield* webhooks.reconcile(connection)
			assert.strictEqual(store.get("shop")?.length, 1)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("adopts and re-enables its webhook and deletes ones left by an earlier connection", () => {
		const testDb = createTestDb(trackedDbs)
		const store = fakePlanetScale({
			scope: "read_databases write_databases",
			databases: [{ name: "shop" }],
		})
		return Effect.gen(function* () {
			const connection = (yield* connectAndPoll)!
			const url = `${WEBHOOK_PREFIX}${connection.id}`
			// PlanetScale disabled ours after failed deliveries, and a reconnect left an old one behind.
			store.set("shop", [
				{ ...store.get("shop")![0]!, enabled: false, secret: "rotated-secret" },
				{
					id: "wh_old",
					url: `${WEBHOOK_PREFIX}old-connection`,
					secret: "old",
					enabled: true,
					events: [],
				},
				{
					id: "wh_theirs",
					url: "https://example.com/hook",
					secret: "theirs",
					enabled: true,
					events: [],
				},
			])

			const webhooks = yield* PlanetScaleWebhookService
			yield* webhooks.reconcile(connection)

			assert.deepStrictEqual(
				store.get("shop")?.map((hook) => [hook.url, hook.enabled]),
				[
					[url, true],
					["https://example.com/hook", true],
				],
			)
			// The listing carries the secret PlanetScale signs with now.
			assert.strictEqual(yield* webhooks.secretFor(asOrgId("org_1"), "shop"), "rotated-secret")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("asks for a reauthorization instead of calling PlanetScale when the grant cannot write", () => {
		const testDb = createTestDb(trackedDbs)
		const store = fakePlanetScale({
			scope: "read_databases read_branches",
			databases: [{ name: "shop" }],
		})
		return Effect.gen(function* () {
			const connection = (yield* connectAndPoll)!
			const result = yield* (yield* PlanetScaleWebhookService).reconcile(connection)

			assert.strictEqual(result.skipped, "missing_scope")
			assert.isFalse(store.has("shop"))
			assert.strictEqual((yield* webhooksStatus)?.state, "needs_reauthorization")

			// A reauthorization with write access registers on the very next tick, not after the TTL.
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					"UPDATE oauth_connections SET scope = 'read_databases write_databases' WHERE provider = 'planetscale'",
				),
			)
			yield* (yield* PlanetScaleService).pollAllOrgs()
			assert.strictEqual(store.get("shop")?.length, 1)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("records a database PlanetScale refuses and still registers the others", () => {
		const testDb = createTestDb(trackedDbs)
		const store = fakePlanetScale({
			scope: "read_databases write_databases",
			databases: [{ name: "shop" }, { name: "full" }],
			refuseCreate: ["full"],
		})
		return Effect.gen(function* () {
			yield* connectAndPoll
			const status = yield* webhooksStatus

			assert.strictEqual(store.get("shop")?.length, 1)
			assert.strictEqual(status?.state, "failing")
			assert.strictEqual(status?.registeredDatabases, 1)
			assert.include(status?.lastError ?? "", "Webhook limit reached")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("deletes its webhooks when the integration is disconnected", () => {
		const testDb = createTestDb(trackedDbs)
		const store = fakePlanetScale({
			scope: "read_databases write_databases",
			databases: [{ name: "shop" }],
			webhooks: [
				[
					"shop",
					[
						{
							id: "wh_theirs",
							url: "https://example.com/hook",
							secret: "x",
							enabled: true,
							events: [],
						},
					],
				],
			],
		})
		return Effect.gen(function* () {
			yield* connectAndPoll
			assert.strictEqual(store.get("shop")?.length, 2)

			yield* (yield* PlanetScaleConnectionService).disconnect(asOrgId("org_1"))

			assert.deepStrictEqual(
				store.get("shop")?.map((hook) => hook.id),
				["wh_theirs"],
			)
			assert.strictEqual(
				yield* (yield* PlanetScaleWebhookService).secretFor(asOrgId("org_1"), "shop"),
				null,
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("leaves the webhook of another Maple org bound to the same PlanetScale org", () => {
		const testDb = createTestDb(trackedDbs)
		const store = fakePlanetScale({
			scope: "read_databases write_databases",
			databases: [{ name: "shop" }],
		})
		return Effect.gen(function* () {
			const first = (yield* connect("org_1"))!
			const second = (yield* connect("org_2"))!
			yield* (yield* PlanetScaleWebhookService).reconcile(first)

			assert.sameMembers(store.get("shop")?.map((hook) => hook.url) ?? [], [
				`${WEBHOOK_PREFIX}${first.id}`,
				`${WEBHOOK_PREFIX}${second.id}`,
			])
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("removes the old organization's webhooks when the connection moves to another one", () => {
		const testDb = createTestDb(trackedDbs)
		const store = fakePlanetScale({
			scope: "read_databases write_databases",
			databases: [{ name: "shop" }],
		})
		return Effect.gen(function* () {
			yield* connectAndPoll
			assert.strictEqual(store.get("shop")?.length, 1)

			yield* (yield* PlanetScaleConnectionService).finalizeOrgSelection(asOrgId("org_1"), {
				organization: "labs",
			})

			assert.deepStrictEqual(store.get("shop"), [])
			// The old organization's databases are retired, so nothing reconciles them against the new one.
			assert.deepStrictEqual(yield* (yield* PlanetScaleService).listDatabases(asOrgId("org_1")), [])
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
