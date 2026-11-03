import * as PG from "@maple-dev/effect-orm/postgres"
import {
	ErrorIssueEvents,
	ErrorIssueFingerprints,
	ErrorIssues,
	ErrorTickStates,
	type ErrorIssueRow,
} from "@maple/db/tables"
import {
	type ActorId,
	type ErrorIssueDocument,
	type ErrorIssueId,
	ErrorIssueNotFoundError,
	type ErrorPersistenceError,
	ErrorValidationError,
	type OrgId,
} from "@maple/domain/http"
import { Clock, Context, Effect, Layer, Array as Arr } from "effect"
import type { MapleDb } from "@maple/db/client"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { ErrorIssueWorkflowService } from "./ErrorIssueWorkflowService"
import { makeErrorDatabaseExecute } from "./error-persistence"
import { foldIssues } from "./issue-fold"

/** Enough for a cleanup pass over one bug's splinters, small enough for one statement each. */
export const MAX_MERGE_SOURCES = 50

type MergeError = ErrorPersistenceError | ErrorIssueNotFoundError | ErrorValidationError

export interface ErrorIssueMergeServiceApi {
	/**
	 * Fold `sourceIds` into `targetId`: their fingerprints land on the target from now
	 * on, their counts add to it, and each source is archived pointing at the target.
	 */
	readonly mergeIssues: (
		orgId: OrgId,
		actorId: ActorId,
		targetId: ErrorIssueId,
		sourceIds: ReadonlyArray<ErrorIssueId>,
	) => Effect.Effect<ErrorIssueDocument, MergeError>
	/** Undo one merge: the issue gets its fingerprints back and leaves the archive. */
	readonly unmergeIssue: (
		orgId: OrgId,
		actorId: ActorId,
		issueId: ErrorIssueId,
	) => Effect.Effect<ErrorIssueDocument, MergeError>
}

const invalid = (message: string, details: ReadonlyArray<string> = []) =>
	new ErrorValidationError({ message, details: [...details] })

