import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { ProposeFixOutput } from "@maple/domain/mcp-outputs"
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
import { ErrorsService } from "@maple/backend/services/errors/ErrorsService"

export function registerProposeFixTool(server: McpToolRegistrar) {
	server.define({
		name: "propose_fix",
		description: [
			"Record a proposed fix for an error issue and move it to `in_review`.",
			"Claims the issue and walks it there from wherever it is, so no claim_error_issue or transition_error_issue call is needed first; it fails if another agent holds the issue.",
			"Pass `pr_url` when you have just opened the PR: it is linked, and once it merges Maple verifies the fix against traffic and closes the issue itself. Use link_pull_request for a PR that already exists and needs no new proposal.",
			"Do not move the issue to `done` by hand.",
		].join(" "),
		parameters: Schema.Struct({
			issue_id: issueIdParam(),
			patch_summary: P.text("What the fix changes and why, in a few sentences"),
			pr_url: P.optionalText(
				"The GitHub pull request URL for the fix, e.g. https://github.com/owner/repo/pull/123. Anything else is rejected",
			),
			artifacts_json: P.optionalJson(
				Schema.Array(Schema.String),
				"JSON array of URLs backing the proposal (logs, traces, analysis docs)",
			),
		}),
		output: ProposeFixOutput,
		hints: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
		phrases: ["Drafting a fix"],
		handler: Effect.fn("McpTool.proposeFix")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			if (params.patch_summary.trim().length === 0) {
				return yield* new McpInvalidInputError({
					message: "patch_summary must not be empty.",
					parameter: "patch_summary",
				})
			}

			const actorId = yield* resolveActorId(tenant)
			const errors = yield* ErrorsService
			const issue = yield* errors
				.proposeFix(tenant.orgId, actorId, params.issue_id, {
					patchSummary: params.patch_summary,
					prUrl: params.pr_url,
					artifacts: params.artifacts_json ?? [],
				})
				.pipe(
					Effect.catchTags({
						"@maple/http/errors/ErrorIssueNotFoundError": issueNotFound,
						"@maple/http/errors/ErrorIssueLeaseConflictError": leaseConflict,
						"@maple/http/errors/ErrorIssueTransitionError": transitionRefused("issue_id"),
						"@maple/http/errors/ErrorIssuePullRequestInvalidError": (error) =>
							Effect.fail(
								new McpInvalidInputError({ message: error.message, parameter: "pr_url" }),
							),
						"@maple/http/errors/ErrorPersistenceError": persistenceFailed("propose_fix"),
					}),
				)

			return { issueId: issue.id, workflowState: issue.workflowState, prUrl: params.pr_url ?? null }
		}),
		// Say what happens next: "State: in_review" does not convey that nobody should touch
		// the issue again until the PR merges.
		render: (output) => ({
			title: "Fix proposed",
			blocks: [
				doc.fields([
					["Issue", output.issueId],
					["State", output.workflowState],
					["Held by", "you, until you release it or the issue closes"],
					["PR", output.prUrl ?? undefined],
				]),
				doc.text(
					output.prUrl === null
						? "No PR attached, so nothing will verify this fix. Call link_pull_request when you open one."
						: "When that PR merges, Maple verifies the fix against real traffic and closes the issue if the error stopped. Don't transition it to 'done' yourself.",
				),
			],
		}),
	})
}
