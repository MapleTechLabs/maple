import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { InvestigationId, OrgId } from "@maple/domain/http"
import { aiTriageSettings, investigations } from "@maple/db"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { AiTriageService } from "./AiTriageService"

const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			MCP_PORT: "3473",
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

const makeLayer = () => {
	const testDb = createTestDb(createdDbs)
	return AiTriageService.layer.pipe(
		Layer.provideMerge(testDb.layer),
		Layer.provideMerge(Env.layer),
		Layer.provide(testConfig()),
	)
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asInvestigationId = Schema.decodeUnknownSync(InvestigationId)
const ORG = asOrgId("org_triage_settings_test")

const seedSettings = (maxRunsPerDay: number, maxPassesPerDay: number) =>
	Effect.gen(function* () {
		const database = yield* Database
		yield* database.execute((db) =>
			db.insert(aiTriageSettings).values({
				orgId: ORG,
				enabled: true,
				maxRunsPerDay,
				maxPassesPerDay,
				updatedAt: new Date(),
			}),
		)
	})

/**
 * Usage is counted from started rows as `fanoutSize + 1` for legacy fan-out rows
 * and 1 for a single-agent run. Seeding rows rather than driving the enqueue path
 * keeps the arithmetic under the test's control.
 */
const seedStartedRuns = (count: number, fanoutSize: number, idOffset = 0) =>
	Effect.gen(function* () {
		const database = yield* Database
		const now = new Date()
		for (let index = 0; index < count; index++) {
			yield* database.execute((db) =>
				db.insert(investigations).values({
					id: asInvestigationId(
						`00000000-0000-4000-8000-${String(idOffset + index).padStart(12, "0")}`,
					),
					orgId: ORG,
					status: "investigating",
					seededBy: "system",
					subjectJson: { type: "question", question: "seed" },
					fanoutSize,
					startedAt: now,
					createdAt: now,
					updatedAt: now,
				}),
			)
		}
	})

describe("AiTriageService.getSettings pause state", () => {
	it.effect("reports triage healthy while both ceilings have room", () =>
		Effect.gen(function* () {
			yield* seedSettings(50, 100)
			const doc = yield* (yield* AiTriageService).getSettings(ORG)
			assert.isFalse(doc.ordinaryPaused)
			assert.isFalse(doc.priorityPaused)
			assert.isNull(doc.pausedDimension)
			assert.isNull(doc.resumesAt)
		}).pipe(Effect.provide(makeLayer())),
	)

	/** The probe costs what a start spends: one pass. */
	it.effect("pauses ordinary triage once the ordinary slice is spent", () =>
		Effect.gen(function* () {
			// Ordinary slice of a 100-pass ceiling is 70. Land usage exactly on it:
			// 70 + 1 > 70 refuses an ordinary start while 70 + 1 <= 100 lets a critical through.
			yield* seedSettings(500, 100)
			yield* seedStartedRuns(17, 3) // 17 x 4 = 68, legacy fan-out rows
			yield* seedStartedRuns(2, 1, 100) // a single-agent run is worth 1
			const doc = yield* (yield* AiTriageService).getSettings(ORG)
			assert.strictEqual(doc.usage.passes, 70)
			assert.isTrue(doc.ordinaryPaused)
			assert.strictEqual(doc.pausedDimension, "passes_reserved")
			// The reserve is the whole point: criticals are still starting here.
			assert.isFalse(doc.priorityPaused)
			assert.isNotNull(doc.resumesAt)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("pauses priority triage too once the full ceiling is spent", () =>
		Effect.gen(function* () {
			yield* seedSettings(500, 100)
			yield* seedStartedRuns(25, 3) // 100 passes; 100 + 1 > 100
			const doc = yield* (yield* AiTriageService).getSettings(ORG)
			assert.isTrue(doc.ordinaryPaused)
			assert.isTrue(doc.priorityPaused)
		}).pipe(Effect.provide(makeLayer())),
	)

	/**
	 * The runs ceiling is checked before any pass arithmetic and has no reserve,
	 * so it stops every severity. Reporting it as a pass problem would tell an
	 * operator that criticals are covered when they are not, and point them at a
	 * number that was never the constraint.
	 */
	it.effect("names the runs ceiling and pauses every severity with it", () =>
		Effect.gen(function* () {
			yield* seedSettings(3, 10_000)
			yield* seedStartedRuns(3, 3)
			const doc = yield* (yield* AiTriageService).getSettings(ORG)
			assert.strictEqual(doc.pausedDimension, "runs")
			assert.isTrue(doc.ordinaryPaused)
			assert.isTrue(doc.priorityPaused)
		}).pipe(Effect.provide(makeLayer())),
	)
})
