import * as PG from "@maple-dev/effect-orm/postgres"
import { ErrorIssueFingerprints, ErrorIssues } from "@maple/db/tables"
import type { MapleDb, MapleDbError } from "@maple/db/client"
import type { ErrorIssueId, OrgId } from "@maple/domain/http"
import { Array as Arr, Effect, Record } from "effect"

/**
 * Every fingerprint hash each issue owns, its primary and its aliases, in one read.
 * `issueFingerprintHashes` needs each issue's primary hash up front, which a spike owner lacks.
 */
export const spikeIssueHashes = (
	db: MapleDb,
	orgId: OrgId,
	issueIds: ReadonlyArray<ErrorIssueId>,
): Effect.Effect<Map<ErrorIssueId, ReadonlyArray<string>>, MapleDbError> =>
	Effect.gen(function* () {
		if (issueIds.length === 0) return new Map<ErrorIssueId, ReadonlyArray<string>>()
		const rows = yield* db.run(
			PG.from(ErrorIssues)
				.leftJoin(ErrorIssueFingerprints, "alias", (issue, alias) =>
					alias.orgId.eq(orgId).and(alias.issueId.eq(issue.id)),
				)
				.select(($) => ({
					issueId: $.id,
					primaryHash: $.fingerprintHash,
					aliasHash: $.alias.fingerprintHash,
				}))
				.where(($) => [$.orgId.eq(orgId), $.id.in_(...issueIds)]),
		)
		return new Map(
			Arr.map(
				Record.values(Arr.groupBy(rows, (row) => row.issueId)),
				(group) =>
					[
						group[0].issueId,
						Arr.dedupe([
							group[0].primaryHash,
							...Arr.flatMap(group, (row) => (row.aliasHash === null ? [] : [row.aliasHash])),
						]),
					] as const,
			),
		)
	})
