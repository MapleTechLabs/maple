import * as PG from "@maple-dev/effect-orm/postgres"
import { ErrorIssueFingerprints, ErrorIssues } from "@maple/db/tables"
import type { MapleDb, MapleDbError } from "@maple/db/client"
import type { ErrorIssueId, OrgId } from "@maple/domain/http"
import { Array as Arr, Effect } from "effect"

interface IssueIdentity {
	readonly id: ErrorIssueId
	readonly fingerprintHash: string
}

/**
 * Every fingerprint each issue owns: its own first, then the merged-in and
 * re-keyed ones, oldest first. A warehouse read for an issue filters on all of them.
 */
export const issueFingerprintHashes = (
	db: MapleDb,
	orgId: OrgId,
	issues: ReadonlyArray<IssueIdentity>,
): Effect.Effect<Map<ErrorIssueId, ReadonlyArray<string>>, MapleDbError> =>
	Effect.gen(function* () {
		const aliases =
			issues.length === 0
				? []
				: yield* db.run(
						PG.from(ErrorIssueFingerprints)
							.select("issueId", "fingerprintHash", "createdAt")
							.where(($) => [
								$.orgId.eq(orgId),
								$.issueId.in_(...Arr.map(issues, (issue) => issue.id)),
							])
							.orderBy(["createdAt", "asc"], ["fingerprintHash", "asc"]),
					)
		return new Map(
			Arr.map(issues, (issue) => [
				issue.id,
				[
					issue.fingerprintHash,
					...Arr.map(
						Arr.filter(aliases, (alias) => alias.issueId === issue.id),
						(alias) => alias.fingerprintHash,
					),
				],
			]),
		)
	})

/**
 * The issue each warehouse hash lands on: through an alias first (a merged-away
 * issue's hash belongs to the issue it was merged into), else the issue it is primary for.
 */
export const issuesOwningHashes = (
	db: MapleDb,
	orgId: OrgId,
	hashes: ReadonlyArray<string>,
): Effect.Effect<
	Map<string, { readonly issueId: ErrorIssueId; readonly firstSeenAt: number }>,
	MapleDbError
> =>
	Effect.gen(function* () {
		if (hashes.length === 0) return new Map()
		const primaries = yield* db.run(
			PG.from(ErrorIssues)
				.select(($) => ({ hash: $.fingerprintHash, issueId: $.id, firstSeenAt: $.firstSeenAt }))
				.where(($) => [$.orgId.eq(orgId), $.fingerprintHash.in_(...hashes)]),
		)
		const aliases = yield* db.run(
			PG.from(ErrorIssueFingerprints)
				.innerJoin(ErrorIssues, "issue", (alias, issue) => issue.id.eq(alias.issueId))
				.select(($) => ({
					hash: $.fingerprintHash,
					issueId: $.issue.id,
					firstSeenAt: $.issue.firstSeenAt,
				}))
				.where(($) => [$.orgId.eq(orgId), $.issue.orgId.eq(orgId), $.fingerprintHash.in_(...hashes)]),
		)
		return new Map(Arr.map([...primaries, ...aliases], ({ hash, ...owner }) => [hash, owner] as const))
	})