const make: Effect.Effect<ErrorIssueMergeServiceApi, never, Database | ErrorIssueWorkflowService> =
	Effect.gen(function* () {
		const database = yield* Database
		const workflow = yield* ErrorIssueWorkflowService
		const dbExecute = makeErrorDatabaseExecute(database, "ErrorIssueMergeService")

		/**
		 * The org's tick cursor, then the issues in id order. Holding the cursor keeps the
		 * errors tick from landing a window between our reads and writes, which could put a
		 * merged issue's occurrences back on it; one ordered lock keeps overlapping merges
		 * from deadlocking.
		 */
		const lockIssues = (db: MapleDb, orgId: OrgId, ids: ReadonlyArray<ErrorIssueId>) =>
			Effect.gen(function* () {
				yield* db.run(
					PG.from(ErrorTickStates)
						.select("orgId")
						.where(($) => [$.orgId.eq(orgId)])
						.forUpdate(),
				)
				return yield* db.run(
					PG.from(ErrorIssues)
						.select()
						.where(($) => [$.orgId.eq(orgId), $.id.in_(...ids)])
						.orderBy(["id", "asc"])
						.forUpdate(),
				)
			})

		/** Why `source` cannot be merged into `target`, or none. */
		const mergeProblem = (target: ErrorIssueRow, source: ErrorIssueRow): string | undefined => {
			if (source.kind !== "error") return `${source.id} is an ${source.kind} issue`
			if (source.mergedIntoIssueId !== null) return `${source.id} is already merged into another issue`
			if (source.archivedAt !== null) return `${source.id} is archived`
			if (source.id === target.id) return "an issue cannot be merged into itself"
			return undefined
		}

		const mergeIssues: ErrorIssueMergeServiceApi["mergeIssues"] = Effect.fn(
			"ErrorIssueMergeService.mergeIssues",
		)(function* (orgId, actorId, targetId, sourceIds) {
			const sources = Arr.dedupe(Arr.filter(sourceIds, (id) => id !== targetId))
			yield* Effect.annotateCurrentSpan({
				orgId,
				"maple.issue.id": targetId,
				"maple.issue.merge.source_count": sources.length,
			})
			if (sources.length === 0) return yield* invalid("Pick at least one other issue to merge in.")
			if (sources.length > MAX_MERGE_SOURCES) {
				return yield* invalid(`Merge at most ${MAX_MERGE_SOURCES} issues at a time.`)
			}
			const timestamp = yield* Clock.currentTimeMillis

			yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						const rows = yield* lockIssues(db, orgId, [targetId, ...sources])
						const target = rows.find((row) => row.id === targetId)
						if (target === undefined) return yield* ErrorIssueNotFoundError.forIssue(targetId)
						if (target.kind !== "error") return yield* invalid("Only error issues can be merged.")
						if (target.mergedIntoIssueId !== null || target.archivedAt !== null) {
							return yield* invalid("The issue to keep is archived or merged away.")
						}
						const missing = sources.find((id) => !rows.some((row) => row.id === id))
						if (missing !== undefined) return yield* ErrorIssueNotFoundError.forIssue(missing)
						const merged = Arr.filter(rows, (row) => row.id !== targetId)
						const problems = Arr.flatMap(merged, (row) => {
							const problem = mergeProblem(target, row)
							return problem === undefined ? [] : [problem]
						})
						if (problems.length > 0)
							return yield* invalid("These issues cannot be merged.", problems)

						yield* foldIssues(db, {
							orgId,
							target,
							sources: merged,
							timestamp,
							event: (issueId, payload) =>
								workflow.buildEvent(orgId, issueId, actorId, "merge", timestamp, { payload }),
						})
					}),
				),
			)
			yield* workflow.recordEventAudit(orgId, targetId, actorId, "merge", {})
			const kept = yield* workflow.requireIssue(orgId, targetId)
			return yield* workflow.hydrateIssue(orgId, kept)
		})

		const unmergeIssue: ErrorIssueMergeServiceApi["unmergeIssue"] = Effect.fn(
			"ErrorIssueMergeService.unmergeIssue",
		)(function* (orgId, actorId, issueId) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.issue.id": issueId })
			const timestamp = yield* Clock.currentTimeMillis
			yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						const [unlocked] = yield* db.run(
							PG.from(ErrorIssues)
								.select("mergedIntoIssueId")
								.where(($) => [$.orgId.eq(orgId), $.id.eq(issueId)]),
						)
						if (unlocked === undefined) return yield* ErrorIssueNotFoundError.forIssue(issueId)
						if (unlocked.mergedIntoIssueId === null) {
							return yield* invalid("This issue is not merged into another.")
						}
						const locked = yield* lockIssues(db, orgId, [issueId, unlocked.mergedIntoIssueId])
						const issue = locked.find((row) => row.id === issueId)
						const targetId = issue?.mergedIntoIssueId ?? null
						// Re-read under the lock: a concurrent unmerge or merge may have moved it.
						if (issue === undefined || targetId !== unlocked.mergedIntoIssueId) {
							return yield* invalid("This issue changed while unmerging; try again.")
						}
						const target = locked.find((row) => row.id === targetId)

						// Its own hash goes back to being its primary; any others it brought
						// become its aliases again.
						yield* db.run(
							PG.deleteFrom(ErrorIssueFingerprints).where(($) => [
								$.orgId.eq(orgId),
								$.originIssueId.eq(issueId),
								$.fingerprintHash.eq(issue.fingerprintHash),
							]),
						)
						yield* db.run(
							PG.update(ErrorIssueFingerprints)
								.set({ issueId, originIssueId: null })
								.where(($) => [$.orgId.eq(orgId), $.originIssueId.eq(issueId)]),
						)
						yield* db.run(
							PG.update(ErrorIssues)
								.set({ mergedIntoIssueId: null, archivedAt: null, updatedAt: timestamp })
								.where(($) => [$.orgId.eq(orgId), $.id.eq(issueId)]),
						)
						if (target !== undefined) {
							yield* db.run(
								PG.update(ErrorIssues)
									.set({
										occurrenceCount: Math.max(
											0,
											target.occurrenceCount - issue.occurrenceCount,
										),
										updatedAt: timestamp,
									})
									.where(($) => [$.orgId.eq(orgId), $.id.eq(targetId)]),
							)
						}
						yield* db.run(
							PG.insertInto(ErrorIssueEvents).values([
								workflow.buildEvent(orgId, issueId, actorId, "unmerge", timestamp, {
									payload: { role: "source", fromIssueId: targetId },
								}),
								workflow.buildEvent(orgId, targetId, actorId, "unmerge", timestamp, {
									payload: {
										role: "target",
										issueId,
										label: issue.errorLabel || issue.exceptionType,
									},
								}),
							]),
						)
					}),
				),
			)
			yield* workflow.recordEventAudit(orgId, issueId, actorId, "unmerge", {})
			const restored = yield* workflow.requireIssue(orgId, issueId)
			return yield* workflow.hydrateIssue(orgId, restored)
		})

		return { mergeIssues, unmergeIssue }
	})

export class ErrorIssueMergeService extends Context.Service<
	ErrorIssueMergeService,
	ErrorIssueMergeServiceApi
>()("@maple/backend/services/errors/ErrorIssueMergeService", { make }) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(ErrorIssueWorkflowService.layer))
}
