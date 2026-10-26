import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, Layer, Option, Ref, Result, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { BillingCustomer, OrgId, UserId } from "@maple/domain/http"
import { AlertDestinationId, UptimeIntervalSeconds, UptimeMonitorId } from "@maple/domain/primitives"
import { UptimeCheckReport, type UptimeMonitorConfig } from "@maple/domain/uptime"
import { Env } from "@maple/backend/platform/Env"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { Database } from "@maple/backend/platform/DatabaseLive"
import {
	UptimeMonitorAllowance,
	uptimeMonitorLimit,
	type UptimeMonitorAllowanceApi,
} from "./UptimeMonitorAllowance"
import { UptimeMonitorsService } from "./UptimeMonitorsService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_uptime")
const OTHER_ORG = Schema.decodeUnknownSync(OrgId)("org_uptime_other")
const USER = Schema.decodeUnknownSync(UserId)("user_uptime")
const UNKNOWN_ID = UptimeMonitorId.make("00000000-0000-4000-8000-000000000000")

const config = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			MCP_PORT: "3473",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_API_BASE_URL: "https://api.maple.test/",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

interface Respond {
	readonly status: number
	readonly body: string
}

const fakeHttp = (respond: Respond) =>
	Layer.succeed(
		HttpClient.HttpClient,
		HttpClient.make((request) =>
			Effect.succeed(
				HttpClientResponse.fromWeb(
					request,
					new Response(respond.body, {
						status: respond.status,
						headers: { "content-type": "text/plain" },
					}),
				),
			),
		),
	)

