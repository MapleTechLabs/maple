import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import { OrgId, UserId } from "@maple/domain/http"
import { SourceId, SupabaseProjectRef } from "@maple/domain/primitives"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/platform/test-pglite"
import { SupabaseOAuthService } from "@maple/backend/services/auth/SupabaseOAuthService"
import { publicSourceId } from "@maple/backend/services/org/integration-sources"
import {
	FAKE_CLIENT_ID,
	FAKE_CLIENT_SECRET,
	type FakeLogRow,
	fakeProject,
	makeFakeSupabase,
} from "./supabase/__fixtures__/fake-supabase-api"
import sample from "./supabase/__fixtures__/supabase-logs-sample.json" with { type: "json" }
import { SupabaseConnectionService } from "./SupabaseConnectionService"
import { SupabaseLogsService } from "./SupabaseLogsService"

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
/** Where a freshly enabled project starts, and where its first window ends. */
const ENABLED_FROM = NOW - 5 * minute
const HORIZON = NOW - minute

const IngestBody = Schema.Struct({
	resourceLogs: Schema.Array(
		Schema.Struct({
			resource: Schema.Struct({
				attributes: Schema.Array(
					Schema.Struct({
						key: Schema.String,
						value: Schema.Struct({ stringValue: Schema.String }),
					}),
				),
			}),
			scopeLogs: Schema.Array(
				Schema.Struct({
					logRecords: Schema.Array(
						Schema.Struct({
							timeUnixNano: Schema.String,
							severityText: Schema.String,
							body: Schema.Struct({ stringValue: Schema.String }),
							attributes: Schema.Array(
								Schema.Struct({
									key: Schema.String,
									value: Schema.Struct({ stringValue: Schema.String }),
								}),
							),
						}),
					),
				}),
			),
		}),
	),
})
const decodeIngestBody = Schema.decodeUnknownSync(Schema.fromJsonString(IngestBody))

const SampleRows = Schema.Struct({
	result: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			timestamp: Schema.String,
			source: Schema.String,
			event_message: Schema.String,
			log_attributes: Schema.Record(Schema.String, Schema.String),
		}),
	),
})
const sampleRows = Schema.decodeUnknownSync(SampleRows)(sample).result

/** A fake Supabase plus a fake ingest gateway that records each OTLP body it accepts. */
const makeWorld = () => {
	const supabase = makeFakeSupabase({
		projects: [fakeProject(REF_A, { name: "app" }), fakeProject(REF_B, { name: "billing" })],
	})
	const bodies: Array<typeof IngestBody.Type> = []
	const authorizations: Array<string | null> = []
	/** `failRequest` answers that request (1-based, counted across ticks) with a 503, once. */
	const ingest = { status: 200, bodies, authorizations, requests: 0, failRequest: 0 }
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const requestInit: RequestInit & { readonly duplex: "half" } = { ...init, duplex: "half" }
		const request = new Request(input, requestInit)
		if (new URL(request.url).host !== "ingest.example.com") return supabase.fetch(input, init)
		const text = await request.text()
		ingest.requests += 1
		if (ingest.requests === ingest.failRequest) return new Response("unavailable", { status: 503 })
		if (ingest.status >= 300) return new Response("unavailable", { status: ingest.status })
		ingest.bodies.push(decodeIngestBody(text))
		ingest.authorizations.push(request.headers.get("authorization"))
		return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
	}
	return { supabase, ingest, fetch }
}
type World = ReturnType<typeof makeWorld>

const makeLayer = (testDb: TestDb, world: World) =>
	Layer.mergeAll(
		SupabaseLogsService.layer,
		SupabaseConnectionService.layer,
		SupabaseOAuthService.layer,
	).pipe(
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
		Layer.merge(Layer.succeed(FetchHttpClient.Fetch, world.fetch)),
	)

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asRef = Schema.decodeUnknownSync(SupabaseProjectRef)
const ORG = asOrgId("org_a")
const REF_A = "abcdefghijklmnopqrst"
const REF_B = "bcdefghijklmnopqrstu"

