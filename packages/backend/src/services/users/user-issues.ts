import type { ErrorIssueId, OrgId, UserDetailRequest, UserIssueItem, WorkflowState } from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { ErrorIssues } from "@maple/db/tables"
import { Array as Arr, DateTime, Effect, Option } from "effect"
import { CH } from "@maple/query-engine"
import { Database } from "@maple/backend/platform/DatabaseLive"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { makeErrorDatabaseExecute } from "@maple/backend/services/errors/error-persistence"
import { issuesOwningHashes } from "@maple/backend/services/errors/issue-fingerprints"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import {
	isMissingErrorEventsUserId,
	isMissingUserActivityHourly,
} from "@maple/backend/services/warehouse/missing-table"

// One user's issues: `userIssuesQuery` groups their occurrences by fingerprint, then each hash
// resolves to the issue the errors tick lands it on (an alias first), the one the hub links to.

const USER_ISSUES_LIMIT = 100

/** The issue fields the Errors tab shows in place of the warehouse's latest occurrence. */
export type OwningIssue = Readonly<{
	id: ErrorIssueId
	fingerprintHash: string
	exceptionType: string
	exceptionMessage: string
	serviceName: string
	workflowState: WorkflowState
}>

const toMs = (value: DateTime.Utc): number => Math.max(0, DateTime.toEpochMillis(value))

/**
 * Folds the per-fingerprint rows onto the issue each hash lands on: a merged issue's hashes sum
 * into the kept one. A hash no issue owns yet stays its own row, unlinked. Most hits first.
 */
export const foldUserIssues = (
	rows: ReadonlyArray<CH.UserIssueOutput>,
	owners: ReadonlyMap<string, OwningIssue>,
): ReadonlyArray<UserIssueItem> => {
	const groups = Arr.groupBy(rows, (row) => {
		const owner = owners.get(row.fingerprintHash)
		return owner === undefined ? `fp:${row.fingerprintHash}` : `issue:${owner.id}`
	})
	const items = Arr.flatMap(Object.values(groups), (group): ReadonlyArray<UserIssueItem> => {
		const members = (group ?? []).toSorted((a, b) => b.hits - a.hits)
		const lead = members[0]
		if (lead === undefined) return []
		const owner = owners.get(lead.fingerprintHash)
		return [
			{
				issueId: owner?.id ?? null,
				fingerprintHash: owner?.fingerprintHash ?? lead.fingerprintHash,
				type: owner?.exceptionType ?? lead.exceptionType,
				message: owner?.exceptionMessage ?? lead.exceptionMessage,
				service: owner?.serviceName ?? lead.serviceName,
				hits: Arr.reduce(members, 0, (sum, row) => sum + row.hits),
				firstSeenMs: Math.min(...Arr.map(members, (row) => toMs(row.firstSeen))),
				lastSeenMs: Math.max(...Arr.map(members, (row) => toMs(row.lastSeen))),
				status: owner?.workflowState ?? null,
			},
		]
	})
	return items.toSorted((a, b) => b.hits - a.hits || b.lastSeenMs - a.lastSeenMs)
}

/** Each hash's owning issue, with the fields the tab shows; hashes no issue owns are absent. */
const owningIssues = Effect.fn("UsersReads.owningIssues")(function* (
	orgId: OrgId,
	hashes: ReadonlyArray<string>,
) {
	if (hashes.length === 0) return new Map<string, OwningIssue>()
	const database = yield* Database
	const dbExecute = makeErrorDatabaseExecute(database, "UsersReads")
	const owners = yield* dbExecute((db) => issuesOwningHashes(db, orgId, hashes))
	const issueIds = Arr.dedupe(Arr.map([...owners.values()], (owner) => owner.issueId))
	const issues =
		issueIds.length === 0
			? []
			: yield* dbExecute((db) =>
					db.run(
						PG.from(ErrorIssues)
							.select(($) => ({
								id: $.id,
								fingerprintHash: $.fingerprintHash,
								exceptionType: $.exceptionType,
								exceptionMessage: $.exceptionMessage,
								serviceName: $.serviceName,
								workflowState: $.workflowState,
							}))
							.where(($) => [$.orgId.eq(orgId), $.id.in_(...issueIds)]),
					),
				)
	const byId = new Map(Arr.map(issues, (issue) => [issue.id, issue] as const))
	return new Map<string, OwningIssue>(
		Arr.flatMap([...owners.entries()], ([hash, owner]) => {
			const issue = byId.get(owner.issueId)
			return issue === undefined ? [] : [[hash, issue] as const]
		}),
	)
})

/**
 * The issues one user hit in the window and scope, `None` on a cluster whose `error_events` lacks
 * `UserId` (migration 0057), or whose scope subquery lacks `user_activity_hourly`.
 */
export const readUserIssueItems = Effect.fn("UsersReads.issueItems")(function* (
	tenant: TenantContext,
	payload: UserDetailRequest,
) {
	const warehouse = yield* WarehouseQueryService
	const rows = yield* warehouse
		.compiledQuery(
			tenant,
			CH.compile(
				CH.userIssuesQuery({
					userId: payload.userId,
					namespaces: payload.namespaces ?? [],
					limit: USER_ISSUES_LIMIT,
				}),
				{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
			),
			{ profile: "list", context: "userIssues" },
		)
		.pipe(
			Effect.map(Option.some),
			Effect.catchIf(
				(error) => isMissingErrorEventsUserId(error) || isMissingUserActivityHourly(error),
				() => Effect.succeed(Option.none<ReadonlyArray<CH.UserIssueOutput>>()),
			),
		)
	if (Option.isNone(rows)) {
		yield* Effect.annotateCurrentSpan({ "maple.users.error_user_id": false })
		return Option.none<ReadonlyArray<UserIssueItem>>()
	}
	const owners = yield* owningIssues(
		tenant.orgId,
		Arr.map(rows.value, (row) => row.fingerprintHash),
	)
	const items = foldUserIssues(rows.value, owners)
	yield* Effect.annotateCurrentSpan({
		"maple.users.error_user_id": true,
		"maple.users.issue_fingerprints": rows.value.length,
		"maple.users.issues": items.length,
	})
	return Option.some(items)
})
