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

interface Occurrence {
	readonly matchers: Record<string, unknown>
	readonly excludeFromBaselines?: boolean
	/** A plain silence, not one a maintenance window wrote. */
	readonly plain?: boolean
}

/**
 * The silence a maintenance occurrence over the four maintenance days left behind. No window
 * row exists: the window was deleted since, and its history must still hold.
 */
const seedOccurrence = (testDb: TestDb, currentHourStartMs: number, occurrence: Occurrence) =>
	executeSql(
		testDb,
		`INSERT INTO alert_silences
		   (id, org_id, reason, matchers_json, starts_at, ends_at, maintenance_window_id,
		    exclude_from_baselines, created_at, updated_at, created_by, updated_by)
		 VALUES ('1b8f7c1e-2f61-4f1e-9d2a-3c4b5d6e7f80', $1, 'Maintenance: Migrations', $2::jsonb,
		         to_timestamp($3 / 1000.0), to_timestamp($4 / 1000.0), $5, $6, now(), now(), 'user_1', 'user_1')`,
		[
			ORG,
			JSON.stringify(occurrence.matchers),
			currentHourStartMs - 4 * DAY_MS - 2 * HOUR_MS,
			currentHourStartMs - DAY_MS + 2 * HOUR_MS,
			occurrence.plain === true ? null : "0b8f7c1e-2f61-4f1e-9d2a-3c4b5d6e7f80",
			occurrence.excludeFromBaselines ?? true,
		],
	)

const errorRateState = (testDb: TestDb) =>
	testDb.pglite.query<{ last_status: string; baseline_median: number }>(
		`SELECT last_status, baseline_median FROM anomaly_detector_states
		 WHERE org_id = $1 AND detector_key = 'error_rate:production:payments'`,
		[ORG],
	)

const runWith = (occurrence: Occurrence | null) =>
	Effect.gen(function* () {
		const testDb = createTestDb(createdDbs)
		const nowMs = yield* Clock.currentTimeMillis
		const currentHourStartMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS
		yield* Effect.promise(() => seedSettings(testDb))
		if (occurrence !== null)
			yield* Effect.promise(() => seedOccurrence(testDb, currentHourStartMs, occurrence))
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

	it.live("leaves a past occurrence's hours out of the baseline, even after its window is gone", () =>
		Effect.gen(function* () {
			const state = yield* runWith({ matchers: { services: ["payments"] } })
			expect(state).toMatchObject({ last_status: "breached", baseline_median: 0.01 })
		}),
	)

	it.live("ignores a window that names no service or environment", () =>
		Effect.gen(function* () {
			const state = yield* runWith({ matchers: { tags: ["db"] } })
			expect(state).toMatchObject({ last_status: "healthy", baseline_median: 0.3 })
		}),
	)

	it.live("keeps hours of an occurrence written without the baseline opt-out, and of plain silences", () =>
		Effect.gen(function* () {
			const optedIn = yield* runWith({
				matchers: { services: ["payments"] },
				excludeFromBaselines: false,
			})
			const plain = yield* runWith({ matchers: { services: ["payments"] }, plain: true })
			expect(optedIn).toMatchObject({ last_status: "healthy", baseline_median: 0.3 })
			expect(plain).toMatchObject({ last_status: "healthy", baseline_median: 0.3 })
		}),
	)
})