/** Connects Supabase through the OAuth callback's sequence and turns on logs for project A. */
const connectWithLogs = (world: World) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		const oauth = yield* SupabaseOAuthService
		const connection = yield* SupabaseConnectionService
		const { redirectUrl, state } = yield* oauth.startConnect(ORG, asUserId("user_a"), {
			callbackUrl: "https://api.example.com/api/integrations/supabase/callback",
		})
		world.supabase.state.codeChallenge = new URL(redirectUrl).searchParams.get("code_challenge")
		const granted = yield* oauth.completeConnect("code", state)
		yield* connection.finalizeConnect(granted.orgId, granted.connectedByUserId, granted.organization)
		yield* connection.sync(granted.orgId)
		yield* (yield* SupabaseLogsService).setLogsEnabled(ORG, asRef(REF_A), true)
	})

const logsRow = (testDb: TestDb, ref = REF_A) =>
	Effect.promise(() =>
		queryFirstRow<{
			watermark: number | null
			boundary: Array<string>
			error: string | null
			polled: number | null
		}>(
			testDb,
			`SELECT (extract(epoch FROM logs_watermark_at) * 1000)::float8 AS watermark, logs_boundary_ids AS boundary,
			 logs_error AS error, (extract(epoch FROM logs_last_polled_at) * 1000)::float8 AS polled
			 FROM supabase_projects WHERE project_ref = $1`,
			[ref],
		),
	).pipe(Effect.map((row) => row!))

const logsCalls = (world: World, ref = REF_A) =>
	world.supabase.state.calls.filter((call) => call.path === `/v1/projects/${ref}/analytics/endpoints/logs`)

const sentRecords = (world: World) =>
	world.ingest.bodies.flatMap((body) =>
		body.resourceLogs.flatMap((resource) => resource.scopeLogs.flatMap((scope) => scope.logRecords)),
	)

const uidOf = (record: { attributes: ReadonlyArray<{ key: string; value: { stringValue: string } }> }) =>
	record.attributes.find((attribute) => attribute.key === "log.record.uid")?.value.stringValue

/** `2026-10-21T17:55:00.000000`-style column text for an epoch ms. */
const columnTime = (ms: number) => new Date(ms).toISOString().replace("Z", "000")

const row = (id: string, ms: number, overrides: Partial<FakeLogRow> = {}): FakeLogRow => ({
	id,
	timestamp: columnTime(ms),
	source: "postgres_logs",
	event_message: `message ${id}`,
	log_attributes: { "parsed.error_severity": "LOG" },
	...overrides,
})

const run = <A, E>(
	testDb: TestDb,
	world: World,
	effect: Effect.Effect<A, E, SupabaseLogsService | SupabaseConnectionService | SupabaseOAuthService>,
) => effect.pipe(Effect.provide(makeLayer(testDb, world)))

