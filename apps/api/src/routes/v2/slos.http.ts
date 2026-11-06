import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant } from "@maple/domain/http"
import {
	isoTimestamp,
	MapleApiV2,
	paginateArray,
	sloSliFromWire,
	sloSliToWire,
	V2InsufficientPermissions,
} from "@maple/domain/http/v2"
import type { V2Slo } from "@maple/domain/http/v2"
import { Effect, Array as Arr } from "effect"
import { auditDiff } from "@/routes/v2/audit-changes"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import * as Policy from "@maple/domain/policy"
import { type SloRecord, SlosService } from "@maple/backend/services/slos/SlosService"

// An SLO owns a burn-rate alert rule, so writes need the same permission as alert rules.

export const toV2Slo = (slo: SloRecord): V2Slo => ({
	id: slo.id,
	object: "slo",
	name: slo.name,
	description: slo.description,
	service_name: slo.serviceName,
	environments: slo.environments,
	sli: sloSliToWire(slo.sli),
	target_percent: slo.targetPercent,
	window_days: slo.windowDays,
	alert_rule_id: slo.alertRuleId,
	created_at: isoTimestamp(slo.createdAt),
	updated_at: isoTimestamp(slo.updatedAt),
})

const sloAuditDiff = auditDiff({
	fields: ["name", "description", "service_name", "environments", "sli", "target_percent", "window_days"],
})

const requireManage = Effect.gen(function* () {
	const tenant = yield* CurrentTenant.Context
	yield* Policy.check(tenant.roles, "alerts:manage", (denial) =>
		V2InsufficientPermissions.make(denial.message),
	)
	return tenant
})

export const HttpV2SlosLive = HttpApiBuilder.group(MapleApiV2, "slos", (handlers) =>
	Effect.gen(function* () {
		const service = yield* SlosService

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const slos = yield* service.list(tenant.orgId)
					const page = yield* paginateArray(Arr.map(slos, toV2Slo), query)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const slo = yield* service.get(tenant.orgId, params.id)
					return toV2Slo(slo)
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* requireManage
					const created = yield* service.create(tenant.orgId, {
						name: payload.name,
						...(payload.description === undefined
							? undefined
							: { description: payload.description }),
						serviceName: payload.service_name,
						...(payload.environments === undefined
							? undefined
							: { environments: payload.environments }),
						sli: sloSliFromWire(payload.sli),
						targetPercent: payload.target_percent,
						...(payload.window_days === undefined
							? undefined
							: { windowDays: payload.window_days }),
						createdBy: tenant.userId,
					})
					yield* recordHttpAudit("slo.created", {
						resourceId: created.id,
						metadata: { name: created.name, service: created.serviceName },
					})
					return toV2Slo(created)
				}),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* requireManage
					const current = yield* service.get(tenant.orgId, params.id)
					const updated = yield* service.update(tenant.orgId, params.id, {
						...(payload.name === undefined ? undefined : { name: payload.name }),
						...(payload.description === undefined
							? undefined
							: { description: payload.description }),
						...(payload.service_name === undefined
							? undefined
							: { serviceName: payload.service_name }),
						...(payload.environments === undefined
							? undefined
							: { environments: payload.environments }),
						...(payload.sli === undefined ? undefined : { sli: sloSliFromWire(payload.sli) }),
						...(payload.target_percent === undefined
							? undefined
							: { targetPercent: payload.target_percent }),
						...(payload.window_days === undefined
							? undefined
							: { windowDays: payload.window_days }),
						updatedBy: tenant.userId,
					})
					yield* recordHttpAudit("slo.updated", {
						resourceId: updated.id,
						changes: sloAuditDiff(payload, toV2Slo(current), toV2Slo(updated)),
						metadata: { name: updated.name },
					})
					return toV2Slo(updated)
				}),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* requireManage
					const deleted = yield* service.delete(tenant.orgId, params.id)
					yield* recordHttpAudit("slo.deleted", { resourceId: deleted })
					return { id: deleted, object: "slo" as const, deleted: true as const }
				}),
			)
	}),
)