const makeLayer = (
	testDb: TestDb,
	options: {
		readonly allowance?: Layer.Layer<UptimeMonitorAllowance>
		readonly respond?: Respond
		readonly database?: Layer.Layer<Database>
	} = {},
) =>
	Layer.effect(UptimeMonitorsService, UptimeMonitorsService.make).pipe(
		Layer.provide(options.allowance ?? UptimeMonitorAllowance.unmetered),
		Layer.provide(fakeHttp(options.respond ?? { status: 200, body: "ok" })),
		Layer.provide(options.database ?? testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(config()),
	)

const httpConfig = (url = "https://status.example.com/health"): UptimeMonitorConfig => ({
	_tag: "http",
	url,
	method: "GET",
	headers: {},
	assertions: [{ _tag: "status", op: "is", value: "2xx" }],
	timeoutMs: 5000,
})

const heartbeatConfig: UptimeMonitorConfig = {
	_tag: "heartbeat",
	schedule: { _tag: "interval", seconds: 300 },
	graceSeconds: 60,
}

const report = (monitorId: UptimeMonitorId, checkedAt: number, ok: boolean) =>
	new UptimeCheckReport({
		monitorId,
		checkedAt,
		ok,
		durationMs: 120,
		statusCode: ok ? 200 : 503,
		error: ok ? null : "Status 503, expected 2xx",
		traceId: null,
	})

const createHttp = (name: string, extra: { readonly failuresToDown?: number; readonly orgId?: OrgId } = {}) =>
	Effect.gen(function* () {
		const service = yield* UptimeMonitorsService
		return yield* service.create(extra.orgId ?? ORG, {
			name,
			kind: "http",
			config: httpConfig(),
			intervalSeconds: UptimeIntervalSeconds.make(60),
			...(extra.failuresToDown === undefined ? undefined : { failuresToDown: extra.failuresToDown }),
			createdBy: USER,
		})
	})

describe("UptimeMonitorsService", () => {
	it.effect("creates, lists, updates, pauses, resumes and deletes a monitor", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* UptimeMonitorsService
			const created = yield* createHttp("API health")
			assert.strictEqual(created.state.status, "pending")
			assert.strictEqual(created.failuresToDown, 2)
			assert.isNull(created.heartbeatUrl)
			const other = yield* createHttp("Elsewhere", { orgId: OTHER_ORG })

			const listed = yield* service.list(ORG)
			assert.deepStrictEqual(
				listed.map((monitor) => monitor.name),
				["API health"],
			)

			const renamed = yield* service.update(ORG, created.id, {
				name: "API",
				failuresToDown: 3,
				updatedBy: USER,
			})
			assert.strictEqual(renamed.name, "API")
			assert.strictEqual(renamed.failuresToDown, 3)

			const paused = yield* service.update(ORG, created.id, { enabled: false, updatedBy: USER })
			assert.isFalse(paused.enabled)
			assert.strictEqual(paused.state.status, "paused")
			// The scraper stops probing a paused monitor; other orgs' monitors are unaffected.
			const targets = yield* service.listProbeTargets()
			assert.deepStrictEqual(
				targets.map((target) => target.id),
				[other.id],
			)

			const resumed = yield* service.update(ORG, created.id, { enabled: true, updatedBy: USER })
			assert.strictEqual(resumed.state.status, "pending")

			assert.strictEqual(yield* service.delete(ORG, created.id), created.id)
			const gone = yield* Effect.exit(service.get(ORG, created.id))
			assert.isTrue(Exit.isFailure(gone))
			const again = yield* Effect.flip(service.delete(ORG, created.id))
			assert.strictEqual(again._tag, "@maple/http/errors/UptimeMonitorNotFoundError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("refuses configs that do not match the kind or reach private hosts", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* UptimeMonitorsService
			const attempt = (kind: "http" | "tcp" | "dns", monitorConfig: UptimeMonitorConfig) =>
				Effect.flip(service.create(ORG, { name: "x", kind, config: monitorConfig, createdBy: USER }))

			const mismatch = yield* attempt("tcp", httpConfig())
			assert.strictEqual(mismatch._tag, "@maple/http/errors/UptimeMonitorValidationError")
			const privateUrl = yield* attempt("http", httpConfig("http://169.254.169.254/latest"))
			assert.strictEqual(privateUrl._tag, "@maple/http/errors/UptimeMonitorValidationError")
			const privateTcp = yield* attempt("tcp", {
				_tag: "tcp",
				host: "10.0.0.5",
				port: 5432,
				timeoutMs: 5000,
			})
			assert.strictEqual(privateTcp._tag, "@maple/http/errors/UptimeMonitorValidationError")
			const localDns = yield* attempt("dns", {
				_tag: "dns",
				hostname: "db.internal",
				recordType: "A",
				timeoutMs: 5000,
			})
			assert.strictEqual(localDns._tag, "@maple/http/errors/UptimeMonitorValidationError")
			assert.deepStrictEqual(yield* service.list(ORG), [])
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("goes down after failures_to_down failures in a row and recovers on a success", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* UptimeMonitorsService
			const monitor = yield* createHttp("API", { failuresToDown: 2 })

			// One failure is not enough to go down.
			assert.strictEqual(yield* service.recordChecks([report(monitor.id, 1_000, false)]), 1)
			const once = yield* service.get(ORG, monitor.id)
			assert.strictEqual(once.state.status, "pending")
			assert.strictEqual(once.state.consecutiveFailures, 1)

			yield* service.recordChecks([report(monitor.id, 2_000, false)])
			const down = yield* service.get(ORG, monitor.id)
			assert.strictEqual(down.state.status, "down")
			assert.strictEqual(down.state.statusChangedAt, 2_000)
			assert.strictEqual(down.state.lastCheck?.error, "Status 503, expected 2xx")

			yield* service.recordChecks([report(monitor.id, 3_000, true)])
			const up = yield* service.get(ORG, monitor.id)
			assert.strictEqual(up.state.status, "up")
			assert.strictEqual(up.state.consecutiveFailures, 0)
			assert.strictEqual(up.state.statusChangedAt, 3_000)
			assert.deepStrictEqual(
				up.state.recent.map((check) => [check.at, check.ok]),
				[
					[1_000, false],
					[2_000, false],
					[3_000, true],
				],
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("records the rest of a batch when a monitor is deleted between the read and the write", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			// Counts down per `Database.execute`; the call that sees 1 deletes `doomed` first.
			const countdown = yield* Ref.make(0)
			const doomed = yield* Ref.make("")
			const database = Layer.effect(
				Database,
				Effect.gen(function* () {
					const inner = yield* Database
					return {
						execute: (fn) =>
							Ref.modify(countdown, (n) => [n, n > 0 ? n - 1 : n] as const).pipe(
								Effect.flatMap((n) =>
									n === 1
										? Ref.get(doomed).pipe(
												Effect.flatMap((id) =>
													Effect.promise(() =>
														executeSql(
															testDb,
															"DELETE FROM uptime_monitors WHERE id = $1",
															[id],
														),
													),
												),
											)
										: Effect.void,
								),
								Effect.andThen(inner.execute(fn)),
							),
					}
				}),
			).pipe(Layer.provide(testDb.layer))

			const program = Effect.gen(function* () {
				const service = yield* UptimeMonitorsService
				const kept = yield* createHttp("kept", { failuresToDown: 1 })
				const deleted = yield* createHttp("deleted", { failuresToDown: 1 })
				yield* Ref.set(doomed, deleted.id)
				// The read runs at 2, the write at 1: the monitor vanishes in between.
				yield* Ref.set(countdown, 2)
				const applied = yield* service.recordChecks([
					report(kept.id, 1_000, false),
					report(deleted.id, 1_000, false),
				])
				assert.strictEqual(applied, 1)
				assert.strictEqual((yield* service.get(ORG, kept.id)).state.status, "down")
				assert.deepStrictEqual(
					(yield* service.list(ORG)).map((monitor) => monitor.id),
					[kept.id],
				)
			})
			yield* program.pipe(Effect.provide(makeLayer(testDb, { database })))
		})
	})

	it.effect("applies a batch in time order, skipping unknown monitors and replayed reports", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* UptimeMonitorsService
			const first = yield* createHttp("first", { failuresToDown: 2 })
			const second = yield* createHttp("second", { failuresToDown: 1 })

			const applied = yield* service.recordChecks([
				report(first.id, 2_000, false),
				report(UNKNOWN_ID, 1_500, false),
				report(first.id, 1_000, false),
				report(second.id, 1_000, true),
			])
			assert.strictEqual(applied, 2)
			assert.strictEqual((yield* service.get(ORG, first.id)).state.status, "down")
			assert.strictEqual((yield* service.get(ORG, second.id)).state.status, "up")

			// A retried batch carries checks the state already has: nothing changes.
			assert.strictEqual(yield* service.recordChecks([report(first.id, 2_000, true)]), 0)
			const replayed = yield* service.get(ORG, first.id)
			assert.strictEqual(replayed.state.status, "down")
			assert.strictEqual(replayed.state.recent.length, 2)

			// A paused monitor ignores results that were in flight when it was paused.
			yield* service.update(ORG, second.id, { enabled: false, updatedBy: USER })
			assert.strictEqual(yield* service.recordChecks([report(second.id, 5_000, false)]), 0)
			assert.strictEqual((yield* service.get(ORG, second.id)).state.status, "paused")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("skips a monitor whose stored state no longer decodes and records the rest", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* UptimeMonitorsService
			const healthy = yield* createHttp("healthy", { failuresToDown: 1 })
			const corrupt = yield* createHttp("corrupt", { failuresToDown: 1 })
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`UPDATE uptime_monitor_states SET recent_json = '{"not":"an array"}'::jsonb WHERE monitor_id = $1`,
					[corrupt.id],
				),
			)
			const applied = yield* service.recordChecks([
				report(corrupt.id, 1_000, false),
				report(healthy.id, 1_000, false),
			])
			assert.strictEqual(applied, 1)
			assert.strictEqual((yield* service.get(ORG, healthy.id)).state.status, "down")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("drops results read before a pause and resume instead of overwriting the resumed state", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			// Counts down per `Database.execute`; the call that sees 1 pauses and resumes first.
			const countdown = yield* Ref.make(0)
			const target = yield* Ref.make("")
			const database = Layer.effect(
				Database,
				Effect.gen(function* () {
					const inner = yield* Database
					return {
						execute: (fn) =>
							Ref.modify(countdown, (n) => [n, n > 0 ? n - 1 : n] as const).pipe(
								Effect.flatMap((n) =>
									n === 1
										? Ref.get(target).pipe(
												Effect.flatMap((id) =>
													Effect.promise(() =>
														executeSql(
															testDb,
															`UPDATE uptime_monitor_states SET status = 'pending', consecutive_failures = 0,
																consecutive_successes = 0, updated_at = '1970-01-01T00:00:05.000Z'
															WHERE monitor_id = $1`,
															[id],
														),
													),
												),
											)
										: Effect.void,
								),
								Effect.andThen(inner.execute(fn)),
							),
					}
				}),
			).pipe(Layer.provide(testDb.layer))

			const program = Effect.gen(function* () {
				const service = yield* UptimeMonitorsService
				const monitor = yield* createHttp("API", { failuresToDown: 2 })
				yield* service.recordChecks([report(monitor.id, 1_000, false)])
				yield* Ref.set(target, monitor.id)
				// The read sees one failure; the resume lands before the write.
				yield* Ref.set(countdown, 2)
				assert.strictEqual(yield* service.recordChecks([report(monitor.id, 2_000, false)]), 0)
				const resumed = yield* service.get(ORG, monitor.id)
				assert.strictEqual(resumed.state.status, "pending")
				assert.strictEqual(resumed.state.consecutiveFailures, 0)

				// The next batch reads the resumed state and applies normally.
				assert.strictEqual(yield* service.recordChecks([report(monitor.id, 3_000, false)]), 1)
				const after = yield* service.get(ORG, monitor.id)
				assert.strictEqual(after.state.status, "pending")
				assert.strictEqual(after.state.consecutiveFailures, 1)
			})
			yield* program.pipe(Effect.provide(makeLayer(testDb, { database })))
		})
	})

	it.effect("records heartbeat pings by token", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* UptimeMonitorsService
			const monitor = yield* service.create(ORG, {
				name: "nightly backup",
				kind: "heartbeat",
				config: heartbeatConfig,
				createdBy: USER,
			})
			const url = monitor.heartbeatUrl ?? ""
			assert.match(url, /^https:\/\/api\.maple\.test\/hb\/[A-Za-z0-9_-]{22,}$/u)
			const token = url.slice(url.lastIndexOf("/") + 1)
			assert.deepStrictEqual(yield* service.listProbeTargets(), [])

			yield* service.recordPing(token, true)
			const up = yield* service.get(ORG, monitor.id)
			assert.strictEqual(up.state.status, "up")
			assert.isNotNull(up.state.lastPingAt)

			yield* service.recordPing(token, false)
			const down = yield* service.get(ORG, monitor.id)
			assert.strictEqual(down.state.status, "down")
			assert.strictEqual(down.state.consecutiveFailures, 1)
			assert.deepStrictEqual(
				down.state.recent.map((check) => check.ok),
				[true, false],
			)

			const unknown = yield* Effect.flip(service.recordPing("not-a-real-token-000000", true))
			assert.strictEqual(unknown._tag, "@maple/backend/uptime/HeartbeatNotFound")

			yield* service.update(ORG, monitor.id, { enabled: false, updatedBy: USER })
			const paused = yield* Effect.flip(service.recordPing(token, true))
			assert.strictEqual(paused._tag, "@maple/backend/uptime/HeartbeatNotFound")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect(
		"checks the plan's limit against the org's monitor count and meters creates and deletes",
		() => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const seen = yield* Ref.make<ReadonlyArray<string>>([])
				const allowance: UptimeMonitorAllowanceApi = {
					limit: () =>
						Ref.update(seen, (calls) => [...calls, "limit"]).pipe(Effect.as(Option.some(1))),
					track: (_orgId, _monitorId, delta) =>
						Ref.update(seen, (calls) => [...calls, `track:${delta}`]),
				}
				const program = Effect.gen(function* () {
					const service = yield* UptimeMonitorsService
					const created = yield* createHttp("one")
					const refused = yield* Effect.flip(createHttp("two"))
					assert.strictEqual(refused._tag, "@maple/http/errors/UptimeMonitorLimitReachedError")
					assert.strictEqual((yield* service.list(ORG)).length, 1)
					// The refused create rolled back its backing rule with it.
					const rules = yield* Effect.promise(() =>
						queryFirstRow<{ readonly n: number }>(
							testDb,
							"SELECT count(*)::int AS n FROM alert_rules WHERE org_id = $1",
							[ORG],
						),
					)
					assert.strictEqual(rules?.n, 1)
					yield* service.delete(ORG, created.id)
				})
				yield* program.pipe(
					Effect.provide(
						makeLayer(testDb, { allowance: Layer.succeed(UptimeMonitorAllowance, allowance) }),
					),
				)
				assert.deepStrictEqual(yield* Ref.get(seen), ["limit", "track:1", "limit", "track:-1"])
			})
		},
	)

	it.effect("lets only one of two concurrent creates take the plan's last slot", () => {
		const testDb = createTestDb(trackedDbs)
		const allowance = Layer.succeed(UptimeMonitorAllowance, {
			limit: () => Effect.succeed(Option.some(1)),
			track: () => Effect.void,
		})
		return Effect.gen(function* () {
			const service = yield* UptimeMonitorsService
			const results = yield* Effect.all(
				[Effect.result(createHttp("first")), Effect.result(createHttp("second"))],
				{ concurrency: 2 },
			)
			assert.strictEqual(results.filter(Result.isSuccess).length, 1)
			const refused = results.find(Result.isFailure)
			assert.strictEqual(
				refused === undefined ? null : refused.failure._tag,
				"@maple/http/errors/UptimeMonitorLimitReachedError",
			)
			assert.strictEqual((yield* service.list(ORG)).length, 1)
		}).pipe(Effect.provide(makeLayer(testDb, { allowance })))
	})

	it.effect("tests an HTTP config against its assertions", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* UptimeMonitorsService
			const result = yield* service.testHttp(httpConfig())
			assert.isFalse(result.ok)
			assert.strictEqual(result.statusCode, 503)
			assert.strictEqual(result.failedAssertion, "Status 503, expected 2xx")
			assert.strictEqual(result.bodyPrefix, "x".repeat(2048))
			assert.isTrue(result.bodyTruncated)

			const tcp = yield* Effect.flip(
				service.testHttp({ _tag: "tcp", host: "db.example.com", port: 5432, timeoutMs: 5000 }),
			)
			assert.strictEqual(tcp._tag, "@maple/http/errors/UptimeMonitorValidationError")
			const local = yield* Effect.flip(service.testHttp(httpConfig("http://localhost:8080/health")))
			assert.strictEqual(local._tag, "@maple/http/errors/UptimeMonitorValidationError")
		}).pipe(Effect.provide(makeLayer(testDb, { respond: { status: 503, body: "x".repeat(5000) } })))
	})
})

