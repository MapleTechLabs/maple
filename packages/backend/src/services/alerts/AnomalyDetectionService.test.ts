import { describe, expect, it } from "@effect/vitest"
import { afterEach } from "vitest"
import { AnomalyIncidentId, OrgId } from "@maple/domain/http"
import {
	Clock,
	ConfigProvider,
	Effect,
	Layer,
	Ref,
	Schema,
	Semaphore,
	Array as Arr,
	String as Str,
	Option,
} from "effect"
import { CacheBackend, EdgeCacheService, makeMemoryBackend } from "@maple/cache"
import { Timestamp } from "@maple/domain/http/v2"
import { CacheBackendLive } from "@maple/backend/platform/CacheBackendLive"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import {
	WarehouseQueryService,
	type WarehouseQueryServiceApi,
} from "@maple/backend/services/warehouse/WarehouseQueryService"
import { OrgClickHouseSettingsService } from "@maple/backend/services/org/OrgClickHouseSettingsService"
import { configResolvingWarehouse, makeOrgConfigProbe } from "@maple/backend/testing/org-config-probe"
import { AnomalyDetectionService } from "./AnomalyDetectionService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { compiledQueryOf } from "@maple/query-engine/execution"

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asIncidentId = Schema.decodeUnknownSync(AnomalyIncidentId)
const decodeTimestamp = Schema.decodeUnknownSync(Timestamp)

const ORG = asOrgId("org_anomaly_counts")
const OTHER_ORG = asOrgId("org_anomaly_counts_other")

const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const makeConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://maple-managed.tinybird.co",
			TINYBIRD_TOKEN: "managed-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "lookup-key",
			MAPLE_INGEST_PUBLIC_URL: "http://127.0.0.1:3474",
			MAPLE_APP_BASE_URL: "http://127.0.0.1:3471",
		}),
	)

const warehouseStub: WarehouseQueryServiceApi = makeWarehouseServiceStub({
	compiledQuery: (_tenant, compiled) => compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie),
})

const makeLayer = (testDb: TestDb) => {
	const configLive = makeConfig()
	return Layer.effect(AnomalyDetectionService, AnomalyDetectionService.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(WarehouseQueryService, warehouseStub),
				OrgClickHouseSettingsService.layer,
			),
		),
		Layer.provide(
			Layer.mergeAll(
				testDb.layer,
				EdgeCacheService.layer.pipe(Layer.provide(CacheBackendLive)),
				Env.layer.pipe(Layer.provide(configLive)),
			),
		),
		Layer.provide(configLive),
	)
}

/** `lastTriggeredAt` ascends with `n` so the group's max is predictable. */
const seedIncident = (
	testDb: TestDb,
	incident: {
		readonly n: number
		readonly orgId: string
		readonly serviceName: string
		readonly deploymentEnv: string
		readonly signalType: string
		readonly severity: string
		readonly status: string
	},
) =>
	executeSql(
		testDb,
		`INSERT INTO anomaly_incidents
		   (id, org_id, detector_key, signal_type, service_name, deployment_env, fingerprint_hash,
		    error_issue_id, status, severity, opened_value, baseline_median, baseline_sigma,
		    threshold_value, last_observed_value, last_sample_count, first_triggered_at,
		    last_triggered_at, resolved_at, resolve_reason, triage_status, dedupe_key,
		    fingerprints_json, reopen_count, last_reopened_at, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, null, null, $7, $8, 0.12, 0.01, 0.004, 0.05, 0.14, 4200,
		         '2026-07-15T09:12:00Z', $9, null, null, 'none', $1, '[]'::jsonb, 0, null,
		         '2026-07-15T09:12:00Z', '2026-07-15T09:12:00Z')`,
		[
			asIncidentId(`00000000-0000-4000-8000-0000000000${Str.padStart(2, "0")(String(incident.n))}`),
			incident.orgId,
			// Suffixed with n: `anomaly_incidents_open_detector_idx` allows one OPEN
			// incident per detector, so same-group rows model distinct detectors
			// (the error-spike shape, where the fingerprint is part of the key).
			`${incident.signalType}:${incident.serviceName}:${incident.deploymentEnv}:${incident.n}`,
			incident.signalType,
			incident.serviceName,
			incident.deploymentEnv,
			incident.status,
			incident.severity,
			`2026-07-15T09:${Str.padStart(2, "0")(String(10 + incident.n))}:00Z`,
		],
	)

