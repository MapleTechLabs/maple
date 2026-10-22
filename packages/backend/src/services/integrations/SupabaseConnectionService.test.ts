import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import { OrgId, UserId } from "@maple/domain/http"
import { SupabaseProjectRef } from "@maple/domain/primitives"
import { Env } from "@maple/backend/platform/Env"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { SupabaseOAuthService } from "@maple/backend/services/auth/SupabaseOAuthService"
import {
	FAKE_CLIENT_ID,
	FAKE_CLIENT_SECRET,
	type FakeCall,
	type FakeLogDrain,
	fakeProject,
	makeFakeSupabase,
} from "./supabase/__fixtures__/fake-supabase-api"
import { mapleDrainDescription, SupabaseConnectionService } from "./SupabaseConnectionService"

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
const USER = asUserId("user_a")

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
				yield* service.updateProject(ORG, USER, asRef(REF_B), { metricsEnabled: false })

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
			const status = yield* service.updateProject(ORG, USER, asRef(REF_A), { metricsEnabled: false })
			assert.isFalse(status.projects[0]?.metricsEnabled ?? true)
			const error = yield* service
				.updateProject(ORG, USER, asRef(OTHER_ORG_REF), { metricsEnabled: true })
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

const drainRow = (testDb: TestDb, ref: string) =>
	Effect.promise(() =>
		queryFirstRow<{
			log_drain_enabled: boolean
			log_drain_id: string | null
			log_drain_source_id: string | null
			log_drain_error: string | null
			logs_enabled: boolean
		}>(
			testDb,
			"SELECT log_drain_enabled, log_drain_id, log_drain_source_id, log_drain_error, logs_enabled FROM supabase_projects WHERE project_ref = $1",
			[ref],
		),
	)

const tokenSourceCount = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{ count: number }>(
			testDb,
			"SELECT count(*)::int AS count FROM sources WHERE kind = 'token'",
		),
	).pipe(Effect.map((row) => row?.count ?? -1))

const drainCalls = (fake: Fake, method: string) =>
	fake.state.calls.filter(
		(call: FakeCall) => call.method === method && call.path.includes("/analytics/log-drains"),
	)

const DrainBody = Schema.fromJsonString(
	Schema.Struct({
		data: Schema.Struct({
			type: Schema.String,
			attributes: Schema.Struct({
				name: Schema.String,
				backend_type: Schema.String,
				config: Schema.Struct({
					endpoint: Schema.String,
					protocol: Schema.String,
					gzip: Schema.Boolean,
					headers: Schema.Record(Schema.String, Schema.String),
				}),
			}),
		}),
	}),
)

/** Drains a customer set up in the Supabase dashboard, configs as the v2 list returns them. */
const DATADOG_DRAIN: FakeLogDrain = {
	id: "drain-datadog",
	attributes: {
		name: "soc2-archive",
		backend_type: "datadog",
		config: { api_key: "dd-secret-key", region: "US1" },
	},
}
const S3_DRAIN: FakeLogDrain = {
	id: "drain-s3",
	attributes: {
		name: "audit-bucket",
		backend_type: "s3",
		config: { s3_bucket: "acme-audit", access_key_id: "AKIA", secret_access_key: "s3-secret" },
	},
}
const MANUAL_MAPLE_DRAIN: FakeLogDrain = {
	id: "drain-manual-maple",
	attributes: {
		name: "maple by hand",
		backend_type: "otlp",
		config: {
			endpoint: "https://ingest.example.com/v1/logs",
			headers: { Authorization: "Bearer maple_src_handmade" },
		},
	},
}

