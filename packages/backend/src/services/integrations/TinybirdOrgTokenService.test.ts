// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
import { afterEach, assert, describe, it } from "@effect/vitest"
import {
	Cause,
	ConfigProvider,
	Effect,
	Exit,
	Layer,
	Array as Arr,
	Record as Rec,
	String as Str,
} from "effect"
import { OrgId, SourceId, UserId } from "@maple/domain/http"
import { Schema } from "effect"
import { TestClock } from "effect/testing"
import { JWT_CACHE_MAX_ENTRIES, TinybirdOrgTokenService } from "./TinybirdOrgTokenService"
import { Env } from "@maple/backend/platform/Env"
import type { Database } from "@maple/backend/platform/DatabaseLive"
import { mintOrgReadJwt } from "@maple/backend/services/auth/tinybird-jwt"
import { READ_HORIZON_TTL_MS, RetentionService } from "@maple/backend/services/retention/RetentionService"
import { DEFAULT_RETENTION_DAYS, type RetentionSignal } from "@maple/domain/retention"
import { listOrgScopedDatasourceNames } from "@maple/backend/services/warehouse/warehouse-catalog"
import {
	cleanupTestDbs,
	createTestDb,
	TestEdgeCacheLive,
	testEdgeCache,
	TestReadHorizonMemoLive,
	insertTestSource,
	makeSwitchableDatabase,
	type TestDb,
} from "@maple/backend/testing/test-pglite"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const SIGNING_KEY = "explicit-test-signing-key"
const asOrgId = Schema.decodeUnknownSync(OrgId)

const testConfig = (extra: Record<string, string> = {}, includeSigning = true) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3478",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "api-token-is-not-the-signing-key",
			...(includeSigning
				? {
						TINYBIRD_SIGNING_KEY: SIGNING_KEY,
						TINYBIRD_WORKSPACE_ID: "ws-uuid-abc",
					}
				: undefined),
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			...extra,
		}),
	)

/** The service as an app root builds it, over a database of its own unless one is given. */
const tokenLayer = (
	config = testConfig(),
	database: Layer.Layer<Database> = createTestDb(trackedDbs).layer,
) =>
	TinybirdOrgTokenService.layer.pipe(
		Layer.provide(Env.layer),
		Layer.provide(config),
		Layer.provide(database),
		Layer.provide(TestEdgeCacheLive),
	)

const decodePayload = (jwt: string) =>
	JSON.parse(Buffer.from(Str.split(".")(jwt)[1], "base64url").toString("utf8")) as {
		workspace_id: string
		exp: number
		name: string
		scopes: ReadonlyArray<{ resource: string; filter: string }>
		limits?: { rps: number }
	}