describe("AnomalyDetectionService.countIncidentsByService", () => {
	// Regression: the aggregate runs raw `sql` fragments, which Drizzle does not
	// put a column codec on. A stubbed-service HTTP test cannot see that; this
	// exercises the real query, and asserts the timestamp is exactly what the v2
	// `Timestamp` schema accepts rather than whatever the driver felt like.
	it.effect("groups open incidents and returns a v2-decodable timestamp", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(async () => {
				// Two open critical+warning rows in one group; the max wins.
				await seedIncident(testDb, {
					n: 1,
					orgId: ORG,
					serviceName: "payments",
					deploymentEnv: "production",
					signalType: "error_rate",
					severity: "warning",
					status: "open",
				})
				await seedIncident(testDb, {
					n: 2,
					orgId: ORG,
					serviceName: "payments",
					deploymentEnv: "production",
					signalType: "error_rate",
					severity: "critical",
					status: "open",
				})
				// Same service, different environment — its own group.
				await seedIncident(testDb, {
					n: 3,
					orgId: ORG,
					serviceName: "payments",
					deploymentEnv: "staging",
					signalType: "error_rate",
					severity: "warning",
					status: "open",
				})
				// Resolved, and another org's row: neither may appear.
				await seedIncident(testDb, {
					n: 4,
					orgId: ORG,
					serviceName: "payments",
					deploymentEnv: "production",
					signalType: "latency_p95",
					severity: "critical",
					status: "resolved",
				})
				await seedIncident(testDb, {
					n: 5,
					orgId: OTHER_ORG,
					serviceName: "payments",
					deploymentEnv: "production",
					signalType: "error_rate",
					severity: "critical",
					status: "open",
				})
			})

			const anomalies = yield* AnomalyDetectionService
			const rows = yield* anomalies.countIncidentsByService(ORG, {})

			const production = Option.getOrUndefined(
				Arr.findFirst(
					rows,
					(row) => row.deploymentEnv === "production" && row.signalType === "error_rate",
				),
			)
			expect(rows).toHaveLength(2)
			expect(production).toBeDefined()
			expect(production?.incidentCount).toBe(2)
			// Severity rolls up to the worst in the group, not the first row's.
			expect(production?.severity).toBe("critical")
			expect(production?.lastTriggeredAt).toBe("2026-07-15T09:12:00.000Z")
			// The whole point: the handler hands this straight to `timestamp()`.
			expect(() => decodeTimestamp(production?.lastTriggeredAt)).not.toThrow()

			const staging = Option.getOrUndefined(
				Arr.findFirst(rows, (row) => row.deploymentEnv === "staging"),
			)
			expect(staging?.incidentCount).toBe(1)
			expect(staging?.severity).toBe("warning")

			// The resolved row is reachable only by asking for it.
			const resolved = yield* anomalies.countIncidentsByService(ORG, { status: "resolved" })
			expect(resolved).toHaveLength(1)
			expect(resolved[0]?.signalType).toBe("latency_p95")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})

describe("AnomalyDetectionService.runTick baseline cache", () => {
	// A cached baseline whose read queues behind the tick's other calls: slow,
	// but well before the hang floor. Every other bucket misses as usual.
	const slowBaselineBackend = Layer.succeed(
		CacheBackend,
		CacheBackend.of({
			...makeMemoryBackend(),
			get: (bucket) =>
				Str.startsWith("anomaly-")(bucket) && Str.endsWith("base")(bucket)
					? Effect.as(Effect.sleep("100 millis"), [])
					: Effect.undefined,
			put: () => Effect.void,
		}),
	)

	it.live("serves a cached baseline that takes 100ms to read instead of recomputing it", () => {
		const testDb = createTestDb(createdDbs)
		const contexts: Array<string> = []
		const warehouse = makeWarehouseServiceStub({
			crossOrgQuery: () => Effect.succeed([{ orgId: ORG }]),
			compiledQuery: (_tenant, compiled, options) => {
				contexts.push(options?.context ?? "")
				// One live fingerprint, so the error-spike path reaches its baseline.
				const rows =
					options?.context === "anomalyErrorSpikeCurrent"
						? [
								{
									fingerprintHash: "42",
									serviceName: "payments",
									errorLabel: "Boom",
									deploymentEnv: "production",
									count: 3,
								},
							]
						: []
				return compiledQueryOf(compiled).decodeRows(rows).pipe(Effect.orDie)
			},
		})
		const configLive = makeConfig()
		const layer = Layer.effect(AnomalyDetectionService, AnomalyDetectionService.make).pipe(
			Layer.provide(
				Layer.mergeAll(
					Layer.succeed(WarehouseQueryService, warehouse),
					OrgClickHouseSettingsService.layer,
				),
			),
			Layer.provide(
				Layer.mergeAll(
					testDb.layer,
					EdgeCacheService.layer.pipe(Layer.provide(slowBaselineBackend)),
					Env.layer.pipe(Layer.provide(configLive)),
				),
			),
			Layer.provide(configLive),
		)

		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`INSERT INTO anomaly_detector_settings (org_id, enabled, sensitivity, muted_signals_json, created_at, updated_at)
					 VALUES ($1, true, 'normal', '[]'::jsonb, now(), now())`,
					[ORG],
				),
			)
			const service = yield* AnomalyDetectionService
			yield* service.runTick

			// The tick evaluated the org: it fetched the current windows fresh...
			expect(contexts).toContain("anomalyTraceSignalsCurrent")
			expect(contexts).toContain("anomalyErrorSpikeCurrent")
			// ...and took all three 7-day baselines from the cache.
			expect(Arr.filter(contexts, (c) => Str.endsWith("Baseline")(c))).toEqual([])
		}).pipe(Effect.provide(layer))
	})

	it.live("computes each baseline once on a miss and the next tick reads it back", () => {
		const testDb = createTestDb(createdDbs)
		const contexts: Array<string> = []
		const warehouse = makeWarehouseServiceStub({
			crossOrgQuery: () => Effect.succeed([{ orgId: ORG }]),
			compiledQuery: (_tenant, compiled, options) => {
				contexts.push(options?.context ?? "")
				const rows =
					options?.context === "anomalyErrorSpikeCurrent"
						? [
								{
									fingerprintHash: "42",
									serviceName: "payments",
									errorLabel: "Boom",
									deploymentEnv: "production",
									count: 3,
								},
							]
						: []
				return compiledQueryOf(compiled).decodeRows(rows).pipe(Effect.orDie)
			},
		})
		const configLive = makeConfig()
		const layer = Layer.effect(AnomalyDetectionService, AnomalyDetectionService.make).pipe(
			Layer.provide(
				Layer.mergeAll(
					Layer.succeed(WarehouseQueryService, warehouse),
					OrgClickHouseSettingsService.layer,
				),
			),
			Layer.provide(
				Layer.mergeAll(
					testDb.layer,
					EdgeCacheService.layer.pipe(
						Layer.provide(Layer.succeed(CacheBackend, CacheBackend.of(makeMemoryBackend()))),
					),
					Env.layer.pipe(Layer.provide(configLive)),
				),
			),
			Layer.provide(configLive),
		)
		const baselineContexts = () => Arr.filter(contexts, (c) => Str.endsWith("Baseline")(c)).sort()

		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`INSERT INTO anomaly_detector_settings (org_id, enabled, sensitivity, muted_signals_json, created_at, updated_at)
					 VALUES ($1, true, 'normal', '[]'::jsonb, now(), now())`,
					[ORG],
				),
			)
			const service = yield* AnomalyDetectionService
			yield* service.runTick
			expect(baselineContexts()).toEqual([
				"anomalyErrorSpikeBaseline",
				"anomalyLogVolumeBaseline",
				"anomalyTraceSignalsBaseline",
			])

			// The next tick five minutes later: its org claim has expired, the hour has not rolled.
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`UPDATE anomaly_detector_settings SET last_tick_at = NULL WHERE org_id = $1`,
					[ORG],
				),
			)
			contexts.length = 0
			yield* service.runTick
			expect(contexts).toContain("anomalyTraceSignalsCurrent")
			expect(baselineContexts()).toEqual([])
		}).pipe(Effect.provide(layer))
	})
})

