import { randomUUID } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Clock, Effect, Layer, Schema, Array as Arr } from "effect"
import { ErrorIssueId, OrgId, UserId } from "@maple/domain/primitives"
import { ErrorIssueEvents, ErrorIssueFingerprints, ErrorIssues } from "@maple/db/tables"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { ErrorActorsService } from "./ErrorActorsService"
import { ErrorIssueMergeService } from "./ErrorIssueMergeService"
import { ErrorIssueWorkflowService } from "./ErrorIssueWorkflowService"

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asIssueId = Schema.decodeUnknownSync(ErrorIssueId)

const ORG = asOrgId("org_error_issue_merge_test")
const USER = asUserId("user_error_issue_merge_test")
const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const makeLayer = () => {
	const database = createTestDb(createdDbs).layer
	const actors = ErrorActorsService.layer.pipe(Layer.provide(database))
	const workflow = Layer.effect(ErrorIssueWorkflowService, ErrorIssueWorkflowService.make).pipe(
		Layer.provide(Layer.mergeAll(database, actors, AuditLogService.layerMemory)),
	)
	const merges = Layer.effect(ErrorIssueMergeService, ErrorIssueMergeService.make).pipe(
		Layer.provide(Layer.mergeAll(database, workflow)),
	)
	return Layer.mergeAll(merges, workflow, actors).pipe(Layer.provideMerge(database))
}

const seedIssue = (fingerprintHash: string, overrides: Partial<PG.InsertRowOf<typeof ErrorIssues>> = {}) =>
	Effect.gen(function* () {
		const database = yield* Database
		const now = yield* Clock.currentTimeMillis
		const id = asIssueId(randomUUID())
		yield* database.execute((db) =>
			db.run(
				PG.insertInto(ErrorIssues).values({
					id,
					orgId: ORG,
					fingerprintHash,
					serviceName: "checkout-api",
					exceptionType: "TimeoutError",
					exceptionMessage: "upstream timed out",
					topFrame: "",
					firstSeenAt: now,
					lastSeenAt: now,
					createdAt: now,
					updatedAt: now,
					...overrides,
				}),
			),
		)
		return id
	})

const loadIssue = (id: ErrorIssueId) =>
	Effect.gen(function* () {
		const database = yield* Database
		const rows = yield* database.execute((db) =>
			db.run(
				PG.from(ErrorIssues)
					.select()
					.where(($) => [$.id.eq(id)]),
			),
		)
		return rows[0]!
	})

const aliasesOf = (issueId: ErrorIssueId) =>
	Effect.gen(function* () {
		const database = yield* Database
		const rows = yield* database.execute((db) =>
			db.run(
				PG.from(ErrorIssueFingerprints)
					.select("fingerprintHash", "originIssueId")
					.where(($) => [$.issueId.eq(issueId)])
					.orderBy(["fingerprintHash", "asc"]),
			),
		)
		return rows
	})

const actor = Effect.gen(function* () {
	const actors = yield* ErrorActorsService
	return (yield* actors.ensureUserActor(ORG, USER)).id
})