describe("SupabaseLogsService", () => {
	it.effect(
		"the first poll reads the five minutes before enabling up to a minute ago and sends them as OTLP logs",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = makeWorld()
			const fixture = sampleRows.find(
				(item) =>
					item.source === "postgres_logs" &&
					item.log_attributes["parsed.error_severity"] === "ERROR",
			)!
			world.supabase.state.logs = [
				row("too-old", ENABLED_FROM - 1),
				{ ...fixture, timestamp: "2026-10-21T17:55:30.123456" },
				row("too-new", HORIZON + 10),
			]
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					yield* connectWithLogs(world)
					const summary = yield* (yield* SupabaseLogsService).pollAllOrgs()
					assert.deepStrictEqual(summary, { orgs: 1, rows: 1, failures: 0, skipped: 0 })

					const [call] = logsCalls(world)
					assert.strictEqual(
						call?.search.get("sql"),
						"select id, timestamp, source, event_message, log_attributes from logs where timestamp >= '2026-10-21 17:55:00.000000' and timestamp < '2026-10-21 17:59:00.000000' order by timestamp asc, id asc limit 1000",
					)
					// Only project A opted in; B is never queried.
					assert.strictEqual(logsCalls(world, REF_B).length, 0)

					const records = sentRecords(world)
					assert.deepStrictEqual(records.map(uidOf), [fixture.id])
					assert.strictEqual(records[0]!.severityText, "ERROR")
					assert.strictEqual(records[0]!.timeUnixNano, `${(ENABLED_FROM + 30_000) / 1000}123456000`)
					assert.strictEqual(records[0]!.body.stringValue, fixture.event_message)

					const sourceId = yield* Effect.promise(() =>
						queryFirstRow<{ source_id: string }>(
							testDb,
							"SELECT source_id FROM supabase_connections WHERE org_id = $1",
							[ORG],
						),
					)
					const resource = Object.fromEntries(
						world.ingest.bodies[0]!.resourceLogs[0]!.resource.attributes.map((attribute) => [
							attribute.key,
							attribute.value.stringValue,
						]),
					)
					assert.deepStrictEqual(resource, {
						"service.name": "supabase",
						"supabase.project.ref": REF_A,
						"supabase.project.name": "app",
						"supabase.project.region": "us-east-1",
						"supabase.organization.slug": "jylmnjimcybytpydxgbu",
						maple_source_id: publicSourceId(
							Schema.decodeUnknownSync(SourceId)(sourceId!.source_id),
						),
					})
					assert.match(world.ingest.authorizations[0] ?? "", /^Bearer /)

					const after = yield* logsRow(testDb)
					assert.strictEqual(after.watermark, HORIZON)
					assert.deepStrictEqual(after.boundary, [])
					assert.strictEqual(after.polled, NOW)

					const status = yield* (yield* SupabaseConnectionService).getStatus(ORG)
					const project = status.projects.find((item) => item.ref === REF_A)
					assert.deepStrictEqual(
						[project?.logsEnabled, project?.logsLastPolledAt, project?.logsError],
						[true, NOW, null],
					)
				}),
			)
		},
	)

	it.effect(
		"pages through full pages and never sends a row twice when rows share the boundary timestamp",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = makeWorld()
			const distinct = Array.from({ length: 2997 }, (_, i) =>
				row(`r-${String(i).padStart(4, "0")}`, ENABLED_FROM + i),
			)
			// Auth logs carry whole seconds, so several rows share one timestamp across a page edge.
			const shared = Array.from({ length: 5 }, (_, i) =>
				row(`s-${i}`, ENABLED_FROM + 5_000, { source: "auth_logs" }),
			)
			world.supabase.state.logs = [...distinct, ...shared]
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					yield* connectWithLogs(world)
					const logs = yield* SupabaseLogsService

					yield* logs.pollAllOrgs()
					// Three full pages in one tick, the rate-limit budget for a lagging project.
					assert.strictEqual(logsCalls(world).length, 3)
					const first = yield* logsRow(testDb)
					assert.strictEqual(first.watermark, ENABLED_FROM + 5_000)
					assert.deepStrictEqual(first.boundary, ["s-0"])

					yield* TestClock.adjust(minute)
					yield* logs.pollAllOrgs()
					const ids = sentRecords(world).map(uidOf)
					assert.strictEqual(ids.length, 3002)
					assert.strictEqual(new Set(ids).size, 3002)
					const caughtUp = yield* logsRow(testDb)
					assert.strictEqual(caughtUp.watermark, HORIZON + minute)
					assert.deepStrictEqual(caughtUp.boundary, [])
				}),
			)
		},
	)

	it.effect("a 429 keeps the watermark and records no error", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeWorld()
		world.supabase.state.logs = [row("a", ENABLED_FROM + 1_000)]
		world.supabase.state.logsStatus = 429
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connectWithLogs(world)
				const summary = yield* (yield* SupabaseLogsService).pollAllOrgs()
				assert.strictEqual(summary.failures, 0)
				const after = yield* logsRow(testDb)
				assert.deepStrictEqual(
					[after.watermark, after.error, after.polled],
					[ENABLED_FROM, null, null],
				)
				assert.strictEqual(world.ingest.bodies.length, 0)
			}),
		)
	})

	it.effect("a refused query records logsError and keeps the watermark", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeWorld()
		world.supabase.state.logsQueryError = "Unknown field: log_level"
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connectWithLogs(world)
				const summary = yield* (yield* SupabaseLogsService).pollAllOrgs()
				assert.strictEqual(summary.failures, 1)
				const after = yield* logsRow(testDb)
				assert.strictEqual(after.watermark, ENABLED_FROM)
				assert.strictEqual(after.error, "Supabase refused the logs query: Unknown field: log_level")
				const status = yield* (yield* SupabaseConnectionService).getStatus(ORG)
				assert.strictEqual(status.projects.find((item) => item.ref === REF_A)?.logsError, after.error)
			}),
		)
	})

	it.effect("an ingest failure does not advance the watermark, and the next poll resends the rows", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeWorld()
		world.supabase.state.logs = [row("a", ENABLED_FROM + 1_000)]
		world.ingest.status = 503
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connectWithLogs(world)
				const logs = yield* SupabaseLogsService
				yield* logs.pollAllOrgs()
				const failed = yield* logsRow(testDb)
				assert.strictEqual(failed.watermark, ENABLED_FROM)
				assert.match(failed.error ?? "", /Supabase logs ingest returned 503/)

				world.ingest.status = 200
				yield* TestClock.adjust(minute)
				yield* logs.pollAllOrgs()
				assert.deepStrictEqual(sentRecords(world).map(uidOf), ["a"])
				const recovered = yield* logsRow(testDb)
				assert.deepStrictEqual([recovered.watermark, recovered.error], [HORIZON + minute, null])
			}),
		)
	})

	it.effect("a failed chunk resumes after the last accepted one, so no row is sent twice", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeWorld()
		// Three rows per millisecond, so the first chunk edge (row 250) splits a millisecond.
		world.supabase.state.logs = Array.from({ length: 600 }, (_, i) =>
			row(`r-${String(i).padStart(4, "0")}`, ENABLED_FROM + Math.floor(i / 3)),
		)
		world.ingest.failRequest = 2
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connectWithLogs(world)
				const logs = yield* SupabaseLogsService
				yield* logs.pollAllOrgs()
				assert.strictEqual(sentRecords(world).length, 250)
				const failed = yield* logsRow(testDb)
				assert.strictEqual(failed.watermark, ENABLED_FROM + 83)
				assert.deepStrictEqual(failed.boundary, ["r-0249"])
				assert.match(failed.error ?? "", /Supabase logs ingest returned 503/)

				yield* TestClock.adjust(minute)
				yield* logs.pollAllOrgs()
				const ids = sentRecords(world).map(uidOf)
				assert.strictEqual(ids.length, 600)
				assert.strictEqual(new Set(ids).size, 600)
				const recovered = yield* logsRow(testDb)
				assert.deepStrictEqual([recovered.watermark, recovered.error], [HORIZON + minute, null])
			}),
		)
	})

	it.effect("turning logs off and on after an ingest refusal polls on the next tick", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeWorld()
		world.supabase.state.logs = [row("a", ENABLED_FROM + 1_000)]
		world.ingest.status = 402
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connectWithLogs(world)
				const logs = yield* SupabaseLogsService
				yield* logs.pollAllOrgs()
				assert.strictEqual(logsCalls(world).length, 1)

				world.ingest.status = 200
				yield* logs.setLogsEnabled(ORG, asRef(REF_A), false)
				yield* logs.setLogsEnabled(ORG, asRef(REF_A), true)
				yield* TestClock.adjust(minute)
				yield* logs.pollAllOrgs()
				assert.strictEqual(logsCalls(world).length, 2)
				assert.deepStrictEqual(sentRecords(world).map(uidOf), ["a"])
			}),
		)
	})

	it.effect("an ingest refusal holds the project for an hour, then polling resumes", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeWorld()
		world.supabase.state.logs = [row("a", ENABLED_FROM + 1_000)]
		world.ingest.status = 402
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connectWithLogs(world)
				const logs = yield* SupabaseLogsService
				yield* logs.pollAllOrgs()
				assert.strictEqual(logsCalls(world).length, 1)

				world.ingest.status = 200
				yield* Effect.forEach([1, 2, 30, 59], (minutes) =>
					TestClock.setTime(NOW + minutes * minute).pipe(Effect.andThen(logs.pollAllOrgs())),
				)
				assert.strictEqual(logsCalls(world).length, 1)
				assert.strictEqual(world.ingest.bodies.length, 0)

				yield* TestClock.setTime(NOW + 61 * minute)
				yield* logs.pollAllOrgs()
				assert.isAbove(logsCalls(world).length, 1)
				assert.deepStrictEqual(sentRecords(world).map(uidOf), ["a"])
			}),
		)
	})

	it.effect("a paused source reads nothing and its watermark follows the clock", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeWorld()
		world.supabase.state.logs = [row("a", ENABLED_FROM + 1_000)]
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connectWithLogs(world)
				yield* Effect.promise(() =>
					queryFirstRow(
						testDb,
						"UPDATE sources SET paused_at = $1 WHERE id = (SELECT source_id FROM supabase_connections WHERE org_id = $2) RETURNING id",
						[new Date(NOW - minute), ORG],
					),
				)
				const summary = yield* (yield* SupabaseLogsService).pollAllOrgs()
				assert.strictEqual(summary.skipped, 1)
				assert.strictEqual(logsCalls(world).length, 0)
				assert.strictEqual((yield* logsRow(testDb)).watermark, HORIZON)
			}),
		)
	})

	it.effect(
		"toggling: on starts five minutes back, a repeated on keeps progress, off stops polling",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = makeWorld()
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					yield* connectWithLogs(world)
					const logs = yield* SupabaseLogsService
					assert.strictEqual((yield* logsRow(testDb)).watermark, ENABLED_FROM)
					yield* logs.pollAllOrgs()
					yield* logs.setLogsEnabled(ORG, asRef(REF_A), true)
					assert.strictEqual((yield* logsRow(testDb)).watermark, HORIZON)

					yield* logs.setLogsEnabled(ORG, asRef(REF_A), false)
					yield* TestClock.adjust(minute)
					const calls = logsCalls(world).length
					assert.deepStrictEqual(yield* logs.pollAllOrgs(), {
						orgs: 0,
						rows: 0,
						failures: 0,
						skipped: 0,
					})
					assert.strictEqual(logsCalls(world).length, calls)

					const missing = yield* Effect.flip(
						logs.setLogsEnabled(ORG, asRef("zzzzzzzzzzzzzzzzzzzz"), true),
					)
					assert.strictEqual(missing._tag, "@maple/http/errors/IntegrationsNotFoundError")
				}),
			)
		},
	)

	it.effect("polling cannot start next to a drain to Maple set up in Supabase", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeWorld()
		world.supabase.state.drains.set(REF_B, [
			{
				id: "drain-manual",
				attributes: {
					name: "maple by hand",
					backend_type: "otlp",
					config: { endpoint: "https://ingest.example.com/v1/logs" },
				},
			},
		])
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connectWithLogs(world)
				const refused = yield* Effect.flip(
					(yield* SupabaseLogsService).setLogsEnabled(ORG, asRef(REF_B), true),
				)
				assert.strictEqual(refused._tag, "@maple/http/errors/IntegrationsValidationError")
				assert.include(refused.message, "maple by hand")
			}),
		)
	})

	it.effect("polling turns on once a hand-made Maple drain is deleted, despite the older snapshot", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeWorld()
		world.supabase.state.drains.set(REF_B, [
			{
				id: "drain-manual",
				attributes: {
					name: "maple by hand",
					backend_type: "otlp",
					config: { endpoint: "https://ingest.example.com/v1/logs" },
				},
			},
		])
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connectWithLogs(world)
				world.supabase.state.drains.set(REF_B, [])
				const connection = yield* SupabaseConnectionService
				// The route's order: the project PATCH (live listing) first, then the polling switch.
				yield* connection.updateProject(ORG, asUserId("user_a"), asRef(REF_B), { logsEnabled: true })
				yield* (yield* SupabaseLogsService).setLogsEnabled(ORG, asRef(REF_B), true)
				const project = (yield* connection.getStatus(ORG)).projects.find((item) => item.ref === REF_B)
				assert.deepStrictEqual([project?.logsEnabled, project?.logDrains], [true, []])
			}),
		)
	})

	it.effect("polling cannot start while a log drain delivers the project's logs", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeWorld()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connectWithLogs(world)
				const connection = yield* SupabaseConnectionService
				const logs = yield* SupabaseLogsService
				const user = asUserId("user_a")
				const drained = yield* connection.updateProject(ORG, user, asRef(REF_A), {
					logDrainEnabled: true,
				})
				assert.isFalse(drained.projects.find((project) => project.ref === REF_A)?.logsEnabled ?? true)

				const refused = yield* Effect.flip(logs.setLogsEnabled(ORG, asRef(REF_A), true))
				assert.strictEqual(refused._tag, "@maple/http/errors/IntegrationsValidationError")
				yield* TestClock.adjust(minute)
				const calls = logsCalls(world).length
				yield* logs.pollAllOrgs()
				assert.strictEqual(logsCalls(world).length, calls)

				// Drain off first, then polling on: the switch back works.
				yield* connection.updateProject(ORG, user, asRef(REF_A), { logDrainEnabled: false })
				yield* logs.setLogsEnabled(ORG, asRef(REF_A), true)
				const status = yield* connection.getStatus(ORG)
				const project = status.projects.find((item) => item.ref === REF_A)
				assert.deepStrictEqual([project?.logDrainEnabled, project?.logsEnabled], [false, true])
			}),
		)
	})
})