describe("TinybirdOrgTokenService", () => {
	it.effect("mints a workspace-scoped token whose scopes are all filtered to the org", () =>
		Effect.gen(function* () {
			const svc = yield* TinybirdOrgTokenService
			const token = yield* svc.getOrgReadToken(asOrgId("org_a"))
			const payload = decodePayload(token)
			assert.strictEqual(payload.workspace_id, "ws-uuid-abc")
			assert.isAbove(payload.scopes.length, 0)
			assert.isTrue(Arr.every(payload.scopes, (s) => s.filter === "OrgId = 'org_a'"))
		}).pipe(Effect.provide(tokenLayer())),
	)

	it.effect("returns the cached token on a second call within its lifetime", () =>
		Effect.gen(function* () {
			const svc = yield* TinybirdOrgTokenService
			const first = yield* svc.getOrgReadToken(asOrgId("org_a"))
			// Advance well within the (ttl - skew = 540s) window.
			yield* TestClock.setTime(120_000)
			const second = yield* svc.getOrgReadToken(asOrgId("org_a"))
			assert.strictEqual(second, first)
		}).pipe(Effect.provide(tokenLayer())),
	)

	it.effect("re-mints after the cached token nears expiry", () =>
		Effect.gen(function* () {
			const svc = yield* TinybirdOrgTokenService
			const first = yield* svc.getOrgReadToken(asOrgId("org_a"))
			// Past the 540s re-mint deadline → new token (later exp).
			yield* TestClock.setTime(600_000)
			const second = yield* svc.getOrgReadToken(asOrgId("org_a"))
			assert.notStrictEqual(second, first)
			assert.isAbove(decodePayload(second).exp, decodePayload(first).exp)
		}).pipe(Effect.provide(tokenLayer())),
	)

	it.effect("issues distinct tokens per org", () =>
		Effect.gen(function* () {
			const svc = yield* TinybirdOrgTokenService
			const a = yield* svc.getOrgReadToken(asOrgId("org_a"))
			const b = yield* svc.getOrgReadToken(asOrgId("org_b"))
			assert.notStrictEqual(a, b)
			assert.isTrue(Arr.every(decodePayload(b).scopes, (s) => s.filter === "OrgId = 'org_b'"))
		}).pipe(Effect.provide(tokenLayer())),
	)

	it.effect("applies the configured per-org Tinybird RPS limit", () => {
		const limitedLayer = tokenLayer(testConfig({ TINYBIRD_RAW_SQL_JWT_RPS_LIMIT: "25" }))
		return Effect.gen(function* () {
			const svc = yield* TinybirdOrgTokenService
			const a = decodePayload(yield* svc.getOrgReadToken(asOrgId("org_a")))
			const b = decodePayload(yield* svc.getOrgReadToken(asOrgId("org_b")))
			assert.deepStrictEqual(a.limits, { rps: 25 })
			assert.deepStrictEqual(b.limits, { rps: 25 })
			assert.notStrictEqual(a.name, b.name)
		}).pipe(Effect.provide(limitedLayer))
	})

	it.effect("gives Maple's own reads a bucket apart from raw SQL, without the raw-SQL ceiling", () => {
		const limitedLayer = tokenLayer(testConfig({ TINYBIRD_RAW_SQL_JWT_RPS_LIMIT: "25" }))
		return Effect.gen(function* () {
			const svc = yield* TinybirdOrgTokenService
			const raw = decodePayload(yield* svc.getOrgReadToken(asOrgId("org_a"), "raw-sql"))
			const trusted = decodePayload(yield* svc.getOrgReadToken(asOrgId("org_a"), "trusted-read"))
			assert.notStrictEqual(trusted.name, raw.name)
			assert.deepStrictEqual(raw.limits, { rps: 25 })
			assert.isUndefined(trusted.limits)
			// The same org filter either way. Only Maple's own reads reach the audit log, which
			// raw SQL is kept out of even inside the caller's org.
			assert.isTrue(Arr.every(trusted.scopes, (scope) => scope.filter === "OrgId = 'org_a'"))
			const resources = (payload: typeof raw) => Arr.map(payload.scopes, (scope) => scope.resource)
			assert.include(resources(trusted), "audit_log")
			assert.notInclude(resources(raw), "audit_log")
			assert.deepStrictEqual(
				Arr.filter(resources(trusted), (name) => !Arr.contains(resources(raw), name)),
				["audit_log", "audit_trail_events"],
			)
		}).pipe(Effect.provide(limitedLayer))
	})

	it.effect("lists only the datasources a statement names, and all of them when it names none", () =>
		Effect.gen(function* () {
			const svc = yield* TinybirdOrgTokenService
			const resourcesFor = (statement: string) =>
				Effect.map(svc.getOrgReadToken(asOrgId("org_a"), "trusted-read", statement), (token) =>
					Arr.map(decodePayload(token).scopes, (scope) => scope.resource),
				)
			// `traces` is a prefix of the rollup's name and must not ride in on it.
			assert.deepStrictEqual(
				yield* resourcesFor(
					"SELECT count() FROM traces_aggregates_hourly AS t INNER JOIN logs AS l ON t.OrgId = l.OrgId WHERE t.OrgId = 'org_a'",
				),
				["logs", "traces_aggregates_hourly"],
			)
			assert.deepStrictEqual(
				yield* resourcesFor("SELECT 1 FROM default.traces WHERE OrgId = 'org_a'"),
				["traces"],
			)
			const everything = decodePayload(yield* svc.getOrgReadToken(asOrgId("org_a"), "trusted-read"))
			assert.lengthOf(yield* resourcesFor("SELECT 1"), everything.scopes.length)
		}).pipe(Effect.provide(tokenLayer())),
	)

	const startsUnsigned = (extra: Record<string, string>) =>
		Effect.asVoid(TinybirdOrgTokenService).pipe(
			Effect.provide(tokenLayer(testConfig(extra, false))),
			Effect.exit,
		)

	it.effect("never answers a limited caller with another caller's cached token", () =>
		Effect.gen(function* () {
			const svc = yield* TinybirdOrgTokenService
			const org = asOrgId("org_a")
			const sql = "SELECT 1 FROM traces"
			const checkout = new Map([["traces", "ResourceAttributes['service.namespace'] IN ('checkout')"]])
			const search = new Map([["traces", "ResourceAttributes['service.namespace'] IN ('search')"]])
			const filterOf = (token: string) => decodePayload(token).scopes[0]?.filter

			const unlimited = yield* svc.getOrgReadToken(org, "trusted-read", sql)
			const forCheckout = yield* svc.getOrgReadToken(org, "trusted-read", sql, checkout)
			const forSearch = yield* svc.getOrgReadToken(org, "trusted-read", sql, search)
			const unlimitedAgain = yield* svc.getOrgReadToken(org, "trusted-read", sql)

			assert.strictEqual(filterOf(unlimited), "OrgId = 'org_a'")
			assert.include(filterOf(forCheckout) ?? "", "IN ('checkout')")
			assert.include(filterOf(forSearch) ?? "", "IN ('search')")
			assert.strictEqual(unlimitedAgain, unlimited)
			// The same limit is the same token; a new map with the same conditions is the same limit.
			assert.strictEqual(
				yield* svc.getOrgReadToken(org, "trusted-read", sql, new Map(checkout)),
				forCheckout,
			)
		}).pipe(Effect.provide(tokenLayer())),
	)

	it.effect("leaves a datasource the caller's limit has no condition for out of the token", () =>
		Effect.gen(function* () {
			const svc = yield* TinybirdOrgTokenService
			const token = yield* svc.getOrgReadToken(
				asOrgId("org_a"),
				"raw-sql",
				undefined,
				new Map([["logs", "ResourceAttributes['service.namespace'] IN ('checkout')"]]),
			)
			assert.deepStrictEqual(
				Arr.map(decodePayload(token).scopes, (scope) => scope.resource),
				["logs"],
			)
		}).pipe(Effect.provide(tokenLayer())),
	)

	it.effect("refuses to start a multi-org deployment on Tinybird without a signing key", () =>
		Effect.map(startsUnsigned({ MAPLE_AUTH_MODE: "clerk", CLERK_SECRET_KEY: "sk_test_x" }), (exit) => {
			assert.isTrue(Exit.isFailure(exit))
			if (Exit.isFailure(exit)) {
				assert.match(
					String(Cause.squash(exit.cause)),
					/multi-org deployment reading Tinybird needs TINYBIRD_SIGNING_KEY/,
				)
			}
		}),
	)

	it.effect("starts single-org self-hosted without a signing key, which has no other org to isolate", () =>
		Effect.map(startsUnsigned({}), (exit) => assert.isTrue(Exit.isSuccess(exit))),
	)

	it.effect("bounds the per-isolate token cache with LRU eviction", () =>
		Effect.gen(function* () {
			const svc = yield* TinybirdOrgTokenService
			const first = yield* svc.getOrgReadToken(asOrgId("org_0"))
			for (let i = 1; i <= JWT_CACHE_MAX_ENTRIES; i++) {
				yield* svc.getOrgReadToken(asOrgId(`org_${i}`))
			}
			yield* TestClock.setTime(1_000)
			const reminted = yield* svc.getOrgReadToken(asOrgId("org_0"))
			assert.notStrictEqual(reminted, first)
			assert.isAbove(decodePayload(reminted).exp, decodePayload(first).exp)
		}).pipe(Effect.provide(tokenLayer())),
	)

	it.effect("returns a typed error when signing configuration is missing", () => {
		const missingLayer = tokenLayer(testConfig({}, false))
		return Effect.gen(function* () {
			const svc = yield* TinybirdOrgTokenService
			const error = yield* Effect.flip(svc.getOrgReadToken(asOrgId("org_a")))
			assert.strictEqual(error._tag, "@maple/http/errors/TinybirdOrgTokenConfigError")
			assert.strictEqual(error.setting, "SigningKey")
			assert.notInclude(error.message, "api-token-is-not-the-signing-key")
		}).pipe(Effect.provide(missingLayer))
	})

	it.effect("fails startup when only one Tinybird JWT setting is configured", () => {
		const malformedLayer = tokenLayer(testConfig({ TINYBIRD_WORKSPACE_ID: "" }))
		return Effect.asVoid(TinybirdOrgTokenService).pipe(
			Effect.provide(malformedLayer),
			Effect.exit,
			Effect.map((exit) => {
				assert.isTrue(Exit.isFailure(exit))
				if (Exit.isFailure(exit)) {
					assert.match(String(Cause.squash(exit.cause)), /must be configured together/)
				}
			}),
		)
	})

	it.effect("fails startup for a non-positive JWT RPS limit", () => {
		const malformedLayer = tokenLayer(testConfig({ TINYBIRD_RAW_SQL_JWT_RPS_LIMIT: "0" }))
		return Effect.asVoid(TinybirdOrgTokenService).pipe(
			Effect.provide(malformedLayer),
			Effect.exit,
			Effect.map((exit) => {
				assert.isTrue(Exit.isFailure(exit))
				if (Exit.isFailure(exit)) {
					assert.match(String(Cause.squash(exit.cause)), /must be a positive integer/)
				}
			}),
		)
	})
})