describe("AnomalyDetectionService.runTick org config priming", () => {
	it.effect("resolves every processed org's warehouse config in one batched read", () => {
		const testDb = createTestDb(createdDbs)
		const runId = Str.slice(2, 10)(Math.random().toString(36))
		// More orgs than the tick's per-org concurrency (4).
		const orgs = Array.from({ length: 6 }, (_, i) => asOrgId(`org_anomaly_prime_${runId}_${i}`))
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				Promise.all(
					Arr.map(orgs, (orgId) =>
						executeSql(
							testDb,
							`INSERT INTO anomaly_detector_settings (org_id, enabled, sensitivity, muted_signals_json, created_at, updated_at)
							 VALUES ($1, true, 'normal', '[]'::jsonb, now(), now())`,
							[orgId],
						),
					),
				),
			)
			const probe = yield* makeOrgConfigProbe
			const configLive = makeConfig()
			const warehouse = configResolvingWarehouse((resolveConfig) =>
				makeWarehouseServiceStub({
					crossOrgQuery: (tenant, compiled) =>
						Effect.andThen(
							resolveConfig(tenant.orgId),
							compiledQueryOf(compiled)
								.decodeRows(Arr.map(orgs, (orgId) => ({ orgId })))
								.pipe(Effect.orDie),
						),
					warmRoute: (tenant) => resolveConfig(tenant.orgId),
					compiledQuery: (tenant, compiled) =>
						Effect.andThen(
							resolveConfig(tenant.orgId),
							compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie),
						),
				}),
			)
			const layer = Layer.effect(AnomalyDetectionService, AnomalyDetectionService.make).pipe(
				Layer.provide(warehouse),
				Layer.provideMerge(probe.orgChSettingsLive),
				Layer.provide(
					Layer.mergeAll(
						testDb.layer,
						probe.edgeCacheLive,
						Env.layer.pipe(Layer.provide(configLive)),
					),
				),
				Layer.provide(configLive),
			)

			const result = yield* AnomalyDetectionService.pipe(
				Effect.flatMap((service) => service.runTick),
				Effect.provide(layer),
			)

			expect(result.orgsProcessed).toBe(orgs.length)
			// Only the active-org discovery route resolves cold, before the org set is
			// known. Without the prime, every processed org does its own cold read.
			expect(yield* probe.coldReads).toBe(1)
		})
	})
})

