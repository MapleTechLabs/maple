import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema, Array as Arr } from "effect"
import { FetchHttpClient } from "effect/http"
import { OrgId, UserId } from "@maple/domain/http"
import { SearchConsoleSiteUrl } from "@maple/domain/primitives"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/platform/test-pglite"
import { GoogleOAuthService } from "@maple/backend/services/auth/GoogleOAuthService"
import { SearchConsoleService } from "./SearchConsoleService"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const SCOPE = "openid email https://www.googleapis.com/auth/webmasters.readonly"
const ID_TOKEN = `h.${Buffer.from(JSON.stringify({ sub: "g-1", email: "owner@acme.dev" })).toString("base64url")}.s`

const SITES = [
	{ siteUrl: "sc-domain:acme.dev", permissionLevel: "siteOwner" },
	{ siteUrl: "https://blog.acme.dev/", permissionLevel: "siteFullUser" },
	{ siteUrl: "https://unverified.acme.dev/", permissionLevel: "siteUnverifiedUser" },
]

const googleFetch: typeof globalThis.fetch = async (input) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
	if (url === "https://oauth2.googleapis.com/token") {
		return jsonResponse({
			access_token: "g-access",
			refresh_token: "g-refresh",
			expires_in: 3599,
			scope: SCOPE,
			id_token: ID_TOKEN,
		})
	}
	if (url === "https://oauth2.googleapis.com/revoke") return new Response(null, { status: 200 })
	if (url === "https://www.googleapis.com/webmasters/v3/sites") return jsonResponse({ siteEntry: SITES })
	return jsonResponse({}, 404)
}

const config = {
	PORT: "3472",
	TINYBIRD_HOST: "https://api.tinybird.co",
	TINYBIRD_TOKEN: "test-token",
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_ROOT_PASSWORD: "test-root-password",
	MAPLE_DEFAULT_ORG_ID: "default",
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
	MAPLE_INGEST_PUBLIC_URL: "https://ingest.example.com",
	GOOGLE_OAUTH_CLIENT_ID: "g-client-id",
	GOOGLE_OAUTH_CLIENT_SECRET: "g-client-secret",
}

const makeLayer = (testDb: TestDb) =>
	Layer.mergeAll(SearchConsoleService.layer, GoogleOAuthService.layer).pipe(
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
		Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, googleFetch)),
	)

const orgA = Schema.decodeSync(OrgId)("org_a")
const userA = Schema.decodeSync(UserId)("user_a")
const siteUrl = Schema.decodeUnknownSync(SearchConsoleSiteUrl)

const connect = Effect.gen(function* () {
	const google = yield* GoogleOAuthService
	const { state } = yield* google.startConnect(orgA, userA, { callbackUrl: "https://api.example.com/cb" })
	yield* google.completeConnect("code", state, { orgId: orgA, userId: userA })
})

describe("SearchConsoleService", () => {
	it.effect("reports a configured but unconnected integration", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const status = yield* (yield* SearchConsoleService).getStatus(orgA)
			assert.deepStrictEqual(status, { configured: true, connection: null, sites: [] })
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("lists Google's properties and marks unverified ones unselectable", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* connect
			const choices = yield* (yield* SearchConsoleService).listAvailableSites(orgA)
			assert.deepStrictEqual(
				Arr.map(choices, (choice) => [choice.siteUrl, choice.selectable, choice.enabled]),
				[
					["https://blog.acme.dev/", true, false],
					["https://unverified.acme.dev/", false, false],
					["sc-domain:acme.dev", true, false],
				],
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("saves the selection and disables a property left out of the next save", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* connect
			const service = yield* SearchConsoleService
			yield* service.saveSites(orgA, [siteUrl("sc-domain:acme.dev"), siteUrl("https://blog.acme.dev/")])
			const saved = yield* service.saveSites(orgA, [siteUrl("https://blog.acme.dev/")])
			assert.deepStrictEqual(
				Arr.map(saved, (row) => [row.siteUrl, row.permissionLevel, row.enabled]),
				[
					["https://blog.acme.dev/", "siteFullUser", true],
					["sc-domain:acme.dev", "siteOwner", false],
				],
			)
			const choices = yield* service.listAvailableSites(orgA)
			assert.deepStrictEqual(
				Arr.map(
					Arr.filter(choices, (choice) => choice.enabled),
					(choice) => choice.siteUrl,
				),
				["https://blog.acme.dev/"],
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("refuses a property the account cannot see or has not verified", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* connect
			const service = yield* SearchConsoleService
			const unknown = yield* service.saveSites(orgA, [siteUrl("https://other.dev/")]).pipe(Effect.flip)
			assert.strictEqual(unknown._tag, "@maple/http/errors/IntegrationsValidationError")
			const unverified = yield* service
				.saveSites(orgA, [siteUrl("https://unverified.acme.dev/")])
				.pipe(Effect.flip)
			assert.strictEqual(unverified._tag, "@maple/http/errors/IntegrationsValidationError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("drops the saved properties with the Google grant on disconnect", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* connect
			yield* (yield* SearchConsoleService).saveSites(orgA, [siteUrl("sc-domain:acme.dev")])
			yield* (yield* GoogleOAuthService).disconnect(orgA)
			const remaining = yield* Effect.promise(() =>
				queryFirstRow<{ count: string }>(
					testDb,
					"SELECT count(*)::text AS count FROM search_console_sites WHERE org_id = $1",
					["org_a"],
				),
			)
			assert.strictEqual(remaining?.count, "0")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
