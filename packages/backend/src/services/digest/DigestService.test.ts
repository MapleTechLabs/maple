import { randomUUID } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { OrgId, UserId, WarehouseQueryError } from "@maple/domain/http"
import type { WeeklyDigestProps } from "@maple/email/weekly-digest-core"
import * as PG from "@maple-dev/effect-orm/postgres"
import { DigestSubscriptions } from "@maple/db/tables"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { EmailService } from "@maple/backend/platform/EmailService"
import { Env } from "@maple/backend/platform/Env"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { EdgeCacheService, makeEdgeCacheService, makeMemoryBackend } from "@maple/cache"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { DigestService } from "./DigestService"

const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3476",
			MCP_PORT: "3477",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

// Monday 2026-07-06 08:00 UTC — getUTCDay() === 1, matching the default
// subscription dayOfWeek. All seeded timestamps derive from this epoch so
// rows and the service (which reads Clock.currentTimeMillis) share one
// time base.
const TICK_MS = Date.UTC(2026, 6, 6, 8, 0, 0)

interface StubOverviewRow {
	serviceName: string
	environment: string
	serviceNamespace: string
	throughput: number
	estimatedSpanCount: number
	errorCount: number
	estimatedErrorCount: number
	p95LatencyMs: number
	period: "current" | "previous"
}

const overview = (over: Partial<StubOverviewRow> & { serviceName: string }) => ({
	environment: "production",
	serviceNamespace: "",
	throughput: over.estimatedSpanCount ?? 100,
	estimatedSpanCount: 100,
	errorCount: 2,
	estimatedErrorCount: 2,
	spanCount: over.estimatedSpanCount ?? 100,
	p50LatencyMs: 20,
	p95LatencyMs: 50,
	p99LatencyMs: 80,
	firstSeen: "2026-06-01 00:00:00",
	commits: [],
	period: "current",
	...over,
})

/** One current-period service row so hasDigestContent() passes. */
const overviewRow = overview({ serviceName: "checkout-api" })

/** A `tracesBreakdownQuery` row; only the fields the digest reads vary. */
const breakdownRow = (name: string, count: number, errorRate: number, p95Duration: number) => ({
	name,
	count,
	spanCount: count,
	avgDuration: 0,
	p50Duration: 0,
	p95Duration,
	p99Duration: 0,
	errorRate,
	satisfiedCount: 0,
	toleratingCount: 0,
	apdexScore: 0,
})

/** The `groupBy: "all"` summary breakdown: one row for the window. */
const summaryRow = (count: number, errorRate: number, p95Duration: number) =>
	breakdownRow("all", count, errorRate, p95Duration)

/** A daily `tracesTimeseriesQuery` bucket. */
const seriesRow = (bucket: string, count: number, errorRate: number) => ({
	...breakdownRow("", count, errorRate, 0),
	bucket,
	groupName: "all",
	estimatedSpanCount: count,
})

/**
 * Query context → wire rows, decoded through each query's real row schema.
 * Anything unlisted answers with no rows. Both windows of a summary or
 * namespace breakdown share one context, so they share one fixture.
 */
type WarehouseFixture = Readonly<Record<string, ReadonlyArray<unknown>>>

type SeenQuery = { context: string; sql: string }

const defaultFixture = {
	digestServiceOverviewCompare: [overviewRow],
	digestTracesSummary: [summaryRow(100, 0.02, 50)],
} satisfies WarehouseFixture

const makeWarehouseStub = (
	fixture: WarehouseFixture = defaultFixture,
	seen?: Array<SeenQuery>,
	/** Query contexts that should fail, simulating a warehouse blip. */
	failing: ReadonlySet<string> = new Set(),
) =>
	Layer.succeed(
		WarehouseQueryService,
		makeWarehouseServiceStub({
			compiledQuery: (_tenant, input, options) =>
				Effect.suspend(() => {
					const compiled = compiledQueryOf(input)
					const context = options?.context ?? ""
					seen?.push({ context, sql: compiled.sql })
					if (failing.has(context)) {
						return Effect.fail(
							new WarehouseQueryError({
								message: `stubbed failure for ${context}`,
								pipeName: context,
							}),
						)
					}
					return compiled.decodeRows(fixture[context] ?? []).pipe(Effect.orDie)
				}),
		}),
	)

