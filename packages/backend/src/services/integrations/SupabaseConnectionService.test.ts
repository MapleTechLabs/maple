import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import { OrgId, UserId } from "@maple/domain/http"
import { SupabaseProjectRef } from "@maple/domain/primitives"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/platform/test-pglite"
import { SupabaseOAuthService } from "@maple/backend/services/auth/SupabaseOAuthService"
import {
	FAKE_CLIENT_ID,
	FAKE_CLIENT_SECRET,
	fakeProject,
	makeFakeSupabase,
} from "./supabase/__fixtures__/fake-supabase-api"
import { SupabaseConnectionService } from "./SupabaseConnectionService"

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

type Fake = ReturnType<typeof makeFakeSupabase>

const makeLayer = (testDb: TestDb, fake: Fake) =>
	Layer.mergeAll(SupabaseConnectionService.layer, SupabaseOAuthService.layer).pipe(
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
		Layer.merge(Layer.succeed(FetchHttpClient.Fetch, fake.fetch)),
	)

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asRef = Schema.decodeUnknownSync(SupabaseProjectRef)
const ORG = asOrgId("org_a")

const REF_A = "abcdefghijklmnopqrst"
const REF_B = "bcdefghijklmnopqrstu"
const REF_C = "cdefghijklmnopqrstuv"
const OTHER_ORG_REF = "zyxwvutsrqponmlkjihg"

/** The callback's sequence: start, consent (the fake sees the PKCE challenge), exchange, bind. */
const finalize = (fake: Fake) =>
	Effect.gen(function* () {
		const oauth = yield* SupabaseOAuthService
		const connection = yield* SupabaseConnectionService
		const { redirectUrl, state } = yield* oauth.startConnect(ORG, asUserId("user_a"), {
			callbackUrl: "https://api.example.com/api/integrations/supabase/callback",
		})
		fake.state.codeChallenge = new URL(redirectUrl).searchParams.get("code_challenge")
		const granted = yield* oauth.completeConnect("code", state)
		return yield* connection.finalizeConnect(
			granted.orgId,
			granted.connectedByUserId,
			granted.organization,
		)
	})

/** The callback, then the dashboard's sync once the popup reports success. */
const connect = (fake: Fake) =>
	Effect.gen(function* () {
		yield* finalize(fake)
		return yield* (yield* SupabaseConnectionService).sync(ORG)
	})

const projectRow = (testDb: TestDb, ref: string) =>
	Effect.promise(() =>
		queryFirstRow<{ name: string; status: string; metrics_enabled: boolean; removed_at: Date | null }>(
			testDb,
			"SELECT name, status, metrics_enabled, removed_at FROM supabase_projects WHERE project_ref = $1",
			[ref],
		),
	)

const sourceRow = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{
			platform: string
			kind: string
			name: string
			last_poll_ok_at: Date | null
			last_poll_error: string | null
			disconnected_at: Date | null
		}>(
			testDb,
			"SELECT s.platform, s.kind, s.name, s.last_poll_ok_at, s.last_poll_error, s.disconnected_at FROM sources s JOIN supabase_connections c ON c.source_id = s.id WHERE c.org_id = $1",
			["org_a"],
		),
	)

const apiCalls = (fake: Fake, path: string) => fake.state.calls.filter((call) => call.path === path).length