describe("AnomalyDetectionService.runTick outbound budget", () => {
	const BASELINE_MS = 300
	const CURRENT_MS = 40
	const CACHE_READ_MS = 5
	const SLOW_MS = 1_500
	/** A call that waits longer than this for a connection was queued in the Worker. */
	const NO_QUEUE_MS = 25
	const orgs = Array.from({ length: 8 }, (_, i) => asOrgId(`org_anomaly_budget_${i}`))

	/**
	 * The Worker's six simultaneous connections, shared by warehouse fetches and cache
	 * reads. A seventh call queues for a slot, as on Cloudflare.
	 */
	const makeWorkerModel = Effect.gen(function* () {
		const connections = yield* Semaphore.make(6)
		const inFlight = yield* Ref.make(0)
		const peakInFlight = yield* Ref.make(0)
		const maxSlotWaitMs = yield* Ref.make(0)
		const baselineScans = yield* Ref.make(0)
		const outbound = <A, E, R>(latencyMs: number, effect: Effect.Effect<A, E, R>) =>
			Effect.gen(function* () {
				const count = yield* Ref.updateAndGet(inFlight, (n) => n + 1)
				yield* Ref.update(peakInFlight, (peak) => Math.max(peak, count))
				const issuedAt = yield* Clock.currentTimeMillis
				return yield* connections.withPermit(
					Effect.gen(function* () {
						const waitedMs = (yield* Clock.currentTimeMillis) - issuedAt
						yield* Ref.update(maxSlotWaitMs, (max) => Math.max(max, waitedMs))
						yield* Effect.sleep(latencyMs)
						return yield* effect
					}),
				)
			}).pipe(Effect.ensuring(Ref.update(inFlight, (n) => n - 1)))
		return { outbound, peakInFlight, maxSlotWaitMs, baselineScans }
	})

	const runModelTick = (options: {
		readonly currentMs?: number
		readonly slowContext?: string
		readonly coldBaselines?: boolean
	}) => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const model = yield* makeWorkerModel
			yield* Effect.promise(() =>
				Promise.all(
					Arr.map(orgs, (orgId) =>
						executeSql(
							testDb,
							`INSERT INTO anomaly_detector_settings (org_id, enabled, sensitivity, muted_signals_json, created_at, updated_at)
							 VALUES ($1, true, 'normal', '[]'::jsonb, now(), now())`,
							[orgId],
						),
					),
				),
			)
			// Every baseline is cached for the hour, as on all but the first tick of an hour.
			// Cold: every baseline read misses and the recomputed blob is written back.
			const isBaselineBucket = (bucket: string) =>
				Str.startsWith("anomaly-")(bucket) && Str.endsWith("base")(bucket)
			const warmBaselineBackend = Layer.succeed(
				CacheBackend,
				CacheBackend.of({
					...makeMemoryBackend(),
					get: (bucket) =>
						isBaselineBucket(bucket)
							? model.outbound(
									CACHE_READ_MS,
									Effect.succeed(options.coldBaselines ? undefined : []),
								)
							: Effect.undefined,
					put: (bucket) =>
						isBaselineBucket(bucket) ? model.outbound(CACHE_READ_MS, Effect.void) : Effect.void,
				}),
			)
			const warehouse = makeWarehouseServiceStub({
				crossOrgQuery: (_tenant, compiled) =>
					compiledQueryOf(compiled)
						.decodeRows(Arr.map(orgs, (orgId) => ({ orgId })))
						.pipe(Effect.orDie),
				compiledQuery: (tenant, compiled, queryOptions) => {
					const context = queryOptions?.context ?? ""
					const isBaseline = context.endsWith("Baseline")
					const latencyMs =
						tenant.orgId === orgs[0] && context === options.slowContext
							? SLOW_MS
							: isBaseline
								? BASELINE_MS
								: (options.currentMs ?? CURRENT_MS)
					const rows =
						context === "anomalyErrorSpikeCurrent"
							? [
									{
										fingerprintHash: "42",
										serviceName: "payments",
										errorLabel: "Boom",
										deploymentEnv: "production",
										count: 3,
									},
								]
							: []
					return Effect.andThen(
						isBaseline ? Ref.update(model.baselineScans, (n) => n + 1) : Effect.void,
						model.outbound(
							latencyMs,
							compiledQueryOf(compiled).decodeRows(rows).pipe(Effect.orDie),
						),
					)
				},
			})
			const configLive = makeConfig()
			const layer = Layer.effect(AnomalyDetectionService, AnomalyDetectionService.make).pipe(
				Layer.provide(
					Layer.mergeAll(
						Layer.succeed(WarehouseQueryService, warehouse),
						OrgClickHouseSettingsService.layer,
					),
				),
				Layer.provide(
					Layer.mergeAll(
						testDb.layer,
						EdgeCacheService.layer.pipe(Layer.provide(warmBaselineBackend)),
						Env.layer.pipe(Layer.provide(configLive)),
					),
				),
				Layer.provide(configLive),
			)
			const startedAt = yield* Clock.currentTimeMillis
			const result = yield* AnomalyDetectionService.pipe(
				Effect.flatMap((service) => service.runTick),
				Effect.provide(layer),
			)
			return {
				orgsProcessed: result.orgsProcessed,
				orgFailures: result.orgFailures,
				tickMs: (yield* Clock.currentTimeMillis) - startedAt,
				peakInFlight: yield* Ref.get(model.peakInFlight),
				maxSlotWaitMs: yield* Ref.get(model.maxSlotWaitMs),
				baselineScans: yield* Ref.get(model.baselineScans),
			}
		})
	}

	it.live(
		"keeps warehouse and cache calls within the outbound budget, so cached baselines are served",
		() =>
			Effect.gen(function* () {
				const run = yield* runModelTick({})
				expect(run.orgsProcessed).toBe(orgs.length)
				expect(run.orgFailures).toBe(0)
				expect(run.peakInFlight).toBeLessThanOrEqual(4)
				// No call queues for a connection, so no baseline read times out into a 7-day scan.
				expect(run.maxSlotWaitMs).toBeLessThan(NO_QUEUE_MS)
				expect(run.baselineScans).toBe(0)
			}),
	)

	// The 2026-10-28 shape: a slower warehouse tail holds connections past the 250ms
	// baseline read deadline, so queued reads time out and rerun their 7-day scans.
	it.live("serves cached baselines when every warehouse query is slow", () =>
		Effect.gen(function* () {
			const run = yield* runModelTick({ currentMs: 400 })
			expect(run.orgFailures).toBe(0)
			expect(run.peakInFlight).toBeLessThanOrEqual(4)
			expect(run.maxSlotWaitMs).toBeLessThan(NO_QUEUE_MS)
			expect(run.baselineScans).toBe(0)
		}),
	)

	it.live("keeps the first tick of an hour, with every baseline recomputed, within the budget", () =>
		Effect.gen(function* () {
			const run = yield* runModelTick({ coldBaselines: true })
			expect(run.orgFailures).toBe(0)
			expect(run.baselineScans).toBe(orgs.length * 3)
			expect(run.peakInFlight).toBeLessThanOrEqual(4)
			expect(run.maxSlotWaitMs).toBeLessThan(NO_QUEUE_MS)
		}),
	)

	it.live("a slow detector query holds one permit, not the other orgs' queries", () =>
		Effect.gen(function* () {
			const run = yield* runModelTick({ slowContext: "anomalyTraceSignalsCurrent" })
			expect(run.orgFailures).toBe(0)
			expect(run.peakInFlight).toBeLessThanOrEqual(4)
			expect(run.maxSlotWaitMs).toBeLessThan(NO_QUEUE_MS)
			expect(run.baselineScans).toBe(0)
		}),
	)
})

