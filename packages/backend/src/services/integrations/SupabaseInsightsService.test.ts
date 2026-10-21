import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import { OrgId, UserId } from "@maple/domain/http"
import { SupabaseProjectRef } from "@maple/domain/primitives"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { SupabaseOAuthService } from "@maple/backend/services/auth/SupabaseOAuthService"
import {
	FAKE_CLIENT_ID,
	FAKE_CLIENT_SECRET,
	fakeProject,
	makeFakeSupabase,
} from "./supabase/__fixtures__/fake-supabase-api"
import { TOP_QUERIES_SQL } from "./supabase/insights"
import { SupabaseConnectionService } from "./SupabaseConnectionService"
import { SupabaseInsightsService } from "./SupabaseInsightsService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const config = {
	PORT: "3472",
	TINYBIRD_HOST: "https://api.tinybird.co",
	TINYBIRD_TOKEN: "test-token",
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_ROOT_PASSWORD: "test-root-password",
	MAPLE_DEFAULT_ORG_ID: "default",
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
	MAPLE_INGEST_PUBLIC_URL: "https://ingest.example.com",
	SUPABASE_OAUTH_CLIENT_ID: FAKE_CLIENT_ID,
	SUPABASE_OAUTH_CLIENT_SECRET: FAKE_CLIENT_SECRET,
}

const minute = 60_000
const NOW = Date.UTC(2026, 9, 21, 18, 0, 0)
const ORG = Schema.decodeUnknownSync(OrgId)("org_a")
const asRef = Schema.decodeUnknownSync(SupabaseProjectRef)
const REF_A = "abcdefghijklmnopqrst"
const REF_PAUSED = "bcdefghijklmnopqrstu"

/** Shaped like a live `/advisors/security` lint (2026-10-21). */
const rlsDisabled = {
	name: "rls_disabled_in_public",
	title: "RLS Disabled in Public",
	level: "ERROR",
	facing: "EXTERNAL",
	categories: ["SECURITY"],
	description:
		"Detects cases where row level security (RLS) has not been enabled on tables in schemas exposed to PostgREST",
	detail: "Table `public.orders` is public, but RLS has not been enabled.",
	remediation: "https://supabase.com/docs/guides/database/database-linter?lint=0013_rls_disabled_in_public",
	metadata: { name: "orders", type: "table", schema: "public" },
	cache_key: "rls_disabled_in_public_public_orders",
}
const unindexedFk = {
	name: "unindexed_foreign_keys",
	title: "Unindexed foreign keys",
	level: "INFO",
	facing: "EXTERNAL",
	categories: ["PERFORMANCE"],
	description: "Identifies foreign key constraints without a covering index.",
	detail: "Table `public.orders` has a foreign key `orders_user_id_fkey` without a covering index.",
	remediation: "https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys",
	metadata: {
		name: "orders",
		type: "table",
		schema: "public",
		fkey_name: "orders_user_id_fkey",
		fkey_columns: [2],
	},
	cache_key: "unindexed_foreign_keys_public_orders_orders_user_id_fkey",
}
const statement = {
	query_id: "-4372925187512357313",
	query: "select * from public.orders where user_id = $1",
	calls: "1200",
	total_exec_time: 5321.5,
	mean_exec_time: 4.43,
	rows: 3600,
}

const makeWorld = () =>
	makeFakeSupabase({
		projects: [fakeProject(REF_A, { name: "app" }), fakeProject(REF_PAUSED, { status: "INACTIVE" })],
		advisors: { performance: [unindexedFk, { name: "broken" }], security: [rlsDisabled] },
		readOnlyRows: [statement],
	})
type World = ReturnType<typeof makeWorld>

const makeLayer = (testDb: TestDb, world: World) =>
	Layer.mergeAll(
		SupabaseInsightsService.layer,
		SupabaseConnectionService.layer,
		SupabaseOAuthService.layer,
	).pipe(
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
		Layer.merge(Layer.succeed(FetchHttpClient.Fetch, world.fetch)),
	)

const connect = (world: World) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		const oauth = yield* SupabaseOAuthService
		const connection = yield* SupabaseConnectionService
		const { redirectUrl, state } = yield* oauth.startConnect(
			ORG,
			Schema.decodeUnknownSync(UserId)("user_a"),
			{
				callbackUrl: "https://api.example.com/api/integrations/supabase/callback",
			},
		)
		world.state.codeChallenge = new URL(redirectUrl).searchParams.get("code_challenge")
		const granted = yield* oauth.completeConnect("code", state)
		yield* connection.finalizeConnect(granted.orgId, granted.connectedByUserId, granted.organization)
		yield* connection.sync(granted.orgId)
	})

