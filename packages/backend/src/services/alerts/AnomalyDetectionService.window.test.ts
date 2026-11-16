import { describe, expect, it } from "@effect/vitest"
import { afterEach } from "vitest"
import {
	AnomalyDetectorSettingsUpdateRequest,
	AnomalyIncidentId,
	OrgId,
	UserId,
	WarehouseConfigError,
} from "@maple/domain/http"
import { Clock, ConfigProvider, Effect, Layer, Record, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { CacheBackend, EdgeCacheService, makeMemoryBackend } from "@maple/cache"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/testing/test-pglite"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { OrgClickHouseSettingsService } from "@maple/backend/services/org/OrgClickHouseSettingsService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { AnomalyDetectionService } from "./AnomalyDetectionService"
import { InvestigationStarter } from "@maple/backend/services/errors/InvestigationStarter"
import { ALERTING_SYSTEM_USER_ID, systemTenant } from "@maple/backend/services/auth/system-tenant"
import type { WarehouseQueryServiceApi } from "@maple/backend/services/warehouse/WarehouseQueryService"

const ORG = Schema.decodeSync(OrgId)("org_anomaly_window")
const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS
const ENVS = ["production", "staging"] as const

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

const row = (deploymentEnv: string, hourMs: number, requestCount: number, errorCount: number) => ({
	hour: formatWarehouseDateTime(hourMs),
	serviceName: "payments",
	deploymentEnv,
	requestCount,
	errorCount,
	p95Ms: 100,
})

interface Scenario {
	readonly includedEnvironments: ReadonlyArray<string>
	/** The cluster has not applied `service_overview_minutely`. */
	readonly withoutMinutely: boolean
	/** Save `includedEnvironments` through `updateSettings` instead of seeding the row. */
	readonly viaSettingsUpdate?: boolean
}

const makeLayer = (testDb: TestDb, warehouse: WarehouseQueryServiceApi) =>
	Layer.effect(AnomalyDetectionService, AnomalyDetectionService.make).pipe(
		Layer.provide(InvestigationStarter.layer),
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

/** A week at 1% errors in both environments; the last 60 minutes run at 20%. */
const run = (scenario: Scenario) =>
	Effect.gen(function* () {
		const testDb = createTestDb(createdDbs)
		const nowMs = yield* Clock.currentTimeMillis
		const hourStart = Math.floor(nowMs / HOUR_MS) * HOUR_MS
		const contexts: string[] = []
		const baseline = Arr.flatMap(ENVS, (env) =>
			Arr.flatMap(Arr.range(1, 7), (day) =>
				Arr.map([-2, -1, 0, 1], (offset) =>
					row(env, hourStart - day * DAY_MS + offset * HOUR_MS, 1000, 10),
				),
			),
		)
		const elapsed = (nowMs - hourStart) / HOUR_MS
		const warehouse = makeWarehouseServiceStub({
			crossOrgQuery: () => Effect.succeed([{ orgId: ORG }]),
			compiledQuery: (_tenant, compiled, options) => {
				const context = options?.context ?? ""
				contexts.push(context)
				if (context === "anomalyTraceSignalsCurrent" && scenario.withoutMinutely) {
					return Effect.fail(
						new WarehouseConfigError({
							message: "Table default.service_overview_minutely does not exist",
							pipeName: context,
							clickhouseType: "UNKNOWN_TABLE",
						}),
					)
				}
				const rows =
					context === "anomalyTraceSignalsBaseline"
						? baseline
						: context === "anomalyTraceSignalsCurrent"
							? Arr.map(ENVS, (env) => row(env, hourStart, 1000, 200))
							: context === "anomalyTraceSignalsCurrentHourly"
								? Arr.flatMap(ENVS, (env) => [
										row(env, hourStart - HOUR_MS, 1000, 200),
										row(
											env,
											hourStart,
											Math.max(1, Math.round(1000 * elapsed)),
											Math.max(1, Math.round(200 * elapsed)),
										),
									])
								: []
				return compiledQueryOf(compiled).decodeRows(rows).pipe(Effect.orDie)
			},
		})
		const layer = makeLayer(testDb, warehouse)
		if (scenario.viaSettingsUpdate !== true) {
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`INSERT INTO anomaly_detector_settings
					   (org_id, enabled, sensitivity, muted_signals_json, included_environments_json, created_at, updated_at)
					 VALUES ($1, true, 'normal', '[]'::jsonb, $2::jsonb, now(), now())`,
					[ORG, JSON.stringify(scenario.includedEnvironments)],
				),
			)
		}
		const saved = yield* AnomalyDetectionService.use((service) =>
			Effect.gen(function* () {
				const settings =
					scenario.viaSettingsUpdate === true
						? yield* service.updateSettings(
								ORG,
								Schema.decodeSync(UserId)("user_window_test"),
								new AnomalyDetectorSettingsUpdateRequest({
									includedEnvironments: scenario.includedEnvironments,
								}),
							)
						: yield* service.getSettings(ORG)
				yield* service.runTick
				return settings.includedEnvironments
			}),
		).pipe(Effect.provide(layer))
		const states = yield* Effect.promise(() =>
			testDb.pglite.query<{ deployment_env: string; last_status: string }>(
				`SELECT deployment_env, last_status FROM anomaly_detector_states
				 WHERE org_id = $1 AND signal_type = 'error_rate'`,
				[ORG],
			),
		)
		return {
			saved,
			contexts,
			statusByEnv: Record.fromEntries(
				Arr.map(states.rows, (r) => [r.deployment_env, r.last_status] as const),
			),
		}
	})