const makeHarness = (
	fixture: WarehouseFixture = defaultFixture,
	seen?: Array<SeenQuery>,
	failing?: ReadonlySet<string>,
) => {
	const sends: string[] = []
	const messages: Array<{ to: string; html: string; headers: Readonly<Record<string, string>> }> = []
	const emailStub = Layer.succeed(EmailService, {
		isConfigured: true,
		send: (to, _subject, html, options) =>
			Effect.sync(() => {
				sends.push(to)
				messages.push({ to, html, headers: options?.headers ?? {} })
			}),
	})
	const testDb = createTestDb(createdDbs)
	const base = testDb.layer.pipe(Layer.provideMerge(Env.layer), Layer.provide(testConfig()))
	const layer = Layer.effect(DigestService, DigestService.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				emailStub,
				makeWarehouseStub(fixture, seen, failing),
				Layer.succeed(EdgeCacheService, makeEdgeCacheService(makeMemoryBackend())),
			),
		),
		Layer.provideMerge(base),
	)
	return { sends, messages, layer }
}

const seedSub = (
	overrides: Partial<PG.InsertRowOf<typeof DigestSubscriptions>> & { email: string; id?: string },
) =>
	Effect.gen(function* () {
		const database = yield* Database
		const id = overrides.id ?? randomUUID()
		yield* database.execute((db) =>
			db.run(
				PG.insertInto(DigestSubscriptions).values({
					id,
					orgId: OrgId.make("org_digest_test"),
					userId: `user-${id}`,
					enabled: true,
					dayOfWeek: 1,
					timezone: "UTC",
					createdAt: TICK_MS,
					updatedAt: TICK_MS,
					...overrides,
				}),
			),
		)
		return id
	})

const getSub = (id: string) =>
	Effect.gen(function* () {
		const database = yield* Database
		const rows = yield* database.execute((db) =>
			db.run(
				PG.from(DigestSubscriptions)
					.select()
					.where(($) => [$.id.eq(id)]),
			),
		)
		const row = rows[0]
		if (!row) {
			return yield* Effect.die(`subscription ${id} not found`)
		}
		return row
	})

