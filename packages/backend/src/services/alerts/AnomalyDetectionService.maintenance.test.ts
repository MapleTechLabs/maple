import { describe, expect, it } from "@effect/vitest"
import { afterEach } from "vitest"
import { OrgId } from "@maple/domain/http"
import { Clock, ConfigProvider, Effect, Layer, Schema, Array as Arr } from "effect"
import { CacheBackend, EdgeCacheService, makeMemoryBackend } from "@maple/cache"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { OrgClickHouseSettingsService } from "@maple/backend/services/org/OrgClickHouseSettingsService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { AnomalyDetectionService } from "./AnomalyDetectionService"

const ORG = Schema.decodeSync(OrgId)("org_anomaly_maintenance")
const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const configLive = ConfigProvider.layer(
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

const goldenRow = (hourMs: number, errorCount: number) => ({
	hour: formatWarehouseDateTime(hourMs),
	serviceName: "payments",
	deploymentEnv: "production",
	requestCount: 1000,
	errorCount,
	p95Ms: 100,
})

/**
 * Matched hours over the last 7 days: the four most recent days ran a 30% error rate
 * under maintenance, the three before were at 1%. The current hour runs at 20%.
 */
const makeLayer = (testDb: TestDb, currentHourStartMs: number) => {
	const baseline = Arr.flatMap(Arr.range(1, 7), (day) =>
		Arr.map([-1, 0, 1], (offset) =>
			goldenRow(currentHourStartMs - day * DAY_MS + offset * HOUR_MS, day <= 4 ? 300 : 10),
		),
	)
	const warehouse = makeWarehouseServiceStub({
		crossOrgQuery: () => Effect.succeed([{ orgId: ORG }]),
		compiledQuery: (_tenant, compiled, options) =>
			compiledQueryOf(compiled)
				.decodeRows(
					options?.context === "anomalyTraceSignalsBaseline"
						? baseline
						: options?.context === "anomalyTraceSignalsCurrent"
							? [goldenRow(currentHourStartMs, 200)]
							: [],
				)
				.pipe(Effect.orDie),
	})
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

const seedSettings = (testDb: TestDb) =>
	executeSql(
		testDb,
		`INSERT INTO anomaly_detector_settings (org_id, enabled, sensitivity, muted_signals_json, created_at, updated_at)
		 VALUES ($1, true, 'normal', '[]'::jsonb, now(), now())`,
		[ORG],
	)

/** A one-off window over the four maintenance days, on `services` (or a tag only). */
const seedWindow = (testDb: TestDb, currentHourStartMs: number, matchers: Record<string, unknown>) =>
	executeSql(
		testDb,
		`INSERT INTO alert_maintenance_windows
		   (id, org_id, name, reason, matchers_json, schedule_json, exclude_from_baselines, enabled,
		    created_at, updated_at, created_by, updated_by)
		 VALUES ('0b8f7c1e-2f61-4f1e-9d2a-3c4b5d6e7f80', $1, 'Migrations', null, $2::jsonb, $3::jsonb,
		         true, true, now(), now(), 'user_1', 'user_1')`,
		[
			ORG,
			JSON.stringify(matchers),
			JSON.stringify({
				_tag: "once",
				startsAt: currentHourStartMs - 4 * DAY_MS - 2 * HOUR_MS,
				endsAt: currentHourStartMs - DAY_MS + 2 * HOUR_MS,
			}),
		],
	)

const errorRateState = (testDb: TestDb) =>
	testDb.pglite.query<{ last_status: string; baseline_median: number }>(
		`SELECT last_status, baseline_median FROM anomaly_detector_states
		 WHERE org_id = $1 AND detector_key = 'error_rate:production:payments'`,
		[ORG],
	)

const runWith = (matchers: Record<string, unknown> | null) =>
	Effect.gen(function* () {
		const testDb = createTestDb(createdDbs)
		const nowMs = yield* Clock.currentTimeMillis
		const currentHourStartMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS
		yield* Effect.promise(() => seedSettings(testDb))
		if (matchers !== null) yield* Effect.promise(() => seedWindow(testDb, currentHourStartMs, matchers))
		yield* AnomalyDetectionService.use((service) => service.runTick).pipe(
			Effect.provide(makeLayer(testDb, currentHourStartMs)),
		)
		const result = yield* Effect.promise(() => errorRateState(testDb))
		return result.rows[0]
	})

describe("AnomalyDetectionService maintenance baseline exclusion", () => {
	it.live("a maintenance spike in the baseline hides a real anomaly without a window", () =>
		Effect.gen(function* () {
			const state = yield* runWith(null)
			expect(state).toMatchObject({ last_status: "healthy", baseline_median: 0.3 })
		}),
	)

	it.live("leaves the window's hours out of the baseline, so the anomaly breaches", () =>
		Effect.gen(function* () {
			const state = yield* runWith({ services: ["payments"] })
			expect(state).toMatchObject({ last_status: "breached", baseline_median: 0.01 })
		}),
	)

	it.live("ignores a window that names no service or environment", () =>
		Effect.gen(function* () {
			const state = yield* runWith({ tags: ["db"] })
			expect(state).toMatchObject({ last_status: "healthy", baseline_median: 0.3 })
		}),
	)
})
