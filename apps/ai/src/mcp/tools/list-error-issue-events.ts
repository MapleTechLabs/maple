import type { McpToolRegistrar } from "./types"
import { Effect, Option, Schema } from "effect"
import { ListErrorIssueEventsOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { actorLabel, issueIdParam, issueNotFound, persistenceFailed } from "./error-issue-shared"
import { ErrorIssueWorkflowService } from "@maple/backend/services/errors/ErrorIssueWorkflowService"

const MAX_EVENTS = 500

/** Event payloads are stored as jsonb, so this only fails for a row that was never JSON. */
const decodePayload = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))

export function registerListErrorIssueEventsTool(server: McpToolRegistrar) {
	server.define({
		name: "list_error_issue_events",
		description:
			"List the audit-log events for an issue (state transitions, claims, comments, agent notes, fix proposals) in reverse-chronological order.",
		parameters: Schema.Struct({
			issue_id: issueIdParam(),
			limit: P.limit({ default: 100, max: MAX_EVENTS, noun: "events" }),
		}),
		output: ListErrorIssueEventsOutput,
		hints: { readOnly: true },
		phrases: ["Reading issue history"],
		handler: Effect.fn("McpTool.listErrorIssueEvents")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const workflow = yield* ErrorIssueWorkflowService
			const response = yield* workflow
				.listIssueEvents(tenant.orgId, params.issue_id, { limit: params.limit })
				.pipe(
					Effect.catchTags({
						"@maple/http/errors/ErrorIssueNotFoundError": issueNotFound,
						"@maple/http/errors/ErrorPersistenceError":
							persistenceFailed("list_error_issue_events"),
					}),
				)

			return {
				issueId: params.issue_id,
				limit: params.limit,
				total: response.events.length,
				events: response.events.map((e) => ({
					id: e.id,
					type: e.type,
					fromState: e.fromState,
					toState: e.toState,
					actorId: e.actor?.id ?? null,
					createdAt: e.createdAt,
					payload: Option.getOrElse(decodePayload(e.payload), () => ({})),
					actor: actorLabel(e.actor),
				})),
			}
		}),
		render: (output) => ({
			title: "Issue events",
			scope: [["Issue", output.issueId]],
			...(output.total === 0
				? { empty: { message: "No events recorded for this issue." } }
				: undefined),
			blocks:
				output.total === 0
					? []
					: [
							doc.text(`Total: ${output.total}`),
							doc.table(
								["Time", "Type", "From", "To", "Actor"],
								output.events.map((e) => [
									e.createdAt.slice(0, 19),
									e.type,
									e.fromState ?? "—",
									e.toState ?? "—",
									e.actor,
								]),
							),
						],
			// Newest first: a full page means older events were left out.
			...(output.total >= output.limit
				? {
						truncation: {
							shown: output.total,
							noun: "most recent events",
							...(output.limit < MAX_EVENTS
								? {
										next: doc.next(
											"list_error_issue_events",
											{ issue_id: output.issueId, limit: MAX_EVENTS },
											"older events",
										),
									}
								: undefined),
						},
					}
				: undefined),
		}),
	})
}