describe("DigestService.runDigestTick", () => {
	it.effect("sends exactly one email per due subscription and records timestamps", () => {
		const { sends, layer } = makeHarness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const aId = yield* seedSub({ email: "a@example.com" })
			const bId = yield* seedSub({ email: "b@example.com" })

			const digest = yield* DigestService
			const result = yield* digest.runDigestTick()

			assert.deepStrictEqual(sends.sort(), ["a@example.com", "b@example.com"])
			assert.strictEqual(result.sentCount, 2)
			assert.strictEqual(result.errorCount, 0)

			for (const id of [aId, bId]) {
				const row = yield* getSub(id)
				assert.strictEqual(row.lastSentAt, TICK_MS)
				assert.strictEqual(row.lastAttemptedAt, TICK_MS)
			}
		}).pipe(Effect.provide(layer))
	})

	it.effect("does not re-send to a sub already attempted today when another sub is claimed", () => {
		const { sends, layer } = makeHarness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			// B was attempted earlier today but its lastSentAt never landed
			// (e.g. bookkeeping write failed after the email went out). It still
			// looks "due" by lastSentAt but must NOT be claimed again today.
			yield* seedSub({
				email: "b@example.com",
				lastAttemptedAt: TICK_MS - 15 * 60 * 1000,
			})
			// D is a fresh subscription (never attempted) — claimable.
			yield* seedSub({ email: "d@example.com" })

			const digest = yield* DigestService
			const result = yield* digest.runDigestTick()

			assert.deepStrictEqual(sends, ["d@example.com"])
			assert.strictEqual(result.sentCount, 1)
			assert.strictEqual(result.errorCount, 0)
		}).pipe(Effect.provide(layer))
	})

	it.effect("sends nothing to an org that ingested no data this week", () => {
		const { sends, layer } = makeHarness({})
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const id = yield* seedSub({ email: "a@example.com" })

			const digest = yield* DigestService
			const result = yield* digest.runDigestTick()

			assert.deepStrictEqual(sends, [])
			assert.strictEqual(result.sentCount, 0)
			assert.strictEqual(result.errorCount, 0)

			// Claimed for the day so later ticks don't re-query, but never marked sent.
			const row = yield* getSub(id)
			assert.strictEqual(row.lastSentAt, null)
			assert.strictEqual(row.lastAttemptedAt, TICK_MS)
		}).pipe(Effect.provide(layer))
	})

	it.effect("sends nothing to an org that only had data the previous week", () => {
		const { sends, layer } = makeHarness({
			digestServiceOverviewCompare: [overview({ serviceName: "checkout-api", period: "previous" })],
		})
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			yield* seedSub({ email: "a@example.com" })

			const digest = yield* DigestService
			const result = yield* digest.runDigestTick()

			assert.deepStrictEqual(sends, [])
			assert.strictEqual(result.sentCount, 0)
		}).pipe(Effect.provide(layer))
	})

	it.effect("a second tick the same day sends nothing", () => {
		const { sends, layer } = makeHarness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			yield* seedSub({ email: "a@example.com" })

			const digest = yield* DigestService
			yield* digest.runDigestTick()
			assert.deepStrictEqual(sends, ["a@example.com"])

			yield* TestClock.setTime(TICK_MS + 15 * 60 * 1000)
			const second = yield* digest.runDigestTick()

			assert.deepStrictEqual(sends, ["a@example.com"])
			assert.strictEqual(second.sentCount, 0)
			assert.strictEqual(second.errorCount, 0)
		}).pipe(Effect.provide(layer))
	})
})

describe("DigestService.unsubscribeByToken", () => {
	it.effect("each recipient gets their own link, and it opts them out without a session", () => {
		const { messages, layer } = makeHarness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const aId = yield* seedSub({ email: "a@example.com" })
			const bId = yield* seedSub({ email: "b@example.com" })

			const digest = yield* DigestService
			yield* digest.runDigestTick()

			const toA = messages.find((m) => m.to === "a@example.com")
			assert.isDefined(toA)
			const header = toA.headers["List-Unsubscribe"] ?? ""
			assert.strictEqual(toA.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click")
			const token = decodeURIComponent(/token=([^>]+)>/.exec(header)?.[1] ?? "")
			assert.include(toA.html, `/unsubscribe?token=${encodeURIComponent(token)}`)
			assert.notInclude(
				messages.find((m) => m.to === "b@example.com")?.html ?? "",
				encodeURIComponent(token),
			)

			const result = yield* digest.unsubscribeByToken(token)
			assert.strictEqual(result.kind, "digest")
			// Idempotent: a mail client and a human click may both arrive.
			yield* digest.unsubscribeByToken(token)

			const a = yield* getSub(aId)
			assert.strictEqual(a.enabled, false)
			assert.isNotNull(a.optedOutAt)
			assert.strictEqual(a.webAnalyticsEnabled, true)
			assert.strictEqual((yield* getSub(bId)).enabled, true)
		}).pipe(Effect.provide(layer))
	})

	it.effect("rejects a tampered token", () => {
		const { layer } = makeHarness()
		return Effect.gen(function* () {
			const digest = yield* DigestService
			const error = yield* digest.unsubscribeByToken(`digest.${randomUUID()}.forged`).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/DigestUnsubscribeTokenInvalidError")
		}).pipe(Effect.provide(layer))
	})
})