describe("uptimeMonitorLimit", () => {
	const customer = (balances?: Record<string, unknown>) =>
		Schema.decodeUnknownSync(BillingCustomer)(
			balances === undefined
				? { id: ORG, subscriptions: [] }
				: { id: ORG, subscriptions: [], balances },
		)

	it("reads the plan's allowance, treating a missing feature as none and overage as uncapped", () => {
		assert.deepStrictEqual(uptimeMonitorLimit(customer()), Option.some(0))
		assert.deepStrictEqual(
			uptimeMonitorLimit(customer({ uptime_monitors: { granted: 10 } })),
			Option.some(10),
		)
		assert.deepStrictEqual(
			uptimeMonitorLimit(customer({ uptime_monitors: { unlimited: true } })),
			Option.none(),
		)
		assert.deepStrictEqual(
			uptimeMonitorLimit(customer({ uptime_monitors: { granted: 10, overageAllowed: true } })),
			Option.none(),
		)
	})
})

interface BackingRuleRow {
	readonly name: string
	readonly signal_type: string
	readonly enabled: boolean
	readonly severity: string
	readonly comparator: string
	readonly threshold: number
	readonly consecutive_breaches_required: number
	readonly consecutive_healthy_required: number
	readonly destination_ids_json: ReadonlyArray<string>
	readonly service_names_json: ReadonlyArray<string> | null
}