/**
 * Runs `sideSql` once, right before the first statement `match` accepts: a write that lands in the
 * window between the tick's read and its UPDATE, as a concurrent request or overlapping tick would.
 */
const interleaveBefore = (
	testDb: TestDb,
	match: (sql: string, params: ReadonlyArray<unknown>) => boolean,
	sideSql: string,
	sideParams: unknown[],
) => {
	const original = testDb.pglite.query.bind(testDb.pglite)
	let fired = false
	Object.defineProperty(testDb.pglite, "query", {
		configurable: true,
		value: (sql: string, params: unknown[] = [], ...rest: unknown[]) => {
			if (fired || !match(sql, params)) return original(sql, params, ...rest)
			fired = true
			return original(sideSql, sideParams).then(() => original(sql, params, ...rest))
		},
	})
	return () => fired
}

const isNoDataResolve = (sql: string, params: ReadonlyArray<unknown>) =>
	Str.startsWith('UPDATE "anomaly_incidents"')(sql) && params.includes("no_data")

const STALE_INCIDENT = {
	n: 7,
	orgId: ORG,
	serviceName: "payments",
	deploymentEnv: "production",
	signalType: "error_rate",
	severity: "warning",
	status: "open",
} as const
const STALE_INCIDENT_ID = asIncidentId("00000000-0000-4000-8000-000000000007")
const STALE_DETECTOR_KEY = "error_rate:payments:production:7"

