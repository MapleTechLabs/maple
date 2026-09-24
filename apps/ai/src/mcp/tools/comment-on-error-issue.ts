import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { CommentOnErrorIssueOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { resolveActorId } from "../lib/resolve-actor"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { issueIdParam, issueNotFound, persistenceFailed } from "./error-issue-shared"
import { ErrorIssueWorkflowService } from "@maple/backend/services/errors/ErrorIssueWorkflowService"

export function registerCommentOnErrorIssueTool(server: McpToolRegistrar) {
	server.define({
		name: "comment_on_error_issue",
		description:
			"Add a comment to the issue's timeline. Use kind='agent_note' for automated reasoning steps (visible in the audit log but styled differently in the UI).",
		parameters: Schema.Struct({
			issue_id: issueIdParam(),
			body: P.text("Comment body (markdown supported)"),
			kind: P.optionalOneOf(["comment", "agent_note"], "'comment' (default) or 'agent_note'"),
			visibility: P.optionalOneOf(["internal", "public"], "'internal' (default) or 'public'"),
		}),
		output: CommentOnErrorIssueOutput,
		hints: { readOnly: false, destructive: false, idempotent: false },
		phrases: ["Commenting on an issue"],
		handler: Effect.fn("McpTool.commentOnErrorIssue")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			if (params.body.trim().length === 0) {
				return yield* new McpInvalidInputError({
					message: "Comment body must not be empty.",
					parameter: "body",
				})
			}
			const kind = params.kind ?? "comment"

			const actorId = yield* resolveActorId(tenant)
			const workflow = yield* ErrorIssueWorkflowService
			const event = yield* workflow
				.commentOnIssue(tenant.orgId, actorId, params.issue_id, params.body, {
					kind,
					visibility: params.visibility,
				})
				.pipe(
					Effect.catchTags({
						"@maple/http/errors/ErrorIssueNotFoundError": issueNotFound,
						"@maple/http/errors/ErrorPersistenceError":
							persistenceFailed("comment_on_error_issue"),
					}),
				)

			return {
				eventId: event.id,
				issueId: event.issueId,
				type: kind,
				actorId: event.actor?.id ?? null,
				actor: event.actor?.agentName ?? event.actor?.userId ?? actorId,
			}
		}),
		render: (output) => ({
			title: "Comment added",
			blocks: [
				doc.fields([
					["Issue", output.issueId],
					["Kind", output.type],
					["Actor", output.actor],
				]),
			],
		}),
	})
}
