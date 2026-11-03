import * as PG from "@maple-dev/effect-orm/postgres"
import {
	ErrorIncidents,
	ErrorIssueEvents,
	ErrorIssueFingerprints,
	ErrorIssues,
	ErrorIssueStates,
	type ErrorIssueEventInsert,
	type ErrorIssueRow,
} from "@maple/db/tables"
import type { MapleDb, MapleDbError } from "@maple/db/client"
import type { ErrorIssueId, OrgId } from "@maple/domain/http"
import { Effect, Array as Arr } from "effect"
import { mergeVersions } from "./issue-versions"

/**
 * Fold `sources` into `target`, already validated and locked by the caller: their
 * fingerprints become the target's aliases, their counts and builds add to it, and
 * each is archived pointing at it. Shared by a user's merge and a version bump's re-key.
 */
export const foldIssues = (
	db: MapleDb,
	input: {
		readonly orgId: OrgId
		readonly target: ErrorIssueRow
		readonly sources: ReadonlyArray<ErrorIssueRow>
		readonly timestamp: number
		readonly event: (issueId: ErrorIssueId, payload: Record<string, unknown>) => ErrorIssueEventInsert
	},
): Effect.Effect<void, MapleDbError> =>
	Effect.gen(function* () {
		const { orgId, target, timestamp, event } = input
		const merged = input.sources
		if (merged.length === 0) return
		const sourceIds = Arr.map(merged, (row) => row.id)
		// A source's own aliases travel with it; the ones it re-keyed itself
		// become its own, so unmerging it hands them back.
		yield* db.run(
			PG.update(ErrorIssueFingerprints)
				.set(($) => ({
					issueId: target.id,
					originIssueId: PG.coalesce($.originIssueId, $.issueId),
				}))
				.where(($) => [$.orgId.eq(orgId), $.issueId.in_(...sourceIds)]),
		)
		yield* db.run(
			PG.insertInto(ErrorIssueFingerprints).values(
				Arr.map(merged, (row) => ({
					orgId,
					fingerprintHash: row.fingerprintHash,
					issueId: target.id,
					source: "merge" as const,
					originIssueId: row.id,
					createdAt: timestamp,
				})),
			),
		)
		// Issues merged into a source earlier now point at the target directly, so
		// the source keeps only its own share of the count: unmerging it later
		// takes back what it brought and leaves its old children on the target.
		const children = yield* db.run(
			PG.from(ErrorIssues)
				.select("mergedIntoIssueId", "occurrenceCount")
				.where(($) => [$.orgId.eq(orgId), $.mergedIntoIssueId.in_(...sourceIds)]),
		)
		yield* db.run(
			PG.update(ErrorIssues)
				.set({ mergedIntoIssueId: target.id, updatedAt: timestamp })
				.where(($) => [$.orgId.eq(orgId), $.mergedIntoIssueId.in_(...sourceIds)]),
		)
		yield* Effect.forEach(
			Arr.filter(merged, (row) => children.some((child) => child.mergedIntoIssueId === row.id)),
			(row) =>
				db.run(
					PG.update(ErrorIssues)
						.set({
							occurrenceCount: Math.max(
								0,
								row.occurrenceCount -
									Arr.reduce(
										Arr.filter(children, (child) => child.mergedIntoIssueId === row.id),
										0,
										(sum, child) => sum + child.occurrenceCount,
									),
							),
						})
						.where(($) => [$.orgId.eq(orgId), $.id.eq(row.id)]),
				),
			{ discard: true },
		)
		// A merged issue's open incident would otherwise resolve on its own a
		// half hour later and send a "resolved" for a bug that is still firing.
		yield* db.run(
			PG.update(ErrorIncidents)
				.set({ status: "resolved", resolvedAt: timestamp, updatedAt: timestamp })
				.where(($) => [$.orgId.eq(orgId), $.issueId.in_(...sourceIds), $.status.eq("open")]),
		)
		yield* db.run(
			PG.update(ErrorIssueStates)
				.set({ openIncidentId: null, updatedAt: timestamp })
				.where(($) => [$.orgId.eq(orgId), $.issueId.in_(...sourceIds)]),
		)
		yield* db.run(
			PG.update(ErrorIssues)
				.set({
					mergedIntoIssueId: target.id,
					archivedAt: timestamp,
					leaseHolderActorId: null,
					leaseExpiresAt: null,
					claimedAt: null,
					updatedAt: timestamp,
				})
				.where(($) => [$.orgId.eq(orgId), $.id.in_(...sourceIds)]),
		)
		yield* db.run(
			PG.update(ErrorIssues)
				.set({
					occurrenceCount:
						target.occurrenceCount +
						Arr.reduce(merged, 0, (sum, row) => sum + row.occurrenceCount),
					firstSeenAt: Math.min(target.firstSeenAt, ...Arr.map(merged, (row) => row.firstSeenAt)),
					lastSeenAt: Math.max(target.lastSeenAt, ...Arr.map(merged, (row) => row.lastSeenAt)),
					seenVersionsJson: Arr.reduce(merged, target.seenVersionsJson, (versions, row) =>
						mergeVersions(versions, row.seenVersionsJson),
					),
					updatedAt: timestamp,
				})
				.where(($) => [$.orgId.eq(orgId), $.id.eq(target.id)]),
		)
		yield* db.run(
			PG.insertInto(ErrorIssueEvents).values([
				event(target.id, {
					role: "target",
					issueIds: Arr.map(merged, (row) => row.id),
					labels: Arr.map(merged, (row) => row.errorLabel || row.exceptionType),
				}),
				...Arr.map(merged, (row) =>
					event(row.id, {
						role: "source",
						intoIssueId: target.id,
						label: target.errorLabel || target.exceptionType,
					}),
				),
			]),
		)
	})
