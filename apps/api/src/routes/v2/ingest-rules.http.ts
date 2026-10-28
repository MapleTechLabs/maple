import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, IngestRuleForbiddenError } from "@maple/domain/http"
import type { IngestRule } from "@maple/domain/ingest-rules"
import {
	MapleApiV2,
	fromV2IngestRuleAction,
	isoTimestamp,
	paginateArray,
	toV2IngestRuleAction,
	type V2IngestRule,
} from "@maple/domain/http/v2"
import { Effect } from "effect"
import { requireAdmin } from "@maple/backend/services/auth/auth"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { IngestRuleService } from "@maple/backend/services/org/IngestRuleService"
import { diffAuditChanges, pickPresentFields } from "@/routes/v2/audit-changes"

const toV2IngestRule = (rule: IngestRule): V2IngestRule => ({
	id: rule.id,
	object: "ingest_rule",
	name: rule.name,
	enabled: rule.enabled,
	position: rule.position,
	signals: rule.spec.signals,
	conditions: rule.spec.conditions,
	action: toV2IngestRuleAction(rule.spec.action),
	created_at: isoTimestamp(rule.createdAt),
	updated_at: isoTimestamp(rule.updatedAt),
})

const ruleAuditKeys: ReadonlyArray<"name" | "enabled" | "position" | "signals" | "conditions" | "action"> = [
	"name",
	"enabled",
	"position",
	"signals",
	"conditions",
	"action",
]

export const HttpV2IngestRulesLive = HttpApiBuilder.group(MapleApiV2, "ingestRules", (handlers) =>
	Effect.gen(function* () {
		const service = yield* IngestRuleService

		// A rule drops or rewrites the whole org's telemetry, so writes are admin-only.
		const requireRuleAdmin = (tenant: CurrentTenant.TenantSchema, action: string) =>
			requireAdmin(
				tenant.roles,
				() =>
					new IngestRuleForbiddenError({
						message: `Only org admins can ${action} ingest rules`,
						...(tenant.roles.length > 0 ? { roles: [...tenant.roles] } : undefined),
					}),
			)

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rules = yield* service.list(tenant.orgId)
					const page = yield* paginateArray(rules.map(toV2IngestRule), query)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return toV2IngestRule(yield* service.get(tenant.orgId, params.id))
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireRuleAdmin(tenant, "create")
					const created = yield* service.create(tenant.orgId, {
						name: payload.name,
						enabled: payload.enabled,
						position: payload.position,
						spec: {
							signals: payload.signals,
							conditions: payload.conditions ?? [],
							action: fromV2IngestRuleAction(payload.action),
						},
					})
					yield* recordHttpAudit("ingest_rule.created", {
						resourceId: created.id,
						metadata: { name: created.name, action: created.spec.action._tag },
					})
					return toV2IngestRule(created)
				}),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireRuleAdmin(tenant, "update")
					const current = yield* service.get(tenant.orgId, params.id)
					const specChanged =
						payload.signals !== undefined ||
						payload.conditions !== undefined ||
						payload.action !== undefined
					const updated = yield* service.update(tenant.orgId, params.id, {
						name: payload.name,
						enabled: payload.enabled,
						position: payload.position,
						spec: specChanged
							? {
									signals: payload.signals ?? current.spec.signals,
									conditions: payload.conditions ?? current.spec.conditions,
									action:
										payload.action === undefined
											? current.spec.action
											: fromV2IngestRuleAction(payload.action),
								}
							: undefined,
					})
					const changes = diffAuditChanges(
						pickPresentFields(ruleAuditKeys, payload, toV2IngestRule(current)),
						pickPresentFields(ruleAuditKeys, payload, toV2IngestRule(updated)),
					)
					yield* recordHttpAudit("ingest_rule.updated", {
						resourceId: updated.id,
						changes,
						metadata: { name: updated.name },
					})
					return toV2IngestRule(updated)
				}),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireRuleAdmin(tenant, "delete")
					const id = yield* service.delete(tenant.orgId, params.id)
					yield* recordHttpAudit("ingest_rule.deleted", { resourceId: id })
					return { id, object: "ingest_rule" as const, deleted: true as const }
				}),
			)
	}),
)
