import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/http"
import { GcpConnectorId, UserId } from "@maple/primitives"
import { Array as Arr, Effect, Layer, Schema, String as Str } from "effect"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	insertTestSource,
	type TestDb,
} from "@maple/backend/testing/test-pglite"
import { GcpCostSourceService } from "./GcpCostSourceService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_gcp")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_other")
const USER = Schema.decodeSync(UserId)("user_1")
const CONNECTOR = Schema.decodeSync(GcpConnectorId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")
const TABLE = "billing-proj.exports.gcp_billing_export_resource_v1_01ABCD_234567_89ABCD"

const insertConnector = (testDb: TestDb, metricsEnabled = true) =>
	Effect.promise(async () => {
		const sourceId = await insertTestSource(testDb, {
			orgId: ORG,
			platform: "gcp",
			name: "Google Cloud acme-prod",
		})
		await executeSql(
			testDb,
			`INSERT INTO gcp_connectors
			   (id, org_id, scope_type, scope_id, project_id, secret_ciphertext, secret_iv, secret_tag,
			    secret_hash, metrics_enabled, created_by, created_at, updated_at, source_id)
			 VALUES ($1, $2, 'project', 'acme-prod', 'acme-prod', 'c', 'i', 't', $1, $3, 'user_1', now(), now(), $4)`,
			[CONNECTOR, ORG, metricsEnabled, sourceId],
		)
	})

const costSources = (testDb: TestDb) =>
	Effect.promise(async () => {
		const result = await testDb.pglite.query<{ org_id: string; provider: string; account_id: string }>(
			"SELECT org_id, provider, account_id FROM cost_sources ORDER BY created_at",
		)
		return result.rows
	})

const run = <A, E>(testDb: TestDb, effect: Effect.Effect<A, E, GcpCostSourceService>) =>
	effect.pipe(
		Effect.provide(
			Layer.effect(GcpCostSourceService, GcpCostSourceService.make).pipe(Layer.provide(testDb.layer)),
		),
	)

const service = GcpCostSourceService

describe("GcpCostSourceService", () => {
	it.effect("adds an export as a source once, and lists it with the connector's reader account", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertConnector(testDb)
			const first = yield* run(
				testDb,
				service.use((s) => s.add(ORG, USER, CONNECTOR, ` ${Str.replace(".", ":")(TABLE)} `)),
			)
			assert.isTrue(first.created)
			assert.deepStrictEqual(
				[first.export.tableRef, first.export.billingAccountId, first.export.detailed],
				[TABLE, "01ABCD-234567-89ABCD", true],
			)
			const again = yield* run(
				testDb,
				service.use((s) => s.add(ORG, USER, CONNECTOR, TABLE)),
			)
			assert.deepStrictEqual([again.created, again.export.id], [false, first.export.id])
			assert.deepStrictEqual(yield* costSources(testDb), [
				{ org_id: ORG, provider: "gcp", account_id: "01ABCD-234567-89ABCD" },
			])

			const status = yield* run(
				testDb,
				service.use((s) => s.status(ORG)),
			)
			assert.deepStrictEqual(
				Arr.map(status.connectors, (c) => [c.id, c.metricsEnabled, c.readerEmail]),
				[[CONNECTOR, true, "maple-018f2b3c4d5e4f708192a3b4@acme-prod.iam.gserviceaccount.com"]],
			)
			assert.deepStrictEqual(
				Arr.map(status.exports, (e) => e.id),
				[first.export.id],
			)
		})
	})

	it.effect("refuses a second export of one billing account, which would count its spend twice", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertConnector(testDb)
			yield* run(
				testDb,
				service.use((s) => s.add(ORG, USER, CONNECTOR, TABLE)),
			)
			const standard = "billing-proj.exports.gcp_billing_export_v1_01ABCD_234567_89ABCD"
			const error = yield* Effect.flip(
				run(
					testDb,
					service.use((s) => s.add(ORG, USER, CONNECTOR, standard)),
				),
			)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
			assert.include(error.message, `from ${TABLE}`)
			assert.lengthOf(yield* costSources(testDb), 1)
		})
	})

	it.effect("refuses a table that is not a billing export, and a connector without a reader", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertConnector(testDb, false)
			const notExport = yield* Effect.flip(
				run(
					testDb,
					service.use((s) => s.add(ORG, USER, CONNECTOR, "billing-proj.exports.costs")),
				),
			)
			assert.strictEqual(notExport._tag, "@maple/http/errors/IntegrationsValidationError")
			const noReader = yield* Effect.flip(
				run(
					testDb,
					service.use((s) => s.add(ORG, USER, CONNECTOR, TABLE)),
				),
			)
			assert.include(noReader.message, "Metrics and resources")
			assert.deepStrictEqual(yield* costSources(testDb), [])
		})
	})

	it.effect("never adds through another org's connector", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertConnector(testDb)
			const error = yield* Effect.flip(
				run(
					testDb,
					service.use((s) => s.add(OTHER_ORG, USER, CONNECTOR, TABLE)),
				),
			)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsNotConnectedError")
			assert.deepStrictEqual(yield* costSources(testDb), [])
		})
	})

	it.effect("removes the export with its source, only in the caller's org", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertConnector(testDb)
			const added = yield* run(
				testDb,
				service.use((s) => s.add(ORG, USER, CONNECTOR, TABLE)),
			)
			const elsewhere = yield* run(
				testDb,
				service.use((s) => s.remove(OTHER_ORG, added.export.id)),
			)
			assert.isFalse(elsewhere.removed)
			assert.lengthOf(yield* costSources(testDb), 1)
			const removed = yield* run(
				testDb,
				service.use((s) => s.remove(ORG, added.export.id)),
			)
			assert.isTrue(removed.removed)
			assert.deepStrictEqual(yield* costSources(testDb), [])
			assert.deepStrictEqual(
				(yield* run(
					testDb,
					service.use((s) => s.status(ORG)),
				)).exports,
				[],
			)
		})
	})
})