const ORG_ID = OrgId.make("org_digest_test")

/**
 * The overview query groups by (serviceName, environment) and also carries a
 * namespace, so a service running in two environments arrives as two rows that
 * differ in nothing the old code looked at.
 */
const multiEnvFixture = {
	digestServiceOverviewCompare: [
		overview({
			serviceName: "api",
			environment: "production",
			serviceNamespace: "edge",
			estimatedSpanCount: 1_000_000,
			estimatedErrorCount: 4_000,
			p95LatencyMs: 120,
			period: "current",
		}),
		overview({
			serviceName: "api",
			environment: "staging",
			serviceNamespace: "edge",
			estimatedSpanCount: 5_000,
			estimatedErrorCount: 500,
			p95LatencyMs: 900,
			period: "current",
		}),
		overview({
			serviceName: "api",
			environment: "production",
			serviceNamespace: "edge",
			estimatedSpanCount: 900_000,
			estimatedErrorCount: 3_000,
			period: "previous",
		}),
		overview({
			serviceName: "api",
			environment: "staging",
			serviceNamespace: "edge",
			estimatedSpanCount: 4_500,
			estimatedErrorCount: 400,
			period: "previous",
		}),
	],
	digestTracesSummary: [summaryRow(1_005_000, 0.004, 130)],
	// True namespace grain — a service's traffic can be split across namespaces,
	// which is exactly what summing the overview rows could not express.
	digestNamespaceBreakdown: [
		breakdownRow("edge", 700_000, 0.003, 110),
		breakdownRow("checkout", 305_000, 0.006, 210),
	],
} satisfies WarehouseFixture

const findService = (props: WeeklyDigestProps, environment: string) => {
	const match = props.services.find((s) => s.environment === environment)
	assert.isDefined(match, `no service row for environment ${environment}`)
	return match
}

