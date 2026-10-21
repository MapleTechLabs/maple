import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import { CreateScrapeTargetRequest, OrgId, ScrapeTargetId, UserId } from "@maple/domain/http"
import { SupabaseProjectRef } from "@maple/domain/primitives"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/platform/test-pglite"
import { SupabaseOAuthService } from "@maple/backend/services/auth/SupabaseOAuthService"
import { ScrapeTargetsService } from "../ScrapeTargetsService"
import { SupabaseConnectionService } from "../SupabaseConnectionService"
import {
	FAKE_CLIENT_ID,
	FAKE_CLIENT_SECRET,
	fakeProject,
	makeFakeSupabase,
} from "./__fixtures__/fake-supabase-api"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const config = {
	PORT: "3472",
	TINYBIRD_HOST: "https://api.tinybird.co",
	TINYBIRD_TOKEN: "test-token",
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_ROOT_PASSWORD: "test-root-password",
	MAPLE_DEFAULT_ORG_ID: "default",
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
	MAPLE_INGEST_PUBLIC_URL: "https://ingest.example.com",
	SUPABASE_OAUTH_CLIENT_ID: FAKE_CLIENT_ID,
	SUPABASE_OAUTH_CLIENT_SECRET: FAKE_CLIENT_SECRET,
}

type Fake = ReturnType<typeof makeFakeSupabase>

const makeLayer = (testDb: TestDb, fake: Fake) =>
	Layer.mergeAll(
		SupabaseConnectionService.layer,
		SupabaseOAuthService.layer,
		ScrapeTargetsService.layer,
	).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
		Layer.merge(Layer.succeed(FetchHttpClient.Fetch, fake.fetch)),
	)

const ORG = Schema.decodeUnknownSync(OrgId)("org_a")
const asRef = Schema.decodeUnknownSync(SupabaseProjectRef)
const asTargetId = Schema.decodeUnknownSync(ScrapeTargetId)

const REF_A = "abcdefghijklmnopqrst"
const REF_B = "bcdefghijklmnopqrstu"
const REF_C = "cdefghijklmnopqrstuv"

/** The OAuth callback: exchange and bind, without discovery. */
const finalize = (fake: Fake) =>
	Effect.gen(function* () {
		const oauth = yield* SupabaseOAuthService
		const { redirectUrl, state } = yield* oauth.startConnect(
			ORG,
			Schema.decodeUnknownSync(UserId)("user_a"),
			{
				callbackUrl: "https://api.example.com/api/integrations/supabase/callback",
			},
		)
		fake.state.codeChallenge = new URL(redirectUrl).searchParams.get("code_challenge")
		const granted = yield* oauth.completeConnect("code", state)
		return yield* (yield* SupabaseConnectionService).finalizeConnect(
			granted.orgId,
			granted.connectedByUserId,
			granted.organization,
		)
	})

/** The callback, then the dashboard's sync, which runs the first discovery. */
const connect = (fake: Fake) =>
	Effect.gen(function* () {
		yield* finalize(fake)
		return yield* (yield* SupabaseConnectionService).sync(ORG)
	})

interface TargetRow {
	readonly id: string
	readonly enabled: boolean
	readonly managed_by: string | null
	readonly target_type: string
	readonly auth_type: string
	readonly url: string
	readonly service_name: string | null
	readonly scrape_interval_seconds: number
	readonly labels_json: Record<string, string> | null
	readonly source_matches: boolean
	readonly updated_at: Date
}

/** The managed target a project points at, or null when it has none. */
const targetOf = (testDb: TestDb, ref: string) =>
	Effect.promise(() =>
		queryFirstRow<TargetRow>(
			testDb,
			`SELECT t.id, t.enabled, t.managed_by, t.target_type, t.auth_type, t.url, t.service_name,
				t.scrape_interval_seconds, t.labels_json, t.source_id = c.source_id AS source_matches, t.updated_at
			FROM supabase_projects p
			JOIN supabase_connections c ON c.id = p.connection_id
			JOIN scrape_targets t ON t.id = p.scrape_target_id
			WHERE p.project_ref = $1`,
			[ref],
		),
	).pipe(Effect.map((row) => row ?? null))

const targetCount = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{ count: number }>(
			testDb,
			"SELECT count(*)::int AS count FROM scrape_targets WHERE target_type = 'supabase'",
		),
	).pipe(Effect.map((row) => row?.count ?? 0))

const connectionId = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{ id: string }>(testDb, "SELECT id FROM supabase_connections WHERE org_id = 'org_a'"),
	).pipe(Effect.map((row) => row?.id ?? ""))

