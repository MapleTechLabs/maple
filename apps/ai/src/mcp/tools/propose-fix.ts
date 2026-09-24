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
			"Record a fix you are proposing for an error issue (a patch summary, optionally a PR URL and supporting artifacts) and move the issue to `in_review`.",
			"Claims the issue for you and walks it there from wherever it is, so you do not need `claim_error_issue` or `transition_error_issue` first; it fails if another agent already holds the issue, or if `pr_url` is not a GitHub pull request URL.",
			"Passing `pr_url` also links the PR, so this is the only tool you need when you have just opened one; use `link_pull_request` for a PR that already exists and needs no new proposal.",
			"Once a linked PR merges, Maple watches the error for a window sized by its severity and rate, then closes the issue itself if it stopped. Do not transition to `done` by hand.",
		].join(" "),
		parameters: Schema.Struct({
			issue_id: issueIdParam(),
			patch_summary: P.text("Short description of the proposed fix (1..4000 chars)"),
			pr_url: P.optionalText("Link to PR, diff, or patch"),
			artifacts_json: P.optionalJson(
				Schema.Array(Schema.String),
				"JSON array of artifact URLs (logs, traces, analysis docs)",
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