describe("DigestService.generateDigestData", () => {
	it.effect("compares each service against its own environment, not the last row seen", () => {
		const { layer } = makeHarness(multiEnvFixture)
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			// Keyed on the service name alone, production (1,000,000) would have
			// been compared against the staging previous row (4,500) — a +22,122%
			// chip on a service that actually grew 11%.
			const production = findService(props, "production")
			assert.deepStrictEqual(production.requestsDelta, {
				kind: "pct",
				value: ((1_000_000 - 900_000) / 900_000) * 100,
			})

			const staging = findService(props, "staging")
			assert.deepStrictEqual(staging.requestsDelta, {
				kind: "pct",
				value: ((5_000 - 4_500) / 4_500) * 100,
			})
		}).pipe(Effect.provide(layer))
	})

	it.effect("carries environment and namespace onto every service row", () => {
		const { layer } = makeHarness(multiEnvFixture)
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			assert.deepStrictEqual(
				props.services.map((s) => `${s.name}/${s.namespace}/${s.environment}`).sort(),
				["api/edge/production", "api/edge/staging"],
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("groups services by environment with per-group subtotals", () => {
		const { layer } = makeHarness(multiEnvFixture)
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			assert.deepStrictEqual(
				props.environmentGroups.map((g) => [g.environment, g.requests]),
				[
					["production", 1_000_000],
					["staging", 5_000],
				],
			)
			// With fewer services than the render cap the header total and the
			// visible rows coincide; the >10 case is covered separately.
			for (const group of props.environmentGroups) {
				assert.strictEqual(
					group.requests,
					group.services.reduce((sum, s) => sum + s.requests, 0),
				)
			}
		}).pipe(Effect.provide(layer))
	})

	it.effect("breaks totals down by environment and by namespace", () => {
		const { layer } = makeHarness(multiEnvFixture)
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			// Environment IS a grouping key on the overview query, so summing its
			// rows is exact.
			assert.deepStrictEqual(
				props.breakdown.environments.map((r) => [r.label, r.requests]),
				[
					["production", 1_000_000],
					["staging", 5_000],
				],
			)
			// Namespace is NOT: the overview reports only a dominant `argMax`
			// namespace ("edge" on every row here), so summing those rows would file
			// all 1,005,000 requests under "edge". The namespace-grouped query shows
			// the traffic is really split with "checkout".
			assert.deepStrictEqual(
				props.breakdown.namespaces.map((r) => [r.label, r.requests]),
				[
					["edge", 700_000],
					["checkout", 305_000],
				],
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("reports a service with no previous week as new rather than +100%", () => {
		const { layer } = makeHarness({
			...multiEnvFixture,
			digestServiceOverviewCompare: [
				overview({ serviceName: "fresh", estimatedSpanCount: 50_000, period: "current" }),
			],
		})
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			assert.deepStrictEqual(props.services[0]?.requestsDelta, { kind: "new" })
		}).pipe(Effect.provide(layer))
	})

	it.effect("suppresses a percentage computed off a negligible previous week", () => {
		const { layer } = makeHarness({
			...multiEnvFixture,
			digestServiceOverviewCompare: [
				overview({ serviceName: "spiky", estimatedSpanCount: 40_000, period: "current" }),
				overview({ serviceName: "spiky", estimatedSpanCount: 3, period: "previous" }),
			],
		})
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			// The honest answer is "+1,333,233%", which is not worth an email chip.
			assert.deepStrictEqual(props.services[0]?.requestsDelta, { kind: "none" })
		}).pipe(Effect.provide(layer))
	})

	it.effect("takes P95 from the merged-quantile summary, never a weighted mean", () => {
		const { layer } = makeHarness(multiEnvFixture)
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			// A throughput-weighted mean of the per-service P95s (120ms at 1M and
			// 900ms at 5k) lands near 124ms. The summary row says 130ms, and that
			// is the only one of the two that is actually a quantile.
			assert.strictEqual(props.summary.p95Latency.valueMs, 130)
		}).pipe(Effect.provide(layer))
	})

	it.effect("uses sample-weighted counts, so requests match the sparkline's source", () => {
		const { layer } = makeHarness({
			...multiEnvFixture,
			digestDailySeries: [
				seriesRow("2026-06-29 00:00:00", 500_000, 0.004),
				seriesRow("2026-06-30 00:00:00", 505_000, 0.004),
			],
		})
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			// Both come from the same day-aligned window and the same weighted
			// count, so the bars add up to the headline number.
			assert.strictEqual(
				props.series.reduce((sum, point) => sum + point.requests, 0),
				props.summary.requests.value,
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("scopes every warehouse query when the subscription names a slice", () => {
		const seen: Array<SeenQuery> = []
		const { layer } = makeHarness(multiEnvFixture, seen)
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID, {
				environments: ["production"],
				namespaces: ["edge"],
			})

			const scoped = seen.filter((call) =>
				[
					"digestServiceOverviewCompare",
					"digestTracesSummary",
					"digestDailySeries",
					"digestNamespaceBreakdown",
				].includes(call.context),
			)
			assert.isAbove(scoped.length, 0)
			for (const call of scoped) {
				assert.include(call.sql, "DeploymentEnv IN ('production')")
				assert.include(call.sql, "ServiceNamespace IN ('edge')")
			}

			// `error_events` has a deployment env column but no namespace one.
			const errors = seen.find((call) => call.context === "digestTopErrors")
			assert.include(errors?.sql, "DeploymentEnv IN ('production')")
			assert.notInclude(errors?.sql, "ServiceNamespace")

			// `service_usage` has neither column, so the scope is approximated by
			// service membership and the email says so.
			const usage = seen.find((call) => call.context === "digestServiceUsageCompare")
			assert.include(usage?.sql, "ServiceName IN ('api')")
			assert.isTrue(props.ingestion.approximate)
			assert.deepStrictEqual(props.scope, { environments: ["production"], namespaces: ["edge"] })
		}).pipe(Effect.provide(layer))
	})

	it.effect("leaves an unscoped digest unfiltered and exact", () => {
		const seen: Array<SeenQuery> = []
		const { layer } = makeHarness(multiEnvFixture, seen)
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			for (const call of seen) {
				assert.notInclude(call.sql, "DeploymentEnv IN")
				assert.notInclude(call.sql, "ServiceNamespace IN")
				assert.notInclude(call.sql, "ServiceName IN")
			}
			assert.isFalse(props.ingestion.approximate)
		}).pipe(Effect.provide(layer))
	})
})

