import { DateTime, Effect, Schema } from "effect"
import { AgentFeedbackImpact, AgentFeedbackKind, OrgId } from "@maple/domain/http"
import { AgentFeedbackPublicId } from "@maple/domain/http/v2"
import { ListMapleFeedbackOutput } from "@maple/domain/mcp-outputs"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { AgentFeedbackService } from "@maple/backend/services/feedback/AgentFeedbackService"
import { CurrentAuditActor } from "@maple/backend/services/auth/audit-actor"
import { McpAuthInvalidError, McpInvalidInputError, McpNotReadyError, type McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const TOOL = "list_maple_feedback"
const encodePublicId = Schema.encodeSync(AgentFeedbackPublicId)
const decodeOrgId = Schema.decodeUnknownOption(OrgId)
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms))

/**
 * The Maple team's triage view of `send_maple_feedback` and `POST /v2/agent_feedback`. Listed on
 * every surface like any public tool, but `AgentFeedbackService.triage` refuses every org except
 * `MAPLE_INTERNAL_ORG_ID`, and this handler refuses any caller but a person or API key on the
 * public `/mcp` transport: Maple's own agents and the bot never carry customer feedback text.
 */
export function registerListMapleFeedbackTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "List Maple Feedback",
		description:
			"Maple team only: read the feedback agents sent about Maple (send_maple_feedback, POST /v2/agent_feedback) across every organization, newest first, with the full reason and details. Refused for any other organization.",
		parameters: Schema.Struct({
			kind: P.optionalOneOf(AgentFeedbackKind.literals, "Only this kind of feedback"),
			impact: P.optionalOneOf(AgentFeedbackImpact.literals, "Only this impact"),
			start_time: P.optionalTimestamp("Only feedback sent at or after this time"),
			related_to: P.optionalText(
				"Only feedback whose related tool, endpoint or page contains this text (case-insensitive)",
			),
			org_id: P.optionalText("Only feedback from this organization (`org_…`)"),
			limit: P.limit({ default: 50, max: 200, noun: "reports" }),
		}),
		output: ListMapleFeedbackOutput,
		aliases: { since: "start_time" },
		hints: { readOnly: true },
		phrases: ["Reading agent feedback"],
		handler: Effect.fn("McpTool.listMapleFeedback")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const actor = yield* CurrentAuditActor
			if (actor === undefined || actor.type === "system") {
				return yield* new McpAuthInvalidError({
					message: `\`${TOOL}\` is for the Maple team over the MCP transport, not for Maple's own agents.`,
					reason: "insufficient_scope",
				})
			}
			const orgId =
				params.org_id === undefined
					? undefined
					: yield* Effect.fromOption(decodeOrgId(params.org_id)).pipe(
							Effect.mapError(
								() =>
									new McpInvalidInputError({
										message: "org_id must be an organization id such as `org_…`.",
										parameter: "org_id",
									}),
							),
						)
			const sinceMs =
				params.start_time === undefined ? undefined : parseWarehouseDateTime(params.start_time)

			const service = yield* AgentFeedbackService
			const reports = yield* service
				.triage(tenant.orgId, {
					kind: params.kind,
					impact: params.impact,
					sinceMs,
					relatedTo: params.related_to,
					orgId,
					limit: params.limit,
				})
				.pipe(
					Effect.catchTags({
						"@maple/http/errors/AgentFeedbackTriageForbiddenError": (error) =>
							new McpAuthInvalidError({ message: error.message, reason: "insufficient_scope" }),
						"@maple/http/errors/AgentFeedbackPersistenceError": () =>
							new McpNotReadyError({
								message: "Feedback could not be read right now.",
								retryAfterSeconds: 5,
							}),
					}),
				)

			return {
				reports: reports.map((report) => ({
					id: encodePublicId(report.id),
					orgId: report.orgId,
					userId: report.userId,
					kind: report.kind,
					impact: report.impact,
					summary: report.summary,
					reason: report.reason,
					details: report.details,
					relatedTo: report.relatedTo,
					agentType: report.agent.type,
					agentName: report.agent.name,
					agentModel: report.agent.model,
					agentVersion: report.agent.version,
					source: report.source,
					createdAt: iso(report.createdAtMs),
				})),
				limit: params.limit,
				filters: {
					...(params.kind !== undefined && { kind: params.kind }),
					...(params.impact !== undefined && { impact: params.impact }),
					...(sinceMs !== undefined && { startTime: iso(sinceMs) }),
					...(params.related_to !== undefined && { relatedTo: params.related_to }),
					...(orgId !== undefined && { orgId }),
				},
			}
		}),
		render: (output) => ({
			title: `Maple feedback: ${output.reports.length} report${output.reports.length === 1 ? "" : "s"}`,
			blocks:
				output.reports.length === 0
					? [doc.text("No feedback matches these filters.")]
					: [
							doc.table(
								["Sent", "Kind", "Impact", "Related to", "Org", "Agent", "Summary"],
								output.reports.map((report) => [
									report.createdAt,
									report.kind,
									report.impact ?? "-",
									report.relatedTo ?? "-",
									report.orgId,
									[report.agentName, report.agentModel].filter(Boolean).join(" · ") ||
										report.agentType,
									report.summary,
								]),
							),
							...output.reports.flatMap((report) => [
								doc.heading(`${report.id}: ${report.summary}`),
								doc.text(report.reason),
								...(report.details === null ? [] : [doc.code("text", report.details)]),
							]),
							...(output.reports.length === output.limit
								? [
										doc.text(
											`Showing the newest ${output.limit}. Narrow with start_time, kind, impact or related_to to see older reports.`,
										),
									]
								: []),
						],
		}),
	})
}