describe("SupabaseConnectionService", () => {
	it.effect("reads as not connected (but configured) before any grant", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const status = yield* (yield* SupabaseConnectionService).getStatus(ORG)
			assert.isTrue(status.configured)
			assert.isFalse(status.connected)
			assert.deepStrictEqual(status.projects, [])
		}).pipe(Effect.provide(makeLayer(testDb, makeFakeSupabase())))
	})

	it.effect("connect binds the granted organization, creates its source and discovers its projects", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({
			projects: [
				fakeProject(REF_B, { name: "billing" }),
				fakeProject(REF_A, { name: "app" }),
				fakeProject(OTHER_ORG_REF, { organization_id: "otherorg", organization_slug: "otherorg" }),
			],
		})
		return Effect.gen(function* () {
			// The callback binds without discovering, so the popup never waits on Supabase's API.
			const bound = yield* finalize(fake)
			assert.isTrue(bound.connected)
			assert.isNull(bound.lastDiscoveryAt)
			assert.deepStrictEqual(bound.projects, [])
			assert.strictEqual(apiCalls(fake, "/v1/projects"), 0)

			const status = yield* (yield* SupabaseConnectionService).sync(ORG)
			assert.isTrue(status.connected)
			assert.isFalse(status.revoked)
			assert.strictEqual(status.organization?.name, "Acme")
			assert.strictEqual(status.connectedByUserId, "user_a")
			assert.strictEqual(status.lastDiscoveryAt, 0)
			assert.isNull(status.lastDiscoveryError)
			// Only the granted organization's projects, by name, metrics on and drains off by default.
			assert.deepStrictEqual(
				status.projects.map((project) => [
					project.ref,
					project.name,
					project.metricsEnabled,
					project.logDrainEnabled,
				]),
				[
					[REF_A, "app", true, false],
					[REF_B, "billing", true, false],
				],
			)
			const source = yield* sourceRow(testDb)
			assert.strictEqual(source?.platform, "supabase")
			assert.strictEqual(source?.kind, "integration")
			assert.strictEqual(source?.name, "Supabase Acme")
			assert.isNotNull(source?.last_poll_ok_at ?? null)
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect(
		"discovery updates changed projects, soft-removes vanished ones and revives returning ones",
		() => {
			const testDb = createTestDb(trackedDbs)
			const fake = makeFakeSupabase({ projects: [fakeProject(REF_A), fakeProject(REF_B)] })
			return Effect.gen(function* () {
				const service = yield* SupabaseConnectionService
				yield* connect(fake)
				yield* service.updateProject(ORG, asRef(REF_B), { metricsEnabled: false })

				fake.state.projects = [
					fakeProject(REF_A, { name: "renamed", status: "INACTIVE" }),
					fakeProject(REF_C),
				]
				yield* TestClock.adjust("1 hour")
				const summary = yield* service.discoverOrg(ORG)
				assert.deepStrictEqual(
					{ projects: summary.projects, removed: summary.removed, error: summary.error },
					{ projects: 2, removed: 1, error: null },
				)
				const status = yield* service.getStatus(ORG)
				assert.deepStrictEqual(
					status.projects.map((project) => [project.ref, project.name, project.status]),
					[
						[REF_C, `project-${REF_C.slice(0, 4)}`, "ACTIVE_HEALTHY"],
						[REF_A, "renamed", "INACTIVE"],
					],
				)
				assert.isNotNull((yield* projectRow(testDb, REF_B))?.removed_at ?? null)

				fake.state.projects = [fakeProject(REF_A), fakeProject(REF_B), fakeProject(REF_C)]
				yield* TestClock.adjust("1 hour")
				yield* service.discoverOrg(ORG)
				const revived = yield* projectRow(testDb, REF_B)
				assert.isNull(revived?.removed_at ?? null)
				// The toggle set before it vanished survives its return.
				assert.isFalse(revived?.metrics_enabled ?? true)
			}).pipe(Effect.provide(makeLayer(testDb, fake)))
		},
	)

	it.effect("an undecodable project item does not soft-remove the existing projects", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ projects: [fakeProject(REF_A), fakeProject(REF_B)] })
		return Effect.gen(function* () {
			const service = yield* SupabaseConnectionService
			yield* connect(fake)

			// REF_B's item stops decoding; the listing is incomplete, so absence proves nothing.
			fake.state.projects = [fakeProject(REF_A), { ref: REF_B, name: 42 }]
			yield* TestClock.adjust("1 hour")
			const summary = yield* service.discoverOrg(ORG)
			assert.deepStrictEqual(
				{ projects: summary.projects, removed: summary.removed, error: summary.error },
				{ projects: 1, removed: 0, error: null },
			)
			assert.isNull((yield* projectRow(testDb, REF_B))?.removed_at ?? null)
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("updateProject toggles metrics and rejects a project the org does not have", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ projects: [fakeProject(REF_A)] })
		return Effect.gen(function* () {
			const service = yield* SupabaseConnectionService
			yield* connect(fake)
			const status = yield* service.updateProject(ORG, asRef(REF_A), { metricsEnabled: false })
			assert.isFalse(status.projects[0]?.metricsEnabled ?? true)
			const error = yield* service
				.updateProject(ORG, asRef(OTHER_ORG_REF), { metricsEnabled: true })
				.pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsNotFoundError")
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("a revoked grant marks the connection revoked and later discoveries skip it", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ projects: [fakeProject(REF_A)] })
		return Effect.gen(function* () {
			const service = yield* SupabaseConnectionService
			yield* connect(fake)
			fake.state.validAccessTokens.clear()
			fake.state.refreshRevoked = true
			yield* TestClock.adjust("1 hour")
			const failed = yield* service.discoverOrg(ORG)
			assert.include(failed.error ?? "", "Reconnect Supabase")

			const status = yield* service.getStatus(ORG)
			assert.isTrue(status.revoked)
			assert.include(status.lastDiscoveryError ?? "", "Reconnect Supabase")
			// The project list stays as last seen rather than being emptied by a failed read.
			assert.strictEqual(status.projects.length, 1)
			assert.isNotNull((yield* sourceRow(testDb))?.disconnected_at ?? null)

			const callsBefore = fake.state.calls.length
			yield* TestClock.adjust("1 hour")
			const skipped = yield* service.discoverOrg(ORG)
			assert.strictEqual(skipped.skipped, "grant revoked")
			const all = yield* service.discoverAllOrgs()
			assert.deepStrictEqual(all, { orgs: 1, discovered: 0, skipped: 1, failures: 0 })
			assert.strictEqual(fake.state.calls.length, callsBefore)
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("a 429 holds the discovery lease for at least a minute", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ projects: [fakeProject(REF_A)] })
		return Effect.gen(function* () {
			const service = yield* SupabaseConnectionService
			yield* connect(fake)
			fake.state.projectsStatus = 429
			yield* TestClock.adjust("1 hour")
			const limited = yield* service.discoverOrg(ORG)
			assert.include(limited.error ?? "", "rate limited")
			assert.strictEqual((yield* sourceRow(testDb))?.last_poll_error, limited.error)

			fake.state.projectsStatus = null
			const held = yield* service.discoverOrg(ORG)
			assert.strictEqual(held.skipped, "lease held")
			yield* TestClock.adjust("61 seconds")
			const resumed = yield* service.discoverOrg(ORG)
			assert.isNull(resumed.error)
			assert.isNull(resumed.skipped)
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("the hourly sweep only discovers connections that are due", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ projects: [fakeProject(REF_A)] })
		return Effect.gen(function* () {
			const service = yield* SupabaseConnectionService
			yield* connect(fake)
			const listed = apiCalls(fake, "/v1/projects")
			assert.deepStrictEqual(yield* service.discoverAllOrgs(), {
				orgs: 0,
				discovered: 0,
				skipped: 0,
				failures: 0,
			})
			yield* TestClock.adjust("1 hour")
			assert.deepStrictEqual(yield* service.discoverAllOrgs(), {
				orgs: 1,
				discovered: 1,
				skipped: 0,
				failures: 0,
			})
			assert.strictEqual(apiCalls(fake, "/v1/projects"), listed + 1)
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("reconnecting to a different Supabase organization removes the old one's projects", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ projects: [fakeProject(REF_A), fakeProject(REF_B)] })
		return Effect.gen(function* () {
			yield* connect(fake)
			const other = { id: "otherorgidotherorgid", slug: "otherorg", name: "Other" }
			fake.state.organizations = [other]
			fake.state.projects = [
				fakeProject(REF_C, { organization_id: other.id, organization_slug: other.slug }),
			]
			yield* TestClock.adjust("1 minute")

			const status = yield* finalize(fake)
			assert.strictEqual(status.organization?.name, "Other")
			assert.deepStrictEqual(status.projects, [])
			assert.isNotNull((yield* projectRow(testDb, REF_A))?.removed_at ?? null)
			assert.isNotNull((yield* projectRow(testDb, REF_B))?.removed_at ?? null)
			// The new organization is due for the next sweep rather than waiting out the interval.
			assert.strictEqual((yield* (yield* SupabaseConnectionService).discoverAllOrgs()).discovered, 1)
			assert.deepStrictEqual(
				(yield* (yield* SupabaseConnectionService).getStatus(ORG)).projects.map(
					(project) => project.ref,
				),
				[REF_C],
			)
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("reconnecting to the same organization keeps its projects", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ projects: [fakeProject(REF_A)] })
		return Effect.gen(function* () {
			yield* connect(fake)
			const status = yield* finalize(fake)
			assert.deepStrictEqual(
				status.projects.map((project) => project.ref),
				[REF_A],
			)
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("disconnect revokes the grant and removes the connection, projects, source and tokens", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ projects: [fakeProject(REF_A), fakeProject(REF_B)] })
		return Effect.gen(function* () {
			const service = yield* SupabaseConnectionService
			yield* connect(fake)
			assert.deepStrictEqual(yield* service.disconnect(ORG), { disconnected: true })
			assert.strictEqual(apiCalls(fake, "/v1/oauth/revoke"), 1)

			const counts = yield* Effect.promise(() =>
				queryFirstRow<{ connections: number; projects: number; sources: number; grants: number }>(
					testDb,
					`SELECT
						(SELECT count(*)::int FROM supabase_connections) AS connections,
						(SELECT count(*)::int FROM supabase_projects) AS projects,
						(SELECT count(*)::int FROM sources WHERE platform = 'supabase') AS sources,
						(SELECT count(*)::int FROM oauth_connections WHERE provider = 'supabase') AS grants`,
				),
			)
			assert.deepStrictEqual(counts, { connections: 0, projects: 0, sources: 0, grants: 0 })
			assert.isFalse((yield* service.getStatus(ORG)).connected)
			assert.deepStrictEqual(yield* service.disconnect(ORG), { disconnected: false })
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})
})
