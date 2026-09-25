import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { LinkPullRequestOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { resolveActorId } from "../lib/resolve-actor"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { issueIdParam, issueNotFound, persistenceFailed } from "./error-issue-shared"
import { IssueFixVerificationService } from "@maple/backend/services/errors/IssueFixVerificationService"

export function registerLinkPullRequestTool(server: McpToolRegistrar) {
	server.define({
		name: "link_pull_request",
		description: [
			"Attach a GitHub pull request to an error issue without proposing new work.",
			"When it merges, Maple opens a verification window sized by the issue's severity and occurrence rate, then closes the issue if the error stopped.",
			"Leave the issue alone after linking: the merge moves it to `verifying` and the verdict moves it on.",
			"propose_fix does the same link when given `pr_url`, and also moves the issue to `in_review`.",
		].join(" "),
		parameters: Schema.Struct({
			issue_id: issueIdParam(),
			pull_request_url: P.text(
				"Full GitHub pull request URL, e.g. https://github.com/owner/repo/pull/123",
			),
		}),
		output: LinkPullRequestOutput,
		// Linking the same PR again updates the one link; it reads the PR's state from GitHub.
		hints: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
		phrases: ["Linking a pull request"],
		handler: Effect.fn("McpTool.linkPullRequest")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const actorId = yield* resolveActorId(tenant)
			const verification = yield* IssueFixVerificationService
			const link = yield* verification
				.linkPullRequest(tenant.orgId, actorId, params.issue_id, params.pull_request_url, "agent")
				.pipe(
					Effect.catchTags({
						"@maple/http/errors/ErrorIssueNotFoundError": issueNotFound,
						"@maple/http/errors/ErrorIssuePullRequestInvalidError": (error) =>
							Effect.fail(
								new McpInvalidInputError({
									message: error.message,
									parameter: "pull_request_url",
									example: "https://github.com/owner/repo/pull/123",
								}),
							),
						"@maple/http/errors/ErrorPersistenceError": persistenceFailed("link_pull_request"),
					}),
				)

			return {
				pullRequestId: link.id,
				issueId: link.issueId,
				repoFullName: link.repoFullName,
				number: link.number,
				url: link.url,
				state: link.state,
			}
		}),
		render: (output) => ({
			title: "Pull request linked",
			blocks: [
				doc.fields([
					["Issue", output.issueId],
					["PR", `${output.repoFullName}#${output.number}`],
					["URL", output.url],
					["State", output.state],
				]),
				doc.text(
					output.state === "merged"
						? "Already merged; verification is scheduled."
						: "Verification starts when this PR merges.",
				),
			],
		}),
	})
}
