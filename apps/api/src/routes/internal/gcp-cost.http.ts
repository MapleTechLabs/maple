import { HttpApiBuilder } from "effect/http-api"
import {
	CurrentTenant,
	GcpCostSourceAdded,
	GcpCostSourceRemoved,
	GcpCostStatus,
	IntegrationsForbiddenError,
	MapleInternalApi,
} from "@maple/domain/http"
import { Effect } from "effect"
import * as Policy from "@maple/domain/policy"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { GcpCostSourceService } from "@maple/backend/services/cost/GcpCostSourceService"

// A cost source is a connection like any other: the role that manages integrations manages it.
const requireIntegrationsManager = (roles: CurrentTenant.TenantSchema["roles"]) =>
	Policy.check(
		roles,
		"integrations:manage",
		(denial) => new IntegrationsForbiddenError({ message: denial.message }),
	)

export const HttpGcpCostLive = HttpApiBuilder.group(MapleInternalApi, "gcpCost", (handlers) =>
	Effect.gen(function* () {
		const sources = yield* GcpCostSourceService

		return handlers
			.handle("status", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const status = yield* sources.status(tenant.orgId)
					return new GcpCostStatus(status)
				}).pipe(Effect.withSpan("HttpGcpCost.status")),
			)
			.handle("add", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireIntegrationsManager(tenant.roles)
					const added = yield* sources.add(
						tenant.orgId,
						tenant.userId,
						payload.connectorId,
						payload.tableRef,
					)
					// Adding what is a source already changed nothing, so it leaves no entry.
					if (added.created) {
						yield* recordHttpAudit("cost_source.created", {
							metadata: { provider: "gcp", account: added.export.billingAccountId },
						})
					}
					return new GcpCostSourceAdded({ export: added.export, created: added.created })
				}).pipe(Effect.withSpan("HttpGcpCost.add")),
			)
			.handle("remove", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireIntegrationsManager(tenant.roles)
					const removed = yield* sources.remove(tenant.orgId, params.exportId)
					if (removed.removed) {
						yield* recordHttpAudit("cost_source.deleted", { metadata: { provider: "gcp" } })
					}
					return new GcpCostSourceRemoved(removed)
				}).pipe(Effect.withSpan("HttpGcpCost.remove")),
			)
	}),
)
