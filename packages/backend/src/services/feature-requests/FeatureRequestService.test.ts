import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { Effect, Layer, Schema } from "effect"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { FeatureRequestService } from "./FeatureRequestService"

const ORG = Schema.decodeSync(OrgId)("org_feature_requests")
const USER = Schema.decodeSync(UserId)("user_feature_requests")

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const makeLayer = (testDb: TestDb) =>
	Layer.effect(FeatureRequestService, FeatureRequestService.make).pipe(Layer.provide(testDb.layer))

interface StoredRequest {
	readonly org_id: string
	readonly user_id: string
	readonly area: string
	readonly subject: string
	readonly note: string | null
}

const stored = (testDb: TestDb, id: string) =>
	Effect.promise(() =>
		queryFirstRow<StoredRequest>(
			testDb,
			"SELECT org_id, user_id, area, subject, note FROM feature_requests WHERE id = $1",
			[id],
		),
	)

describe("FeatureRequestService", () => {
	it.effect("records who asked for what, where, with their note", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const requests = yield* FeatureRequestService
			const { id } = yield* requests.create(ORG, USER, {
				area: "cost_source",
				subject: "Hetzner",
				note: "  Our servers run there  ",
			})
			assert.deepStrictEqual(yield* stored(testDb, id), {
				org_id: ORG,
				user_id: USER,
				area: "cost_source",
				subject: "Hetzner",
				note: "Our servers run there",
			})
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("keeps no note when none, or only spaces, was given", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const requests = yield* FeatureRequestService
			const bare = yield* requests.create(ORG, USER, { area: "cost_source", subject: "Fly.io" })
			const blank = yield* requests.create(ORG, USER, {
				area: "cost_source",
				subject: "Render",
				note: "   ",
			})
			assert.isNull((yield* stored(testDb, bare.id))?.note)
			assert.isNull((yield* stored(testDb, blank.id))?.note)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
