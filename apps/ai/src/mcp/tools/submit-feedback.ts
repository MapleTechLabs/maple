import { McpInvalidInputError, McpUnavailableError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { AgentFeedbackImpact, AgentFeedbackKind, AgentType } from "@maple/domain/http"
import { AgentFeedbackPublicId } from "@maple/domain/http/v2"
import { SubmitFeedbackOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
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

export function registerSubmitFeedbackTool(server: McpToolRegistrar) {
	server.define({
		name: "submit_feedback",
		description:
			"Send feedback about Maple itself to the Maple team: a bug you hit, a tool or capability you were missing, a misleading description or doc, or something that worked well. " +
			"Say what kind it is, who you are (agent type, name, model), and why you are sending it. Use it when Maple got in the way of your task, not for problems in the user's own services.",
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
			agent_type: P.oneOf(
				AgentType.literals,
				"coding_agent (Claude Code, Cursor, Codex), chat_assistant, autonomous_agent, ci, or other",
			),
			agent_name: P.optionalText(
				"Your client or agent name, e.g. 'claude-code'. Defaults to the MCP client name from the handshake",
			),
			model: P.optionalText("The model you run on, e.g. 'claude-opus-5-5'"),
			agent_version: P.optionalText("Your client or agent version"),
		}),
		output: SubmitFeedbackOutput,
		hints: { readOnly: false, destructive: false, idempotent: false },
		phrases: ["Sending feedback"],
		handler: Effect.fn("McpTool.submitFeedback")(function* (params) {
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
						type: params.agent_type,
						name: params.agent_name ?? tenant.mcpClientName?.slice(0, LIMITS.label),
						model: params.model,
						version: params.agent_version,
					},
					source: "mcp",
				})
				.pipe(
					Effect.catchTag(
						"@maple/http/errors/AgentFeedbackPersistenceError",
						() =>
							new McpUnavailableError({
								message: "Feedback could not be saved right now. Retry in a few seconds.",
								capability: "agent_feedback",
							}),
					),
				)

			const audit = yield* AuditLogService
			yield* audit.record({
				orgId: tenant.orgId,
				actor: { type: "user", userId: tenant.userId },
				source: "mcp",
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
				createdAt: new Date(feedback.createdAtMs).toISOString(),
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
				doc.text("Thanks. The Maple team reads every submission."),
			],
		}),
	})
}
