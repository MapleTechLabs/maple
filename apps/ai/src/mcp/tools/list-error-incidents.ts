import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Effect, Schema, Array as Arr, String as Str } from "effect"
import { ListErrorIncidentsOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { issueIdParam, issueNotFound, persistenceFailed } from "./error-issue-shared"
import { ErrorIssueReadModelsService } from "@maple/backend/services/errors/ErrorIssueReadModelsService"

const TOOL = "list_error_incidents"
const MAX_LIMIT = 500
/** Issues one call reads; a poller over more splits its list. */
const MAX_ISSUE_IDS = 100

export function registerListErrorIncidentsTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "List Error Incidents",
		description:
			"Error incidents: flare-ups of an error issue (alert-rule breaches are list_alert_incidents). An issue gets a 'first_seen' incident when it opens and a 'regression' incident when it fires after being resolved; incidents auto-resolve after ~30 min of silence. No time window: without issue_id or issue_ids, every currently open incident in the org; with them, those issues' incidents, open and resolved, newest first. Polling many issues? Pass them all as issue_ids in one call.",
		parameters: Schema.Struct({
			issue_id: Schema.optional(
				issueIdParam(
					"Only this issue's incidents, resolved ones included. Omit for open incidents org-wide.",
				),
			),
			issue_ids: P.optionalResourceIdList(
				"errorIssue",
				`Only these issues' incidents, resolved ones included, in one read (at most ${MAX_ISSUE_IDS})`,
			),
			limit: P.limit({ default: 100, max: MAX_LIMIT, noun: "incidents" }),
		}),
		output: ListErrorIncidentsOutput,
		hints: { readOnly: true },
		phrases: ["Listing error incidents"],
		handler: Effect.fn("McpTool.listErrorIncidents")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const decoded = yield* Effect.forEach(
				params.issue_ids ?? [],
				P.decodeResourceId("errorIssue", "issue_ids"),
			)
			const many = Arr.dedupe(decoded)
			const ids = Arr.dedupe(params.issue_id === undefined ? many : [params.issue_id, ...many])
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"maple.issue.id": ids.length === 1 ? ids[0] : ids.length === 0 ? "all" : "many",
				"maple.issue.count": ids.length,
				"maple.ai.limit": params.limit,
			})
			if (ids.length > MAX_ISSUE_IDS) {
				return yield* new McpInvalidInputError({
					message: `${ids.length} issue ids; pass at most ${MAX_ISSUE_IDS} per call and split the rest.`,
					parameter: "issue_ids",
				})
			}
			const readModels = yield* ErrorIssueReadModelsService
			const persistence = persistenceFailed(TOOL)

			const result = Arr.isReadonlyArrayNonEmpty(ids)
				? ids.length === 1
					? // One issue keeps the not-found answer a batch cannot give per id.
						yield* readModels.listIssueIncidents(tenant.orgId, ids[0]).pipe(
							Effect.catchTags({
								"@maple/http/errors/ErrorIssueNotFoundError": issueNotFound,
								"@maple/http/errors/ErrorPersistenceError": persistence,
							}),
						)
					: yield* readModels
							.listIncidentsOfIssues(tenant.orgId, ids, { limit: params.limit + 1 })
							.pipe(Effect.catchTag("@maple/http/errors/ErrorPersistenceError", persistence))
				: yield* readModels
						.listOpenIncidents(tenant.orgId)
						.pipe(Effect.catchTag("@maple/http/errors/ErrorPersistenceError", persistence))

			const incidents = result.incidents.slice(0, params.limit)
			const withIncidents = new Set(Arr.map(result.incidents, (i) => i.issueId))
			return {
				incidents: Arr.map(incidents, (i) => ({
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
				openCount: Arr.filter(incidents, (i) => i.status === "open").length,
				...(ids.length === 1 ? { issueId: ids[0] } : undefined),
				...(ids.length > 1
					? {
							issueIds: ids,
							// Only meaningful when every incident was read.
							...(result.incidents.length > params.limit
								? undefined
								: {
										issuesWithoutIncidents: Arr.filter(
											ids,
											(id) => !withIncidents.has(id),
										),
									}),
						}
					: undefined),
				limit: params.limit,
				hasMore: result.incidents.length > params.limit,
			}
		}),
		render: (output) => {
			const scope =
				output.issueIds !== undefined
					? `${output.issueIds.length} issues`
					: (output.issueId ?? "all, open only")
			const limit = output.limit ?? MAX_LIMIT
			return {
				title: "Error Incidents",
				scope: [["Issue", scope]],
				...(output.total === 0
					? {
							empty: {
								message:
									output.issueId === undefined && output.issueIds === undefined
										? "No open incidents in this org."
										: output.issueIds === undefined
											? "No incidents found for this issue."
											: "No incidents found for these issues.",
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
									Arr.map(output.incidents, (i) => [
										i.issueId,
										i.status,
										i.reason,
										String(i.occurrenceCount),
										Str.slice(0, 19)(i.firstTriggeredAt),
										Str.slice(0, 19)(i.lastTriggeredAt),
									]),
								),
								...(output.issuesWithoutIncidents === undefined ||
								output.issuesWithoutIncidents.length === 0
									? []
									: [
											doc.text(
												`No incidents: ${Arr.join(output.issuesWithoutIncidents, ", ")}`,
											),
										]),
							],
				...(output.hasMore === true
					? {
							truncation: {
								shown: output.incidents.length,
								noun: "incidents, newest first",
								...(limit < MAX_LIMIT
									? {
											next: doc.next(
												TOOL,
												{
													issue_id: output.issueId,
													issue_ids: output.issueIds,
													limit: MAX_LIMIT,
												},
												"more incidents",
											),
										}
									: undefined),
							},
						}
					: undefined),
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
			}
		},
	})
}