describe("SupabaseConnectionService log drains", () => {
	it.effect(
		"enabling mints a logs-only token source, creates an OTLP drain that sends as it and stops polling",
		() => {
			const testDb = createTestDb(trackedDbs)
			const fake = makeFakeSupabase({ projects: [fakeProject(REF_A, { name: "app" })] })
			return Effect.gen(function* () {
				const service = yield* SupabaseConnectionService
				yield* connect(fake)
				yield* Effect.promise(() =>
					executeSql(
						testDb,
						"UPDATE supabase_projects SET logs_enabled = true WHERE project_ref = $1",
						[REF_A],
					),
				)
				const status = yield* service.updateProject(ORG, USER, asRef(REF_A), {
					logDrainEnabled: true,
				})

				const [create] = drainCalls(fake, "POST")
				assert.strictEqual(create?.path, `/v2/projects/${REF_A}/analytics/log-drains`)
				const body = Schema.decodeUnknownSync(DrainBody)(create?.body)
				const authorization = body.data.attributes.config.headers.Authorization ?? ""
				assert.deepStrictEqual(
					{ ...body.data.attributes, config: { ...body.data.attributes.config, headers: {} } },
					{
						name: "Maple",
						backend_type: "otlp",
						config: {
							endpoint: "https://ingest.example.com/v1/logs",
							protocol: "http/protobuf",
							gzip: true,
							headers: {},
						},
					},
				)
				assert.strictEqual(body.data.type, "log_drain")
				assert.match(authorization, /^Bearer maple_src_/)

				const row = yield* drainRow(testDb, REF_A)
				const stored = fake.state.drains.get(REF_A) ?? []
				assert.isTrue(row?.log_drain_enabled ?? false)
				assert.strictEqual(row?.log_drain_id, stored[0]?.id)
				// The drain now delivers this project's logs, so polling them too would store them twice.
				assert.isFalse(row?.logs_enabled ?? true)
				const source = yield* Effect.promise(() =>
					queryFirstRow<{
						platform: string
						kind: string
						name: string
						key_prefix: string
						allowed_signals: unknown
						resource_attributes: unknown
					}>(
						testDb,
						"SELECT platform, kind, name, key_prefix, allowed_signals, resource_attributes FROM sources WHERE id = $1",
						[row?.log_drain_source_id ?? ""],
					),
				)
				assert.deepStrictEqual(
					{ platform: source?.platform, kind: source?.kind, name: source?.name },
					{ platform: "supabase", kind: "token", name: "Supabase logs: app" },
				)
				// The drain sends the token this source was minted with.
				assert.isTrue(authorization.startsWith(`Bearer ${source?.key_prefix ?? "?"}`))
				assert.deepStrictEqual(source?.allowed_signals, ["logs"])
				assert.deepStrictEqual(source?.resource_attributes, [
					{ key: "supabase.project.ref", value: REF_A, mode: "set" },
					{ key: "supabase.project.name", value: "app", mode: "set" },
					{ key: "service.name", value: "supabase", mode: "default" },
				])
				const project = status.projects[0]
				assert.deepStrictEqual(
					[
						project?.logDrainEnabled,
						project?.logDrainError,
						project?.logDrainSourceId,
						project?.logsEnabled,
					],
					[true, null, row?.log_drain_source_id, false],
				)
				assert.deepStrictEqual(
					project?.logDrains.map((drain) => [drain.name, drain.toMaple, drain.managedByMaple]),
					[["Maple", true, true]],
				)
			}).pipe(Effect.provide(makeLayer(testDb, fake)))
		},
	)

	it.effect("a Free plan 402 deletes the minted source and surfaces the plan error", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ projects: [fakeProject(REF_A)], drainCreateStatus: 402 })
		return Effect.gen(function* () {
			const service = yield* SupabaseConnectionService
			yield* connect(fake)
			const error = yield* service
				.updateProject(ORG, USER, asRef(REF_A), { logDrainEnabled: true })
				.pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsPlanRequiredError")
			assert.strictEqual(error.message, "Log drains need a Supabase Pro plan or higher.")
			assert.strictEqual(yield* tokenSourceCount(testDb), 0)
			const row = yield* drainRow(testDb, REF_A)
			assert.deepStrictEqual(
				[row?.log_drain_enabled, row?.log_drain_id, row?.log_drain_source_id],
				[false, null, null],
			)
			// A create is never retried, so a slow success cannot become two drains.
			assert.strictEqual(drainCalls(fake, "POST").length, 1)
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("a drain to Maple set up in Supabase blocks enabling, so logs are not stored twice", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ projects: [fakeProject(REF_A)] })
		fake.state.drains.set(REF_A, [MANUAL_MAPLE_DRAIN])
		return Effect.gen(function* () {
			const service = yield* SupabaseConnectionService
			yield* connect(fake)
			const error = yield* service
				.updateProject(ORG, USER, asRef(REF_A), { logDrainEnabled: true })
				.pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
			assert.include(error.message, `"maple by hand"`)
			assert.strictEqual(drainCalls(fake, "POST").length, 0)
			assert.strictEqual(yield* tokenSourceCount(testDb), 0)
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect(
		"a create that fails after Supabase stored it is swept, so no drain is billed unrecorded",
		() => {
			const testDb = createTestDb(trackedDbs)
			const fake = makeFakeSupabase({ projects: [fakeProject(REF_A)] })
			fake.state.drains.set(REF_A, [DATADOG_DRAIN])
			fake.state.drainCreateFailsAfterStore = true
			return Effect.gen(function* () {
				const service = yield* SupabaseConnectionService
				yield* connect(fake)
				const error = yield* service
					.updateProject(ORG, USER, asRef(REF_A), { logDrainEnabled: true })
					.pipe(Effect.flip)
				assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsUpstreamError")
				assert.deepStrictEqual(fake.state.drains.get(REF_A), [DATADOG_DRAIN])
				assert.strictEqual(yield* tokenSourceCount(testDb), 0)
			}).pipe(Effect.provide(makeLayer(testDb, fake)))
		},
	)

	it.effect("a Maple drain no row records is replaced on enable, not mistaken for a hand-made one", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ projects: [fakeProject(REF_A)] })
		const orphan: FakeLogDrain = {
			id: "drain-orphan",
			attributes: {
				name: "Maple",
				description: mapleDrainDescription("org_a", "ingest.example.com"),
				backend_type: "otlp",
				config: { endpoint: "https://ingest.example.com/v1/logs" },
			},
		}
		fake.state.drains.set(REF_A, [orphan])
		return Effect.gen(function* () {
			const service = yield* SupabaseConnectionService
			const connected = yield* connect(fake)
			assert.deepStrictEqual(
				connected.projects[0]?.logDrains.map((drain) => [drain.id, drain.managedByMaple]),
				[["drain-orphan", true]],
			)
			const status = yield* service.updateProject(ORG, USER, asRef(REF_A), { logDrainEnabled: true })
			const stored = fake.state.drains.get(REF_A) ?? []
			assert.strictEqual(stored.length, 1)
			assert.notStrictEqual(stored[0]?.id, "drain-orphan")
			assert.deepStrictEqual(
				status.projects[0]?.logDrains.map((drain) => drain.id),
				[stored[0]?.id],
			)
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("another org's or deployment's Maple drain is treated as foreign and never swept", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ projects: [fakeProject(REF_A)] })
		const elsewhere: FakeLogDrain = {
			id: "drain-other-install",
			attributes: {
				name: "Maple",
				description: mapleDrainDescription("org_other", "ingest.eu.example.com"),
				backend_type: "otlp",
				config: { endpoint: "https://ingest.eu.example.com/v1/logs" },
			},
		}
		fake.state.drains.set(REF_A, [elsewhere])
		return Effect.gen(function* () {
			const service = yield* SupabaseConnectionService
			const connected = yield* connect(fake)
			assert.deepStrictEqual(
				connected.projects[0]?.logDrains.map((drain) => [drain.managedByMaple, drain.toMaple]),
				[[false, false]],
			)
			yield* service.updateProject(ORG, USER, asRef(REF_A), { logDrainEnabled: true })
			const ids = (fake.state.drains.get(REF_A) ?? []).map((drain) => drain.id)
			assert.strictEqual(ids.length, 2)
			assert.include(ids, "drain-other-install")
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("a disable that lands while the drain is being created wins, and the drain is undone", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ projects: [fakeProject(REF_A)] })
		return Effect.gen(function* () {
			const service = yield* SupabaseConnectionService
			yield* connect(fake)
			// The disable's write, as it lands between the create and the enable's final write.
			fake.state.afterDrainCreate = () =>
				executeSql(
					testDb,
					"UPDATE supabase_projects SET log_drain_enabled = false WHERE project_ref = $1 AND log_drain_id IS NULL",
					[REF_A],
				)
			const status = yield* service.updateProject(ORG, USER, asRef(REF_A), { logDrainEnabled: true })
			assert.isFalse(status.projects[0]?.logDrainEnabled ?? true)
			assert.deepStrictEqual(fake.state.drains.get(REF_A), [])
			assert.strictEqual(yield* tokenSourceCount(testDb), 0)
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("asking for a drain and polling at once is refused", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ projects: [fakeProject(REF_A)] })
		return Effect.gen(function* () {
			const service = yield* SupabaseConnectionService
			yield* connect(fake)
			const error = yield* service
				.updateProject(ORG, USER, asRef(REF_A), { logDrainEnabled: true, logsEnabled: true })
				.pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
			assert.strictEqual(drainCalls(fake, "POST").length, 0)
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("discovery lists every project's drains by destination, never their secrets", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ projects: [fakeProject(REF_A), fakeProject(REF_B)] })
		fake.state.drains.set(REF_A, [DATADOG_DRAIN, S3_DRAIN])
		fake.state.drains.set(REF_B, [MANUAL_MAPLE_DRAIN])
		return Effect.gen(function* () {
			const status = yield* connect(fake)
			const byRef = new Map(status.projects.map((project) => [project.ref, project]))
			assert.deepStrictEqual(byRef.get(asRef(REF_A))?.logDrains, [
				{
					id: "drain-datadog",
					name: "soc2-archive",
					backendType: "datadog",
					destination: "US1",
					toMaple: false,
					managedByMaple: false,
				},
				{
					id: "drain-s3",
					name: "audit-bucket",
					backendType: "s3",
					destination: "s3://acme-audit",
					toMaple: false,
					managedByMaple: false,
				},
			])
			assert.deepStrictEqual(byRef.get(asRef(REF_B))?.logDrains, [
				{
					id: "drain-manual-maple",
					name: "maple by hand",
					backendType: "otlp",
					destination: "ingest.example.com",
					toMaple: true,
					managedByMaple: false,
				},
			])
			assert.strictEqual(byRef.get(asRef(REF_A))?.logDrainsCheckedAt, 0)
			const stored = yield* Effect.promise(() =>
				queryFirstRow<{ text: string }>(
					testDb,
					"SELECT string_agg(log_drains_json::text, ' ') AS text FROM supabase_projects",
				),
			)
			for (const secret of ["dd-secret-key", "s3-secret", "maple_src_handmade"]) {
				assert.notInclude(stored?.text ?? "", secret)
			}
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("a refused drain listing keeps the last snapshot and does not fail discovery", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ projects: [fakeProject(REF_A)] })
		fake.state.drains.set(REF_A, [DATADOG_DRAIN])
		return Effect.gen(function* () {
			const service = yield* SupabaseConnectionService
			yield* connect(fake)
			fake.state.drainListStatus = 403
			fake.state.drains.set(REF_A, [])
			yield* TestClock.adjust("1 hour")
			const summary = yield* service.discoverOrg(ORG)
			assert.isNull(summary.error)
			const project = (yield* service.getStatus(ORG)).projects[0]
			assert.deepStrictEqual(
				project?.logDrains.map((drain) => drain.id),
				["drain-datadog"],
			)
			assert.strictEqual(project?.logDrainsCheckedAt, 0)
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("disabling deletes the drain upstream and its source, then clears the row", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ projects: [fakeProject(REF_A)] })
		fake.state.drains.set(REF_A, [DATADOG_DRAIN])
		return Effect.gen(function* () {
			const service = yield* SupabaseConnectionService
			yield* connect(fake)
			yield* service.updateProject(ORG, USER, asRef(REF_A), { logDrainEnabled: true })
			const drainId = (yield* drainRow(testDb, REF_A))?.log_drain_id
			const status = yield* service.updateProject(ORG, USER, asRef(REF_A), { logDrainEnabled: false })

			assert.deepStrictEqual(
				drainCalls(fake, "DELETE").map((call) => call.path),
				[`/v2/projects/${REF_A}/analytics/log-drains/${drainId ?? "?"}`],
			)
			// The customer's own drain is never touched.
			assert.deepStrictEqual(fake.state.drains.get(REF_A), [DATADOG_DRAIN])
			assert.strictEqual(yield* tokenSourceCount(testDb), 0)
			assert.isFalse(status.projects[0]?.logDrainEnabled ?? true)
			assert.deepStrictEqual(
				status.projects[0]?.logDrains.map((drain) => drain.id),
				["drain-datadog"],
			)
			assert.isNull((yield* drainRow(testDb, REF_A))?.log_drain_id ?? null)
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect("disabling a drain already deleted upstream still cleans up", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ projects: [fakeProject(REF_A)] })
		return Effect.gen(function* () {
			const service = yield* SupabaseConnectionService
			yield* connect(fake)
			yield* service.updateProject(ORG, USER, asRef(REF_A), { logDrainEnabled: true })
			fake.state.drains.clear()
			const status = yield* service.updateProject(ORG, USER, asRef(REF_A), { logDrainEnabled: false })
			assert.isFalse(status.projects[0]?.logDrainEnabled ?? true)
			assert.strictEqual(yield* tokenSourceCount(testDb), 0)
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})

	it.effect(
		"disconnect deletes Maple's drains upstream and their sources, and leaves the customer's",
		() => {
			const testDb = createTestDb(trackedDbs)
			const fake = makeFakeSupabase({ projects: [fakeProject(REF_A), fakeProject(REF_B)] })
			fake.state.drains.set(REF_A, [DATADOG_DRAIN])
			return Effect.gen(function* () {
				const service = yield* SupabaseConnectionService
				yield* connect(fake)
				yield* service.updateProject(ORG, USER, asRef(REF_A), { logDrainEnabled: true })
				yield* service.updateProject(ORG, USER, asRef(REF_B), { logDrainEnabled: true })
				assert.strictEqual(yield* tokenSourceCount(testDb), 2)

				yield* service.disconnect(ORG)
				assert.deepStrictEqual(
					[fake.state.drains.get(REF_A), fake.state.drains.get(REF_B)],
					[[DATADOG_DRAIN], []],
				)
				assert.strictEqual(yield* tokenSourceCount(testDb), 0)
			}).pipe(Effect.provide(makeLayer(testDb, fake)))
		},
	)

	it.effect("discovery flags a drain deleted upstream or a deleted source, and never recreates it", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFakeSupabase({ projects: [fakeProject(REF_A), fakeProject(REF_B)] })
		return Effect.gen(function* () {
			const service = yield* SupabaseConnectionService
			yield* connect(fake)
			yield* service.updateProject(ORG, USER, asRef(REF_A), { logDrainEnabled: true })
			yield* service.updateProject(ORG, USER, asRef(REF_B), { logDrainEnabled: true })
			fake.state.drains.set(REF_A, [])
			const sourceB = (yield* drainRow(testDb, REF_B))?.log_drain_source_id ?? ""
			yield* Effect.promise(() => executeSql(testDb, "DELETE FROM sources WHERE id = $1", [sourceB]))
			const creates = drainCalls(fake, "POST").length

			yield* TestClock.adjust("1 hour")
			yield* service.discoverOrg(ORG)
			const status = yield* service.getStatus(ORG)
			const byRef = new Map(status.projects.map((project) => [project.ref, project]))
			assert.include(byRef.get(asRef(REF_A))?.logDrainError ?? "", "removed in Supabase")
			assert.include(
				byRef.get(asRef(REF_B))?.logDrainError ?? "",
				"source this log drain sends as was deleted",
			)
			assert.isTrue(byRef.get(asRef(REF_A))?.logDrainEnabled ?? false)
			assert.strictEqual(drainCalls(fake, "POST").length, creates)

			// Turning it on again (the explicit action) recreates the drain and clears the flag.
			const recreated = yield* service.updateProject(ORG, USER, asRef(REF_A), { logDrainEnabled: true })
			const again = recreated.projects.find((project) => project.ref === REF_A)
			assert.deepStrictEqual([again?.logDrainEnabled, again?.logDrainError], [true, null])
			assert.strictEqual((fake.state.drains.get(REF_A) ?? []).length, 1)
		}).pipe(Effect.provide(makeLayer(testDb, fake)))
	})
})