describe("DigestService.generateDigestData — comparison identity", () => {
	it.effect("still matches a service whose dominant namespace changed week to week", () => {
		// `serviceOverviewQuery` reports `argMax(cServiceNamespace, …)` — the
		// busiest namespace, display metadata rather than row identity. Keying the
		// comparison on it made a service whose busiest namespace shifted look new.
		const { layer } = makeHarness({
			...multiEnvFixture,
			digestServiceOverviewCompare: [
				overview({
					serviceName: "api",
					serviceNamespace: "checkout",
					estimatedSpanCount: 1_000_000,
					period: "current",
				}),
				overview({
					serviceName: "api",
					serviceNamespace: "edge",
					estimatedSpanCount: 900_000,
					period: "previous",
				}),
			],
		})
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			assert.deepStrictEqual(props.services[0]?.requestsDelta, {
				kind: "pct",
				value: ((1_000_000 - 900_000) / 900_000) * 100,
			})
		}).pipe(Effect.provide(layer))
	})

	it.effect("compares whole environments, not the rendered top ten against everything", () => {
		// Twelve services in one environment: only ten are rendered, but the header
		// total and its delta must cover the environment, or a flat week reports a
		// decline purely because two rows did not fit.
		const many = (period: "current" | "previous") =>
			Array.from({ length: 12 }, (_, index) =>
				overview({
					serviceName: `svc-${index}`,
					estimatedSpanCount: 10_000,
					period,
				}),
			)
		const { layer } = makeHarness({
			...multiEnvFixture,
			digestServiceOverviewCompare: [...many("current"), ...many("previous")],
		})
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			const group = props.environmentGroups[0]
			assert.strictEqual(group?.services.length, 10, "renders the top ten")
			assert.strictEqual(group?.requests, 120_000, "but totals all twelve")
			assert.deepStrictEqual(group?.requestsDelta, { kind: "pct", value: 0 })
		}).pipe(Effect.provide(layer))
	})
})

describe("DigestService.generateDigestData — scope containment", () => {
	it.effect("scopes errors by service membership, not just by environment", () => {
		// `error_events` has no namespace column, so a namespace-only scope would
		// otherwise pull top errors from the whole org into a scoped digest.
		const seen: Array<SeenQuery> = []
		const { layer } = makeHarness(multiEnvFixture, seen)
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			yield* digest.generateDigestData(ORG_ID, { environments: [], namespaces: ["edge"] })

			const errors = seen.find((call) => call.context === "digestTopErrors")
			assert.include(errors?.sql, "ServiceName IN ('api')")
			assert.notInclude(errors?.sql, "DeploymentEnv IN", "no environment in this scope")
		}).pipe(Effect.provide(layer))
	})

	it.effect("treats a scope that matches nothing as empty, not as unfiltered", () => {
		const seen: Array<SeenQuery> = []
		const { layer } = makeHarness({ ...multiEnvFixture, digestServiceOverviewCompare: [] }, seen)
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID, {
				environments: [],
				namespaces: ["nonexistent"],
			})

			// Dropping the filter here would have shown org-wide ingestion and
			// org-wide errors inside a digest claiming to cover one namespace.
			assert.isUndefined(seen.find((call) => call.context === "digestServiceUsageCompare"))
			assert.isUndefined(seen.find((call) => call.context === "digestTopErrors"))
			assert.strictEqual(props.ingestion.totalBytes, 0)
			assert.deepStrictEqual(props.topErrors, [])
		}).pipe(Effect.provide(layer))
	})

	const errorRow = {
		fingerprintHash: "111",
		errorLabel: "Boom",
		sampleMessage: "Boom",
		count: 10,
		affectedServicesCount: 1,
		firstSeen: "2026-07-01 00:00:00",
		lastSeen: "2026-07-05 00:00:00",
		serviceNames: [],
	}

	it.effect("badges an error new only when the previous window genuinely lacks it", () => {
		const { layer } = makeHarness({
			...multiEnvFixture,
			digestTopErrors: [errorRow],
			digestPreviousErrors: [],
		})
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			assert.strictEqual(props.topErrors[0]?.isNew, true)
		}).pipe(Effect.provide(layer))
	})

	it.effect("does not badge every error new when the previous-window lookup fails", () => {
		const { layer } = makeHarness(
			{ ...multiEnvFixture, digestTopErrors: [errorRow], digestPreviousErrors: [] },
			undefined,
			new Set(["digestPreviousErrors"]),
		)
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			// A warehouse blip must not invent first-seen badges. Losing the badge is
			// the safe direction; the digest itself still sends.
			assert.strictEqual(props.topErrors[0]?.isNew, false)
		}).pipe(Effect.provide(layer))
	})
})

