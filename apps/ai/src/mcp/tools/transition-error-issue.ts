import type { McpToolRegistrar } from "./types"
import { Effect, Schema, Array as Arr } from "effect"
import { TransitionErrorIssueOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { resolveActorId } from "../lib/resolve-actor"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import {
	TO_STATE_ALIASES,
	issueIdParam,
	issueNotFound,
	persistenceFailed,
	toStateParam,
	transitionRefused,
	validationFailed,
} from "./error-issue-shared"
import { ErrorsService } from "@maple/backend/services/errors/ErrorsService"
import { ErrorIssueWorkflowService } from "@maple/backend/services/errors/ErrorIssueWorkflowService"
import type { ActorId, ErrorIssueId, OrgId, WorkflowState } from "@maple/domain/http"

/**
 * One move, plus the state it started from: the service returns only the result, and a
 * caller (and the chat's approval summary) needs both ends.
 */
export const transitionIssueFrom = Effect.fn("McpTool.transitionIssueFrom")(function* (
	orgId: OrgId,
	actorId: ActorId,
	issueId: ErrorIssueId,
	toState: WorkflowState,
	opts: { readonly note?: string | undefined; readonly snoozeUntil?: string | undefined },
) {
	const workflow = yield* ErrorIssueWorkflowService
	const before = yield* workflow.requireIssue(orgId, issueId)
	const errors = yield* ErrorsService
	const issue = yield* errors.transitionIssue(orgId, actorId, issueId, toState, opts)
	return { issue, fromState: before.workflowState }
})

export function registerTransitionErrorIssueTool(server: McpToolRegistrar) {
	server.define({
		name: "transition_error_issue",
		title: "Transition Error Issue",
		description: Arr.join(
			[
				"Move an error issue to another workflow state; for several at once use transition_error_issues.",
				"Moving to `in_progress` claims the issue; moving to a closed state ends your lease. `cancelled` is final.",
				"`regressed` (fixed error fired again) and `verifying` (linked PR merged, check running) are set by Maple and cannot be requested.",
				"Once a PR is linked, do not move the issue to `done`: the merge opens a verification window that closes it when the error stops.",
				"A refused move names the states allowed from the current one.",
			],
			" ",
		),
		aliases: TO_STATE_ALIASES,
		parameters: Schema.Struct({
			issue_id: issueIdParam(),
			to_state: toStateParam(),
			note: P.optionalText(
				"Reasoning or context, shown on the issue timeline with the move; no separate comment_on_error_issue call is needed",
			),
			snooze_until: P.optionalTimestamp(
				"For a `wontfix` move: time after which new occurrences reopen the issue as `triage`",
			),
		}),
		output: TransitionErrorIssueOutput,
		hints: { readOnly: false, destructive: false, idempotent: true },
		phrases: ["Updating an issue's status"],
		handler: Effect.fn("McpTool.transitionErrorIssue")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const actorId = yield* resolveActorId(tenant)
			const { issue, fromState } = yield* transitionIssueFrom(
				tenant.orgId,
				actorId,
				params.issue_id,
				params.to_state,
				{ note: params.note, snoozeUntil: params.snooze_until },
			).pipe(
				Effect.catchTags({
					"@maple/http/errors/ErrorIssueNotFoundError": issueNotFound,
					"@maple/http/errors/ErrorIssueTransitionError": transitionRefused("to_state"),
					"@maple/http/errors/ErrorValidationError": validationFailed("snooze_until"),
					"@maple/http/errors/ErrorPersistenceError": persistenceFailed("transition_error_issue"),
				}),
			)

			return {
				id: issue.id,
				workflowState: issue.workflowState,
				fromState,
				toState: issue.workflowState,
				assignedActorId: issue.assignedActor?.id ?? null,
				leaseHolderActorId: issue.leaseHolder?.id ?? null,
				snoozeUntil: issue.snoozeUntil,
				serviceName: issue.serviceName,
				exceptionType: issue.exceptionType,
				...(params.note === undefined ? undefined : { note: params.note }),
			}
		}),
		render: (output) => ({
			title: "Error issue transitioned",
			blocks: [
				doc.fields([
					["ID", output.id],
					["State", `${output.fromState} -> ${output.workflowState}`],
					["Service", output.serviceName],
					["Exception", output.exceptionType],
					["Snoozed until", output.snoozeUntil ?? undefined],
					["Note", output.note],
				]),
			],
		}),
	})
}
