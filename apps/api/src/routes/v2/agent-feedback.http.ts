import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant } from "@maple/domain/http"
import { isoTimestamp, MapleApiV2, paginateOffsetQuery } from "@maple/domain/http/v2"
import type { V2AgentFeedback } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import {
	AgentFeedbackService,
	type AgentFeedback,
} from "@maple/backend/services/feedback/AgentFeedbackService"

export const toV2AgentFeedback = (feedback: AgentFeedback): V2AgentFeedback => ({
	id: feedback.id,
	object: "agent_feedback",
	kind: feedback.kind,
	impact: feedback.impact,
	summary: feedback.summary,
	reason: feedback.reason,
	details: feedback.details,
	related_to: feedback.relatedTo,
	agent: {
		type: feedback.agent.type,
		name: feedback.agent.name,
		model: feedback.agent.model,
		version: feedback.agent.version,
	},
	source: feedback.source,
	created_at: isoTimestamp(feedback.createdAtMs),
})

export const HttpV2AgentFeedbackLive = HttpApiBuilder.group(MapleApiV2, "agentFeedback", (handlers) =>
	Effect.gen(function* () {
		const service = yield* AgentFeedbackService

		return handlers
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const feedback = yield* service.submit(tenant.orgId, tenant.userId, {
						kind: payload.kind,
						impact: payload.impact,
						summary: payload.summary,
						reason: payload.reason,
						details: payload.details,
						relatedTo: payload.related_to,
						agent: payload.agent,
						source: "api",
					})
					yield* recordHttpAudit("agent_feedback.submitted", {
						resourceId: feedback.id,
						metadata: { kind: feedback.kind, agent_type: feedback.agent.type },
					})
					return toV2AgentFeedback(feedback)
				}),
			)
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const page = yield* paginateOffsetQuery(query, (window) =>
						service
							.list(tenant.orgId, window)
							.pipe(Effect.map((rows) => rows.map(toV2AgentFeedback))),
					)
					return { object: "list" as const, ...page }
				}),
			)
	}),
)