describe("DigestService.runDigestTick — stored scope handling", () => {
	it.effect("a malformed scope column widens that digest instead of aborting the tick", () => {
		const { sends, layer } = makeHarness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			yield* seedSub({ email: "broken@example.com", namespacesJson: "{not json" })
			yield* seedSub({ email: "fine@example.com" })

			const digest = yield* DigestService
			const result = yield* digest.runDigestTick()

			// A throw while partitioning subscriptions would have taken the healthy
			// subscriber down with the bad row.
			assert.deepStrictEqual(sends.sort(), ["broken@example.com", "fine@example.com"])
			assert.strictEqual(result.errorCount, 0)
		}).pipe(Effect.provide(layer))
	})
})

describe("DigestService — subscriber opt-out", () => {
	it.effect("the Clerk sweep re-enables a returning member but not one who opted out", () => {
		const { layer } = makeHarness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const database = yield* Database

			const optedOut = yield* seedSub({ email: "opted-out@example.com" })
			const departed = yield* seedSub({ email: "departed@example.com" })
			const optedOutUser = UserId.make(`user-${optedOut}`)
			const departedUser = UserId.make(`user-${departed}`)

			yield* digest.upsertSubscription(ORG_ID, optedOutUser, {
				email: "opted-out@example.com",
				enabled: false,
			})
			// What the sweep itself does to a member it no longer sees in the org.
			yield* database.execute((db) =>
				db.run(
					PG.update(DigestSubscriptions)
						.set({ enabled: false })
						.where(($) => [$.id.eq(departed)]),
				),
			)

			yield* digest.reconcileSubscriptions([
				{ orgId: ORG_ID, userId: optedOutUser, email: "opted-out@example.com" },
				{ orgId: ORG_ID, userId: departedUser, email: "departed@example.com" },
			])

			assert.strictEqual((yield* getSub(optedOut)).enabled, false)
			assert.strictEqual((yield* getSub(departed)).enabled, true)
		}).pipe(Effect.provide(layer))
	})

	it.effect("deleting a subscription records the opt-out instead of erasing it", () => {
		const { layer } = makeHarness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const id = yield* seedSub({ email: "gone@example.com" })
			const userId = UserId.make(`user-${id}`)

			yield* digest.deleteSubscription(ORG_ID, userId)
			yield* digest.reconcileSubscriptions([{ orgId: ORG_ID, userId, email: "gone@example.com" }])

			// A hard delete here would be undone by the very next sweep.
			const row = yield* getSub(id)
			assert.strictEqual(row.enabled, false)
			assert.notStrictEqual(row.optedOutAt, null)
		}).pipe(Effect.provide(layer))
	})
})