const seedDetectorState = (testDb: TestDb) =>
	executeSql(
		testDb,
		`INSERT INTO anomaly_detector_states
		   (org_id, detector_key, signal_type, service_name, deployment_env, open_incident_id,
		    last_evaluated_at, updated_at)
		 VALUES ($1, $2, 'error_rate', 'payments', 'production', $3, now(), now())`,
		[ORG, STALE_DETECTOR_KEY, STALE_INCIDENT_ID],
	)

const readIncident = (testDb: TestDb) =>
	Effect.promise(() =>
		testDb.pglite.query<{ status: string; resolve_reason: string | null; resolved_at: Date | null }>(
			"SELECT status, resolve_reason, resolved_at FROM anomaly_incidents WHERE id = $1",
			[STALE_INCIDENT_ID],
		),
	).pipe(Effect.map((result) => result.rows[0]))

const readDetectorPointer = (testDb: TestDb) =>
	Effect.promise(() =>
		testDb.pglite.query<{ open_incident_id: string | null }>(
			"SELECT open_incident_id FROM anomaly_detector_states WHERE org_id = $1 AND detector_key = $2",
			[ORG, STALE_DETECTOR_KEY],
		),
	).pipe(Effect.map((result) => result.rows[0]?.open_incident_id))

const runTickWith = (testDb: TestDb) =>
	AnomalyDetectionService.pipe(
		Effect.flatMap((service) => service.runTick),
		Effect.provide(makeLayer(testDb)),
	)

