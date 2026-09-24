import type { McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { ReleaseErrorIssueOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { resolveActorId } from "../lib/resolve-actor"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import {
	issueIdParam,
	issueNotFound,
	leaseConflict,
	persistenceFailed,
	transitionRefused,
} from "./error-issue-shared"
import { ErrorIssueWorkflowService } from "@maple/backend/services/errors/ErrorIssueWorkflowService"
import { WorkflowState } from "@maple/domain/http"

export function registerReleaseErrorIssueTool(server: McpToolRegistrar) {
	server.define({
		name: "release_error_issue",
		description:
			"Release the lease on an error issue you previously claimed, optionally transitioning it to another workflow state (default: 'todo').",
		parameters: Schema.Struct({
			issue_id: issueIdParam(),
			transition_to: P.optionalOneOf(
				WorkflowState.literals,
				"Workflow state to land in after release (default: 'todo')",
			),
			note: P.optionalText("Optional reasoning / context"),
		}),
		output: ReleaseErrorIssueOutput,
		hints: { readOnly: false, destructive: false, idempotent: false },
		phrases: ["Releasing an issue"],
		handler: Effect.fn("McpTool.releaseErrorIssue")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const actorId = yield* resolveActorId(tenant)
			const workflow = yield* ErrorIssueWorkflowService
			const issue = yield* workflow
				.releaseIssue(tenant.orgId, actorId, params.issue_id, {
					transitionTo: params.transition_to,
					note: params.note,
				})
				.pipe(
					Effect.catchTags({
						"@maple/http/errors/ErrorIssueNotFoundError": issueNotFound,
						"@maple/http/errors/ErrorIssueLeaseConflictError": leaseConflict,
						"@maple/http/errors/ErrorIssueTransitionError": transitionRefused("transition_to"),
						"@maple/http/errors/ErrorPersistenceError": persistenceFailed("release_error_issue"),
					}),
				)

			return { id: issue.id, workflowState: issue.workflowState, previousLeaseHolderActorId: actorId }
		}),
		render: (output) => ({
			title: "Error issue released",
			blocks: [
				doc.fields([
					["ID", output.id],
					["State", output.workflowState],
				]),
			],
		}),
	})
}
