import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema, Array as Arr } from "effect"
import { TestClock } from "effect/testing"
import { OrgId, UserId } from "@maple/domain/http"
import { SearchConsoleSiteUrl } from "@maple/primitives"
import { Env } from "@maple/backend/platform/Env"
import * as VendorFake from "@maple/backend/testing/vendor-fake"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { GoogleOAuthService } from "@maple/backend/services/auth/GoogleOAuthService"
import { SearchConsoleService } from "./SearchConsoleService"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

const SCOPE = "openid email https://www.googleapis.com/auth/webmasters.readonly"
const ID_TOKEN = `h.${Buffer.from(JSON.stringify({ sub: "g-1", email: "owner@acme.dev" })).toString("base64url")}.s`

const SITES = [
	{ siteUrl: "sc-domain:acme.dev", permissionLevel: "siteOwner" },
	{ siteUrl: "https://blog.acme.dev/", permissionLevel: "siteFullUser" },
	{ siteUrl: "https://unverified.acme.dev/", permissionLevel: "siteUnverifiedUser" },
]

const googleRoutes: ReadonlyArray<VendorFake.VendorFakeRoute> = [
	{
		path: "/token",
		respond: () =>
			VendorFake.json({
				access_token: "g-access",
				refresh_token: "g-refresh",
				expires_in: 3599,
				scope: SCOPE,
				id_token: ID_TOKEN,
			}),
	},
	{ path: "/revoke", respond: () => VendorFake.empty(200) },
	{ path: "/webmasters/v3/sites", respond: () => VendorFake.json({ siteEntry: SITES }) },
]

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
	GOOGLE_SEARCH_CONSOLE_CLIENT_ID: "g-client-id",
	GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET: "g-client-secret",
}

const makeLayer = (testDb: TestDb, routes: ReadonlyArray<VendorFake.VendorFakeRoute> = googleRoutes) =>
	Layer.mergeAll(SearchConsoleService.layer, GoogleOAuthService.layer).pipe(
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
		Layer.provideMerge(VendorFake.make({ routes }).layer),
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

	it.effect("re-saving moves updatedAt only on properties whose enabled state changed", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* connect
			const service = yield* SearchConsoleService
			const first = yield* service.saveSites(orgA, [
				siteUrl("sc-domain:acme.dev"),
				siteUrl("https://blog.acme.dev/"),
			])
			const savedAt = first[0]?.updatedAt
			yield* TestClock.adjust("1 hour")
			const second = yield* service.saveSites(orgA, [siteUrl("https://blog.acme.dev/")])
			assert.deepStrictEqual(
				Arr.map(second, (row) => [row.siteUrl, row.enabled, row.updatedAt === savedAt]),
				[
					["https://blog.acme.dev/", true, true],
					["sc-domain:acme.dev", false, false],
				],
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("reports each property's import frontiers", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* connect
			const service = yield* SearchConsoleService
			yield* service.saveSites(orgA, [siteUrl("sc-domain:acme.dev")])
			const before = yield* service.getStatus(orgA)
			assert.deepStrictEqual(
				Arr.map(before.sites, (site) => [site.watermarkDate, site.backfillDate]),
				[[null, null]],
			)
			yield* Effect.promise(() =>
				queryFirstRow(
					testDb,
					"UPDATE search_console_sites SET watermark_date = $1, backfill_date = $2 WHERE org_id = $3 RETURNING id",
					["2026-11-07", "2026-10-26", "org_a"],
				),
			)
			const after = yield* service.getStatus(orgA)
			assert.deepStrictEqual(
				Arr.map(after.sites, (site) => [site.siteUrl, site.watermarkDate, site.backfillDate]),
				[["sc-domain:acme.dev", "2026-11-07", "2026-10-26"]],
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

	it.effect("refuses a save whose Google account changed after the property list was read", () => {
		const testDb = createTestDb(trackedDbs)
		// Another tab reconnects as a different Google account while this save is validating.
		const reconnecting: VendorFake.VendorFakeRoute = {
			path: "/webmasters/v3/sites",
			respond: async () => {
				await testDb.pglite.query(
					"UPDATE oauth_connections SET external_user_id = $1 WHERE org_id = $2 AND provider = 'google'",
					["g-2", "org_a"],
				)
				return undefined
			},
		}
		return Effect.gen(function* () {
			yield* connect
			const service = yield* SearchConsoleService
			const refused = yield* service.saveSites(orgA, [siteUrl("sc-domain:acme.dev")]).pipe(Effect.flip)
			assert.strictEqual(refused._tag, "@maple/http/errors/IntegrationsConnectionChangedError")
			const saved = yield* Effect.promise(() =>
				queryFirstRow<{ count: string }>(
					testDb,
					"SELECT count(*)::text AS count FROM search_console_sites WHERE org_id = $1",
					["org_a"],
				),
			)
			assert.strictEqual(saved?.count, "0")
		}).pipe(Effect.provide(makeLayer(testDb, [reconnecting, ...googleRoutes])))
	})

	it.effect("keeps saving after a reconnect as the same Google account", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* connect
			const service = yield* SearchConsoleService
			yield* service.saveSites(orgA, [siteUrl("sc-domain:acme.dev")])
			yield* connect
			const saved = yield* service.saveSites(orgA, [
				siteUrl("sc-domain:acme.dev"),
				siteUrl("https://blog.acme.dev/"),
			])
			assert.deepStrictEqual(
				Arr.map(saved, (row) => [row.siteUrl, row.enabled]),
				[
					["https://blog.acme.dev/", true],
					["sc-domain:acme.dev", true],
				],
			)
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