describe("AnomalyDetectionService.runTick no-data sweep races", () => {
	it.live("resolves a silent incident as no_data and clears the detector pointer", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(async () => {
				await seedIncident(testDb, STALE_INCIDENT)
				await seedDetectorState(testDb)
			})

			const result = yield* runTickWith(testDb)

			expect(result.incidentsResolved).toBe(1)
			expect((yield* readIncident(testDb))?.resolve_reason).toBe("no_data")
			expect(yield* readDetectorPointer(testDb)).toBeNull()
		})
	})

	it.live("a manual resolve that lands first keeps its reason and time", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedIncident(testDb, STALE_INCIDENT))
			const manualAt = "2026-07-20T10:00:00.000Z"
			const fired = interleaveBefore(
				testDb,
				isNoDataResolve,
				"UPDATE anomaly_incidents SET status = 'resolved', resolve_reason = 'manual', resolved_at = $2 WHERE id = $1",
				[STALE_INCIDENT_ID, manualAt],
			)

			const result = yield* runTickWith(testDb)

			expect(fired()).toBe(true)
			expect(result.incidentsResolved).toBe(0)
			const incident = yield* readIncident(testDb)
			expect(incident?.resolve_reason).toBe("manual")
			expect(incident?.resolved_at?.toISOString()).toBe(manualAt)
		})
	})

	it.live("an overlapping tick that saw the series fire keeps the incident open and pointed at", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(async () => {
				await seedIncident(testDb, STALE_INCIDENT)
				await seedDetectorState(testDb)
			})
			const fired = interleaveBefore(
				testDb,
				isNoDataResolve,
				"UPDATE anomaly_incidents SET last_triggered_at = now() WHERE id = $1",
				[STALE_INCIDENT_ID],
			)

			const result = yield* runTickWith(testDb)

			expect(fired()).toBe(true)
			expect(result.incidentsResolved).toBe(0)
			expect((yield* readIncident(testDb))?.status).toBe("open")
			expect(yield* readDetectorPointer(testDb)).toBe(STALE_INCIDENT_ID)
		})
	})
})

