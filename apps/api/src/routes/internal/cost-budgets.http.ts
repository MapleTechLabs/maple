import { HttpApiBuilder } from "effect/http-api"
import { CostBudgetForbiddenError, CurrentTenant, MapleInternalApi } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { CostBudgetsService } from "@maple/backend/services/cost/CostBudgetsService"
import { Effect } from "effect"
import { auditDiff } from "@/routes/v2/audit-changes"

const budgetAuditDiff = auditDiff({
	fields: ["name", "enabled", "amount", "currency", "period", "metric", "filters", "alerts"],
})

export const HttpCostBudgetsLive = HttpApiBuilder.group(MapleInternalApi, "costBudgets", (handlers) =>
	Effect.gen(function* () {
		const budgets = yield* CostBudgetsService
		// A budget is an alert rule: the role that manages alerts writes it.
		const managing = (tenant: CurrentTenant.TenantSchema) =>
			Effect.as(
				Policy.check(
					tenant.permissions,
					"slos:manage",
					(denial) => new CostBudgetForbiddenError({ message: denial.message }),
				),
				tenant,
			)
		const asAlertsManager = Effect.flatMap(CurrentTenant.Context, managing)

		return handlers
			.handle("list", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return { budgets: yield* budgets.list(tenant) }
				}).pipe(Effect.withSpan("HttpCostBudgets.list")),
			)
			.handle("get", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* budgets.get(tenant.orgId, params.id)
				}).pipe(Effect.withSpan("HttpCostBudgets.get")),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* asAlertsManager
					const created = yield* budgets.create(tenant.orgId, payload, tenant.userId)
					yield* recordHttpAudit("alert_rule.created", {
						resourceId: created.id,
						metadata: { name: created.name, signalType: "cost_budget" },
					})
					return created
				}).pipe(Effect.withSpan("HttpCostBudgets.create")),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* asAlertsManager
					const current = yield* budgets.get(tenant.orgId, params.id)
					const updated = yield* budgets.update(tenant.orgId, params.id, payload, tenant.userId)
					yield* recordHttpAudit("alert_rule.updated", {
						resourceId: updated.id,
						changes: budgetAuditDiff(payload, current, updated),
						metadata: { name: updated.name, signalType: "cost_budget" },
					})
					return updated
				}).pipe(Effect.withSpan("HttpCostBudgets.update")),
			)
			.handle("remove", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* asAlertsManager
					const id = yield* budgets.remove(tenant.orgId, params.id)
					yield* recordHttpAudit("alert_rule.deleted", {
						resourceId: id,
						metadata: { signalType: "cost_budget" },
					})
					return { id }
				}).pipe(Effect.withSpan("HttpCostBudgets.remove")),
			)
	}),
)