describe("TinybirdOrgTokenService retention read horizon", () => {
	const ORG_A = asOrgId("org_a")
	const ORG_B = asOrgId("org_b")
	const ANA = Schema.decodeSync(UserId)("user_ana")
	const decodeSourceId = Schema.decodeSync(SourceId)

	/** The service and the retention service it reads, as one app root builds them. */
	const withPolicies = <A, E>(
		run: (db: TestDb) => Effect.Effect<A, E, TinybirdOrgTokenService | RetentionService>,
	) => {
		const db = createTestDb(trackedDbs)
		return run(db).pipe(
			Effect.provide(
				Layer.merge(TinybirdOrgTokenService.layer, RetentionService.layer).pipe(
					Layer.provide(Env.layer),
					Layer.provide(testConfig()),
					Layer.provide(Layer.mergeAll(db.layer, testEdgeCache(db), TestReadHorizonMemoLive)),
				),
			),
		)
	}

	/** A change made elsewhere: another instance over the same database, as another isolate is. */
	const fromAnotherIsolate = <A, E>(db: TestDb, effect: Effect.Effect<A, E, RetentionService>) =>
		effect.pipe(
			Effect.provide(
				Layer.fresh(RetentionService.layer).pipe(
					Layer.provide(
						Layer.mergeAll(db.layer, testEdgeCache(db), Layer.fresh(TestReadHorizonMemoLive)),
					),
				),
			),
		)

	const filtersOf = (token: string): Record<string, string> =>
		Rec.fromEntries(Arr.map(decodePayload(token).scopes, (scope) => [scope.resource, scope.filter]))
	/** The scopes that carry more than the org filter. */
	const boundedIn = (token: string, orgId: OrgId) =>
		Rec.filter(filtersOf(token), (filter) => filter !== `OrgId = '${orgId}'`)
	const since = (orgId: OrgId, column: string, days: number) =>
		`OrgId = '${orgId}' AND ${column} >= now() - INTERVAL ${days} DAY`
	/** Every bounded table once an org has a policy: `days` per signal, the default where unset. */
	const boundedAt = (orgId: OrgId, set: Partial<Record<RetentionSignal, number>>) => {
		const days = { ...DEFAULT_RETENTION_DAYS, ...set }
		const traces = (column: string) => since(orgId, column, days.traces)
		const metrics = since(orgId, "TimeUnix", days.metrics)
		const sessions = (column: string) => since(orgId, column, days.sessions)
		return {
			traces: traces("Timestamp"),
			// A bucket the horizon cuts through still locates spans that are kept.
			trace_index: `${traces("Bucket")} - INTERVAL 5 MINUTE`,
			trace_list_mv: traces("Timestamp"),
			service_map_spans: traces("Timestamp"),
			service_map_children: traces("Timestamp"),
			service_overview_spans: traces("Timestamp"),
			ai_trace_index: traces("Timestamp"),
			ai_crawler_requests: traces("Timestamp"),
			scanner_requests: traces("Timestamp"),
			logs: since(orgId, "TimestampTime", days.logs),
			metrics_sum: metrics,
			metrics_gauge: metrics,
			metrics_histogram: metrics,
			metrics_exponential_histogram: metrics,
			session_events: sessions("Timestamp"),
			session_replay_events: sessions("Timestamp"),
			session_replays: sessions("StartTime"),
			product_events: since(orgId, "Timestamp", days.events),
			profiles: since(orgId, "Timestamp", days.profiles),
		}
	}

	it.effect("an org that set nothing gets the token it got before retention could be set", () =>
		withPolicies(() =>
			Effect.gen(function* () {
				const tokens = yield* TinybirdOrgTokenService
				const retention = yield* RetentionService
				// Another org's periods are not this org's.
				yield* retention.setOrganization(ORG_B, ANA, { traces: 7, logs: 7 })
				const token = yield* tokens.getOrgReadToken(ORG_A)
				assert.strictEqual(
					token,
					mintOrgReadJwt({
						signingKey: SIGNING_KEY,
						workspaceId: "ws-uuid-abc",
						orgId: ORG_A,
						datasourceNames: listOrgScopedDatasourceNames(),
						nowSeconds: 0,
						ttlSeconds: decodePayload(token).exp,
					}),
				)
				assert.deepStrictEqual(boundedIn(token, ORG_A), {})
			}),
		),
	)

	it.effect(
		"cuts a shortened signal's raw tables at the org's period, and every other at its default",
		() =>
			withPolicies(() =>
				Effect.gen(function* () {
					const tokens = yield* TinybirdOrgTokenService
					const retention = yield* RetentionService
					yield* retention.setOrganization(ORG_A, ANA, { logs: 7, metrics: 14 })
					assert.deepStrictEqual(
						boundedIn(yield* tokens.getOrgReadToken(ORG_A), ORG_A),
						boundedAt(ORG_A, { logs: 7, metrics: 14 }),
					)
				}),
			),
	)

	it.effect("cuts traces and the tables projected from them together, each by its own column", () =>
		withPolicies(() =>
			Effect.gen(function* () {
				const tokens = yield* TinybirdOrgTokenService
				const retention = yield* RetentionService
				yield* retention.setOrganization(ORG_A, ANA, { traces: 7 })
				const everything = yield* tokens.getOrgReadToken(ORG_A, "trusted-read")
				assert.deepStrictEqual(boundedIn(everything, ORG_A), boundedAt(ORG_A, { traces: 7 }))
				// The token of one statement lists fewer datasources, bounded the same way.
				const one = yield* tokens.getOrgReadToken(
					ORG_A,
					"trusted-read",
					"SELECT count() FROM trace_index AS i INNER JOIN logs AS l ON i.OrgId = l.OrgId WHERE i.OrgId = 'org_a'",
				)
				const bounded = boundedAt(ORG_A, { traces: 7 })
				assert.deepStrictEqual(filtersOf(one), {
					logs: bounded.logs,
					trace_index: bounded.trace_index,
				})
			}),
		),
	)

	it.effect("reaches as far back as the source that keeps a signal longest", () =>
		withPolicies((db) =>
			Effect.gen(function* () {
				const tokens = yield* TinybirdOrgTokenService
				const retention = yield* RetentionService
				const sourceOf = (orgId: OrgId) =>
					Effect.map(
						Effect.promise(() => insertTestSource(db, { orgId, platform: "nodejs" })),
						decodeSourceId,
					)
				yield* retention.setOrganization(ORG_A, ANA, { traces: 7 })
				yield* retention.setSource(ORG_A, ANA, yield* sourceOf(ORG_A), { traces: 90 })
				assert.strictEqual(
					filtersOf(yield* tokens.getOrgReadToken(ORG_A))["traces"],
					since(ORG_A, "Timestamp", 90),
				)
				// A source's period alone bounds the org, with no period on the org.
				yield* retention.setSource(ORG_B, ANA, yield* sourceOf(ORG_B), { logs: 365 })
				assert.deepStrictEqual(
					boundedIn(yield* tokens.getOrgReadToken(ORG_B), ORG_B),
					boundedAt(ORG_B, { logs: 365 }),
				)
			}),
		),
	)

	it.effect("a period changed elsewhere changes the token long before the old one would be re-minted", () =>
		withPolicies((db) =>
			Effect.gen(function* () {
				const tokens = yield* TinybirdOrgTokenService
				const unbounded = yield* tokens.getOrgReadToken(ORG_A)
				yield* fromAnotherIsolate(
					db,
					RetentionService.use((other) => other.setOrganization(ORG_A, ANA, { traces: 7 })),
				)
				assert.strictEqual(yield* tokens.getOrgReadToken(ORG_A), unbounded)

				yield* TestClock.adjust(READ_HORIZON_TTL_MS)
				const shortened = yield* tokens.getOrgReadToken(ORG_A)
				assert.strictEqual(filtersOf(shortened)["traces"], since(ORG_A, "Timestamp", 7))

				yield* fromAnotherIsolate(
					db,
					RetentionService.use((other) => other.setOrganization(ORG_A, ANA, { traces: 60 })),
				)
				yield* TestClock.adjust(READ_HORIZON_TTL_MS)
				assert.strictEqual(
					filtersOf(yield* tokens.getOrgReadToken(ORG_A))["traces"],
					since(ORG_A, "Timestamp", 60),
				)
			}),
		),
	)

	it.effect("a period set on this instance changes the next token", () =>
		withPolicies(() =>
			Effect.gen(function* () {
				const tokens = yield* TinybirdOrgTokenService
				const retention = yield* RetentionService
				const before = yield* tokens.getOrgReadToken(ORG_A)
				yield* retention.setOrganization(ORG_A, ANA, { logs: 3 })
				const after = yield* tokens.getOrgReadToken(ORG_A)
				assert.notStrictEqual(after, before)
				assert.strictEqual(filtersOf(after)["logs"], since(ORG_A, "TimestampTime", 3))
			}),
		),
	)

	it.effect("still mints a token for the org when its policy cannot be read", () => {
		const database = makeSwitchableDatabase(createTestDb(trackedDbs))
		database.state.down = true
		return Effect.gen(function* () {
			const tokens = yield* TinybirdOrgTokenService
			const token = yield* tokens.getOrgReadToken(ORG_A)
			assert.isAbove(decodePayload(token).scopes.length, 0)
			assert.deepStrictEqual(boundedIn(token, ORG_A), {})
		}).pipe(Effect.provide(tokenLayer(testConfig(), database.layer)))
	})
})
