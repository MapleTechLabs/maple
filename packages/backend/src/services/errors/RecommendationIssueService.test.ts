import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { OrgId, RecommendationIssueId, UserId } from "@maple/domain/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { RecommendationIssueService } from "./RecommendationIssueService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_recommendations")
const ISSUE = Schema.decodeSync(RecommendationIssueId)("3f9a1b2c-0d4e-4f5a-8b6c-7d8e9f0a1b2c")
const tenant: TenantContext = {
	orgId: ORG,
	userId: Schema.decodeSync(UserId)("user_recommendations"),
	roles: ["org:admin"],
	authMode: "self_hosted",
}

// The key is no longer seen in span telemetry, so reconcile plans the open issue to `resolved`.
const noSpanKeys = makeWarehouseServiceStub({ compiledQuery: () => Effect.succeed([]) })

/**
 * The real PGlite database, except that `onCall` runs just before the given `execute` call:
 * a write that lands between reconcile's read and its updates.
 */
const racingDatabase = (testDb: TestDb, call: number, onCall: Effect.Effect<void>) =>
	Layer.effect(
		Database,
		Effect.gen(function* () {
			const inner = yield* Database
			let calls = 0
			return {
				execute: (fn) =>
					Effect.suspend(() => {
						calls += 1
						return calls === call
							? onCall.pipe(Effect.andThen(inner.execute(fn)))
							: inner.execute(fn)
					}),
			} satisfies typeof inner
		}),
	).pipe(Layer.provide(testDb.layer))

const layerFor = (testDb: TestDb, database: Layer.Layer<Database>) =>
	Layer.effect(RecommendationIssueService, RecommendationIssueService.make).pipe(
		Layer.provide(database),
		Layer.provide(Layer.succeed(WarehouseQueryService, noSpanKeys)),
	)

const seedOpenIssue = (testDb: TestDb) =>
	Effect.promise(() =>
		executeSql(
			testDb,
			`INSERT INTO org_recommendation_issues (id, org_id, number, recommendation_key, kind, source_key, canonical_key, status, usage_count)
			 VALUES ($1, $2, 1, 'rename:http.status_code', 'rename', 'http.status_code', 'http.response.status_code', 'open', 10)`,
			[ISSUE, ORG],
		),
	)

const issueState = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{ status: string; resolved_at: Date | null }>(
			testDb,
			"SELECT status, resolved_at FROM org_recommendation_issues WHERE id = $1",
			[ISSUE],
		),
	)

describe("RecommendationIssueService reconcile", () => {
	it.effect("a dismissal that lands after reconcile read the issue stays dismissed", () => {
		const testDb = createTestDb(trackedDbs)
		// Reconcile has read the issue and not yet written it: it must still be open here.
		const dismissMidReconcile = Effect.gen(function* () {
			assert.strictEqual((yield* issueState(testDb))?.status, "open")
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					"UPDATE org_recommendation_issues SET status = 'dismissed' WHERE id = $1",
					[ISSUE],
				),
			)
			injected = true
		})
		let injected = false
		// Calls: the mappings read, the issues read, then the planned status update.
		const database = racingDatabase(testDb, 3, dismissMidReconcile)
		return Effect.gen(function* () {
			yield* seedOpenIssue(testDb)
			const list = yield* (yield* RecommendationIssueService).listReconciled(tenant)
			assert.isTrue(injected)
			assert.strictEqual(list.issues[0]?.status, "dismissed")
			assert.strictEqual((yield* issueState(testDb))?.status, "dismissed")
		}).pipe(Effect.provide(layerFor(testDb, database)))
	})

	it.effect("dismiss closes the issue with a resolvedAt, like reconcile's resolve", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* seedOpenIssue(testDb)
			const service = yield* RecommendationIssueService
			yield* service.dismiss(tenant, ISSUE)
			assert.isNotNull((yield* issueState(testDb))?.resolved_at)

			yield* service.reopen(tenant, ISSUE)
			yield* service.listReconciled(tenant)
			const resolved = yield* issueState(testDb)
			assert.strictEqual(resolved?.status, "resolved")
			assert.isNotNull(resolved?.resolved_at)
		}).pipe(Effect.provide(layerFor(testDb, testDb.layer)))
	})
})
