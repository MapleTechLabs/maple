import type { McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { TransitionErrorIssueOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { resolveActorId } from "../lib/resolve-actor"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import {
	SELECTABLE_STATES,
	issueIdParam,
	issueNotFound,
	persistenceFailed,
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
		description: [
			"Move an error issue to another workflow state.",
			"`regressed` and `verifying` are set by Maple's own ticks and cannot be requested: `regressed` means a fixed error fired again from a build after the fix, `verifying` means a linked PR merged and the post-merge check is running.",
			"`cancelled` is final. A refused move names the states allowed from the current one.",
			"Do not move an issue to `done` yourself once a PR is linked: the merge opens a verification window that closes the issue when the error stops.",
			"Moving to a closed state ends your lease. For several issues at once use transition_error_issues.",
		].join(" "),
		parameters: Schema.Struct({
			issue_id: issueIdParam(),
			to_state: P.oneOf(SELECTABLE_STATES, "Target workflow state"),
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
