import { McpInvalidInputError, McpNotReadyError, type McpToolRegistrar } from "./types"
import { DateTime, Effect, Schedule, Schema, String as Str } from "effect"
import { AgentFeedbackImpact, AgentFeedbackKind, AgentType } from "@maple/domain/http"
import { AgentFeedbackPublicId } from "@maple/domain/http/v2"
import { SendMapleFeedbackOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { auditAttribution } from "@maple/backend/services/audit/audit-access"
import { CurrentAuditActor } from "@maple/backend/services/auth/audit-actor"
import { AgentFeedbackService } from "@maple/backend/services/feedback/AgentFeedbackService"

const encodePublicId = Schema.encodeSync(AgentFeedbackPublicId)

/** Same bounds as `POST /v2/agent_feedback`, so the two surfaces accept the same feedback. */
const LIMITS = { summary: 200, reason: 4000, details: 10000, label: 200 } as const

const checkLength = (parameter: string, value: string | undefined, max: number, required: boolean) => {
	const trimmed = value?.trim() ?? ""
	if (required && trimmed.length === 0) {
		return Effect.fail(
			new McpInvalidInputError({ message: `${parameter} must not be empty.`, parameter }),
		)
	}
	if (trimmed.length > max) {
		return Effect.fail(
			new McpInvalidInputError({
				message: `${parameter} must be at most ${max} characters.`,
				parameter,
			}),
		)
	}
	return Effect.void
}

export function registerSendMapleFeedbackTool(server: McpToolRegistrar) {
	server.define({
		name: "send_maple_feedback",
		title: "Send Maple Feedback",
		description:
			"Report a problem with Maple itself (this MCP server, its tools, API, or docs) to the Maple team: a bug, a missing capability, a misleading description, or something that worked well. " +
			"Send it yourself, without asking first, when a Maple tool fails in a way that looks like Maple's fault or Maple got in the way of the task; skip it only if the user's instructions say not to send Maple feedback. Not for problems in the user's own services. " +
			"The report is visible to the Maple team and to the user's organization, so tell the user in one line that you sent it. " +
			"Describe Maple's behaviour, not the user's data: leave out secrets, customer data, and raw log or span contents.",
		parameters: Schema.Struct({
			kind: P.oneOf(
				AgentFeedbackKind.literals,
				"bug (broken or wrong), feature_request (missing capability), improvement (works but could be better), documentation (a description or doc misled you), praise, or other",
			),
			summary: P.text(`One line: what happened or what you want (max ${LIMITS.summary} chars)`),
			reason: P.text(
				`Why you are sending this: what you were trying to do, what got in the way, and why it matters (max ${LIMITS.reason} chars)`,
			),
			details: P.optionalText(
				`Reproduction steps, the call you made, expected versus actual (max ${LIMITS.details} chars)`,
			),
			impact: P.optionalOneOf(
				AgentFeedbackImpact.literals,
				"blocking (could not finish), degraded (finished with a workaround), or minor",
			),
			related_to: P.optionalText("The tool, API endpoint, or page this is about, e.g. 'search_traces'"),
			agent_type: P.optionalOneOf(
				AgentType.literals,
				"coding_agent (Claude Code, Cursor, Codex), chat_assistant, autonomous_agent, ci, or other (the default)",
			),
			agent_name: P.optionalText(
				"Your client or agent name, e.g. 'claude-code'. Default: the name your client sent when it connected",
			),
			model: P.optionalText("The model you run on, e.g. 'claude-opus-5-5'"),
			agent_version: P.optionalText("Your client or agent version"),
		}),
		// Values agents send for `kind` and `agent_type` that mean a published one.
		valueAliases: {
			kind: {
				bug_report: "bug",
				error: "bug",
				issue: "bug",
				broken: "bug",
				feature: "feature_request",
				feature_req: "feature_request",
				request: "feature_request",
				missing_feature: "feature_request",
				enhancement: "improvement",
				suggestion: "improvement",
				ux: "improvement",
				usability: "improvement",
				performance: "improvement",
				docs: "documentation",
				doc: "documentation",
				description: "documentation",
				positive: "praise",
				compliment: "praise",
				kudos: "praise",
				feedback: "other",
				general: "other",
			},
			agent_type: {
				coding: "coding_agent",
				coding_assistant: "coding_agent",
				code_agent: "coding_agent",
				cli: "coding_agent",
				ide: "coding_agent",
				assistant: "chat_assistant",
				chat: "chat_assistant",
				chatbot: "chat_assistant",
				autonomous: "autonomous_agent",
				agent: "autonomous_agent",
				ci_cd: "ci",
			},
		},
		output: SendMapleFeedbackOutput,
		hints: { readOnly: false, destructive: false, idempotent: false },
		phrases: ["Sending feedback"],
		handler: Effect.fn("McpTool.sendMapleFeedback")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			yield* checkLength("summary", params.summary, LIMITS.summary, true)
			yield* checkLength("reason", params.reason, LIMITS.reason, true)
			yield* checkLength("details", params.details, LIMITS.details, false)
			yield* checkLength("related_to", params.related_to, LIMITS.label, false)
			yield* checkLength("agent_name", params.agent_name, LIMITS.label, false)
			yield* checkLength("model", params.model, LIMITS.label, false)
			yield* checkLength("agent_version", params.agent_version, LIMITS.label, false)

			const service = yield* AgentFeedbackService
			const feedback = yield* service
				.submit(tenant.orgId, tenant.userId, {
					kind: params.kind,
					impact: params.impact,
					summary: params.summary,
					reason: params.reason,
					details: params.details,
					relatedTo: params.related_to,
					agent: {
						type: params.agent_type ?? "other",
						// The client's self-declared name is unchecked input: bounded like the parameter.
						name:
							params.agent_name ??
							(tenant.mcpClientName === undefined
								? undefined
								: Str.slice(0, LIMITS.label)(tenant.mcpClientName)),
						model: params.model,
						version: params.agent_version,
					},
					source: "mcp",
				})
				.pipe(
					// A report is often sent right after something else failed: one blip must not lose it.
					Effect.retry({ times: 2, schedule: Schedule.exponential("200 millis") }),
					Effect.catchTag(
						"@maple/http/errors/AgentFeedbackPersistenceError",
						() =>
							new McpNotReadyError({
								message: "Feedback could not be saved right now; nothing was recorded.",
								retryAfterSeconds: 10,
							}),
					),
				)

			// Same attribution as the executor's `mcp_tool.called` entry: a pinned agent,
			// an autonomous turn or a chat connector is the actor, not the key's user.
			const audit = yield* AuditLogService
			const actor = yield* CurrentAuditActor
			yield* audit.record({
				orgId: tenant.orgId,
				...auditAttribution(tenant, actor),
				action: "agent_feedback.submitted",
				resourceId: feedback.id,
				metadata: { kind: feedback.kind, agent_type: feedback.agent.type },
			})

			return {
				id: encodePublicId(feedback.id),
				kind: feedback.kind,
				impact: feedback.impact,
				summary: feedback.summary,
				agentType: feedback.agent.type,
				agentName: feedback.agent.name,
				agentModel: feedback.agent.model,
				createdAt: DateTime.formatIso(DateTime.makeUnsafe(feedback.createdAtMs)),
			}
		}),
		render: (output) => ({
			title: "Feedback sent",
			blocks: [
				doc.fields([
					["ID", output.id],
					["Kind", output.kind],
					["Impact", output.impact ?? undefined],
					["Summary", output.summary],
					[
						"Agent",
						[output.agentType, output.agentName, output.agentModel].filter(Boolean).join(" · "),
					],
				]),
				doc.text(
					"Sent. Tell the user in one line that you reported this to the Maple team; their organization can see it too.",
				),
			],
		}),
	})
}