describe("AnomalyDetectionService.runTick baseline resolve races", () => {
	const SPIKE_INCIDENT_ID = asIncidentId("00000000-0000-4000-8000-000000000008")
	const RECOVERING_KEY = "error_spike:production:41"
	const NEW_SPIKE_KEY = "error_spike:production:43"

	const isBaselineResolve = (sql: string, params: ReadonlyArray<unknown>) =>
		Str.startsWith('UPDATE "anomaly_incidents"')(sql) && params.includes("returned_to_baseline")

	/** One open spike incident whose only series (fingerprint 41) is one healthy tick from resolving. */
	const seedRecoveringSpike = (testDb: TestDb) =>
		Effect.promise(async () => {
			await executeSql(
				testDb,
				`INSERT INTO anomaly_incidents
				   (id, org_id, detector_key, signal_type, service_name, deployment_env, fingerprint_hash,
				    status, severity, opened_value, baseline_median, baseline_sigma, threshold_value,
				    last_observed_value, last_sample_count, first_triggered_at, last_triggered_at,
				    triage_status, dedupe_key, fingerprints_json, reopen_count, created_at, updated_at)
				 VALUES ($1, $2, $3, 'error_spike', 'payments', 'production', '41', 'open', 'warning',
				         40, 1, 1, 11, 40, 40, now() - interval '10 minutes', now() - interval '5 minutes',
				         'none', $1, '[]'::jsonb, 0, now() - interval '10 minutes', now())`,
				[SPIKE_INCIDENT_ID, ORG, RECOVERING_KEY],
			)
			await executeSql(
				testDb,
				`INSERT INTO anomaly_detector_states
				   (org_id, detector_key, signal_type, service_name, deployment_env, fingerprint_hash,
				    consecutive_healthy, open_incident_id, last_evaluated_at, updated_at)
				 VALUES ($1, $2, 'error_spike', 'payments', 'production', '41', 2, $3, now(), now())`,
				[ORG, RECOVERING_KEY, SPIKE_INCIDENT_ID],
			)
			// A second fingerprint one breach away from opening, for the follow-up tick.
			await executeSql(
				testDb,
				`INSERT INTO anomaly_detector_states
				   (org_id, detector_key, signal_type, service_name, deployment_env, fingerprint_hash,
				    consecutive_breaches, last_evaluated_at, updated_at)
				 VALUES ($1, $2, 'error_spike', 'payments', 'production', '43', 1, now(), now())`,
				[ORG, NEW_SPIKE_KEY],
			)
		})

	const readSpikeIncidents = (testDb: TestDb) =>
		Effect.promise(() =>
			testDb.pglite.query<{ id: string; status: string; resolve_reason: string | null }>(
				"SELECT id, status, resolve_reason FROM anomaly_incidents WHERE org_id = $1",
				[ORG],
			),
		).pipe(Effect.map((result) => result.rows))

	const readState = (testDb: TestDb, detectorKey: string) =>
		Effect.promise(() =>
			testDb.pglite.query<{ open_incident_id: string | null; last_resolved_at: Date | null }>(
				"SELECT open_incident_id, last_resolved_at FROM anomaly_detector_states WHERE org_id = $1 AND detector_key = $2",
				[ORG, detectorKey],
			),
		).pipe(Effect.map((result) => result.rows[0]))

	/** Fingerprint 41 is silent (healthy); fingerprint 43 fires only once `fire43` is set. */
	const makeSpikeLayer = (testDb: TestDb, fire43: { value: boolean }) => {
		const warehouse = makeWarehouseServiceStub({
			crossOrgQuery: (_tenant, compiled) =>
				compiledQueryOf(compiled)
					.decodeRows([{ orgId: ORG }])
					.pipe(Effect.orDie),
			compiledQuery: (_tenant, compiled, options) => {
				const rows =
					options?.context === "anomalyErrorSpikeCurrent" && fire43.value
						? [
								{
									fingerprintHash: "43",
									serviceName: "payments",
									errorLabel: "Boom",
									deploymentEnv: "production",
									count: 50,
								},
							]
						: options?.context === "anomalyErrorSpikeBaseline"
							? [
									{
										fingerprintHash: "43",
										deploymentEnv: "production",
										totalCount: 336,
										medianNonzeroHourly: 2,
										maxHourly: 4,
									},
								]
							: []
				return compiledQueryOf(compiled).decodeRows(rows).pipe(Effect.orDie)
			},
		})
		const configLive = makeConfig()
		return Layer.effect(AnomalyDetectionService, AnomalyDetectionService.make).pipe(
			Layer.provide(
				Layer.mergeAll(
					Layer.succeed(WarehouseQueryService, warehouse),
					OrgClickHouseSettingsService.layer,
				),
			),
			Layer.provide(
				Layer.mergeAll(
					testDb.layer,
					EdgeCacheService.layer.pipe(
						Layer.provide(Layer.succeed(CacheBackend, CacheBackend.of(makeMemoryBackend()))),
					),
					Env.layer.pipe(Layer.provide(configLive)),
				),
			),
			Layer.provide(configLive),
		)
	}

	const RACES = [
		{
			name: "an overlapping tick's lastTriggeredAt bump",
			sql: "UPDATE anomaly_incidents SET last_triggered_at = now() WHERE id = $1",
		},
		{
			// Same last_triggered_at, so only the reopen count tells the two rows apart.
			name: "an overlapping tick's resolve and reopen",
			sql: "UPDATE anomaly_incidents SET reopen_count = reopen_count + 1, last_reopened_at = now() WHERE id = $1",
		},
	] as const

	Arr.forEach(RACES, (race) =>
		it.live(
			`a lost returned_to_baseline resolve after ${race.name} keeps the incident and its pointer`,
			() => {
				const testDb = createTestDb(createdDbs)
				const fire43 = { value: false }
				const runTick = AnomalyDetectionService.pipe(Effect.flatMap((service) => service.runTick))
				return Effect.gen(function* () {
					yield* seedRecoveringSpike(testDb)
					const fired = interleaveBefore(testDb, isBaselineResolve, race.sql, [SPIKE_INCIDENT_ID])

					const first = yield* runTick

					expect(fired()).toBe(true)
					expect(first.incidentsResolved).toBe(0)
					expect(yield* readSpikeIncidents(testDb)).toEqual([
						{ id: SPIKE_INCIDENT_ID, status: "open", resolve_reason: null },
					])
					expect(yield* readState(testDb, RECOVERING_KEY)).toEqual({
						open_incident_id: SPIKE_INCIDENT_ID,
						last_resolved_at: null,
					})

					// Opens run before resolves within a tick, so the attach target is exercised on the next one:
					// a co-onset fingerprint on the same service attaches instead of opening a duplicate.
					yield* Effect.promise(() =>
						executeSql(
							testDb,
							"UPDATE anomaly_detector_settings SET last_tick_at = NULL WHERE org_id = $1",
							[ORG],
						),
					)
					fire43.value = true
					const second = yield* runTick

					expect(second.incidentsOpened).toBe(0)
					expect(second.incidentsAttached).toBe(1)
					expect(yield* readSpikeIncidents(testDb)).toEqual([
						{ id: SPIKE_INCIDENT_ID, status: "open", resolve_reason: null },
					])
					expect((yield* readState(testDb, NEW_SPIKE_KEY))?.open_incident_id).toBe(
						SPIKE_INCIDENT_ID,
					)
				}).pipe(Effect.provide(makeSpikeLayer(testDb, fire43)))
			},
		),
	)
})
