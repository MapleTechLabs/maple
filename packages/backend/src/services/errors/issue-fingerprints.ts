import * as PG from "@maple-dev/effect-orm/postgres"
import { ErrorIssueFingerprints } from "@maple/db/tables"
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