const backingRule = (testDb: TestDb, ruleId: string | null) =>
	Effect.promise(() =>
		queryFirstRow<BackingRuleRow>(
			testDb,
			`select name, signal_type, enabled, severity, comparator, threshold,
				consecutive_breaches_required, consecutive_healthy_required,
				destination_ids_json, service_names_json
			from alert_rules where id = $1`,
			[ruleId],
		),
	)

const seedDestination = (testDb: TestDb, id: string, orgId: OrgId = ORG) =>
	Effect.promise(() =>
		executeSql(
			testDb,
			`insert into alert_destinations (id, org_id, name, type, config_json, secret_ciphertext,
				secret_iv, secret_tag, created_at, updated_at, created_by, updated_by)
			values ($1, $2, $1, 'webhook', '{}'::jsonb, 'c', 'i', 't', now(), now(), 'u', 'u')`,
			[id, orgId],
		),
	)

const DEST_A = AlertDestinationId.make("00000000-0000-4000-8000-00000000000a")
const DEST_B = AlertDestinationId.make("00000000-0000-4000-8000-00000000000b")

describe("UptimeMonitorsService backing alert rule", () => {
	it.effect(
		"creates the rule with the monitor and keeps it in step through update, pause and delete",
		() => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const service = yield* UptimeMonitorsService
				yield* seedDestination(testDb, DEST_A)
				yield* seedDestination(testDb, DEST_B)
				const created = yield* service.create(ORG, {
					name: "Checkout health",
					kind: "http",
					config: httpConfig(),
					serviceName: "checkout-api",
					destinationIds: [DEST_A],
					createdBy: USER,
				})
				assert.deepStrictEqual(created.destinationIds, [DEST_A])
				assert.deepStrictEqual(yield* backingRule(testDb, created.alertRuleId), {
					name: "Checkout health",
					signal_type: "uptime",
					enabled: true,
					severity: "critical",
					comparator: "gte",
					threshold: 1,
					consecutive_breaches_required: 1,
					consecutive_healthy_required: 1,
					destination_ids_json: [DEST_A],
					service_names_json: ["checkout-api"],
				})

				const updated = yield* service.update(ORG, created.id, {
					name: "Checkout",
					serviceName: "payments",
					destinationIds: [DEST_B, DEST_A],
					updatedBy: USER,
				})
				assert.deepStrictEqual(updated.destinationIds, [DEST_B, DEST_A])
				const afterUpdate = yield* backingRule(testDb, created.alertRuleId)
				assert.strictEqual(afterUpdate?.name, "Checkout")
				assert.deepStrictEqual(afterUpdate?.service_names_json, ["payments"])
				assert.deepStrictEqual(afterUpdate?.destination_ids_json, [DEST_B, DEST_A])

				yield* service.update(ORG, created.id, { enabled: false, updatedBy: USER })
				assert.isFalse((yield* backingRule(testDb, created.alertRuleId))?.enabled)
				yield* service.update(ORG, created.id, { enabled: true, updatedBy: USER })
				assert.isTrue((yield* backingRule(testDb, created.alertRuleId))?.enabled)

				yield* service.delete(ORG, created.id)
				assert.isUndefined(yield* backingRule(testDb, created.alertRuleId))
			}).pipe(Effect.provide(makeLayer(testDb)))
		},
	)

	it.effect("refuses another org's destination and a name another rule already has", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* UptimeMonitorsService
			yield* seedDestination(testDb, DEST_A, OTHER_ORG)
			const foreign = yield* Effect.flip(
				service.create(ORG, {
					name: "API",
					kind: "http",
					config: httpConfig(),
					destinationIds: [DEST_A],
					createdBy: USER,
				}),
			)
			assert.strictEqual(foreign._tag, "@maple/http/errors/UptimeMonitorValidationError")
			assert.lengthOf(yield* service.list(ORG), 0)

			yield* createHttp("API")
			const duplicate = yield* Effect.flip(createHttp("API"))
			assert.strictEqual(duplicate._tag, "@maple/http/errors/UptimeMonitorValidationError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("refuses a heartbeat cron schedule that does not parse", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* UptimeMonitorsService
			const error = yield* Effect.flip(
				service.create(ORG, {
					name: "Nightly",
					kind: "heartbeat",
					config: {
						_tag: "heartbeat",
						schedule: { _tag: "cron", expression: "0 9 * * *", timezone: "Mars/Olympus" },
						graceSeconds: 0,
					},
					createdBy: USER,
				}),
			)
			assert.strictEqual(error._tag, "@maple/http/errors/UptimeMonitorValidationError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