describe("Supabase managed scrape targets", () => {
	it.effect("connect creates one enabled target per running project and none for a paused one", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({
			projects: [
				fakeProject(REF_A, { name: "app" }),
				fakeProject(REF_B, { status: "INACTIVE" }),
				fakeProject(REF_C, { status: "COMING_UP" }),
			],
		})
		return Effect.gen(function* () {
			yield* connect(fake)
			const target = yield* targetOf(testDb, REF_A)
			assert.isNotNull(target)
			if (target === null) return
			assert.deepStrictEqual(
				{
					enabled: target.enabled,
					managedBy: target.managed_by,
					targetType: target.target_type,
					authType: target.auth_type,
					url: target.url,
					serviceName: target.service_name,
					interval: target.scrape_interval_seconds,
					labels: target.labels_json,
					sourceMatches: target.source_matches,
				},
				{
					enabled: true,
					managedBy: `supabase:${yield* connectionId(testDb)}`,
					targetType: "supabase",
					authType: "supabase_oauth",
					url: `https://api.supabase.com/v1/projects/${REF_A}/analytics/endpoints/metrics`,
					serviceName: "supabase",
					interval: 60,
					labels: {
						"supabase.project.ref": REF_A,
						"supabase.project.name": "app",
						"supabase.project.region": "us-east-1",
						"supabase.organization.slug": "jylmnjimcybytpydxgbu",
					},
					sourceMatches: true,
				},
			)
			assert.isNull(yield* targetOf(testDb, REF_B))
			// A project still coming up keeps its target: the state lasts minutes, discovery an hour.
			assert.isTrue((yield* targetOf(testDb, REF_C))?.enabled ?? false)
			assert.strictEqual(yield* targetCount(testDb), 2)
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("the metrics toggle disables and re-enables the project's target in place", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ projects: [fakeProject(REF_A)] })
		return Effect.gen(function* () {
			const service = yield* SupabaseConnectionService
			yield* connect(fake)
			const created = yield* targetOf(testDb, REF_A)
			yield* service.updateProject(ORG, asRef(REF_A), { metricsEnabled: false })
			const disabled = yield* targetOf(testDb, REF_A)
			assert.strictEqual(disabled?.id, created?.id)
			assert.isFalse(disabled?.enabled ?? true)
			yield* service.updateProject(ORG, asRef(REF_A), { metricsEnabled: true })
			assert.isTrue((yield* targetOf(testDb, REF_A))?.enabled ?? false)
			assert.strictEqual(yield* targetCount(testDb), 1)
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect(
		"discovery disables a paused project's target, deletes a removed one's, and a rerun changes nothing",
		() => {
			const testDb = createTestDb(trackedDbs)
			const fake = makeFakeSupabase({ projects: [fakeProject(REF_A), fakeProject(REF_B)] })
			return Effect.gen(function* () {
				const service = yield* SupabaseConnectionService
				yield* connect(fake)
				const removedTarget = yield* targetOf(testDb, REF_B)

				fake.state.projects = [fakeProject(REF_A, { status: "PAUSING" })]
				yield* TestClock.adjust("1 hour")
				yield* service.discoverOrg(ORG)
				const paused = yield* targetOf(testDb, REF_A)
				assert.isFalse(paused?.enabled ?? true)
				assert.isNull(yield* targetOf(testDb, REF_B))
				const gone = yield* Effect.promise(() =>
					queryFirstRow<{ count: number }>(
						testDb,
						"SELECT count(*)::int AS count FROM scrape_targets WHERE id = $1",
						[removedTarget?.id ?? ""],
					),
				)
				assert.strictEqual(gone?.count, 0)

				yield* TestClock.adjust("1 hour")
				yield* service.discoverOrg(ORG)
				const rerun = yield* targetOf(testDb, REF_A)
				assert.strictEqual(rerun?.updated_at.getTime(), paused?.updated_at.getTime())
				assert.strictEqual(yield* targetCount(testDb), 1)

				fake.state.projects = [fakeProject(REF_A)]
				yield* TestClock.adjust("1 hour")
				yield* service.discoverOrg(ORG)
				assert.isTrue((yield* targetOf(testDb, REF_A))?.enabled ?? false)
			}).pipe(Effect.provide(makeLayer(testDb, fake)))
		},
	)

	it.effect("the callback creates no targets; the first discovery does", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ projects: [fakeProject(REF_A)] })
		return Effect.gen(function* () {
			yield* finalize(fake)
			assert.strictEqual(yield* targetCount(testDb), 0)
			yield* TestClock.adjust("1 hour")
			yield* (yield* SupabaseConnectionService).discoverAllOrgs()
			assert.isTrue((yield* targetOf(testDb, REF_A))?.enabled ?? false)
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("a discovery after a metrics toggle keeps the toggle", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ projects: [fakeProject(REF_A)] })
		return Effect.gen(function* () {
			const service = yield* SupabaseConnectionService
			yield* connect(fake)
			yield* service.updateProject(ORG, asRef(REF_A), { metricsEnabled: false })
			yield* TestClock.adjust("1 hour")
			yield* service.discoverOrg(ORG)
			assert.isFalse((yield* targetOf(testDb, REF_A))?.enabled ?? true)
			assert.strictEqual(yield* targetCount(testDb), 1)
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("reconnecting to a different organization deletes the old organization's targets", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ projects: [fakeProject(REF_A), fakeProject(REF_B)] })
		return Effect.gen(function* () {
			yield* connect(fake)
			assert.strictEqual(yield* targetCount(testDb), 2)
			const other = { id: "otherorgidotherorgid", slug: "otherorg", name: "Other" }
			fake.state.organizations = [other]
			yield* finalize(fake)
			assert.strictEqual(yield* targetCount(testDb), 0)
			assert.isNull(yield* targetOf(testDb, REF_A))
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("disconnect deletes every managed target", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ projects: [fakeProject(REF_A), fakeProject(REF_B)] })
		return Effect.gen(function* () {
			yield* connect(fake)
			assert.strictEqual(yield* targetCount(testDb), 2)
			yield* (yield* SupabaseConnectionService).disconnect(ORG)
			assert.strictEqual(yield* targetCount(testDb), 0)
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect(
		"the scraper's target list carries the grant's Bearer token, and a revoked grant fails as revoked",
		() => {
			const testDb = createTestDb(trackedDbs)
			const fake = makeFakeSupabase({ projects: [fakeProject(REF_A)] })
			return Effect.gen(function* () {
				const scrapeTargets = yield* ScrapeTargetsService
				yield* connect(fake)
				const [row] = (yield* scrapeTargets.listAllEnabled()).filter(
					(target) => target.targetType === "supabase",
				)
				assert.isDefined(row)
				if (row === undefined) return
				assert.deepStrictEqual(yield* scrapeTargets.authHeaders(row), {
					Authorization: "Bearer sbp_oauth_access_1",
				})

				// The grant dies upstream; discovery's refresh fails and stamps it revoked.
				fake.state.validAccessTokens.clear()
				fake.state.refreshRevoked = true
				yield* TestClock.adjust("1 hour")
				yield* (yield* SupabaseConnectionService).discoverOrg(ORG)
				const error = yield* scrapeTargets.authHeaders(row).pipe(Effect.flip)
				assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsRevokedError")
			}).pipe(Effect.provide(makeLayer(testDb, fake)))
		},
	)

	it.effect(
		"the generic scrape-target API refuses Supabase targets and the supabase_oauth auth type",
		() => {
			const testDb = createTestDb(trackedDbs)
			const fake = makeFakeSupabase({ projects: [fakeProject(REF_A)] })
			return Effect.gen(function* () {
				const scrapeTargets = yield* ScrapeTargetsService
				const asSupabase = yield* scrapeTargets
					.create(ORG, new CreateScrapeTargetRequest({ name: "sb", targetType: "supabase" }))
					.pipe(Effect.flip)
				assert.strictEqual(asSupabase._tag, "@maple/http/errors/ScrapeTargetValidationError")
				const withOAuth = yield* scrapeTargets
					.create(
						ORG,
						new CreateScrapeTargetRequest({
							name: "sb",
							url: "https://metrics.example.com/metrics",
							authType: "supabase_oauth",
						}),
					)
					.pipe(Effect.flip)
				assert.strictEqual(withOAuth._tag, "@maple/http/errors/ScrapeTargetValidationError")

				yield* connect(fake)
				const managed = yield* targetOf(testDb, REF_A)
				const targetId = asTargetId(managed?.id ?? "")
				const edit = yield* scrapeTargets.update(ORG, targetId, { enabled: false }).pipe(Effect.flip)
				assert.strictEqual(edit._tag, "@maple/http/errors/ScrapeTargetValidationError")
				const removal = yield* scrapeTargets.delete(ORG, targetId).pipe(Effect.flip)
				assert.strictEqual(removal._tag, "@maple/http/errors/ScrapeTargetValidationError")
				assert.isTrue((yield* targetOf(testDb, REF_A))?.enabled ?? false)
			}).pipe(Effect.provide(makeLayer(testDb, fake)))
		},
	)
})
