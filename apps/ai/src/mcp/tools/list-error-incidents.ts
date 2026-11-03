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
		title: "List Error Incidents",
		description:
			"Error incidents: flare-ups of an error issue (alert-rule breaches are list_alert_incidents). An issue gets a 'first_seen' incident when it opens and a 'regression' incident when it fires after being resolved; incidents auto-resolve after ~30 min of silence. No time window: without issue_id, every currently open incident in the org (newest 500); with it, that issue's incidents, open and resolved (newest 200).",
		parameters: Schema.Struct({
			issue_id: Schema.optional(
				issueIdParam(
					"Only this issue's incidents, resolved ones included. Omit for open incidents org-wide.",
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
				"maple.issue.id": params.issue_id ?? "all",
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