describe("AnomalyDetectionService current window and environments", () => {
	it.live("evaluates production and skips a staging environment nobody opted in", () =>
		Effect.gen(function* () {
			const { statusByEnv } = yield* run({ includedEnvironments: [], withoutMinutely: false })
			expect(statusByEnv).toEqual({ production: "breached" })
		}),
	)

	it.live("evaluates a non-production environment the org lists", () =>
		Effect.gen(function* () {
			const { statusByEnv } = yield* run({ includedEnvironments: ["staging"], withoutMinutely: false })
			expect(statusByEnv).toEqual({ production: "breached", staging: "breached" })
		}),
	)

	it.live("reads the current window from hourly rows on a cluster without the minutely table", () =>
		Effect.gen(function* () {
			const { contexts, statusByEnv } = yield* run({ includedEnvironments: [], withoutMinutely: true })
			expect(contexts).toContain("anomalyTraceSignalsCurrentHourly")
			expect(statusByEnv).toEqual({ production: "breached" })
		}),
	)
})

describe("AnomalyDetectionService settings", () => {
	it.live("saves opted-in environments once each and the next tick watches them", () =>
		Effect.gen(function* () {
			const { saved, statusByEnv } = yield* run({
				includedEnvironments: ["staging", "staging"],
				withoutMinutely: false,
				viaSettingsUpdate: true,
			})
			expect(saved).toEqual(["staging"])
			expect(statusByEnv).toEqual({ production: "breached", staging: "breached" })
		}),
	)
})

/** The `Hour >= '…'` lower bound of a compiled chart query, in epoch ms. */
const queryStartMs = (sql: string): number => {
	const bound = /Hour >= '([0-9-]+ [0-9:]+)'/.exec(sql)?.[1]
	return bound === undefined ? Number.NaN : Date.parse(`${Str.replace(" ", "T")(bound)}Z`)
}

