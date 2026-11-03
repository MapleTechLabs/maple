import type { McpToolRegistrar } from "./types"
import { Effect, Option, Schema, Array as Arr } from "effect"
import { MergeErrorIssuesOutput } from "@maple/domain/mcp-outputs"
import {
	ErrorIssueMergeService,
	MAX_MERGE_SOURCES,
} from "@maple/backend/services/errors/ErrorIssueMergeService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { resolveActorId } from "../lib/resolve-actor"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { decodeIssueIds } from "./error-issue-batch"
import { issueIdParam, issueNotFound, persistenceFailed, validationFailed } from "./error-issue-shared"
import { McpInvalidInputError } from "./types"

export function registerMergeErrorIssuesTool(server: McpToolRegistrar) {
	server.define({
		name: "merge_error_issues",
		title: "Merge Error Issues",
		description: `Fold duplicate error issues into one when they are the same bug split across fingerprints. The kept issue (issue_id) takes their occurrences and every future occurrence of their fingerprints; each merged issue is archived pointing at it. Up to ${MAX_MERGE_SOURCES} at a time. Only merge issues you have confirmed share a root cause; a merge is undone from the dashboard.`,
		parameters: Schema.Struct({
			issue_id: issueIdParam("The issue to keep, from list_error_issues"),
			merge_issue_ids: P.list(`Issue IDs to fold into it, at most ${MAX_MERGE_SOURCES}`),
		}),
		output: MergeErrorIssuesOutput,
		hints: { readOnly: false, destructive: false, idempotent: false },
		phrases: ["Merging duplicate issues"],
		handler: Effect.fn("McpTool.mergeErrorIssues")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const entries = yield* decodeIssueIds(params.merge_issue_ids, "merge_issue_ids")
			const invalid = Arr.filter(entries, (entry) => Option.isNone(entry.id))
			if (invalid.length > 0) {
				return yield* new McpInvalidInputError({
					message: `Not issue ids: ${Arr.join(
						Arr.map(invalid, (entry) => entry.raw),
						", ",
					)}. Use ids from list_error_issues.`,
					parameter: "merge_issue_ids",
				})
			}
			const sourceIds = Arr.flatMap(entries, (entry) => Option.toArray(entry.id))
			const actorId = yield* resolveActorId(tenant)
			const merges = yield* ErrorIssueMergeService
			const issue = yield* merges.mergeIssues(tenant.orgId, actorId, params.issue_id, sourceIds).pipe(
				Effect.catchTags({
					"@maple/http/errors/ErrorIssueNotFoundError": issueNotFound,
					"@maple/http/errors/ErrorValidationError": validationFailed("merge_issue_ids"),
					"@maple/http/errors/ErrorPersistenceError": persistenceFailed("merge_error_issues"),
				}),
			)
			return {
				id: issue.id,
				mergedIssueIds: Arr.filter(sourceIds, (id) => id !== issue.id),
				fingerprintHashes: [...issue.fingerprintHashes],
				occurrenceCount: issue.occurrenceCount,
				workflowState: issue.workflowState,
				serviceName: issue.serviceName,
			}
		}),
		render: (output) => ({
			title: `Merged ${output.mergedIssueIds.length} issue${output.mergedIssueIds.length === 1 ? "" : "s"}`,
			blocks: [
				doc.fields([
					["Kept", output.id],
					["Merged", Arr.join(output.mergedIssueIds, ", ")],
					["Occurrences", String(output.occurrenceCount)],
					["Fingerprints", String(output.fingerprintHashes.length)],
					["State", output.workflowState],
					["Service", output.serviceName],
				]),
			],
		}),
	})
}
