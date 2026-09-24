import type { McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { ListErrorIncidentsOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { doc } from "../lib/tool-doc"
import { issueIdParam, issueNotFound, persistenceFailed } from "./error-issue-shared"
import { ErrorIssueReadModelsService } from "@maple/backend/services/errors/ErrorIssueReadModelsService"

export function registerListErrorIncidentsTool(server: McpToolRegistrar) {
	server.define({
		name: "list_error_incidents",
		description:
			"List error incidents: time-bounded flare-ups under an error issue. Each issue can have many incidents: a 'first_seen' incident when the issue opens, then 'regression' incidents if new occurrences arrive after the issue was resolved. Incidents auto-resolve after the issue is silent for ~30 min.",
		parameters: Schema.Struct({
			issue_id: Schema.optional(
				issueIdParam(
					"Optional: narrow to incidents for this issue ID. If omitted, returns org-wide open incidents.",
				),
			),
		}),
		output: ListErrorIncidentsOutput,
		hints: { readOnly: true },
		phrases: ["Listing error incidents"],
		handler: Effect.fn("McpTool.listErrorIncidents")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				issueId: params.issue_id ?? "all",
			})
			const readModels = yield* ErrorIssueReadModelsService

			const result =
				params.issue_id === undefined
					? yield* readModels
							.listOpenIncidents(tenant.orgId)
							.pipe(
								Effect.catchTag(
									"@maple/http/errors/ErrorPersistenceError",
									persistenceFailed("list_error_incidents"),
								),
							)
					: yield* readModels.listIssueIncidents(tenant.orgId, params.issue_id).pipe(
							Effect.catchTags({
								"@maple/http/errors/ErrorIssueNotFoundError": issueNotFound,
								"@maple/http/errors/ErrorPersistenceError":
									persistenceFailed("list_error_incidents"),
							}),
						)

			const incidents = result.incidents
			return {
				incidents: incidents.map((i) => ({
					id: i.id,
					issueId: i.issueId,
					status: i.status,
					reason: i.reason,
					firstTriggeredAt: i.firstTriggeredAt,
					lastTriggeredAt: i.lastTriggeredAt,
					resolvedAt: i.resolvedAt,
					occurrenceCount: i.occurrenceCount,
				})),
				total: incidents.length,
				openCount: incidents.filter((i) => i.status === "open").length,
				...(params.issue_id === undefined ? undefined : { issueId: params.issue_id }),
			}
		}),
		render: (output) => ({
			title: "Error Incidents",
			scope: [["Issue", output.issueId ?? "all, open only"]],
			...(output.total === 0
				? {
						empty: {
							message:
								output.issueId === undefined
									? "No open incidents in this org."
									: "No incidents found for this issue.",
						},
					}
				: undefined),
			blocks:
				output.total === 0
					? []
					: [
							doc.text(`Total: ${output.total} (${output.openCount} open)`),
							// Full issue id: a prefix cannot be passed to the issue tools.
							doc.table(
								["Issue", "Status", "Reason", "Events", "Opened", "Last triggered"],
								output.incidents.map((i) => [
									i.issueId,
									i.status,
									i.reason,
									String(i.occurrenceCount),
									i.firstTriggeredAt.slice(0, 19),
									i.lastTriggeredAt.slice(0, 19),
								]),
							),
						],
			next:
				output.issueId === undefined && output.incidents[0] !== undefined
					? [
							doc.next(
								"list_error_issue_events",
								{ issue_id: output.incidents[0].issueId },
								"history of the first incident's issue",
							),
						]
					: [],
		}),
	})
}