describe("AnomalyDetectionService incident chart", () => {
	it.effect("plots the detector's 60-minute observation for the in-progress hour", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(createdDbs)
			// A fixed mid-hour clock, so the in-progress hour cannot roll over during the test.
			yield* TestClock.setTime(Date.parse("2026-11-16T10:30:00Z"))
			const nowMs = yield* Clock.currentTimeMillis
			const hourStart = Math.floor(nowMs / HOUR_MS) * HOUR_MS
			const incidentId = Schema.decodeSync(AnomalyIncidentId)("00000000-0000-4000-8000-000000000071")
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`INSERT INTO anomaly_incidents
					   (id, org_id, detector_key, signal_type, service_name, deployment_env, status, severity,
					    opened_value, baseline_median, baseline_sigma, threshold_value, last_observed_value,
					    last_sample_count, first_triggered_at, last_triggered_at, triage_status, dedupe_key,
					    fingerprints_json, reopen_count, created_at, updated_at)
					 VALUES ($1, $2, 'throughput:production:payments', 'throughput', 'payments', 'production',
					         'open', 'warning', 1, 100, 10, 5, 1, 60, to_timestamp($3 / 1000.0),
					         to_timestamp($3 / 1000.0), 'none', $1, '[]'::jsonb, 0, now(), now())`,
					[incidentId, ORG, hourStart - HOUR_MS],
				),
			)
			const warehouse = makeWarehouseServiceStub({
				compiledQuery: (_tenant, compiled, options) =>
					compiledQueryOf(compiled)
						.decodeRows(
							options?.context === "anomalyTraceSignalTimeseries"
								? [
										{
											hour: formatWarehouseDateTime(hourStart - HOUR_MS),
											requestCount: 6000,
											errorCount: 0,
											p95Ms: 100,
										},
										// The in-progress hour's partial row; the chart must not show it as the current value.
										{
											hour: formatWarehouseDateTime(hourStart),
											requestCount: 7,
											errorCount: 0,
											p95Ms: 100,
										},
									]
								: options?.context === "anomalyTraceSignalsCurrent"
									? [row("production", hourStart, 3000, 0)]
									: [],
						)
						.pipe(Effect.orDie),
			})
			const series = yield* AnomalyDetectionService.use((service) =>
				service.getIncidentTimeseries(systemTenant(ORG, ALERTING_SYSTEM_USER_ID), incidentId, {}),
			).pipe(Effect.provide(makeLayer(testDb, warehouse)))
			expect(Arr.map(series.buckets, (b) => [b.value, b.sampleCount])).toEqual([
				[100, 6000],
				[50, 3000],
			])
		}),
	)

	it.effect("plots zero for the in-progress hour when the last 60 minutes saw no traffic", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(createdDbs)
			yield* TestClock.setTime(Date.parse("2026-11-16T10:30:00Z"))
			const hourStart = Date.parse("2026-11-16T10:00:00Z")
			const incidentId = Schema.decodeSync(AnomalyIncidentId)("00000000-0000-4000-8000-000000000073")
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`INSERT INTO anomaly_incidents
					   (id, org_id, detector_key, signal_type, service_name, deployment_env, status, severity,
					    opened_value, baseline_median, baseline_sigma, threshold_value, last_observed_value,
					    last_sample_count, first_triggered_at, last_triggered_at, triage_status, dedupe_key,
					    fingerprints_json, reopen_count, created_at, updated_at)
					 VALUES ($1, $2, 'throughput:production:payments', 'throughput', 'payments', 'production',
					         'open', 'warning', 1, 100, 10, 5, 1, 60, to_timestamp($3 / 1000.0),
					         to_timestamp($3 / 1000.0), 'none', $1, '[]'::jsonb, 0, now(), now())`,
					[incidentId, ORG, hourStart - HOUR_MS],
				),
			)
			const warehouse = makeWarehouseServiceStub({
				compiledQuery: (_tenant, compiled, options) =>
					compiledQueryOf(compiled)
						.decodeRows(
							options?.context === "anomalyTraceSignalTimeseries"
								? [
										{
											hour: formatWarehouseDateTime(hourStart - HOUR_MS),
											requestCount: 6000,
											errorCount: 0,
											p95Ms: 100,
										},
									]
								: [],
						)
						.pipe(Effect.orDie),
			})
			const series = yield* AnomalyDetectionService.use((service) =>
				service.getIncidentTimeseries(systemTenant(ORG, ALERTING_SYSTEM_USER_ID), incidentId, {}),
			).pipe(Effect.provide(makeLayer(testDb, warehouse)))
			expect(Arr.map(series.buckets, (b) => [b.bucket, b.value, b.sampleCount])).toEqual([
				["2026-11-16T09:00:00.000Z", 100, 6000],
				["2026-11-16T10:00:00.000Z", 0, 0],
			])
		}),
	)

	it.effect("draws the live error-log point from the previous hour when this hour has no logs yet", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(createdDbs)
			yield* TestClock.setTime(Date.parse("2026-11-16T10:30:00Z"))
			const hourStart = Date.parse("2026-11-16T10:00:00Z")
			const incidentId = Schema.decodeSync(AnomalyIncidentId)("00000000-0000-4000-8000-000000000072")
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`INSERT INTO anomaly_incidents
					   (id, org_id, detector_key, signal_type, service_name, deployment_env, status, severity,
					    opened_value, baseline_median, baseline_sigma, threshold_value, last_observed_value,
					    last_sample_count, first_triggered_at, last_triggered_at, triage_status, dedupe_key,
					    fingerprints_json, reopen_count, created_at, updated_at)
					 VALUES ($1, $2, 'log_volume:production:payments', 'log_volume', 'payments', 'production',
					         'open', 'warning', 1, 1, 1, 1, 1, 60, to_timestamp($3 / 1000.0),
					         to_timestamp($3 / 1000.0), 'none', $1, '[]'::jsonb, 0, now(), now())`,
					[incidentId, ORG, hourStart - HOUR_MS],
				),
			)
			const warehouse = makeWarehouseServiceStub({
				compiledQuery: (_tenant, compiled, options) =>
					compiledQueryOf(compiled)
						.decodeRows(
							// Like the real query, the 09:00 row comes back only when the range starts by 09:00.
							options?.context === "anomalyLogVolumeTimeseries" &&
								queryStartMs(compiledQueryOf(compiled).sql) <= hourStart - HOUR_MS
								? [{ hour: formatWarehouseDateTime(hourStart - HOUR_MS), errorLogCount: 60 }]
								: [],
						)
						.pipe(Effect.orDie),
			})
			const series = yield* AnomalyDetectionService.use((service) =>
				service.getIncidentTimeseries(systemTenant(ORG, ALERTING_SYSTEM_USER_ID), incidentId, {}),
			).pipe(Effect.provide(makeLayer(testDb, warehouse)))
			// Half of 09:00's 60 logs fall in the window 09:30 to 10:30, even when the chart starts at 10:20.
			const recent = yield* AnomalyDetectionService.use((service) =>
				service.getIncidentTimeseries(systemTenant(ORG, ALERTING_SYSTEM_USER_ID), incidentId, {
					startTime: "2026-11-16 10:20:00",
				}),
			).pipe(Effect.provide(makeLayer(testDb, warehouse)))
			expect(Arr.map(recent.buckets, (b) => b.sampleCount)).toEqual([30])
			expect(Arr.map(series.buckets, (b) => [b.bucket, b.value, b.sampleCount])).toEqual([
				["2026-11-16T09:00:00.000Z", 1, 60],
				["2026-11-16T10:00:00.000Z", 0.5, 30],
			])
		}),
	)
})
