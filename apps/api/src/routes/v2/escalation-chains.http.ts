import { HttpApiBuilder } from "effect/http-api"
import {
	CurrentTenant,
	EscalationChainCreateRequest,
	EscalationChainUpdateRequest,
	type EscalationChainDocument,
	type EscalationStep,
	type EscalationTarget,
} from "@maple/domain/http"
import type {
	V2EscalationChain,
	V2EscalationChainDeleteResponse,
	V2EscalationChainUpdateParams,
	V2EscalationStep,
	V2EscalationTarget,
} from "@maple/domain/http/v2"
import { MapleApiV2, paginateArray, timestamp } from "@maple/domain/http/v2"
import { Array as Arr, Effect } from "effect"
import { auditDiff } from "@/routes/v2/audit-changes"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { EscalationChainsService } from "@maple/backend/services/alerts/EscalationChainsService"

const chainAuditDiff = auditDiff<keyof V2EscalationChainUpdateParams & keyof V2EscalationChain>({
	fields: ["name", "description", "steps", "repeat_count"],
})

const toV2Target = (target: EscalationTarget): V2EscalationTarget => {
	switch (target.type) {
		case "destination":
			return { type: "destination", destination_id: target.destinationId }
		case "user":
			return { type: "user", user_id: target.userId }
		case "schedule":
			return { type: "schedule", schedule_id: target.scheduleId }
	}
}

const fromV2Target = (target: V2EscalationTarget): EscalationTarget => {
	switch (target.type) {
		case "destination":
			return { type: "destination", destinationId: target.destination_id }
		case "user":
			return { type: "user", userId: target.user_id }
		case "schedule":
			return { type: "schedule", scheduleId: target.schedule_id }
	}
}

const toV2Step = (step: EscalationStep): V2EscalationStep => ({
	targets: Arr.map(step.targets, toV2Target),
	wait_minutes: step.waitMinutes,
})

const fromV2Step = (step: V2EscalationStep): EscalationStep => ({
	targets: Arr.map(step.targets, fromV2Target),
	waitMinutes: step.wait_minutes,
})

export const toV2EscalationChain = (doc: EscalationChainDocument): V2EscalationChain => ({
	id: doc.id,
	object: "escalation_chain",
	name: doc.name,
	description: doc.description,
	steps: Arr.map(doc.steps, toV2Step),
	repeat_count: doc.repeatCount,
	rule_ids: doc.ruleIds,
	created_at: timestamp(doc.createdAt),
	updated_at: timestamp(doc.updatedAt),
})

export const HttpV2EscalationChainsLive = HttpApiBuilder.group(MapleApiV2, "escalationChains", (handlers) =>
	Effect.gen(function* () {
		const chains = yield* EscalationChainsService

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					// The service returns the org's whole (capped) set, so pages are cut from it.
					const response = yield* chains.list(tenant.orgId)
					const page = yield* paginateArray(Arr.map(response.chains, toV2EscalationChain), query)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const chain = yield* chains.get(tenant.orgId, params.id)
					return toV2EscalationChain(chain)
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const created = yield* chains.create(
						tenant.orgId,
						tenant.userId,
						tenant.roles,
						new EscalationChainCreateRequest({
							name: payload.name,
							...(payload.description === undefined
								? undefined
								: { description: payload.description }),
							steps: Arr.map(payload.steps, fromV2Step),
							...(payload.repeat_count === undefined
								? undefined
								: { repeatCount: payload.repeat_count }),
						}),
					)
					yield* recordHttpAudit("escalation_chain.created", {
						resourceId: created.id,
						metadata: { name: created.name, steps: created.steps.length },
					})
					return toV2EscalationChain(created)
				}),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const current = yield* chains.get(tenant.orgId, params.id)
					const updated = yield* chains.update(
						tenant.orgId,
						tenant.userId,
						tenant.roles,
						params.id,
						new EscalationChainUpdateRequest({
							...(payload.name === undefined ? undefined : { name: payload.name }),
							...(payload.description === undefined
								? undefined
								: { description: payload.description }),
							...(payload.steps === undefined
								? undefined
								: { steps: Arr.map(payload.steps, fromV2Step) }),
							...(payload.repeat_count === undefined
								? undefined
								: { repeatCount: payload.repeat_count }),
						}),
					)
					yield* recordHttpAudit("escalation_chain.updated", {
						resourceId: updated.id,
						changes: chainAuditDiff(
							payload,
							toV2EscalationChain(current),
							toV2EscalationChain(updated),
						),
						metadata: { name: updated.name },
					})
					return toV2EscalationChain(updated)
				}),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* chains.delete(tenant.orgId, tenant.roles, params.id)
					yield* recordHttpAudit("escalation_chain.deleted", { resourceId: params.id })
					const deleted: V2EscalationChainDeleteResponse = {
						id: params.id,
						object: "escalation_chain",
						deleted: true,
					}
					return deleted
				}),
			)
	}),
)
