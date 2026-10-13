import type { McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { TransitionErrorIssuesOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { resolveActorId } from "../lib/resolve-actor"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { SELECTABLE_STATES } from "./error-issue-shared"
import { MAX_BATCH_ISSUES, decodeIssueIds, runIssueBatch } from "./error-issue-batch"
import { transitionIssueFrom } from "./transition-error-issue"

export function registerTransitionErrorIssuesTool(server: McpToolRegistrar) {
	server.define({
		name: "transition_error_issues",
		title: "Transition Error Issues",
		description: [
			`Move up to ${MAX_BATCH_ISSUES} error issues to one workflow state in a single call, with one note stored on each issue's timeline.`,
			"Every issue is checked on its own, exactly as transition_error_issue would: an illegal move, an unknown id or a bad id fails for that issue only and names the states allowed from where it is.",
			"Moving to `in_progress` claims each issue. `regressed` and `verifying` cannot be requested, and issues with a linked PR should not be closed by hand.",
		].join(" "),
		parameters: Schema.Struct({
			issue_ids: P.list(`Error issue IDs from list_error_issues, at most ${MAX_BATCH_ISSUES}`),
			to_state: P.oneOf(SELECTABLE_STATES, "Target workflow state for every issue"),
			note: P.optionalText("Reasoning or context, stored on every issue's timeline with the move"),
			snooze_until: P.optionalTimestamp(
				"For a `wontfix` move: time after which new occurrences reopen each issue as `triage`",
			),
		}),
		output: TransitionErrorIssuesOutput,
		hints: { readOnly: false, destructive: false, idempotent: true },
		phrases: ["Updating several issues' status"],
		handler: Effect.fn("McpTool.transitionErrorIssues")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const entries = yield* decodeIssueIds(params.issue_ids, "issue_ids")
			const actorId = yield* resolveActorId(tenant)
			const results = yield* runIssueBatch(entries, (id) =>
				transitionIssueFrom(tenant.orgId, actorId, id, params.to_state, {
					note: params.note,
					snoozeUntil: params.snooze_until,
				}).pipe(
					Effect.map(({ issue, fromState }) => ({
						fromState,
						workflowState: issue.workflowState,
					})),
				),
			)
			const succeeded = results.filter((result) => result.ok).length
			return {
				toState: params.to_state,
				succeeded,
				failed: results.length - succeeded,
				results,
				...(params.note === undefined ? undefined : { note: params.note }),
			}
		}),
		render: (output) => {
			const failures = output.results.filter((result) => !result.ok)
			return {
				title: "Error issues transitioned",
				blocks: [
					doc.fields([
						["Target", output.toState],
						["Moved", String(output.succeeded)],
						["Failed", String(output.failed)],
						["Note", output.note],
					]),
					...(failures.length === 0
						? []
						: [
								doc.table(
									["Issue", "Error"],
									failures.map((result) => [result.id, result.error ?? ""]),
								),
							]),
				],
			}
		},
	})
}
