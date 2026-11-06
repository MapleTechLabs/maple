import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb, MapleDbError } from "@maple/db/client"
import { ErrorIssues, type ErrorIssueRow } from "@maple/db/tables"
import type { OrgId, WorkflowState } from "@maple/domain/http"
import { transitionRow } from "@maple/backend/platform/transition-row"

/**
 * A closed issue that fires again: a fixed (`done`) one lands in `regressed` with the same
 * bookkeeping the errors tick does, and a `wontfix` whose snooze expired wakes into `triage`.
 */
export type IssueReopen =
	| { readonly fromState: "done"; readonly toState: "regressed" }
	| { readonly fromState: "wontfix"; readonly toState: "triage" }

export const issueReopenFor = (
	prior: Pick<ErrorIssueRow, "workflowState" | "snoozeUntil">,
	timestamp: number,
): IssueReopen | null => {
	if (prior.workflowState === "done") return { fromState: "done", toState: "regressed" }
	if (prior.workflowState === "wontfix" && prior.snoozeUntil !== null && prior.snoozeUntil <= timestamp) {
		return { fromState: "wontfix", toState: "triage" }
	}
	return null
}

/**
 * Apply a reopen, guarded on the state it was decided from. Fails with
 * `TransitionConflictError` when a concurrent transition moved the issue first (or re-snoozed
 * it), so the caller records no regression for a reopen that did not happen.
 */
export const applyIssueReopen = (
	db: MapleDb,
	orgId: OrgId,
	issueId: ErrorIssueRow["id"],
	reopen: IssueReopen,
	timestamp: number,
) =>
	transitionRow<WorkflowState, { readonly id: ErrorIssueRow["id"] }, MapleDbError, never>(
		{ table: "error_issues", id: issueId, from: [reopen.fromState], to: reopen.toState },
		(from) =>
			reopen.toState === "regressed"
				? db.run(
						PG.update(ErrorIssues)
							.set(($) => ({
								workflowState: "regressed",
								resolvedAt: null,
								resolvedByActorId: null,
								lastRegressedAt: timestamp,
								regressionCount: $.regressionCount.add(1),
								// A regression on an issue retention already archived must be seen.
								archivedAt: null,
								updatedAt: timestamp,
							}))
							.where(($) => [$.orgId.eq(orgId), $.id.eq(issueId), $.workflowState.in_(...from)])
							.returning("id"),
					)
				: db.run(
						PG.update(ErrorIssues)
							.set({ workflowState: "triage", snoozeUntil: null, updatedAt: timestamp })
							.where(($) => [
								$.orgId.eq(orgId),
								$.id.eq(issueId),
								$.workflowState.in_(...from),
								// A snooze renewed since the read keeps the issue asleep.
								$.snoozeUntil.lte(timestamp),
							])
							.returning("id"),
					),
	)