const insightCalls = (world: World) =>
	world.state.calls
		.filter((call) => /\/(advisors\/|database\/query)/.test(call.path))
		.map((call) => call.path.replace(/^\/v1\/projects\//, ""))

const run = <A, E>(
	testDb: TestDb,
	world: World,
	effect: Effect.Effect<A, E, SupabaseInsightsService | SupabaseConnectionService | SupabaseOAuthService>,
) => effect.pipe(Effect.provide(makeLayer(testDb, world)))

describe("SupabaseInsightsService", () => {
	it.effect("reads advisors and top queries of running projects and serves them grouped by level", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeWorld()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect(world)
				const insights = yield* SupabaseInsightsService
				const summary = yield* insights.pollAllOrgs()
				assert.deepStrictEqual(summary, {
					orgs: 1,
					advisorsRead: 1,
					queriesRead: 1,
					failures: 0,
					skipped: 0,
				})
				// The inactive project is never called.
				assert.deepStrictEqual(insightCalls(world), [
					`${REF_A}/advisors/performance`,
					`${REF_A}/advisors/security`,
					`${REF_A}/database/query/read-only`,
				])
				const queryCall = world.state.calls.find((call) => call.path.endsWith("/read-only"))
				assert.deepStrictEqual(JSON.parse(queryCall?.body ?? "{}"), { query: TOP_QUERIES_SQL })

				const result = yield* insights.getInsights(ORG, asRef(REF_A))
				assert.deepStrictEqual(
					result.advisors.error.map((lint) => [lint.advisor, lint.name, lint.schema, lint.object]),
					[["security", "rls_disabled_in_public", "public", "orders"]],
				)
				assert.strictEqual(result.advisors.warn.length, 0)
				// The undecodable lint is dropped, its sibling kept.
				assert.deepStrictEqual(
					result.advisors.info.map((lint) => [lint.advisor, lint.name, lint.objectType]),
					[["performance", "unindexed_foreign_keys", "table"]],
				)
				assert.deepStrictEqual(result.topQueries, [
					{
						queryId: "-4372925187512357313",
						query: "select * from public.orders where user_id = $1",
						calls: 1200,
						totalExecMs: 5321.5,
						meanExecMs: 4.43,
						rows: 3600,
					},
				])
				assert.strictEqual(result.advisorsCheckedAt, NOW)
				assert.strictEqual(result.queriesCheckedAt, NOW)
				assert.strictEqual(result.advisorsError, null)
			}),
		)
	})

	it.effect("reads top queries every 15 minutes and advisors hourly", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeWorld()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect(world)
				const insights = yield* SupabaseInsightsService
				yield* insights.pollAllOrgs()
				const callsAfter = (count: number) => insightCalls(world).slice(count)

				yield* TestClock.setTime(NOW + 5 * minute)
				yield* insights.pollAllOrgs()
				assert.deepStrictEqual(callsAfter(3), [])

				yield* TestClock.setTime(NOW + 15 * minute)
				yield* insights.pollAllOrgs()
				assert.deepStrictEqual(callsAfter(3), [`${REF_A}/database/query/read-only`])

				yield* TestClock.setTime(NOW + 60 * minute)
				yield* insights.pollAllOrgs()
				assert.deepStrictEqual(callsAfter(4), [
					`${REF_A}/advisors/performance`,
					`${REF_A}/advisors/security`,
					`${REF_A}/database/query/read-only`,
				])
			}),
		)
	})

	it.effect("records a refused statement read and keeps the last good result", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeWorld()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect(world)
				const insights = yield* SupabaseInsightsService
				yield* insights.pollAllOrgs()

				world.state.readOnlyError = "permission denied for view pg_stat_statements"
				yield* TestClock.setTime(NOW + 15 * minute)
				const summary = yield* insights.pollAllOrgs()
				assert.strictEqual(summary.failures, 1)

				const result = yield* insights.getInsights(ORG, asRef(REF_A))
				assert.match(result.queriesError ?? "", /permission denied for view pg_stat_statements/)
				assert.strictEqual(result.queriesCheckedAt, NOW)
				assert.strictEqual(result.topQueries.length, 1)
				assert.strictEqual(result.advisors.error.length, 1)

				world.state.readOnlyError = null
				yield* TestClock.setTime(NOW + 30 * minute)
				yield* insights.pollAllOrgs()
				assert.strictEqual((yield* insights.getInsights(ORG, asRef(REF_A))).queriesError, null)
			}),
		)
	})

	it.effect("leaves a rate-limited project unchecked and without an error", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeWorld()
		world.state.advisorsStatus = 429
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect(world)
				const insights = yield* SupabaseInsightsService
				const summary = yield* insights.pollAllOrgs()
				assert.strictEqual(summary.failures, 0)
				// Rate limited on the first advisor: nothing else is called this tick.
				assert.deepStrictEqual(insightCalls(world), [`${REF_A}/advisors/performance`])
				const result = yield* insights.getInsights(ORG, asRef(REF_A))
				assert.strictEqual(result.advisorsCheckedAt, null)
				assert.strictEqual(result.advisorsError, null)
				assert.strictEqual(result.queriesCheckedAt, null)
			}),
		)
	})

	it.effect("answers not found for a project the org does not have", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeWorld()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect(world)
				const failure = yield* (yield* SupabaseInsightsService)
					.getInsights(ORG, asRef("zzzzzzzzzzzzzzzzzzzz"))
					.pipe(Effect.flip)
				assert.strictEqual(failure._tag, "@maple/http/errors/IntegrationsNotFoundError")
			}),
		)
	})
})
