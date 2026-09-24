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

export function registerTransitionErrorIssueTool(server: McpToolRegistrar) {
	server.define({
		name: "transition_error_issue",
		description: [
			"Move an error issue to another workflow state.",
			"`regressed` and `verifying` are set by Maple's own ticks and cannot be requested: `regressed` means a fixed error fired again from a build after the fix, `verifying` means a linked PR merged and the post-merge check is running.",
			"`cancelled` is final. A refused move names the states allowed from the current one.",
			"Do not move an issue to `done` yourself once a PR is linked: the merge opens a verification window that closes the issue when the error stops.",
			"Moving to a closed state ends your lease.",
		].join(" "),
		parameters: Schema.Struct({
			issue_id: issueIdParam(),
			to_state: P.oneOf(SELECTABLE_STATES, "Target workflow state"),
			note: P.optionalText("Reasoning or context, stored on the event"),
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
			const errors = yield* ErrorsService
			const issue = yield* errors
				.transitionIssue(tenant.orgId, actorId, params.issue_id, params.to_state, {
					note: params.note,
					snoozeUntil: params.snooze_until,
				})
				.pipe(
					Effect.catchTags({
						"@maple/http/errors/ErrorIssueNotFoundError": issueNotFound,
						"@maple/http/errors/ErrorIssueTransitionError": transitionRefused("to_state"),
						"@maple/http/errors/ErrorValidationError": validationFailed("snooze_until"),
						"@maple/http/errors/ErrorPersistenceError":
							persistenceFailed("transition_error_issue"),
					}),
				)

			return {
				id: issue.id,
				workflowState: issue.workflowState,
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
					["State", output.workflowState],
					["Service", output.serviceName],
					["Exception", output.exceptionType],
					["Snoozed until", output.snoozeUntil ?? undefined],
					["Note", output.note],
				]),
			],
		}),
	})
}