describe("ErrorIssueMergeService", () => {
	it.effect("folds duplicates into the kept issue and archives them pointing at it", () =>
		Effect.gen(function* () {
			const merges = yield* ErrorIssueMergeService
			const database = yield* Database
			const actorId = yield* actor
			const now = yield* Clock.currentTimeMillis
			const target = yield* seedIssue("100", {
				occurrenceCount: 10,
				seenVersionsJson: ["1.0.0"],
				firstSeenAt: now - 5_000,
			})
			const first = yield* seedIssue("200", {
				occurrenceCount: 4,
				seenVersionsJson: ["1.1.0"],
				firstSeenAt: now - 9_000,
			})
			const second = yield* seedIssue("300", { occurrenceCount: 1, lastSeenAt: now + 1_000 })

			const merged = yield* merges.mergeIssues(ORG, actorId, target, [first, second, target, first])

			assert.deepStrictEqual(merged.fingerprintHashes, ["100", "200", "300"])
			assert.strictEqual(merged.occurrenceCount, 15)
			const kept = yield* loadIssue(target)
			assert.strictEqual(kept.firstSeenAt, now - 9_000)
			assert.strictEqual(kept.lastSeenAt, now + 1_000)
			assert.sameMembers([...kept.seenVersionsJson], ["1.0.0", "1.1.0"])
			for (const id of [first, second]) {
				const source = yield* loadIssue(id)
				assert.strictEqual(source.mergedIntoIssueId, target)
				assert.isNotNull(source.archivedAt)
			}
			assert.deepStrictEqual(yield* aliasesOf(target), [
				{ fingerprintHash: "200", originIssueId: first },
				{ fingerprintHash: "300", originIssueId: second },
			])
			const events = yield* database.execute((db) =>
				db.run(
					PG.from(ErrorIssueEvents)
						.select("issueId", "type")
						.where(($) => [$.type.eq("merge")]),
				),
			)
			assert.sameMembers(
				Arr.map(events, (event) => event.issueId),
				[target, first, second],
			)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("carries an earlier merge along when its owner is merged", () =>
		Effect.gen(function* () {
			const merges = yield* ErrorIssueMergeService
			const actorId = yield* actor
			const target = yield* seedIssue("100")
			const middle = yield* seedIssue("200")
			const inner = yield* seedIssue("300")

			yield* merges.mergeIssues(ORG, actorId, middle, [inner])
			const merged = yield* merges.mergeIssues(ORG, actorId, target, [middle])

			assert.deepStrictEqual([...merged.fingerprintHashes].sort(), ["100", "200", "300"])
			assert.strictEqual((yield* loadIssue(inner)).mergedIntoIssueId, target)
			assert.lengthOf(yield* aliasesOf(middle), 0)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("refuses merges that would lose or corrupt an issue", () =>
		Effect.gen(function* () {
			const merges = yield* ErrorIssueMergeService
			const actorId = yield* actor
			const target = yield* seedIssue("100")
			const alert = yield* seedIssue("alert:rule:group", { kind: "alert" })
			const archived = yield* seedIssue("400", { archivedAt: 1 })

			const self = yield* Effect.flip(merges.mergeIssues(ORG, actorId, target, [target]))
			assert.strictEqual(self._tag, "@maple/http/errors/ErrorValidationError")
			const wrongKind = yield* Effect.flip(merges.mergeIssues(ORG, actorId, target, [alert]))
			assert.strictEqual(wrongKind._tag, "@maple/http/errors/ErrorValidationError")
			const gone = yield* Effect.flip(merges.mergeIssues(ORG, actorId, target, [archived]))
			assert.strictEqual(gone._tag, "@maple/http/errors/ErrorValidationError")
			const missing = yield* Effect.flip(
				merges.mergeIssues(ORG, actorId, target, [asIssueId(randomUUID())]),
			)
			assert.strictEqual(missing._tag, "@maple/http/errors/ErrorIssueNotFoundError")
			// Nothing moved.
			assert.lengthOf(yield* aliasesOf(target), 0)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("unmerging hands an issue its fingerprints back", () =>
		Effect.gen(function* () {
			const merges = yield* ErrorIssueMergeService
			const actorId = yield* actor
			const target = yield* seedIssue("100", { occurrenceCount: 10 })
			const source = yield* seedIssue("200", { occurrenceCount: 4 })
			const other = yield* seedIssue("300", { occurrenceCount: 1 })
			yield* merges.mergeIssues(ORG, actorId, target, [source, other])

			const restored = yield* merges.unmergeIssue(ORG, actorId, source)

			assert.isNull(restored.mergedIntoIssueId)
			assert.isNull(restored.archivedAt)
			assert.deepStrictEqual(restored.fingerprintHashes, ["200"])
			const kept = yield* loadIssue(target)
			assert.strictEqual(kept.occurrenceCount, 11)
			assert.deepStrictEqual(yield* aliasesOf(target), [
				{ fingerprintHash: "300", originIssueId: other },
			])
			const again = yield* Effect.flip(merges.unmergeIssue(ORG, actorId, source))
			assert.strictEqual(again._tag, "@maple/http/errors/ErrorValidationError")
		}).pipe(Effect.provide(makeLayer())),
	)
})
