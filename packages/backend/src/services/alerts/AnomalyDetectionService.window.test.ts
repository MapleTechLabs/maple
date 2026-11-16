import { describe, expect, it } from "@effect/vitest"
import { afterEach } from "vitest"
import { OrgId, WarehouseConfigError } from "@maple/domain/http"
import { Clock, ConfigProvider, Effect, Layer, Record, Schema, Array as Arr } from "effect"
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
}

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
		const layer = Layer.effect(AnomalyDetectionService, AnomalyDetectionService.make).pipe(
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
		yield* Effect.promise(() =>
			executeSql(
				testDb,
				`INSERT INTO anomaly_detector_settings
				   (org_id, enabled, sensitivity, muted_signals_json, included_environments_json, created_at, updated_at)
				 VALUES ($1, true, 'normal', '[]'::jsonb, $2::jsonb, now(), now())`,
				[ORG, JSON.stringify(scenario.includedEnvironments)],
			),
		)
		yield* AnomalyDetectionService.use((service) => service.runTick).pipe(Effect.provide(layer))
		const states = yield* Effect.promise(() =>
			testDb.pglite.query<{ deployment_env: string; last_status: string }>(
				`SELECT deployment_env, last_status FROM anomaly_detector_states
				 WHERE org_id = $1 AND signal_type = 'error_rate'`,
				[ORG],
			),
		)
		return {
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
